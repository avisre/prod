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
