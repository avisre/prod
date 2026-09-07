'use strict';

// Fund fees, from the prospectus fee table as filed with the SEC.
//
// Why: Yahoo's expense ratios are correct for ETFs and unreliable for mutual
// funds. Measured 2026-09-07 against the funds' own prospectuses —
//
//   SWPPX   Yahoo 1.24%   filed 0.02%     62x
//   FZROX   Yahoo 0.99%   filed 0.00%      —
//   FXAIX   Yahoo 0.69%   filed 0.015%    46x
//   FSKAX   Yahoo 0.66%   filed 0.015%    44x
//   VWELX   Yahoo 0.99%   filed 0.25%      4x
//   DODGX   Yahoo 0.00%   filed 0.51%    zero
//   VOO/SPY/GLD/TLT/SCHD/ARKK/XLK/QQQ …  all correct
//
// The wrong figures track the fund's Morningstar *category* average rather than
// the fund itself, which is why the cheapest index funds are the worst hit — the
// exact funds people pick on cost. This is the metric the 2026-09-03 session
// stripped a whole ETF grade over ("if we can't verify it we won't have it"), so
// the fix is to read the number from the source rather than to patch Yahoo's.
//
// Every open-end fund and ETF registered under the '40 Act tags its prospectus
// fee table in XBRL on Form 485BPOS, per share class, using the RR/OEF
// taxonomy: oef:ExpensesOverAssets is total annual operating expenses,
// oef:NetExpensesOverAssets is the figure after contractual waivers. FXAIX's
// 2026-04-24 filing carries ExpensesOverAssets = 0.00015 — 0.015%, exactly.
//
// UITs and grantor trusts (SPY, QQQ, DIA, GLD, IBIT) file no 485BPOS and have
// no share classes; they resolve to null here and keep Yahoo's figure, which
// measurement shows is right for them.

const secFunds = require('./sec-fund-index');

const FEES_TTL_MS = 30 * 24 * 60 * 60 * 1000; // prospectuses are updated annually
// A UIT or grantor trust files no 485BPOS and never will, but a fund can also
// miss simply because its newest filings had no parsable instance — so the "no"
// is held for a day, not a month.
const NO_FEES_TTL_MS = 24 * 60 * 60 * 1000;
// Fee rows are tiny (a few hundred bytes), so this holds thousands of funds.
const MEM_MAX_BYTES = 4 * 1024 * 1024;

const cache = secFunds.createCache({
    maxBytes: MEM_MAX_BYTES, ttlMs: FEES_TTL_MS, missTtlMs: NO_FEES_TTL_MS
});

// Local names, matched across whichever prefix the filer used: older filings
// carry the rr: namespace, current ones oef:.
const FEE_TAGS = {
    grossExpenseRatio: 'ExpensesOverAssets',
    netExpenseRatio: 'NetExpensesOverAssets',
    managementFee: 'ManagementFeesOverAssets',
    distributionFee: 'DistributionAndService12b1FeesOverAssets',
    otherExpenses: 'OtherExpensesOverAssets',
    acquiredFundFees: 'AcquiredFundFeesAndExpensesOverAssets',
    feeWaiver: 'FeeWaiverOrReimbursementOverAssets'
};

// A fee ratio is a decimal fraction: 0.00015 is 0.015%. Anything at or above 1
// would be a 100%-of-assets fee, which does not exist — treat it as a unit
// error in the filing and refuse it rather than publish it.
function feeValue(raw) {
    const n = Number(raw);
    if (!Number.isFinite(n) || n < 0 || n >= 1) return null;
    return n;
}

function parseContexts(xml) {
    const contexts = new Map();
    const re = /<(?:\w+:)?context id="([^"]+)"([\s\S]*?)<\/(?:\w+:)?context>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const body = m[2];
        const end = (/<(?:\w+:)?endDate>([^<]+)</.exec(body) || [])[1] ||
            (/<(?:\w+:)?instant>([^<]+)</.exec(body) || [])[1] || '';
        contexts.set(m[1], { body, endDate: end });
    }
    return contexts;
}

