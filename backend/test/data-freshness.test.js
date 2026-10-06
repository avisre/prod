'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const f = require('../data-freshness');

const at = (iso) => Date.parse(iso);
function quotes(day, n = 100, extra = {}) {
    const out = { _meta: { generatedAt: day + 'T01:35:00Z' } };
    for (let i = 0; i < n; i++) out['S' + i] = { price: 10 + i, asOf: day };
    return { ...out, ...extra };
}
const summary = (asOf, extractionVersion = 'v2') => ({ asOf, extractionVersion, datasetId: 'abcdef0123456789', counts: { stockListings: 100, uniqueIssuers: 95 } });

test('weekdays are counted across a weekend', () => {
    assert.equal(f.weekdaysBetween('2026-10-02', '2026-10-05'), 1); // Fri -> Mon
    assert.equal(f.weekdaysBetween('2026-10-02', '2026-10-04'), 0); // Fri -> Sun
    assert.equal(f.weekdaysBetween('2026-10-05', '2026-10-09'), 4);
    assert.equal(f.weekdaysBetween('2026-10-06', '2026-10-06'), 0);
});

test('daily prices: yesterday is fresh, a weekend does not age them, two missed runs are stale', () => {
    const tuesday = quotes('2026-10-06');
    assert.equal(f.assessPrices(tuesday, { now: at('2026-10-07T12:00:00Z'), listed: 100 }).status, 'ok');
    const friday = quotes('2026-10-02');
    assert.equal(f.assessPrices(friday, { now: at('2026-10-04T12:00:00Z'), listed: 100 }).status, 'ok');   // Sunday
    assert.equal(f.assessPrices(friday, { now: at('2026-10-05T12:00:00Z'), listed: 100 }).status, 'ok');   // Monday before the run
    const missedOne = f.assessPrices(friday, { now: at('2026-10-06T12:00:00Z'), listed: 100 });            // one missed run or a holiday
    assert.equal(missedOne.status, 'warn');
    const missedTwo = f.assessPrices(friday, { now: at('2026-10-07T12:00:00Z'), listed: 100 });
    assert.equal(missedTwo.status, 'stale');
    assert.match(missedTwo.reasons[0], /3 trading days old \(2026-10-02\)/);
});

test('thinly traded listings do not date the snapshot, but a half-refreshed snapshot is stale', () => {
    const thin = quotes('2026-10-06', 97, { OLD1: { price: 1, asOf: '2026-08-20' }, OLD2: { price: 1, asOf: '2026-09-11' }, OLD3: { price: 1, asOf: '2026-10-02' } });
    const ok = f.assessPrices(thin, { now: at('2026-10-07T12:00:00Z'), listed: 100 });
    assert.equal(ok.status, 'ok'); assert.equal(ok.tradingDate, '2026-10-06'); assert.equal(ok.priced, 100);
    const half = quotes('2026-10-06', 60); for (let i = 0; i < 40; i++) half['T' + i] = { price: 5, asOf: '2026-10-01' };
    const partial = f.assessPrices(half, { now: at('2026-10-07T12:00:00Z'), listed: 100 });
    assert.equal(partial.status, 'stale'); assert.match(partial.reasons.join(' '), /only 60\.0% of priced listings carry 2026-10-06/);
});

test('missing prices, missing coverage and future-dated rows are not read as fresh', () => {
    assert.equal(f.assessPrices({}, { now: at('2026-10-07T12:00:00Z') }).status, 'stale');
    assert.equal(f.assessPrices(null, { now: at('2026-10-07T12:00:00Z') }).status, 'stale');
    const few = f.assessPrices(quotes('2026-10-06', 80), { now: at('2026-10-07T12:00:00Z'), listed: 100 });
    assert.equal(few.status, 'stale'); assert.match(few.reasons.join(' '), /only 80\.0% of requested listings have a price/);
    const future = quotes('2026-09-01', 100, { FUT: { price: 1, asOf: '2027-01-01' }, ZERO: { price: 0, asOf: '2026-10-06' } });
    const read = f.assessPrices(future, { now: at('2026-10-07T12:00:00Z'), listed: 100 });
    assert.equal(read.tradingDate, '2026-09-01'); assert.equal(read.status, 'stale');
});

test('weekly fundamentals: within a week is fresh, a late run warns, a missed week is stale', () => {
    const now = (day) => ({ now: at(day + 'T12:00:00Z'), extractionVersion: 'v2' });
    assert.equal(f.assessFundamentals(summary('2026-10-06'), now('2026-10-06')).status, 'ok');
    assert.equal(f.assessFundamentals(summary('2026-10-06'), now('2026-10-14')).status, 'ok');
    assert.equal(f.assessFundamentals(summary('2026-10-06'), now('2026-10-15')).status, 'warn');
    const missed = f.assessFundamentals(summary('2026-10-06'), now('2026-10-17'));
    assert.equal(missed.status, 'stale'); assert.match(missed.reasons[0], /11 days ago \(2026-10-06\)/);
    assert.equal(f.assessFundamentals(null, now('2026-10-06')).status, 'stale');
    assert.equal(f.assessFundamentals({ asOf: 'yesterday' }, now('2026-10-06')).status, 'stale');
});

test('statements extracted with older rules than the running code are stale even when recent', () => {
    const r = f.assessFundamentals(summary('2026-10-06', 'v1'), { now: at('2026-10-06T12:00:00Z'), extractionVersion: 'v2' });
    assert.equal(r.status, 'stale'); assert.match(r.reasons[0], /rules v1; the code is on v2/);
});

test('the overall verdict is the worse of the two and ok is false only when stale', () => {
    const fresh = f.assess({ quotes: quotes('2026-10-06'), summary: summary('2026-10-06'), now: at('2026-10-07T12:00:00Z'), listed: 100, extractionVersion: 'v2' });
    assert.equal(fresh.status, 'ok'); assert.equal(fresh.ok, true);
    const warn = f.assess({ quotes: quotes('2026-10-06'), summary: summary('2026-09-28'), now: at('2026-10-07T12:00:00Z'), listed: 100, extractionVersion: 'v2' });
    assert.equal(warn.status, 'warn'); assert.equal(warn.ok, true);
    const stale = f.assess({ quotes: quotes('2026-09-25'), summary: summary('2026-10-06'), now: at('2026-10-07T12:00:00Z'), listed: 100, extractionVersion: 'v2' });
    assert.equal(stale.status, 'stale'); assert.equal(stale.ok, false); assert.equal(stale.fundamentals.status, 'ok');
});
