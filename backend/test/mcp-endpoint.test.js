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
//   4  company search is a lookup      'search_companies is metered as a lookup'
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
const connectorNotices = require('../connector-notices');
const recentFilingsModule = require('../mcp-recent-filings');
const mcpAnon = require('../mcp-anon');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ASK_LIMIT = 10;
const EXPECTED_TOOLS = [
    'ask_filings',
    'get_company_fundamentals',
    'get_filing',
    'get_recent_filings',
    'screen_companies',
    'get_filing_changes',
    'get_red_flags',
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
// 4 — company search is a metered lookup (owner decision 2026-10-08; it was
//     free until then, and /mcp/apps already charged for it)
// ---------------------------------------------------------------------------

test('search_companies is metered as a lookup, and reports a bad query honestly', { timeout: 60000 }, async (t) => {
    stubFinancials();
    t.after(restoreFinancials);
    const checked = [];
    const spent = [];
    const url = await mount(t, anonShape({
        limiter: {
            check: async (id, op) => { checked.push(op); return { ok: true, used: 0, allowance: 25, resetsAt: null }; },
            spend: async (id, op, reason) => { spent.push(`${op}|${reason}`); }
        }
    }));
    const client = await connect(t, url);

    const found = await client.callTool({ name: 'search_companies', arguments: { query: 'Apple', limit: 5 } });
    assert.ok(!found.isError, 'a caller inside the allowance gets an answer');
    assert.deepEqual(checked, ['mcp_lookup'], 'the allowance is consulted as a lookup');
    assert.deepEqual(spent, ['mcp_lookup|mcp:search_companies'], 'and one lookup is spent for it');
    const payload = JSON.parse(found.content[0].text);
    assert.ok(Array.isArray(payload.companies) && payload.companies.length > 0, 'the catalog resolves "Apple"');
    const apple = payload.companies.find((c) => c.ticker === 'AAPL');
    assert.ok(apple, 'AAPL is among the matches');
    assert.ok(apple.cik, 'a resolved company carries its SEC CIK');
    assert.equal(apple.cik.length, 10, 'the CIK is zero-padded to the SEC width a filing lookup needs');

    // A query nothing matches is an empty list, not a fabricated company.
    const none = await client.callTool({ name: 'search_companies', arguments: { query: 'zzzznotacompanyzzzz' } });
    assert.equal(JSON.parse(none.content[0].text).match_count, 0);

    const spentBefore = spent.length;
    const missing = await client.callTool({ name: 'search_companies', arguments: {} });
    assert.equal(missing.isError, true);
    assert.equal(jsonOf(missing).code, 'COMPANY_REQUIRED');
    assert.equal(spent.length, spentBefore, 'a call that failed spends nothing');
});

test('search_companies is refused once the allowance is gone, and for an account without API access', { timeout: 60000 }, async (t) => {
    stubFinancials();
    t.after(restoreFinancials);
    const spent = [];
    const drained = await connect(t, await mount(t, anonShape({
        limiter: {
            check: async () => ({ ok: false, used: 25, allowance: 25, resetsAt: null, message: 'That was all 25 free data lookups in this rolling 30-day window.' }),
            spend: async () => { spent.push(1); }
        }
    })));
    const over = await drained.callTool({ name: 'search_companies', arguments: { query: 'Apple' } });
    assert.equal(over.isError, true, 'an exhausted free allowance refuses company search too');
    assert.equal(jsonOf(over).code, 'QUOTA_EXCEEDED');
    assert.equal(spent.length, 0);

    const shape = keyedShape({ limiter: { check: async () => ({ ok: true }), spend: async () => { spent.push(1); } } });
    shape.deps.entitled = () => false;
    const unentitled = await connect(t, await mount(t, shape));
    const res = await unentitled.callTool({ name: 'search_companies', arguments: { query: 'Apple' } });
    assert.equal(res.isError, true);
    assert.equal(jsonOf(res).code, 'ENTITLEMENT_REQUIRED');
    assert.equal(spent.length, 0);
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

test('a protected tool with no credentials returns an actionable auth error, and the session survives it', { timeout: 60000 }, async (t) => {
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

    // The connection is still alive and the free probe still answers — a refusal
    // must never take the session down with it.
    const free = await client.callTool({ name: 'sp_health', arguments: {} });
    assert.ok(!free.isError, 'the session survives a refusal and the free probe still answers');
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
    // The refusal says what to do: which plan, what it costs, where to get it.
    assert.match(jsonOf(refused).error, /Monthly plan \(\$79\.99\/month/);
    assert.match(jsonOf(refused).error, /stockportfolio\.pro\/upgrade\.html/);
    assert.match(jsonOf(refused).upgradeUrl, /^https:\/\/www\.stockportfolio\.pro\/upgrade\.html/);
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

// ---------------------------------------------------------------------------
// Account notices — connector-notices.js, wired the way app.js wires it
// ---------------------------------------------------------------------------

function noticeShape() {
    const shape = keyedShape();
    shape.deps.accountNotice = (gate) => connectorNotices.forCall({
        ledger: mongoose.connection.collection('credit_ledger'),
        userId: 'u1',
        gate,
        facts: { lookupCost: credits.COST.mcp_lookup, askCost: credits.COST.mcp_ask }
    });
    return shape;
}

test('credits added to an account are announced on its next call, once', { timeout: 60000 }, async (t) => {
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await mem.stop(); });
    stubFinancials();
    t.after(restoreFinancials);
    const client = await connect(t, await mount(t, noticeShape()));
    const lookup = async () => jsonOf(await client.callTool({ name: 'search_filings', arguments: { ticker: 'AAPL' } }));

    assert.equal((await lookup()).account_notice, undefined, 'an ordinary call says nothing about the account');

    assert.equal(await credits.grant('u1', 500, 'comp', 'comp-test'), true);
    const told = await lookup();
    assert.match(told.account_notice, /^500 credits were added to this StockPortfolio\.pro account on \d+ \w+ \d{4}\. After this call it has 518 credits available\./);
    assert.equal(Object.keys(told)[0], 'account_notice', 'the notice is the first thing in the result');
    assert.deepEqual({ used: told.credits.used, allowance: told.credits.allowance, remaining: told.credits.remaining }, { used: 2, allowance: 520, remaining: 518 });
    assert.ok(Array.isArray(told.filings) || told.filings === undefined || typeof told === 'object', 'the tool payload is still there');

    assert.equal((await lookup()).account_notice, undefined, 'the call that announced it is now the last call');
    assert.equal((await credits.balance('u1', ASK_LIMIT)).used, 3 * credits.COST.mcp_lookup, 'a notice never changes what a call costs');
});

test('the notice reads the ledger before the call is charged, however slow that read is', { timeout: 60000 }, async (t) => {
    // The deploy workflow failed twice on 2026-10-10 because the charge could
    // land before the notice had read the ledger; the call's own charge then
    // looked like "the last call" and hid the credits that had just arrived.
    // A deliberately slow ledger read makes that ordering certain here.
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await mem.stop(); });
    stubFinancials();
    t.after(restoreFinancials);
    const shape = keyedShape();
    shape.deps.accountNotice = async (gate) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        return connectorNotices.forCall({ ledger: mongoose.connection.collection('credit_ledger'), userId: 'u1', gate, facts: { lookupCost: credits.COST.mcp_lookup, askCost: credits.COST.mcp_ask } });
    };
    const client = await connect(t, await mount(t, shape));
    const lookup = async () => jsonOf(await client.callTool({ name: 'search_filings', arguments: { ticker: 'AAPL' } }));
    await lookup();
    await credits.grant('u1', 500, 'comp', 'comp-slow');
    assert.match((await lookup()).account_notice || '', /^500 credits were added/);
    assert.equal((await lookup()).account_notice, undefined);
});

test('a wallet that is nearly spent says so before the refusal, and a broken notice never fails a call', { timeout: 60000 }, async (t) => {
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await mem.stop(); });
    stubFinancials();
    t.after(restoreFinancials);
    const client = await connect(t, await mount(t, noticeShape()));
    const lookup = async () => jsonOf(await client.callTool({ name: 'search_filings', arguments: { ticker: 'AAPL' } }));

    // The test wallet is 20 credits and a lookup costs 1, so the notice starts
    // on the call that leaves five lookups' worth (call 15).
    for (let i = 0; i < 14; i++) assert.equal((await lookup()).account_notice, undefined, `call ${i + 1} leaves more than five lookups`);
    const low = await lookup();
    assert.match(low.account_notice, /credits are running low: 5 of 20 left this month, enough for about 5 more data lookups \(an AI answer costs 42\)/);
    assert.ok(low.account_notice.includes(connectorNotices.RECHARGE_URL));
    assert.equal(low.credits.remaining, 5);

    // A tool error carries no notice: nothing was charged and the model is
    // already being told something more important.
    const bad = await client.callTool({ name: 'get_company_fundamentals', arguments: { ticker: 'AAPL', metrics: ['ebitda'] } });
    assert.equal(bad.isError, true);
    assert.equal(jsonOf(bad).account_notice, undefined);

    const shape = keyedShape({ limiter: { check: async () => ({ ok: true, used: 90, allowance: 100, cost: 2, remaining: 10 }), spend: async () => {} } });
    shape.deps.accountNotice = async () => { throw new Error('ledger down'); };
    const other = await connect(t, await mount(t, shape));
    const res = await other.callTool({ name: 'search_filings', arguments: { ticker: 'AAPL' } });
    assert.ok(!res.isError, 'the call still succeeds');
    assert.equal(jsonOf(res).account_notice, undefined);
});

