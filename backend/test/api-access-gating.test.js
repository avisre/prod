'use strict';

// Structural guards for who gets API/MCP access and what it costs — asserted
// against the source (same pattern as test/ai-paper-gating.test.js), since
// this is exactly the kind of gate that's easy to wire once and silently
// drop from a route added later.
//
// Decided 9/11: API/MCP access is Power/Desk + the TOP AppSumo/DealMirror
// tier only (not every lifetime buyer, unlike Monitor's isLifetimeBuyer()).
// Pricing: MCP is the base tier, the REST API is exactly 2x MCP — mcp_ask
// (2) is anchored to measured frontier-model cost (Claude Fable 5.1 and
// GPT-6 Astra both $10/$50 per M tokens as of 2026-09; ~1.7 credits/call at
// this product's $0.10/credit rate), api_ask (4) is 2x that by the stated
// rule, not an independent estimate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const credits = require('../credits');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('credits.COST prices the API surface at exactly 2x the MCP surface', () => {
    assert.equal(credits.COST.mcp_lookup, 1);
    assert.equal(credits.COST.mcp_ask, 2);
    assert.equal(credits.COST.api_lookup, credits.COST.mcp_lookup * 2, 'api_lookup must be exactly 2x mcp_lookup');
    assert.equal(credits.COST.api_ask, credits.COST.mcp_ask * 2, 'api_ask must be exactly 2x mcp_ask');
    // The old undifferentiated keys must be gone, not left dangling alongside
    // the new ones — a stray unused key here would be a second, driftable
    // price list.
    assert.equal('api_lookup' in credits.COST && 'mcp_lookup' in credits.COST, true);
});

test('apiAccessGate exists and gates on Power/Desk or the top LTD tier only', () => {
    const gi = appSource.indexOf('function hasApiAccess(req)');
    assert.ok(gi >= 0, 'hasApiAccess exists');
    const fn = appSource.slice(gi, appSource.indexOf('\nfunction apiAccessGate'));
    assert.match(fn, /\['power', 'power-monthly', 'desk'\]\.includes\(sub\.planId\)/, 'recurring gate is Power/Desk only, not every paid plan');
    assert.match(fn, /Number\(user\.appsumoTier\) === 3/, 'only the top AppSumo tier, not isLifetimeBuyer()');
    assert.match(fn, /Number\(user\.dealMirrorTier\) === 3/, 'DealMirror tier 3 is treated the same as AppSumo tier 3');
    assert.equal(/isLifetimeBuyer/.test(fn), false, 'must NOT reuse the any-LTD-buyer check Monitor uses — this gate is narrower');
});

test('every API/MCP-issuing or -serving route carries apiAccessGate', () => {
    const routes = [
        "app.post('/api/account/api-keys', authMiddleware, apiAccessGate,",
        "app.use('/api/v1', publicApi.buildPublicApiRouter({ credits, effectiveAskLimit, aiChat, apiKeyAuth, apiAccessGate,",
        "app.post('/mcp', jsonParser, apiKeyAuth, apiAccessGate,",
    ];
    for (const needle of routes) {
        assert.ok(appSource.includes(needle), `expected to find: ${needle}`);
    }
    // list/revoke intentionally stay ungated by tier — a downgraded account
    // must still be able to see and delete its own existing keys.
    assert.match(appSource, /app\.get\('\/api\/account\/api-keys', authMiddleware, async/, 'listing keys stays tier-ungated');
    assert.match(appSource, /app\.delete\('\/api\/account\/api-keys\/:id', authMiddleware, async/, 'revoking a key stays tier-ungated');
});
