'use strict';

// embed-widgets.js — the /embed/:widget contract that third-party sites depend
// on. The route is mounted here through the same mountEmbedRoutes() app.js
// calls, so the headers and status codes asserted below are the ones the server
// actually sends rather than a re-implementation that could drift from it.
//
// freeTools.getToolResult is monkey-patched (the pattern from
// test/public-api.test.js) so no test touches the network or the on-disk
// fundamentals cache, and so the parity assertions compare the rendered card
// against a body this test controls.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const freeTools = require('../free-tools');
const embedConfig = require('../embed-config');
const { mountEmbedRoutes, renderEmbed } = require('../embed-widgets');

// A filing-grounded earnings-quality payload with the fields the card renders:
// three large USD figures (so compactUsd takes its B branch), one negative (so
// the sign branch is exercised) and a conversion ratio.
const EARNINGS_BODY = {
    symbol: 'NVDA',
    period: 'FY2025',
    revenue: 130497000000,
    netIncome: -72800000000,
    operatingCashFlow: 64141000000,
    freeCashFlow: 60853000000,
    cashConversionRatio: 1.23,
    sourceUrl: 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001045810'
};

const TIMELINE_BODY = {
    symbol: 'NVDA',
    filings: [
        { date: '2026-02-26', form: '10-K', label: '10-K', url: 'https://www.sec.gov/Archives/edgar/data/1045810/000104581026000021/nvda-20260125.htm' },
        { date: '2025-11-19', form: '10-Q', label: '10-Q', url: 'https://www.sec.gov/Archives/edgar/data/1045810/000104581025000228/nvda-20251026.htm' },
        { date: '2025-08-27', form: '8-K', label: '8-K', url: 'https://www.sec.gov/Archives/edgar/data/1045810/000104581025000205/nvda-20250827.htm' }
    ]
};

async function withServer(t, run) {
    const app = express();
    mountEmbedRoutes(app); // no limiter: rate-limit behaviour is app.js's, tested there
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return run(`http://127.0.0.1:${server.address().port}`);
}

// Stub getToolResult for the duration of one test. Returning {status, body}
// keeps the module's real normalization/error contract in play.
function stubTool(t, impl) {
    const orig = freeTools.getToolResult;
    freeTools.getToolResult = impl;
    t.after(() => { freeTools.getToolResult = orig; });
}

function bodyFor(slug) {
    return slug === 'filing-timeline' ? TIMELINE_BODY : EARNINGS_BODY;
}

test('embed route sends the third-party-frame headers and nothing else frameable', async (t) => {
    stubTool(t, async (slug) => ({ status: 200, body: bodyFor(slug) }));
    await withServer(t, async (base) => {
        const res = await fetch(`${base}/embed/earnings-quality?ticker=NVDA`);
        const html = await res.text();

        assert.equal(res.status, 200);
        assert.match(res.headers.get('content-type'), /text\/html/);

        const csp = res.headers.get('content-security-policy');
        assert.match(csp, /frame-ancestors \*/, 'embeds are the one route a third party may frame');
        assert.match(csp, /default-src 'none'/, 'the widget fetches and runs nothing');
        assert.ok(!/script-src/.test(csp), 'no script-src: there is no script to allow');

        assert.equal(res.headers.get('x-robots-tag'), 'noindex', 'a framed copy must not be indexed as a page');
        const cache = res.headers.get('cache-control');
        assert.match(cache, /s-maxage=900/, 'shared cache absorbs the embed traffic');
        assert.match(cache, /max-age=300/);
    });
});

test('widgets are self-contained: no /assets/ reference, no external fetch', async (t) => {
    stubTool(t, async (slug) => ({ status: 200, body: bodyFor(slug) }));
    await withServer(t, async (base) => {
        for (const slug of ['earnings-quality', 'filing-timeline']) {
            const html = await (await fetch(`${base}/embed/${slug}?ticker=NVDA`)).text();
            // The load-bearing assertion of this file: a widget that pulled from
            // /assets/ would join the ?v= cache-stamp cascade, where a missed
            // bump ships a stale bundle for up to a year.
            assert.ok(!/\/assets\//.test(html), `${slug} must not reference /assets/`);
            assert.ok(!/<script/i.test(html), `${slug} must ship no JavaScript`);
            assert.ok(!/<link[^>]+stylesheet/i.test(html), `${slug} must inline its CSS`);
            assert.match(html, /<style>/, `${slug} inlines its CSS`);
        }
    });
});

test('rendered card carries the filed figures and the UTM badge', async (t) => {
    stubTool(t, async (slug) => ({ status: 200, body: bodyFor(slug) }));
    await withServer(t, async (base) => {
        const html = await (await fetch(`${base}/embed/earnings-quality?ticker=NVDA`)).text();

        // Parity with the payload: the compact figure a reader sees, and the
        // exact filed value kept in the title attribute.
        assert.match(html, /\$130\.50B/, 'revenue renders compacted');
        assert.match(html, /title="\$130,497,000,000"/, 'the exact filed value survives in title=');
        assert.match(html, /-\$72\.80B/, 'a negative figure keeps its sign');
        assert.match(html, /title="-\$72,800,000,000"/);
        assert.match(html, /123%/, 'cash conversion renders as a percentage');
        assert.match(html, /FY2025/);
        assert.match(html, /sec\.gov/, 'the source filing is linked');

        // The href is the single source of truth (embed-config.badgeHref), and it
        // must reach the browser escaped — a raw & in an attribute is invalid
        // HTML, and browsers are lenient about it in ways that break the UTM.
        const badge = embedConfig.badgeHref('earnings-quality', 'NVDA');
        const escapedBadge = badge.replace(/&/g, '&amp;');
        assert.match(html, new RegExp(`href="${escapedBadge.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`), 'badge links back to the company page, escaped');
        assert.match(badge, /utm_source=embed/);
        assert.match(badge, /utm_medium=widget/);
        assert.ok(!/href="[^"]*&[^a]/.test(html), 'no unescaped ampersand in an href');
        assert.match(html, /Every value from an SEC filing/);
    });
});

