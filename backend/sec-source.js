// SEC EDGAR backfill + history extension. The agency's XBRL companyFacts
// endpoint exposes every line item a US company has ever reported on a
// 10-K or 10-Q (XBRL is mandatory since ~2009). It's free, requires no
// key, and is the canonical source. We use it two ways:
//
//   1. Backfill — fill the cells Yahoo leaves blank in the ~4 years it
//      returns (interestExpense, goodwill, treasuryStock, ...).
//   2. Extend — synthesize entire report rows for every fiscal year and
//      quarter EDGAR has that Yahoo doesn't surface, taking annual
//      history from ~4 years to 15+ and quarterly from ~0 to 40+.
//
// Quarterly subtlety: 10-Qs report the income statement both for the
// discrete quarter and year-to-date, but the cash-flow statement is
// YTD-only, and Q4 is never filed on its own (it's inside the 10-K's
// full-year figures). So discrete quarters are resolved in two steps:
// use a ~3-month-duration fact when one exists, otherwise difference
// two YTD facts that share the same period start (Q4 = FY − 9-month).

const axios = require('axios');
const splitAdjust = require('./split-adjust');

const SEC_HEADERS = {
    'User-Agent': 'stockportfolio.pro contact@stockportfolio.pro',
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate'
};

let _tickerMap = null;        // { TICKER: '0000320193' (10-digit padded CIK) }
let _factsCache = new Map();  // ticker -> { fetchedAt, facts }
const FACTS_TTL_MS = 6 * 60 * 60 * 1000; // 6h
// companyfacts payloads run several MB each — without eviction a long sweep
// (e.g. refreshing 1000+ tickers) grows the heap past Node's 4GB limit.
const FACTS_CACHE_MAX = 30;

function factsCacheSet(key, entry) {
    _factsCache.delete(key); // re-insert to keep Map in LRU order
    _factsCache.set(key, entry);
    while (_factsCache.size > FACTS_CACHE_MAX) {
        _factsCache.delete(_factsCache.keys().next().value);
    }
}

async function loadTickerMap() {
    if (_tickerMap) return _tickerMap;
    try {
        const r = await axios.get('https://www.sec.gov/files/company_tickers.json', {
            headers: SEC_HEADERS,
            timeout: 15000
        });
        const out = {};
        for (const v of Object.values(r.data || {})) {
            if (v?.ticker && v?.cik_str != null) {
                out[String(v.ticker).toUpperCase()] = String(v.cik_str).padStart(10, '0');
            }
        }
        _tickerMap = out;
        return _tickerMap;
    } catch (_) {
        _tickerMap = {};
        return _tickerMap;
    }
}

async function fetchCompanyFacts(symbol) {
    const key = String(symbol || '').toUpperCase();
    const cached = _factsCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < FACTS_TTL_MS) return cached.facts;

    const map = await loadTickerMap();
    const cik = map[key];
    if (!cik) return null;

    try {
        const r = await axios.get(`https://data.sec.gov/api/xbrl/companyfacts/CIK${cik}.json`, {
            headers: SEC_HEADERS,
            timeout: 20000
        });
        const facts = r?.data?.facts?.['us-gaap'] || {};
        factsCacheSet(key, { fetchedAt: Date.now(), facts });
        return facts;
    } catch (_) {
        factsCacheSet(key, { fetchedAt: Date.now(), facts: null });
        return null;
    }
}

// ---------------------------------------------------------------------------
// Normalized fact rows
// ---------------------------------------------------------------------------

const DAY = 86400000;
// Yahoo's fiscalDateEnding rounds to month-end while SEC reports the actual
// 13/52-week period end (e.g. 2022-09-24 vs Yahoo's 2022-09-30), so all
// end-date matching tolerates ±14 days.
const TOL = 14 * DAY;

// facts object -> Map(tag -> normalized rows). WeakMap so the cache dies
// with the facts blob when its 6h TTL evicts it.
const _rowsCache = new WeakMap();

