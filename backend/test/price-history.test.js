'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const ph = require('../price-history');

const bar = (date, close) => ({ date: new Date(date + 'T14:30:00Z'), open: close, high: close, low: close, close, adjclose: close, volume: 10 });
const client = (daily, monthly) => ({ chart: async (_id, opts) => ({ quotes: opts.interval === '1d' ? daily : monthly }) });
const stored = (lastDaily) => ({
    overview: { Symbol: 'TEST' }, income: { annualReports: [{ fiscalDateEnding: '2025-12-31' }] },
    daily: { 'Meta Data': {}, 'Time Series (Daily)': { [lastDaily]: { '4. close': '10' } } },
    monthly: { 'Meta Data': {}, 'Monthly Adjusted Time Series': { '2026-06-01': { '4. close': '10' } } }
});

test('a fetched series replaces the stored one and nothing else in the file', async () => {
    const f = await ph.fetchSeries('TEST', { client: client([bar('2026-10-08', 11), bar('2026-10-09', 12)], [bar('2026-09-01', 9), bar('2026-10-01', 11), bar('2026-10-09', 12)]) });
    const payload = stored('2026-06-11');
    assert.equal(ph.apply(payload, f), true);
    assert.equal(ph.latest(ph.dailyOf(payload)), '2026-10-09');
    assert.deepEqual(Object.keys(ph.monthlyOf(payload)), ['2026-09-01', '2026-10-09'], 'the month-opening bar gives way to the newer bar of the same month');
    assert.deepEqual(payload.income, { annualReports: [{ fiscalDateEnding: '2025-12-31' }] });
    assert.equal(payload.daily['Time Series (Daily)']['2026-10-09']['4. close'], '12', 'values are stored as strings, like the existing files');
});

test('an empty answer from the source never wipes what is stored', async () => {
    const f = await ph.fetchSeries('TEST', { client: client([], []) });
    const payload = stored('2026-06-11');
    assert.equal(ph.apply(payload, f), false);
    assert.equal(ph.latest(ph.dailyOf(payload)), '2026-06-11');
});

test('a reader gets a stale series topped up, a fresh one is left alone, and a slow source does not hold the page', async () => {
    ph.__reset();
    const now = Date.parse('2026-10-10T12:00:00Z');
    const fresh = stored('2026-10-09');
    assert.equal(await ph.topUp('FRESH', fresh, { now, fetcher: async () => { throw new Error('must not be called'); } }), fresh);
    let calls = 0;
    const fetcher = async () => { calls++; return { daily: { '2026-10-09': { '4. close': '12' } }, monthly: {}, reason: '' }; };
    const stale = stored('2026-06-11');
    const out = await ph.topUp('STALE', stale, { now, fetcher });
    assert.equal(ph.latest(ph.dailyOf(out)), '2026-10-09');
    assert.equal(ph.latest(ph.dailyOf(stale)), '2026-06-11', 'the shared stored object is not mutated');
    await ph.topUp('STALE', stale, { now: now + 1000, fetcher });
    assert.equal(calls, 1, 'the fetched series is kept in memory between readers');
    const slow = await ph.topUp('SLOW', stored('2026-06-11'), { now, waitMs: 20, fetcher: () => new Promise((r) => setTimeout(() => r({ daily: { '2026-10-09': { '4. close': '1' } }, monthly: {} }), 200)) });
    assert.equal(ph.latest(ph.dailyOf(slow)), '2026-06-11');
});
