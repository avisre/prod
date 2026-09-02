'use strict';

// Filing Monitor on the lifetime tiers. The entitlement is coverage-capped
// rather than all-or-nothing, so the things worth pinning down are: who counts
// as a lifetime buyer, what each tier's cap is, that an unknown tier resolves
// UP (never under-serving someone who paid), and that non-LTD accounts are left
// completely alone — Power/Desk must stay uncapped.

const test = require('node:test');
const assert = require('node:assert');
const tierLimits = require('../../lib/tier-limits');

const appsumo = (tier) => ({ appsumoRedeemedAt: new Date('2026-08-01'), appsumoTier: tier });
const dealmirror = (tier) => ({ dealMirrorRedeemedAt: new Date('2026-08-01'), dealMirrorTier: tier });
const syms = (n) => Array.from({ length: n }, (_, i) => `SYM${i}`);

test('lifetime buyers are recognised on either channel', () => {
    assert.equal(tierLimits.isLifetimeBuyer(appsumo(1)), true);
    assert.equal(tierLimits.isLifetimeBuyer(dealmirror(2)), true);
    assert.equal(tierLimits.isLifetimeBuyer({ subscription: { planId: 'pro', status: 'active' } }), false);
    assert.equal(tierLimits.isLifetimeBuyer({}), false);
    assert.equal(tierLimits.isLifetimeBuyer(null), false);
    assert.equal(tierLimits.isLifetimeBuyer(undefined), false);
});

test('each lifetime tier gets its own company cap', () => {
    assert.equal(tierLimits.monitorCapFor(appsumo(1)), 12);
    assert.equal(tierLimits.monitorCapFor(appsumo(2)), 40);
    assert.equal(tierLimits.monitorCapFor(appsumo(3)), tierLimits.UNLIMITED);
});

test('an unknown tier resolves UP, never down', () => {
    // A data gap must never leave a paying customer with less than they bought.
    assert.equal(tierLimits.monitorCapFor(appsumo(99)), tierLimits.UNLIMITED);
    assert.equal(tierLimits.monitorCapFor(appsumo(null)), tierLimits.UNLIMITED);
    assert.equal(tierLimits.monitorCapFor(appsumo(undefined)), tierLimits.UNLIMITED);
});

test('non-lifetime accounts return null, meaning "does not apply"', () => {
    // null is load-bearing: it must not be read as a cap of zero, or a Power
    // subscriber would silently lose every symbol.
    assert.equal(tierLimits.monitorCapFor({ subscription: { planId: 'power', status: 'active' } }), null);
    assert.equal(tierLimits.monitorCapFor({}), null);
});

test('capSymbols trims lifetime buyers to their tier', () => {
    assert.equal(tierLimits.capSymbols(appsumo(1), syms(25)).length, 12);
    assert.equal(tierLimits.capSymbols(appsumo(2), syms(25)).length, 25); // under the cap, untouched
    assert.equal(tierLimits.capSymbols(appsumo(2), syms(60)).length, 40);
    assert.equal(tierLimits.capSymbols(appsumo(3), syms(500)).length, 500);
});

test('capSymbols is a no-op for everyone who is not a lifetime buyer', () => {
    const power = { subscription: { planId: 'desk', status: 'active' } };
    assert.equal(tierLimits.capSymbols(power, syms(500)).length, 500);
    assert.equal(tierLimits.capSymbols({}, syms(500)).length, 500);
});

test('capSymbols survives bad input without throwing', () => {
    assert.deepEqual(tierLimits.capSymbols(appsumo(1), null), []);
    assert.deepEqual(tierLimits.capSymbols(appsumo(1), undefined), []);
    assert.deepEqual(tierLimits.capSymbols(null, ['A']), ['A']);
});

// ---- Monitor cap v2 (1/4/8) -------------------------------------------------
// The narrowing applies to redemptions on/after the cutover and to nobody else.
// Every case below passes env explicitly rather than mutating process.env: the
// grandfather clause is the only thing keeping a paid-for entitlement intact,
// so it must not be provable only under a global that another test can clobber.

const V2 = { MONITOR_CAP_V2_EFFECTIVE_FROM: '2026-09-10T00:00:00.000Z' };
const CUTOVER_MS = Date.parse(V2.MONITOR_CAP_V2_EFFECTIVE_FROM);
const before = (tier) => ({ appsumoRedeemedAt: new Date(CUTOVER_MS - 86400000), appsumoTier: tier });
const after = (tier) => ({ appsumoRedeemedAt: new Date(CUTOVER_MS + 86400000), appsumoTier: tier });
const exactly = (tier) => ({ appsumoRedeemedAt: new Date(CUTOVER_MS), appsumoTier: tier });

test('v2: buyers who redeemed before the cutover keep 12/40/unlimited', () => {
    // The clawback guard. If this ever fails, a lifetime entitlement someone
    // already paid for has been retroactively narrowed.
    assert.equal(tierLimits.monitorCapFor(before(1), V2), 12);
    assert.equal(tierLimits.monitorCapFor(before(2), V2), 40);
    assert.equal(tierLimits.monitorCapFor(before(3), V2), tierLimits.UNLIMITED);
});

