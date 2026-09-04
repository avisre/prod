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

    // recentActivity(): newest-first, scoped to this user+month, capped at
    // `limit`. Excludes the stale 2020-01 row just inserted above and the
    // 'user-2'/'user-poor' rows from other users.
    const recent = await credits.recentActivity(user, 8);
    assert.equal(recent.length, 3, 'the 3 spends for this user this month, not the stale/other-user rows');
    assert.deepEqual(recent.map((r) => r.reason), ['dossier', 'dossier', 'ask'], 'newest first');
    assert.deepEqual(recent.map((r) => r.refId), ['AAPL:deep', 'AAPL:standard', 'q1']);
    assert.deepEqual(recent.map((r) => r.delta), [-30, -10, -2]);
    assert.ok(recent.every((r) => r.at instanceof Date), 'each row carries its own timestamp');

    const capped = await credits.recentActivity(user, 2);
    assert.equal(capped.length, 2, 'limit is respected');

    const empty = await credits.recentActivity('user-nobody', 8);
    assert.deepEqual(empty, [], 'a user with no ledger rows gets an empty list, not an error');

    // Monitor cost, on a fresh user so it doesn't disturb the exact
    // recentActivity ordering/count asserted above for `user`.
    const monUser = 'user-monitor';
    await credits.spend(monUser, 'monitor', 'monitor', 'NVDA');
    const monBal = await credits.balance(monUser, 300);
    assert.equal(monBal.used, 5, 'a Monitor report costs 5');
    const monRecent = await credits.recentActivity(monUser);
    assert.equal(monRecent.length, 1);
    assert.equal(monRecent[0].reason, 'monitor');
    assert.equal(monRecent[0].refId, 'NVDA');
});

test('allowance() gives Power/Desk a real ceiling instead of inheriting Pro\'s ×2', () => {
    // Power/Desk collapse to the same 'pro' *gate* tier (userTier() in
    // app.js), so effectiveAskLimit alone can't tell them apart — the floor
    // must be keyed on the uncollapsed planId.
    assert.equal(credits.allowance(300, 'power'), 2000, 'Power floor wins over 300×2=600');
    assert.equal(credits.allowance(300, 'power-monthly'), 2000);
    assert.equal(credits.allowance(300, 'desk'), 10000);

    // A plan with a genuinely larger Ask limit than the floor keeps its own
    // ×2 — the floor is a minimum, never a cap that shrinks anyone.
    assert.equal(credits.allowance(6000, 'desk'), 12000, '6000×2=12000 > the 10000 floor');

    // Every other plan (including no planId at all) is untouched: same ×2 as
    // before this change, so no existing user's capacity shrinks.
    assert.equal(credits.allowance(300, 'pro'), 600);
    assert.equal(credits.allowance(300), 600, 'planId omitted entirely');
    assert.equal(credits.allowance(30, 'free'), 60);

    // planId is matched case-insensitively against the exact stored values —
    // never accidentally matches a substring or unrelated plan.
    assert.equal(credits.allowance(300, 'POWER'), 2000);
    assert.equal(credits.allowance(300, 'power-annual'), 600, 'not a recognized Power planId — falls through to ×2');
});

test('LTD tiers get an explicit wallet, and the relist never shrinks an existing buyer', () => {
    // The listing advertises these literals. Before, the wallet was derived as
    // askLimit×2, so the marketplace page and the code were two sources of
    // truth that could drift apart. These ARE the advertised numbers.
    assert.equal(credits.allowance(30, null, 1), 100, 'Tier 1');
    assert.equal(credits.allowance(100, null, 2), 300, 'Tier 2');
    assert.equal(credits.allowance(300, null, 3), 800, 'Tier 3');

    // Load-bearing: every tier is strictly ABOVE the old derived allowance
    // (60/200/600). Widening a lifetime entitlement needs no grandfather clause
    // and no AppSumo downgrade approval; narrowing one needs both. If a future
    // edit drops any of these below the old ×2, that is a downgrade shipped to
    // people who already paid, and this assertion is the thing that catches it.
    for (const [askCap, tier] of [[30, 1], [100, 2], [300, 3]]) {
        assert.ok(
            credits.allowance(askCap, null, tier) > askCap * 2,
            `tier ${tier} must not shrink below the pre-relist ${askCap * 2}`
        );
    }

    // An unknown but truthy tier resolves UP to Tier 3, matching
    // appsumoTierConfig() and monitorCapFor(): a paying customer is never
    // under-served because of a data gap.
    assert.equal(credits.allowance(300, null, 9), 800, 'unknown tier resolves up');

    // 0/null/undefined mean "not a lifetime buyer" — these must fall through to
    // the derived allowance, not be read as a zero grant that locks everyone out.
    assert.equal(credits.allowance(50, null, 0), 100, 'tier 0 is not an LTD buyer');
    assert.equal(credits.allowance(50, null, null), 100);
    assert.equal(credits.allowance(50), 100, 'tier omitted entirely');
    assert.equal(credits.allowance(300, 'pro-annual', null), 600, 'plain subscriber untouched');

    // A plan floor still wins when it is larger: an LTD holder who also runs a
    // Desk subscription keeps the Desk ceiling rather than being cut to 100.
    assert.equal(credits.allowance(30, 'desk', 1), 10000, 'Desk floor beats the Tier 1 wallet');
    assert.equal(credits.allowance(30, 'pro', 1), 100, 'a non-floor plan does not reduce it');
});

