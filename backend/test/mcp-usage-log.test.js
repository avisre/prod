'use strict';

// mcp-usage-log.js — the mcp_calls usage log: facets, caller hashing, result
// facets, the write path, the Phase-2 aggregation, and the admin auth gate.
//
// The privacy rules are the point of the module, so they are the point of the
// tests: no raw question, no raw IP, no unknown argument key, no company name
// that is not ticker-shaped, ever reaches a row. The caller hash is asserted
// to be stable within a month, different across months, different for signed-in
// vs keyless, and to never equal or contain the IP.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const usage = require('../mcp-usage-log');

const APP_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

async function memoryCol(t) {
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await mem.stop(); });
    return mongoose.connection.collection(usage.COLLECTION);
}

// ---------------------------------------------------------------------------
// facetsFor — structured research inputs, never the raw arguments
// ---------------------------------------------------------------------------

test('facets never contain the raw question, a raw IP or unknown argument keys', () => {
    const question = 'What are the main risk factors with the filing?';
    const facets = usage.facetsFor('ask_filings', {
        ticker: 'aapl',
        question,
        visitor_ip: '203.0.113.9',        // unknown key: must not be echoed
        conversation: 'ignore me too'
    });
    const serialized = JSON.stringify(facets);
    assert.ok(!serialized.includes(question), 'the question text is never stored');
    assert.ok(!serialized.includes('203.0.113.9'), 'an IP-looking unknown key is never stored');
    assert.ok(!serialized.includes('visitor_ip') && !serialized.includes('conversation'), 'unknown argument keys are not facets');
    assert.deepEqual(facets.tickers, ['AAPL']);
    assert.equal(facets.topic, 'risk');
    assert.equal(facets.questionLen, question.length);
    assert.ok(!('question' in facets));
});

test('tickers are upper-cased, capped at 10 and 12 chars, and names are dropped', () => {
    const facets = usage.facetsFor('compare_company_metrics', {
        companies: ['aapl', 'Not A Company Name At All', 'MSFT', 'goog', 'amzn', 'nvda', 'meta', 'tsla', 'brk.b', 'bf-b', 'wmt', 'unh', 'jpm'],
        tickers: ['xom', 'v']
    });
    assert.ok(facets.tickers.length <= 10, 'at most 10 tickers');
    for (const ticker of facets.tickers) {
        assert.equal(ticker, ticker.toUpperCase());
        assert.ok(ticker.length <= 12, `${ticker} within 12 chars`);
        assert.match(ticker, /^[A-Z]/, 'only ticker-shaped values survive');
    }
    assert.ok(!facets.tickers.includes('NOT A COMPANY'), 'a company name is not a ticker facet');
    assert.ok(!facets.tickers.includes('UNH'), 'an entry past the cap is dropped');
    assert.ok(!facets.tickers.includes('V'), 'a second list cannot climb past the cap either');
});

test('the ask topic classifier buckets the common question shapes', () => {
    const cases = [
        ['Why did gross margin fall last quarter?', 'margins'],
        ['What is the free cash flow trend?', 'cash_flow'],
        ['How leveraged are they versus peers?', 'debt_liquidity'],
        ['Is the stock cheap on earnings?', 'valuation'],
        ['What did management guide for next year?', 'guidance'],
        ['Which segment declined?', 'segments'],
        ['Compare revenue growth with Microsoft', 'comparison'],
        ['Is the goodwill impaired?', 'accounting'],
        ['How fast is revenue growing?', 'growth'],
        ['Anything about the new buyback?', 'capital_return'],
        ['Tell me something random', 'other']
    ];
    for (const [question, expected] of cases) {
        assert.equal(usage.classifyTopic(question), expected, question);
    }
});

test('a company search term is kept only for search_companies, lower-cased and bounded', () => {
    const search = usage.facetsFor('search_companies', { query: '  Berkshire Hathaway Inc  ' });
    assert.equal(search.term, 'berkshire hathaway inc');
    assert.equal(usage.facetsFor('search_companies', { query: 'x'.repeat(100) }).term.length, 60, 'term is capped at 60 chars');
    const other = usage.facetsFor('get_company_fundamentals', { query: 'Berkshire' });
    assert.equal(other.term, undefined, 'a filing-search query is not a company search term');
    assert.equal(other.hasQuery, true);
    assert.equal(other.queryLen, 'Berkshire'.length);
});

test('metrics, forms, section and periods facets are bounded', () => {
    const facets = usage.facetsFor('search_filings', {
        ticker: 'AAPL',
        filing_type: ['10-K', '10-Q'],
        section: 'Risk Factors',
        periods: 5
    });
    assert.deepEqual(facets.forms, ['10-K', '10-Q']);
    assert.equal(facets.section, 'Risk Factors');
    assert.equal(facets.periods, 5);
    const many = usage.facetsFor('get_company_fundamentals', {
        metrics: Array.from({ length: 30 }, (_, i) => `metric_${i}`)
    });
    assert.equal(many.metrics.length, 20, 'at most 20 metrics');
    for (const m of many.metrics) assert.ok(m.length <= 40);
});

