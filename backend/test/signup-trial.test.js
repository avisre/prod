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

// --- Production-readiness regressions (2026-11-18 review) -------------------
// These lift the real functions out of app.js and run them, so they fail on
// the behaviour, not on wording.
const APP_SOURCE = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
function fnSource(name) {
    const start = APP_SOURCE.search(new RegExp(`(?:async )?function ${name}\\(`));
    assert.ok(start >= 0, `${name} not found in app.js`);
    // The body opens at the first ") {" line end; default params can hold braces.
    let i = APP_SOURCE.indexOf(') {\n', start) + 2;
    let depth = 0;
    for (; i < APP_SOURCE.length; i++) {
        if (APP_SOURCE[i] === '{') depth++;
        else if (APP_SOURCE[i] === '}' && --depth === 0) return APP_SOURCE.slice(start, i + 1);
    }
    throw new Error(`unbalanced ${name}`);
}
function routeSource(method, route) {
    const start = APP_SOURCE.indexOf(`app.${method}('${route}'`);
    assert.ok(start >= 0, `${method.toUpperCase()} ${route} not found`);
    const end = APP_SOURCE.indexOf('\n});', start);
    return APP_SOURCE.slice(start, end);
}

function productGate({ wallPaidOnly, trialEnabled, trialActive = false }) {
    // eslint-disable-next-line no-new-func
    return new Function('WALL_PAID_ONLY', 'SIGNUP_TRIAL', 'signupTrial', 'FREE_PLAN_ID',
        `${fnSource('subscriptionIsPaid')}\n${fnSource('subscriptionIsActive')}\n${fnSource('subscriptionGrantsProductAccess')}\nreturn subscriptionGrantsProductAccess;`)(
        wallPaidOnly, { enabled: trialEnabled }, { active: () => trialActive }, 'free');
}

test('an active FREE plan (connector signup, legacy free row) never opens the product', () => {
    const gate = productGate({ wallPaidOnly: true, trialEnabled: true });
    assert.equal(gate({}, { planId: 'free', status: 'active' }), false, 'POST /oauth/signup must not be a free side door');
    assert.equal(gate({}, { planId: 'monthly', status: 'trialing' }), false, 'a manual comp is not a payment');
    assert.equal(gate({}, { planId: 'monthly', status: 'cancelled' }), false, 'an expired trial is refused');
    assert.equal(gate({}, { planId: 'monthly', status: 'active' }), true);
    assert.equal(gate({}, { planId: 'pro-annual', status: 'cancel_at_period_end' }), true);
    // Trial on without WALL_PAID_ONLY is still paid-only for free rows.
    assert.equal(productGate({ wallPaidOnly: false, trialEnabled: true })({}, { planId: 'free', status: 'active' }), false);
    // A live signup trial opens it.
    assert.equal(productGate({ wallPaidOnly: true, trialEnabled: true, trialActive: true })({}, { planId: 'monthly', status: 'trialing' }), true);
    // Full rollback (both switches off) keeps the old open rule.
    assert.equal(productGate({ wallPaidOnly: false, trialEnabled: false })({}, { planId: 'free', status: 'active' }), true);
});

test('streamed Ask quota does not read a variable declared later in the handler (TDZ crash for paid users)', () => {
    const decl = APP_SOURCE.match(/const quotaPayload = \(([^)]*)\) => \{[\s\S]*?\n {8}\};/);
    assert.ok(decl, 'quotaPayload declaration');
    assert.equal(decl[1], 'usedNow', 'the answer count is passed in');
    assert.doesNotMatch(decl[0], /\bcounted\b/, 'reading `counted` from this closure throws in the streaming branch');
    const calls = APP_SOURCE.match(/quotaPayload\([^)]*\)/g).filter((c) => !c.startsWith('quotaPayload(usedNow)'));
    assert.deepEqual(calls, [], 'every call passes usedNow');
    // Reproduce the original failure shape so this test documents why.
    const broken = () => { const q = () => counted; if (true) return q(); const counted = 1; }; // eslint-disable-line no-constant-condition
    assert.throws(broken, ReferenceError);
});

