#!/usr/bin/env node
'use strict';
// Snapshot of famous non-SEC companies (listed outside the US, no 10-K/20-F), in USD.
//
//   node scripts/global-companies-snapshot.js [--out docs/global-companies]
//
// Source: Yahoo Finance (quotes, profile, statements via fundamentalsTimeSeries), read through
// the site's own field mapping in backend/yahoo-source.js and converted to USD by
// backend/fx-conversion.js: balance sheets at the period's closing rate, income and cash flow at
// the average of month-end rates over the period. Market data uses today's spot rate. These are
// NOT filing-verified figures; every company carries its official filing source for checking.
//
// yahoo-source.js turns dots into hyphens for US class shares (BRK.B -> BRK-B), which breaks
// exchange suffixes (MC.PA, 7974.T), so it is compiled here with the symbol passed through as is.

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');
const req = Module.createRequire(path.join(BACKEND, 'package.json'));

function loadYahooSource() {
    const file = path.join(BACKEND, 'yahoo-source.js');
    const src = fs.readFileSync(file, 'utf8');
    const patched = src.replace(/function toYahooSymbol\(symbol\) \{[^}]*\}/, 'function toYahooSymbol(symbol) { return String(symbol || \'\').toUpperCase(); }')
        + '\nmodule.exports.__builders = { buildOverview };\n';
    if (patched === src) throw new Error('toYahooSymbol not found in yahoo-source.js');
    const m = new Module(file, module);
    m.filename = file;
    m.paths = Module._nodeModulePaths(BACKEND);
    m._compile(patched, file);
    return m.exports;
}