// ---------------------------------------------------------------------------
// callerHash — pseudonymous, monthly for keyless, never the IP
// ---------------------------------------------------------------------------

test('callerHash is stable within a month, rotates across months, and separates callers', () => {
    const priorSecret = process.env.MCP_USAGE_SALT;
    const priorJwt = process.env.JWT_SECRET;
    process.env.MCP_USAGE_SALT = 'test-salt';
    delete process.env.JWT_SECRET;
    try {
        const ip = '203.0.113.9';
        const a = usage.callerHash({ anonymous: true, ip, now: new Date('2026-10-05T12:00:00Z') });
        const b = usage.callerHash({ anonymous: true, ip, now: new Date('2026-10-28T23:00:00Z') });
        const nextMonth = usage.callerHash({ anonymous: true, ip, now: new Date('2026-11-02T00:00:00Z') });
        const otherIp = usage.callerHash({ anonymous: true, ip: '198.51.100.7', now: new Date('2026-10-05T12:00:00Z') });
        const signedIn = usage.callerHash({ anonymous: false, userId: '507f1f77bcf86cd799439011' });

        assert.equal(a, b, 'stable within the month');
        assert.notEqual(a, nextMonth, 'the keyless id rotates with the month');
        assert.notEqual(a, otherIp, 'different addresses hash differently');
        assert.notEqual(a, signedIn, 'keyless and signed-in ids never collide');
        assert.match(a, /^[0-9a-f]{16}$/, '16 hex chars');
        for (const hash of [a, nextMonth, otherIp, signedIn]) {
            assert.ok(!hash.toLowerCase().includes(ip), 'the hash never contains the IP');
            assert.notEqual(hash, ip);
        }
        // The salt is secret material: the digest must depend on it.
        process.env.MCP_USAGE_SALT = 'another-salt';
        assert.notEqual(usage.callerHash({ anonymous: true, ip, now: new Date('2026-10-05T12:00:00Z') }), a);
    } finally {
        if (priorSecret === undefined) delete process.env.MCP_USAGE_SALT; else process.env.MCP_USAGE_SALT = priorSecret;
        if (priorJwt !== undefined) process.env.JWT_SECRET = priorJwt;
    }
});

test('callerHash falls back to JWT_SECRET and then to a constant when unset', () => {
    const priorSalt = process.env.MCP_USAGE_SALT;
    const priorJwt = process.env.JWT_SECRET;
    delete process.env.MCP_USAGE_SALT;
    process.env.JWT_SECRET = 'jwt-secret-for-test';
    const withJwt = usage.callerHash({ anonymous: true, ip: '203.0.113.9' });
    delete process.env.JWT_SECRET;
    const withDefault = usage.callerHash({ anonymous: true, ip: '203.0.113.9' });
    assert.notEqual(withJwt, withDefault);
    assert.ok(usage.callerHash({ anonymous: true, ip: null }) === null, 'no IP means no keyless id');
    assert.ok(usage.callerHash({ anonymous: false, userId: null }) === null, 'no user means no signed-in id');
    if (priorSalt !== undefined) process.env.MCP_USAGE_SALT = priorSalt;
    if (priorJwt !== undefined) process.env.JWT_SECRET = priorJwt; else delete process.env.JWT_SECRET;
});

// ---------------------------------------------------------------------------
// resultFacets and nullShare
// ---------------------------------------------------------------------------

test('resultFacets reads a success: rows, bytes, empty and nullShare', () => {
    const payload = { filings: [{ v: 1 }, { v: null }, { v: 3 }, { v: null }] };
    const facets = usage.resultFacets({ structuredContent: payload, content: [{ type: 'text', text: JSON.stringify(payload) }] });
    assert.equal(facets.ok, true);
    assert.equal(facets.code, null);
    assert.equal(facets.rows, 4);
    assert.equal(facets.empty, false);
    assert.equal(facets.nullShare, 0.5);
    assert.ok(facets.bytes > 0);
});

test('resultFacets reads a refusal: ok false, the code, and empty on a zero-row success', () => {
    const refusal = { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: 'QUOTA_EXCEEDED', error: 'That was all.' }) }] };
    const facets = usage.resultFacets(refusal);
    assert.equal(facets.ok, false);
    assert.equal(facets.code, 'QUOTA_EXCEEDED');
    assert.equal(facets.empty, false, 'empty is a success-only facet');

    const none = usage.resultFacets({ structuredContent: { companies: [] }, content: [{ type: 'text', text: '[]' }] });
    assert.equal(none.rows, 0);
    assert.equal(none.empty, true);
    assert.equal(none.nullShare, null, 'no numeric leaves means no nullShare');
});