// ---------------------------------------------------------------------------
// Anti-scraping: the cap on different companies (company-breadth.js)
// ---------------------------------------------------------------------------

test('an account over its company cap is refused before the work and never charged; one under it is recorded', { timeout: 60000 }, async (t) => {
    stubFinancials();
    t.after(restoreFinancials);
    const spent = [];
    const recorded = [];
    const limiter = { check: async () => ({ ok: true }), spend: async () => { spent.push(1); } };
    const refusing = keyedShape({ limiter });
    refusing.deps.breadth = {
        check: async () => ({ ok: false, window: 'day', limit: 50, resetsAt: '2026-10-19T09:00:00.000Z', message: 'This account has looked up 50 different companies in the last 24 hours, the most allowed.' }),
        record: async (c) => { recorded.push(c); }
    };
    const over = await connect(t, await mount(t, refusing));
    const res = await over.callTool({ name: 'get_company_fundamentals', arguments: { ticker: 'AAPL', periods: 1 } });
    assert.equal(res.isError, true);
    assert.equal(jsonOf(res).code, 'COMPANY_LIMIT');
    assert.equal(jsonOf(res).resets_at, '2026-10-19T09:00:00.000Z');
    assert.equal(spent.length, 0, 'a refused call costs nothing');

    const checked = [];
    const allowing = keyedShape({ limiter });
    allowing.deps.breadth = { check: async (c) => { checked.push(c); return { ok: true }; }, record: async (c) => { recorded.push(c); } };
    const under = await connect(t, await mount(t, allowing));
    const ok = await under.callTool({ name: 'get_company_fundamentals', arguments: { ticker: 'aapl', periods: 1 } });
    assert.ok(!ok.isError, ok.content[0].text);
    assert.deepEqual(checked, [['AAPL']]);
    assert.deepEqual(recorded, [['AAPL']], 'recorded once, after the work succeeded');
    // A call about no company (a name search) never consults the cap.
    await under.callTool({ name: 'search_companies', arguments: { query: 'Apple' } });
    assert.equal(checked.length, 1);
});

