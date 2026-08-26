'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const ltd = require('../direct-ltd');

const env = {
  DIRECT_LTD_ENABLED: 'true',
  STRIPE_PRICE_ID_LTD_STARTER: 'price_test_starter',
  STRIPE_PRICE_ID_LTD_INVESTOR: 'price_test_investor',
  STRIPE_PRICE_ID_LTD_PRO: 'price_test_pro'
};

test('direct tiers mirror the AppSumo tier ladder and Ask caps', () => {
  assert.deepEqual(ltd.TIER_NUMBERS, [1, 2, 3]);
  assert.deepEqual(
    Object.fromEntries(ltd.TIER_NUMBERS.map((t) => [t, ltd.TIERS[t].askCap])),
    { 1: 30, 2: 100, 3: 300 }
  );
});

test('each direct price is exactly $0.99 above its AppSumo tier', () => {
  for (const t of ltd.TIER_NUMBERS) {
    const cfg = ltd.TIERS[t];
    assert.equal(Number((cfg.directUsd - cfg.appsumoUsd).toFixed(2)), 0.99, `tier ${t}`);
  }
  assert.deepEqual(
    ltd.TIER_NUMBERS.map((t) => [ltd.TIERS[t].appsumoUsd, ltd.TIERS[t].directUsd]),
    [[39, 39.99], [79, 79.99], [149, 149.99]]
  );
});

test('price floors pass with shipped defaults', () => {
  assert.equal(ltd.priceFloorsOk(env), true);
  assert.deepEqual(ltd.assertAllPriceFloors(env).violations, []);
});

test('GUARD: a direct price below the AppSumo price is rejected', () => {
  assert.throws(
    () => ltd.assertPriceFloor({ tier: 2, directUsd: 78.0, env, context: 'unit' }),
    (e) => e.code === 'DIRECT_LTD_PRICE_FLOOR' && /not above the AppSumo price/.test(e.message)
  );
});

test('GUARD: a direct price EQUAL to the AppSumo price is rejected (AppSumo must be strictly cheapest)', () => {
  assert.throws(
    () => ltd.assertPriceFloor({ tier: 1, directUsd: 39, env, context: 'unit' }),
    (e) => e.code === 'DIRECT_LTD_PRICE_FLOOR'
  );
  // one cent above is the minimum acceptable
  assert.equal(ltd.assertPriceFloor({ tier: 1, directUsd: 39.01, env, context: 'unit' }), true);
});

test('GUARD: an AppSumo price RISE above our direct price trips the floor', () => {
  // Simulates AppSumo raising tier 3 to $199 without anyone updating this repo.
  const raised = { ...env, APPSUMO_TIER3_PRICE_USD: '199' };
  assert.equal(ltd.priceFloorsOk(raised), false);
  assert.throws(
    () => ltd.assertPriceFloor({ tier: 3, directUsd: ltd.TIERS[3].directUsd, env: raised, context: 'unit' }),
    (e) => e.code === 'DIRECT_LTD_PRICE_FLOOR'
  );
  // ...and the other two tiers are unaffected, so only the breaching tier stops.
  const report = ltd.assertAllPriceFloors(raised);
  assert.deepEqual(report.violations.map((v) => v.tier), [3]);
});

test('GUARD: a non-numeric or absent Stripe amount fails closed', () => {
  assert.throws(() => ltd.assertPriceFloor({ tier: 1, directUsd: undefined, env }), /GUARD FAILED/);
  assert.throws(() => ltd.assertPriceFloor({ tier: 1, directUsd: 'free', env }), /GUARD FAILED/);
});

test('GUARD: a malformed AppSumo override falls back to the listing price, never to 0', () => {
  const bad = { ...env, APPSUMO_TIER1_PRICE_USD: 'oops' };
  assert.equal(ltd.appsumoReferenceUsd(1, bad), 39);
  assert.throws(() => ltd.assertPriceFloor({ tier: 1, directUsd: 10, env: bad }), /GUARD FAILED/);
});

