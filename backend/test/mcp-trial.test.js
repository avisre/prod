'use strict';

// mcp-trial.js — the per-account 30-day trial. Real Mongo (in-memory), same
// pattern as test/mcp-anon.test.js: this module's whole job is counting
// correctly against a database, and a hand-rolled fake would prove nothing
// about the upsert/never-rollover behaviour that actually bounds the trial.

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mcpTrial = require('../mcp-trial');
const mcpAnon = require('../mcp-anon');

const USER = 'user-trial-1';
const DAY_MS = 24 * 60 * 60 * 1000;

const ENV = { MCP_TRIAL_DAYS: '30', MCP_TRIAL_LOOKUPS: '25', MCP_TRIAL_ASKS: '3' };

async function mongo(t) {
    const server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await server.stop(); });
    return mongoose.connection.collection(mcpTrial.COLLECTION);
}

test('the first call starts the trial: startedAt is set once, and the config is env-switchable', { timeout: 60000 }, async (t) => {
    const col = await mongo(t);
    const wallet = mcpTrial.creditsFor(USER, ENV);

    assert.equal((await col.findOne({ _id: USER })), null, 'no trial exists before the first call');
    const gate = await wallet.check(USER, 'mcp_lookup');
    assert.equal(gate.ok, true, 'the first lookup is allowed');
    assert.equal(gate.used, 0, 'used is the count before the call');
    const doc = await col.findOne({ _id: USER });
    assert.ok(doc.startedAt instanceof Date, 'startedAt is stamped at the first reserved call');
    const startedAt = doc.startedAt.getTime();
    assert.equal(doc.lookups, 1, 'the reservation is the increment itself');
    assert.equal(doc.asks, 0, 'a lookup never touches the ask counter');

    // The trial end is 30 days from THAT first call, not from signup.
    assert.equal(new Date(gate.endsAt).getTime(), startedAt + 30 * DAY_MS, 'endsAt is startedAt + days');
    assert.equal(gate.lookupsLeft, 24, 'the ok gate reports what remains');
    assert.equal(gate.asksLeft, 3);
    assert.equal(gate.daysLeft, 30, 'the first call sees the whole window');

    // env knobs: the trial is configurable without a deploy.
    const custom = mcpTrial.config({ MCP_TRIAL_DAYS: '7', MCP_TRIAL_LOOKUPS: '11', MCP_TRIAL_ASKS: '5' });
    assert.deepEqual([custom.days, custom.lookups, custom.asks], [7, 11, 5]);
    assert.equal(mcpTrial.config({}).days, 30, 'defaults: 30 days, 25 lookups, 3 asks');
    assert.deepEqual([mcpTrial.config({}).lookups, mcpTrial.config({}).asks], [25, 3]);
});

test('the 26th lookup and the 4th AI answer are refused, each with its own reason', { timeout: 60000 }, async (t) => {
    const col = await mongo(t);
    const wallet = mcpTrial.creditsFor(USER, ENV);

    for (let i = 0; i < 25; i++) {
        assert.equal((await wallet.check(USER, 'mcp_lookup')).ok, true, `lookup ${i + 1} of 25 is inside the trial`);
        await wallet.spend(USER, 'mcp_lookup', 'mcp:search_companies', 'AAPL');
    }
    const lookupsGone = await wallet.check(USER, 'mcp_lookup');
    assert.equal(lookupsGone.ok, false, 'the lookup allowance is enforced');
    assert.equal(lookupsGone.reason, 'lookup_limit');
    assert.match(lookupsGone.message, /all 25 free data lookups/, 'names the trial allowance');
    assert.match(lookupsGone.message, /30-day free trial/, 'says which allowance it was');
    assert.match(lookupsGone.message, /\$79\.99\/month/, 'the refusal copy says how to continue');
    assert.match(lookupsGone.message, /200 credits a month/, 'with the Monthly wallet');
    assert.match(lookupsGone.message, /upgrade\.html/, 'and links the upgrade page');
    assert.equal(lookupsGone.used, 25, 'the refusal reports the count');
    assert.equal(lookupsGone.allowance, 25);

    // Asks are metered SEPARATELY, the same split as the keyless tier had.
    const askWallet = mcpTrial.creditsFor(USER + '-asks', ENV);
    for (let i = 0; i < 3; i++) {
        assert.equal((await askWallet.check(USER + '-asks', 'mcp_ask')).ok, true, `ask ${i + 1} of 3 is inside the trial`);
        await askWallet.spend(USER + '-asks', 'mcp_ask', 'mcp:ask_filings', 'AAPL');
    }
    const asksGone = await askWallet.check(USER + '-asks', 'mcp_ask');
    assert.equal(asksGone.ok, false, 'the ask allowance is enforced too');
    assert.equal(asksGone.reason, 'ask_limit');
    assert.match(asksGone.message, /all 3 free AI answers/, 'names the ask allowance, not the lookup one');
});

