'use strict';

// Normalized metadata for stocks, ETFs and mutual funds. This module is kept
// separate from the legacy company-fundamentals path so existing stock pages
// continue to use their SEC-backed data without behavioural changes.
const YahooFinance = require('yahoo-finance2').default;

const noop = () => {};
const yahoo = new YahooFinance({
    suppressNotices: ['yahooSurvey', 'ripHistorical'],
    logger: { info: noop, warn: noop, error: noop, debug: noop, dir: noop },
    validation: { logErrors: false, logOptionsErrors: false }
});

const cache = new Map();
const TTL_MS = 30 * 60 * 1000;

function symbolKey(value) {
    return String(value || '').toUpperCase().trim().replace(/\./g, '-');
}

function number(value) {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'object' && value && 'raw' in value) value = value.raw;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

function date(value) {
    if (!value) return null;
    const d = value instanceof Date ? value : new Date(value);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function normalizeAssetType(value) {
    const type = String(value || '').toUpperCase().replace(/[^A-Z]/g, '');
    if (type === 'ETF') return 'etf';
    if (type === 'MUTUALFUND' || type === 'FUND') return 'mutual_fund';
    if (type === 'CRYPTOCURRENCY') return 'crypto';
    if (type === 'EQUITY' || type === 'STOCK') return 'stock';
    return 'other';
}

function assetTypeLabel(value) {
    return ({ stock: 'Stock', etf: 'ETF', mutual_fund: 'Mutual fund', crypto: 'Crypto', other: 'Asset' })[normalizeAssetType(value)] || 'Asset';
}

function isFundAsset(value) {
    const type = normalizeAssetType(value);
    return type === 'etf' || type === 'mutual_fund';
}

function entries(value) {
    if (!value) return [];
    if (Array.isArray(value)) return value;
    return Object.entries(value).map(([name, weight]) => ({ name, weight }));
}

function normalizeWeights(value) {
    return entries(value).map((row) => ({
        name: row.name || row.sector || row.rating || '',
        weight: number(row.weight ?? row.value)
    })).filter((row) => row.name && row.weight !== null);
}

async function fetchAssetProfile(symbol, { fundDetails = true } = {}) {
    const key = symbolKey(symbol);
    if (!key || !/^[A-Z0-9\-^=]{1,20}$/.test(key)) throw Object.assign(new Error('Invalid symbol'), { status: 400 });
    // Portfolio mutations only need identity, type and the live quote. Keep
    // that lightweight response separate from the full fund dossier cache so
    // adding an ETF/fund does not wait for Yahoo's larger quoteSummary call.
    const cacheKey = `${key}:${fundDetails ? 'full' : 'basic'}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

    let quote;
    try { quote = await yahoo.quote(key); }
    catch (error) { throw Object.assign(new Error(`No market data found for ${symbol}`), { status: 404, cause: error }); }

    const assetType = normalizeAssetType(quote.quoteType || quote.typeDisp);
    let summary = {};
    if (fundDetails && isFundAsset(assetType)) {
        summary = await yahoo.quoteSummary(key, {
            modules: ['topHoldings', 'fundPerformance', 'fundProfile', 'summaryDetail', 'defaultKeyStatistics', 'price']
        }, { validateResult: false }).catch(() => ({}));
    }

    const sd = summary.summaryDetail || {};
    const ks = summary.defaultKeyStatistics || {};
    const fp = summary.fundPerformance || {};
    const fund = summary.fundProfile || {};
    const fees = fund.feesExpensesInvestment || {};
    const th = summary.topHoldings || {};
    const overview = fp.performanceOverview || {};
    const trailing = fp.trailingReturns || {};
    const currentPrice = number(quote.regularMarketPrice ?? summary.price?.regularMarketPrice);
    const previousClose = number(quote.regularMarketPreviousClose ?? sd.previousClose);
    const changePercent = number(quote.regularMarketChangePercent) ??
        (currentPrice !== null && previousClose ? (currentPrice / previousClose - 1) * 100 : null);

    const value = {
        symbol: String(symbol || '').toUpperCase().trim(),
        name: quote.longName || quote.shortName || summary.price?.longName || key,
        assetType,
        assetTypeLabel: assetTypeLabel(assetType),
        quoteType: quote.quoteType || quote.typeDisp || '',
        exchange: quote.fullExchangeName || quote.exchange || summary.price?.exchangeName || '',
        currency: quote.currency || summary.price?.currency || 'USD',
        price: currentPrice,
        previousClose,
        changePercent,
        asOf: date(quote.regularMarketTime),
        category: ks.category || fund.categoryName || fp.fundCategoryName || '',
        fundFamily: ks.fundFamily || fund.family || '',
        totalAssets: number(ks.totalAssets ?? sd.totalAssets ?? fees.totalNetAssets),
        expenseRatio: number(ks.annualReportExpenseRatio ?? fees.annualReportExpenseRatio ?? fees.netExpRatio ?? fees.grossExpRatio),
        yield: number(ks.yield ?? sd.yield),
        ytdReturn: number(ks.ytdReturn ?? sd.ytdReturn ?? overview.ytdReturnPct),
        beta3Year: number(ks.beta3Year),
        inceptionDate: date(ks.fundInceptionDate),
        rating: number(ks.morningStarOverallRating),
        riskRating: number(ks.morningStarRiskRating),
        turnover: number(ks.annualHoldingsTurnover ?? fees.annualHoldingsTurnover),
        returns: {
            oneMonth: number(trailing.oneMonth),
            threeMonth: number(trailing.threeMonth),
            oneYear: number(trailing.oneYear),
            threeYear: number(trailing.threeYear),
            fiveYear: number(trailing.fiveYear),
            tenYear: number(trailing.tenYear)
        },
        performance: {
            yearsUp: number(overview.numYearsUp),
            yearsDown: number(overview.numYearsDown),
            bestOneYear: number(overview.bestOneYrTotalReturn),
            worstOneYear: number(overview.worstOneYrTotalReturn)
        },
        allocations: {
            cash: number(th.cashPosition),
            stock: number(th.stockPosition),
            bond: number(th.bondPosition),
            other: number(th.otherPosition),
            sectors: normalizeWeights(th.sectorWeightings),
            bondRatings: normalizeWeights(th.bondRatings)
        },
        topHoldings: (th.holdings || []).slice(0, 15).map((holding) => ({
            symbol: holding.symbol || '',
            name: holding.holdingName || holding.symbol || '',
            weight: number(holding.holdingPercent)
        })).filter((holding) => holding.name),
        risk: (((fp.riskOverviewStatistics || {}).riskStatistics) || []).map((row) => ({
            period: row.year || row.period || '',
            alpha: number(row.alpha), beta: number(row.beta), standardDeviation: number(row.stdDev),
            sharpeRatio: number(row.sharpeRatio), rSquared: number(row.rSquared)
        })),
        supports: {
            portfolio: true, quote: true, priceHistory: true, news: true, ask: true,
            fundProfile: isFundAsset(assetType),
            financialStatements: assetType === 'stock', filings: assetType === 'stock',
            reverseDcf: assetType === 'stock', insiders: assetType === 'stock'
        },
        source: 'Yahoo Finance'
    };
    cache.set(cacheKey, { at: Date.now(), value });
    if (cache.size > 1000) cache.delete(cache.keys().next().value);
    return value;
}

module.exports = { fetchAssetProfile, normalizeAssetType, assetTypeLabel, isFundAsset };
