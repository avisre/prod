// Research Dossier — "the initiation report a junior analyst spends 20-40 hours on."
//
// The Monitor answers "what changed in a name I already follow." This answers
// the prior question: "should I own this at all?" — an on-demand, from-scratch,
// decision-grade write-up on ANY ticker, threading every existing grounded
// surface (business, segments, 10-yr figures, valuation/reverse-DCF, analyst
// read, recent filing changes, health) into one synthesized, exportable
// document. Two new synthesis layers sit on top: an executive summary and a
// bull-vs-bear case — both written by the model over FINISHED facts only, so no
// figure can be invented. Cached in Mongo per (symbol, fiscal year): each
// dossier is paid for once per annual cycle, refreshed when a new 10-K lands.

const mongoose = require('mongoose');
const aiClient = require('./ai-client');
const aiChat = require('./ai-chat');
const insights = require('./insights');
const segments = require('./segments');
const reverseDcf = require('./reverse-dcf');
const filingMonitor = require('./filing-monitor');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
function dossierCol() { return mongoose.connection.collection('company_dossiers'); }

// Compact, grounded fact digest the synthesis models write over. ONLY finished
// numbers go in — the models never compute, only narrate.
function buildDigest({ overview, rdcf, deltas, checks, insightItems, segs }) {
    const lines = [];
    if (overview) {
        lines.push(`Company: ${overview.Name || ''} (${overview.Symbol || ''}), ${overview.Sector || 'n/a'} / ${overview.Industry || 'n/a'}.`);
        const mc = num(overview.MarketCapitalization);
        if (mc) lines.push(`Market cap ${(mc / 1e9).toFixed(1)}B, P/E ${overview.PERatio || 'n/a'}, profit margin ${overview.ProfitMargin || 'n/a'}, ROE ${overview.ReturnOnEquityTTM || 'n/a'}, dividend yield ${overview.DividendYield || 'n/a'}.`);
    }
    if (rdcf && !rdcf.error && rdcf.impliedGrowthPct !== null) {
        const r = rdcf.record || {};
        lines.push(`Valuation: today's price implies ~${rdcf.impliedGrowthPct}%/yr free-cash-flow growth for ${rdcf.assumptions.horizonYears}yr; actual FCF grew ${r.fcfCagr5Pct ?? 'n/a'}%/yr over 5yr and revenue ${r.revCagr5Pct ?? 'n/a'}%/yr.`);
    }
    if (deltas && deltas.length) {
        lines.push('Latest quarter YoY: ' + deltas.slice(0, 6).map((d) => `${d.label} ${d.latest} (${d.change})`).join(', ') + '.');
    }
    if (checks && checks.length) {
        const pass = checks.filter((c) => c.pass).length;
        lines.push(`Health checks: ${pass}/${checks.length} pass. Failing: ${checks.filter((c) => !c.pass).map((c) => c.label).join('; ') || 'none'}.`);
    }
    if (segs && segs.segments && segs.segments.length) {
        lines.push('Segments: ' + segs.segments.slice(0, 6).map((s) => `${s.name}${s.revenuePct != null ? ` (${s.revenuePct}%)` : ''}`).join(', ') + '.');
    }
    if (insightItems && insightItems.length) {
        lines.push('Analyst observations: ' + insightItems.map((i) => i.title).join('; ') + '.');
    }
    return lines.join('\n');
}

const SUMMARY_SYSTEM = [
    'You write the one-paragraph executive summary at the top of an equity research dossier, from the supplied facts digest.',
    'STRICT GROUNDING: use ONLY numbers and facts present in the digest. Never compute, estimate, or add outside knowledge. 3-5 sentences.',
    'Cover what the business is, how it has performed, and what the price assumes — neutrally. No buy/sell language, no advice, no exclamation marks.'
].join('\n');

const BULLBEAR_SYSTEM = [
    'You write the bull case and bear case for an equity research dossier, from the supplied facts digest. Reply with ONLY a JSON object, no prose, no markdown fences.',
    'Schema: {"bull": [{"point": str, "basis": str}], "bear": [{"point": str, "basis": str}]}',
    'Each side: 2-4 points. "point" is the argument in one sentence; "basis" cites the specific figure or fact from the digest it rests on.',
    'STRICT GROUNDING: every point must trace to a fact in the digest — never invent figures or outside facts. Balanced and neutral; describe the cases, do not recommend. No advice.'
].join('\n');

async function execSummary(digest) {
    try {
        const text = String(await aiClient.chat([
            { role: 'system', content: SUMMARY_SYSTEM },
            { role: 'user', content: `Facts digest:\n${digest}\n\nWrite the executive summary.` }
        ], { temperature: 0.3, maxTokens: 360, purpose: 'summary', timeoutMs: 40000 }) || '').trim();
        return text || null;
    } catch (_) { return null; }
}

async function bullBear(digest) {
    const callModel = (extra) => aiClient.chatRaw([
        { role: 'system', content: BULLBEAR_SYSTEM },
        { role: 'user', content: `Facts digest:\n${digest}${extra}\n\nWrite the bull and bear cases.` }
    ], { purpose: 'summary', temperature: 0.3, maxTokens: 1400, timeoutMs: 45000 });
    const tryParse = (msg) => {
        try {
            const raw = String(msg.content || '').replace(/```json|```/g, '').trim();
            const p = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
            return (Array.isArray(p.bull) && Array.isArray(p.bear)) ? p : null;
        } catch (_) { return null; }
    };
    let parsed = null;
    try { parsed = tryParse(await callModel('')); } catch (_) { parsed = null; }
    if (!parsed) { try { parsed = tryParse(await callModel('\nREPLY WITH ONLY THE JSON OBJECT.')); } catch (_) { parsed = null; } }
    if (!parsed) return null;
    const clean = (arr) => arr.slice(0, 4).map((x) => ({
        point: String(x.point || '').slice(0, 240),
        basis: String(x.basis || '').slice(0, 240)
    })).filter((x) => x.point);
    return { bull: clean(parsed.bull), bear: clean(parsed.bear) };
}

