'use strict';
// Per-user usage measurement: rollup maths, bounds, and cache attribution.
// No database is required — the aggregator is pure in-memory until flush().
const test = require('node:test');
const assert = require('node:assert/strict');
const usage = require('../usage-aggregate');
const usageContext = require('../usage-context');
const { createCache, MAX_PERSISTENT } = require('../public-financial-cache');

test.afterEach(() => usage.__reset());

test('the day key follows IST, not UTC', () => {
    // 2026-11-20T20:00Z is 2026-11-21 01:30 IST: a UTC day boundary would split
    // one working evening across two rows.
    assert.equal(usage.istDay(new Date('2026-11-20T20:00:00Z')), '2026-11-21');
    assert.equal(usage.istDay(new Date('2026-11-20T18:29:00Z')), '2026-11-20');
    assert.equal(usage.istDay(new Date('2026-11-20T18:31:00Z')), '2026-11-21');
});

test('caller keys separate accounts, keyless visitors and server work', () => {
    assert.equal(usage.userKeyOf({ userId: 'abc123' }), 'u:abc123');
    assert.equal(usage.userKeyOf({ callerHash: 'f'.repeat(16) }), 'a:' + 'f'.repeat(16));
    assert.equal(usage.userKeyOf({ system: 'warmup' }), 'system:warmup');
    assert.equal(usage.userKeyOf({}), null, 'nothing identifiable is never guessed');
    assert.equal(usage.userKeyOf({ system: 'boot', userId: 'x' }), 'system:boot', 'server work is never billed to a customer');
});

test('only the known surfaces are accepted', () => {
    for (const s of ['web', 'rest', 'mcp', 'mcp-apps', 'system']) assert.equal(usage.surfaceOf(s), s);
    assert.equal(usage.surfaceOf('nonsense'), 'web');
    assert.equal(usage.surfaceOf(undefined), 'web');
});

test('a request rollup adds response bytes and the cache bytes it caused', () => {
    assert.equal(usage.record({
        at: new Date('2026-11-21T05:00:00Z'),
        userId: 'u1', surface: 'web', route: '/api/company/*',
        resBytes: 5000, ok: true,
        cache: { hits: 1, misses: 2, readBytes: 5800000, writeBytes: 2900000 }
    }), true);
    const [bucket] = usage.__snapshot();
    assert.equal(bucket.userKey, 'u:u1');
    assert.equal(bucket.requests, 1);
    assert.equal(bucket.resBytes, 5000);
    assert.equal(bucket.cacheMisses, 2);
    assert.equal(bucket.cacheReadBytes, 5800000);
    assert.equal(bucket.cacheWriteBytes, 2900000);
    assert.equal(bucket.route.get('/api/company/*'), 1);
});

test('an error is counted as an error, not a success', () => {
    usage.record({ userId: 'u1', surface: 'rest', route: '/api/x', ok: false });
    const [bucket] = usage.__snapshot();
    assert.equal(bucket.err, 1);
    assert.equal(bucket.ok, 0);
});

test('unidentifiable traffic is dropped instead of inventing a user', () => {
    assert.equal(usage.record({ surface: 'web', route: '/api/x', resBytes: 10 }), false);
    assert.equal(usage.__snapshot().length, 0);
});

test('symbols and metrics are counted, and the tool dimension is kept', () => {
    usage.record({ userId: 'u1', surface: 'mcp', tool: 'get_company_fundamentals', symbols: ['aapl', 'MSFT'], metrics: ['revenue'], resBytes: 1024 });
    usage.record({ userId: 'u1', surface: 'mcp', tool: 'get_company_fundamentals', symbols: ['AAPL'], resBytes: 1024 });
    const [bucket] = usage.__snapshot();
    assert.equal(bucket.tool.get('get_company_fundamentals'), 2);
    assert.equal(bucket.symbol.get('AAPL'), 2, 'symbols are normalised to upper case');
    assert.equal(bucket.symbol.get('MSFT'), 1);
    assert.equal(bucket.metric.get('revenue'), 1);
});

test('a busy day cannot grow the dimension map without bound', () => {
    for (let i = 0; i < usage.MAX_DIM + 50; i += 1) {
        usage.record({ userId: 'u1', surface: 'web', route: '/api/route-' + i, resBytes: 1 });
    }
    const [bucket] = usage.__snapshot();
    assert.equal(bucket.route.size, usage.MAX_DIM, 'new keys past the cap are dropped');
    assert.equal(bucket.requests, usage.MAX_DIM + 50, 'scalar counters keep counting');
});

test('the per-request event buffer is capped rather than growing the heap', () => {
    for (let i = 0; i < usage.MAX_EVENTS + 25; i += 1) {
        usage.recordEvent({ userId: 'u1', surface: 'web', route: '/api/x', resBytes: 1 });
    }
    assert.equal(usage.stats().events, usage.MAX_EVENTS);
    assert.equal(usage.stats().droppedEvents, 25);
});

test('the flush payload increments scalars and keeps dotted routes out of field names', () => {
    usage.record({
        at: new Date('2026-11-21T05:00:00Z'), userId: 'u1', surface: 'web',
        route: '/api/company/*', plan: 'pro', resBytes: 100, ok: true,
        cache: { misses: 1, readBytes: 200 }
    });
    const { dailyOps, countOps } = usage.flushOperations(usage.__snapshot());
    assert.equal(dailyOps.length, 1);
    const daily = dailyOps[0].updateOne;
    assert.deepEqual(daily.filter, { userKey: 'u:u1', surface: 'web', day: '2026-11-21' });
    assert.equal(daily.update.$inc.requests, 1);
    assert.equal(daily.update.$inc.resBytes, 100);
    assert.equal(daily.update.$inc.cacheReadBytes, 200);
    assert.equal(daily.update.$setOnInsert.plan, 'pro');
    // A route such as `/api/company/*` contains a dot; Mongo forbids dots in
    // field names, which is why dimensions live in their own collection.
    for (const op of countOps) assert.ok(!Object.keys(op.updateOne.filter).some((k) => k.includes('.') || String(op.updateOne.filter[k]).includes('.')));
    const routeOp = countOps.find((op) => op.updateOne.filter.kind === 'route');
    assert.equal(routeOp.updateOne.filter.key, '/api/company/*');
    assert.equal(routeOp.updateOne.update.$inc.n, 1);
});

