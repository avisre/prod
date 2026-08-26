#!/usr/bin/env node
'use strict';
// One-off: announce the AI research update to every customer via the PROD
// admin broadcast endpoint (in-app message + email in a single call).
//
//   node scripts/broadcast-ai-features.js --dry-run   # list recipients, send nothing
//   node scripts/broadcast-ai-features.js             # send
//
// Sends through the live endpoint so Render's SMTP credentials are used, and
// so the endpoint's own safeguards apply: opt-outs are suppressed, the admin
// account is excluded, and the idempotency key makes a re-run a no-op.

const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const dep = (m) => require(path.join(ROOT, 'backend/node_modules', m));
dep('dotenv').config({ path: path.join(ROOT, 'backend/prod.env') });
const jwt = dep('jsonwebtoken');
const { MongoClient } = dep('mongodb');

const DRY_RUN = process.argv.includes('--dry-run');
const API = (process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro').replace(/\/$/, '');
const ADMIN_EMAIL = 'rin@gmail.com';
const BATCH_SIZE = 100; // endpoint cap
const SOURCE = path.join(ROOT, 'marketing/announcements/ai-features-2026-08-24.txt');

function loadMessage() {
  const raw = fs.readFileSync(SOURCE, 'utf8');
  const match = raw.match(/^SUBJECT\n([\s\S]*?)\n\nBODY\n([\s\S]*)$/);
  if (!match) throw new Error(`${SOURCE} is not in SUBJECT/BODY format.`);
  const subject = match[1].trim();
  const body = match[2].trim();
  if (!subject || subject.length > 180) throw new Error('Subject must be 1-180 characters.');
  if (!body || body.length > 4000) throw new Error('Body must be 1-4000 characters.');
  return { subject, body };
}

async function main() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required (backend/prod.env).');
  if (!process.env.JWT_SECRET) throw new Error('JWT_SECRET is required (backend/prod.env).');
  const { subject, body } = loadMessage();

  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  const users = await client.db().collection('users')
    .find({ email: { $ne: ADMIN_EMAIL } }, { projection: { _id: 1, email: 1, customerMessageEmailsOptOut: 1 } })
    .toArray();
  const admin = await client.db().collection('users')
    .findOne({ email: ADMIN_EMAIL }, { projection: { _id: 1, authVersion: 1 } });
  await client.close();

  const optOuts = users.filter((u) => u.customerMessageEmailsOptOut).length;
  console.log(`subject:    ${subject}`);
  console.log(`body:       ${body.length} chars`);
  console.log(`recipients: ${users.length} (${optOuts} have opted out of email; they still get the in-app message)`);
  console.log(`batches:    ${Math.ceil(users.length / BATCH_SIZE)} of up to ${BATCH_SIZE}`);
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
      headers: { 'Content-Type': 'application/json', Cookie: `sp_auth=${encodeURIComponent(token)}` },
      body: JSON.stringify({
        subject,
        body,
        sendInApp: true,
        sendEmail: true,
        userIds: batch.map((u) => String(u._id)),
        confirmation: `SEND ${batch.length}`,
        idempotencyKey: `ai-features-2026-08-24-b${n}-${bodyHash}`
      })
    });
    console.log(`batch ${n}: HTTP ${response.status} ${await response.text()}`);
  }
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
