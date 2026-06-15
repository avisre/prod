// Reverse DCF — "what growth is priced in?"
// Instead of guessing inputs to spit out a fair value, start from today's
// market cap and solve for the FCF growth rate the price implies, then put
// that number next to the company's actual filed record. Every input is
// shown and editable; the model is deliberately simple and stated plainly.
//
// Model: market cap = PV of fcfBase growing at g for `horizon` years,
// discounted at r, plus a Gordon terminal value at `terminalGrowth`.
// Solved for g by bisection. Simplifications (stated in `notes`): equity
// value is used directly (no net-debt bridge) and FCF = OCF + capex
// (capex stored negative), matching the rest of the codebase.

const aiChat = require('./ai-chat');

function num(v) {
    if (v === null || v === undefined || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}

function cagr(first, last, years) {
    if (first === null || last === null || first <= 0 || last <= 0 || years <= 0) return null;
    return (Math.pow(last / first, 1 / years) - 1) * 100;
}

// PV of the whole stream for a given growth rate
function presentValue(fcfBase, g, r, tg, horizon) {
    let pv = 0;
    let f = fcfBase;
    for (let t = 1; t <= horizon; t++) {
        f *= 1 + g;
        pv += f / Math.pow(1 + r, t);
    }
    const terminal = (f * (1 + tg)) / (r - tg);
    pv += terminal / Math.pow(1 + r, horizon);
    return pv;
}

function solveImpliedGrowth(marketCap, fcfBase, r, tg, horizon) {
    let lo = -0.5, hi = 1.0;
    if (presentValue(fcfBase, lo, r, tg, horizon) > marketCap) return lo; // priced below even -50%/yr
    if (presentValue(fcfBase, hi, r, tg, horizon) < marketCap) return null; // >100%/yr implied — not meaningful
    for (let i = 0; i < 80; i++) {
        const mid = (lo + hi) / 2;
        if (presentValue(fcfBase, mid, r, tg, horizon) < marketCap) lo = mid; else hi = mid;
    }
    return (lo + hi) / 2;
}

async function computeReverseDcf(symbol, opts = {}) {
    const data = await aiChat.loadFundAny(symbol);
    if (!data) return { error: `No data for ${String(symbol).toUpperCase()}.` };
    return computeFromData(symbol, data, opts);
}

// Sync core — callers that already hold the fundamentals payload (SEO pages)
// can compute without the async loader.
function computeFromData(symbol, data, opts = {}) {
    const ov = data.overview || {};
    const marketCap = num(ov.MarketCapitalization);
    const reports = ((data.cash || {}).annualReports || []).slice(0, 20); // newest first
    const fcfHistory = [];
    for (const r of reports) {
        const ocf = num(r.operatingCashflow);
        const capex = num(r.capitalExpenditures);
        if (ocf === null || capex === null) continue;
        fcfHistory.push({ fy: String(r.fiscalDateEnding || '').slice(0, 10), fcf: ocf + capex });
    }
    if (!marketCap || marketCap <= 0) return { error: 'Market cap unavailable.' };
    if (!fcfHistory.length) return { error: 'No free-cash-flow history available.' };

    // assumptions (editable via opts; percentages arrive as e.g. 10 and 2.5)
    const r = Math.min(0.25, Math.max(0.05, (num(opts.discountRatePct) ?? 10) / 100));
    const tg = Math.min(0.04, Math.max(0, (num(opts.terminalGrowthPct) ?? 2.5) / 100));
    const horizon = 10;
    if (r <= tg) return { error: 'Discount rate must exceed terminal growth.' };

    const latest = fcfHistory[0];
    const avg3 = fcfHistory.slice(0, 3).reduce((a, x) => a + x.fcf, 0) / Math.min(3, fcfHistory.length);
    const useAvg = String(opts.base || 'latest') === 'avg3';
    const fcfBase = useAvg ? avg3 : latest.fcf;

    const notes = [];
    if (latest.fcf > 0 && avg3 > 0 && Math.abs(latest.fcf / avg3 - 1) > 0.3) {
        notes.push('Latest-year FCF differs from the 3-year average by more than 30% — try both bases.');
    }
    notes.push('Equity value (market cap) is compared against FCF directly — no net-debt bridge. FCF = operating cash flow minus capex, as filed.');

    let impliedGrowthPct = null;
    let priced = null;
    if (fcfBase <= 0) {
        notes.unshift('Free cash flow is negative on this base — an implied growth rate cannot be solved. The price rests on a future turn to positive cash flow.');
    } else {
        const g = solveImpliedGrowth(marketCap, fcfBase, r, tg, horizon);
        if (g === null) {
            notes.unshift(`Even +100%/yr FCF growth for ${horizon} years does not reach today's market cap under these assumptions.`);
            priced = 'beyond-model';
        } else {
            impliedGrowthPct = Number((g * 100).toFixed(1));
            priced = 'solved';
        }
    }

    // the actual filed record, for the side-by-side
    const at = (n) => (fcfHistory.length > n ? fcfHistory[n] : null);
    const span = (n) => {
        const a = at(n); const b = fcfHistory[0];
        return a ? cagr(a.fcf, b.fcf, n) : null;
    };
    const income = ((data.income || {}).annualReports || []);
    const rev = (i) => (income.length > i ? num(income[i].totalRevenue) : null);
    const record = {
        fcfCagr5Pct: round1(span(5)),
        fcfCagr10Pct: round1(span(10)),
        revCagr5Pct: round1(cagr(rev(5), rev(0), 5)),
        revCagr10Pct: round1(cagr(rev(10), rev(0), 10)),
        fcfHistory: fcfHistory.slice(0, 11).reverse() // oldest→newest for charting
    };

    // Scenario fair-value RANGE (bear / base / bull) — the inverse of the
    // reverse solve: set a growth rate, value the FCF stream, compare to today's
    // market cap. Growth anchors come from the filed record (5yr FCF CAGR) ±
    // a band, so the range is grounded in what the company has actually done.
    // Descriptive only — a value band, NOT a buy/sell call or a single target.
    let scenarios = null;
    if (fcfBase > 0) {
        const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
        const baseG = record.fcfCagr5Pct !== null ? clamp(record.fcfCagr5Pct, -5, 30) : Math.min(impliedGrowthPct || 8, 15);
        const bearG = clamp(baseG - 8, -10, baseG);
        const bullG = clamp(baseG + 8, baseG, 40);
        const one = (gPct) => {
            const value = presentValue(fcfBase, gPct / 100, r, tg, horizon);
            return {
                growthPct: Number(gPct.toFixed(1)),
                value: Math.round(value),
                upsidePct: marketCap > 0 ? Number(((value / marketCap - 1) * 100).toFixed(1)) : null
            };
        };
        scenarios = {
            currentMarketCap: marketCap,
            bear: one(bearG),
            base: one(baseG),
            bull: one(bullG),
            basis: `Growth anchored on the company's filed 5-year FCF CAGR (${record.fcfCagr5Pct ?? 'n/a'}%/yr) ± an 8-point band, valued at a ${Number((r * 100).toFixed(1))}% discount rate and ${Number((tg * 100).toFixed(2))}% terminal growth. A descriptive value range, not a recommendation or price target.`
        };
    }

    return {
        scenarios,
        symbol: String(symbol).toUpperCase(),
        name: ov.Name || String(symbol).toUpperCase(),
        marketCap,
        fcfBase: Math.round(fcfBase),
        fcfBasis: useAvg ? `average of last ${Math.min(3, fcfHistory.length)} fiscal years` : `FY ending ${latest.fy}`,
        impliedGrowthPct,
        priced,
        assumptions: {
            discountRatePct: Number((r * 100).toFixed(1)),
            terminalGrowthPct: Number((tg * 100).toFixed(2)),
            horizonYears: horizon
        },
        record,
        notes,
        source: 'Company SEC filings (10-K) via the stockportfolio.pro fundamentals cache; market cap from latest quote data.'
    };
}

function round1(v) { return v === null || v === undefined ? null : Number(Number(v).toFixed(1)); }

module.exports = { computeReverseDcf, computeFromData };
