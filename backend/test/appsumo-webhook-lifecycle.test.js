'use strict';

// Pins two entitlement-drift fixes in appsumoHandleEvent (backend/app.js).
// Style matches paid-first-signup.test.js / pricing-ladder.test.js: this
// logic lives inline in the monolith with no exported module, and no test
// in this repo requires the full app.js directly (it opens a live DB
// connection and starts background jobs at module scope) — so, like every
// other test of monolith-embedded logic, this pins the fix at the source
// level rather than executing it live.
//
// Bug 1 (migrate): AppSumo's `migrate` event is about licence-key lineage
// (account transfers), not pricing, and routinely omits `tier`. The old code
// wrote `tier` into the licence's $set unconditionally, using the shared
// `const tier = Number(body.tier) || 1` — a missing tier silently downgraded
// the licence row to 1 while the linked user's appsumoTier was left
// untouched, so the two permanently disagreed. Reproduced this session:
// khaledaziz130@gmail.com carried user.appsumoTier=2 against a linked
// licence at tier=1.
//
// Bug 2 (upgrade/downgrade): the branch looked up the licence being
// upgraded FROM by `findOne({ licenseKey: prevKey })`. AppSumo can omit
// prev_license_key (e.g. a tier-only change on the same key); Mongoose
// strips an undefined filter key, so the call silently became
// findOne({}) — the first licence in the collection, in whatever order
// Mongo returns it — which then re-granted a RANDOM unrelated user with
// this event's tier and rewrote their licenceKey.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const appSource = fs.readFileSync(require.resolve('../app'), 'utf8');

test('appsumo migrate never fabricates a tier when the event omits one', () => {
  // The old, buggy shape: tier written into the migrate $set unconditionally,
  // via the shared default-to-1 constant.
  assert.doesNotMatch(
    appSource,
    /event === 'migrate'\) \{[\s\S]{0,400}\$set: \{ parentLicenseKey: body\.parent_license_key \|\| null, tier,/,
    'a migrate payload with no body.tier must not downgrade the licence to tier 1'
  );
  // The fix: tier is only added to the $set when the event actually supplies
  // a valid positive number.
  const migrateBlock = appSource.slice(appSource.indexOf("event === 'migrate'"));
  assert.match(migrateBlock, /Number\.isFinite\(migrateTier\) && migrateTier > 0/,
    'migrate must guard tier before writing it');
  assert.match(migrateBlock.slice(0, 1000), /migrateSet\.tier = migrateTier/);
});

test('appsumo migrate re-grants the linked user so licence and user tier cannot diverge', () => {
  const migrateBlock = appSource.slice(appSource.indexOf("event === 'migrate'"), appSource.indexOf("event === 'migrate'") + 1300);
  assert.match(migrateBlock, /findOneAndUpdate\(\s*\n\s*\{ licenseKey \},\s*\n\s*\{ \$set: migrateSet \},\s*\n\s*\{ upsert: true, new: true \}/,
    'migrate must read back the persisted licence (new: true) to re-grant from its real tier, not the raw event tier');
  assert.match(migrateBlock, /if \(lic && lic\.userId\) \{/);
  assert.match(migrateBlock, /grantAppSumoProAccess\(user, \{ licenseKey, tier: lic\.tier \}\)/,
    'must re-grant with the licence\'s own persisted tier, matching the purchase/activate branch — never the raw, possibly-absent event tier');
});

test('appsumo upgrade/downgrade never looks up a licence by an undefined prev_license_key', () => {
  // The old, buggy shape: unconditional findOne keyed on prevKey.
  assert.doesNotMatch(
    appSource,
    /event === 'upgrade' \|\| event === 'downgrade'\) \{\s*\n\s*let lic = await AppSumoLicense\.findOne\(\{ licenseKey: prevKey \}\);/,
    'an unconditional findOne({licenseKey: prevKey}) degenerates to findOne({}) when prevKey is undefined — ' +
    'Mongoose strips undefined filter keys, matching an arbitrary licence and re-granting the wrong user'
  );
  const upgradeBlock = appSource.slice(appSource.indexOf("event === 'upgrade' || event === 'downgrade'"), appSource.indexOf("event === 'upgrade' || event === 'downgrade'") + 900);
  assert.match(upgradeBlock, /let lic = prevKey \? await AppSumoLicense\.findOne\(\{ licenseKey: prevKey \}\) : null;/,
    'the lookup must only run when prevKey was actually supplied');
});

test('appsumo purchase/activate still grants from the persisted licence tier (unchanged control)', () => {
  // Guards against a fix that accidentally also touched the branch that
  // already worked correctly.
  assert.match(appSource, /grantAppSumoProAccess\(user, \{ licenseKey, tier: lic\.tier \}\);/);
});
