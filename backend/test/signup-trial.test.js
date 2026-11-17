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
        signupTrialAt: new Date(), emailVerifyToken: 'hash', emailVerifyCode: 'hmac', emailVerifiedAt: null,
        subscription: { planId: 'monthly', status: 'trialing' }
    });
    const User = {
        async findOne(q) { return q.$or ? squatted : null; }
    };
    const identityVerifiedSrc = fnSource('identityVerified');
    // eslint-disable-next-line no-new-func
    const findOrCreate = new Function('User', 'createHttpError', 'ensureSubscriptionShape', 'recordCustomerLifecycleEvent', 'sendNewUserEmails', 'emailOtp',
        `${identityVerifiedSrc}\n${fnSource('findOrCreateSocialUser')}\nreturn findOrCreateSocialUser;`)(
        User, (s, m) => Object.assign(new Error(m), { status: s }), (u) => u.subscription,
        async () => {}, async () => {}, require('../email-otp'));
    const { user, created } = await findOrCreate({ provider: 'google', providerUserId: 'g-123', email: 'victim@example.com', name: 'Victim' });
    assert.equal(created, false);
    assert.equal(user.password, null, 'the password someone else chose no longer works');
    assert.equal(user.authVersion, 1, 'tokens issued to the squatter are revoked');
    assert.equal(user.emailVerifyToken, null);
    assert.equal(user.emailVerifyCode, null, 'the squatter cannot finish with a code either');
    assert.ok(user.emailVerifiedAt, 'Google has verified the address');
    assert.equal(user.googleId, 'g-123');

    // A verified row keeps its password: linking Google is not a reset.
    saved.length = 0;
    const owner = makeUser({ email: 'own@example.com', password: 'keep', emailVerifiedAt: new Date(), subscription: { planId: 'monthly', status: 'active' } });
    const UserB = { async findOne(q) { return q.$or ? owner : null; } };
    // eslint-disable-next-line no-new-func
    const findOrCreateB = new Function('User', 'createHttpError', 'ensureSubscriptionShape', 'recordCustomerLifecycleEvent', 'sendNewUserEmails', 'emailOtp',
        `${identityVerifiedSrc}\n${fnSource('findOrCreateSocialUser')}\nreturn findOrCreateSocialUser;`)(
        UserB, () => new Error('x'), (u) => u.subscription, async () => {}, async () => {}, require('../email-otp'));
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
    assert.match(post, /await completeEmailVerification\(user, req, res, 'link'\)/);
    const complete = fnSource('completeEmailVerification');
    assert.match(complete, /user\.emailVerifiedAt = user\.emailVerifiedAt \|\| new Date\(\)/);
    assert.match(complete, /user\.emailVerifyToken = null;/);
    assert.match(complete, /emailOtp\.clear\(user\);/, 'the code dies with the link');
    assert.match(complete, /setAuthCookie\(res, createUserToken\(user\), req\)/);
});

// ---- First-time activation by emailed code (owner, 2026-11-18) ----

const emailOtp = require('../email-otp');
const mailer = require('../mailer');
const signupFields = require('../signup-fields');

async function otpDb(t) {
    const server = await MongoMemoryServer.create();
    const db = new Mongoose();
    await db.connect(server.getUri());
    t.after(async () => { await db.disconnect().catch(() => {}); await server.stop(); });
    const User = db.model('OtpUser', new db.Schema({
        email: String,
        emailVerifyExpires: Date,
        emailVerifyCode: { type: String, default: null },
        emailVerifyCodeAttempts: { type: Number, default: 0 }
    }));
    return User;
}

test('email code: stored as a keyed hash, accepts the right code, counts wrong ones, normalises separators', { timeout: 120000 }, async (t) => {
    const User = await otpDb(t);
    const user = new User({ email: 'a@example.com', emailVerifyExpires: new Date(Date.now() + HOUR) });
    const code = emailOtp.issue(user, 'secret-1');
    await user.save();
    assert.match(code, /^\d{6}$/);
    assert.notEqual(user.emailVerifyCode, code);
    assert.notEqual(user.emailVerifyCode, require('crypto').createHash('sha256').update(code).digest('hex'), 'not an offline-reversible bare hash');
    assert.equal(user.emailVerifyCode, emailOtp.codeHash('secret-1', user._id, code));

    const wrong = code === '000000' ? '000001' : '000000';
    let r = await emailOtp.check(User, user._id, wrong, { secret: 'secret-1' });
    assert.deepEqual([r.ok, r.reason, r.attemptsLeft], [false, 'wrong', emailOtp.MAX_ATTEMPTS - 1]);
    r = await emailOtp.check(User, user._id, 'abc', { secret: 'secret-1' });
    assert.equal(r.reason, 'format');
    assert.equal((await User.findById(user._id)).emailVerifyCodeAttempts, 1, 'a malformed entry spends no guess');
    r = await emailOtp.check(User, user._id, code, { secret: 'secret-2' });
    assert.equal(r.ok, false, 'the server secret is part of the hash');
    r = await emailOtp.check(User, user._id, `${code.slice(0, 3)} ${code.slice(3)}`, { secret: 'secret-1' });
    assert.equal(r.ok, true);
    assert.equal(String(r.user._id), String(user._id));
});

