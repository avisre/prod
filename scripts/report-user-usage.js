#!/usr/bin/env node
'use strict';

// Per-user usage report (read-only).
//
// Prints who is using the product, on which surface, what they ask for, and the
// bytes their requests cost — response bytes plus the cache read/write their
// request caused. Reads the usage_daily / usage_counts rollups written by
// backend/usage-aggregate.js. It never writes to production collections and
// never changes an account, plan or allowance.
//
//   node scripts/report-user-usage.js --days=30 --limit=25
//   node scripts/report-user-usage.js --userId=<accountId> --days=90
//   node scripts/report-user-usage.js --json=out.json --full
//
// Emails are masked unless --full is passed, because this table is safe to
// paste into a shared channel in the default form.

const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.join(__dirname, '..');
const mongoose = require(path.join(ROOT, 'backend/node_modules/mongoose'));
require(path.join(ROOT, 'backend/node_modules/dotenv')).config({ path: path.join(ROOT, 'backend/.env') });

function arg(name, fallback = '') {
    const hit = process.argv.find((v) => v.startsWith(`--${name}=`));
    if (hit) return hit.slice(name.length + 3);
    return process.argv.includes(`--${name}`) ? 'true' : fallback;
}
const mask = (email) => String(email || '').replace(/^(.)[^@]*/, '$1***');
const mb = (n) => (Number(n || 0) / 1048576).toFixed(1);

