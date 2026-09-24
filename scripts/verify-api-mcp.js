'use strict';
/**
 * End-to-end check of BOTH paid developer surfaces against a running server.
 *
 * Exists because "the API works" was only ever verified by hand with curl, one
 * endpoint at a time, and the MCP half needs a real Streamable HTTP client so
 * it never got checked at all without bespoke scripting. Run this before any
 * model flip or deploy: every documented REST endpoint, every MCP tool, the
 * auth boundary, and the anonymous MCP cap.
 *
 * It spends real credits on the two `ask` calls (one REST, one MCP) because a
 * mocked ask proves nothing about the model actually being reachable.
 *
 * Run it against a FRESHLY started server: the anonymous-tier check asserts an
 * exact remaining quota, so a previous run's free asks would make it fail.
 *
 *   node scripts/dev-local.js                      # in another shell
 *   node scripts/verify-api-mcp.js --key sp_live_...
 *   node scripts/verify-api-mcp.js --server http://localhost:5055 --key ... --anon-limit 2
 *
 * Exits non-zero if any check fails, so it can gate a release.
 */
const path = require('path');
// The MCP SDK declares package `exports`, so a raw path into node_modules does
// not resolve — the require has to be rooted inside backend/, where the
// dependency actually lives (this repo keeps deps there, not at the root).
const { createRequire } = require('module');
const BK = createRequire(path.join(__dirname, '..', 'backend', 'package.json'));
const { Client } = BK('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = BK('@modelcontextprotocol/sdk/client/streamableHttp.js');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SERVER = arg('--server', 'http://localhost:5055').replace(/\/+$/, '');
const KEY = arg('--key', '');
const ANON_LIMIT = Number(arg('--anon-limit', '2'));

let pass = 0, fail = 0;
function check(ok, label, detail) {
    if (ok) { pass++; console.log(`  PASS  ${label}`); }
    else { fail++; console.log(`  FAIL  ${label}${detail ? `  :: ${detail}` : ''}`); }
}

async function http(pathname, { method = 'GET', body = null, key = KEY } = {}) {
    const headers = {};
    if (key) headers['X-Api-Key'] = key;
    if (body) headers['Content-Type'] = 'application/json';
    const r = await fetch(SERVER + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch (_) { /* html error page */ }
    return { status: r.status, json, text };
}

async function mcpClient(withKey) {
    const t = new StreamableHTTPClientTransport(new URL(SERVER + '/mcp'),
        withKey ? { requestInit: { headers: { 'X-Api-Key': KEY } } } : {});
    const c = new Client({ name: 'verify-api-mcp', version: '1.0.0' }, { capabilities: {} });
    await c.connect(t);
    return c;
}
function mcpText(r) { return String((r.content && r.content[0] && r.content[0].text) || ''); }
function mcpFailed(r) { return Boolean(r.isError) || /"error"\s*:/.test(mcpText(r)); }

(async () => {
    if (!KEY) { console.error('--key is required (dev-local.js prints one).'); process.exit(2); }
    console.log(`Verifying ${SERVER}\n`);

    console.log('REST — auth boundary');
    check((await http('/api/v1/health', { key: '' })).status === 200, 'health is reachable unauthenticated');
    check((await http('/api/v1/filing/AAPL', { key: '' })).status === 401, 'no key is rejected 401');
    check((await http('/api/v1/filing/AAPL', { key: 'sp_live_deadbeef' })).status === 401, 'bad key is rejected 401');

    console.log('\nREST — every documented endpoint');
    for (const ep of [
        '/api/v1/financials/AAPL?tool=earnings-quality',
        '/api/v1/financials/MSFT?tool=dilution',
        '/api/v1/filing/NVDA',
        '/api/v1/compare?tickers=AAPL,MSFT',
        '/api/v1/screen?tickers=AAPL,MSFT,NVDA',
        '/api/v1/fund/SPY'
    ]) {
        const r = await http(ep);
        check(r.status === 200 && r.json && !r.json.error, `GET ${ep}`, `status ${r.status}`);
    }

    console.log('\nREST — AI ask (spends credits, proves the model is reachable)');
    const ask = await http('/api/v1/ask', { method: 'POST', body: { question: 'What was Apple total revenue in the latest 10-K?' } });
    check(ask.status === 200 && ask.json && ask.json.answer, 'POST /api/v1/ask returns an answer', `status ${ask.status}`);
    check(ask.json && /\d/.test(String(ask.json.answer || '')), 'the answer carries a figure, not a hedge');
    check(ask.json && Array.isArray(ask.json.toolsUsed) && ask.json.toolsUsed.length > 0, 'the answer is grounded in at least one tool call');

    console.log('\nMCP — keyed');
    const c = await mcpClient(true);
    const tools = await c.listTools();
    check(tools.tools.length === 7, `all 7 tools advertised`, `saw ${tools.tools.length}`);
    for (const [name, args] of [
        ['sp_health', {}],
        ['sp_financials', { ticker: 'AAPL', tool: 'earnings-quality' }],
        ['sp_filing', { ticker: 'NVDA' }],
        ['sp_compare', { tickers: 'AAPL,MSFT' }],
        ['sp_screen', { tickers: 'AAPL,MSFT,NVDA' }],
        ['sp_fund', { symbol: 'SPY' }]
    ]) {
        const r = await c.callTool({ name, arguments: args });
        check(!mcpFailed(r), `${name}`, mcpText(r).slice(0, 90));
    }
    const mcpAsk = await c.callTool({ name: 'sp_ask', arguments: { question: 'What was Apple revenue last fiscal year?' } });
    check(!mcpFailed(mcpAsk) && /\d/.test(mcpText(mcpAsk)), 'sp_ask returns a figure', mcpText(mcpAsk).slice(0, 90));
    await c.close();

    console.log(`\nMCP — anonymous tier (cap expected at ${ANON_LIMIT})`);
    const a = await mcpClient(false);
    check(!mcpFailed(await a.callTool({ name: 'sp_health', arguments: {} })), 'keyless sp_health is allowed (free probe)');
    let allowed = 0, refused = 0;
    for (let i = 0; i < ANON_LIMIT + 2; i++) {
        const r = await a.callTool({ name: 'sp_ask', arguments: { question: `What was Apple revenue in FY${2019 + i}?` } });
        if (mcpFailed(r)) refused++; else allowed++;
    }
    check(allowed === ANON_LIMIT, `exactly ${ANON_LIMIT} free asks allowed`, `allowed ${allowed}`);
    check(refused >= 2, 'the cap then refuses, rather than serving unmetered AI', `refused ${refused}`);
    await a.close();

    console.log(`\n${fail === 0 ? 'ALL CHECKS PASSED' : 'FAILURES PRESENT'} — ${pass} passed, ${fail} failed`);
    process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('verify-api-mcp crashed: ' + e.message); process.exit(2); });
