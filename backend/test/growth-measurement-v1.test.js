'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tracking = require('../marketing-attribution');
const growth = require('../growth-measurement');
const ga4 = require('../ga4-server');

const SECRET = 'growth-test-secret';

test('Google campaign survives a direct return, signup and a cookie-free payment', () => {
    const landing = { method: 'GET', path: '/connect', hostname: 'stockportfolio.pro',
        query: { utm_source: 'google', utm_medium: 'cpc', utm_campaign: 'us_search_10', gclid: 'google-click-123' },
        headers: { 'user-agent': 'Mozilla/5.0 Chrome/150.0.0.0' } };
    const response = responseMock();
    const first = tracking.captureAttribution(landing, response, { secret: SECRET, secure: false });
    const cookie = response.getHeader('Set-Cookie')[0].split(';')[0];
    const returning = tracking.captureAttribution({ ...landing, query: {}, headers: { ...landing.headers, cookie } }, responseMock(), { secret: SECRET, secure: false });
    const signup = growth.canonicalEvent({ eventName: 'signup_completed', userId: 'test-user', attribution: returning, secret: SECRET });
    assert.equal(signup.firstTouch.campaign, 'us_search_10');
    assert.equal(signup.lastNonDirectTouch.medium, 'cpc');
    assert.equal(signup.currentSessionTouch.source, 'direct');

    const persistedUser = { analyticsAnonymousId: first.anonymousId, analyticsFirstTouch: returning.firstTouch, analyticsLastNonDirectTouch: returning.lastNonDirectTouch };
    const paid = growth.canonicalEvent({ eventName: 'invoice_paid', userId: 'test-user',
        attribution: growth.attributionForUser(persistedUser), data: { amountMinor: 7999, currency: 'usd' }, secret: SECRET });
    assert.equal(paid.anonymousId, first.anonymousId);
    assert.equal(paid.firstTouch.source, 'google');
    assert.equal(paid.lastNonDirectTouch.clickId, 'google-click-123');
    assert.equal(paid.lastNonDirectTouch.campaign, 'us_search_10');
    assert.equal(paid.currentSessionTouch, null, 'a webhook must not invent a browser session');

    const unknown = growth.canonicalEvent({ eventName: 'invoice_paid', userId: 'legacy-user', attribution: growth.attributionForUser({}), secret: SECRET });
    assert.equal(unknown.firstTouch, null);
    assert.equal(unknown.lastNonDirectTouch, null);
});

test('Google auto-tagged landings work without a referrer or manual UTM tags', () => {
    for (const key of ['gclid', 'dclid', 'gbraid', 'wbraid']) {
        const req = { method: 'GET', path: '/connect', query: { [key]: 'google-click-123' }, headers: {} };
        assert.equal(tracking.hasCampaignMarker(req.query), true);
        const touch = tracking.attributionTouch(req);
        assert.equal(touch.source, 'google');
        assert.equal(touch.medium, 'cpc');
        assert.equal(touch.clickId, 'google-click-123');
        assert.equal(tracking.attributionTouch({ ...req, query: { ...req.query, utm_source: 'newsletter', utm_medium: 'email' } }).source, 'newsletter');
        assert.equal(tracking.attributionTouch({ ...req, method: 'POST', path: '/api/track/page_view' }).source, 'direct');
    }
});

function responseMock() {
    const headers = new Map();
    return {
        getHeader(name) { return headers.get(name); },
        setHeader(name, value) { headers.set(name, value); },
        append(name, value) { headers.set(name, [...(headers.get(name) || []), value]); }
    };
}

test('attribution preserves non-direct touch when a later visit is direct', () => {
    const firstReq = { method: 'GET', path: '/tools/dilution', query: { utm_source: 'Twitter', utm_campaign: 'august' }, headers: { host: 'stockportfolio.pro', 'user-agent': 'Mozilla/5.0 Chrome/150.0.0.0' } };
    const firstRes = responseMock();
    const first = tracking.captureAttribution(firstReq, firstRes, { secret: SECRET, now: Date.parse('2026-08-11T00:00:00Z'), secure: false });
    assert.equal(first.firstTouch.source, 'x');
    const cookie = firstRes.getHeader('Set-Cookie')[0].split(';')[0];
    const directReq = { method: 'GET', path: '/stocks/WAB', query: {}, headers: { host: 'stockportfolio.pro', cookie, 'user-agent': 'Mozilla/5.0 Chrome/150.0.0.0' } };
    const direct = tracking.captureAttribution(directReq, responseMock(), { secret: SECRET, now: Date.parse('2026-08-12T00:00:00Z'), secure: false });
    assert.equal(direct.firstTouch.source, 'x');
    assert.equal(direct.lastNonDirectTouch.source, 'x');
    assert.equal(direct.currentSessionTouch.source, 'direct');
});

