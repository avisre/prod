'use strict';

// mcp-endpoint.js end-to-end: a real MCP SDK Client speaking Streamable HTTP to
// a real Express route running mcpEndpoint.handleMcpRequest, over an actual
// loopback HTTP connection, with raw fetch() calls alongside it for the cases
// where the HTTP status itself is the thing under test.
//
// The transport wiring has no prior use in this codebase and the discovery path
// is what every directory and app-scan depends on, so these exercise the real
// protocol handshake rather than calling buildMcpServer's handlers directly.
// Credit spend is checked against a real in-memory Mongo ledger, same as
// public-api.test.js.
//
// The ten cases the endpoint must survive, and where each is asserted:
//   1  initialize                      'initialize and tools/list never 402'
//   2  initialized notification        same test, explicit notification POST
//   3  tools/list                      'tools/list publishes the documented set'
//   4  a free read tool                'search_companies answers without a wallet'
//   5  protected tool, valid creds     'a protected tool with a funded wallet'
//   6  protected tool, no credentials  'a protected tool with no credentials'
//   7  insufficient credits            'a drained wallet is refused'
//   8  repeated connect/disconnect     'repeated connect and disconnect'
//   9  malformed MCP request           'a malformed request is a JSON-RPC error'
//  10  unknown tool                    'an unknown tool names the known ones'

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const credits = require('../credits');
const fin = require('../mcp-financials');
const aiChat = require('../ai-chat');
const mcpEndpoint = require('../mcp-endpoint');

const ASK_LIMIT = 10;
const EXPECTED_TOOLS = [
    'ask_filings',
    'get_company_fundamentals',
    'get_filing',
    'search_companies',
    'search_filings',
    'sp_health'
];

// One stub set for the four data-bearing tools. They are stubbed rather than
// run for real because the live versions reach SEC EDGAR over the network: a
// test that needs the internet to pass cannot distinguish "the endpoint broke"
// from "EDGAR was slow". searchCompanies is deliberately NOT stubbed — it reads
// the deployed catalog, so the free-tool path stays a real end-to-end call.
const REAL_COMPANY_FINANCIALS = fin.companyFinancials;
const REAL_SEARCH_FILINGS = fin.searchFilings;
const REAL_GET_FILING_CONTENT = fin.getFilingContent;
const REAL_ASK = aiChat.ask;

function stubFinancials() {
    fin.companyFinancials = async ({ company, metrics }) => ({
        company: { ticker: String(company).toUpperCase(), name: 'Stub Inc', cik: '0000320193', exchange: null, currency: 'USD' },
        period_type: 'annual',
        order: 'most_recent_first',
        metrics: (metrics || ['revenue']).map((metric) => ({
            metric,
            label: metric,
            units: 'USD',
            observations: [{
                metric,
                label: metric,
                period_type: 'annual',
                period_end: '2024-09-28',
                value: 391035000000,
                units: 'USD',
                source: { form: '10-K', filing_date: '2024-11-01', accession_number: '0000320193-24-000123', url: 'https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/', linkage: 'xbrl_fact' }
            }]
        }))
    });
    fin.searchFilings = async ({ company }) => ({
        company: { ticker: String(company).toUpperCase(), name: 'Stub Inc', cik: '0000320193' },
        match_count: 1,
        filings: [{ form: '10-K', filing_date: '2024-11-01', report_date: '2024-09-28', accession_number: '0000320193-24-000123', description: 'Annual report', source_url: 'https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/' }]
    });
    fin.getFilingContent = async () => ({
        company: { ticker: 'AAPL', name: 'Stub Inc', cik: '0000320193' },
        filing: { form: '10-K', filing_date: '2024-11-01', accession_number: '0000320193-24-000123', source_url: 'https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/' },
        section: { key: 'risk_factors', label: 'Risk Factors' },
        match_count: 1,
        excerpts: [{ text: 'Stub risk text.', section: 'risk_factors', section_label: 'Risk Factors' }]
    });
    aiChat.ask = async () => ({
        answer: 'Revenue rose because services grew.',
        toolsUsed: [{ tool: 'financials', source: 'https://www.sec.gov/Archives/edgar/data/320193/000032019324000123/' }],
        source: 'ai'
    });
}

