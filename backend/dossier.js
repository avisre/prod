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
const crypto = require('crypto');
const aiClient = require('./ai-client');
const aiChat = require('./ai-chat');
const { plainSummary, plainJsonArray, plainBullBear } = require('./plain-language');
const insights = require('./insights');
const segments = require('./segments');
const unitEconomics = require('./unit-economics');
const reverseDcf = require('./reverse-dcf');
const filingMonitor = require('./filing-monitor');
// bumped: statements are now stored USD-converted, and per-share figures are on
// the ADS basis. Cached dossiers built before this assumed USD-native filers, and
// the compare route reads them build-free — so they must not survive the change.
const DOSSIER_SCHEMA_VERSION = 7;
const analysis = require('./dossier-analysis');
const incomeStmt = require('./income-statement');
const governance = require('./governance');
const esgMod = require('./esg');
const industry = require('./industry');
const valuationDcf = require('./valuation-dcf');
const dossierBuildLock = require('./dossier-build-lock');
const keypoints = require('./keypoints');

const num = require('./sec-coverage').number;
function dossierCol() { return mongoose.connection.collection('company_dossiers'); }
const DossierBuildLock = dossierBuildLock.createModel(mongoose);
const DOSSIER_BUILD_LEASE_MS = 15 * 60 * 1000;
const DOSSIER_BUILD_WAIT_MS = 6 * 60 * 1000;

// A build publishes a "partial" dossier (every data section, narrative empty)
// the moment gathering finishes, then overwrites it with the full payload when
// the writing round completes. Fresh partials are served to polls so users see
// the data sections ~20s in instead of ~90s+; but if the builder dies between
// the two writes, a partial left older than this is abandoned — reads treat it
// as a miss so the next non-poll request rebuilds from scratch.
const DOSSIER_PARTIAL_STALE_MS = 10 * 60 * 1000;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

// Upsert the dossier doc. Used twice per build: once for the published partial
// and once for the finished payload that overwrites it.
async function writeDossierDoc(col, sym, fyEnd, depth, payload) {
    // Filter shape mirrors cachedDossier's read exactly. Deep must match
    // ONLY an explicit deep doc (else it would overwrite the Standard
    // one at the same {symbol, fyEnd}); Standard must match ANY non-deep
    // doc, including one cached before this field existed — otherwise a
    // force-refresh of a legacy dossier would fail to match and insert
    // an orphaned duplicate instead of updating it in place.
    const filter = depth === 'deep'
        ? { symbol: sym, fyEnd, depth: 'deep' }
        : { symbol: sym, fyEnd, depth: { $ne: 'deep' } };
    await col.updateOne(filter, { $set: { symbol: sym, fyEnd, depth, payload, at: new Date() } }, { upsert: true });
}

// depth is not a schema-version bump: an existing Standard dossier is not
// wrong, it is just missing this field. So a Standard request matches any
// document that isn't explicitly 'deep' (covers every dossier cached before
// this field existed) — nothing already built gets silently invalidated. A
// Deep request matches only an explicit 'deep' document, which by definition
// cannot exist yet, so it always builds fresh the first time.
async function cachedDossier(col, sym, fyEnd, depth = 'standard', evidenceFingerprint = null) {
    const query = depth === 'deep'
        ? { symbol: sym, fyEnd, depth: 'deep' }
        : { symbol: sym, fyEnd, depth: { $ne: 'deep' } };
    const hit = await col.findOne(query, { projection: { _id: 0 } });
    // Partials are excluded here deliberately: this read is what the lease
    // re-checks and the build-time cache checks use, and treating a draft as
    // done would (a) return a narrative-less dossier as final to a concurrent
    // requester who then stops polling, and (b) skip the spend that funds the
    // build still in flight. Only peekDossier serves partials.
    return hit && hit.payload && hit.payload.schemaVersion === DOSSIER_SCHEMA_VERSION && !hit.payload.partial && (!evidenceFingerprint || hit.payload.evidenceFingerprint===evidenceFingerprint)
        ? { ...hit.payload, cached: true }
        : null;
}

