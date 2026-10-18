// Filing Diff — "what changed this quarter".
//
// Institutional shops pay BamSEC/Hudson Labs for filing redlines; retail gets
// nothing. We compare a company's newest 10-K/10-Q against its previous
// filing of the same form: guidance and outlook language, risk-factor
// changes, demand/margin commentary, liquidity — quoted from the documents,
// never recalled from memory. Results cached in Mongo per filing pair, so
// each diff is paid for once, ever.

const axios = require('axios');
const mongoose = require('mongoose');
const secSource = require('./sec-source');
const watchdog = require('./watchdog');
const aiClient = require('./ai-client');

const MAX_DOC_CHARS = 20000; // per document, keeps both inside the context

// Shared with keypoints.js. The local copy replaced EVERY tag with a space,
// which fuses words split across inline/styling tags ("risk factors" arriving
// as "ris k factors") and silently defeated the anchors below.
const { htmlToText } = require('./filing-sections');
const { tidyQuote } = require('./html-text');

// Windows around the sections where quarter-over-quarter narrative changes
// actually live: outlook/guidance, risk factors, MD&A trend language.
function narrativeWindows(text) {
    const anchors = [
        /outlook/gi, /guidance/gi, /risk factors/gi,
        /management.s discussion/gi, /trends? and uncertainties/gi,
        /liquidity and capital resources/gi, /macroeconomic/gi,
        /we (expect|anticipate|believe)/gi
    ];
    const spans = [];
    for (const re of anchors) {
        let m;
        while ((m = re.exec(text)) !== null && spans.length < 16) {
            spans.push([Math.max(0, m.index - 800), Math.min(text.length, m.index + 4500)]);
        }
        if (spans.length >= 16) break;
    }
    if (!spans.length) return text.slice(0, MAX_DOC_CHARS);
    spans.sort((a, b) => a[0] - b[0]);
    const merged = [spans[0]];
    for (const [s, e] of spans.slice(1)) {
        const last = merged[merged.length - 1];
        if (s <= last[1]) last[1] = Math.max(last[1], e);
        else merged.push([s, e]);
    }
    let out = '';
    for (const [s, e] of merged) {
        if (out.length >= MAX_DOC_CHARS) break;
        out += text.slice(s, e) + '\n…\n';
    }
    return out.slice(0, MAX_DOC_CHARS);
}

// Newest periodic report plus the previous filing of the same form. 20-F/40-F
// are included so a foreign private issuer, which files no 10-K, can still be
// compared year over year against its own prior annual report.
async function latestPair(symbol) {
    const filings = await watchdog.fetchRecentFilings(symbol, new Set(['10-K', '10-Q', '20-F', '40-F']), 12);
    if (!filings || !filings.length) return null;
    const latest = filings[0];
    const prev = filings.slice(1).find((f) => f.form === latest.form) || null;
    if (!prev) return null;
    return { latest, prev };
}

// Bumped whenever the payload shape changes, so stale rows re-extract
// v3: figures asserted in `what` are now checked against both filings, so a
// pre-v3 payload may carry a fabricated number beside a verified quote and
// must be recomputed rather than served.
const DIFF_SCHEMA_V = 3;