function restoreFinancials() {
    fin.companyFinancials = REAL_COMPANY_FINANCIALS;
    fin.searchFilings = REAL_SEARCH_FILINGS;
    fin.getFilingContent = REAL_GET_FILING_CONTENT;
    aiChat.ask = REAL_ASK;
}

// Mounts the real endpoint on loopback with a caller of the given shape and
// returns { url, close }. `shape` picks the identity/entitlement deps; every
// test that cares about a refusal picks the one it is testing rather than
// reusing a default.
async function mount(t, shape) {
    const app = express();
    app.post('/mcp', express.json(), async (req, res) => {
        await mcpEndpoint.handleMcpRequest(req, res, shape.ctx, shape.deps);
    });
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return `http://127.0.0.1:${server.address().port}/mcp`;
}

async function connect(t, url) {
    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(url)));
    t.after(() => client.close().catch(() => {}));
    return client;
}

function keyedShape(overrides = {}) {
    return {
        // planId 'free' on purpose: credits.balance() sizes the wallet from the
        // stored user record while credits.check() honours the planId passed in,
        // so a 'dev' caller here would be checked against a 200-credit allowance
        // that balance() reports as 20 — and the drain-the-wallet test would
        // under-drain and pass for the wrong reason. Entitlement is stubbed
        // explicitly rather than inferred from the plan, so the two stay
        // independent.
        ctx: { userId: 'u1', user: { _id: 'u1' }, tier: 'free', subscription: { planId: 'free' }, anonymous: false, logId: 'keyed1' },
        deps: {
            limiter: overrides.limiter || credits,
            effectiveAskLimit: () => ASK_LIMIT,
            entitled: () => true,
            wallReason: null,
            onLog: () => {}
        }
    };
}

function anonShape(overrides = {}) {
    return {
        ctx: { userId: '203.0.113.9', user: null, tier: 'free', subscription: null, anonymous: true, logId: 'anon1' },
        deps: {
            limiter: overrides.limiter,
            effectiveAskLimit: () => 0,
            entitled: () => false,
            wallReason: overrides.wallReason || null,
            onLog: () => {}
        }
    };
}

function jsonOf(result) {
    return JSON.parse(result.content[0].text);
}

// ---------------------------------------------------------------------------
// 1, 2, 4, 9 — the raw transport contract, asserted on the HTTP status itself
// ---------------------------------------------------------------------------

test('initialize and tools/list never 402, and the initialized notification is accepted', { timeout: 60000 }, async (t) => {
    const url = await mount(t, keyedShape());

    const post = (body) => fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(body)
    });

    const initialize = await post({
        jsonrpc: '2.0', id: 1, method: 'initialize',
        params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'probe', version: '1' } }
    });
    assert.equal(initialize.status, 200, 'initialize must answer 200 even with no credential presented');
    const initText = await initialize.text();
    assert.ok(!/"code":402|REGION_PAID_ONLY|NETWORK_PAID_ONLY/.test(initText), 'initialize must never carry a payment refusal');

    const list = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    assert.equal(list.status, 200, 'tools/list must answer 200 even with no credential presented');

    const note = await post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    assert.ok([200, 202].includes(note.status), `an initialized notification is accepted, got ${note.status}`);

    const ping = await post({ jsonrpc: '2.0', id: 3, method: 'ping', params: {} });
    assert.equal(ping.status, 200, 'ping is a protocol-level operation and is never refused');

    // A method this server does not implement is still a protocol-level
    // request: it answers as a JSON-RPC error, never as an HTTP 402, or a
    // directory's capability scan reads the server as broken.
    const unknownMethod = await post({ jsonrpc: '2.0', id: 4, method: 'resources/list', params: {} });
    assert.equal(unknownMethod.status, 200, 'an unsupported method answers at the protocol layer, not with a payment status');
});