// Prices refresh independently of the saved filing analysis. No model call.
async function refreshValuation(payload, sym, data) {
    if(!data.marketData?.asOf)return payload;
    const rdcf=reverseDcf.computeFromData(sym,data);
    const forward=await valuationDcf.buildValuation(sym,{data,rdcf:rdcf.error?null:rdcf});
    return {...payload,marketData:data.marketData,valuationAsOf:data.marketData.asOf,
        snapshot:{...payload.snapshot,marketCap:data.overview.MarketCapitalization,pe:data.overview.PERatio,price:data.marketData.price},
        valuation:rdcf.error?{error:rdcf.error}: {impliedGrowthPct:rdcf.impliedGrowthPct,assumptions:rdcf.assumptions,record:rdcf.record,marketCap:rdcf.marketCap,scenarios:rdcf.scenarios || null,note:rdcf.notes?.[0] || null},
        forwardDcf:forward, narrativeAsOf:payload.generatedAt || payload.at || null};
}

async function acquireDossierLease(col, sym, fyEnd, depth, onStage, evidenceFingerprint) {
    const key = `${sym}:${fyEnd}:${depth}:v${DOSSIER_SCHEMA_VERSION}`;
    const owner = crypto.randomUUID();
    const deadline = Date.now() + DOSSIER_BUILD_WAIT_MS;

    for (;;) {
        const lease = await dossierBuildLock.acquire(DossierBuildLock, {
            key, owner, leaseMs: DOSSIER_BUILD_LEASE_MS
        });
        if (lease.acquired) return { key, owner };

        onStage('queued');
        const cached = await cachedDossier(col, sym, fyEnd, depth, evidenceFingerprint);
        if (cached) return { cached };
        if (Date.now() >= deadline) return { busy: true };
        await sleep(1000);
    }
}

// Compact, grounded fact digest the synthesis models write over. ONLY finished
// numbers go in — the models never compute, only narrate.
function buildDigest({ overview, rdcf, deltas, checks, insightItems, segs, peers, forensic, valuation, gov, industryData, esg, ue }) {
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
    if (ue && ue.derived && ue.derived.revenuePerUnit != null) {
        const d = ue.derived;
        lines.push(`Unit economics (${d.period}): ${d.volume.toLocaleString()} ${d.unitLabel}${d.unitLabel.endsWith('s') ? '' : 's'}, revenue/unit $${Math.round(d.revenuePerUnit).toLocaleString()}${d.grossProfitPerUnit != null ? `, gross profit/unit $${Math.round(d.grossProfitPerUnit).toLocaleString()}` : ''}.`);
    }
    if (insightItems && insightItems.length) {
        lines.push('Analyst observations: ' + insightItems.map((i) => i.title).join('; ') + '.');
    }
    if (peers) {
        lines.push(`Competitive: ${peers.verdict}`);
        if (peers.multiples) lines.push(`Peer multiples: trades at ${peers.multiples.companyPe}x P/E vs sector median ${peers.multiples.peerMedianPe}x (${peers.multiples.premiumPct >= 0 ? '+' : ''}${peers.multiples.premiumPct}%).`);
    }
    if (forensic && forensic.length) {
        lines.push('Forensic signals: ' + forensic.map((s) => `${s.label} = ${s.value} (${s.read})`).join(' | '));
    }
    if (valuation && !valuation.error && valuation.fairValue && valuation.fairValue.perShare !== null) {
        const fv = valuation.fairValue;
        lines.push(`Forward DCF: base-case fair value ~$${fv.perShare}/share vs ~$${fv.currentPrice}/share now (${fv.upsidePct >= 0 ? '+' : ''}${fv.upsidePct}%); WACC ${valuation.waccBuildup.waccPct}% (Re ${valuation.waccBuildup.costOfEquityPct}%, beta ${valuation.waccBuildup.beta}). ${fv.status || ''}`);
    }
    if (industryData && !industryData.error && industryData.drivers && industryData.drivers.length) {
        const tag = (d) => `${d.driver} [${d.direction}]`;
        lines.push('Industry drivers: ' + industryData.drivers.slice(0, 6).map(tag).join('; ') + (industryData.sectorContext ? ` (sector ${industryData.sectorContext.structure}, HHI ${industryData.sectorContext.hhi}).` : '.'));
    }
    if (gov) {
        const b = gov.board;
        const bits = [];
        if (b) { if (b.independencePct !== null) bits.push(`board ${b.independencePct}% independent`); if (b.ceoChairCombined === true) bits.push('CEO/Chair combined'); if (b.dualClassShares === true) bits.push('dual-class shares'); if (b.ceoPayRatio !== null) bits.push(`CEO pay ${Math.round(b.ceoPayRatio)}× median`); }
        if (gov.insider && gov.insider.sentiment) bits.push(`insiders ${gov.insider.sentiment} (8q)`);
        if (gov.ownership && gov.ownership.holderCount) bits.push(`${gov.ownership.holderCount} tracked investors hold it`);
        if (bits.length) lines.push('Governance/ownership: ' + bits.join(', ') + '.');
        if (gov.redFlags && gov.redFlags.length) lines.push('Governance flags: ' + gov.redFlags.join(' ').slice(0, 400));
    }
    if (esg && esg.transparency) {
        lines.push(`ESG disclosure transparency: ${esg.transparency.overall}/100 (${esg.transparency.verdict}) — governance ${esg.transparency.byPillar.governance}, environmental ${esg.transparency.byPillar.environmental}, human-capital ${esg.transparency.byPillar.humanCapital}.`);
        if (esg.litigation && esg.litigation.materiality && esg.litigation.materiality !== 'none' && esg.litigation.materiality !== 'low') lines.push(`Litigation materiality: ${esg.litigation.materiality}.`);
    }
    return lines.join('\n');
}

