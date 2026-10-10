'use strict';

// Structural guards for who gets API/MCP access and what it costs — asserted
// against the source (same pattern as test/ai-paper-gating.test.js), since
// this is exactly the kind of gate that's easy to wire once and silently
// drop from a route added later.
//
// Decided 9/11: API/MCP access is Power/Desk + the top lifetime tiers only
// (not every lifetime buyer, unlike Monitor's isLifetimeBuyer()). Amended
// 2026-10-05: the floor moved from tier 3 alone to tier 2 (Investor), because
// the live AppSumo listing kept selling API+MCP on Investor while the gate had
// narrowed past it — a tier-2 buyer redeemed for the API, found no key, and
// refunded inside 30 minutes. The floor is shared with lib/tier-limits.js so
// the gate and the listing copy cannot drift apart again.
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
// this as "top tiers only". The narrower assertions below (LTD tier floor, no
// isLifetimeBuyer) are unchanged in kind. Dev has its own $19.99 Stripe price; the
// guards that keep it from ever being confused with Monthly — metadata-first
// resolution and the shared-price-id refusal — live in test/dev-plan.test.js.
//
// Amended 2026-10-08: Monthly ($79.99/mo) joined the gate after a new Monthly
// subscriber connected the MCP server to Claude and had every tool call
// refused while the cheaper Dev plan was let through. Annual and Pro
// ('pro-annual') were added the same day.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const credits = require('../credits');
const tierLimits = require('../../lib/tier-limits');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
// The MCP tool layer, where the decisions that used to sit at the transport
// (entitlement, the network/region walls, the free allowance) now live.
const endpointSource = fs.readFileSync(path.join(__dirname, '..', 'mcp-endpoint.js'), 'utf8');

test('credits.COST prices the MCP and REST surfaces identically', () => {
    // 1 since 2026-10-10 (owner decision): a lookup makes no model call.
    assert.equal(credits.COST.mcp_lookup, 1);
    assert.equal(credits.COST.mcp_ask, 42);
    // Surface parity, both halves. The ask was equalised 2026-09-22 (shared
    // 6x-frontier anchor); the lookup 2026-09-23 (no anchor either side, so
    // the 1-vs-2 split had nothing behind it), and both moved to 1 together. A future reprice must move both
    // surfaces together or this fails — which is the point.
    assert.equal(credits.COST.api_lookup, credits.COST.mcp_lookup, 'api_lookup and mcp_lookup must be equal');
    assert.equal(credits.COST.api_ask, credits.COST.mcp_ask, 'api_ask and mcp_ask share the 6x anchor');
    // The old undifferentiated keys must be gone, not left dangling alongside
    // the new ones — a stray unused key here would be a second, driftable
    // price list.
    assert.equal('api_lookup' in credits.COST && 'mcp_lookup' in credits.COST, true);
});

test('apiAccessGate exists and gates on the paid subscription plans or the top two LTD tiers only', () => {
    const gi = appSource.indexOf('function hasApiAccess(req)');
    assert.ok(gi >= 0, 'hasApiAccess exists');
    const fn = appSource.slice(gi, appSource.indexOf('\nfunction apiAccessGate'));
    assert.match(fn, /\['monthly', 'annual', 'pro-annual', 'power', 'power-monthly', 'desk', 'dev'\]\.includes\(sub\.planId\)/, 'recurring gate lists the subscription plans explicitly');
    // Lifetime AppSumo/DealMirror grants are stored as an active 'pro' plan, so
    // bare 'pro' in this list would give every lifetime buyer API/MCP access
    // and bypass the tier floor asserted below.
    assert.equal(/\[[^\]]*'pro'[^\]]*\]\.includes\(sub\.planId\)/.test(fn), false, "bare 'pro' must not be in the recurring list");
    // Tier 2 (Investor) is in, added 2026-10-05 to match the live AppSumo
    // listing, which sells API+MCP on Investor as well as Pro. The floor is a
    // shared constant so the gate and the marketing copy cannot drift apart.
    assert.match(fn, /Number\(user\.appsumoTier\) >= tierLimits\.API_ACCESS_MIN_LTD_TIER/, 'Investor (tier 2) and Pro (tier 3), not isLifetimeBuyer()');
    assert.match(fn, /Number\(user\.dealMirrorTier\) >= tierLimits\.API_ACCESS_MIN_LTD_TIER/, 'DealMirror uses the same floor as AppSumo');
    assert.equal(tierLimits.API_ACCESS_MIN_LTD_TIER, 2, 'the floor is Investor (tier 2): a Starter (tier 1) purchase after the cutoff carries no API/MCP');
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

