'use strict';

// POST /oauth/signup — the free account the connector sign-in screen offers,
// and the only way to the MCP trial (owner decision 2026-10-26). The handler
// runs against fakes (oauth-signup.js is a factory over injected deps); the
// app.js wiring and the gating that reads the flag are checked in source, the
// way paid-first-signup.test.js checks the routes it cannot boot.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const oauthSignup = require('../oauth-signup');
const oauthOffer = require('../oauth-signin-offer');
const mcpTrial = require('../mcp-trial');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

const CLIENT = { clientId: 'client-1', clientName: 'Claude', redirectUris: ['https://claude.ai/api/mcp/auth_callback'] };
const GOOD = {
    email: 'New.Person@Example.com',
    password: 'Abcdefg1',
    client_id: CLIENT.clientId,
    redirect_uri: CLIENT.redirectUris[0]
};

function harness({ existing = null } = {}) {
    const saved = [];
    const cookies = [];
    const events = [];
    class User {
        constructor(fields) { Object.assign(this, fields); this._id = `u${saved.length + 1}`; }
        static findOne() { return { select: async () => existing }; }
        markModified() {}
        async save() { saved.push(this); }
    }
    const handler = oauthSignup.connectorSignupHandler({
        getClient: async (id) => (id === CLIENT.clientId ? CLIENT : null),
        User,
        hashPassword: async (p) => `hashed:${p}`,
        planConfig: { planId: 'free', planName: 'Free', price: 0, currency: 'usd', billingInterval: 'month' },
        ensureSubscriptionShape: () => ({}),
        attachSignupAttribution: () => {},
        recordCustomerLifecycleEvent: async () => {},
        sendNewUserEmails: async () => {},
        trackFunnel: (name) => events.push(name),
        createUserToken: (u) => `token-${u._id}`,
        setAuthCookie: (res, token) => cookies.push(token),
        trackingRequestFields: () => ({}),
        sendApiError: (res, err) => res.status(err.status).json({ message: err.message, code: err.code }),
        now: () => new Date('2026-10-26T12:00:00Z')
    });
    async function post(body) {
        const res = {
            statusCode: 200, body: null,
            status(c) { this.statusCode = c; return this; },
            json(b) { this.body = b; return this; }
        };
        await handler({ body, headers: {} }, res);
        return res;
    }
    return { post, saved, cookies, events };
}

test('a valid connector request creates a free account flagged for the trial and signs it in', async () => {
    const h = harness();
    const res = await h.post(GOOD);
    assert.equal(res.statusCode, 200);
    assert.equal(h.saved.length, 1);
    const user = h.saved[0];
    assert.equal(user.email, 'new.person@example.com', 'email is normalised');
    assert.equal(user.password, 'hashed:Abcdefg1');
    assert.equal(user.subscription.planId, 'free');
    assert.equal(user.subscription.status, 'active');
    assert.equal(user.paymentRequiredAt, null, 'owes nothing');
    assert.deepEqual(user.mcpTrial, { eligible: true, grantedAt: new Date('2026-10-26T12:00:00Z'), clientId: CLIENT.clientId });
    assert.equal(mcpTrial.eligible(user), true);
    assert.deepEqual(h.cookies, ['token-u1'], 'signed in straight away');
    assert.ok(h.events.includes('signup'));
});

test('an unknown client or a redirect_uri the client did not register creates nothing', async () => {
    for (const body of [
        { ...GOOD, client_id: 'nope' },
        { ...GOOD, redirect_uri: 'https://evil.example/cb' },
        { ...GOOD, redirect_uri: '' }
    ]) {
        const h = harness();
        const res = await h.post(body);
        assert.equal(res.statusCode, 400);
        assert.equal(res.body.code, 'OAUTH_CLIENT_UNKNOWN');
        assert.equal(h.saved.length, 0);
        assert.equal(h.cookies.length, 0);
    }
});

test('the honeypot answers 200 and creates nothing', async () => {
    const h = harness();
    const res = await h.post({ ...GOOD, website: 'http://spam.example' });
    assert.equal(res.statusCode, 200);
    assert.equal(h.saved.length, 0);
    assert.equal(h.cookies.length, 0);
});

test('a duplicate email is 409 and a weak password or SMS-gateway email is 400', async () => {
    let h = harness({ existing: { _id: 'old' } });
    let res = await h.post(GOOD);
    assert.equal(res.statusCode, 409);
    assert.equal(res.body.code, 'EMAIL_ALREADY_REGISTERED');
    assert.equal(h.saved.length, 0);

    h = harness();
    res = await h.post({ ...GOOD, password: 'short' });
    assert.equal(res.statusCode, 400);
    assert.equal(res.body.code, 'PASSWORD_POLICY_FAILED');

    res = await h.post({ ...GOOD, email: '5551234567@vtext.com' });
    assert.equal(res.statusCode, 400);
    assert.equal(h.saved.length, 0);
});

test('only a connector-made account is eligible; a website or lapsed account is not', () => {
    assert.equal(mcpTrial.eligible(null), false);
    assert.equal(mcpTrial.eligible({}), false, 'a website account has no flag');
    assert.equal(mcpTrial.eligible({ mcpTrial: { eligible: false } }), false);
    assert.equal(mcpTrial.eligible({ mcpTrial: { eligible: 'true' } }), false, 'only a real true counts');
    // A lapsed paid plan keeps whatever flag the account was created with; a
    // website account that lapses therefore never gains a trial.
    assert.equal(mcpTrial.eligible({ subscription: { status: 'canceled' } }), false);
});