const RISK_SYSTEM = [
    'You write the RISK FACTORS section of an equity research dossier from the supplied facts digest. Reply with ONLY a JSON object, no prose, no fences.',
    'Schema: {"risks": [{"risk": str, "trigger": str, "impact": str, "mitigant": str, "severity": "high"|"medium"|"low"}]}',
    'A good risk is NOT generic — each states the specific CONDITION under which it materialises ("trigger"), the concrete EFFECT on the business or valuation ("impact"), and a "mitigant": the offsetting factor in the supplied facts that softens it (or "" if none). 3-5 risks, drawn from the digest (e.g. expectation gap, margin compression, leverage, customer/segment concentration, dividend coverage, decelerating growth, the filing\'s own flagged changes).',
    'STRICT GROUNDING: tie each risk and mitigant to a fact in the digest; never invent figures or outside facts. No advice, no buy/sell language.'
].join('\n');

const EDGE_SYSTEM = [
    'You write the "Edge" section of an equity research dossier — the few NON-OBVIOUS, decision-relevant observations a generic summary would miss, drawn from the computed forensic signals supplied. Reply with ONLY a JSON object, no prose, no fences.',
    'Schema: {"insights": [{"insight": str, "evidence": str, "soWhat": str}]}',
    'Pick the 3-4 MOST surprising or consequential signals (e.g. an expectation gap, weak FCF conversion, an accruals flag, margin trajectory, capital-allocation read, Rule of 40, leverage). "insight" is the non-obvious point; "evidence" is the specific number from the signals; "soWhat" is why it matters for a decision.',
    'STRICT GROUNDING: every insight must rest on a supplied signal — never invent numbers. Be sharp and specific, not generic. No advice, no buy/sell language.'
].join('\n');

function parseObj(msg, guard) {
    try {
        const raw = String(msg.content || '').replace(/```json|```/g, '').trim();
        const p = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
        return guard(p) ? p : null;
    } catch (_) { return null; }
}

