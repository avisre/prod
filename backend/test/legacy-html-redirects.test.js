'use strict';

// One canonical URL per public page (shipped 2026-09-28).
//
// `express.static(frontendV2, { extensions: ['html'] })` answers every page at
// BOTH /<name> and /<name>.html: the extension fallback resolves the file, it does
// not redirect. So each public page had a second URL that no sitemap listed, that
// duplicated its <title> and description exactly, and that three pages left
// canonical-less — and the site's own link graph pointed at 72 of them, which is
// what Bing's Site Scan read back as "identical titles / identical descriptions".
//
// The fix is a table of exact 301s in app.js. Never /(.+)\.html$/: the 17 noindex
// private twins keep both spellings, and /profile.html is the *target* of the
// /inbox 301. These tests hold both ends of it — the table stays complete as pages
// are added, and the link graph stops feeding the duplicates.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const seo = require('../seo-pages');

const BACKEND = path.join(__dirname, '..');
const V2 = path.join(BACKEND, '..', 'frontend-v2');
const APP = fs.readFileSync(path.join(BACKEND, 'app.js'), 'utf8');

// Pages that deliberately keep both spellings: they carry <meta robots noindex>,
// never enter an index, and /upgrade + /recharge deep-link ?next=%2Fupgrade.html —
// rewriting those would risk auth flows for no ranking gain.
const isNoindex = (htmlPage) => {
    for (const m of htmlPage.slice(0, 4000).matchAll(/<meta\b[^>]*>/gi)) {
        if (/name=["']robots["']/i.test(m[0]) && /noindex/i.test(m[0])) return true;
    }
    return false;
};

const files = fs.readdirSync(V2).filter((f) => f.endsWith('.html')).sort();
const html = new Map(files.map((f) => [f, fs.readFileSync(path.join(V2, f), 'utf8')]));
const indexable = files.filter((f) => !isNoindex(html.get(f)));
const noindex = files.filter((f) => isNoindex(html.get(f)));
const cleanRoute = (file) => (file === 'index.html' ? '/' : '/' + file.replace(/\.html$/, ''));

// The two twins whose pages are not files: /verify-ledger and /filing-changes are
// served by dual-path route arrays in app.js, so nothing derivable from
// frontend-v2 can see them. Both answered 200 beside their clean route when
// measured live 2026-09-28, and /verify-ledger is in core.xml — a duplicate with a
// sitemap row, which is the exact pair Bing flags. Deleting the `.html` entry from
// those arrays instead would 404 a URL that is live today.
const ROUTE_ONLY_TWINS = ['/verify-ledger.html', '/filing-changes.html'];

// The shipped table, extracted and evaluated rather than restated — the
// profile-consolidation idiom. A copy here would drift from what runs.
const tableAt = APP.indexOf('const HTML_TWIN_REDIRECTS = ');
const tableEnd = APP.indexOf('\n};', tableAt);
assert.ok(tableAt > 0 && tableEnd > tableAt, 'HTML_TWIN_REDIRECTS not found in app.js');
const TABLE = eval('(' + APP.slice(APP.indexOf('{', tableAt), tableEnd + 2) + ')');
const TARGETS = [...new Set(Object.values(TABLE))];

test('the twin table is registered before express.static and before the paywall', () => {
    const staticAt = APP.indexOf("express.static(path.join(__dirname, '../frontend-v2')");
    const wallAt = APP.indexOf('app.use(wallAllPagesMiddleware)');
    assert.ok(staticAt > 0 && wallAt > 0, 'both mounts still exist');
    assert.ok(tableAt < staticAt, 'static would answer the .html spelling 200 before the 301 could');
    // The wall 302s anonymous visitors to /register.html and inactive ones to
    // /upgrade.html. Both are wall-exempt prefixes, so the traced chain is
    // /ask.html -> 301 /ask -> wall 302 /register.html -> 301 /register -> 200:
    // it terminates rather than looping, but only because the table runs first.
    assert.ok(tableAt < wallAt, 'the 301 must precede the paywall');
});

test('every indexable page redirects its .html twin to the clean route', () => {
    for (const file of indexable) {
        assert.equal(TABLE['/' + file], cleanRoute(file), `/${file} must 301 to ${cleanRoute(file)}`);
    }
});

test('every indexable page declares its own canonical URL', () => {
    // The table above makes the clean route win, but a page carrying no canonical
    // at all leaves the choice to the crawler. /verify, /partners and
    // /partners-apply shipped that way — and were added to core.xml on 2026-09-28,
    // so the sitemap named three pages that never stated their own URL. Reusing
    // the file-derived list means a new page cannot quietly join them.
    for (const file of indexable) {
        const canonical = html.get(file).match(/<link rel="canonical" href="([^"]+)"/);
        assert.ok(canonical, `${file} must declare a canonical`);
        assert.equal(canonical[1], 'https://www.stockportfolio.pro' + cleanRoute(file),
            `${file} must canonicalise to its own clean route, not to a twin or another page`);
    }
});

test('the table is exactly the indexable pages plus the two fileless twins', () => {
    const expected = [...indexable.map((f) => '/' + f), ...ROUTE_ONLY_TWINS].sort();
    assert.deepEqual(Object.keys(TABLE).sort(), expected,
        'adding an indexable page, or a dual-path app.get([...]) array, without an entry here ' +
        'ships another duplicate URL — that is the defect this file exists to catch');
});

test('no dual-path route array serves a .html spelling the table misses', () => {
    const served = new Set();
    // Anchored on the handler signature, not just the array: the comment above
    // HTML_TWIN_REDIRECTS quotes an `app.get(['/x', '/x.html'])` example, and a
    // loose scan reads the documentation as if it were a route.
    for (const m of APP.matchAll(/app\.get\(\[\s*((?:'[^']*'\s*,\s*)+'[^']*')\s*\],\s*(?:async\s*)?\(?req/g)) {
        for (const p of m[1].matchAll(/'([^']+\.html)'/g)) served.add(p[1]);
    }
    // Ask, screener and company still list their .html half; it is unreachable
    // behind the 301 and pinned by ask-page.test.js, so it stays.
    assert.ok(served.size >= 3, 'the scan must find the known arrays');
    for (const p of served) {
        assert.ok(Object.hasOwn(TABLE, p), `${p} is served 200 by a route array with no redirect entry`);
    }
});

test('the table cannot be reached through Object.prototype', () => {
    for (const p of ['/constructor', '/toString', '/hasOwnProperty', '/__proto__', '/valueOf']) {
        assert.equal(Object.hasOwn(TABLE, p), false, `${p} must not be a table key`);
    }
    assert.match(APP, /Object\.hasOwn\(HTML_TWIN_REDIRECTS, req\.path\)/,
        'a bare lookup would resolve /constructor to Object.prototype.constructor and "redirect" to a function');
});

test('the redirect is GET-only, permanent, and preserves the query string', () => {
    const body = APP.slice(tableAt, tableAt + 2000);
    assert.match(body, /if \(req\.method !== 'GET'\) return next\(\)/, 'POSTs to a twin must still reach the route');
    assert.match(body, /res\.redirect\(301, HTML_TWIN_REDIRECTS\[req\.path\] \+ qs\)/);
    // originalUrl.slice, not querystring.stringify(req.query): ?plan=, ?symbol= and
    // the array-valued screening params must arrive as sent.
    assert.match(body, /req\.originalUrl\.slice\(req\.path\.length\)/);
    assert.ok(!/stringify\(req\.query\)/.test(body), 'rebuilding the query drops repeated params');
});

test('every redirect target is a page that exists, and is not itself a redirect', () => {
    for (const to of TARGETS) {
        assert.equal(Object.hasOwn(TABLE, to), false, `a 301 must not land on another 301 (${to})`);
        const file = to === '/' ? 'index.html' : to.slice(1) + '.html';
        if (fs.existsSync(path.join(V2, file))) continue;
        assert.ok(ROUTE_ONLY_TWINS.some((t) => TABLE[t] === to),
            `${to} has no ${file} and is not a known fileless route — a 301 to a 404 is worse than a duplicate`);
    }
});

test('/pricing answers a permanent redirect, not a temporary one', () => {
    const at = APP.indexOf("app.get('/pricing'");
    assert.ok(at > 0, '/pricing route still exists');
    assert.match(APP.slice(at, at + 200), /res\.redirect\(301,/,
        'a 302 tells Bing the move is temporary, so /pricing keeps competing with /#pricing');
});

test('core.xml lists every redirect target except the deliberately unlisted skeleton', () => {
    // /company is not advertised: bare /company is a JS-only skeleton that nothing
    // links, and /stocks/:symbol already covers per-symbol pages.
    const UNSITEMAPPED = new Set(['/company']);
    const locs = new Set([...seo.buildSitemapShard('core').matchAll(/<loc>([^<]+)<\/loc>/g)]
        .map((m) => m[1].replace('https://www.stockportfolio.pro', '')));
    for (const to of TARGETS) {
        if (UNSITEMAPPED.has(to)) continue;
        assert.ok(locs.has(to), `${to} takes a 301 from ${to}.html but is in no sitemap shard`);
    }
});

test('no indexable page names a twin spelling anywhere — not just in an anchor', () => {
    // Anywhere, because the first sweep of this fix covered `href` only and
    // missed two served-markup references a crawler reads just as happily: the
    // homepage's JSON-LD SearchAction target and a navigation string in gurus.html.
    const twins = indexable.map((f) => f.replace(/\.html$/, ''));
    const rx = new RegExp('/(?:' + twins.join('|') + ')\\.html\\b');
    for (const file of indexable) {
        const lines = html.get(file).split('\n');
        for (let i = 0; i < lines.length; i++) {
            assert.ok(!rx.test(lines[i]), `${file}:${i + 1} still names a retired twin: ${lines[i].trim().slice(0, 120)}`);
        }
    }
});

test('no module hands a reader a twin URL', () => {
    // A twin followed by ? or # is a URL someone follows — an alert email, a
    // share link, the paywall's own 302 target — never a file path, because a
    // path carries no query. Anchoring on that caught the wall's two-hop
    // /register.html hop and four alert-email URLs after the href sweep was
    // already thought done.
    const twins = indexable.map((f) => f.replace(/\.html$/, ''));
    const rx = new RegExp('/(?:' + twins.join('|') + ')\\.html[?#]');
    for (const name of fs.readdirSync(BACKEND)) {
        if (!name.endsWith('.js')) continue;
        const lines = fs.readFileSync(path.join(BACKEND, name), 'utf8').split('\n');
        for (let i = 0; i < lines.length; i++) {
            assert.ok(!rx.test(lines[i]), `${name}:${i + 1} still emits a twin URL: ${lines[i].trim().slice(0, 120)}`);
        }
    }
});

test('links from an indexable page into a noindex page carry rel="nofollow"', () => {
    const names = noindex.map((f) => f.replace(/\.html$/, ''));
    // Both spellings: repointing a link does not make it any less of an
    // advertisement that the noindex page exists.
    const rx = new RegExp('href="/(' + names.join('|') + ')(?:\\.html)?(?:[?"#]|$)', 'i');
    // Linkers, not targets: a noindex page linking another noindex page
    // advertises nothing, because neither is in an index to begin with.
    const pages = indexable.map((f) => [f, html.get(f)]);
    // Only full-page renderers, so an email body or a redirect template that
    // happens to echo a path is not held to an HTML-crawl rule.
    for (const name of fs.readdirSync(BACKEND)) {
        if (!name.endsWith('.js') || name === 'app.js') continue;
        const body = fs.readFileSync(path.join(BACKEND, name), 'utf8');
        if (body.includes('<body')) pages.push([name, body]);
    }
    pages.push(['app.js', APP]);
    // Served markup only. The one exemption is app.js's activation confirmation
    // string — `<a href="/onboarding">` built inside show('ok', ...) after a
    // successful POST /api/appsumo/activate, so it exists only in the DOM of a
    // buyer who just unlocked Pro and never in the HTML a crawler reads. Exempted
    // by exact snippet rather than by loosening the rule for everything near it.
    const NOT_SERVED = new Set(['<a href="/onboarding">']);
    for (const [name, body] of pages) {
        for (const m of body.matchAll(/<a\b[^>]*>/g)) {
            if (NOT_SERVED.has(m[0])) continue;
            if (!rx.test(m[0])) continue;
            assert.match(m[0], /rel="[^"]*nofollow/,
                `${name} links a noindex page without nofollow: ${m[0].replace(/\s+/g, ' ').slice(0, 110)}`);
        }
    }
});

test('the comparison footer does not advertise the app-shell demo', () => {
    // /demo 302s to the noindex dashboard?demo=1 and sat in a footer rendered on
    // ~5,887 comparison URLs — the largest single source of card-4 links. The
    // indexable demo page is /monitor-demo, and it is in the sitemap.
    const cmp = fs.readFileSync(path.join(BACKEND, 'comparison-pages.js'), 'utf8');
    const demos = [...cmp.matchAll(/<a\b[^>]*href="\/demo"[^>]*>/g)].map((m) => m[0]);
    assert.ok(demos.length > 0, 'the footer/CTA demo links still exist');
    for (const tag of demos) {
        assert.match(tag, /rel="[^"]*nofollow/, `comparison page demo link without nofollow: ${tag.slice(0, 110)}`);
    }
});
