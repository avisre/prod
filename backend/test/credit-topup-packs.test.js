'use strict';

// Larger credit refills (owner decision 2026-10-08): $50 / $100 / $250 / $500
// beside the $14.99 base pack, all at 10 credits per dollar. These pin the three
// things that would cost money if they drifted: the server alone decides what a
// pack costs and grants, the webhook re-checks the paid total before granting,
// and the page offers exactly the packs the server sells.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const rechargeSource = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'recharge.html'), 'utf8');

function loadPacks() {
    const start = appSource.indexOf('const CREDIT_TOPUP_PACKS = Object.freeze({');
    const end = appSource.indexOf('// September launch rate');
    assert.ok(start > -1 && end > start, 'the pack table is where this test expects it');
    // eslint-disable-next-line no-new-func
    return new Function(`${appSource.slice(start, end)}; return { CREDIT_TOPUP_PACKS, creditTopupPack, creditTopupPackSettled };`)();
}

test('the packs are $50, $100, $250 and $500, each at 10 credits per dollar', () => {
    const { CREDIT_TOPUP_PACKS } = loadPacks();
    assert.deepEqual(Object.keys(CREDIT_TOPUP_PACKS), ['50', '100', '250', '500']);
    for (const [id, pack] of Object.entries(CREDIT_TOPUP_PACKS)) {
        assert.equal(pack.usd, Number(id));
        assert.equal(pack.credits, pack.usd * 10, `pack ${id} is sold at the same rate as every other`);
    }
});

test('only a listed pack id resolves, and never an inherited property', () => {
    const { creditTopupPack } = loadPacks();
    assert.deepEqual(creditTopupPack('100'), { usd: 100, credits: 1000 });
    assert.deepEqual(creditTopupPack(100), { usd: 100, credits: 1000 });
    for (const bad of ['', null, undefined, '75', '1000', '-50', '50.0', ' 50', '__proto__', 'constructor', 'toString', 'hasOwnProperty']) {
        assert.equal(creditTopupPack(bad), null, `${String(bad)} is not a pack`);
    }
});

test('a pack session settles only when the paid total, currency and credits all match the table', () => {
    const { creditTopupPackSettled } = loadPacks();
    const paid = (over = {}, meta = {}) => ({ amount_total: 10000, currency: 'usd', ...over, metadata: { pack: '100', credits: '1000', ...meta } });
    assert.equal(creditTopupPackSettled(paid()), true);
    assert.equal(creditTopupPackSettled(paid({ amount_total: 5000 })), false, 'paid for a smaller pack');
    assert.equal(creditTopupPackSettled(paid({ amount_total: 0 })), false, 'a fully discounted session grants nothing');
    assert.equal(creditTopupPackSettled(paid({ currency: 'inr' })), false, '10000 of another currency is not $100');
    assert.equal(creditTopupPackSettled(paid({}, { credits: '5000' })), false, 'credits inflated in the metadata');
    assert.equal(creditTopupPackSettled(paid({}, { pack: '999' })), false, 'unknown pack');
    assert.equal(creditTopupPackSettled({ amount_total: 1499, currency: 'usd', metadata: {} }), false, 'the base refill is not a pack');
});

test('checkout charges the table amount and the webhook refuses a mismatch before it grants', () => {
    const route = appSource.slice(appSource.indexOf("app.post('/api/credits/topup'"));
    const routeFn = route.slice(0, route.indexOf('\n});'));
    // The amount and the credit count both come from the table entry, never the request.
    assert.match(routeFn, /const pack = creditTopupPack\(packId\);\s*if \(!pack\) return res\.status\(400\)/);
    assert.match(routeFn, /price_data: \{ currency: 'usd', unit_amount: pack\.usd \* 100,/);
    assert.match(routeFn, /pack: packId,\s*credits: String\(pack\.credits\),/);
    assert.doesNotMatch(routeFn, /req\.body\.(amount|credits|price|usd)/, 'nothing but the pack id is read from the request');
    // No discount codes on a refill: a code would break the paid-total check.
    assert.doesNotMatch(routeFn, /allow_promotion_codes|discounts:/);

    const hook = appSource.slice(appSource.indexOf("payload.metadata?.checkoutType === 'credit_topup'"));
    const guardAt = hook.indexOf('if (payload.metadata?.pack && !creditTopupPackSettled(payload))');
    const grantAt = hook.indexOf('credits.grant(');
    assert.ok(guardAt > -1 && grantAt > guardAt, 'the mismatch guard runs before the grant');
    assert.match(hook.slice(guardAt, grantAt), /no credits granted\.`\);\s*\} else if \(payload\.payment_status === 'paid'\) \{/);
});

test('the recharge page offers exactly the packs the server sells, at the same numbers', () => {
    const { CREDIT_TOPUP_PACKS } = loadPacks();
    const buttons = [...rechargeSource.matchAll(/data-pack="([^"]*)" data-price="([^"]+)" data-credits="(\d+)"/g)]
        .map((m) => ({ id: m[1], price: Number(m[2]), credits: Number(m[3]) }));
    assert.equal(buttons.length, 5);
    // The first is the base refill: no pack id, the existing $14.99 / 150.
    assert.deepEqual(buttons[0], { id: '', price: 14.99, credits: 150 });
    assert.match(appSource, /CREDIT_TOPUP_PRICE = parseFloat\(process\.env\.CREDIT_TOPUP_PRICE \|\| '14\.99'\)/);
    assert.match(appSource, /CREDIT_TOPUP_CREDITS = parseInt\(process\.env\.CREDIT_TOPUP_CREDITS \|\| '150', 10\)/);
    const offered = Object.fromEntries(buttons.slice(1).map((b) => [b.id, { usd: b.price, credits: b.credits }]));
    assert.deepEqual(offered, JSON.parse(JSON.stringify(CREDIT_TOPUP_PACKS)));
    // The page sends the pack id and nothing else.
    assert.match(rechargeSource, /body: JSON\.stringify\(selectedPack \? \{ pack: selectedPack \} : \{\}\)/);
});
