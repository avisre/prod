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
