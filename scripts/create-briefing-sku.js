#!/usr/bin/env node
'use strict';

// One-time setup for the paid Research Briefing SKU.
//
//   node scripts/create-briefing-sku.js            # dry run, writes nothing
//   node scripts/create-briefing-sku.js --live     # creates it for real
//
// Creates three things that must agree with each other, which is the whole
// reason this is a script and not a dashboard click-through:
//
//   1. a Product, whose name is what lands on the buyer's card statement
//   2. a recurring annual Price at BRIEFING_ANNUAL_USD (default $149)
//   3. a Payment Link carrying metadata.checkoutType = 'briefing_annual'
//
// (3) is the field that is easiest to forget by hand and the one that makes
// delivery work: briefing-subscription.matches() reads it first. The price-id
// fallback covers a link built without it, but only once the env var is set,
// so setting both here removes the ordering hazard entirely.
//
// The secret is read from backend/.env by dotenv. It is never accepted as an
// argument, so it cannot end up in shell history or a process listing.

const path = require('node:path');
const BACKEND = path.join(__dirname, '..', 'backend');
require(path.join(BACKEND, 'node_modules/dotenv')).config({ path: path.join(BACKEND, '.env') });
const Stripe = require(path.join(BACKEND, 'node_modules/stripe'));
const briefing = require(path.join(BACKEND, 'briefing-subscription'));

const LIVE = process.argv.includes('--live');
const PRODUCT_NAME = 'StockPortfolio.pro Research Briefing';
const DESCRIPTION = 'Two companies a month, researched and written by hand. Sourced to SEC filings, with the case against each stated. Not investment advice.';

function mask(id) {
    const s = String(id || '');
    return s.length > 12 ? `${s.slice(0, 8)}…${s.slice(-4)}` : s;
}

async function main() {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY missing from backend/.env');
    const mode = key.startsWith('sk_live') ? 'LIVE' : 'TEST';
    const usd = briefing.priceUsd();
    const unitAmount = Math.round(usd * 100);

    console.log(`Stripe mode : ${mode}`);
    console.log(`Product     : ${PRODUCT_NAME}`);
    console.log(`Price       : $${usd.toFixed(2)} / year  (${unitAmount} minor units)`);
    console.log(`Metadata    : checkoutType=${briefing.CHECKOUT_TYPE}`);

    const stripe = new Stripe(key);

    // Never create a second copy of a product that already exists — a
    // duplicate would split the subscriber base across two price ids and only
    // one of them can be in STRIPE_PRICE_ID_BRIEFING_ANNUAL.
    const existing = await stripe.products.search({
        query: `active:'true' AND name:'${PRODUCT_NAME}'`,
        limit: 5
    }).catch(() => ({ data: [] }));
    if (existing.data && existing.data.length) {
        console.log(`\nAlready exists: ${existing.data.map((p) => p.id).join(', ')}`);
        console.log('Refusing to create a duplicate. Archive the old one first if this is intentional.');
        return;
    }

    if (!LIVE) {
        console.log('\nDRY RUN — nothing written. Re-run with --live to create it.');
        return;
    }

    const product = await stripe.products.create({
        name: PRODUCT_NAME,
        description: DESCRIPTION,
        statement_descriptor: 'BRIEFING'
    });
    const price = await stripe.prices.create({
        product: product.id,
        unit_amount: unitAmount,
        currency: 'usd',
        recurring: { interval: 'year' }
    });
    const link = await stripe.paymentLinks.create({
        line_items: [{ price: price.id, quantity: 1 }],
        metadata: { checkoutType: briefing.CHECKOUT_TYPE },
        subscription_data: { metadata: { checkoutType: briefing.CHECKOUT_TYPE } },
        allow_promotion_codes: true
    });

    console.log('\nCreated:');
    console.log(`  product : ${product.id}`);
    console.log(`  price   : ${price.id}`);
    console.log(`  link    : ${link.url}`);
    console.log(`\nSet on Render:  STRIPE_PRICE_ID_BRIEFING_ANNUAL=${price.id}`);
    console.log(`(account ${mask(process.env.STRIPE_ACCOUNT_ID)}, mode ${mode})`);
}

main().catch((error) => {
    console.error('FAILED:', error && error.message);
    process.exit(1);
});
