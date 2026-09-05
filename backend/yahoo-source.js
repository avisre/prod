// Yahoo Finance adapter that returns data shaped like Alpha Vantage so the
// existing routes and frontend consumers don't have to change. Lives behind
// fetchAlpha() in app.js.
//
// Replaces (one-for-one) the Alpha endpoints we used:
//   GLOBAL_QUOTE                     -> yahooFinance.quote
//   OVERVIEW                         -> yahooFinance.quoteSummary
//   TIME_SERIES_DAILY_ADJUSTED       -> yahooFinance.chart (interval 1d)
//   TIME_SERIES_MONTHLY_ADJUSTED     -> yahooFinance.chart (interval 1mo)
//   TIME_SERIES_INTRADAY             -> yahooFinance.chart (interval 5m)
//   INCOME_STATEMENT / BALANCE_SHEET / CASH_FLOW -> quoteSummary statements
//   SYMBOL_SEARCH                    -> yahooFinance.search
//   TOP_GAINERS_LOSERS               -> yahooFinance.dailyGainers + screener
//   NEWS_SENTIMENT                   -> yahooFinance.search news + RSS fallback

const YahooFinance = require('yahoo-finance2').default;
const noop = () => {};
const yf = new YahooFinance({
    suppressNotices: ['yahooSurvey', 'ripHistorical'],
    logger: { info: noop, warn: noop, error: (...args) => console.error('[yahoo]', ...args), debug: noop, dir: noop },
    validation: { logErrors: false, logOptionsErrors: false }
});
const axios = require('axios');

// Yahoo uses hyphens for class-share tickers (BRK-B); other feeds use dots.
function toYahooSymbol(symbol) {
    return String(symbol || '').toUpperCase().replace(/\./g, '-');
}

function n(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'object' && 'raw' in value) value = value.raw;
    return Number.isFinite(value) ? String(value) : '';
}

function isoDay(d) {
    if (!d) return '';
    const date = d instanceof Date ? d : new Date(d);
    return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 10);
}

// ---- Translators ----

function buildGlobalQuote(symbol, quote) {
    const price = quote?.regularMarketPrice;
    const prevClose = quote?.regularMarketPreviousClose;
    const change = (Number.isFinite(price) && Number.isFinite(prevClose)) ? price - prevClose : null;
    const pct = (Number.isFinite(change) && Number.isFinite(prevClose) && prevClose !== 0)
        ? (change / prevClose) * 100
        : null;
    return {
        'Global Quote': {
            '01. symbol': symbol,
            '02. open': n(quote?.regularMarketOpen),
            '03. high': n(quote?.regularMarketDayHigh),
            '04. low': n(quote?.regularMarketDayLow),
            '05. price': n(price),
            '06. volume': n(quote?.regularMarketVolume),
            '07. latest trading day': isoDay(quote?.regularMarketTime),
            '08. previous close': n(prevClose),
            '09. change': n(change),
            '10. change percent': Number.isFinite(pct) ? `${pct.toFixed(4)}%` : ''
        }
    };
}

function buildOverview(symbol, summary) {
    const ap = summary?.assetProfile || {};
    const sd = summary?.summaryDetail || {};
    const ks = summary?.defaultKeyStatistics || {};
    const fd = summary?.financialData || {};
    const price = summary?.price || {};
    return {
        Symbol: symbol,
        Name: ap.longName || price.longName || price.shortName || symbol,
        Description: ap.longBusinessSummary || '',
        CIK: '',
        Exchange: ap.exchange || price.exchangeName || '',
        Currency: sd.currency || price.currency || 'USD',
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
        DividendDate: isoDay(sd.dividendDate) || '',
        ExDividendDate: isoDay(sd.exDividendDate) || '',
        DebtToEquity: n(fd.debtToEquity)
    };
}