test('app.js: the route is mounted behind the signup limiter, and website signup still refuses plan=free', () => {
    assert.match(appSource, /app\.post\('\/oauth\/signup', subscribeLimiter, jsonParser, oauthSignup\.connectorSignupHandler\(\{/);
    assert.match(appSource, /planConfig: getPlanConfig\(FREE_PLAN_ID\)/);
    assert.match(appSource, /if \(REQUIRE_INITIAL_STRIPE_PAYMENT && !appsumoActivationSignup && planConfig\.planId === FREE_PLAN_ID\)/);
    assert.match(appSource, /require\('\.\/signup-fields'\)/, 'field checks come from the shared module');
    assert.doesNotMatch(appSource, /^function passwordMeetsPolicy/m, 'no second copy in app.js');
    assert.doesNotMatch(appSource, /^const SMS_GATEWAY_DOMAINS = new Set/m);
});

test('app.js: only an eligible account without access runs on the trial, on both MCP surfaces', () => {
    const lines = appSource.match(/const trialCaller = .*;/g) || [];
    assert.equal(lines.length, 2);
    for (const line of lines) assert.equal(line, 'const trialCaller = !hasApiAccess(req) && mcpTrial.eligible(req.user);');
    // Not a trial caller and no access: the live check refuses (ENTITLEMENT_REQUIRED).
    assert.equal((appSource.match(/entitled: \(\) => \(trialCaller \? true : hasApiAccess\(req\)\)/g) || []).length, 2);
    assert.match(appSource, /hasAccess: await connectorUsable\(user\)/, '/oauth/session counts a live trial as access');
});

test('app.js: the sign-in screen offers the trial signup first and the Monthly plan second', () => {
    const signin = appSource.slice(appSource.indexOf('<h1>Sign in to connect</h1>'), appSource.indexOf("const email = escapeHtmlOauth(user.email || '');"));
    assert.match(signin, /oauthOffer\.trialSignupHtml\(\{ clientId, redirectUri, trial: mcpTrial\.config\(\)/);
    assert.match(signin, /secondary: true/);
    assert.match(signin, /oauthOffer\.trialSignupScript\(\)/);
    assert.ok(signin.indexOf('trialSignupHtml') < signin.indexOf('signupOfferHtml'));
});

test('app.js: the consent screen picks the trial, trial-over or no-access notice', () => {
    const consent = appSource.slice(appSource.indexOf("const email = escapeHtmlOauth(user.email || '');"), appSource.indexOf("app.get('/oauth/session'"));
    assert.match(consent, /mcpTrial\.eligible\(user\) \? await mcpTrial\.status\(user\._id\) : null/);
    assert.match(consent, /trialLive \? oauthOffer\.trialNoticeHtml\(trial, offerFacts\)/);
    assert.match(consent, /: trial \? oauthOffer\.trialEndedNoticeHtml\(trial, offerFacts\)/);
    assert.match(consent, /: oauthOffer\.noAccessNoticeHtml\(offerFacts\)/);
    assert.match(consent, /\$\{hasAccess \|\| trialLive \? '' : oauthOffer\.pollScript\('access'\)\}/);
});

test('the three consent notices and the signup form say what the trial is and that it does not renew', () => {
    const facts = { price: 79.99, lookupCost: 2, askCost: 50, credits: 200 };
    const fresh = { started: false, days: 30, lookupsLeft: 25, asksLeft: 3 };
    const live = { started: true, endsAt: '2026-11-25T00:00:00Z', daysLeft: 1, lookupsLeft: 1, asksLeft: 0, ended: false };

    assert.match(oauthOffer.trialNoticeHtml(fresh, facts), /25 data lookups and 3 AI answers left\. The 30 days start with your first request\./);
    const liveHtml = oauthOffer.trialNoticeHtml(live, facts);
    assert.match(liveHtml, /1 data lookup and 0 AI answers left/);
    assert.match(liveHtml, /It ends on 25 November 2026 \(1 day left\)/);
    assert.match(liveHtml, /does not renew/);

    assert.match(oauthOffer.trialEndedNoticeHtml({ ended: true }, facts), /Your free connector trial has ended\./);
    assert.match(oauthOffer.trialEndedNoticeHtml({ ended: false, lookupsLeft: 0, asksLeft: 0 }, facts), /You have used everything in your free connector trial\./);
    assert.match(oauthOffer.trialEndedNoticeHtml({ ended: true }, facts), /The trial does not renew\./);
    assert.match(oauthOffer.noAccessNoticeHtml(facts), /Your plan does not include this connector/);

    const form = oauthOffer.trialSignupHtml({ clientId: 'c"1', redirectUri: 'https://x/cb', trial: { lookups: 25, asks: 3, days: 30 }, price: 79.99, credits: 200 });
    assert.match(form, /value="c&quot;1"/, 'client_id is escaped');
    assert.match(form, /25 data lookups and 3 AI answers, for 30 days from your first request\. One trial per account; it does not renew\./);
    assert.match(form, /id="ts-website"/, 'honeypot field');
    assert.match(oauthOffer.trialSignupScript(), /fetch\('\/oauth\/signup'/);
    assert.match(oauthOffer.signupOfferHtml({ ...facts, secondary: true }), /Or start with the Monthly plan/);
});

test('a ChatGPT redirect gets no signup, even from a hand-made POST', async () => {
    const chatgptClient = 'https://chatgpt.com/connector/oauth/abc123';
    CLIENT.redirectUris.push(chatgptClient);
    try {
        const h = harness();
        const res = await h.post({ ...GOOD, redirect_uri: chatgptClient });
        assert.equal(res.statusCode, 403);
        assert.equal(res.body.code, 'OAUTH_SIGNUP_UNAVAILABLE');
        assert.equal(h.saved.length, 0);
        assert.equal(h.cookies.length, 0);
    } finally {
        CLIENT.redirectUris.pop();
    }
});