// One prospectus covers every series and class in the trust, so the fee table
// must be read from the contexts carrying THIS class id — reading the first
// match in the document would return a sibling fund's fees.
function parseFeeTable(xml, classId, seriesId) {
    const contexts = parseContexts(xml);
    const wanted = new Set();
    for (const [id, ctx] of contexts) {
        if (classId && ctx.body.includes(classId)) wanted.add(id);
    }
    if (!wanted.size && seriesId) {
        // Single-class funds sometimes tag at the series level only.
        for (const [id, ctx] of contexts) if (ctx.body.includes(seriesId)) wanted.add(id);
    }
    if (!wanted.size) return null;

    const out = {};
    const factRe = /<(?:\w+):([A-Za-z0-9]+)[^>]*\scontextRef="([^"]+)"[^>]*>([^<]*)</g;
    const byField = new Map();
    let m;
    while ((m = factRe.exec(xml)) !== null) {
        const [, localName, contextRef, raw] = m;
        if (!wanted.has(contextRef)) continue;
        const field = Object.keys(FEE_TAGS).find((key) => FEE_TAGS[key] === localName);
        if (!field) continue;
        const value = feeValue(raw);
        if (value === null) continue;
        // A prospectus restates prior years in dated contexts alongside the
        // current one; keep the latest period.
        const endDate = (contexts.get(contextRef) || {}).endDate || '';
        const prior = byField.get(field);
        if (!prior || endDate > prior.endDate) byField.set(field, { value, endDate });
    }
    for (const [field, { value }] of byField) out[field] = value;
    return Object.keys(out).length ? out : null;
}

// The expense ratio an investor actually pays this year: net of contractual
// waivers where the fund has them, gross otherwise.
function effectiveRatio(fees) {
    if (!fees) return null;
    if (fees.netExpenseRatio !== undefined && fees.netExpenseRatio !== null) return fees.netExpenseRatio;
    if (fees.grossExpenseRatio !== undefined && fees.grossExpenseRatio !== null) return fees.grossExpenseRatio;
    return null;
}

// Returns null (never throws) for anything without a filed fee table.
async function fetchFundFees(symbol) {
    const key = secFunds.tickerKey(symbol);
    if (!key) return null;

    return cache.remember(key, async () => {
        try {
            const col = secFunds.collection('fund_fees');
            if (col) {
                secFunds.ensureTtl('fund_fees', 60 * 24 * 3600);
                const doc = await col.findOne({ _id: key });
                if (doc && doc.value && Date.now() - new Date(doc.at || 0).getTime() < FEES_TTL_MS) return doc.value;
            }
        } catch (_) { /* best-effort */ }

        let value = null;
        try {
            const filer = await secFunds.resolveFund(key);
            // No series means a UIT or grantor trust: no share classes, no 485BPOS.
            if (filer && filer.seriesId) {
                // 485BPOS is the annual update that carries the fee table; 497 is
                // the supplement some funds use to restate it mid-year. Several
                // filings are tried, not just the newest: iShares' 2026-07-27
                // 485BPOS for IVV ships its fee table as inline XBRL inside a 40MB
                // HTML document with no extracted instance, while the 2025 filing
                // has a clean 10MB one. Falling back a year is honest as long as the
                // filing date travels with the number, which it does.
                const attempts = [];
                for (const type of ['485BPOS', '497']) {
                    const filings = await secFunds.recentFilings(filer, type, type === '485BPOS' ? 6 : 4);
                    for (const filing of filings.slice(0, type === '485BPOS' ? 3 : 2)) attempts.push({ type, filing });
                }
                for (const { type, filing } of attempts) {
                    const doc = await secFunds.filingInstance(filing).catch(() => null);
                    if (!doc || !doc.xml) continue;
                    const fees = parseFeeTable(doc.xml, filer.classId, filer.seriesId);
                    if (!fees) continue;
                    const ratio = effectiveRatio(fees);
                    if (ratio === null) continue;
                    value = {
                        symbol: key,
                        expenseRatio: ratio,
                        grossExpenseRatio: fees.grossExpenseRatio ?? null,
                        netExpenseRatio: fees.netExpenseRatio ?? null,
                        managementFee: fees.managementFee ?? null,
                        distributionFee: fees.distributionFee ?? null,
                        otherExpenses: fees.otherExpenses ?? null,
                        acquiredFundFees: fees.acquiredFundFees ?? null,
                        filedAt: filing.filedAt,
                        formType: type,
                        source: `SEC Form ${type} prospectus fee table`,
                        sourceUrl: filing.indexUrl
                    };
                    break;
                }
            }
        } catch (error) {
            console.error(`[fees] ${key} failed: ${(error && error.name) || 'Error'} ${String((error && error.message) || '').slice(0, 160)}`);
            throw error; // transient — must not be cached as "no fee table"
        }

        if (value) await secFunds.cacheToMongo('fund_fees', key, value);
        return value;
    }).catch(() => null);
}

module.exports = { fetchFundFees, parseFeeTable, effectiveRatio, feeValue };
