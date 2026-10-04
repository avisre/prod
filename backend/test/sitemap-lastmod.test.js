'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const seo = require('../seo-pages');

const MANIFEST = path.join(__dirname, '..', '..', 'frontend', 'data', 'fundamentals-changed.json');
const SNAPSHOT_FALLBACK = '2026-07-19';

// The defect these guard, fixed 2026-09-28: <lastmod> was clamped to a hard-coded
// snapshot date for any data file whose mtime was <= seo-pages.js's own mtime + 1h.
// On a git-checkout deploy EVERY file gets the checkout timestamp, so the clamp
// fired unconditionally and lastmod could never advance. 20,283 of 21,797 URLs sat
// frozen at 2026-07-19 while the page bodies rendered a current date -- the site
// contradicting itself about its own freshness, and Bing scheduling recrawls from
// lastmod. The existing "dates.size > 1" assertion could not catch this, because
// core.xml alone supplies a second distinct date.
//
// The fix reads a committed manifest that refresh-fundamentals.js writes, so a
// plain code deploy no longer moves or freezes the date, and a real data refresh
// does.

function readManifest() {
    assert.ok(fs.existsSync(MANIFEST),
        `${MANIFEST} is missing. refresh-fundamentals.js writes it and backend/seo-pages.js ` +
        'reads it for <lastmod>; without it every data-driven URL falls back to the frozen ' +
        `snapshot date ${SNAPSHOT_FALLBACK}.`);
    return JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
}

test('lastmod is derived from the data manifest, not from file mtimes', () => {
    const manifest = readManifest();
    const manifestDay = String(manifest.generatedAt || '').slice(0, 10);
    assert.match(manifestDay, /^\d{4}-\d{2}-\d{2}$/, 'the manifest must carry a usable generatedAt');

    const symbols = manifest.symbols || {};
    // Per-symbol date when one is recorded, else the manifest-wide refresh date.
    assert.equal(seo.dataDateFor('AAPL'),require('../public-stock-index').get('AAPL').lastmod);

    // The load-bearing part: this must NOT be the frozen fallback. On a git
    // checkout the fundamentals file's mtime is "now", so an mtime-derived answer
    // would differ from the manifest date -- and the old clamp would return the
    // snapshot date outright.
    assert.notEqual(seo.dataDateFor('AAPL'), SNAPSHOT_FALLBACK,
        'while the manifest exists, data-driven lastmod must never fall back to the ' +
        'hard-coded snapshot date');
});

test('the deploy-mtime clamp is gone from the source', () => {
    // A source-text guard, matching the style of robots-policy.test.js. If someone
    // reintroduces the clamp, every data-driven lastmod silently freezes again on
    // the next git-checkout deploy -- the exact failure this replaced.
    const source = fs.readFileSync(require.resolve('../seo-pages'), 'utf8');
    assert.doesNotMatch(source, /SITEMAP_DEPLOY_MS/,
        'reintroducing the deploy-mtime clamp re-freezes every data-driven lastmod');
});

test('a sitemap shard dates a ticker exactly as the page body does', () => {
    // The visible symptom was self-contradiction: the sitemap advertised
    // /stocks/AAPL/shares-outstanding as 2026-07-19 while the rendered page said
    // it had been updated that same week.
    const xml = seo.buildSitemapShard('metrics-1');
    const entry = [...xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)]
        .find((m) => /\/stocks\/AAPL\//.test(m[1]));
    assert.ok(entry, 'AAPL must appear in the metrics-1 shard');
    assert.equal(entry[2], seo.dataDateFor('AAPL'),
        'the sitemap and the page body must agree on the data date for the same ticker');
});

test('every ticker-derived sitemap entry retains its own genuine content date', () => {
    readManifest();

    // Every ticker-derived shard, whatever today's split happens to be — comparisons-2
    // and any future metrics-4 are covered without hardcoding a list that goes stale
    // the moment the inventory grows past another 5,000 URLs. `diffs-1` is deliberately
    // absent: its dates come from filing-change records, not from the fundamentals
    // manifest, so the manifest date need not appear in it. `core` is real file mtimes.
    const names = [...seo.buildSitemap().matchAll(/\/sitemaps\/([^<]+)\.xml/g)]
        .map((m) => m[1])
        .filter((name) => /^(metrics|stocks|comparisons)-\d+$/.test(name));
    assert.ok(names.length >= 4, `expected the ticker-derived shards; got ${names.join(', ')}`);

    for (const shard of names) {
        const xml = seo.buildSitemapShard(shard);
        const dates = new Set([...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]));
        assert.ok(dates.size > 0, `${shard} must carry lastmod values`);
        assert.ok(!dates.has(SNAPSHOT_FALLBACK),
            `${shard} still advertises the frozen snapshot date ${SNAPSHOT_FALLBACK}`);
        for (const entry of xml.matchAll(/<url>\s*<loc>([^<]+)<\/loc>\s*<lastmod>([^<]+)<\/lastmod>/g)) {
            const stock = entry[1].match(/\/stocks\/([^/]+)(?:\/|$)/);
            const comparison = entry[1].match(/\/compare\/([^/]+)-vs-([^/]+)$/);
            if (stock) assert.equal(entry[2], seo.dataDateFor(stock[1]), 'a quote refresh must not rewrite unrelated issuer dates');
            else if (comparison) {
                const expected = [seo.dataDateFor(comparison[1]), seo.dataDateFor(comparison[2])].sort().at(-1);
                assert.ok(entry[2] >= expected, 'comparison lastmod must include its latest changed issuer');
            }
        }
    }
});
