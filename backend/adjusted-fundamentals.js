'use strict';
/**
 * One place that hands out split-normalized fundamentals.
 *
 * Why it exists: `split-adjust.js` normalizes share counts, EPS and the
 * weighted-average share series to the current split basis, but it needs the
 * split list (Yahoo, async, cached 24h). Only some call sites were async — the
 * company page's API route adjusted, while the indexed /stocks/:symbol page and
 * the metric histories read the stored payload as-is. The same company therefore
 * showed FY2011 EPS of $27.68 on one page and $0.99 on another.
 *
 * The payload is CLONED before adjustment: `verified-fundamentals` reuses its
 * report rows between calls, and mutating them in place would apply the factors
 * to values that had already been adjusted on a previous request.
 *
 * Fail-open: a Yahoo hiccup, or no splits at all, returns the payload unchanged.
 */
const { loadFundamentals } = require('./fundamentals-cache');
const splitAdjust = require('./split-adjust');

const TTL_MS = 6 * 3600 * 1000;
const cache = new Map(); // SYMBOL -> { at, payload }

function clone(value) {
    try { return structuredClone(value); } catch (_) { return JSON.parse(JSON.stringify(value)); }
}

/**
 * The payload for a symbol with share counts and per-share figures on today's
 * split basis. Synchronous callers keep using loadFundamentals; anything that
 * can await should use this.
 */
async function adjusted(symbol) {
    const key = String(symbol || '').toUpperCase();
    if (!key) return null;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.payload;
    const raw = loadFundamentals(key);
    if (!raw) return null;
    const payload = clone(raw);
    try { await splitAdjust.adjustPayloadForSymbol(key, payload); } catch (_) { /* fail-open */ }
    if (cache.size >= 4000) cache.delete(cache.keys().next().value);
    cache.set(key, { at: Date.now(), payload });
    return payload;
}

/**
 * Clone-then-adjust a payload the caller already has (the reader path builds one
 * from fresher evidence). Never mutates the argument.
 */
async function adjustClone(symbol, payload) {
    if (!payload) return payload;
    const copy = clone(payload);
    try { await splitAdjust.adjustPayloadForSymbol(String(symbol || '').toUpperCase(), copy); } catch (_) { /* fail-open */ }
    return copy;
}

function invalidate(symbol) {
    if (symbol) cache.delete(String(symbol).toUpperCase());
    else cache.clear();
}

module.exports = { adjusted, adjustClone, invalidate };
