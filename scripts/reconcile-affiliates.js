#!/usr/bin/env node
'use strict';

// Read-only customer-candidate reconciliation. It deliberately does not call
// update/insert/delete and does not print passwords, license keys or tokens.
const path = require('node:path');
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/prod.env') });
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/.env') });
const mongoose = require(path.join(__dirname, '../backend/node_modules/mongoose'));

async function main() {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000 });
    const db = mongoose.connection.db;
    const users = await db.collection('users').find({ $or: [
        { appsumoRedeemedAt: { $ne: null } },
        { stripeCustomerId: { $ne: null } },
        { stripeSubscriptionId: { $ne: null } }
    ] }, { projection: { name: 1, email: 1, createdAt: 1, updatedAt: 1, appsumoRedeemedAt: 1, appsumoTier: 1, stripeCustomerId: 1, stripeSubscriptionId: 1, 'subscription.status': 1, 'subscription.planId': 1, 'subscription.planName': 1 } }).toArray();
    const profiles = await db.collection('affiliate_profiles').find({}).toArray();
    const byUser = new Map(profiles.map((p) => [String(p.userId), p]));
    const active = new Set(['active', 'trialing', 'cancel_at_period_end']);
    const candidates = users.map((user) => {
        const appsumo = Boolean(user.appsumoRedeemedAt);
        const stripeLinked = Boolean(user.stripeCustomerId || user.stripeSubscriptionId);
        const stripeActive = stripeLinked && active.has(String(user.subscription?.status || ''));
        const profile = byUser.get(String(user._id));
        return { userId: String(user._id), email: user.email, name: user.name || null, purchaseSource: appsumo ? 'appsumo' : stripeActive ? 'stripe' : 'stripe_unverified', planId: user.subscription?.planId || null, planName: user.subscription?.planName || null, appsumoTier: user.appsumoTier || null, verifiedPurchase: appsumo || stripeActive, warning: stripeLinked && !stripeActive ? 'stripe_linked_but_not_active' : null, supportStatus: profile?.customerStatus || 'needs_support', ambassadorStatus: profile?.status || null, lastKnownActivityAt: user.updatedAt || user.createdAt || null };
    });
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), payingCandidateCount: candidates.filter((c) => c.verifiedPurchase).length, candidates }, null, 2));
    await mongoose.disconnect();
}
main().catch(async (error) => { console.error(error?.message || error); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });

