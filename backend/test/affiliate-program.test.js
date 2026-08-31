'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
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
  for (const planId of ['monthly', 'annual', 'pro', 'pro-annual', 'power', 'power-monthly']) {
    assert.equal(affiliate.commissionRateBps(planId), 3000, `${planId} is an explicit 30% plan`);
  }
  assert.equal(affiliate.commissionRateBps('firm'), 1000);
  assert.equal(affiliate.commissionRateBps('enterprise'), 1000);
  assert.equal(affiliate.commissionRateBps('unknown-future-plan'), 0);
  assert.deepEqual(affiliate.calculateCommission({ eligibleBasisMinor: 25_000, planId: 'unknown-future-plan' }), { basisMinor: 25_000, rateBps: 0, amountMinor: 0 });
  assert.equal(affiliate.isMonthlyEligible(12), true);
  assert.equal(affiliate.isMonthlyEligible(13), false);
  assert.equal(affiliate.isAnnualEligible(1), true);
  assert.equal(affiliate.isAnnualEligible(2), false);
});

test('ambassador acceptance requires a genuine invite and a verified active purchase', () => {
  const invited = { status: 'invited', customerStatus: 'ambassador_invited', invitedAt: new Date() };
  const stripeCustomer = { stripeCustomerId: 'cus_test', subscription: { status: 'active' } };
  assert.equal(affiliate.canAcceptAmbassadorInvite({ profile: invited, user: stripeCustomer }), true);
  assert.equal(affiliate.canAcceptAmbassadorInvite({ profile: { ...invited, invitedAt: null }, user: stripeCustomer }), false);
  assert.equal(affiliate.canAcceptAmbassadorInvite({ profile: { ...invited, customerStatus: 'successful_user' }, user: stripeCustomer }), false);
  assert.equal(affiliate.canAcceptAmbassadorInvite({ profile: invited, user: { subscription: { status: 'active' } } }), false);
  assert.equal(affiliate.canAcceptAmbassadorInvite({ profile: invited, user: {}, appSumoLicenseActive: true }), true);
  assert.equal(affiliate.canAcceptAmbassadorInvite({ profile: invited, user: { stripeCustomerId: 'cus_trial', subscription: { status: 'trialing' } } }), false);
  assert.match(affiliate.CURRENT_TERMS_VERSION, /^customer-ambassador-v\d+-\d{4}-\d{2}-\d{2}$/);
});

test('commission summaries preserve currency and show fully reversed money', () => {
  const byCurrency = affiliate.summarizeCommissionsByCurrency([
    { currency: 'USD', basisMinor: 10_000, amountMinor: 3_000, reversalMinor: 600, status: 'pending' },
    { currency: 'usd', basisMinor: 5_000, amountMinor: 1_500, reversalMinor: 1_500, status: 'reversed' },
    { currency: 'gbp', basisMinor: 2_000, amountMinor: 400, reversalMinor: 0, status: 'paid' }
  ]);
  assert.deepEqual(byCurrency.usd, {
    count: 2, basisMinor: 15_000, amountMinor: 4_500, reversalMinor: 2_100,
    netMinor: 2_400, pendingMinor: 2_400, approvedMinor: 0, paidMinor: 0, reversedMinor: 2_100
  });
  assert.equal(byCurrency.gbp.paidMinor, 400);
  assert.deepEqual(affiliate.combineCommissionCurrencyTotals(byCurrency), {
    pendingMinor: 2_400, approvedMinor: 0, paidMinor: 400, reversedMinor: 2_100
  });
});

test('payout selection applies the minimum to each ambassador within a currency batch', () => {
  const first = new mongoose.Types.ObjectId();
  const second = new mongoose.Types.ObjectId();
  const third = new mongoose.Types.ObjectId();
  const selection = affiliate.selectPayoutEligibleCommissions([
    { _id: 'c1', affiliateProfileId: first, amountMinor: 6_000, reversalMinor: 0 },
    { _id: 'c2', affiliateProfileId: first, amountMinor: 5_000, reversalMinor: 500 },
    { _id: 'c3', affiliateProfileId: second, amountMinor: 9_999, reversalMinor: 0 },
    { _id: 'c4', affiliateProfileId: third, amountMinor: 12_000, reversalMinor: 3_000 }
  ], 10_000);
  assert.equal(selection.totalMinor, 10_500);
  assert.deepEqual(selection.eligibleCommissions.map((row) => row._id), ['c1', 'c2']);
  assert.equal(selection.qualifyingProfiles.length, 1);
  assert.equal(selection.excludedProfiles, 2);
});