function rowsFor(facts, tag) {
    let perTag = _rowsCache.get(facts);
    if (!perTag) { perTag = new Map(); _rowsCache.set(facts, perTag); }
    if (perTag.has(tag)) return perTag.get(tag);

    const out = [];
    const entry = facts[tag];
    if (entry?.units) {
        const unitKey = entry.units.USD ? 'USD'
            : (entry.units['USD/shares'] ? 'USD/shares' : Object.keys(entry.units)[0]);
        for (const r of entry.units[unitKey] || []) {
            if (!Number.isFinite(r?.val)) continue;
            const end = Date.parse(r.end);
            if (!Number.isFinite(end)) continue;
            const start = r.start ? Date.parse(r.start) : NaN;
            out.push({
                start: Number.isFinite(start) ? start : null,
                end,
                days: Number.isFinite(start) ? Math.round((end - start) / DAY) : null,
                val: r.val,
                form: r.form || '',
                filed: r.filed ? Date.parse(r.filed) || 0 : 0
            });
        }
    }
    perTag.set(tag, out);
    return out;
}

// Choose among candidate rows near a target end date: closest end date
// first, then preferred form, then the most recently filed (restatements
// in later filings supersede the original number).
function best(cands, target, preferForm) {
    let win = null;
    for (const r of cands) {
        if (!win) { win = r; continue; }
        const dr = Math.abs(r.end - target), dw = Math.abs(win.end - target);
        if (dr !== dw) { if (dr < dw) win = r; continue; }
        if (preferForm) {
            const fr = r.form.startsWith(preferForm), fw = win.form.startsWith(preferForm);
            if (fr !== fw) { if (fr) win = r; continue; }
        }
        if (r.filed > win.filed) win = r;
    }
    return win;
}

// Instant fact (balance sheet) at a point in time.
function pickInstant(facts, tags, target) {
    for (const tag of tags) {
        const cands = rowsFor(facts, tag).filter(r => r.days === null && Math.abs(r.end - target) <= TOL);
        const win = best(cands, target);
        if (win) return win.val;
    }
    return null;
}

// Duration fact (income / cash flow) whose period length falls in
// [minDays, maxDays] and ends near the target date.
function pickDuration(facts, tags, target, minDays, maxDays, preferForm) {
    for (const tag of tags) {
        const cands = rowsFor(facts, tag).filter(r =>
            r.days !== null && r.days >= minDays && r.days <= maxDays &&
            Math.abs(r.end - target) <= TOL);
        const win = best(cands, target, preferForm);
        if (win) return win.val;
    }
    return null;
}

// Discrete-quarter value ending at qEnd. Direct ~3-month fact when filed
// (income statements), else difference two YTD facts sharing the same
// fiscal-year start (cash flow Q2-Q4, income Q4 = FY − 9-month YTD).
function pickQuarter(facts, tags, qEnd) {
    const direct = pickDuration(facts, tags, qEnd, 75, 105);
    if (direct !== null) return direct;

    for (const tag of tags) {
        const rows = rowsFor(facts, tag);
        const ytds = rows.filter(r =>
            r.days !== null && r.days >= 160 && r.days <= 380 &&
            Math.abs(r.end - qEnd) <= TOL);
        const r1 = best(ytds, qEnd);
        if (!r1) continue;
        const prevTarget = r1.end - 91 * DAY;
        const prevs = rows.filter(r =>
            r.days !== null && r.start !== null && r1.start !== null &&
            Math.abs(r.start - r1.start) <= 5 * DAY &&
            r.days >= r1.days - 110 && r.days <= r1.days - 75);
        const r2 = best(prevs, prevTarget);
        // Round: differencing two reported floats (e.g. EPS) accumulates
        // binary noise like 1.8399999999999999.
        if (r2) return Math.round((r1.val - r2.val) * 1e6) / 1e6;
    }
    return null;
}

// ---------------------------------------------------------------------------
// Period discovery — which fiscal years / quarters does EDGAR know about?
// ---------------------------------------------------------------------------

// High-coverage tags every filer reports; used only to enumerate period
// end dates, not for values.
const MARKER_TAGS = [
    'Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet',
    'NetIncomeLoss', 'ProfitLoss', 'OperatingIncomeLoss',
    'NetCashProvidedByUsedInOperatingActivities'
];

