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
    assert.match(exhausted.message, /\$79\.99\/month/, 'quotes the Monthly price');
    assert.match(exhausted.message, /200 credits a month/, 'says what the plan buys in the connector');
    assert.match(exhausted.message, /register\?plan=monthly/, 'links somewhere a purchase can happen');
    assert.doesNotMatch(exhausted.message, /Out of credits for this month/, 'does not reuse the wallet wording');

    // Lookups are metered SEPARATELY — burning the asks must not disable the
    // cheap calls, which is the whole reason the two limits are distinct.
    const lookupGate = await wallet.check(IP, 'mcp_lookup', 0, null, null);
    assert.equal(lookupGate.ok, true, 'lookups survive an exhausted ask allowance');
    assert.equal(lookupGate.allowance, 5, 'lookups carry their own, looser allowance');
    // This gate was only read from; hand its reservation back so the five
    // real calls below get the full allowance.
    await wallet.release(IP, 'mcp_lookup');

    // check() reserves and spend() confirms, so a lookup is spent by the pair.
    for (let i = 0; i < 5; i++) {
        assert.equal((await wallet.check(IP, 'mcp_lookup', 0, null, null)).ok, true, `lookup ${i + 1} of 5 is inside the allowance`);
        await wallet.spend(IP, 'mcp_lookup', 'mcp:earnings-quality', 'AAPL');
    }
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
    // The lookup limit is set explicitly: the keyless tier is off by default
    // since 2026-10-26, so a test that exercises it opts in per knob.
    const env = { ANON_MCP_ASK_LIMIT: '50', ANON_MCP_LOOKUP_LIMIT: '50', ANON_MCP_GLOBAL_ASK_DAY: '2' };

    for (const who of ['a', 'b']) {
        assert.equal((await mcpAnon.creditsFor(who, env).check(who, 'mcp_ask', 0, null, null)).ok, true, `${who} is inside the ceiling`);
        await mcpAnon.creditsFor(who, env).spend(who, 'mcp_ask', 'mcp:ask');
    }

    const third = await mcpAnon.creditsFor('c', env).check('c', 'mcp_ask', 0, null, null);
    assert.equal(third.ok, false, 'a brand-new IP is refused once the day is spent');
    assert.match(third.message, /shared limit/, 'explains it is a global cap, not their own');
    assert.match(third.message, /00:00 UTC/, 'says when it lifts');

    // The ceiling is asks-only: lookups carry no inference cost, so they stay open.
    const lookup = await mcpAnon.creditsFor('c', env).check('c', 'mcp_lookup', 0, null, null);
    assert.equal(lookup.ok, true, 'the global ask ceiling does not close cheap lookups');
});

test('the keyless tier is off by default, and fails closed without a database', async () => {
    assert.equal(mcpAnon.enabled({ ANON_MCP_ASK_LIMIT: '0' }), false, 'ANON_MCP_ASK_LIMIT=0 removes the tier');
    // Off by default since 2026-10-26 (owner decision): free evaluation is the
    // per-account trial in mcp-trial.js, so a keyless call answers
    // AUTHENTICATION_REQUIRED with the sign-in challenge instead.
    assert.equal(mcpAnon.enabled({}), false, 'it is off with no env at all');
    assert.equal(mcpAnon.config({}).askLimit, 0, 'the default ask allowance is zero');
    assert.equal(mcpAnon.config({}).lookupLimit, 0, 'the default lookup allowance is zero');
    assert.equal(mcpAnon.enabled({ ANON_MCP_ASK_LIMIT: '3' }), true, 'env can bring the tier back');
    assert.equal(mcpAnon.config({}).globalAskDay, 100, 'the daily ceiling stays conservative (the trial reserves on it too)');
    assert.equal(typeof mcpAnon.dayKey, 'function', 'the day key is shared with mcp-trial.js');
    assert.match(mcpAnon.dayKey(new Date('2026-10-26T12:00:00Z')), /^global:2026-10-26$/);

    // Not connected here: a database blip must not hand out unlimited free
    // inference, so an unavailable store reads as exhausted rather than open.
    assert.equal(mongoose.connection.readyState, 0, 'precondition: no live connection');
    const gate = await mcpAnon.creditsFor('1.2.3.4', {}).check('1.2.3.4', 'mcp_ask', 0, null, null);
    assert.equal(gate.ok, false, 'fails closed when the counter store is unreachable');
});