test('a malformed request is a JSON-RPC error, not a broken connection', { timeout: 60000 }, async (t) => {
    const url = await mount(t, keyedShape());

    const bad = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: '{"jsonrpc":"2.0","id":1,"method":'   // truncated JSON
    });
    assert.ok(bad.status < 500, `a malformed body must not surface as a server crash (got ${bad.status})`);

    // A well-formed envelope with a nonsense method must still answer, and the
    // caller must be able to keep using the connection afterwards.
    const client = await connect(t, url);
    const tools = await client.listTools();
    assert.ok(tools.tools.length > 0, 'the client still works after a malformed request was sent');
});

// ---------------------------------------------------------------------------
// 3 — the published tool set
// ---------------------------------------------------------------------------

test('tools/list publishes the documented set with reviewable metadata', { timeout: 60000 }, async (t) => {
    const url = await mount(t, keyedShape());
    const client = await connect(t, url);

    const { tools } = await client.listTools();
    assert.deepEqual(
        tools.map((tl) => tl.name).sort(),
        EXPECTED_TOOLS.slice().sort(),
        'the hosted endpoint advertises exactly the documented tools'
    );

    for (const tl of tools) {
        // The connector-directory review requires every tool to carry a title
        // and the applicable hint, and a missing one is a documented rejection
        // reason. Asserted over the real wire, because a missing annotation is
        // invisible from the source alone once anything reshapes it in transit.
        assert.ok(tl.title, `${tl.name} must carry a title for directory review`);
        assert.equal(tl.annotations && tl.annotations.readOnlyHint, true, `${tl.name} must declare readOnlyHint`);
        assert.equal(tl.inputSchema.type, 'object', `${tl.name} must declare an object input schema`);
        assert.ok(tl.description && tl.description.length > 40, `${tl.name} needs a description an LLM can route on`);
        // Strict schemas: anything not in the schema is rejected rather than
        // ignored, so a tool cannot be used to smuggle extra content.
        assert.equal(tl.inputSchema.additionalProperties, false, `${tl.name} must reject undeclared properties`);
    }

    const withRequired = tools.filter((tl) => (tl.inputSchema.required || []).length > 0);
    assert.ok(withRequired.length >= 4, 'the required/optional distinction must actually be declared');
    assert.deepEqual(
        tools.find((tl) => tl.name === 'sp_health').inputSchema.required || [],
        [],
        'a no-argument tool declares no required properties'
    );
});

// ---------------------------------------------------------------------------
// 4 — the free read tool, with no wallet and no credential
// ---------------------------------------------------------------------------

test('search_companies answers without a wallet, and reports a bad query honestly', { timeout: 60000 }, async (t) => {
    stubFinancials();
    t.after(restoreFinancials);
    const url = await mount(t, anonShape({
        limiter: { check: async () => { throw new Error('the free tool must not consult a limiter'); }, spend: async () => {} }
    }));
    const client = await connect(t, url);

    const found = await client.callTool({ name: 'search_companies', arguments: { query: 'Apple', limit: 5 } });
    assert.ok(!found.isError, 'the free tool must succeed for an anonymous caller');
    const payload = JSON.parse(found.content[0].text);
    assert.ok(Array.isArray(payload.companies) && payload.companies.length > 0, 'the catalog resolves "Apple"');
    const apple = payload.companies.find((c) => c.ticker === 'AAPL');
    assert.ok(apple, 'AAPL is among the matches');
    assert.ok(apple.cik, 'a resolved company carries its SEC CIK');
    assert.equal(apple.cik.length, 10, 'the CIK is zero-padded to the SEC width a filing lookup needs');

    // A query nothing matches is an empty list, not a fabricated company.
    const none = await client.callTool({ name: 'search_companies', arguments: { query: 'zzzznotacompanyzzzz' } });
    assert.equal(JSON.parse(none.content[0].text).match_count, 0);

    const missing = await client.callTool({ name: 'search_companies', arguments: {} });
    assert.equal(missing.isError, true);
    assert.equal(jsonOf(missing).code, 'COMPANY_REQUIRED');
});