// FTS rows carry many more fields than quoteSummary's deprecated statement
// modules. We map them into the Alpha-shape envelope the frontend expects.
function buildIncomeReportsFromFTS(rows) {
    return (rows || []).map((r) => ({
        fiscalDateEnding: isoDay(r.date) || '',
        reportedCurrency: 'USD',
        grossProfit: n(r.grossProfit),
        totalRevenue: n(r.totalRevenue),
        costOfRevenue: n(r.costOfRevenue ?? r.reconciledCostOfRevenue),
        costofGoodsAndServicesSold: n(r.costOfRevenue ?? r.reconciledCostOfRevenue),
        operatingIncome: n(r.operatingIncome ?? r.totalOperatingIncomeAsReported),
        sellingGeneralAndAdministrative: n(r.sellingGeneralAndAdministration),
        researchAndDevelopment: n(r.researchAndDevelopment),
        operatingExpenses: n(r.operatingExpense ?? r.totalExpenses),
        investmentIncomeNet: '',
        netInterestIncome: n(r.netInterestIncome),
        interestIncome: n(r.interestIncome ?? r.interestIncomeNonOperating),
        interestExpense: n(r.interestExpense ?? r.interestExpenseNonOperating),
        nonInterestIncome: '',
        otherNonOperatingIncome: n(r.otherNonOperatingIncomeExpenses ?? r.otherIncomeExpense),
        depreciation: n(r.reconciledDepreciation),
        depreciationAndAmortization: n(r.reconciledDepreciation),
        incomeBeforeTax: n(r.pretaxIncome),
        incomeTaxExpense: n(r.taxProvision),
        interestAndDebtExpense: n(r.interestExpense ?? r.interestExpenseNonOperating),
        netIncomeFromContinuingOperations: n(r.netIncomeContinuousOperations ?? r.netIncomeFromContinuingOperationNetMinorityInterest),
        comprehensiveIncomeNetOfTax: n(r.netIncomeCommonStockholders),
        ebit: n(r.EBIT),
        ebitda: n(r.EBITDA ?? r.normalizedEBITDA),
        netIncome: n(r.netIncome ?? r.netIncomeIncludingNoncontrollingInterests),
        eps: n(r.basicEPS),
        dilutedEPS: n(r.dilutedEPS)
    }));
}

