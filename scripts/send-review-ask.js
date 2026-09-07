#!/usr/bin/env node
'use strict';

// A short personal note to the newest AppSumo buyers: how are you getting on,
// and if it has been useful, an honest review is welcome.
//
//   node scripts/send-review-ask.js                    # dry run
//   node scripts/send-review-ask.js --only a@b.com --live
//   node scripts/send-review-ask.js --live             # all of them
//
// Why this is not a review blast: the product already runs an automated review
// drip (startAppSumoJobs -> runAppSumoReviewSweep, daily) which deliberately
// holds until a buyer is review-eligible — 2+ completed research actions, or
// one plus two sessions. Asking someone for a review before they have used the
// thing produces no review, or a bad one. So this leads with the question that
// is actually useful to us, and mentions the review second, without pressure.
//
// The ask is deliberately unincentivised and rating-neutral, matching
// mailer.appsumoReviewEligibleEmail: no reward, no request for a particular
// score, and "critical" named as an acceptable answer. AppSumo's own rules and
// basic honesty both require that, and a review bought with a favour is worth
// less than no review at all.
//
// Sends as support@stockportfolio.pro over the product's SMTP. Logged to
// scripts/.sent-review-ask.json; a logged address is skipped on re-runs.

const path = require('node:path');
const fs = require('node:fs');
const BACKEND = path.join(__dirname, '..', 'backend');
require(path.join(BACKEND, 'node_modules/dotenv')).config({ path: path.join(BACKEND, '.env') });
const mailer = require(path.join(BACKEND, 'mailer'));

const LIVE = process.argv.includes('--live');
const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx > -1 ? String(process.argv[onlyIdx + 1] || '').toLowerCase() : null;

const LOG = path.join(__dirname, '.sent-review-ask.json');
const APP = process.env.APP_PUBLIC_URL || 'https://www.stockportfolio.pro';
const REVIEW_URL = 'https://appsumo.com/account/products/';
const SUBJECT = 'How are you getting on with it?';

// Recipients are NOT in source. The list carries customer email addresses
// and private notes on what each person said and bought — committing it
// would put customer data into public git history permanently. The file
// below is gitignored; see .recipients-review-ask.json.example for its shape.
const RECIPIENTS_FILE = path.join(__dirname, '.recipients-review-ask.json');
let RECIPIENTS;
try {
    RECIPIENTS = JSON.parse(fs.readFileSync(RECIPIENTS_FILE, 'utf8'));
} catch (_) {
    console.error(`Missing ${path.basename(RECIPIENTS_FILE)} — create it (gitignored) as [{ "email": "…", "name": "…", "bought": "5 September" }, …]`);
    process.exit(1);
}

function render(r) {
  const greeting = r.name ? `Hi ${r.name},` : 'Hi,';
  const paras = [
    `You picked up the lifetime deal on ${r.bought} — thank you. I run this on my own, so I read every reply myself.`,
    'One question, and a one-line answer is plenty: what did you buy it to do? I would rather build for a real job than guess at one.',
    `If you have not had a proper go yet, the fastest useful thing is one ticker and one question — the answer comes back with the filing it came from, so you can check it: ${APP}/ask`,
    `And if it has already been useful, an honest AppSumo review helps a great deal. Positive, mixed or critical — I am not asking for a particular rating and there is nothing on offer in return: ${REVIEW_URL}`,
    'Either way, reply and tell me what is missing. That is worth more to me than a review.'
  ];
  const text = [greeting, '', ...paras.flatMap((p) => [p, '']), '— Avinash', 'StockPortfolio.pro'].join('\n');
  const esc = mailer.escapeHtml;
  const html = `<div style="font-family:-apple-system,Segoe UI,Arial;max-width:560px;color:#0f172a"><p>${esc(greeting)}</p>${paras.map((p) => `<p>${esc(p)}</p>`).join('')}<p>— Avinash<br>StockPortfolio.pro</p></div>`;
  return { text, html };
}

function readLog() {
  try { return JSON.parse(fs.readFileSync(LOG, 'utf8')); } catch (_) { return {}; }
}

async function main() {
  const log = readLog();
  const targets = RECIPIENTS.filter((r) => !ONLY || r.email.toLowerCase() === ONLY);
  if (!targets.length) throw new Error(`No recipient matches --only ${ONLY}`);

  console.log(`Sender configured: ${mailer.isMailerConfigured()}`);
  console.log(`Mode: ${LIVE ? 'LIVE — will send' : 'DRY RUN — nothing sent'}\n`);

  for (const r of targets) {
    if (log[r.email]) { console.log(`SKIP  ${r.email} — already sent ${log[r.email]}`); continue; }
    const { text, html } = render(r);
    if (!LIVE) { console.log(`--- ${r.email} ---\n${text}\n`); continue; }
    const ok = await mailer.sendMail({ to: r.email, subject: SUBJECT, html, text });
    console.log(`${ok ? 'SENT ' : 'FAIL '} ${r.email}`);
    if (ok) { log[r.email] = new Date().toISOString(); fs.writeFileSync(LOG, JSON.stringify(log, null, 2)); }
  }
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