// ---------------------------------------------------------------------------
// 5 — a protected tool with valid credentials
// ---------------------------------------------------------------------------

test('a protected tool with a funded wallet returns sourced figures and spends once', { timeout: 60000 }, async (t) => {
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await mem.stop(); });

    stubFinancials();
    t.after(restoreFinancials);
    const url = await mount(t, keyedShape());
    const client = await connect(t, url);

    const before = await credits.balance('u1', ASK_LIMIT);
    const res = await client.callTool({ name: 'get_company_fundamentals', arguments: { ticker: 'AAPL', periods: 1 } });
    assert.ok(!res.isError, `a funded key may call a protected tool: ${res.content[0].text}`);
    const payload = jsonOf(res);

    // Every financial figure must carry its period and its SEC citation.
    const revenue = payload.metrics.find((m) => m.metric === 'revenue');
    const obs = revenue.observations[0];
    assert.equal(obs.period_end, '2024-09-28', 'a figure carries its fiscal period');
    assert.equal(obs.source.form, '10-K', 'a figure carries its filing type');
    assert.equal(obs.source.filing_date, '2024-11-01', 'a figure carries its filing date');
    assert.match(obs.source.url, /^https:\/\/www\.sec\.gov\//, 'a figure carries its SEC source URL');

    const after = await credits.balance('u1', ASK_LIMIT);
    assert.equal(after.used, before.used + credits.COST.mcp_lookup, 'one call spends exactly mcp_lookup, like api_lookup');

    // The declared default metric set is the one the tool description promises.
    const defaults = await client.callTool({ name: 'get_company_fundamentals', arguments: { ticker: 'AAPL', periods: 1 } });
    const ids = jsonOf(defaults).metrics.map((m) => m.metric);
    for (const required of ['revenue', 'gross_profit', 'operating_income', 'net_income', 'diluted_eps', 'free_cash_flow', 'cash_and_equivalents', 'total_debt', 'shares_outstanding']) {
        assert.ok(ids.includes(required), `the default set includes ${required}`);
    }
});

test('an unsupported metric is refused by name rather than silently dropped', { timeout: 60000 }, async (t) => {
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await mem.stop(); });
    stubFinancials();
    t.after(restoreFinancials);
    const url = await mount(t, keyedShape());
    const client = await connect(t, url);

    const res = await client.callTool({ name: 'get_company_fundamentals', arguments: { ticker: 'AAPL', metrics: ['ebitda'] } });
    assert.equal(res.isError, true);
    const payload = jsonOf(res);
    assert.equal(payload.code, 'UNSUPPORTED_METRIC');
    assert.ok(Array.isArray(payload.available_metrics) && payload.available_metrics.length > 0, 'the caller is told what does exist');
});

// ---------------------------------------------------------------------------
// 6 — a protected tool with no credentials
// ---------------------------------------------------------------------------

