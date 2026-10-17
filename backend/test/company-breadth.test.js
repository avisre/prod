'use strict';

// Anti-scraping cap on how many different companies one account pulls through
// the connectors and the REST API (company-breadth.js).

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { MongoClient } = require('mongodb');
const { MongoMemoryServer } = require('mongodb-memory-server');
const companyBreadth = require('../company-breadth');
const freeTools = require('../free-tools');
const { buildPublicApiRouter } = require('../public-api');

const HOUR = 60 * 60 * 1000;

async function memCol(t) {
    const mem = await MongoMemoryServer.create();
    const client = await MongoClient.connect(mem.getUri());
    t.after(async () => { await client.close().catch(() => {}); await mem.stop(); });
    return client.db('t').collection('company_breadth');
}

test('companiesIn reads a ticker, a name or a list, and nothing from a call about no company', () => {
    assert.deepEqual(companyBreadth.companiesIn({ ticker: ' aapl ' }), ['AAPL']);
    assert.deepEqual(companyBreadth.companiesIn({ company: 'Berkshire  Hathaway' }), ['BERKSHIRE HATHAWAY']);
    assert.deepEqual(companyBreadth.companiesIn({ companies: ['MSFT', 'msft', 'NVDA'] }), ['MSFT', 'NVDA']);
    assert.deepEqual(companyBreadth.companiesIn({ tickers: 'AAPL, MSFT,,' }), ['AAPL', 'MSFT']);
    assert.deepEqual(companyBreadth.companiesIn({ query: 'Apple' }), []);
    assert.deepEqual(companyBreadth.companiesIn({ accession_number: '0000320193-25-000079' }), []);
    assert.equal(companyBreadth.companiesIn({ tickers: Array.from({ length: 30 }, (_, i) => `T${i}`) }).length, companyBreadth.MAX_PER_CALL);
});

test('the defaults sit far above measured use and can be tuned per deploy', () => {
    assert.deepEqual(companyBreadth.limits({}), { day: 50, month: 250 });
    assert.deepEqual(companyBreadth.limits({ CONNECTOR_DAILY_COMPANIES: '80', CONNECTOR_MONTHLY_COMPANIES: 'x' }), { day: 80, month: 250 });
});

test('the daily cap counts different companies, not calls, and frees a slot 24 hours on', { timeout: 60000 }, async (t) => {
    const col = await memCol(t);
    let clock = Date.parse('2026-10-18T09:00:00Z');
    const guard = companyBreadth.forAccount(col, 'u1', { env: { CONNECTOR_DAILY_COMPANIES: '3', CONNECTOR_MONTHLY_COMPANIES: '100' }, now: () => new Date(clock) });
    for (const c of ['AAPL', 'MSFT', 'NVDA']) {
        assert.equal((await guard.check([c])).ok, true);
        await guard.record([c]);
        clock += HOUR;
    }
    const over = await guard.check(['GOOGL']);
    assert.equal(over.ok, false);
    assert.equal(over.code, 'COMPANY_LIMIT');
    assert.equal(over.window, 'day');
    assert.equal(over.resetsAt, '2026-10-19T09:00:00.000Z', 'the oldest company of the day frees its slot first');
    // The same three names keep working all day.
    assert.equal((await guard.check(['MSFT'])).ok, true);
    // A list that brings in one new name too many is refused whole.
    assert.equal((await guard.check(['AAPL', 'GOOGL'])).ok, false);
    // Another account is counted separately.
    assert.equal((await companyBreadth.forAccount(col, 'u2', { env: { CONNECTOR_DAILY_COMPANIES: '3' }, now: () => new Date(clock) }).check(['GOOGL'])).ok, true);
    clock = Date.parse('2026-10-19T09:00:01Z');
    assert.equal((await guard.check(['GOOGL'])).ok, true, 'a slot opens once the oldest falls out of the window');
});

test('the 30-day cap holds a slow, steady walk through the universe', { timeout: 60000 }, async (t) => {
    const col = await memCol(t);
    let clock = Date.parse('2026-10-01T00:00:00Z');
    const guard = companyBreadth.forAccount(col, 'u1', { env: { CONNECTOR_DAILY_COMPANIES: '2', CONNECTOR_MONTHLY_COMPANIES: '5' }, now: () => new Date(clock) });
    let added = 0;
    for (let day = 0; day < 5; day += 1) {
        for (const c of [`A${day}`, `B${day}`]) {
            if ((await guard.check([c])).ok) { await guard.record([c]); added += 1; }
        }
        clock += 24 * HOUR + 1;
    }
    assert.equal(added, 5, 'two a day is under the daily cap, but the month stops at five');
    const over = await guard.check(['NEW']);
    assert.equal(over.window, 'month');
    assert.equal(over.resetsAt, '2026-10-31T00:00:00.000Z');
});

test('a database failure lets the call through', async () => {
    const broken = { find: () => { throw new Error('down'); }, countDocuments: async () => { throw new Error('down'); }, createIndex: async () => { throw new Error('down'); }, bulkWrite: async () => { throw new Error('down'); } };
    const guard = companyBreadth.forAccount(broken, 'u1');
    assert.equal((await guard.check(['AAPL'])).ok, true);
    await guard.record(['AAPL']);
});

test('the REST API answers 429 COMPANY_LIMIT before the lookup, and records only a successful one', { timeout: 30000 }, async (t) => {
    const original = freeTools.getToolResult;
    t.after(() => { freeTools.getToolResult = original; });
    let looked = 0;
    freeTools.getToolResult = async (slug, ticker) => { looked += 1; return { status: 200, body: { symbol: ticker } }; };
    let spent = 0;
    const recorded = [];
    let allow = false;
    const app = express();
    app.use(buildPublicApiRouter({
        credits: { check: async () => ({ ok: true }), spend: async () => { spent += 1; } },
        effectiveAskLimit: () => 100,
        aiChat: {},
        apiKeyAuth: (req, res, next) => { req.userId = 'u1'; next(); },
        apiAccessGate: (req, res, next) => next(),
        apiKeyRateLimit: (req, res, next) => next(),
        jsonParser: express.json(),
        breadthFor: () => ({
            check: async () => (allow ? { ok: true } : { ok: false, window: 'day', limit: 50, resetsAt: null, message: 'over' }),
            record: async (c) => { recorded.push(c); }
        })
    }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;

    let res = await fetch(`${base}/compare?tickers=AAPL,MSFT`);
    assert.equal(res.status, 429);
    assert.equal((await res.json()).code, 'COMPANY_LIMIT');
    assert.equal(looked, 0);
    assert.equal(spent, 0);

    allow = true;
    res = await fetch(`${base}/financials/aapl`);
    assert.equal(res.status, 200);
    assert.deepEqual(recorded, [['AAPL']]);
});