test('nullShare scans at most 5,000 leaves', () => {
    // 4,000 numbers then 3,000 nulls: an uncapped walk would say 3/7 ≈ 0.43,
    // the capped one stops at 5,000 leaves and says 1,000/5,000 = 0.2.
    const rows = [
        ...Array.from({ length: 4000 }, () => ({ v: 1 })),
        ...Array.from({ length: 3000 }, () => ({ v: null }))
    ];
    assert.equal(usage.nullShare(rows), 0.2);
    assert.equal(usage.nullShare(null), null);
    assert.equal(usage.nullShare({ a: 'text' }), null);
});

// ---------------------------------------------------------------------------
// record — fire-and-forget, never throws, switchable
// ---------------------------------------------------------------------------

test('record writes one small row with nulls dropped, and the TTL index exists', async (t) => {
    const col = await memoryCol(t);
    usage.record(col, {
        surface: 'mcp', era: 'legacy', client: 'Claude', platform: null, anonymous: true, pool: 'visitor',
        caller: 'a1b2c3d4e5f60718', plan: null, tool: 'search_companies', code: null, ms: 42,
        ...usage.facetsFor('search_companies', { query: 'Apple' }),
        ...usage.resultFacets({ structuredContent: { companies: [] }, content: [] })
    });
    // The insert is fire-and-forget; poll for it rather than sleeping.
    let row = null;
    for (let i = 0; i < 50 && !row; i++) {
        await new Promise((resolve) => setTimeout(resolve, 50));
        row = await col.findOne({});
    }
    assert.ok(row, 'the row landed');
    assert.ok(row.at instanceof Date);
    assert.equal(row.surface, 'mcp');
    assert.equal(row.tool, 'search_companies');
    assert.equal(row.term, 'apple');
    assert.equal(row.empty, true);
    assert.equal('platform' in row, false, 'null keys are dropped');
    assert.equal('code' in row, false);
    assert.equal('plan' in row, false);

    // TTL index with the configured retention, plus the tool/at query index.
    let indexes = [];
    for (let i = 0; i < 50; i++) {
        indexes = await col.indexes();
        if (indexes.some((ix) => ix.name === 'at_1')) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const ttl = indexes.find((ix) => ix.name === 'at_1');
    assert.ok(ttl, 'the TTL index exists');
    assert.equal(ttl.expireAfterSeconds, usage.RETENTION_DAYS * 86400);
    assert.ok(indexes.some((ix) => ix.name === 'tool_1_at_-1'));
});

test('record never throws with a broken collection, and MCP_USAGE_LOG=false writes nothing', () => {
    const broken = {
        insertOne: () => { throw new Error('collection down'); },
        createIndex: () => { throw new Error('collection down'); }
    };
    assert.doesNotThrow(() => usage.record(broken, { tool: 'sp_health' }));

    const prior = process.env.MCP_USAGE_LOG;
    process.env.MCP_USAGE_LOG = 'false';
    try {
        const writes = [];
        const col = { insertOne: (doc) => { writes.push(doc); return Promise.resolve(); }, createIndex: () => Promise.resolve() };
        usage.record(col, { tool: 'sp_health', ok: true });
        assert.equal(writes.length, 0, 'the switch disables every write');
    } finally {
        if (prior === undefined) delete process.env.MCP_USAGE_LOG; else process.env.MCP_USAGE_LOG = prior;
    }
});

// ---------------------------------------------------------------------------
// collectMcpUsage — the Phase-2 aggregation
// ---------------------------------------------------------------------------

test('collectMcpUsage folds seeded rows into every section of the report', async (t) => {
    const col = await memoryCol(t);
    const now = new Date();
    const row = (fields) => col.insertOne({ at: now, ...fields });
    await row({ tool: 'search_companies', surface: 'mcp', anonymous: true, caller: 'anon1', ok: true, ms: 10, term: 'apple', empty: true });
    await row({ tool: 'search_companies', surface: 'mcp', anonymous: true, caller: 'anon1', ok: true, ms: 12, term: 'apple', empty: true, tickers: ['AAPL'] });
    await row({ tool: 'get_company_fundamentals', surface: 'mcp', anonymous: false, caller: 'user1', ok: true, ms: 200, tickers: ['NVDA'], metrics: ['revenue'], rows: 5, nullShare: 0.2, client: 'Claude', platform: 'platform' });
    await row({ tool: 'ask_filings', surface: 'apps', anonymous: false, caller: 'user1', ok: false, code: 'QUOTA_EXCEEDED', ms: 30, topic: 'margins', questionLen: 40 });
    await row({ tool: 'ask_filings', surface: 'apps', anonymous: false, caller: 'user2', ok: true, ms: 9000, topic: 'risk', questionLen: 20 });

    const report = await usage.collectMcpUsage(col, { days: 7 });
    assert.equal(report.days, 7);
    assert.equal(report.totals.calls, 5);
    assert.equal(report.totals.ok, 4);
    assert.equal(report.totals.refused, 1);
    assert.equal(report.totals.anonymousCallers, 1);
    assert.equal(report.totals.signedInCallers, 2);

    const search = report.byTool.find((r) => r.tool === 'search_companies');
    assert.equal(search.calls, 2);
    assert.equal(search.okRate, 100);
    assert.ok(search.p50Ms > 0, 'a percentile was computed');

    const asked = report.byTool.find((r) => r.tool === 'ask_filings');
    assert.equal(asked.calls, 2);
    assert.equal(asked.ok, 1);

    assert.ok(report.byClient.some((r) => r.client === 'Claude' && r.platform === 'platform'));
    assert.deepEqual(report.refusals, [{ code: 'QUOTA_EXCEEDED', count: 1 }]);
    assert.deepEqual(report.tickers, [{ ticker: 'AAPL', count: 1 }, { ticker: 'NVDA', count: 1 }]);
    assert.deepEqual(report.metrics, [{ metric: 'revenue', count: 1 }]);
    assert.deepEqual(report.emptySearchTerms, [{ term: 'apple', count: 2 }], 'the coverage gap is named');
    assert.ok(report.askTopics.some((t) => t.topic === 'margins' && t.count === 1));
    assert.equal(report.perDay.length, 1);
    // anon1 started with search_companies; user1 started with get_company_fundamentals.
    const firstTools = Object.fromEntries(report.firstTools.map((r) => [r.tool, r.count]));
    assert.equal(firstTools.search_companies, 1);
    assert.equal(firstTools.get_company_fundamentals, 1);
    assert.equal(firstTools.ask_filings, 1, 'user2 counts too');

    // The window is bounded: a row outside it is invisible.
    await col.insertOne({ at: new Date(now.getTime() - 30 * 86400000), tool: 'sp_health', surface: 'mcp', anonymous: true, caller: 'old', ok: true, ms: 1 });
    const week = await usage.collectMcpUsage(col, { days: 7 });
    assert.equal(week.totals.calls, 5);
    const month = await usage.collectMcpUsage(col, { days: 90 });
    assert.equal(month.totals.calls, 6);
    assert.equal((await usage.collectMcpUsage(null, { days: 7 })).totals.calls, 0, 'no collection is an empty report, not a crash');
});

// ---------------------------------------------------------------------------
// Admin auth — token header valid → allowed; else session + dashboard gate
// ---------------------------------------------------------------------------

test('the admin auth gate: 403 without auth, 200 with a valid token header', async (t) => {
    const prior = process.env.ADMIN_TOKEN;
    process.env.ADMIN_TOKEN = 'test-admin-token-value';
    const dashboardOnly = (req, res) => res.status(403).json({ message: 'Dashboard access denied' });
    // Mirrors app.js: the session check falls through to the dashboard gate.
    const sessionAuth = (req, res, next) => dashboardOnly(req, res, next);
    const gate = usage.adminAuth({ sessionAuth, dashboardOnly });

    const app = express();
    app.get('/api/admin/mcp-usage', gate, (req, res) => res.json({ ok: true }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const url = `http://127.0.0.1:${server.address().port}/api/admin/mcp-usage`;

    const bare = await fetch(url);
    assert.equal(bare.status, 403, 'no credentials is refused');
    const wrong = await fetch(url, { headers: { 'x-admin-token': 'not-the-token' } });
    assert.equal(wrong.status, 403, 'a wrong token is refused');
    const right = await fetch(url, { headers: { 'x-admin-token': 'test-admin-token-value' } });
    assert.equal(right.status, 200);
    assert.equal((await right.json()).ok, true);

    // The routes in app.js are wired to this gate, with the marketing nav link.
    assert.match(APP_SOURCE, /app\.get\('\/api\/admin\/mcp-usage', mcpUsageAdminAuth,/, 'the JSON route uses the gate');
    assert.match(APP_SOURCE, /app\.get\('\/admin\/mcp-usage', mcpUsageAdminAuth,/, 'the HTML route uses the gate');
    assert.match(APP_SOURCE, /href="\/admin\/mcp-usage">MCP usage</, 'the marketing dashboard links to it');

    if (prior === undefined) delete process.env.ADMIN_TOKEN; else process.env.ADMIN_TOKEN = prior;
});