test('email code: ten guesses per account in total, a resend does not reset them, and expiry is enforced', { timeout: 120000 }, async (t) => {
    const User = await otpDb(t);
    const user = new User({ email: 'b@example.com', emailVerifyExpires: new Date(Date.now() + HOUR) });
    let code = emailOtp.issue(user, 's');
    await user.save();
    const wrongFor = (c) => (c === '999999' ? '999998' : '999999');
    // Parallel guesses cannot exceed the cap: the $inc is conditional.
    const burst = await Promise.all(Array.from({ length: 6 }, () => emailOtp.check(User, user._id, wrongFor(code), { secret: 's' })));
    assert.ok(burst.every((x) => !x.ok));
    // A resend issues a new code but keeps the count.
    const doc = await User.findById(user._id);
    code = emailOtp.issue(doc, 's');
    await doc.save();
    assert.equal((await User.findById(user._id)).emailVerifyCodeAttempts, 6);
    for (let i = 0; i < 4; i++) await emailOtp.check(User, user._id, wrongFor(code), { secret: 's' });
    const locked = await emailOtp.check(User, user._id, code, { secret: 's' });
    assert.deepEqual([locked.ok, locked.reason], [false, 'locked'], 'even the right code is refused once the guesses are spent');
    assert.match(emailOtp.message(locked), /Open the link/);

    const old = new User({ email: 'c@example.com', emailVerifyExpires: new Date(Date.now() - 1000) });
    const oldCode = emailOtp.issue(old, 's');
    await old.save();
    assert.equal((await emailOtp.check(User, old._id, oldCode, { secret: 's' })).reason, 'expired');
    const none = await new User({ email: 'd@example.com' }).save();
    assert.equal((await emailOtp.check(User, none._id, '123456', { secret: 's' })).reason, 'no_code');
});

test('the verification email carries the code in the subject and body, escaped', () => {
    const withCode = mailer.emailVerificationEmail('Ada <b>', 'https://x/api/email/verify?token=abc', 24, '042917');
    assert.equal(withCode.subject, '042917 is your StockPortfolio.pro verification code');
    assert.match(withCode.html, />042917</);
    assert.match(withCode.text, /Your verification code: 042917/);
    assert.match(withCode.text, /https:\/\/x\/api\/email\/verify\?token=abc/, 'the link stays as a fallback');
    assert.doesNotMatch(withCode.html, /<b>/);
    const linkOnly = mailer.emailVerificationEmail('Ada', 'https://x/v', 24);
    assert.equal(linkOnly.subject, 'Verify your email to start your StockPortfolio.pro trial');
});

test('throwaway inboxes cannot sign up, on the website or the connector screen', () => {
    assert.equal(signupFields.isDisposableEmail('Someone@Mailinator.com'), true);
    assert.equal(signupFields.isDisposableEmail('someone@gmail.com'), false);
    const err = signupFields.signupFieldError({ email: 'x@yopmail.com', password: 'Abcdefg1' });
    assert.equal(err.code, 'EMAIL_DISPOSABLE');
    assert.equal(signupFields.signupFieldError({ email: 'x@example.com', password: 'Abcdefg1' }), null);
    const subscribe = routeSource('post', '/api/subscribe');
    assert.match(subscribe, /if \(isDisposableEmail\(normalizedEmail\)\)/);
    // The mailer returns the SMTP transcript (message id, envelope, relay queue
    // line); the browser only learns whether the email went out.
    assert.match(subscribe, /emailSent: Boolean\(emailSent\),/);
    assert.match(routeSource('post', '/api/email/resend'), /emailSent: Boolean\(sent\),/);
});