const DIFF_SYSTEM = [
    'You compare two SEC filings from the SAME company: the NEW one and the PRIOR one of the same form. Reply with ONLY a JSON object, no prose, no markdown fences.',
    'Schema: {"headline": str, "changes": [{"area": str, "what": str, "priorQuote": str|null, "newQuote": str|null}], "tone": "improving"|"stable"|"deteriorating"|null}',
    '"headline" is one sentence: the single most decision-relevant change (or "Little changed" if true). Each "changes" item: "area" is a short label (Guidance, Risk factors, Demand, Margins, Liquidity, Legal, Segments...), "what" is 1-2 factual sentences on what changed NEW vs PRIOR.',
    'QUOTES ARE A MATCHED PAIR showing the same point before and after: "priorQuote" is copied WORD FOR WORD from the PRIOR FILING excerpt, "newQuote" WORD FOR WORD from the NEW FILING excerpt. Copy characters exactly — do not paraphrase, tidy, shorten mid-phrase, join separated sentences, or fix typos. Keep each under 40 words. If the same point is not stated in BOTH documents, set the side you cannot copy to null. Every quote is checked against the source text and silently dropped if it is not found there, so a paraphrase is worse than a null.',
    'STRICT GROUNDING: only report differences observable between the two supplied texts. Both are excerpts — if something is absent from the excerpts, do not speculate about it. Never use outside knowledge, never estimate numbers not present. 3-7 changes; fewer if little changed.',
    'Each "what" is a finished statement only — never show your working, scratch arithmetic, or self-correction (no "Wait", "let me recalculate", "actually the calculation…"). Do not recompute figures; report only what the two texts state.',
    'No investment advice, no buy/sell language — describe, never recommend.'
].join('\n');

// The user turn for one comparison. Extracted so the model A/B harness
// (scripts/ab-summary-quality.js) prompts byte-identically to production —
// a scorer running a drifted copy of the prompt measures the wrong thing.
function diffUserMessage({ sym, latest, prev, oldDoc, newDoc }, extra = '') {
    return `Company: ${sym}. Compare the NEW ${latest.form} (filed ${latest.date}) against the PRIOR ${prev.form} (filed ${prev.date}).${extra}\n\n=== PRIOR FILING (${prev.date}) — excerpts ===\n${oldDoc}\n\n=== NEW FILING (${latest.date}) — excerpts ===\n${newDoc}`;
}

