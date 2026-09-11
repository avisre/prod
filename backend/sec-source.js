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
const mongoose = require('mongoose');
const splitAdjust = require('./split-adjust');
const bulkFacts = require('./companyfacts-bulk'); // opt-in bulk companyfacts (inert unless SEC_BULK_DIR set)
require('./sec-throttle'); // installs the global ≤8/sec axios interceptor for *.sec.gov

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

const TICKER_MAP_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d — the list changes slowly
function tickerMapCol() { try { return mongoose.connection.collection('sec_ticker_map'); } catch (_) { return null; } }

// Ticker→CIK resolver. Hardened after a 50-stock sweep exposed the original:
// a single SEC 429/503 threw, and the catch cached an EMPTY map — which, being
// truthy, was then returned for the entire process, silently breaking every
// filing-backed section until restart. Now: never cache empty; retry; and
// persist to Mongo so SEC throttling (or a fresh worker) can't break the map.
async function loadTickerMap() {
    if (_tickerMap && Object.keys(_tickerMap).length) return _tickerMap;

    // 1) Mongo-persisted map — survives SEC throttling and process restarts.
    let staleFallback = null;
    try {
        const col = tickerMapCol();
        if (col) {
            const doc = await col.findOne({ _id: 'company_tickers' });
            if (doc && doc.map && Object.keys(doc.map).length) {
                if (Date.now() - new Date(doc.at || 0).getTime() < TICKER_MAP_TTL_MS) { _tickerMap = doc.map; return _tickerMap; }
                staleFallback = doc.map; // expired → try to refresh, but keep as fallback
            }
        }
    } catch (_) { /* best-effort */ }

    // 2) Refresh from SEC with retry; persist on success.
    for (let i = 0; i < 3; i++) {
        try {
            const r = await axios.get('https://www.sec.gov/files/company_tickers.json', { headers: SEC_HEADERS, timeout: 15000 });
            const out = {};
            if (r.data && typeof r.data === 'object') {
                for (const v of Object.values(r.data)) {
                    if (v && v.ticker && v.cik_str != null) out[String(v.ticker).toUpperCase()] = String(v.cik_str).padStart(10, '0');
                }
            }
            if (Object.keys(out).length) {
                _tickerMap = out;
                try { const col = tickerMapCol(); if (col) await col.updateOne({ _id: 'company_tickers' }, { $set: { map: out, at: new Date() } }, { upsert: true }); } catch (_) { /* cache best-effort */ }
                return _tickerMap;
            }
        } catch (_) { /* transient — retry */ }
        await new Promise((res) => setTimeout(res, 800 * (i + 1)));
    }

    // 3) SEC unavailable: use a stale Mongo map if we have one; otherwise return
    // an empty map WITHOUT caching it, so the next call retries instead of being
    // permanently poisoned.
    if (staleFallback) { _tickerMap = staleFallback; return _tickerMap; }
    return {};
}

async function fetchCompanyFacts(symbol) {
    const key = String(symbol || '').toUpperCase();
    const cached = _factsCache.get(key);
    if (cached && Date.now() - cached.fetchedAt < FACTS_TTL_MS) return cached.facts;

    const map = await loadTickerMap();
    const cik = map[key];
    if (!cik) return null;

    // Prefer the nightly bulk zip when a disk is configured (zero live SEC calls);
    // otherwise hit the per-ticker API (now globally throttled by sec-throttle).
    try {
        const bf = await bulkFacts.factsForCik(cik);
        if (bf) { factsCacheSet(key, { fetchedAt: Date.now(), facts: bf }); return bf; }
    } catch (_) { /* fall through to live API */ }

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

// Which units bucket to read for a tag, given the currency the statements are
// actually denominated in. A foreign private issuer's 20-F frequently carries a
// USD *convenience translation* alongside the real figures — for some tags and
// some years only (NTES: Revenues has CNY 2009-2014 but USD 2011-2014; Goodwill
// is CNY-only). A blind units.USD preference therefore mixes two currencies
// inside a single row. Never fall back to a different currency: a blank cell is
// recoverable, a mis-denominated one is not.
//
// 'shares' (share counts) and 'pure' (ratios) carry no currency and are always
// usable.
function unitKeyFor(units, currency) {
    if (!units) return null;
    const cur = String(currency || 'USD').toUpperCase();
    if (units[cur]) return cur;
    if (units[`${cur}/shares`]) return `${cur}/shares`;
    if (units.shares) return 'shares';
    if (units.pure) return 'pure';
    return null;
}

function rowsFor(facts, tag, currency = 'USD') {
    let perTag = _rowsCache.get(facts);
    if (!perTag) { perTag = new Map(); _rowsCache.set(facts, perTag); }
    const cacheKey = `${tag}|${String(currency || 'USD').toUpperCase()}`;
    if (perTag.has(cacheKey)) return perTag.get(cacheKey);

    const out = [];
    const entry = facts[tag];
    const unitKey = entry?.units ? unitKeyFor(entry.units, currency) : null;
    if (unitKey) {
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
    perTag.set(cacheKey, out);
    return out;
}

// The annual report forms we accept. 10-K is the US domestic filer; 20-F is the
// foreign private issuer (NetEase, Alibaba, SAP); 40-F is the Canadian MJDS
// equivalent. A 20-F filer has NO 10-K at all — NTES's EDGAR history is 25
// 20-Fs and zero 10-Ks — so a hardcoded '10-K' meant every foreign issuer
// resolved to an empty fact set and got no SEC history whatsoever.
const ANNUAL_FORMS = ['10-K', '20-F', '40-F'];

// Quarterly stays 10-Q-only on purpose. Foreign private issuers are not required
// to file quarterly: NetEase reports quarterly through 6-K press-release
// exhibits, which are not XBRL-tagged into companyfacts. Verified — every NTES
// duration fact is 12-month/20-F, so there is nothing sub-annual to difference
// and quarters for these filers come from Yahoo alone.
const QUARTER_FORMS = ['10-'];

function matchesForm(form, prefixes) {
    if (!prefixes) return true;
    const list = Array.isArray(prefixes) ? prefixes : [prefixes];
    const f = String(form || '');
    return list.some((p) => f.startsWith(p));
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
            const fr = matchesForm(r.form, preferForm), fw = matchesForm(win.form, preferForm);
            if (fr !== fw) { if (fr) win = r; continue; }
        }
        if (r.filed > win.filed) win = r;
    }
    return win;
}

