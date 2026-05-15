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
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });
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
        DividendDate: '',
        ExDividendDate: '',
        DebtToEquity: n(fd.debtToEquity)
    };
}

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

async function fetchIncomeStatement(symbol) {
    const ys = toYahooSymbol(symbol);
    const summary = await yf.quoteSummary(ys, { modules: ['incomeStatementHistory', 'incomeStatementHistoryQuarterly'] });
    return {
        symbol,
        annualReports: buildIncomeReports(summary?.incomeStatementHistory),
        quarterlyReports: buildIncomeReports(summary?.incomeStatementHistoryQuarterly)
    };
}

async function fetchBalanceSheet(symbol) {
    const ys = toYahooSymbol(symbol);
    const summary = await yf.quoteSummary(ys, { modules: ['balanceSheetHistory', 'balanceSheetHistoryQuarterly'] });
    return {
        symbol,
        annualReports: buildBalanceReports(summary?.balanceSheetHistory),
        quarterlyReports: buildBalanceReports(summary?.balanceSheetHistoryQuarterly)
    };
}

async function fetchCashFlow(symbol) {
    const ys = toYahooSymbol(symbol);
    const summary = await yf.quoteSummary(ys, { modules: ['cashflowStatementHistory', 'cashflowStatementHistoryQuarterly'] });
    return {
        symbol,
        annualReports: buildCashReports(summary?.cashflowStatementHistory),
        quarterlyReports: buildCashReports(summary?.cashflowStatementHistoryQuarterly)
    };
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
    const r = await yf.search(keywords, { quotesCount: 10, newsCount: 0 });
    return buildSymbolSearch(r);
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

module.exports = {
    fetchFromYahoo,
    fetchQuote,
    fetchOverview,
    fetchIncomeStatement,
    fetchBalanceSheet,
    fetchCashFlow,
    fetchDaily,
    fetchMonthly,
    fetchIntraday,
    fetchSymbolSearch,
    fetchMovers,
    fetchNews,
    toYahooSymbol
};
