'use strict';

// The setup guide on /docs/api-mcp, and the prices on the /api landing page.
//
// Written 2026-09-25, after a customer asked whether the site had a guide to
// set MCP up and the honest answer was no: the page named the endpoint and the
// auth header and stopped there, so nothing on it could actually be pasted
// into a client. Every command and URL asserted below was run against the live
// endpoint rather than inferred from the source.
//
// Two facts here are load-bearing. Claude and ChatGPT authenticate by OAuth
// because neither can send a static bearer to a custom connector, so the guide
// must NOT tell those users to paste a key — this test fails if it starts to.
// And the /api landing page had drifted: its table said a lookup cost "1 / 2"
// and called REST "2x MCP", a pricing rule credits.js retired, while the Dev
// card twenty lines above on the same page said 2 and 42. Nothing read those
// numbers back, which is the same failure public-api-doc-truth.test.js exists
// to prevent one file over. Both now read credits.COST; this closes the loop.

const test = require('node:test');
const assert = require('node:assert/strict');

const docs = require('../docs-pages');
const seoPages = require('../seo-pages');
const credits = require('../credits');

const COST = credits.COST;
const PAGE = docs.renderDocPage('api-mcp');
const BLOCKS = docs.DOC_PAGES['api-mcp'].setup;

test('the API/MCP page documents setup for each client, not just the endpoint', () => {
    assert.ok(Array.isArray(BLOCKS) && BLOCKS.length >= 8, 'expected one setup block per client');
    const titles = BLOCKS.map((b) => b.title).join(' | ');
    for (const client of ['Claude', 'Claude Code', 'Anthropic', 'ChatGPT', 'OpenAI', 'MCP client', 'REST']) {
        assert.match(titles, new RegExp(client), `the setup section does not name ${client}`);
    }
});

test('every setup block ships a copyable snippet', () => {
    // A block with prose and no code is the exact failure this page had: it
    // described the shape of the call without ever showing one.
    for (const block of BLOCKS) {
        assert.ok(block.code, `the "${block.title}" block has no snippet to copy`);
    }
    const rendered = PAGE.match(/<pre><code>/g) || [];
    assert.ok(rendered.length >= BLOCKS.length, 'fewer snippets rendered than blocks defined');
});

test('snippets are escaped, so JSON and shell quoting cannot break the page', () => {
    const snippets = [...PAGE.matchAll(/<pre><code>([\s\S]*?)<\/code><\/pre>/g)].map((m) => m[1]);
    assert.equal(snippets.length, (PAGE.match(/<pre><code>/g) || []).length, 'a snippet did not close');
    for (const s of snippets) {
        assert.ok(!/<[a-zA-Z/]/.test(s), `a snippet contains raw markup: ${s.slice(0, 80)}`);
    }
    // The JSON configs carry quotes, which must arrive as entities.
    assert.ok(snippets.some((s) => s.includes('&quot;')), 'JSON snippets were not escaped');
});

test('the clients that cannot send a key are told to use OAuth, not to paste one', () => {
    const byTitle = (needle) => BLOCKS.find((b) => b.title.includes(needle));
    for (const who of ['Claude —', 'ChatGPT']) {
        const block = byTitle(who);
        assert.ok(block, `no setup block for ${who}`);
        const text = block.body + (block.note || '') + (Array.isArray(block.code) ? block.code.join('') : block.code);
        assert.match(text, /OAuth/, `${who} is not told it authenticates over OAuth`);
        assert.ok(!/sp_live_/.test(text), `${who} is told to paste a key it cannot send`);
    }
    // The ones that can send a header must actually show the header.
    for (const who of ['Claude Code', 'Any other MCP client']) {
        const code = [].concat(byTitle(who).code).join('\n');
        assert.match(code, /Authorization: Bearer sp_live_/, `${who} does not show the bearer header`);
    }
});

test('the guide points at the live endpoint on both surfaces', () => {
    assert.match(PAGE, /https:\/\/www\.stockportfolio\.pro\/mcp/, 'the MCP URL is not in the guide');
    assert.match(PAGE, /\/api\/v1\/financials\//, 'no REST example is in the guide');
    // The apex drops the Authorization header through the redirect, so every
    // URL in the guide has to carry www — see seo-pages.js.
    const urls = [...PAGE.matchAll(/https:\/\/stockportfolio\.pro[^\s"<]*/g)];
    assert.equal(urls.length, 0, `the guide uses the apex host: ${urls.map((m) => m[0]).join(', ')}`);
});

test('the stdio bridge is documented with the bare key its package expects', () => {
    // mcp-remote takes the whole `Bearer <key>` string because it is pasted into
    // a header; stockportfolio-mcp takes the bare key and adds the scheme. The
    // two are easy to swap and a swap 401s silently.
    const bridge = BLOCKS.find((b) => b.title.includes('stdio'));
    assert.ok(bridge, 'the local stdio bridge is not documented');
    const code = [].concat(bridge.code).join('\n');
    assert.match(code, /stockportfolio-mcp/);
    assert.match(code, /"STOCKPORTFOLIO_API_KEY": "sp_live_your_key"/, 'the bridge is shown with a header-shaped key');
});

test('the /api landing page quotes credits.COST rather than typed-in numbers', () => {
    const html = seoPages.renderApiLanding();
    const rows = [...html.matchAll(
        /<code>(sp_\w+)<\/code><\/td><td><code>[^<]+<\/code><\/td><td>([^<]+)<\/td>/g
    )].map((m) => [m[1], m[2]]);
    assert.ok(rows.length >= 7, 'the tool table did not render');

    const lookup = `${COST.mcp_lookup} / ${COST.api_lookup}`;
    const ask = `${COST.mcp_ask} / ${COST.api_ask}`;
    for (const [tool, price] of rows) {
        if (tool === 'sp_health') {
            assert.equal(price, 'free', 'sp_health is documented as costing something');
            continue;
        }
        assert.equal(price, tool === 'sp_ask' ? ask : lookup, `${tool} is priced ${price} on /api`);
    }
});

test('the retired "REST costs 2x MCP" claim is gone from the landing page', () => {
    // Both surfaces price identically now — see credits.js. The landing page and
    // public-api.md both used to assert the 2x rule; public-api.md was fixed
    // first and had a test, /api did not and kept the claim.
    const html = seoPages.renderApiLanding();
    assert.doesNotMatch(html, /2&times;\s*MCP|2x MCP|exactly 2/, '/api still claims REST costs twice MCP');
    assert.match(html, /href="\/docs\/api-mcp"/, '/api does not link to the setup guide');
});
