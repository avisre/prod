'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const seo = require('../seo-pages');

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
    for (const m of xml.matchAll(/<lastmod>([^<]+)<\/lastmod>/g)) dates.add(m[1]);
  }
  assert.ok(total > 18_000, 'crawl-prioritized public inventory remains discoverable');
  assert.match(seo.buildSitemapShard('core'), /<loc>https:\/\/www\.stockportfolio\.pro\/appsumo<\/loc>/);
  assert.equal((seo.buildSitemapShard('core').match(/<loc>https:\/\/www\.stockportfolio\.pro\/tools\//g) || []).length, 30);
  assert.equal((seo.buildSitemapShard('core').match(/<loc>https:\/\/www\.stockportfolio\.pro\/research\//g) || []).length, 7);
  assert.ok(dates.size > 1, 'lastmod must reflect real per-page/data freshness, not generation day');
  assert.equal(seo.buildSitemapShard('does-not-exist'), null);
});
