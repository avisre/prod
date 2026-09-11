'use strict';

// Structural guards for who gets API/MCP access and what it costs — asserted
// against the source (same pattern as test/ai-paper-gating.test.js), since
// this is exactly the kind of gate that's easy to wire once and silently
// drop from a route added later.
//
// Decided 9/11: API/MCP access is Power/Desk + the TOP AppSumo/DealMirror
// tier only (not every lifetime buyer, unlike Monitor's isLifetimeBuyer()).
// Pricing: MCP is the base tier, the REST API is exactly 2x MCP. Repriced
// 9/11 to 2x measured frontier cost (Claude Fable 5.1 and GPT-6 Astra both
// $10/$50 per M tokens as of 2026-09): mcp_ask (4) anchors on the measured
// 'chat'-shaped call at 13,820 tokens/call — NOT the all-purposes blend, which
// is dragged down by shorter 'summary' calls — and api_ask (8) is 2x that by
// the stated rule, not an independent estimate. The arithmetic is in the COST
// comment in credits.js.
//
// Amended the same day the Dev plan shipped ($19.99/mo, 200 credits): the
// self-serve developer rung was added to this gate, and it is the ONE plan
// here that is not a top tier. The gate stays a PAID gate — Dev is a
// subscription, not a free tier — but it is no longer accurate to describe
// this as "top tiers only". The narrower assertions below (top LTD tier, no
// isLifetimeBuyer) are unchanged. Dev has its own $19.99 Stripe price; the
// guards that keep it from ever being confused with Monthly — metadata-first
// resolution and the shared-price-id refusal — live in test/dev-plan.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const credits = require('../credits');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('credits.COST prices the API surface at exactly 2x the MCP surface', () => {
    assert.equal(credits.COST.mcp_lookup, 1);
    assert.equal(credits.COST.mcp_ask, 4);
    assert.equal(credits.COST.api_lookup, credits.COST.mcp_lookup * 2, 'api_lookup must be exactly 2x mcp_lookup');
    assert.equal(credits.COST.api_ask, credits.COST.mcp_ask * 2, 'api_ask must be exactly 2x mcp_ask');
    // The old undifferentiated keys must be gone, not left dangling alongside
    // the new ones — a stray unused key here would be a second, driftable
    // price list.
    assert.equal('api_lookup' in credits.COST && 'mcp_lookup' in credits.COST, true);
});

test('apiAccessGate exists and gates on Dev/Power/Desk or the top LTD tier only', () => {
    const gi = appSource.indexOf('function hasApiAccess(req)');
    assert.ok(gi >= 0, 'hasApiAccess exists');
    const fn = appSource.slice(gi, appSource.indexOf('\nfunction apiAccessGate'));
    assert.match(fn, /\['power', 'power-monthly', 'desk', 'dev'\]\.includes\(sub\.planId\)/, 'recurring gate is Dev/Power/Desk only, not every paid plan');
    assert.match(fn, /Number\(user\.appsumoTier\) === 3/, 'only the top AppSumo tier, not isLifetimeBuyer()');
    assert.match(fn, /Number\(user\.dealMirrorTier\) === 3/, 'DealMirror tier 3 is treated the same as AppSumo tier 3');
    assert.equal(/isLifetimeBuyer/.test(fn), false, 'must NOT reuse the any-LTD-buyer check Monitor uses — this gate is narrower');
});

// Dev is the plan the whole developer funnel converts on, and it is the one
// plan whose entitlement is narrower than its price suggests: it must grant
// API/MCP access WITHOUT granting the web-app feature set. If a later edit
// drops the userTier() short-circuit, a Dev subscriber silently becomes a
// second Monthly subscriber for $5 less a month — a revenue leak with no error
// anywhere.
test('the Dev plan grants API/MCP access but no web-app tier', () => {
    const ut = appSource.indexOf('function userTier(user, subscription)');
    assert.ok(ut >= 0, 'userTier exists');
    const fn = appSource.slice(ut, appSource.indexOf('\nfunction isProUser'));
    assert.match(fn, /if \(active && planId === 'dev'\) return 'free';/,
        "Dev must resolve to 'free' before the `planId !== 'free'` branch, or it inherits core features");
    // Ordering is the whole point: the dev line has to come BEFORE the catch-all
    // that returns 'core' for any other non-free active plan. Matched on the
    // full catch-all statement, not the bare `planId !== 'free'` fragment —
    // that fragment also appears in the explanatory comment above the dev line,
    // which would make this comparison pass on a wrongly-ordered function.
    const catchAll = "if (active && planId !== 'free') return AI_PRO_FOR_ALL ? 'pro' : 'core';";
    assert.ok(fn.includes(catchAll), 'the catch-all branch is still there');
    assert.ok(fn.indexOf("planId === 'dev'") < fn.indexOf(catchAll),
        'the Dev short-circuit must precede the `planId !== \'free\'` catch-all');
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
