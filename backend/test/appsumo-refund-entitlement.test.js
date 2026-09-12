'use strict';

// Pins the AppSumo refund-entitlement leak found this session:
// revokeAppSumoAccess cleared only subscription.status and appsumoAiCap,
// leaving appsumoTier and appsumoRedeemedAt untouched — so a refunded
// lifetime buyer kept their full credit wallet (credits.ltdAllowance keys off
// exactly those two fields) and API/MCP access (hasApiAccess checked
// appsumoTier===3 with no status check at all) permanently.
//
// credits.js is a standalone module, so the downstream half of this is a
// real, live-execution test, not a source pin. revokeAppSumoAccess and
// hasApiAccess themselves are inline in the app.js monolith with no exported
// module — same constraint as appsumo-webhook-lifecycle.test.js — so those
// two are verified by source-text assertion, matching this repo's existing
// convention for logic that lives only in app.js (paid-first-signup.test.js,
// pricing-ladder.test.js, etc.).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const credits = require('../credits');

test('live: a tier-3 AppSumo buyer holds the full lifetime wallet (control)', () => {
  const user = { appsumoTier: 3, appsumoRedeemedAt: new Date('2026-01-01') };
  assert.equal(credits.ltdAllowance(user, {}), 800, 'V1 wallet — no V2 cutover configured in this env');
});

test('live: nulling appsumoTier/appsumoRedeemedAt (the fix) zeroes the lifetime wallet', () => {
  // Exactly the two fields revokeAppSumoAccess's fix now clears.
  const revoked = { appsumoTier: null, appsumoRedeemedAt: null };
  assert.equal(credits.ltdAllowance(revoked, {}), 0,
    'a refunded buyer must fall through to the derived, non-lifetime allowance, not keep the LTD grant');
});

test('live: demonstrates the leak — subscription.status alone never gated the wallet', () => {
  // This is the exact shape revokeAppSumoAccess used to leave behind: status
  // flipped to cancelled, but appsumoTier/appsumoRedeemedAt still present.
  const preFixRevokedState = { appsumoTier: 3, appsumoRedeemedAt: new Date('2026-01-01'), subscription: { status: 'cancelled' } };
  assert.equal(credits.ltdAllowance(preFixRevokedState, {}), 800,
    'ltdAllowance() only reads appsumoTier/appsumoRedeemedAt — subscription.status was never enough on its own, which is why the leak needed the fields themselves cleared');
});

const appSource = fs.readFileSync(require.resolve('../app'), 'utf8');

test('source: revokeAppSumoAccess clears appsumoTier/appsumoRedeemedAt and guards an active Stripe subscriber', () => {
  const start = appSource.indexOf('async function revokeAppSumoAccess');
  const fnBody = appSource.slice(start, start + 1400);
  assert.match(fnBody, /if \(isActiveStripeSubscriber\(user\)\) return;/,
    'must not clobber a subscription the user separately holds via Stripe — mirrors revokeDealMirrorAccess');
  assert.match(fnBody, /user\.appsumoTier = null;/);
  assert.match(fnBody, /user\.appsumoRedeemedAt = null;/);
  assert.doesNotMatch(fnBody, /user\.appsumoTier = 0/,
    'never a falsy-but-numeric sentinel — an unknown truthy tier resolves UP to 3 elsewhere (ltdAllowance, appsumoTierConfig), so null is the only safe value');
  // appsumoLicenseKey must survive the revoke: the deactivate branch and the
  // reconcile job both match on it for idempotency.
  assert.doesNotMatch(fnBody, /user\.appsumoLicenseKey = null/);
});

test('source: hasApiAccess denies a cancelled lifetime AppSumo/DealMirror grant', () => {
  const start = appSource.indexOf('function hasApiAccess');
  const fnBody = appSource.slice(start, start + 1400);
  assert.match(fnBody, /if \(sub\.status === 'cancelled'\) return false;/);
  const guardIdx = fnBody.indexOf("sub.status === 'cancelled'");
  const fallbackIdx = fnBody.indexOf('appsumoTier) === 3');
  assert.ok(guardIdx > -1 && fallbackIdx > -1 && guardIdx < fallbackIdx,
    'the cancelled-status check must run before the tier-3 fallback it is meant to gate');
});
