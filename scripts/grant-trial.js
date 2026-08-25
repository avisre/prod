#!/usr/bin/env node
'use strict';

// Admin pre-grant: give a feature first, invoice later.
//
//   node scripts/grant-trial.js --user <id|email> --feature monitor --days 14
//
// Writes ONLY the trialGrant entry. It never touches subscription, Stripe,
// AppSumo or any billing field — so the worst a mistake here can do is give
// somebody free access for a fortnight, and revoking it is a delete.
// Pass --dry-run to see exactly what would be written without writing it.

const path = require('node:path');
const BACKEND = path.join(__dirname, '..', 'backend');
require(path.join(BACKEND, 'node_modules/dotenv')).config({ path: path.join(BACKEND, 'prod.env') });
require(path.join(BACKEND, 'node_modules/dotenv')).config({ path: path.join(BACKEND, '.env') });
const mongoose = require(path.join(BACKEND, 'node_modules/mongoose'));

const FEATURES = ['monitor'];

function parseArgs(argv) {
    const out = {};
    for (let i = 0; i < argv.length; i += 1) {
        const a = argv[i];
        if (!a.startsWith('--')) continue;
        const key = a.slice(2);
        if (key === 'dry-run') { out.dryRun = true; continue; }
        out[key] = argv[i + 1];
        i += 1;
    }
    return out;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const feature = String(args.feature || '').trim();
    const days = Number(args.days);
    const who = String(args.user || '').trim();

    if (!who) throw new Error('--user <id|email> is required');
    if (!FEATURES.includes(feature)) throw new Error(`--feature must be one of: ${FEATURES.join(', ')}`);
    if (!Number.isFinite(days) || days < 1 || days > 90) throw new Error('--days must be a whole number between 1 and 90');
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');

    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    const users = mongoose.connection.db.collection('users');
    const query = /^[a-f0-9]{24}$/i.test(who)
        ? { _id: new mongoose.Types.ObjectId(who) }
        : { email: who.toLowerCase() };
    const user = await users.findOne(query, { projection: { email: 1, name: 1, trialGrant: 1 } });
    if (!user) throw new Error(`No user matched ${who}`);

    const now = new Date();
    const grant = {
        feature,
        grantedAt: now,
        expiresAt: new Date(now.getTime() + days * 86400000),
        source: 'admin',
        expiryEmailQueuedAt: null,
        revokedAt: null
    };
    const existing = (user.trialGrant || []).find((g) => g && g.feature === feature && g.expiresAt && new Date(g.expiresAt) > now);
    if (existing) {
        console.log(`User ${user.email} already has an active ${feature} grant until ${new Date(existing.expiresAt).toISOString()} — not adding a second one.`);
        await mongoose.disconnect();
        return;
    }

    console.log(JSON.stringify({ user: user.email, grant }, null, 2));
    if (args.dryRun) {
        console.log('--dry-run: nothing written.');
    } else {
        await users.updateOne({ _id: user._id }, { $push: { trialGrant: grant } });
        console.log(`Granted ${feature} to ${user.email} until ${grant.expiresAt.toISOString()}.`);
    }
    await mongoose.disconnect();
}

main().catch(async (error) => {
    console.error(error && error.message || error);
    try { await mongoose.disconnect(); } catch (_) { /* already down */ }
    process.exit(1);
});
