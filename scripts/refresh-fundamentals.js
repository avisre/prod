#!/usr/bin/env node
/**
 * refresh-fundamentals.js
 *
 * Pulls fundamentals for a configurable list of symbols from Yahoo Finance
 * via yahoo-finance2 and writes one JSON file per symbol shaped to match
 * what /api/alpha/fundamentals/:symbol returns from Alpha Vantage. The
 * frontend's existing local-cache reader (fetchTopSheetFundamentals)
 * consumes these files unchanged.
 *
 * Why Yahoo for the nightly batch: no per-minute rate limit for our
 * volume, much faster total runtime than Alpha. Live runtime price data
 * still flows through Alpha via /api/alpha/quote/:symbol — this script
 * deliberately omits the quote field so the cached payload doesn't
 * carry a stale price.
 *
 * Usage:
 *   node scripts/refresh-fundamentals.js [symbol-list.json]
 *
 * SEC EDGAR extension: after the Yahoo pull, each US symbol's statements
 * are extended from SEC XBRL companyFacts — annual history grows from
 * Yahoo's ~4 years to 15+, and quarterly reports (which Yahoo's
 * quoteSummary doesn't give us at all) are synthesized back ~12 years.
 *
 * Env vars:
 *   MAX_SYMBOLS=20       Cap symbols processed (0 = no cap)
 *   HISTORY_DEPTH=full   Pull full daily history (default ~6 months)
 *   CONCURRENCY=5        Parallel Yahoo requests (default 5)
 *   SEC_EXTEND=0         Skip the SEC EDGAR extension (default on)
 *   WRITE_INDEX=0        Skip rewriting the index file (for partial runs)
 */

const fs = require('fs');
const path = require('path');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance();
const secSource = require(path.join(__dirname, '..', 'backend', 'sec-source'));

const SEC_EXTEND = String(process.env.SEC_EXTEND || '1') !== '0';
const WRITE_INDEX = String(process.env.WRITE_INDEX || '1') !== '0';

const ROOT = path.resolve(__dirname, '..');
const FRONTEND_DATA = path.join(ROOT, 'frontend', 'data');
const OUT_DIR = path.join(FRONTEND_DATA, 'fundamentals');
const INDEX_FILE = path.join(FRONTEND_DATA, 'top-100-fundamentals-index.json');
const DEFAULT_LISTS = [
  path.join(FRONTEND_DATA, 'sp1500-companies.json'),
  path.join(FRONTEND_DATA, 'sp500-companies.json'),
  path.join(FRONTEND_DATA, 'top-100-companies.json')
];

const MAX_SYMBOLS = Number(process.env.MAX_SYMBOLS || 0);
const HISTORY_DEPTH = String(process.env.HISTORY_DEPTH || 'compact').toLowerCase();
const CONCURRENCY = Math.max(1, Math.min(10, Number(process.env.CONCURRENCY || 5)));

// ---- Helpers ----

function isoDate(d) {
  if (!d) return null;
  const date = d instanceof Date ? d : new Date(d * 1000); // yahoo returns unix seconds
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

// Numeric values come unwrapped from yahoo-finance2 (just the number).
// Some statement fields can be missing — return '' for those (matches the
// Alpha shape which uses empty strings for missing values).
function n(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && 'raw' in value) value = value.raw;
  return Number.isFinite(value) ? String(value) : '';
}

// ---- Yahoo → Alpha shape translators ----

