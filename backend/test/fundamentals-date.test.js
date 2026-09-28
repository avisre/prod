'use strict';

// Freshness must come from the data, never from filesystem mtime: a
// git-checkout deploy stamps every file with the deploy time, which is how
// June fundamentals passed as fresh on a September server and the page
// advertised the deploy date as "last refreshed".

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const fundDate = require('../fundamentals-date');
const fundFetch = require('../fundamentals-fetch');

const DAY_MS = 86400000;
const DIR = path.join(__dirname, '..', '..', 'frontend', 'data', 'fundamentals');
const TEST_SYMBOL = 'ZZDATE1';
const TEST_FILE = path.join(DIR, `${TEST_SYMBOL}.json`);
const FRESH_SYMBOL = 'ZZDATE2';
const FRESH_FILE = path.join(DIR, `${FRESH_SYMBOL}.json`);

function payload({ fetchedAt, period, daily } = {}) {
    const p = { overview: { Name: 'Test Co' } };
    if (period) p.income = { annualReports: [{ fiscalDateEnding: period, totalRevenue: '1000' }], quarterlyReports: [] };
    if (daily) p.daily = { 'Time Series (Daily)': { [daily]: { '4. close': '10' } } };
    if (fetchedAt) p.fetchedAt = fetchedAt;
    return p;
}

test('dataAsOf is the newest date present in the data', () => {
    const d = fundDate.describe(payload({ period: '2026-03-31', daily: '2026-06-10' }));
    assert.equal(d.dataAsOf, '2026-06-10');
});

test('fetchedAt is the freshness clock when present', () => {
    const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS).toISOString();
    const d = fundDate.describe(payload({ fetchedAt: twoDaysAgo, period: '2025-12-31', daily: '2025-12-31' }));
    assert.equal(d.fetchedAt, twoDaysAgo);
    assert.ok(d.ageDays <= 2, `ageDays=${d.ageDays}`);
    assert.equal(d.stale, false);
});

test('data with old dates and no stamp is stale', () => {
    const d = fundDate.describe(payload({ period: '2025-06-30', daily: '2025-06-30' }));
    assert.ok(d.ageDays > fundDate.STALE_DAYS);
    assert.equal(d.stale, true);
});

test('a file with no datable content reports no age, and a missing file is missing rather than stale', () => {
    const d = fundDate.describe({ overview: {} });
    assert.equal(d.ageDays, null);
    assert.equal(d.stale, false);
    assert.equal(fundFetch.isStaleOnDemand(TEST_SYMBOL), false);
});

test('isStaleOnDemand reads the data dates, not the file mtime', () => {
    fs.mkdirSync(DIR, { recursive: true });
    // Content from a year ago written *now* — exactly the deploy-checkout case.
    fs.writeFileSync(TEST_FILE, JSON.stringify(payload({ period: '2025-01-31', daily: '2025-01-31' })));
    fs.writeFileSync(FRESH_FILE, JSON.stringify(payload({
        fetchedAt: new Date().toISOString(), period: '2026-03-31', daily: '2026-06-30'
    })));
    try {
        assert.equal(fundFetch.isStaleOnDemand(TEST_SYMBOL), true, 'old content must read as stale however new the file');
        assert.equal(fundFetch.isStaleOnDemand(FRESH_SYMBOL), false, 'a fresh write stamp makes it fresh');
    } finally {
        fs.rmSync(TEST_FILE, { force: true });
        fs.rmSync(FRESH_FILE, { force: true });
    }
});

test('the refreshed files carry a fetchedAt stamp the page can show', () => {
    const stamped = fundDate.describe({ ...payload({ period: '2026-03-31' }), fetchedAt: '2026-09-01T00:00:00.000Z' });
    assert.equal(stamped.fetchedAt, '2026-09-01T00:00:00.000Z');
    assert.match(stamped.fetchedAt.slice(0, 10), /^\d{4}-\d{2}-\d{2}$/);
});

test('a real cached symbol resolves a data date', () => {
    const info = fundDate.info('EXEL');
    assert.match(String(info.dataAsOf), /^\d{4}-\d{2}-\d{2}$/);
});
