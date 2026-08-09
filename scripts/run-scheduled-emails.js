#!/usr/bin/env node
'use strict';

const path = require('node:path');
const jwt = require(path.join(__dirname, '../backend/node_modules/jsonwebtoken'));
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/prod.env') });
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/.env') });

const mongoose = require(path.join(__dirname, '../backend/node_modules/mongoose'));
const mailer = require('../backend/mailer');

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
      if (job.template !== 'appsumo_review_5d') {
        await db.collection('scheduled_emails').updateOne({ _id: job._id }, { $set: { status: 'skipped', skippedReason: 'unknown template' } });
        skipped++;
        continue;
      }
      const user = await db.collection('users').findOne({ _id: job.userId });
      if (!user || user.appsumoEmailsOptOut || !user.appsumoRedeemedAt || user.appsumoReviewStage >= 2 || user.subscription?.status !== 'active') {
        await db.collection('scheduled_emails').updateOne({ _id: job._id }, { $set: { status: 'skipped', skippedReason: 'not eligible at send time' } });
        skipped++;
        continue;
      }
      const unsubUrl = `${appUrl}/api/appsumo/unsubscribe?token=${appsumoUnsubToken(user._id)}`;
      const email = mailer.appsumoReviewEmail(user.name, appUrl, 2, appsumoReviewUrl(), unsubUrl);
      const ok = await mailer.sendMail({ to: user.email, subject: email.subject, html: email.html, text: email.text });
      if (!ok) {
        await db.collection('scheduled_emails').updateOne({ _id: job._id }, { $set: { status: 'failed', lastError: 'mailer returned false' } });
        failed++;
        continue;
      }
      await db.collection('users').updateOne({ _id: user._id }, { $set: { appsumoReviewStage: 2 } });
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
