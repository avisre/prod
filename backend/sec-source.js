// SEC EDGAR backfill. The agency's XBRL companyFacts endpoint exposes
// every line item a US company has ever reported on a 10-K or 10-Q.
// It's free, requires no key, and is the canonical source — we use it
// to fill the cells Yahoo doesn't break out (interestExpense, goodwill,
// treasuryStock, depreciation, intangibles, preferred-stock cash flows).

const axios = require('axios');

const SEC_HEADERS = {
    'User-Agent': 'stockportfolio.pro contact@stockportfolio.pro',
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate'
};

let _tickerMap = null;        // { TICKER: '0000320193' (10-digit padded CIK) }
let _factsCache = new Map();  // ticker -> { fetchedAt, facts }
const FACTS_TTL_MS = 6 * 60 * 60 * 1000; // 6h

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
        _factsCache.set(key, { fetchedAt: Date.now(), facts });
        return facts;
    } catch (_) {
        _factsCache.set(key, { fetchedAt: Date.now(), facts: null });
        return null;
    }
}

// Pick the value for a given fiscalDateEnding from one or more XBRL tags.
// Yahoo's fiscalDateEnding rounds to month-end while SEC reports the actual
// 13-week or 52-week period end (e.g. 2022-09-24 vs Yahoo's 2022-09-30). We
// accept any XBRL `end` within ±14 days of Yahoo's date and treat the
// duration filter (full-year for 10-K, ~3 months for 10-Q) as the strict
// signal that we're picking the right reporting period.
function valueFor(facts, tagNames, endDate, form /* '10-K' | '10-Q' */) {
    if (!facts || !endDate) return null;
    const target = new Date(endDate).getTime();
    if (!Number.isFinite(target)) return null;
    const TOL = 14 * 86400000;
    for (const tag of tagNames) {
        const entry = facts[tag];
        if (!entry?.units) continue;
        const unitKey = entry.units.USD ? 'USD' : (entry.units['USD/shares'] ? 'USD/shares' : Object.keys(entry.units)[0]);
        const series = entry.units[unitKey] || [];

        // Pass 1: exact form + within tolerance, preferring full-period rows.
        let best = null; let bestScore = Infinity;
        for (const row of series) {
            const t = new Date(row.end).getTime();
            if (!Number.isFinite(t)) continue;
            const diff = Math.abs(t - target);
            if (diff > TOL) continue;
            if (form && row.form && row.form !== form) continue;
            // Prefer the latest filing if multiple match the same period.
            const score = diff - (row.filed ? Date.parse(row.filed) / 1e13 : 0);
            if (score < bestScore) { best = row; bestScore = score; }
        }
        if (best && Number.isFinite(best.val)) return best.val;

        // Pass 2: any form, within tolerance.
        best = null; bestScore = Infinity;
        for (const row of series) {
            const t = new Date(row.end).getTime();
            if (!Number.isFinite(t)) continue;
            const diff = Math.abs(t - target);
            if (diff > TOL) continue;
            const score = diff - (row.filed ? Date.parse(row.filed) / 1e13 : 0);
            if (score < bestScore) { best = row; bestScore = score; }
        }
        if (best && Number.isFinite(best.val)) return best.val;
    }
    return null;
}

// XBRL → Alpha field mapping. Each Alpha field maps to a list of XBRL tags
// in priority order (first one that resolves wins).
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
    capitalExpenditures: ['PaymentsToAcquirePropertyPlantAndEquipment'],
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

function backfillSection(reports, map, facts, form) {
    if (!facts || !reports?.length) return reports;
    for (const r of reports) {
        const end = r.fiscalDateEnding;
        if (!end) continue;
        for (const [alphaField, xbrlTags] of Object.entries(map)) {
            const existing = r[alphaField];
            if (existing !== '' && existing !== null && existing !== undefined) continue;
            const val = valueFor(facts, xbrlTags, end, form);
            if (val !== null && Number.isFinite(val)) {
                // Capex is reported positive in XBRL but negative in Alpha; mirror that.
                if (alphaField === 'capitalExpenditures' && val > 0) {
                    r[alphaField] = String(-Math.abs(val));
                } else if ((alphaField === 'dividendPayout' || alphaField === 'dividendPayoutCommonStock' || alphaField === 'paymentsForRepurchaseOfCommonStock') && val > 0) {
                    r[alphaField] = String(-Math.abs(val));
                } else {
                    r[alphaField] = String(val);
                }
            }
        }
    }
    return reports;
}

async function backfillStatements(symbol, payload) {
    const facts = await fetchCompanyFacts(symbol);
    if (!facts) return payload;
    if (payload.income) {
        backfillSection(payload.income.annualReports, INCOME_MAP, facts, '10-K');
        backfillSection(payload.income.quarterlyReports, INCOME_MAP, facts, '10-Q');
    }
    if (payload.balance) {
        backfillSection(payload.balance.annualReports, BALANCE_MAP, facts, '10-K');
        backfillSection(payload.balance.quarterlyReports, BALANCE_MAP, facts, '10-Q');
    }
    if (payload.cash) {
        backfillSection(payload.cash.annualReports, CASH_MAP, facts, '10-K');
        backfillSection(payload.cash.quarterlyReports, CASH_MAP, facts, '10-Q');
    }
    return payload;
}

module.exports = { backfillStatements, fetchCompanyFacts };