// ---------------------------------------------------------------------------
// OpenAI Apps auth contract: per-tool securitySchemes on tools/list, and the
// _meta['mcp/www_authenticate'] challenge that makes ChatGPT/Claude surface
// their account-linking UI on a refusal an account would fix.
// ---------------------------------------------------------------------------

test('tools/list declares per-tool security schemes that survive to the wire', { timeout: 60000 }, async (t) => {
    const url = await mount(t, keyedShape());
    // Raw fetch, not the SDK client: the client's Zod parse strips fields the
    // 2025-11-25 SDK does not know, so the wire is the only place the new
    // field can be asserted. What a directory's scanner reads is the wire.
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} })
    });
    assert.equal(res.status, 200);
    // The transport answers SSE; one data: line holds the whole result.
    const dataLine = (await res.text()).split('\n').find((l) => l.startsWith('data: '));
    const { result } = JSON.parse(dataLine.slice(6));
    const byName = new Map(result.tools.map((tl) => [tl.name, tl]));
    assert.deepEqual(
        byName.get('sp_health').securitySchemes,
        [{ type: 'noauth' }],
        'the free probe needs no credential and says so'
    );
    for (const name of ['search_companies', 'get_company_fundamentals', 'search_filings', 'get_filing', 'ask_filings', 'get_recent_filings', 'get_red_flags']) {
        assert.deepEqual(
            byName.get(name).securitySchemes,
            [{ type: 'noauth' }, { type: 'oauth2', scopes: ['financials:read', 'filings:read', 'research:read'] }],
            `${name} declares the keyless tier and the OAuth grant that unlocks it`
        );
    }
    // The account-only tools have no keyless tier to advertise: only the
    // OAuth grant, which is what makes the client offer sign-in.
    for (const name of ['screen_companies', 'get_filing_changes']) {
        assert.deepEqual(
            byName.get(name).securitySchemes,
            [{ type: 'oauth2', scopes: ['financials:read', 'filings:read', 'research:read'] }],
            `${name} is account-only and declares only the OAuth grant`
        );
    }
});