async function riskSection(digest) {
    const call = (extra) => aiClient.chatRaw([
        { role: 'system', content: RISK_SYSTEM },
        { role: 'user', content: `Facts digest:\n${digest}${extra}\n\nWrite the risk factors.` }
    ], { purpose: 'summary', temperature: 0.3, maxTokens: 1400, timeoutMs: 90000 });
    let p = null;
    try { p = parseObj(await call(''), (x) => Array.isArray(x.risks)); } catch (e) { p = null; console.warn('[dossier] risks attempt 1:', e.message); }
    if (!p) { try { p = parseObj(await call('\nREPLY WITH ONLY THE JSON OBJECT.'), (x) => Array.isArray(x.risks)); } catch (e) { p = null; console.warn('[dossier] risks attempt 2:', e.message); } }
    if (!p) { console.warn('[dossier] risks section empty after 2 attempts'); return []; }
    const SEV = new Set(['high', 'medium', 'low']);
    return p.risks.slice(0, 5).map((r) => ({
        risk: String(r.risk || '').slice(0, 200),
        trigger: String(r.trigger || '').slice(0, 240),
        impact: String(r.impact || '').slice(0, 240),
        mitigant: String(r.mitigant || '').slice(0, 240),
        severity: SEV.has(r.severity) ? r.severity : 'medium'
    })).filter((r) => r.risk);
}

async function edgeSection(forensic) {
    if (!forensic || !forensic.length) return [];
    const digest = forensic.map((s) => `- ${s.label}: ${s.value} — ${s.read} [${s.flag}]`).join('\n');
    const call = (extra) => aiClient.chatRaw([
        { role: 'system', content: EDGE_SYSTEM },
        { role: 'user', content: `Computed forensic signals:\n${digest}${extra}\n\nWrite the Edge section.` }
    ], { purpose: 'summary', temperature: 0.3, maxTokens: 1200, timeoutMs: 90000 });
    let p = null;
    try { p = parseObj(await call(''), (x) => Array.isArray(x.insights)); } catch (e) { p = null; console.warn('[dossier] edge attempt 1:', e.message); }
    if (!p) { try { p = parseObj(await call('\nREPLY WITH ONLY THE JSON OBJECT.'), (x) => Array.isArray(x.insights)); } catch (e) { p = null; console.warn('[dossier] edge attempt 2:', e.message); } }
    if (!p) return [];
    return p.insights.slice(0, 4).map((i) => ({
        insight: String(i.insight || '').slice(0, 220),
        evidence: String(i.evidence || '').slice(0, 160),
        soWhat: String(i.soWhat || '').slice(0, 240)
    })).filter((i) => i.insight);
}

const SUMMARY_SYSTEM = [
    'You write the one-paragraph executive summary at the top of an equity research dossier, from the supplied facts digest.',
    'STRICT GROUNDING: use ONLY numbers and facts present in the digest. Never compute, estimate, or add outside knowledge. Write 4-6 compact sentences.',
    'Build an evidence-led argument, not a generic company description: quantify the multi-year operating trajectory, compare at least one company metric with its peer median when supplied, state what the current valuation implies versus the historical record, and finish with the most important unresolved tension or limitation in the supplied facts.',
    'Do not use empty adjectives such as strong, solid, attractive, compelling, significant, healthy or concerning unless the same clause contains the exact evidence that earns the word. Do not merely list metrics; explain the relationship between them. No buy/sell language, no advice, no exclamation marks.'
].join('\n');

const BULLBEAR_SYSTEM = [
    'You write the bull case and bear case for an equity research dossier, from the supplied facts digest. Reply with ONLY a JSON object, no prose, no markdown fences.',
    'Schema: {"bull": [{"point": str, "basis": str}], "bear": [{"point": str, "basis": str}]}',
    'Each side: 2-4 points. "point" is the argument in one sentence; "basis" cites the specific figure or fact from the digest it rests on.',
    'STRICT GROUNDING: every point must trace to a fact in the digest — never invent figures or outside facts. Balanced and neutral; describe the cases, do not recommend. No advice.'
].join('\n');

