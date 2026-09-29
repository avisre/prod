#!/usr/bin/env node
'use strict';
// Read-only unless --apply is explicit. Never loads database/mail credentials.
// --key-file accepts a raw Stripe key file OR an env file parsed only for the
// requested Stripe key. No secrets are printed, persisted or passed in argv.
const fs = require('node:fs');
const path = require('node:path');
const Stripe = require('../backend/node_modules/stripe');
const dotenv = require('../backend/node_modules/dotenv');
const args = process.argv.slice(2);
const value = key => args.includes(key) ? args[args.indexOf(key) + 1] : null;
const mode = value('--mode') || 'test';
async function main() {
    if (!['test', 'live'].includes(mode)) throw new Error('--mode must be test or live');
    let key = mode === 'test' ? process.env.STRIPE_TEST_SECRET_KEY : process.env.STRIPE_SECRET_KEY;
    const file = value('--key-file');
    if (file) {
        const text = fs.readFileSync(path.resolve(file), 'utf8').trim();
        const parsed = dotenv.parse(text);
        key = /^sk_(test|live)_\w+$/.test(text) ? text : mode === 'test' ? parsed.STRIPE_TEST_SECRET_KEY || parsed.STRIPE_SECRET_KEY : parsed.STRIPE_SECRET_KEY;
    }
    if (!key?.startsWith(`sk_${mode}_`)) throw new Error(`A ${mode}-mode Stripe key is required. No Stripe calls made.`);
    const stripe = Stripe(key, { apiVersion: '2022-11-15' });
    const account = await stripe.accounts.retrieve();
    const products = [];
    for await (const product of stripe.products.list({ active: true, limit: 100 })) {
        if (product.name.trim().toLowerCase() === 'stockportfolio.pro') products.push(product);
    }
    if (products.length !== 1) throw new Error(`Expected exactly one active stockportfolio.pro product; found ${products.length}. No changes made.`);
    const product = products[0];
    const matches = [];
    for await (const price of stripe.prices.list({ active: true, product: product.id, type: 'recurring', limit: 100 })) {
        if (price.unit_amount === 4900 && price.currency === 'usd' && price.recurring?.interval === 'month' && price.recurring?.interval_count === 1 && price.recurring?.usage_type === 'licensed' && price.billing_scheme === 'per_unit') matches.push(price);
    }
    if (matches.length > 1) throw new Error('Multiple matching prices found. Reconcile them before launch. No changes made.');
    let price = matches[0];
    let created = false;
    if (!price && args.includes('--apply')) {
        price = await stripe.prices.create({ product: product.id, unit_amount: 4900, currency: 'usd', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }, nickname: 'Filing Watch — $49/month; Monthly software plus founder-prepared weekly service', metadata: { planId: 'filing-watch', revenueType: 'service_plus_software', pilotCapacity: '5' } }, { idempotencyKey: 'filing-watch-49-usd-month-v1' });
        created = true;
    }
    console.log(JSON.stringify({ mode, accountId: account.id, chargesEnabled: account.charges_enabled, payoutsEnabled: account.payouts_enabled, productId: product.id, priceId: price?.id || null, amountMinor: price?.unit_amount || null, currency: price?.currency || null, interval: price?.recurring?.interval || null, created, next: price ? 'Set STRIPE_PRICE_ID_FILING_WATCH to this price id. Keep FILING_WATCH_ENABLED=false until sandbox and deployed checkout checks pass.' : 'No matching price. Rerun with --apply to create only this one price.' }, null, 2));
}
main().catch(error => { console.error(error.type ? `Stripe request failed: ${error.type} (${error.statusCode || 'unknown status'})` : error.message); process.exitCode = 1; });