test('a protected tool with no credentials returns an actionable auth error, and search_companies still works', { timeout: 60000 }, async (t) => {
    stubFinancials();
    t.after(restoreFinancials);
    // Keyless access switched off: the only way in is a connected account. Set
    // through the real knob rather than faked in the limiter, because the
    // refusal CODE is derived from whether keyless access exists at all.
    const priorLimit = process.env.ANON_MCP_ASK_LIMIT;
    process.env.ANON_MCP_ASK_LIMIT = '0';
    t.after(() => {
        if (priorLimit === undefined) delete process.env.ANON_MCP_ASK_LIMIT;
        else process.env.ANON_MCP_ASK_LIMIT = priorLimit;
    });
    const url = await mount(t, anonShape({
        limiter: {
            check: async () => ({ ok: false, used: 0, allowance: 0, resetsAt: null, message: 'Keyless access is not available. Get a key.' }),
            spend: async () => {}
        }
    }));
    const client = await connect(t, url);

    const res = await client.callTool({ name: 'get_company_fundamentals', arguments: { ticker: 'AAPL' } });
    assert.equal(res.isError, true, 'a protected tool refuses without credentials');
    const payload = jsonOf(res);
    assert.equal(payload.code, 'AUTHENTICATION_REQUIRED');
    assert.equal(payload.authenticate, true, 'the client is told that authenticating is the fix');
    assert.match(payload.error, /key|account/i, 'the message names the way in rather than only the refusal');

    // The connection is still alive and the free tool still answers — a refusal
    // must never take the session down with it.
    const free = await client.callTool({ name: 'search_companies', arguments: { query: 'Microsoft' } });
    assert.ok(!free.isError, 'the session survives a refusal and the free tool still answers');
    const tools = await client.listTools();
    assert.equal(tools.tools.length, EXPECTED_TOOLS.length, 'and discovery still works after a refusal');
});

test('a walled network is not by itself a refusal while MCP_KEYLESS_WALL is off', { timeout: 60000 }, async (t) => {
    stubFinancials();
    t.after(restoreFinancials);
    // Every AI client runs on rented infrastructure, so an anonymous caller
    // arriving from a data-centre address must still get the free allowance.
    const url = await mount(t, anonShape({
        wallReason: 'network',
        limiter: {
            check: async () => ({ ok: true, used: 0, allowance: 50, resetsAt: '2026-10-30', windowDays: 30 }),
            spend: async () => {}
        }
    }));
    const client = await connect(t, url);

    const res = await client.callTool({ name: 'search_filings', arguments: { ticker: 'AAPL' } });
    assert.ok(!res.isError, `a data-centre caller keeps the free allowance: ${res.content[0].text}`);
});

// The keyless tier has no wallet, so mcp-anon.js's own upsell (Dev plan, not
// "recharge") must survive: a caller who never had credits cannot top them up.
test('a keyless refusal keeps the limiter’s own copy, not the recharge body', { timeout: 60000 }, async (t) => {
    stubFinancials();
    t.after(restoreFinancials);
    const url = await mount(t, anonShape({
        limiter: {
            check: async () => ({
                ok: false, used: 3, allowance: 3, resetsAt: null,
                message: 'That was all 3 free questions in this rolling 30-day window. Get more: https://www.stockportfolio.pro/register?plan=dev'
            }),
            spend: async () => {}
        }
    }));
    const client = await connect(t, url);

    const res = await client.callTool({ name: 'ask_filings', arguments: { ticker: 'AAPL', question: 'Why did margin fall?' } });
    assert.equal(res.isError, true);
    const payload = jsonOf(res);
    assert.equal(payload.code, 'QUOTA_EXCEEDED');
    assert.match(payload.error, /plan=dev/, 'the keyless caller keeps the signup upsell');
    assert.equal(payload.recharge, undefined, 'and is never told to recharge a wallet it never had');
});

// ---------------------------------------------------------------------------
// 7 — insufficient credits
// ---------------------------------------------------------------------------

