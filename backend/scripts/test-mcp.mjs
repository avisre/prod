#!/usr/bin/env node
// Live MCP compatibility check — the 10 scenarios a directory scan, ChatGPT
// custom connector or CLI client actually performs, run against a REAL
// endpoint (production by default), printing PASS/FAIL per scenario.
//
// Why a separate script when backend/test/mcp-endpoint.test.js already covers
// this: the test file mounts the handler in-process, so it can prove the code
// is right but never that the deployed service is. The failure that started
// this work — a directory marking /mcp Unhealthy after an HTTP 402 that no
// local test could see — is a between-the-parts failure: the proxy, the
// transport wall and the plan gate all behave under test and still refused a
// real client. This script crosses the wire instead, and it is deliberately
// dependency-light: the MCP SDK client (already in backend/node_modules) for
// the well-formed scenarios, raw fetch for the parts a real client fumbles.
//
//   cd backend && npm run test:mcp
//   node scripts/test-mcp.mjs --url https://www.stockportfolio.pro/mcp
//   node scripts/test-mcp.mjs --key sp_live_...        (a key is optional)
//
// The key is read from --key, then STOCKPORTFOLIO_API_KEY, then
// ~/.config/stockportfolio/api-key. It is never printed; only a fingerprint
// is, so a failing run can be pasted into a chat without leaking a credential.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const DEFAULT_URL = 'https://www.stockportfolio.pro/mcp';
const TIMEOUT_MS = 30_000;

const argv = process.argv.slice(2);
const argOf = (name) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
};
const URL_ = argOf('--url') || process.env.MCP_URL || DEFAULT_URL;
const CYCLES = Number(argOf('--cycles')) || 5;

function resolveKey() {
    const fromArg = argOf('--key') || process.env.STOCKPORTFOLIO_API_KEY;
    if (fromArg) return fromArg.trim();
    const file = path.join(os.homedir(), '.config', 'stockportfolio', 'api-key');
    try {
        const key = fs.readFileSync(file, 'utf8').trim();
        return key || null;
    } catch {
        return null;
    }
}
const KEY = resolveKey();
// A fingerprint, not the key: enough to tell two credentials apart in a log,
// useless to anyone reading it.
const fingerprint = (k) => (k ? `${k.slice(0, 7)}…${crypto.createHash('sha256').update(k).digest('hex').slice(0, 8)}` : 'none');

// ── reporting ───────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
let skipped = 0;
const failures = [];

