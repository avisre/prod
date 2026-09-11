// Forward DCF + transparent WACC buildup — the intrinsic-value leg a real
// initiation report carries, built entirely from filed numbers + stated,
// editable assumptions. NO buy/sell rating: the output is a DESCRIPTIVE
// fair-value estimate with every input shown, so a reader can see exactly
// what it rests on and change it.
//
// Method (standard, textbook — CAPM + WACC + FCFF, Gordon terminal value):
//   Cost of equity  Re = Rf + beta × ERP                         (CAPM)
//   Cost of debt    Rd = interest expense ÷ total debt           (from the 10-K)
//   WACC = wE·Re + wD·Rd·(1−tax),  weights by market equity / book debt
//   FCFF = operating cash flow + after-tax interest − capex      (cash to ALL capital)
//   EV  = Σ PV(FCFF, WACC) over 10y + PV(Gordon terminal value)
//   Equity value = EV − net debt;  per share = equity ÷ shares outstanding
// Defaults (June 2026, editable): Rf 4.4% (10Y Treasury), ERP 4.5%
// (≈ Damodaran 2026 implied), terminal growth 2.5% (capped below WACC).
// Refs: Damodaran (stern.nyu.edu/~adamodar), CAPM, Gordon Growth Model.

const aiChat = require('./ai-chat');

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const r1 = (v) => (v === null || v === undefined ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Defaults are editable assumptions, stamped into the output.
const DEFAULTS = { riskFreePct: 4.4, erpPct: 4.5, terminalGrowthPct: 2.5, horizonYears: 10, taxFallbackPct: 21 };

function latestDebt(b) {
    return (num(b.shortTermDebt) || 0) + (num(b.longTermDebt) || 0) + (num(b.currentLongTermDebt) || 0);
}
function latestCash(b) {
    return (num(b.cashAndCashEquivalentsAtCarryingValue) || 0) + (num(b.shortTermInvestments) || 0);
}

// FCFF for a single year's statements (cash to all capital providers).
function fcffOf(inc, cash, taxRate) {
    const ocf = num(cash.operatingCashflow);
    const capex = num(cash.capitalExpenditures); // stored negative
    if (ocf === null || capex === null) return null;
    const interest = num(inc.interestExpense);
    const afterTaxInterest = interest !== null ? Math.abs(interest) * (1 - taxRate) : 0;
    return ocf + afterTaxInterest + capex; // capex negative → subtracts
}

// Compute the whole valuation. Accepts pre-loaded fundamentals (the dossier has
// them) and the reverse-DCF record for the growth anchor; loads if absent.
async function buildValuation(symbol, { data, rdcf, opts = {} } = {}) {
    const sym = String(symbol || '').toUpperCase().trim();
    if (!data) { data = await aiChat.loadFundAny(sym).catch(() => null); }
    if (!data) return { error: `No data for ${sym}.` };

    const ov = data.overview || {};
    const inc0 = ((data.income || {}).annualReports || [])[0] || {};
    const bal0 = ((data.balance || {}).annualReports || [])[0] || {};
    const fyEnd = String(inc0.fiscalDateEnding || '').slice(0, 10) || null;

    const marketCap = num(ov.MarketCapitalization);
    if (!marketCap || marketCap <= 0) return { error: 'Market cap unavailable — needed for the equity weight and the per-share bridge.' };

    // ---- tax rate (effective, from the 10-K; clamp + fallback) ----
    const taxExp = num(inc0.incomeTaxExpense);
    const pretax = num(inc0.incomeBeforeTax);
    let taxPct = (taxExp !== null && pretax && pretax > 0) ? (taxExp / pretax) * 100 : (num(opts.taxPct) ?? DEFAULTS.taxFallbackPct);
    taxPct = clamp(taxPct, 0, 40);
    const tax = taxPct / 100;

    // ---- WACC buildup ----
    const rf = (num(opts.riskFreePct) ?? DEFAULTS.riskFreePct) / 100;
    const erp = (num(opts.erpPct) ?? DEFAULTS.erpPct) / 100;
    const beta = num(ov.Beta);
    const betaUsed = beta !== null ? beta : 1.0;
    const betaNote = beta !== null ? 'Published beta (Yahoo/market data).' : 'No published beta available — defaulted to 1.0 (market beta); cost of equity is approximate.';
    const re = rf + betaUsed * erp; // cost of equity (CAPM)

    const totalDebt = latestDebt(bal0);
    const interest = num(inc0.interestExpense);
    let rd = (interest !== null && totalDebt > 0) ? Math.abs(interest) / totalDebt : null;
    if (rd !== null) rd = clamp(rd, 0, 0.15); // guard odd ratios
    const rdUsed = rd !== null ? rd : 0.05; // only matters if there is debt
    const wE = totalDebt > 0 ? marketCap / (marketCap + totalDebt) : 1;
    const wD = 1 - wE;
    const wacc = wE * re + wD * rdUsed * (1 - tax);

    const waccBuildup = {
        riskFreePct: r2(rf * 100),
        beta: r2(betaUsed),
        betaSource: betaNote,
        erpPct: r2(erp * 100),
        costOfEquityPct: r2(re * 100),
        costOfDebtPct: rd !== null ? r2(rd * 100) : null,
        costOfDebtNote: rd !== null ? 'Interest expense ÷ total debt, from the latest 10-K.' : 'No debt / interest reported — debt weight is zero.',
        taxRatePct: r1(taxPct),
        weightEquityPct: r1(wE * 100),
        weightDebtPct: r1(wD * 100),
        waccPct: r2(wacc * 100),
        formula: 'WACC = wE·Re + wD·Rd·(1−tax); Re = Rf + β·ERP (CAPM).'
    };

    // ---- FCFF base + growth anchor ----
    const incs = (data.income || {}).annualReports || [];
    const cashs = (data.cash || {}).annualReports || [];
    const n = Math.min(incs.length, cashs.length);
    const fcffHist = [];
    for (let i = 0; i < Math.min(n, 6); i++) {
        const f = fcffOf(incs[i] || {}, cashs[i] || {}, tax);
        if (f !== null) fcffHist.push({ fy: String((incs[i] || {}).fiscalDateEnding || '').slice(0, 10), fcff: f });
    }
    if (!fcffHist.length) return { error: 'No free-cash-flow history available to project.' };
    const latestFcff = fcffHist[0].fcff;
    const avg3 = fcffHist.slice(0, 3).reduce((a, x) => a + x.fcff, 0) / Math.min(3, fcffHist.length);
    const useAvg = String(opts.base || 'latest') === 'avg3';
    const fcffBase = useAvg ? avg3 : latestFcff;

    if (fcffBase <= 0) {
        return {
            symbol: sym, name: ov.Name || sym, fyEnd, marketCap, waccBuildup,
            note: 'Free cash flow to the firm is negative on the latest base — a forward DCF would produce a meaningless negative value, so no fair-value estimate is shown. The valuation rests on a future turn to positive cash generation.',
            disclaimer: DISCLAIMER
        };
    }

    // growth anchor from the filed 5yr FCF CAGR (reverse-dcf record), clamped
    const recCagr = rdcf && rdcf.record ? num(rdcf.record.fcfCagr5Pct) : null;
    const baseG = recCagr !== null ? clamp(recCagr, -5, 25) : 8;
    const bands = { bear: clamp(baseG - 8, -10, baseG), base: baseG, bull: clamp(baseG + 8, baseG, 35) };

    // terminal growth, capped safely below WACC
    let tg = (num(opts.terminalGrowthPct) ?? DEFAULTS.terminalGrowthPct) / 100;
    const tgCap = wacc - 0.005;
    let tgClamped = false;
    if (tg >= tgCap) { tg = Math.max(0, tgCap); tgClamped = true; }
    const horizon = DEFAULTS.horizonYears;

    const netDebt = totalDebt - latestCash(bal0);
    // The share count MUST be on the same basis as marketCap and the quoted
    // price. ov.SharesOutstanding is Yahoo's quote-basis count (marketCap /
    // price); for an ADR that is the ADS count, while the balance sheet reports
    // ORDINARY shares — ~5x larger for NTES, ~7.5x for BABA. Preferring the
    // balance sheet put fair-value-per-share on a different scale from the price
    // it is compared against. It is also marginally more accurate for domestic
    // filers, where the balance-sheet count is a fiscal-year-end snapshot that
    // buybacks have already moved.
    const shares = num(ov.SharesOutstanding) || num(bal0.commonStockSharesOutstanding);
    const currentPrice = shares && shares > 0 ? marketCap / shares : null;

    // Project + discount one scenario; also return the year-by-year breakdown.
    function valueScenario(gPct, withDetail) {
        const g = gPct / 100;
        let pvSum = 0, f = fcffBase;
        const yearRows = [];
        for (let t = 1; t <= horizon; t++) {
            f *= 1 + g;
            const df = 1 / Math.pow(1 + wacc, t);
            const pv = f * df;
            pvSum += pv;
            if (withDetail) yearRows.push({ year: t, fcff: Math.round(f), discountFactor: r2(df * 100) / 100, pv: Math.round(pv) });
        }
        const terminalFcff = f * (1 + tg);
        const terminalValue = terminalFcff / (wacc - tg);
        const pvTerminal = terminalValue / Math.pow(1 + wacc, horizon);
        const ev = pvSum + pvTerminal;
        const equity = ev - netDebt;
        const perShare = shares && shares > 0 ? equity / shares : null;
        return {
            growthPct: r1(gPct),
            enterpriseValue: Math.round(ev),
            equityValue: Math.round(equity),
            perShare: perShare !== null ? r2(perShare) : null,
            upsidePct: (perShare !== null && currentPrice) ? r1((perShare / currentPrice - 1) * 100) : null,
            terminalPct: r1((pvTerminal / ev) * 100),
            yearRows: withDetail ? yearRows : undefined,
            pvTerminal: withDetail ? Math.round(pvTerminal) : undefined
        };
    }

    const base = valueScenario(bands.base, true);
    const bear = valueScenario(bands.bear, false);
    const bull = valueScenario(bands.bull, false);

    let status = null;
    if (base.upsidePct !== null) {
        status = base.upsidePct > 20 ? 'below the base-case estimate (model implies upside)'
            : base.upsidePct < -20 ? 'above the base-case estimate (model implies downside)'
                : 'within ±20% of the base-case estimate (broadly fairly valued on these assumptions)';
    }

    // A single-point DCF is unreliable in three situations; in each we flag it
    // low-confidence and let the frontend reframe the number rather than present a
    // misleading "fair value". (1) hypergrowth: tiny FCF yield — the market prices
    // growth far above the historical trend. (2) low spread: WACC sits near
    // terminal growth, so the Gordon terminal value (and the answer) explodes on
    // tiny assumption changes — heavy-debt, low-beta names like telecoms. (3)
    // extreme: the fair value lands far from the price, a sign the anchor misfits.
    const fcfYieldPct = marketCap > 0 ? (fcffBase / marketCap) * 100 : null;
    const spreadPP = (wacc - tg) * 100;
    let weakReason = null;
    if (fcfYieldPct !== null && fcfYieldPct > 0 && fcfYieldPct < 1.5) weakReason = 'hypergrowth';
    else if (spreadPP < 2) weakReason = 'lowspread';
    else if (base.upsidePct !== null && Math.abs(base.upsidePct) > 65) weakReason = 'extreme';
    const historicalAnchorWeak = !!weakReason;
    const weakNote = weakReason === 'hypergrowth'
        ? `The price reflects expected free-cash-flow growth well above ${sym}'s historical trend (its current FCF is only ~${fcfYieldPct.toFixed(1)}% of market cap). A DCF anchored to past cash flows understates companies the market is pricing for rapid future growth — read this alongside "What's priced in", which solves for the growth the price actually implies.`
        : weakReason === 'lowspread'
            ? `${sym}'s computed WACC (${r2(wacc * 100)}%) sits close to the terminal growth rate, so the terminal value — and therefore the fair value — is extremely sensitive to small changes in the discount rate. Treat the per-share figure as indicative only; the scenario range and "What's priced in" are the better lenses for a name with this capital structure.`
            : weakReason === 'extreme'
                ? `The model's fair value lands far from the current price. A DCF anchored to ${sym}'s historical free-cash-flow trend is a poor fit when the market is pricing a different trajectory — read it alongside "What's priced in", which solves for the growth the price actually implies.`
                : null;

    return {
        symbol: sym,
        name: ov.Name || sym,
        fyEnd,
        marketCap,
        currentPrice: currentPrice !== null ? r2(currentPrice) : null,
        sharesOutstanding: shares || null,
        netDebt: Math.round(netDebt),
        waccBuildup,
        fairValue: {
            perShare: base.perShare,
            currentPrice: currentPrice !== null ? r2(currentPrice) : null,
            upsidePct: base.upsidePct,
            status,
            historicalAnchorWeak,
            weakNote
        },
        scenarios: { bear, base: { ...base, yearRows: undefined, pvTerminal: undefined }, bull },
        projection: { yearRows: base.yearRows, terminalValuePv: base.pvTerminal, terminalSharePct: base.terminalPct, enterpriseValue: base.enterpriseValue, netDebt: Math.round(netDebt), equityValue: base.equityValue },
        assumptions: {
            fcffBase: Math.round(fcffBase),
            fcffBasis: useAvg ? `average of last ${Math.min(3, fcffHist.length)} fiscal years` : `FY ending ${fcffHist[0].fy}`,
            historicalFcfCagr5Pct: recCagr !== null ? r1(recCagr) : null,
            growthBands: { bearPct: r1(bands.bear), basePct: r1(bands.base), bullPct: r1(bands.bull) },
            terminalGrowthPct: r2(tg * 100),
            terminalGrowthClamped: tgClamped,
            horizonYears: horizon,
            riskFreePct: r2(rf * 100),
            erpPct: r2(erp * 100),
            waccPct: r2(wacc * 100)
        },
        note: tgClamped ? `Terminal growth was capped just below the ${r2(wacc * 100)}% WACC to keep the model finite.` : null,
        disclaimer: DISCLAIMER,
        source: 'Company SEC filings (10-K) via the stockportfolio.pro fundamentals cache; market cap and beta from latest market data. Rf = 10Y Treasury, ERP per Damodaran 2026 — both editable assumptions.'
    };
}

const DISCLAIMER = 'A descriptive fair-value ESTIMATE computed from filed cash flows and the stated, editable assumptions — NOT a price target, forecast, or buy/sell recommendation. Terminal value is typically 50–80% of the total and is sensitive to the terminal-growth and discount-rate assumptions; the bear/base/bull range brackets ±8 points of FCF-growth variance around the filed 5-year trend. Valid only under the assumptions shown. Educational use only.';

module.exports = { buildValuation };
