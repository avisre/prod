'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');

const shareCopy = require('../share-copy');

const BASE = 'https://stockportfolio.pro';
const NOW = Date.UTC(2026, 6, 26, 12, 0, 0);
const SECRET = 'unit-test-cookie-secret-with-enough-entropy';

test('AppSumo campaign sources are allowlisted and aliases are canonicalized', () => {
    assert.equal(shareCopy.normalizeAppSumoSource(' X '), 'x');
    assert.equal(shareCopy.normalizeAppSumoSource('twitter'), 'x');
    assert.equal(shareCopy.normalizeAppSumoSource('bridge'), 'bridge');
    assert.equal(shareCopy.normalizeAppSumoSource('creator'), 'creator');

    for (const unsafe of ['', 'x/path', '../x', 'x?next=evil', '<script>', 'unknown']) {
        assert.equal(shareCopy.normalizeAppSumoSource(unsafe), null, unsafe);
    }
});

test('allowlisted landing source rewrites only the fixed bridge CTA', () => {
    const original = '<a href="/go/appsumo/bridge">Deal</a><p>/go/appsumo/not-bridge</p>';
    assert.equal(
        shareCopy.attributeAppSumoLandingHtml(original, 'twitter'),
        '<a href="/go/appsumo/x">Deal</a><p>/go/appsumo/not-bridge</p>'
    );
    assert.equal(shareCopy.attributeAppSumoLandingHtml(original, 'bridge'), original);
    assert.equal(shareCopy.attributeAppSumoLandingHtml(original, 'x/../../evil'), original);

    const landing = fs.readFileSync(path.join(__dirname, '../../frontend-v2/appsumo.html'), 'utf8');
    assert.match(landing, /\/go\/appsumo\/bridge/);
    const attributedLanding = shareCopy.attributeAppSumoLandingHtml(landing, 'reddit');
    assert.match(attributedLanding, /\/go\/appsumo\/reddit/);
    assert.doesNotMatch(attributedLanding, /\/go\/appsumo\/bridge/);
});

test('review asks require product use while stage-one onboarding does not', () => {
    assert.equal(shareCopy.shouldSendAppSumoReviewStage(1, 0), true);
    assert.equal(shareCopy.shouldSendAppSumoReviewStage(2, 0), false);
    assert.equal(shareCopy.shouldSendAppSumoReviewStage(3, 0), false);
    assert.equal(shareCopy.shouldSendAppSumoReviewStage(2, 1), true);
    assert.equal(shareCopy.shouldSendAppSumoReviewStage(3, 7), true);
    assert.equal(shareCopy.shouldSendAppSumoReviewStage(4, 100), false);
});

test('AppSumo redirect accepts only official HTTPS hosts and has a live fallback', () => {
    const direct = 'https://appsumo.com/products/stockportfoliopro/?utm_source=x';
    const tracked = 'https://go.appsumo.com/stockportfolio-pro?ref=partner';
    assert.equal(shareCopy.resolveAppSumoRedirect(direct), direct);
    assert.equal(shareCopy.resolveAppSumoRedirect(tracked), tracked);

    for (const unsafe of [
        'javascript:alert(1)',
        'http://appsumo.com/products/stockportfoliopro/',
        'https://appsumo.com.evil.example/deal',
        'https://user:password@appsumo.com/deal',
        'https://example.com/?next=https://appsumo.com'
    ]) {
        assert.equal(shareCopy.resolveAppSumoRedirect(unsafe), shareCopy.DEFAULT_APPSUMO_DEAL_URL, unsafe);
    }
});

test('acquisition cookie is signed, anonymous, cross-host first party, and expires', () => {
    const clickId = 'click_ID-123';
    const value = shareCopy.createAcquisitionCookieValue('reddit', { secret: SECRET, now: NOW, clickId });
    assert.match(value, /^v1\.reddit\.\d+\.click_ID-123\.[A-Za-z0-9_-]+$/);
    assert.doesNotMatch(value, /@|127\.0\.0\.1|email|user/i);

    const serialized = shareCopy.serializeAcquisitionCookie(value, {
        secure: true,
        domain: shareCopy.acquisitionCookieDomain('www.stockportfolio.pro')
    });
    assert.match(serialized, /^sp_as_acq=/);
    assert.match(serialized, /Max-Age=7776000/);
    assert.match(serialized, /HttpOnly/);
    assert.match(serialized, /SameSite=Lax/);
    assert.match(serialized, /Secure/);
    assert.match(serialized, /Domain=stockportfolio\.pro/);
    assert.equal(shareCopy.acquisitionCookieDomain('stockportfolio.pro'), 'stockportfolio.pro');
    assert.equal(shareCopy.acquisitionCookieDomain('attacker.example'), null);

    const parsed = shareCopy.parseAcquisitionCookieHeader(`session=abc; sp_as_acq=${encodeURIComponent(value)}`, {
        secret: SECRET,
        now: NOW + 60_000
    });
    assert.equal(parsed.source, 'reddit');
    assert.equal(parsed.clickId, clickId);
    assert.equal(parsed.clickedAt.toISOString(), new Date(NOW).toISOString());

    assert.equal(shareCopy.parseAcquisitionCookieHeader(`sp_as_acq=${value}x`, { secret: SECRET, now: NOW }), null);
    assert.equal(shareCopy.parseAcquisitionCookieHeader(`sp_as_acq=${value}`, { secret: 'wrong-secret', now: NOW }), null);
    assert.equal(shareCopy.parseAcquisitionCookieHeader(`sp_as_acq=${value}`, {
        secret: SECRET,
        now: NOW + (shareCopy.ACQUISITION_MAX_AGE_SECONDS + 1) * 1000
    }), null);
});

