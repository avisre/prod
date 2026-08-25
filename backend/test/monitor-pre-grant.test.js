'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const { isGrantActive, hasActiveTrialGrant } = require('../../lib/trial-grant');

const now = Date.UTC(2026, 7, 25);
const day = 86400000;
const grant = (over = {}) => ({ feature: 'monitor', grantedAt: new Date(now - day), expiresAt: new Date(now + day), revokedAt: null, ...over });

test('an unexpired grant for the right feature opens the gate', () => {
  assert.equal(isGrantActive(grant(), 'monitor', now), true);
  assert.equal(hasActiveTrialGrant({ trialGrant: [grant()] }, 'monitor', now), true);
});

test('expiry is read live — no cron run can silently extend access', () => {
  assert.equal(isGrantActive(grant({ expiresAt: new Date(now - 1) }), 'monitor', now), false);
  // still un-revoked (the sweep runs a day later), but already closed
  assert.equal(hasActiveTrialGrant({ trialGrant: [grant({ expiresAt: new Date(now - 1) })] }, 'monitor', now), false);
});

test('a grant never leaks across features and an explicit revoke closes it at once', () => {
  assert.equal(isGrantActive(grant({ feature: 'dossier' }), 'monitor', now), false);
  assert.equal(isGrantActive(grant({ revokedAt: new Date(now - 1) }), 'monitor', now), false);
});

test('missing, empty and malformed grant records are all inert', () => {
  assert.equal(hasActiveTrialGrant(null, 'monitor', now), false);
  assert.equal(hasActiveTrialGrant({}, 'monitor', now), false);
  assert.equal(hasActiveTrialGrant({ trialGrant: [] }, 'monitor', now), false);
  assert.equal(hasActiveTrialGrant({ trialGrant: [null, { feature: 'monitor' }] }, 'monitor', now), false);
});
