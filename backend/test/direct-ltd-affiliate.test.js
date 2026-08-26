'use strict';

// Direct lifetime deals are mode:'payment' Checkout sessions, so they never
// produce an invoice and never reach recordStripeInvoicePaid. These tests pin
// the one-time commission path end to end: attribution at checkout, the
// commission itself, replay safety, and the refund clawback that protects the
// 30-day direct refund window.

const test = require('node:test');
const assert = require('node:assert/strict');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const affiliate = require('../affiliate-program');

const TIER3_MINOR = 14_999; // $149.99

test('a referred direct-LTD purchase earns, holds and reverses a 30% commission', { timeout: 120000 }, async (t) => {
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

  const { AffiliateProfile, ReferralClick, ReferralOrder, Commission } = affiliate.models();
  const partnerUserId = new mongoose.Types.ObjectId();
  const profile = await AffiliateProfile.create({
    userId: partnerUserId, slug: 'amb-dealsite', customerStatus: 'ambassador_active',
    status: 'active', invitedAt: new Date(), termsAcceptedAt: new Date(), termsVersion: affiliate.CURRENT_TERMS_VERSION
  });
  const click = await ReferralClick.create({
    clickId: 'click_dealsite_00000001', affiliateProfileId: profile._id, slug: profile.slug,
    destination: 'lifetime', landingPath: '/lifetime', clickedAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 86400000)
  });

  const buyer = { _id: new mongoose.Types.ObjectId() };
  // Exactly the metadata createDirectLtdCheckoutSession now attaches.
  const session = {
    id: 'cs_ltd_1',
    customer: 'cus_ltd_1',
    payment_intent: 'pi_ltd_1',
    payment_status: 'paid',
    currency: 'usd',
    amount_subtotal: TIER3_MINOR,
    amount_total: TIER3_MINOR,
    metadata: {
      userId: String(buyer._id),
      planId: 'pro',
      checkoutType: 'direct_ltd',
      ltdTier: '3',
      affiliateProfileId: String(profile._id),
      affiliateSlug: profile.slug,
      referralClickId: click.clickId
    }
  };

  const attributed = await affiliate.recordStripeCheckout({ payload: session, user: buyer });
  assert.equal(attributed.recorded, true, 'LTD checkout must be attributed');

  const paid = await affiliate.recordStripeOneTimePaid({ payload: session, eventId: 'evt_ltd_1', holdDays: 30 });
  assert.equal(paid.recorded, true);
  assert.equal(paid.amountMinor, 4_499, '30% of $149.99, floored, in minor units');

  const commission = await Commission.findOne({ invoiceId: 'cs:cs_ltd_1' }).lean();
  assert.equal(commission.rateBps, 3_000);
  assert.equal(commission.basisMinor, TIER3_MINOR);
  assert.equal(commission.amountMinor, 4_499);
  assert.equal(commission.status, 'pending');
  assert.equal(commission.paymentIntentId, 'pi_ltd_1', 'refund clawback matches on this');
  const holdDays = Math.round((new Date(commission.holdUntil) - Date.now()) / 86400000);
  assert.ok(holdDays >= 29 && holdDays <= 31, `held for the direct refund window, got ${holdDays}d`);

  const order = await ReferralOrder.findOne({ providerOrderId: 'cs_ltd_1' }).lean();
  assert.equal(order.status, 'paid');
  assert.equal(order.eligibleBasisMinor, TIER3_MINOR);

  // Replaying the same webhook event must not pay twice.
  const replay = await affiliate.recordStripeOneTimePaid({ payload: session, eventId: 'evt_ltd_1', holdDays: 30 });
  assert.equal(replay.duplicate, true);
  assert.equal(await Commission.countDocuments({ referralOrderId: order._id }), 1);

  // A refund inside the 30-day window must claw the commission back, matched
  // through payment_intent since a one-time sale has no invoice id.
  const reversed = await affiliate.reverseStripeCommission({
    payload: { id: 're_ltd_1', payment_intent: 'pi_ltd_1', amount: TIER3_MINOR },
    reason: 'refund', eventId: 'evt_ltd_refund_1', eventType: 'refund.created'
  });
  assert.equal(reversed.reversed, true, 'a refunded LTD sale must reverse its commission');
  const after = await Commission.findOne({ invoiceId: 'cs:cs_ltd_1' }).lean();
  assert.equal(after.reversalMinor, 4_499, 'a full refund reverses the full commission');
  assert.equal(after.status, 'reversed');
});

