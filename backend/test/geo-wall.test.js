'use strict';

// Geo wall (owner decision 2026-09-23): visitors from GEO_WALL_COUNTRIES
// (default SG,CN,HK) get no free surface — pages, free tools, anonymous Ask,
// keyless MCP and the signup trial all require a paid plan — regardless of
// WALL_ALL_PAGES. Pins the source wiring plus the GeoIP resolution it uses.
//
// The wall is now the combined freeTierWallReason() (region first, then the
// hosting/VPN check); the hosting half is pinned in hosting-wall.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const marketingAttribution = require('../marketing-attribution');

const appSource = () => fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('GEO_WALL_COUNTRIES defaults to SG,CN,HK and an empty value switches it off', () => {
    const source = appSource();
    assert.match(source, /process\.env\.GEO_WALL_COUNTRIES \?\? 'SG,CN,HK'/);
    assert.match(source, /if \(!GEO_WALL_COUNTRIES\.size\) return false;/);
    // A GeoIP miss is never walled.
    assert.match(source, /return Boolean\(country && GEO_WALL_COUNTRIES\.has\(country\)\);/);
});

test('the offline GeoIP lookup resolves SG and CN, and leaves other countries alone', () => {
    assert.equal(marketingAttribution.resolveCountry('101.127.0.1'), 'SG');
    assert.equal(marketingAttribution.resolveCountry('36.110.0.1'), 'CN');
    assert.equal(marketingAttribution.resolveCountry('175.45.0.1'), 'HK');
    assert.equal(marketingAttribution.resolveCountry('::ffff:1.180.0.1'), 'CN');
    assert.equal(marketingAttribution.resolveCountry('8.8.8.8'), 'US');
    assert.equal(marketingAttribution.resolveCountry('127.0.0.1'), null);
});

test('requestCountry trusts Cloudflare headers in production only, else req.ip', () => {
    const prod = { NODE_ENV: 'production' };
    const dev = { NODE_ENV: 'development' };
    // The measured production shape: req.ip is a German proxy hop, CF says HK.
    const behindCf = { ip: '5.9.0.1', headers: { 'cf-ipcountry': 'hk', 'cf-connecting-ip': '175.45.0.1' } };
    assert.equal(marketingAttribution.requestCountry(behindCf, prod), 'HK');
    // A forged header outside production is ignored.
    assert.equal(marketingAttribution.requestCountry(behindCf, dev), marketingAttribution.resolveCountry('5.9.0.1'));
    // XX (unknown) and T1 (Tor) fall through to CF-Connecting-IP.
    assert.equal(marketingAttribution.requestCountry({ ip: '8.8.8.8', headers: { 'cf-ipcountry': 'XX', 'cf-connecting-ip': '101.127.0.1' } }, prod), 'SG');
    assert.equal(marketingAttribution.requestCountry({ ip: '8.8.8.8', headers: { 'cf-ipcountry': 'T1', 'cf-connecting-ip': '36.110.0.1' } }, prod), 'CN');
    // No Cloudflare headers at all: req.ip.
    assert.equal(marketingAttribution.requestCountry({ ip: '8.8.8.8', headers: {} }, prod), 'US');
    assert.equal(marketingAttribution.requestCountry(null, prod), null);
    assert.match(appSource(), /const country = marketingAttribution\.requestCountry\(req\);/);
});