test('Stripe reversal identifiers never derive an order from customer alone', () => {
  assert.deepEqual(affiliate.stripeReversalIdentifiers({ customer: 'cus_ambiguous' }, 'refund.created'), {
    invoiceId: null, paymentIntentId: null, chargeId: null, checkoutSessionId: null, refundIds: []
  });
  assert.deepEqual(affiliate.stripeReversalIdentifiers({
    id: 'ch_1', payment_intent: { id: 'pi_1' }, invoice: 'in_1', refunds: { data: [{ id: 're_1' }] }
  }, 'charge.refunded'), {
    invoiceId: 'in_1', paymentIntentId: 'pi_1', chargeId: 'ch_1', checkoutSessionId: null, refundIds: ['re_1']
  });
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
  assert.match(source, /payout-batches\/\:id\/cancel/);
  assert.match(source, /Record the external payment reference/);
  assert.match(source, /termsVersion: affiliateProgram\.CURRENT_TERMS_VERSION/);
  assert.match(source, /eventId: event\.id/);
  assert.match(source, /totalsByCurrency/);
  assert.match(source, /sendFile\(path\.join\(__dirname, 'affiliate-dashboard\.html'\)\)/);
  assert.match(source, /X-Robots-Tag', 'noindex, nofollow, noarchive/);
  const moduleSource = fs.readFileSync(path.join(__dirname, '..', 'affiliate-program.js'), 'utf8');
  assert.match(moduleSource, /AFFILIATE_PROGRAM_ENABLED/);
  assert.match(moduleSource, /AFFILIATE_COOKIE_SECRET/);
  const privateDashboard = fs.readFileSync(path.join(__dirname, '..', 'affiliate-dashboard.html'), 'utf8');
  const customerScript = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'affiliate.js'), 'utf8');
  const terms = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'affiliate-terms.html'), 'utf8');
  assert.match(privateDashboard, /noindex,nofollow,noarchive/);
  assert.match(privateDashboard, /Order status without customer identity/);
  assert.match(customerScript, new RegExp(affiliate.CURRENT_TERMS_VERSION));
  assert.match(customerScript, /Affiliate link — I may earn a commission/);
  assert.match(terms, new RegExp(affiliate.CURRENT_TERMS_VERSION));
  assert.equal(fs.existsSync(path.join(__dirname, '..', '..', 'frontend-v2', 'affiliate.html')), false);
});