test('unattributed and self-referred LTD purchases earn nothing', { timeout: 120000 }, async (t) => {
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

  const { AffiliateProfile, ReferralClick, Commission } = affiliate.models();

  // Organic buyer: no referral metadata at all.
  const organic = {
    id: 'cs_ltd_organic', payment_status: 'paid', currency: 'usd',
    amount_subtotal: TIER3_MINOR, amount_total: TIER3_MINOR,
    metadata: { planId: 'pro', checkoutType: 'direct_ltd', ltdTier: '3' }
  };
  assert.equal((await affiliate.recordStripeCheckout({ payload: organic, user: { _id: new mongoose.Types.ObjectId() } })).recorded, false);
  const organicPaid = await affiliate.recordStripeOneTimePaid({ payload: organic, eventId: 'evt_organic', holdDays: 30 });
  assert.equal(organicPaid.recorded, false);
  assert.equal(organicPaid.reason, 'no_attributed_order');

  // Self-referral: the partner buying through their own link.
  const selfUserId = new mongoose.Types.ObjectId();
  const selfProfile = await AffiliateProfile.create({
    userId: selfUserId, slug: 'amb-selfbuy', customerStatus: 'ambassador_active',
    status: 'active', invitedAt: new Date(), termsAcceptedAt: new Date(), termsVersion: affiliate.CURRENT_TERMS_VERSION
  });
  const selfClick = await ReferralClick.create({
    clickId: 'click_selfbuy_00000001', affiliateProfileId: selfProfile._id, slug: selfProfile.slug,
    destination: 'lifetime', landingPath: '/lifetime', clickedAt: new Date(),
    expiresAt: new Date(Date.now() + 60 * 86400000)
  });
  const selfSession = {
    id: 'cs_ltd_self', payment_status: 'paid', currency: 'usd',
    amount_subtotal: TIER3_MINOR, amount_total: TIER3_MINOR,
    metadata: {
      planId: 'pro', checkoutType: 'direct_ltd', ltdTier: '3',
      affiliateProfileId: String(selfProfile._id), affiliateSlug: selfProfile.slug, referralClickId: selfClick.clickId
    }
  };
  const selfAttributed = await affiliate.recordStripeCheckout({ payload: selfSession, user: { _id: selfUserId } });
  assert.equal(selfAttributed.recorded, false);
  assert.equal(selfAttributed.reason, 'invalid_or_self_referral');
  assert.equal((await affiliate.recordStripeOneTimePaid({ payload: selfSession, eventId: 'evt_self', holdDays: 30 })).recorded, false);
  assert.equal(await Commission.countDocuments({}), 0);
});

test('an external partner can activate without ever having been a customer', () => {
  const invited = { status: 'invited', customerStatus: 'ambassador_invited', invitedAt: new Date() };
  const nonCustomer = {};
  // The customer gate still governs ordinary ambassadors...
  assert.equal(affiliate.canAcceptAmbassadorInvite({ profile: { ...invited, kind: 'ambassador' }, user: nonCustomer }), false);
  // ...but a deal/review site enrolled as a partner is verified by that
  // enrollment, since it is never expected to buy the product.
  assert.equal(affiliate.canAcceptAmbassadorInvite({ profile: { ...invited, kind: 'partner' }, user: nonCustomer }), true);
  // A partner still cannot activate without a genuine invite.
  assert.equal(affiliate.canAcceptAmbassadorInvite({ profile: { ...invited, kind: 'partner', invitedAt: null }, user: nonCustomer }), false);
  assert.equal(affiliate.canAcceptAmbassadorInvite({ profile: { ...invited, kind: 'partner', status: 'suspended' }, user: nonCustomer }), false);
});

test('a partner batch can pay out a single lifetime sale; the default still cannot', () => {
  // One tier-3 sale: $149.99 basis, $44.99 commission.
  const single = [{ affiliateProfileId: 'p1', amountMinor: 4_499, reversalMinor: 0 }];
  assert.equal(affiliate.DEFAULT_PAYOUT_MINIMUM_MINOR, 10_000);
  assert.equal(affiliate.selectPayoutEligibleCommissions(single).eligibleCommissions.length, 0,
    'the $100 default still withholds a single sale');
  assert.equal(affiliate.selectPayoutEligibleCommissions(single, 4_000).eligibleCommissions.length, 1,
    'an explicit partner threshold pays a single tier-3 sale');
  // The clamp still refuses a nonsensical near-zero threshold.
  assert.equal(affiliate.selectPayoutEligibleCommissions(single, 1).minimumMinor, affiliate.ABSOLUTE_PAYOUT_MINIMUM_MINOR);
  // A reversed commission does not count toward the threshold.
  const refunded = [{ affiliateProfileId: 'p1', amountMinor: 4_499, reversalMinor: 4_499 }];
  assert.equal(affiliate.selectPayoutEligibleCommissions(refunded, 4_000).eligibleCommissions.length, 0);
});