function buildOverview(symbol, summary) {
  const ap = summary?.assetProfile || {};
  const sd = summary?.summaryDetail || {};
  const ks = summary?.defaultKeyStatistics || {};
  const fd = summary?.financialData || {};
  return {
    Symbol: symbol,
    Name: ap.longName || summary?.price?.longName || summary?.price?.shortName || symbol,
    Description: ap.longBusinessSummary || '',
    CIK: '',
    Exchange: ap.exchange || summary?.price?.exchangeName || '',
    Currency: sd.currency || summary?.price?.currency || 'USD',
    Country: ap.country || 'USA',
    Sector: ap.sector || '',
    Industry: ap.industry || '',
    Address: [ap.address1, ap.city, ap.state, ap.zip, ap.country].filter(Boolean).join(', '),
    FiscalYearEnd: '',
    LatestQuarter: '',
    MarketCapitalization: n(sd.marketCap),
    EBITDA: n(fd.ebitda),
    PERatio: n(sd.trailingPE),
    PEGRatio: n(ks.pegRatio),
    BookValue: n(ks.bookValue),
    DividendPerShare: n(sd.dividendRate),
    DividendYield: n(sd.dividendYield),
    EPS: n(ks.trailingEps),
    RevenuePerShareTTM: n(fd.revenuePerShare),
    ProfitMargin: n(ks.profitMargins ?? fd.profitMargins),
    OperatingMarginTTM: n(ks.operatingMargins ?? fd.operatingMargins),
    ReturnOnAssetsTTM: n(ks.returnOnAssets ?? fd.returnOnAssets),
    ReturnOnEquityTTM: n(ks.returnOnEquity ?? fd.returnOnEquity),
    RevenueTTM: n(fd.totalRevenue),
    GrossProfitTTM: n(fd.grossProfits),
    DilutedEPSTTM: n(ks.trailingEps),
    QuarterlyEarningsGrowthYOY: n(ks.earningsQuarterlyGrowth),
    QuarterlyRevenueGrowthYOY: n(fd.revenueGrowth),
    AnalystTargetPrice: n(fd.targetMeanPrice),
    TrailingPE: n(sd.trailingPE),
    ForwardPE: n(sd.forwardPE),
    PriceToSalesRatioTTM: n(sd.priceToSalesTrailing12Months),
    PriceToBookRatio: n(ks.priceToBook),
    EVToRevenue: n(ks.enterpriseToRevenue),
    EVToEBITDA: n(ks.enterpriseToEbitda),
    Beta: n(ks.beta),
    '52WeekHigh': n(sd.fiftyTwoWeekHigh),
    '52WeekLow': n(sd.fiftyTwoWeekLow),
    '50DayMovingAverage': n(sd.fiftyDayAverage),
    '200DayMovingAverage': n(sd.twoHundredDayAverage),
    SharesOutstanding: n(ks.sharesOutstanding),
    // Next expected ex/pay dates from summaryDetail when Yahoo reports them;
    // left blank when it does not (pay dates in particular are often absent).
    DividendDate: isoDate(sd.dividendDate) || '',
    ExDividendDate: isoDate(sd.exDividendDate) || '',
    DebtToEquity: n(fd.debtToEquity)
  };
}

function buildIncomeReports(history) {
  const list = history?.incomeStatementHistory || [];
  return list.map((r) => ({
    fiscalDateEnding: isoDate(r.endDate) || '',
    reportedCurrency: 'USD',
    grossProfit: n(r.grossProfit),
    totalRevenue: n(r.totalRevenue),
    costOfRevenue: n(r.costOfRevenue),
    costofGoodsAndServicesSold: n(r.costOfRevenue),
    operatingIncome: n(r.operatingIncome),
    sellingGeneralAndAdministrative: n(r.sellingGeneralAdministrative),
    researchAndDevelopment: n(r.researchDevelopment),
    operatingExpenses: n(r.totalOperatingExpenses),
    investmentIncomeNet: '',
    netInterestIncome: '',
    interestIncome: '',
    interestExpense: n(r.interestExpense),
    nonInterestIncome: '',
    otherNonOperatingIncome: n(r.totalOtherIncomeExpenseNet),
    depreciation: '',
    depreciationAndAmortization: '',
    incomeBeforeTax: n(r.incomeBeforeTax),
    incomeTaxExpense: n(r.incomeTaxExpense),
    interestAndDebtExpense: n(r.interestExpense),
    netIncomeFromContinuingOperations: n(r.netIncomeFromContinuingOps),
    comprehensiveIncomeNetOfTax: '',
    ebit: n(r.ebit),
    ebitda: '',
    netIncome: n(r.netIncome),
    eps: '',
    dilutedEPS: ''
  }));
}