test('resetsAt() is the 1st of next UTC month, including a December -> January rollover', (t) => {
    const RealDate = Date;
    function mockDate(iso) {
        class MockDate extends RealDate {
            constructor(...args) { return args.length ? new RealDate(...args) : new RealDate(iso); }
            static now() { return new RealDate(iso).getTime(); }
        }
        global.Date = MockDate;
    }
    t.after(() => { global.Date = RealDate; });

    mockDate('2026-08-29T12:00:00Z');
    assert.equal(credits.resetsAt(), '2026-09-01T00:00:00.000Z');

    mockDate('2026-12-15T23:59:00Z');
    assert.equal(credits.resetsAt(), '2027-01-01T00:00:00.000Z', 'December rolls into next year, not month 13');
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

test('recentActivity() never throws, even with a broken connection', { timeout: 10000 }, async () => {
    const result = await credits.recentActivity('user-x', 8).catch(() => 'THREW');
    assert.notEqual(result, 'THREW');
    assert.deepEqual(result, []);
});

test('purchased top-ups raise the current month only, and a webhook retry never double-grants', { timeout: 60000 }, async (t) => {
    const server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await server.stop(); });

    const user = 'user-topup';

    const fresh = await credits.balance(user, 300);        // Pro: 600 base
    assert.equal(fresh.allowance, 600, 'no grants yet — plain plan allowance');

    // First webhook delivery: exactly one +150 row, allowance +150, and the
    // grant is visible in the same month key the spend rows use.
    const first = await credits.grant(user, 150, 'topup', 'cs_test_1');
    assert.equal(first, true, 'first delivery inserts the grant');
    const granted = await credits.balance(user, 300);
    assert.equal(granted.allowance, 750, '600 plan + 150 purchased');
    assert.equal(granted.remaining, 750);

    // Spend against the enlarged wallet to prove both pools draw together.
    await credits.spend(user, 'dossier_standard', 'dossier', 'AAPL:standard'); // -10
    const afterSpend = await credits.balance(user, 300);
    assert.equal(afterSpend.used, 10);
    assert.equal(afterSpend.remaining, 740);

    // Stripe redelivers checkout.session.completed on ack failure: the same
    // refId must be refused, not inserted twice.
    const retry = await credits.grant(user, 150, 'topup', 'cs_test_1');
    assert.equal(retry, false, 'redelivery of the same Stripe session is idempotent');
    const afterRetry = await credits.balance(user, 300);
    assert.equal(afterRetry.allowance, 750, 'balance unchanged by the retry');
    assert.equal(afterRetry.remaining, 740);

    // A genuinely new session (a second purchase later in the month) stacks.
    await credits.grant(user, 150, 'topup', 'cs_test_2');
    const twoFills = await credits.balance(user, 300);
    assert.equal(twoFills.allowance, 900, '600 + 150 + 150');

    // Guard rails: a malformed grant is a no-op, never a crash or a wrong row.
    assert.equal(await credits.grant(user, 0, 'topup', 'cs_test_3'), false);
    assert.equal(await credits.grant(user, -5, 'topup', 'cs_test_4'), false);
    assert.equal(await credits.grant(user, 'NaN', 'topup', 'cs_test_5'), false);
    const guarded = await credits.balance(user, 300);
    assert.equal(guarded.allowance, 900, 'rejected grants changed nothing');
});