test('app.js: the code route is signed-in, rate-limited, open to unverified sessions, and verifies through the shared path', () => {
    const route = routeSource('post', '/api/email/verify-code');
    assert.match(route, /^app\.post\('\/api\/email\/verify-code', emailCodeLimiter, authMiddleware,/);
    assert.match(route, /emailOtp\.check\(User, req\.user\._id, req\.body && req\.body\.code, \{ secret: JWT_SECRET \}\)/);
    assert.match(route, /await completeEmailVerification\(result\.user, req, res, 'code'\)/);
    assert.match(APP_SOURCE, /'\/api\/email\/resend',\n\s+'\/api\/email\/verify-code',/);
    const issue = fnSource('issueEmailVerification');
    assert.match(issue, /const code = emailOtp\.issue\(user, JWT_SECRET\);/);
    assert.match(issue, /return \{ verifyUrl, code \};/);
    // The Google takeover guard and a password reset also retire the code.
    assert.match(fnSource('findOrCreateSocialUser'), /emailOtp\.clear\(user\);/);
    assert.match(routeSource('post', '/api/password/reset'), /emailOtp\.clear\(user\);/);
    // The page posts the code to that route.
    const page = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'verify-email.html'), 'utf8');
    assert.match(page, /autocomplete="one-time-code"/);
    assert.match(page, /fetch\(`\$\{V2\.API\}\/email\/verify-code`/);
});

test('a completed password reset also counts as inbox proof', () => {
    const reset = routeSource('post', '/api/password/reset');
    assert.match(reset, /if \(!user\.emailVerifiedAt\) \{\s*user\.emailVerifiedAt = new Date\(\);/);
});

// ---- The trial on the connectors and the REST API (owner, 2026-11-18) ----

async function trialDb(t) {
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
    const User = db.model('ConnectorTrialUser', schema);
    const make = async (fields = {}) => {
        const start = new Date();
        return User.create({
            email: 'trial@example.com',
            signupTrialAt: start,
            subscription: { planId: 'monthly', status: 'trialing', trialEndsAt: new Date(start.getTime() + 72 * HOUR) },
            ...fields
        });
    };
    return { User, make };
}

test('connector and API asks spend the same five questions as the website; lookups are not counted', { timeout: 120000 }, async (t) => {
    const { User, make } = await trialDb(t);
    // Two questions already asked on the website.
    const user = await make({ trialAiUsed: 2 });
    const answered = [];
    const lim = trial.connectorLimiter(User, user, { upgradeUrl: 'https://x/upgrade', onAnswered: (e) => answered.push(e) });

    const look = await lim.check(user._id, 'mcp_lookup');
    assert.equal(look.ok, true);
    assert.equal(look.lookupsLeft, null, 'lookups are not metered during the trial');
    assert.equal((await User.findById(user._id)).trialAiUsed, 2, 'a lookup spends no question');

    const ask = await lim.check(user._id, 'mcp_ask');
    assert.equal(ask.ok, true);
    assert.equal(ask.asksLeft, 2, 'the third question is reserved; two remain');
    assert.match(ask.notice, /2 of 5 AI answers left \(shared with the website\)/);
    assert.doesNotMatch(ask.neutralNotice, /\$|subscri|upgrade|price|plan/i, '/mcp/apps copy stays commerce-neutral');
    await lim.release(user._id, 'mcp_ask');
    assert.equal((await User.findById(user._id)).trialAiUsed, 2, 'a failed connector answer gives the question back');

    assert.equal((await lim.check(user._id, 'mcp_ask')).ok, true);
    await lim.spend(user._id, 'mcp_ask');
    const after = await User.findById(user._id);
    assert.equal(after.trialAiUsed, 3);
    assert.ok(after.trialActivatedAt, 'a connector answer activates the trial like a website one');
    assert.deepEqual(answered, [{ first: true, used: 3, limit: 5 }]);

    // The REST API draws from the same counter.
    const api = trial.connectorLimiter(User, user, { upgradeUrl: 'https://x/upgrade' });
    assert.equal((await api.check(user._id, 'api_ask')).ok, true);
    await api.spend(user._id, 'api_ask');
    assert.equal((await api.check(user._id, 'api_ask')).ok, true);
    await api.spend(user._id, 'api_ask');
    const sixth = await api.check(user._id, 'api_ask');
    assert.equal(sixth.ok, false);
    assert.equal(sixth.reason, 'ask_limit');
    assert.match(sixth.message, /last of your 5 free AI questions/);
    assert.equal((await User.findById(user._id)).trialAiUsed, 5, 'never a sixth question on any surface');
    assert.equal((await lim.check(user._id, 'mcp_lookup')).ok, true, 'lookups continue until the trial ends');

    // Expired: everything refused, and the refusal says the trial ended.
    const old = await make({ signupTrialAt: new Date(Date.now() - 80 * HOUR), subscription: { planId: 'monthly', status: 'trialing', trialEndsAt: new Date(Date.now() - 8 * HOUR) } });
    const ended = trial.connectorLimiter(User, old, {});
    for (const key of ['mcp_lookup', 'mcp_ask', 'api_lookup', 'api_ask']) {
        const r = await ended.check(old._id, key);
        assert.equal(r.ok, false, key);
        assert.equal(r.reason, 'trial_ended', key);
    }
});

test('REST API /ask on a trial key: refuses the sixth, refunds a failed answer', { timeout: 120000 }, async (t) => {
    const http = require('node:http');
    const express = require('express');
    const aiChat = require('../ai-chat');
    const { buildPublicApiRouter } = require('../public-api');
    const { User, make } = await trialDb(t);
    const user = await make({ trialAiUsed: 4 });
    const app = express();
    app.use(buildPublicApiRouter({
        credits: { check: async () => { throw new Error('the wallet must not meter a trial caller'); }, spend: async () => { throw new Error('no wallet spend'); } },
        effectiveAskLimit: () => 0,
        aiChat,
        apiKeyAuth: (req, res, next) => { req.userId = user._id; req.user = user; req.subscription = user.subscription; next(); },
        apiAccessGate: (req, res, next) => next(),
        apiKeyRateLimit: (req, res, next) => next(),
        jsonParser: express.json(),
        limiterFor: (req) => trial.connectorLimiter(User, req.user, { upgradeUrl: 'https://x/upgrade' })
    }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const ask = () => fetch(`${base}/ask`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question: 'Revenue?' }) });

    const original = aiChat.ask;
    t.after(() => { aiChat.ask = original; });
    aiChat.ask = async () => { throw new Error('model down'); };
    assert.equal((await ask()).status, 502);
    assert.equal((await User.findById(user._id)).trialAiUsed, 4, 'a failed API answer does not spend the question');

    aiChat.ask = async () => ({ source: 'ai', answer: 'Filed revenue was 10.', toolsUsed: [] });
    assert.equal((await ask()).status, 200);
    assert.equal((await User.findById(user._id)).trialAiUsed, 5);

    const refused = await ask();
    assert.equal(refused.status, 402);
    const body = await refused.json();
    assert.equal(body.code, 'TRIAL_AI_LIMIT');
    assert.equal(body.trial.asks_left, 0);
});

