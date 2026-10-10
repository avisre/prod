'use strict';

// Account notices inside a connector result (owner decision 2026-10-09): a
// customer who only ever uses the connector is told there, by the assistant,
// that credits arrived or that the wallet is nearly spent. Both are derived
// from the ledger on each call, so they reach every account the same way.

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const notices = require('../connector-notices');

const RESET = '2026-11-01T00:00:00.000Z';
const gate = (used, allowance, cost = 2) => ({ ok: true, used, allowance, cost, remaining: allowance - used, resetsAt: RESET });

test('the low notice starts at 80% of the wallet and returns for the last few credits', () => {
    // A 100-credit month, 2 credits a lookup: silent to 78 used, then every call.
    assert.equal(notices.isLow(gate(76, 100)), false, '78 used after the call is under 80%');
    assert.equal(notices.isLow(gate(78, 100)), true, 'the call that reaches 80%');
    for (let used = 80; used <= 98; used += 2) assert.equal(notices.isLow(gate(used, 100)), true, `still said at ${used} used`);

    // A 600-credit wallet: said around the 480 mark, quiet through the middle,
    // said again for the last 10 credits. A large wallet is not nagged on
    // every one of its last 60 lookups.
    assert.equal(notices.isLow(gate(476, 600)), false);
    assert.equal(notices.isLow(gate(478, 600)), true);
    assert.equal(notices.isLow(gate(488, 600)), true, 'a burst that stepped over the exact crossing still hears it');
    assert.equal(notices.isLow(gate(490, 600)), false);
    assert.equal(notices.isLow(gate(560, 600)), false);
    assert.equal(notices.isLow(gate(588, 600)), true, '10 left after this call');

    // One 42-credit AI answer can jump the threshold in a single call.
    assert.equal(notices.isLow(gate(50, 100, 42)), true);
    // No wallet, or a free call, says nothing.
    assert.equal(notices.isLow(gate(0, 0)), false);
    assert.equal(notices.isLow(gate(90, 100, 0)), false);
    assert.equal(notices.isLow(null), false);
});

