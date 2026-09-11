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
    assert.equal(after.used, before.used + 1, 'a real tools/call over the wire spends exactly mcp_lookup (1) — half the api_lookup rate');
});