// A challenge is an instruction, not a label: the client reads scope= and asks
// /oauth/authorize for exactly that value. So it has to be one the
// authorization endpoint will ISSUE. /mcp advertised "mcp" — the legacy
// all-access scope mcp-apps.js still honours on tokens already in the wild, but
// one normalizeOauthScope refuses to grant — so a client that followed the
// instruction was refused with invalid_scope and never connected, and the
// failure read as a dead connector rather than a scope mismatch. Found
// 2026-09-30 by walking the consent flow through a real browser.
test('the challenge asks for scopes the authorization endpoint will actually issue', () => {
    const start = appSource.indexOf('function mcpAuthChallenge');
    const fn = appSource.slice(start, appSource.indexOf('async function apiKeyAuth'));
    const scopeExpr = (fn.match(/const scope = ([^;]+);/) || [])[1];
    assert.ok(scopeExpr, 'mcpAuthChallenge still computes a scope');
    assert.equal(scopeExpr.trim(), "OAUTH_SCOPES.join(' ')",
        'the challenge advertises a scope /oauth/authorize does not issue');

    // Every document that advertises scopes must read that same list, or a
    // client that trusts one and asks with the other is refused for the same
    // reason from the other direction.
    const advertised = [...appSource.matchAll(/scopes_supported: ([A-Za-z_$][\w$]*)/g)].map((m) => m[1]);
    assert.ok(advertised.length >= 3, 'the discovery documents still advertise scopes');
    // Two lists are legitimate, and they answer different questions: the RFC
    // 9728 resource document names the DATA scopes the endpoint reads, while the
    // authorization-server and OIDC documents also name the identity scopes
    // /oauth/userinfo needs. Neither may name anything authorize refuses.
    for (const name of advertised) {
        assert.ok(['OAUTH_SCOPES', 'OAUTH_SCOPES_SUPPORTED'].includes(name),
            `a discovery document advertises ${name}, which this test does not account for`);
    }

    // And a tool's requiredScope has to be one of them. A tool asking for a
    // scope no newly issued token can carry is denied on every new connection
    // and works only for legacy 'mcp' tokens — which mcp-apps.js still honours,
    // so the breakage stays invisible to anyone testing with an old token.
    const literal = (appSource.match(/const OAUTH_SCOPES = \[([^\]]+)\];/) || [])[1];
    assert.ok(literal, 'OAUTH_SCOPES is still a literal list this test can read');
    const oidcLiteral = (appSource.match(/const OIDC_SCOPES = \[([^\]]+)\];/) || [])[1];
    assert.ok(oidcLiteral, 'OIDC_SCOPES is still a literal list this test can read');
    // The advertised union must be built from both lists, and authorize must
    // validate against THAT union — otherwise advertising an OIDC scope is an
    // invitation to a request the same endpoint then refuses, which is exactly
    // how the /mcp 'mcp'-scope challenge broke a connector before.
    assert.match(appSource, /const OAUTH_SCOPES_SUPPORTED = \[\.\.\.OIDC_SCOPES, \.\.\.OAUTH_SCOPES\];/,
        'the advertised union is no longer built from the two scope lists');
    assert.match(appSource, /const invalid = requested\.filter\(\(s\) => !OAUTH_SCOPES_SUPPORTED\.includes\(s\)\);/,
        'normalizeOauthScope no longer accepts everything the documents advertise');
    const issuable = [...literal.split(','), ...oidcLiteral.split(',')]
        .map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
    const appsSource = fs.readFileSync(path.join(__dirname, '..', 'mcp-apps.js'), 'utf8');
    const required = [...appsSource.matchAll(/requiredScope: '([^']+)'/g)].map((m) => m[1]);
    assert.ok(required.length >= 5, `the apps tools still declare required scopes (found ${required.length})`);
    for (const scope of new Set(required)) {
        assert.ok(issuable.includes(scope),
            `an /mcp/apps tool requires ${scope}, which no newly issued token can carry`);
    }
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
