'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fundFetch = require('../fundamentals-fetch');

const FUND_DIR = path.join(__dirname, '..', '..', 'frontend', 'data', 'fundamentals');
const TEST_SYMBOL = 'ZZTEST9';
const TEST_FILE = path.join(FUND_DIR, `${TEST_SYMBOL}.json`);
const FRESH_SYMBOL = 'ZZTEST8';
const FRESH_FILE = path.join(FUND_DIR, `${FRESH_SYMBOL}.json`);

test('isStaleOnDemand never flags an S&P 500 symbol — CI already keeps it warm', () => {
    assert.equal(fundFetch.isStaleOnDemand('AAPL'), false);
});

test('isStaleOnDemand is false for a symbol with no cached file at all', () => {
    assert.equal(fundFetch.isStaleOnDemand('NOFILEFORTHISSYMBOL'), false);
});

test('isStaleOnDemand flags a cache file whose content carries no datable freshness', () => {
    fs.mkdirSync(FUND_DIR, { recursive: true });
    fs.writeFileSync(TEST_FILE, '{}');
    try {
        // A file with no dates is not evidence of freshness — rebuild it.
        // (This used to be "false", because the check read the file mtime.)
        assert.equal(fundFetch.isStaleOnDemand(TEST_SYMBOL), true);
    } finally {
        fs.rmSync(TEST_FILE, { force: true });
    }
});

test('isStaleOnDemand reads the data dates, not the file mtime', () => {
    fs.mkdirSync(FUND_DIR, { recursive: true });
    const oldData = JSON.stringify({
        overview: { Name: 'Test Co' },
        income: { annualReports: [{ fiscalDateEnding: '2025-01-31', totalRevenue: '1' }] },
        daily: { 'Time Series (Daily)': { '2025-01-31': { '4. close': '1' } } }
    });
    fs.writeFileSync(FRESH_FILE, oldData);
    // A freshly-written file (new mtime) whose content is old must still read stale.
    try {
        assert.equal(fundFetch.isStaleOnDemand(FRESH_SYMBOL), true);
    } finally {
        fs.rmSync(FRESH_FILE, { force: true });
    }
});