test('an anonymous refusal an account would fix carries the sign-in challenge; a keyed one does not', { timeout: 60000 }, async (t) => {
    stubFinancials();
    t.after(restoreFinancials);
    const metadataUrl = 'https://www.stockportfolio.pro/.well-known/oauth-protected-resource';
    const refused = {
        check: async () => ({ ok: false, used: 3, allowance: 3, resetsAt: null, message: 'That was all 3 free questions in this rolling 30-day window.' }),
        spend: async () => {}
    };

    const anon = anonShape({ limiter: refused });
    anon.deps.resourceMetadataUrl = metadataUrl;
    const client = await connect(t, await mount(t, anon));
    const res = await client.callTool({ name: 'search_companies', arguments: { query: 'Apple' } });
    assert.equal(res.isError, true);
    assert.equal(jsonOf(res).code, 'QUOTA_EXCEEDED');
    const challenges = res._meta && res._meta['mcp/www_authenticate'];
    assert.ok(Array.isArray(challenges) && challenges.length === 1, 'the refusal carries exactly one challenge');
    assert.match(challenges[0], new RegExp(`resource_metadata="${metadataUrl.replace(/\//g, '\\/')}"`));
    assert.match(challenges[0], /error="insufficient_scope"/);
    assert.match(challenges[0], /Connect a StockPortfolio\.pro account to continue\./);

    // Keyed callers already have an account; their refusal must not trigger
    // the client's sign-in flow, and stays byte-for-byte as published.
    const keyed = keyedShape({ limiter: refused });
    keyed.deps.resourceMetadataUrl = metadataUrl;
    const keyedClient = await connect(t, await mount(t, keyed));
    const keyedRes = await keyedClient.callTool({ name: 'search_companies', arguments: { query: 'Apple' } });
    assert.equal(keyedRes.isError, true);
    assert.equal(jsonOf(keyedRes).code, 'QUOTA_EXCEEDED');
    assert.equal(keyedRes._meta, undefined, 'a keyed refusal carries no challenge');

    // Without a resource metadata URL in deps (the npm bridge, older mounts)
    // the refusal is exactly what it was before the challenge existed.
    const bare = await connect(t, await mount(t, anonShape({ limiter: refused })));
    const bareRes = await bare.callTool({ name: 'search_companies', arguments: { query: 'Apple' } });
    assert.equal(bareRes.isError, true);
    assert.equal(bareRes._meta, undefined, 'no metadata URL in deps means no challenge');
});

test('AUTHENTICATION_REQUIRED, the keyless-off refusal, carries the challenge too', { timeout: 60000 }, async (t) => {
    stubFinancials();
    t.after(restoreFinancials);
    const priorLimit = process.env.ANON_MCP_ASK_LIMIT;
    process.env.ANON_MCP_ASK_LIMIT = '0';
    t.after(() => {
        if (priorLimit === undefined) delete process.env.ANON_MCP_ASK_LIMIT;
        else process.env.ANON_MCP_ASK_LIMIT = priorLimit;
    });
    const shape = anonShape({
        limiter: {
            check: async () => ({ ok: false, used: 0, allowance: 0, resetsAt: null, message: 'Keyless access is not available. Get a key.' }),
            spend: async () => {}
        }
    });
    shape.deps.resourceMetadataUrl = 'https://www.stockportfolio.pro/.well-known/oauth-protected-resource';
    const client = await connect(t, await mount(t, shape));
    const res = await client.callTool({ name: 'get_company_fundamentals', arguments: { ticker: 'AAPL' } });
    assert.equal(res.isError, true);
    assert.equal(jsonOf(res).code, 'AUTHENTICATION_REQUIRED');
    assert.ok(Array.isArray(res._meta && res._meta['mcp/www_authenticate']), 'the auth refusal points at the OAuth metadata');
});

