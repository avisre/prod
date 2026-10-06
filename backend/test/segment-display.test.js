'use strict';
// The company page shows a segment breakdown only when a reader can use it:
// plain names, at least two rows, and rows that account for revenue.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const store = require('../sec-segment-observations');

const BUSINESS = 'us-gaap:StatementBusinessSegmentsAxis', PRODUCT = 'srt:ProductOrServiceAxis';
const group = (axis, periodEnd, values, totalRevenue = 100) => ({ axis, periodEnd, totalRevenue, entries: values.map((value, i) => ({ member: `x:Part${i}Member`, value })) });

test('a breakdown covering a sliver of revenue is not usable', () => {
    assert.equal(store.preferred([group(PRODUCT, '2025-12-31', [5, 3])]).usable, null);
    assert.equal(store.preferred([group(BUSINESS, '2025-12-31', [100])]).usable, null, 'one row says nothing');
    assert.equal(store.preferred([]).usable, null);
});

test('operating segments lead product lines in the same period when both account for revenue', () => {
    const segments = group(BUSINESS, '2025-12-31', [60, 40]), lines = group(PRODUCT, '2025-12-31', [50, 30, 20]);
    assert.equal(store.preferred([lines, segments]).usable, segments);
});

test('product lines are used when the segment axis holds a single member', () => {
    const lone = group(BUSINESS, '2025-12-31', [100]), lines = group(PRODUCT, '2025-12-31', [70, 30]);
    assert.equal(store.preferred([lone, lines]).usable, lines);
});

test('an older usable period is preferred to a newer unusable one', () => {
    const thin = group(PRODUCT, '2025-12-31', [8, 4]), older = group(BUSINESS, '2024-12-31', [55, 45]);
    assert.equal(store.preferred([thin, older]).usable, older);
});

test('filed subtotals are pruned before coverage is judged, and eliminations are tolerated', () => {
    const withSubtotal = group(PRODUCT, '2025-12-31', [70, 30, 40, 30]);
    const view = store.shown(withSubtotal);
    assert.ok(view.usable && view.coverage <= 1.02, 'a product table with its own subtotal still reads as 100%');
    assert.ok(store.shown(group(BUSINESS, '2025-12-31', [60, 45])).usable, 'segments before eliminations may exceed revenue slightly');
    assert.ok(!store.shown(group(BUSINESS, '2025-12-31', [90, 80])).usable);
    assert.ok(store.shown(group(BUSINESS, '2025-12-31', [70, 32, -2])).usable, 'a signed elimination is not a slice of revenue');
});

test('every issuer in the dataset shows plain names and a breakdown that accounts for revenue', { skip: !fs.existsSync(path.join(require('../sec-coverage').DATA_DIR, 'sec-financials')) }, () => {
    const result = require('../../scripts/audit-segment-display').audit();
    assert.deepEqual(result.failures.slice(0, 10), []);
    assert.ok(result.shown > 0);
});