function buildBalanceReports(history) {
  const list = history?.balanceSheetStatements || [];
  return list.map((r) => ({
    fiscalDateEnding: isoDate(r.endDate) || '',
    reportedCurrency: 'USD',
    totalAssets: n(r.totalAssets),
    totalCurrentAssets: n(r.totalCurrentAssets),
    cashAndCashEquivalentsAtCarryingValue: n(r.cash),
    cashAndShortTermInvestments: n(r.shortTermInvestments != null && r.cash != null ? (r.cash + r.shortTermInvestments) : r.cash),
    inventory: n(r.inventory),
    currentNetReceivables: n(r.netReceivables),
    totalNonCurrentAssets: '',
    propertyPlantEquipment: n(r.propertyPlantEquipment),
    accumulatedDepreciationAmortizationPPE: '',
    intangibleAssets: n(r.intangibleAssets),
    intangibleAssetsExcludingGoodwill: '',
    goodwill: n(r.goodWill),
    investments: '',
    longTermInvestments: n(r.longTermInvestments),
    shortTermInvestments: n(r.shortTermInvestments),
    otherCurrentAssets: n(r.otherCurrentAssets),
    otherNonCurrentAssets: n(r.otherAssets),
    totalLiabilities: n(r.totalLiab),
    totalCurrentLiabilities: n(r.totalCurrentLiabilities),
    currentAccountsPayable: n(r.accountsPayable),
    deferredRevenue: '',
    currentDebt: n(r.shortLongTermDebt),
    shortTermDebt: n(r.shortLongTermDebt),
    totalNonCurrentLiabilities: '',
    capitalLeaseObligations: '',
    longTermDebt: n(r.longTermDebt),
    currentLongTermDebt: n(r.shortLongTermDebt),
    longTermDebtNoncurrent: n(r.longTermDebt),
    shortLongTermDebtTotal: n((r.shortLongTermDebt || 0) + (r.longTermDebt || 0)),
    otherCurrentLiabilities: n(r.otherCurrentLiab),
    otherNonCurrentLiabilities: n(r.otherLiab),
    totalShareholderEquity: n(r.totalStockholderEquity),
    treasuryStock: n(r.treasuryStock),
    retainedEarnings: n(r.retainedEarnings),
    commonStock: n(r.commonStock),
    commonStockSharesOutstanding: n(r.commonStockSharesOutstanding)
  }));
}

function buildCashReports(history) {
  const list = history?.cashflowStatements || [];
  return list.map((r) => ({
    fiscalDateEnding: isoDate(r.endDate) || '',
    reportedCurrency: 'USD',
    operatingCashflow: n(r.totalCashFromOperatingActivities),
    paymentsForOperatingActivities: '',
    proceedsFromOperatingActivities: '',
    changeInOperatingLiabilities: '',
    changeInOperatingAssets: '',
    depreciationDepletionAndAmortization: n(r.depreciation),
    capitalExpenditures: n(r.capitalExpenditures != null ? -Math.abs(r.capitalExpenditures) : null),
    changeInReceivables: n(r.changeToAccountReceivables),
    changeInInventory: n(r.changeToInventory),
    profitLoss: n(r.netIncome),
    cashflowFromInvestment: n(r.totalCashflowsFromInvestingActivities),
    cashflowFromFinancing: n(r.totalCashFromFinancingActivities),
    proceedsFromRepaymentsOfShortTermDebt: '',
    paymentsForRepurchaseOfCommonStock: n(r.repurchaseOfStock),
    paymentsForRepurchaseOfEquity: '',
    paymentsForRepurchaseOfPreferredStock: '',
    dividendPayout: n(r.dividendsPaid != null ? -Math.abs(r.dividendsPaid) : null),
    dividendPayoutCommonStock: n(r.dividendsPaid != null ? -Math.abs(r.dividendsPaid) : null),
    dividendPayoutPreferredStock: '',
    proceedsFromIssuanceOfCommonStock: n(r.issuanceOfStock),
    proceedsFromIssuanceOfLongTermDebtAndCapitalSecuritiesNet: '',
    proceedsFromIssuanceOfPreferredStock: '',
    proceedsFromRepurchaseOfEquity: '',
    proceedsFromSaleOfTreasuryStock: '',
    changeInCashAndCashEquivalents: n(r.changeInCash),
    changeInExchangeRate: n(r.effectOfExchangeRate),
    netIncome: n(r.netIncome)
  }));
}

function buildDailyTimeSeries(chart) {
  // chart() returns { quotes: [{date, open, high, low, close, adjclose, volume}] }
  const quotes = chart?.quotes || [];
  const series = {};
  for (const q of quotes) {
    if (!q || !q.date) continue;
    const day = (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10);
    series[day] = {
      '1. open': n(q.open),
      '2. high': n(q.high),
      '3. low': n(q.low),
      '4. close': n(q.close),
      '5. adjusted close': n(q.adjclose ?? q.close),
      '6. volume': n(q.volume),
      '7. dividend amount': '0.0000',
      '8. split coefficient': '1.0'
    };
  }
  return {
    'Meta Data': {
      '1. Information': 'Daily Time Series (sourced via Yahoo Finance, shaped like Alpha Vantage)',
      '2. Symbol': chart?.meta?.symbol || '',
      '3. Last Refreshed': Object.keys(series).sort().pop() || '',
      '4. Output Size': HISTORY_DEPTH === 'full' ? 'Full size' : 'Compact'
    },
    'Time Series (Daily)': series
  };
}

