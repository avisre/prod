'use strict';

// mcp-endpoint.js end-to-end: a real MCP SDK Client speaking Streamable
// HTTP to a real Express route running mcpEndpoint.handleMcpRequest, over
// an actual loopback HTTP connection. This is the highest-risk new code in
// this launch (the transport wiring has no prior use in this codebase), so
// it's worth exercising the real protocol handshake rather than only
// calling buildMcpServer's handlers directly. Credit spend is checked
// against a real in-memory Mongo ledger, same as public-api.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const credits = require('../credits');
const freeTools = require('../free-tools');
const mcpEndpoint = require('../mcp-endpoint');

function effectiveAskLimit() { return 10; }

test('hosted MCP endpoint: tools/list and tools/call over real Streamable HTTP', { timeout: 60000 }, async (t) => {
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await mem.stop(); });

    const origGetToolResult = freeTools.getToolResult;
    t.after(() => { freeTools.getToolResult = origGetToolResult; });
    freeTools.getToolResult = async (slug, ticker) => ({
        status: 200,
        body: { symbol: ticker, tool: slug, revenue: 1000, sourceUrl: 'https://sec.gov/x' },
    });

    const app = express();
    app.post('/mcp', express.json(), async (req, res) => {
        const ctx = { userId: 'u1', user: { _id: 'u1' }, tier: 'free', subscription: { planId: 'free' } };
        await mcpEndpoint.handleMcpRequest(req, res, ctx, { credits, effectiveAskLimit, aiChat: { ask: async () => ({ answer: 'stub' }) } });
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}/mcp`;

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(base));
    await client.connect(transport);
    t.after(() => client.close());

    const { tools } = await client.listTools();
    assert.deepEqual(
        tools.map((tl) => tl.name).sort(),
        ['sp_ask', 'sp_compare', 'sp_filing', 'sp_financials', 'sp_fund', 'sp_health', 'sp_screen'].sort(),
        'the hosted endpoint advertises the same 7 tools as the stdio dev server'
    );

    const health = await client.callTool({ name: 'sp_health', arguments: {} });
    const healthPayload = JSON.parse(health.content[0].text);
    assert.equal(healthPayload.status, 'ok');

    const before = await credits.balance('u1', effectiveAskLimit());
    const result = await client.callTool({ name: 'sp_financials', arguments: { ticker: 'AAPL' } });
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.symbol, 'AAPL');
    assert.equal(payload.source.type, 'filed');
    const after = await credits.balance('u1', effectiveAskLimit());
    assert.equal(after.used, before.used + credits.COST.mcp_lookup, 'a real tools/call over the wire spends exactly mcp_lookup — the same rate as api_lookup');

    // Drain the rest of the wallet, then check the exhaustion payload carries
    // the same actionable fields the REST 402 does (api-response.quotaError):
    // an MCP client is the caller least able to go and find /recharge itself.
    const wallet = await credits.balance('u1', effectiveAskLimit());
    // Derived from the price, never assumed to be 1 per call: at mcp_lookup 2
    // a remaining-count loop would overshoot and drain the wallet early.
    const callsToDrain = Math.floor(wallet.remaining / credits.COST.mcp_lookup);
    for (let i = 0; i < callsToDrain; i++) {
        await client.callTool({ name: 'sp_financials', arguments: { ticker: 'AAPL' } });
    }
    const drained = await client.callTool({ name: 'sp_financials', arguments: { ticker: 'AAPL' } });
    assert.equal(drained.isError, true);
    const quota = JSON.parse(drained.content[0].text);
    assert.equal(quota.code, 'QUOTA_EXCEEDED');
    assert.equal(quota.remaining, 0);
    assert.equal(quota.needed, credits.COST.mcp_lookup, 'the refused call states its own price');
    assert.ok(quota.resetsAt, 'the client is told when the allowance returns');
    assert.ok(/\/recharge\.html/.test(quota.recharge.url), 'the client is handed the recharge link');
    assert.equal(quota.recharge.price, '$14.99');
});

// The keyless tier has no wallet, so mcp-anon.js's own upsell (Dev plan, not
// "recharge") must survive the quotaError change — a caller who never had
// credits cannot top them up.
test('a limiter-supplied message still wins over the recharge body', { timeout: 30000 }, async (t) => {
    const app = express();
    app.post('/mcp', express.json(), async (req, res) => {
        const ctx = { userId: 'anon', user: null, tier: 'free', subscription: null, anonymous: true };
        const fakeCredits = {
            COST: credits.COST,
            check: async () => ({ ok: false, used: 5, allowance: 5, remaining: 0, cost: 1, resetsAt: null, message: 'That was all 5 free data lookups. Keep going on the Dev plan — $19.99/month: https://www.stockportfolio.pro/signup.html' }),
            spend: async () => {},
        };
        await mcpEndpoint.handleMcpRequest(req, res, ctx, { credits: fakeCredits, effectiveAskLimit: () => 0, aiChat: { ask: async () => ({ answer: 'stub' }) } });
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${server.address().port}/mcp`)));
    t.after(() => client.close());

    const res = await client.callTool({ name: 'sp_financials', arguments: { ticker: 'AAPL' } });
    const payload = JSON.parse(res.content[0].text);
    assert.equal(payload.code, 'QUOTA_EXCEEDED');
    assert.match(payload.error, /Dev plan/, 'the keyless caller keeps the signup upsell');
    assert.equal(payload.recharge, undefined, 'and is never told to recharge a wallet it never had');
});
