'use strict';

// Public, deterministic research utilities. These tools deliberately do not
// call the AI layer: their value is a fast, reproducible calculation with the
// filing period and primary source visible.
const fs = require('fs');
const path = require('path');
const fundamentalsFetch = require('./fundamentals-fetch');
const watchdog = require('./watchdog');
const assetProfile = require('./asset-profile');

const FUND_DIR = path.join(__dirname, '..', 'frontend', 'data', 'fundamentals');
const SYMBOL_RE = /^[A-Z0-9][A-Z0-9.\-]{0,9}$/;
const CACHE_TTL_MS = 15 * 60 * 1000;
const DATA_CACHE = new Map();
const BUILD_INFLIGHT = new Map();

const TOOL_DEFINITIONS = Object.freeze({
    'earnings-quality': {
        id: 'tool-earnings-quality',
        slug: 'earnings-quality',
        path: '/tools/earnings-quality',
        title: 'Earnings Quality Checker — operating cash flow vs net income',
        description: 'Check a US company’s filed revenue, net income, operating cash flow, free cash flow and cash-conversion ratio.',
        heading: 'Earnings quality checker',
        intro: 'Compare accounting earnings with the cash flow reported for the same annual period.'
    },
    dilution: {
        id: 'tool-dilution',
        slug: 'dilution',
        path: '/tools/dilution',
        title: 'Share Dilution Calculator — compare filed share counts',
        description: 'Compare a US company’s latest and prior filed share counts, dates and percentage change with split-aware warnings.',
        heading: 'Share dilution calculator',
        intro: 'See how the filed share count changed between the two latest comparable annual periods.'
    },
    'filing-timeline': {
        id: 'tool-filing-timeline',
        slug: 'filing-timeline',
        path: '/tools/filing-timeline',
        title: 'SEC Filing Timeline — 10-K, 10-Q, 8-K, Form 4 and proxy history',
        description: 'Browse a company’s recent 10-K, 10-Q, 8-K, Form 4 and proxy filings with dates, form labels and direct EDGAR links.',
        heading: 'SEC filing timeline',
        intro: 'Find the filing, period and primary SEC document before comparing a financial claim.'
    },
    'filing-change': { id: 'tool-filing-change', slug: 'filing-change', path: '/tools/filing-change', title: 'Filing Change Detector', description: 'Compare key filed line items across the latest two annual periods.', heading: 'Filing change detector', intro: 'See which major filed financial values changed and by how much.' },
    'revenue-consistency': { id: 'tool-revenue-consistency', slug: 'revenue-consistency', path: '/tools/revenue-consistency', title: 'Revenue Growth Consistency Checker', description: 'Measure annual revenue growth consistency and CAGR from filed statements.', heading: 'Revenue growth consistency', intro: 'Separate a durable revenue trend from a single strong year.' },
    'profitability-trend': { id: 'tool-profitability-trend', slug: 'profitability-trend', path: '/tools/profitability-trend', title: 'Profitability Trend Checker', description: 'Track filed operating and net margins across annual periods.', heading: 'Profitability trend', intro: 'See whether reported margins are expanding, stable or contracting.' },
    'cash-flow-quality': { id: 'tool-cash-flow-quality', slug: 'cash-flow-quality', path: '/tools/cash-flow-quality', title: 'Cash Flow Quality Checker', description: 'Compare operating cash flow with net income across annual filings.', heading: 'Cash-flow quality', intro: 'Check whether reported earnings have consistently converted into operating cash.' },
    'free-cash-flow-trend': { id: 'tool-free-cash-flow-trend', slug: 'free-cash-flow-trend', path: '/tools/free-cash-flow-trend', title: 'Free Cash Flow Trend', description: 'Track operating cash flow, capital spending and free cash flow.', heading: 'Free-cash-flow trend', intro: 'Inspect the annual cash left after capital expenditure.' },
    'working-capital': { id: 'tool-working-capital', slug: 'working-capital', path: '/tools/working-capital', title: 'Working Capital Analyzer', description: 'Track receivables, inventory, payables and net working capital.', heading: 'Working-capital analyzer', intro: 'See how operating balance-sheet accounts changed relative to revenue.' },
    'debt-snapshot': { id: 'tool-debt-snapshot', slug: 'debt-snapshot', path: '/tools/debt-snapshot', title: 'Debt Snapshot', description: 'Review current debt, long-term debt, cash and debt trend.', heading: 'Debt snapshot', intro: 'Compare filed debt balances and cash across annual periods.' },
    'buybacks-vs-dilution': { id: 'tool-buybacks-vs-dilution', slug: 'buybacks-vs-dilution', path: '/tools/buybacks-vs-dilution', title: 'Buybacks vs Dilution Checker', description: 'Compare reported repurchases with the net change in shares outstanding.', heading: 'Buybacks versus dilution', intro: 'Check whether repurchase spending translated into a lower filed share count.' },
    'insider-filings': { id: 'tool-insider-filings', slug: 'insider-filings', path: '/tools/insider-filings', title: 'Insider Filing Explorer', description: 'Browse recent Form 4 insider filings with direct SEC links.', heading: 'Insider filing explorer', intro: 'Open recent Form 4 filings at the primary SEC source.' },
    'institutional-filings': { id: 'tool-institutional-filings', slug: 'institutional-filings', path: '/tools/institutional-filings', title: 'Institutional Filing Timeline', description: 'Browse recent 13F institutional filings for a filing entity.', heading: 'Institutional filing timeline', intro: 'Review recent 13F filing dates and primary SEC documents.' },
    'stock-compensation': { id: 'tool-stock-compensation', slug: 'stock-compensation', path: '/tools/stock-compensation', title: 'Stock-Based Compensation Checker', description: 'Compare filed stock compensation with revenue and operating cash flow.', heading: 'Stock-based compensation checker', intro: 'Put stock compensation in context with the business cash flow and share count.' },
    'dividend-safety': { id: 'tool-dividend-safety', slug: 'dividend-safety', path: '/tools/dividend-safety', title: 'Dividend Coverage Checker', description: 'Compare cash dividends with free cash flow and net income.', heading: 'Dividend coverage checker', intro: 'See whether filed cash generation covered reported dividend payments.' },
    'interest-coverage': { id: 'tool-interest-coverage', slug: 'interest-coverage', path: '/tools/interest-coverage', title: 'Interest Coverage Checker', description: 'Compare operating income with filed interest expense.', heading: 'Interest-coverage checker', intro: 'Measure how many times operating income covered interest expense.' },
    'balance-sheet-signals': { id: 'tool-balance-sheet-signals', slug: 'balance-sheet-signals', path: '/tools/balance-sheet-signals', title: 'Balance Sheet Signals', description: 'Review transparent liquidity, leverage and retained-earnings components.', heading: 'Balance-sheet signals', intro: 'Inspect deterministic financial-health components without a black-box score.' },
    'goodwill-concentration': { id: 'tool-goodwill-concentration', slug: 'goodwill-concentration', path: '/tools/goodwill-concentration', title: 'Goodwill Concentration Checker', description: 'Measure goodwill relative to total assets and shareholder equity.', heading: 'Goodwill concentration', intro: 'See how much of the filed asset and equity base is represented by goodwill.' },
    'receivables-warning': { id: 'tool-receivables-warning', slug: 'receivables-warning', path: '/tools/receivables-warning', title: 'Receivables Growth Warning', description: 'Compare receivables growth with revenue growth.', heading: 'Receivables warning check', intro: 'Flag periods when receivables grew materially faster than revenue.' },
    'inventory-warning': { id: 'tool-inventory-warning', slug: 'inventory-warning', path: '/tools/inventory-warning', title: 'Inventory Growth Warning', description: 'Compare inventory growth with revenue growth.', heading: 'Inventory warning check', intro: 'Flag periods when inventory grew materially faster than revenue.' },
    'portfolio-filing-alerts': { id: 'tool-portfolio-filing-alerts', slug: 'portfolio-filing-alerts', path: '/tools/portfolio-filing-alerts', title: 'Portfolio Filing Alert Scanner', description: 'Check the latest SEC filing across a list of tickers.', heading: 'Portfolio filing alert scanner', intro: 'Enter up to ten comma-separated holdings to see their latest filing activity.', multi: true },
    'portfolio-revenue': { id: 'tool-portfolio-revenue', slug: 'portfolio-revenue', path: '/tools/portfolio-revenue', title: 'Portfolio Revenue Exposure', description: 'Compare latest revenue growth across a list of holdings.', heading: 'Portfolio revenue exposure', intro: 'Enter up to ten holdings for an equal-weighted revenue-growth snapshot.', multi: true },
    'portfolio-dilution': { id: 'tool-portfolio-dilution', slug: 'portfolio-dilution', path: '/tools/portfolio-dilution', title: 'Portfolio Dilution Monitor', description: 'Compare filed share-count changes across holdings.', heading: 'Portfolio dilution monitor', intro: 'Enter up to ten holdings to find where filed share counts increased.', multi: true },
    'etf-overlap': { id: 'tool-etf-overlap', slug: 'etf-overlap', path: '/tools/etf-overlap', title: 'ETF Holdings Overlap', description: 'Compare the reported top holdings of two ETFs.', heading: 'ETF holdings overlap', intro: 'Enter two comma-separated ETF tickers to inspect shared top holdings.', multi: true },
    'etf-sector-concentration': { id: 'tool-etf-sector-concentration', slug: 'etf-sector-concentration', path: '/tools/etf-sector-concentration', title: 'ETF Sector Concentration', description: 'Inspect reported sector weights and top-holding concentration.', heading: 'ETF sector concentration', intro: 'See where an ETF is concentrated using its latest reported profile.' },
    'company-comparison': { id: 'tool-company-comparison', slug: 'company-comparison', path: '/tools/company-comparison', title: 'Company Comparison Snapshot', description: 'Compare revenue, margins, cash flow and share count for two companies.', heading: 'Company comparison snapshot', intro: 'Enter two comma-separated tickers for a filing-grounded comparison.', multi: true },
    'peer-cash-conversion': { id: 'tool-peer-cash-conversion', slug: 'peer-cash-conversion', path: '/tools/peer-cash-conversion', title: 'Peer Cash Conversion Ranking', description: 'Rank up to ten companies by operating cash flow divided by net income.', heading: 'Peer cash-conversion ranking', intro: 'Enter comma-separated peers to compare their latest filed cash conversion.', multi: true },
    'ask-question-builder': { id: 'tool-ask-question-builder', slug: 'ask-question-builder', path: '/tools/ask-question-builder', title: 'Source-Backed Ask Question Builder', description: 'Create filing-grounded research questions from a ticker’s latest data.', heading: 'Ask question builder', intro: 'Turn the latest filed periods and metrics into useful research questions.' },
    'filing-evidence-checklist': { id: 'tool-filing-evidence-checklist', slug: 'filing-evidence-checklist', path: '/tools/filing-evidence-checklist', title: 'Filing Evidence Checklist', description: 'Assemble the primary SEC documents needed to verify a company claim.', heading: 'Filing evidence checklist', intro: 'Build a source checklist before publishing or relying on a financial claim.' },
    'research-dossier-starter': { id: 'tool-research-dossier-starter', slug: 'research-dossier-starter', path: '/tools/research-dossier-starter', title: 'Research Dossier Starter', description: 'Assemble filing links, periods and headline metrics for deeper research.', heading: 'Research dossier starter', intro: 'Create a deterministic starting pack for the full StockPortfolio.pro dossier workflow.' }
});

