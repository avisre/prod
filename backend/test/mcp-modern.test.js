'use strict';

// mcp-modern.js — the 2026-07-28 ("modern") protocol on the same stateless
// POST /mcp route the SDK serves. Mounted exactly the way app.js mounts it
// (isModern → handleModern with the real tool surface, else the SDK path),
// with a real in-memory Mongo behind the anonymous limiter, because the
// modern path must charge the same allowance the legacy one does.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const mcpModern = require('../mcp-modern');
const mcpEndpoint = require('../mcp-endpoint');
const mcpAnon = require('../mcp-anon');

const MODERN = '2026-07-28';
const ANON_IP = '203.0.113.9';

// The same surface object app.js builds: the extracted tool handlers, so both
// protocol eras serve one implementation of each tool.
const SURFACE = {
    name: mcpEndpoint.SERVER_NAME,
    version: mcpEndpoint.SERVER_VERSION,
    instructions: mcpEndpoint.SERVER_INSTRUCTIONS,
    listTools: (ctx, deps) => mcpEndpoint.listToolsResult(ctx, deps),
    callTool: (ctx, deps, params) => mcpEndpoint.callToolResult(ctx, deps, params)
};

function anonCtx() {
    return { userId: ANON_IP, user: null, tier: 'free', subscription: null, anonymous: true, logId: 'modern1' };
}

function anonDeps(limiter) {
    return {
        limiter,
        effectiveAskLimit: () => 0,
        entitled: () => false,
        wallReason: null,
        oauthScopes: ['financials:read', 'filings:read', 'research:read'],
        resourceMetadataUrl: 'https://www.stockportfolio.pro/.well-known/oauth-protected-resource',
        onLog: () => {}
    };
}