async function execSummary(digest) {
    // The four section calls fire concurrently, and under provider contention
    // the first attempt can time out even at 90s. Every other section already
    // gets a second attempt, which is what rescues them — measured 2026-09-22
    // on the BABA digest, where attempt 1 timed out for bull/bear, risks and
    // edge yet all three recovered on retry, while the summary (the only
    // section with no retry) was the one that went missing from the page.
    // Identity-blocked output is NOT retried: that is a deliberate refusal,
    // not a transient fault, and asking again just burns another call.
    const once = async () => String(await aiClient.chat([
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: `Facts digest:\n${digest}\n\nWrite the executive summary.` }
    ], { temperature: 0.3, maxTokens: 360, purpose: 'summary', timeoutMs: 90000 }) || '').trim();
    try {
        return (await once()) || null;
    } catch (e) {
        if (e && e.code === 'AI_IDENTITY_BLOCKED') { console.warn('[dossier] summary blocked on identity'); return null; }
        console.warn('[dossier] summary attempt 1:', e.message);
    }
    try {
        return (await once()) || null;
    } catch (e) {
        console.warn('[dossier] summary attempt 2:', e.message);
        return null;
    }
}

async function bullBear(digest) {
    const callModel = (extra) => aiClient.chatRaw([
        { role: 'system', content: BULLBEAR_SYSTEM },
        { role: 'user', content: `Facts digest:\n${digest}${extra}\n\nWrite the bull and bear cases.` }
    ], { purpose: 'summary', temperature: 0.3, maxTokens: 1400, timeoutMs: 90000 });
    const tryParse = (msg) => {
        try {
            const raw = String(msg.content || '').replace(/```json|```/g, '').trim();
            const p = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
            return (Array.isArray(p.bull) && Array.isArray(p.bear)) ? p : null;
        } catch (_) { return null; }
    };
    let parsed = null;
    try { parsed = tryParse(await callModel('')); } catch (e) { parsed = null; console.warn('[dossier] bull/bear attempt 1:', e.message); }
    if (!parsed) { try { parsed = tryParse(await callModel('\nREPLY WITH ONLY THE JSON OBJECT.')); } catch (e) { parsed = null; console.warn('[dossier] bull/bear attempt 2:', e.message); } }
    if (!parsed) { console.warn('[dossier] bull/bear empty after 2 attempts'); return null; }
    const clean = (arr) => arr.slice(0, 4).map((x) => ({
        point: String(x.point || '').slice(0, 240),
        basis: String(x.basis || '').slice(0, 240)
    })).filter((x) => x.point);
    return { bull: clean(parsed.bull), bear: clean(parsed.bear) };
}

