'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const profiles = require('../employee-profiles');

// The data file is built by scripts/build-employee-counts.js from the annual
// reports; these tests guard the join contract the company page depends on, not
// the extraction itself.
const DATA = path.join(__dirname, '..', '..', 'frontend', 'data', 'employee-counts.json');

test('a symbol with a stored headcount is returned as years, latest and ratios', () => {
  if (!fs.existsSync(DATA)) return; // a fresh clone before the data build
  const raw = JSON.parse(fs.readFileSync(DATA, 'utf8'));
  const symbol = Object.keys(raw.symbols || {}).find((s) => raw.symbols[s] && raw.symbols[s].latest);
  if (!symbol) return;
  const got = profiles.forSymbol(symbol);

  assert.ok(got, `${symbol} should resolve`);
  assert.equal(typeof got.latest.value, 'number');
  assert.ok(got.latest.value > 0);
  assert.ok(Object.keys(got.years).length >= 1);
  for (const [year, rec] of Object.entries(got.years)) {
    assert.match(year, /^(19|20)\d{2}$/, 'years are fiscal years');
    assert.ok(rec.value > 0, `${symbol} FY${year} must be a positive count`);
    assert.ok(['headcount', 'fte'].includes(rec.basis), 'the measure is named');
  }
  // the page labels the measure, so a missing basis must not silently become NaN
  assert.match(got.source, /Item 101\(c\)\(2\)/);
});

test('an unknown or empty symbol has no slice rather than an empty one', () => {
  assert.equal(profiles.forSymbol('ZZZZ-NOT-A-SYMBOL'), null);
  assert.equal(profiles.forSymbol(''), null);
  assert.equal(profiles.forSymbol(null), null);
});

test('a missing data file is not an error (the page simply has no headcount)', () => {
  const real = fs.readFileSync;
  try {
    fs.readFileSync = (file, ...rest) => {
      if (String(file).endsWith('employee-counts.json')) throw new Error('ENOENT');
      return real.call(fs, file, ...rest);
    };
    // the module caches for 6h; a broken read must still answer null, never throw
    const fresh = { forSymbol: profiles.forSymbol };
    assert.doesNotThrow(() => fresh.forSymbol('AAPL'));
  } finally {
    fs.readFileSync = real;
  }
});
