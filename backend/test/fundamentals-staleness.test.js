'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fundFetch = require('../fundamentals-fetch');

const FUND_DIR = path.join(__dirname, '..', '..', 'frontend', 'data', 'fundamentals');
const TEST_SYMBOL = 'ZZTEST9';
const TEST_FILE = path.join(FUND_DIR, `${TEST_SYMBOL}.json`);

test('isStaleOnDemand never flags an S&P 500 symbol — CI already keeps it warm', () => {
    assert.equal(fundFetch.isStaleOnDemand('AAPL'), false);
});

test('isStaleOnDemand is false for a symbol with no cached file at all', () => {
    assert.equal(fundFetch.isStaleOnDemand('NOFILEFORTHISSYMBOL'), false);
});

test('isStaleOnDemand is false for a freshly-written non-index cache file', () => {
    fs.mkdirSync(FUND_DIR, { recursive: true });
    fs.writeFileSync(TEST_FILE, '{}');
    try {
        assert.equal(fundFetch.isStaleOnDemand(TEST_SYMBOL), false);
    } finally {
        fs.rmSync(TEST_FILE, { force: true });
    }
});

test('isStaleOnDemand is true once a non-index cache file is older than 90 days', () => {
    fs.mkdirSync(FUND_DIR, { recursive: true });
    fs.writeFileSync(TEST_FILE, '{}');
    try {
        const old = new Date(Date.now() - 91 * 24 * 60 * 60 * 1000);
        fs.utimesSync(TEST_FILE, old, old);
        assert.equal(fundFetch.isStaleOnDemand(TEST_SYMBOL), true);
    } finally {
        fs.rmSync(TEST_FILE, { force: true });
    }
});
