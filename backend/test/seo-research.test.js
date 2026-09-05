'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const http = require('node:http');
const express = require('express');
const extra = require('../seo-extra');
const seo = require('../seo-pages');
const competitorComparisons = require('../comparison-pages');
const { buildDividendHistory } = require('../../scripts/refresh-fundamentals');

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
    assert.match(page.html, /assets\/system\.css\?v=20260905-fallback3/);
    assert.match(page.html, /assets\/app\.js\?v=20260905-fallback3/);
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
    assert.match(competitorPage, /assets\/system\.css\?v=20260905-fallback3/);
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

test('totalReturn computes split/dividend-adjusted returns and degrades on short history', () => {
    const series = [
        { date: '2016-01-01', close: 100 },
        { date: '2017-01-01', close: 110 },
        { date: '2018-01-01', close: 121 },
        { date: '2019-01-01', close: 133.1 },
        { date: '2020-01-01', close: 146.41 },
        { date: '2021-01-01', close: 161.05 }
    ];
    assert.ok(Math.abs(extra.totalReturn(series, 1) - 10) < 0.001, '1y return is ~10%');
    assert.ok(Math.abs(extra.totalReturn(series, 5) - 61.05) < 0.001, '5y return is ~61.05%');
    assert.equal(extra.totalReturn(series, 10), null, '10y window exceeds history');
    assert.equal(extra.totalReturn([], 1), null, 'empty series returns null');
    assert.equal(extra.totalReturn([{ date: '2020-01-01', close: 10 }], 1), null, 'single point returns null');
    assert.equal(extra.totalReturn(null, 1), null, 'null series returns null');
});

test('comparison pages include a performance section with real returns', () => {
    const page = extra.renderComparePage('AAPL-vs-MSFT');
    assert.ok(page && page.html);
    assert.match(page.html, /Performance &mdash; AAPL vs MSFT/);
    assert.match(page.html, /1-year return/);
    assert.match(page.html, /3-year return/);
    assert.match(page.html, /5-year return/);
    assert.match(page.html, /10-year return/);
    assert.match(page.html, /52-week range/);
    // Large caps with ~20y of monthly data must produce real numbers, not em-dashes.
    assert.doesNotMatch(page.html, /1-year return<\/td><td[^>]*>&mdash;<\/td>/);
    assert.match(page.html, /Over the last five years/);
    assert.match(page.html, /1\/3\/5\/10-year performance/);
});