test('a journey that starts on a tracking beacon records the page, not the beacon', () => {
    // Regression: a paying customer who arrived on /docs/api-mcp was stored with
    // landingPath "/api/track/page_view", so the page that sold him was invisible.
    const beacon = (body, referer) => ({ method: 'POST', path: '/api/track/page_view', query: {}, body, headers: { host: 'www.stockportfolio.pro', ...(referer ? { referer } : {}), 'user-agent': 'Mozilla/5.0 Chrome/150.0.0.0' } });
    const capture = (req) => tracking.captureAttribution(req, responseMock(), { secret: SECRET, now: Date.parse('2026-10-08T00:00:00Z'), secure: false });

    const fromBody = capture(beacon({ path: '/docs/api-mcp?x=1#top', referrer: '' }, 'https://www.stockportfolio.pro/docs/api-mcp'));
    assert.equal(fromBody.firstTouch.landingPath, '/docs/api-mcp');
    assert.equal(fromBody.firstTouch.source, 'direct');

    const fromReferer = capture(beacon({}, 'https://www.stockportfolio.pro/screener'));
    assert.equal(fromReferer.firstTouch.landingPath, '/screener');

    // Nothing first-party to go on: unknown, never the beacon's own path.
    for (const req of [beacon({}), beacon({ path: '/api/track/page_view' }), beacon({ path: '//evil.example/x' }), beacon({}, 'https://evil.example/landing')]) {
        assert.equal(capture(req).firstTouch.landingPath, null);
    }

    // A public HTML request still records its own path.
    const html = capture({ method: 'GET', path: '/gurus', query: {}, headers: { host: 'www.stockportfolio.pro', 'user-agent': 'Mozilla/5.0 Chrome/150.0.0.0' } });
    assert.equal(html.firstTouch.landingPath, '/gurus');
});

test('attribution self-referral is internal and values are bounded', () => {
    const req = { method: 'GET', path: '/compare/AAPL-vs-MSFT', query: { utm_source: 'x', content_id: 'bad value with spaces' }, headers: { referer: 'https://x.com/investor/status/1?email=secret', 'user-agent': 'Mozilla/5.0 Firefox/130.0' } };
    const fields = tracking.attributionTouch(req);
    assert.equal(fields.source, 'x');
    assert.equal(fields.contentId, null);
    const internal = tracking.attributionTouch({ ...req, query: {}, headers: { ...req.headers, referer: 'https://stockportfolio.pro/stocks/AAPL?prompt=secret' } });
    assert.equal(internal.source, 'internal');
    assert.equal(internal.referrerHost, 'stockportfolio.pro');
});

test('canonical schema maps GA4 events and removes sensitive values', () => {
    const payload = growth.canonicalEvent({
        eventName: 'signup', userId: 'user-123', plan: 'Pro', secret: SECRET,
        data: { path: '/register.html?email=x', pageType: 'pricing', contentId: 'tool-earnings-quality', prompt: 'do not store', email: 'x@example.com', dedupeKey: 'signup:user-123' },
        attribution: { firstTouch: { source: 'google', landingPath: '/stocks/WAB/eps?x=1' } }
    });
    assert.equal(payload.eventName, 'signup_completed');
    assert.equal(payload.event_name, 'signup_completed');
    assert.equal(payload.schema_version, growth.SCHEMA_VERSION);
    assert.equal(payload.ga4EventName, 'sign_up');
    assert.equal(payload.pagePath, '/register.html');
    assert.equal(payload.firstTouch.landingPath, '/stocks/WAB/eps');
    assert.equal(payload.opaqueUserId.length, 32);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'email'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(payload, 'prompt'), false);
});

test('browser event allowlist excludes business truth claims', () => {
    assert.equal(growth.validateBrowserEvent('cta_clicked'), true);
    assert.equal(growth.validateBrowserEvent('signup_completed'), false);
    assert.equal(growth.validateBrowserEvent('trial_verified'), false);
    assert.equal(growth.normalizeEventName('appsumo_outbound'), 'appsumo_outbound_clicked');
    assert.equal(growth.normalizeEventName('meaningful_activation'), 'research_outcome_completed');
});

