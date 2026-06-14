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

function htmlToText(html) {
    return String(html)
        .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#160;/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/\s+/g, ' ');
}

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

// Newest 10-K or 10-Q plus the previous filing of the same form.
async function latestPair(symbol) {
    const filings = await watchdog.fetchRecentFilings(symbol, new Set(['10-K', '10-Q']), 12);
    if (!filings || !filings.length) return null;
    const latest = filings[0];
    const prev = filings.slice(1).find((f) => f.form === latest.form) || null;
    if (!prev) return null;
    return { latest, prev };
}

const DIFF_SYSTEM = [
    'You compare two SEC filings from the SAME company: the NEW one and the PRIOR one of the same form. Reply with ONLY a JSON object, no prose, no markdown fences.',
    'Schema: {"headline": str, "changes": [{"area": str, "what": str, "quote": str|null}], "tone": "improving"|"stable"|"deteriorating"|null}',
    '"headline" is one sentence: the single most decision-relevant change (or "Little changed" if true). Each "changes" item: "area" is a short label (Guidance, Risk factors, Demand, Margins, Liquidity, Legal, Segments...), "what" is 1-2 factual sentences on what changed NEW vs PRIOR, "quote" is a short verbatim phrase from the NEW filing when one exists.',
    'STRICT GROUNDING: only report differences observable between the two supplied texts. Both are excerpts — if something is absent from the excerpts, do not speculate about it. Never use outside knowledge, never estimate numbers not present. 3-7 changes; fewer if little changed.',
    'No investment advice, no buy/sell language — describe, never recommend.'
].join('\n');

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
        if (hit) return { ...hit.payload, cached: true };
    } catch (_) { /* cache is best-effort */ }

    const get = (url) => axios.get(url, { headers: secSource.SEC_HEADERS, timeout: 30000, maxContentLength: 40e6 });
    const newDoc = narrativeWindows(htmlToText((await get(latest.url)).data));
    const oldDoc = narrativeWindows(htmlToText((await get(prev.url)).data));
    if (newDoc.length < 500 || oldDoc.length < 500) return { error: 'Could not read the filing text.' };

    const callModel = (extra) => aiClient.chatRaw([
        { role: 'system', content: DIFF_SYSTEM },
        {
            role: 'user',
            content: `Company: ${sym}. Compare the NEW ${latest.form} (filed ${latest.date}) against the PRIOR ${prev.form} (filed ${prev.date}).${extra}\n\n=== PRIOR FILING (${prev.date}) — excerpts ===\n${oldDoc}\n\n=== NEW FILING (${latest.date}) — excerpts ===\n${newDoc}`
        }
    ], { purpose: 'summary', temperature: 0, maxTokens: 4000, timeoutMs: 40000 });

    const tryParse = (msg) => {
        try {
            const raw = String(msg.content || '').replace(/```json|```/g, '').trim();
            const p = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
            return typeof p.headline === 'string' && Array.isArray(p.changes) ? p : null;
        } catch (_) { return null; }
    };

    let parsed = tryParse(await callModel(''));
    if (!parsed) {
        parsed = tryParse(await callModel(' REPLY WITH ONLY THE JSON OBJECT — your entire reply must parse as JSON.'));
    }
    if (!parsed) return { error: 'Comparison failed — try again later.' };

    const payload = {
        symbol: sym,
        headline: String(parsed.headline || '').slice(0, 300),
        tone: ['improving', 'stable', 'deteriorating'].includes(parsed.tone) ? parsed.tone : null,
        changes: parsed.changes.slice(0, 8).map((c) => ({
            area: String(c.area || '').slice(0, 60),
            what: String(c.what || '').slice(0, 500),
            quote: c.quote ? String(c.quote).slice(0, 280) : null
        })).filter((c) => c.area && c.what),
        latest: { form: latest.form, date: latest.date, url: latest.url },
        prev: { form: prev.form, date: prev.date, url: prev.url },
        note: 'Compared from narrative excerpts (outlook, risks, MD&A) of both filings — quotes are verbatim from the new filing. Not advice.',
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

module.exports = { computeFilingDiff };