test('Stripe reversals and AppSumo reconciliation are durable and idempotent', { timeout: 120000 }, async (t) => {
  const originalFlag = process.env.AFFILIATE_PROGRAM_ENABLED;
  process.env.AFFILIATE_PROGRAM_ENABLED = 'true';
  const server = await MongoMemoryServer.create();
  await mongoose.connect(server.getUri());
  t.after(async () => {
    if (originalFlag == null) delete process.env.AFFILIATE_PROGRAM_ENABLED;
    else process.env.AFFILIATE_PROGRAM_ENABLED = originalFlag;
    await mongoose.disconnect().catch(() => {});
    await server.stop();
  });

  const { AffiliateProfile, ReferralOrder, Commission, ProcessedWebhookEvent } = affiliate.models();
  const profile = await AffiliateProfile.create({
    userId: new mongoose.Types.ObjectId(), slug: 'amb-idempotent', customerStatus: 'ambassador_active',
    status: 'active', invitedAt: new Date(), termsAcceptedAt: new Date(), termsVersion: affiliate.CURRENT_TERMS_VERSION
  });
  const stripeOrder = await ReferralOrder.create({
    provider: 'stripe', providerOrderId: 'cs_1', providerCustomerId: 'cus_shared', subscriptionId: 'sub_1',
    affiliateProfileId: profile._id, planId: 'pro', billingInterval: 'month', status: 'paid',
    grossCollectedMinor: 10_000, eligibleBasisMinor: 10_000,
    metadata: { checkoutSessionId: 'cs_1', invoiceId: 'in_1', paymentIntentId: 'pi_1', chargeId: 'ch_1' }
  });
  await Commission.create({
    affiliateProfileId: profile._id, referralOrderId: stripeOrder._id, provider: 'stripe', invoiceId: 'in_1',
    paymentIntentId: 'pi_1', chargeId: 'ch_1',
    currency: 'usd', basisMinor: 10_000, rateBps: 3_000, amountMinor: 3_000,
    holdUntil: new Date(Date.now() + 86_400_000), status: 'pending'
  });
  await Commission.create({
    affiliateProfileId: profile._id, referralOrderId: stripeOrder._id, provider: 'stripe', invoiceId: 'in_1_next',
    paymentIntentId: 'pi_1_next', chargeId: 'ch_1_next',
    currency: 'usd', basisMinor: 10_000, rateBps: 3_000, amountMinor: 3_000,
    holdUntil: new Date(Date.now() + 86_400_000), status: 'pending'
  });
  const secondStripeOrder = await ReferralOrder.create({
    provider: 'stripe', providerOrderId: 'cs_2', providerCustomerId: 'cus_shared', subscriptionId: 'sub_2',
    affiliateProfileId: profile._id, planId: 'pro', billingInterval: 'month', status: 'paid',
    metadata: { checkoutSessionId: 'cs_2', invoiceId: 'in_2', paymentIntentId: 'pi_2', chargeId: 'ch_2' }
  });
  await Commission.create({
    affiliateProfileId: profile._id, referralOrderId: secondStripeOrder._id, provider: 'stripe', invoiceId: 'in_2',
    paymentIntentId: 'pi_2', chargeId: 'ch_2',
    currency: 'usd', basisMinor: 5_000, rateBps: 3_000, amountMinor: 1_500,
    holdUntil: new Date(Date.now() + 86_400_000), status: 'pending'
  });

  const first = await affiliate.reverseStripeCommission({
    payload: { id: 're_1', payment_intent: 'pi_1', charge: 'ch_1', amount: 2_000 },
    reason: 'refund', eventId: 'evt_refund_1', eventType: 'refund.created'
  });
  assert.equal(first.refundedMinor, 2_000);
  assert.equal((await Commission.findOne({ invoiceId: 'in_1' }).lean()).reversalMinor, 600);
  assert.equal((await Commission.findOne({ invoiceId: 'in_1_next' }).lean()).reversalMinor, 0);
  const duplicate = await affiliate.reverseStripeCommission({
    payload: { id: 're_1', payment_intent: 'pi_1', charge: 'ch_1', amount: 2_000 },
    reason: 'refund', eventId: 'evt_refund_1', eventType: 'refund.created'
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal((await Commission.findOne({ invoiceId: 'in_1' }).lean()).reversalMinor, 600);

  await affiliate.reverseStripeCommission({
    payload: { id: 'ch_1', payment_intent: 'pi_1', amount_refunded: 5_000, refunds: { data: [{ id: 're_1' }, { id: 're_2' }] } },
    reason: 'refund', eventId: 'evt_charge_1', eventType: 'charge.refunded'
  });
  assert.equal((await Commission.findOne({ invoiceId: 'in_1' }).lean()).reversalMinor, 1_500);
  const companion = await affiliate.reverseStripeCommission({
    payload: { id: 're_2', payment_intent: 'pi_1', charge: 'ch_1', amount: 3_000 },
    reason: 'refund', eventId: 'evt_refund_2', eventType: 'refund.created'
  });
  assert.equal(companion.duplicate, true);
  assert.equal((await Commission.findOne({ invoiceId: 'in_1' }).lean()).reversalMinor, 1_500);

  const customerOnly = await affiliate.reverseStripeCommission({
    payload: { customer: 'cus_shared', amount: 1_000 }, reason: 'refund', eventId: 'evt_customer_only', eventType: 'refund.created'
  });
  assert.equal(customerOnly.reason, 'no_order');
  assert.equal(await ProcessedWebhookEvent.countDocuments({ eventId: 'evt_customer_only' }), 0);

  const disputed = await affiliate.reverseStripeCommission({
    payload: { id: 'dp_1', charge: 'ch_2', payment_intent: 'pi_2' },
    reason: 'dispute', eventId: 'evt_dispute_1', eventType: 'charge.dispute.created'
  });
  assert.equal(disputed.reversed, true);
  const disputedCommission = await Commission.findOne({ invoiceId: 'in_2' }).lean();
  assert.equal(disputedCommission.status, 'reversed');
  assert.equal(disputedCommission.reversalMinor, 1_500);
  const duplicateDispute = await affiliate.reverseStripeCommission({
    payload: { id: 'dp_1', charge: 'ch_2', payment_intent: 'pi_2' },
    reason: 'dispute', eventId: 'evt_dispute_1', eventType: 'charge.dispute.created'
  });
  assert.equal(duplicateDispute.duplicate, true);

  const appSumoOrder = await ReferralOrder.create({
    provider: 'appsumo', providerOrderId: 'AS-IDEMPOTENT', affiliateProfileId: profile._id,
    planId: 'appsumo-tier-1', status: 'pending_reconciliation'
  });
  const csv = 'License key,Status,Net proceeds,Currency\nAS-IDEMPOTENT,paid,40.00,USD';
  const imported = await affiliate.reconcileAppSumoCsv({ csv, dryRun: false });
  assert.equal(imported.commissions, 1);
  const originalCommission = await Commission.findOne({ referralOrderId: appSumoOrder._id, provider: 'appsumo' }).lean();
  const repeated = await affiliate.reconcileAppSumoCsv({ csv, dryRun: false });
  const repeatedCommission = await Commission.findOne({ referralOrderId: appSumoOrder._id, provider: 'appsumo' }).lean();
  assert.equal(repeated.commissions, 0);
  assert.equal(repeated.unchanged, 1);
  assert.equal(repeatedCommission.holdUntil.toISOString(), originalCommission.holdUntil.toISOString());
  assert.equal(await Commission.countDocuments({ referralOrderId: appSumoOrder._id, provider: 'appsumo' }), 1);
});

test('existing pricing and AppSumo entitlement code remains present', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(source, /const PRO_PLAN_PRICE = parseFloat\(process\.env\.PRO_PLAN_PRICE \|\| '79\.99'\)/);
  assert.match(source, /user\.appsumoRedeemedAt = user\.appsumoRedeemedAt \|\| now/);
  assert.match(source, /user\.appsumoAiCap = cfg\.askCap/);
});
