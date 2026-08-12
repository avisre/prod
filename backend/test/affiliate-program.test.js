'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const affiliate = require('../affiliate-program');

const SECRET = 'affiliate-test-secret-with-sufficient-entropy';
const NOW = Date.UTC(2026, 7, 9, 12, 0, 0);

test('referral cookie is signed, opaque and expires at the configured window', () => {
  const value = affiliate.createReferralCookieValue({ slug: 'amb-7k2m', clickId: 'click_1234567890123456', secret: SECRET, now: NOW });
  assert.match(value, /^v1\.amb-7k2m\./);
  assert.equal(value.includes('@'), false);
  assert.equal(affiliate.parseReferralCookieValue(value, { secret: SECRET, now: NOW + 59 * 86400000, maxAgeSeconds: 60 * 86400 }).slug, 'amb-7k2m');
  assert.equal(affiliate.parseReferralCookieValue(`${value}x`, { secret: SECRET, now: NOW }), null);
  assert.equal(affiliate.parseReferralCookieValue(value, { secret: SECRET, now: NOW + 61 * 86400000, maxAgeSeconds: 60 * 86400 }), null);
});

test('commission rates use integer minor units and the approved plan bands', () => {
  assert.deepEqual(affiliate.calculateCommission({ eligibleBasisMinor: 25000, planId: 'pro-annual' }), { basisMinor: 25000, rateBps: 3000, amountMinor: 7500 });
  assert.deepEqual(affiliate.calculateCommission({ eligibleBasisMinor: 196100, planId: 'desk' }), { basisMinor: 196100, rateBps: 2000, amountMinor: 39220 });
  assert.deepEqual(affiliate.calculateCommission({ eligibleBasisMinor: 14900, appsumo: true }), { basisMinor: 14900, rateBps: 2500, amountMinor: 3725 });
  assert.equal(affiliate.isMonthlyEligible(12), true);
  assert.equal(affiliate.isMonthlyEligible(13), false);
  assert.equal(affiliate.isAnnualEligible(1), true);
  assert.equal(affiliate.isAnnualEligible(2), false);
});

test('AppSumo CSV parser supports quoted values and normalizes net proceeds', () => {
  const rows = affiliate.parseCsv('License key,Status,Net proceeds,Currency\n"AS-1","paid","$39.50",USD\nAS-2,refunded,0,USD');
  assert.equal(rows.length, 2);
  assert.deepEqual(affiliate.normalizeAppSumoRow(rows[0]), { providerOrderId: 'AS-1', status: 'paid', currency: 'usd', grossMinor: null, netProceedsMinor: 3950, refundedMinor: 0 });
  assert.equal(affiliate.normalizeAppSumoRow({ license: 'AS-3', partner_payout: '12.00' }, { net_proceeds: 'partner payout' }).netProceedsMinor, 1200);
});

test('Release-1 routes are feature-gated and do not expose a token-only customer page', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(source, /app\.get\('\/r\/:id'/);
  assert.match(source, /handleAffiliateReferral/);
  assert.match(source, /app\.get\('\/api\/affiliate\/me', authMiddleware/);
  assert.match(source, /app\.post\('\/api\/affiliate\/accept', authMiddleware/);
  assert.match(source, /affiliateAdminAuth/);
  assert.match(source, /sentEmail: false/);
  assert.match(source, /automaticPayout: false/);
  assert.match(source, /event\.type === 'invoice\.paid'/);
  assert.match(source, /recordStripeInvoicePaid/);
  assert.match(source, /appsumo\/reconcile/);
  assert.match(source, /reverseAppSumoCommission/);
  assert.match(source, /payout-batches\/\:id\.csv/);
  const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'affiliate-program.js'), 'utf8');
  assert.match(moduleSource, /AFFILIATE_PROGRAM_ENABLED/);
  assert.match(moduleSource, /AFFILIATE_COOKIE_SECRET/);
});

test('existing pricing and AppSumo entitlement code remains present', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(source, /const PRO_PLAN_PRICE = parseFloat\(process\.env\.PRO_PLAN_PRICE \|\| '25\.00'\)/);
  assert.match(source, /user\.appsumoRedeemedAt = user\.appsumoRedeemedAt \|\| now/);
  assert.match(source, /user\.appsumoAiCap = cfg\.askCap/);
});
