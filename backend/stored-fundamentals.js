'use strict';

// Last-known-good fallback for when Yahoo refuses us.
//
// The nightly refresh already writes every equity here as Alpha-Vantage-shaped
// blobs, which is the exact shape the fundamentals route and the company page
// already consume — so serving these is a format-identical substitute, not a
// reimplementation. On 2026-09-05 Yahoo blocked the production host for ~9
// hours and the company page went blank while this data sat on disk unused.
//
// Deliberately dependency-free: asset-profile.js and app.js both need it, and
// seo-pages.js (which has its own loader) cannot be required from
// asset-profile.js without a cycle via ai-chat.js.
//
// Equities only. The store holds no ETF or mutual-fund entries (verified
// 2026-09-05: SPY/VOO/QQQ/VFIAX/FXAIX all absent), so fund symbols find
// nothing here and callers keep their existing error path.

const fs = require('fs');
const path = require('path');
const stockUniverse = require('./stock-universe');

const DIR = path.join(__dirname, '../frontend/data/fundamentals');
const QUOTES_FILE = process.env.QUOTES_FILE || path.join(__dirname, '../frontend/data/quotes.json');

function load(symbol) {
    const company=stockUniverse.lookup(symbol);
    if (company) return require('./fundamentals-cache').loadFundamentals(company.symbol);
    // Non-company asset routes retain their dedicated provider data.
    return require('./fundamentals-cache').loadRawFundamentals(symbol);
}

// The price-only snapshot (scripts/refresh-quotes.js) is at most a session old;
// the fundamentals bundle's newest close can be months old for anything outside
// the weekly S&P 500 refresh. Prefer the snapshot when it carries the symbol.
let _quotesCache = { at: 0, data: {} };
function snapshotQuote(symbol) {
    const now = Date.now();
    if (now - _quotesCache.at > 60 * 1000) {
        let data = {};
        try {
            const parsed = JSON.parse(fs.readFileSync(QUOTES_FILE, 'utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
        } catch (_) { /* no snapshot yet */ }
        _quotesCache = { at: now, data };
    }
    const key = String(symbol || '').toUpperCase().replace(/\./g, '-');
    return _quotesCache.data[key] || null;
}

// A third of the store is an empty placeholder carrying neither a name nor a
// price series. Serving one of those is worse than erroring, so treat as absent.
function usable(data) {
    return !!(data && data.overview && data.overview.Name);
}

function dailyCloses(data) {
    const series = (data && data.daily && data.daily['Time Series (Daily)']) || null;
    if (!series) return null;
    const days = Object.keys(series).sort();
    if (!days.length) return null;
    const num = (row, key) => {
        const n = Number(row && row[key]);
        return Number.isFinite(n) ? n : null;
    };
    const last = days[days.length - 1];
    const prev = days.length > 1 ? days[days.length - 2] : null;
    return {
        date: last,
        row: series[last] || {},
        close: num(series[last], '4. close'),
        previousClose: prev ? num(series[prev], '4. close') : null
    };
}

function globalQuote(symbol, data) {
    const snap = snapshotQuote(symbol);
    const snapPrice = snap ? Number(snap.price) : NaN;
    if (Number.isFinite(snapPrice) && snapPrice > 0) {
        const prev = snap.previousClose === null || snap.previousClose === undefined ? NaN : Number(snap.previousClose);
        const change = Number.isFinite(prev) ? snapPrice - prev : null;
        const pct = Number.isFinite(prev) && prev ? (snapPrice / prev - 1) * 100 : null;
        const s = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '' : String(v));
        return {
            'Global Quote': {
                '01. symbol': String(symbol || '').toUpperCase(),
                '02. open': '',
                '03. high': '',
                '04. low': '',
                '05. price': String(snapPrice),
                '06. volume': '',
                '07. latest trading day': snap.asOf ? String(snap.asOf) : '',
                '08. previous close': s(prev),
                '09. change': change === null ? '' : String(change),
                '10. change percent': pct === null ? '' : `${pct.toFixed(4)}%`
            }
        };
    }
    const daily = dailyCloses(data);
    if (!daily || daily.close === null) return null;
    const prev = daily.previousClose;
    const change = prev === null ? null : daily.close - prev;
    const pct = prev ? (daily.close / prev - 1) * 100 : null;
    const str = (v) => (v === null || v === undefined ? '' : String(v));
    return {
        'Global Quote': {
            '01. symbol': String(symbol || '').toUpperCase(),
            '02. open': str(daily.row['1. open']),
            '03. high': str(daily.row['2. high']),
            '04. low': str(daily.row['3. low']),
            '05. price': str(daily.close),
            '06. volume': str(daily.row['6. volume']),
            '07. latest trading day': daily.date,
            '08. previous close': str(prev),
            '09. change': str(change),
            '10. change percent': pct === null ? '' : `${pct.toFixed(4)}%`
        }
    };
}

module.exports = { load, usable, dailyCloses, globalQuote };