// Collect duration-fact end dates with period length in [minDays, maxDays],
// clustered so the same period reported as e.g. 09-24 and 09-30 counts once.
// formPrefix guards against rolling-period disclosures: AMZN puts a
// trailing-twelve-month operating-cash-flow figure in every 10-Q, so a
// 12-month duration alone does NOT mean "fiscal year end" — only 12-month
// periods from a 10-K do.
function periodEnds(facts, minDays, maxDays, formPrefix) {
    const ends = [];
    for (const tag of MARKER_TAGS) {
        for (const r of rowsFor(facts, tag)) {
            if (r.days === null || r.days < minDays || r.days > maxDays) continue;
            if (formPrefix && !r.form.startsWith(formPrefix)) continue;
            ends.push(r.end);
        }
    }
    ends.sort((a, b) => a - b);
    const out = [];
    for (const e of ends) {
        if (!out.length || e - out[out.length - 1] > TOL) out.push(e);
        else if (e > out[out.length - 1]) out[out.length - 1] = e;
    }
    return out; // ascending
}

function annualEnds(facts) {
    return periodEnds(facts, 340, 380, '10-K');
}

function quarterEnds(facts) {
    // Q1-Q3 come from discrete ~3-month facts; every fiscal year end is
    // also a Q4 end. Merge + recluster.
    const all = periodEnds(facts, 75, 105, '10-').concat(annualEnds(facts));
    all.sort((a, b) => a - b);
    const out = [];
    for (const e of all) {
        if (!out.length || e - out[out.length - 1] > TOL) out.push(e);
        else if (e > out[out.length - 1]) out[out.length - 1] = e;
    }
    return out;
}

// ---------------------------------------------------------------------------
// XBRL → Alpha field mapping. Each Alpha field maps to a list of XBRL tags
// in priority order (first one that resolves wins).
// ---------------------------------------------------------------------------

const INCOME_MAP = {
    totalRevenue: ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'],
    costOfRevenue: ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold'],
    costofGoodsAndServicesSold: ['CostOfGoodsAndServicesSold', 'CostOfRevenue', 'CostOfGoodsSold'],
    grossProfit: ['GrossProfit'],
    operatingIncome: ['OperatingIncomeLoss'],
    operatingExpenses: ['OperatingExpenses', 'CostsAndExpenses'],
    sellingGeneralAndAdministrative: ['SellingGeneralAndAdministrativeExpense', 'GeneralAndAdministrativeExpense'],
    researchAndDevelopment: ['ResearchAndDevelopmentExpense'],
    depreciation: ['Depreciation', 'DepreciationAndAmortization'],
    depreciationAndAmortization: ['DepreciationAndAmortization', 'DepreciationDepletionAndAmortization', 'Depreciation'],
    interestExpense: ['InterestExpense', 'InterestExpenseDebt'],
    interestIncome: ['InvestmentIncomeInterest', 'InterestAndDividendIncomeOperating', 'InterestIncomeOperating'],
    netInterestIncome: ['InterestIncomeExpenseNet', 'NoninterestIncome'],
    nonInterestIncome: ['NoninterestIncome'],
    investmentIncomeNet: ['InvestmentIncomeNet', 'InvestmentIncomeInterest'],
    interestAndDebtExpense: ['InterestExpense', 'InterestExpenseDebt'],
    otherNonOperatingIncome: ['OtherNonoperatingIncomeExpense', 'NonoperatingIncomeExpense'],
    incomeBeforeTax: ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments'],
    incomeTaxExpense: ['IncomeTaxExpenseBenefit'],
    netIncome: ['NetIncomeLoss', 'ProfitLoss'],
    netIncomeFromContinuingOperations: ['IncomeLossFromContinuingOperations'],
    comprehensiveIncomeNetOfTax: ['ComprehensiveIncomeNetOfTax'],
    ebit: ['OperatingIncomeLoss'],
    ebitda: [],
    eps: ['EarningsPerShareBasic'],
    dilutedEPS: ['EarningsPerShareDiluted']
};

