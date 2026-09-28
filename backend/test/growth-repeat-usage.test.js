'use strict';

// Repeat-usage instrumentation: a cached/polled Dossier or Filing Monitor
// serve must record the same per-user view and idempotent feature activation a
// fresh serve does, the authenticated briefing is counted once per user per UTC
// day, and explicit Dossier Normal/Analyst selections flow through the existing
// consent-gated browser pipeline. These are structural checks (the live routes
// need Mongo + Stripe + the AI provider), matching the convention of
// dossier-progressive.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const frontendSource = fs.readFileSync(path.join(root, 'frontend-v2', 'assets', 'dossier.js'), 'utf8');
const frontendAppSource = fs.readFileSync(path.join(root, 'frontend-v2', 'assets', 'app.js'), 'utf8');
const growth = require('../growth-measurement');

function routeSlice(source, startMarker, nextMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start !== -1, `route ${startMarker} must exist`);
    const end = source.indexOf(nextMarker, start + startMarker.length);
    assert.ok(end > start, `route ${startMarker} must have a following app route`);
    return source.slice(start, end);
}

test('repeat-usage canonical events are registered with the right allowlists', () => {
    assert.equal(growth.normalizeEventName('feature_activation_completed'), 'feature_activation_completed');
    assert.equal(growth.normalizeEventName('briefing_viewed'), 'briefing_viewed');
    assert.equal(growth.normalizeEventName('dossier_viewed'), 'dossier_viewed');
    assert.equal(growth.normalizeEventName('filing_monitor_viewed'), 'filing_monitor_viewed');
    assert.equal(growth.normalizeEventName('dossier_mode_selected'), 'dossier_mode_selected');
    assert.equal(growth.validateBrowserEvent('dossier_mode_selected'), true);
    assert.equal(growth.validateBrowserEvent('briefing_viewed'), false, 'a server-owned briefing view is not a browser intent event');
    assert.equal(growth.validateBrowserEvent('feature_activation_completed'), false);
});

