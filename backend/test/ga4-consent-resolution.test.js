'use strict';

// Pins the GA4 consent/clientId fix found this session: sign_up, begin_checkout
// and purchase never reached GA4 because (a) consent was never threaded onto
// the events that map to those GA4 names, and (b) even where it was, a
// server-originated event (the Stripe webhook) has no request/cookie of its
// own to source a clientId from. data.consent was simply undefined for every
// such call — never explicitly true or false — so the old gate
// (`data.consent === true`) silently never fired for them.
//
// Style matches paid-first-signup.test.js / api-access-gating.test.js:
// logFunnelEvent lives inline in the app.js monolith with no exported module
// (same constraint as appsumo-webhook-lifecycle.test.js and
// appsumo-refund-entitlement.test.js), so this pins the fix at the source
// level. credits.js-style live execution isn't available here — there is no
// separable module to import.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const appSource = fs.readFileSync(require.resolve('../app'), 'utf8');
const logFunnelEventBody = appSource.slice(
  appSource.indexOf('async function logFunnelEvent'),
  appSource.indexOf('function trackFunnel(event, userId, plan, extra)')
);

test('logFunnelEvent resolves a fallback consent/clientId only when the caller supplied neither', () => {
  assert.match(logFunnelEventBody, /let ga4Consent = data\.consent;/);
  assert.match(logFunnelEventBody, /let ga4ClientId = canonical && canonical\.anonymousId;/);
  // The fallback must trigger on undefined specifically — never on an
  // explicit false, which is a real "no, do not send this" signal.
  assert.match(logFunnelEventBody, /if \(ga4Consent === undefined && userId && ga4Server\.enabled\(\)\) \{/,
    'must not re-fire for every event with a userId — only when the caller gave no consent signal at all, and only when GA4 sending is actually enabled');
});

test('the fallback sources consent and clientId from the persisted, PII-free User fields', () => {
  assert.match(logFunnelEventBody, /User\.findById\(userId\)\.select\('analyticsConsent analyticsAnonymousId'\)\.lean\(\)/,
    'must select only these two fields — never email, name, or any identity field');
  assert.match(logFunnelEventBody, /consentUser\.analyticsConsent === true/);
  assert.match(logFunnelEventBody, /ga4ClientId \|\| consentUser\.analyticsAnonymousId \|\| null/,
    'must not override a clientId the event already had from a live request');
});

test('the GA4 send now uses the resolved values, not the raw per-call ones', () => {
  const sendBlock = logFunnelEventBody.slice(logFunnelEventBody.indexOf('ga4Server.sendServerEvent'));
  assert.match(sendBlock, /clientId: ga4ClientId,/, 'must send the resolved clientId, not canonical.anonymousId directly');
  assert.doesNotMatch(logFunnelEventBody, /if \(canonical && data\.consent === true/,
    'the old gate read data.consent directly — it must go through the resolved ga4Consent now');
  assert.match(logFunnelEventBody, /if \(canonical && ga4Consent === true/);
});

test('a lookup failure never blocks the funnel write it happens after', () => {
  const fallbackBlock = logFunnelEventBody.slice(logFunnelEventBody.indexOf('if (ga4Consent === undefined'));
  assert.match(fallbackBlock.slice(0, 500), /catch \(_\) \{ \/\* best-effort only/);
});

test('User schema carries analyticsConsent, defaulting to false (fail-closed)', () => {
  assert.match(appSource, /analyticsConsent: \{ type: Boolean, default: false \}/);
});

test('attachSignupAttribution only ever writes true, never overwrites with a falsy signal', () => {
  const start = appSource.indexOf('function attachSignupAttribution');
  const fnBody = appSource.slice(start, start + 800);
  assert.match(fnBody, /if \(requestFields\.consent === true\) user\.analyticsConsent = true;/);
});

test('PendingSignup carries consent through to materialization for paid-first signups', () => {
  assert.match(appSource, /consent: \{ type: Boolean, default: false \}/,
    'PendingSignup needs its own consent field — no live request exists at materialization time');
  const start = appSource.indexOf('if (pending.attribution || pending.consent)');
  assert.ok(start > -1, 'materializePendingSignup must forward pending.consent into attachSignupAttribution');
  assert.match(appSource.slice(start, start + 200), /consent: pending\.consent === true/);
});

test('/api/track/event forwards its own hard-verified consent and persists it onto the account', () => {
  const start = appSource.indexOf("app.post('/api/track/event'");
  const routeBody = appSource.slice(start, start + 2000);
  assert.match(routeBody, /if \(body\.consent !== true\) return res\.status\(204\)\.end\(\);/,
    'the hard consent gate this fix relies on must still be there, unchanged');
  assert.match(routeBody, /req\.user\.analyticsConsent = true;/);
  assert.match(routeBody, /consent: true\s*\n\s*\}\);/, 'must forward the already-proven consent into the trackFunnel payload');
});
