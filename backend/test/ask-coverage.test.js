'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const c = require('../ask-coverage');

const listed = new Set(['SPOT', 'LLY', 'VRTX', 'ABBV', 'NVO', 'PFE', 'MRK', 'AI', 'ON', 'BRK.B']);
const lookup = (s) => (listed.has(s) ? { symbol: s } : null);

test('named tickers skip finance shorthand and ticker-shaped English unless written with $', () => {
    assert.deepEqual(c.namedTickers('RSI and EPS for SPOT, LLY and BRK.B? Is AI ON track? Also $AI', lookup), ['SPOT', 'LLY', 'BRK.B', 'AI']);
    assert.deepEqual(c.namedTickers('spot lly vrtx', lookup), [], 'lower-case words are not read as tickers');
});

test('a run cut off after some of the named tickers reports the rest in question order', () => {
    const q = 'Dla SPOT, LLY, VRTX, ABBV, NVO, PFE, MRK odpowiedz na 10 pytań';
    const tools = [
        { tool: 'get_financials', args: { symbol: 'NVO' }, ok: true },
        { tool: 'compare_companies', args: { symbols: ['spot', 'LLY'] }, ok: true },
        { tool: 'get_financials', args: { symbol: 'VRTX' }, ok: false }
    ];
    assert.deepEqual(c.uncovered(q, tools, lookup), ['VRTX', 'ABBV', 'PFE', 'MRK']);
    assert.match(c.nextLine(['VRTX', 'ABBV']), /^> Next: Continue with VRTX, ABBV:/);
});

test('no Next line for short lists, full coverage, or a run that looked nothing up', () => {
    assert.deepEqual(c.uncovered('Compare SPOT and LLY', [{ args: { symbol: 'SPOT' }, ok: true }], lookup), []);
    const q = 'SPOT LLY VRTX';
    assert.deepEqual(c.uncovered(q, ['SPOT', 'LLY', 'VRTX'].map((symbol) => ({ args: { symbol }, ok: true })), lookup), []);
    assert.deepEqual(c.uncovered(q, [], lookup), []);
});
