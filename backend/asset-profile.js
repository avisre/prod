'use strict';

// Normalized metadata for stocks, ETFs and mutual funds. This module is kept
// separate from the legacy company-fundamentals path so existing stock pages
// continue to use their SEC-backed data without behavioural changes.
const YahooFinance = require('yahoo-finance2').default;
const stored = require('./stored-fundamentals');
const fundFees = require('./fund-fees');

const noop = () => {};
// Yahoo is the single upstream behind this whole page, and its failures used to
// be invisible: every error channel was silenced, so the 2026-09-05 outage
// logged nine hours of bare "404" with no upstream reason. Schema-validation
// noise stays off (it floods); real errors are surfaced and greppable as [yahoo].
function logYahooError(where, error) {
    const status = (error && (error.response?.status ?? error.status ?? error.code)) || 'n/a';
    console.error(`[yahoo] ${where} failed: ${(error && error.name) || 'Error'} status=${status} ${String((error && error.message) || '').slice(0, 200)}`);
}
const yahoo = new YahooFinance({
    suppressNotices: ['yahooSurvey', 'ripHistorical'],
    logger: { info: noop, warn: noop, error: (...args) => console.error('[yahoo]', ...args), debug: noop, dir: noop },
    validation: { logErrors: false, logOptionsErrors: false }
});

const cache = new Map();
const TTL_MS = 30 * 60 * 1000;
// The filed fee table costs 2-8s on a cold fund and nothing once cached (30
// days). Waiting the full cold path would stall the page, so the lookup is
// raced against this budget and the pending fetch is left running: it lands in
// the cache and the next visitor gets the filed number.
const FEE_TIMEOUT_MS = 2500;

// A profile built while the fee lookup was still in flight holds a fallback
// figure that the background fetch is about to make stale, so it is cached for
// a minute rather than the full half hour. A fund that simply HAS no filed fee
// table (SPY, GLD — grantor trusts, no share classes) is not a timeout and
// keeps the normal TTL; re-fetching those every minute would just burn Yahoo
// calls for an answer that will never change.
const FEE_RETRY_TTL_MS = 60 * 1000;

function withTimeout(promise, ms) {
    return new Promise((resolve) => {
        let settled = false;
        const done = (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve({ value, timedOut: false }); } };
        const timer = setTimeout(() => { if (!settled) { settled = true; resolve({ value: null, timedOut: true }); } }, ms);
        promise.then(done, () => done(null));
    });
}
// A stale fallback is cached only briefly: long enough to stop every request
// re-hitting an upstream that is already refusing us (which is what gets an IP
// rate-limited in the first place), short enough to pick Yahoo back up quickly.
const STALE_TTL_MS = 60 * 1000;

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

// Yahoo returns sector weightings and bond ratings as an array of single-key
// objects — [{realestate: 0.018}, {consumer_cyclical: 0.0931}] — not as
// {name, weight} rows. Reading .name/.weight off that shape yields undefined
// for every row, so the filter below dropped all of them: sector exposure and
// bond ratings rendered empty on every fund page, and the public
// etf-sector-concentration tool returned zero rows (measured 2026-09-07 against
// SPY, which really has 11 sectors). Both shapes are accepted now.
const WEIGHT_LABELS = {
    realestate: 'Real Estate',
    consumer_cyclical: 'Consumer Cyclical',
    consumer_defensive: 'Consumer Defensive',
    basic_materials: 'Basic Materials',
    communication_services: 'Communication Services',
    financial_services: 'Financial Services',
    healthcare: 'Healthcare',
    us_government: 'US Government',
    below_b: 'Below B',
    other: 'Other'
};

