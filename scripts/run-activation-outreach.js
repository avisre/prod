#!/usr/bin/env node
'use strict';

const path = require('node:path');
const jwt = require(path.join(__dirname, '../backend/node_modules/jsonwebtoken'));
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/prod.env') });
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/.env') });

const { MongoClient, ObjectId } = require(path.join(__dirname, '../backend/node_modules/mongodb'));
const mailer = require('../backend/mailer');

const CAMPAIGN = 'activation-help-2026-08-09';
const DAY_MS = 24 * 60 * 60 * 1000;
const CONTACT_COOLDOWN_MS = 4 * DAY_MS;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || 'there';
}

function maskEmail(email) {
  const [local = '', domain = ''] = String(email || '').split('@');
  return `${local.slice(0, 1)}***${local.slice(-1)}@${domain}`;
}

function unsubscribeUrl(appUrl, userId, purpose) {
  const token = jwt.sign({ userId: String(userId), p: purpose }, process.env.JWT_SECRET, { expiresIn: '180d' });
  const route = purpose === 'as-review' ? 'appsumo' : 'trial';
  return `${appUrl}/api/${route}/unsubscribe?token=${encodeURIComponent(token)}`;
}

function buyerEmail(user, appUrl) {
  const first = escapeHtml(firstName(user.name));
  const askUrl = `${appUrl}/ask?source=email&content_id=activation-help`;
  const toolsUrl = `${appUrl}/tools?source=email&content_id=activation-help`;
  const unsub = unsubscribeUrl(appUrl, user._id, 'as-review');
  const subject = 'What are you researching in StockPortfolio.pro?';
  const text = [
    `Hi ${firstName(user.name)},`,
    '',
    'What ticker have you been researching? Send me one question and I’ll help you run it in StockPortfolio.pro.',
    '',
    `Ask with filing sources: ${askUrl}`,
    `Free research tools: ${toolsUrl}`,
    '',
    'Reply to this email with the ticker and the question. I read the replies myself.',
    '',
    '— Avinash',
    'StockPortfolio.pro',
    '',
    `Stop these onboarding emails: ${unsub}`
  ].join('\n');
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;max-width:600px;margin:0 auto;color:#172033;line-height:1.65">
    <p>Hi ${first},</p>
    <p><strong>What ticker have you been researching?</strong> Send me one question and I’ll help you run it in StockPortfolio.pro.</p>
    <p><a href="${escapeHtml(askUrl)}">Ask with filing sources</a> · <a href="${escapeHtml(toolsUrl)}">Use the free research tools</a></p>
    <p>Reply to this email with the ticker and the question. I read the replies myself.</p>
    <p>— Avinash<br/>StockPortfolio.pro</p>
    <p style="font-size:12px;color:#64748b"><a href="${escapeHtml(unsub)}" style="color:#64748b">Stop these onboarding emails</a></p>
  </div>`;
  return { subject, text, html };
}

function expiredTrialEmail(user, appUrl) {
  const first = escapeHtml(firstName(user.name));
  const toolsUrl = `${appUrl}/tools?source=email&content_id=trial-reactivation-help`;
  const appsumoUrl = `${appUrl}/appsumo?source=email&content_id=trial-reactivation-help`;
  const unsub = unsubscribeUrl(appUrl, user._id, 'trial-emails');
  const subject = 'Want help researching one stock?';
  const text = [
    `Hi ${firstName(user.name)},`,
    '',
    'Your StockPortfolio.pro trial has ended, but I’d still like to help you get one useful result.',
    '',
    'Reply with one ticker and the question you were trying to answer. I’ll point you to the right filing, comparison, or free tool.',
    '',
    `Free research tools: ${toolsUrl}`,
    `Current AppSumo offer: ${appsumoUrl}`,
    '',
    '— Avinash',
    'StockPortfolio.pro',
    '',
    `Stop these trial emails: ${unsub}`
  ].join('\n');
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Arial,sans-serif;max-width:600px;margin:0 auto;color:#172033;line-height:1.65">
    <p>Hi ${first},</p>
    <p>Your StockPortfolio.pro trial has ended, but I’d still like to help you get one useful result.</p>
    <p><strong>Reply with one ticker and the question you were trying to answer.</strong> I’ll point you to the right filing, comparison, or free tool.</p>
    <p><a href="${escapeHtml(toolsUrl)}">Use the free research tools</a> · <a href="${escapeHtml(appsumoUrl)}">See the current AppSumo offer</a></p>
    <p>— Avinash<br/>StockPortfolio.pro</p>
    <p style="font-size:12px;color:#64748b"><a href="${escapeHtml(unsub)}" style="color:#64748b">Stop these trial emails</a></p>
  </div>`;
  return { subject, text, html };
}

