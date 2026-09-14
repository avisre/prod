#!/usr/bin/env node
'use strict';

// The 12 high-ACV warm leads: people who picked a rung and hit the payment step
// while it was broken. Copy and rationale in
// notes/2026-09-14-warm-lead-emails.md. Owner approved the send 2026-09-14.
//
//   node scripts/send-warm-lead-recovery.js                  # dry run, sends nothing
//   node scripts/send-warm-lead-recovery.js --live --limit 4 # send today's batch
//   node scripts/send-warm-lead-recovery.js --only a@b.com --live
//
// Goes out as support@stockportfolio.pro, the identity these people already
// have a relationship with. That is allowed here precisely because they are
// EXISTING users — CLAUDE.md forbids support@ for cold outreach, which this is
// not.
//
// THE LOAD-BEARING DETAIL: every link carries ?client_reference_id=<user _id>.
// A bare Stripe payment link carries no userId, no client_reference_id and no
// subscription metadata, so the webhook resolves nobody and grants NOTHING —
// the buyer is charged and gets silence. With it, app.js:9885's clientRef
// fallback finds them and the plan resolves off their own stored
// subscription.planId (app.js:4156). So a lead is only ever sent the link for
// the rung they already chose; a mismatch charges one price and grants another.
// Verified end to end on 2026-09-14 by replaying a real paid session.
//
// Sends are logged to scripts/.sent-warm-lead-recovery.json and a logged
// address is skipped forever after. These are individually addressed notes to
// named customers; sending one twice is not a rate-limit issue, it is an
// embarrassment.

const path = require('node:path');
const fs = require('node:fs');
const BACKEND = path.join(__dirname, '..', 'backend');
require(path.join(BACKEND, 'node_modules/dotenv')).config({ path: path.join(BACKEND, '.env') });
const mongoose = require(path.join(BACKEND, 'node_modules/mongoose'));
const mailer = require(path.join(BACKEND, 'mailer'));

const LIVE = process.argv.includes('--live');
const onlyIdx = process.argv.indexOf('--only');
const ONLY = onlyIdx > -1 ? String(process.argv[onlyIdx + 1] || '').toLowerCase() : null;
const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx > -1 ? Number(process.argv[limitIdx + 1]) : Infinity;
const LOG = path.join(__dirname, '.sent-warm-lead-recovery.json');

// Verified active in Stripe on 2026-09-14.
const LINKS = {
    'pro-annual': 'https://buy.stripe.com/8x23cu0Coa2cgXN4C24sE05',
    desk: 'https://buy.stripe.com/cNi8wO1Gs5LW22T5G64sE08'
};
const REMAP = { pro: 'pro-annual', power: 'pro-annual', 'power-monthly': 'pro-annual' };

function alreadySent() {
    try { return new Set(JSON.parse(fs.readFileSync(LOG, 'utf8'))); } catch (_) { return new Set(); }
}
function recordSent(set) { fs.writeFileSync(LOG, JSON.stringify([...set], null, 2)); }

