'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const tu = require('../technicals-universe');

// 260 rising sessions ending on `last`, so every indicator has data.
function series(last, { start = 100, step = 0.5 } = {}) {
    const end = Date.parse(last), rows = [];
    for (let i = 259; i >= 0; i--) rows.push({ date: new Date(end - i * 86400000).toISOString().slice(0, 10), close: start + (259 - i) * step, volume: 1000 });
    return rows;
}

test('build keeps the majority session, drops stale rows and counts failures', async () => {
    const fetcher = async (s) => {
        if (s === 'GONE') throw new Error('not found');
        if (s === 'NONE') return [];
        return series(s === 'HALT' ? '2026-09-30' : '2026-10-23');
    };
    const doc = await tu.build({ symbols: ['MSFT', 'AAPL', 'HALT', 'GONE', 'NONE'], fetcher, gapMs: 0 });
    assert.equal(doc.asOf, '2026-10-23');
    assert.deepEqual(doc.rows.map((r) => r[0]), ['AAPL', 'MSFT']);
    assert.equal(doc.stale, 1);
    assert.equal(doc.failed, 2);
    assert.equal(doc.rows[0].length, tu.COLUMNS.length);
});

test('the index derives distance from the 200-day average and golden-cross age', () => {
    tu.__set({ asOf: '2026-10-23', builtAt: '2026-10-23T22:30:00Z', columns: tu.COLUMNS, rows: [
        ['AAA', 110, 60, 105, 100, 'golden', '2026-10-13', 1.5, -2, 'uptrend'],
        ['BBB', 90, 40, 95, 100, 'death', '2026-10-01', 0.8, -20, 'downtrend']
    ] });
    assert.equal(tu.get('aaa').pctVsSma200, 10);
    assert.equal(tu.get('AAA').goldenCrossDaysAgo, 10);
    assert.equal(tu.get('BBB').goldenCrossDaysAgo, null, 'a death cross is not a golden one');
    assert.equal(tu.get('ZZZ'), null);
    tu.__set(null);
});

test('a run Yahoo mostly refused does not replace the stored snapshot', async () => {
    assert.equal(await tu.save({ rows: [['A']], failed: 3, symbols: 5 }), false);
    assert.equal(await tu.save({ rows: [], failed: 0, symbols: 5 }), false);
});

test('rebuilds once per weekday after the close, and at once when nothing is stored', () => {
    const snap = { builtAt: new Date('2026-10-22T22:10:00Z') };
    assert.equal(tu.due(new Date('2026-10-23T15:00:00Z'), snap), false, 'before the close');
    assert.equal(tu.due(new Date('2026-10-23T22:05:00Z'), snap), true, 'Friday after the close');
    assert.equal(tu.due(new Date('2026-10-23T23:05:00Z'), { builtAt: new Date('2026-10-23T22:40:00Z') }), false, 'already built today');
    assert.equal(tu.due(new Date('2026-10-24T22:05:00Z'), snap), false, 'Saturday');
    assert.equal(tu.due(new Date('2026-10-24T03:00:00Z'), null), true);
});
