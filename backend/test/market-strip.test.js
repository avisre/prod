'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMarketStripQuote } = require('../market-strip');

test('market strip exposes the actual trading date and skips placeholder closes', () => {
    const quote = buildMarketStripQuote({
        '2026-09-29': { '4. close': 'not available' },
        '2026-09-28': { '4. close': '101.23' },
        '2026-09-25': { '4. close': '100.00' }
    });
    assert.equal(quote.date, '2026-09-28');
    assert.equal(quote.value, 101.23);
    assert.equal(quote.change, 1.23);
    assert.equal(quote.pct, 1.23);
    assert.deepEqual(quote.closes, [100, 101.23]);
});

test('market strip omits a series without two valid closes', () => {
    assert.equal(buildMarketStripQuote({ '2026-09-28': { '4. close': '100' } }), null);
    assert.equal(buildMarketStripQuote({
        '2026-09-28': { '4. close': '100' },
        '2026-09-25': { '4. close': '0' }
    }), null);
});
