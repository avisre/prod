// Governance & ownership — the section a real initiation report builds from the
// proxy. Three grounded legs, all from SEC filings, no paid data:
//   1. Board & pay  — extracted from the latest DEF 14A (board size/independence,
//      diversity, CEO duality, say-on-pay, CEO pay ratio, dual-class). temp 0,
//      strict schema, fields left null when the proxy doesn't state them.
//   2. Insider activity — Form 4 buys/sells rolling 8 quarters (insiders.js),
//      summarised to a net figure + sentiment.
//   3. Smart-money ownership — which of our ~27 tracked 13F investors hold it
//      (gurus.holdersOf), clearly labelled a subsample, not total institutional.
// A short list of computed red flags ties it together. The model writes nothing
// here that isn't a filed/computed number.

const filing = require('./filing-fetcher');
const insiders = require('./insiders');
const gurus = require('./gurus');
const governanceWeb = require('./governance-web');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
// many of these fields are never legitimately zero — a model that returns 0
// almost always means "couldn't find it", so treat 0 as not-disclosed.
const posNum = (v) => { const n = num(v); return n !== null && n > 0 ? n : null; };
const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);

const GOV_SYSTEM = [
    'You extract corporate-governance facts from a company DEF 14A (proxy statement) text. Reply with ONLY a JSON object, no prose, no markdown fences.',
    'Schema: {"boardSize": int|null, "independentDirectors": int|null, "womenDirectors": int|null, "ceoName": str|null, "ceoChairCombined": true|false|null, "leadIndependentDirector": true|false|null, "sayOnPayApprovalPct": number|null, "dualClassShares": true|false|null, "ceoTotalCompUsd": number|null, "medianEmployeePayUsd": number|null, "ceoPayRatio": number|null, "committees": [str], "auditor": str|null}',
    'Rules: use ONLY facts explicitly stated in the supplied text. If a field is genuinely not stated, return null — NEVER return 0 as a placeholder for "not found" (0 is only valid if the text literally says zero).',
    'independentDirectors: read prose like "seven of our eight directors are independent" → 7. sayOnPayApprovalPct: the percentage of votes cast FOR the most recent advisory say-on-pay vote (e.g. "approximately 95% of votes cast" → 95). ceoChairCombined = true only if the SAME person is both CEO and Chair. leadIndependentDirector = true if a lead independent director is named. ceoPayRatio = CEO total compensation ÷ median employee pay (a number like 250, not "250:1"). dualClassShares = true only if multiple common-share classes with different voting rights exist. committees: the standing board committees named. Numbers as plain numbers (no $, %, or commas).'
].join('\n');

function guard(o) { return o && typeof o === 'object' && ('boardSize' in o || 'ceoName' in o || 'committees' in o); }

// ---- DEF 14A extraction ----
async function extractGovernance(symbol) {
    const got = await filing.getFilingText(symbol, 'DEF 14A', { maxChars: 360000 });
    if (!got || got.error) return { error: (got && got.error) || 'No proxy statement found.' };
    const text = filing.windows(got.text, [
        /proxy summary|governance highlights|board snapshot/i,
        /director nominees|nominees for (election|director)|our board of directors/i,
        /director independence|independent director|are independent/i,
        /\bcommittee/i,
        /say[- ]on[- ]pay|advisory vote|votes cast|approval of (named )?executive compensation/i,
        /ceo pay ratio|pay ratio|median (annual )?(total )?compensation of (all )?employees/i,
        /class\s+a common stock|class\s+b common stock|super[- ]?voting|dual[- ]class/i
    ], { before: 400, after: 7000, maxChars: 38000 });

    const ext = await filing.extractJson(GOV_SYSTEM, `DEF 14A text (windowed):\n${text}\n\nExtract the governance facts. Remember: null, never 0, for anything not stated.`, guard, { maxTokens: 1200 });
    if (!ext) return { error: 'Could not parse the proxy statement reliably.', filing: { date: got.date, url: got.url } };

    const boardSize = posNum(ext.boardSize);
    const indep = posNum(ext.independentDirectors);
    const women = num(ext.womenDirectors); // 0 women can be real, but see flag guard
    return {
        boardSize,
        independentDirectors: indep,
        independencePct: (boardSize && indep !== null) ? r1((indep / boardSize) * 100) : null,
        womenDirectors: women,
        womenPct: (boardSize && women !== null && women > 0) ? r1((women / boardSize) * 100) : null,
        ceoName: ext.ceoName ? String(ext.ceoName).slice(0, 80) : null,
        ceoChairCombined: typeof ext.ceoChairCombined === 'boolean' ? ext.ceoChairCombined : null,
        leadIndependentDirector: typeof ext.leadIndependentDirector === 'boolean' ? ext.leadIndependentDirector : null,
        sayOnPayApprovalPct: posNum(ext.sayOnPayApprovalPct),
        dualClassShares: typeof ext.dualClassShares === 'boolean' ? ext.dualClassShares : null,
        ceoTotalCompUsd: posNum(ext.ceoTotalCompUsd),
        medianEmployeePayUsd: posNum(ext.medianEmployeePayUsd),
        ceoPayRatio: posNum(ext.ceoPayRatio),
        committees: Array.isArray(ext.committees) ? ext.committees.map((c) => String(c).slice(0, 60)).slice(0, 8) : [],
        auditor: ext.auditor ? String(ext.auditor).slice(0, 80) : null,
        filing: { date: got.date, url: got.url, accession: got.accession }
    };
}