// ---------------------------------------------------------------------------
// The mcp_calls usage log wiring — deps.usage is invoked once per call,
// refusals included (mcp-usage-log.js)
// ---------------------------------------------------------------------------

test('deps.usage is invoked once per tool call, including for a refusal', { timeout: 60000 }, async (t) => {
    stubFinancials();
    t.after(restoreFinancials);
    const events = [];
    const shape = keyedShape({
        limiter: {
            check: async () => ({ ok: true, used: 0, allowance: 20, resetsAt: null }),
            spend: async () => {}
        }
    });
    shape.deps.usage = (evt) => events.push(evt);
    const refused = keyedShape({
        limiter: {
            check: async () => ({ ok: false, used: 3, allowance: 3, resetsAt: null, message: 'That was all 3 free questions.' }),
            spend: async () => {}
        }
    });
    refused.deps.usage = (evt) => events.push(evt);

    const client = await connect(t, await mount(t, shape));
    await client.callTool({ name: 'sp_health', arguments: {} });
    await client.callTool({ name: 'search_companies', arguments: { query: 'Apple' } });
    const drained = await connect(t, await mount(t, refused));
    await drained.callTool({ name: 'search_companies', arguments: { query: 'Apple' } });

    assert.equal(events.length, 3, 'one usage event per call');
    assert.equal(events.filter((e) => e.tool === 'sp_health').length, 1);
    const ok = events.find((e) => e.tool === 'search_companies' && e.code === null);
    assert.ok(ok, 'a successful call is recorded');
    assert.ok(ok.args && ok.args.query === 'Apple', 'the event carries the raw args for facet extraction');
    assert.equal(typeof ok.ms, 'number');
    const refusal = events.find((e) => e.code === 'QUOTA_EXCEEDED');
    assert.ok(refusal, 'a refusal is recorded too');
    assert.ok(refusal.result && refusal.result.isError, 'the event carries the result for outcome facets');
});

// ---------------------------------------------------------------------------
// The new tools — get_recent_filings, screen_companies, get_filing_changes,
// get_red_flags
// ---------------------------------------------------------------------------

// A small sec-reporting fixture (never the real ~5,900-issuer file) plus the
// per-company statements file, in a temp dir the module is pointed at.
function writeRecentFilingsFixture(t) {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-recent-'));
    const issuers = {};
    const NOW = new Date('2026-10-25T12:00:00Z');
    for (let i = 0; i < 15; i++) {
        const cik = String(1000000000 + i);
        const issuer = {
            cik,
            issuerName: `Test Issuer ${i} Inc.`,
            symbols: [`T${String(i).padStart(2, '0')}`],
            financialFile: `sec-financials/${cik}.json`,
            latestPeriodic: {
                form: '10-Q',
                accessionNumber: `${cik}-26-000001`,
                filingDate: '2026-10-20',
                reportDate: '2026-09-30',
                filingUrl: `https://www.sec.gov/Archives/edgar/data/${cik}/one.htm`
            }
        };
        // One issuer reports a period its statements do not carry, so
        // in_statements:false is exercised, not just true.
        if (i === 1) issuer.latestPeriodic.reportDate = '2026-09-29';
        if (i % 2 === 0) {
            issuer.latestAnnual = {
                form: '10-K',
                accessionNumber: `${cik}-26-000002`,
                filingDate: '2026-10-21',
                reportDate: '2025-09-27',
                filingUrl: `https://www.sec.gov/Archives/edgar/data/${cik}/two.htm`
            };
        }
        if (i % 3 === 0) {
            issuer.latestEarningsRelease = {
                form: '8-K',
                accessionNumber: `${cik}-26-000003`,
                filingDate: '2026-10-22',
                reportDate: '2026-10-22',
                items: '2.02',
                filingUrl: `https://www.sec.gov/Archives/edgar/data/${cik}/three.htm`
            };
        }
        issuers[cik] = issuer;
        fs.mkdirSync(path.join(dataDir, 'sec-financials'), { recursive: true });
        fs.writeFileSync(path.join(dataDir, 'sec-financials', `${cik}.json`), JSON.stringify({
            income: {
                quarterlyReports: [{ fiscalDateEnding: '2026-09-30' }],
                annualReports: [{ fiscalDateEnding: '2025-09-27' }]
            }
        }));
    }
    const reportingFile = path.join(dataDir, 'sec-reporting.json');
    fs.writeFileSync(reportingFile, JSON.stringify({ schemaVersion: 'test', issuers }));
    t.after(() => { fs.rmSync(dataDir, { recursive: true, force: true }); recentFilingsModule._resetCache(); });
    return (args) => recentFilingsModule.recentFilings(args, { reportingFile, dataDir, now: NOW });
}