function buildMonthlyTimeSeries(chart) {
  const quotes = chart?.quotes || [];
  const series = {};
  for (const q of quotes) {
    if (!q || !q.date) continue;
    const day = (q.date instanceof Date ? q.date : new Date(q.date)).toISOString().slice(0, 10);
    series[day] = {
      '1. open': n(q.open),
      '2. high': n(q.high),
      '3. low': n(q.low),
      '4. close': n(q.close),
      '5. adjusted close': n(q.adjclose ?? q.close),
      '6. volume': n(q.volume),
      '7. dividend amount': '0.0000'
    };
  }
  return {
    'Meta Data': {
      '1. Information': 'Monthly Adjusted Time Series (sourced via Yahoo Finance, shaped like Alpha Vantage)',
      '2. Symbol': chart?.meta?.symbol || ''
    },
    'Monthly Adjusted Time Series': series
  };
}

// Historical cash dividend ex-dates/amounts from the chart dividend events.
// Oldest-first; an empty array for non-payers. Stored as plain numbers so the
// dividend-history page never has to string-parse them.
function buildDividendHistory(chart) {
  return ((chart?.events?.dividends) || [])
    .map((d) => {
      const amount = typeof d.amount === 'number' ? d.amount : Number(d.amount);
      const day = d.date instanceof Date ? d.date : new Date(d.date);
      const date = Number.isNaN(day.getTime()) ? '' : day.toISOString().slice(0, 10);
      return { exDate: date, amount: Number.isFinite(amount) ? amount : null };
    })
    .filter((d) => d.exDate && d.amount !== null)
    .sort((a, b) => a.exDate.localeCompare(b.exDate));
}

// ---- Per-symbol fetch ----

// Yahoo uses hyphens for class-share tickers (BRK-B, BF-B) where most
// other data feeds use dots (BRK.B, BF.B). Translate before querying.
function toYahooSymbol(symbol) {
  return symbol.replace(/\./g, '-');
}

async function fetchSymbol(symbol) {
  const result = { overview: null, daily: null, monthly: null, income: null, balance: null, cash: null };
  const errors = [];
  const yahooSymbol = toYahooSymbol(symbol);

  const now = new Date();
  const dailyStart = new Date(now);
  if (HISTORY_DEPTH === 'full') dailyStart.setFullYear(now.getFullYear() - 20);
  else dailyStart.setDate(now.getDate() - 200);
  const monthlyStart = new Date(now); monthlyStart.setFullYear(now.getFullYear() - 20);

  // Quote summary modules: profile + ratios + statements
  const modules = [
    'assetProfile',
    'price',
    'summaryDetail',
    'defaultKeyStatistics',
    'financialData',
    'incomeStatementHistory',
    'balanceSheetHistory',
    'cashflowStatementHistory'
  ];

  try {
    const nowSec = Math.floor(now.getTime() / 1000);
    const [summary, dailyChart, monthlyChart, dividendChart] = await Promise.allSettled([
      yahooFinance.quoteSummary(yahooSymbol, { modules }),
      yahooFinance.chart(yahooSymbol, { period1: dailyStart, period2: now, interval: '1d' }),
      yahooFinance.chart(yahooSymbol, { period1: monthlyStart, period2: now, interval: '1mo' }),
      yahooFinance.chart(yahooSymbol, { period1: nowSec - 15 * 365 * 86400, period2: nowSec, interval: '1mo', events: 'div' })
    ]);

    if (summary.status === 'fulfilled' && summary.value) {
      result.overview = buildOverview(symbol, summary.value);
      result.income = { annualReports: buildIncomeReports(summary.value.incomeStatementHistory), quarterlyReports: [] };
      result.balance = { annualReports: buildBalanceReports(summary.value.balanceSheetHistory), quarterlyReports: [] };
      result.cash = { annualReports: buildCashReports(summary.value.cashflowStatementHistory), quarterlyReports: [] };
    } else errors.push('quoteSummary');

    if (dailyChart.status === 'fulfilled' && dailyChart.value) result.daily = buildDailyTimeSeries(dailyChart.value);
    else errors.push('chart-daily');

    if (monthlyChart.status === 'fulfilled' && monthlyChart.value) result.monthly = buildMonthlyTimeSeries(monthlyChart.value);
    else errors.push('chart-monthly');

    if (dividendChart.status === 'fulfilled' && dividendChart.value) {
      result.dividends = { history: buildDividendHistory(dividendChart.value) };
    } else errors.push('chart-dividends');
  } catch (err) {
    errors.push('exception:' + (err.message || 'unknown'));
  }

  return { result, errors };
}

// ---- Concurrency-limited runner ----

