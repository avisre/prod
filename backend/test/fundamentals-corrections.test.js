'use strict';

// SEC-verified overrides for provider line items that are wrong. The one entry
// today: OLN FY2025 net income, which Yahoo reports as -$42.8M while the 10-K
// says $(101.1)M and Yahoo's own diluted EPS (-0.88) agrees with the filing.

const test = require('node:test');
const assert = require('node:assert/strict');

const corrections = require('../fundamentals-corrections');

test('OLN FY2025 net income is corrected to the filed figure', () => {
    const payload = { income: { annualReports: [{ fiscalDateEnding: '2025-12-31', netIncome: -42800000, dilutedEPS: -0.88 }] } };
    corrections.apply('OLN', payload);
    assert.equal(payload.income.annualReports[0].netIncome, -101100000);
    assert.equal(payload.income.annualReports[0].dilutedEPS, -0.88);
});

test('a different fiscal year is left alone', () => {
    const payload = { income: { annualReports: [{ fiscalDateEnding: '2024-12-31', netIncome: 108600000 }] } };
    corrections.apply('OLN', payload);
    assert.equal(payload.income.annualReports[0].netIncome, 108600000);
});

test('an unknown symbol is untouched', () => {
    const payload = { income: { annualReports: [{ fiscalDateEnding: '2025-12-31', netIncome: 123 }] } };
    corrections.apply('ZZZZ', payload);
    assert.equal(payload.income.annualReports[0].netIncome, 123);
});

test('a payload without the section or missing entirely does not throw', () => {
    assert.doesNotThrow(() => corrections.apply('OLN', {}));
    assert.doesNotThrow(() => corrections.apply('OLN', null));
    assert.doesNotThrow(() => corrections.apply('', {}));
});
