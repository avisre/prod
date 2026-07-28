'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const extra = require('../seo-extra');
const seo = require('../seo-pages');

test('high-opportunity metric pages contain answer-first analysis, chart, sources and CSV', () => {
    for (const [symbol, metric] of [['AAPL', 'shares-outstanding'], ['MSFT', 'pe-ratio'], ['NVDA', 'dividend-history']]) {
        const html = extra.renderMetricPage(symbol, metric);
        assert.ok(html, `${symbol}/${metric} renders`);
        assert.match(html, /Latest filed value/);
        assert.match(html, /One-year change/);
        assert.match(html, /metric-chart-title/);
        assert.match(html, /SEC EDGAR/);
        assert.match(html, /Download CSV/);
        assert.match(html, /support@stockportfolio\.pro/);
        assert.doesNotMatch(html, /recommendation to buy|guaranteed return/i);
    }
});

test('metric CSV is raw, escaped, and preserves fiscal periods', () => {
    const csv = extra.metricCsv('AAPL', 'shares-outstanding');
    assert.match(csv, /^"symbol","fiscal_year","period_end","shares-outstanding","formatted_value"/);
    assert.match(csv, /"AAPL","2025","2025-09-30"/);
    assert.ok(csv.trim().split('\n').length >= 3);
    assert.equal(extra.metricCsv('AAPL', 'not-a-metric'), null);
});

test('research hubs are canonical, source-backed and internally connected', () => {
    const pages = [
        ['/research/shares-outstanding', extra.renderSharesResearch()],
        ['/research/pe-ratio-history', extra.renderPeResearch()],
        ['/research/dilution-scorecard', extra.renderDilutionScorecard()]
    ];
    for (const [route, html] of pages) {
        assert.match(html, new RegExp(`canonical" href="https://www\\.stockportfolio\\.pro${route}`));
        assert.match(html, /application\/ld\+json/);
        assert.match(html, /SEC EDGAR|SEC filings/);
        assert.match(html, /Methodology|methodology/);
        assert.match(html, /support@stockportfolio\.pro|Not investment advice/);
        assert.match(html, /href="\/research\//);
        assert.match(html, /\/appsumo\?source=website&amp;content_id=research-/);
    }
});

test('dilution dataset has broad coverage and marks comparability explicitly', () => {
    const rows = extra.dilutionRows();
    assert.ok(rows.length >= 100, `expected broad dataset, received ${rows.length}`);
    assert.ok(rows.every((row) => row.symbol && row.period && row.latestShares > 0));
    assert.ok(rows.some((row) => row.notComparable));
    assert.ok(rows.filter((row) => !row.notComparable).every((row) => row.oneYearPct !== null));
    const csv = extra.dilutionCsv();
    assert.equal(csv.trim().split('\n').length, rows.length + 1);
    assert.match(csv, /"comparison_status"/);
    assert.match(csv, /"not directly comparable"/);
});

test('research pages are discoverable in sitemap with honest page modification dates', () => {
    const core = seo.buildSitemapShard('core');
    for (const route of extra.RESEARCH_ROUTES) {
        assert.match(core, new RegExp(`<loc>https://www\\.stockportfolio\\.pro${route}</loc><lastmod>\\d{4}-\\d{2}-\\d{2}</lastmod>`));
    }
});
