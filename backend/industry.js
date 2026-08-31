// Industry overview with Positive/Negative driver tags — the competitive-
// landscape section a real initiation report opens with, built from the
// company's OWN 10-K (Item 1 Business + Item 1A Risk Factors) plus computed
// peer/sector context. Two disciplines make it better than generic sell-side:
//   1. Every driver's evidence is a VERBATIM substring of the filing
//      (substring-validated; ungrounded quotes are dropped). No hallucinated
//      "industry color".
//   2. Direction is COMPANY-SPECIFIC, not headline sentiment: a pressure is
//      tagged Negative only if this company's margins/growth actually lag peers;
//      Mixed/Positive if it is holding up. The model is fed the company's margin
//      trajectory and growth percentile so the tag reflects the real response.
//   3. Market structure (HHI) is computed explicitly from sector peers, so
//      concentration/pricing-power is visible, not buried in prose.

const aiChat = require('./ai-chat');
const filing = require('./filing-fetcher');
const mongoose = require('mongoose');

// The industry build's cost is the driver EXTRACTOR — a filed-text model call
// inside get_peer_context that measured 34-65s, the single biggest Ask
// latency item. Drivers derive from the filing itself and 10-Ks are annual,
// so the extraction is cached in Mongo per (symbol, accession) and bumped by
// INDUSTRY_VERSION when the prompt/schema changes. sectorContext and the
// company-vs-peer facts stay live (in-memory math); the cached drivers' texts
// and narratives are filing-immutable. Concurrent builds for the same filing
// are coalesced so parallel Asks share one extraction.
const INDUSTRY_VERSION = 1;
function col() { return mongoose.connection.collection('industry_context'); }
const _inflight = new Map(); // 'SYM:accession:v' -> Promise

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
const median = (arr) => {
    const a = arr.filter((x) => x !== null && Number.isFinite(x)).sort((x, y) => x - y);
    if (!a.length) return null;
    const m = Math.floor(a.length / 2);
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
};

// Herfindahl-Hirschman index over the sector's market caps (0–1). >0.25
// concentrated, <0.10 fragmented. Labelled as an S&P-1500-subsample measure.
function sectorContext(symbol, sector) {
    let rows = [];
    try { rows = (aiChat.screenRows({ sector, limit: 800, maxLimit: 800 }) || {}).rows || []; } catch (_) { rows = []; }
    if (rows.length < 3) return null;
    const caps = rows.map((r) => num(r.marketCapB)).filter((x) => x !== null && x > 0);
    const total = caps.reduce((a, b) => a + b, 0);
    let hhi = null;
    if (total > 0 && caps.length) hhi = caps.reduce((a, c) => a + Math.pow(c / total, 2), 0);
    const structure = hhi === null ? null : hhi > 0.25 ? 'concentrated' : hhi < 0.10 ? 'fragmented' : 'moderately concentrated';
    return {
        peerCount: rows.length - 1,
        medianRevCagr5Pct: r1(median(rows.map((r) => num(r.revCagr5Pct)))),
        medianNetMarginPct: r1(median(rows.map((r) => num(r.netMarginPct)))),
        hhi: hhi === null ? null : Math.round(hhi * 1000) / 1000,
        structure,
        note: `Across ${rows.length} S&P 1500 names in ${sector}. HHI is a concentration proxy from this listed subsample, not the true global market.`
    };
}

const DRIVER_SYSTEM = [
    'You analyse the industry/competitive landscape of ONE company from its 10-K. Reply with ONLY a JSON object, no prose, no markdown fences.',
    'Schema: {"drivers": [{"driver": str, "direction": "positive"|"negative"|"mixed", "evidence": str, "source": "Item 1"|"Item 1A", "companyPosition": str, "rationale": str}], "sectorNarrative": str}',
    '"driver" = a specific industry/macro/competitive force named in the filing (e.g. AI demand, pricing pressure, regulation, input costs, consolidation). "evidence" = a SHORT VERBATIM quote copied exactly from the supplied text (so it can be matched back — do not paraphrase). "direction" = whether the force is, on balance, positive/negative/mixed FOR THIS COMPANY, judged using the supplied company-vs-peer facts (a pressure that this company is weathering better than peers is "mixed", not "negative"). "companyPosition" = one phrase (beneficiary / exposed / resilient / neutral). "rationale" = one sentence tying the tag to a company metric or the filing. 5-7 drivers. "sectorNarrative" = 2-3 neutral sentences describing the industry as the filing frames it.',
    'STRICT GROUNDING: evidence MUST be a real substring of the supplied text. Never invent figures, competitors, or outside facts. No advice, no buy/sell language.'
].join('\n');

function guard(o) { return o && Array.isArray(o.drivers); }