test('v2: buyers who redeemed on/after the cutover get 1/4/8', () => {
    assert.equal(tierLimits.monitorCapFor(after(1), V2), 1);
    assert.equal(tierLimits.monitorCapFor(after(2), V2), 4);
    assert.equal(tierLimits.monitorCapFor(after(3), V2), 8);
    // The boundary is >=, so a redemption at the exact cutover ms is v2.
    assert.equal(tierLimits.monitorCapFor(exactly(1), V2), 1);
});

test('v2: an unset or unparseable cutover leaves everyone on v1', () => {
    // Fail-closed on the downgrade: a config typo must not narrow anybody.
    assert.equal(tierLimits.monitorCapFor(after(1), {}), 12);
    assert.equal(tierLimits.monitorCapFor(after(1), { MONITOR_CAP_V2_EFFECTIVE_FROM: '' }), 12);
    assert.equal(tierLimits.monitorCapFor(after(1), { MONITOR_CAP_V2_EFFECTIVE_FROM: 'soon' }), 12);
});

test('v2: an unknown tier still resolves UP', () => {
    assert.equal(tierLimits.monitorCapFor(after(99), V2), 8);
    assert.equal(tierLimits.monitorCapFor(after(null), V2), 8);
});

test('v2: non-lifetime accounts are untouched under both cohorts', () => {
    const power = { subscription: { planId: 'power', status: 'active' } };
    assert.equal(tierLimits.monitorCapFor(power, V2), null);
    assert.equal(tierLimits.monitorCapFor({}, V2), null);
    assert.equal(tierLimits.isMonitorCapV2Cohort(power, V2), false);
});

test('v2: capSymbols trims to the cohort cap, and tier 3 now truncates', () => {
    assert.equal(tierLimits.capSymbols(after(1), syms(25), V2).length, 1);
    assert.equal(tierLimits.capSymbols(after(2), syms(25), V2).length, 4);
    // Tier 3 was Infinity under v1, so this slice path never ran for it before.
    assert.equal(tierLimits.capSymbols(after(3), syms(500), V2).length, 8);
    // ...and the grandfathered cohort is still untrimmed at tier 3.
    assert.equal(tierLimits.capSymbols(before(3), syms(500), V2).length, 500);
});

test('v2: the watchlist gate applies to the v2 cohort ONLY', () => {
    // A grandfathered buyer must never be blocked from adding a symbol. Their
    // watchlist is a general feature, not a Monitor entitlement, and it does
    // not retroactively become one.
    assert.equal(tierLimits.wouldExceedMonitorCap(before(1), 30, V2), false);
    assert.equal(tierLimits.wouldExceedMonitorCap(before(3), 5000, V2), false);
    // Non-LTD plans are never gated by this at all.
    assert.equal(tierLimits.wouldExceedMonitorCap({ subscription: { planId: 'desk' } }, 5000, V2), false);
    // With no cutover configured, nobody is gated.
    assert.equal(tierLimits.wouldExceedMonitorCap(after(1), 30, {}), false);
    // The v2 cohort is gated at exactly its cap.
    assert.equal(tierLimits.wouldExceedMonitorCap(after(1), 0, V2), false);
    assert.equal(tierLimits.wouldExceedMonitorCap(after(1), 1, V2), true);
    assert.equal(tierLimits.wouldExceedMonitorCap(after(2), 3, V2), false);
    assert.equal(tierLimits.wouldExceedMonitorCap(after(2), 4, V2), true);
    assert.equal(tierLimits.wouldExceedMonitorCap(after(3), 8, V2), true);
});

test('v2: the display label matches the cohort and is never hand-written', () => {
    // The email and the profile page both render this string. If it drifts from
    // monitorCapFor, one of them is promising a number the product will not give.
    assert.equal(tierLimits.monitorCapLabel(before(3), V2), 'unlimited companies');
    assert.equal(tierLimits.monitorCapLabel(before(1), V2), 'up to 12 companies');
    assert.equal(tierLimits.monitorCapLabel(after(3), V2), 'up to 8 companies');
    assert.equal(tierLimits.monitorCapLabel(after(2), V2), 'up to 4 companies');
    assert.equal(tierLimits.monitorCapLabel(after(1), V2), 'up to 1 company'); // singular
    assert.equal(tierLimits.monitorCapLabel({}, V2), null);
});

test('the lifetime cap does not depend on the tier-v2 flag', () => {
    // ENABLE_TIER_V2_LIMITS also meters history depth; turning Monitor on for
    // lifetime buyers must not switch that on as a side effect.
    const before = process.env.ENABLE_TIER_V2_LIMITS;
    try {
        delete process.env.ENABLE_TIER_V2_LIMITS;
        assert.equal(tierLimits.monitorCapFor(appsumo(1)), 12);
        assert.equal(tierLimits.limitsFor(appsumo(1)).metered, false);
    } finally {
        if (before === undefined) delete process.env.ENABLE_TIER_V2_LIMITS;
        else process.env.ENABLE_TIER_V2_LIMITS = before;
    }
});
