'use strict';

// A market cap is price x shares, and the quote's share count goes stale
// (measured 2026-09-28: LLY 5% low, ESS 7% high). These tests pin the fix:
// SEC's cover-page count wins when it is consistent with the quote's scale, and
// is ignored when it clearly covers a single class of a multi-class filer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const QUOTES_FILE = path.join(__dirname, '..', '..', 'frontend', 'data', 'quotes.json');
const q = JSON.parse(fs.readFileSync(QUOTES_FILE, 'utf8'));
const implied = (sym) => q[sym].marketCap / q[sym].price;

// Point quote-store at a controlled share map before it is first required.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'secshares-'));
const sharesFile = path.join(dir, 'sec-shares.json');
const map = {
    shares: {
        AMD: { shares: Math.round(implied('AMD') * 1.05), asOf: '2026-08-01' },   // 5% off => applied
        EXEL: { shares: Math.round(implied('EXEL') * 2), asOf: '2026-08-01' }     // wildly off => ignored
    }
};
fs.writeFileSync(sharesFile, JSON.stringify(map));
process.env.SEC_SHARES_FILE = sharesFile;

const quoteStore = require('../quote-store');

test('SEC cover-page shares replace a stale market cap when the scale is consistent', async () => {
    const quote = await quoteStore.getQuote('AMD', { allowLive: false });
    assert.equal(quote.marketCapSource, 'sec-shares');
    assert.equal(quote.marketCap, Math.round(q.AMD.price * map.shares.AMD.shares));
    assert.notEqual(quote.marketCap, q.AMD.marketCap);
    assert.equal(quote.sharesOutstanding, map.shares.AMD.shares);
});

test('a count that disagrees wildly is treated as one class of a multi-class filer and ignored', async () => {
    const quote = await quoteStore.getQuote('EXEL', { allowLive: false });
    assert.equal(quote.marketCapSource, undefined);
    assert.equal(quote.marketCap, q.EXEL.marketCap);
});

test('a symbol with no SEC count keeps the quote market cap', async () => {
    const quote = await quoteStore.getQuote('HCI', { allowLive: false });
    assert.equal(quote.marketCapSource, undefined);
    assert.equal(quote.marketCap, q.HCI.marketCap);
    assert.ok(quote.marketCap > 0);
});

test('the real SEC share map resolves LLY and ESS and omits multi-class GOOGL', () => {
    const real = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'frontend', 'data', 'sec-shares.json'), 'utf8')).shares;
    assert.ok(real.LLY && real.LLY.shares > 0, 'LLY resolved');
    assert.ok(real.ESS && real.ESS.shares > 0, 'ESS resolved');
    assert.equal(real.GOOGL, undefined, 'multi-class GOOGL is not resolved');
});
