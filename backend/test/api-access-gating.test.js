'use strict';

// Structural guards for who gets API/MCP access and what it costs — asserted
// against the source (same pattern as test/ai-paper-gating.test.js), since
// this is exactly the kind of gate that's easy to wire once and silently
// drop from a route added later.
//
// Decided 9/11: API/MCP access is Power/Desk + the TOP AppSumo/DealMirror
// tier only (not every lifetime buyer, unlike Monitor's isLifetimeBuyer()).
// Pricing: MCP and the REST API are priced IDENTICALLY, action for action.
// The old "REST is exactly 2x MCP" base-tier rule went in two steps — the ask
// was equalised 2026-09-22, the lookup 2026-09-23 — because both surfaces run
// the same call over the same data and a split with no cost basis behind it
// was arbitrary. MCP is the agent-native path, not the cheap one. The
// arithmetic behind the anchors is in the COST comment in credits.js.
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
// The MCP tool layer, where the decisions that used to sit at the transport
// (entitlement, the network/region walls, the free allowance) now live.
const endpointSource = fs.readFileSync(path.join(__dirname, '..', 'mcp-endpoint.js'), 'utf8');

test('credits.COST prices the MCP and REST surfaces identically', () => {
    assert.equal(credits.COST.mcp_lookup, 2);
    assert.equal(credits.COST.mcp_ask, 42);
    // Surface parity, both halves. The ask was equalised 2026-09-22 (shared
    // 6x-frontier anchor); the lookup 2026-09-23 (no anchor either side, so
    // the 1-vs-2 split had nothing behind it). A future reprice must move both
    // surfaces together or this fails — which is the point.
    assert.equal(credits.COST.api_lookup, credits.COST.mcp_lookup, 'api_lookup and mcp_lookup must be equal');
    assert.equal(credits.COST.api_ask, credits.COST.mcp_ask, 'api_ask and mcp_ask share the 6x anchor');
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
    // The 2026-09-23 widening: any tier purchased on or before the cutoff. It
    // must go through the dated cohort check, never a bare tier test — a bare
    // `user.appsumoTier` here would hand API access to every lifetime buyer.
    assert.match(fn, /tierLimits\.isLtdApiAccessCohort\(user\)/, 'the pre-cutoff widening is date-gated via lib/tier-limits.js');
    assert.ok(fn.indexOf("sub.status === 'cancelled'") < fn.indexOf('isLtdApiAccessCohort'), 'the refund revocation check must stay AHEAD of the cohort widening');
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

// An MCP client discovers OAuth ONLY from the WWW-Authenticate challenge on a
// 401. Without it an expired token is a dead end: the client sees 401, has no
// resource_metadata URL to follow, and the customer cannot re-authenticate from
// inside ChatGPT or claude.ai at all.
test('an MCP 401 points the client at its OAuth discovery document for the endpoint it called', () => {
    // Scoped to the MCP endpoints only: /mcp keeps its published contract and
    // /mcp/apps is the OpenAI Apps surface. The REST API's error contract is
    // deliberately untouched, so neither path may widen this to all routes.
    assert.match(appSource, /function mcpAuthChallenge\(req, res\) \{[\s\S]*?if \(req\.path !== '\/mcp' && !isApps\) return;/,
        'the challenge is scoped to the MCP endpoints, leaving the REST error contract alone');
    assert.match(appSource, /resource_metadata="\$\{oauthBase\(req\)\}\$\{metadataPath\}"/,
        'the challenge carries the RFC 9728 metadata URL for the endpoint that was called');
    assert.match(appSource, /const metadataPath = isApps \? '\/\.well-known\/oauth-protected-resource\/mcp\/apps' : '\/\.well-known\/oauth-protected-resource';/,
        'each MCP endpoint advertises its own protected-resource document');
    // Three failure modes must challenge: no credential at all, one that is
    // present but expired/revoked, and an OAuth token minted for another
    // resource — the resource case is what stops a /mcp token being replayed
    // against /mcp/apps.
    const start = appSource.indexOf('async function apiKeyAuth');
    const fn = appSource.slice(start, appSource.indexOf('// Rate-limits public API/MCP callers'));
    assert.equal((fn.match(/mcpAuthChallenge\(req, res\);/g) || []).length, 3,
        'missing-credential, invalid-credential and wrong-resource 401s all challenge');
});

test('every API/MCP-issuing or -serving route carries apiAccessGate', () => {
    const routes = [
        "app.post('/api/account/api-keys', authMiddleware, apiAccessGate,",
        "app.use('/api/v1', publicApi.buildPublicApiRouter({ credits, effectiveAskLimit, aiChat, apiKeyAuth, apiAccessGate,",
    ];
    for (const needle of routes) {
        assert.ok(appSource.includes(needle), `expected to find: ${needle}`);
    }
    // /mcp names NEITHER apiAccessGate nor a wrapper around it, and that is
    // deliberate rather than a dropped gate. apiAccessGate answers HTTP 402
    // API_ACCESS_REQUIRED, and a 402 raised before the MCP session starts is
    // indistinguishable to a client from a dead server: it cannot read the tool
    // list, and the account holder is never told why. mcp-endpoint.js applies
    // hasApiAccess() inside tools/call and returns ENTITLEMENT_REQUIRED as a
    // tool result instead — same decision, delivered where it can be read.
    assert.ok(
        !/app\.post\('\/mcp',[^\n]*apiAccessGate/.test(appSource),
        '/mcp must not raise a transport-level 402: entitlement is decided per tool call'
    );
    // The gate therefore has to exist on the tool side, or the paid tier check
    // would simply be gone.
    assert.match(endpointSource, /ENTITLEMENT_REQUIRED/,
        'the tool layer carries the paid-tier check that left the transport');

    // list/revoke intentionally stay ungated by tier — a downgraded account
    // must still be able to see and delete its own existing keys.
    assert.match(appSource, /app\.get\('\/api\/account\/api-keys', authMiddleware, async/, 'listing keys stays tier-ungated');
    assert.match(appSource, /app\.delete\('\/api\/account\/api-keys\/:id', authMiddleware, async/, 'revoking a key stays tier-ungated');

    // The keyless path widened /mcp's door, so pin the thing that stops it
    // becoming a hole: a caller who offers a key that does not resolve is
    // rejected rather than silently served the free tier — which would read to
    // a paying customer as their key having stopped working, with no error to
    // explain it.
    assert.match(
        appSource,
        /if \(offered\) return apiKeyAuth\(req, res, next\);/,
        'an offered key is always verified — no silent downgrade to the free tier'
    );
});

// OpenAI's Scan Tools (and any MCP directory crawler) performs server discovery
// or the initialize / notifications/initialized handshake and reads tools/list,
// then may ping or call a tool to verify the endpoint. None of that may be
// refused by a wall, because the refusal arrives before the client has read the
// tool list and is indistinguishable from a broken server — which is exactly
// how a directory came to mark this endpoint Unhealthy while a hand-built
// allowlist of method names tried to carve out the protocol operations.
//
// The fix was to stop deciding at the transport at all. These assertions pin
// that: the transport never refuses, and discovery never consults entitlement.
test('the MCP transport never refuses a request, and discovery never meters', () => {
    const start = appSource.indexOf('async function apiKeyAuthOptional');
    const fn = appSource.slice(start, appSource.indexOf('const anonMcpRateLimit'));
    assert.ok(fn.length > 0, 'apiKeyAuthOptional is still where this test expects it');

    // No payment status, no auth status, no wall refusal at the transport. A
    // method allowlist would be the old bug in a new form, so assert the wall
    // and the 402 body are simply not reachable from here.
    assert.ok(!/freeTierWallResponse|\.status\(402\)/.test(fn),
        'the MCP transport must never answer 402, for any method or any caller');
    assert.ok(!/\.status\(401\)/.test(fn),
        'the MCP transport must never answer 401: a client has to reach tools/list to be told it lacks access');
    assert.ok(!/req\.body\.method ===/.test(fn),
        'no method allowlist: every protocol operation is allowed through, not an enumerated few');

    // What it does instead: mark the caller keyless and hand the wall decision
    // onward, so tools/call can decide with the tool actually being called.
    assert.match(fn, /req\.anonMcp = true;/, 'a credential-less caller is admitted as keyless');
    assert.match(fn, /req\.mcpWallReason = freeTierWallReason\(req\);/, 'the wall verdict is carried to the tool layer, not enforced here');
    assert.match(fn, /if \(offered\) return apiKeyAuth\(req, res, next\);/, 'an offered key is still verified first');

    // Discovery is the one thing that must never consult entitlement or a
    // wallet: a client cannot be told it lacks access to tools it has not been
    // allowed to read yet.
    const listStart = endpointSource.indexOf('setRequestHandler(ListToolsRequestSchema');
    const listHandler = endpointSource.slice(listStart, endpointSource.indexOf('setRequestHandler(CallToolRequestSchema'));
    assert.ok(listStart > -1 && listHandler.length > 0, 'the tools/list handler is present');
    assert.ok(!/deps\.limiter|deps\.entitled|gate\b/.test(listHandler),
        'tools/list must not touch the limiter, entitlement or the wall — discovery is never metered');

    // And the decisions that left the transport are all accounted for on the
    // tool side, or they would have been dropped rather than moved.
    assert.match(endpointSource, /ENTITLEMENT_REQUIRED/, 'entitlement is decided per tool call');
    assert.match(endpointSource, /NETWORK_PAID_ONLY|MSG_NETWORK/, 'the network wall is expressible as a tool error');
    assert.match(endpointSource, /REGION_PAID_ONLY|MSG_REGION/, 'the region wall is expressible as a tool error');
});
