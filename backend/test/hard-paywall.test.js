'use strict';

// 1-week hard-paywall experiment (2026-09): WALL_ALL_PAGES puts every page —
// SSR (stocks, compare, company, screener, methodology, homepage) and static
// .html — behind an active subscription, a live trial, or an AppSumo/lifetime
// grant. This file pins the wall's source wiring: flag-gated (default off),
// mounted ahead of the SSR cache, page-scoped (assets/robots/sitemaps/API
// exempt), anonymous → register.html, signed-in-inactive → upgrade.html, and
// no user-agent special-casing (crawlers walled like humans — no cloaking).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = () => fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function wallSection() {
    const source = appSource();
    const start = source.indexOf('WALL_PAGE_EXEMPT_PREFIXES');
    const end = source.indexOf("app.use(wallAllPagesMiddleware)");
    assert.ok(start > -1 && end > start, 'wall middleware block exists');
    return source.slice(start, end);
}

test('WALL_ALL_PAGES flag exists, opt-in, and defaults off when unset', () => {
    // `=== 'true'` means an unset var (or any other value) keeps the site open —
    // the revert is "unset the env var", with no redeploy needed.
    assert.match(appSource(), /const WALL_ALL_PAGES = process\.env\.WALL_ALL_PAGES === 'true';/);
});

test('wall middleware is mounted ahead of the SSR cache so no walled page is ever cached', () => {
    const source = appSource();
    const wallMount = source.indexOf('app.use(wallAllPagesMiddleware)');
    const cacheMount = source.indexOf('app.use(ssrCacheMw)');
    assert.ok(wallMount > -1, 'wall middleware is mounted');
    assert.ok(cacheMount > -1, 'ssrCacheMw is mounted');
    assert.ok(wallMount < cacheMount, 'wall mounts before ssrCacheMw');
});

test('wall skips non-GET/HEAD requests and passes through instantly when the flag is off', () => {
    const section = wallSection();
    assert.match(section, /if \(!WALL_ALL_PAGES\) return next\(\);/);
    assert.match(section, /if \(req\.method !== 'GET' && req\.method !== 'HEAD'\) return next\(\);/);
});

test('auth, legal, redemption, and buy pages stay reachable through the wall', () => {
    const section = wallSection();
    // signup/signin + password reset + legal + support
    for (const prefix of ['/register', '/login', '/forgot-password', '/reset-password',
        '/privacy', '/terms', '/support']) {
        assert.ok(section.includes(`'${prefix}'`), `exempt: ${prefix}`);
    }
    // existing customers: AppSumo + DealMirror redemption, lifetime/upgrade/recharge buys
    for (const prefix of ['/appsumo', '/dealmirror', '/lifetime', '/upgrade', '/recharge']) {
        assert.ok(section.includes(`'${prefix}'`), `exempt: ${prefix}`);
    }
    // infrastructure: API keeps its own per-route gates; robots/sitemaps stay
    // public so re-indexing after the experiment is fast.
    for (const prefix of ['/api', '/admin', '/robots.txt', '/sitemap.xml', '/sitemaps', '/assets']) {
        assert.ok(section.includes(`'${prefix}'`), `exempt: ${prefix}`);
    }
    // Non-page endpoints and attribution redirects that must survive the wall:
    // /stripe/config carries signupTrialDays (walling it kills the trial card
    // unhide), /mcp + /oauth are machine legs that authenticate or meter every
    // call, /go and /go/appsumo/:source are cookie-setting redirects.
    for (const prefix of ['/stripe', '/mcp', '/oauth', '/.well-known', '/go']) {
        assert.ok(section.includes(`'${prefix}'`), `exempt: ${prefix}`);
    }
});

test('page requests redirect: anonymous to register, signed-in-inactive to upgrade', () => {
    const source = appSource();
    // Anonymous (no/invalid token) must never touch the DB on the way out.
    const section = wallSection();
    assert.match(section, /if \(!token\) return wallRedirect\(res, '\/register\.html'\);/);
    assert.match(section, /if \(!subscriptionIsActive\(normalized\)\) return wallRedirect\(res, '\/upgrade\.html'\);/);
    // 302 + no-store so no shared/proxy layer ever caches the wall decision.
    assert.match(source, /function wallRedirect\(res, target\) \{\s*res\.set\('Cache-Control', 'no-store'\);\s*return res\.redirect\(302, target\);\s*\}/);
});

test('expired no-card trials are caught by the wall via ensureSubscriptionShape on read', () => {
    const section = wallSection();
    // ensureSubscriptionShape self-expires trialing subs whose trialEndsAt has
    // passed (app.js comp/trial guard), so the wall needs no own expiry logic.
    assert.match(section, /const normalized = ensureSubscriptionShape\(user\);/);
    assert.match(section, /subscriptionIsActive\(normalized\)/);
});

test('affiliate referral links stay open while the public research library stays walled', () => {
    const section = wallSection();
    // /r/<amb-slug> records the referral click, sets the cookie, and redirects.
    assert.match(section, /if \(pathname\.startsWith\('\/r\/amb-'\)\) return true;/);
    // /r/<publicId> serves an actual research report — content — so the carve-out
    // must stay exactly one slug prefix wide: no bare /r or /r/ exemption.
    assert.ok(!section.includes("'/r'"), 'no bare /r prefix exemption');
    assert.ok(!section.includes("'/r/'"), 'no blanket /r/ prefix exemption');
});

test('no user-agent special-casing in the wall — crawlers get the same 302 as humans', () => {
    const section = wallSection();
    assert.doesNotMatch(section, /user-agent|userAgent|User-Agent/i);
});