const BALANCE_MAP = {
    totalAssets: ['Assets'],
    totalCurrentAssets: ['AssetsCurrent'],
    cashAndCashEquivalentsAtCarryingValue: ['CashAndCashEquivalentsAtCarryingValue', 'CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
    cashAndShortTermInvestments: ['CashCashEquivalentsAndShortTermInvestments'],
    inventory: ['InventoryNet'],
    currentNetReceivables: ['AccountsReceivableNetCurrent', 'ReceivablesNetCurrent'],
    totalNonCurrentAssets: ['AssetsNoncurrent'],
    propertyPlantEquipment: ['PropertyPlantAndEquipmentNet'],
    accumulatedDepreciationAmortizationPPE: ['AccumulatedDepreciationDepletionAndAmortizationPropertyPlantAndEquipment'],
    intangibleAssets: ['IntangibleAssetsNetExcludingGoodwill', 'FiniteLivedIntangibleAssetsNet'],
    intangibleAssetsExcludingGoodwill: ['IntangibleAssetsNetExcludingGoodwill', 'FiniteLivedIntangibleAssetsNet'],
    goodwill: ['Goodwill'],
    investments: ['LongTermInvestments', 'Investments'],
    longTermInvestments: ['LongTermInvestments'],
    shortTermInvestments: ['ShortTermInvestments', 'AvailableForSaleSecuritiesCurrent'],
    otherCurrentAssets: ['OtherAssetsCurrent'],
    otherNonCurrentAssets: ['OtherAssetsNoncurrent'],
    totalLiabilities: ['Liabilities'],
    totalCurrentLiabilities: ['LiabilitiesCurrent'],
    currentAccountsPayable: ['AccountsPayableCurrent'],
    deferredRevenue: ['DeferredRevenue', 'ContractWithCustomerLiabilityCurrent'],
    currentDebt: ['DebtCurrent', 'LongTermDebtCurrent', 'ShortTermBorrowings'],
    shortTermDebt: ['ShortTermBorrowings', 'DebtCurrent'],
    totalNonCurrentLiabilities: ['LiabilitiesNoncurrent'],
    capitalLeaseObligations: ['CapitalLeaseObligations', 'OperatingLeaseLiabilityNoncurrent'],
    longTermDebt: ['LongTermDebt', 'LongTermDebtNoncurrent'],
    currentLongTermDebt: ['LongTermDebtCurrent'],
    longTermDebtNoncurrent: ['LongTermDebtNoncurrent'],
    shortLongTermDebtTotal: ['DebtLongtermAndShorttermCombinedAmount', 'LongTermDebt'],
    otherCurrentLiabilities: ['OtherLiabilitiesCurrent'],
    otherNonCurrentLiabilities: ['OtherLiabilitiesNoncurrent'],
    totalShareholderEquity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
    treasuryStock: ['TreasuryStockValue', 'TreasuryStockCommonValue'],
    retainedEarnings: ['RetainedEarningsAccumulatedDeficit'],
    commonStock: ['CommonStockValue'],
    commonStockSharesOutstanding: ['CommonStockSharesOutstanding']
};

const CASH_MAP = {
    operatingCashflow: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
    cashflowFromInvestment: ['NetCashProvidedByUsedInInvestingActivities', 'NetCashProvidedByUsedInInvestingActivitiesContinuingOperations'],
    cashflowFromFinancing: ['NetCashProvidedByUsedInFinancingActivities', 'NetCashProvidedByUsedInFinancingActivitiesContinuingOperations'],
    capitalExpenditures: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PurchasesOfPropertyAndEquipmentNetOfProceedsFromSalesAndIncentives', 'PaymentsToAcquireProductiveAssets', 'PaymentsForCapitalImprovements'],
    depreciationDepletionAndAmortization: ['DepreciationDepletionAndAmortization', 'DepreciationAndAmortization', 'Depreciation'],
    changeInReceivables: ['IncreaseDecreaseInAccountsReceivable'],
    changeInInventory: ['IncreaseDecreaseInInventories'],
    changeInOperatingLiabilities: ['IncreaseDecreaseInAccountsPayableAndAccruedLiabilities'],
    profitLoss: ['NetIncomeLoss', 'ProfitLoss'],
    netIncome: ['NetIncomeLoss', 'ProfitLoss'],
    dividendPayout: ['PaymentsOfDividends', 'PaymentsOfDividendsCommonStock'],
    dividendPayoutCommonStock: ['PaymentsOfDividendsCommonStock', 'PaymentsOfDividends'],
    dividendPayoutPreferredStock: ['PaymentsOfDividendsPreferredStockAndPreferenceStock'],
    paymentsForRepurchaseOfCommonStock: ['PaymentsForRepurchaseOfCommonStock'],
    paymentsForRepurchaseOfEquity: ['PaymentsForRepurchaseOfEquity'],
    paymentsForRepurchaseOfPreferredStock: ['PaymentsForRepurchaseOfPreferredStockAndPreferenceStock'],
    proceedsFromIssuanceOfCommonStock: ['ProceedsFromIssuanceOfCommonStock'],
    proceedsFromIssuanceOfLongTermDebtAndCapitalSecuritiesNet: ['ProceedsFromIssuanceOfLongTermDebt'],
    proceedsFromIssuanceOfPreferredStock: ['ProceedsFromIssuanceOfPreferredStockAndPreferenceStock'],
    proceedsFromRepaymentsOfShortTermDebt: ['ProceedsFromRepaymentsOfShortTermDebt', 'ProceedsFromRepaymentsOfCommercialPaper'],
    proceedsFromRepurchaseOfEquity: ['ProceedsFromRepurchaseOfEquity'],
    proceedsFromSaleOfTreasuryStock: ['ProceedsFromSaleOfTreasuryStock'],
    changeInCashAndCashEquivalents: ['CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect'],
    changeInExchangeRate: ['EffectOfExchangeRateOnCashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents']
};

// XBRL reports these as positive outflows; the Alpha/Yahoo shape carries
// them as negatives.
const NEGATE_FIELDS = new Set([
    'capitalExpenditures',
    'dividendPayout', 'dividendPayoutCommonStock', 'dividendPayoutPreferredStock',
    'paymentsForRepurchaseOfCommonStock', 'paymentsForRepurchaseOfEquity', 'paymentsForRepurchaseOfPreferredStock'
]);

// Fields whose presence makes a synthesized row worth keeping; a row that
// resolves none of these is dropped as junk.
const CORE_FIELDS = {
    income: ['totalRevenue', 'netIncome', 'operatingIncome'],
    balance: ['totalAssets', 'totalShareholderEquity'],
    cash: ['operatingCashflow', 'netIncome']
};

// ---------------------------------------------------------------------------
// Resolution + row synthesis
// ---------------------------------------------------------------------------

// kind: 'instant' (balance) | 'duration' (income/cash)
// period: 'annual' | 'quarterly'
function resolveField(facts, tags, end, kind, period) {
    if (!tags?.length) return null;
    if (kind === 'instant') return pickInstant(facts, tags, end);
    if (period === 'annual') return pickDuration(facts, tags, end, 340, 380, '10-K');
    return pickQuarter(facts, tags, end);
}

function formatValue(alphaField, val) {
    if (NEGATE_FIELDS.has(alphaField) && val > 0) return String(-Math.abs(val));
    return String(val);
}

function isoDate(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

// Fill blank cells in rows that already exist (Yahoo's years).
function backfillSection(reports, map, facts, kind, period) {
    if (!facts || !reports?.length) return;
    for (const r of reports) {
        const end = Date.parse(r.fiscalDateEnding);
        if (!Number.isFinite(end)) continue;
        for (const [alphaField, xbrlTags] of Object.entries(map)) {
            // A literal 0 from Yahoo almost always means "not populated", not
            // a filed zero (e.g. AAPL gross profit 2022-25) — let SEC win.
            const existing = r[alphaField];
            const present = existing !== '' && existing !== null && existing !== undefined
                && existing !== 'None' && Number(existing) !== 0;
            if (present) continue;
            const val = resolveField(facts, xbrlTags, end, kind, period);
            if (val !== null && Number.isFinite(val)) {
                r[alphaField] = formatValue(alphaField, val);
            }
        }
    }
}

// Synthesize whole rows for periods EDGAR knows about but the reports
// array doesn't cover.
function extendSection(reports, map, facts, kind, period, ends, coreFields) {
    if (!facts || !Array.isArray(reports)) return;
    const have = reports
        .map(r => Date.parse(r.fiscalDateEnding))
        .filter(Number.isFinite);

    for (const end of ends) {
        if (have.some(t => Math.abs(t - end) <= TOL)) continue;
        const row = { fiscalDateEnding: isoDate(end), reportedCurrency: 'USD' };
        let coreHit = false;
        for (const [alphaField, xbrlTags] of Object.entries(map)) {
            const val = resolveField(facts, xbrlTags, end, kind, period);
            if (val !== null && Number.isFinite(val)) {
                row[alphaField] = formatValue(alphaField, val);
                if (coreFields.includes(alphaField)) coreHit = true;
            } else {
                row[alphaField] = '';
            }
        }
        if (coreHit) reports.push(row);
    }
    reports.sort((a, b) => String(b.fiscalDateEnding).localeCompare(String(a.fiscalDateEnding)));
}

const MAX_QUARTERS = 48; // ~12 years of quarterly history

async function backfillStatements(symbol, payload) {
    const facts = await fetchCompanyFacts(symbol);
    if (!facts) return payload;

    const annuals = annualEnds(facts);
    const quarters = quarterEnds(facts).slice(-MAX_QUARTERS);

    const sections = [
        { node: payload.income, map: INCOME_MAP, kind: 'duration', core: CORE_FIELDS.income },
        { node: payload.balance, map: BALANCE_MAP, kind: 'instant', core: CORE_FIELDS.balance },
        { node: payload.cash, map: CASH_MAP, kind: 'duration', core: CORE_FIELDS.cash }
    ];

    for (const s of sections) {
        if (!s.node) continue;
        if (!Array.isArray(s.node.annualReports)) s.node.annualReports = [];
        if (!Array.isArray(s.node.quarterlyReports)) s.node.quarterlyReports = [];
        // Extend first (adds the deep-history rows), then backfill blanks
        // in the rows Yahoo supplied.
        extendSection(s.node.annualReports, s.map, facts, s.kind, 'annual', annuals, s.core);
        extendSection(s.node.quarterlyReports, s.map, facts, s.kind, 'quarterly', quarters, s.core);
        backfillSection(s.node.annualReports, s.map, facts, s.kind, 'annual');
        backfillSection(s.node.quarterlyReports, s.map, facts, s.kind, 'quarterly');
    }

    // GrossProfit is an optional XBRL tag many filers omit (and Yahoo wrote
    // 0 where it had nothing) — derive either of grossProfit/costOfRevenue
    // from the other wherever one is still missing.
    const present = (v) => v !== '' && v !== null && v !== undefined && Number(v) !== 0 && Number.isFinite(Number(v));
    for (const kind of ['annualReports', 'quarterlyReports']) {
        for (const r of (payload.income || {})[kind] || []) {
            if (!present(r.totalRevenue)) continue;
            const rev = Number(r.totalRevenue);
            if (!present(r.grossProfit) && present(r.costOfRevenue)) r.grossProfit = String(rev - Number(r.costOfRevenue));
            else if (!present(r.costOfRevenue) && present(r.grossProfit)) r.costOfRevenue = String(rev - Number(r.grossProfit));
        }
    }

    // SEC values are as-filed; normalize shares + per-share figures to the
    // current split basis (fail-open inside).
    await splitAdjust.adjustPayloadForSymbol(symbol, payload);
    return payload;
}

// Ticker -> 10-digit padded CIK (tries dot/dash class-share variants).
async function cikFor(symbol) {
    const map = await loadTickerMap();
    const key = String(symbol || '').toUpperCase();
    return map[key] || map[key.replace(/\./g, '-')] || map[key.replace(/-/g, '.')] || null;
}

module.exports = { backfillStatements, fetchCompanyFacts, cikFor, SEC_HEADERS };
