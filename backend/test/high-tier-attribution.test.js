'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const shareCopy = require('../share-copy');
const { buildCampaignLink } = require('../../scripts/campaign-link');

const SECRET = 'high-tier-attribution-test-secret';
const NOW = Date.UTC(2026, 7, 13, 12, 0, 0);

test('high-tier audit links use only the two allowlisted IDs and the public monitor route', () => {
    for (const [contentId, clickId] of [
        ['high-tier-power-audit', 'email-20260813-power-01'],
        ['high-tier-desk-audit', 'email-20260813-desk-01']
    ]) {
        assert.equal(shareCopy.normalizeAcquisitionContentId(contentId), contentId);
        const link = new URL(buildCampaignLink({
            source: 'email',
            contentId,
            clickId,
            pathname: '/monitor',
            campaign: 'high-tier-filing-pilot-2026-08'
        }));
        assert.equal(link.origin, 'https://www.stockportfolio.pro');
        assert.equal(link.pathname, '/monitor');
        assert.equal(link.searchParams.get('source'), 'email');
        assert.equal(link.searchParams.get('content_id'), contentId);
        assert.equal(link.searchParams.get('click_id'), clickId);
        assert.equal(link.searchParams.get('utm_medium'), 'email');
        assert.equal(link.searchParams.get('utm_campaign'), 'high-tier-filing-pilot-2026-08');
    }

    assert.equal(shareCopy.normalizeAcquisitionContentId('high-tier-unknown-audit'), null);
    assert.throws(() => buildCampaignLink({
        source: 'email',
        contentId: 'high-tier-power-audit',
        clickId: 'email-20260813-power-02',
        pathname: '/admin/monitor',
        campaign: 'high-tier-filing-pilot-2026-08'
    }), /approved tool, research page, \/monitor, or \/appsumo/);
});

test('high-tier monitor attribution survives as a signed anonymous acquisition cookie', () => {
    const contentId = 'high-tier-desk-audit';
    const clickId = 'email-20260813-desk-02';
    const value = shareCopy.createAcquisitionCookieValue('email', {
        secret: SECRET,
        now: NOW,
        clickId,
        contentId
    });
    const parsed = shareCopy.parseAcquisitionCookieHeader(
        `${shareCopy.ACQUISITION_COOKIE_NAME}=${encodeURIComponent(value)}`,
        { secret: SECRET, now: NOW }
    );

    assert.deepEqual(parsed, {
        source: 'email',
        clickId,
        contentId,
        clickedAt: new Date(NOW)
    });
    assert.doesNotMatch(value, /@|email address|user|name/i);
});

test('registration and Stripe checkout consume the signed acquisition cookie', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const subscribeStart = source.indexOf("app.post('/api/subscribe'");
    const socialStart = source.indexOf("app.post('/api/auth/social'");
    const checkoutStart = source.indexOf("app.post('/api/checkout'");
    const subscribe = source.slice(subscribeStart, socialStart);
    const social = source.slice(socialStart, checkoutStart);

    assert.match(subscribe, /parseAcquisitionCookieHeader\(req\.headers\.cookie/);
    assert.match(subscribe, /trackFunnel\('signup_completed'[\s\S]*acquisitionFunnelFields\(acquisition\)/);
    assert.match(subscribe, /createCheckoutSessionForUser\(user,[\s\S]*acquisitionStripeMetadata\(acquisition\)/);
    assert.match(social, /parseAcquisitionCookieHeader\(req\.headers\.cookie/);
    assert.match(social, /createCheckoutSessionForUser\(user,[\s\S]*acquisitionStripeMetadata\(acquisition\)/);
});