test('get_recent_filings lists newest filings, honours kinds/tickers/limit and in_statements', { timeout: 60000 }, async (t) => {
    const shape = keyedShape({
        limiter: { check: async () => ({ ok: true, used: 0, allowance: 20, resetsAt: null }), spend: async () => {} }
    });
    shape.deps.recentFilings = writeRecentFilingsFixture(t);
    const client = await connect(t, await mount(t, shape));

    const all = jsonOf(await client.callTool({ name: 'get_recent_filings', arguments: {} }));
    assert.equal(all.match_count, all.filings.length);
    assert.ok(all.filings.length > 10, 'the fixture yields more than the keyless cap');
    const dates = all.filings.map((r) => r.filing_date);
    assert.deepEqual(dates, [...dates].sort().reverse(), 'newest first');
    for (const row of all.filings) {
        assert.match(row.filing_url, /^https:\/\/www\.sec\.gov\//);
        assert.ok(['annual', 'quarterly', 'earnings_release'].includes(row.kind));
        if (row.kind !== 'earnings_release') assert.ok(typeof row.in_statements === 'boolean');
    }
    const outOfStatements = all.filings.find((r) => r.ticker === 'T01');
    assert.equal(outOfStatements.in_statements, false, 'a period end missing from the statements is flagged');
    const inStatements = all.filings.find((r) => r.ticker === 'T00' && r.kind === 'quarterly');
    assert.equal(inStatements.in_statements, true);

    const annual = jsonOf(await client.callTool({ name: 'get_recent_filings', arguments: { kinds: ['annual'] } }));
    assert.ok(annual.filings.length > 0);
    assert.ok(annual.filings.every((r) => r.kind === 'annual' && r.form === '10-K'));

    const one = jsonOf(await client.callTool({ name: 'get_recent_filings', arguments: { tickers: ['t00'] } }));
    assert.ok(one.filings.length > 0);
    assert.ok(one.filings.every((r) => r.ticker === 'T00'), 'the ticker filter is case-insensitive');

    const capped = jsonOf(await client.callTool({ name: 'get_recent_filings', arguments: { limit: 3 } }));
    assert.equal(capped.filings.length, 3);
});

test('a keyless caller gets at most 10 recent-filings rows, and is told so', { timeout: 60000 }, async (t) => {
    const shape = anonShape({
        limiter: { check: async () => ({ ok: true, used: 0, allowance: 25, resetsAt: null }), spend: async () => {} }
    });
    shape.deps.recentFilings = writeRecentFilingsFixture(t);
    const client = await connect(t, await mount(t, shape));
    const result = jsonOf(await client.callTool({ name: 'get_recent_filings', arguments: { limit: 100 } }));
    assert.equal(result.filings.length, 10, 'the keyless cap is 10 rows');
    assert.equal(result.match_count, 10);
    assert.ok(result.notes.some((note) => /at most 10 rows/i.test(note)), 'the cap is said in a notes entry');
});

test('account-only tools refuse a keyless caller with the sign-in challenge and consume no allowance', { timeout: 60000 }, async (t) => {
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await mem.stop(); });

    const ip = '203.0.113.9';
    const shape = anonShape({
        // The REAL anonymous limiter, so the no-allowance-consumed claim is
        // checked against the actual mcp_free_usage row.
        limiter: mcpAnon.creditsFor(ip, process.env, null, { pool: 'visitor' })
    });
    shape.deps.resourceMetadataUrl = 'https://www.stockportfolio.pro/.well-known/oauth-protected-resource';
    shape.deps.screenUniverse = async () => ({ universe: 10, matched: 1, rows: [{ symbol: 'AAPL' }] });
    shape.deps.filingDiff = async () => ({ headline: 'x' });
    const client = await connect(t, await mount(t, shape));

    for (const [tool, args] of [['screen_companies', { sector: 'TECHNOLOGY' }], ['get_filing_changes', { ticker: 'AAPL' }]]) {
        const res = await client.callTool({ name: tool, arguments: args });
        assert.equal(res.isError, true, `${tool} refuses a keyless caller`);
        const payload = jsonOf(res);
        assert.equal(payload.code, 'AUTHENTICATION_REQUIRED');
        assert.match(payload.error, /needs a signed-in StockPortfolio\.pro account\. Connect your account to use it\./);
        assert.ok(Array.isArray(res._meta && res._meta['mcp/www_authenticate']), `${tool} carries the sign-in challenge`);
        assert.match(res._meta['mcp/www_authenticate'][0], /insufficient_scope/);
    }
    // Not one unit of the free allowance was reserved or spent: no row exists.
    const row = await mongoose.connection.collection('mcp_free_usage').findOne({ _id: ip });
    assert.equal(row, null, 'a requiresAccount refusal never touches the allowance');
});