test('a drained wallet is refused with the REST shortfall body', { timeout: 60000 }, async (t) => {
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await mem.stop(); });

    stubFinancials();
    t.after(restoreFinancials);
    const url = await mount(t, keyedShape());
    const client = await connect(t, url);

    const wallet = await credits.balance('u1', ASK_LIMIT);
    const callsToDrain = Math.floor(wallet.remaining / credits.COST.mcp_lookup);
    for (let i = 0; i < callsToDrain; i++) {
        await client.callTool({ name: 'search_filings', arguments: { ticker: 'AAPL' } });
    }

    const drained = await client.callTool({ name: 'search_filings', arguments: { ticker: 'AAPL' } });
    assert.equal(drained.isError, true);
    const quota = jsonOf(drained);
    assert.equal(quota.code, 'QUOTA_EXCEEDED');
    assert.equal(quota.remaining, 0);
    assert.equal(quota.needed, credits.COST.mcp_lookup, 'the refused call states its own price');
    assert.ok(quota.resetsAt, 'the client is told when the allowance returns');
    assert.ok(/\/recharge\.html/.test(quota.recharge.url), 'the client is handed the recharge link');

    // An entitlement problem is reported the same way, never as an HTTP error.
    const unentitled = await mount(t, {
        ctx: { userId: 'u2', user: { _id: 'u2' }, tier: 'free', subscription: { planId: 'free' }, anonymous: false, logId: 'keyed2' },
        deps: { limiter: credits, effectiveAskLimit: () => ASK_LIMIT, entitled: () => false, wallReason: null, onLog: () => {} }
    });
    const client2 = await connect(t, unentitled);
    const refused = await client2.callTool({ name: 'search_filings', arguments: { ticker: 'AAPL' } });
    assert.equal(refused.isError, true);
    assert.equal(jsonOf(refused).code, 'ENTITLEMENT_REQUIRED', 'a plan without the capability is explained, not 402ed');
});

// ---------------------------------------------------------------------------
// 8 — repeated connection and disconnection
// ---------------------------------------------------------------------------

test('repeated connect and disconnect stays healthy and leaks no session state', { timeout: 120000 }, async (t) => {
    const url = await mount(t, keyedShape());
    const rounds = 12;
    for (let i = 0; i < rounds; i++) {
        const client = new Client({ name: `churn-${i}`, version: '1.0.0' });
        await client.connect(new StreamableHTTPClientTransport(new URL(url)));
        const { tools } = await client.listTools();
        assert.equal(tools.length, EXPECTED_TOOLS.length, `round ${i} sees the full tool list`);
        const health = await client.callTool({ name: 'sp_health', arguments: {} });
        assert.equal(jsonOf(health).status, 'ok', `round ${i} reports healthy`);
        await client.close();
    }
    // The transport is stateless, so a session id must never be issued — a
    // server that started handing them out would accumulate state across the
    // health checks a directory runs.
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 9, method: 'tools/list', params: {} })
    });
    assert.equal(res.headers.get('mcp-session-id'), null, 'a stateless endpoint must not open a session');
});

// ---------------------------------------------------------------------------
// 10 — unknown tool
// ---------------------------------------------------------------------------

test('an unknown tool names the known ones instead of failing the connection', { timeout: 60000 }, async (t) => {
    const url = await mount(t, keyedShape());
    const client = await connect(t, url);

    const res = await client.callTool({ name: 'sp_nonexistent', arguments: {} });
    assert.equal(res.isError, true);
    const payload = jsonOf(res);
    assert.equal(payload.code, 'UNKNOWN_TOOL');
    assert.deepEqual(payload.available_tools.slice().sort(), EXPECTED_TOOLS.slice().sort(), 'the caller is handed the real tool list');
});

// ---------------------------------------------------------------------------
// ask_filings — the metered AI tool, and its free-allowance reporting
// ---------------------------------------------------------------------------

