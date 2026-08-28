'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const credits = require('../credits');

// Real Mongo (in-memory), not a hand-rolled fake: the aggregation pipeline in
// credits.js is exactly the part a fake $match/$group would risk getting
// subtly wrong, so it's worth the real engine here.
test('credit ledger: allowance, spend, balance, and month isolation', { timeout: 60000 }, async (t) => {
    const server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await server.stop(); });

    const user = 'user-1';

    // allowance is 2x the caller's existing Ask limit, not a separate table —
    // preserves exactly the Ask capacity already sold.
    assert.equal(credits.allowance(300), 600, 'Pro (300 Ask) -> 600 credits');
    assert.equal(credits.allowance(30), 60, 'AppSumo Starter (30 Ask) -> 60 credits');
    assert.equal(credits.allowance(0), 0);
    assert.equal(credits.allowance(-5), 0, 'never negative');

    let bal = await credits.balance(user, 300);
    assert.equal(bal.used, 0);
    assert.equal(bal.allowance, 600);
    assert.equal(bal.remaining, 600);

    await credits.spend(user, 'ask', 'ask', 'q1');
    bal = await credits.balance(user, 300);
    assert.equal(bal.used, 2, 'ask costs 2');
    assert.equal(bal.remaining, 598);

    await credits.spend(user, 'dossier_standard', 'dossier', 'AAPL:standard');
    bal = await credits.balance(user, 300);
    assert.equal(bal.used, 12, '2 (ask) + 10 (standard dossier)');

    await credits.spend(user, 'dossier_deep', 'dossier', 'AAPL:deep');
    bal = await credits.balance(user, 300);
    assert.equal(bal.used, 42, '2 + 10 + 30');
    assert.equal(bal.remaining, 558);

    // check() reads without spending
    const before = await credits.balance(user, 300);
    const gate = await credits.check(user, 'dossier_deep', 300);
    assert.equal(gate.ok, true);
    assert.equal(gate.cost, 30);
    const after = await credits.balance(user, 300);
    assert.equal(before.used, after.used, 'check() must not itself spend');

    // insufficient balance is reported, not silently allowed
    const poor = await credits.check('user-poor', 'dossier_deep', 3); // allowance 6
    assert.equal(poor.ok, false);
    assert.equal(poor.remaining, 6);

    // a different user's ledger is untouched
    const other = await credits.balance('user-2', 300);
    assert.equal(other.used, 0, 'ledger is per-user');

    // month isolation: an entry logged under a different month must not count
    // toward the current month's balance
    await mongoose.connection.collection('credit_ledger').insertOne({
        userId: user, month: '2020-01', delta: -999, reason: 'ask', at: new Date()
    });
    bal = await credits.balance(user, 300);
    assert.equal(bal.used, 42, 'a stale month must not bleed into the current balance');
});

test('spend() never throws, even with a broken connection', { timeout: 10000 }, async () => {
    // No mongoose connection established in this test (runs after test 1's
    // t.after disconnects it) — the raw driver collection call should reject
    // promptly rather than mongoose's Model-level buffering hanging it. The
    // explicit timeout turns a wrong assumption there into a clear failure
    // instead of a hung suite.
    await assert.doesNotReject(credits.spend('user-x', 'ask', 'ask'));
});

test('a zero or unknown cost key is a no-op, not a crash', async () => {
    await assert.doesNotReject(credits.spend('user-x', 'not_a_real_key', 'ask'));
});