test('paid means a paid plan: trials, comps and free-plan accounts do not pass', () => {
    const source = appSource();
    assert.match(source, /function subscriptionIsPaid\(sub\) \{\s*return Boolean\(sub && sub\.planId !== FREE_PLAN_ID\s*&& \['active', 'cancel_at_period_end'\]\.includes\(sub\.status\)\);/);
});

test('the walls are combined with the region checked first, and each reason names itself', () => {
    const source = appSource();
    assert.match(source, /function freeTierWallReason\(req\) \{\s*if \(geoWalled\(req\)\) return 'region';\s*if \(hostingWalled\(req\)\) return 'network';\s*return null;\s*\}/);
    assert.match(source, /code: reason === 'network' \? 'NETWORK_PAID_ONLY' : 'REGION_PAID_ONLY',/);
    // The old region-only 402 helper is gone; every free surface uses the
    // reason-aware one so the response body never misreports the cause.
    assert.doesNotMatch(source, /geoWallApiResponse/);
});

test('page wall applies to walled visitors even with WALL_ALL_PAGES off, and requires paid', () => {
    const source = appSource();
    const start = source.indexOf('async function wallAllPagesMiddleware');
    const end = source.indexOf('app.use(wallAllPagesMiddleware)');
    const section = source.slice(start, end);
    assert.match(section, /const walled = freeTierWallReason\(req\);/);
    assert.match(section, /if \(!WALL_ALL_PAGES && !walled\) return next\(\);/);
    assert.match(section, /if \(walled && !subscriptionIsPaid\(normalized\)\) return wallRedirect\(res, '\/upgrade\.html'\);/);
});

test('free API surfaces refuse walled visitors: free tools, anonymous Ask, keyless MCP', () => {
    const source = appSource();
    assert.match(source, /app\.get\('\/api\/free-tools\/:tool'[\s\S]{0,200}const wall = freeTierWallReason\(req\);\s*if \(wall && !\(await requestUserIsPaid\(req\)\)\) return freeTierWallResponse\(res, wall\);/);
    const anon = source.slice(source.indexOf('async function anonAskHandler'));
    assert.match(anon.slice(0, 600), /if \(askWall\) return freeTierWallResponse\(res, askWall\);/);

    // MCP is the one surface where the wall is NOT enforced at the transport.
    // A 402 (or an allowlist of blessed method names) lands before the session
    // starts, so the client cannot read the tool list and cannot tell a wall
    // from a dead server — which is how a directory came to mark /mcp
    // Unhealthy while three successive commits each added one more method name
    // to the exemption list. The verdict is still computed; it is carried on
    // the request and decided per tool call in mcp-endpoint.js, where it can
    // be READ (NETWORK_PAID_ONLY / REGION_PAID_ONLY as a tool error).
    // Sliced to the end of the function, not a fixed window: the reasoning is
    // written out in full above the code and grows every time the decision is
    // revisited, which is exactly what silently truncated the previous version
    // of this assertion.
    const mcp = source.slice(source.indexOf('async function apiKeyAuthOptional'));
    const mcpFn = mcp.slice(0, mcp.indexOf('\nconst anonMcpRateLimit'));
    assert.ok(mcpFn.length > 0, 'apiKeyAuthOptional is still where this test expects it');
    assert.match(mcpFn, /if \(offered\) return apiKeyAuth\(req, res, next\);/,
        'a presented key is still verified first — no silent downgrade to the keyless tier');
    assert.equal(/freeTierWallResponse|mcpWall\b/.test(mcpFn), false,
        'the MCP transport raises no wall of its own: every method, keyless or keyed, is admitted');
    assert.match(mcpFn, /req\.mcpWallReason = freeTierWallReason\(req\);/,
        'the wall verdict is carried to the tool layer rather than dropped');

    // And the tool layer can express it, or moving the decision would have
    // deleted the wall instead of relocating it.
    const endpoint = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'mcp-endpoint.js'), 'utf8');
    assert.match(endpoint, /NETWORK_PAID_ONLY|MSG_NETWORK/, 'the network wall survives as a tool error');
    assert.match(endpoint, /REGION_PAID_ONLY|MSG_REGION/, 'the region wall survives as a tool error');
});

test('signup trial is withheld from walled visitors everywhere SIGNUP_TRIAL_DAYS was read', () => {
    const source = appSource();
    assert.match(source, /function signupTrialDaysFor\(req\) \{\s*return freeTierWalled\(req\) \? 0 : SIGNUP_TRIAL_DAYS;\s*\}/);
    assert.match(source, /signupTrialDays: signupTrialDaysFor\(req\),/);
    // No request-scoped check may read the raw constant any more.
    const raw = source.match(/SIGNUP_TRIAL_DAYS (<=|>) 0/g) || [];
    assert.equal(raw.length, 0, 'every trial check goes through signupTrialDaysFor(req)');
});
