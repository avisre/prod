'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const refundQuote = require('../refund-quote');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const page = (name) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', name), 'utf8');

test('only plans priced above Monthly deduct usage', () => {
    assert.equal(refundQuote.deductsUsage(79.99, 79.99), false, 'Monthly keeps a full refund');
    assert.equal(refundQuote.deductsUsage(49, 79.99), false, 'Filing Watch is below Monthly');
    assert.equal(refundQuote.deductsUsage(649.99, 79.99), true, 'Annual');
    assert.equal(refundQuote.deductsUsage(799.99, 79.99), true, 'Pro');
    assert.equal(refundQuote.deductsUsage(1999.99, 79.99), true, 'Desk');
    assert.equal(refundQuote.deductsUsage(200, 79.99), true, 'Developer');
    assert.equal(refundQuote.deductsUsage(undefined, 79.99), false, 'an unknown price never deducts');
});

test('the refund is the payment minus plan credits used at the top-up rate', () => {
    const q = refundQuote.quote({ paidMinor: 64999, spentByMonth: [{ month: '2026-10', spent: 300 }], monthlyAllowance: 300, topupPriceMinor: 1499, topupCredits: 150 });
    assert.deepEqual(q, { paidMinor: 64999, creditsUsed: 300, deductionMinor: 2998, refundMinor: 62001 });
});

test('a window across the 1st counts both months, each capped at the allowance', () => {
    const q = refundQuote.quote({
        paidMinor: 64999,
        spentByMonth: [{ month: '2026-10', spent: 450 }, { month: '2026-11', spent: 120 }],
        monthlyAllowance: 300, topupPriceMinor: 1499, topupCredits: 150
    });
    // 450 in October is 300 plan credits plus 150 from a top-up the customer
    // paid for separately; only the 300 is deducted.
    assert.equal(q.creditsUsed, 420);
    assert.equal(q.deductionMinor, Math.round(420 * 1499 / 150));
});

test('nothing used means a full refund, and the deduction never exceeds the payment', () => {
    assert.equal(refundQuote.quote({ paidMinor: 64999, spentByMonth: [], monthlyAllowance: 300, topupPriceMinor: 1499, topupCredits: 150 }).refundMinor, 64999);
    const all = refundQuote.quote({ paidMinor: 1000, spentByMonth: [{ month: '2026-10', spent: 10000 }], monthlyAllowance: 10000, topupPriceMinor: 1499, topupCredits: 150 });
    assert.equal(all.refundMinor, 0);
    assert.equal(all.deductionMinor, 1000);
});

test('the deduction is decided when the payment is recorded, from the plan it bought', () => {
    const fn = appSource.slice(appSource.indexOf('async function recordInitialStripePayment'));
    const body = fn.slice(0, fn.indexOf('\n}\n'));
    assert.match(body, /initialPaidMinor = /);
    assert.match(body, /getPlanConfigByPriceId\(linePriceId\)/);
    assert.match(body, /initialRefundDeductsUsage = refundQuote\.deductsUsage\(boughtPlan && boughtPlan\.price, CORE_PLAN_PRICE\)/);
    assert.match(appSource, /initialRefundDeductsUsage: \{ type: Boolean, default: false \}/, 'earlier payments keep a full refund');
});

test('the refund route refunds the quoted amount and refuses when nothing is left', () => {
    const route = appSource.slice(appSource.indexOf("app.post('/api/billing/refund'"));
    const body = route.slice(0, route.indexOf("app.post('/api/subscription/cancel'"));
    assert.match(body, /const priced = await initialRefundQuote\(req, claimed\)/);
    assert.match(body, /\.\.\.\(priced \? \{ amount: priced\.refundMinor \} : \{\}\)/);
    assert.match(body, /REFUND_NOTHING_LEFT/);
    const quoteFn = appSource.slice(appSource.indexOf('async function initialRefundQuote'));
    assert.match(quoteFn.slice(0, 1500), /credits\.spentByMonthSince\(user\._id, user\.initialPaymentAt\)/);
});

test('customers see the refund terms before paying and the exact figure before confirming', () => {
    assert.match(appSource, /\*\*Refund terms for this plan:\*\*/, 'Stripe checkout text');
    assert.match(appSource, /deductsUsage: user\.initialRefundDeductsUsage === true/, 'session payload');
    assert.match(appSource, /quote: await sessionRefundQuote\(req, user\)/);
    const dash = page('assets/dashboard.js');
    assert.match(dash, /policy\.deductsUsage/);
    assert.match(dash, /so you would get back/);
    const register = page('register.html');
    assert.match(register, /7-day refund, minus credits used/);
    assert.match(register, /name: 'Monthly', amount: '\$79\.99', cadence: 'per month', fullRefund: true/);
    assert.match(page('index.html'), /full on Monthly, minus credits used on yearly plans/);
    assert.match(page('upgrade.html'), /Monthly is refunded in full; Annual, Pro and Desk are refunded minus the credits used/);
    assert.match(page('terms.html'), /On the Monthly plan the refund is the full payment\. On plans priced above Monthly/);
});
