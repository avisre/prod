'use strict';

// The 2026-09-23 API/MCP widening: every AppSumo/DealMirror buyer who
// PURCHASED on or before the cutoff keeps API and MCP on whichever tier they
// bought, permanently. From the cutoff onward it is a tier-3 feature again.
//
// This is the mirror image of the V2 gates in the same module: those narrow a
// lifetime entitlement, so an unset cutover must leave everyone generous. This
// one widens, so an unset cutover must grant NOBODY — a missing env var here
// would otherwise hand API access to every lifetime buyer who ever redeemed.
// Modelled on ltd-monitor-entitlement.test.js.

const test = require('node:test');
const assert = require('node:assert/strict');
const tierLimits = require('../../lib/tier-limits');

const CUTOFF = '2026-09-22T23:59:59.999Z';
const env = (over = {}) => ({ LTD_API_ACCESS_CUTOFF: CUTOFF, ...over });
const buyer = (over = {}) => ({ appsumoTier: 1, appsumoRedeemedAt: new Date('2026-08-10T00:00:00.000Z'), ...over });

test('a pre-cutoff buyer is grandfathered on every tier, not just tier 3', () => {
    for (const tier of [1, 2, 3]) {
        assert.equal(tierLimits.isLtdApiAccessCohort(buyer({ appsumoTier: tier }), env()), true, `tier ${tier} redeemed in August keeps API/MCP`);
    }
    // DealMirror redemptions are the same entitlement through another channel.
    assert.equal(tierLimits.isLtdApiAccessCohort({ dealMirrorTier: 1, dealMirrorRedeemedAt: new Date('2026-09-01T00:00:00.000Z') }, env()), true);
});

test('a post-cutoff buyer is not in the cohort — tier 3 is their only route', () => {
    const late = buyer({ appsumoRedeemedAt: new Date('2026-09-23T00:00:01.000Z') });
    assert.equal(tierLimits.isLtdApiAccessCohort(late, env()), false);
    assert.equal(tierLimits.isLtdApiAccessCohort({ ...late, appsumoTier: 3 }, env()), false,
        'tier 3 is NOT granted here — app.js grants it before consulting this cohort at all');
});

test('the cutoff boundary is inclusive to the last millisecond of 22 September', () => {
    assert.equal(tierLimits.isLtdApiAccessCohort(buyer({ appsumoRedeemedAt: new Date(CUTOFF) }), env()), true);
    assert.equal(tierLimits.isLtdApiAccessCohort(buyer({ appsumoRedeemedAt: new Date('2026-09-23T00:00:00.000Z') }), env()), false);
});

test('an unset or unparseable cutoff grants nobody — the widening ships dark', () => {
    assert.equal(tierLimits.ltdApiAccessCutoff({}), null);
    assert.equal(tierLimits.ltdApiAccessCutoff({ LTD_API_ACCESS_CUTOFF: 'not a date' }), null);
    assert.equal(tierLimits.isLtdApiAccessCohort(buyer(), {}), false, 'unset env var must not widen anything');
    assert.equal(tierLimits.isLtdApiAccessCohort(buyer(), env({ LTD_API_ACCESS_CUTOFF: 'whenever' })), false);
});

test('the licence allowlist overrides a late redemption — it carries the PURCHASE date', () => {
    // Bought 22 Sep, redeemed 5 Oct: redeemedAt alone would wrongly exclude
    // them. This is the case the AppSumo sales export exists to fix.
    const lateRedeemer = buyer({ appsumoRedeemedAt: new Date('2026-10-05T00:00:00.000Z'), grandfatheredLicence: true });
    assert.equal(tierLimits.isLtdApiAccessCohort(lateRedeemer, env()), true);
    assert.equal(tierLimits.isLtdApiAccessCohort({ ...lateRedeemer, grandfatheredLicence: false }, env()), false,
        'without the flag the same account falls back to its redemption date');
});

test('a tiered but undated account resolves generous, like every other tier lookup', () => {
    // An undated lifetime grant predates the dating, so it predates the cutoff.
    assert.equal(tierLimits.isLtdApiAccessCohort({ appsumoTier: 2 }, env()), true);
    assert.equal(tierLimits.isLtdApiAccessCohort({ appsumoTier: 2, appsumoRedeemedAt: 'garbage' }, env()), true);
});

test('non-lifetime accounts are never in the cohort', () => {
    assert.equal(tierLimits.isLtdApiAccessCohort({}, env()), false);
    assert.equal(tierLimits.isLtdApiAccessCohort(null, env()), false);
    assert.equal(tierLimits.isLtdApiAccessCohort({ appsumoTier: 0 }, env()), false);
    assert.equal(tierLimits.isLtdApiAccessCohort({ appsumoTier: null, subscription: { planId: 'free' } }, env()), false);
});