function weightLabel(key) {
    const raw = String(key || '').trim();
    if (!raw) return '';
    if (WEIGHT_LABELS[raw]) return WEIGHT_LABELS[raw];
    // Credit-rating buckets arrive as bare letters: aaa, aa, bbb, b.
    if (/^[a-z]{1,3}$/.test(raw)) return raw.toUpperCase();
    return raw.replace(/[_-]+/g, ' ').replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

function entries(value) {
    if (!value) return [];
    if (!Array.isArray(value)) {
        return Object.entries(value).map(([name, weight]) => ({ name, weight }));
    }
    return value.flatMap((row) => {
        if (!row || typeof row !== 'object') return [];
        if (row.name || row.sector || row.rating) return [row];
        return Object.entries(row).map(([name, weight]) => ({ name, weight }));
    });
}

// Zero-weight buckets are dropped: an equity ETF reports every credit rating as
// 0, and rendering eleven empty bars is noise, not information.
function normalizeWeights(value) {
    return entries(value).map((row) => ({
        name: weightLabel(row.name || row.sector || row.rating || ''),
        weight: number(row.weight ?? row.value)
    })).filter((row) => row.name && row.weight !== null && row.weight > 0)
        .sort((a, b) => b.weight - a.weight);
}

// Yahoo is the only live source behind this page, so when it refuses we serve
// the nightly store rather than a blank page. Marked `stale` with the trading
// day it came from so the UI can say "as of" instead of implying a live quote —
// showing a week-old price as current would be worse than showing nothing.
// Returns null for funds and for placeholder rows, leaving the 404 intact.
function profileFromStore(symbol, key) {
    const data = stored.load(key);
    if (!stored.usable(data)) return null;
    const daily = stored.dailyCloses(data);
    if (!daily || daily.close === null) return null;

    const overview = data.overview || {};
    const changePercent = daily.previousClose
        ? (daily.close / daily.previousClose - 1) * 100
        : null;

    return {
        symbol: String(symbol || '').toUpperCase().trim(),
        name: overview.Name || key,
        assetType: 'stock',
        assetTypeLabel: assetTypeLabel('stock'),
        quoteType: 'EQUITY',
        exchange: overview.Exchange || '',
        currency: overview.Currency || 'USD',
        price: daily.close,
        previousClose: daily.previousClose,
        changePercent,
        asOf: daily.date,
        stale: true,
        staleAsOf: daily.date,
        category: '', fundFamily: '',
        totalAssets: null, expenseRatio: null, expenseRatioSource: null, expenseRatioAsOf: null,
        expenseRatioUrl: null, fees: null, yield: null, ytdReturn: null,
        beta3Year: number(overview.Beta), inceptionDate: null, rating: null,
        riskRating: null, turnover: null,
        returns: { oneMonth: null, threeMonth: null, oneYear: null, threeYear: null, fiveYear: null, tenYear: null },
        performance: { yearsUp: null, yearsDown: null, bestOneYear: null, worstOneYear: null },
        annualReturns: [],
        allocations: { cash: null, stock: null, bond: null, other: null, sectors: [], bondRatings: [] },
        topHoldings: [],
        risk: [],
        supports: {
            portfolio: true, quote: true, priceHistory: true, news: true, ask: true,
            fundProfile: false,
            financialStatements: true, filings: true, reverseDcf: true, insiders: true
        },
        source: 'Cached snapshot'
    };
}

async function fetchAssetProfile(symbol, { fundDetails = true } = {}) {
    const key = symbolKey(symbol);
    if (!key || !/^[A-Z0-9\-^=]{1,20}$/.test(key)) throw Object.assign(new Error('Invalid symbol'), { status: 400 });
    // Portfolio mutations only need identity, type and the live quote. Keep
    // that lightweight response separate from the full fund dossier cache so
    // adding an ETF/fund does not wait for Yahoo's larger quoteSummary call.
    const cacheKey = `${key}:${fundDetails ? 'full' : 'basic'}`;
    const hit = cache.get(cacheKey);
    if (hit && Date.now() - hit.at < (hit.value && hit.value.stale ? STALE_TTL_MS : (hit.ttl || TTL_MS))) return hit.value;

    const serveStored = (error) => {
        const fallback = profileFromStore(symbol, key);
        if (!fallback) return null;
        cache.set(cacheKey, { at: Date.now(), value: fallback });
        console.warn(`[yahoo] serving cached ${key} as of ${fallback.asOf}${error ? '' : ' (empty quote)'}`);
        return fallback;
    };

    let quote;
    try { quote = await yahoo.quote(key); }
    catch (error) {
        logYahooError(`quote(${key})`, error);
        const fallback = serveStored(error);
        if (fallback) return fallback;
        throw Object.assign(new Error(`No market data found for ${symbol}`), { status: 404, cause: error });
    }
    // An unknown ticker resolves rather than throwing, so without this the next
    // line reads quoteType off undefined and surfaces a TypeError as a 500.
    if (!quote) {
        const fallback = serveStored(null);
        if (fallback) return fallback;
        throw Object.assign(new Error(`No market data found for ${symbol}`), { status: 404 });
    }

    const assetType = normalizeAssetType(quote.quoteType || quote.typeDisp);
    let summary = {};
    if (fundDetails && isFundAsset(assetType)) {
        summary = await yahoo.quoteSummary(key, {
            modules: ['topHoldings', 'fundPerformance', 'fundProfile', 'summaryDetail', 'defaultKeyStatistics', 'price']
        }, { validateResult: false }).catch(() => ({}));
    }

    // Expense ratio comes from the prospectus fee table as filed, not from
    // Yahoo. Measured 2026-09-07: Yahoo is right for ETFs and wrong for roughly
    // half the mutual funds tested, and wrong in the direction that matters —
    // it reported SWPPX at 1.24% against a filed 0.02%, FXAIX at 0.69% against
    // 0.015%, FZROX at 0.99% against 0.00%, and DODGX at 0.00% against 0.51%.
    // Those look like the fund's Morningstar category average rather than the
    // fund, which is why the cheapest index funds are the worst hit: exactly
    // the funds people choose on cost.
    const feeLookup = (fundDetails && isFundAsset(assetType))
        ? await withTimeout(fundFees.fetchFundFees(key), FEE_TIMEOUT_MS)
        : { value: null, timedOut: false };
    const filedFees = feeLookup.value;

    const sd = summary.summaryDetail || {};
    const ks = summary.defaultKeyStatistics || {};
    const fp = summary.fundPerformance || {};
    const fund = summary.fundProfile || {};
    const fees = fund.feesExpensesInvestment || {};
    const th = summary.topHoldings || {};
    const overview = fp.performanceOverview || {};
    const trailing = fp.trailingReturns || {};
    // Yahoo's performanceOverview no longer carries numYearsUp/numYearsDown or
    // the best/worst year, but it does return the full calendar-year series —
    // which is strictly better, since the counts can be derived from it exactly
    // and the years themselves can be shown to the user.
    const annualReturns = (((fp.annualTotalReturns || {}).returns) || [])
        .map((row) => ({ year: number(row.year), value: number(row.annualValue) }))
        .filter((row) => row.year !== null && row.value !== null)
        .sort((a, b) => b.year - a.year);
    const annualValues = annualReturns.map((row) => row.value);
    const currentPrice = number(quote.regularMarketPrice ?? summary.price?.regularMarketPrice);
    const previousClose = number(quote.regularMarketPreviousClose ?? sd.previousClose);
    const changePercent = number(quote.regularMarketChangePercent) ??
        (currentPrice !== null && previousClose ? (currentPrice / previousClose - 1) * 100 : null);

    // Resolution order: the filed figure, then Yahoo but only for ETFs where it
    // has been verified accurate. A mutual fund with no filed table shows
    // nothing rather than a number we know may be off by 60x — the same call
    // that pulled the ETF grade on 2026-09-03.
    const yahooExpenseRatio = number(ks.annualReportExpenseRatio ?? fees.annualReportExpenseRatio ?? fees.netExpRatio ?? fees.grossExpRatio);
    const expenseRatio = filedFees
        ? { value: filedFees.expenseRatio, source: filedFees.source, asOf: filedFees.filedAt, url: filedFees.sourceUrl }
        : (assetType === 'etf' && yahooExpenseRatio !== null
            ? { value: yahooExpenseRatio, source: 'Yahoo Finance', asOf: null, url: null }
            : { value: null, source: null, asOf: null, url: null });

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
        expenseRatio: expenseRatio.value,
        expenseRatioSource: expenseRatio.source,
        expenseRatioAsOf: expenseRatio.asOf,
        expenseRatioUrl: expenseRatio.url,
        fees: filedFees ? {
            gross: filedFees.grossExpenseRatio, net: filedFees.netExpenseRatio,
            management: filedFees.managementFee, distribution: filedFees.distributionFee,
            other: filedFees.otherExpenses, acquiredFunds: filedFees.acquiredFundFees
        } : null,
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
            yearsUp: number(overview.numYearsUp) ?? (annualValues.length ? annualValues.filter((v) => v > 0).length : null),
            yearsDown: number(overview.numYearsDown) ?? (annualValues.length ? annualValues.filter((v) => v <= 0).length : null),
            bestOneYear: number(overview.bestOneYrTotalReturn) ?? (annualValues.length ? Math.max(...annualValues) : null),
            worstOneYear: number(overview.worstOneYrTotalReturn) ?? (annualValues.length ? Math.min(...annualValues) : null)
        },
        annualReturns,
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
    cache.set(cacheKey, { at: Date.now(), value, ttl: feeLookup.timedOut ? FEE_RETRY_TTL_MS : TTL_MS });
    if (cache.size > 1000) cache.delete(cache.keys().next().value);
    return value;
}

module.exports = { fetchAssetProfile, normalizeAssetType, assetTypeLabel, isFundAsset, normalizeWeights };
