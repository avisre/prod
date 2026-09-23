#!/usr/bin/env node
'use strict';
// Re-send the 2026-09-23 customer update, with receipts recorded this time.
//
//   node scripts/resend-customer-update-2026-09-24.js                       # dry run (default)
//   node scripts/resend-customer-update-2026-09-24.js --send --confirm "RESEND 60"
//
// Why a separate script rather than re-running broadcast-user-update.js: that
// one derives its idempotency key from the campaign id, so re-running it is a
// no-op by design (it would find the existing row and skip every recipient
// already marked sent). Sending under a NEW campaign id is what makes this a
// real re-send — and it is exactly why the guards below are not optional.
//
// The 60 people being sent this already received it on 2026-09-23. That is the
// owner's decision, recorded; the tool states it rather than hiding it.

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const dep = (m) => require(path.join(ROOT, 'backend/node_modules', m));
const PROD_ENV = path.join(ROOT, 'backend/prod.env');
dep('dotenv').config({ path: fs.existsSync(PROD_ENV) ? PROD_ENV : path.join(ROOT, 'backend/.env') });
const jwt = dep('jsonwebtoken');
const { MongoClient } = dep('mongodb');

const SEND = process.argv.includes('--send');
const CONFIRM = (() => {
  const i = process.argv.indexOf('--confirm');
  return i >= 0 ? String(process.argv[i + 1] || '') : '';
})();
const MAX_SENDS = (() => {
  const i = process.argv.indexOf('--max-sends');
  return i >= 0 ? parseInt(process.argv[i + 1], 10) || 0 : 70;
})();
const SPACING_MS = 1200;
const API = (process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro').replace(/\/$/, '');
const ADMIN_EMAIL = 'rin@gmail.com';
const BATCH_SIZE = 100; // endpoint cap
const NEW_CAMPAIGN = 'user-update-2026-09-24-resend';
const OLD_CAMPAIGN = 'user-update-2026-09-23';
const SEGMENTS = ['ltd', 'general'];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isLtdActive = (u) => !!(u.appsumoRedeemedAt || u.dealMirrorRedeemedAt)
  && u.subscription && u.subscription.status === 'active';

function loadMessage(segment) {
  const source = path.join(ROOT, `marketing/announcements/${OLD_CAMPAIGN}-${segment}.txt`);
  const raw = fs.readFileSync(source, 'utf8');
  const match = raw.match(/^SUBJECT\n([\s\S]*?)\n\nBODY\n([\s\S]*)$/);
  if (!match) throw new Error(`${source} is not in SUBJECT/BODY format.`);
  return { subject: match[1].trim(), body: match[2].trim() };
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required.');

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const db = client.db();

  const all = await db.collection('users')
    .find({ email: { $ne: ADMIN_EMAIL } }, {
      projection: { _id: 1, email: 1, customerMessageEmailsOptOut: 1, appsumoRedeemedAt: 1, dealMirrorRedeemedAt: 1, 'subscription.status': 1 }
    })
    .toArray();
  const admin = await db.collection('users').findOne({ email: ADMIN_EMAIL }, { projection: { _id: 1, authVersion: 1 } });

  // What the first run actually did, so the operator sees it before repeating it.
  const prior = await db.collection('customer_message_broadcasts')
    .find({ idempotencyKey: { $regex: `^${OLD_CAMPAIGN}-` } }, { projection: { subject: 1, status: 1, idempotencyKey: 1, recipients: 1, createdAt: 1 } })
    .toArray();

  // Anyone this re-send has ALREADY reached with a recorded receipt. The 9/23
  // rows carry no messageId (receipts did not exist yet), so they deliberately
  // do not appear here — but a second accidental run of this script will find
  // every recipient and skip them.
  const resent = await db.collection('customer_message_broadcasts')
    .find({ idempotencyKey: { $regex: `^${NEW_CAMPAIGN}-` } }, { projection: { recipients: 1 } })
    .toArray();
  const alreadyReceipted = new Set();
  for (const row of resent) {
    for (const r of row.recipients || []) {
      if (r.emailStatus === 'sent' && r.messageId) alreadyReceipted.add(String(r.userId));
    }
  }
  await client.close();

  console.log(`=== what ${OLD_CAMPAIGN} did ===`);
  if (!prior.length) console.log('  (no rows found — the first send is not recorded here)');
  prior.forEach((b) => {
    const rec = b.recipients || [];
    const tally = rec.reduce((m, r) => { m[r.emailStatus] = (m[r.emailStatus] || 0) + 1; return m; }, {});
    console.log(`  ${b.createdAt instanceof Date ? b.createdAt.toISOString() : b.createdAt} | ${b.status} | n=${rec.length} | ${JSON.stringify(tally)}`);
  });

  const plans = [];
  let total = 0;
  for (const segment of SEGMENTS) {
    const { subject, body } = loadMessage(segment);
    const everyone = all.filter((u) => (segment === 'ltd' ? isLtdActive(u) : !isLtdActive(u)));
    const skipped = everyone.filter((u) => alreadyReceipted.has(String(u._id)));
    const users = everyone.filter((u) => !alreadyReceipted.has(String(u._id)));
    plans.push({ segment, subject, body, users, skipped });
    total += users.length;
    console.log(`\n=== ${segment} ===`);
    console.log(`  subject:    ${subject}`);
    console.log(`  recipients: ${users.length}${skipped.length ? ` (+${skipped.length} already receipted this run — skipped)` : ''}`);
    users.forEach((u) => console.log(`    - ${u.email}`));
    if (skipped.length) skipped.forEach((u) => console.log(`    SKIP (already sent with receipt) ${u.email}`));
  }

  console.log(`\ntotal to send: ${total}`);
  console.log(`note: these recipients already received this exact message on 2026-09-23.`);

  if (!SEND) return console.log('\nDRY RUN — nothing was sent. Re-run with --send --confirm "RESEND <n>".');
  if (!total) return console.log('\nNothing left to send.');
  if (total > MAX_SENDS) throw new Error(`${total} exceeds --max-sends ${MAX_SENDS}; refusing.`);
  if (CONFIRM !== `RESEND ${total}`) throw new Error(`Confirmation must be exactly: --confirm "RESEND ${total}"`);
  if (!admin) throw new Error(`${ADMIN_EMAIL} was not found, so the send cannot be authenticated.`);

  const token = jwt.sign(
    { userId: String(admin._id), v: Number(admin.authVersion || 0) },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );

  let sentBatches = 0;
  for (const plan of plans) {
    if (!plan.users.length) continue;
    for (let i = 0; i < plan.users.length; i += BATCH_SIZE) {
      const batch = plan.users.slice(i, i + BATCH_SIZE);
      const n = i / BATCH_SIZE + 1;
      const bodyHash = crypto.createHash('sha1').update(plan.body).digest('hex').slice(0, 12);
      const response = await fetch(`${API}/api/admin/messages/broadcasts`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'User-Agent': 'stockportfolio-internal',
          Cookie: `sp_auth=${encodeURIComponent(token)}`
        },
        body: JSON.stringify({
          subject: plan.subject,
          body: plan.body,
          sendInApp: true,
          sendEmail: true,
          userIds: batch.map((u) => String(u._id)),
          confirmation: `SEND ${batch.length}`,
          idempotencyKey: `${NEW_CAMPAIGN}-${plan.segment}-b${n}-${bodyHash}`
        })
      });
      console.log(`batch ${plan.segment}/${n}: HTTP ${response.status} ${await response.text()}`);
      sentBatches += 1;
      await sleep(SPACING_MS);
    }
  }

  // The receipt file: read back what each recipient's send actually recorded.
  const client2 = new MongoClient(process.env.MONGODB_URI);
  await client2.connect();
  const written = await client2.db().collection('customer_message_broadcasts')
    .find({ idempotencyKey: { $regex: `^${NEW_CAMPAIGN}-` } }, { projection: { subject: 1, idempotencyKey: 1, status: 1, recipients: 1 } })
    .toArray();
  await client2.close();

  const lines = [];
  for (const b of written) {
    lines.push(`# ${b.subject} [${b.idempotencyKey}] ${b.status}`);
    for (const r of b.recipients || []) {
      lines.push(`${r.emailStatus}\t${r.email}\t${r.messageId || '(no receipt)'}\t${r.smtpResponse || ''}`);
    }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const out = path.join(ROOT, 'backend', `tmp-resend-receipt-${stamp}.txt`);
  fs.writeFileSync(out, lines.join('\n') + '\n');
  console.log(`\nsent ${sentBatches} batch(es); receipt written to ${path.relative(ROOT, out)}`);
  console.log('Verify in the admin screen: /admin/messages → "Delivery history & receipts".');
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
