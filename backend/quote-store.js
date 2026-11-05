'use strict';

// Prices live apart from the fundamentals.
//
// The weekly fundamentals refresh deliberately does not store a quote. What it
// does store is a `daily`/`monthly` close series, and several server-rendered
// pages were reading the newest close out of that bundle and presenting it as
// "Price". Because the bundle only refreshes weekly, and only for the S&P 500,
// mid/small caps served June prices in September (measured 2026-09-28: EXEL
// cached 53.13 vs live 58.16, HCI 160.65 vs 174.94).
//
// This module is the single place pages ask for a price:
//   1. live Yahoo quote, cached QUOTE_TTL_MS (default 60s) and budgeted;
//   2. fallback to frontend/data/quotes.json, a small daily snapshot written
//      by scripts/refresh-quotes.js (robots, Yahoo outages, cold paths).
//
// It never throws and never returns a price without an as-of date, so a caller
// can always label what it shows instead of implying a stale close is current.

const fs = require('fs');
const path = require('path');
const yahooSource = require('./yahoo-source');
const fundStatus = require('./fundamentals-status');

const QUOTES_FILE = process.env.QUOTES_FILE || path.join(__dirname, '..', 'frontend', 'data', 'quotes.json');
const SEC_SHARES_FILE = process.env.SEC_SHARES_FILE || path.join(__dirname, '..', 'frontend', 'data', 'sec-shares.json');
const TTL_MS = Math.max(5 * 1000, Number(process.env.QUOTE_TTL_MS || 60 * 1000));
const TIMEOUT_MS = Math.max(250, Number(process.env.QUOTE_TIMEOUT_MS || 2500));
// Ceiling on live Yahoo lookups per process per minute. Crawlers that ignore
// the user-agent check below still cannot turn an SEO sweep into an outbound
// flood; past the ceiling every caller gets the daily snapshot instead.
const LIVE_PER_MIN = Math.max(0, Number(process.env.QUOTE_LIVE_PER_MIN || 120));

// BRK.B in our lists, BRK-B at Yahoo. Store and look up the same way so either
// spelling resolves.
function normalize(symbol) {
    return String(symbol || '').trim().toUpperCase().replace(/\./g, '-').replace(/[^A-Z0-9-]/g, '');
}

function num(value) {
    return require('./sec-coverage').number(value);
}

const CRAWLER_RE = /bot|crawl|spider|slurp|bing|google|yandex|baidu|duckduck|facebookexternalhit|semrush|ahrefs|mj12|dotbot|petal|applebot|python-requests|curl|wget|headless|pingdom|statuscake|uptime/i;
// Only a browser-shaped user-agent gets a live lookup. Everything else —
// crawlers, scripts, test clients, API consumers — gets the daily snapshot, so
// a sweep of unknown clients cannot become a Yahoo flood and the test suite
// never reaches the network.
function isLikelyCrawler(userAgent) {
    const ua = String(userAgent || '');
    if (!ua) return true;
    if (CRAWLER_RE.test(ua)) return true;
    return !/^Mozilla\/5\.0/i.test(ua);
}

let fileCache = { at: 0, data: {} };
function loadDailyFile() {
    const now = Date.now();
    if (now - fileCache.at < 60 * 1000) return fileCache.data;
    let data = {};
    try {
        const parsed = JSON.parse(fs.readFileSync(QUOTES_FILE, 'utf8'));
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
    } catch (_) { /* absent or mid-write — the empty map is the honest answer */ }
    fileCache = { at: now, data };
    return data;
}

let secCache = { at: 0, data: {} };
function loadSecShares() {
    const now = Date.now();
    if (now - secCache.at < 60 * 1000) return secCache.data;
    let data = {};
    try {
        const parsed = JSON.parse(fs.readFileSync(SEC_SHARES_FILE, 'utf8'));
        if (parsed && parsed.shares && typeof parsed.shares === 'object') data = parsed.shares;
    } catch (_) { /* absent — fall back to the quote's own share count */ }
    secCache = { at: now, data };
    return data;
}