test('ask_filings answers with citations and, keyless, reports the remaining allowance', { timeout: 60000 }, async (t) => {
    stubFinancials();
    t.after(restoreFinancials);
    const url = await mount(t, anonShape({
        limiter: {
            check: async () => ({ ok: true, used: 1, allowance: 3, resetsAt: '2026-10-30', windowDays: 30 }),
            spend: async () => {}
        }
    }));
    const client = await connect(t, url);

    const res = await client.callTool({ name: 'ask_filings', arguments: { ticker: 'AAPL', question: 'Why did services revenue grow?' } });
    assert.ok(!res.isError, `the AI tool answers within the free allowance: ${res.content[0].text}`);
    const payload = jsonOf(res);
    assert.match(payload.answer, /services grew/);
    assert.ok(payload.citations.some((c) => /sec\.gov/.test(c)), 'the answer cites the SEC filing behind its figures');
    assert.equal(payload.usage.remaining, 1, 'a keyless answer reports what is left, so the limit is never a surprise');
    assert.match(payload.notice, /1 free MCP question remains/);

    // A question with no ticker is refused by name rather than researched.
    const noTicker = await client.callTool({ name: 'ask_filings', arguments: { question: 'What is revenue?' } });
    assert.equal(noTicker.isError, true);
    assert.equal(jsonOf(noTicker).code, 'COMPANY_REQUIRED');
});

// ---------------------------------------------------------------------------
// get_filing — identified by accession number alone
// ---------------------------------------------------------------------------

test('get_filing resolves a company from an accession number, and rejects a malformed one', { timeout: 60000 }, async (t) => {
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await mem.stop(); });
    stubFinancials();
    t.after(restoreFinancials);
    const url = await mount(t, keyedShape());
    const client = await connect(t, url);

    const res = await client.callTool({ name: 'get_filing', arguments: { accession_number: '0000320193-24-000123', section: 'Risk Factors' } });
    assert.ok(!res.isError, `an accession number on its own identifies the filing: ${res.content[0].text}`);
    const payload = jsonOf(res);
    assert.equal(payload.filing.accession_number, '0000320193-24-000123');
    assert.match(payload.filing.filing_url, /^https:\/\/www\.sec\.gov\//, 'the filing carries its source URL');
    assert.ok(payload.excerpts[0].text.length > 0, 'excerpts are returned rather than the whole document');

    const bad = await client.callTool({ name: 'get_filing', arguments: { accession_number: 'not-an-accession' } });
    assert.equal(bad.isError, true);
    assert.equal(jsonOf(bad).code, 'FILING_NOT_FOUND');

    const neither = await client.callTool({ name: 'get_filing', arguments: {} });
    assert.equal(neither.isError, true);
    assert.equal(jsonOf(neither).code, 'COMPANY_REQUIRED', 'with no identifier at all the caller is told what to pass');
});

// ---------------------------------------------------------------------------
// Telemetry — the log carries no credential material
// ---------------------------------------------------------------------------

test('the call log records duration and outcome but never a credential', { timeout: 60000 }, async (t) => {
    stubFinancials();
    t.after(restoreFinancials);
    const events = [];
    const shape = keyedShape({
        // Stubbed so this test needs no database: it is about what the log
        // records, and a real wallet would only add an unrelated dependency.
        limiter: {
            check: async () => ({ ok: true, used: 0, allowance: 20, resetsAt: null }),
            spend: async () => {}
        }
    });
    shape.deps.onLog = (evt) => events.push(evt);
    const url = await mount(t, shape);
    const client = await connect(t, url);

    await client.listTools();
    await client.callTool({ name: 'sp_health', arguments: {} });
    await client.callTool({ name: 'get_company_fundamentals', arguments: { ticker: 'AAPL' } });

    const listed = events.find((e) => e.event === 'tools/list');
    assert.ok(listed, 'tools/list is logged');
    assert.equal(listed.toolCount, EXPECTED_TOOLS.length);

    const called = events.find((e) => e.event === 'tools/call' && e.tool === 'get_company_fundamentals');
    assert.ok(called, 'tools/call is logged');
    assert.equal(called.ok, true);
    assert.equal(typeof called.ms, 'number', 'every call records its duration');

    const serialized = JSON.stringify(events);
    assert.ok(!/Bearer|sp_live_|authorization/i.test(serialized), 'no credential material reaches the log');
    assert.ok(!/203\.0\.113|u1/.test(serialized), 'the caller is a hash, not the raw identity');
});
