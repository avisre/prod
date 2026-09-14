'use strict';

// mcp-anon.js — the keyless MCP allowance. Real Mongo (in-memory), same pattern
// as test/api-keys.test.js: this module's whole job is counting correctly
// against a database, and a hand-rolled fake would prove nothing about the
// upsert/rollover behaviour that actually bounds the AI spend.

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mcpAnon = require('../mcp-anon');

const IP = '203.0.113.7';

test('keyless MCP allowance: limits, messaging, ceilings and rollover', { timeout: 60000 }, async (t) => {
    const server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await server.stop(); });

    const env = { ANON_MCP_ASK_LIMIT: '3', ANON_MCP_LOOKUP_LIMIT: '5', ANON_MCP_GLOBAL_ASK_DAY: '100', ANON_MCP_WINDOW_DAYS: '30' };
    const wallet = mcpAnon.creditsFor(IP, env);

    // Asks are allowed up to the limit, and each one is recorded.
    for (let i = 0; i < 3; i++) {
        const gate = await wallet.check(IP, 'mcp_ask', 0, null, null);
        assert.equal(gate.ok, true, `ask ${i + 1} of 3 is inside the free allowance`);
        assert.equal(gate.used, i, 'usage reflects what was already spent');
        await wallet.spend(IP, 'mcp_ask', 'mcp:ask');
    }

    // The fourth is refused, and the copy must sell the plan rather than talk
    // about a wallet the caller never had.
    const exhausted = await wallet.check(IP, 'mcp_ask', 0, null, null);
    assert.equal(exhausted.ok, false, 'the ask allowance is enforced');
    assert.match(exhausted.message, /all 3 free questions/, 'says how many were free');
    assert.match(exhausted.message, /\$19\.99/, 'quotes the Dev price');
    assert.match(exhausted.message, /register\?plan=dev/, 'links somewhere a purchase can happen');
    assert.doesNotMatch(exhausted.message, /Out of credits for this month/, 'does not reuse the wallet wording');

    // Lookups are metered SEPARATELY — burning the asks must not disable the
    // cheap calls, which is the whole reason the two limits are distinct.
    const lookupGate = await wallet.check(IP, 'mcp_lookup', 0, null, null);
    assert.equal(lookupGate.ok, true, 'lookups survive an exhausted ask allowance');
    assert.equal(lookupGate.allowance, 5, 'lookups carry their own, looser allowance');

    for (let i = 0; i < 5; i++) await wallet.spend(IP, 'mcp_lookup', 'mcp:earnings-quality', 'AAPL');
    const lookupsGone = await wallet.check(IP, 'mcp_lookup', 0, null, null);
    assert.equal(lookupsGone.ok, false, 'the lookup allowance is enforced too');
    assert.match(lookupsGone.message, /5 free data lookups/, 'names the lookup allowance, not the ask one');

    // A different caller is unaffected — the allowance is per identity.
    const other = mcpAnon.creditsFor('198.51.100.22', env);
    const fresh = await other.check('198.51.100.22', 'mcp_ask', 0, null, null);
    assert.equal(fresh.ok, true, 'a different IP gets its own allowance');
});

test('the global daily ceiling bounds total anonymous spend', { timeout: 60000 }, async (t) => {
    const server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await server.stop(); });

    // A high per-IP allowance with a tiny global ceiling: the ceiling must win,
    // because per-IP limits are worthless against a caller with many addresses.
    const env = { ANON_MCP_ASK_LIMIT: '50', ANON_MCP_GLOBAL_ASK_DAY: '2' };

    await mcpAnon.creditsFor('a', env).spend('a', 'mcp_ask', 'mcp:ask');
    await mcpAnon.creditsFor('b', env).spend('b', 'mcp_ask', 'mcp:ask');

    const third = await mcpAnon.creditsFor('c', env).check('c', 'mcp_ask', 0, null, null);
    assert.equal(third.ok, false, 'a brand-new IP is refused once the day is spent');
    assert.match(third.message, /global limit/, 'explains it is a global cap, not their own');
    assert.match(third.message, /00:00 UTC/, 'says when it lifts');

    // The ceiling is asks-only: lookups carry no inference cost, so they stay open.
    const lookup = await mcpAnon.creditsFor('c', env).check('c', 'mcp_lookup', 0, null, null);
    assert.equal(lookup.ok, true, 'the global ask ceiling does not close cheap lookups');
});

test('the tier can be switched off entirely, and fails closed without a database', async () => {
    assert.equal(mcpAnon.enabled({ ANON_MCP_ASK_LIMIT: '0' }), false, 'ANON_MCP_ASK_LIMIT=0 removes the tier');
    assert.equal(mcpAnon.enabled({}), true, 'it is on by default');
    assert.equal(mcpAnon.config({}).askLimit, 10, 'the default offer is 10 questions');

    // Not connected here: a database blip must not hand out unlimited free
    // inference, so an unavailable store reads as exhausted rather than open.
    assert.equal(mongoose.connection.readyState, 0, 'precondition: no live connection');
    const gate = await mcpAnon.creditsFor('1.2.3.4', {}).check('1.2.3.4', 'mcp_ask', 0, null, null);
    assert.equal(gate.ok, false, 'fails closed when the counter store is unreachable');
});