test('the published snippet points at a URL this route actually serves', async (t) => {
    // Catches the one drift that would matter most: embed-config handing out an
    // <iframe> src that the renderer does not answer.
    stubTool(t, async (slug) => ({ status: 200, body: bodyFor(slug) }));
    await withServer(t, async (base) => {
        for (const slug of ['earnings-quality', 'filing-timeline']) {
            const snippet = embedConfig.embedSnippet(slug, { ticker: 'NVDA' });
            const src = snippet.match(/src="([^"]+)"/)[1];
            const path = src.replace(embedConfig.EMBED_ORIGIN, '');
            assert.match(path, new RegExp(`^/embed/${slug}\\?ticker=NVDA$`));
            assert.equal((await fetch(`${base}${path}`)).status, 200, `${slug} snippet src resolves`);
        }
        assert.equal(embedConfig.embedSnippet('nope', {}), '', 'no snippet for an unknown widget');
    });
});

test('timeline widget renders filing rows and caps the list', async (t) => {
    const many = {
        symbol: 'NVDA',
        filings: Array.from({ length: 20 }, (_, i) => ({
            date: `2026-01-${String(i + 1).padStart(2, '0')}`,
            form: '10-Q',
            label: '10-Q',
            url: `https://www.sec.gov/Archives/edgar/data/1045810/filing-${i}.htm`
        }))
    };
    stubTool(t, async () => ({ status: 200, body: many }));
    await withServer(t, async (base) => {
        const html = await (await fetch(`${base}/embed/filing-timeline?ticker=NVDA`)).text();
        const rows = html.match(/Open filing/g) || [];
        assert.equal(rows.length, 8, 'the card caps at 8 filings instead of growing unbounded');
        assert.match(html, /filing-7\.htm/, 'the eighth row is the last one rendered');
        assert.ok(!/filing-8\.htm/.test(html), 'the ninth filing is dropped');
        assert.match(html, /8 most recent/);
    });
});

test('errors still render a card, at the upstream status', async (t) => {
    const cases = [
        [{ status: 404, body: { error: 'ZZZZ is not a supported US-listed ticker.' } }, 404, /not a supported US-listed ticker/],
        [{ status: 422, body: { error: 'NTES reports in CNY, which is outside this pilot\'s USD coverage.' } }, 422, /outside this pilot/],
        [{ status: 502, body: { error: 'SEC filing data is temporarily unavailable.' } }, 502, /temporarily unavailable/]
    ];
    await withServer(t, async (base) => {
        for (const [result, status, pattern] of cases) {
            stubTool(t, async () => result);
            const res = await fetch(`${base}/embed/earnings-quality?ticker=ZZZZ`);
            const html = await res.text();
            assert.equal(res.status, status, `${status} is preserved so the embedder can tell a typo from a coverage gap`);
            assert.match(html, pattern);
            // A broken iframe shows an empty box, which tells the person who
            // pasted it nothing — so even the error states stay a card with the
            // badge and its headers.
            assert.match(html, /Every value from an SEC filing/);
            assert.match(res.headers.get('content-security-policy'), /frame-ancestors \*/);
        }
    });
});

test('a throwing tool becomes a rendered 502, not a 500', async (t) => {
    stubTool(t, async () => { throw new Error('upstream exploded'); });
    await withServer(t, async (base) => {
        const res = await fetch(`${base}/embed/filing-timeline?ticker=NVDA`);
        assert.equal(res.status, 502);
        assert.match(await res.text(), /temporarily unavailable/);
    });
});

test('bad inputs are 404/400 cards, and the symbol alias works', async (t) => {
    stubTool(t, async (slug, symbol) => ({ status: 200, body: { ...bodyFor(slug), symbol } }));
    await withServer(t, async (base) => {
        const unknown = await fetch(`${base}/embed/nope?ticker=NVDA`);
        assert.equal(unknown.status, 404);
        assert.match(await unknown.text(), /Unknown widget/);

        const noTicker = await fetch(`${base}/embed/earnings-quality`);
        assert.equal(noTicker.status, 400);
        assert.match(await noTicker.text(), /Add a ticker to the URL/);

        const empty = await fetch(`${base}/embed/earnings-quality?ticker=%20`);
        assert.equal(empty.status, 400);

        // ?symbol= is accepted alongside ?ticker=, lower case is normalized, and
        // a raw symbol is never interpolated into the HTML unescaped.
        const alias = await (await fetch(`${base}/embed/earnings-quality?symbol=nvda`)).text();
        assert.match(alias, /<span class="sym">NVDA<\/span>/);
        const injected = await (await fetch(`${base}/embed/earnings-quality?symbol=%3Cscript%3E`)).text();
        assert.ok(!/<script/i.test(injected), 'a symbol never becomes markup');
    });
});

test('renderEmbed is callable directly, with the same status contract', async (t) => {
    stubTool(t, async (slug) => ({ status: 200, body: bodyFor(slug) }));
    assert.deepEqual(Object.keys(await renderEmbed('earnings-quality', 'NVDA')).sort(), ['html', 'status']);
    assert.equal((await renderEmbed('earnings-quality', 'NVDA')).status, 200);
    assert.equal((await renderEmbed('nope', 'NVDA')).status, 404);
    assert.equal((await renderEmbed('earnings-quality', '')).status, 400);
});