// ---- Form 4 insider activity, rolling 8 quarters ----
async function insiderSummary(symbol) {
    let h = null;
    try { h = await insiders.history(symbol); } catch (_) { h = null; }
    if (!h || !Array.isArray(h.quarters)) return null;
    const last8 = h.quarters.slice(-8);
    let buySh = 0, sellSh = 0, buyVal = 0, sellVal = 0, buys = 0, sells = 0;
    for (const q of last8) { buySh += q.buySh || 0; sellSh += q.sellSh || 0; buyVal += q.buyVal || 0; sellVal += q.sellVal || 0; buys += q.buys || 0; sells += q.sells || 0; }
    const netSh = buySh - sellSh, netVal = buyVal - sellVal;
    const totalVal = buyVal + sellVal;
    // sentiment: net buying/selling as a share of gross dollar activity
    let sentiment = 'neutral';
    if (totalVal > 0) {
        const ratio = netVal / totalVal;
        sentiment = ratio > 0.2 ? 'net buying' : ratio < -0.2 ? 'net selling' : 'mixed';
    }
    return {
        quarters: last8.map((q) => ({ key: q.key, buyShares: q.buySh || 0, sellShares: q.sellSh || 0, buyValue: q.buyVal || 0, sellValue: q.sellVal || 0 })),
        netShares: netSh, netValue: Math.round(netVal),
        buys, sells, sentiment,
        recent: (h.recent || []).slice(0, 10).map((t) => ({ date: t.date, owner: t.owner, relation: t.relation, side: t.side, shares: t.shares, value: t.value })),
        builtAt: h.builtAt, filingsParsed: h.filingsParsed
    };
}

// ---- Tracked-investor (13F) ownership — labelled subsample ----
async function ownership(symbol) {
    let g = null;
    try { g = await gurus.holdersOf(symbol); } catch (_) { g = null; }
    if (!g) return null;
    const holders = (g.holders || []).slice(0, 12);
    const totalValue = holders.reduce((a, x) => a + (x.value || 0), 0);
    return {
        holders,
        holderCount: (g.holders || []).length,
        scanned: g.scanned,
        totalValue,
        period: (holders[0] && holders[0].reportingPeriod) || null,
        note: `Among ${g.scanned} tracked institutional investors' latest 13F filings — a subsample of disciplined managers, NOT total institutional ownership.`
    };
}

// Conservative: only flag on HIGH-CONFIDENCE signals. Null/0 means "not parsed",
// never a flag — a missed extraction must not become a false governance alarm.
function redFlags(gov) {
    const flags = [];
    if (!gov || gov.error) return flags;
    if (gov.dualClassShares === true) flags.push('Dual-class share structure — public holders may have limited voting power.');
    if (gov.ceoChairCombined === true && gov.leadIndependentDirector !== true) flags.push('CEO also chairs the board, with no lead independent director disclosed — concentrated oversight.');
    if (gov.independencePct !== null && gov.independencePct > 0 && gov.independencePct < 50) flags.push(`Board is only ${gov.independencePct}% independent — below the majority-independent norm.`);
    if (gov.ceoPayRatio !== null && gov.ceoPayRatio >= 300) flags.push(`CEO pay is ${Math.round(gov.ceoPayRatio)}× the median employee — high by most standards.`);
    if (gov.sayOnPayApprovalPct !== null && gov.sayOnPayApprovalPct > 0 && gov.sayOnPayApprovalPct < 70) flags.push(`Say-on-pay drew only ${gov.sayOnPayApprovalPct}% approval — notable shareholder dissent on compensation.`);
    return flags;
}

async function buildGovernance(symbol, { name = null } = {}) {
    const [gov, ins, own] = await Promise.all([
        extractGovernance(symbol).catch((e) => ({ error: String(e && e.message || e) })),
        insiderSummary(symbol).catch(() => null),
        ownership(symbol).catch(() => null)
    ]);

    // Web enrichment — fill ONLY the qualitative fields the proxy extraction left
    // blank (CEO, CEO-also-Chair, dual-class), from verified free public sources.
    // Filing values are never overwritten; provenance is recorded for the UI.
    let webProvenance = null, webSources = [];
    if (gov && !gov.error) {
        try {
            const enr = await governanceWeb.enrichGovernance(symbol, name, gov);
            const prov = {};
            for (const [k, info] of Object.entries(enr.fields || {})) {
                if (gov[k] == null && info && info.value != null) {
                    gov[k] = info.value;
                    if (k === 'independentDirectors' && gov.boardSize) gov.independencePct = Math.round((info.value / gov.boardSize) * 1000) / 10;
                    prov[k] = { source: 'web', urls: info.sources || [], confidence: info.confidence || 'medium', evidence: info.evidence || null };
                }
            }
            if (Object.keys(prov).length) { webProvenance = prov; webSources = enr.sourcesUsed || []; gov.webEnriched = true; }
        } catch (_) { /* best-effort; filing-only on failure */ }
    }

    return {
        board: gov && !gov.error ? gov : null,
        boardError: gov && gov.error ? gov.error : null,
        boardFiling: gov && gov.filing ? gov.filing : null,
        webProvenance,
        webSources,
        insider: ins,
        ownership: own,
        redFlags: redFlags(gov), // recomputed AFTER the merge — a web-found dual-class now flags
        source: 'DEF 14A (board, compensation), Form 4 (insider trades), and 13F filings of tracked investors — all from SEC EDGAR.' + (webProvenance ? ' Fields marked “web” were filled from public sources (Wikipedia/Wikidata) and cross-checked across two independent sources.' : '')
    };
}

module.exports = { buildGovernance, extractGovernance, insiderSummary, ownership };