// ---------------------------------------------------------------------------
// The shared AI-platform pool (ai-platform-egress.js): callers egressing from
// Anthropic's or OpenAI's own network are metered together, per UTC day, in
// rows of their own — one busy user must not close the door for a month.
// ---------------------------------------------------------------------------

test('the platform pool: separate rows, a UTC-day window, larger limits, its own copy', { timeout: 60000 }, async (t) => {
    const server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await server.stop(); });

    const env = { ANON_MCP_ASK_LIMIT: '3', ANON_MCP_LOOKUP_LIMIT: '5', ANON_MCP_PLATFORM_ASK_LIMIT: '10', ANON_MCP_PLATFORM_LOOKUP_LIMIT: '12' };
    assert.equal(mcpAnon.config(env).platform.askLimit, 10, 'the platform knobs are env-switchable');
    assert.equal(mcpAnon.config(env).platform.lookupLimit, 12);
    assert.equal(mcpAnon.config({}).platform.askLimit, 10, 'and default to the larger shared allowances');
    assert.equal(mcpAnon.config({}).platform.lookupLimit, 100);

    // An Anthropic egress address (160.79.104.0/21), for realism only — the
    // pool is chosen by the caller, not re-derived from the identity here.
    const EGRESS = '160.79.104.9';
    const col = () => mongoose.connection.collection(mcpAnon.COLLECTION);
    const hits = [];
    const platform = mcpAnon.creditsFor(EGRESS, env, (info) => hits.push(info), { pool: 'platform' });
    const visitor = mcpAnon.creditsFor(EGRESS, env);

    // The pool keeps its own row: the visitor row stays untouched.
    const first = await platform.check(EGRESS, 'mcp_lookup', 0, null, null);
    assert.equal(first.ok, true);
    assert.equal(first.pool, 'platform', 'the gate says which pool it drew on');
    assert.equal(first.allowance, 12, 'the platform lookup allowance, not the visitor one');
    await platform.spend(EGRESS, 'mcp_lookup');
    assert.equal((await col().findOne({ _id: EGRESS })), null, 'no visitor row is written for a platform-pool call');
    assert.equal((await col().findOne({ _id: `platform:${EGRESS}` })).lookups, 1, 'the platform row holds the count');

    // A visitor gate on the same identity still draws the small window.
    const v = await visitor.check(EGRESS, 'mcp_lookup', 0, null, null);
    assert.equal(v.pool, 'visitor');
    assert.equal(v.allowance, 5, 'the per-visitor allowance is unchanged');
    await visitor.release(EGRESS, 'mcp_lookup');

    // Ten platform asks: the larger allowance holds, then refuses with copy
    // that names the shared pool and the UTC-day reset.
    for (let i = 0; i < 10; i++) {
        const g = await platform.check(EGRESS, 'mcp_ask', 0, null, null);
        assert.equal(g.ok, true, `platform ask ${i + 1} of 10 is inside the shared allowance`);
        await platform.spend(EGRESS, 'mcp_ask');
    }
    const over = await platform.check(EGRESS, 'mcp_ask', 0, null, null);
    assert.equal(over.ok, false, 'the shared platform allowance is still a limit');
    assert.equal(over.pool, 'platform');
    assert.match(over.message, /AI platform's network/, 'the refusal says the allowance is shared');
    assert.match(over.message, /00:00 UTC/, 'and when it resets');
    assert.doesNotMatch(over.message, /rolling 30-day/, 'never the visitor window copy');
    assert.equal(hits[hits.length - 1].pool, 'platform', 'the cap-hit signal carries the pool');
    const nextMidnight = new Date();
    nextMidnight.setUTCHours(0, 0, 0, 0);
    nextMidnight.setUTCDate(nextMidnight.getUTCDate() + 1);
    assert.equal(over.resetsAt, nextMidnight.toISOString().slice(0, 10), 'the reset is the next 00:00 UTC');
    assert.equal(over.windowDays, 1, 'the window is the UTC day, not the rolling month');

    // Yesterday's platform row is rolled by today's call, even at the limit.
    await col().updateOne(
        { _id: 'platform:198.51.100.99' },
        { $set: { asks: 10, lookups: 12, windowStartedAt: new Date(Date.now() - 24 * 60 * 60 * 1000) } },
        { upsert: true }
    );
    const rolled = await mcpAnon.creditsFor('198.51.100.99', env, null, { pool: 'platform' }).check('198.51.100.99', 'mcp_ask', 0, null, null);
    assert.equal(rolled.ok, true, 'a platform caller whose UTC day rolled starts fresh');
    assert.equal(rolled.used, 0);

    // The usage notice carries the same shared-allowance copy.
    const notice = mcpAnon.askUsageNotice(9, 10, 1, 'platform');
    assert.match(notice, /AI platform's network/);
    assert.match(notice, /00:00 UTC/);
    assert.doesNotMatch(notice, /rolling 1-day/);
});

