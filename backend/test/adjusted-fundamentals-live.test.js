'use strict';
// The fundamentals routes split-normalize the reader's payload in place of
// rebuilding it from the overnight snapshot. On 11-05 the routes swapped the
// evidence payload for adjusted(symbol), which carries the snapshot quote
// (up to a day old, cached 6h more) and drops a quarter extracted at runtime,
// so the company page showed yesterday's price and a P/E built from it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const splitPath = require.resolve('../split-adjust');
require.cache[splitPath] = {
    id: splitPath, filename: splitPath, loaded: true,
    exports: {
        // stand-in for a 2:1 split: shares double, EPS halves
        async adjustPayloadForSymbol(_symbol, payload) {
            for (const row of payload.income?.annualReports || []) row.dilutedEPS = row.dilutedEPS / 2;
            for (const row of payload.balance?.annualReports || []) row.commonStockSharesOutstanding *= 2;
            return { changed: true };
        }
    }
};
const cachePath = require.resolve('../fundamentals-cache');
require.cache[cachePath] = {
    id: cachePath, filename: cachePath, loaded: true,
    exports: { loadFundamentals: (symbol) => ({ symbol, income: { annualReports: [{ fiscalDateEnding: '2025-12-31', dilutedEPS: 8 }] } }) }
};
const { adjusted, adjustClone, MAX_ENTRIES, _cacheSize } = require('../adjusted-fundamentals');

test('adjustClone keeps the live quote and the runtime quarter, and applies the split', async () => {
    const live = {
        marketData: { price: 251.37, trailingPE: 31.2, source: 'live' },
        income: {
            annualReports: [{ fiscalDateEnding: '2025-12-31', dilutedEPS: 8 }],
            quarterlyReports: [{ fiscalDateEnding: '2026-09-30', netIncome: 1000 }]
        },
        balance: { annualReports: [{ fiscalDateEnding: '2025-12-31', commonStockSharesOutstanding: 100 }] }
    };
    const out = await adjustClone('TEST', live);
    assert.equal(out.marketData.price, 251.37);
    assert.equal(out.marketData.source, 'live');
    assert.equal(out.income.quarterlyReports[0].fiscalDateEnding, '2026-09-30');
    assert.equal(out.income.annualReports[0].dilutedEPS, 4);
    assert.equal(out.balance.annualReports[0].commonStockSharesOutstanding, 200);
    // the reader's rows are reused between requests: never adjusted twice
    assert.equal(live.income.annualReports[0].dilutedEPS, 8);
    assert.equal(live.balance.annualReports[0].commonStockSharesOutstanding, 100);
});

test('the fundamentals routes normalize the reader payload, not the snapshot', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    for (const route of ["app.get('/api/alpha/fundamentals/:symbol'", "app.get('/api/demo/alpha/fundamentals/:symbol'"]) {
        const at = src.indexOf(route);
        assert.ok(at > 0, route + ' exists');
        const body = src.slice(at, at + 8000);
        assert.match(body, /adjustClone\(symbol, payload\)/, route);
        assert.doesNotMatch(body.slice(0, body.indexOf('Headcount per fiscal year')), /\.adjusted\(symbol\)/, route);
    }
});

// 11-05 16:04 and 11-06 01:51 UTC: production ran out of heap. Each cached payload is ~3.2 MB and the
// cap was 4000, so crawlers walking /stocks/:symbol filled the ~250 MB heap within hours.
test('adjusted() keeps only a few recently used payloads however many symbols are asked for', async () => {
    assert.ok(MAX_ENTRIES <= 16, 'each entry is a few MB of heap');
    for (let i = 0; i < 500; i++) await adjusted('SYM' + i);
    assert.equal(_cacheSize(), MAX_ENTRIES);
    // a symbol used again stays while newer ones arrive (least recently used goes first)
    const keep = await adjusted('SYM499');
    for (let i = 0; i < MAX_ENTRIES - 1; i++) await adjusted('NEW' + i);
    assert.equal(await adjusted('SYM499'), keep);
});
