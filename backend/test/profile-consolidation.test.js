'use strict';

// Structural checks (same convention as test/paid-first-signup.test.js — see
// that file's header comment for why: app.js is an ~8800-line monolith that
// isn't worth booting a real server for) for consolidating Messages onto the
// Profile page behind the nav's person icon.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const appSource = fs.readFileSync(require.resolve('../app'), 'utf8');
const frontendAppSource = fs.readFileSync(require.resolve('../../frontend-v2/assets/app.js'), 'utf8');

test('/inbox.html redirects to /profile.html, registered before express.static', () => {
    // Express matches middleware/routes in registration order. inbox.html is
    // still a physical file — if the static mount ran first, it would serve
    // that file directly and this redirect would never fire for that exact
    // path, no matter where else in the file it was written.
    const redirectIdx = appSource.indexOf("res.redirect(301, '/profile.html')");
    const staticIdx = appSource.indexOf("express.static(path.join(__dirname, '../frontend-v2')");
    assert.ok(redirectIdx !== -1, 'the redirect route must exist');
    assert.ok(staticIdx !== -1, 'the frontend-v2 static mount must exist');
    assert.ok(redirectIdx < staticIdx, 'the redirect must be registered before static file serving, or it will never run');

    // Extract the actual regex literal from source and exercise it directly,
    // rather than text-matching its formatting — it must catch the bare
    // path, the trailing slash, and the literal .html, but nothing that
    // merely contains "inbox" as a substring (an unrelated /api/inbox.html
    // or /admin-inbox.html, which do exist elsewhere in this app).
    const m = appSource.match(/app\.get\((\/\^\\\/inbox[^,]+\/), \(req, res\) => res\.redirect\(301, '\/profile\.html'\)\)/);
    assert.ok(m, 'could not find the redirect route to extract its regex from');
    // eslint-disable-next-line no-eval -- reading our own already-loaded source, not untrusted input
    const re = eval(m[1]);
    for (const path of ['/inbox', '/inbox/', '/inbox.html', '/inbox.html/']) {
        assert.ok(re.test(path), `${path} should redirect`);
    }
    for (const path of ['/inboxfoo', '/admin-inbox.html', '/api/inbox.html']) {
        assert.ok(!re.test(path), `${path} should NOT match — it only contains "inbox" as a substring`);
    }
});

test('the customer-message reply email still links to /inbox.html (so the redirect above has a reason to exist)', () => {
    assert.match(appSource, /const inboxUrl = `\$\{appUrl\}\/inbox\.html`/);
});

test('nav: the person icon points at /profile.html, and the standalone desktop text link is gone', () => {
    assert.match(frontendAppSource, /class="nav-profile" href="\/profile\.html"/, 'the account icon must open the consolidated page');

    // Isolate just the desktop <nav class="nav-links"> block — the mobile
    // drawer (checked separately below) is a second, independent link list
    // in the same nav() function that legitimately DOES get its own Profile
    // entry (it has no icon to fall back on), so a whole-file check for
    // "no Profile link anywhere" would false-positive on that correct addition.
    const start = frontendAppSource.indexOf('<nav class="nav-links"');
    const end = frontendAppSource.indexOf('</nav>', start);
    assert.ok(start !== -1 && end !== -1);
    const desktopLinks = frontendAppSource.slice(start, end);
    assert.doesNotMatch(desktopLinks, /href="\/profile\.html"/, 'the old standalone "Profile" text link (redundant now the icon owns it) must be removed from the desktop list');
});

