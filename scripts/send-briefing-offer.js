#!/usr/bin/env node
'use strict';

// Founding-subscriber offer for the Research Briefing, sent to the early
// AppSumo buyers over the product's own SMTP identity.
//
//   node scripts/send-briefing-offer.js                 # dry run: prints, sends nothing
//   node scripts/send-briefing-offer.js --only a@b.com  # one person
//   node scripts/send-briefing-offer.js --live          # actually sends
//
// Goes out as StockPortfolio.pro Support <support@stockportfolio.pro> rather
// than from a personal mailbox. That is not cosmetic: mail from the founder's
// Gmail has already landed in at least one of these buyers' spam folders, and
// mailer.isMailerConfigured() refuses to treat any non-support mailbox as a
// valid sender for customer mail.
//
// Sends are logged to scripts/.sent-briefing-offer.json and a logged address is
// skipped on later runs. These are individually written notes to a handful of
// named customers, so sending one twice is not a rate-limit problem, it is an
// embarrassment — the guard is there to make a re-run safe.

const path = require('node:path');
const fs = require('node:fs');
const BACKEND = path.join(__dirname, '..', 'backend');
require(path.join(BACKEND, 'node_modules/dotenv')).config({ path: path.join(BACKEND, '.env') });
const mailer = require(path.join(BACKEND, 'mailer'));

const LIVE = process.argv.includes('--live');
const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx > -1 ? String(process.argv[onlyIdx + 1] || '').toLowerCase() : null;

const LOG = path.join(__dirname, '.sent-briefing-offer.json');
const CHECKOUT = 'https://buy.stripe.com/9B66oG1Gsa2c9vl6Ka4sE07';
const SUBJECT = 'Two companies a month, written by hand';

// The opener is the only part that differs, and it is the only part that
// matters: each one refers to something that person actually said.
// Recipients are NOT in source. The list carries customer email addresses
// and private notes on what each person said and bought — committing it
// would put customer data into public git history permanently. The file
// below is gitignored; see .recipients-briefing-offer.json.example for its shape.
const RECIPIENTS_FILE = path.join(__dirname, '.recipients-briefing-offer.json');
let RECIPIENTS;
try {
    RECIPIENTS = JSON.parse(fs.readFileSync(RECIPIENTS_FILE, 'utf8'));
} catch (_) {
    console.error(`Missing ${path.basename(RECIPIENTS_FILE)} — create it (gitignored) as [{ "email": "…", "name": "…", "opener": "…" }, …]`);
    process.exit(1);
}

const BODY = [
  'I’ve started a small paid newsletter, separate from the app. Two companies a month, chosen by me, each written up by hand: what the business actually does, what the numbers say translated out of jargon, every figure traceable back to an SEC filing, and the case against it set out as clearly as the case for it. No buy signals and no price targets — just the reasoning, so you can argue with it where you think I’ve got it wrong.',
  'Me choosing the names is the point. Your lifetime deal already lets you pull up any ticker you’ve thought of. Working out which two are worth your attention this month is the harder half, and it’s the part the software can’t do for you.',
  'It’s $149 a year for the first AppSumo buyers. It goes to $199 after that, and your rate stays where it started for as long as you stay subscribed.'
];

const TAIL = [
  'Full refund within 30 days if the first couple of issues aren’t useful, no explanation needed. After that you can cancel any time and it simply stops renewing.',
  'Two things to be straight about. This is separate from your lifetime deal, which doesn’t change in any way. And it’s research, not personal advice — I don’t know your situation and I won’t tell you to buy or sell anything.',
  'If you’d rather not get notes like this, just say so and I’ll stop.'
];

function render(r) {
  const greeting = r.name ? `Hi ${r.name},` : 'Hi,';
  const text = [greeting, '', r.opener, '', ...BODY.flatMap((p) => [p, '']), CHECKOUT, '', ...TAIL.flatMap((p) => [p, '']), '— Avinash', 'StockPortfolio.pro'].join('\n');
  const esc = mailer.escapeHtml;
  const paras = [r.opener, ...BODY].map((p) => `<p>${esc(p)}</p>`).join('');
  const tail = TAIL.map((p) => `<p style="font-size:13px;color:#64748b">${esc(p)}</p>`).join('');
  const html = `<div style="font-family:-apple-system,Segoe UI,Arial;max-width:560px;color:#0f172a"><p>${esc(greeting)}</p>${paras}<p><a href="${CHECKOUT}" style="background:#111827;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;font-weight:700">Subscribe — $149/year</a></p>${tail}<p>— Avinash<br>StockPortfolio.pro</p></div>`;
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
    if (!LIVE) {
      console.log(`--- ${r.email} ---\n${text}\n`);
      continue;
    }
    const ok = await mailer.sendMail({ to: r.email, subject: SUBJECT, html, text });
    console.log(`${ok ? 'SENT ' : 'FAIL '} ${r.email}`);
    if (ok) {
      log[r.email] = new Date().toISOString();
      fs.writeFileSync(LOG, JSON.stringify(log, null, 2));
    }
  }
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