test('Google sign-in onto an unverified email/password row drops the squatter password and sessions', async () => {
    const saved = [];
    const makeUser = (fields) => ({
        _id: 'u-squat', authVersion: 0, ...fields,
        async save() { saved.push({ ...this }); }, markModified() {}
    });
    const squatted = makeUser({
        email: 'victim@example.com', password: 'bcrypt-of-attacker-password',
        signupTrialAt: new Date(), emailVerifyToken: 'hash', emailVerifiedAt: null,
        subscription: { planId: 'monthly', status: 'trialing' }
    });
    const User = {
        async findOne(q) { return q.$or ? squatted : null; }
    };
    const identityVerifiedSrc = fnSource('identityVerified');
    // eslint-disable-next-line no-new-func
    const findOrCreate = new Function('User', 'createHttpError', 'ensureSubscriptionShape', 'recordCustomerLifecycleEvent', 'sendNewUserEmails',
        `${identityVerifiedSrc}\n${fnSource('findOrCreateSocialUser')}\nreturn findOrCreateSocialUser;`)(
        User, (s, m) => Object.assign(new Error(m), { status: s }), (u) => u.subscription,
        async () => {}, async () => {});
    const { user, created } = await findOrCreate({ provider: 'google', providerUserId: 'g-123', email: 'victim@example.com', name: 'Victim' });
    assert.equal(created, false);
    assert.equal(user.password, null, 'the password someone else chose no longer works');
    assert.equal(user.authVersion, 1, 'tokens issued to the squatter are revoked');
    assert.equal(user.emailVerifyToken, null);
    assert.ok(user.emailVerifiedAt, 'Google has verified the address');
    assert.equal(user.googleId, 'g-123');

    // A verified row keeps its password: linking Google is not a reset.
    saved.length = 0;
    const owner = makeUser({ email: 'own@example.com', password: 'keep', emailVerifiedAt: new Date(), subscription: { planId: 'monthly', status: 'active' } });
    const UserB = { async findOne(q) { return q.$or ? owner : null; } };
    // eslint-disable-next-line no-new-func
    const findOrCreateB = new Function('User', 'createHttpError', 'ensureSubscriptionShape', 'recordCustomerLifecycleEvent', 'sendNewUserEmails',
        `${identityVerifiedSrc}\n${fnSource('findOrCreateSocialUser')}\nreturn findOrCreateSocialUser;`)(
        UserB, () => new Error('x'), (u) => u.subscription, async () => {}, async () => {});
    const linked = await findOrCreateB({ provider: 'google', providerUserId: 'g-9', email: 'own@example.com' });
    assert.equal(linked.user.password, 'keep');
    assert.equal(linked.user.authVersion, 0);
});

test('opening the inbox link does not spend it; only the confirm POST verifies', () => {
    const get = routeSource('get', '/api/email/verify');
    assert.doesNotMatch(get, /findOne|save\(|emailVerifiedAt|setAuthCookie/, 'a mail scanner fetching the link must change nothing');
    assert.match(get, /<form method="post" action="\/api\/email\/verify">/);
    const post = routeSource('post', '/api/email/verify');
    assert.match(post, /express\.urlencoded/);
    assert.match(post, /emailVerifyToken: emailVerifyHash\(raw\)/);
    assert.match(post, /user\.emailVerifiedAt = user\.emailVerifiedAt \|\| new Date\(\)/);
    assert.match(post, /setAuthCookie\(res, createUserToken\(user\), req\)/);
});

test('a completed password reset also counts as inbox proof', () => {
    const reset = routeSource('post', '/api/password/reset');
    assert.match(reset, /if \(!user\.emailVerifiedAt\) \{\s*user\.emailVerifiedAt = new Date\(\);/);
});