test('research hubs are canonical, source-backed and internally connected', () => {
    const pages = [
        ['/research/shares-outstanding', extra.renderSharesResearch()],
        ['/research/pe-ratio-history', extra.renderPeResearch()],
        ['/research/dilution-scorecard', extra.renderDilutionScorecard()],
        ['/research/how-to-read-a-10-k', extra.renderRead10KGuide()],
        ['/research/how-to-compare-two-stocks', extra.renderCompareGuide()],
        ['/research/what-is-free-cash-flow', extra.renderFreeCashFlowGuide()],
        ['/research/how-to-find-undervalued-stocks', extra.renderFindUndervaluedGuide()]
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

test('educational guides carry a worked filed example, an FAQ block and honest framing', () => {
    const tenK = extra.renderRead10KGuide();
    assert.match(tenK, /Worked example/);
    assert.match(tenK, /Frequently asked questions/);
    assert.match(tenK, /fiscal \d{4} 10-K/);
    assert.match(tenK, /revenue of \$/); // real filed figure, not a placeholder
    assert.doesNotMatch(tenK, /<td>[^<]*&mdash;<\/td>/);

    const compare = extra.renderCompareGuide();
    assert.match(compare, /Apple vs Microsoft|Apple vs Microsoft/);
    assert.match(compare, /Returned|returned/);
    assert.match(compare, /\+\d+(\.\d+)?%/); // a signed real return, not a dash
    assert.match(compare, /Trailing P\/E/);

    const fcf = extra.renderFreeCashFlowGuide();
    assert.match(fcf, /operating cash flow − capital expenditures|operating cash flow/);
    assert.match(fcf, /\$[\d.]+[BT]?/); // real money figure
    assert.match(fcf, /Negative|negative/);

    const undervalued = extra.renderFindUndervaluedGuide();
    assert.match(undervalued, /cheap/i);
    assert.match(undervalued, /undervalued/i);
    assert.match(undervalued, /low P\/E|low-pe|screen/);
    // Honest framing: a low multiple is not a guarantee.
    assert.match(undervalued, /not a (prediction|guarantee|recommendation)|never guarantees|not investment advice/);

    for (const html of [tenK, compare, fcf, undervalued]) {
        assert.ok(Buffer.byteLength(html) < 100_000, 'guide must stay under 100 KB');
    }
});

test('research guide routes serve 200 for all four new URLs', async () => {
    const app = express();
    app.use(extra.router);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const status = (path) => new Promise((resolve) => {
        const req = http.get(base + path, (res) => { resolve(res.statusCode); res.resume(); });
        req.on('error', () => resolve(-1));
    });
    try {
        assert.equal(await status('/research/how-to-read-a-10-k'), 200);
        assert.equal(await status('/research/how-to-compare-two-stocks'), 200);
        assert.equal(await status('/research/what-is-free-cash-flow'), 200);
        assert.equal(await status('/research/how-to-find-undervalued-stocks'), 200);
    } finally { server.close(); }
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

test('sectorPercentile ranks a ticker within its sector and degrades to null', () => {
    // AAPL is the largest Technology company by revenue in the cached index.
    const pct = extra.sectorPercentile('AAPL', 'latestRevenue');
    assert.ok(pct !== null && pct >= 0 && pct <= 100, `expected a percentile, got ${pct}`);
    assert.ok(pct >= 90, 'AAPL revenue should rank near the top of its sector');
    assert.equal(extra.sectorPercentile('AAPL', 'notAField'), null, 'unknown field yields no peers');
    assert.equal(extra.sectorPercentile('ZZZZ-NOT-A-SYMBOL', 'latestRevenue'), null, 'unknown symbol yields null');
});

test('sectorPeers returns same-sector comparables, never the ticker itself', () => {
    const peers = extra.sectorPeers('AAPL', 'latestRevenue', 5);
    assert.ok(peers.length === 5, `expected 5 peers, got ${peers.length}`);
    assert.ok(peers.every((p) => p.symbol && p.name && typeof p.value === 'number'));
    assert.ok(peers.every((p) => p.symbol !== 'AAPL'));
    assert.ok(peers[0].value >= peers[peers.length - 1].value, 'peers sorted highest-first');
    assert.deepEqual(extra.sectorPeers('ZZZZ-NOT-A-SYMBOL', 'latestRevenue'), []);
});

test('metric pages carry the sector percentile, peer table and update-frequency label', () => {
    const html = extra.renderMetricPage('AAPL', 'revenue');
    assert.ok(html);
    assert.match(html, /percentile of the Technology sector/);
    assert.match(html, /vs\. Technology sector peers/);
    assert.match(html, /Update frequency: quarterly/);
    assert.match(html, /<a href="\/stocks\/MSFT\/revenue">MSFT<\/a>/);
    // A metric whose sector has no comparable peers must degrade without crashing.
    const html2 = extra.renderMetricPage('NVDA', 'eps');
    assert.ok(html2);
});

test('price-history pages carry a real chart, returns table, range bar and FAQ', () => {
    const html = extra.renderPriceHistoryPage('AAPL');
    assert.ok(html, 'AAPL price-history renders');
    assert.match(html, /Stock Price History \| Monthly since 2006/);
    assert.match(html, /adjusted monthly close since/);
    assert.match(html, /Year to date/);
    assert.match(html, /5 years/);
    assert.match(html, /10 years/);
    assert.match(html, /52-week range/);
    assert.match(html, /50-day moving average/);
    assert.match(html, /frequently asked questions/);
    // Real returns for a 20-year large cap — no em-dash placeholders.
    assert.doesNotMatch(html, /<td>Year to date<\/td><td[^>]*>&mdash;<\/td>/);
    assert.doesNotMatch(html, /<td>1 year<\/td><td[^>]*>&mdash;<\/td>/);
    assert.ok(Buffer.byteLength(html) < 100_000, 'price-history page must stay under 100 KB');
    assert.equal(extra.renderPriceHistoryPage('ZZZZ-NOT-A-REAL-SYMBOL'), null);
});

test('price-history URLs are in the sitemap for tickers with enough monthly data', () => {
    const urls = extra.sitemapUrls();
    assert.ok(urls.some((u) => u.loc === '/stocks/AAPL/price-history'));
    // No fabricated pages for symbols whose monthly series is too short.
    assert.ok(urls.every((u) => !u.loc.endsWith('/price-history') || u.loc.startsWith('/stocks/')));
});

test('buildDividendHistory maps chart dividend events to oldest-first ex-date rows', () => {
    const chart = {
        events: {
            dividends: [
                { date: new Date('2026-08-10T13:30:00Z'), amount: 0.27 },
                { date: new Date('2026-05-11T13:30:00Z'), amount: 0.27 },
                { date: 'garbage', amount: 'not-a-number' },
            ],
        },
    };
    assert.deepEqual(buildDividendHistory(chart), [
        { exDate: '2026-05-11', amount: 0.27 },
        { exDate: '2026-08-10', amount: 0.27 },
    ]);
    // Non-payer / missing events degrade to an empty history, never a crash.
    assert.deepEqual(buildDividendHistory({}), []);
    assert.deepEqual(buildDividendHistory(null), []);
});

test('dividend-history pages carry ex-dates, next-ex callout and quarterly payouts when data present', () => {
    const html = extra.renderMetricPage('AAPL', 'dividend-history');
    assert.ok(html, 'AAPL dividend-history renders');
    assert.match(html, /Next expected ex-dividend date:/);
    assert.match(html, /Ex-dividend date<\/th><th>Dividend per share<\/th>/);
    assert.match(html, /Total paid per share<\/th>/);
    // Real declared-payout row from the enriched cache — no placeholder.
    assert.match(html, /<tr><td>Aug 10, 2026<\/td><td>\$0\.27<\/td><\/tr>/);
    assert.ok(Buffer.byteLength(html) < 100_000, 'dividend page must stay under 100 KB');
});

test('dividend-history pages degrade gracefully for non-payers without the extras section', () => {
    const html = extra.renderMetricPage('BRK.B', 'dividend-history');
    assert.ok(html, 'non-payer dividend-history still renders');
    // No ex-dates/quarterly extras, no crash — the fiscal-year table remains.
    assert.doesNotMatch(html, /Ex-dividend date<\/th><th>Dividend per share<\/th>/);
    assert.doesNotMatch(html, /Total paid per share<\/th>/);
    assert.match(html, /Fiscal year<\/th>/);
});

test('price-history route serves 200, 301-canonicals and redirects invalid tickers', async () => {
    const app = express();
    app.use(extra.router);
    const server = app.listen(0);
    const base = `http://127.0.0.1:${server.address().port}`;
    const status = (path) => new Promise((resolve) => {
        const req = http.get(base + path, (res) => { resolve(res.statusCode); res.resume(); });
        req.on('error', () => resolve(-1));
    });
    try {
        assert.equal(await status('/stocks/AAPL/price-history'), 200);
        assert.equal(await status('/stocks/aapl/price-history'), 301, 'lowercase ticker canonicals');
        const invalid = await status('/stocks/ZZZZ-NOT-A-REAL-SYMBOL-XX/price-history');
        assert.ok(invalid === 302 || invalid === 404, `invalid ticker should redirect, got ${invalid}`);
    } finally { server.close(); }
});
