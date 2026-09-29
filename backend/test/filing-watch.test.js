'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const filing = require('../filing-watch');
let mongo;
before(async () => {
    process.env.FILING_WATCH_ENABLED = 'true';
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri('filing_watch_test'));
});
after(async () => { await mongoose.disconnect(); if (mongo) await mongo.stop(); delete process.env.FILING_WATCH_ENABLED; });

test('simultaneous invitations cannot allocate a sixth seat', async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => filing.issue(`buyer${i}@example.com`)));
    assert.equal(attempts.filter(x => x.status === 'fulfilled').length, 5);
    assert.equal(await filing.model().countDocuments({ state: 'invited' }), 5);
    for (const result of attempts.filter(x => x.status === 'rejected')) assert.equal(result.reason.code, 'PILOT_FULL');
    const invite = attempts.find(x => x.status === 'fulfilled').value;
    const seat = await filing.model().findById(invite.seat);
    await assert.rejects(filing.reserve(invite.token, 'someone-else@example.com'), { code: 'INVITE_UNAVAILABLE' });
    const claims = await Promise.allSettled([filing.reserve(invite.token, seat.email), filing.reserve(invite.token, seat.email)]);
    assert.equal(claims.filter(x => x.status === 'fulfilled').length, 1);
    const reserved = claims.find(x => x.status === 'fulfilled').value;
    const pending = { _id: new mongoose.Types.ObjectId() };
    await filing.bindPending(reserved, pending);
    const checkouts = await Promise.allSettled([filing.beginCheckout(pending), filing.beginCheckout(pending)]);
    assert.equal(checkouts.filter(x => x.status === 'fulfilled').length, 1, 'only one payment session per seat');
    await filing.recordSession(reserved, { id: 'cs_test_filing' });
    const user = { _id: new mongoose.Types.ObjectId(), subscription: { planId: filing.PLAN_ID, status: 'active' } };
    await filing.linkUser(pending._id, user._id);
    await assert.rejects(filing.submitTickers(user, ['AAPL', 'MSFT', 'MISSING'], t => t !== 'MISSING'), { code: 'TICKER_UNSUPPORTED' });
    await assert.rejects(filing.submitTickers({ ...user, subscription: { planId: 'monthly', status: 'active' } }, ['AAPL','MSFT','FORM'], () => true), { code: 'SUBSCRIPTION_REQUIRED' });
    const saved = await filing.submitTickers(user, ['aapl','MSFT','FORM'], () => true);
    assert.deepEqual([...saved.tickers], ['AAPL','MSFT','FORM']);
    assert.equal(saved.baselineDueAt - saved.tickersSubmittedAt, 48 * 3600000);
    await assert.rejects(filing.submitTickers(user, ['AAPL','MSFT','FORM'], () => true), { code: 'TICKERS_ALREADY_SAVED' });
    assert.equal(await filing.model().countDocuments(), 5);
});
test('duplicate email invitation races cannot consume multiple seats', async () => {
    await filing.model().deleteMany({});
    const results = await Promise.allSettled([filing.issue('same@example.com'), filing.issue('same@example.com')]);
    assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
    assert.equal(await filing.model().countDocuments({ email: 'same@example.com' }), 1);
});
test('only paid, active service customers can receive fulfilment', () => {
    for (const status of ['pending','trialing','cancelled','past_due','unpaid']) assert.equal(filing.active({ subscription: { planId: filing.PLAN_ID, status } }), false);
    for (const status of ['active','cancel_at_period_end']) assert.equal(filing.active({ subscription: { planId: filing.PLAN_ID, status } }), true);
    assert.throws(() => filing.normalizeTickers(['AAPL','aapl','MSFT']), { code: 'TICKERS_INVALID' });
    assert.throws(() => filing.normalizeTickers(['AAPL']), { code: 'THREE_TICKERS_REQUIRED' });
});
test('disabled pilot refuses invitations and payment reservations', async () => {
    delete process.env.FILING_WATCH_ENABLED;
    await assert.rejects(filing.issue('new@example.com'), { code: 'PILOT_NOT_OPEN' });
    await assert.rejects(filing.reserve('a'.repeat(64), 'new@example.com'), { code: 'PILOT_NOT_OPEN' });
    process.env.FILING_WATCH_ENABLED = 'true';
});
