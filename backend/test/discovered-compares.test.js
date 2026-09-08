const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

test('discovered compare pairs reach the sitemap', () => {
    const snap = path.join(__dirname, '..', 'discovered-compares.json');
    try { fs.unlinkSync(snap); } catch (_) {}
    const seoExtra = require('../seo-extra');
    // A pair outside comparePairs(): renders with real metrics on both sides.
    const out = seoExtra.renderComparePage('PANW-vs-SNDK');
    assert.ok(out && out.html, 'PANW-vs-SNDK should render');
    assert.ok(!fs.existsSync(snap), 'nothing written before flush');

    const bad = seoExtra.renderComparePage('ZZZZ-vs-SNDK');
    assert.ok(!bad || bad.redirect || !bad.html, 'unknown ticker must not render');

    // Redirected pairs (unsorted) must not record the reversed slug twice.
    const rev = seoExtra.renderComparePage('SNDK-vs-PANW');
    assert.ok(rev && rev.redirect, 'reversed pair 301s, no record');

    return new Promise((resolve) => setTimeout(resolve, 5600)).then(() => {
        const list = JSON.parse(fs.readFileSync(snap, 'utf8'));
        assert.ok(list.some((e) => e.p === 'PANW-vs-SNDK' && /^\d{4}-\d{2}-\d{2}$/.test(e.at)), 'snapshot records PANW-vs-SNDK');
        assert.equal(list.filter((e) => e.p === 'SNDK-vs-PANW').length, 0, 'no reversed duplicate');

        // Second render is a no-op (already seen).
        seoExtra.renderComparePage('PANW-vs-SNDK');
        const seoPages = require('../seo-pages');
        const hits = [];
        for (let i = 1; i <= 5; i++) {
            const xml = seoPages.buildSitemapShard('comparisons-' + i);
            if (!xml) break;
            if (xml.includes('<url>')) {
                const n = (xml.match(/PANW-vs-SNDK/g) || []).length;
                if (n > 0) { assert.equal(n, 1, 'pair appears exactly once in comparisons-' + i); hits.push(xml); }
            }
        }
        assert.equal(hits.length, 1, 'exactly one comparisons shard carries the pair');
        assert.ok(hits[0].includes('<lastmod>'), 'entry carries lastmod');
        const indexXml = seoPages.buildSitemap();
        assert.ok(indexXml.includes('/sitemaps/comparisons-'), 'index still emits comparisons shards');
    });
});
