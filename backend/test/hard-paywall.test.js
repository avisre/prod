'use strict';

// 1-week hard-paywall experiment (2026-09): WALL_ALL_PAGES puts every page —
// SSR (stocks, compare, company, screener, methodology, homepage) and static
// .html — behind an active subscription, a live trial, or an AppSumo/lifetime
// grant. This file pins the wall's source wiring: flag-gated (default off),
// mounted ahead of the SSR cache, page-scoped (assets/robots/sitemaps/API
// exempt), anonymous → register.html, signed-in-inactive → upgrade.html, and
// crawlers exempt through bot-blocker's classifier rather than any UA string of
// its own. That last one is a correction, not a feature: the 2026-09-15 run
// walled crawlers too, and Google dropped ~6,600 URLs from the index in four
// days (Search Console: indexed 16,574 on 09-04 → 9,940 on 09-21).

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
    // The geo and hosting walls (geo-wall.test.js, hosting-wall.test.js) keep
    // the wall up for their visitors even with the flag off; everyone else
    // passes straight through.
    assert.match(section, /if \(!WALL_ALL_PAGES && !walled\) return next\(\);/);
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

test('every page bot-blocker sends a refused crawler to is reachable through the wall', () => {
    // bot-blocker.js answers a refused crawler with a body ending in "...available:
    // /licensing" or ".../api", and exempts those two paths itself so the denial
    // isn't a dead end. The wall must not re-create the dead end. Parsed from the
    // array literal and evaluated the way wallPathIsExempt does it — path ===
    // prefix || path.startsWith(prefix) — so narrowing a prefix (e.g. '/api' →
    // '/api/' for JSON-only) fails here instead of silently walling the landing page.
    const section = wallSection();
    const literal = section.slice(section.indexOf('WALL_PAGE_EXEMPT_PREFIXES = ['));
    const prefixes = [...literal.slice(0, literal.indexOf('];')).matchAll(/'(\/[A-Za-z0-9._-]*)'/g)].map((m) => m[1]);
    const reachable = (p) => prefixes.some((prefix) => p === prefix || p.startsWith(prefix));
    assert.ok(reachable('/licensing'), '/licensing stays reachable');
    assert.ok(reachable('/api'), '/api (developer landing page) stays reachable');
});

test('no user-agent special-casing in the region wall, and only the crawler claim in the hosting wall', () => {
    // The point of this test is that a visitor cannot UA their way past the
    // wall. That still holds — the region half never looks at the UA, and the
    // hosting half's single UA branch exempts ONLY a crawler claim
    // (bot-blocker.classifyUa -> 'allowed-claim'/'internal'), which a browser
    // UA never produces: it classifies as 'unknown' and is checked normally.
    // That exemption is not optional. Googlebot and Bingbot crawl from Google
    // and Microsoft cloud ranges, which are in the hosting table, so without
    // it the wall would answer them with a 302 to /upgrade.html and deindex
    // the site. Forged bot claims are refused by bot-blocker's reverse-DNS
    // verification, which runs ahead of the wall.
    const section = wallSection();
    const region = section.slice(section.indexOf('// ---- Geo wall'), section.indexOf('// ---- Hosting/VPN wall'));
    assert.ok(region.length > 0, 'region wall section found');
    assert.doesNotMatch(region, /user-agent|userAgent|User-Agent/i);
    // Ends at the page wall, which has its own (separately tested) claim check.
    // Without this bound the slice would reach it and count two UA branches.
    const hosting = section.slice(section.indexOf('// ---- Hosting/VPN wall'), section.indexOf('async function wallAllPagesMiddleware'));
    // Lines, not occurrences: the single branch tests the claim twice
    // ('allowed-claim' or 'internal'), so counting matches would read as two.
    const uaBranches = hosting.split('\n').filter((line) => /claim ===/.test(line));
    assert.equal(uaBranches.length, 1, 'exactly one UA branch, the crawler exemption');
    assert.match(hosting, /if \(claim === 'allowed-claim' \|\| claim === 'internal'\) return false;/);
    // The wall delegates to bot-blocker's classifier rather than naming UAs
    // itself, so the two can never drift about who counts as a crawler.
    const code = hosting.replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(code, /googlebot|bingbot|headless|curl|wget/i, 'no UA string matching in the wall');
    assert.doesNotMatch(code, /ALLOWED_UA_RE|DENY_PATTERNS/);
});

test('the page wall serves a crawler the page, not the 302', () => {
    // The 2026-09-15 experiment walled crawlers along with everyone else. Google
    // responded by dropping ~6,600 URLs — the sitemap's whole /stocks, /compare,
    // /metrics surface — and unlike the wall that caused it, that cost does not
    // lift when the flag is unset: re-indexing waits on a crawl schedule. So the
    // exemption is asserted here, and asserted to run BEFORE the flag test, or
    // re-arming the experiment re-creates the same bill.
    const section = wallSection();
    const wall = section.slice(section.indexOf('async function wallAllPagesMiddleware'));
    assert.match(wall, /const crawlerClaim = botBlocker\.classifyUa\(\(req\.headers \|\| \{\}\)\['user-agent'\]\);/);
    assert.match(wall, /if \(crawlerClaim === 'allowed-claim' \|\| crawlerClaim === 'internal'\) return next\(\);/);

    const claimAt = wall.indexOf('crawlerClaim');
    const flagAt = wall.indexOf('if (!WALL_ALL_PAGES && !walled)');
    assert.ok(claimAt > -1 && flagAt > -1 && claimAt < flagAt,
        'the crawler check precedes the WALL_ALL_PAGES test, so it holds in both states');

    // Not a UA bypass: it delegates to bot-blocker's classifier instead of
    // matching a UA string, so only what bot-blocker admits as a crawler is
    // exempt, and bot-blocker verifies that claim by reverse DNS ahead of here.
    const code = wall.replace(/\/\/[^\n]*/g, '');
    assert.doesNotMatch(code, /googlebot|bingbot|headless|curl|wget/i, 'no UA string matching in the page wall');
    assert.doesNotMatch(code, /ALLOWED_UA_RE|DENY_PATTERNS/);
});