// The real route shape from app.js: modern requests to handleModern, everything
// else to the SDK transport, on one Express app behind one URL.
async function mount(t, ctx, deps) {
    const app = express();
    app.post('/mcp', express.json(), async (req, res) => {
        if (mcpModern.isModern(req)) {
            await mcpModern.handleModern(req, res, SURFACE, ctx, deps);
            return;
        }
        await mcpEndpoint.handleMcpRequest(req, res, ctx, deps);
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}/mcp`;
}

// One modern request: version in params._meta AND the headers, the way a
// 2026-07-28 client sends it. `over` replaces headers outright.
function modernPost(url, { id = 1, method, params = {}, headers = {} }) {
    const body = {
        jsonrpc: '2.0',
        ...(id === null ? {} : { id }),
        method,
        params: {
            _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN, clientInfo: { name: 'modern-test', version: '1' }, clientCapabilities: {} },
            ...params
        }
    };
    return fetch(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            accept: 'application/json',
            'mcp-protocol-version': MODERN,
            'mcp-method': method,
            ...(method === 'tools/call' ? { 'mcp-name': String(params.name || '') } : {}),
            ...headers
        },
        body: JSON.stringify(body)
    });
}

test('server/discover answers the modern handshake with no initialize', { timeout: 60000 }, async (t) => {
    const url = await mount(t, anonCtx(), anonDeps({ check: async () => ({ ok: true }), spend: async () => {} }));
    const res = await modernPost(url, { method: 'server/discover' });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /application\/json/);
    const body = await res.json();
    assert.equal(body.jsonrpc, '2.0');
    assert.equal(body.id, 1);
    const result = body.result;
    assert.equal(result.resultType, 'complete', 'every result carries resultType');
    assert.ok(result.supportedVersions.includes(MODERN), 'the modern version is offered');
    assert.ok(result.supportedVersions.includes('2025-06-18'), 'and the SDK legacy versions, so a dual-era client can pick');
    assert.deepEqual(result.capabilities, { tools: {} });
    assert.ok(result.instructions && result.instructions.length > 40, 'the server instructions travel with discovery');
    assert.equal(result.ttlMs, 3600000);
    assert.equal(result.cacheScope, 'public');
    assert.deepEqual(
        result._meta['io.modelcontextprotocol/serverInfo'],
        { name: mcpEndpoint.SERVER_NAME, version: mcpEndpoint.SERVER_VERSION }
    );
    // Statelessness is part of the contract: no session id is ever minted.
    assert.equal(res.headers.get('mcp-session-id'), null);
});

test('tools/list serves the same tools as the legacy path, with ttlMs and cacheScope', { timeout: 60000 }, async (t) => {
    const url = await mount(t, anonCtx(), anonDeps({ check: async () => ({ ok: true }), spend: async () => {} }));

    const modernRes = await modernPost(url, { method: 'tools/list' });
    assert.equal(modernRes.status, 200);
    const modern = await modernRes.json();
    assert.equal(modern.result.resultType, 'complete');
    assert.equal(modern.result.ttlMs, 300000, 'tool lists are cacheable for five minutes');
    assert.equal(modern.result.cacheScope, 'public');
    assert.ok(modern.result._meta['io.modelcontextprotocol/serverInfo'], 'serverInfo rides on tools/list too');
    assert.ok(modern.result.tools.every((tl) => Array.isArray(tl.securitySchemes)), 'the per-tool security schemes survive to the modern wire');

    // The same route, the same hour, the legacy SDK client: identical names.
    // (connect() performs the initialize handshake itself.)
    const legacy = new Client({ name: 'legacy-test', version: '1.0.0' });
    await legacy.connect(new StreamableHTTPClientTransport(new URL(url)));
    t.after(() => legacy.close().catch(() => {}));
    const listed = await legacy.listTools();
    assert.deepEqual(
        modern.result.tools.map((tl) => tl.name).sort(),
        listed.tools.map((tl) => tl.name).sort(),
        'a modern client and a legacy client see the same tool set'
    );
    assert.equal(legacy.getServerVersion().name, mcpEndpoint.SERVER_NAME, 'the legacy initialize handshake still works on the shared route');
});

test('tools/call answers sp_health, and charges a lookup through the real anonymous limiter', { timeout: 60000 }, async (t) => {
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await mem.stop(); });

    const limiter = mcpAnon.creditsFor(ANON_IP, { ANON_MCP_ASK_LIMIT: '3', ANON_MCP_LOOKUP_LIMIT: '25' });
    const url = await mount(t, anonCtx(), anonDeps(limiter));

    const health = await modernPost(url, { method: 'tools/call', params: { name: 'sp_health', arguments: {} } });
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.result.resultType, 'complete');
    assert.ok(!healthBody.result.isError, 'sp_health is free and always answers');
    assert.equal(JSON.parse(healthBody.result.content[0].text).status, 'ok');
    assert.ok(healthBody.result._meta['io.modelcontextprotocol/serverInfo']);

    // A metered lookup through the modern path: the reservation check() makes
    // is confirmed by spend(), exactly as on the legacy path.
    const lookup = await modernPost(url, { method: 'tools/call', params: { name: 'search_companies', arguments: { query: 'Apple', limit: 3 } } });
    assert.equal(lookup.status, 200);
    const lookupBody = await lookup.json();
    assert.equal(lookupBody.result.resultType, 'complete', 'a metered modern call returns a result, not a refusal');
    assert.ok(!lookupBody.result.isError);
    const payload = JSON.parse(lookupBody.result.content[0].text);
    assert.ok(payload.match_count >= 1, 'the catalog answers through the modern path');
    const row = await mongoose.connection.collection(mcpAnon.COLLECTION).findOne({ _id: ANON_IP });
    assert.equal(row.lookups, 1, 'the modern call spent exactly one lookup, like the legacy one');
});

test('an unsupported version is a -32022 naming what IS supported', { timeout: 60000 }, async (t) => {
    const url = await mount(t, anonCtx(), anonDeps({ check: async () => ({ ok: true }), spend: async () => {} }));
    const res = await modernPost(url, {
        method: 'tools/list',
        // No _meta version: the header alone makes this a modern request with
        // an unknown version, which is exactly the -32022 case.
        params: { _meta: {} },
        headers: { 'mcp-protocol-version': '1900-01-01' }
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.error.code, -32022);
    assert.equal(body.error.message, 'Unsupported protocol version');
    assert.ok(body.error.data.supported.includes(MODERN));
    assert.ok(body.error.data.supported.includes('2025-06-18'), 'the legacy versions are offered for renegotiation');
    assert.equal(body.error.data.requested, '1900-01-01');
});

test('header mismatches and missing headers are -32020, never silent', { timeout: 60000 }, async (t) => {
    const url = await mount(t, anonCtx(), anonDeps({ check: async () => ({ ok: true }), spend: async () => {} }));

    const noVersion = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json', 'mcp-method': 'ping' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } } })
    });
    assert.equal(noVersion.status, 400);
    assert.equal((await noVersion.json()).error.code, -32020, 'MCP-Protocol-Version is required');

    const disagreeing = await modernPost(url, { method: 'ping', headers: { 'mcp-protocol-version': '2025-06-18' } });
    assert.equal(disagreeing.status, 400);
    assert.equal((await disagreeing.json()).error.code, -32020, 'the header must agree with params._meta');

    const noMethod = await modernPost(url, { method: 'ping', headers: { 'mcp-method': '' } });
    assert.equal(noMethod.status, 400);
    assert.equal((await noMethod.json()).error.code, -32020, 'Mcp-Method is required');

    const wrongMethod = await modernPost(url, { method: 'ping', headers: { 'mcp-method': 'tools/list' } });
    assert.equal(wrongMethod.status, 400);
    assert.equal((await wrongMethod.json()).error.code, -32020, 'Mcp-Method must match the body method');

    const noName = await modernPost(url, { method: 'tools/call', params: { name: 'sp_health', arguments: {} }, headers: { 'mcp-name': '' } });
    assert.equal(noName.status, 400);
    assert.equal((await noName.json()).error.code, -32020, 'Mcp-Name is required for tools/call');

    const wrongName = await modernPost(url, { method: 'tools/call', params: { name: 'sp_health', arguments: {} }, headers: { 'mcp-name': 'search_companies' } });
    assert.equal(wrongName.status, 400);
    assert.equal((await wrongName.json()).error.code, -32020, 'Mcp-Name must match params.name');
});

test('a base64-encoded Mcp-Name is decoded before comparison', { timeout: 60000 }, async (t) => {
    const url = await mount(t, anonCtx(), anonDeps({ check: async () => ({ ok: true }), spend: async () => {} }));
    const encoded = `=?base64?${Buffer.from('sp_health', 'utf8').toString('base64')}?=`;
    const res = await modernPost(url, { method: 'tools/call', params: { name: 'sp_health', arguments: {} }, headers: { 'mcp-name': encoded } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.ok(!body.result.isError, 'an encoded-word Mcp-Name names the same tool');
    assert.equal(JSON.parse(body.result.content[0].text).status, 'ok');
});

test('an unknown method is HTTP 404 with -32601, and a notification is a 202 with no body', { timeout: 60000 }, async (t) => {
    const url = await mount(t, anonCtx(), anonDeps({ check: async () => ({ ok: true }), spend: async () => {} }));

    const unknown = await modernPost(url, { method: 'resources/list' });
    assert.equal(unknown.status, 404);
    const body = await unknown.json();
    assert.equal(body.error.code, -32601);
    assert.equal(body.error.message, 'Method not found');

    const note = await modernPost(url, { id: null, method: 'notifications/initialized' });
    assert.equal(note.status, 202, 'a notification is acknowledged');
    assert.equal(await note.text(), '', 'with an empty body');
});

test('a modern refusal keeps its sign-in challenge beside serverInfo', { timeout: 60000 }, async (t) => {
    // The Phase-3 _meta must survive the modern wrapper: a modern client that
    // hits the cap needs the account-linking challenge as much as a legacy one.
    const refusing = {
        check: async () => ({ ok: false, used: 25, allowance: 25, resetsAt: null, pool: 'visitor', message: 'That was all 25 free data lookups in this rolling 30-day window.' }),
        spend: async () => {}
    };
    const url = await mount(t, anonCtx(), anonDeps(refusing));
    const res = await modernPost(url, { method: 'tools/call', params: { name: 'search_companies', arguments: { query: 'Apple' } } });
    assert.equal(res.status, 200, 'a tool refusal is a result, never an HTTP error');
    const body = await res.json();
    assert.equal(body.result.resultType, 'complete');
    assert.equal(body.result.isError, true);
    const meta = body.result._meta;
    assert.ok(meta['io.modelcontextprotocol/serverInfo'], 'serverInfo is merged in');
    assert.match(meta['mcp/www_authenticate'][0], /resource_metadata=/, 'and the sign-in challenge survives beside it');
});

test('isModern routes by era: initialize and legacy versions stay on the SDK path', () => {
    const req = (body, headers = {}) => ({ body, get: (name) => headers[name] });
    assert.equal(mcpModern.isModern(req({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: MODERN } })), false, 'initialize is always the SDK handshake');
    assert.equal(mcpModern.isModern(req({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })), false, 'no version marker anywhere is a legacy client');
    assert.equal(mcpModern.isModern(req({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { 'mcp-protocol-version': '2025-06-18' })), false, 'a legacy version header is the SDK path');
    assert.equal(mcpModern.isModern(req({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: { _meta: { 'io.modelcontextprotocol/protocolVersion': MODERN } } })), true, '_meta version means modern');
    assert.equal(mcpModern.isModern(req({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }, { 'mcp-protocol-version': '1900-01-01' })), true, 'an unknown version gets the actionable -32022, not the SDK dead end');
    assert.equal(mcpModern.isModern(req([1, 2])), false, 'a batch body is not a modern request');
    assert.equal(mcpModern.isModern(req(null)), false);
});
test('a new tool lists and answers through the modern path', { timeout: 60000 }, async (t) => {
    const deps = anonDeps({ check: async () => ({ ok: true }), spend: async () => {} });
    deps.recentFilings = () => ({
        since: '2026-10-18', kinds: ['annual'], match_count: 1,
        filings: [{ ticker: 'AAPL', name: 'Apple Inc.', kind: 'annual', form: '10-K', filing_date: '2026-10-20', period_end: '2026-09-26', filing_url: 'https://www.sec.gov/x' }]
    });
    const url = await mount(t, anonCtx(), deps);
    const list = await (await modernPost(url, { method: 'tools/list' })).json();
    assert.ok(list.result.tools.some((tl) => tl.name === 'get_recent_filings'));
    const res = await modernPost(url, { method: 'tools/call', params: { name: 'get_recent_filings', arguments: { kinds: ['annual'] } } });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.result.resultType, 'complete');
    assert.ok(!body.result.isError);
    assert.equal(JSON.parse(body.result.content[0].text).filings[0].ticker, 'AAPL');
});

// ---------------------------------------------------------------------------
// The per-account trial through the 2026-07-28 path: a modern client that
// signed in on a free account runs on the same trial limiter the legacy path
// uses, and reads the same trial block and refusal codes.
// ---------------------------------------------------------------------------

test('a modern trial caller gets the trial block, and a TRIAL_ENDED refusal is a result, never an HTTP error', { timeout: 60000 }, async (t) => {
    const mongoose = require('mongoose');
    const { MongoMemoryServer } = require('mongodb-memory-server');
    const mcpTrial = require('../mcp-trial');
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await mem.stop(); });

    const trialCtx = { userId: 't1', user: { _id: 't1' }, tier: 'free', subscription: { planId: 'free' }, anonymous: false, trial: true, logId: 'moderntrial' };
    const trialDeps = () => ({
        limiter: mcpTrial.creditsFor('t1'),
        effectiveAskLimit: () => 0,
        entitled: () => true,
        wallReason: null,
        oauthScopes: ['financials:read', 'filings:read', 'research:read'],
        resourceMetadataUrl: 'https://www.stockportfolio.pro/.well-known/oauth-protected-resource',
        onLog: () => {}
    });

    const url = await mount(t, trialCtx, trialDeps());
    const ok = await modernPost(url, { method: 'tools/call', params: { name: 'search_companies', arguments: { query: 'Apple', limit: 2 } } });
    assert.equal(ok.status, 200, 'a trial caller answers through the modern path');
    const okBody = await ok.json();
    assert.ok(!okBody.result.isError);
    const payload = JSON.parse(okBody.result.content[0].text);
    assert.ok(payload.match_count >= 1, 'the data is real');
    assert.equal(payload.trial.lookups_left, 24, 'the trial block rides on the modern result');
    assert.equal(payload.trial.days_left, 30);
    assert.match(payload.notice, /Free trial: 24 of 25 lookups and 3 of 3 AI answers left/);

    // The 30 days are over: the refusal is a tool result with the trial's own
    // code, never a transport error — the same rule as every other refusal.
    await mongoose.connection.collection(mcpTrial.COLLECTION).updateOne(
        { _id: 't1' },
        { $set: { startedAt: new Date(Date.now() - 31 * 24 * 60 * 60 * 1000), lookups: 3, asks: 0 } }
    );
    const refused = await modernPost(url, { method: 'tools/call', params: { name: 'search_companies', arguments: { query: 'Apple' } } });
    assert.equal(refused.status, 200, 'a trial-ended refusal is a result, not an HTTP error');
    const refusedBody = await refused.json();
    assert.equal(refusedBody.result.isError, true);
    const refusal = JSON.parse(refusedBody.result.content[0].text);
    assert.equal(refusal.code, 'TRIAL_ENDED');
    assert.match(refusal.error, /30-day free trial .* has ended/);
    assert.ok(refusedBody.result._meta['io.modelcontextprotocol/serverInfo'], 'serverInfo still rides on a trial refusal');
});
