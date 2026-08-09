#!/usr/bin/env node
'use strict';

const path = require('node:path');
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/prod.env') });
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/.env') });

const mongoose = require(path.join(__dirname, '../backend/node_modules/mongoose'));
const Stripe = require(path.join(__dirname, '../backend/node_modules/stripe'));

async function listStripeSubscriptions(stripe) {
  if (!stripe) return [];
  const out = [];
  let starting_after = null;
  do {
    const page = await stripe.subscriptions.list({ limit: 100, ...(starting_after ? { starting_after } : {}) });
    out.push(...page.data);
    starting_after = page.has_more && page.data.length ? page.data[page.data.length - 1].id : null;
  } while (starting_after);
  return out;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const db = mongoose.connection.db;
  const collections = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((entry) => entry.name));
  const appsumoCollection = collections.has('appsumolicenses') ? 'appsumolicenses' : 'appsumo_licenses';
  const users = await db.collection('users').find({}, {
    projection: {
      email: 1, stripeCustomerId: 1, stripeSubscriptionId: 1, appsumoLicenseKey: 1,
      appsumoRedeemedAt: 1, 'subscription.status': 1, 'subscription.planName': 1
    }
  }).toArray();
  const licenses = await db.collection(appsumoCollection).find({}, {
    projection: { licenseKey: 1, status: 1, userId: 1, tier: 1, redeemedAt: 1 }
  }).toArray();
  const lifecycle = await db.collection('customer_lifecycle_events').find({}, {
    projection: { userId: 1, type: 1, email: 1 }
  }).toArray();

  const stripe = process.env.STRIPE_SECRET_KEY ? Stripe(process.env.STRIPE_SECRET_KEY, { apiVersion: '2022-11-15' }) : null;
  const stripeSubscriptions = await listStripeSubscriptions(stripe);
  const activeStripeIds = new Set(stripeSubscriptions
    .filter((sub) => ['active', 'trialing'].includes(sub.status))
    .map((sub) => sub.id));

  const activeAppSumoUsers = users.filter((user) => user.appsumoRedeemedAt && user.subscription?.status === 'active');
  const activeStripeUsers = users.filter((user) =>
    user.subscription && ['active', 'trialing', 'cancel_at_period_end'].includes(user.subscription.status)
    && (user.stripeCustomerId || user.stripeSubscriptionId)
  );
  const userById = new Map(users.map((user) => [String(user._id), user]));
  const mismatches = [];

  for (const user of activeStripeUsers) {
    if (stripe && user.stripeSubscriptionId && !activeStripeIds.has(user.stripeSubscriptionId)) {
      mismatches.push({ type: 'stripe_user_not_active_in_stripe', email: user.email, stripeSubscriptionId: user.stripeSubscriptionId });
    }
  }
  for (const sub of stripeSubscriptions.filter((entry) => ['active', 'trialing'].includes(entry.status))) {
    const found = users.find((user) => user.stripeSubscriptionId === sub.id || user.stripeCustomerId === sub.customer);
    if (!found) mismatches.push({ type: 'stripe_subscription_without_user', stripeSubscriptionId: sub.id, stripeCustomerId: sub.customer });
  }
  for (const license of licenses.filter((lic) => lic.status !== 'deactivated' && lic.userId)) {
    if (!userById.has(String(license.userId))) mismatches.push({ type: 'appsumo_license_user_missing', licenseStatus: license.status, tier: license.tier });
  }
  for (const user of activeAppSumoUsers) {
    const license = licenses.find((lic) => lic.licenseKey && lic.licenseKey === user.appsumoLicenseKey);
    if (!license || license.status === 'deactivated') mismatches.push({ type: 'appsumo_user_without_active_license', email: user.email });
  }

  const lifecycleCounts = lifecycle.reduce((acc, event) => {
    acc[event.type] = (acc[event.type] || 0) + 1;
    return acc;
  }, {});
  const result = {
    generatedAt: new Date().toISOString(),
    payingCustomers: activeAppSumoUsers.length + activeStripeUsers.length,
    split: { appsumo: activeAppSumoUsers.length, stripe: activeStripeUsers.length },
    appsumoLicenses: {
      collection: appsumoCollection,
      total: licenses.length,
      activeOrInactive: licenses.filter((lic) => lic.status !== 'deactivated').length,
      redeemed: licenses.filter((lic) => lic.userId).length,
      deactivated: licenses.filter((lic) => lic.status === 'deactivated').length
    },
    stripe: {
      configured: Boolean(stripe),
      subscriptions: stripeSubscriptions.length,
      activeOrTrialingSubscriptions: activeStripeIds.size
    },
    lifecycleCounts,
    mismatches
  };
  console.log(JSON.stringify(result, null, 2));
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error && error.message || error);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