test('nav: the mobile drawer also points its account entry at /profile.html, not /inbox.html', () => {
    // The mobile drawer is a second, independently-written link list in the
    // same nav() function — it does not inherit from the desktop list, so
    // this is a distinct assertion, not a duplicate of the one above.
    assert.doesNotMatch(frontendAppSource, /href="\/inbox\.html"/, 'no remaining inbox.html reference in the frontend nav');
    assert.match(frontendAppSource, /authed \? `<a href="\/profile\.html"[^`]*>Profile<\/a>` : ''/, 'mobile drawer must link to profile.html');
});

test('nav() is idempotent — profile.html loads both profile.js and the bundled messages.js, and both call nav()', () => {
    assert.match(frontendAppSource, /if \(document\.querySelector\('header\.nav'\)\) return;/);
});

// ---------------------------------------------------------------------------
// Cache-busting. This is the guard for a bug that actually shipped: app.js was
// edited (removing a nav link, adding the idempotency guard above) without
// bumping its ?v= stamp. Because backend/app.js serves every .js/.css with
// `Cache-Control: max-age=31536000, immutable`, browsers kept running the OLD
// app.js for up to a year — so users still saw the removed nav item AND the
// duplicated header the guard was written to prevent. The fix is worthless if
// the stamp doesn't move with it.

const path = require('node:path');
const FRONTEND = path.join(__dirname, '../../frontend-v2');

// Every page that references the shared bundle — the static pages AND the
// server-rendered ones, which are easy to forget precisely because they aren't
// files in frontend-v2/.
function pagesReferencingSharedAssets() {
    const out = [];
    for (const f of fs.readdirSync(FRONTEND)) {
        if (f.endsWith('.html')) out.push([f, fs.readFileSync(path.join(FRONTEND, f), 'utf8')]);
    }
    for (const f of ['free-tools.js', 'comparison-pages.js', 'seo-pages.js', 'app.js', 'affiliate-dashboard.html']) {
        out.push([f, fs.readFileSync(path.join(__dirname, '..', f), 'utf8')]);
    }
    return out;
}

test('every page stamps app.js and system.css with the SAME version', () => {
    const stamps = new Map();   // stamp -> [where it was seen]
    for (const [name, src] of pagesReferencingSharedAssets()) {
        for (const m of src.matchAll(/assets\/(?:app\.js|system\.css)\?v=([\w.-]+)/g)) {
            if (!stamps.has(m[1])) stamps.set(m[1], []);
            if (!stamps.get(m[1]).includes(name)) stamps.get(m[1]).push(name);
        }
    }
    assert.ok(stamps.size > 0, 'expected to find versioned references to the shared assets');
    assert.equal(stamps.size, 1,
        'app.js/system.css must carry ONE stamp everywhere — a partial bump leaves some pages ' +
        'on a year-long immutable cache of the old bundle. Found: ' +
        JSON.stringify(Object.fromEntries(stamps)));
});

test('the shared-bundle stamp is not one of the known-stale values', () => {
    // Bumping is only meaningful if the value actually changes.
    const [, indexHtml] = pagesReferencingSharedAssets().find(([n]) => n === 'index.html');
    const stamp = indexHtml.match(/assets\/app\.js\?v=([\w.-]+)/)[1];
    for (const stale of ['20260826-onboarding1', '20260826-askchip1', '20260811-statement-table8']) {
        assert.notEqual(stamp, stale, `stamp is still ${stale} — it must change when app.js/system.css change`);
    }
});

// ---------------------------------------------------------------------------
// Nav appearance + the account dropdown.

const systemCss = fs.readFileSync(path.join(FRONTEND, 'assets/system.css'), 'utf8');

test('nav links are full-ink by default, not muted until active', () => {
    assert.match(systemCss, /\.nav-links a \{ color: var\(--ink\);/,
        'nav links must default to --ink (#1c1b18), not --ink-2 (#5f5c55)');
    assert.match(systemCss, /\.nav-dd-trigger \{ color: var\(--ink\);/,
        'the Ask AI trigger must match its sibling links');
    // The active page still has to be distinguishable without relying on colour.
    assert.match(systemCss, /\.nav-links a\[aria-current='page'\] \{[^}]*font-weight: 650;[^}]*border-bottom-color/);
});

test('account dropdown: markup, and the icon still degrades to a plain link', () => {
    assert.match(frontendAppSource, /class="nav-account-menu" id="v2-account-menu" role="menu"/);
    assert.match(frontendAppSource, /class="nav-profile" href="\/profile\.html" id="v2-account-trigger"/,
        'the trigger keeps its href so it works without JS and on mobile');
    assert.match(frontendAppSource, /aria-haspopup="menu" aria-expanded="false" aria-controls="v2-account-menu"/);
});

test('account dropdown only intercepts the click on desktop', () => {
    // .nav-links hides at 1180px; below that the mobile drawer owns navigation
    // and carries its own Profile entry, so the icon must keep navigating.
    const body = frontendAppSource.slice(frontendAppSource.indexOf('function mountAccountMenu'));
    assert.match(body, /matchMedia\('\(min-width: 1181px\)'\)/);
    const guardIdx = body.indexOf('if (!isDesktop()) return;');
    const preventIdx = body.indexOf('e.preventDefault();');
    assert.ok(guardIdx !== -1 && preventIdx !== -1);
    assert.ok(guardIdx < preventIdx,
        'the breakpoint check must come BEFORE preventDefault, or the link is dead on mobile');
});

test('account dropdown is mounted at most once, and reuses the existing session fetch', () => {
    assert.match(frontendAppSource, /if \(!trigger \|\| !menu \|\| menu\.dataset\.wired === '1'\) return;/);
    // trialBanner() already fetches /api/session and returns the payload; the
    // dropdown must consume that promise rather than issue a second request.
    assert.match(frontendAppSource, /const sessionPromise = trialBanner\(\);/);
    assert.match(frontendAppSource, /mountAccountMenu\(el\.querySelector\('#v2-account-trigger'\), el\.querySelector\('#v2-account-menu'\), sessionPromise\)/);
    const menuFn = frontendAppSource.slice(frontendAppSource.indexOf('function mountAccountMenu'));
    assert.doesNotMatch(menuFn.slice(0, menuFn.indexOf('\n    }\n')), /fetch\(`\$\{API\}\/session`/,
        'the dropdown must not fetch /api/session itself');
});

test('credit formatting is shared between the profile page and the dropdown, not duplicated', () => {
    const profileSource = fs.readFileSync(path.join(FRONTEND, 'assets/profile.js'), 'utf8');
    for (const fn of ['formatReset', 'activityLabel', 'creditSplit']) {
        assert.match(frontendAppSource, new RegExp(`function ${fn}\\(`), `${fn} should live in app.js`);
        assert.doesNotMatch(profileSource, new RegExp(`function ${fn}\\(`),
            `${fn} must not be redefined in profile.js — two copies of the covered>=used guard can drift`);
    }
    assert.match(profileSource, /const \{[^}]*formatReset, activityLabel, creditSplit[^}]*\} = window\.V2;/);
    assert.match(frontendAppSource, /markdown, nav, footer, formatReset, activityLabel, creditSplit,/,
        'the helpers must be exported on window.V2');
});