async function trialCohort(db, since) {
  const events = await db.collection('funnel_events').find({
    event: 'trial_start',
    userId: { $ne: null },
    $or: [{ timestamp: { $gte: since } }, { at: { $gte: since } }]
  }).sort({ timestamp: 1, at: 1 }).toArray();
  const ids = [...new Set(events.map((event) => String(event.userId)))]
    .filter((id) => ObjectId.isValid(id))
    .map((id) => new ObjectId(id));
  return db.collection('users').find({ _id: { $in: ids } }).toArray();
}

async function main() {
  const send = process.argv.includes('--send');
  const retryFailed = process.argv.includes('--retry-failed');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required');
  if (send && !mailer.isMailerConfigured()) throw new Error('SMTP is not configured');

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db();
  const outbox = db.collection('campaign_outreach');
  await outbox.createIndex({ outreachKey: 1 }, { unique: true });

  const users = await trialCohort(db, new Date(Date.now() - 30 * DAY_MS));
  const appUrl = (process.env.APP_PUBLIC_URL || 'https://www.stockportfolio.pro').replace(/\/$/, '');
  const results = { mode: send ? 'send' : 'dry-run', campaign: CAMPAIGN, cohort: users.length, eligible: 0, sent: 0, skipped: 0, failed: 0, rows: [] };

  for (const user of users) {
    const isBuyer = Boolean(user.appsumoRedeemedAt) && user.subscription?.status === 'active';
    const isExpired = !user.appsumoRedeemedAt && user.subscription?.status === 'cancelled';
    const optedOut = isBuyer ? user.appsumoEmailsOptOut === true : user.trialEmailsOptOut === true;
    const segment = isBuyer ? 'appsumo-buyer' : isExpired ? 'expired-trial' : null;
    const outreachKey = `${CAMPAIGN}:${String(user._id)}`;
    const prior = await outbox.findOne({ outreachKey });
    const normalizedEmail = String(user.email || '').trim().toLowerCase();
    const recentOtherContact = normalizedEmail ? await outbox.findOne({
      to: normalizedEmail,
      status: 'sent',
      campaign: { $ne: CAMPAIGN },
      sentAt: { $gte: new Date(Date.now() - CONTACT_COOLDOWN_MS) },
    }, { projection: { _id: 1 } }) : null;

    if (!segment || optedOut || recentOtherContact || (prior && prior.status === 'sent') || (prior && prior.status === 'failed' && !retryFailed)) {
      results.skipped++;
      results.rows.push({
        user: maskEmail(user.email),
        segment: segment || 'ineligible',
        action: optedOut ? 'opted-out' : recentOtherContact ? 'recent-contact-cooldown' : prior?.status || 'skipped',
      });
      continue;
    }

    results.eligible++;
    if (!send) {
      results.rows.push({ user: maskEmail(user.email), segment, action: prior ? `would-retry-${prior.status}` : 'would-send' });
      continue;
    }

    try {
      if (prior && prior.status === 'failed' && retryFailed) {
        await outbox.updateOne({ outreachKey, status: 'failed' }, { $set: { status: 'sending', retryStartedAt: new Date(), lastError: null } });
      } else {
        await outbox.insertOne({ outreachKey, campaign: CAMPAIGN, userId: user._id, segment, to: normalizedEmail, status: 'sending', createdAt: new Date() });
      }
      const email = isBuyer ? buyerEmail(user, appUrl) : expiredTrialEmail(user, appUrl);
      const ok = await mailer.sendMail({ to: user.email, subject: email.subject, html: email.html, text: email.text });
      if (!ok) throw new Error('mailer returned false');
      await outbox.updateOne({ outreachKey }, { $set: { status: 'sent', sentAt: new Date(), subject: email.subject } });
      results.sent++;
      results.rows.push({ user: maskEmail(user.email), segment, action: 'sent' });
    } catch (error) {
      await outbox.updateOne({ outreachKey }, { $set: { status: 'failed', failedAt: new Date(), lastError: String(error && error.message || error).slice(0, 300) } }, { upsert: true }).catch(() => {});
      results.failed++;
      results.rows.push({ user: maskEmail(user.email), segment, action: 'failed' });
    }
  }

  console.log(JSON.stringify(results, null, 2));
  await client.close();
  if (results.failed) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error && error.message || error);
    process.exit(1);
  });
}

module.exports = { buyerEmail, expiredTrialEmail, escapeHtml, firstName, maskEmail };