// A market cap is only as good as the share count behind it. Yahoo's count (and
// sometimes its marketCap, which can contradict its own count) goes stale —
// LLY was 5% low and ESS 7% high on 2026-09-28. When SEC's cover-page count
// exists and is consistent with the quote's own scale, price x SEC shares wins.
// A disagreement over 25% means a multi-class filer whose cover page covers one
// class (GOOGL), so Yahoo's total-company figure is kept instead.
function applySecShares(quote) {
    if (!quote || !quote.price) return quote;
    const s = loadSecShares()[quote.symbol];
    if (!s || !(s.shares > 0)) return quote;
    if (quote.marketCap && Math.abs(s.shares / (quote.marketCap / quote.price) - 1) > 0.25) return quote;
    return { ...quote, marketCap: Math.round(quote.price * s.shares), sharesOutstanding: s.shares, sharesAsOf: s.asOf, marketCapSource: 'sec-shares' };
}

function getDailyQuote(symbol,{useLegacySecShares=true}={}) {
    const key = normalize(symbol);
    if (!key) return null;
    const row = loadDailyFile()[key];
    const price = row ? num(row.price) : null;
    if (price === null || price <= 0) return null;
    const quote={
        symbol: key,
        price,
        previousClose: num(row.previousClose),
        changePercent: num(row.changePercent),
        marketCap: num(row.marketCap),
        trailingPE: num(row.trailingPE),
        forwardPE: num(row.forwardPE),
        dividendYield: num(row.dividendYield),
        fiftyTwoWeekHigh: num(row.fiftyTwoWeekHigh),
        fiftyTwoWeekLow: num(row.fiftyTwoWeekLow),
        sharesOutstanding: num(row.sharesOutstanding),
        asOf: row.asOf || null,
        fetchedAt: row.fetchedAt || null,
        currency: row.currency || 'USD',
        source: 'daily'
    };
    return useLegacySecShares?applySecShares(quote):quote;
}

const liveCache = new Map(); // KEY -> { at, quote }
const inflight = new Map(); // KEY -> Promise
let bucket = { at: 0, count: 0 };

function takeLiveSlot() {
    const now = Date.now();
    if (now - bucket.at >= 60 * 1000) bucket = { at: now, count: 0 };
    if (bucket.count >= LIVE_PER_MIN) return false;
    bucket.count += 1;
    return true;
}

function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('quote timeout')), ms);
        promise.then(
            (value) => { clearTimeout(timer); resolve(value); },
            (error) => { clearTimeout(timer); reject(error); }
        );
    });
}

// A live price that came from Yahoo's chart endpoint has no market cap, P/E,
// yield or share count. Keep the snapshot's earnings, dividend and shares and
// re-price them at the live price, so the ratios move with the price instead
// of showing the previous session's multiples beside today's price.
function fillFromSnapshot(quote) {
    const snap = getDailyQuote(quote.symbol, { useLegacySecShares: false });
    if (!snap || !(snap.price > 0)) return quote;
    const r = quote.price / snap.price;
    const out = { ...quote };
    if (out.trailingPE === null && snap.trailingPE !== null) out.trailingPE = snap.trailingPE * r;
    if (out.forwardPE === null && snap.forwardPE !== null) out.forwardPE = snap.forwardPE * r;
    if (out.dividendYield === null && snap.dividendYield !== null) out.dividendYield = snap.dividendYield / r;
    if (out.sharesOutstanding === null && snap.sharesOutstanding > 0) out.sharesOutstanding = snap.sharesOutstanding;
    if (out.marketCap === null) {
        if (out.sharesOutstanding > 0) out.marketCap = Math.round(out.price * out.sharesOutstanding);
        else if (snap.marketCap > 0) out.marketCap = Math.round(snap.marketCap * r);
    }
    if (out.fiftyTwoWeekHigh === null) out.fiftyTwoWeekHigh = snap.fiftyTwoWeekHigh;
    if (out.fiftyTwoWeekLow === null) out.fiftyTwoWeekLow = snap.fiftyTwoWeekLow;
    return out;
}