// The developer funnel was blind for a reason worth pinning: trackFunnel()
// silently DROPS any event name absent from growth-measurement's EVENT_NAMES
// (normalizeEventName returns null), so instrumenting the cap without
// registering the name logs nothing and looks like zero demand.
test('the cap-hit signal is both emitted and loggable', async (t) => {
    const growth = require('../growth-measurement');
    for (const name of ['mcp_keyless_cap_hit', 'mcp_oauth_client_registered', 'mcp_oauth_authorized']) {
        assert.equal(growth.EVENT_NAMES.has(name), true, `${name} must be canonical or trackFunnel discards it`);
    }
    // These are server-side and must never be accepted from a browser caller.
    assert.equal(growth.BROWSER_EVENTS.has('mcp_keyless_cap_hit'), false, 'not a browser-reportable event');

    const server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await server.stop(); });

    const env = { ANON_MCP_ASK_LIMIT: '1', ANON_MCP_LOOKUP_LIMIT: '1' };
    const hits = [];
    const credits = mcpAnon.creditsFor(IP, env, (info) => hits.push(info));

    assert.equal((await credits.check(IP, 'mcp_ask', 0, null, null)).ok, true, 'first ask is free');
    assert.equal(hits.length, 0, 'no cap hit while the caller is inside the allowance');

    await credits.spend(IP, 'mcp_ask', 'mcp', 'x');
    const blocked = await credits.check(IP, 'mcp_ask', 0, null, null);
    assert.equal(blocked.ok, false, 'the second ask is refused');
    assert.equal(hits.length, 1, 'the refusal emits exactly one cap hit');
    assert.equal(hits[0].reason, 'ask_limit');
    assert.equal(hits[0].allowance, 1);

    // A throwing callback must never cost the caller their refusal message.
    const safe = mcpAnon.creditsFor(IP, env, () => { throw new Error('telemetry down'); });
    const still = await safe.check(IP, 'mcp_ask', 0, null, null);
    assert.equal(still.ok, false, 'a broken telemetry sink does not change the gate');
    assert.match(still.message, /Monthly plan/, 'and the upsell message still reaches the caller');
});

// ---------------------------------------------------------------------------
// Atomicity — the reservation must hold under concurrency, release must give
// an unused slot back, and spend must never double count
// ---------------------------------------------------------------------------

// The bug this guards against (measured 2026-10-20): the old gate read the
// counter, let the tool run, and only then incremented, so concurrent calls
// all passed the same check and a 25-lookup identity reached 29.
test('40 concurrent checks on one identity take exactly 25 lookup slots', { timeout: 60000 }, async (t) => {
    const server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await server.stop(); });

    const env = { ANON_MCP_ASK_LIMIT: '3', ANON_MCP_LOOKUP_LIMIT: '25' };
    const wallet = mcpAnon.creditsFor(IP, env);
    const gates = await Promise.all(
        Array.from({ length: 40 }, () => wallet.check(IP, 'mcp_lookup', 0, null, null))
    );
    const ok = gates.filter((g) => g.ok);
    assert.equal(ok.length, 25, 'exactly the lookup limit passes, no matter how the calls interleave');
    const refused = gates.filter((g) => !g.ok);
    assert.equal(refused.length, 15);
    for (const g of refused) assert.match(g.message, /25 free data lookups/, 'a concurrent loser reads the cap copy');

    const doc = await mongoose.connection.collection(mcpAnon.COLLECTION).findOne({ _id: IP });
    assert.equal(doc.lookups, 25, 'the counter holds exactly the limit');
    assert.equal(doc.asks, 0, 'lookups never touch the ask counter');
});