test('day 30 refuses with trial_ended even with allowance left, and NEVER rolls over', { timeout: 60000 }, async (t) => {
    const col = await mongo(t);
    // An account that started 31 days ago and has used almost nothing.
    await col.updateOne(
        { _id: USER },
        { $set: { startedAt: new Date(Date.now() - 31 * DAY_MS), lookups: 2, asks: 1 } },
        { upsert: true }
    );

    const wallet = mcpTrial.creditsFor(USER, ENV);
    const gate = await wallet.check(USER, 'mcp_lookup');
    assert.equal(gate.ok, false, 'a trial past its end refuses');
    assert.equal(gate.reason, 'trial_ended');
    assert.match(gate.message, /30-day free trial .* has ended/, 'says the trial has ended');
    assert.match(gate.message, /subscribe to the Monthly plan \(\$79\.99\/month, cancel anytime\)/);
    assert.match(gate.message, /200 credits a month/);
    assert.match(gate.message, /upgrade\.html/, 'links the upgrade page');
    assert.equal(gate.used, 2, 'the refusal still reports the recorded count');
    assert.ok(gate.endsAt, 'the refusal says when the trial ended');

    // NEVER rolls over: every later call refuses identically, forever.
    const later = await wallet.check(USER, 'mcp_ask');
    assert.equal(later.ok, false);
    assert.equal(later.reason, 'trial_ended', 'asks refuse the same way');
    const row = await col.findOne({ _id: USER });
    assert.deepEqual([row.lookups, row.asks], [2, 1], 'a refused call after the end reserves nothing');

    // The status reads as ended for the profile page and the emails.
    const st = await mcpTrial.status(USER);
    assert.equal(st.started, true);
    assert.equal(st.ended, true);
    assert.equal(st.daysLeft, 0);
    assert.equal(st.lookupsUsed, 2);
    assert.equal(st.asksUsed, 1);
    assert.equal(st.lookupsLeft, 23, 'status reports the allowance still on paper');
    assert.equal(st.asksLeft, 2);
});

test('40 concurrent checks take exactly 25 lookup slots, and asks also bound on the shared day ceiling', { timeout: 60000 }, async (t) => {
    const col = await mongo(t);
    const wallet = mcpTrial.creditsFor(USER, ENV);
    const gates = await Promise.all(
        Array.from({ length: 40 }, () => wallet.check(USER, 'mcp_lookup'))
    );
    assert.equal(gates.filter((g) => g.ok).length, 25, 'exactly the lookup limit passes, no matter how the calls interleave');
    assert.equal(gates.filter((g) => !g.ok).length, 15);
    assert.equal(gates.filter((g) => !g.ok).every((g) => g.reason === 'lookup_limit'), true, 'a concurrent loser reads the limit reason');
    const doc = await col.findOne({ _id: USER });
    assert.equal(doc.lookups, 25, 'the counter holds exactly the limit');
    assert.equal(doc.asks, 0, 'lookups never touch the ask counter');

    // Asks reserve on mcp-anon's global day doc too: one 100/day ceiling shared
    // with anything keyless, never a second ceiling.
    const askEnv = { ...ENV, ANON_MCP_GLOBAL_ASK_DAY: '2' };
    const a = mcpTrial.creditsFor('c1', askEnv);
    const b = mcpTrial.creditsFor('c2', askEnv);
    for (const w of [a, b]) {
        const g = await w.check(w === a ? 'c1' : 'c2', 'mcp_ask');
        assert.equal(g.ok, true);
        await w.spend('c1' === (w === a ? 'c1' : 'c2') ? 'c1' : 'c2', 'mcp_ask', 'mcp:ask');
    }
    const third = await mcpTrial.creditsFor('c3', askEnv).check('c3', 'mcp_ask');
    assert.equal(third.ok, false, 'a brand-new account is refused once the shared day is spent');
    assert.equal(third.reason, 'global_ask_day');
    assert.match(third.message, /00:00 UTC/, 'the global refusal says when it lifts');
    const dayDoc = await mongoose.connection.collection(mcpAnon.COLLECTION)
        .findOne({ _id: new RegExp('^global:') });
    assert.equal(dayDoc.asks, 2, 'the day ceiling counts both surfaces on one doc');
    // The refused account's own trial was untouched by its refused ask.
    const c3row = await col.findOne({ _id: 'c3' });
    assert.equal(c3row.asks, 0, 'a globally refused call burns none of the trial');
});