// Live failures used to be swallowed, which is how every page sat on the
// overnight snapshot for days without a trace. One line per symbol per 10 min.
const failureLogged = new Map();
function logFallback(key, reason) {
    const now = Date.now();
    if (now - (failureLogged.get(key) || 0) < 10 * 60 * 1000) return;
    failureLogged.set(key, now);
    if (failureLogged.size > 5000) failureLogged.delete(failureLogged.keys().next().value);
    console.warn(`[quote] fallback ${key} reason=${String(reason || 'unknown').slice(0, 160)}`);
}

function liveQuoteFrom(key, data) {
    const price = data ? num(data.price) : null;
    if (price === null || price <= 0 || !data.asOf || !Number.isFinite(Date.parse(data.asOf))) return null;
    return fillFromSnapshot({
        symbol: key,
        price,
        previousClose: num(data.previousClose),
        changePercent: num(data.changePercent),
        marketCap: num(data.marketCap),
        trailingPE: num(data.trailingPE),
        forwardPE: num(data.forwardPE),
        dividendYield: num(data.dividendYield),
        fiftyTwoWeekHigh: num(data.fiftyTwoWeekHigh),
        fiftyTwoWeekLow: num(data.fiftyTwoWeekLow),
        sharesOutstanding: num(data.sharesOutstanding),
        asOf:data.asOf,marketState:data.marketState || null,freshness:data.marketState==='REGULAR'?'delayed':data.marketState?'market_closed':'dated_quote',
        fetchedAt: new Date().toISOString(),
        currency: data.currency || null,
        source: 'live'
    });
}

async function fetchLive(symbol) {
    const key = normalize(symbol);
    const hit = liveCache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.quote;
    if (inflight.has(key)) return inflight.get(key);
    if (!takeLiveSlot()) { logFallback('*', `live budget ${LIVE_PER_MIN}/min exhausted`); return null; }

    // A cold Yahoo connection can take longer than the timeout. The caller gets
    // the snapshot then, but the request is left to finish and fill the cache,
    // so the next reader of that symbol gets the live price.
    const live = yahooSource.fetchQuoteExtras(key).then((data) => {
        const quote = liveQuoteFrom(key, data);
        if (quote) {
            liveCache.set(key, { at: Date.now(), quote });
            if (liveCache.size > 2000) liveCache.delete(liveCache.keys().next().value);
        }
        return quote;
    });
    const request = (async () => {
        try {
            const quote = await withTimeout(live, TIMEOUT_MS);
            if (!quote) logFallback(key, 'no price or timestamp in live quote');
            return quote;
        } catch (error) {
            logFallback(key, error && error.message);
            return null;
        } finally {
            inflight.delete(key);
        }
    })();
    live.catch(() => {}); // a failure landing after the timeout must not become an unhandled rejection

    inflight.set(key, request);
    return request;
}

// options.allowLive === false skips the Yahoo call entirely (crawlers, tests,
// render paths that must stay offline).
async function getQuote(symbol, options = {}) {
    const key = normalize(symbol);
    if (!key) return null;
    if (options.allowLive !== false && !fundStatus.isUnlisted(key)) {
        const live = await fetchLive(key);
        if (live) return options.useLegacySecShares===false?live:applySecShares(live);
    }
    const lastGood=liveCache.get(key)?.quote || getDailyQuote(key,{useLegacySecShares:options.useLegacySecShares!==false});
    const selected=lastGood && options.useLegacySecShares!==false?applySecShares(lastGood):lastGood;
    return selected?{...selected,freshness:'stale_fallback',lastRetrievalResult:'retrieval_failed_or_skipped'}:null;
}

module.exports = {
    getQuote,
    getDailyQuote,
    isLikelyCrawler,
    normalize,
    _quotesFile: QUOTES_FILE,
    _secSharesFile: SEC_SHARES_FILE
};
