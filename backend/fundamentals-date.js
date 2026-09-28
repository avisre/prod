'use strict';

// The truth about how fresh a fundamentals file is.
//
// Filesystem mtime is deliberately NOT used. A git-checkout deploy stamps every
// file with the deploy time, so mtime says nothing about the data — and the
// page body used to advertise "Data last refreshed <deploy date>" while its own
// sitemap entry (which reads a committed manifest) said something else entirely.
//
// Two dates matter:
//   - dataAsOf:  the newest period actually present in the data — the latest
//                fiscal period end across the statements, or the latest daily
//                close. This is what a reader should see.
//   - fetchedAt: when a refresh last wrote the file. Stamped by
//                scripts/refresh-fundamentals.js and fundamentals-fetch.js from
//                2026-09-28 on; older files have none and fall back to dataAsOf.
//
// A file whose freshest date is older than STALE_DAYS should be labelled as
// possibly superseded, not presented as current.

const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'frontend', 'data', 'fundamentals');
const DAY_MS = 86400000;
// Statements update quarterly; allow one filing window plus slack before
// calling data stale. The monthly refresh keeps well inside this.
const STALE_DAYS = 45;

function fileFor(symbol) {
    return path.join(DIR, `${String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}.json`);
}

function dayOf(value) {
    const s = String(value || '');
    return /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null;
}

function describe(data) {
    if (!data || typeof data !== 'object') return { dataAsOf: null, fetchedAt: null, ageDays: null, stale: false };
    const dates = [];
    for (const statement of ['income', 'balance', 'cash']) {
        const section = data[statement] || {};
        for (const period of ['annualReports', 'quarterlyReports']) {
            for (const row of (section[period] || [])) {
                const d = dayOf(row && row.fiscalDateEnding);
                if (d) dates.push(d);
            }
        }
    }
    const daily = (data.daily || {})['Time Series (Daily)'];
    if (daily) {
        const keys = Object.keys(daily).sort();
        if (keys.length) {
            const d = dayOf(keys[keys.length - 1]);
            if (d) dates.push(d);
        }
    }
    const monthly = (data.monthly || {})['Monthly Adjusted Time Series'];
    if (monthly) {
        const keys = Object.keys(monthly).sort();
        if (keys.length) {
            const d = dayOf(keys[keys.length - 1]);
            if (d) dates.push(d);
        }
    }
    const dataAsOf = dates.sort().pop() || null;
    const fetchedAt = data.fetchedAt && !Number.isNaN(Date.parse(data.fetchedAt))
        ? new Date(data.fetchedAt).toISOString()
        : null;
    const reference = fetchedAt || (dataAsOf ? `${dataAsOf}T00:00:00Z` : null);
    const rawAge = reference ? Math.floor((Date.now() - Date.parse(reference)) / DAY_MS) : null;
    const ageDays = rawAge === null ? null : Math.max(0, rawAge);
    return { dataAsOf, fetchedAt, ageDays, stale: ageDays !== null && ageDays > STALE_DAYS };
}

const _cache = new Map(); // SYMBOL -> { at, info } — a page render may ask repeatedly
function info(symbol) {
    const key = String(symbol || '').toUpperCase();
    const hit = _cache.get(key);
    if (hit && Date.now() - hit.at < 60 * 1000) return hit.info;
    let result;
    try { result = describe(JSON.parse(fs.readFileSync(fileFor(symbol), 'utf8'))); }
    catch (_) { result = { dataAsOf: null, fetchedAt: null, ageDays: null, stale: false }; }
    _cache.set(key, { at: Date.now(), info: result });
    if (_cache.size > 1000) _cache.delete(_cache.keys().next().value);
    return result;
}

module.exports = { describe, info, fileFor, STALE_DAYS };