test('trackActivation writes a distinct per-feature canonical name, never activation_completed', () => {
    const start = appSource.indexOf('async function trackActivation(');
    assert.ok(start !== -1, 'trackActivation must exist');
    const end = appSource.indexOf('\nfunction recordDossierEngagement', start);
    assert.ok(end > start);
    const fn = appSource.slice(start, end);
    assert.match(fn, /eventName: 'feature_activation_completed'/);
    assert.doesNotMatch(fn, /eventName: 'activation_completed'/);
    assert.match(fn, /dedupeKey: `activation-job:/, 'the per-feature dedupe key stays distinct');
});

test('complete Dossier and company Monitor results log repeat use once per UTC day', () => {
    const start = appSource.indexOf('function recordRepeatFeatureView(');
    const end = appSource.indexOf('\n}', start);
    assert.ok(start !== -1 && end > start, 'daily repeat-feature logger must exist');
    const helper = appSource.slice(start, end);
    assert.match(helper, /toISOString\(\)\.slice\(0, 10\)/);
    assert.match(helper, /dedupeKey: `\$\{eventName\}:\$\{String\(userId\)\}:\$\{dayKey\}`/);
    assert.match(helper, /\.\.\.trackingRequestFields\(req, res\)/,
        'the canonical event gets flattened attribution and bot/test classifications');
    assert.doesNotMatch(helper, /symbol|ticker|prompt|answer|holdings/i,
        'repeat-use funnel rows do not store research or portfolio content');

    const dossierHelper = appSource.slice(appSource.indexOf('function recordDossierEngagement('), appSource.indexOf('\nfunction recordMonitorEngagement('));
    assert.match(dossierHelper, /recordRepeatFeatureView\(req, res, 'dossier_viewed', 'dossier'\)/);
    const monitorHelper = appSource.slice(appSource.indexOf('function recordMonitorEngagement('), appSource.indexOf('\nfunction recordRepeatFeatureView('));
    assert.match(monitorHelper, /recordRepeatFeatureView\(req, res, 'filing_monitor_viewed', 'filing_monitor'\)/);
});

test('account activation is upserted by its canonical dedupe key', () => {
    const start = appSource.indexOf('async function meaningfulActivationFor(');
    assert.ok(start !== -1, 'meaningfulActivationFor must exist');
    const end = appSource.indexOf('\nasync function trackActivation(', start);
    assert.ok(end > start);
    const fn = appSource.slice(start, end);
    assert.match(fn, /eventName: 'activation_completed', dedupeKey: `activation_completed:\$\{String\(user\._id\)\}`/,
        'the one canonical account activation is keyed by dedupeKey, not shadowed by historical per-feature rows');
});

test('complete dossier serves record a view and engagement, but partials never do', () => {
    const dossier = routeSlice(appSource, "app.get('/api/dossier/:symbol'", '\napp.');

    // The fund workspace is a delivered result, so it engages like a company Dossier.
    assert.match(dossier, /if \(instrument && assetProfile\.isFundAsset\(instrument\.assetType\)\) \{[\s\S]{0,400}?recordDossierView\(req\.userId, sym, instrument\.name\);([\s\S]{0,260}?)recordDossierEngagement\(req, res\);/);

    // Poll branch: only a complete payload records.
    assert.match(dossier, /if \(!cached\.partial\) recordDossierView\(req\.userId, sym, cached\.name\);/);
    assert.match(dossier, /if \(!cached\.partial\) recordDossierEngagement\(req, res\);/);

    // Pre-cache branch: both records are inside the partial guard.
    assert.match(dossier, /if \(!preCached\.partial\) \{[\s\S]{0,200}?recordDossierView\(req\.userId, sym, preCached\.name\);[\s\S]{0,200}?recordDossierEngagement\(req, res\);/);

    // Fresh build: a partial pollable intermediate must not record a view or engagement.
    assert.match(dossier, /if \(winner && !winner\.error && !winner\.partial\) \{[\s\S]{0,200}?recordDossierView\(req\.userId, sym, winner\.name\);[\s\S]{0,200}?recordDossierEngagement\(req, res\);/);
    assert.doesNotMatch(dossier, /recordDossierView\(req\.userId, sym, winner && winner\.name\)/,
        'the fresh path must guard partial before recording a view');
    assert.equal((dossier.match(/recordDossierEngagement\(/g) || []).length, 4,
        'fund, complete poll, complete pre-cache hit and fresh build each engage once');

    const monitor = routeSlice(appSource, "app.get('/api/filings/:symbol/report'", '\napp.');
    assert.match(monitor, /recordMonitorView\(resolvedTrackingUserId\(req\), normSym, cached\.name\);\s*recordMonitorEngagement\(req, res\);/);
    assert.match(monitor, /if \(winner && !winner\.error\) recordMonitorEngagement\(req, res\);/);
    assert.equal((monitor.match(/recordMonitorEngagement\(/g) || []).length, 2,
        'a complete poll and a fresh build each engage once');
    const monitorHelper = appSource.slice(appSource.indexOf('function recordMonitorEngagement('), appSource.indexOf('\n}', appSource.indexOf('function recordMonitorEngagement(')));
    assert.match(monitorHelper, /trackActivation\(userId, 'filing_monitor'/);
});

test('a fund Monitor snapshot is not counted as Filing Monitor engagement', () => {
    const monitor = routeSlice(appSource, "app.get('/api/filings/:symbol/report'", '\napp.');
    const fundStart = monitor.indexOf('if (instrument && assetProfile.isFundAsset(instrument.assetType)) {');
    const fundEnd = monitor.indexOf('// Free allowance: MONITOR_FREE_STOCKS', fundStart);
    assert.ok(fundStart !== -1 && fundEnd > fundStart, 'the fund branch must exist before the free-allowance block');
    const fund = monitor.slice(fundStart, fundEnd);
    assert.match(fund, /recordMonitorView\(resolvedTrackingUserId\(req\), normSym, instrument\.name\);/);
    assert.doesNotMatch(fund, /recordMonitorEngagement/,
        'a labelled fund snapshot explicitly is not a filing-change report, so it is not Monitor engagement');
});

test('dossier_mode_selected attributes to the authenticated account from the same-origin auth cookie', () => {
    const route = appSource.slice(
        appSource.indexOf("app.post('/api/track/event'"),
        appSource.indexOf("app.post('/api/track/page_view'")
    );
    assert.ok(route.length > 0, 'the browser-event route must exist');
    assert.match(route, /optionalAuth/);
    assert.match(route, /if \(body\.consent !== true\) return res\.status\(204\)\.end\(\);/,
        'analytics consent is still hard-required');
    // The account id always comes from the resolved session, never from the body.
    assert.match(route, /trackFunnel\(legacyEvent, req\.user \? req\.user\._id : null/);
    assert.doesNotMatch(route, /body\.(userId|email|symbol|prompt|answer)/);

    const optional = appSource.slice(
        appSource.indexOf('async function optionalAuth('),
        appSource.indexOf('// API-key auth for the public REST API')
    );
    assert.match(optional, /authTokenFromRequest\(req\)/, 'optionalAuth resolves the same session token the server issues');
    assert.match(optional, /req\.user = user;/, 'optionalAuth resolves valid sessions to account documents');
    assert.doesNotMatch(optional, /req\.userId = user\._id;/,
        'usage attribution uses the resolved account without changing the Monitor credit-charge path');
    assert.match(appSource, /function resolvedTrackingUserId\(req\) \{\s*return req && \(req\.userId \|\| \(req\.user && req\.user\._id\)\)/,
        'user-scoped analytics can use optional-auth identity without mutating its billing fields');

    const tokenFn = appSource.slice(
        appSource.indexOf('function authTokenFromRequest('),
        appSource.indexOf('function authCookieDomain(')
    );
    assert.match(tokenFn, /parseCookieHeader\(req\.headers\.cookie \|\| ''\)\[AUTH_COOKIE_NAME\]/,
        'the sp_auth HttpOnly cookie is the account source when no bearer token is present');

    // Same-origin sendBeacon carries that cookie; the browser sender is consent-gated.
    assert.match(frontendAppSource, /navigator\.sendBeacon\('\/api\/track\/event'/);
    assert.match(frontendAppSource, /if \(!analyticsConsentGranted\(\)\) return;/);
});

test('a valid authenticated briefing is counted once per user per UTC day, but never the sample', () => {
    const fnStart = appSource.indexOf('function recordBriefingViewed(');
    assert.ok(fnStart !== -1, 'recordBriefingViewed must exist');
    const fn = appSource.slice(fnStart, appSource.indexOf('\n}', fnStart));
    assert.match(fn, /dedupeKey: `briefing_viewed:\$\{String\(req\.userId\)\}:\$\{dayKey\}`/);
    assert.match(fn, /toISOString\(\)\.slice\(0, 10\)/, 'the dedupe window is a UTC calendar day');
    assert.match(fn, /\.\.\.trackingRequestFields\(req, res\)/);

    const briefing = routeSlice(appSource, "app.get('/api/portfolio/briefing'", "app.get('/api/portfolio/briefing/sample'");
    assert.ok((briefing.match(/if \([^)]*\) recordBriefingViewed\(req, res\);/g) || []).length >= 2,
        'both the cached and freshly generated valid branches record');

    const sample = routeSlice(appSource, "app.get('/api/portfolio/briefing/sample'", '\napp.');
    assert.doesNotMatch(sample, /recordBriefingViewed/, 'the public sample briefing is never counted');
});

test('dossier mode selections are validated and sent through the consent-gated browser pipeline', () => {
    assert.match(frontendSource, /function trackDossierMode\(mode\)/);
    assert.match(frontendSource, /if \(mode !== 'normal' && mode !== 'analyst'\) return;/);
    assert.match(frontendSource, /window\.V2\.trackGrowthEvent\('dossier_mode_selected'/);
    assert.match(frontendSource, /ctaId: `dossier-mode-\$\{mode\}`/);

    const calls = frontendSource.match(/trackDossierMode\('(?:normal|analyst)'\)/g) || [];
    assert.equal(calls.length, 5, 'both render sites plus the show-analyst button wire the helper');

    const payloadStart = frontendSource.indexOf("trackGrowthEvent('dossier_mode_selected'");
    const payload = frontendSource.slice(payloadStart, payloadStart + 220);
    assert.match(payload, /featureType: 'dossier'/);
    assert.doesNotMatch(payload, /ticker|prompt|answer|holdings|email/i, 'no research or account text is sent');
    assert.doesNotMatch(frontendSource, /trackGrowthEvent\(['"]ask/, 'no Ask mode-toggle events were added');
    assert.match(appSource, /dossier-mode-\(normal\|analyst\)/, 'the browser-event endpoint validates the mode server-side too');
});
