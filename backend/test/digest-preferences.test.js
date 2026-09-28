'use strict';

// Explicit weekly Filing Monitor digest opt-in for Pro Annual. Power, Desk,
// enterprise and lifetime buyers keep the existing opt-out behavior; Pro Annual
// is the one plan that must consent before it is mailed. These are structural
// and module-level checks — runDigestSweep lives inside app.js (requiring that
// file starts the server and reads backend/.env), so the query shape and the
// pure entitlement helper are asserted directly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const digestSource = fs.readFileSync(path.join(__dirname, '..', 'monitor-digest.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'frontend-v2', 'dashboard.html'), 'utf8');
const tierLimits = require('../../lib/tier-limits');

function slice(source, startMarker, endMarker) {
    const start = source.indexOf(startMarker);
    assert.ok(start !== -1, `${startMarker} must exist`);
    const end = source.indexOf(endMarker, start + startMarker.length);
    assert.ok(end > start, `${startMarker} must have ${endMarker} after it`);
    return source.slice(start, end);
}

test('Pro Annual is the only plan that needs explicit digest consent', () => {
    for (const status of ['active', 'trialing', 'cancel_at_period_end']) {
        assert.equal(tierLimits.hasProAnnualDigestEntitlement({ subscription: { planId: 'pro-annual', status } }), true, status);
    }
    // An expired/canceled plan is not eligible even with a prior opt-in.
    assert.equal(tierLimits.hasProAnnualDigestEntitlement({ subscription: { planId: 'pro-annual', status: 'canceled' } }), false);
    assert.equal(tierLimits.hasProAnnualDigestEntitlement({ subscription: { planId: 'pro-annual', status: 'past_due' } }), false);
    // Existing opt-out plans are eligible through their plan, not this helper.
    assert.equal(tierLimits.hasProAnnualDigestEntitlement({ subscription: { planId: 'pro', status: 'active' } }), false);
    assert.equal(tierLimits.hasProAnnualDigestEntitlement({ subscription: { planId: 'power', status: 'active' } }), false);
    assert.equal(tierLimits.hasProAnnualDigestEntitlement({ subscription: { planId: 'desk', status: 'active' } }), false);
    assert.equal(tierLimits.hasProAnnualDigestEntitlement({}), false);
});

test('digestOptInAt is nullable and defaults to null so consent is never inferred', () => {
    assert.match(appSource, /digestOptInAt: \{ type: Date, default: null \}/);
});

test('preferences routes are authenticated and return a consistent state shape', () => {
    assert.match(appSource, /app\.get\('\/api\/digest\/preferences', authMiddleware/);
    assert.match(appSource, /app\.post\('\/api\/digest\/preferences', authMiddleware/);

    const stateFn = slice(appSource, 'function digestPreferenceState(', "app.get('/api/digest/preferences'");
    assert.match(stateFn, /eligible: !!eligible/);
    assert.match(stateFn, /enabled: !!eligible && digestOptInAt != null && digestOptOut !== true/,
        'an opt-out suppresses even a previously recorded opt-in');
    assert.match(stateFn, /cadence: 'weekly'/);
});

test('POST accepts only a boolean enabled; enable opts in and disable opts out', () => {
    const post = slice(appSource, "app.post('/api/digest/preferences'", 'async function runDigestSweep');
    assert.match(post, /if \(typeof body\.enabled !== 'boolean'\)/);
    assert.match(post, /await User\.updateOne\(\{ _id: req\.userId \}, \{ \$set: \{ digestOptInAt, digestOptOut: false \} \}\)/,
        'enable explicitly sets digestOptInAt and clears the unsubscribe flag');
    assert.match(post, /digestOptOut: false/);
    assert.match(post, /digestOptOut: true/);
    assert.match(post, /hasProAnnualDigestEntitlement\(req\.user, req\.subscription\)/);
    assert.match(post, /res\.status\(403\)/, 'enable is refused for a non-Pro-Annual account');
});

test('runDigestSweep adds Pro Annual only when opted in, and keeps the existing tiers', () => {
    const sweep = slice(appSource, 'async function runDigestSweep', 'function startDigest');
    // Cadence and last-sent bookkeeping are unchanged.
    assert.match(sweep, /const dueBefore = new Date\(Date\.now\(\) - 6\.5 \* 86400000\)/);
    assert.match(sweep, /\$or: \[\{ lastDigestAt: null \}, \{ lastDigestAt: \{ \$lt: dueBefore \} \}\]/);
    // Existing opt-out plans and lifetime buyers stay exactly as they were.
    assert.match(sweep, /'subscription\.planId': \{ \$in: \['power', 'power-monthly', 'desk', 'enterprise'\] \}, 'subscription\.status': \{ \$in: ACTIVE \}/);
    assert.match(sweep, /appsumoRedeemedAt: \{ \$ne: null \}/);
    assert.match(sweep, /dealMirrorRedeemedAt: \{ \$ne: null \}/);
    // Pro Annual is included only when digestOptInAt exists; the outer filter
    // still drops any account whose unsubscribe flag is set.
    assert.match(sweep, /'subscription\.planId': 'pro-annual', 'subscription\.status': \{ \$in: ACTIVE \}, digestOptInAt: \{ \$ne: null \}/);
    assert.match(sweep, /digestOptOut: \{ \$ne: true \}/);
    assert.match(sweep, /if \(!digest\) \{\s*advanceCadence = true;/,
        'a no-material-filing week advances cadence without sending');
    assert.match(sweep, /else if \(await mailer\.sendMail\([\s\S]{0,360}?advanceCadence = true;/,
        'only a successful email send advances cadence when a digest exists');
    assert.match(sweep, /if \(advanceCadence\) \{\s*u\.lastDigestAt = new Date\(\);/,
        'a failed send remains due for the next daily retry');
});

test('unsubscribe links still only ever set digestOptOut', () => {
    const unsub = slice(appSource, "app.get('/api/digest/unsubscribe'", "app.get('/api/outreach/unsubscribe'");
    assert.equal((unsub.match(/\$set: \{ digestOptOut: true \}/g) || []).length, 2, 'GET and one-click POST both opt out');
    assert.doesNotMatch(unsub, /digestOptInAt/);
});

test('the digest footer no longer claims a Power/Desk-only plan', () => {
    assert.doesNotMatch(digestSource, /Power or Desk plan/);
    assert.doesNotMatch(digestSource, /Power\/Desk plan/);
    assert.match(digestSource, /Filing Monitor is active on your account/);
});

test('dashboard exposes a hidden-by-default Pro Annual opt-in wired to the endpoint', () => {
    assert.match(dashboard, /id="digest-pref-section" hidden/);
    assert.match(dashboard, /id="digest-pref-toggle"/);
    assert.doesNotMatch(dashboard, /id="digest-pref-toggle"[^>]*checked/, 'the control defaults off');
    assert.match(dashboard, /Weekly filing digest/);
    assert.match(dashboard, /Email me the weekly Filing Monitor digest/);
    assert.match(dashboard, /turn this off/);
    assert.match(dashboard, /\/api\/digest\/preferences/);
    assert.match(dashboard, /credentials: 'same-origin'/,
        'the cookie session is explicitly sent to the authenticated preference endpoint');
    assert.match(dashboard, /method: 'POST'/);
    assert.match(dashboard, /body: JSON\.stringify\(\{ enabled: enabled \}\)/);
    // A failed or non-eligible read leaves it hidden; it never blocks loading.
    assert.match(dashboard, /if \(!data \|\| !data\.eligible\) return;/);
    assert.match(dashboard, /preference check is non-blocking/);
});