// `peers`/`financials` are passed in by the dossier to avoid recompute.
async function buildIndustry(symbol, { overview, peers = null, financials = null } = {}) {
    const sym = String(symbol || '').toUpperCase().trim();
    const sector = (overview && overview.Sector) || '';
    const ctx = sector ? sectorContext(sym, sector) : null;

    const got = await filing.getFilingText(sym, '10-K', { maxChars: 420000 });
    if (!got || got.error) return { error: (got && got.error) || 'No 10-K found.', sectorContext: ctx };

    const cacheKey = { symbol: sym, accession: got.accession, v: INDUSTRY_VERSION };
    let inflightKey = null;
    if (got.accession && mongoose.connection.readyState === 1) {
        try {
            const hit = await col().findOne(cacheKey);
            if (hit && hit.payload) return { ...hit.payload, sectorContext: ctx, cached: true };
        } catch (_) { /* cache best-effort */ }
        inflightKey = `${sym}:${got.accession}:${INDUSTRY_VERSION}`;
        if (_inflight.has(inflightKey)) return _inflight.get(inflightKey);
    }

    const build = (async () => {
        const text = filing.windows(got.text, [
        /\bitem\s*1\b\.?\s*business|^business$|our business|the company|principal products|competition/i,
        /competit|industry|market for|barriers to entry/i,
        /\bitem\s*1a\b|risk factors|risks (relating|related) to/i
    ], { before: 300, after: 9000, maxChars: 32000 });

    // company-vs-peer facts to ground the direction tags
    const facts = [];
    if (peers && peers.rank) {
        if (peers.rank.revCagr5Pct !== null) facts.push(`Revenue growth percentile vs sector peers: ${peers.rank.revCagr5Pct} (0=slowest,100=fastest).`);
        if (peers.rank.netMarginPct !== null) facts.push(`Net-margin percentile vs peers: ${peers.rank.netMarginPct}.`);
        if (peers.multiples) facts.push(`Trades at ${peers.multiples.companyPe}x P/E vs sector median ${peers.multiples.peerMedianPe}x.`);
    }
    if (financials && financials.length >= 2) {
        const a = financials[financials.length - 1], b = financials[0];
        if (a.opMarginPct !== null && b.opMarginPct !== null) facts.push(`Operating margin moved from ${b.opMarginPct}% to ${a.opMarginPct}% over the filed history (${a.opMarginPct >= b.opMarginPct ? 'expanding' : 'compressing'}).`);
    }
    if (ctx) facts.push(`Sector median revenue growth ${ctx.medianRevCagr5Pct}%/yr, median net margin ${ctx.medianNetMarginPct}%, market structure ${ctx.structure} (HHI ${ctx.hhi}).`);

    const user = `Company: ${(overview && overview.Name) || sym} — ${sector}${overview && overview.Industry ? ' / ' + overview.Industry : ''}.\n\nCompany-vs-peer facts (use these to set each driver's direction):\n${facts.join('\n') || 'n/a'}\n\n10-K text (windowed — Item 1 Business + Item 1A Risk Factors):\n${text}\n\nIdentify the industry drivers and tag each for this company.`;
    const ext = await filing.extractJson(DRIVER_SYSTEM, user, guard, { maxTokens: 2200 });
    if (!ext) return { error: 'Could not parse the industry drivers reliably.', sectorContext: ctx, filing: { date: got.date, url: got.url } };

    const DIR = new Set(['positive', 'negative', 'mixed']);
    const drivers = (ext.drivers || []).slice(0, 8).map((d) => {
        const evidence = String(d.evidence || '').slice(0, 240);
        const grounded = filing.isGrounded(evidence, text);
        return {
            driver: String(d.driver || '').slice(0, 120),
            direction: DIR.has(d.direction) ? d.direction : 'mixed',
            evidence: grounded ? evidence : null,
            grounded,
            source: /1a/i.test(String(d.source)) ? 'Item 1A' : 'Item 1',
            companyPosition: String(d.companyPosition || '').slice(0, 60),
            rationale: String(d.rationale || '').slice(0, 220)
        };
    }).filter((d) => d.driver);
    // grounded drivers first, then cap at 7
    drivers.sort((a, b) => (b.grounded === a.grounded ? 0 : b.grounded ? 1 : -1));
    const kept = drivers.slice(0, 7);

        const result = {
            sector,
            industry: (overview && overview.Industry) || null,
            sectorContext: ctx,
            sectorNarrative: String(ext.sectorNarrative || '').slice(0, 600),
            drivers: kept,
            groundedCount: kept.filter((d) => d.grounded).length,
            filing: { date: got.date, url: got.url, accession: got.accession },
            honesty: `Drivers are extracted from ${sym}'s own 10-K (Item 1 & Item 1A); each evidence quote is verified as verbatim filing text. Direction tags reflect this company's position versus ${ctx ? ctx.peerCount : 'its'} sector peers as of the filing date — descriptive, not advice.`
        };
        if (mongoose.connection.readyState === 1) {
            try { await col().updateOne(cacheKey, { $set: { payload: result } }, { upsert: true }); } catch (_) { /* cache best-effort */ }
        }
        return result;
    })();
    if (inflightKey) {
        _inflight.set(inflightKey, build);
        build.finally(() => _inflight.delete(inflightKey)).catch(() => {});
    }
    return build;
}

module.exports = { buildIndustry, sectorContext };