function normalizeSymbol(value) {
    const symbol = String(value || '').trim().toUpperCase();
    return SYMBOL_RE.test(symbol) ? symbol : null;
}

function number(value) {
    if (value === null || value === undefined || value === '' || value === 'None') return null;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function annualRows(data, statement) {
    return (((data || {})[statement] || {}).annualReports || [])
        .filter((row) => row && row.fiscalDateEnding)
        .slice()
        .sort((a, b) => String(b.fiscalDateEnding).localeCompare(String(a.fiscalDateEnding)));
}

function currencyOf(data, rows = []) {
    return String((rows.find((row) => row.reportedCurrency) || data?.overview || {}).reportedCurrency
        || data?.overview?.Currency || 'USD').toUpperCase();
}

function sourceInfo(symbol, data, updatedAt) {
    return {
        symbol,
        currency: currencyOf(data),
        source: 'Company SEC filings (10-K), stockportfolio.pro fundamentals cache',
        sourceUrl: `https://www.sec.gov/edgar/search/#/q=${encodeURIComponent(symbol)}`,
        updatedAt: updatedAt || null,
        note: 'Informational research only. Verify material figures against the linked primary filing before acting.'
    };
}

function computeEarningsQuality(symbol, data, updatedAt) {
    const income = annualRows(data, 'income');
    const cash = annualRows(data, 'cash');
    const latestIncome = income[0] || null;
    if (!latestIncome) return { tool: 'earnings-quality', symbol, error: `No annual income statement data for ${symbol}.` };
    const exactCash = cash.find((row) => row.fiscalDateEnding === latestIncome.fiscalDateEnding) || null;
    const latestCash = exactCash || cash[0] || null;
    const revenue = number(latestIncome.totalRevenue);
    const netIncome = number(latestIncome.netIncome);
    const operatingCashFlow = number(latestCash?.operatingCashflow);
    const capex = number(latestCash?.capitalExpenditures);
    // SEC/Yahoo sources alternate between negative cash outflow and positive
    // capex magnitudes; normalize both to operating cash flow minus spend.
    const freeCashFlow = operatingCashFlow !== null && capex !== null ? operatingCashFlow - Math.abs(capex) : null;
    const cashConversionRatio = operatingCashFlow !== null && netIncome !== null && netIncome !== 0
        ? operatingCashFlow / netIncome : null;
    const result = {
        tool: 'earnings-quality',
        ...sourceInfo(symbol, data, updatedAt),
        period: latestIncome.fiscalDateEnding,
        cashFlowPeriod: latestCash?.fiscalDateEnding || null,
        comparablePeriods: Boolean(exactCash),
        revenue,
        netIncome,
        operatingCashFlow,
        capitalExpenditures: capex,
        freeCashFlow,
        cashConversionRatio,
        warnings: []
    };
    if (!exactCash) result.warnings.push('Cash-flow data is not available for the same annual period; values may not be directly comparable.');
    if (netIncome === null) result.warnings.push('Net income was not disclosed for the selected period.');
    if (operatingCashFlow === null) result.warnings.push('Operating cash flow was not disclosed for the selected period.');
    if (capex === null) result.warnings.push('Capital expenditure was not disclosed; free cash flow cannot be computed.');
    if (netIncome === 0) result.warnings.push('Cash-conversion ratio is not computed when net income is zero.');
    return result;
}

function computeDilution(symbol, data, updatedAt) {
    const rows = annualRows(data, 'balance')
        .filter((row) => number(row.commonStockSharesOutstanding) !== null);
    if (rows.length < 2) return { tool: 'dilution', symbol, error: `Not enough annual share-count data for ${symbol}.` };
    const latest = rows[0];
    const prior = rows[1];
    const latestShares = number(latest.commonStockSharesOutstanding);
    const priorShares = number(prior.commonStockSharesOutstanding);
    const multiple = priorShares > 0 ? latestShares / priorShares : null;
    const splitSuspected = multiple !== null && (multiple > 1.8 || multiple < 0.55);
    const change = latestShares - priorShares;
    const percentageChange = !splitSuspected && priorShares !== 0 ? change / Math.abs(priorShares) * 100 : null;
    const result = {
        tool: 'dilution',
        ...sourceInfo(symbol, data, updatedAt),
        latest: { period: latest.fiscalDateEnding, shares: latestShares },
        prior: { period: prior.fiscalDateEnding, shares: priorShares },
        comparablePeriods: !splitSuspected,
        splitSuspected,
        change: splitSuspected ? null : change,
        percentageChange,
        warnings: []
    };
    if (splitSuspected) result.warnings.push('A split-sized share-count change was detected. The two as-filed counts are not directly comparable.');
    else if (percentageChange > 0) result.warnings.push('The filed share count increased between these comparable annual periods.');
    else if (percentageChange < 0) result.warnings.push('The filed share count decreased between these comparable annual periods.');
    return result;
}

function field(row, ...keys) {
    for (const key of keys) {
        const value = number(row && row[key]);
        if (value !== null) return value;
    }
    return null;
}

function pctChange(latest, prior) {
    return latest !== null && prior !== null && prior !== 0 ? (latest / Math.abs(prior) - Math.sign(prior)) * 100 : null;
}

function safeRatio(a, b, scale = 1) {
    return a !== null && b !== null && b !== 0 ? a / b * scale : null;
}

function genericResult(tool, symbol, data, updatedAt, summary, metrics, rows, warnings = []) {
    return { tool, ...sourceInfo(symbol, data, updatedAt), summary, metrics, rows, warnings };
}

function paired(data, statement) {
    const rows = annualRows(data, statement);
    return { latest: rows[0] || {}, prior: rows[1] || {}, rows };
}

function computeSingleTool(tool, symbol, data, updatedAt) {
    const income = paired(data, 'income');
    const balance = paired(data, 'balance');
    const cash = paired(data, 'cash');
    const period = income.latest.fiscalDateEnding || balance.latest.fiscalDateEnding || cash.latest.fiscalDateEnding || null;
    const rev = field(income.latest, 'totalRevenue');
    const prevRev = field(income.prior, 'totalRevenue');
    const ni = field(income.latest, 'netIncome');
    const op = field(income.latest, 'operatingIncome');
    const ocf = field(cash.latest, 'operatingCashflow');
    const capex = field(cash.latest, 'capitalExpenditures');
    const fcf = ocf !== null && capex !== null ? ocf - Math.abs(capex) : null;
    const shares = field(balance.latest, 'commonStockSharesOutstanding');
    const prevShares = field(balance.prior, 'commonStockSharesOutstanding');
    const warnings = [];
    const annual = (statement, mapper) => annualRows(data, statement).slice(0, 6).map(mapper);

    if (tool === 'filing-change') {
        const specs = [
            ['Revenue', income.latest, income.prior, 'totalRevenue'], ['Net income', income.latest, income.prior, 'netIncome'],
            ['Operating cash flow', cash.latest, cash.prior, 'operatingCashflow'], ['Total assets', balance.latest, balance.prior, 'totalAssets'],
            ['Total liabilities', balance.latest, balance.prior, 'totalLiabilities'], ['Shares outstanding', balance.latest, balance.prior, 'commonStockSharesOutstanding']
        ];
        const rows = specs.map(([metric, a, b, key]) => { const latest = field(a, key); const prior = field(b, key); return { metric, latest, prior, changePct: pctChange(latest, prior) }; });
        return genericResult(tool, symbol, data, updatedAt, `Latest filed annual changes through ${period || 'the available period'}.`, [], rows, rows.some((r) => r.latest === null || r.prior === null) ? ['Some line items were not available in both periods.'] : []);
    }
    if (tool === 'revenue-consistency') {
        const rows = annual('income', (r, i, all) => ({ period: r.fiscalDateEnding, revenue: field(r, 'totalRevenue'), growthPct: i < all.length - 1 ? pctChange(field(r, 'totalRevenue'), field(all[i + 1], 'totalRevenue')) : null }));
        const growth = rows.map((r) => r.growthPct).filter(Number.isFinite);
        const oldest = rows[rows.length - 1];
        const years = Math.max(1, rows.length - 1);
        const cagr = rows.length > 1 && rows[0].revenue > 0 && oldest.revenue > 0 ? (Math.pow(rows[0].revenue / oldest.revenue, 1 / years) - 1) * 100 : null;
        return genericResult(tool, symbol, data, updatedAt, `${growth.filter((v) => v > 0).length} of ${growth.length} measured years had positive revenue growth.`, [{ label: 'Revenue CAGR', value: cagr, format: 'percent' }, { label: 'Positive-growth years', value: growth.filter((v) => v > 0).length, format: 'number' }], rows);
    }
    if (tool === 'profitability-trend') {
        const rows = annual('income', (r) => { const revenue = field(r, 'totalRevenue'); return { period: r.fiscalDateEnding, revenue, operatingMarginPct: safeRatio(field(r, 'operatingIncome'), revenue, 100), netMarginPct: safeRatio(field(r, 'netIncome'), revenue, 100) }; });
        return genericResult(tool, symbol, data, updatedAt, `Filed profitability history through ${period || 'the latest period'}.`, [{ label: 'Latest operating margin', value: rows[0]?.operatingMarginPct, format: 'percent' }, { label: 'Latest net margin', value: rows[0]?.netMarginPct, format: 'percent' }], rows);
    }
    if (tool === 'cash-flow-quality') {
        const cashByPeriod = new Map(annualRows(data, 'cash').map((r) => [r.fiscalDateEnding, r]));
        const rows = annual('income', (r) => { const c = cashByPeriod.get(r.fiscalDateEnding) || {}; const netIncome = field(r, 'netIncome'); const operatingCashFlow = field(c, 'operatingCashflow'); return { period: r.fiscalDateEnding, netIncome, operatingCashFlow, cashConversionRatio: safeRatio(operatingCashFlow, netIncome) }; });
        return genericResult(tool, symbol, data, updatedAt, 'Cash conversion compares operating cash flow with net income for matching annual periods.', [{ label: 'Latest cash conversion', value: rows[0]?.cashConversionRatio, format: 'ratio' }], rows, rows.some((r) => r.operatingCashFlow === null) ? ['Some matching cash-flow periods are missing.'] : []);
    }
    if (tool === 'free-cash-flow-trend') {
        const rows = annual('cash', (r) => { const operatingCashFlow = field(r, 'operatingCashflow'); const capitalExpenditures = field(r, 'capitalExpenditures'); return { period: r.fiscalDateEnding, operatingCashFlow, capitalExpenditures, freeCashFlow: operatingCashFlow !== null && capitalExpenditures !== null ? operatingCashFlow - Math.abs(capitalExpenditures) : null }; });
        return genericResult(tool, symbol, data, updatedAt, 'Free cash flow equals operating cash flow minus the absolute capital-expenditure outflow.', [{ label: 'Latest free cash flow', value: rows[0]?.freeCashFlow, format: 'money' }], rows);
    }
    if (tool === 'working-capital') {
        const rows = annual('balance', (r) => { const receivables = field(r, 'currentNetReceivables'); const inventory = field(r, 'inventory'); const payables = field(r, 'currentAccountsPayable'); return { period: r.fiscalDateEnding, receivables, inventory, payables, netOperatingWorkingCapital: receivables !== null && inventory !== null && payables !== null ? receivables + inventory - payables : null }; });
        return genericResult(tool, symbol, data, updatedAt, 'Net operating working capital here is receivables plus inventory minus accounts payable.', [{ label: 'Latest net working capital', value: rows[0]?.netOperatingWorkingCapital, format: 'money' }], rows);
    }
    if (tool === 'debt-snapshot') {
        const rows = annual('balance', (r) => ({ period: r.fiscalDateEnding, currentDebt: field(r, 'currentDebt', 'shortTermDebt'), longTermDebt: field(r, 'longTermDebt', 'longTermDebtNoncurrent'), cash: field(r, 'cashAndCashEquivalentsAtCarryingValue', 'cashAndShortTermInvestments') }));
        const debt = (rows[0]?.currentDebt || 0) + (rows[0]?.longTermDebt || 0);
        return genericResult(tool, symbol, data, updatedAt, 'Debt balances are as filed and may not include every contractual maturity detail.', [{ label: 'Latest total debt', value: debt, format: 'money' }, { label: 'Latest cash', value: rows[0]?.cash, format: 'money' }], rows);
    }
    if (tool === 'buybacks-vs-dilution') {
        const repurchases = Math.abs(field(cash.latest, 'paymentsForRepurchaseOfCommonStock', 'paymentsForRepurchaseOfEquity') || 0);
        const changePct = pctChange(shares, prevShares);
        if (changePct !== null && changePct > 0) warnings.push('Shares increased despite reported repurchase spending; issuance or compensation may have offset buybacks.');
        return genericResult(tool, symbol, data, updatedAt, 'Repurchase cash outflow is compared with the net filed share-count change.', [{ label: 'Repurchase spending', value: repurchases, format: 'money' }, { label: 'Share-count change', value: changePct, format: 'percent' }], [{ period, repurchases, latestShares: shares, priorShares: prevShares, shareChangePct: changePct }], warnings);
    }
    if (tool === 'stock-compensation') {
        const sbc = field(cash.latest, 'stockBasedCompensation', 'shareBasedCompensation');
        if (sbc === null) warnings.push('Stock-based compensation was not available as a separate cached line item.');
        return genericResult(tool, symbol, data, updatedAt, 'Stock compensation is shown only when separately disclosed in the cached filing facts.', [{ label: 'Stock compensation', value: sbc, format: 'money' }, { label: 'SBC / revenue', value: safeRatio(sbc, rev, 100), format: 'percent' }, { label: 'SBC / operating cash flow', value: safeRatio(sbc, ocf, 100), format: 'percent' }], [{ period, stockBasedCompensation: sbc, revenue: rev, operatingCashFlow: ocf, shares }], warnings);
    }
    if (tool === 'dividend-safety') {
        const dividends = Math.abs(field(cash.latest, 'dividendPayout', 'dividendPayoutCommonStock') || 0);
        return genericResult(tool, symbol, data, updatedAt, 'Coverage compares filed cash dividends with free cash flow and net income; it is not a dividend forecast.', [{ label: 'Cash dividends', value: dividends, format: 'money' }, { label: 'FCF coverage', value: safeRatio(fcf, dividends), format: 'ratio' }, { label: 'Earnings payout', value: safeRatio(dividends, ni, 100), format: 'percent' }], [{ period, dividends, freeCashFlow: fcf, netIncome: ni }], fcf !== null && dividends > fcf ? ['Cash dividends exceeded free cash flow in the latest period.'] : []);
    }
    if (tool === 'interest-coverage') {
        const interest = Math.abs(field(income.latest, 'interestExpense', 'interestAndDebtExpense') || 0);
        return genericResult(tool, symbol, data, updatedAt, 'Interest coverage equals operating income divided by reported interest expense.', [{ label: 'Operating income', value: op, format: 'money' }, { label: 'Interest expense', value: interest, format: 'money' }, { label: 'Interest coverage', value: safeRatio(op, interest), format: 'ratio' }], [{ period, operatingIncome: op, interestExpense: interest, coverage: safeRatio(op, interest) }], interest === 0 ? ['No separate interest expense was available; coverage cannot be interpreted.'] : []);
    }
    if (tool === 'balance-sheet-signals') {
        const assets = field(balance.latest, 'totalAssets'); const liabilities = field(balance.latest, 'totalLiabilities');
        const currentAssets = field(balance.latest, 'totalCurrentAssets'); const currentLiabilities = field(balance.latest, 'totalCurrentLiabilities');
        const retained = field(balance.latest, 'retainedEarnings');
        return genericResult(tool, symbol, data, updatedAt, 'Transparent components are shown individually; no proprietary bankruptcy probability is claimed.', [{ label: 'Current ratio', value: safeRatio(currentAssets, currentLiabilities), format: 'ratio' }, { label: 'Liabilities / assets', value: safeRatio(liabilities, assets, 100), format: 'percent' }, { label: 'Retained earnings / assets', value: safeRatio(retained, assets, 100), format: 'percent' }], [{ period, currentAssets, currentLiabilities, assets, liabilities, retainedEarnings: retained }]);
    }
    if (tool === 'goodwill-concentration') {
        const goodwill = field(balance.latest, 'goodwill'); const assets = field(balance.latest, 'totalAssets'); const equity = field(balance.latest, 'totalShareholderEquity');
        return genericResult(tool, symbol, data, updatedAt, 'Goodwill concentration is descriptive and does not predict an impairment.', [{ label: 'Goodwill', value: goodwill, format: 'money' }, { label: 'Goodwill / assets', value: safeRatio(goodwill, assets, 100), format: 'percent' }, { label: 'Goodwill / equity', value: safeRatio(goodwill, equity, 100), format: 'percent' }], [{ period, goodwill, totalAssets: assets, shareholderEquity: equity }]);
    }
    if (tool === 'receivables-warning' || tool === 'inventory-warning') {
        const key = tool === 'receivables-warning' ? 'currentNetReceivables' : 'inventory';
        const label = tool === 'receivables-warning' ? 'Receivables' : 'Inventory';
        const latestValue = field(balance.latest, key); const priorValue = field(balance.prior, key);
        const itemGrowth = pctChange(latestValue, priorValue); const revenueGrowth = pctChange(rev, prevRev);
        if (itemGrowth !== null && revenueGrowth !== null && itemGrowth > revenueGrowth + 10) warnings.push(`${label} growth exceeded revenue growth by more than 10 percentage points.`);
        return genericResult(tool, symbol, data, updatedAt, `${label} growth is compared with revenue growth over the same annual periods.`, [{ label: `${label} growth`, value: itemGrowth, format: 'percent' }, { label: 'Revenue growth', value: revenueGrowth, format: 'percent' }, { label: 'Growth gap', value: itemGrowth !== null && revenueGrowth !== null ? itemGrowth - revenueGrowth : null, format: 'percent' }], [{ period, latestValue, priorValue, itemGrowthPct: itemGrowth, revenueGrowthPct: revenueGrowth }], warnings);
    }
    if (tool === 'ask-question-builder') {
        const questions = [
            `Why did ${symbol}'s operating cash flow ${ocf !== null && ni !== null && ocf >= ni ? 'exceed' : 'trail'} net income in the ${period || 'latest'} filing?`,
            `What explains ${symbol}'s latest revenue change, and which filing sections support the explanation?`,
            `Did ${symbol}'s share count change materially, and what issuance or repurchase disclosures explain it?`,
            `What were the most material risks or accounting changes in ${symbol}'s latest 10-K or 10-Q?`
        ];
        return genericResult(tool, symbol, data, updatedAt, 'Copy one of these deterministic prompts into Ask for a cited answer.', [], questions.map((question, index) => ({ number: index + 1, question })));
    }
    return null;
}

async function filingTimeline(symbol) {
    const forms = new Set(['10-K', '10-K/A', '10-Q', '10-Q/A', '8-K', '8-K/A', '4', '4/A', 'DEF 14A']);
    const filings = await watchdog.fetchFilingsDeep(symbol, forms, {
        '10-K': 5, '10-K/A': 2, '10-Q': 6, '10-Q/A': 2, '8-K': 8, '8-K/A': 2, '4': 8, '4/A': 2, 'DEF 14A': 4
    });
    if (!filings || !filings.length) return { tool: 'filing-timeline', symbol, error: `No SEC filings found for ${symbol}.` };
    const labels = watchdog.FORM_LABEL || {};
    return {
        tool: 'filing-timeline', symbol,
        source: 'SEC EDGAR',
        generatedAt: new Date().toISOString(),
        filings: filings
            .slice()
            .sort((a, b) => String(b.date).localeCompare(String(a.date)))
            .map((filing) => ({ form: filing.form, label: labels[filing.form] || filing.form, date: filing.date, url: filing.url }))
    };
}

function parseSymbols(value, { min = 1, max = 10 } = {}) {
    const symbols = [...new Set(String(value || '').toUpperCase().split(/[\s,]+/).map(normalizeSymbol).filter(Boolean))];
    return symbols.length >= min && symbols.length <= max ? symbols : null;
}

async function filingTool(tool, symbol) {
    const formMap = {
        'insider-filings': new Set(['4', '4/A']),
        'institutional-filings': new Set(['13F-HR', '13F-HR/A']),
        'filing-evidence-checklist': new Set(['10-K', '10-Q', '8-K', 'DEF 14A']),
        'research-dossier-starter': new Set(['10-K', '10-Q', '8-K', 'DEF 14A'])
    };
    const forms = formMap[tool];
    const filings = await watchdog.fetchFilingsDeep(symbol, forms, Object.fromEntries([...forms].map((form) => [form, 6])));
    const rows = (filings || []).sort((a, b) => String(b.date).localeCompare(String(a.date))).map((filing) => ({ date: filing.date, form: filing.form, label: watchdog.FORM_LABEL[filing.form] || filing.form, url: filing.url }));
    if (tool === 'filing-evidence-checklist') {
        const required = ['10-K', '10-Q', '8-K', 'DEF 14A'].map((form) => { const found = rows.find((row) => row.form === form); return { document: form, status: found ? 'Available' : 'Not found in recent filings', date: found?.date || null, url: found?.url || null }; });
        return { tool, symbol, source: 'SEC EDGAR', generatedAt: new Date().toISOString(), summary: 'Use this checklist to verify periods, material events and governance claims at the primary source.', metrics: [], rows: required, warnings: ['Availability does not prove that a filing supports a particular claim; read the document.'] };
    }
    if (tool === 'research-dossier-starter') {
        const loaded = await loadFundamentals(symbol);
        const data = loaded?.data || {};
        const earnings = loaded ? computeEarningsQuality(symbol, data, loaded.updatedAt) : {};
        return { tool, symbol, source: 'SEC EDGAR and stockportfolio.pro fundamentals cache', generatedAt: new Date().toISOString(), summary: 'A deterministic starting pack for deeper research; no AI conclusion is generated.', metrics: [
            { label: 'Latest revenue', value: earnings.revenue, format: 'money' }, { label: 'Latest net income', value: earnings.netIncome, format: 'money' }, { label: 'Latest free cash flow', value: earnings.freeCashFlow, format: 'money' }
        ], rows: rows.slice(0, 12), warnings: earnings.warnings || [] };
    }
    return { tool, symbol, source: 'SEC EDGAR', generatedAt: new Date().toISOString(), summary: rows.length ? `Found ${rows.length} recent matching filings.` : 'No matching recent filings were found.', metrics: [{ label: 'Matching filings', value: rows.length, format: 'number' }], rows, warnings: [] };
}

async function loadMany(symbols) {
    return Promise.all(symbols.map(async (symbol) => ({ symbol, loaded: await loadFundamentals(symbol) })));
}

async function computeMultiTool(tool, symbols) {
    if (tool === 'etf-overlap') {
        if (symbols.length !== 2) return { error: 'Enter exactly two ETF tickers separated by a comma.' };
        const profiles = await Promise.all(symbols.map((symbol) => assetProfile.fetchAssetProfile(symbol)));
        if (profiles.some((profile) => !assetProfile.isFundAsset(profile.assetType))) return { error: 'Both symbols must resolve to ETFs or mutual funds.' };
        const [a, b] = profiles; const bMap = new Map(b.topHoldings.map((holding) => [holding.symbol || holding.name, holding]));
        const rows = a.topHoldings.filter((holding) => bMap.has(holding.symbol || holding.name)).map((holding) => { const other = bMap.get(holding.symbol || holding.name); return { holding: holding.symbol || holding.name, firstWeightPct: holding.weight == null ? null : holding.weight * 100, secondWeightPct: other.weight == null ? null : other.weight * 100, minimumSharedWeightPct: holding.weight != null && other.weight != null ? Math.min(holding.weight, other.weight) * 100 : null }; });
        return { tool, symbols, source: 'Yahoo Finance fund profiles', generatedAt: new Date().toISOString(), summary: `${a.symbol} and ${b.symbol} share ${rows.length} holdings within their reported top-holdings lists.`, metrics: [{ label: 'Shared top holdings', value: rows.length, format: 'number' }, { label: 'Minimum overlap shown', value: rows.reduce((sum, row) => sum + (row.minimumSharedWeightPct || 0), 0), format: 'percent' }], rows, warnings: ['This is a lower-bound comparison of reported top holdings, not complete portfolio overlap.'] };
    }
    if (tool === 'portfolio-filing-alerts') {
        const rows = await Promise.all(symbols.map(async (symbol) => { const filings = await watchdog.fetchRecentFilings(symbol, new Set(['10-K', '10-Q', '8-K']), 1).catch(() => []); const filing = filings?.[0]; return { symbol, date: filing?.date || null, form: filing?.form || null, url: filing?.url || null }; }));
        return { tool, symbols, source: 'SEC EDGAR', generatedAt: new Date().toISOString(), summary: `Latest filing activity for ${symbols.length} holdings.`, metrics: [{ label: 'Holdings checked', value: symbols.length, format: 'number' }, { label: 'Filings found', value: rows.filter((row) => row.form).length, format: 'number' }], rows, warnings: [] };
    }
    const records = await loadMany(symbols);
    const missing = records.filter((record) => !record.loaded).map((record) => record.symbol);
    const valid = records.filter((record) => record.loaded);
    if (!valid.length) return { error: 'No supported filing data was found for the supplied symbols.' };
    if (tool === 'portfolio-revenue') {
        const rows = valid.map(({ symbol, loaded }) => { const inc = annualRows(loaded.data, 'income'); const latest = field(inc[0], 'totalRevenue'); const prior = field(inc[1], 'totalRevenue'); return { symbol, period: inc[0]?.fiscalDateEnding || null, revenue: latest, revenueGrowthPct: pctChange(latest, prior) }; });
        const values = rows.map((row) => row.revenueGrowthPct).filter(Number.isFinite);
        return { tool, symbols, source: 'Company SEC filings', generatedAt: new Date().toISOString(), summary: 'Equal-weighted snapshot; portfolio position sizes are not used.', metrics: [{ label: 'Average revenue growth', value: values.length ? values.reduce((a, b) => a + b, 0) / values.length : null, format: 'percent' }], rows, warnings: missing.length ? [`No data for: ${missing.join(', ')}.`] : [] };
    }
    if (tool === 'portfolio-dilution') {
        const rows = valid.map(({ symbol, loaded }) => { const d = computeDilution(symbol, loaded.data, loaded.updatedAt); return { symbol, latestPeriod: d.latest?.period || null, priorPeriod: d.prior?.period || null, shareChangePct: d.percentageChange, comparable: d.comparablePeriods !== false }; });
        return { tool, symbols, source: 'Company SEC filings', generatedAt: new Date().toISOString(), summary: 'Filed share-count changes across the supplied holdings.', metrics: [{ label: 'Holdings with dilution', value: rows.filter((row) => row.shareChangePct > 0).length, format: 'number' }], rows, warnings: missing.length ? [`No data for: ${missing.join(', ')}.`] : [] };
    }
    if (tool === 'company-comparison') {
        if (symbols.length !== 2) return { error: 'Enter exactly two company tickers separated by a comma.' };
        const rows = valid.map(({ symbol, loaded }) => { const i = annualRows(loaded.data, 'income')[0] || {}; const c = annualRows(loaded.data, 'cash')[0] || {}; const b = annualRows(loaded.data, 'balance')[0] || {}; const revenue = field(i, 'totalRevenue'); const netIncome = field(i, 'netIncome'); const operatingCashFlow = field(c, 'operatingCashflow'); const capex = field(c, 'capitalExpenditures'); return { symbol, period: i.fiscalDateEnding, revenue, netMarginPct: safeRatio(netIncome, revenue, 100), operatingCashFlow, freeCashFlow: operatingCashFlow !== null && capex !== null ? operatingCashFlow - Math.abs(capex) : null, shares: field(b, 'commonStockSharesOutstanding') }; });
        return { tool, symbols, source: 'Company SEC filings', generatedAt: new Date().toISOString(), summary: 'Latest as-filed values are shown with their periods; fiscal calendars may differ.', metrics: [], rows, warnings: rows[0]?.period !== rows[1]?.period ? ['The companies have different fiscal period-end dates.'] : [] };
    }
    if (tool === 'peer-cash-conversion') {
        const rows = valid.map(({ symbol, loaded }) => { const i = annualRows(loaded.data, 'income')[0] || {}; const c = annualRows(loaded.data, 'cash').find((row) => row.fiscalDateEnding === i.fiscalDateEnding) || {}; const netIncome = field(i, 'netIncome'); const operatingCashFlow = field(c, 'operatingCashflow'); return { symbol, period: i.fiscalDateEnding, netIncome, operatingCashFlow, cashConversionRatio: safeRatio(operatingCashFlow, netIncome) }; }).sort((a, b) => (b.cashConversionRatio ?? -Infinity) - (a.cashConversionRatio ?? -Infinity));
        return { tool, symbols, source: 'Company SEC filings', generatedAt: new Date().toISOString(), summary: 'Ranking uses matching-period operating cash flow divided by net income; negative earnings require caution.', metrics: [{ label: 'Peers ranked', value: rows.length, format: 'number' }], rows, warnings: rows.some((row) => row.netIncome <= 0) ? ['At least one peer has zero or negative net income, which can make the ratio misleading.'] : [] };
    }
    return { error: 'This multi-symbol tool is unavailable.' };
}

async function etfSectorTool(symbol) {
    const profile = await assetProfile.fetchAssetProfile(symbol);
    if (!assetProfile.isFundAsset(profile.assetType)) return { error: `${symbol} is not an ETF or mutual fund.` };
    const rows = (profile.allocations?.sectors || []).map((row) => ({ sector: row.name, weightPct: row.weight == null ? null : row.weight * 100 })).sort((a, b) => (b.weightPct || 0) - (a.weightPct || 0));
    const topWeight = (profile.topHoldings || []).slice(0, 10).reduce((sum, row) => sum + (row.weight || 0), 0) * 100;
    return { tool: 'etf-sector-concentration', symbol, source: profile.source, generatedAt: new Date().toISOString(), summary: `Latest reported allocation profile for ${profile.name}.`, metrics: [{ label: 'Largest sector', value: rows[0]?.weightPct, format: 'percent' }, { label: 'Top-10 holdings weight', value: topWeight, format: 'percent' }, { label: 'Expense ratio', value: profile.expenseRatio == null ? null : profile.expenseRatio * 100, format: 'percent' }], rows, warnings: ['Fund holdings and sector allocations can be reported on different source dates.'] };
}

function cacheFile(symbol) {
    return path.join(FUND_DIR, `${symbol.replace(/[^A-Z0-9]/g, '_')}.json`);
}

async function loadFundamentals(symbol) {
    const hit = DATA_CACHE.get(symbol);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
    let data = null;
    const file = cacheFile(symbol);
    try { if (fs.existsSync(file)) data = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { data = null; }
    if (!data && fundamentalsFetch.lookup(symbol)) {
        if (!BUILD_INFLIGHT.has(symbol)) BUILD_INFLIGHT.set(symbol, fundamentalsFetch.buildFundamentals(symbol).finally(() => BUILD_INFLIGHT.delete(symbol)));
        try { data = await BUILD_INFLIGHT.get(symbol); } catch (_) { data = null; }
    }
    if (!data) return null;
    const loaded = { data, at: Date.now(), updatedAt: fs.existsSync(file) ? fs.statSync(file).mtime.toISOString() : null };
    DATA_CACHE.set(symbol, loaded);
    if (DATA_CACHE.size > 100) DATA_CACHE.delete(DATA_CACHE.keys().next().value);
    return loaded;
}

async function getToolResult(tool, rawSymbol) {
    const definition = TOOL_DEFINITIONS[tool];
    if (!definition) return { status: 404, body: { error: 'Unknown free tool.' } };
    if (definition.multi) {
        const min = ['etf-overlap', 'company-comparison'].includes(tool) ? 2 : 1;
        const symbols = parseSymbols(rawSymbol, { min, max: 10 });
        if (!symbols) return { status: 400, body: { error: `Enter ${min === 2 ? 'at least two' : 'one to ten'} valid comma-separated ticker symbols.` } };
        try {
            const body = await computeMultiTool(tool, symbols);
            return { status: body.error ? 422 : 200, body };
        } catch (_) { return { status: 502, body: { error: 'The requested market data is temporarily unavailable.' } }; }
    }
    const symbol = normalizeSymbol(rawSymbol);
    if (!symbol) return { status: 400, body: { error: 'Enter a valid ticker symbol.' } };
    if (tool === 'etf-sector-concentration') {
        try { const body = await etfSectorTool(symbol); return { status: body.error ? 422 : 200, body }; }
        catch (_) { return { status: 502, body: { error: 'The fund profile is temporarily unavailable.' } }; }
    }
    const filingTools = new Set(['filing-timeline', 'insider-filings', 'institutional-filings', 'filing-evidence-checklist', 'research-dossier-starter']);
    if (filingTools.has(tool)) {
        try {
            const body = tool === 'filing-timeline' ? await filingTimeline(symbol) : await filingTool(tool, symbol);
            return { status: 200, body };
        } catch (_) { return { status: 502, body: { error: 'SEC filing data is temporarily unavailable. Try again shortly.' } }; }
    }
    // Reuse the existing US-listed universe allowlist before touching the SEC
    // or fundamentals cache. This keeps arbitrary hostnames/strings from
    // becoming on-demand fetch jobs and gives unsupported symbols a safe 404.
    if (!fundamentalsFetch.lookup(symbol)) {
        return { status: 404, body: { error: `${symbol} is not a supported US-listed ticker.` } };
    }
    const loaded = await loadFundamentals(symbol);
    if (!loaded) return { status: 404, body: { error: `No supported USD filing data was found for ${symbol}.` } };
    const currency = currencyOf(loaded.data);
    if (currency !== 'USD') return { status: 422, body: { error: `${symbol} reports in ${currency}, which is outside this pilot's USD coverage.` } };
    let body;
    if (tool === 'earnings-quality') body = computeEarningsQuality(symbol, loaded.data, loaded.updatedAt);
    else if (tool === 'dilution') body = computeDilution(symbol, loaded.data, loaded.updatedAt);
    else body = computeSingleTool(tool, symbol, loaded.data, loaded.updatedAt);
    return body ? { status: 200, body } : { status: 501, body: { error: 'This tool is not implemented.' } };
}

function esc(value) {
    return String(value == null ? '' : value)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function renderToolPage(tool) {
    const definition = TOOL_DEFINITIONS[tool];
    if (!definition) return '';
    const canonical = `https://www.stockportfolio.pro${definition.path}`;
    const ctaHref = `/appsumo?source=website&content_id=${encodeURIComponent(definition.id)}&utm_source=website&utm_medium=free_tool&utm_campaign=engineering-tools&utm_content=${encodeURIComponent(definition.id)}`;
    const jsonld = JSON.stringify({
        '@context': 'https://schema.org', '@type': 'WebApplication', name: definition.heading,
        applicationCategory: 'FinanceApplication', operatingSystem: 'Web', url: canonical,
        description: definition.description, isAccessibleForFree: true,
        publisher: { '@type': 'Organization', name: 'stockportfolio.pro', url: 'https://www.stockportfolio.pro' }
    });
    const labels = {
        'earnings-quality': 'Latest annual filed values',
        dilution: 'Latest comparable annual share counts',
        'filing-timeline': 'Recent SEC filings'
    };
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(definition.title)}</title><meta name="description" content="${esc(definition.description)}"><link rel="canonical" href="${canonical}"><link rel="icon" type="image/png" sizes="48x48" href="/Media/icon.png?v=20260729-favicon1"><link rel="apple-touch-icon" href="/Media/icon.png?v=20260729-favicon1"><meta property="og:title" content="${esc(definition.title)}"><meta property="og:description" content="${esc(definition.description)}"><meta property="og:url" content="${canonical}"><script type="application/ld+json">${jsonld}</script><style>
body{margin:0;background:#fafaf9;color:#18202b;font:15px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:900px;margin:0 auto;padding:32px 20px 70px}a{color:#2563eb}.crumb{font-size:13px;color:#64748b}.hero{margin:28px 0 22px}.hero h1{font-size:38px;line-height:1.1;margin:0 0 10px}.hero p{color:#64748b;max-width:680px;font-size:17px}.panel{background:#fff;border:1px solid #e5e7eb;border-radius:14px;padding:20px;margin:18px 0;box-shadow:0 3px 12px #1118270a}.form{display:flex;gap:10px;flex-wrap:wrap}.form input{border:1px solid #cbd5e1;border-radius:8px;padding:12px;font:inherit;text-transform:uppercase;width:180px}.form button{border:0;border-radius:8px;padding:12px 18px;background:#111827;color:#fff;font:inherit;cursor:pointer}.hint,.note{font-size:13px;color:#64748b}.result h2{margin-top:0}.error{color:#b91c1c}.value-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(155px,1fr));gap:10px}.value{border:1px solid #e5e7eb;border-radius:10px;padding:12px}.value strong{display:block;font-size:20px;margin-top:3px}table{border-collapse:collapse;width:100%;margin-top:10px}th,td{text-align:left;border-bottom:1px solid #e5e7eb;padding:9px 7px;vertical-align:top}th{font-size:12px;text-transform:uppercase;color:#64748b}.cta{background:#eff6ff;border-color:#bfdbfe}.cta a{font-weight:700}.cta-bridge{margin:8px 0 0}.cta-bridge a{font-weight:600}.warning{background:#fffbeb;border-color:#fde68a;color:#92400e;padding:10px;border-radius:8px;margin-top:10px}.footer{margin-top:30px;color:#64748b;font-size:13px}@media(max-width:600px){.hero h1{font-size:30px}main{padding:24px 14px 50px}}
</style></head><body><main><div class="crumb"><a href="/">Home</a> / Free tools / ${esc(definition.heading)}</div><section class="hero"><h1>${esc(definition.heading)}</h1><p>${esc(definition.intro)} This free utility uses filed data and does not provide investment advice.</p></section><section class="panel"><form class="form" id="tool-form"><label for="symbol" class="hint" style="width:100%">Enter a US ticker symbol</label><input id="symbol" name="symbol" maxlength="10" autocomplete="off" placeholder="AAPL" required><button type="submit">Run ${esc(labels[tool])}</button></form><p class="hint">Source: SEC filings via stockportfolio.pro. Verify material figures against the primary filing.</p></section><section class="panel result" id="result" aria-live="polite"><h2>Enter a ticker to see the result</h2><p class="note">The result includes the reporting period, source and any comparability warnings.</p></section><section class="panel cta"><strong>Want the full research workflow?</strong><p id="cta-copy">Investigate the complete filing and source trail on StockPortfolio.pro.</p><a id="cta" href="${ctaHref}" data-content-id="${esc(definition.id)}" data-tool-id="${esc(definition.id)}">Explore StockPortfolio.pro on AppSumo &rarr;</a><p class="cta-bridge"><a id="cta-watch" href="/monitor.html">Watch this company — get this check every time the filing changes &rarr;</a></p><p class="cta-bridge"><a id="cta-ask" href="/ask.html">Ask what this means in plain words &rarr;</a></p><p class="cta-bridge"><a href="/filing-changes">See what changed in the latest filings &rarr;</a></p></section><section class="footer"><a href="/methodology">Methodology</a> · <a href="/screener">Free screener</a> · <a href="/tools/earnings-quality">Earnings quality</a> · <a href="/tools/dilution">Dilution</a> · <a href="/tools/filing-timeline">Filing timeline</a></section></main><script>
const TOOL=${JSON.stringify(tool)}, CONTENT_ID=${JSON.stringify(definition.id)}, form=document.getElementById('tool-form'), result=document.getElementById('result'), symbolInput=document.getElementById('symbol'), cta=document.getElementById('cta');
function escText(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function fmt(v,dp=2){return v==null?'—':Number(v).toLocaleString('en-US',{maximumFractionDigits:dp});}
function money(v){return v==null?'—':fmt(v,0);}
function warningList(items){return (items||[]).map(x=>'<div class="warning">'+escText(x)+'</div>').join('');}
function render(data){if(data.error){result.innerHTML='<h2 class="error">'+escText(data.error)+'</h2>';return;} let html='<h2>'+escText(data.symbol||'')+' · result</h2>';
 if(TOOL==='earnings-quality'){html+='<p class="note">Income period: '+escText(data.period)+' · cash-flow period: '+escText(data.cashFlowPeriod||'—')+' · updated: '+escText(data.updatedAt||'—')+' · <a href="'+escText(data.sourceUrl)+'" target="_blank" rel="noopener nofollow">SEC source</a></p><div class="value-grid">'+[['Revenue',money(data.revenue)],['Net income',money(data.netIncome)],['Operating cash flow',money(data.operatingCashFlow)],['Free cash flow',money(data.freeCashFlow)],['Cash conversion',data.cashConversionRatio==null?'—':fmt(data.cashConversionRatio)+'×']].map(x=>'<div class="value"><span>'+x[0]+'</span><strong>'+x[1]+'</strong></div>').join('')+'</div>';
 } else if(TOOL==='dilution'){html+='<p class="note">Updated: '+escText(data.updatedAt||'—')+' · <a href="'+escText(data.sourceUrl)+'" target="_blank" rel="noopener nofollow">SEC source</a></p><table><tr><th>Period</th><th>Filed shares</th></tr><tr><td>'+escText(data.latest.period)+'</td><td>'+money(data.latest.shares)+'</td></tr><tr><td>'+escText(data.prior.period)+'</td><td>'+money(data.prior.shares)+'</td></tr></table><div class="value-grid" style="margin-top:12px"><div class="value"><span>Change</span><strong>'+money(data.change)+'</strong></div><div class="value"><span>Percentage change</span><strong>'+(data.percentageChange==null?'—':fmt(data.percentageChange)+'%')+'</strong></div></div>';
 } else {html+='<p class="note">Generated: '+escText(data.generatedAt||'—')+' · source: SEC EDGAR</p><table><tr><th>Date</th><th>Form</th><th>Primary source</th></tr>'+(data.filings||[]).map(f=>'<tr><td>'+escText(f.date)+'</td><td>'+escText(f.label||f.form)+'</td><td><a href="'+escText(f.url)+'" target="_blank" rel="noopener nofollow">Open SEC filing</a></td></tr>').join('')+'</table>';}
 html+=warningList(data.warnings); result.innerHTML=html; cta.href='/appsumo?source=website&content_id='+encodeURIComponent(CONTENT_ID)+'&utm_source=website&utm_medium=free_tool&utm_campaign=engineering-tools&utm_content='+encodeURIComponent(CONTENT_ID);var sym=(data.symbol||'').toUpperCase();if(sym){var w=document.getElementById('cta-watch'),a=document.getElementById('cta-ask');if(w)w.href='/monitor.html?symbol='+encodeURIComponent(sym);if(a)a.href='/ask.html?q='+encodeURIComponent('What does this '+TOOL+' result mean for '+sym+'? Explain the numbers in plain words.');}}
	form.addEventListener('submit',async e=>{e.preventDefault();const symbol=symbolInput.value.trim().toUpperCase();if(!/^[A-Z0-9][A-Z0-9.\\-]{0,9}$/.test(symbol)){render({error:'Enter a valid ticker symbol.'});return;}result.innerHTML='<h2>Loading filed data…</h2>';try{const r=await fetch('/api/free-tools/'+encodeURIComponent(TOOL)+'?symbol='+encodeURIComponent(symbol),{headers:{Accept:'application/json'}});const data=await r.json();render(data);navigator.sendBeacon&&navigator.sendBeacon('/api/track/free_tool_complete',new Blob([JSON.stringify({toolId:CONTENT_ID,symbol,referrer:document.referrer})],{type:'application/json'}));}catch(_){render({error:'The tool is temporarily unavailable. Try again shortly.'});}});
	try{navigator.sendBeacon&&navigator.sendBeacon('/api/track/free_tool_view',new Blob([JSON.stringify({toolId:CONTENT_ID,path:location.pathname,referrer:document.referrer})],{type:'application/json'}));}catch(_){}</script></body></html>`;
}

// Shared renderer for the expanded catalog. It intentionally consumes the
// generic metrics/rows response shape so new deterministic calculators do not
// need bespoke client code or separate static pages.
function renderExpandedToolPage(tool) {
    const definition = TOOL_DEFINITIONS[tool];
    if (!definition) return '';
    const canonical = `https://www.stockportfolio.pro${definition.path}`;
    const contentId = definition.id;
    const ctaHref = `/go/appsumo/website?content_id=${encodeURIComponent(contentId)}`;
    const placeholder = definition.multi ? 'AAPL, MSFT' : (tool.startsWith('etf-') ? 'QQQ' : 'AAPL');
    const inputHelp = definition.multi ? 'Enter a company or fund name, then select a suggestion. Add up to ten symbols.' : 'Enter a stock, fund or company name and select a suggestion.';
    const searchTypes = tool.startsWith('etf-') ? ['etf', 'mutual_fund'] : ['stock'];
    const jsonld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebApplication', name: definition.heading, applicationCategory: 'FinanceApplication', operatingSystem: 'Web', url: canonical, description: definition.description, isAccessibleForFree: true });
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(definition.title)} — StockPortfolio.pro</title><meta name="description" content="${esc(definition.description)}"><link rel="canonical" href="${canonical}"><link rel="icon" type="image/png" sizes="48x48" href="/Media/icon.png?v=20260729-favicon1"><link rel="apple-touch-icon" href="/Media/icon.png?v=20260729-favicon1"><meta property="og:title" content="${esc(definition.title)}"><meta property="og:description" content="${esc(definition.description)}"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..750&display=swap"><link rel="stylesheet" href="/assets/system.css?v=20260830-noflow1"><script type="application/ld+json">${jsonld}</script><style>
main.tool-page{max-width:980px;margin:auto;padding:48px 32px 70px}.crumb,.note{font-size:var(--text-sm);color:var(--ink-3)}h1{font-size:clamp(34px,5vw,48px);line-height:1.06;font-weight:650;letter-spacing:-.035em;margin:24px 0 10px}.lead{font-size:17px;color:var(--ink-2);max-width:720px}.panel{background:var(--surface);border:1px solid var(--line);border-radius:var(--radius);padding:24px;margin:18px 0;overflow:auto}.form{display:flex;gap:10px;flex-wrap:wrap;overflow:visible}.tool-input-wrap{position:relative;min-width:230px;flex:1}.form input{width:100%;height:44px;border:1px solid var(--line-strong);border-radius:var(--radius-sm);padding:0 12px;font:inherit;text-transform:uppercase;background:var(--surface)}.form input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-tint)}.form button{height:44px;border:1px solid var(--ink);border-radius:var(--radius-sm);padding:0 18px;background:var(--ink);color:var(--paper);font:inherit;font-weight:600;cursor:pointer}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}.metric{border:1px solid var(--line);border-radius:var(--radius);padding:14px}.metric span{font-size:var(--text-xs);color:var(--ink-3);text-transform:uppercase;letter-spacing:.05em}.metric strong{display:block;font-size:21px;margin-top:4px;font-variant-numeric:tabular-nums}table{border-collapse:collapse;width:100%;margin-top:14px;font-variant-numeric:tabular-nums}th,td{text-align:left;border-bottom:1px solid var(--line);padding:10px 8px;vertical-align:top}th{font-size:var(--text-xs);text-transform:uppercase;letter-spacing:.05em;color:var(--ink-3);font-weight:600}.warn{background:var(--neg-tint);color:var(--neg);border:1px solid color-mix(in srgb,var(--neg) 18%,var(--line));padding:10px;border-radius:var(--radius-sm);margin-top:9px}.error{color:var(--neg)}.cta{background:var(--accent-tint);border-color:color-mix(in srgb,var(--accent) 18%,var(--line))}.cta-bridge{margin:8px 0 0}.cta-bridge a{font-weight:600}.tools{columns:3;column-gap:20px}.tools a{display:block;padding:8px 0;font-size:var(--text-sm)}.crumb a{display:inline-block;padding:8px 2px}@media(max-width:650px){main.tool-page{padding:32px 16px 56px}.tool-input-wrap,.form button{width:100%;flex-basis:100%}.tools{columns:2}th,td{font-size:12px}}@media(max-width:420px){.tools{columns:1}}
 </style></head><body><main class="tool-page"><div class="crumb"><a href="/">Home</a> / <a href="/tools">Free tools</a> / ${esc(definition.heading)}</div><h1>${esc(definition.heading)}</h1><p class="lead">${esc(definition.intro)}</p><section class="panel"><form id="form" class="form"><div class="tool-input-wrap"><input id="symbols" maxlength="120" placeholder="${placeholder}" aria-label="Stock, fund or company name" aria-autocomplete="list" aria-controls="tool-suggestions" autocomplete="off" required><div id="tool-suggestions" class="sym-ac" role="listbox" hidden></div></div><button type="submit">Run tool</button></form><p class="note">${inputHelp} No login or AI is used.</p></section><section id="result" class="panel"><h2 class="title-2">Ready</h2><p class="note">Results show reporting periods, refresh context, source links and limitations.</p></section><section id="contextual-cta" class="panel cta" hidden><strong>You just checked a real filing result.</strong><p>Continue with the complete source trail and research workflow.</p><p><a href="${ctaHref}" data-appsumo-campaign-link data-content-id="${esc(contentId)}" data-tool-id="${esc(contentId)}">Explore StockPortfolio.pro on AppSumo &rarr;</a></p><p class="cta-bridge"><a id="cta-watch" href="/monitor.html">Watch this company — get this check every time the filing changes &rarr;</a></p><p class="cta-bridge"><a id="cta-ask" href="/ask.html">Ask what this means in plain words &rarr;</a></p><p class="cta-bridge"><a href="/filing-changes">See what changed in the latest filings &rarr;</a></p></section><section class="panel"><strong>Methodology and limitations</strong><p class="note">Calculations use existing filed fundamentals or explicitly identified fund-profile data. Missing values stay missing. Period mismatches, split-sized changes and incomplete holdings coverage are labelled rather than estimated. These tools are informational and are not investment advice.</p><p><a href="/methodology">Read the full methodology &rarr;</a></p></section><section class="panel"><strong>All free research tools</strong><div class="tools">${Object.values(TOOL_DEFINITIONS).map((item) => `<a href="${item.path}">${esc(item.heading)}</a>`).join('')}</div></section></main><script src="/assets/app.js?v=20260830-noflow1"></script><script>
const TOOL=${JSON.stringify(tool)},CID=${JSON.stringify(contentId)},MULTI=${Boolean(definition.multi)},SEARCH_TYPES=${JSON.stringify(searchTypes)},form=document.getElementById('form'),input=document.getElementById('symbols'),suggestions=document.getElementById('tool-suggestions'),result=document.getElementById('result'),ctaPanel=document.getElementById('contextual-cta');
const E=v=>String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const label=k=>String(k).replace(/([a-z])([A-Z])/g,'$1 $2').replace(/_/g,' ').replace(/^./,c=>c.toUpperCase());
let matches=[],active=-1,searchSequence=0,searchTimer;
const currentQuery=()=>input.value.split(',').pop().trim();
function closeSuggestions(){matches=[];active=-1;suggestions.hidden=true;suggestions.innerHTML='';input.removeAttribute('aria-activedescendant');}
function renderSuggestions(){if(!matches.length){closeSuggestions();return;}suggestions.innerHTML=matches.map((row,index)=>'<button type="button" role="option" id="tool-option-'+index+'" data-index="'+index+'" aria-selected="'+(index===active)+'" class="'+(index===active?'is-active':'')+'"><span class="sym">'+E(row.symbol)+'</span><span class="nm">'+E(row.name||row.symbol)+(row.assetTypeLabel?' · '+E(row.assetTypeLabel):'')+'</span></button>').join('');suggestions.hidden=false;if(active>=0)input.setAttribute('aria-activedescendant','tool-option-'+active);else input.removeAttribute('aria-activedescendant');}
function choose(row){if(!row)return;if(MULTI){const parts=input.value.split(',');parts[parts.length-1]=row.symbol;input.value=parts.map(part=>part.trim()).filter(Boolean).join(', ')+(parts.filter(part=>part.trim()).length<10?', ':'');}else input.value=row.symbol;closeSuggestions();input.focus();}
async function findMatches(){const query=currentQuery();if(!query){closeSuggestions();return;}const sequence=++searchSequence;try{const rows=await V2.searchAssets(query,{limit:8,types:SEARCH_TYPES});if(sequence!==searchSequence)return;matches=rows;active=-1;renderSuggestions();}catch(_){if(sequence===searchSequence)closeSuggestions();}}
input.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(findMatches,120);});
input.addEventListener('keydown',event=>{if(event.key==='Escape'){closeSuggestions();return;}if(suggestions.hidden||!matches.length)return;if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();active=event.key==='ArrowDown'?(active+1)%matches.length:(active-1+matches.length)%matches.length;renderSuggestions();}else if(event.key==='Enter'&&active>=0){event.preventDefault();choose(matches[active]);}});
suggestions.addEventListener('mousedown',event=>{const button=event.target.closest('[data-index]');if(!button)return;event.preventDefault();choose(matches[Number(button.dataset.index)]);});
document.addEventListener('click',event=>{if(!event.target.closest('.tool-input-wrap'))closeSuggestions();});
async function resolveSymbols(){const parts=input.value.split(',').map(part=>part.trim()).filter(Boolean);const resolved=[];for(const part of parts){if(/^[A-Z0-9][A-Z0-9.\-]{0,9}$/i.test(part)){resolved.push(part.toUpperCase());continue;}const rows=await V2.searchAssets(part,{limit:1,types:SEARCH_TYPES});if(!rows.length)throw new Error('Choose a company or ticker from the suggestions.');resolved.push(rows[0].symbol.toUpperCase());}return resolved.join(',');}
function compact(v,prefix=''){const n=Number(v),a=Math.abs(n),f=(x,d)=>x.toLocaleString('en-US',{minimumFractionDigits:d,maximumFractionDigits:d});if(a>=1e9)return prefix+f(n/1e9,2)+'B';if(a>=1e6)return prefix+f(n/1e6,1)+'M';return prefix+n.toLocaleString('en-US',{maximumFractionDigits:2});}
function value(v,format){if(v==null||v==='')return '—';if(typeof v==='string')return E(v);const n=Number(v);if(!Number.isFinite(n))return E(v);if(format==='money')return compact(n,'$');if(format==='compact')return compact(n);if(format==='percent')return n.toLocaleString('en-US',{maximumFractionDigits:2})+'%';if(format==='ratio')return n.toLocaleString('en-US',{maximumFractionDigits:2})+'×';return n.toLocaleString('en-US',{maximumFractionDigits:2});}
function normalize(d){if(d.filings&&!d.rows)d.rows=d.filings;if(TOOL==='earnings-quality'&&!d.metrics)d.metrics=[['Revenue',d.revenue,'money'],['Net income',d.netIncome,'money'],['Operating cash flow',d.operatingCashFlow,'money'],['Free cash flow',d.freeCashFlow,'money'],['Cash conversion',d.cashConversionRatio,'ratio']].map(x=>({label:x[0],value:x[1],format:x[2]}));if(TOOL==='dilution'&&!d.rows){d.metrics=[{label:'Share-count change',value:d.change,format:'compact'},{label:'Percentage change',value:d.percentageChange,format:'percent'}];d.rows=[{period:d.latest&&d.latest.period,shares:d.latest&&d.latest.shares},{period:d.prior&&d.prior.period,shares:d.prior&&d.prior.shares}];}return d;}
function rowFormat(k,row){const s=k.toLowerCase();if(s.includes('pct')||s.includes('margin')||s.includes('weight'))return 'percent';if(s.includes('ratio')||s==='coverage')return 'ratio';if(s.includes('shares')||(s==='latest'||s==='prior')&&row.metric==='Shares outstanding')return 'compact';if((s==='latest'||s==='prior')&&row.metric)return 'money';if(/revenue|income|cash|debt|asset|liabilit|equity|goodwill|receivable|inventory|payable|capitalexpenditure|freecashflow|workingcapital|repurchase|dividend|compensation|latestvalue|priorvalue/.test(s))return 'money';return null;}
function render(raw){const d=normalize(raw);if(d.error){result.innerHTML='<h2 class="title-2 error">'+E(d.error)+'</h2>';return;}let h='<h2 class="title-2">'+E((d.symbol||(d.symbols||[]).join(', '))||'Result')+'</h2>';if(d.summary)h+='<p class="muted">'+E(d.summary)+'</p>';if(d.updatedAt||d.generatedAt)h+='<p class="note">Data refreshed/generated: '+E(d.updatedAt||d.generatedAt)+'</p>';if(d.sourceUrl)h+='<p><a href="'+E(d.sourceUrl)+'" target="_blank" rel="noopener nofollow">Open SEC source</a></p>';if((d.metrics||[]).length)h+='<div class="grid">'+d.metrics.map(m=>'<div class="metric"><span>'+E(m.label)+'</span><strong>'+value(m.value,m.format)+'</strong></div>').join('')+'</div>';const rows=d.rows||[];if(rows.length){const keys=[...new Set(rows.flatMap(r=>Object.keys(r)))].filter(k=>!k.startsWith('_'));h+='<div class="table-wrap"><table><thead><tr>'+keys.map(k=>'<th>'+E(label(k))+'</th>').join('')+'</tr></thead><tbody>'+rows.map(r=>'<tr>'+keys.map(k=>{const v=r[k];return '<td>'+(k==='url'&&v?'<a href="'+E(v)+'" target="_blank" rel="noopener nofollow">SEC source</a>':value(v,rowFormat(k,r)))+'</td>';}).join('')+'</tr>').join('')+'</tbody></table></div>';}h+=(d.warnings||[]).map(w=>'<div class="warn">'+E(w)+'</div>').join('');result.innerHTML=h;ctaPanel.hidden=false;const sym=String(d.symbol||(d.symbols||[])[0]||'').toUpperCase();if(sym){const w=document.getElementById('cta-watch'),a=document.getElementById('cta-ask');if(w)w.href='/monitor.html?symbol='+encodeURIComponent(sym);if(a)a.href='/ask.html?q='+encodeURIComponent('What does this '+TOOL+' result mean for '+sym+'? Explain the numbers in plain words.');}V2.attachHScroll&&V2.attachHScroll(result.querySelector('.table-wrap'));}
	form.addEventListener('submit',async e=>{e.preventDefault();closeSuggestions();ctaPanel.hidden=true;result.innerHTML='<h2 class="title-2">Loading filed data…</h2>';try{const symbols=await resolveSymbols();input.value=symbols.replace(/,/g,', ');const r=await fetch('/api/free-tools/'+encodeURIComponent(TOOL)+'?symbol='+encodeURIComponent(symbols));render(await r.json());if(r.ok&&navigator.sendBeacon)navigator.sendBeacon('/api/track/free_tool_complete',new Blob([JSON.stringify({toolId:CID,contentId:CID,symbol:symbols.split(',')[0].trim(),referrer:document.referrer})],{type:'application/json'}));}catch(error){render({error:error&&error.message==='Choose a company or ticker from the suggestions.'?error.message:'The tool is temporarily unavailable.'});}});try{navigator.sendBeacon&&navigator.sendBeacon('/api/track/free_tool_view',new Blob([JSON.stringify({toolId:CID,path:location.pathname,referrer:document.referrer})],{type:'application/json'}));}catch(_){}V2.nav('tools');V2.footer();</script></body></html>`;
}

function renderToolIndex() {
    const cards = Object.values(TOOL_DEFINITIONS).map((tool) => `<article class="card card-pad"><p class="label">Free research tool</p><h2 class="title-2"><a href="${tool.path}">${esc(tool.heading)}</a></h2><p class="muted small">${esc(tool.description)}</p><a class="tool-link" href="${tool.path}">Open tool &rarr;</a></article>`).join('');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>30 free SEC and portfolio research tools — StockPortfolio.pro</title><meta name="description" content="Thirty deterministic financial research tools for SEC filings, cash flow, dilution, portfolios, comparisons and ETFs."><link rel="canonical" href="https://www.stockportfolio.pro/tools"><link rel="icon" type="image/png" sizes="48x48" href="/Media/icon.png?v=20260729-favicon1"><link rel="apple-touch-icon" href="/Media/icon.png?v=20260729-favicon1"><link rel="preconnect" href="https://fonts.googleapis.com"><link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..750&display=swap"><link rel="stylesheet" href="/assets/system.css?v=20260830-noflow1"><style>main.tools-index{max-width:1180px;margin:auto;padding:64px 32px 80px}.tools-index .display{max-width:18ch}.tools-index p a{display:inline-block;padding:8px 2px}.tools-lead{color:var(--ink-2);font-size:17px;max-width:720px;margin-top:16px}.tool-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px;margin-top:36px}.tool-grid article{display:flex;flex-direction:column;min-height:210px}.tool-grid h2{margin:10px 0 8px}.tool-grid h2 a{display:inline-block;padding:5px 0}.tool-grid p.muted{flex:1}.tool-link{font-size:var(--text-sm);font-weight:600;margin-top:18px;display:inline-block;padding:8px 0}@media(max-width:650px){main.tools-index{padding:42px 16px 64px}}</style></head><body><main class="tools-index"><p class="label">Engineering as marketing</p><h1 class="display">30 free research tools.</h1><p class="tools-lead">Deterministic filing, accounting, portfolio and fund analysis. No login, no AI conclusions, and primary-source links wherever the underlying data permits.</p><div class="tool-grid">${cards}</div><p style="margin-top:32px"><a href="/methodology">Methodology and limitations &rarr;</a></p></main><script src="/assets/app.js?v=20260830-noflow1"></script><script>V2.nav('tools');V2.footer();</script></body></html>`;
}

module.exports = {
    TOOL_DEFINITIONS,
    normalizeSymbol,
    computeEarningsQuality,
    computeDilution,
    filingTimeline,
    getToolResult,
    renderToolPage: renderExpandedToolPage,
    renderToolIndex
};
