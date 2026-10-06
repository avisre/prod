'use strict';

// Is the data on this server as fresh as its schedule promises?
//   prices        refreshed every trading day (scripts/refresh-quotes.js)
//   fundamentals  reconciled against the SEC once a week (refresh-fundamentals.yml)
// A job that stops, or a refresh that is committed but never deployed, fails
// silently: every number stays plausible and simply ages. This module turns
// that into a verdict. It reads two small files and never the network.
const fs = require('fs');
const path = require('path');

const DAY = 86400000;
const DATA_DIR = process.env.SEC_COVERAGE_DATA_DIR || path.join(__dirname, '..', 'frontend', 'data');
const isDay = (value) => /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
const utcDay = (now) => new Date(now).toISOString().slice(0, 10);

// Weekdays after `from`, up to and including `to`. Market holidays are not
// modelled, which is why one extra day is a warning and not a failure.
function weekdaysBetween(from, to) {
    if (!isDay(from) || !isDay(to) || from >= to) return 0;
    let count = 0;
    for (let t = Date.parse(from) + DAY; t <= Date.parse(to); t += DAY) {
        const weekday = new Date(t).getUTCDay();
        if (weekday !== 0 && weekday !== 6) count += 1;
    }
    return count;
}

const PRICE_OK_WEEKDAYS = 1;      // yesterday's close, or today's
const PRICE_WARN_WEEKDAYS = 2;    // one missed run, or a market holiday
const PRICE_MIN_SHARE = 0.9;      // of priced listings on the newest trading date
const PRICE_MIN_COVERAGE = 0.95;  // of requested listings carrying any price
const WEEKLY_OK_DAYS = 8;         // a week plus the run's own day
const WEEKLY_WARN_DAYS = 10;

function assessPrices(quotes, { now, listed = null }) {
    const reasons = [];
    const dates = {};
    let priced = 0;
    for (const [symbol, row] of Object.entries(quotes || {})) {
        if (symbol === '_meta' || !row || !(Number(row.price) > 0) || !isDay(row.asOf)) continue;
        priced += 1;
        dates[row.asOf] = (dates[row.asOf] || 0) + 1;
    }
    const today = utcDay(now);
    // The date most listings last traded on. A thin share class that last
    // traded in August must not make the whole snapshot look two months old,
    // and one future-dated row must not make it look current.
    const tradingDate = Object.keys(dates).filter((day) => day <= today).sort((a, b) => dates[b] - dates[a] || (a < b ? 1 : -1))[0] || null;
    const shareOnDate = priced && tradingDate ? dates[tradingDate] / priced : 0;
    const weekdaysOld = tradingDate ? weekdaysBetween(tradingDate, today) : null;
    const coverage = listed ? priced / listed : null;
    let status = 'ok';
    const worse = (next) => { if (next === 'stale' || (next === 'warn' && status === 'ok')) status = next; };
    if (!tradingDate) { worse('stale'); reasons.push('no dated prices in the snapshot'); }
    else if (weekdaysOld > PRICE_WARN_WEEKDAYS) { worse('stale'); reasons.push(`prices are ${weekdaysOld} trading days old (${tradingDate})`); }
    else if (weekdaysOld > PRICE_OK_WEEKDAYS) { worse('warn'); reasons.push(`prices are ${weekdaysOld} trading days old (${tradingDate}); a missed run or a market holiday`); }
    if (tradingDate && shareOnDate < PRICE_MIN_SHARE) { worse('stale'); reasons.push(`only ${(shareOnDate * 100).toFixed(1)}% of priced listings carry ${tradingDate}`); }
    if (coverage !== null && coverage < PRICE_MIN_COVERAGE) { worse('stale'); reasons.push(`only ${(coverage * 100).toFixed(1)}% of requested listings have a price`); }
    return { status, tradingDate, weekdaysOld, priced, listed, shareOnTradingDate: Number(shareOnDate.toFixed(4)),
        generatedAt: quotes?._meta?.generatedAt || null, reasons };
}

function assessFundamentals(summary, { now, extractionVersion = null }) {
    const reasons = [];
    const asOf = isDay(summary?.asOf) ? summary.asOf : null;
    const daysOld = asOf ? Math.floor((Date.parse(utcDay(now)) - Date.parse(asOf)) / DAY) : null;
    let status = 'ok';
    if (!asOf) { status = 'stale'; reasons.push('no reconciliation date in the coverage summary'); }
    else if (daysOld > WEEKLY_WARN_DAYS) { status = 'stale'; reasons.push(`last SEC reconciliation was ${daysOld} days ago (${asOf})`); }
    else if (daysOld > WEEKLY_OK_DAYS) { status = 'warn'; reasons.push(`last SEC reconciliation was ${daysOld} days ago (${asOf}); this week's run is late`); }
    // New extraction rules that have not been run over the stored statements:
    // the code is current and the figures are not.
    if (extractionVersion && summary?.extractionVersion && summary.extractionVersion !== extractionVersion) {
        status = 'stale';
        reasons.push(`stored statements were extracted with rules ${summary.extractionVersion}; the code is on ${extractionVersion}`);
    }
    return { status, asOf, daysOld, extractionVersion: summary?.extractionVersion || null, expectedExtractionVersion: extractionVersion,
        datasetId: summary?.datasetId ? String(summary.datasetId).slice(0, 12) : null, issuers: summary?.counts?.uniqueIssuers ?? null, reasons };
}

function assess({ quotes, summary, now = Date.now(), listed = null, extractionVersion = null } = {}) {
    const prices = assessPrices(quotes, { now, listed });
    const fundamentals = assessFundamentals(summary, { now, extractionVersion });
    const rank = { ok: 0, warn: 1, stale: 2 };
    const status = rank[prices.status] >= rank[fundamentals.status] ? prices.status : fundamentals.status;
    return { status, ok: status !== 'stale', checkedAt: new Date(now).toISOString(), prices, fundamentals };
}

function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }

function read(dir = DATA_DIR) {
    const summary = readJson(path.join(dir, 'financial-coverage-summary.json'));
    const quotes = readJson(path.join(dir, 'quotes.json'));
    // Coverage is measured against what the refresh asked Yahoo for: the
    // snapshot prices funds and share classes too, so the stock count is not
    // its denominator.
    return { quotes, summary, listed: Number(quotes?._meta?.requested) > 0 ? Number(quotes._meta.requested) : null,
        extractionVersion: require('./sec-facts').EXTRACTION_VERSION };
}

// The files change only on a deploy, so a short cache keeps a health poller
// from re-parsing the snapshot on every hit while the dates still advance.
let cached = null;
function current(now = Date.now()) {
    if (!cached || now - cached.at > 5 * 60 * 1000) cached = { at: now, inputs: read() };
    return assess({ ...cached.inputs, now });
}

module.exports = { assess, assessPrices, assessFundamentals, weekdaysBetween, read, current, _reset: () => { cached = null; } };
