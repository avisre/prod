// The /docs section makes factual claims about prices, plans and features. This
// test is the thing that keeps them true.
//
// It exists because public-api.md drifted from the real prices for months and
// nothing noticed: its numbers were hand-written and no test ever read them
// back. So the assertions here deliberately parse the RENDERED HTML rather than
// inspecting the definitions — a doc page is wrong in the way that matters when
// the bytes a user receives are wrong, not when a source object disagrees.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const docs = require('../docs-pages');
const credits = require('../credits');

// The article body only — everything after the sidebar, which repeats all 18
// descriptions and would otherwise satisfy any substring check.
function article(html) {
    const i = html.indexOf('<div class="docs-main"');
    assert.ok(i > -1, 'no article region found');
    return html.slice(i);
}

const SLUGS = Object.keys(docs.DOC_PAGES);
const ALL = SLUGS.map((s) => [s, docs.renderDocPage(s)]);

test('every documented page renders', () => {
    assert.equal(SLUGS.length, 18, 'expected 18 doc pages');
    for (const [slug, html] of ALL) {
        assert.ok(html && html.length > 2000, `${slug} rendered nothing substantial`);
        assert.ok(html.startsWith('<!doctype html>'), `${slug} is not a full document`);
    }
});

test('the index links to every page, and each page is reachable from the sidebar', () => {
    const index = docs.renderDocsIndex();
    for (const page of Object.values(docs.DOC_PAGES)) {
        assert.ok(index.includes(`href="${page.path}"`), `index does not link ${page.path}`);
    }
    // The sidebar is built by topic; a page whose topic is missing from
    // TOPIC_ORDER would render but be unreachable from every other page.
    for (const page of Object.values(docs.DOC_PAGES)) {
        assert.ok(docs.TOPIC_ORDER.includes(page.topic), `topic "${page.topic}" is not in TOPIC_ORDER`);
    }
    const ask = docs.renderDocPage('ask');
    for (const page of Object.values(docs.DOC_PAGES)) {
        assert.ok(ask.includes(`href="${page.path}"`), `sidebar on /docs/ask omits ${page.path}`);
    }
});

test('titles, descriptions and canonicals are present and unique', () => {
    const canonicals = new Set();
    const titles = new Set();
    for (const [slug, html] of ALL) {
        const page = docs.DOC_PAGES[slug];
        const canonical = html.match(/<link rel="canonical" href="([^"]+)"/);
        assert.ok(canonical, `${slug} has no canonical`);
        assert.equal(canonical[1], `https://www.stockportfolio.pro${page.path}`, `${slug} canonical does not match its path`);
        assert.ok(!canonicals.has(canonical[1]), `duplicate canonical ${canonical[1]}`);
        canonicals.add(canonical[1]);

        const title = html.match(/<title>([^<]+)<\/title>/);
        assert.ok(title && title[1].trim().length > 10, `${slug} has no usable <title>`);
        assert.ok(!titles.has(title[1]), `duplicate <title> on ${slug}`);
        titles.add(title[1]);

        const desc = html.match(/<meta name="description" content="([^"]+)"/);
        assert.ok(desc && desc[1].trim().length > 30, `${slug} has no usable meta description`);
    }
});

test('every credit figure rendered is a real credits.COST value', () => {
    // Parsed out of the HTML, not read from the definitions: this is the check
    // that would have caught the public-api.md drift.
    const real = new Set(Object.values(credits.COST));
    const seen = [];
    for (const [slug, html] of [...ALL, ['index', docs.renderDocsIndex()]]) {
        for (const m of html.matchAll(/(\d+)\s+credits?\b/g)) {
            const n = Number(m[1]);
            assert.ok(real.has(n), `${slug} renders "${m[0]}", which is not a value in credits.COST`);
            seen.push(n);
        }
    }
    assert.ok(seen.length >= 10, 'expected the docs to quote prices; found almost none');
});

test('the credits page prices every metered action at its real cost', () => {
    const html = docs.renderDocPage('credits');
    const expected = {
        'Ask a question (web)': credits.COST.ask,
        'Research Dossier': credits.COST.dossier_standard,
        'Compare two dossiers': credits.COST.dossier_compare,
        'Filing Monitor report': credits.COST.monitor,
        'API data lookup': credits.COST.api_lookup,
        'API AI answer': credits.COST.api_ask,
        'MCP data lookup': credits.COST.mcp_lookup,
        'MCP AI answer': credits.COST.mcp_ask
    };
    for (const [label, cost] of Object.entries(expected)) {
        const row = new RegExp(`<td>${label.replace(/[()]/g, '\\$&')}</td><td>${cost} credits?</td>`);
        assert.match(html, row, `credits page does not price "${label}" at ${cost}`);
    }
});

test('the shared bundle carries the same stamp the rest of the site does', () => {
    const indexHtml = fs.readFileSync(path.join(__dirname, '../../frontend-v2/index.html'), 'utf8');
    const siteStamp = indexHtml.match(/assets\/system\.css\?v=([\w.-]+)/)[1];
    for (const [slug, html] of [...ALL, ['index', docs.renderDocsIndex()]]) {
        const stamps = [...html.matchAll(/assets\/(?:app\.js|system\.css)\?v=([\w.-]+)/g)].map((m) => m[1]);
        assert.equal(stamps.length, 2, `${slug} should reference system.css and app.js exactly once each`);
        for (const s of stamps) assert.equal(s, siteStamp, `${slug} is on stamp ${s}, the site is on ${siteStamp}`);
    }
});

