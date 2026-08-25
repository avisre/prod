#!/usr/bin/env node
'use strict';

// Read-only: list Stripe Checkout Sessions from the last 30 days that were never
// completed but do have an email attached, and write them to a CSV.
//
// This script SENDS NOTHING. It only reads from Stripe and writes a file. Any
// outreach to the people in that CSV is a separate, human decision — deliberately
// not automated here, because "abandoned checkout" includes people who changed
// their mind, tested the flow, or entered someone else's address.
//
//   node scripts/pull-abandoned-checkouts.js
//   node scripts/pull-abandoned-checkouts.js --days 14 --out /tmp/abandoned.csv
//
// Requires STRIPE_SECRET_KEY (read from backend/prod.env / backend/.env like the
// other reconcile scripts). Uses only stripe.checkout.sessions.list — no writes.

const fs = require('node:fs');
const path = require('node:path');
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/prod.env') });
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/.env') });

const Stripe = require(path.join(__dirname, '../backend/node_modules/stripe'));

function parseArgs(argv) {
    const out = { days: 30, out: null };
    for (let i = 0; i < argv.length; i++) {
        if (argv[i] === '--days') out.days = Math.max(1, parseInt(argv[++i], 10) || 30);
        else if (argv[i] === '--out') out.out = argv[++i];
        else if (argv[i] === '--help' || argv[i] === '-h') out.help = true;
    }
    return out;
}

function csvCell(value) {
    const s = value == null ? '' : String(value);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// A session's email can arrive in three places depending on how far the buyer
// got, so check all of them rather than only customer_details.
function emailOf(session) {
    return (session.customer_details && session.customer_details.email)
        || session.customer_email
        || (session.customer && typeof session.customer === 'object' ? session.customer.email : null)
        || null;
}

async function listSessions(stripe, createdAfter) {
    const out = [];
    let starting_after = null;
    do {
        const page = await stripe.checkout.sessions.list({
            limit: 100,
            created: { gte: createdAfter },
            ...(starting_after ? { starting_after } : {})
        });
        out.push(...page.data);
        starting_after = page.has_more && page.data.length ? page.data[page.data.length - 1].id : null;
    } while (starting_after);
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        console.log('Usage: node scripts/pull-abandoned-checkouts.js [--days 30] [--out FILE]\nRead-only Stripe pull. Writes a CSV. Sends nothing to anyone.');
        return;
    }
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key || !key.startsWith('sk_')) {
        console.error('No usable STRIPE_SECRET_KEY in backend/prod.env or backend/.env — cannot read Stripe.');
        process.exit(1);
    }
    const stripe = Stripe(key, { apiVersion: '2022-11-15' });

    const createdAfter = Math.floor(Date.now() / 1000) - args.days * 86400;
    const sessions = await listSessions(stripe, createdAfter);

    // "Abandoned" = never paid AND we have a way to reach them. `expired` counts:
    // Stripe expires an unfinished session after 24h, and that is exactly the
    // case we care about. `complete`/`paid` are excluded — those are customers.
    const rows = sessions
        .filter((s) => s.payment_status !== 'paid' && s.status !== 'complete')
        .map((s) => ({ session: s, email: emailOf(s) }))
        .filter((r) => r.email)
        .map(({ session: s, email }) => ({
            sessionId: s.id,
            createdAt: new Date(s.created * 1000).toISOString(),
            email,
            name: (s.customer_details && s.customer_details.name) || '',
            country: (s.customer_details && s.customer_details.address && s.customer_details.address.country) || '',
            status: s.status,
            paymentStatus: s.payment_status,
            mode: s.mode,
            currency: (s.currency || '').toUpperCase(),
            amountTotal: s.amount_total != null ? (s.amount_total / 100).toFixed(2) : '',
            planId: (s.metadata && (s.metadata.planId || s.metadata.plan)) || '',
            checkoutType: (s.metadata && s.metadata.checkoutType) || '',
            clientReferenceId: s.client_reference_id || ''
        }))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    const header = Object.keys(rows[0] || {
        sessionId: '', createdAt: '', email: '', name: '', country: '', status: '', paymentStatus: '',
        mode: '', currency: '', amountTotal: '', planId: '', checkoutType: '', clientReferenceId: ''
    });
    const csv = [header.join(','), ...rows.map((r) => header.map((h) => csvCell(r[h])).join(','))].join('\n') + '\n';

    const outPath = path.resolve(args.out || path.join(__dirname, '..', 'docs', 'growth', `abandoned-checkouts-${new Date().toISOString().slice(0, 10)}.csv`));
    fs.mkdirSync(path.dirname(outPath), { recursive: true });
    fs.writeFileSync(outPath, csv);

    console.log(`Scanned ${sessions.length} Checkout Sessions from the last ${args.days} days.`);
    console.log(`${rows.length} abandoned with an email attached.`);
    console.log(`Wrote ${outPath}`);
    console.log('Nothing was sent to anyone. Any outreach from this list is a manual decision.');
}

main().catch((err) => { console.error(`pull-abandoned-checkouts failed: ${err.message}`); process.exit(1); });
