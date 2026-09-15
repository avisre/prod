#!/usr/bin/env node
/**
 * wall-week-report.js — the 1-week hard-paywall experiment's numbers, in one
 * command. Read-only: it never writes and never emails.
 *
 *   node scripts/wall-week-report.js              (since the wall was armed 9/15)
 *   SINCE=2026-09-01 node scripts/wall-week-report.js
 *
 * The plan measures the funnel, not MRR: trials granted → checkouts started →
 * trial→paid conversions → and how many trials are still live at reading time.
 * Everything here comes from the users collection, so it needs no Stripe key.
 *
 * Why a script and not a one-off query: the wall's week ends on ~9/22 and the
 * interesting comparison is against the same numbers read a few days in. A
 * fixed query also means the definition of "converted" can't drift between
 * readings — `active` with a stripeSubscriptionId is paid; `trialing` is a live
 * trial; `cancelled` with a signupTrialAt but no payment is an expired trial.
 */

const path = require('path');
const BACKEND = path.join(__dirname, '..', 'backend');
require(path.join(BACKEND, 'node_modules', 'dotenv')).config({ path: path.join(BACKEND, '.env') });
const mongoose = require(path.join(BACKEND, 'node_modules', 'mongoose'));

// Armed ~08:00Z on 9/15. Override with SINCE=… for a different window.
const SINCE = new Date(process.env.SINCE || '2026-09-15T00:00:00Z');
const DAY = 24 * 3600 * 1000;

const day = (d) => (d ? new Date(d).toISOString().slice(0, 10) : null);

mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 }).then(async () => {
    const col = mongoose.connection.collection('users');
    const now = new Date();

    const created = await col.find({ createdAt: { $gte: SINCE } },
        { projection: { email: 1, createdAt: 1, signupTrialAt: 1, subscription: 1, stripeSubscriptionId: 1, initialPaymentAt: 1, googleId: 1 } }
    ).sort({ createdAt: 1 }).toArray();

    const rows = created.map((u) => {
        const s = u.subscription || {};
        const paid = s.status === 'active' && !!(u.stripeSubscriptionId || u.initialPaymentAt);
        const trialLive = s.status === 'trialing' && s.trialEndsAt && new Date(s.trialEndsAt) > now;
        const trialExpired = !!u.signupTrialAt && !paid && !trialLive;
        return {
            email: u.email,
            created: day(u.createdAt),
            via: u.googleId ? 'google' : 'email',
            trialGranted: !!u.signupTrialAt,
            status: s.status || null,
            trialEndsAt: day(s.trialEndsAt),
            planId: s.planId || null,
            outcome: paid ? 'PAID' : trialLive ? 'trial-live' : trialExpired ? 'trial-expired' : 'no-trial'
        };
    });

    const byDay = {};
    for (const r of rows) {
        byDay[r.created] = byDay[r.created] || { signups: 0, trialsGranted: 0, paid: 0 };
        byDay[r.created].signups += 1;
        if (r.trialGranted) byDay[r.created].trialsGranted += 1;
        if (r.outcome === 'PAID') byDay[r.created].paid += 1;
    }

    const count = (f) => rows.filter(f).length;
    const totals = {
        windowStarts: day(SINCE),
        daysElapsed: Math.max(1, Math.round((now - SINCE) / DAY)),
        signups: rows.length,
        trialsGranted: count((r) => r.trialGranted),
        trialsLiveNow: count((r) => r.outcome === 'trial-live'),
        trialsExpiredUnpaid: count((r) => r.outcome === 'trial-expired'),
        paid: count((r) => r.outcome === 'PAID'),
        signupsWithNoTrial: count((r) => r.outcome === 'no-trial')
    };
    totals.trialToPaidRate = totals.trialsGranted ? `${((totals.paid / totals.trialsGranted) * 100).toFixed(0)}%` : 'n/a';

    // The whole account base, so the week's cohort can be read against it.
    const byStatus = await col.aggregate([{ $group: { _id: '$subscription.status', n: { $sum: 1 } } }, { $sort: { n: -1 } }]).toArray();

    console.log(JSON.stringify({ totals, byDay, byStatus, rows }, null, 1));
    await mongoose.disconnect();
}).catch((e) => { console.error('ERR', e.message); process.exit(1); });
