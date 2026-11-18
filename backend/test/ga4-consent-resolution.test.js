'use strict';

// Server events use the opted-in GA4 browser identity saved at signup.
// Keep the app wiring checks alongside growth-measurement-v1's payload tests.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const appSource = fs.readFileSync(require.resolve('../app'), 'utf8');
const logFunnelEventBody = appSource.slice(
  appSource.indexOf('async function logFunnelEvent'),
  appSource.indexOf('function trackFunnel(event, userId, plan, extra)')
);

test('logFunnelEvent looks up stored consent only when the caller gave no consent signal', () => {
  assert.match(logFunnelEventBody, /let ga4Consent = data\.consent;/);
  assert.match(logFunnelEventBody, /let ga4Identity = data\.ga4Identity;/);
  assert.match(logFunnelEventBody, /if \(!canonical\?\.ga4EventName \|\| !ga4Server\.enabled\(\)/);
  assert.match(logFunnelEventBody, /if \(ga4Consent === undefined && userId\) \{/);
});

test('the fallback sources consent and clientId from the persisted, PII-free User fields', () => {
  assert.match(logFunnelEventBody, /User\.findById\(userId\)\.select\('analyticsConsent analyticsGa4'\)\.lean\(\)/,
    'must select only these two fields — never email, name, or any identity field');
  assert.match(logFunnelEventBody, /consentUser\.analyticsConsent === true/);
  assert.match(logFunnelEventBody, /ga4Identity \|\| consentUser\.analyticsGa4/,
    'must not override a clientId the event already had from a live request');
});

test('the GA4 send now uses the resolved values, not the raw per-call ones', () => {
  const sendBlock = logFunnelEventBody.slice(logFunnelEventBody.indexOf('ga4Server.sendServerEvent'));
  assert.match(sendBlock, /clientId: ga4Identity\.clientId,/);
  assert.doesNotMatch(logFunnelEventBody, /if \(canonical && data\.consent === true/,
    'the old gate read data.consent directly — it must go through the resolved ga4Consent now');
  assert.match(logFunnelEventBody, /if \(ga4Consent === true && ga4Identity\?\.clientId\)/);
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
  const fnBody = appSource.slice(start, appSource.indexOf('function eventTypeFor', start));
  assert.match(fnBody, /if \(requestFields\.consent === true\) \{\s*user\.analyticsConsent = true;\s*if \(requestFields\.ga4Identity\) user\.analyticsGa4 = requestFields\.ga4Identity;/);
});

test('PendingSignup carries consent through to materialization for paid-first signups', () => {
  assert.match(appSource, /consent: \{ type: Boolean, default: false \}/,
    'PendingSignup needs its own consent field — no live request exists at materialization time');
  const start = appSource.indexOf('if (pending.attribution || pending.consent)');
  assert.ok(start > -1, 'materializePendingSignup must forward pending.consent into attachSignupAttribution');
  assert.match(appSource.slice(start, start + 250), /consent: pending\.consent === true, ga4Identity: pending\.ga4Identity/);
});

test('real trial verification and Stripe invoices supply server-owned conversion data', () => {
  assert.match(appSource, /function trackVerifiedSignupTrial\(user, authMethod\) \{\s*if \(!identityVerified\(user\) \|\| !signupTrial\.active\(user\)\) return;/);
  assert.match(appSource, /if \(firstVerification\) \{\s*trackVerifiedSignupTrial\(user, 'email'\);/);
  assert.match(appSource, /if \(trialGranted \|\| verifiedNow\) trackVerifiedSignupTrial\(user, provider\);/);
  assert.match(appSource, /dedupeKey: payload\.id \? `stripe:invoice-paid:\$\{payload\.id\}` : null/);
  assert.match(appSource, /ga4Purchase: invoiceSubscription \? ga4Server\.purchaseParams\(payload, invoiceUser\.subscription\?\.planId, invoiceUser\.initialInvoiceId === payload\.id\) : null/);
});

test('/api/track/event forwards its own hard-verified consent and persists it onto the account', () => {
  const start = appSource.indexOf("app.post('/api/track/event'");
  // Slice to the NEXT route declaration rather than a fixed character count. A
  // fixed window silently truncates as the route grows, and the assertion then
  // fails for a reason unrelated to what it guards -- a 2000-char window did
  // exactly that once the consent-persistence block pushed `consent: true` to
  // offset 2115, so this test was failing at HEAD while the code was correct.
  const nextRoute = appSource.indexOf('\napp.', start + 1);
  const routeBody = appSource.slice(start, nextRoute === -1 ? undefined : nextRoute);
  assert.match(routeBody, /if \(body\.consent !== true\) return res\.status\(204\)\.end\(\);/,
    'the hard consent gate this fix relies on must still be there, unchanged');
  assert.match(routeBody, /req\.user\.analyticsConsent = true;/);
  assert.match(routeBody, /consent: true\s*\n\s*\}\);/, 'must forward the already-proven consent into the trackFunnel payload');
});
