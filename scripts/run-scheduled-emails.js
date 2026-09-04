#!/usr/bin/env node
'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const jwt = require(path.join(__dirname, '../backend/node_modules/jsonwebtoken'));
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/prod.env') });
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/.env') });

const mongoose = require(path.join(__dirname, '../backend/node_modules/mongoose'));
const mailer = require('../backend/mailer');

async function recordMeasurementEvent(db, user, eventName, dedupeKey, extra = {}) {
  if (!db || !user || !user._id) return;
  await db.collection('funnel_events').updateOne(
    { dedupeKey },
    { $setOnInsert: {
      event: eventName, eventType: eventName, eventName, schemaVersion: 'growth-measurement-v1',
      eventId: crypto.randomUUID(), dedupeKey, userId: String(user._id), occurredAt: new Date(), timestamp: new Date(), at: new Date(),
      entitlementSource: user.appsumoRedeemedAt ? 'appsumo' : 'unknown', ...extra
    } }, { upsert: true }
  );
}

function appsumoReviewUrl() {
  return process.env.APPSUMO_PRODUCT_SLUG
    ? `https://appsumo.com/products/${process.env.APPSUMO_PRODUCT_SLUG}/#reviews`
    : 'https://appsumo.com/account/products/';
}

function appsumoUnsubToken(userId) {
  return jwt.sign({ userId: String(userId), p: 'as-review' }, process.env.JWT_SECRET, { expiresIn: '180d' });
}