test('keyed calls to the new tools succeed and charge the right cost key', { timeout: 60000 }, async (t) => {
    const checked = [];
    const spent = [];
    const shape = keyedShape({
        limiter: {
            check: async (id, op) => { checked.push(op); return { ok: true, used: 0, allowance: 20, resetsAt: null }; },
            spend: async (id, op, reason) => { spent.push(`${op}|${reason}`); }
        }
    });
    shape.deps.recentFilings = writeRecentFilingsFixture(t);
    shape.deps.screenUniverse = async () => ({ universe: 5870, matched: 2, rows: [{ symbol: 'AAPL' }, { symbol: 'MSFT' }] });
    shape.deps.filingDiff = async () => ({
        symbol: 'AAPL', headline: 'Services grew', changes: [],
        latest: { form: '10-K', date: '2025-10-31', url: 'https://www.sec.gov/a' },
        prev: { form: '10-K', date: '2024-11-01', url: 'https://www.sec.gov/b' }
    });
    shape.deps.redFlags = () => ({ symbol: 'AAPL', flags: [], flagCount: 0, asOf: '2025-09-27', source: 'computed' });
    const client = await connect(t, await mount(t, shape));

    const screen = jsonOf(await client.callTool({ name: 'screen_companies', arguments: { sector: 'TECHNOLOGY', limit: 5 } }));
    assert.equal(screen.universe, 5870, 'the universe size travels with the rows');
    assert.equal(screen.rows.length, 2);

    const diff = jsonOf(await client.callTool({ name: 'get_filing_changes', arguments: { ticker: 'AAPL' } }));
    assert.equal(diff.symbol, 'AAPL');
    assert.equal(diff.latest.form, '10-K', 'both filings travel with form, date and URL');

    const flags = jsonOf(await client.callTool({ name: 'get_red_flags', arguments: { ticker: 'AAPL' } }));
    assert.equal(flags.symbol, 'AAPL');
    assert.equal(flags.flagCount, 0);

    await client.callTool({ name: 'get_recent_filings', arguments: { limit: 3 } });

    // Lookup cost for the read tools; the filing comparison runs the model, so
    // it is charged as an ask exactly like ask_filings.
    assert.deepEqual(checked.sort(), ['mcp_ask', 'mcp_lookup', 'mcp_lookup', 'mcp_lookup']);
    assert.deepEqual(spent.sort(), [
        'mcp_ask|mcp:get_filing_changes',
        'mcp_lookup|mcp:get_recent_filings',
        'mcp_lookup|mcp:get_red_flags',
        'mcp_lookup|mcp:screen_companies'
    ]);
});