// Orchestrate. The expensive grounded pieces are independent module calls, each
// itself cached — run them concurrently, tolerate any single failure.
async function buildDossier(symbol, { force = false, onStage = () => {}, depth = 'standard' } = {}) {
    const sym = String(symbol || '').toUpperCase().trim();
    if (!/^[A-Z0-9.\-]{1,10}$/.test(sym)) return { error: 'Invalid ticker.' };
    depth = depth === 'deep' ? 'deep' : 'standard';

    const data = await aiChat.loadFundAny(sym).catch(() => null);
    if (!data) return { error: `No data for ${sym}. We cover US exchange-listed SEC filers. Check the ticker symbol.` };
    const evidenceFingerprint=data.provenance?.evidenceFingerprint || data.provenance?.financialDigest;
    const overview = data.overview || {};
    const pack = insights.buildFactPack(sym,data); // gives the fiscal-year cache key
    const fyEnd = pack ? pack.fyEnd : (((data.income || {}).annualReports || [])[0] || {}).fiscalDateEnding || 'na';

    const col = dossierCol();
    if (!force) {
        try {
            const hit = await cachedDossier(col, sym, fyEnd, depth, evidenceFingerprint);
            if (hit) return refreshValuation(hit,sym,data);
        } catch (_) { /* cache best-effort */ }
    }

    let buildLease = null;
    try {
        try {
            const lease = await acquireDossierLease(col, sym, fyEnd, depth, onStage, evidenceFingerprint);
            if (lease.cached) return refreshValuation(lease.cached,sym,data);
            if (lease.busy) return { status: 'building', symbol: sym, stage: 'queued' };
            buildLease = lease;

            // Another worker may have completed between our first cache read
            // and this lease acquisition. Re-check before spending any AI.
            if (!force) {
                const hit = await cachedDossier(col, sym, fyEnd, depth, evidenceFingerprint);
                if (hit) return refreshValuation(hit,sym,data);
            }
        } catch (error) {
            // Availability wins if Mongo's lock collection is temporarily
            // unavailable. The route's in-process promise map still coalesces
            // requests on this instance, and the final cache write remains
            // best-effort as before.
            console.warn('[dossier] build lease unavailable:', error.message);
        }

        onStage('gathering'); // pulling the grounded surfaces (the slow part)
        // Deep does NOT re-run governance/ESG/segments/unit-economics across
        // three years — those are current-state facts, not historical ones, and
        // tripling them would be expensive and mostly redundant. Its value is
        // the year-over-year keypoints comparison: newly disclosed risks,
        // dropped risks, strategy drift — reused here rather than rebuilt.
        const [rdcfR, checksR, insightsR, segsR, monitorR, ueR, trendR] = await Promise.allSettled([
            reverseDcf.computeReverseDcf(sym),
            Promise.resolve().then(() => aiChat.runTool('get_health_checks', { symbol: sym }, {})),
            insights.generateInsights(sym),
            segments.extractSegments(sym),
            filingMonitor.buildReport(sym).catch(() => null),
            unitEconomics.extract(sym),
            depth === 'deep' ? keypoints.extractKeyPoints(sym, { depth: 'deep', allowAi: true }) : Promise.resolve(null)
        ]);
    const ok = (r) => (r.status === 'fulfilled' && r.value && !r.value.error ? r.value : null);
    const rdcf = ok(rdcfR);
    const checks = (checksR.status === 'fulfilled' && checksR.value && Array.isArray(checksR.value.checks)) ? checksR.value.checks : [];
    const insightItems = (ok(insightsR) || {}).insights || [];
    const segs = ok(segsR);
    const monitor = ok(monitorR);
    const ue = ok(ueR);
    const deltas = monitor && monitor.deltas ? monitor.deltas : [];
    const trendResult = ok(trendR);
    const yearOverYear = (trendResult && trendResult.depth === 'deep' && Array.isArray(trendResult.yearOverYear))
        ? trendResult.yearOverYear : [];

    // deterministic layers (cheap, in-memory): peer/competitive + forensic edge
    let peers = null;
    try { peers = analysis.peerAnalysis(sym, overview); } catch (_) { peers = null; }
    let forensic = [];
    try { forensic = analysis.forensicSignals(data, rdcf, overview); } catch (_) { forensic = []; }
    let financials = null;
    try { financials = analysis.financialHistory(data); } catch (_) { financials = null; }
    // Absolute income-statement dollars for the revenue-flow chart.
    // financialHistory() deliberately emits margins only, so the payload has
    // never carried gross profit or cost of sales in dollars — which is also
    // why Normal mode's "where the money goes" band has always rendered empty.
    let incomeStatement = null;
    try {
        incomeStatement = incomeStmt.repairIncome((((data.income || {}).annualReports) || [])[0]);
    } catch (_) { incomeStatement = null; }

    // Initiation-grade grounded sections — industry, governance and the forward
    // DCF run concurrently (each fetches its own SEC filing or is pure compute);
    // ESG runs after, reusing governance's board leg and the now-cached 10-K text.
    const [govR, industryR, valuationR] = await Promise.allSettled([
        governance.buildGovernance(sym, { name: overview.Name }),
        industry.buildIndustry(sym, { overview, peers, financials }),
        valuationDcf.buildValuation(sym, { data, rdcf })
    ]);
    const gov = govR.status === 'fulfilled' ? govR.value : null;
    const industryData = ok(industryR);
    const valuation = ok(valuationR);
    let esg = null;
    try { esg = await esgMod.buildESG(sym, { governance: gov }); } catch (_) { esg = null; }
    if (esg && esg.error && !esg.governance && !esg.environmental && !esg.humanCapital) esg = null;

    let digest = buildDigest({ overview, rdcf, deltas, checks, insightItems, segs, peers, forensic, valuation, gov, industryData, esg, ue });
    if (yearOverYear.length) {
        // Appended, not threaded through buildDigest's signature: this keeps
        // the single-year digest shape unchanged for every other caller and
        // for Standard dossiers, and lets the writers reference what changed
        // without a second, parallel "grounding" concept to reason about.
        digest += '\n\nYear-over-year changes (from the last 3 filed 10-Ks):\n' +
            yearOverYear.map((s) => `${s.heading}: ${s.points.join(' ')}`).join('\n');
    }
    const mc = num(overview.MarketCapitalization);
    // Publish the payload with the narrative sections still empty: the poll
    // route serves this partial the moment it lands, so users watch the data
    // sections fill in at ~20s instead of waiting blind for the whole build.
    // The writing round then merges the narrative in over these draft values
    // and the same doc is overwritten with the finished payload.
    const payload = {
        schemaVersion: DOSSIER_SCHEMA_VERSION,evidenceFingerprint,financialSources:data.provenance,supplementalObservations:data.supplementalObservations || [],financialCoverage:data.coverage,
        symbol: sym,
        name: overview.Name || sym,
        sector: overview.Sector || '',
        industry: overview.Industry || '',
        fyEnd,
        depth,
        yearOverYear,
        filingHistory: (trendResult && trendResult.history) || null,
        snapshot: {
            marketCap: mc,
            pe: overview.PERatio || null,
            eps: overview.EPS || null,
            profitMargin: overview.ProfitMargin || null,
            roe: overview.ReturnOnEquityTTM || null,
            dividendYield: overview.DividendYield || null,
            description: String(overview.Description || '').slice(0, 600)
        },
        executiveSummary: null,
        executiveSummaryPlain: null,
        partial: true,
        keyFigures: pack ? pack.lines : null,
        industry: industryData || null,
        segments: segs ? {
            fiscalYear: segs.fiscalYear,
            items: segs.segments,
            note: segs.note || null,
            // Kept so the panel can cite the exact filing the split came from
            // rather than asserting it unsourced; both were dropped before.
            basis: segs.basis || null,
            filing: segs.filing || null
        } : null,
        unitEconomics: ue && (ue.derived || (ue.metrics && ue.metrics.length)) ? {
            unitLabel: ue.unitLabel || (ue.derived && ue.derived.unitLabel) || null,
            fiscalYear: ue.fiscalYear || null,
            metrics: ue.metrics || [],
            derived: ue.derived && ue.derived.revenuePerUnit != null ? ue.derived : null,
            note: (ue.derived && ue.derived.note) || ue.note || null,
            filing: ue.filing || null
        } : null,
        valuation: rdcf ? {
            impliedGrowthPct: rdcf.impliedGrowthPct,
            assumptions: rdcf.assumptions,
            record: rdcf.record,
            marketCap: rdcf.marketCap,
            scenarios: rdcf.scenarios || null,
            note: rdcf.notes && rdcf.notes[0] ? rdcf.notes[0] : null
        } : null,
        forwardDcf: valuation || null,
        governance: gov || null,
        esg: esg || null,
        financials,
        incomeStatement,
        analystRead: insightItems,
        edge: [],
        edgePlain: [],
        bull: [],
        bear: [],
        bullPlain: [],
        bearPlain: [],
        risks: [],
        risksPlain: [],
        competitive: peers,
        forensicSignals: forensic,
        healthChecks: checks.map((c) => ({ label: c.label, pass: !!c.pass, detail: c.detail || '' })),
        recentChanges: monitor ? {
            summary: monitor.summary,
            materiality: monitor.materiality,
            materialityBreakdown: monitor.materialityBreakdown || null,
            bucket: monitor.materialityBucket,
            headline: monitor.narrative ? monitor.narrative.headline : null,
            tone: monitor.narrative ? monitor.narrative.tone : null,
            changes: monitor.narrative && monitor.narrative.changes ? monitor.narrative.changes : [],
            comparison: monitor.narrative ? { latest: monitor.narrative.latest, prev: monitor.narrative.prev } : null,
            deltas: monitor.deltas || [],
            reportedPeriod: monitor.reportedPeriod || null,
            priorPeriod: monitor.priorPeriod || null,
            currency: monitor.currency || null,
            filing: monitor.periodic || monitor.latestFiling || null,
            latestEvent: monitor.latestFiling && monitor.periodic && (monitor.latestFiling.form !== monitor.periodic.form || monitor.latestFiling.date !== monitor.periodic.date)
                ? monitor.latestFiling : null
        } : null,
        sources: {
            filings: 'SEC EDGAR 10-K/10-Q (statements, segments, risk language)',
            note: 'Every figure is computed from SEC-filed statements; prose is written over those finished facts. Educational, not investment advice.'
        },
        generatedAt: new Date().toISOString()
    };

        try {
            await writeDossierDoc(col, sym, fyEnd, depth, payload);
        } catch (_) { /* cache best-effort */ }

        onStage('writing'); // executive summary + bull/bear + risk + edge synthesis
        const [summary, bb, risks, edge] = await Promise.all([
            execSummary(digest), bullBear(digest), riskSection(digest), edgeSection(forensic)
        ]);
        const [summaryPlain, bbPlain, risksPlain, edgePlain] = await Promise.all([
            plainSummary(summary), plainBullBear(bb ? bb.bull : [], bb ? bb.bear : []), plainJsonArray(risks || []), plainJsonArray(edge || [])
        ]);

        delete payload.partial;
        Object.assign(payload, {
            executiveSummary: summary,
            executiveSummaryPlain: summaryPlain,
            edge: edge || [],
            edgePlain: edgePlain || [],
            bull: bb ? bb.bull : [],
            bear: bb ? bb.bear : [],
            bullPlain: bbPlain ? bbPlain.bull : [],
            bearPlain: bbPlain ? bbPlain.bear : [],
            risks: risks || [],
            risksPlain: risksPlain || []
        });

        try {
            await writeDossierDoc(col, sym, fyEnd, depth, payload);
        } catch (_) { /* cache best-effort */ }
        return payload;
    } finally {
        if (buildLease && buildLease.key) {
            await dossierBuildLock.release(DossierBuildLock, buildLease).catch((error) => {
                console.warn('[dossier] build lease release failed:', error.message);
            });
        }
    }
}

