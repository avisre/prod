'use strict';

// Geo wall (owner decision 2026-09-23): visitors from GEO_WALL_COUNTRIES
// (default SG,CN) get no free surface — pages, free tools, anonymous Ask,
// keyless MCP and the signup trial all require a paid plan — regardless of
// WALL_ALL_PAGES. Pins the source wiring plus the GeoIP resolution it uses.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const marketingAttribution = require('../marketing-attribution');

const appSource = () => fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('GEO_WALL_COUNTRIES defaults to SG,CN and an empty value switches it off', () => {
    const source = appSource();
    assert.match(source, /process\.env\.GEO_WALL_COUNTRIES \?\? 'SG,CN'/);
    assert.match(source, /if \(!GEO_WALL_COUNTRIES\.size\) return false;/);
    // A GeoIP miss is never walled.
    assert.match(source, /return Boolean\(country && GEO_WALL_COUNTRIES\.has\(country\)\);/);
});

test('the offline GeoIP lookup resolves SG and CN, and leaves other countries alone', () => {
    assert.equal(marketingAttribution.resolveCountry('101.127.0.1'), 'SG');
    assert.equal(marketingAttribution.resolveCountry('36.110.0.1'), 'CN');
    assert.equal(marketingAttribution.resolveCountry('::ffff:1.180.0.1'), 'CN');
    assert.equal(marketingAttribution.resolveCountry('8.8.8.8'), 'US');
    assert.equal(marketingAttribution.resolveCountry('127.0.0.1'), null);
});

test('paid means a paid plan: trials, comps and free-plan accounts do not pass', () => {
    const source = appSource();
    assert.match(source, /function subscriptionIsPaid\(sub\) \{\s*return Boolean\(sub && sub\.planId !== FREE_PLAN_ID\s*&& \['active', 'cancel_at_period_end'\]\.includes\(sub\.status\)\);/);
});

test('page wall applies to geo visitors even with WALL_ALL_PAGES off, and requires paid', () => {
    const source = appSource();
    const start = source.indexOf('async function wallAllPagesMiddleware');
    const end = source.indexOf('app.use(wallAllPagesMiddleware)');
    const section = source.slice(start, end);
    assert.match(section, /const geo = geoWalled\(req\);/);
    assert.match(section, /if \(!WALL_ALL_PAGES && !geo\) return next\(\);/);
    assert.match(section, /if \(geo && !subscriptionIsPaid\(normalized\)\) return wallRedirect\(res, '\/upgrade\.html'\);/);
});

test('free API surfaces refuse geo visitors: free tools, anonymous Ask, keyless MCP', () => {
    const source = appSource();
    assert.match(source, /app\.get\('\/api\/free-tools\/:tool'[\s\S]{0,200}if \(geoWalled\(req\) && !\(await requestUserIsPaid\(req\)\)\) return geoWallApiResponse\(res\);/);
    const anon = source.slice(source.indexOf('async function anonAskHandler'));
    assert.match(anon.slice(0, 600), /if \(geoWalled\(req\)\) return geoWallApiResponse\(res\);/);
    const mcp = source.slice(source.indexOf('async function apiKeyAuthOptional'));
    // A presented key is still honoured (apiKeyAuth + apiAccessGate gate it);
    // only the keyless free tier is refused.
    assert.match(mcp.slice(0, 700), /if \(offered\) return apiKeyAuth\(req, res, next\);[\s\S]*if \(geoWalled\(req\)\) return geoWallApiResponse\(res\);/);
});

test('signup trial is withheld from geo visitors everywhere SIGNUP_TRIAL_DAYS was read', () => {
    const source = appSource();
    assert.match(source, /function signupTrialDaysFor\(req\) \{\s*return geoWalled\(req\) \? 0 : SIGNUP_TRIAL_DAYS;\s*\}/);
    assert.match(source, /signupTrialDays: signupTrialDaysFor\(req\),/);
    // No request-scoped check may read the raw constant any more.
    const raw = source.match(/SIGNUP_TRIAL_DAYS (<=|>) 0/g) || [];
    assert.equal(raw.length, 0, 'every trial check goes through signupTrialDaysFor(req)');
});