test('the low notice states what is left, what it buys, when it returns and where to refill', () => {
    const text = notices.lowBalanceText(gate(78, 100), { lookupCost: 2, askCost: 42 });
    assert.match(text, /20 of 100 left this month/);
    assert.match(text, /about 10 more data lookups \(an AI answer costs 42\)/);
    // How many lookups are left comes from the real charge; the notice quotes no per-lookup price.
    assert.doesNotMatch(text, /credits? each/);
    assert.match(text, /returns on 1 November 2026/);
    assert.ok(text.includes(notices.RECHARGE_URL));
    assert.doesNotMatch(text, /\$/, 'a notice states the account, it does not quote prices');

    assert.match(notices.lowBalanceText(gate(96, 100), { lookupCost: 2 }), /about 1 more data lookup \(/);
    assert.match(notices.lowBalanceText(gate(98, 100), { lookupCost: 2 }), /0 of 100 left this month, not enough for another data lookup/);
    assert.equal(notices.lowBalanceText(gate(10, 100)), null);
});

test('the ChatGPT app copy names no credits, prices, plans or links', () => {
    const low = notices.lowBalanceText(gate(78, 100), { neutral: true, lookupCost: 2 });
    const added = notices.creditsAddedText({ credits: 500, at: new Date('2026-10-08T14:59:00Z') }, gate(100, 600), { neutral: true });
    for (const text of [low, added]) {
        assert.doesNotMatch(text, /\$|https?:|\/recharge|\/upgrade|credit|plan|subscribe|buy|refill|top.?up/i);
    }
    assert.match(low, /about 10 more lookups remain/);
    assert.match(low, /resets on 1 November 2026/);
    assert.match(added, /was increased on 8 October 2026/);
});

test('credits added are stated with the date and the balance after the call', () => {
    const text = notices.creditsAddedText({ credits: 500, at: new Date('2026-10-08T14:59:00Z') }, gate(104, 600));
    assert.equal(text, '500 credits were added to this StockPortfolio.pro account on 8 October 2026. After this call it has 494 credits available. Tell the user.');
    assert.match(notices.creditsAddedText({ credits: 1, at: null }, gate(0, 21)), /^1 credit was added to this StockPortfolio\.pro account\. After this call it has 19 credits available\./);
    assert.equal(notices.creditsAddedText({ credits: 0 }, gate(0, 100)), null);
    assert.equal(notices.creditsAddedText(null, gate(0, 100)), null);
});

test('a notice goes first in the result and never replaces a field or a non-object result', () => {
    const out = notices.attach({ company: 'AAPL', metrics: [] }, { account_notice: 'x', credits: { remaining: 1 } });
    assert.deepEqual(Object.keys(out), ['account_notice', 'credits', 'company', 'metrics']);
    // A tool that already returns a field of the same name keeps its own.
    assert.equal(notices.attach({ account_notice: 'tool' }, { account_notice: 'ours' }).account_notice, 'tool');
    const same = { a: 1 };
    assert.equal(notices.attach(same, null), same);
    assert.deepEqual(notices.attach([1], { account_notice: 'x' }), [1]);
    assert.equal(notices.attach('text', { account_notice: 'x' }), 'text');
});

test('begin never rejects, whatever the wiring does', async () => {
    assert.equal(await notices.begin({}, gate(0, 100)), null, 'a keyless caller has no notice wiring');
    assert.equal(await notices.begin(null, gate(0, 100)), null);
    assert.equal(await notices.begin({ accountNotice: () => { throw new Error('boom'); } }, gate(0, 100)), null);
    assert.equal(await notices.begin({ accountNotice: async () => { throw new Error('boom'); } }, gate(0, 100)), null);
    assert.deepEqual(await notices.begin({ accountNotice: () => ({ account_notice: 'x' }) }, gate(0, 100)), { account_notice: 'x' });
});

test('credits added are read from the ledger since the last connector call', { timeout: 60000 }, async (t) => {
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await mem.stop(); });
    const ledger = mongoose.connection.collection('credit_ledger');
    const now = new Date('2026-10-09T02:00:00Z');
    const at = (iso) => new Date(iso);
    const row = (userId, delta, reason, iso) => ({ userId, month: iso.slice(0, 7), delta, reason, refId: null, at: at(iso) });

    await ledger.insertMany([
        // The customer this was built for: last call 13:24, credits added 14:59.
        row('todd', -2, 'mcp:get_company_fundamentals', '2026-10-08T13:24:51Z'),
        row('todd', 500, 'comp', '2026-10-08T14:59:00Z'),
        // Already seen: the credits arrived BEFORE the last connector call.
        row('seen', 150, 'topup', '2026-10-08T10:00:00Z'),
        row('seen', -2, 'mcp-apps:get_company_financials', '2026-10-08T11:00:00Z'),
        // A website Ask after the refill is not a connector call, so the
        // refill has still not been announced in the connector.
        row('web', -2, 'mcp:search_filings', '2026-10-07T09:00:00Z'),
        row('web', 150, 'topup', '2026-10-08T10:00:00Z'),
        row('web', 100, 'topup', '2026-10-08T12:00:00Z'),
        row('web', -2, 'ask', '2026-10-08T13:00:00Z'),
        // Never used the connector: only the last 30 days count.
        row('new', 150, 'topup', '2026-08-01T10:00:00Z'),
        row('new', 50, 'topup', '2026-10-01T10:00:00Z')
    ]);

    assert.deepEqual(await notices.creditsAddedSinceLastCall(ledger, 'todd', now), { credits: 500, at: at('2026-10-08T14:59:00Z') });
    assert.equal(await notices.creditsAddedSinceLastCall(ledger, 'seen', now), null);
    assert.deepEqual(await notices.creditsAddedSinceLastCall(ledger, 'web', now), { credits: 250, at: at('2026-10-08T12:00:00Z') });
    assert.deepEqual(await notices.creditsAddedSinceLastCall(ledger, 'new', now), { credits: 50, at: at('2026-10-01T10:00:00Z') });
    assert.equal(await notices.creditsAddedSinceLastCall(ledger, 'nobody', now), null);

    // Both notices in one result, the arrival first.
    const both = await notices.forCall({ ledger, userId: 'todd', gate: gate(588, 600), facts: { lookupCost: 2, askCost: 42 }, now });
    assert.match(both.account_notice, /^500 credits were added .* StockPortfolio\.pro credits are running low: 10 of 600 left/);
    assert.deepEqual(both.credits, { used: 590, allowance: 600, remaining: 10, resets_at: RESET });
    const neutral = await notices.forCall({ ledger, userId: 'todd', gate: gate(104, 600), neutral: true, now });
    assert.deepEqual(Object.keys(neutral), ['account_notice'], 'the neutral form carries no credit figures');
    assert.equal(await notices.forCall({ ledger, userId: 'seen', gate: gate(10, 600), now }), null);

    // A ledger that cannot be read costs the notice, never the call.
    const broken = { find: () => { throw new Error('down'); } };
    assert.equal(await notices.creditsAddedSinceLastCall(broken, 'todd', now), null);
    assert.equal((await notices.forCall({ ledger: broken, userId: 'todd', gate: gate(78, 100), now })).account_notice.startsWith('StockPortfolio.pro credits are running low'), true);
    assert.equal(await notices.forCall({}), null);
});
