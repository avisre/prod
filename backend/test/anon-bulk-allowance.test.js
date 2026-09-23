'use strict';

// Bulk routes — the market tape here — disclose many symbols in one response, so
// the per-visitor company allowance cannot be enforced before the work the way
// /api/company/:symbol does: the set of companies IS the result. These routes
// charge after the fact instead, clipping the response to what the visitor's day
// still allows.
//
// The tape gets its OWN budget rather than drawing on the 25-company research
// allowance. SPY,QQQ,DIA,IWM load with a page's chrome, so charging them to the
// research budget would take four of a reader's 25 companies before they read
// anything — and the tape is ETFs and indices, not companies being researched.
//
// Why this route and not only the per-company gate: /api/market/strip spent a
// live Yahoo call per cold symbol with no auth at all, and every outbound call
// queues on one process-wide gate. A caller varying symbols held that queue in
// front of paying customers' price data. Measured 2026-09-24: the endpoint takes
// 12 symbols per request, so one visitor could reach the whole 3,840-company
// universe in ~320 requests.
//
// Not covered here, deliberately: /api/screener. It is advertised as free and
// unmetered in the docs page, the landing page's structured data and the AppSumo
// listing, it reads a local precomputed index with no provider call, and it
// returns filed fundamentals that the SEC publishes. Clipping it would contradict
// published copy to protect data we already give away; the measurement is in
// .claude/HANDOFF.md for the owner to decide on, not a call to make silently.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = () => fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function factory() {
    const source = appSource();
    const start = source.indexOf('function createAnonBulkAllowance(');
    assert.ok(start > -1, 'the factory exists');
    return source.slice(start, source.indexOf('\n}\n', start));
}

function routeBody(route) {
    const source = appSource();
    const start = source.indexOf(route);
    assert.ok(start > -1, `${route} exists`);
    return source.slice(start, source.indexOf('\n});', start));
}

test('a bulk allowance reads the same visitor the gate counts', () => {
    const body = factory();
    // One identity for both paths. Two derivations would let the tape spend a
    // budget the company pages never see, and vice versa.
    assert.match(body, /anonCompanyKey\(req\)/);
    assert.match(body, /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/, 'UTC day');
    assert.match(body, /normalizeTicker\(s\)/, 'BRK.B and BRK-B are one symbol');
    assert.doesNotMatch(body, /req\.ip\b/, 'never the proxy hop');
    // Already-counted symbols stay visible however the day is spent, so a page
    // and the tape linking to it charge once between them.
    assert.match(body, /symbols\.filter\(\(s\) => allowance\.allow\(/);
});

test('a bulk allowance clips, and never limits a signed-in or keyed caller', () => {
    const body = factory();
    assert.match(body, /if \(perDay <= 0 \|\| req\.user \|\| req\.userId \|\| req\.apiKeyId\) return symbols;/,
        'plan gates govern signed-in callers; 0 switches the limit off');
    // `limited` is the number the owner reads to tell a machine from a reader.
    assert.match(body, /counters\.limited \+= 1/);
    assert.match(body, /stats\(\) \{ return \{ limit: perDay, tracked: allowance\.size\(\)/);
});

test('the tape has its own budget, not a share of the research allowance', () => {
    const source = appSource();
    assert.match(source, /const anonStripAllowance = createAnonBulkAllowance\('ANON_STRIP_SYMBOL_DAY', 40\)/);
    // The 25-company allowance keeps its own constructor, so the two counters
    // cannot become one by accident.
    assert.match(source, /const anonCompanyAllowance = createCompanyAllowance\(\{ perDay: ANON_COMPANY_DAY \}\)/);
    assert.equal((source.match(/createAnonBulkAllowance\(/g) || []).length, 2, 'the definition and its one use');
});

test('the tape clips the shared payload instead of refusing the page', () => {
    const body = routeBody("app.get('/api/market/strip'");
    // optionalAuth first: without it req.user is always undefined here and a
    // signed-in customer would be clipped like an anonymous visitor.
    assert.match(body.slice(0, 60), /^app\.get\('\/api\/market\/strip', optionalAuth, async/);
    assert.match(body, /anonStripAllowance\.keep\(req, symbols\)/);
    assert.match(body, /limited: true, limit: anonStripAllowance\.perDay/);
    assert.match(body, /Cache-Control', 'no-store'/, 'a clipped answer is not cacheable');
    // A tape is chrome on a page the visitor is already reading: a 429 there is
    // a blank strip with no explanation, and the client cannot act on it.
    assert.doesNotMatch(body, /status\(429\)/);
    // The clip must copy. Writing into payload.quotes would delete the symbols
    // from the shared cache for every later visitor.
    assert.match(body, /const quotes = \{\};/);
    assert.doesNotMatch(body, /payload\.quotes\[[^\]]*\]\s*=/);
    assert.match(body, /_stripCache\.set\(key, \{ at: Date\.now\(\), payload \}\)/, 'the cache stores the whole payload');
});

test('the tape budget is visible to the owner', () => {
    assert.match(appSource(), /strip: anonStripAllowance\.stats\(\)/);
});

test('the symbol lookup is cached and separately rate limited', () => {
    const source = appSource();
    // It had no cache: every keystroke was a live Yahoo call, and all outbound
    // calls share one gate, so a caller walking prefixes queued ahead of paying
    // customers. The cache covers the repeated-prefix case that is most of the
    // real traffic.
    assert.match(source, /await fetchAlphaCached\('SYMBOL_SEARCH', \{ keywords: query \}, ALPHA_CACHE_TTL_MS\.search\)/);
    assert.match(source, /search: 5 \* 60 \* 1000/);
    assert.match(source, /app\.get\('\/api\/assets\/search', assetSearchLimiter, async/);
    assert.match(source, /const assetSearchLimiter = rateLimit\(\{/);
    // The client falls back to its bundled company list when this refuses, so
    // the refusal degrades an honest visitor's autocomplete rather than breaking it.
    assert.match(source, /code: 'SEARCH_RATE_LIMIT'/);
});