// Defence in depth: the diff model (temp 0, JSON) occasionally spills self-
// correction / scratch arithmetic into a "what" field ("…40.7%? Actually
// calculation… Wait, need to recalc…"). Trim at the first such tell and drop the
// change if nothing useful survives, so reasoning never reaches the page.
const REASONING_TELL = /\b(wait,|actually[,:]?\s*(the\s+)?calculation|need to recalc(ulate)?|let me\s+(recalc|recompute|re-?check|reconsider)|recalculate\b|hmm,)/i;
function cleanWhat(s) {
    let what = String(s || '').trim();
    const m = what.search(REASONING_TELL);
    if (m === 0) return '';
    if (m > 0) what = what.slice(0, m).trim().replace(/[\s,;:?(]+$/, '');
    return what;
}

// The model is asked for verbatim quotes; this is what makes "verified" mean
// something. Each side is checked as a normalised substring of the document it
// claims to come from — the same excerpt text the model was shown. A paraphrase
// simply fails and the pair is dropped. Nothing sets a "verified" flag by hand.
// Normalisation absorbs the differences that survive an honest copy: collapsed
// whitespace, smart quotes/dashes from the filing's HTML, and case.
function normalizeQuote(s) {
    return String(s || '')
        .replace(/[\u2018\u2019\u201a\u201b]/g, "'")
        .replace(/[\u201c\u201d\u201e\u201f]/g, '"')
        .replace(/[\u2010-\u2015\u2212]/g, '-')
        .replace(/\u00a0/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}
function quoteIsInSource(quote, sourceText) {
    const q = normalizeQuote(quote);
    if (q.length < 12) return false; // too short to be evidence of anything
    return normalizeQuote(sourceText).includes(q);
}

// `what` was the hole: quotes were checked character-for-character, the prose
// around them was not, so a change could carry a verified quote and still
// assert a figure that is in neither filing. Found in the wild on a freshly
// computed row — AAOI's narrative said the prior operating loss was $9.0M
// while its own quote read "Loss from operations (24,727 ) (15,976 )", and
// NVTS said 232.0M shares against a quote of 230,525,464. A fabricated number
// beside a real citation is worse than no number, because the citation is what
// makes a reader trust it.
//
// Scale is the whole difficulty: filings tabulate in thousands, the narrative
// writes "$49.8 billion", and "49,836" is the same fact. So figures are
// compared as scientific-notation mantissas to three significant figures,
// which is scale-invariant — 49.8bn and 49,836 both reduce to 4.98 — and a
// figure counts as supported if its mantissa occurs anywhere in either filing
// excerpt. That direction is deliberately forgiving: the cost of missing a bad
// figure is one wrong number, the cost of a false positive is deleting a true
// one, and only the latter is silent.
const YEAR_LIKE = /^(1[89]|20|21)\d\d$/;
function figureMantissa(raw) {
    const n = Number(String(raw).replace(/[,$\s]/g, ''));
    if (!isFinite(n) || n === 0) return null;
    const abs = Math.abs(n);
    const mantissa = abs / Math.pow(10, Math.floor(Math.log10(abs)));
    return mantissa.toFixed(2); // 3 significant figures
}
// Only tokens that actually look like reported figures: money, percentages,
// decimals, thousands-separated, or three-plus digits. Skips "two segments",
// "8-K", "Q1" and bare years, none of which are claims worth verifying.
function extractFigures(text) {
    const out = [];
    const re = /\$?\d[\d,]*\.?\d*\s*(?:%|percent|bps|million|billion|trillion|thousand)?/gi;
    for (const m of String(text || '').match(re) || []) {
        const token = m.trim();
        const digits = token.replace(/[^\d.]/g, '');
        if (!digits) continue;
        const looksReported = /[$%,.]/.test(token) || /million|billion|trillion|thousand|percent|bps/i.test(token) || digits.replace('.', '').length >= 3;
        if (!looksReported) continue;
        if (YEAR_LIKE.test(digits)) continue;
        const mant = figureMantissa(digits);
        if (mant) out.push({ token, mant });
    }
    return out;
}
function sourceMantissaSet(sourceText) {
    const set = new Set();
    for (const f of extractFigures(sourceText)) set.add(f.mant);
    return set;
}
// Drops only the sentence carrying an unsupported figure, never the whole
// change: the rest of the narrative is usually sound and the verified quotes
// are untouched. Returns the surviving prose plus what was removed.
function stripUnsupportedFigures(what, sourceMantissas) {
    const text = String(what || '').trim();
    if (!text) return { what: '', removed: [] };
    const sentences = text.split(/(?<=[.;])\s+/);
    const kept = [];
    const removed = [];
    for (const sentence of sentences) {
        const bad = extractFigures(sentence).filter((f) => !sourceMantissas.has(f.mant));
        if (bad.length) removed.push(...bad.map((b) => b.token));
        else kept.push(sentence);
    }
    return { what: kept.join(' ').trim(), removed };
}

function tidyDiffQuotes(payload) {
    if (!payload || !Array.isArray(payload.changes)) return payload;
    return { ...payload, changes: payload.changes.map((c) => (c && typeof c === 'object' ? { ...c, priorQuote: tidyQuote(c.priorQuote), newQuote: tidyQuote(c.newQuote), quote: tidyQuote(c.quote) } : c)) };
}

async function computeFilingDiff(symbol) {
    const sym = String(symbol || '').toUpperCase().trim();
    const pair = await latestPair(sym);
    if (!pair) return { error: 'Need at least two filings of the same form (10-K or 10-Q) to compare.' };
    const { latest, prev } = pair;
    if (!/\.htm/i.test(latest.url) || !/\.htm/i.test(prev.url)) {
        return { error: 'Filing documents unavailable in a readable format.' };
    }

    const col = mongoose.connection.collection('filing_diffs');
    try {
        const hit = await col.findOne({ symbol: sym, accession: latest.accession, prevAccession: prev.accession });
        // Rows cached before paired quotes existed have no verified evidence and
        // never will — they must re-extract, or the panel stays blank until the
        // company's next filing. Treat a pre-v2 payload as a miss.
        // Quotes cached before entities were decoded are tidied on the way out.
        if (hit && hit.payload && hit.payload.v === DIFF_SCHEMA_V) return { ...tidyDiffQuotes(hit.payload), cached: true };
    } catch (_) { /* cache is best-effort */ }

    const get = (url) => axios.get(url, { headers: secSource.SEC_HEADERS, timeout: 30000, maxContentLength: 40e6 });
    const newDoc = narrativeWindows(htmlToText((await get(latest.url)).data));
    const oldDoc = narrativeWindows(htmlToText((await get(prev.url)).data));
    if (newDoc.length < 500 || oldDoc.length < 500) return { error: 'Could not read the filing text.' };

    const callModel = (extra) => aiClient.chatRaw([
        { role: 'system', content: DIFF_SYSTEM },
        { role: 'user', content: diffUserMessage({ sym, latest, prev, oldDoc, newDoc }, extra) }
    ], { purpose: 'summary', temperature: 0, maxTokens: 4000, timeoutMs: 40000 });

    const tryParse = (msg) => {
        try {
            const raw = String(msg.content || '').replace(/```json|```/g, '').trim();
            const p = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
            return typeof p.headline === 'string' && Array.isArray(p.changes) ? p : null;
        } catch (_) { return null; }
    };

    const sourceFigures = sourceMantissaSet(`${oldDoc}\n${newDoc}`);

    let parsed = tryParse(await callModel(''));
    if (!parsed) {
        parsed = tryParse(await callModel(' REPLY WITH ONLY THE JSON OBJECT — your entire reply must parse as JSON.'));
    }
    if (!parsed) return { error: 'Comparison failed — try again later.' };

    const payload = {
        symbol: sym,
        headline: String(parsed.headline || '').slice(0, 300),
        tone: ['improving', 'stable', 'deteriorating'].includes(parsed.tone) ? parsed.tone : null,
        changes: parsed.changes.slice(0, 8).map((c) => {
            // a quote survives only if it is really in the document it cites
            const priorQuote = quoteIsInSource(c.priorQuote, oldDoc) ? tidyQuote(String(c.priorQuote).slice(0, 420)) : null;
            const newQuote = quoteIsInSource(c.newQuote || c.quote, newDoc) ? tidyQuote(String(c.newQuote || c.quote).slice(0, 420)) : null;
            // …and a figure in the prose survives only if it is in one of the
            // filings. Both excerpts count as the source: a change legitimately
            // cites the prior period, which lives in the older document.
            const cleaned = stripUnsupportedFigures(cleanWhat(c.what), sourceFigures);
            return {
                area: String(c.area || '').slice(0, 60),
                what: cleaned.what.slice(0, 500),
                priorQuote,
                newQuote,
                evidenceVerified: !!(priorQuote && newQuote),
                figuresVerified: cleaned.removed.length === 0,
                quote: newQuote // the company page and alerts read `quote`
            };
        }).filter((c) => c.area && c.what && c.what.length >= 12),
        latest: { form: latest.form, date: latest.date, url: latest.url },
        prev: { form: prev.form, date: prev.date, url: prev.url },
        note: 'Compared from narrative excerpts (outlook, risks, MD&A) of both filings. Every quotation shown was checked character-for-character against the filing it is attributed to, and every figure in the commentary was checked against the filings themselves — anything unsupported is removed rather than shown. Not advice.',
        v: DIFF_SCHEMA_V,
        extractedAt: new Date().toISOString()
    };
    try {
        await col.updateOne(
            { symbol: sym, accession: latest.accession, prevAccession: prev.accession },
            { $set: { payload, at: new Date() } },
            { upsert: true }
        );
    } catch (_) { /* cache is best-effort */ }
    return payload;
}

module.exports = {
    computeFilingDiff, normalizeQuote, quoteIsInSource, tidyDiffQuotes, DIFF_SCHEMA_V,
    extractFigures, figureMantissa, sourceMantissaSet, stripUnsupportedFigures,
    // for scripts/ab-summary-quality.js — the scorer must run the production
    // prompt and the production filters, never a copy that can drift
    DIFF_SYSTEM, diffUserMessage, cleanWhat, REASONING_TELL,
    latestPair, narrativeWindows
};