test('measurement can be switched off without a deploy', () => {
    const prior = process.env.USAGE_METRICS;
    process.env.USAGE_METRICS = 'false';
    try {
        assert.equal(usage.enabled(), false);
        assert.equal(usage.record({ userId: 'u1', surface: 'web', route: '/api/x' }), false);
        assert.equal(usage.__snapshot().length, 0);
    } finally {
        if (prior === undefined) delete process.env.USAGE_METRICS; else process.env.USAGE_METRICS = prior;
    }
});

// --- cache attribution -----------------------------------------------------

function cacheFixture() {
    const rows = new Map();
    let uploads = 0;
    const col = {
        createIndex: async () => {},
        findOne: async (q) => (q._id ? rows.get(q._id) || null : [...rows.values()].reverse().find((r) => r.issuer === q.issuer) || null),
        insertOne: async (row) => {
            uploads += 1;
            if (rows.has(row._id)) throw Object.assign(new Error('duplicate'), { code: 11000 });
            rows.set(row._id, row);
        }
    };
    const connection = {
        readyState: 1,
        db: { createCollection: async () => {}, listCollections: () => ({ next: async () => ({ options: { capped: true, size: MAX_PERSISTENT } }) }) },
        collection: () => col
    };
    return { connection, uploads: () => uploads, rows };
}

test('a memory hit costs nothing; a Mongo read is charged as a miss with its bytes', async () => {
    const db = cacheFixture();
    const cache = createCache({ connection: () => db.connection });
    const value = { financial: { text: 'x'.repeat(5000) } };
    const store = usageContext.createStore();
    await usageContext.run(store, async () => {
        await cache.set('cik-1', value);              // first write
        await cache.get('cik-1');                     // memory hit
        cache.clear();                                // force a Mongo read
        await cache.get('cik-1');                     // miss + bytes
    });
    assert.equal(store.cacheHits, 1);
    assert.equal(store.cacheMisses, 1);
    assert.ok(store.cacheReadBytes > 5000, 'the stored row size is what crossed the wire');
    assert.equal(store.cacheWriteBytes, Buffer.byteLength(JSON.stringify(value)));
    assert.equal(db.uploads(), 1);
});

test('an already-present content hash is not charged as an upload', async () => {
    const db = cacheFixture();
    const first = createCache({ connection: () => db.connection });
    const value = { financial: { text: 'y'.repeat(2000) } };
    await first.set('cik-2', value);
    const restarted = createCache({ connection: () => db.connection });
    const store = usageContext.createStore();
    await usageContext.run(store, () => restarted.set('cik-2', value));
    assert.equal(db.uploads(), 1, 'the duplicate was never uploaded');
    assert.equal(store.cacheWriteBytes, 0, 'no payload moved, so no bytes are billed');
});

test('cache work with no request context is ignored rather than misattributed', async () => {
    const db = cacheFixture();
    const cache = createCache({ connection: () => db.connection });
    const value = { financial: { text: 'z'.repeat(1000) } };
    await cache.set('cik-3', value); // no usageContext.run wrapper
    await cache.get('cik-3');
    assert.equal(usage.stats().buckets, 0);
});

// --- flush path (fake connection; production is never touched) -------------

function fakeConnection() {
    const written = { daily: [], counts: [], events: [] };
    const make = (bucket) => ({
        createIndex: async () => 'ok',
        bulkWrite: async (ops) => { written[bucket].push(...ops); return { ok: 1 }; },
        insertMany: async (rows) => { written.events.push(...rows); return { insertedCount: rows.length }; }
    });
    return {
        readyState: 1,
        collection: (name) => make(name === 'usage_daily' ? 'daily' : name === 'usage_counts' ? 'counts' : 'events'),
        written
    };
}

test('flush writes incremented daily rows, dimension rows and per-request events', async () => {
    const conn = fakeConnection();
    usage.start({ connection: conn, intervalMs: 3600000 });
    usage.record({
        at: new Date('2026-11-21T05:00:00Z'), userId: '507f1f77bcf86cd799439011', surface: 'web',
        route: '/api/company/*', resBytes: 400, ok: true,
        cache: { hits: 0, misses: 1, readBytes: 2900000, writeBytes: 0 }
    });
    usage.recordEvent({ at: new Date('2026-11-21T05:00:00Z'), userId: '507f1f77bcf86cd799439011', surface: 'web', route: '/api/company/*', resBytes: 400 });
    const result = await usage.flush();
    assert.equal(result.flushed, 1);
    assert.equal(conn.written.daily.length, 1);
    assert.equal(conn.written.daily[0].updateOne.update.$inc.cacheReadBytes, 2900000);
    assert.ok(conn.written.counts.some((op) => op.updateOne.filter.kind === 'route' && op.updateOne.filter.key === '/api/company/*'));
    assert.equal(conn.written.events.length, 1);
    assert.equal(conn.written.events[0].userKey, 'u:507f1f77bcf86cd799439011');
    assert.equal(usage.__snapshot().length, 0, 'the buffer is emptied by a successful flush');
    await usage.stop();
});
