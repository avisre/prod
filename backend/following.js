'use strict';
// "Following" on the dashboard: the companies a customer has shown interest in,
// with each one's latest SEC filing. Last month 5 customers opened dossiers but
// every watchlist was empty and the Filing Monitor had no views, so interest
// never turned into a reason to come back. Following is derived instead of
// asked for: holdings, the watchlist, and dossier or company-page views in the
// last 90 days, minus what the customer removed.

const WINDOW_DAYS = 90;
const NEW_DAYS = 14;
const MAX_SYMBOLS = 12;
const LIVE_TTL_MS = 6 * 3600 * 1000;
const FAILURE_TTL_MS = 10 * 60 * 1000;
const FORMS = new Set(['10-K', '10-Q', '20-F', '40-F', '8-K', '6-K']);
const PERIODIC = new Set(['10-K', '10-Q', '20-F', '40-F']);

// Explicit choices first (holdings, watchlist), then views newest first.
function collect({ holdings = [], watchlist = [], views = [], unfollowed = [], now = new Date() }) {
    const removed = new Set(unfollowed.map((s) => String(s).toUpperCase()));
    const since = now.getTime() - WINDOW_DAYS * 86400000;
    const out = new Map();
    const add = (symbol, reason, at = null) => {
        const s = String(symbol || '').toUpperCase().trim();
        if (!s || removed.has(s) || out.has(s)) return;
        out.set(s, { symbol: s, reason, viewedAt: at });
    };
    holdings.forEach((s) => add(s, 'holding'));
    watchlist.forEach((s) => add(s, 'watchlist'));
    views.filter((v) => v.lastViewedAt && new Date(v.lastViewedAt).getTime() >= since)
        .sort((a, b) => new Date(b.lastViewedAt) - new Date(a.lastViewedAt))
        .forEach((v) => add(v.symbol, v.kind === 'dossier' ? 'dossier' : 'viewed', new Date(v.lastViewedAt).toISOString()));
    return [...out.values()].slice(0, MAX_SYMBOLS);
}

function isNew(date, now = new Date()) {
    const t = Date.parse(date);
    return Number.isFinite(t) && now.getTime() - t <= NEW_DAYS * 86400000;
}

// Newest periodic report and newest 8-K/6-K from a filings list (newest first).
function summarize(filings, now = new Date()) {
    const pick = (test) => {
        const f = (filings || []).find((x) => test(x.form));
        return f ? { form: f.form, date: f.date, url: f.url, isNew: isNew(f.date, now) } : null;
    };
    return { periodic: pick((form) => PERIODIC.has(form)), event: pick((form) => form === '8-K' || form === '6-K') };
}

// The weekly reporting index is up to a week behind, so the SEC submissions
// file is read live (globally throttled by sec-throttle) and kept 6 hours; the
// index answers only when that read fails.
const cache = new Map(); // SYM -> { at, ok, filings }
async function filingsFor(symbol, { fetchRecent, fromIndex, now = Date.now() }) {
    const hit = cache.get(symbol);
    if (hit && now - hit.at < (hit.ok ? LIVE_TTL_MS : FAILURE_TTL_MS)) return hit.filings;
    let filings = null, ok = false;
    try {
        filings = await fetchRecent(symbol, FORMS, 20);
        ok = Array.isArray(filings);
    } catch (_) { /* fall back below */ }
    if (!ok) filings = fromIndex(symbol);
    cache.set(symbol, { at: now, ok, filings });
    if (cache.size > 2000) cache.delete(cache.keys().next().value);
    return filings;
}

module.exports = { collect, summarize, filingsFor, isNew, WINDOW_DAYS, NEW_DAYS, MAX_SYMBOLS, FORMS, __reset: () => cache.clear() };
