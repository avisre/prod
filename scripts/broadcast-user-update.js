#!/usr/bin/env node
'use strict';
// One-off: the 2026-09-23 feature update, sent from support@ via the PROD
// admin broadcast endpoint (in-app message + email in a single call).
//
//   node scripts/broadcast-user-update.js --segment ltd     --dry-run
//   node scripts/broadcast-user-update.js --segment general --dry-run
//   node scripts/broadcast-user-update.js --segment ltd       # send
//
// Segments:
//   ltd     — active AppSumo/DealMirror buyers. Carries the lifetime API/MCP line
//             and the AppSumo review ask ("if you haven't left a review yet"),
//             since nothing records who actually reviewed.
//   general — everyone else, including refunded LTD buyers. No review ask.
//
// Same safeguards as broadcast-ai-features.js: opt-outs are suppressed by the
// endpoint, the admin account is excluded, and the idempotency key makes a
// re-run a no-op.

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const dep = (m) => require(path.join(ROOT, 'backend/node_modules', m));
const PROD_ENV = path.join(ROOT, 'backend/prod.env');
dep('dotenv').config({ path: fs.existsSync(PROD_ENV) ? PROD_ENV : path.join(ROOT, 'backend/.env') });
const jwt = dep('jsonwebtoken');
const { MongoClient } = dep('mongodb');

const DRY_RUN = process.argv.includes('--dry-run');
const SEGMENT = process.argv[process.argv.indexOf('--segment') + 1];
const API = (process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro').replace(/\/$/, '');
const ADMIN_EMAIL = 'rin@gmail.com';
const BATCH_SIZE = 100; // endpoint cap
const CAMPAIGN = 'user-update-2026-09-23';

const isLtdActive = (u) => !!(u.appsumoRedeemedAt || u.dealMirrorRedeemedAt)
  && u.subscription && u.subscription.status === 'active';

function loadMessage() {
  const source = path.join(ROOT, `marketing/announcements/${CAMPAIGN}-${SEGMENT}.txt`);
  const raw = fs.readFileSync(source, 'utf8');
  const match = raw.match(/^SUBJECT\n([\s\S]*?)\n\nBODY\n([\s\S]*)$/);
  if (!match) throw new Error(`${source} is not in SUBJECT/BODY format.`);
  const subject = match[1].trim();
  const body = match[2].trim();
  if (!subject || subject.length > 180) throw new Error('Subject must be 1-180 characters.');
  if (!body || body.length > 4000) throw new Error('Body must be 1-4000 characters.');
  return { subject, body };
}

async function main() {
  if (!['ltd', 'general'].includes(SEGMENT)) throw new Error('Pass --segment ltd or --segment general.');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required.');
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required.');
  const { subject, body } = loadMessage();

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const all = await client.db().collection('users')
    .find({ email: { $ne: ADMIN_EMAIL } }, {
      projection: { _id: 1, email: 1, customerMessageEmailsOptOut: 1, appsumoRedeemedAt: 1, dealMirrorRedeemedAt: 1, 'subscription.status': 1 }
    })
    .toArray();
  const admin = await client.db().collection('users')
    .findOne({ email: ADMIN_EMAIL }, { projection: { _id: 1, authVersion: 1 } });
  await client.close();

  const users = all.filter((u) => (SEGMENT === 'ltd' ? isLtdActive(u) : !isLtdActive(u)));
  const optOuts = users.filter((u) => u.customerMessageEmailsOptOut).length;
  console.log(`segment:    ${SEGMENT}`);
  console.log(`subject:    ${subject}`);
  console.log(`body:       ${body.length} chars`);
  console.log(`recipients: ${users.length} (${optOuts} have opted out of email; they still get the in-app message)`);
  users.forEach((u) => console.log(`  - ${u.email}`));

  if (DRY_RUN) return console.log('\nDRY RUN — nothing was sent.');
  if (!users.length) return console.log('\nNo recipients; nothing to send.');
  if (!admin) throw new Error(`${ADMIN_EMAIL} was not found, so the broadcast cannot be authenticated.`);

  const token = jwt.sign(
    { userId: String(admin._id), v: Number(admin.authVersion || 0) },
    process.env.JWT_SECRET,
    { expiresIn: '1h' }
  );
  const bodyHash = crypto.createHash('sha1').update(body).digest('hex').slice(0, 12);

  for (let i = 0; i < users.length; i += BATCH_SIZE) {
    const batch = users.slice(i, i + BATCH_SIZE);
    const n = i / BATCH_SIZE + 1;
    const response = await fetch(`${API}/api/admin/messages/broadcasts`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'stockportfolio-internal',
        Cookie: `sp_auth=${encodeURIComponent(token)}`
      },
      body: JSON.stringify({
        subject,
        body,
        sendInApp: true,
        sendEmail: true,
        userIds: batch.map((u) => String(u._id)),
        confirmation: `SEND ${batch.length}`,
        idempotencyKey: `${CAMPAIGN}-${SEGMENT}-b${n}-${bodyHash}`
      })
    });
    console.log(`batch ${n}: HTTP ${response.status} ${await response.text()}`);
  }
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
