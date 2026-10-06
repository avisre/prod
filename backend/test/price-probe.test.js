'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const probe = require('../price-probe');

test('the probe counts priced, unpriced and failed batches without retrying or writing', async () => {
    let calls = 0;
    const quote = async (chunk) => {
        calls += 1;
        if (chunk.includes('BAD1')) throw Object.assign(new Error('Too Many Requests'), { code: 429 });
        return chunk.filter((s) => s !== 'NOPX').map((s) => ({ symbol: s, regularMarketPrice: 10, regularMarketTime: '2026-10-06T20:00:00Z', marketCap: s === 'NOCAP' ? null : 1e9 }));
    };
    const summary = await probe.run({ symbols: ['AAA', 'BRK-B', 'NOPX', 'NOCAP', 'BAD1', 'BAD2'], quote, batch: 2, delayMs: 0 });
    assert.equal(calls, 3);
    assert.equal(summary.symbols, 6);
    assert.equal(summary.priced, 3);
    assert.equal(summary.noPrice, 3);
    assert.equal(summary.noMarketCap, 1);
    assert.equal(summary.batchFailures, 1);
    assert.deepEqual(summary.errors, { 429: 1 });
    assert.equal(summary.newestTradingDate, '2026-10-06');
    assert.equal(summary.onNewestTradingDate, 3);
});

test('one run at a time, and the last summary is kept', async () => {
    let release; const gate = new Promise((resolve) => { release = resolve; });
    let calls = 0;
    const quote = async (chunk) => { calls += 1; await gate; return chunk.map((s) => ({ symbol: s, regularMarketPrice: 1, regularMarketTime: '2026-10-06T20:00:00Z', marketCap: 1 })); };
    assert.equal(probe.start({ symbols: ['AAA'], quote, delayMs: 0 }).running, true);
    assert.equal(probe.start({ symbols: ['AAA'], quote, delayMs: 0 }).running, true);
    release(); await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(calls, 1);
    assert.equal(probe.status().running, false);
    assert.equal(probe.status().last.priced, 1);
});
