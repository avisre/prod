'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Mongoose } = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const buildLock = require('../dossier-build-lock');
const prewarm = require('../prewarm');

test('dossier prewarming is disabled unless explicitly enabled', () => {
    assert.equal(prewarm.shouldStart({ NODE_ENV: 'production' }), false);
    assert.equal(prewarm.shouldStart({ NODE_ENV: 'production', PREWARM: 'off' }), false);
    assert.equal(prewarm.shouldStart({ PREWARM: 'true' }), false);
    assert.equal(prewarm.shouldStart({ PREWARM: 'on' }), true);
    assert.equal(prewarm.shouldStart({ PREWARM: ' ON ' }), true);
});

test('dossier build lease prevents duplicate work and permits expiry takeover', { timeout: 120000 }, async (t) => {
    const server = await MongoMemoryServer.create();
    const db = new Mongoose();
    await db.connect(server.getUri());
    t.after(async () => { await db.disconnect().catch(() => {}); await server.stop(); });

    const Model = buildLock.createModel(db);
    const now = new Date('2026-08-03T00:00:00.000Z');

    assert.equal((await buildLock.acquire(Model, {
        key: 'AAPL:2025-09-27:v2', owner: 'worker-a', leaseMs: 60_000, now
    })).acquired, true);
    assert.equal((await buildLock.acquire(Model, {
        key: 'AAPL:2025-09-27:v2', owner: 'worker-b', leaseMs: 60_000, now
    })).acquired, false);

    // The current owner may renew its lease, but another owner cannot release it.
    assert.equal((await buildLock.acquire(Model, {
        key: 'AAPL:2025-09-27:v2', owner: 'worker-a', leaseMs: 60_000, now
    })).acquired, true);
    await buildLock.release(Model, { key: 'AAPL:2025-09-27:v2', owner: 'worker-b' });
    assert.equal((await buildLock.acquire(Model, {
        key: 'AAPL:2025-09-27:v2', owner: 'worker-b', leaseMs: 60_000, now
    })).acquired, false);

    await buildLock.release(Model, { key: 'AAPL:2025-09-27:v2', owner: 'worker-a' });
    assert.equal((await buildLock.acquire(Model, {
        key: 'AAPL:2025-09-27:v2', owner: 'worker-b', leaseMs: 60_000, now
    })).acquired, true);

    assert.equal((await buildLock.acquire(Model, {
        key: 'MSFT:2025-06-30:v2', owner: 'worker-a', leaseMs: 1_000, now
    })).acquired, true);
    assert.equal((await buildLock.acquire(Model, {
        key: 'MSFT:2025-06-30:v2', owner: 'worker-b', leaseMs: 60_000,
        now: new Date(now.getTime() + 1_001)
    })).acquired, true);
});

test('dossier route protects refreshes and handles cross-process build status', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const routeStart = source.indexOf("app.get('/api/dossier/:symbol'");
    const routeEnd = source.indexOf("app.get('/api/thesis'", routeStart);
    const route = source.slice(routeStart, routeEnd);

    assert.ok(routeStart >= 0 && routeEnd > routeStart, 'dossier route exists');
    assert.match(route, /req\.query\.refresh === '1'/);
    assert.match(route, /req\.headers\['x-admin-token'\]/);
    assert.match(route, /timingSafeStrEqual\(provided, adminToken\)/);
    assert.match(route, /status\(403\)/);
    assert.match(route, /winner\.status === 'building'/);

    assert.match(source, /if \(dossierPrewarm\.shouldStart\(\)\)/);
    assert.doesNotMatch(source, /NODE_ENV === 'production' \|\| process\.env\.PREWARM/);

    const envExample = fs.readFileSync(path.join(__dirname, '..', 'prod.env.example'), 'utf8');
    assert.match(envExample, /^PREWARM=off$/m);
});
