'use strict';

// The anonymous company allowance: a signed-out visitor may look at a limited
// number of DIFFERENT companies per UTC day before being asked to create an
// account. Distinct symbols, not requests, because a company page fans out to
// several endpoints for one stock — counting calls would limit a reader after a
// few page views while letting a scraper (one call per company) through.
//
// Covers the counting logic directly (anon-company-limit.js) and the wiring in
// app.js. The count is what stops the free company endpoints — a live SEC deep
// fetch on a filings cache miss, a ~1-2 minute background build for a company
// nobody has built — from being walked by a machine.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCompanyAllowance } = require('../anon-company-limit');

const appSource = () => fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

// --- The counting logic ----------------------------------------------------

test('distinct companies are counted and the day ends at the allowance', () => {
    const allowance = createCompanyAllowance({ perDay: 3 });
    assert.equal(allowance.allow('v1', 'AAPL', '2026-09-24'), true);
    assert.equal(allowance.allow('v1', 'MSFT', '2026-09-24'), true);
    assert.equal(allowance.allow('v1', 'NVDA', '2026-09-24'), true);
    assert.equal(allowance.allow('v1', 'TSLA', '2026-09-24'), false, 'the 4th company is refused');
    assert.equal(allowance.allow('v1', 'AMZN', '2026-09-24'), false);
    assert.equal(allowance.used('v1', '2026-09-24'), 3, 'a refused company is not counted');
});

test('re-reading a company is free, including once the allowance is spent', () => {
    // This is the whole reason symbols are counted instead of requests: a page
    // that fans out to filings, ownership and insider-history for one stock, and
    // a visitor who comes back to it, must all cost one.
    const allowance = createCompanyAllowance({ perDay: 2 });
    allowance.allow('v1', 'AAPL', '2026-09-24');
    allowance.allow('v1', 'MSFT', '2026-09-24');
    for (let i = 0; i < 5; i += 1) {
        assert.equal(allowance.allow('v1', 'AAPL', '2026-09-24'), true, 'repeat view');
    }
    assert.equal(allowance.used('v1', '2026-09-24'), 2, 'repeats never spend the allowance');
    assert.equal(allowance.allow('v1', 'NVDA', '2026-09-24'), false, 'but a new company is still refused');
});

test('visitors do not share an allowance, and the day rolls over', () => {
    const allowance = createCompanyAllowance({ perDay: 1 });
    assert.equal(allowance.allow('v1', 'AAPL', '2026-09-24'), true);
    assert.equal(allowance.allow('v1', 'MSFT', '2026-09-24'), false);
    // A second visitor is unaffected by the first one's spending — the bug the
    // proxy-hop keying caused was that these were one bucket.
    assert.equal(allowance.allow('v2', 'MSFT', '2026-09-24'), true);
    // And the next day starts clean.
    assert.equal(allowance.allow('v1', 'MSFT', '2026-09-25'), true);
    assert.equal(allowance.used('v1', '2026-09-25'), 1);
    // A key holds one record — the current day — so yesterday's spend is not
    // retrievable and, more to the point, cannot carry forward into today.
    assert.equal(allowance.used('v1', '2026-09-24'), 0, 'only the current day is retained');
});

test('the map is bounded, and never evicts the record it just wrote', () => {
    // A memory guard, not a security boundary: eviction can hand an old record a
    // fresh allowance, which is why the per-request limiters still matter.
    const allowance = createCompanyAllowance({ perDay: 5, maxEntries: 3 });
    for (const key of ['a', 'b', 'c', 'd', 'e']) allowance.allow(key, 'AAPL', '2026-09-24');
    assert.equal(allowance.size(), 3, 'the map stays at its bound');
    assert.equal(allowance.used('e', '2026-09-24'), 1, 'the newest record survived');
    // The guard against evicting the current key: with maxEntries 0 the write
    // must not be undone by the bound it just violated.
    const tiny = createCompanyAllowance({ perDay: 5, maxEntries: 0 });
    assert.equal(tiny.allow('a', 'AAPL', '2026-09-24'), true);
    assert.equal(tiny.size(), 1);
    assert.equal(tiny.used('a', '2026-09-24'), 1, 'the write is intact');
});

// --- The wiring in app.js --------------------------------------------------

function gateSection() {
    const source = appSource();
    const start = source.indexOf('function anonCompanyGate(req, res, next)');
    assert.ok(start > -1, 'the gate exists');
    return source.slice(start, source.indexOf('\n}', start));
}

