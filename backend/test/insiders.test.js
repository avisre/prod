'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { aggregate } = require('../insiders');

const sale = (date, shares, price) => ({ code: 'S', side: 'sell', shares, price, value: shares * price, date });

test('a Form 4 price with a dropped decimal is read as one, and an unplaceable outlier adds no value', () => {
    // Lilly Endowment, 2025-11-17: 1031414 filed for $1,031.414
    const docs = [
        { owner: 'LILLY ENDOWMENT INC', relation: '10% owner', txns: [sale('2025-11-17', 103871, 1030.312), sale('2025-11-17', 55908, 1031414)] },
        { owner: 'LILLY ENDOWMENT INC', relation: '10% owner', txns: [sale('2025-11-20', 96516, 1050.208), sale('2025-11-21', 10, 9e9)] }
    ];
    const { buckets, recent } = aggregate(docs);
    const q = buckets.get('2025 Q4');
    assert.equal(q.sells, 4);
    const expected = 103871 * 1030.312 + 55908 * 1031.414 + 96516 * 1050.208;
    assert.ok(Math.abs(q.sellVal - expected) < 1, `${q.sellVal} vs ${expected}`);
    assert.equal(recent.find((r) => r.shares === 10).value, null);
    assert.ok(Math.abs(recent.find((r) => r.shares === 55908).value - 55908 * 1031.414) < 1);
});

test('ordinary prices pass through unchanged', () => {
    const { buckets } = aggregate([{ owner: 'X', relation: 'CEO', txns: [sale('2026-08-24', 36656, 278.9), { code: 'P', side: 'buy', shares: 100, price: 280, value: 28000, date: '2026-08-25' }] }]);
    const q = buckets.get('2026 Q3');
    assert.equal(q.sellVal, 36656 * 278.9);
    assert.equal(q.buyVal, 28000);
});