async function main() {
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
  const db = mongoose.connection.db;
  // Keep the inactive reminder idempotent and separate from review stages.
  // Scheduling is safe when SMTP is unavailable; the job remains queued.
  const inactiveUsers = await db.collection('users').find({
    appsumoRedeemedAt: { $ne: null }, appsumoEmailsOptOut: { $ne: true },
    'subscription.status': 'active'
  }, { projection: { _id: 1, email: 1, appsumoRedeemedAt: 1 } }).limit(200).toArray();
  const activationUsers = await db.collection('funnel_events').distinct('userId', { event: 'meaningful_activation' });
  const activeSet = new Set(activationUsers.map(String));
  // Second, independent proof of activation: demonstrable product usage.
  //
  // `meaningful_activation` is emitted by instrumentation that is not currently
  // firing — the event count is zero for every account, including customers who
  // have run dozens of Asks and Dossiers. Trusting it alone therefore classifies
  // ALL paying customers as "never got started", and this job then mails each of
  // them a nudge saying so. On a daily cron that repeats forever, and the people
  // it insults first are the most engaged ones.
  //
  // So treat a real spend, a real Dossier view, or a real Ask as activation too.
  // These are ledgers of things the customer actually did, not analytics events
  // that can silently stop being written. Either signal is sufficient; the
  // funnel event stays authoritative for everything else that reads it.
  // AI-feature usage keys on `userId`; portfolio-side usage keys on `user`.
  // Both count: a customer who has built a 17-stock portfolio and set 22 filing
  // alerts has plainly got started, even if they have never opened Ask. Nudging
  // them to "get started" reads as the product not knowing who they are.
  const usageSignals = [
    ['credit_ledger', 'userId'], ['dossier_views', 'userId'], ['ask_reports', 'userId'],
    ['stocks', 'user'], ['alerts', 'user'], ['watchlists', 'user'], ['portfolios', 'user']
  ];
  for (const [col, field] of usageSignals) {
    for (const id of await db.collection(col).distinct(field)) {
      if (id !== null && id !== undefined) activeSet.add(String(id));
    }
  }
  for (const user of inactiveUsers) {
    if (Date.now() - new Date(user.appsumoRedeemedAt).getTime() < 48 * 3600000 || activeSet.has(String(user._id))) continue;
    await db.collection('scheduled_emails').updateOne(
      { emailKey: `appsumo-inactive-48h:${String(user._id)}` },
      { $setOnInsert: { emailKey: `appsumo-inactive-48h:${String(user._id)}`, template: 'appsumo_inactive_48h', userId: user._id, to: user.email, dueAt: new Date(), status: 'scheduled', meta: { campaignId: 'appsumo_aug_2026' } } },
      { upsert: true }
    );
  }
  const scheduled = await db.collection('scheduled_emails').find({
    status: 'scheduled',
    dueAt: { $lte: new Date() }
  }).sort({ dueAt: 1 }).limit(Number(process.env.SCHEDULED_EMAIL_BATCH || 50)).toArray();

  const appUrl = (process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro').replace(/\/$/, '');
  let sent = 0;
  let skipped = 0;
  let failed = 0;
  for (const job of scheduled) {
    try {
      if (!['appsumo_review_5d', 'appsumo_onboarding', 'appsumo_activation_next', 'appsumo_inactive_48h', 'appsumo_review_eligible'].includes(job.template)) {
        await db.collection('scheduled_emails').updateOne({ _id: job._id }, { $set: { status: 'skipped', skippedReason: 'unknown template' } });
        skipped++;
        continue;
      }
      let user = await db.collection('users').findOne({ _id: job.userId });
      if (!user || user.appsumoEmailsOptOut || !user.appsumoRedeemedAt || user.subscription?.status !== 'active') {
        await db.collection('scheduled_emails').updateOne({ _id: job._id }, { $set: { status: 'skipped', skippedReason: 'not eligible at send time' } });
        skipped++;
        continue;
      }
      const isReviewRequest = job.template === 'appsumo_review_5d' || job.template === 'appsumo_review_eligible';
      let reviewClaimedAt = null;
      const unsubUrl = `${appUrl}/api/appsumo/unsubscribe?token=${appsumoUnsubToken(user._id)}`;
      let email;
      if (job.template === 'appsumo_review_5d') {
        if (user.appsumoReviewStage >= 2) {
          await db.collection('scheduled_emails').updateOne({ _id: job._id }, { $set: { status: 'skipped', skippedReason: 'review already sent' } }); skipped++; continue;
        }
        email = mailer.appsumoReviewEmail(user.name, appUrl, 2, appsumoReviewUrl(), unsubUrl);
      } else if (job.template === 'appsumo_onboarding') {
        email = mailer.appsumoOnboardingEmail(user.name, appUrl, process.env.APPSUMO_ONBOARDING_VIDEO_URL || '', unsubUrl, user.ltdChannel);
      } else if (job.template === 'appsumo_activation_next') {
        email = mailer.appsumoActivationNextEmail(user.name, appUrl, unsubUrl);
      } else if (job.template === 'appsumo_inactive_48h') {
        const used = await db.collection('funnel_events').findOne({ event: 'meaningful_activation', userId: String(user._id) });
        if (used) { await db.collection('scheduled_emails').updateOne({ _id: job._id }, { $set: { status: 'skipped', skippedReason: 'customer already activated' } }); skipped++; continue; }
        email = mailer.appsumoInactiveEmail(user.name, appUrl, unsubUrl);
      } else {
        if (!user.reviewEligibleAt) { await db.collection('scheduled_emails').updateOne({ _id: job._id }, { $set: { status: 'skipped', skippedReason: 'not review eligible' } }); skipped++; continue; }
        email = mailer.appsumoReviewEligibleEmail(user.name, appUrl, appsumoReviewUrl(), unsubUrl);
      }
      // One persisted guard for every worker. Claim only after the job has
      // passed all eligibility checks, but before sending, so two due jobs or
      // workers cannot send two review requests.
      if (isReviewRequest) {
        reviewClaimedAt = new Date();
        // includeResultMetadata is load-bearing, not decoration. The raw driver
        // returned `{ value: doc }` up to v4 and the bare document from v5 on;
        // this file is on v6 and reads `claim.value`, so without the option the
        // read is always undefined, every claim looks like a loss, and NO review
        // request is ever sent — while the $set above has already landed, which
        // permanently blocks that user from ever being asked. Silent, and it cost
        // every review request this product has never received. The option pins
        // the `{ value }` shape on v5+ and is ignored (already correct) on v4.
        const claim = await db.collection('users').findOneAndUpdate(
          { _id: user._id, reviewRequestSentAt: null, reviewRequestClaimedAt: null },
          { $set: { reviewRequestClaimedAt: reviewClaimedAt } },
          { returnDocument: 'after', includeResultMetadata: true }
        );
        if (!claim.value) {
          await db.collection('scheduled_emails').updateOne({ _id: job._id }, { $set: { status: 'skipped', skippedReason: 'review request already sent or claimed' } });
          skipped++;
          continue;
        }
        user = claim.value;
      }
      const ok = await mailer.sendMail({ to: user.email, subject: email.subject, html: email.html, text: email.text });
      if (!ok) {
        if (isReviewRequest) await db.collection('users').updateOne({ _id: user._id, reviewRequestClaimedAt, reviewRequestSentAt: null }, { $unset: { reviewRequestClaimedAt: '' } });
        await db.collection('scheduled_emails').updateOne({ _id: job._id }, { $set: { status: 'failed', lastError: 'mailer returned false' } });
        failed++;
        continue;
      }
      const updates = {};
      if (isReviewRequest) updates.appsumoReviewStage = 3;
      if (job.template === 'appsumo_onboarding') updates.appsumoReviewStage = Math.max(Number(user.appsumoReviewStage || 0), 1);
      if (job.template === 'appsumo_review_eligible') updates.reviewPromptShownAt = new Date();
      if (isReviewRequest) updates.reviewRequestSentAt = new Date();
      if (isReviewRequest) updates.reviewRequestClaimedAt = null;
      if (Object.keys(updates).length) await db.collection('users').updateOne({ _id: user._id }, { $set: updates });
      if (isReviewRequest) {
        await recordMeasurementEvent(db, user, 'review_request_sent', `review-request-sent:${String(user._id)}`);
      }
      await db.collection('scheduled_emails').updateOne({ _id: job._id }, { $set: { status: 'sent', sentAt: new Date() } });
      sent++;
    } catch (error) {
      await db.collection('scheduled_emails').updateOne({ _id: job._id }, { $set: { status: 'failed', lastError: String(error && error.message || error).slice(0, 400) } }).catch(() => {});
      failed++;
    }
  }
  console.log(JSON.stringify({ due: scheduled.length, sent, skipped, failed }, null, 2));
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error && error.message || error);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
