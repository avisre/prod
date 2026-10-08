'use strict';

// The connector's sign-in screen (/oauth/authorize) is where an assistant sends
// a capped trial user, and the only screen in that journey on our own domain.
// These tests pin what it offers someone who cannot use the connector yet, and
// that the trip back from checkout can only ever land on our own endpoint.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const offer = require('../oauth-signin-offer');

const FACTS = { price: 79.99, lookupCost: 2, askCost: 42, credits: 100 };
const QUERY = 'response_type=code&client_id=mcpc_abc&redirect_uri=https%3A%2F%2Fchatgpt.com%2Fconnector_platform_oauth_redirect&state=s%261&code_challenge=xyz&code_challenge_method=S256&resource=https%3A%2F%2Fwww.stockportfolio.pro%2Fmcp%2Fapps';

// What app.js's parseCookieHeader does to a Set-Cookie value on the way back.
function roundTrip(setCookie) {
    return decodeURIComponent(setCookie.split(';')[0].split('=').slice(1).join('='));
}

test('the signed-out offer names the plan, its price and what it includes, and links signup with the return path', () => {
    const html = offer.signupOfferHtml(FACTS);
    assert.match(html, /No account yet\?/);
    assert.match(html, /\$79\.99 a month, cancel anytime/);
    assert.match(html, /100 credits a month \(a data lookup costs 2 credits, an AI answer 42\)/);
    assert.match(html, /href="\/register\?plan=monthly&amp;next=oauth%2Fresume&amp;utm_source=connector&amp;utm_campaign=oauth_signin"/);
    assert.match(html, /come straight back here/);
    // Without a stored request there is no return trip to promise.
    assert.match(offer.signupOfferHtml({ ...FACTS, canResume: false }), /reconnect from your assistant/);
});

test('the no-access notice comes with the upgrade link and says Allow still works', () => {
    const html = offer.noAccessNoticeHtml(FACTS);
    assert.match(html, /Your plan does not include this connector/);
    assert.match(html, /You can still connect/);
    assert.match(html, /\$79\.99 a month/);
    assert.match(html, /href="\/upgrade\.html\?utm_source=connector&amp;utm_campaign=oauth_no_access" target="_blank"/);
});

test('the price follows the configured plan price, never a typed-in figure', () => {
    assert.match(offer.signupOfferHtml({ ...FACTS, price: 99 }), /\$99\.00 a month/);
    assert.doesNotMatch(offer.signupOfferHtml({ ...FACTS, price: 99 }), /79\.99/);
});

test('the resume cookie survives the round trip and resumes the same authorization', () => {
    const header = offer.resumeCookie(QUERY, { secure: true });
    assert.match(header, /^sp_oauth_resume=/);
    assert.match(header, /; Path=\/oauth; HttpOnly; SameSite=Lax; Secure$/);
    assert.match(header, /Max-Age=7200/);
    const target = offer.resumeTarget(roundTrip(header));
    assert.ok(target.startsWith('/oauth/authorize?'));
    const back = new URLSearchParams(target.split('?')[1]);
    const sent = new URLSearchParams(QUERY);
    for (const [k, v] of sent) assert.equal(back.get(k), v, `${k} must come back unchanged`);
});

test('resume only ever targets our own authorize endpoint', () => {
    for (const hostile of ['https://evil.example/', '//evil.example', '/dashboard.html', 'next=https://evil.example', '']) {
        const target = offer.resumeTarget(hostile);
        assert.ok(target === null || target.startsWith('/oauth/authorize?'), `"${hostile}" resolved to ${target}`);
    }
    // A value that is not an authorization request is not resumed at all.
    assert.equal(offer.resumeTarget('foo=bar'), null);
    assert.equal(offer.resumeTarget('client_id=x'), null);
    // An over-long request is not stored, so the page promises no return trip.
    assert.equal(offer.resumeCookie('client_id=x&redirect_uri=y&state=' + 'a'.repeat(4000)), null);
});

test('the poll script waits for the right thing on each screen', () => {
    assert.match(offer.pollScript('session'), /s\.signedIn\) location\.reload\(\)/);
    assert.match(offer.pollScript('access'), /s\.hasAccess\) location\.reload\(\)/);
    assert.match(offer.pollScript('session'), /fetch\('\/oauth\/session'/);
});

test('app.js renders both offers, exposes the session check and routes the return trip', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.ok(src.includes('oauthOffer.signupOfferHtml('), 'the sign-in screen offers the plan');
    assert.ok(src.includes('oauthOffer.noAccessNoticeHtml(offerFacts)'), 'the consent screen warns an account without access');
    assert.ok(src.includes("hasApiAccess({ user, subscription: user.subscription })"), 'access is decided by the same rule the endpoints use');
    assert.ok(src.includes("app.get('/oauth/session'"), 'the polled session check is routed');
    assert.ok(src.includes("app.get('/oauth/resume'"), 'the return trip is routed');
    assert.ok(src.includes('price: CORE_PLAN_PRICE'), 'the price is the configured Monthly price');
    // The return route redirects to the validated target or the dashboard, nothing else.
    const resume = src.slice(src.indexOf("app.get('/oauth/resume'"));
    assert.match(resume.slice(0, 700), /res\.redirect\(302, target \|\| '\/dashboard\.html'\)/);
});

test('register.html carries only the connector return path through checkout', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'register.html'), 'utf8');
    assert.ok(html.includes("requestedNext === 'oauth/resume' ? 'oauth/resume' : 'dashboard.html'"),
        'any other ?next= falls back to the dashboard');
    assert.equal(offer.RESUME_NEXT, 'oauth/resume');
});
