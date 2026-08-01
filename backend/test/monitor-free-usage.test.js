'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Mongoose } = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const usage = require('../monitor-free-usage');

test('free Monitor allowance is durable, atomic, private, and capped at three stocks', { timeout: 120000 }, async (t) => {
    const server = await MongoMemoryServer.create();
    const firstDb = new Mongoose();
    await firstDb.connect(server.getUri());
    t.after(async () => { await firstDb.disconnect().catch(() => {}); await server.stop(); });

    const Model = usage.createModel(firstDb);
    const rawIp = '203.0.113.7';
    const clientHash = crypto.createHmac('sha256', 'test-only-salt').update(rawIp).digest('hex');
    const context = { clientHash, dayKey: '2026-08-01', expiresAt: new Date('2026-08-04T00:00:00Z') };

    assert.equal((await usage.claim(Model, context, 'AAPL', 3)).allowed, true);
    assert.equal((await usage.claim(Model, context, 'MSFT', 3)).allowed, true);
    assert.equal((await usage.claim(Model, context, 'NVDA', 3)).allowed, true);
    const duplicate = await usage.claim(Model, context, 'AAPL', 3);
    assert.equal(duplicate.allowed, true);
    assert.equal(duplicate.known, true);
    assert.equal((await usage.claim(Model, context, 'AMZN', 3)).allowed, false);

    const stored = await Model.findOne({ clientHash }).lean();
    assert.deepEqual(stored.symbols.sort(), ['AAPL', 'MSFT', 'NVDA']);
    assert.equal(JSON.stringify(stored).includes(rawIp), false);

    // A rejected/invalid build can return its reserved symbol without costing
    // the visitor a credit.
    await usage.release(Model, stored._id, 'NVDA');
    assert.equal((await usage.claim(Model, context, 'AMZN', 3)).allowed, true);

    // Recreate the application model on a fresh connection: the Mongo record,
    // unlike the former process Map, still recognizes the same stock.
    const secondDb = new Mongoose();
    await secondDb.connect(server.getUri());
    const RestartedModel = usage.createModel(secondDb);
    const afterRestart = await usage.claim(RestartedModel, context, 'AAPL', 3);
    assert.equal(afterRestart.allowed, true);
    assert.equal(afterRestart.known, true);
    await secondDb.disconnect();
});

test('Monitor route defaults to three, validates first, and protects poll access', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const monitorJs = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'monitor.js'), 'utf8');
    const pickBody = monitorJs.match(/function pick\(sym\) \{([\s\S]*?)\n  \}/);
    assert.match(source, /process\.env\.MONITOR_FREE_STOCKS \|\| '3'/);
    assert.match(source, /if \(!isValidTicker\(sym\)\)/);
    assert.match(source, /MONITOR_POLL_NOT_AUTHORIZED/);
    assert.match(source, /monitorFreeUsage\.claim/);
    assert.doesNotMatch(source, /const _monitorFreeSeen = new Map/);
    assert.ok(pickBody, 'Monitor picker exists');
    assert.equal((pickBody[1].match(/analyze\(sym\)/g) || []).length, 1, 'autocomplete starts one analysis loop');
});
