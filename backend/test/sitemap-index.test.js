'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const seo = require('../seo-pages');

const MANIFEST = path.join(__dirname, '..', '..', 'frontend', 'data', 'fundamentals-changed.json');
// The hard-coded fallback in seo-pages.js (`isoMtime`'s default, `SITEMAP_DATA_SNAPSHOT`).
// The 2026-09-28 bug left 21,272 of 21,780 live URLs sitting on exactly this date.
const FROZEN_SNAPSHOT = '2026-07-19';

test('sitemap root is a small index with valid, bounded child shards', () => {
  const index = seo.buildSitemap();
  assert.match(index, /<sitemapindex\b/);
  assert.ok(Buffer.byteLength(index) < 100_000, 'root sitemap must stay cheap to fetch and parse');
  const names = [...index.matchAll(/\/sitemaps\/([^<]+)\.xml/g)].map((m) => m[1]);
  assert.ok(names.length >= 4);
  assert.equal(new Set(names).size, names.length);
  let total = 0;
  const dates = new Set();
  for (const name of names) {
    const xml = seo.buildSitemapShard(name);
    assert.match(xml, /<urlset\b/);
    const count = (xml.match(/<url>/g) || []).length;
    assert.ok(count > 0 && count <= 5000, `${name} contains ${count} URLs`);
    total += count;
    const shardDates = new Set([...xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)].map((m) => m[1]));
    // Per shard, so the failure names the shard that went flat. A file that is
    // missing also falls back to this date, so an entirely-frozen shard is the
    // symptom of either a reintroduced clamp or a shard whose sources vanished.
    assert.ok(!shardDates.has(FROZEN_SNAPSHOT),
      `${name} advertises the frozen snapshot date ${FROZEN_SNAPSHOT} — its lastmod is coming ` +
      'from a constant rather than from real data or a real file, and Bing schedules recrawls from lastmod');
    for (const d of shardDates) dates.add(d);
  }
  assert.ok(total > 18_000, 'crawl-prioritized public inventory remains discoverable');
  // AppSumo sales were retired 2026-10-11; the landing page is noindex and unlisted.
  assert.doesNotMatch(seo.buildSitemapShard('core'), /<loc>https:\/\/www\.stockportfolio\.pro\/appsumo<\/loc>/);
  assert.equal((seo.buildSitemapShard('core').match(/<loc>https:\/\/www\.stockportfolio\.pro\/tools\//g) || []).length, 30);
  assert.equal((seo.buildSitemapShard('core').match(/<loc>https:\/\/www\.stockportfolio\.pro\/research\//g) || []).length, 7);
  // The inventory must be dated from the committed data manifest — not from a
  // constant, and not from file mtimes (a git-checkout deploy stamps every file with
  // the checkout time, which is how the original bug froze 97.7% of the inventory).
  //
  // This replaces `assert.ok(dates.size > 1, 'lastmod must vary across the inventory')`.
  // That was a coincidence detector, not an invariant: core.xml's dates are real file
  // mtimes while the data shards' come from the manifest, so the distinct-date count
  // was 2 only on days when those two disagree. When the refresh runs on the same day
  // the tree is checked out — which is what the weekly pipeline does, and what the
  // 2026-09-28 backfill did — every URL legitimately carries one date. Variation is
  // no longer asserted here; the per-shard freshness contract lives in
  // test/sitemap-lastmod.test.js and the frozen-date check above.
  assert.ok(fs.existsSync(MANIFEST),
    `${MANIFEST} is missing. refresh-fundamentals.js writes it and seo-pages.js reads it for ` +
    `<lastmod>; without it every data-driven URL falls back to ${FROZEN_SNAPSHOT}.`);
  const manifestDay = require('../public-stock-index').get('AAPL').lastmod;
  assert.match(manifestDay, /^\d{4}-\d{2}-\d{2}$/, 'the manifest must carry a usable generatedAt');
  assert.ok(dates.has(manifestDay),
    `the inventory must be dated from the data manifest (${manifestDay}); got ` +
    `${[...dates].sort().join(', ')} — a date set that excludes the manifest means lastmod is not ` +
    'reading it at all');
  const today = new Date().toISOString().slice(0, 10);
  const future = [...dates].filter((d) => d > today);
  assert.equal(future.length, 0, `lastmod must never be dated in the future: ${future.join(', ')}`);
  assert.equal(seo.buildSitemapShard('does-not-exist'), null);
});
