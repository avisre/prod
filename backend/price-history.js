'use strict';
// Price history for the company chart: daily closes for about seven months and
// monthly closes for twenty years, in the shape the stored fundamentals files
// already use.
//
// Why this exists (measured 2026-10-10): the chart series lived inside the
// weekly fundamentals file and was only ever refreshed for the S&P 500 (weekly)
// and S&P 1500 (monthly). Both jobs were replaced by the SEC reconciliation on
// 2026-10-03, which reads filings and no prices, so nothing refreshed a chart
// after that. Of 4,358 stocks, 1,250 still ended on 2026-06-11, the day of the
// last full pull, and 1,572 had no series at all.
//
// Two users:
//   scripts/refresh-price-history.js  rewrites the stored series (weekly job);
//   topUp()                           brings a stale stored series up to date
//                                     for a reader, from memory, without git.

const YahooFinance = require('yahoo-finance2').default;

let yahoo = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });
const DAILY_DAYS = 210;
const MONTHLY_YEARS = 20;

const text = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? null : String(v));
const yahooSymbol = (symbol) => String(symbol).replace(/\./g, '-');
const dayOf = (d) => (d instanceof Date ? d : new Date(d)).toISOString().slice(0, 10);

function rows(chart, daily) {
    const series = {};
    for (const q of (chart && chart.quotes) || []) {
        if (!q || !q.date || text(q.close) === null) continue;
        const row = {
            '1. open': text(q.open), '2. high': text(q.high), '3. low': text(q.low), '4. close': text(q.close),
            '5. adjusted close': text(q.adjclose ?? q.close), '6. volume': text(q.volume), '7. dividend amount': '0.0000'
        };
        if (daily) row['8. split coefficient'] = '1.0';
        series[dayOf(q.date)] = row;
    }
    return series;
}

// Yahoo's monthly chart ends with the month's opening bar and, during the
// month, a second bar dated today. Both fall in the same month; the later one
// carries the newest close, so the earlier is dropped.
function dedupeLastMonth(series) {
    const keys = Object.keys(series).sort();
    if (keys.length >= 2 && keys[keys.length - 1].slice(0, 7) === keys[keys.length - 2].slice(0, 7)) delete series[keys[keys.length - 2]];
    return series;
}

async function fetchSeries(symbol, { now = new Date(), client = yahoo } = {}) {
    const id = yahooSymbol(symbol);
    const dailyStart = new Date(now.getTime() - DAILY_DAYS * 86400000);
    const monthlyStart = new Date(now.getTime() - MONTHLY_YEARS * 365 * 86400000);
    const [d, m] = await Promise.allSettled([
        client.chart(id, { period1: dailyStart, period2: now, interval: '1d' }),
        client.chart(id, { period1: monthlyStart, period2: now, interval: '1mo' })
    ]);
    const daily = d.status === 'fulfilled' ? rows(d.value, true) : {};
    const monthly = m.status === 'fulfilled' ? dedupeLastMonth(rows(m.value, false)) : {};
    const reason = [d, m].filter((s) => s.status === 'rejected').map((s) => String((s.reason && s.reason.message) || s.reason)).join('; ');
    return { daily, monthly, reason };
}

const latest = (series) => Object.keys(series || {}).sort().pop() || '';
const dailyOf = (payload) => (payload && payload.daily && payload.daily['Time Series (Daily)']) || {};
const monthlyKey = (payload) => (payload && payload.monthly && payload.monthly['Monthly Time Series'] && !payload.monthly['Monthly Adjusted Time Series']
    ? 'Monthly Time Series' : 'Monthly Adjusted Time Series');
const monthlyOf = (payload) => (payload && payload.monthly && payload.monthly[monthlyKey(payload)]) || {};

// Put fetched series into a fundamentals payload. A fetch that returned nothing
// never replaces what is stored. Returns true when anything changed.
function apply(payload, fetched) {
    let changed = false;
    if (Object.keys(fetched.daily).length && latest(fetched.daily) >= latest(dailyOf(payload))) {
        const next = { ...(payload.daily || {}), 'Time Series (Daily)': fetched.daily };
        next['Meta Data'] = { ...((payload.daily && payload.daily['Meta Data']) || {}), '3. Last Refreshed': latest(fetched.daily) };
        if (JSON.stringify(dailyOf(payload)) !== JSON.stringify(fetched.daily)) changed = true;
        payload.daily = next;
    }
    if (Object.keys(fetched.monthly).length && latest(fetched.monthly) >= latest(monthlyOf(payload))) {
        const key = monthlyKey(payload);
        if (JSON.stringify(monthlyOf(payload)) !== JSON.stringify(fetched.monthly)) changed = true;
        payload.monthly = { ...(payload.monthly || {}), [key]: fetched.monthly };
    }
    return changed;
}

// ---- reader-side top-up -----------------------------------------------------
// A stored series more than STALE_DAYS behind today is refreshed from Yahoo the
// first time someone opens the page, kept in memory for six hours, and merged
// into the answer. The wait is capped: a slow Yahoo never holds the page.
const STALE_DAYS = 4;
const KEEP_MS = 6 * 3600 * 1000;
const WAIT_MS = 2500;
const MAX_KEPT = 600;
const PER_MINUTE = 60;
const kept = new Map(); // symbol -> { at, fetched } | { at, pending }
let windowStart = 0; let windowCount = 0;

function isStale(payload, now = Date.now()) {
    const last = latest(dailyOf(payload)) || latest(monthlyOf(payload));
    if (!last) return true;
    return now - Date.parse(last + 'T00:00:00Z') > STALE_DAYS * 86400000;
}

function allowed(now) {
    if (now - windowStart > 60000) { windowStart = now; windowCount = 0; }
    if (windowCount >= PER_MINUTE) return false;
    windowCount++;
    return true;
}

async function topUp(symbol, payload, { now = Date.now(), fetcher = fetchSeries, waitMs = WAIT_MS } = {}) {
    if (!payload || !isStale(payload, now)) return payload;
    let entry = kept.get(symbol);
    if (entry && now - entry.at > KEEP_MS) { kept.delete(symbol); entry = null; }
    if (!entry) {
        if (!allowed(now)) return payload;
        if (kept.size >= MAX_KEPT) kept.delete(kept.keys().next().value);
        entry = { at: now, fetched: null };
        entry.pending = fetcher(symbol).then((f) => { entry.fetched = f; entry.pending = null; return f; })
            .catch(() => { entry.pending = null; kept.delete(symbol); return null; });
        kept.set(symbol, entry);
    }
    let fetched = entry.fetched;
    if (!fetched && entry.pending) {
        fetched = await Promise.race([entry.pending, new Promise((resolve) => setTimeout(() => resolve(null), waitMs))]);
    }
    if (!fetched) return payload;
    const copy = { ...payload };
    apply(copy, fetched);
    return copy;
}

module.exports = {
    fetchSeries, apply, topUp, isStale, latest, dailyOf, monthlyOf, dedupeLastMonth,
    __setClient(c) { yahoo = c; }, __reset() { kept.clear(); windowStart = 0; windowCount = 0; }
};