test('release gives an unused reservation back, and spend does not double count', { timeout: 60000 }, async (t) => {
    const server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await server.stop(); });

    const env = { ANON_MCP_ASK_LIMIT: '3', ANON_MCP_LOOKUP_LIMIT: '2' };
    const wallet = mcpAnon.creditsFor(IP, env);
    const doc = () => mongoose.connection.collection(mcpAnon.COLLECTION).findOne({ _id: IP });

    const reserved = await wallet.check(IP, 'mcp_lookup', 0, null, null);
    assert.equal(reserved.ok, true);
    assert.equal(reserved.used, 0, 'used is the count before the call');
    await wallet.release(IP, 'mcp_lookup');
    assert.equal((await doc()).lookups, 0, 'a released reservation is fully given back');

    const rechecked = await wallet.check(IP, 'mcp_lookup', 0, null, null);
    assert.equal(rechecked.used, 0, 'the slot really is free again');
    await wallet.spend(IP, 'mcp_lookup', 'mcp:search_companies', 'AAPL');
    assert.equal((await doc()).lookups, 1, 'spend confirms the reservation without a second increment');

    const second = await wallet.check(IP, 'mcp_lookup', 0, null, null);
    assert.equal(second.used, 1, 'the confirmed call is what the next one reads');
    await wallet.spend(IP, 'mcp_lookup', 'mcp:search_companies', 'MSFT');
    assert.equal((await doc()).lookups, 2);
    assert.equal((await wallet.check(IP, 'mcp_lookup', 0, null, null)).ok, false, 'the limit still binds');

    // Releasing with nothing outstanding is a no-op, not an under-count.
    await wallet.release(IP, 'mcp_lookup');
    assert.equal((await doc()).lookups, 2);
});

test('an expired window rolls before the reservation, so a returning caller starts fresh', { timeout: 60000 }, async (t) => {
    const server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await server.stop(); });

    const env = { ANON_MCP_ASK_LIMIT: '3', ANON_MCP_WINDOW_DAYS: '30' };
    await mongoose.connection.collection(mcpAnon.COLLECTION).updateOne(
        { _id: IP },
        { $set: { asks: 3, lookups: 9, windowStartedAt: new Date(Date.now() - 40 * 86400000) } },
        { upsert: true }
    );

    const wallet = mcpAnon.creditsFor(IP, env);
    const rolled = await wallet.check(IP, 'mcp_ask', 0, null, null);
    assert.equal(rolled.ok, true, 'a caller whose window expired is not locked out');
    assert.equal(rolled.used, 0, 'the roll restarts the count at zero');
    await wallet.spend(IP, 'mcp_ask', 'mcp:ask');
    assert.equal((await wallet.check(IP, 'mcp_ask', 0, null, null)).used, 1, 'and the next call builds on the rolled window');
});

test('concurrent asks reserve against the global day ceiling atomically', { timeout: 60000 }, async (t) => {
    const server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await server.stop(); });

    const env = { ANON_MCP_ASK_LIMIT: '50', ANON_MCP_GLOBAL_ASK_DAY: '3' };
    const identities = Array.from({ length: 10 }, (_, i) => `198.51.100.${i + 1}`);
    const wallets = new Map(identities.map((who) => [who, mcpAnon.creditsFor(who, env)]));
    const gates = await Promise.all(
        identities.map((who) => wallets.get(who).check(who, 'mcp_ask', 0, null, null))
    );
    assert.equal(gates.filter((g) => g.ok).length, 3, 'exactly the global ceiling passes, across identities');
    for (const g of gates.filter((g) => !g.ok)) assert.match(g.message, /shared limit/, 'losers read the global copy');

    // The refused callers' reservations were undone; only the granted asks hold one.
    for (const [i, g] of gates.entries()) {
        if (g.ok) await wallets.get(identities[i]).spend(identities[i], 'mcp_ask', 'mcp:ask');
    }
    const rows = await Promise.all(identities.map((who) => mongoose.connection.collection(mcpAnon.COLLECTION).findOne({ _id: who })));
    const reserved = rows.filter(Boolean).map((r) => r.asks).reduce((a, b) => a + b, 0);
    assert.equal(reserved, 3, 'only the granted asks hold a reservation anywhere');
});
