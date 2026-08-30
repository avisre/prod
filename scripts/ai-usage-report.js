#!/usr/bin/env node
'use strict';

// Who actually uses the AI features — read-only, writes NOTHING.
//
//   node scripts/ai-usage-report.js              # this month
//   node scripts/ai-usage-report.js --all        # all time
//   node scripts/ai-usage-report.js --month 2026-07
//   node scripts/ai-usage-report.js --top 40
//
// Sources, and what each one can and cannot tell you:
//   ai_chat_usage  monthly Ask counts per user. The long history.
//   credit_ledger  per-spend rows, but only from 2026-08-29 and only for
//                  uncached reads by a paying user — undercounts real use.
//   dossier_views  per (user, symbol) with a views counter. From 2026-08-28.
//   monitor_views  same, for Filing Monitor. Added when this script was, so
//                  it is empty for everything that happened before that.
//   filing_reports the report cache, keyed (symbol, accession) — NO userId,
//                  so it measures what got built, never who read it.
//
// GOTCHA: user ids are stored as ObjectId in the mongoose-modelled collections
// (dossier_views, monitor_views, ask_reports) and as String in the raw ones
// (credit_ledger, ai_chat_usage, funnel_events). A $in of one type silently
// matches nothing against the other — it once reported an active buyer as
// having zero dossier views. userKeys() below passes both forms, always.

const path = require('node:path');
const BACKEND = path.join(__dirname, '..', 'backend');
require(path.join(BACKEND, 'node_modules/dotenv')).config({ path: path.join(BACKEND, 'prod.env') });
require(path.join(BACKEND, 'node_modules/dotenv')).config({ path: path.join(BACKEND, '.env') });
const mongoose = require(path.join(BACKEND, 'node_modules/mongoose'));

const MONITOR_PLANS = ['power', 'power-monthly', 'desk', 'enterprise'];
const ACTIVE = ['active', 'trialing', 'cancel_at_period_end'];

function parseArgs(argv) {
    const out = { top: 25 };
    for (let i = 0; i < argv.length; i += 1) {
        if (argv[i] === '--all') { out.all = true; continue; }
        if (argv[i] === '--month') { out.month = argv[i + 1]; i += 1; continue; }
        if (argv[i] === '--top') { out.top = Number(argv[i + 1]) || 25; i += 1; continue; }
    }
    return out;
}

const pad = (s, n) => String(s == null ? '' : s).slice(0, n).padEnd(n);
const num = (v, n = 7) => String(v == null ? '' : v).padStart(n);
const head = (t) => console.log(`\n${'='.repeat(78)}\n${t}\n${'='.repeat(78)}`);
const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : '');
const maxDate = (...ds) => {
    const v = ds.filter(Boolean).map((x) => new Date(x)).filter((x) => !Number.isNaN(x.getTime()));
    return v.length ? new Date(Math.max(...v)) : null;
};

// Both id encodings, so a $in matches whichever the collection happens to use.
function userKeys(ids) {
    const out = [];
    for (const id of ids) {
        out.push(String(id));
        try { out.push(new mongoose.Types.ObjectId(String(id))); } catch (_) { /* not an oid */ }
    }
    return out;
}

function cohortOf(u) {
    const sub = (u && u.subscription) || {};
    const active = ACTIVE.includes(String(sub.status || ''));
    if (active && MONITOR_PLANS.includes(String(sub.planId || '').toLowerCase())) return `PAID:${sub.planId}`;
    if (u && u.appsumoRedeemedAt) return `AppSumo T${u.appsumoTier || '?'}`;
    if (u && u.dealMirrorRedeemedAt) return `DealMirror ${u.dealMirrorTier || '?'}`;
    if (active && sub.planId) return `PAID:${sub.planId}`;
    return 'free';
}

