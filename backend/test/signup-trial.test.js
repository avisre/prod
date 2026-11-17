'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { Mongoose } = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const trial = require('../trial');

const HOUR = 60 * 60 * 1000;
const plainUser = (overrides = {}) => ({
    _id: 'u1',
    email: 'ada@example.com',
    signupTrialAt: null,
    trialAiUsed: 0,
    trialAiLimit: 5,
    subscription: { planId: 'monthly', planName: 'Monthly', price: 79.99, currency: 'USD', billingInterval: 'month', status: 'pending', trialEndsAt: null },
    markModified() {},
    ...overrides
});

test('trial defaults are one 72-hour window and five standard AI questions', () => {
    const cfg = trial.config({});
    assert.equal(cfg.enabled, true);
    assert.equal(cfg.hours, 72);
    assert.equal(cfg.aiQuestions, 5);
    assert.equal(trial.config({ TRIAL_ENABLED: 'false' }).enabled, false);
    assert.equal(trial.config({ TRIAL_HOURS: '24', TRIAL_AI_QUESTIONS: '2' }).hours, 24);
    assert.equal(trial.config({ TRIAL_HOURS: '24', TRIAL_AI_QUESTIONS: '2' }).aiQuestions, 2);
});

test('grant starts exactly one 72-hour clock and never restarts it', () => {
    const user = plainUser();
    const start = new Date('2026-11-18T10:00:00Z');
    assert.equal(trial.grant(user, { planId: 'monthly', planName: 'Monthly', price: 79.99, currency: 'USD', billingInterval: 'month' }, start), true);
    assert.equal(user.signupTrialAt.toISOString(), start.toISOString());
    assert.equal(user.subscription.trialEndsAt.toISOString(), new Date(start.getTime() + 72 * HOUR).toISOString());
    assert.equal(user.subscription.status, 'trialing');
    assert.equal(user.subscription.stripePriceId, null);
    assert.equal(user.trialAiUsed, 0);
    assert.equal(user.trialAiLimit, 5);

    const later = new Date(start.getTime() + 10 * HOUR);
    assert.equal(trial.grant(user, { planId: 'annual', planName: 'Annual', price: 649.99 }, later), false, 'a second login method cannot reset the trial');
    assert.equal(user.subscription.trialEndsAt.toISOString(), new Date(start.getTime() + 72 * HOUR).toISOString());
    assert.equal(user.subscription.planId, 'monthly');
});

test('status reports active, expiry, remaining hours and the five-question allowance', () => {
    const start = new Date('2026-11-18T10:00:00Z');
    const user = plainUser();
    trial.grant(user, { planId: 'monthly', planName: 'Monthly', price: 79.99 }, start);
    user.trialAiUsed = 3;

    const live = trial.status(user, start.getTime() + HOUR);
    assert.equal(live.active, true);
    assert.equal(live.used, 3);
    assert.equal(live.limit, 5);
    assert.equal(live.remaining, 2);
    assert.equal(live.hoursLeft, 71);

    const ended = trial.status(user, start.getTime() + 73 * HOUR);
    assert.equal(ended.active, false);
    assert.equal(ended.expired, true);
    assert.equal(ended.remaining, 2, 'the meter is preserved, not reset, after expiry');

    // A paid subscription is not a signup trial even if the old clock is in
    // the future: the status is gated on the trialing state.
    user.subscription.status = 'active';
    assert.equal(trial.status(user, start.getTime() + HOUR).active, false);
});

test('reserveQuestion is atomic, refuses the sixth, and refunds a failed answer only', { timeout: 120000 }, async (t) => {
    const server = await MongoMemoryServer.create();
    const db = new Mongoose();
    await db.connect(server.getUri());
    t.after(async () => { await db.disconnect().catch(() => {}); await server.stop(); });

    const schema = new db.Schema({
        email: String,
        signupTrialAt: Date,
        trialAiUsed: { type: Number, default: 0 },
        trialAiLimit: { type: Number, default: 5 },
        trialActivatedAt: { type: Date, default: null },
        subscription: { planId: String, status: String, trialEndsAt: Date }
    });
    const User = db.model('TrialUser', schema);
    const start = new Date();
    const user = await User.create({
        email: 'trial@example.com',
        signupTrialAt: start,
        subscription: { planId: 'monthly', status: 'trialing', trialEndsAt: new Date(start.getTime() + 72 * HOUR) }
    });

    const results = await Promise.all(Array.from({ length: 8 }, () => trial.reserveQuestion(User, user._id)));
    assert.equal(results.filter((r) => r.ok).length, 5, 'five concurrent reservations succeed');
    assert.equal(results.filter((r) => !r.ok).length, 3, 'the rest get the limit, never a sixth answer');

    await trial.refundQuestion(User, user._id);
    const fifthAgain = await trial.reserveQuestion(User, user._id);
    assert.equal(fifthAgain.ok, true, 'a failed question gives its slot back');
    assert.equal(fifthAgain.status.used, 5);

    const sixth = await trial.reserveQuestion(User, user._id);
    assert.equal(sixth.ok, false);
    assert.equal(sixth.status.remaining, 0);

    assert.equal(await trial.markActivated(User, user._id, new Date()), true);
    assert.equal(await trial.markActivated(User, user._id, new Date()), false, 'activation is recorded once');
});

test('the app wires identity proof, the trial gate and the paid-only exclusions', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.match(source, /const SIGNUP_TRIAL = signupTrial\.config\(\);/);
    assert.match(source, /function identityVerified\(user\)/);
    assert.match(source, /code: 'EMAIL_VERIFICATION_REQUIRED'/);
    assert.match(source, /if \(signupTrial\.active\(user\)\) return 'core';/);
    assert.match(source, /if \(signupTrial\.active\(user\)\) return true;/);
    assert.match(source, /signupTrial\.reserveQuestion\(User, userId\)/);
    assert.match(source, /code: 'TRIAL_AI_LIMIT'/);
    assert.match(source, /code: 'TRIAL_STANDARD_ONLY'/);
    // API/MCP and Monitor stay paid features, never trial features.
    assert.match(source, /const PAID_ACTIVE_STATUSES = \['active', 'cancel_at_period_end'\];/);
    assert.match(source, /function hasApiAccess[\s\S]{0,400}PAID_ACTIVE_STATUSES\.includes\(sub\.status\)/);
    assert.match(source, /function hasMonitor[\s\S]{0,400}PAID_ACTIVE_STATUSES\.includes\(sub\.status\)/);
});
