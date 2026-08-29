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