// One row per user for a (collection, dateField), keyed by String(userId).
async function perUser(db, coll, dateField, keys, { sumField } = {}) {
    const rows = await db.collection(coll).aggregate([
        { $match: { userId: { $in: keys } } },
        { $group: {
            _id: '$userId',
            // $ifNull so a row written before the counter existed still counts
            // as one view rather than zero — otherwise real usage reads as none.
            n: sumField ? { $sum: { $max: [{ $ifNull: [`$${sumField}`, 1] }, 1] } } : { $sum: 1 },
            rows: { $sum: 1 },
            last: { $max: `$${dateField}` }
        } }
    ]).toArray();
    return new Map(rows.map((r) => [String(r._id), r]));
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required (backend/prod.env)');

    const month = args.month || new Date().toISOString().slice(0, 7);
    const scope = args.all ? {} : { month };
    const scopeLabel = args.all ? 'ALL TIME' : `MONTH ${month}`;
    const week = new Date(Date.now() - 7 * 86400000);

    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    const db = mongoose.connection.db;
    const ledger = db.collection('credit_ledger');
    const users = db.collection('users');
    const spendMatch = { ...scope, delta: { $lt: 0 } };

    // ---- 1. Feature mix (credit-weighted; weights differ a lot) -------------
    const byFeature = await ledger.aggregate([
        { $match: spendMatch },
        { $group: { _id: '$reason', credits: { $sum: { $abs: '$delta' } }, events: { $sum: 1 }, users: { $addToSet: '$userId' } } },
        { $project: { credits: 1, events: 1, users: { $size: '$users' } } },
        { $sort: { credits: -1 } }
    ]).toArray();
    const totalCredits = byFeature.reduce((s, r) => s + r.credits, 0) || 1;
    head(`FEATURE MIX — credit_ledger only (${scopeLabel})`);
    console.log(`${pad('feature', 20)}${num('credits')}${num('share', 8)}${num('events')}${num('users')}`);
    for (const r of byFeature) {
        console.log(`${pad(r._id || '(none)', 20)}${num(r.credits)}${num(`${Math.round(r.credits / totalCredits * 100)}%`, 8)}${num(r.events)}${num(r.users)}`);
    }
    const first = await ledger.find({}).sort({ at: 1 }).limit(1).toArray();
    if (first.length) console.log(`\n(credit_ledger begins ${day(first[0].at)} — anything before that is invisible here)`);

    // ---- 2. Every AppSumo buyer, all sources ------------------------------
    const buyers = await users.find({ appsumoRedeemedAt: { $ne: null } },
        { projection: { email: 1, appsumoTier: 1, appsumoRedeemedAt: 1, subscription: 1 } })
        .sort({ appsumoTier: 1, appsumoRedeemedAt: 1 }).toArray();
    const keys = userKeys(buyers.map((u) => u._id));

    const [chat, dossierV, monitorV, askR, funnel] = await Promise.all([
        perUser(db, 'ai_chat_usage', 'lastAt', keys, { sumField: 'count' }),
        perUser(db, 'dossier_views', 'lastViewedAt', keys, { sumField: 'views' }),
        perUser(db, 'monitor_views', 'lastViewedAt', keys, { sumField: 'views' }),
        perUser(db, 'ask_reports', 'createdAt', keys),
        perUser(db, 'funnel_events', 'timestamp', keys)
    ]);

    head(`APPSUMO BUYERS — every source (7d cutoff ${day(week)})`);
    console.log(`${pad('email', 30)}${pad('tier', 5)}${pad('redeemed', 10)}${num('asks', 6)}${num('doss', 6)}${num('mon', 6)}${num('evts', 6)}  lastSeen     7d`);
    let active7 = 0, usedAsk = 0, usedDoss = 0, usedMon = 0, everActive = 0;
    for (const u of buyers) {
        const id = String(u._id);
        const c = chat.get(id), d = dossierV.get(id), m = monitorV.get(id), a = askR.get(id), f = funnel.get(id);
        const last = maxDate(c && c.last, d && d.last, m && m.last, a && a.last, f && f.last);
        const seen7 = last && last >= week;
        if (seen7) active7 += 1;
        if (c && c.n) usedAsk += 1;
        if (d && d.rows) usedDoss += 1;
        if (m && m.rows) usedMon += 1;
        if (last) everActive += 1;
        console.log(`${pad(u.email, 30)}${pad(`T${u.appsumoTier || '?'}`, 5)}${pad(day(u.appsumoRedeemedAt), 10)}` +
            `${num((c && c.n) || 0, 6)}${num((d && d.n) || 0, 6)}${num((m && m.n) || 0, 6)}${num((f && f.n) || 0, 6)}  ` +
            `${pad(last ? day(last) : 'NEVER', 12)}${seen7 ? 'YES' : ''}`);
    }
    console.log(`\n--- over ${buyers.length} AppSumo buyers ---`);
    console.log(`active in last 7 days :  ${active7} / ${buyers.length}`);
    console.log(`ever used Ask         :  ${usedAsk} / ${buyers.length}`);
    console.log(`ever opened a Dossier :  ${usedDoss} / ${buyers.length}`);
    console.log(`ever ran Monitor      :  ${usedMon} / ${buyers.length}`);
    console.log(`any activity ever     :  ${everActive} / ${buyers.length}`);

    // ---- 3. Top spenders overall ------------------------------------------
    const top = await ledger.aggregate([
        { $match: spendMatch },
        { $group: { _id: '$userId', credits: { $sum: { $abs: '$delta' } },
            ask: { $sum: { $cond: [{ $eq: ['$reason', 'ask'] }, 1, 0] } },
            dossier: { $sum: { $cond: [{ $eq: ['$reason', 'dossier'] }, 1, 0] } },
            monitor: { $sum: { $cond: [{ $eq: ['$reason', 'monitor'] }, 1, 0] } },
            last: { $max: '$at' } } },
        { $sort: { credits: -1 } }, { $limit: args.top }
    ]).toArray();
    const topDocs = await users.find({ _id: { $in: userKeys(top.map((r) => r._id)) } },
        { projection: { email: 1, subscription: 1, appsumoTier: 1, appsumoRedeemedAt: 1, dealMirrorTier: 1, dealMirrorRedeemedAt: 1 } }).toArray();
    const topBy = new Map(topDocs.map((u) => [String(u._id), u]));
    head(`TOP ${args.top} BY CREDITS (${scopeLabel})`);
    console.log(`${pad('email', 32)}${pad('cohort', 16)}${num('credits')}${num('ask')}${num('doss')}${num('mon')}  last`);
    for (const r of top) {
        const u = topBy.get(String(r._id));
        console.log(`${pad(u && u.email || `(deleted ${r._id})`, 32)}${pad(cohortOf(u), 16)}` +
            `${num(r.credits)}${num(r.ask)}${num(r.dossier)}${num(r.monitor)}  ${day(r.last)}`);
    }

    // ---- 4. Who pays for Monitor today ------------------------------------
    const subs = await users.find({ 'subscription.planId': { $in: MONITOR_PLANS }, 'subscription.status': { $in: ACTIVE } },
        { projection: { email: 1, subscription: 1 } }).toArray();
    const subMon = await perUser(db, 'monitor_views', 'lastViewedAt', userKeys(subs.map((u) => u._id)), { sumField: 'views' });
    head('PAID MONITOR SUBSCRIBERS (Power / Desk / Enterprise)');
    console.log(`count: ${subs.length}`);
    if (subs.length) {
        console.log(`\n${pad('email', 34)}${pad('plan', 16)}${num('mon.views', 11)}  lastMonitor`);
        for (const u of subs) {
            const m = subMon.get(String(u._id));
            console.log(`${pad(u.email, 34)}${pad(u.subscription && u.subscription.planId, 16)}${num((m && m.n) || 0, 11)}  ${day(m && m.last)}`);
        }
        console.log('\n^ If these people never use Monitor, it is not what they are paying for.');
    }

    // ---- 5. Cost driver -----------------------------------------------------
    const [wl, st] = await Promise.all([
        db.collection('watchlists').aggregate([{ $unwind: '$symbols' }, { $group: { _id: null, syms: { $addToSet: '$symbols' } } }]).toArray(),
        db.collection('stocks').aggregate([{ $match: { assetType: { $nin: ['etf', 'mutual_fund', 'crypto'] } } }, { $group: { _id: null, syms: { $addToSet: '$symbol' } } }]).toArray()
    ]);
    const tracked = new Set([...(wl[0] && wl[0].syms || []), ...(st[0] && st[0].syms || [])]);
    const built = (await db.collection('filing_reports').distinct('symbol')).length;
    head('MONITOR COST DRIVER');
    console.log(`Companies across all watchlists + holdings : ${tracked.size}`);
    console.log(`Companies already in the report cache      : ${built}`);
    console.log('Reports are cached per (symbol, accession) and shared by every user, so an');
    console.log('extra Monitor user costs ~0 for any company already built. Cost scales with');
    console.log('distinct companies x filings per year — never with headcount.');

    await mongoose.disconnect();
}

main().catch((e) => { console.error('\nERROR:', e && e.message); process.exit(1); });