// Legacy quoteSummary-shaped builder kept as a fallback for tickers where FTS
// returns nothing (very rare since Yahoo migrated to FTS as the canonical source).
function buildIncomeReports(history) {
    const list = history?.incomeStatementHistory || [];
    return list.map((r) => ({
        fiscalDateEnding: isoDay(r.endDate) || '',
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

function buildBalanceReportsFromFTS(rows) {
    return (rows || []).map((r) => ({
        fiscalDateEnding: isoDay(r.date) || '',
        reportedCurrency: 'USD',
        totalAssets: n(r.totalAssets),
        totalCurrentAssets: n(r.currentAssets),
        cashAndCashEquivalentsAtCarryingValue: n(r.cashAndCashEquivalents ?? r.cashFinancial),
        cashAndShortTermInvestments: n(r.cashCashEquivalentsAndShortTermInvestments),
        inventory: n(r.inventory),
        currentNetReceivables: n(r.receivables ?? r.accountsReceivable),
        totalNonCurrentAssets: n(r.totalNonCurrentAssets),
        propertyPlantEquipment: n(r.netPPE ?? r.grossPPE),
        accumulatedDepreciationAmortizationPPE: n(r.accumulatedDepreciation),
        intangibleAssets: '',
        intangibleAssetsExcludingGoodwill: '',
        goodwill: '',
        investments: n(r.investmentsAndAdvances),
        longTermInvestments: n(r.investmentinFinancialAssets ?? r.investmentsAndAdvances),
        shortTermInvestments: n(r.otherShortTermInvestments),
        otherCurrentAssets: n(r.otherCurrentAssets),
        otherNonCurrentAssets: n(r.otherNonCurrentAssets),
        totalLiabilities: n(r.totalLiabilitiesNetMinorityInterest),
        totalCurrentLiabilities: n(r.currentLiabilities),
        currentAccountsPayable: n(r.accountsPayable ?? r.payables),
        deferredRevenue: n(r.currentDeferredRevenue),
        currentDebt: n(r.currentDebt),
        shortTermDebt: n(r.currentDebt),
        totalNonCurrentLiabilities: n(r.totalNonCurrentLiabilitiesNetMinorityInterest),
        capitalLeaseObligations: n(r.leases),
        longTermDebt: n(r.longTermDebt),
        currentLongTermDebt: n(r.currentDebt),
        longTermDebtNoncurrent: n(r.longTermDebt),
        shortLongTermDebtTotal: n(r.totalDebt),
        otherCurrentLiabilities: n(r.otherCurrentLiabilities),
        otherNonCurrentLiabilities: n(r.otherNonCurrentLiabilities),
        totalShareholderEquity: n(r.stockholdersEquity ?? r.totalEquityGrossMinorityInterest),
        treasuryStock: '',
        retainedEarnings: n(r.retainedEarnings),
        commonStock: n(r.commonStock ?? r.capitalStock),
        commonStockSharesOutstanding: n(r.ordinarySharesNumber ?? r.shareIssued)
    }));
}

function buildBalanceReports(history) {
    const list = history?.balanceSheetStatements || [];
    return list.map((r) => ({
        fiscalDateEnding: isoDay(r.endDate) || '',
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

function buildCashReportsFromFTS(rows) {
    return (rows || []).map((r) => {
        const capex = r.capitalExpenditure;
        const div = r.cashDividendsPaid ?? r.commonStockDividendPaid;
        return {
            fiscalDateEnding: isoDay(r.date) || '',
            reportedCurrency: 'USD',
            operatingCashflow: n(r.operatingCashFlow ?? r.cashFlowFromContinuingOperatingActivities),
            paymentsForOperatingActivities: '',
            proceedsFromOperatingActivities: '',
            changeInOperatingLiabilities: n(r.changeInPayablesAndAccruedExpense),
            changeInOperatingAssets: '',
            depreciationDepletionAndAmortization: n(r.depreciationAmortizationDepletion ?? r.depreciationAndAmortization),
            capitalExpenditures: n(Number.isFinite(capex) ? -Math.abs(capex) : null),
            changeInReceivables: n(r.changesInAccountReceivables ?? r.changeInReceivables),
            changeInInventory: n(r.changeInInventory),
            profitLoss: n(r.netIncomeFromContinuingOperations),
            cashflowFromInvestment: n(r.cashFlowFromContinuingInvestingActivities ?? r.investingCashFlow),
            cashflowFromFinancing: n(r.cashFlowFromContinuingFinancingActivities ?? r.financingCashFlow),
            proceedsFromRepaymentsOfShortTermDebt: n(r.netShortTermDebtIssuance),
            paymentsForRepurchaseOfCommonStock: n(r.repurchaseOfCapitalStock != null ? -Math.abs(r.repurchaseOfCapitalStock) : null),
            paymentsForRepurchaseOfEquity: '',
            paymentsForRepurchaseOfPreferredStock: '',
            dividendPayout: n(Number.isFinite(div) ? -Math.abs(div) : null),
            dividendPayoutCommonStock: n(Number.isFinite(div) ? -Math.abs(div) : null),
            dividendPayoutPreferredStock: '',
            proceedsFromIssuanceOfCommonStock: n(r.netCommonStockIssuance),
            proceedsFromIssuanceOfLongTermDebtAndCapitalSecuritiesNet: n(r.longTermDebtIssuance),
            proceedsFromIssuanceOfPreferredStock: '',
            proceedsFromRepurchaseOfEquity: '',
            proceedsFromSaleOfTreasuryStock: '',
            changeInCashAndCashEquivalents: n(r.changesInCash),
            changeInExchangeRate: '',
            netIncome: n(r.netIncomeFromContinuingOperations)
        };
    });
}

function buildCashReports(history) {
    const list = history?.cashflowStatements || [];
    return list.map((r) => ({
        fiscalDateEnding: isoDay(r.endDate) || '',
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

function buildDailySeries(symbol, chart, outputSize) {
    const quotes = chart?.quotes || [];
    const series = {};
    for (const q of quotes) {
        if (!q || !q.date) continue;
        const day = isoDay(q.date);
        if (!day) continue;
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
            '1. Information': 'Daily Time Series (Yahoo Finance, shaped like Alpha Vantage)',
            '2. Symbol': symbol,
            '3. Last Refreshed': Object.keys(series).sort().pop() || '',
            '4. Output Size': outputSize === 'full' ? 'Full size' : 'Compact'
        },
        'Time Series (Daily)': series
    };
}

function buildMonthlySeries(symbol, chart) {
    const quotes = chart?.quotes || [];
    const series = {};
    for (const q of quotes) {
        if (!q || !q.date) continue;
        const day = isoDay(q.date);
        if (!day) continue;
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
            '1. Information': 'Monthly Adjusted Time Series (Yahoo Finance, shaped like Alpha Vantage)',
            '2. Symbol': symbol
        },
        'Monthly Adjusted Time Series': series
    };
}

function buildIntraday(symbol, interval, chart) {
    const quotes = chart?.quotes || [];
    const series = {};
    for (const q of quotes) {
        if (!q || !q.date) continue;
        const date = q.date instanceof Date ? q.date : new Date(q.date);
        const stamp = date.toISOString().slice(0, 19).replace('T', ' ');
        series[stamp] = {
            '1. open': n(q.open),
            '2. high': n(q.high),
            '3. low': n(q.low),
            '4. close': n(q.close),
            '5. volume': n(q.volume)
        };
    }
    const key = `Time Series (${interval})`;
    return {
        'Meta Data': {
            '1. Information': 'Intraday (Yahoo Finance, shaped like Alpha Vantage)',
            '2. Symbol': symbol,
            '4. Interval': interval
        },
        [key]: series
    };
}

function buildSymbolSearch(results) {
    const quotes = Array.isArray(results?.quotes) ? results.quotes : [];
    const bestMatches = quotes
        .filter((q) => q && (q.symbol || q.shortname || q.longname))
        .map((q) => ({
            '1. symbol': q.symbol || '',
            '2. name': q.longname || q.shortname || q.symbol || '',
            '3. type': q.quoteType || q.typeDisp || 'Equity',
            '4. region': q.exchDisp || '',
            '5. marketOpen': '',
            '6. marketClose': '',
            '7. timezone': '',
            '8. currency': 'USD',
            '9. matchScore': q.score ? String(q.score) : '1.0'
        }));
    return { bestMatches };
}

function buildMoverRows(rows) {
    if (!Array.isArray(rows)) return [];
    return rows.map((row) => {
        const price = row.regularMarketPrice;
        const change = row.regularMarketChange;
        const pct = row.regularMarketChangePercent;
        return {
            ticker: row.symbol || '',
            price: Number.isFinite(price) ? price.toFixed(2) : '',
            change_amount: Number.isFinite(change) ? change.toFixed(2) : '',
            change_percentage: Number.isFinite(pct) ? `${pct.toFixed(2)}%` : '',
            volume: Number.isFinite(row.regularMarketVolume) ? String(row.regularMarketVolume) : ''
        };
    });
}

function buildNewsItem(item) {
    const ms = item?.providerPublishTime
        ? (item.providerPublishTime > 2e10 ? item.providerPublishTime : item.providerPublishTime * 1000)
        : null;
    const date = ms ? new Date(ms) : null;
    const stamp = (date && !Number.isNaN(date.getTime())) ? date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '') : '';
    const thumb = item?.thumbnail?.resolutions || [];
    const banner = thumb.length ? thumb[0].url : '';
    const relatedTickers = Array.isArray(item?.relatedTickers) ? item.relatedTickers : [];

    // No sentiment data from Yahoo. We still expose ticker_sentiment so the
    // frontend's trending-tickers code (which ranks by mentions when scores
    // are zero) keeps working — relevance defaults to 1 per mention, sentiment 0.
    const tickerSentiment = relatedTickers.map((t) => ({
        ticker: String(t || '').toUpperCase(),
        relevance_score: '1',
        ticker_sentiment_score: '0',
        ticker_sentiment_label: 'Neutral'
    }));

    return {
        title: item?.title || '',
        url: item?.link || item?.url || '',
        time_published: stamp,
        authors: item?.publisher ? [item.publisher] : [],
        summary: item?.summary || '',
        banner_image: banner,
        source: item?.publisher || 'Yahoo Finance',
        source_domain: '',
        category_within_source: item?.type || '',
        topics: [],
        overall_sentiment_score: 0,
        overall_sentiment_label: 'Neutral',
        ticker_sentiment: tickerSentiment
    };
}

// ---- Fetchers ----

async function fetchQuote(symbol) {
    const ys = toYahooSymbol(symbol);
    const q = await yf.quote(ys);
    return buildGlobalQuote(symbol, q);
}

async function fetchOverview(symbol) {
    const ys = toYahooSymbol(symbol);
    const summary = await yf.quoteSummary(ys, {
        modules: ['assetProfile', 'price', 'summaryDetail', 'defaultKeyStatistics', 'financialData']
    });
    return buildOverview(symbol, summary);
}

// FTS gives ~5 rows with ~30-60 fields each (vs quoteSummary's ~10 fields).
// We pull annual + quarterly in parallel and sort newest-first to match
// what Alpha Vantage returned. Yahoo's retention for the oldest period in
// the response is poor — that row usually has 5-10% of fields populated
// while younger periods have 80%+. We drop those sparse rows so every
// rendered column in the frontend is actually filled.
async function fetchFtsRows(symbol, module) {
    const ys = toYahooSymbol(symbol);
    const now = new Date();
    const start = new Date(now); start.setFullYear(now.getFullYear() - 10);
    const [annual, quarterly] = await Promise.allSettled([
        yf.fundamentalsTimeSeries(ys, { period1: start, period2: now, type: 'annual', module }),
        yf.fundamentalsTimeSeries(ys, { period1: start, period2: now, type: 'quarterly', module })
    ]);
    const sortByDate = (rows) => (rows || []).slice().sort((a, b) => new Date(b.date) - new Date(a.date));
    // Count populated numeric fields (excludes meta keys date/TYPE/periodType).
    const fillCount = (row) => {
        let c = 0;
        for (const [k, v] of Object.entries(row || {})) {
            if (k === 'date' || k === 'TYPE' || k === 'periodType') continue;
            if (Number.isFinite(v) && v !== 0) c++;
        }
        return c;
    };
    // Drop rows that are 2x sparser than the best row — keeps the response
    // free of "ghost" oldest-period rows that render as a column of dashes.
    const pruneSparse = (rows) => {
        if (!rows.length) return rows;
        const best = rows.reduce((m, r) => Math.max(m, fillCount(r)), 0);
        if (best < 4) return rows; // not enough data anywhere — keep everything
        const threshold = Math.max(4, Math.ceil(best * 0.4));
        return rows.filter((r) => fillCount(r) >= threshold);
    };
    return {
        annual: pruneSparse(sortByDate(annual.status === 'fulfilled' ? annual.value : [])),
        quarterly: pruneSparse(sortByDate(quarterly.status === 'fulfilled' ? quarterly.value : []))
    };
}

// Yahoo quoteSummary still carries a handful of statement fields (notably
// interestExpense, interestIncome, totalOtherIncomeExpenseNet) even when
// FTS doesn't. We use it as a per-row backfill keyed by fiscalDateEnding.
async function fetchQuoteSummaryStatements(symbol) {
    const ys = toYahooSymbol(symbol);
    try {
        const s = await yf.quoteSummary(ys, {
            modules: [
                'incomeStatementHistory', 'incomeStatementHistoryQuarterly',
                'balanceSheetHistory', 'balanceSheetHistoryQuarterly',
                'cashflowStatementHistory', 'cashflowStatementHistoryQuarterly'
            ]
        });
        return s || {};
    } catch (_) { return {}; }
}

function mergeNonEmpty(target, source) {
    for (const r of target) {
        const match = source.find((s) => s.fiscalDateEnding === r.fiscalDateEnding);
        if (!match) continue;
        for (const [k, v] of Object.entries(match)) {
            if ((r[k] === '' || r[k] === null || r[k] === undefined) && v !== '' && v !== null && v !== undefined) {
                r[k] = v;
            }
        }
    }
    return target;
}

// Yahoo statements come back in the company's REPORTING currency — JPY for
// Toyota's ADR, EUR for SAP's — not USD. Stamp rows honestly instead of the
// old hardcoded 'USD' so downstream consumers can warn the user.
const _finCurrencyCache = new Map();
async function financialCurrency(symbol) {
    const ys = toYahooSymbol(symbol);
    if (_finCurrencyCache.has(ys)) return _finCurrencyCache.get(ys);
    let cur = 'USD';
    try {
        const s = await yf.quoteSummary(ys, { modules: ['financialData'] });
        cur = (s && s.financialData && s.financialData.financialCurrency) || 'USD';
    } catch (_) { /* default USD */ }
    _finCurrencyCache.set(ys, cur);
    return cur;
}
function stampCurrency(reports, cur) {
    for (const r of reports) r.reportedCurrency = cur;
    return reports;
}

async function fetchIncomeStatement(symbol) {
    const [{ annual, quarterly }, qs, cur] = await Promise.all([
        fetchFtsRows(symbol, 'financials'),
        fetchQuoteSummaryStatements(symbol),
        financialCurrency(symbol)
    ]);
    const annualReports = buildIncomeReportsFromFTS(annual);
    const quarterlyReports = buildIncomeReportsFromFTS(quarterly);
    mergeNonEmpty(annualReports, buildIncomeReports(qs.incomeStatementHistory));
    mergeNonEmpty(quarterlyReports, buildIncomeReports(qs.incomeStatementHistoryQuarterly));
    return { symbol, annualReports: stampCurrency(annualReports, cur), quarterlyReports: stampCurrency(quarterlyReports, cur) };
}

async function fetchBalanceSheet(symbol) {
    const [{ annual, quarterly }, qs, cur] = await Promise.all([
        fetchFtsRows(symbol, 'balance-sheet'),
        fetchQuoteSummaryStatements(symbol),
        financialCurrency(symbol)
    ]);
    const annualReports = buildBalanceReportsFromFTS(annual);
    const quarterlyReports = buildBalanceReportsFromFTS(quarterly);
    mergeNonEmpty(annualReports, buildBalanceReports(qs.balanceSheetHistory));
    mergeNonEmpty(quarterlyReports, buildBalanceReports(qs.balanceSheetHistoryQuarterly));
    return { symbol, annualReports: stampCurrency(annualReports, cur), quarterlyReports: stampCurrency(quarterlyReports, cur) };
}

async function fetchCashFlow(symbol) {
    const [{ annual, quarterly }, qs, cur] = await Promise.all([
        fetchFtsRows(symbol, 'cash-flow'),
        fetchQuoteSummaryStatements(symbol),
        financialCurrency(symbol)
    ]);
    const annualReports = buildCashReportsFromFTS(annual);
    const quarterlyReports = buildCashReportsFromFTS(quarterly);
    mergeNonEmpty(annualReports, buildCashReports(qs.cashflowStatementHistory));
    mergeNonEmpty(quarterlyReports, buildCashReports(qs.cashflowStatementHistoryQuarterly));
    return { symbol, annualReports: stampCurrency(annualReports, cur), quarterlyReports: stampCurrency(quarterlyReports, cur) };
}

async function fetchDaily(symbol, outputsize = 'compact') {
    const ys = toYahooSymbol(symbol);
    const now = new Date();
    const start = new Date(now);
    if (outputsize === 'full') start.setFullYear(now.getFullYear() - 20);
    else start.setDate(now.getDate() - 200);
    const chart = await yf.chart(ys, { period1: start, period2: now, interval: '1d' });
    return buildDailySeries(symbol, chart, outputsize);
}

async function fetchMonthly(symbol) {
    const ys = toYahooSymbol(symbol);
    const now = new Date();
    const start = new Date(now); start.setFullYear(now.getFullYear() - 20);
    const chart = await yf.chart(ys, { period1: start, period2: now, interval: '1mo' });
    return buildMonthlySeries(symbol, chart);
}

// Historical cash dividend ex-dates and amounts, oldest-first, via the chart
// endpoint's dividend events. Returns [{ exDate: 'YYYY-MM-DD', amount: number }];
// an empty array for non-payers. A 15-year window keeps the payload bounded.
async function fetchDividendHistory(symbol) {
    const ys = toYahooSymbol(symbol);
    const now = Math.floor(Date.now() / 1000);
    const chart = await yf.chart(ys, {
        interval: '1mo',
        events: 'div',
        period1: now - 15 * 365 * 86400,
        period2: now
    });
    return ((chart && chart.events && chart.events.dividends) || [])
        .map((d) => {
            const amount = typeof d.amount === 'number' ? d.amount : Number(d.amount);
            return { exDate: isoDay(d.date), amount: Number.isFinite(amount) ? amount : null };
        })
        .filter((d) => d.exDate && d.amount !== null)
        .sort((a, b) => a.exDate.localeCompare(b.exDate));
}

async function fetchIntraday(symbol, interval = '5min') {
    const ys = toYahooSymbol(symbol);
    const map = { '1min': '1m', '5min': '5m', '15min': '15m', '30min': '30m', '60min': '60m' };
    const yfInterval = map[interval] || '5m';
    const now = new Date();
    const start = new Date(now); start.setDate(now.getDate() - 1);
    const chart = await yf.chart(ys, { period1: start, period2: now, interval: yfInterval });
    return buildIntraday(symbol, interval, chart);
}

async function fetchSymbolSearch(keywords) {
    // Use Yahoo's JSON endpoint directly. The yahoo-finance2 search wrapper can
    // silently discard ETF/MUTUALFUND rows after upstream schema changes (seen
    // on Render while quote/profile still worked), leaving autocomplete empty.
    const response = await axios.get('https://query2.finance.yahoo.com/v1/finance/search', {
        params: { q: keywords, quotesCount: 10, newsCount: 0, region: 'US', lang: 'en-US' },
        headers: { 'User-Agent': 'Mozilla/5.0 stockportfolio.pro asset search' },
        timeout: 12000
    });
    return buildSymbolSearch(response && response.data ? response.data : {});
}

// Yahoo Finance's predefined screener endpoint. yahoo-finance2's wrapper
// fails strict schema validation when Yahoo drifts (often), so we call
// the JSON endpoint directly.
async function fetchScreener(scrId, count = 25) {
    const url = 'https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved';
    const resp = await axios.get(url, {
        params: { formatted: false, lang: 'en-US', region: 'US', scrIds: scrId, count },
        headers: { 'User-Agent': 'Mozilla/5.0 stockportfolio.pro' },
        timeout: 12000
    });
    return resp?.data?.finance?.result?.[0]?.quotes || [];
}

async function fetchMovers() {
    const [gainers, losers, actives] = await Promise.allSettled([
        fetchScreener('day_gainers', 25),
        fetchScreener('day_losers', 25),
        fetchScreener('most_actives', 25)
    ]);
    const rowsOf = (r) => (r.status === 'fulfilled' ? r.value : []);
    return {
        metadata: 'Top gainers/losers/actives (Yahoo Finance, shaped like Alpha Vantage)',
        last_updated: new Date().toISOString(),
        top_gainers: buildMoverRows(rowsOf(gainers)),
        top_losers: buildMoverRows(rowsOf(losers)),
        most_actively_traded: buildMoverRows(rowsOf(actives))
    };
}

// Broad-market query basket used when the request doesn't filter by ticker.
// Mixing index ETFs, sector ETFs, mega-caps, and topical keywords spreads
// the news mix across different desks (markets, earnings, macro, tech).
const BROAD_MARKET_QUERIES = [
    'SPY', 'QQQ', 'DIA', 'IWM',
    'AAPL', 'NVDA', 'MSFT', 'GOOGL', 'TSLA', 'AMZN', 'META',
    'XLF', 'XLE', 'XLK',
    'stocks', 'market', 'earnings', 'economy', 'wall street'
];

// Yahoo Finance RSS feed for the general headline index. Free, no key, and
// returns ~25 broad-market items refreshed throughout the day.
const YAHOO_RSS_INDEX = 'https://finance.yahoo.com/news/rssindex';
const YAHOO_RSS_TICKER = (symbol) => `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`;

function parseRssItems(xml) {
    if (!xml) return [];
    const items = [];
    const blockRe = /<item\b[^>]*>([\s\S]*?)<\/item>/gi;
    let match;
    while ((match = blockRe.exec(xml)) !== null) {
        const block = match[1];
        const grab = (tag) => {
            const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
            const m = re.exec(block);
            if (!m) return '';
            return m[1]
                .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
                .replace(/<[^>]+>/g, '')
                .trim();
        };
        const title = grab('title');
        const link = grab('link');
        const pub = grab('pubDate');
        const desc = grab('description');
        const source = grab('source') || grab('dc:creator');
        if (!title || !link) continue;
        const ts = pub ? Date.parse(pub) : NaN;
        const time = Number.isFinite(ts)
            ? new Date(ts).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, '')
            : '';
        // Some Yahoo RSS items embed <img src="..."> inside the description.
        const imgMatch = block.match(/<media:thumbnail\b[^>]*url="([^"]+)"|<enclosure\b[^>]*url="([^"]+)"/i);
        const banner = imgMatch ? (imgMatch[1] || imgMatch[2]) : '';
        items.push({
            uuid: link,
            title,
            link,
            summary: desc,
            publisher: source || 'Yahoo Finance',
            providerPublishTime: Number.isFinite(ts) ? Math.floor(ts / 1000) : null,
            thumbnail: banner ? { resolutions: [{ url: banner }] } : null,
            relatedTickers: []
        });
    }
    return items;
}

async function fetchYahooRss(url) {
    try {
        const resp = await axios.get(url, {
            headers: { 'User-Agent': 'Mozilla/5.0 stockportfolio.pro', Accept: 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8' },
            timeout: 10000,
            responseType: 'text'
        });
        return parseRssItems(resp.data || '');
    } catch (_) {
        return [];
    }
}

async function fetchNews(params = {}) {
    const tickers = String(params.tickers || '').split(',').map((t) => t.trim()).filter(Boolean);
    const limit = Math.max(1, Math.min(80, Number(params.limit) || 40));

    // Pick the source list: caller-supplied tickers, or our broad-market basket.
    const queries = tickers.length
        ? tickers.slice(0, 8).map(toYahooSymbol)
        : BROAD_MARKET_QUERIES;
    const perQuery = tickers.length
        ? Math.max(8, Math.ceil(limit / Math.max(1, tickers.length)) + 4)
        : Math.max(8, Math.ceil(limit / 6));

    // Yahoo's search-based news + RSS feeds run in parallel — each adds ~10-25
    // headlines, dedup keeps the total tidy.
    const tasks = queries.map((q) => yf.search(q, { quotesCount: 0, newsCount: perQuery }).catch(() => null));
    tasks.push(fetchYahooRss(YAHOO_RSS_INDEX));
    if (tickers.length) {
        for (const t of tickers.slice(0, 4)) {
            tasks.push(fetchYahooRss(YAHOO_RSS_TICKER(toYahooSymbol(t))));
        }
    }

    const settled = await Promise.allSettled(tasks);
    const seenUrl = new Set();
    const seenTitle = new Set();
    const feed = [];
    for (const r of settled) {
        if (r.status !== 'fulfilled' || !r.value) continue;
        const list = Array.isArray(r.value) ? r.value : (r.value.news || []);
        for (const item of list) {
            const url = String(item?.link || item?.uuid || '').split('?')[0].split('#')[0];
            const titleKey = String(item?.title || '').trim().toLowerCase().slice(0, 80);
            if (!url && !titleKey) continue;
            if (url && seenUrl.has(url)) continue;
            if (titleKey && seenTitle.has(titleKey)) continue;
            if (url) seenUrl.add(url);
            if (titleKey) seenTitle.add(titleKey);
            feed.push(buildNewsItem(item));
        }
    }

    feed.sort((a, b) => (b.time_published || '').localeCompare(a.time_published || ''));
    return {
        items: feed.length,
        sentiment_score_definition: 'unavailable',
        feed: feed.slice(0, limit)
    };
}

// ---- Unified dispatcher ----

async function fetchFromYahoo(functionName, params = {}) {
    const symbol = String(params.symbol || '').toUpperCase();
    switch (functionName) {
        case 'GLOBAL_QUOTE': return fetchQuote(symbol);
        case 'OVERVIEW': return fetchOverview(symbol);
        case 'INCOME_STATEMENT': return fetchIncomeStatement(symbol);
        case 'BALANCE_SHEET': return fetchBalanceSheet(symbol);
        case 'CASH_FLOW': return fetchCashFlow(symbol);
        case 'TIME_SERIES_DAILY_ADJUSTED': return fetchDaily(symbol, params.outputsize);
        case 'TIME_SERIES_MONTHLY_ADJUSTED': return fetchMonthly(symbol);
        case 'TIME_SERIES_INTRADAY': return fetchIntraday(symbol, params.interval);
        case 'SYMBOL_SEARCH': return fetchSymbolSearch(params.keywords);
        case 'TOP_GAINERS_LOSERS': return fetchMovers();
        case 'NEWS_SENTIMENT': return fetchNews(params);
        default: {
            const err = new Error(`Unsupported function: ${functionName}`);
            err.status = 501;
            throw err;
        }
    }
}

// Major holders, top institutions and insider activity for the Ownership
// section (v2 company page).
async function fetchOwnership(symbol) {
    const r = await yf.quoteSummary(toYahooSymbol(symbol), {
        modules: ['majorHoldersBreakdown', 'institutionOwnership', 'insiderTransactions', 'netSharePurchaseActivity']
    });
    const mh = (r && r.majorHoldersBreakdown) || {};
    const inst = (((r && r.institutionOwnership) || {}).ownershipList || []).map((o) => ({
        organization: o.organization || '',
        pctHeld: Number.isFinite(o.pctHeld) ? o.pctHeld : null,
        value: Number.isFinite(o.value) ? o.value : null,
        reportDate: o.reportDate ? new Date(o.reportDate).toISOString().slice(0, 10) : null
    }));
    const insiders = (((r && r.insiderTransactions) || {}).transactions || []).slice(0, 40).map((t) => {
        const text = String(t.transactionText || '');
        const side = /purchase|buy/i.test(text) ? 'buy' : (/sale|sell/i.test(text) ? 'sell' : 'other');
        return {
            name: t.filerName || '',
            relation: t.filerRelation || '',
            side,
            text: text.slice(0, 120),
            date: t.startDate ? new Date(t.startDate).toISOString().slice(0, 10) : null,
            shares: Number.isFinite(t.shares) ? t.shares : null,
            value: Number.isFinite(t.value) ? t.value : null
        };
    });
    const net = (r && r.netSharePurchaseActivity) || {};
    return {
        insidersPctHeld: Number.isFinite(mh.insidersPercentHeld) ? mh.insidersPercentHeld : null,
        institutionsPctHeld: Number.isFinite(mh.institutionsPercentHeld) ? mh.institutionsPercentHeld : null,
        institutionsCount: Number.isFinite(mh.institutionsCount) ? mh.institutionsCount : null,
        topInstitutions: inst,
        insiderTransactions: insiders,
        insiderNet: {
            period: net.period || null,
            buyCount: Number.isFinite(net.buyInfoCount) ? net.buyInfoCount : null,
            buyShares: Number.isFinite(net.buyInfoShares) ? net.buyInfoShares : null,
            sellCount: Number.isFinite(net.sellInfoCount) ? net.sellInfoCount : null,
            sellShares: Number.isFinite(net.sellInfoShares) ? net.sellInfoShares : null,
            netShares: Number.isFinite(net.netInfoShares) ? net.netInfoShares : null
        }
    };
}

// Free news search (no key): Yahoo's search endpoint with news-only results.
async function fetchNewsSearch(query, count = 10) {
    const r = await yf.search(String(query || '').slice(0, 120), { quotesCount: 0, newsCount: Math.min(15, count) });
    return (r.news || []).map((n) => ({
        title: n.title,
        publisher: n.publisher,
        url: n.link,
        published: n.providerPublishTime ? new Date(n.providerPublishTime).toISOString().slice(0, 10) : ''
    }));
}

module.exports = {
    fetchFromYahoo,
    fetchNewsSearch,
    fetchQuote,
    fetchOverview,
    fetchIncomeStatement,
    fetchBalanceSheet,
    fetchCashFlow,
    fetchDaily,
    fetchMonthly,
    fetchDividendHistory,
    fetchIntraday,
    fetchSymbolSearch,
    fetchMovers,
    fetchNews,
    fetchOwnership,
    toYahooSymbol
};