function firstName(name, email) {
    const n = String(name || '').trim().split(/\s+/)[0];
    if (n && /^[A-Za-z][A-Za-z'-]{1,}$/.test(n)) return n;
    return String(email || '').split('@')[0].replace(/[._-]+/g, ' ').split(' ')[0] || 'there';
}
function when(date) {
    if (!date) return 'a little while back';
    return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

function body({ stored, name, email, signedUp, link }) {
    const who = firstName(name, email);
    const month = when(signedUp);
    if (stored === 'desk') {
        return {
            subject: 'your Desk signup — what stopped you?',
            text: `Hi ${who},

You started a Desk signup in ${month} and were never charged — our payment step was broken then. It works now.

Before you click anything: Desk is the full research set plus API and MCP access and the filing monitor, at $1,999.99/year. Is that still what you're after, or were you really after one piece of it? If it's one piece, there's probably a cheaper rung that fits, and I'd rather put you on the right one than the biggest one.

If Desk is right, this link is tied to your account:
${link}

Either way, a one-line reply telling me what you actually need would help.

— Avinash
StockPortfolio.pro`
        };
    }
    if (stored === 'pro-annual') {
        return {
            subject: 'the Pro plan you signed up for — and what it cost you',
            text: `Hi ${who},

You signed up for Pro in ${month} and never got charged, because our payment step was broken. That was ours, not yours, and I'm sorry it wasted your time.

One thing I owe you: Pro was $250/year when you chose it. It's $499.99 now. You shouldn't pay more because our checkout didn't work, so this link honours your original price for the first year — $250, renewing at the current rate after that, cancel any time before then:

${link}

The discount should already be applied when the page opens; if it isn't, the code is ORIGINAL250.

If something other than the price stopped you, I'd genuinely like to know what. A one-line reply is plenty, and it changes what I build next.

— Avinash
StockPortfolio.pro`
        };
    }
    return {
        subject: 'your Pro signup never went through — that was our bug',
        text: `Hi ${who},

You picked Pro in ${month} and were never charged. Our payment step was broken at the time — nothing to do with your card. It's fixed, and this link is tied to your account so it picks up where you left off:

${link}

If you've since decided it isn't for you, that's a fair answer and I won't chase it. But if something specific put you off — the price, a missing feature, or it just wasn't clear what you'd get — telling me in one line would genuinely help.

— Avinash
StockPortfolio.pro`
    };
}

function html(text) {
    return text.split('\n\n').map((p) => {
        const safe = p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        const linked = safe.replace(/(https:\/\/[^\s]+)/g, '<a href="$1">$1</a>');
        return `<p style="margin:0 0 14px">${linked.replace(/\n/g, '<br>')}</p>`;
    }).join('\n');
}

async function main() {
    if (LIVE && !mailer.isMailerConfigured()) {
        console.error('SMTP is not configured for the support mailbox — refusing to send.');
        process.exit(1);
    }
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
    const docs = await mongoose.connection.collection('users')
        .find({ 'subscription.status': 'pending' })
        .project({ email: 1, name: 1, createdAt: 1, subscription: 1 })
        .toArray();

    const leads = [];
    for (const d of docs) {
        const stored = String(d.subscription?.planId || '').toLowerCase();
        const effective = REMAP[stored] || stored;
        if (effective !== 'pro-annual' && effective !== 'desk') continue;   // high-ACV only
        const base = LINKS[effective];
        if (!base) continue;
        const link = stored === 'pro-annual'
            ? `${base}?client_reference_id=${d._id}&prefilled_promo_code=ORIGINAL250`
            : `${base}?client_reference_id=${d._id}`;
        leads.push({ email: String(d.email || '').toLowerCase(), name: d.name, signedUp: d.createdAt, stored, effective, link });
    }
    // Desk first, then Pro/Power, then the price-honouring five — the order the
    // plan sets, highest intent and highest value first.
    const rank = (l) => (l.stored === 'desk' ? 0 : l.stored === 'pro-annual' ? 2 : 1);
    leads.sort((a, b) => rank(a) - rank(b) || String(a.signedUp) .localeCompare(String(b.signedUp)));

    const sent = alreadySent();
    let done = 0;
    for (const lead of leads) {
        if (!lead.email) continue;
        if (ONLY && lead.email !== ONLY) continue;
        if (sent.has(lead.email)) { console.log(`skip (already sent): ${lead.email}`); continue; }
        if (done >= LIMIT) { console.log(`— limit ${LIMIT} reached, stopping —`); break; }

        const { subject, text } = body(lead);
        console.log(`\n${LIVE ? 'SEND' : 'DRY '} → ${lead.email}  [${lead.stored} → ${lead.effective}]`);
        console.log(`  subject: ${subject}`);
        console.log(`  link:    ${lead.link.replace(/client_reference_id=[a-f0-9]+/, 'client_reference_id=<id>')}`);
        if (!LIVE) { done += 1; continue; }

        const ok = await mailer.sendMail({ to: lead.email, subject, text, html: html(text) });
        if (ok) { sent.add(lead.email); recordSent(sent); done += 1; console.log('  sent.'); }
        else console.log('  FAILED — not logged, safe to retry.');
    }
    console.log(`\n${LIVE ? 'sent' : 'would send'}: ${done}   (pool ${leads.length}, previously sent ${alreadySent().size})`);
    if (!LIVE) console.log('dry run — add --live to actually send.');
    await mongoose.disconnect();
}

main().catch((e) => { console.error('ERR', e && e.message); process.exit(1); });
