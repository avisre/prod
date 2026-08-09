'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const extra = require('../seo-extra');
const seo = require('../seo-pages');
const competitorComparisons = require('../comparison-pages');

test('missing numeric fields never become fabricated zero values', () => {
    for (const value of ['', '   ', null, undefined]) assert.equal(seo.num(value), null);
    assert.equal(seo.num('0'), 0, 'a real reported zero remains valid');
    const rows = extra.METRICS.eps.rows({ income: { annualReports: [
        { fiscalDateEnding: '2025-12-31', dilutedEPS: '', eps: '' },
        { fiscalDateEnding: '2024-12-31', dilutedEPS: '   ', eps: '' }
    ] } });
    assert.ok(rows.every((row) => row.value === null));
});

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

test('stock comparison pages use the shared authenticated navbar', () => {
    const page = extra.renderComparePage('LB-vs-MUR');
    assert.ok(page && page.html);
    assert.match(page.html, /assets\/system\.css\?v=20260730-ssrnav1/);
    assert.match(page.html, /assets\/app\.js\?v=20260730-ssrnav1/);
    assert.match(page.html, /V2\.nav\("compare"\)/);
    assert.match(page.html, /cmpWireAutocomplete\('cmpAdd','cmpMatches'\)/);
    assert.ok(Buffer.byteLength(page.html) < 100_000, 'comparison pages must not embed the full ticker universe');
    const inlineScripts = [...page.html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)]
        .filter((match) => !/application\/ld\+json|\bsrc=/i.test(match[1]))
        .map((match) => match[2]).filter(Boolean);
    inlineScripts.forEach((source) => assert.doesNotThrow(() => new vm.Script(source)));
    assert.match(page.html, /window\.__spSkipAutoPageView=true/);
    assert.doesNotMatch(page.html, /id="seoNavCta"|<header class="seo-nav"/);

    const competitorPage = competitorComparisons.renderComparison(competitorComparisons.competitors[0]);
    assert.match(competitorPage, /assets\/system\.css\?v=20260730-ssrnav1/);
    assert.match(competitorPage, /V2\.nav\('compare'\)/);
    assert.doesNotMatch(competitorPage, /<header class="seo-nav"/);
});

test('advertised comparison URLs are canonical, renderable primary listings', () => {
    const pairs = extra.comparePairs();
    assert.ok(pairs.length >= 5_000 && pairs.length < 7_000, `crawl-prioritized pair count was ${pairs.length}`);
    assert.ok(pairs.every((pair) => /^[A-Z0-9.]+-vs-[A-Z0-9.]+$/.test(pair)));
    // The deployment audit checks the full inventory; keep the unit suite fast
    // while sampling evenly across its sorted range.
    const samples = Array.from({ length: 25 }, (_, i) => pairs[Math.floor(i * (pairs.length - 1) / 24)]);
    assert.ok(samples.every((pair) => {
        const page = extra.renderComparePage(pair);
        return page && page.html && !page.redirect;
    }), 'sampled advertised comparisons must return their canonical pages');
    assert.ok(!pairs.includes('BF-A-vs-BF.B'));
    assert.ok(!pairs.includes('BF-A-vs-SJM'));
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
