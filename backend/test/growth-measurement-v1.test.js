'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const tracking = require('../marketing-attribution');
const growth = require('../growth-measurement');
const ga4 = require('../ga4-server');

const SECRET = 'growth-test-secret';

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
    const payload = ga4.buildPayload({ event: 'sign_up', clientId: 'anon-123', sessionId: 'session-123', opaqueUserId: 'opaque-123', params: { page_type: 'pricing', email: 'hidden@example.com', prompt: 'hidden' } });
    assert.equal(payload.events[0].params.page_type, 'pricing');
    assert.equal(Object.prototype.hasOwnProperty.call(payload.events[0].params, 'email'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(payload.events[0].params, 'prompt'), false);
    assert.equal(ga4.enabled(), false);
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
