'use strict';

// End-to-end for the dead-ticker catch: a confirmed-unlisted symbol must leave
// the sitemap and say so on its page. Runs in its own process (node --test runs
// each file separately) so the status-file override is read before
// fundamentals-status computes its FILE constant.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { test, after } = require('node:test');
const assert = require('node:assert/strict');

const STATUS_FILE = path.join(os.tmpdir(), `fundamentals-status-test-${process.pid}.json`);
fs.writeFileSync(STATUS_FILE, JSON.stringify({
    generatedAt: '2026-10-01T00:00:00.000Z',
    symbols: {
        NSA: {
            firstFailedDay: '2026-09-01', lastFailedDay: '2026-10-01',
            consecutive: 2, kind: 'not-found',
            lastError: 'Quote not found for symbol: NSA', unlistedSince: '2026-10-01'
        }
    }
}));
process.env.FUNDAMENTALS_STATUS_FILE = STATUS_FILE;

const status = require('../fundamentals-status');
const seo = require('../seo-pages');

after(() => { try { fs.rmSync(STATUS_FILE, { force: true }); } catch (_) { /* best effort */ } });

test('the status file is read from the override', () => {
    assert.equal(status.isUnlisted('NSA'), true);
    assert.equal(status.isUnlisted('AMD'), false);
    assert.equal(status.info('NSA').since, '2026-10-01');
});

test('an unlisted ticker is excluded from the sitemap', () => {
    // Stock URLs live in the stocks-N shards, not the sitemap index.
    let combined = '';
    for (let i = 1; i <= 10; i++) {
        const shard = seo.buildSitemapShard(`stocks-${i}`);
        if (!shard) break;
        combined += shard;
    }
    assert.ok(combined.length > 1000, 'stocks shards render');
    assert.doesNotMatch(combined, /\/stocks\/NSA</, 'dead ticker must not be advertised to crawlers');
    assert.match(combined, /\/stocks\/AMD</, 'a live ticker is still there');
});

test('an unlisted ticker keeps a reachable, honestly labelled page', () => {
    const html = seo.renderStockPage('NSA');
    assert.ok(html, 'the page still renders rather than 404ing');
    assert.match(html, /No longer listed under this ticker/);
    assert.doesNotMatch(html, /Not the latest data — a newer SEC filing may exist/);
});
