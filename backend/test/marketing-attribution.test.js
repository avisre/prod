'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const tracking = require('../marketing-attribution');

const SECRET = 'marketing-unit-test-secret-with-enough-entropy';
const NOW = Date.UTC(2026, 6, 30, 10, 0, 0);

test('anonymous marketing sessions are signed, bounded and contain no PII', () => {
    const value = tracking.createSessionValue({ secret: SECRET, now: NOW, sessionId: 'AbCdEf0123_-xyZ9' });
    assert.match(value, /^v1\.\d+\.AbCdEf0123_-xyZ9\.[A-Za-z0-9_-]+$/);
    assert.doesNotMatch(value, /@|email|user|127\.0\.0\.1/i);
    assert.equal(tracking.parseSessionValue(value, { secret: SECRET, now: NOW }).sessionId, 'AbCdEf0123_-xyZ9');
    assert.equal(tracking.parseSessionValue(`${value}x`, { secret: SECRET, now: NOW }), null);
    assert.equal(tracking.parseSessionValue(value, { secret: 'wrong-secret', now: NOW }), null);
    assert.equal(tracking.parseSessionValue(value, {
        secret: SECRET,
        now: NOW + (tracking.SESSION_MAX_AGE_SECONDS + 1) * 1000
    }), null);
});
test('traffic classification excludes crawlers, headless QA and unknown clients', () => {
    const browser = tracking.classifyUserAgent('Mozilla/5.0 AppleWebKit/537.36 Chrome/150.0.0.0 Safari/537.36');
    assert.equal(browser.estimatedHuman, true);
    assert.equal(browser.isBot, false);
    assert.equal(browser.trafficClass, 'browser');

    for (const value of ['Googlebot/2.1', 'Mozilla/5.0 HeadlessChrome/150.0.0.0', 'curl/8.0', '']) {
        const result = tracking.classifyUserAgent(value);
        assert.equal(result.estimatedHuman, false, value);
        assert.equal(result.isBot, true, value);
    }
});

test('referrers are query-free and map search/social sources', () => {
    assert.equal(
        tracking.sanitizeReferrer('https://www.google.com/search?q=private-query#fragment'),
        'https://www.google.com/search'
    );
    assert.equal(tracking.referrerSource('https://www.google.com/search?q=stocks'), 'google');
    assert.equal(tracking.referrerSource('https://x.com/person/status/123'), 'x');
    assert.equal(tracking.referrerSource('https://www.linkedin.com/feed/'), 'linkedin');
    assert.equal(tracking.referrerSource('https://www.stockportfolio.pro/tools/dilution'), 'internal');
    assert.equal(tracking.sanitizeReferrer('javascript:alert(1)'), null);
});

test('QA mode requires a signed cookie or configured secret header', () => {
    const qa = tracking.createQaValue({ secret: SECRET, now: NOW });
    assert.equal(tracking.parseQaValue(qa, { secret: SECRET, now: NOW }), true);
    assert.equal(tracking.parseQaValue(`${qa}x`, { secret: SECRET, now: NOW }), false);
    assert.equal(tracking.qaModeFromRequest({ headers: { cookie: `sp_mkt_qa=${qa}` } }, { secret: SECRET, now: NOW }), true);
    assert.equal(tracking.qaModeFromRequest({ headers: { 'x-marketing-qa-token': 'qa-secret' } }, {
        secret: SECRET,
        qaToken: 'qa-secret',
        now: NOW
    }), true);
    assert.equal(tracking.qaModeFromRequest({ headers: { 'x-marketing-qa-token': 'wrong' } }, {
        secret: SECRET,
        qaToken: 'qa-secret',
        now: NOW
    }), false);
});

// The server-rendered /filing-changes pages load no /assets/*.js — that is
// deliberate (it keeps them out of the cache-stamp cascade) but it means they
// have no client-side tracking, so a campaign landing there is attributed
// server-side or not at all. Two halves, and BOTH matter:
//   - capture it, or Show HN / partner traffic is unmeasurable;
//   - capture it only for campaign traffic, because setting a cookie makes the
//     response uncacheable (ssr-cache.js refuses to cache Set-Cookie), and
//     doing that unconditionally would empty the SSR cache for the organic and
//     crawler traffic that is the overwhelming majority of hits.
test('filing-changes landings are attributed without emptying the SSR cache', () => {
    const fs = require('fs');
    const path = require('path');
    const appJs = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const ssrCacheJs = fs.readFileSync(path.join(__dirname, '..', 'ssr-cache.js'), 'utf8');

    const gated = appJs.match(/if \(hasCampaignMarker\(req\)\) marketingRequestFields\(req, res\);/g) || [];
    assert.equal(gated.length, 2, 'both /filing-changes routes capture the campaign touch');

    // An unconditional call on these routes is the regression this guards.
    const routeBlock = appJs.slice(appJs.indexOf("app.get(['/filing-changes'"), appJs.indexOf("app.get('/filing-changes/:symbol'") + 4000);
    assert.doesNotMatch(routeBlock, /^\s*marketingRequestFields\(req, res\);/m,
        'an ungated capture would set a cookie on every hit and disable the SSR cache');

    assert.match(appJs, /function hasCampaignMarker\(req\)/, 'the gate is a named, documented helper');
    // A bare referrer must not trigger it: that matches most organic search.
    const helper = appJs.slice(appJs.indexOf('function hasCampaignMarker'), appJs.indexOf('function marketingRequestFields'));
    assert.doesNotMatch(helper, /referer|referrer/i, 'referrer must not trigger capture — it would match organic search');

    assert.match(ssrCacheJs, /getHeader\('Set-Cookie'\)\)\s*return;/,
        'ssr-cache must keep refusing to cache a response that sets a cookie');
});
