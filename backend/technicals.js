'use strict';
// Price-trend indicators computed in code from daily closes, so Ask, the
// screener and the company page can answer "is RSI above 50", "golden cross"
// or "volume breakout" with numbers rather than a refusal (3 of the 10
// customer questions in 2026-09-24..10-24 asked for these). They describe the
// past series only; nothing here is a trade signal.
//
// The stored chart series (price-history.js) covers 210 calendar days, about
// 145 sessions, which is too short for a 200-day average. forSymbol() fetches
// LOOKBACK_DAYS of daily bars on demand and keeps only the computed numbers.

const YahooFinance = require('yahoo-finance2').default;

let yahoo = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });
const LOOKBACK_DAYS = 430; // ~295 sessions: a 200-day average plus ~95 days to find a cross in
const RSI_PERIOD = 14;
const VOLUME_PERIOD = 20;
const HIGH_PERIOD = 252; // one year of sessions

const DEFINITIONS = {
    rsi14: "Wilder's 14-session Relative Strength Index of daily adjusted closes (0-100).",
    sma50: 'Mean of the last 50 daily adjusted closes.',
    sma200: 'Mean of the last 200 daily adjusted closes.',
    pctVsSma50: 'Percent difference between the latest close and the 50-day average.',
    pctVsSma200: 'Percent difference between the latest close and the 200-day average.',
    lastCross: 'Most recent session where the 50-day average crossed the 200-day average: golden = crossed above, death = crossed below.',
    volumeRatio20: "Latest session's volume divided by the mean volume of the 20 sessions before it.",
    pctFrom52wHigh: 'Percent difference between the latest close and the highest close of the last 252 sessions (0 = at the high).',
    trend: 'uptrend = close above the 50-day average and the 50-day above the 200-day; downtrend = both below; otherwise mixed.'
};

const round = (v, dp = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null);
const mean = (a) => a.reduce((s, v) => s + v, 0) / a.length;

// Wilder: seed with simple means of the first `period` gains and losses, then
// avg = (prev * (period - 1) + current) / period. Average loss 0 gives 100.
function rsi(closes, period = RSI_PERIOD) {
    if (closes.length < period + 1) return null;
    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) { const d = closes[i] - closes[i - 1]; if (d > 0) gain += d; else loss -= d; }
    gain /= period; loss /= period;
    for (let i = period + 1; i < closes.length; i++) {
        const d = closes[i] - closes[i - 1];
        gain = (gain * (period - 1) + Math.max(d, 0)) / period;
        loss = (loss * (period - 1) + Math.max(-d, 0)) / period;
    }
    if (loss === 0) return gain === 0 ? null : 100;
    return 100 - 100 / (1 + gain / loss);
}

function sma(closes, n, end = closes.length) {
    return end < n ? null : mean(closes.slice(end - n, end));
}

// Walks back from the latest session to the most recent sign change of
// sma50 - sma200. Null when the series is too short to have both averages.
function lastCross(rows, closes) {
    let next = null;
    for (let end = closes.length; end >= 200; end--) {
        const fast = sma(closes, 50, end), slow = sma(closes, 200, end), side = Math.sign(fast - slow);
        if (side === 0) continue;
        if (next && side !== next.side) return { type: next.side > 0 ? 'golden' : 'death', date: next.date, sessionsAgo: closes.length - next.end };
        next = { side, date: rows[end - 1].date, end };
    }
    return null;
}

// rows: [{date:'YYYY-MM-DD', close, volume}] in any order.
function compute(input) {
    const rows = (input || []).filter((r) => r && r.date && Number.isFinite(r.close)).sort((a, b) => a.date.localeCompare(b.date));
    if (!rows.length) return null;
    const closes = rows.map((r) => r.close), last = rows[rows.length - 1];
    const sma50 = sma(closes, 50), sma200 = sma(closes, 200);
    const prior = rows.slice(-VOLUME_PERIOD - 1, -1).map((r) => r.volume).filter((v) => Number.isFinite(v) && v > 0);
    const high = Math.max(...closes.slice(-HIGH_PERIOD));
    let trend = null;
    if (sma50 !== null && sma200 !== null) trend = last.close > sma50 && sma50 > sma200 ? 'uptrend' : last.close < sma50 && sma50 < sma200 ? 'downtrend' : 'mixed';
    return {
        asOf: last.date,
        close: round(last.close, 4),
        sessions: rows.length,
        rsi14: round(rsi(closes)),
        sma50: round(sma50, 4),
        sma200: round(sma200, 4),
        pctVsSma50: sma50 ? round((last.close / sma50 - 1) * 100) : null,
        pctVsSma200: sma200 ? round((last.close / sma200 - 1) * 100) : null,
        lastCross: sma200 === null ? null : lastCross(rows, closes),
        // null lastCross with this set means "no cross in that many sessions", not "never"
        crossSearchedSessions: sma200 === null ? null : closes.length - 199,
        volumeRatio20: prior.length === VOLUME_PERIOD && Number.isFinite(last.volume) ? round(last.volume / mean(prior)) : null,
        // a year-high needs a year of sessions; a shorter window would call a
        // six-month high a 52-week one
        pctFrom52wHigh: closes.length >= HIGH_PERIOD ? round((last.close / high - 1) * 100) : null,
        trend,
        definitions: DEFINITIONS,
        note: 'Descriptive statistics of past prices, not a forecast or a trade signal.'
    };
}

// The Alpha-shaped daily series price-history.js and the stored files use.
function fromAlphaDaily(series) {
    return Object.entries(series || {}).map(([date, r]) => ({ date, close: Number(r['5. adjusted close'] ?? r['4. close']), volume: Number(r['6. volume']) }));
}

const KEEP_MS = 6 * 3600 * 1000;
const MAX_KEPT = 600;
const kept = new Map(); // symbol -> { at, value } | { at, pending }

async function fetchRows(symbol, { now = new Date(), client = yahoo } = {}) {
    const chart = await client.chart(String(symbol).replace(/\./g, '-'), { period1: new Date(now.getTime() - LOOKBACK_DAYS * 86400000), period2: now, interval: '1d' });
    return ((chart && chart.quotes) || []).filter((q) => q && q.date && Number.isFinite(q.close))
        .map((q) => ({ date: new Date(q.date).toISOString().slice(0, 10), close: Number(q.adjclose ?? q.close), volume: Number(q.volume) }));
}

// One symbol on demand, kept six hours. Concurrent callers share one fetch.
async function forSymbol(symbol, { now = Date.now(), fetcher = fetchRows } = {}) {
    const key = String(symbol || '').toUpperCase();
    if (!key) return null;
    let entry = kept.get(key);
    if (entry && now - entry.at > KEEP_MS) { kept.delete(key); entry = null; }
    if (!entry) {
        if (kept.size >= MAX_KEPT) kept.delete(kept.keys().next().value);
        entry = { at: now };
        entry.pending = fetcher(key).then((rows) => { entry.value = compute(rows); entry.pending = null; return entry.value; })
            .catch((error) => { kept.delete(key); throw error; });
        kept.set(key, entry);
    }
    return entry.pending || entry.value;
}

module.exports = {
    compute, rsi, sma, fromAlphaDaily, forSymbol, fetchRows, DEFINITIONS, LOOKBACK_DAYS,
    __setClient(c) { yahoo = c; }, __reset() { kept.clear(); }
};
