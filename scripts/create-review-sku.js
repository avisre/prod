#!/usr/bin/env node
'use strict';

// One-time SKU: a paid two-ticker review. The buyer names two companies and
// gets them written up by hand — the white-glove product, priced per job.
//
//   node scripts/create-review-sku.js            # dry run, writes nothing
//   node scripts/create-review-sku.js --live     # creates it for real
//
// Deliberately a ONE-TIME payment, not a subscription: it is a piece of work
// delivered once, and billing it annually would promise a cadence that does
// not exist. That is the opposite decision from the briefing SKU, and the
// reason the two cannot share a product.
//
// The secret is read from backend/.env by dotenv. It is never accepted as an
// argument, so it cannot end up in shell history or a process listing.

const path = require('node:path');
const BACKEND = path.join(__dirname, '..', 'backend');
require(path.join(BACKEND, 'node_modules/dotenv')).config({ path: path.join(BACKEND, '.env') });
const Stripe = require(path.join(BACKEND, 'node_modules/stripe'));

const LIVE = process.argv.includes('--live');
const PRODUCT_NAME = 'StockPortfolio.pro Two-Ticker Review';
const DESCRIPTION = 'Two companies of your choosing, researched and written up by hand: what the business does, what the filings say in plain language, and the case against it. Research, not investment advice.';
const USD = 99;

async function main() {
    const key = process.env.STRIPE_SECRET_KEY;
    if (!key) throw new Error('STRIPE_SECRET_KEY missing from backend/.env');
    const mode = key.startsWith('sk_live') ? 'LIVE' : 'TEST';
    console.log(`Stripe mode : ${mode}`);
    console.log(`Product     : ${PRODUCT_NAME}`);
    console.log(`Price       : $${USD}.00 one-time`);

    const stripe = new Stripe(key);

    // Never create a second copy — a duplicate splits buyers across two price
    // ids and only one of them can be the link you send.
    const existing = await stripe.products.search({
        query: `active:'true' AND name:'${PRODUCT_NAME}'`, limit: 5
    }).catch(() => ({ data: [] }));
    if (existing.data && existing.data.length) {
        console.log(`\nAlready exists: ${existing.data.map((p) => p.id).join(', ')} — refusing to duplicate.`);
        return;
    }

    if (!LIVE) { console.log('\nDRY RUN — nothing written. Re-run with --live to create it.'); return; }

    const product = await stripe.products.create({
        name: PRODUCT_NAME, description: DESCRIPTION, statement_descriptor: 'TICKER REVIEW'
    });
    const price = await stripe.prices.create({
        product: product.id, unit_amount: USD * 100, currency: 'usd'
    });
    const link = await stripe.paymentLinks.create({
        line_items: [{ price: price.id, quantity: 1 }],
        metadata: { checkoutType: 'ticker_review' },
        // The whole product depends on knowing which two companies they want,
        // so it is collected at checkout rather than chased over email after.
        custom_fields: [{
            key: 'tickers',
            label: { type: 'custom', custom: 'Which two tickers?' },
            type: 'text'
        }],
        allow_promotion_codes: true
    });

    console.log('\nCreated:');
    console.log(`  product : ${product.id}`);
    console.log(`  price   : ${price.id}`);
    console.log(`  link    : ${link.url}`);
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1); });