test('an unknown slug renders nothing, so the route can 404', () => {
    assert.equal(docs.renderDocPage('nonsense'), null);
    assert.equal(docs.renderDocPage(''), null);
    // Object.prototype keys must not resolve to a page.
    assert.equal(docs.renderDocPage('constructor'), null);
    assert.equal(docs.renderDocPage('toString'), null);
});

test('the docs never author nav or footer markup, and never style it', () => {
    // The whole design constraint in one assertion: the chrome must be whatever
    // V2.nav/V2.footer inject, so the docs must emit neither the markup nor any
    // CSS that could shift it away from every other page.
    for (const [slug, html] of [...ALL, ['index', docs.renderDocsIndex()]]) {
        assert.ok(!/<header[\s>]/.test(html), `${slug} authors its own <header>`);
        assert.ok(!/<footer[\s>]/.test(html), `${slug} authors its own <footer>`);
        assert.ok(html.includes("V2.nav('');V2.footer();"), `${slug} does not inject the shared chrome`);
    }
    const src = fs.readFileSync(path.join(__dirname, '../docs-pages.js'), 'utf8');
    const style = src.match(/const STYLE = `([\s\S]*?)`\.replace/)[1];
    for (const selector of ['.nav', '.footer', '.nav-inner', '.footer-inner', '.wordmark']) {
        assert.ok(!style.includes(selector), `page-local CSS targets ${selector}, which belongs to the shared chrome`);
    }
});

test('the docs do not repeat claims the product does not support', () => {
    const all = [...ALL.map(([, h]) => h), docs.renderDocsIndex()].join('\n').toLowerCase();

    // Deep Dossier has no UI entry point (dossier.js only ever sends '', ?refresh=1,
    // ?poll=1) and the AI Paper Portfolio is dark behind two unset env flags.
    // Documenting either would sell something nobody can reach.
    assert.ok(!all.includes('deep dossier'), 'docs mention Deep Dossier, which has no UI entry point');
    assert.ok(!all.includes('paper portfolio'), 'docs mention the AI Paper Portfolio, which is not enabled');

    // ALLOW_ANON_AI=false and ANON_ASK_LIMIT=0 — Ask returns 401 ASK_AUTH when
    // signed out. ask.html still promises "no card needed"; the docs must not.
    // Scoped to the article, not the whole document: the sidebar repeats every
    // other page's description, and the free-tools one truthfully says those
    // need no account.
    const ask = article(docs.renderDocPage('ask')).toLowerCase();
    assert.ok(!/no (account|login|sign-?up|card) (needed|required)/.test(ask), 'the Ask page implies anonymous access works');
    assert.match(ask, /except dev|not the dev plan/, 'the Ask page does not mention the Dev plan restriction');
});

test('the Monitor page names pro-annual and does not promise it on Pro monthly', () => {
    const html = docs.renderDocPage('filing-monitor');
    assert.match(html, /Pro <em>annual<\/em>/, 'the Monitor page does not distinguish Pro annual');
    assert.match(html, /Pro <em>monthly<\/em> plan does not include it/, 'the Monitor page does not warn about Pro monthly');
    // The trial is real (3 companies/day) and users hit TRIAL_EXHAUSTED on it.
    assert.match(html, /three companies per day/);
});

test('every error code documented is one the server can actually emit', () => {
    const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
    for (const err of docs.DOC_PAGES.troubleshooting.errors) {
        if (err.code === 'Rate limited') continue;   // a condition, not a code string
        assert.ok(appSrc.includes(err.code), `troubleshooting documents ${err.code}, which app.js never sends`);
    }
});

test('/docs is exempt from the logged-out wall, and only by prefix', () => {
    const appSrc = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
    const block = appSrc.match(/const WALL_PAGE_EXEMPT_PREFIXES = \[([\s\S]*?)\];/);
    assert.ok(block, 'WALL_PAGE_EXEMPT_PREFIXES not found');
    const prefixes = [...block[1].matchAll(/'(\/[A-Za-z0-9._-]*)'/g)].map((m) => m[1]);
    assert.ok(prefixes.includes('/docs'), '/docs is walled — logged-out visitors cannot read the manual');
});

test('every page is in the sitemap', () => {
    const shard = require('../seo-pages').buildSitemapShard('core');
    for (const page of Object.values(docs.DOC_PAGES)) {
        assert.ok(shard.includes(`<loc>https://www.stockportfolio.pro${page.path}</loc>`), `${page.path} is missing from the core sitemap`);
    }
    assert.ok(shard.includes('<loc>https://www.stockportfolio.pro/docs</loc>'), '/docs hub is missing from the sitemap');
});

test('related links resolve, so no article is a dead end', () => {
    for (const page of Object.values(docs.DOC_PAGES)) {
        assert.ok(page.related && page.related.length, `${page.slug} has no related links`);
        for (const slug of page.related) {
            assert.ok(docs.DOC_PAGES[slug], `${page.slug} links to "${slug}", which does not exist`);
            assert.notEqual(slug, page.slug, `${page.slug} links to itself`);
        }
    }
});
