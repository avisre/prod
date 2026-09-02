'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const tl = require('../../lib/tier-limits');

const ON = { ENABLE_TIER_V2_LIMITS: 'true', TIER_V2_EFFECTIVE_FROM: '2026-09-01' };
const OLD_BUYER = { appsumoRedeemedAt: new Date('2026-07-10'), appsumoTier: 1 };
const NEW_BUYER = { appsumoRedeemedAt: new Date('2026-09-15'), appsumoTier: 1 };

test('the flag is off by default, so nothing is metered anywhere', () => {
  assert.equal(tl.enabled({}), false);
  for (const user of [OLD_BUYER, NEW_BUYER]) {
    const l = tl.limitsFor(user, {});
    assert.equal(l.metered, false);
    assert.equal(l.maxMonitoredCompanies, tl.UNLIMITED);
    assert.equal(l.historyYearsLimit, tl.UNLIMITED);
  }
});

test('existing redeemed codes are never retroactively downgraded', () => {
  const l = tl.limitsFor(OLD_BUYER, ON);
  assert.equal(l.metered, false);
  assert.equal(l.maxMonitoredCompanies, tl.UNLIMITED);
  assert.equal(tl.wouldExceedMonitored(OLD_BUYER, 5000, ON), false);
  assert.equal(tl.clampHistoryYears(OLD_BUYER, 25, ON), 25);
});

test('a missing or unparseable cutover meters nobody (fail-closed on the downgrade)', () => {
  assert.equal(tl.limitsFor(NEW_BUYER, { ENABLE_TIER_V2_LIMITS: 'true' }).metered, false);
  assert.equal(tl.limitsFor(NEW_BUYER, { ENABLE_TIER_V2_LIMITS: 'true', TIER_V2_EFFECTIVE_FROM: 'soon' }).metered, false);
});

test('post-cutover buyers get their tier config', () => {
  assert.deepEqual(tl.limitsFor(NEW_BUYER, ON), { maxMonitoredCompanies: 12, historyYearsLimit: 5, maxPortfolios: 1, metered: true });
  assert.equal(tl.limitsFor({ ...NEW_BUYER, appsumoTier: 2 }, ON).maxMonitoredCompanies, 40);
  assert.equal(tl.limitsFor({ ...NEW_BUYER, appsumoTier: 3 }, ON).maxMonitoredCompanies, tl.UNLIMITED);
  // unknown tier resolves UP, matching appsumoTierConfig()
  assert.equal(tl.limitsFor({ ...NEW_BUYER, appsumoTier: 9 }, ON).historyYearsLimit, tl.UNLIMITED);
});

test('non-LTD accounts are untouched — plan gates govern them, not these', () => {
  assert.equal(tl.limitsFor({ subscription: { planId: 'pro' } }, ON).metered, false);
  assert.equal(tl.limitsFor(null, ON).metered, false);
});

test('the meters themselves behave at the boundary', () => {
  assert.equal(tl.wouldExceedMonitored(NEW_BUYER, 11, ON), false);
  assert.equal(tl.wouldExceedMonitored(NEW_BUYER, 12, ON), true);
  assert.equal(tl.clampHistoryYears(NEW_BUYER, 20, ON), 5);
  assert.equal(tl.clampHistoryYears(NEW_BUYER, 3, ON), 3);
});

test('portfolio cap: tier 1 is the pre-feature product, and Main counts toward it', () => {
  // tier 1 = 1 total portfolio = the implicit Main only, i.e. exactly what
  // shipped before multi-portfolio existed. Nothing is taken away.
  assert.equal(tl.limitsFor(NEW_BUYER, ON).maxPortfolios, 1);
  assert.equal(tl.wouldExceedPortfolios(NEW_BUYER, 1, ON), true);   // has Main, wants a 2nd
  assert.equal(tl.limitsFor({ ...NEW_BUYER, appsumoTier: 2 }, ON).maxPortfolios, 5);
  assert.equal(tl.wouldExceedPortfolios({ ...NEW_BUYER, appsumoTier: 2 }, 4, ON), false);
  assert.equal(tl.wouldExceedPortfolios({ ...NEW_BUYER, appsumoTier: 2 }, 5, ON), true);
  assert.equal(tl.limitsFor({ ...NEW_BUYER, appsumoTier: 3 }, ON).maxPortfolios, tl.UNLIMITED);
  assert.equal(tl.wouldExceedPortfolios({ ...NEW_BUYER, appsumoTier: 3 }, 500, ON), false);
});

test('portfolio cap never applies to existing redeemers or with the flag off', () => {
  // the load-bearing guarantee: a lifetime buyer who already redeemed keeps
  // unlimited portfolios forever, flag on or off.
  assert.equal(tl.wouldExceedPortfolios(OLD_BUYER, 999, ON), false);
  assert.equal(tl.wouldExceedPortfolios(NEW_BUYER, 999, {}), false);
  assert.equal(tl.wouldExceedPortfolios({}, 999, ON), false); // non-LTD account
});