test('the allowance is 25 a day by default, tunable, and can be switched off', () => {
    const source = appSource();
    assert.match(source, /process\.env\.ANON_COMPANY_DAY \?\? '25'/);
    // 0 is the kill switch — the limit lifts without a redeploy, the same shape
    // the walls' env switches take.
    assert.match(gateSection(), /if \(ANON_COMPANY_DAY <= 0\) return next\(\);/);
});

test('signed-in and keyed callers are not limited here', () => {
    // Their own plan gates (coreGate/proGate) and per-key limits govern them, so
    // a paying customer browsing all day is never refused by this counter.
    assert.match(gateSection(), /if \(req\.user \|\| req\.userId \|\| req\.apiKeyId\) return next\(\);/);
});

test('the gate counts the visitor through visitorIp, keyed by an HMAC', () => {
    const gate = gateSection();
    assert.match(gate, /anonCompanyKey\(req\)/, 'the gate uses the shared key');
    assert.doesNotMatch(gate, /req\.ip\b/, 'never the proxy hop');
    // The derivation lives in exactly one helper now, because the bulk
    // allowances key on it too: two derivations would be two identities for one
    // visitor, and the tape would spend a budget the company pages never see.
    const source = appSource();
    const derivations = source.split('\n')
        .filter((line) => line.includes("createHmac('sha256', process.env.ANON_COMPANY_SALT"));
    assert.equal(derivations.length, 1, 'one derivation, in anonCompanyKey');
    assert.match(source, /function anonCompanyKey\(req\) \{[\s\S]{0,220}?update\(visitorIp\(req\)\)\.digest\('hex'\)/);
    // UTC day, so the allowance is predictable and not timezone-dependent.
    assert.match(gate, /new Date\(\)\.toISOString\(\)\.slice\(0, 10\)/);
    // BRK.B and BRK-B are one company.
    assert.match(gate, /normalizeTicker\(symbol\)/);
});

test('the refusal is a 429 that no cache may keep, with its own code', () => {
    const gate = gateSection();
    assert.match(gate, /res\.setHeader\('Cache-Control', 'no-store'\)/);
    assert.match(gate, /status\(429\)/);
    assert.match(gate, /code: 'ANON_COMPANY_LIMIT'/);
    assert.match(gate, /RateLimit-Remaining', '0'/);
});

test('every symbol-scoped keyless data route carries the gate', () => {
    const source = appSource();
    for (const route of [
        "app.get('/api/company/:symbol/filings', optionalAuth, anonCompanyGate,",
        "app.get('/api/company/:symbol/insider-history', optionalAuth, anonCompanyGate,",
        "app.get('/api/company/:symbol/ownership', optionalAuth, anonCompanyGate,",
        "app.get('/api/assets/:symbol/profile', anonCompanyGate,",
        "app.get('/api/assets/:symbol/holdings', anonCompanyGate,",
        "app.get('/api/assets/:symbol/fees', anonCompanyGate,"
    ]) {
        assert.ok(source.includes(route), `gated: ${route.slice(0, 52)}`);
    }
});

test('the route that does live SEC work resolves the session before counting', () => {
    // /filings had no auth middleware at all. Gating it without optionalAuth
    // would count a signed-in customer as anonymous and refuse them after 25
    // companies — so the order is asserted, not assumed.
    const source = appSource();
    const filings = source.slice(source.indexOf("app.get('/api/company/:symbol/filings'"));
    assert.match(filings.slice(0, 120), /optionalAuth, anonCompanyGate, async/);
    // The two allowances that already gate themselves are deliberately left
    // alone: keypoints (5 stocks a month) is tighter than this, and the filing
    // monitor report has MONITOR_FREE_STOCKS with its own polling rules.
    const keypoints = source.slice(source.indexOf("app.get('/api/company/:symbol/keypoints'"));
    assert.match(keypoints.slice(0, 90), /optionalAuth, async/, 'keypoints keeps its own allowance');
});

test('the admin route exposes the limit and how often it bites', () => {
    // `limited` is the only number that tells the owner whether the free company
    // endpoints are being walked by machines; zero over a long window means the
    // allowance sits above real use.
    assert.match(appSource(), /app\.get\('\/api\/admin\/anon-company\/stats', authMiddleware, marketingDashboardOnly,[\s\S]{0,320}?limit: ANON_COMPANY_DAY/);
    assert.match(gateSection(), /anonCompanyCounters\.limited \+= 1/);
});