// Build-free cache peek for the decoupled poll path.
// The poll/pre-cache read. Unlike cachedDossier, a FRESH partial is a valid
// hit: it carries every data section and a `partial: true` marker the frontend
// uses to keep polling for the narrative. A stale one (builder died mid-write)
// is a miss, so a non-poll request falls through and rebuilds.
async function peekDossier(symbol, depth = 'standard') {
    const sym = String(symbol || '').toUpperCase().trim();
    try {
        const data = await aiChat.loadFundAny(sym).catch(() => null);
        if (!data) return null;
        const pack = insights.buildFactPack(sym,data);
        const fyEnd = pack ? pack.fyEnd : (((data.income || {}).annualReports || [])[0] || {}).fiscalDateEnding || 'na';
        const d = depth === 'deep' ? 'deep' : 'standard';
        const query = d === 'deep'
            ? { symbol: sym, fyEnd, depth: 'deep' }
            : { symbol: sym, fyEnd, depth: { $ne: 'deep' } };
        const hit = await dossierCol().findOne(query, { projection: { _id: 0 } });
        if (!hit || !hit.payload || hit.payload.schemaVersion !== DOSSIER_SCHEMA_VERSION || (data.provenance?.evidenceFingerprint && hit.payload.evidenceFingerprint!==data.provenance.evidenceFingerprint)) return null;
        if (hit.payload.partial) {
            const age = hit.at ? Date.now() - new Date(hit.at).getTime() : Infinity;
            return age <= DOSSIER_PARTIAL_STALE_MS ? { ...hit.payload, partial: true } : null;
        }
        return refreshValuation({ ...hit.payload, cached: true },sym,data);
    } catch (_) { return null; }
}

module.exports = { buildDossier, peekDossier, buildDigest, cachedDossier, refreshValuation, DOSSIER_SCHEMA_VERSION };