const COMPANIES = [
    ['MC.PA', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['RMS.PA', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['OR.PA', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['AIR.PA', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['SU.PA', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['AI.PA', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['SAF.PA', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['KER.PA', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['SIE.DE', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['VOW3.DE', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['MBG.DE', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['BMW.DE', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['ALV.DE', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['DTE.DE', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['ADS.DE', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['BAYN.DE', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['BAS.DE', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['IFX.DE', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['ITX.MC', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['IBE.MC', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['UCG.MI', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['HEIA.AS', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['ADYEN.AS', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['MAERSK-B.CO', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['VOLV-B.ST', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['HM-B.ST', 'EU ESEF iXBRL', 'https://filings.xbrl.org/'],
    ['RR.L', 'UK FCA NSM iXBRL', 'https://data.fca.org.uk/#/nsm/nationalstoragemechanism'],
    ['GLEN.L', 'UK FCA NSM iXBRL', 'https://data.fca.org.uk/#/nsm/nationalstoragemechanism'],
    ['7974.T', 'Japan EDINET (XBRL API)', 'https://disclosure2.edinet-fsa.go.jp/'],
    ['6861.T', 'Japan EDINET (XBRL API)', 'https://disclosure2.edinet-fsa.go.jp/'],
    ['8035.T', 'Japan EDINET (XBRL API)', 'https://disclosure2.edinet-fsa.go.jp/'],
    ['9984.T', 'Japan EDINET (XBRL API)', 'https://disclosure2.edinet-fsa.go.jp/'],
    ['6501.T', 'Japan EDINET (XBRL API)', 'https://disclosure2.edinet-fsa.go.jp/'],
    ['9983.T', 'Japan EDINET (XBRL API)', 'https://disclosure2.edinet-fsa.go.jp/'],
    ['005930.KS', 'Korea OpenDART API', 'https://opendart.fss.or.kr/'],
    ['000660.KS', 'Korea OpenDART API', 'https://opendart.fss.or.kr/'],
    ['005380.KS', 'Korea OpenDART API', 'https://opendart.fss.or.kr/'],
    ['RELIANCE.NS', 'NSE India XBRL results', 'https://www.nseindia.com/companies-listing/corporate-filings-financial-results'],
    ['TCS.NS', 'NSE India XBRL results', 'https://www.nseindia.com/companies-listing/corporate-filings-financial-results'],
    ['NESN.SW', 'Annual report PDF', 'https://www.nestle.com/investors'],
    ['RO.SW', 'Annual report PDF', 'https://www.roche.com/investors'],
    ['ABBN.SW', 'Annual report PDF', 'https://global.abb/group/en/investors'],
    ['CFR.SW', 'Annual report PDF', 'https://www.richemont.com/investors/'],
    ['ZURN.SW', 'Annual report PDF', 'https://www.zurich.com/investor-relations'],
    ['0700.HK', 'HKEXnews annual report PDF', 'https://www.hkexnews.hk/'],
    ['1810.HK', 'HKEXnews annual report PDF', 'https://www.hkexnews.hk/'],
    ['1211.HK', 'HKEXnews annual report PDF', 'https://www.hkexnews.hk/'],
    ['600519.SS', 'SSE annual report PDF', 'https://www.sse.com.cn/'],
    ['2222.SR', 'Annual report PDF', 'https://www.aramco.com/en/investors'],
    ['2317.TW', 'Taiwan MOPS', 'https://mops.twse.com.tw/'],
];

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const sum = (rows, k) => { const v = rows.map((r) => num(r[k])); return v.length && v.every((x) => x !== null) ? v.reduce((a, b) => a + b, 0) : null; };
const ratio = (a, b) => (a !== null && b !== null && b !== 0 ? a / b : null);

// Pence-quoted London lines (GBp) and other minor units are 1/100 of the major currency.
function quoteUnit(cur) {
    if (cur === 'GBp' || cur === 'GBX') return { code: 'GBP', scale: 0.01 };
    if (cur === 'ILA') return { code: 'ILS', scale: 0.01 };
    if (cur === 'ZAc') return { code: 'ZAR', scale: 0.01 };
    return { code: String(cur || 'USD').toUpperCase(), scale: 1 };
}

async function spot(yf, code) {
    if (code === 'USD') return 1;
    const q = await yf.quote(`${code}USD=X`, { fields: ['regularMarketPrice'] });
    const r = num(q && q.regularMarketPrice);
    if (!r) throw new Error(`no ${code}/USD spot`);
    return r;
}

function pickIncome(r) {
    return r && {
        fiscalDateEnding: r.fiscalDateEnding,
        revenue: num(r.totalRevenue), grossProfit: num(r.grossProfit), operatingIncome: num(r.operatingIncome),
        ebitda: num(r.ebitda), netIncome: num(r.netIncome), dilutedEPS: num(r.dilutedEPS),
        researchAndDevelopment: num(r.researchAndDevelopment),
    };
}
function pickBalance(r) {
    return r && {
        fiscalDateEnding: r.fiscalDateEnding,
        totalAssets: num(r.totalAssets), totalLiabilities: num(r.totalLiabilities), equity: num(r.totalShareholderEquity),
        cash: num(r.cashAndShortTermInvestments ?? r.cashAndCashEquivalentsAtCarryingValue),
        totalDebt: num(r.shortLongTermDebtTotal), sharesOutstanding: num(r.commonStockSharesOutstanding),
    };
}
function pickCash(r) {
    const ocf = r && num(r.operatingCashflow), capex = r && num(r.capitalExpenditures);
    return r && {
        fiscalDateEnding: r.fiscalDateEnding,
        operatingCashFlow: ocf, capex, freeCashFlow: ocf !== null && capex !== null ? ocf + capex : null,
        dividendsPaid: num(r.dividendPayout), buybacks: num(r.paymentsForRepurchaseOfCommonStock),
    };
}

async function one(ys, fx, yf, symbol, filingSource, filingUrl) {
    const summary = await yf.quoteSummary(symbol, { modules: ['assetProfile', 'price', 'summaryDetail', 'defaultKeyStatistics', 'financialData'] });
    const ov = ys.__builders.buildOverview(symbol, summary);
    const [inc, bal, cash] = await Promise.all([ys.fetchIncomeStatement(symbol), ys.fetchBalanceSheet(symbol), ys.fetchCashFlow(symbol)]);
    const reportingCurrency = (summary.financialData && summary.financialData.financialCurrency) || ov.Currency;
    const raw = {
        income: { annualReports: inc.annualReports, quarterlyReports: inc.quarterlyReports },
        balance: { annualReports: bal.annualReports, quarterlyReports: bal.quarterlyReports },
        cash: { annualReports: cash.annualReports, quarterlyReports: cash.quarterlyReports },
    };
    const usd = reportingCurrency === 'USD' ? raw : fx.convertPayloadWithSeries(raw, await fx.rateSeries(reportingCurrency), reportingCurrency);

    const qu = quoteUnit((summary.price && summary.price.currency) || ov.Currency);
    const toUsd = (await spot(yf, qu.code)) * qu.scale;
    const price = num(summary.price && summary.price.regularMarketPrice);
    const capUsd = num(ov.MarketCapitalization) !== null ? num(ov.MarketCapitalization) * (qu.code === 'GBP' ? 1 : qu.scale) * (toUsd / qu.scale) : null;

    const incA = usd.income.annualReports.map(pickIncome), balA = usd.balance.annualReports.map(pickBalance), cashA = usd.cash.annualReports.map(pickCash);
    const incQ = usd.income.quarterlyReports.map(pickIncome);
    const fy = incA[0] || null, fyBal = balA.find((b) => fy && b.fiscalDateEnding === fy.fiscalDateEnding) || balA[0] || null;
    const fyCash = cashA.find((c) => fy && c.fiscalDateEnding === fy.fiscalDateEnding) || cashA[0] || null;
    // trailing twelve months from the last four quarters, when all four are there and newer than the year
    const q4 = incQ.slice(0, 4);
    const ttmNet = q4.length === 4 && fy && q4[0].fiscalDateEnding > fy.fiscalDateEnding ? sum(q4, 'netIncome') : null;
    const ttmRev = q4.length === 4 && fy && q4[0].fiscalDateEnding > fy.fiscalDateEnding ? sum(q4, 'revenue') : null;
    const earnings = ttmNet ?? (fy && fy.netIncome), sales = ttmRev ?? (fy && fy.revenue);
    const oldest = incA.filter((r) => r.revenue).slice(-1)[0];
    const years = fy && oldest ? (Date.parse(fy.fiscalDateEnding) - Date.parse(oldest.fiscalDateEnding)) / (365.25 * 864e5) : 0;
    const ap = summary.assetProfile || {};

    return {
        symbol, name: ov.Name, exchange: (summary.price && summary.price.exchangeName) || ov.Exchange,
        country: ap.country || null, sector: ap.sector || null, industry: ap.industry || null,
        employees: num(ap.fullTimeEmployees), website: ap.website || null,
        description: (ap.longBusinessSummary || '').split(/(?<=\.)\s/).slice(0, 2).join(' '),
        quoteCurrency: qu.code, reportingCurrency, filingSource, filingUrl,
        market: {
            asOf: new Date().toISOString().slice(0, 10), fxToUsd: toUsd / qu.scale,
            priceLocal: price, priceUsd: price !== null ? price * toUsd : null,
            marketCapUsd: capUsd,
            week52HighUsd: num(ov['52WeekHigh']) !== null ? num(ov['52WeekHigh']) * toUsd : null,
            week52LowUsd: num(ov['52WeekLow']) !== null ? num(ov['52WeekLow']) * toUsd : null,
            dividendYield: num(ov.DividendYield), beta: num(ov.Beta),
        },
        valuation: {
            earningsBasis: ttmNet !== null ? 'TTM (last 4 quarters)' : 'latest fiscal year',
            pe: earnings > 0 ? ratio(capUsd, earnings) : null,
            ps: ratio(capUsd, sales),
            pb: fyBal && fyBal.equity > 0 ? ratio(capUsd, fyBal.equity) : null,
            evToEbitda: fy && fy.ebitda > 0 && fyBal && capUsd !== null ? (capUsd + (fyBal.totalDebt || 0) - (fyBal.cash || 0)) / fy.ebitda : null,
            fcfYield: fyCash && fyCash.freeCashFlow !== null ? ratio(fyCash.freeCashFlow, capUsd) : null,
        },
        latestYear: fy && {
            ...fy, ...(fyBal || {}), ...(fyCash || {}), fiscalDateEnding: fy.fiscalDateEnding,
            grossMargin: ratio(fy.grossProfit, fy.revenue), operatingMargin: ratio(fy.operatingIncome, fy.revenue),
            netMargin: ratio(fy.netIncome, fy.revenue), roe: fyBal && fyBal.equity > 0 ? ratio(fy.netIncome, fyBal.equity) : null,
            revenueGrowth: incA[1] && incA[1].revenue ? fy.revenue / incA[1].revenue - 1 : null,
            revenueCagr: years >= 2 && oldest.revenue > 0 && fy.revenue > 0 ? Math.pow(fy.revenue / oldest.revenue, 1 / years) - 1 : null,
            revenueCagrYears: years >= 2 ? Math.round(years) : null,
        },
        annual: { income: incA, balance: balA, cash: cashA },
        quarterly: { income: incQ.slice(0, 8) },
        usdConversion: usd.currencyConversion || { from: 'USD', to: 'USD' },
    };
}

(async () => {
    const outDir = path.join(ROOT, process.argv.includes('--out') ? process.argv[process.argv.indexOf('--out') + 1] : 'docs/global-companies');
    const ys = loadYahooSource();
    const fx = req('./fx-conversion');
    const YF = req('yahoo-finance2').default;
    const yf = new YF({ suppressNotices: ['yahooSurvey', 'ripHistorical'], validation: { logErrors: false, logOptionsErrors: false } });
    const out = [], failed = [];
    for (const [symbol, src, url] of COMPANIES) {
        let row = null;
        for (let attempt = 1; attempt <= 3 && !row; attempt++) {
            try { row = await one(ys, fx, yf, symbol, src, url); } catch (e) { if (attempt === 3) failed.push(`${symbol}: ${e.message}`); }
        }
        if (row) { out.push(row); process.stderr.write(`${symbol.padEnd(12)} ${row.name.slice(0, 40).padEnd(40)} ${row.reportingCurrency} FY ${row.latestYear ? row.latestYear.fiscalDateEnding : '—'}\n`); }
    }
    fs.mkdirSync(outDir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.writeFileSync(path.join(outDir, `snapshot-${day}.json`), JSON.stringify({ generatedAt: new Date().toISOString(), source: 'Yahoo Finance via backend/yahoo-source.js; USD via backend/fx-conversion.js', companies: out, failed }, null, 1));
    const cols = ['symbol', 'name', 'country', 'sector', 'industry', 'employees', 'reportingCurrency', 'filingSource',
        ['market', 'priceUsd'], ['market', 'marketCapUsd'], ['market', 'dividendYield'], ['valuation', 'pe'], ['valuation', 'ps'], ['valuation', 'pb'], ['valuation', 'evToEbitda'], ['valuation', 'fcfYield'],
        ['latestYear', 'fiscalDateEnding'], ['latestYear', 'revenue'], ['latestYear', 'grossProfit'], ['latestYear', 'operatingIncome'], ['latestYear', 'netIncome'], ['latestYear', 'ebitda'],
        ['latestYear', 'operatingCashFlow'], ['latestYear', 'capex'], ['latestYear', 'freeCashFlow'], ['latestYear', 'totalAssets'], ['latestYear', 'totalLiabilities'], ['latestYear', 'equity'],
        ['latestYear', 'cash'], ['latestYear', 'totalDebt'], ['latestYear', 'grossMargin'], ['latestYear', 'operatingMargin'], ['latestYear', 'netMargin'], ['latestYear', 'roe'],
        ['latestYear', 'revenueGrowth'], ['latestYear', 'revenueCagr'], ['latestYear', 'revenueCagrYears']];
    const cell = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const csv = [cols.map((c) => (Array.isArray(c) ? c[1] : c)).join(',')]
        .concat(out.map((r) => cols.map((c) => cell(Array.isArray(c) ? (r[c[0]] || {})[c[1]] : r[c])).join(','))).join('\n');
    fs.writeFileSync(path.join(outDir, `snapshot-${day}.csv`), csv + '\n');
    console.log(`wrote ${out.length} companies to ${path.relative(ROOT, outDir)}; failed: ${failed.length ? failed.join(' | ') : 'none'}`);
})();