test('tier normalization accepts numbers and slugs, rejects anything else', () => {
  assert.equal(ltd.normalizeTier(2), 2);
  assert.equal(ltd.normalizeTier('3'), 3);
  assert.equal(ltd.normalizeTier('investor'), 2);
  assert.equal(ltd.normalizeTier('PRO'), 3);
  assert.equal(ltd.normalizeTier('enterprise'), null);
  assert.equal(ltd.normalizeTier(4), null);
  assert.equal(ltd.normalizeTier(null), null);
});

test('Price ID lookup round-trips and unknown IDs resolve to null', () => {
  assert.equal(ltd.priceIdFor(2, env), 'price_test_investor');
  assert.equal(ltd.tierFromPriceId('price_test_investor', env), 2);
  assert.equal(ltd.tierFromPriceId('price_live_somethingelse', env), null);
  assert.equal(ltd.tierFromPriceId('', env), null);
  assert.equal(ltd.priceIdFor(1, {}), null);
});

test('minted license keys are channel-tagged, unique, and distinguishable from AppSumo keys', () => {
  const a = ltd.mintLicenseKey(2), b = ltd.mintLicenseKey(2);
  assert.match(a, /^SPP-DIRECT-T2-[A-Z0-9_-]{16,}$/);
  assert.notEqual(a, b);
  assert.equal(ltd.isDirectLicenseKey(a), true);
  assert.equal(ltd.isDirectLicenseKey('0a1b2c3d-appsumo-issued-key'), false);
});

test('unit amounts are integer cents matching the advertised price', () => {
  assert.deepEqual(ltd.TIER_NUMBERS.map(ltd.unitAmountFor), [3999, 7999, 14999]);
});

test('channel tag is distinct from appsumo so revenue cannot be double-counted', () => {
  assert.equal(ltd.CHANNEL, 'direct-ltd');
  assert.notEqual(ltd.CHANNEL, 'appsumo');
  assert.equal(ltd.CHECKOUT_TYPE, 'direct_ltd');
});

test('publicTiers exposes all three prices and marks unconfigured tiers unavailable', () => {
  const tiers = ltd.publicTiers(env);
  assert.deepEqual(tiers.map((t) => t.priceDisplay), ['$39.99', '$79.99', '$149.99']);
  assert.equal(tiers.every((t) => t.available), true);
  assert.equal(ltd.publicTiers({}).every((t) => t.available === false), true);
});

test('publicTiers exposes the AppSumo reference price so the page can state the real gap', () => {
  const tiers = ltd.publicTiers(env);
  assert.deepEqual(tiers.map((t) => t.appsumoPriceUsd), [39, 79, 149]);
  assert.deepEqual(tiers.map((t) => t.appsumoPriceDisplay), ['$39.00', '$79.00', '$149.00']);
  // The floor guarantee the copy relies on: direct is always strictly above.
  assert.equal(tiers.every((t) => t.priceUsd > t.appsumoPriceUsd), true);
});

test('publicTiers follows an AppSumo price override rather than the listing constant', () => {
  // The whole reason the page must not hard-code the gap: this override moves
  // the AppSumo price without a deploy, and stale copy would then misstate it.
  const tiers = ltd.publicTiers({ ...env, APPSUMO_TIER1_PRICE_USD: '45' });
  assert.equal(tiers[0].appsumoPriceUsd, 45);
  assert.equal(tiers[0].appsumoPriceDisplay, '$45.00');
  assert.equal(tiers[1].appsumoPriceUsd, 79);
});

test('direct LTD is off unless explicitly enabled', () => {
  assert.equal(ltd.enabled({}), false);
  assert.equal(ltd.enabled({ DIRECT_LTD_ENABLED: 'false' }), false);
  assert.equal(ltd.enabled(env), true);
});