test('canonical first-event names accept legacy aliases without adding PII', () => {
    for (const [alias, canonical] of [
        ['signup_complete', 'signup_completed'],
        ['first_research_complete', 'first_research_completed'],
        ['first_ask_success', 'first_ask_succeeded']
    ]) {
        assert.equal(growth.normalizeEventName(alias), canonical);
        const payload = growth.canonicalEvent({
            eventName: alias,
            userId: 'user-123',
            secret: SECRET,
            data: {
                dedupeKey: `canonical-alias:${canonical}`,
                email: 'hidden@example.com',
                question: 'hidden research text',
                answer: 'hidden answer'
            }
        });
        assert.equal(payload.eventName, canonical);
        assert.equal(Object.prototype.hasOwnProperty.call(payload, 'email'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(payload, 'question'), false);
        assert.equal(Object.prototype.hasOwnProperty.call(payload, 'answer'), false);
    }
});

test('GA4 payload is privacy-safe and disabled by default', () => {
    const payload = ga4.buildPayload({ event: 'sign_up', clientId: '12345.1795000000', opaqueUserId: 'opaque-123', params: { page_type: 'pricing', email: 'hidden@example.com', prompt: 'hidden' } });
    assert.equal(payload.events[0].params.page_type, 'pricing');
    assert.equal(Object.prototype.hasOwnProperty.call(payload.events[0].params, 'email'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(payload.events[0].params, 'prompt'), false);
    assert.equal(ga4.enabled(), false);
});

test('only the matching GA4 browser identity joins a recent session', () => {
    const clientId = '12345.1795000000';
    const sessionId = '1795000100';
    const measurementId = 'G-TEST123';
    for (const sessionCookie of [`GS1.1.${sessionId}.7.0`, `GS2.1.s${sessionId}$o7`, `GS2.1.o7$s${sessionId}`]) {
        const cookies = new Map([['_ga', `GA1.1.${clientId}`], ['_ga_TEST123', sessionCookie]]);
        assert.deepEqual(ga4.identityFromCookies(cookies, measurementId), { clientId, sessionId });
        assert.deepEqual(ga4.identityFromCookies(cookies, 'G-OTHER'), { clientId, sessionId: null });
    }
    const base = { event: 'trial_verified', clientId, sessionId, now: (Number(sessionId) + 30) * 1000 };
    assert.equal(ga4.buildPayload(base).events[0].params.session_id, Number(sessionId));
    assert.equal(ga4.buildPayload({ ...base, clientId: 'anon-123' }), null);
    assert.equal(ga4.buildPayload({ ...base, now: base.now + 72 * 60 * 60 * 1000 }).events[0].params.session_id, undefined);
});

test('a paid Meta cohort uses the original campaign and stable Stripe receipt after the trial', () => {
    const campaign = 'meta_trial_us_10usd';
    for (const [source, normalized] of [['fb', 'facebook'], ['ig', 'instagram'], ['msg', 'messenger'], ['an', 'audience_network'], ['wa', 'whatsapp'], ['whatsapp', 'whatsapp'], ['meta', 'meta']]) {
        const touch = tracking.attributionTouch({
            method: 'GET', path: '/register', query: { utm_source: source, utm_medium: 'paid_social', utm_campaign: campaign }, headers: {}
        });
        assert.equal(touch.source, normalized);
        assert.equal(growth.sanitizeAttribution(touch).source, normalized);
        assert.deepEqual(ga4.acquisitionParams(growth.sanitizeAttribution(touch)), { acquisition_campaign: campaign });
    }
    const invoice = { id: 'in_123', livemode: true, status: 'paid', amount_paid: 8599, total: 8599, total_excluding_tax: 7999, currency: 'usd' };
    const purchase = ga4.purchaseParams(invoice, 'monthly', true);
    assert.match(purchase.transaction_id, /^invoice_[a-f0-9]{32}$/);
    assert.equal(purchase.value, 79.99);
    assert.equal(purchase.tax, 6);
    assert.equal(purchase.subscription_payment, 'first');
    assert.equal(ga4.purchaseParams(invoice, 'monthly', false).transaction_id, purchase.transaction_id);
    assert.equal(ga4.purchaseParams(invoice, 'monthly', false).subscription_payment, 'subsequent');
    assert.equal(ga4.purchaseParams({ ...invoice, livemode: false }, 'monthly', true), null);
    assert.equal(ga4.purchaseParams({ ...invoice, amount_paid: 0 }, 'monthly', true), null);
    const base = { event: 'purchase', clientId: '12345.1795000000', params: { acquisition_campaign: campaign } };
    assert.equal(ga4.buildPayload(base), null);
    assert.deepEqual(ga4.buildPayload({ ...base, purchase }).events[0].params, { acquisition_campaign: campaign, ...purchase });
    assert.deepEqual(ga4.acquisitionParams({ campaign: 'hidden@example.com' }), {});
});

test('P0 proof-funnel events are registered as browser events', () => {
    for (const name of ['source_opened', 'proof_view', 'second_session']) {
        assert.equal(growth.normalizeEventName(name), name);
        assert.equal(growth.validateBrowserEvent(name), true, name);
    }
});

// The second_session sender is the smallest complete hook for a returning
// buyer starting another research session after activation. It guards on an
// already-activated user (firstActivationAt set) and carries no dedupe key,
// so each returning Ask is counted while first ask success keeps its own
// idempotent record.
// The second_session sender is the smallest complete hook for a returning
// buyer starting another research session after activation. It guards on an
// already-activated user (firstActivationAt set) and carries no dedupe key,
// so each returning Ask is counted while first ask success keeps its own
// idempotent record.
test('second_session sender is wired into the Ask flow', () => {
    const fs = require('node:fs');
    const path = require('node:path');
    const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.match(appSource, /function trackSecondSession\(req, user\) \{/);
    assert.match(appSource, /trackFunnel\('second_session'/);
    // Both Ask success sites call the sender before first ask success.
    assert.equal((appSource.match(/trackSecondSession\(req, req\.user\);/g) || []).length >= 2, true);
});