async function main() {
    const days = Math.min(Math.max(Number(arg('days', '30')), 1), 400);
    const limit = Math.min(Math.max(Number(arg('limit', '25')), 1), 200);
    const full = arg('full', 'false') === 'true';
    const jsonOut = arg('json');
    const userId = arg('userId');

    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
    const db = mongoose.connection.db;
    const daily = db.collection('usage_daily');
    const counts = db.collection('usage_counts');

    const istDay = (d) => new Date(d.getTime() + 330 * 60000).toISOString().slice(0, 10);
    const since = istDay(new Date(Date.now() - (days - 1) * 86400000));
    const filter = { day: { $gte: since } };
    if (userId) filter.userKey = 'u:' + String(userId);

    const [totalsRow] = await daily.aggregate([{ $match: filter }, { $group: {
        _id: null, requests: { $sum: '$requests' }, resBytes: { $sum: '$resBytes' },
        cacheReadBytes: { $sum: '$cacheReadBytes' }, cacheWriteBytes: { $sum: '$cacheWriteBytes' },
        cacheHits: { $sum: '$cacheHits' }, cacheMisses: { $sum: '$cacheMisses' }
    } }]).toArray();
    const totals = totalsRow || { requests: 0, resBytes: 0, cacheReadBytes: 0, cacheWriteBytes: 0 };
    const grand = Number(totals.resBytes || 0) + Number(totals.cacheReadBytes || 0) + Number(totals.cacheWriteBytes || 0) || 1;

    const bySurface = await daily.aggregate([{ $match: filter }, { $group: {
        _id: '$surface', requests: { $sum: '$requests' }, resBytes: { $sum: '$resBytes' },
        cacheReadBytes: { $sum: '$cacheReadBytes' }, cacheWriteBytes: { $sum: '$cacheWriteBytes' }
    } }, { $sort: { resBytes: -1 } }]).toArray();

    const users = await daily.aggregate([{ $match: filter }, { $group: {
        _id: '$userKey', plan: { $max: '$plan' }, days: { $addToSet: '$day' },
        requests: { $sum: '$requests' }, err: { $sum: '$err' },
        resBytes: { $sum: '$resBytes' }, cacheReadBytes: { $sum: '$cacheReadBytes' },
        cacheWriteBytes: { $sum: '$cacheWriteBytes' }, cacheHits: { $sum: '$cacheHits' },
        cacheMisses: { $sum: '$cacheMisses' }, activeMinutes: { $sum: '$activeMinutes' },
        firstAt: { $min: '$firstAt' }, lastAt: { $max: '$lastAt' }
    } }, { $addFields: { costBytes: { $add: ['$resBytes', { $add: ['$cacheReadBytes', '$cacheWriteBytes'] }] }, activeDays: { $size: '$days' } } },
    { $sort: { costBytes: -1 } }, { $limit: limit }]).toArray();

    const ids = users.map((u) => String(u._id)).filter((k) => /^u:[a-f0-9]{24}$/i.test(k)).map((k) => new mongoose.Types.ObjectId(k.slice(2)));
    const accounts = ids.length ? await db.collection('users').find({ _id: { $in: ids } }, { projection: { email: 1, createdAt: 1, subscription: 1 } }).toArray() : [];
    const byId = new Map(accounts.map((a) => ['u:' + String(a._id), a]));

    const rows = users.map((u) => {
        const account = byId.get(String(u._id)) || null;
        const total = u.cacheHits + u.cacheMisses;
        return {
            userKey: u._id,
            accountId: account ? String(account._id) : null,
            email: account ? account.email : null,
            plan: u.plan || (account && account.subscription && account.subscription.planName) || null,
            system: String(u._id).startsWith('system:'),
            anonymous: String(u._id).startsWith('a:'),
            activeDays: u.activeDays,
            activeMinutes: u.activeMinutes || 0,
            requests: u.requests,
            errors: u.err || 0,
            resBytes: u.resBytes || 0,
            cacheReadBytes: u.cacheReadBytes || 0,
            cacheWriteBytes: u.cacheWriteBytes || 0,
            costBytes: u.costBytes || 0,
            sharePct: Math.round(((u.costBytes || 0) / grand) * 1000) / 10,
            cacheHitRatePct: total ? Math.round((u.cacheHits / total) * 1000) / 10 : null,
            firstAt: u.firstAt || null,
            lastAt: u.lastAt || null
        };
    });

    const top = (kind, n = 15) => counts.aggregate([{ $match: { ...(userId ? { userKey: 'u:' + String(userId) } : {}), day: { $gte: since }, kind } },
        { $group: { _id: '$key', n: { $sum: '$n' } } }, { $sort: { n: -1 } }, { $limit: n }]).toArray()
        .then((r) => r.map((x) => ({ key: x._id, n: x.n })));

    const report = {
        generatedAt: new Date().toISOString(), days, since,
        totals: { requests: totals.requests || 0, resBytes: totals.resBytes || 0, cacheReadBytes: totals.cacheReadBytes || 0, cacheWriteBytes: totals.cacheWriteBytes || 0 },
        bySurface: bySurface.map((s) => ({ surface: s._id, requests: s.requests, resBytes: s.resBytes, cacheReadBytes: s.cacheReadBytes, cacheWriteBytes: s.cacheWriteBytes })),
        users: rows,
        topRoutes: await top('route'), topTools: await top('tool'),
        topSymbols: await top('symbol'), topMetrics: await top('metric')
    };

    if (jsonOut) {
        fs.writeFileSync(jsonOut, JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
        console.log('wrote ' + jsonOut);
    }

    const label = (r) => (r.system ? r.userKey : r.anonymous ? r.userKey : (r.email ? (full ? r.email : mask(r.email)) + ' · ' + String(r.accountId || '').slice(-6) : r.userKey));
    console.log(`\nUsage ${days}d since ${since} — requests ${report.totals.requests} | response ${mb(report.totals.resBytes)} MB | cache read ${mb(report.totals.cacheReadBytes)} MB | cache write ${mb(report.totals.cacheWriteBytes)} MB`);
    console.log('\nBy surface:');
    for (const s of report.bySurface) console.log(`  ${String(s.surface).padEnd(10)} req ${String(s.requests).padStart(6)}  resp ${mb(s.resBytes).padStart(8)} MB  cacheR ${mb(s.cacheReadBytes).padStart(8)} MB  cacheW ${mb(s.cacheWriteBytes).padStart(8)} MB`);
    console.log('\nTop users by cost (response + cache moved):');
    console.log(`  ${'user'.padEnd(38)} ${'days'.padStart(4)} ${'req'.padStart(6)} ${'resp'.padStart(8)} ${'cacheR'.padStart(8)} ${'cacheW'.padStart(8)} ${'share'.padStart(6)} ${'hit%'.padStart(6)}`);
    for (const r of rows) {
        console.log(`  ${label(r).slice(0, 38).padEnd(38)} ${String(r.activeDays).padStart(4)} ${String(r.requests).padStart(6)} ${mb(r.resBytes).padStart(8)} ${mb(r.cacheReadBytes).padStart(8)} ${mb(r.cacheWriteBytes).padStart(8)} ${(r.sharePct + '%').padStart(6)} ${(r.cacheHitRatePct == null ? '-' : r.cacheHitRatePct + '%').padStart(6)}`);
    }
    const show = (title, list) => { if (list.length) console.log(`\n${title}: ` + list.map((x) => `${x.key}×${x.n}`).join(', ')); };
    show('Top routes', report.topRoutes);
    show('Top tools', report.topTools);
    show('Top symbols', report.topSymbols);
    show('Top metrics', report.topMetrics);
    if (!report.totals.requests) console.log('\nNo rows yet — the aggregator flushes once a minute after the next deploy.');
    console.log('');

    await mongoose.disconnect();
}

main().catch((error) => {
    console.error('report failed:', String((error && error.message) || error).replace(/mongodb[^\s]+/gi, '[redacted]'));
    process.exitCode = 1;
});