async function runWithConcurrency(items, worker, concurrency) {
  let idx = 0;
  let done = 0;
  const start = Date.now();
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (idx < items.length) {
      const i = idx++;
      await worker(items[i], i);
      done++;
      if (done % 25 === 0) {
        const elapsed = (Date.now() - start) / 1000;
        const rate = done / elapsed;
        const eta = Math.round((items.length - done) / rate);
        console.log(`  progress: ${done}/${items.length} (${rate.toFixed(1)}/s, eta ${eta}s)`);
      }
    }
  }));
}

// ---- IO ----

function loadSymbolList(explicitPath) {
  const candidates = explicitPath ? [path.resolve(explicitPath)] : DEFAULT_LISTS;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, 'utf8'));
      const list = Array.isArray(raw) ? raw : (Array.isArray(raw.companies) ? raw.companies : []);
      return { path: p, list };
    }
  }
  throw new Error(`No symbol list found. Tried: ${candidates.join(', ')}`);
}

async function main() {
  const explicit = process.argv[2];
  const { path: listPath, list } = loadSymbolList(explicit);
  console.log(`Loaded ${list.length} symbols from ${path.relative(ROOT, listPath)}`);
  console.log(`HISTORY_DEPTH=${HISTORY_DEPTH}  CONCURRENCY=${CONCURRENCY}  MAX_SYMBOLS=${MAX_SYMBOLS || 'all'}`);

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });

  const limit = MAX_SYMBOLS > 0 ? Math.min(MAX_SYMBOLS, list.length) : list.length;
  const items = list.slice(0, limit);
  const indexFiles = [];
  let wrote = 0;
  let skipped = 0;
  const errorList = [];
  const start = Date.now();

  await runWithConcurrency(items, async (entry, i) => {
    const symbol = String(entry?.symbol || '').toUpperCase();
    if (!symbol) return;
    const file = path.join(OUT_DIR, `${symbol.replace(/[^A-Z0-9]/g, '_')}.json`);

    let attempt = 0;
    let result; let errors;
    while (attempt < 2) {
      ({ result, errors } = await fetchSymbol(symbol));
      const haveAny = !!(result.overview || result.daily || result.monthly || result.income);
      if (haveAny) break;
      attempt++;
      await new Promise((r) => setTimeout(r, 500));
    }

    const haveAny = !!(result.overview || result.daily || result.monthly || result.income);
    if (!haveAny) {
      skipped++;
      errorList.push({ symbol, errors });
      console.log(`[${i + 1}/${limit}] ${symbol.padEnd(7)} SKIP (${errors.join(',')})`);
      indexFiles.push({ symbol, file: `data/fundamentals/${path.basename(file)}` });
      return;
    }

    const payload = {};
    if (result.overview) payload.overview = result.overview;
    if (result.daily) payload.daily = result.daily;
    if (result.monthly) payload.monthly = result.monthly;
    if (result.income) payload.income = result.income;
    if (result.balance) payload.balance = result.balance;
    if (result.cash) payload.cash = result.cash;
    if (result.dividends) payload.dividends = result.dividends;
    // The whole file is rewritten each pass; if the dividend fetch failed,
    // keep the previously cached history rather than silently dropping it.
    else if (fs.existsSync(file)) {
      try {
        const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (prev && prev.dividends) payload.dividends = prev.dividends;
      } catch (_) { /* unreadable previous file */ }
    }
    if (SEC_EXTEND) {
      try {
        // backfillStatements also normalizes shares/per-share figures to the
        // current split basis (backend/split-adjust.js).
        await secSource.backfillStatements(symbol, payload);
      } catch (err) {
        errors.push('sec:' + (err.message || 'unknown'));
      }
    }
    fs.writeFileSync(file, JSON.stringify(payload));
    wrote++;
    indexFiles.push({ symbol, file: `data/fundamentals/${path.basename(file)}` });
    if (errors.length) console.log(`[${i + 1}/${limit}] ${symbol.padEnd(7)} OK ${(fs.statSync(file).size / 1024).toFixed(1)} KB (partial: ${errors.join(',')})`);
  }, CONCURRENCY);

  if (WRITE_INDEX) {
    fs.writeFileSync(INDEX_FILE, JSON.stringify({
      generatedAt: new Date().toISOString(),
      count: indexFiles.length,
      source: 'yahoo-finance2',
      files: indexFiles
    }, null, 2));
  }

  const secs = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`\nDone in ${secs}s — wrote ${wrote}, skipped ${skipped}.`);
  if (errorList.length) {
    console.log(`Failures (${errorList.length}):`);
    errorList.slice(0, 20).forEach((e) => console.log(`  ${e.symbol}: ${e.errors.join(',')}`));
  }
}

if (require.main === module) {
  main().catch((e) => { console.error('fatal:', e); process.exit(1); });
}
module.exports = { buildDividendHistory };