test('the app admits a live, verified signup trial on /mcp, /mcp/apps, the REST API and the consent screen', () => {
    const access = fnSource('signupTrialConnectorAccess');
    assert.match(access, /signupTrial\.active\(user\)/);
    assert.match(access, /identityVerified\(user\)/, 'an unverified trial never reaches the connectors');
    assert.match(access, /!hasApiAccess\(req\)/, 'a paying account stays on its credit wallet');

    const gate = fnSource('apiAccessGate');
    assert.match(gate, /if \(hasApiAccess\(req\) \|\| signupTrialConnectorAccess\(req\)\) return next\(\);/);
    assert.match(gate, /code: 'TRIAL_ENDED'/, 'an expired trial is told it ended, not that its plan lacks the API');

    assert.match(APP_SOURCE, /limiterFor: \(req\) => \(signupTrialConnectorAccess\(req\) \? signupTrialLimiter\(req, 'api'\) : null\)/);
    for (const [route, surface] of [['/mcp', 'mcp'], ['/mcp/apps', 'mcp_apps']]) {
        const src = routeSource('post', route);
        assert.match(src, /const signupTrialCaller = signupTrialConnectorAccess\(req\);/, route);
        assert.match(src, new RegExp(`limiter: signupTrialCaller \\? signupTrialLimiter\\(req, '${surface}'\\)`), route);
        assert.match(src, /entitled: \(\) => \(trialCaller \|\| signupTrialCaller \? true : hasApiAccess\(req\)\)/, route);
        assert.match(src, /const trialCaller = !signupTrialCaller && /, `${route}: one trial per account, never both`);
        assert.match(src, /breadth: companyBreadthFor\(req\)/, `${route}: the anti-scraping cap still holds the trial`);
    }
    assert.match(fnSource('connectorUsable'), /signupTrialConnectorAccess\(/);
    assert.match(routeSource('get', '/oauth/authorize'), /const hasAccess = hasApiAccess\(\{ user, subscription: user\.subscription \}\) \|\| signupTrialLive;/);
});