// Instant fact (balance sheet) at a point in time.
function pickInstant(facts, tags, target, currency = 'USD') {
    for (const tag of tags) {
        const cands = rowsFor(facts, tag, currency).filter(r => r.days === null && Math.abs(r.end - target) <= TOL);
        const win = best(cands, target);
        if (win) return win.val;
    }
    return null;
}

// Duration fact (income / cash flow) whose period length falls in
// [minDays, maxDays] and ends near the target date.
function pickDuration(facts, tags, target, minDays, maxDays, preferForm, currency = 'USD') {
    for (const tag of tags) {
        const cands = rowsFor(facts, tag, currency).filter(r =>
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
function pickQuarter(facts, tags, qEnd, currency = 'USD') {
    const direct = pickDuration(facts, tags, qEnd, 75, 105, undefined, currency);
    if (direct !== null) return direct;

    for (const tag of tags) {
        const rows = rowsFor(facts, tag, currency);
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
function periodEnds(facts, minDays, maxDays, formPrefix, currency = 'USD') {
    const ends = [];
    for (const tag of MARKER_TAGS) {
        for (const r of rowsFor(facts, tag, currency)) {
            if (r.days === null || r.days < minDays || r.days > maxDays) continue;
            if (formPrefix && !matchesForm(r.form, formPrefix)) continue;
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

function annualEnds(facts, currency = 'USD') {
    return periodEnds(facts, 340, 380, ANNUAL_FORMS, currency);
}

function quarterEnds(facts, currency = 'USD') {
    // Q1-Q3 come from discrete ~3-month facts; every fiscal year end is
    // also a Q4 end. Merge + recluster.
    const all = periodEnds(facts, 75, 105, QUARTER_FORMS, currency).concat(annualEnds(facts, currency));
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
    changeInExchangeRate: ['EffectOfExchangeRateOnCashCashEquivalentsRestrictedCashAndRestrictedCashEquivalents'],
    shareBasedCompensation: ['ShareBasedCompensation']
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
function resolveField(facts, tags, end, kind, period, currency = 'USD') {
    if (!tags?.length) return null;
    if (kind === 'instant') return pickInstant(facts, tags, end, currency);
    if (period === 'annual') return pickDuration(facts, tags, end, 340, 380, ANNUAL_FORMS, currency);
    return pickQuarter(facts, tags, end, currency);
}

function formatValue(alphaField, val) {
    if (NEGATE_FIELDS.has(alphaField) && val > 0) return String(-Math.abs(val));
    return String(val);
}

function isoDate(ms) {
    return new Date(ms).toISOString().slice(0, 10);
}

// Fill blank cells in rows that already exist (Yahoo's years).
function backfillSection(reports, map, facts, kind, period, currency = 'USD') {
    if (!facts || !reports?.length) return;
    for (const r of reports) {
        const end = Date.parse(r.fiscalDateEnding);
        if (!Number.isFinite(end)) continue;
        // Fill from facts denominated the same way this row is. Filling a CNY
        // row from a USD convenience translation is what produced mixed-currency
        // rows before unitKeyFor existed.
        const rowCurrency = String(r.reportedCurrency || currency || 'USD').toUpperCase();
        for (const [alphaField, xbrlTags] of Object.entries(map)) {
            // A literal 0 from Yahoo almost always means "not populated", not
            // a filed zero (e.g. AAPL gross profit 2022-25) — let SEC win.
            const existing = r[alphaField];
            const present = existing !== '' && existing !== null && existing !== undefined
                && existing !== 'None' && Number(existing) !== 0;
            if (present) continue;
            const val = resolveField(facts, xbrlTags, end, kind, period, rowCurrency);
            if (val !== null && Number.isFinite(val)) {
                r[alphaField] = formatValue(alphaField, val);
            }
        }
    }
}

// Synthesize whole rows for periods EDGAR knows about but the reports
// array doesn't cover.
function extendSection(reports, map, facts, kind, period, ends, coreFields, currency = 'USD') {
    if (!facts || !Array.isArray(reports)) return;
    const have = reports
        .map(r => Date.parse(r.fiscalDateEnding))
        .filter(Number.isFinite);

    const cur = String(currency || 'USD').toUpperCase();
    for (const end of ends) {
        if (have.some(t => Math.abs(t - end) <= TOL)) continue;
        const row = { fiscalDateEnding: isoDate(end), reportedCurrency: cur };
        let coreHit = false;
        for (const [alphaField, xbrlTags] of Object.entries(map)) {
            const val = resolveField(facts, xbrlTags, end, kind, period, cur);
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

// The currency Yahoo stamped on the statements (yahoo-source stampCurrency),
// which is the filer's real reporting currency. Everything pulled from EDGAR
// must be read in this same denomination or the two sources cannot share a row.
function payloadCurrency(payload) {
    for (const node of [payload?.income, payload?.balance, payload?.cash]) {
        for (const key of ['annualReports', 'quarterlyReports']) {
            for (const r of (node || {})[key] || []) {
                const c = String(r?.reportedCurrency || '').trim().toUpperCase();
                if (c) return c;
            }
        }
    }
    return 'USD';
}

async function backfillStatements(symbol, payload) {
    const facts = await fetchCompanyFacts(symbol);
    if (!facts) return payload;

    const currency = payloadCurrency(payload);
    const annuals = annualEnds(facts, currency);
    const quarters = quarterEnds(facts, currency).slice(-MAX_QUARTERS);

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
        extendSection(s.node.annualReports, s.map, facts, s.kind, 'annual', annuals, s.core, currency);
        extendSection(s.node.quarterlyReports, s.map, facts, s.kind, 'quarterly', quarters, s.core, currency);
        backfillSection(s.node.annualReports, s.map, facts, s.kind, 'annual', currency);
        backfillSection(s.node.quarterlyReports, s.map, facts, s.kind, 'quarterly', currency);
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

// company_tickers.json occasionally maps a ticker to a co-registrant or
// shell CIK that shares the ticker but doesn't carry the company's own 10-K
// history — e.g. XOM maps to CIK 2115436 "ExxonMobil Holdings Corp", a
// filer of S-8/8-K only, while the real annual reports are under CIK 34088
// "Exxon Mobil Corp". EDGAR's own company-search-by-ticker endpoint is a
// separately-maintained index that resolves the ticker correctly, so when
// the mapped CIK is missing a form a caller needs, this is the fallback.
// Cached (including negative results — real ETFs/foreign filers that
// simply have no 10-K) so a symbol only costs one extra request per day,
// not per call.
const CIK_OVERRIDE_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const _cikOverrideCache = new Map(); // symbol -> { cik: string|null, at: number }
function cikOverrideCol() { try { return mongoose.connection.collection('sec_cik_overrides'); } catch (_) { return null; } }

async function resolveWorkingCik(symbol, mappedCik, form = '10-K') {
    const key = String(symbol || '').toUpperCase();
    const mem = _cikOverrideCache.get(key);
    if (mem && Date.now() - mem.at < CIK_OVERRIDE_TTL_MS) return mem.cik;

    try {
        const col = cikOverrideCol();
        if (col) {
            const doc = await col.findOne({ _id: key });
            if (doc && Date.now() - new Date(doc.at || 0).getTime() < CIK_OVERRIDE_TTL_MS) {
                _cikOverrideCache.set(key, { cik: doc.cik, at: Date.now() });
                return doc.cik;
            }
        }
    } catch (_) { /* best-effort */ }

    let found = null;
    try {
        const r = await axios.get('https://www.sec.gov/cgi-bin/browse-edgar', {
            headers: { ...SEC_HEADERS, Accept: 'application/atom+xml, text/xml, */*' },
            timeout: 15000,
            params: { action: 'getcompany', CIK: key, type: form, output: 'atom', count: 1 }
        });
        const m = String(r.data || '').match(/<cik>(\d+)<\/cik>/);
        if (m && m[1] && m[1].padStart(10, '0') !== String(mappedCik || '')) found = m[1].padStart(10, '0');
    } catch (_) { /* SEC unavailable, or the ticker genuinely has no filer for this form */ }

    _cikOverrideCache.set(key, { cik: found, at: Date.now() });
    try { const col = cikOverrideCol(); if (col) await col.updateOne({ _id: key }, { $set: { cik: found, at: new Date() } }, { upsert: true }); } catch (_) { /* best-effort */ }
    return found;
}

module.exports = { backfillStatements, fetchCompanyFacts, cikFor, resolveWorkingCik, SEC_HEADERS, ANNUAL_FORMS };