test('public share IDs are 96-bit URL-safe capability identifiers', () => {
    const ids = new Set(Array.from({ length: 500 }, () => shareCopy.makePublicShareId()));
    assert.equal(ids.size, 500);
    for (const id of ids) assert.equal(shareCopy.isPublicShareId(id), true);
    assert.equal(shareCopy.isPublicShareId('too-short'), false);
    assert.equal(shareCopy.isPublicShareId('aaaaaaaaaaaaaaaa/'), false);
});

test('public share creation has a deliberate per-IP hourly ceiling', () => {
    assert.equal(shareCopy.PUBLIC_SHARE_CREATE_LIMIT_PER_HOUR, 20);
    const appSource = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
    assert.match(appSource, /max:\s*shareCopy\.PUBLIC_SHARE_CREATE_LIMIT_PER_HOUR/);
    assert.match(appSource, /app\.use\('\/api\/research-shares',\s*researchShareCreateLimiter\)/);
});

test('public share input is plain text, bounded, and strips private URL data', () => {
    const normalized = shareCopy.normalizePublicResearchShare({
        title: '<img src=x onerror=alert(1)> ACME & Co',
        content: '<script>alert("x")</script>Revenue was <b>$12m</b>.\n\nFree cash flow was $3m.',
        sourceUrl: `${BASE}/company.html?token=secret&symbol=aapl#private`
    }, { publicBase: BASE });

    assert.equal(normalized.title, 'ACME & Co');
    assert.equal(normalized.content, 'Revenue was $12m.\n\nFree cash flow was $3m.');
    assert.equal(normalized.sourceUrl, `${BASE}/company.html?symbol=AAPL`);
    assert.doesNotMatch(`${normalized.title}\n${normalized.content}`, /<|>|script|onerror|alert/i);

    assert.equal(shareCopy.safePublicSourceUrl('https://evil.example/company.html?symbol=AAPL', BASE), null);
    assert.equal(shareCopy.safePublicSourceUrl(`${BASE}/dashboard.html?symbol=AAPL`, BASE), null);
    assert.equal(shareCopy.safePublicSourceUrl(`${BASE}/api/users/me?symbol=AAPL`, BASE), null);

    assert.throws(
        () => shareCopy.normalizePublicResearchShare({ content: 'too short' }, { publicBase: BASE }),
        (error) => error.status === 400
    );
    assert.throws(
        () => shareCopy.normalizePublicResearchShare({ content: 'x'.repeat(shareCopy.PUBLIC_SHARE_LIMITS.content + 1) }, { publicBase: BASE }),
        (error) => error.status === 413
    );
});

test('public report renderer escapes research, emits social metadata, and links the attributed CTA', () => {
    const id = 'AbCdEf0123_-xyZ9';
    const html = shareCopy.renderPublicResearchPage({
        publicId: id,
        title: '<img src=x onerror=alert(1)> Alpha & "Beta"',
        content: 'Cash < EBITDA & "quoted".\n\n<script>alert(2)</script>Verify the filing.',
        sourceUrl: `${BASE}/company.html?symbol=msft&token=secret`,
        createdAt: '2026-07-26T12:00:00.000Z'
    }, { publicBase: BASE });

    assert.match(html, /<meta property="og:title"/);
    assert.match(html, /<meta name="twitter:card" content="summary">/);
    assert.match(html, new RegExp(`<link rel="canonical" href="${BASE}/r/${id}">`));
    assert.match(html, /Alpha &amp; &quot;Beta&quot;/);
    assert.match(html, /Cash &lt; EBITDA &amp; &quot;quoted&quot;\./);
    assert.match(html, /company\.html\?symbol=MSFT/);
    assert.doesNotMatch(html, /token=secret|onerror|alert\(/i);
    assert.doesNotMatch(html, /<script\b/i);
    assert.match(html, new RegExp(`/go/appsumo/report\\?rid=${id}`));
    assert.match(html, /Unlisted public research/);
    assert.match(html, /Anyone with this unlisted URL can view this report/);
    assert.match(html, /noindex,nofollow,noarchive/);
});