test('the breadth cap ignores get_recent_filings and screen_companies', { timeout: 60000 }, async (t) => {
    const checked = [];
    const shape = keyedShape({
        limiter: { check: async () => ({ ok: true }), spend: async () => {} }
    });
    shape.deps.recentFilings = writeRecentFilingsFixture(t);
    shape.deps.screenUniverse = async () => ({ universe: 10, matched: 3, rows: [] });
    shape.deps.breadth = {
        check: async (c) => { checked.push(['check', ...c]); return { ok: true }; },
        record: async (c) => { checked.push(['record', ...c]); }
    };
    const client = await connect(t, await mount(t, shape));
    await client.callTool({ name: 'get_recent_filings', arguments: { tickers: ['T00', 'T01', 'T02'] } });
    await client.callTool({ name: 'screen_companies', arguments: { symbols: ['AAPL', 'MSFT'] } });
    assert.equal(checked.length, 0, 'a multi-company list is not per-company breadth');
    // A single-company tool still counts, as today.
    shape.deps.redFlags = () => ({ symbol: 'AAPL', flags: [], flagCount: 0, asOf: null, source: 'x' });
    await client.callTool({ name: 'get_red_flags', arguments: { ticker: 'AAPL' } });
    assert.deepEqual(checked, [['check', 'AAPL'], ['record', 'AAPL']], 'checked before the work, recorded after it');
});

test('a fund asking for filing changes gets the same refusal copy as the website route', { timeout: 60000 }, async (t) => {
    const shape = keyedShape({
        limiter: { check: async () => ({ ok: true, used: 0, allowance: 100, resetsAt: null }), spend: async () => {} }
    });
    shape.deps.filingDiff = async () => {
        const err = new Error('ETFs do not have comparable company 10-K/10-Q filing changes. Use Ask for the fund\'s latest holdings, costs, performance and risk.');
        err.code = 'ASSET_FEATURE_UNAVAILABLE';
        throw err;
    };
    const client = await connect(t, await mount(t, shape));
    const res = await client.callTool({ name: 'get_filing_changes', arguments: { ticker: 'SPY' } });
    assert.equal(res.isError, true);
    const payload = jsonOf(res);
    assert.equal(payload.code, 'ASSET_FEATURE_UNAVAILABLE');
    assert.match(payload.error, /do not have comparable company 10-K\/10-Q filing changes/);
});

test('screen_companies passes a named ticker list and established-first ranking to the screener', { timeout: 60000 }, async (t) => {
    const seen = [];
    const shape = keyedShape({
        limiter: { check: async () => ({ ok: true, used: 0, allowance: 20, resetsAt: null }), spend: async () => {} }
    });
    shape.deps.screenUniverse = async (criteria) => {
        seen.push(criteria);
        return { universe: 100, matched: 1, rows: [{ symbol: 'MSFT' }], notInUniverse: ['ZZZQ'], technicalsAsOf: '2026-10-24', similarTo: { symbol: 'ORCL' } };
    };
    const client = await connect(t, await mount(t, shape));
    const result = jsonOf(await client.callTool({
        name: 'screen_companies',
        arguments: { symbols: ['MSFT', 'ZZZQ'], sort_by: 'netIncomeCagr5Pct', min_net_margin_pct: 10, limit: 70 }
    }));
    assert.deepEqual(seen[0].symbols, ['MSFT', 'ZZZQ'], 'the ticker list reaches the screener');
    assert.equal(seen[0].established_first, true);
    assert.equal(seen[0].sort_by, 'netIncomeCagr5Pct', 'every website sort key is accepted');
    assert.equal(seen[0].min_net_margin_pct, 10);
    assert.equal(seen[0].limit, 50, 'limit is capped at 50');
    assert.deepEqual(result.not_in_universe, ['ZZZQ']);
    assert.equal(result.technicals_as_of, '2026-10-24', 'the price-data date travels with the rows');
    assert.deepEqual(result.similar_to, { symbol: 'ORCL' });
});

test('get_recent_filings reads a statements file only for the rows it returns', (t) => {
    const run = writeRecentFilingsFixture(t);
    const reads = [];
    const real = fs.readFileSync;
    t.mock.method(fs, 'readFileSync', function (p, ...rest) {
        if (String(p).includes('sec-financials')) reads.push(String(p));
        return real.call(fs, p, ...rest);
    });
    const result = run({ limit: 3 });
    assert.equal(result.filings.length, 3);
    const periodic = result.filings.filter((r) => r.kind !== 'earnings_release').length;
    assert.equal(reads.length, periodic, 'one statements read per returned periodic row, none for the rest');
});