function pass(name, detail) {
    passed++;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ''}`);
}
function fail(name, detail) {
    failed++;
    failures.push(`${name}: ${detail}`);
    console.log(`FAIL  ${name} — ${detail}`);
}
function skip(name, reason) {
    skipped++;
    console.log(`SKIP  ${name} — ${reason}`);
}
// Each scenario is one try/catch so a thrown assertion cannot abort the run:
// the point of the script is to report every scenario, including the ones
// after a failure.
async function scenario(name, fn) {
    try {
        await fn();
    } catch (err) {
        fail(name, `threw ${err?.name || 'Error'}: ${err?.message || err}`);
    }
}

// ── raw JSON-RPC over the wire ──────────────────────────────────────────────
// Used wherever the assertion is about the HTTP layer — status codes, a
// malformed body, a notification — which the SDK client hides by design.
async function rpc({ body, method = 'POST', key = null, rawBody = null, headers = {} }) {
    const res = await fetch(URL_, {
        method,
        headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...(key ? { authorization: `Bearer ${key}` } : {}),
            ...headers
        },
        body: rawBody !== null ? rawBody : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS)
    });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* SSE or an empty 202 body */ }
    if (!json && text.startsWith('event:')) {
        // Streamable HTTP may answer a POST with a one-shot SSE stream.
        const line = text.split('\n').find((l) => l.startsWith('data:'));
        if (line) { try { json = JSON.parse(line.slice(5).trim()); } catch { /* leave null */ } }
    }
    return { status: res.status, json, text };
}

const INITIALIZE = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'stockportfolio-test-mcp', version: '1.0.0' }
    }
};

// A real MCP client handshake, which is what a directory or ChatGPT does:
// connect() runs initialize + notifications/initialized and negotiates the
// protocol version. `key` null exercises the keyless tier.
async function connect(key = null) {
    const client = new Client({ name: 'stockportfolio-test-mcp', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(new URL(URL_), {
        requestInit: key ? { headers: { authorization: `Bearer ${key}` } } : undefined
    });
    await client.connect(transport);
    return client;
}

const textOf = (result) => (result?.content || []).map((c) => c.text || '').join('\n');
const codeOf = (result) => {
    try { return JSON.parse(textOf(result)).code || null; } catch { return null; }
};

// ── the scenarios ───────────────────────────────────────────────────────────

console.log(`\nStockPortfolio.pro MCP compatibility check`);
console.log(`endpoint : ${URL_}`);
console.log(`key      : ${KEY ? fingerprint(KEY) : 'none (keyless tier only)'}\n`);

// 1. initialize — the first message any client sends. It must never be
// refused: a client that cannot initialize cannot read the tool list, so a
// refusal here is indistinguishable from a dead server.
await scenario('initialize', async () => {
    const { status, json } = await rpc({ body: INITIALIZE });
    if (status === 402) return fail('initialize', 'HTTP 402 — the exact failure this script exists to catch');
    if (status !== 200) return fail('initialize', `HTTP ${status}`);
    const r = json?.result;
    if (!r) return fail('initialize', `no result: ${JSON.stringify(json).slice(0, 200)}`);
    if (!r.protocolVersion) return fail('initialize', 'result carries no protocolVersion');
    if (!r.serverInfo?.name) return fail('initialize', 'result carries no serverInfo.name');
    if (!r.capabilities?.tools) return fail('initialize', 'does not advertise the tools capability');
    pass('initialize', `${r.serverInfo.name} ${r.serverInfo.version || ''} protocol ${r.protocolVersion}`);
});

// 2. notifications/initialized — a notification, so the correct answer is an
// accepted-with-no-body status. A 402/405 here breaks real clients mid-handshake.
await scenario('notifications/initialized', async () => {
    const { status } = await rpc({ body: { jsonrpc: '2.0', method: 'notifications/initialized' } });
    if (status === 402) return fail('notifications/initialized', 'HTTP 402 on a protocol notification');
    if (![200, 202, 204].includes(status)) return fail('notifications/initialized', `HTTP ${status}`);
    pass('notifications/initialized', `HTTP ${status}`);
});

// 3. tools/list — tool discovery. Must work with NO credential and no
// payment: this is the message whose refusal made the endpoint unlistable.
let tools = [];
await scenario('tools/list (no credentials)', async () => {
    const { status, json } = await rpc({ body: { jsonrpc: '2.0', id: 2, method: 'tools/list' } });
    if (status === 402) return fail('tools/list', 'HTTP 402 — discovery must never be charged');
    if (status !== 200) return fail('tools/list', `HTTP ${status}`);
    tools = json?.result?.tools || [];
    if (!tools.length) return fail('tools/list', 'no tools returned');
    for (const t of tools) {
        if (!t.name || !t.inputSchema) return fail('tools/list', `tool ${t.name || '(unnamed)'} is missing name or inputSchema`);
        if (!t.description) return fail('tools/list', `tool ${t.name} has no description to route on`);
    }
    pass('tools/list', `${tools.length} tools`);
});

// 3b. The same thing through the SDK, which is how a real client does it —
// proving the handshake works end to end and not just as loose JSON-RPC.
await scenario('tools/list (SDK client handshake)', async () => {
    const client = await connect(KEY);
    try {
        const listed = await client.listTools();
        if ((listed.tools || []).length !== tools.length) {
            return fail('tools/list (SDK)', `SDK saw ${listed.tools.length} tools, raw JSON-RPC saw ${tools.length}`);
        }
        pass('tools/list (SDK)', `handshake ok, ${listed.tools.length} tools`);
    } finally {
        await client.close().catch(() => {});
    }
});

console.log(`\nTools advertised by ${URL_}:`);
for (const t of tools) {
    const flags = [t.annotations?.readOnlyHint ? 'read-only' : null, t.title ? null : 'NO TITLE'].filter(Boolean).join(', ');
    console.log(`  · ${t.name}${flags ? `  (${flags})` : ''}`);
}
console.log('');

const nameOf = (predicate) => tools.find(predicate)?.name || null;
const freeTool = nameOf((t) => /^search_companies$/.test(t.name)) || nameOf((t) => /health/i.test(t.name));
const meteredTool = nameOf((t) => /fundamentals|financials/i.test(t.name));
const askTool = nameOf((t) => /ask/i.test(t.name));

// 4. Company search, keyless. It spends one lookup from the keyless allowance
// (it was free until 2026-10-08). Proves the read path returns structured data
// and that the keyless tier reaches real data, not just the tool list.
await scenario('call company search keyless (search_companies)', async () => {
    if (!freeTool) return fail('call a free tool', 'no free read tool is advertised');
    const { status, json } = await rpc({
        body: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: freeTool, arguments: { query: 'Apple' } } }
    });
    if (status !== 200) return fail('call a free tool', `HTTP ${status}`);
    const r = json?.result;
    if (!r) return fail('call a free tool', `no result: ${JSON.stringify(json).slice(0, 200)}`);
    if (r.isError) return fail('call a free tool', `tool error: ${textOf(r).slice(0, 160)}`);
    const parsed = JSON.parse(textOf(r));
    const rows = parsed.companies || parsed.matches || [];
    if (!rows.length) return fail('call a free tool', 'returned no matches for a query that must match');
    if (!rows[0].ticker) return fail('call a free tool', 'no ticker in the first match');
    pass('call a free tool', `${freeTool}("Apple") → ${rows.length} match(es), first ${rows[0].ticker}`);
});

// 5. A metered tool WITHOUT credentials. The requirement is not that this
// succeeds — it is that the refusal, if any, is a readable tool result and
// never a transport status. A 402 here is what a client reports as "server
// broken"; a tool error is something the model can act on (and the user can
// read). Both a keyless success and a structured refusal pass.
await scenario('metered tool without credentials', async () => {
    if (!meteredTool) return fail('metered tool without credentials', 'no metered tool is advertised');
    const { status, json } = await rpc({
        body: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: meteredTool, arguments: { ticker: 'AAPL', periods: 1 } } }
    });
    if (status === 402 || status === 401) return fail('metered tool without credentials', `HTTP ${status} at the transport — the client cannot read this`);
    if (status !== 200) return fail('metered tool without credentials', `HTTP ${status}`);
    const r = json?.result;
    if (!r) return fail('metered tool without credentials', 'no tool result');
    if (!r.isError) return pass('metered tool without credentials', 'keyless tier allowed the lookup (inside its free allowance)');
    const code = codeOf(r);
    if (!code) return fail('metered tool without credentials', 'refused without a machine-readable code');
    pass('metered tool without credentials', `structured tool error: ${code}`);
});

// 6. A metered tool WITH credentials. Needs a key: without one the keyless
// allowance is what is under test, not the account path.
if (!KEY) {
    skip('metered tool with credentials', 'no key found (pass --key, set STOCKPORTFOLIO_API_KEY, or write ~/.config/stockportfolio/api-key)');
} else {
    await scenario('metered tool with credentials', async () => {
        const client = await connect(KEY);
        try {
            const r = await client.callTool({ name: meteredTool || freeTool, arguments: { ticker: 'AAPL', periods: 1 } });
            if (r.isError) {
                const code = codeOf(r);
                // A 0-credit account is a legitimate state, not a broken server
                // — but it is not a success for THIS scenario either.
                if (code === 'QUOTA_EXCEEDED' || code === 'ENTITLEMENT_REQUIRED') {
                    return skip('metered tool with credentials', `key is valid but not entitled/out of credits (${code})`);
                }
                return fail('metered tool with credentials', `tool error ${code || ''}: ${textOf(r).slice(0, 160)}`);
            }
            const parsed = JSON.parse(textOf(r));
            const company = parsed.company || {};
            if (!company.ticker && !company.cik) return fail('metered tool with credentials', 'result carries no company identity');
            const observations = (parsed.metrics || []).flatMap((m) => m.observations || []);
            if (!observations.length) return fail('metered tool with credentials', 'returned no observations');
            const cited = observations.filter((o) => o.source_url || o.filing_url || o.accession_number || o.source?.url);
            if (!cited.length) return fail('metered tool with credentials', 'no observation carries a filing citation');
            pass('metered tool with credentials', `${company.ticker || company.cik}: ${observations.length} observations, ${cited.length} cited`);
        } finally {
            await client.close().catch(() => {});
        }
    });
}

// 7. Out of credits. This needs an account that is actually out, which this
// script cannot conjure without spending real money — so it asserts the shape
// when the account happens to be drained and otherwise says so out loud,
// rather than printing a PASS it did not earn. The in-process suite covers
// the drained case against a real limiter (backend/test/mcp-endpoint.test.js).
if (!KEY) {
    skip('insufficient credits', 'no key to spend from');
} else {
    skip('insufficient credits', 'needs an account with 0 credits; the drained-account case is covered by backend/test/mcp-endpoint.test.js');
}

// 8. Repeated connect/disconnect. A directory health check, a ChatGPT
// reconnect or a retry loop opens and drops sessions constantly, and the
// stateless transport has to survive it — this is the shape of the crash that
// took the service down (exit 134) and of the leaks that precede one.
await scenario(`repeated connect/disconnect ×${CYCLES}`, async () => {
    const times = [];
    for (let i = 0; i < CYCLES; i++) {
        const started = Date.now();
        const client = await connect(KEY);
        try {
            const listed = await client.listTools();
            if (!(listed.tools || []).length) return fail('repeated connect/disconnect', `cycle ${i + 1} saw no tools`);
        } finally {
            await client.close().catch(() => {});
        }
        times.push(Date.now() - started);
    }
    pass('repeated connect/disconnect', `${CYCLES} cycles, ${Math.min(...times)}–${Math.max(...times)}ms each`);
});

// 9. A malformed request. Clients and probes send garbage; the answer must be
// a clean JSON-RPC/HTTP error, never a 402 and never a dead process.
await scenario('malformed request', async () => {
    const { status } = await rpc({ rawBody: '{"jsonrpc":"2.0","id":9,"method":' });
    if (status === 402) return fail('malformed request', 'HTTP 402 on unparseable input');
    if (status >= 500) return fail('malformed request', `HTTP ${status} — a bad request must not be a server error`);
    // The server has to still be there afterwards, which is the half that a
    // status code alone does not prove.
    const after = await rpc({ body: INITIALIZE });
    if (after.status !== 200) return fail('malformed request', `endpoint stopped answering initialize afterwards (HTTP ${after.status})`);
    pass('malformed request', `HTTP ${status}, endpoint still healthy`);
});

// 10. An unknown tool. The model will hallucinate tool names; the answer has
// to be a structured error the model can read and correct from, and the
// session has to survive it.
await scenario('unknown tool', async () => {
    const { status, json } = await rpc({
        body: { jsonrpc: '2.0', id: 10, method: 'tools/call', params: { name: 'definitely_not_a_tool', arguments: {} } }
    });
    if (status === 402) return fail('unknown tool', 'HTTP 402 for a bad tool name');
    if (status !== 200) return fail('unknown tool', `HTTP ${status}`);
    const r = json?.result;
    if (!r?.isError) return fail('unknown tool', 'not reported as a tool error');
    const code = codeOf(r);
    if (!code) return fail('unknown tool', 'error carries no code');
    const after = await rpc({ body: { jsonrpc: '2.0', id: 11, method: 'tools/list' } });
    if (after.status !== 200) return fail('unknown tool', `session did not survive the error (HTTP ${after.status})`);
    pass('unknown tool', `${code}, session survived`);
});

// ── summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed, ${skipped} skipped`);
if (failed) {
    console.log('\nFailures:');
    for (const f of failures) console.log(`  · ${f}`);
}
console.log('');
process.exit(failed ? 1 : 0);