// Orchestrate. The expensive grounded pieces are independent module calls, each
// itself cached — run them concurrently, tolerate any single failure.
async function buildDossier(symbol, { force = false, onStage = () => {} } = {}) {
    const sym = String(symbol || '').toUpperCase().trim();
    if (!/^[A-Z0-9.\-]{1,10}$/.test(sym)) return { error: 'Invalid ticker.' };

    const data = await aiChat.loadFundAny(sym).catch(() => null);
    if (!data) return { error: `No data for ${sym}. We cover US exchange-listed SEC filers reporting in USD.` };
    const overview = data.overview || {};
    const pack = insights.buildFactPack(sym); // gives the fiscal-year cache key
    const fyEnd = pack ? pack.fyEnd : (((data.income || {}).annualReports || [])[0] || {}).fiscalDateEnding || 'na';

    const col = dossierCol();
    if (!force) {
        try {
            const hit = await col.findOne({ symbol: sym, fyEnd }, { projection: { _id: 0 } });
            if (hit && hit.payload) return { ...hit.payload, cached: true };
        } catch (_) { /* cache best-effort */ }
    }

    onStage('gathering'); // pulling the grounded surfaces (the slow part)
    const [rdcfR, checksR, insightsR, segsR, monitorR] = await Promise.allSettled([
        reverseDcf.computeReverseDcf(sym),
        Promise.resolve().then(() => aiChat.runTool('get_health_checks', { symbol: sym }, {})),
        insights.generateInsights(sym),
        segments.extractSegments(sym),
        filingMonitor.buildReport(sym).catch(() => null)
    ]);
    const ok = (r) => (r.status === 'fulfilled' && r.value && !r.value.error ? r.value : null);
    const rdcf = ok(rdcfR);
    const checks = (checksR.status === 'fulfilled' && checksR.value && Array.isArray(checksR.value.checks)) ? checksR.value.checks : [];
    const insightItems = (ok(insightsR) || {}).insights || [];
    const segs = ok(segsR);
    const monitor = ok(monitorR);
    const deltas = monitor && monitor.deltas ? monitor.deltas : [];

    const digest = buildDigest({ overview, rdcf, deltas, checks, insightItems, segs });
    onStage('writing'); // executive summary + bull/bear synthesis
    const [summary, bb] = await Promise.all([execSummary(digest), bullBear(digest)]);

    const mc = num(overview.MarketCapitalization);
    const payload = {
        symbol: sym,
        name: overview.Name || sym,
        sector: overview.Sector || '',
        industry: overview.Industry || '',
        fyEnd,
        snapshot: {
            marketCap: mc,
            pe: overview.PERatio || null,
            eps: overview.EPS || null,
            profitMargin: overview.ProfitMargin || null,
            roe: overview.ReturnOnEquityTTM || null,
            dividendYield: overview.DividendYield || null,
            description: String(overview.Description || '').slice(0, 600)
        },
        executiveSummary: summary,
        keyFigures: pack ? pack.lines : null,
        segments: segs ? { fiscalYear: segs.fiscalYear, items: segs.segments, note: segs.note || null } : null,
        valuation: rdcf ? {
            impliedGrowthPct: rdcf.impliedGrowthPct,
            assumptions: rdcf.assumptions,
            record: rdcf.record,
            marketCap: rdcf.marketCap,
            note: rdcf.notes && rdcf.notes[0] ? rdcf.notes[0] : null
        } : null,
        analystRead: insightItems,
        bull: bb ? bb.bull : [],
        bear: bb ? bb.bear : [],
        healthChecks: checks.map((c) => ({ label: c.label, pass: !!c.pass, detail: c.detail || '' })),
        recentChanges: monitor ? {
            summary: monitor.summary,
            materiality: monitor.materiality,
            bucket: monitor.materialityBucket,
            headline: monitor.narrative ? monitor.narrative.headline : null,
            tone: monitor.narrative ? monitor.narrative.tone : null,
            deltas: monitor.deltas ? monitor.deltas.slice(0, 6) : [],
            filing: monitor.periodic || monitor.latestFiling || null
        } : null,
        sources: {
            filings: 'SEC EDGAR 10-K/10-Q (statements, segments, risk language)',
            note: 'Every figure is computed from SEC-filed statements; prose is written over those finished facts. Educational, not investment advice.'
        },
        generatedAt: new Date().toISOString()
    };

    try {
        await col.updateOne({ symbol: sym, fyEnd }, { $set: { symbol: sym, fyEnd, payload, at: new Date() } }, { upsert: true });
    } catch (_) { /* cache best-effort */ }
    return payload;
}

// Build-free cache peek for the decoupled poll path.
async function peekDossier(symbol) {
    const sym = String(symbol || '').toUpperCase().trim();
    try {
        const data = await aiChat.loadFundAny(sym).catch(() => null);
        if (!data) return null;
        const pack = insights.buildFactPack(sym);
        const fyEnd = pack ? pack.fyEnd : (((data.income || {}).annualReports || [])[0] || {}).fiscalDateEnding || 'na';
        const hit = await dossierCol().findOne({ symbol: sym, fyEnd }, { projection: { _id: 0 } });
        return hit && hit.payload ? { ...hit.payload, cached: true } : null;
    } catch (_) { return null; }
}

module.exports = { buildDossier, peekDossier, buildDigest };