test('release gives an unused reservation back, and spend does not double count', { timeout: 60000 }, async (t) => {
    const col = await mongo(t);
    const wallet = mcpTrial.creditsFor(USER, ENV);
    const doc = () => col.findOne({ _id: USER });

    const reserved = await wallet.check(USER, 'mcp_lookup');
    assert.equal(reserved.ok, true);
    await wallet.release(USER, 'mcp_lookup');
    assert.equal((await doc()).lookups, 0, 'a released reservation is fully given back');

    const rechecked = await wallet.check(USER, 'mcp_lookup');
    assert.equal(rechecked.used, 0, 'the slot really is free again');
    await wallet.spend(USER, 'mcp_lookup', 'mcp:search_companies', 'AAPL');
    assert.equal((await doc()).lookups, 1, 'spend confirms the reservation without a second increment');
    // Releasing with nothing outstanding is a no-op, not an under-count.
    await wallet.release(USER, 'mcp_lookup');
    assert.equal((await doc()).lookups, 1);

    // An ask that is released also gives the global day slot back.
    const askEnv = { ...ENV, ANON_MCP_GLOBAL_ASK_DAY: '1' };
    const asker = mcpTrial.creditsFor(USER, askEnv);
    const askGate = await asker.check(USER, 'mcp_ask');
    assert.equal(askGate.ok, true);
    await asker.release(USER, 'mcp_ask');
    const dayDoc = await mongoose.connection.collection(mcpAnon.COLLECTION).findOne({ _id: new RegExp('^global:') });
    assert.equal(dayDoc.asks, 0, 'the shared day slot went back with the trial slot');
    const again = await asker.check(USER, 'mcp_ask');
    assert.equal(again.ok, true, 'and the same day slot can be taken again');
});

test('status() is correct before, during and after the trial, and survives an unreachable store', { timeout: 60000 }, async (t) => {
    await mongo(t);

    const fresh = await mcpTrial.status('nobody-yet');
    assert.equal(fresh.started, false, 'an account that never called has no trial');
    assert.equal(fresh.ended, false);
    assert.equal(fresh.lookupsLeft, 25);
    assert.equal(fresh.asksLeft, 3);
    assert.ok(fresh.startedAt === null && fresh.endsAt === null, 'no dates before the first call');

    const wallet = mcpTrial.creditsFor(USER, ENV);
    await wallet.check(USER, 'mcp_lookup');
    await wallet.spend(USER, 'mcp_lookup', 'mcp:get_red_flags', 'NVDA');
    await wallet.check(USER, 'mcp_ask');
    await wallet.spend(USER, 'mcp_ask', 'mcp:ask_filings', 'NVDA');

    const st = await mcpTrial.status(USER);
    assert.equal(st.started, true);
    assert.equal(st.lookupsUsed, 1);
    assert.equal(st.asksUsed, 1);
    assert.equal(st.lookupsLeft, 24);
    assert.equal(st.asksLeft, 2);
    assert.equal(st.ended, false);
    assert.equal(st.daysLeft, 30);
    assert.equal(new Date(st.endsAt).getTime(), new Date(st.startedAt).getTime() + 30 * DAY_MS);

    // usageNotice renders the same figures the gate carried.
    const gate = await wallet.check(USER, 'mcp_lookup');
    const notice = mcpTrial.usageNotice(gate);
    assert.match(notice, /Free trial: 23 of 25 lookups and 2 of 3 AI answers left; ends \d+ \w+ \d{4} \(30 days left\)/);
    assert.match(notice, /Monthly plan \(\$79\.99\/month, 200 credits\)/);
    assert.equal(mcpTrial.usageNotice({ ok: false }), null, 'no notice on a refusal');
});

test('Mongo down fails closed: check() refuses and hands out no free use', async (t) => {
    // Not connected here: a database blip must not hand out unlimited free
    // inference, so an unavailable store reads as refused rather than open.
    assert.equal(mongoose.connection.readyState, 0, 'precondition: no live connection');
    const gate = await mcpTrial.creditsFor('1.2.3.4').check('1.2.3.4', 'mcp_lookup');
    assert.equal(gate.ok, false, 'fails closed when the counter store is unreachable');
    assert.match(gate.message, /temporarily unavailable/, 'the copy says to retry, not that the trial is over');
    const st = await mcpTrial.status('1.2.3.4');
    assert.equal(st.started, false, 'status also survives an unreachable store');
});