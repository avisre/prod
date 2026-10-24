'use strict';
// Price-trend screen filters (RSI, 200-day average, golden cross, volume) read
// the daily snapshot in technicals-universe.js. Three of the ten customer Ask
// questions in 2026-09-24..10-24 asked for exactly these and got a refusal.
const test = require('node:test');
const assert = require('node:assert');

process.env.DISABLE_BACKGROUND_JOBS = '1';
const chat = require('../ai-chat');
const tu = require('../technicals-universe');

const SNAPSHOT = {
    asOf: '2026-10-23', builtAt: '2026-10-23T22:30:00Z', columns: tu.COLUMNS,
    rows: [
        //  symbol close rsi  sma50 sma200 cross     crossDate   vol  52w   trend
        ['AAPL', 110, 63, 105, 100, 'golden', '2026-10-09', 2.4, -1, 'uptrend'],
        ['MSFT', 120, 55, 118, 100, 'golden', '2026-06-01', 0.9, -3, 'uptrend'],
        ['KO', 90, 35, 95, 100, 'death', '2026-09-01', 1.1, -15, 'downtrend'],
        ['PEP', 101, 48, 99, 100, null, null, 3.0, -8, 'mixed']
    ]
};
const syms = ['AAPL', 'MSFT', 'KO', 'PEP'];
const screen = (args) => chat.screenRows({ symbols: syms, ...args });

test('without a snapshot a price-trend screen says so and names the fallback', () => {
    tu.__set(null);
    const r = screen({ min_rsi14: 50 });
    assert.equal(r.matched, 0);
    assert.match(r.error, /not available yet.*min_price_vs_10_month_avg_pct/);
    assert.equal(screen({}).error, undefined, 'a screen with no price-trend condition is unaffected');
});

test('each filter applies on its own and together, and the result carries the snapshot date', () => {
    tu.__set(SNAPSHOT);
    const set = (r) => r.rows.map((x) => x.symbol).sort();
    assert.deepEqual(set(screen({ min_rsi14: 50 })), ['AAPL', 'MSFT']);
    assert.deepEqual(set(screen({ max_rsi14: 40 })), ['KO']);
    assert.deepEqual(set(screen({ sma200_position: 'above' })), ['AAPL', 'MSFT', 'PEP']);
    assert.deepEqual(set(screen({ sma200_position: 'below' })), ['KO']);
    assert.deepEqual(set(screen({ golden_cross_within_days: 30 })), ['AAPL'], 'MSFT crossed 144 days ago, KO last crossed down');
    assert.deepEqual(set(screen({ min_volume_ratio_20: 2 })), ['AAPL', 'PEP']);
    const both = screen({ min_rsi14: 50, golden_cross_within_days: 30 });
    assert.deepEqual(set(both), ['AAPL']);
    assert.equal(both.technicalsAsOf, '2026-10-23');
    assert.equal(screen({ min_rsi14: 50, sort_by: 'rsi14' }).rows[0].symbol, 'AAPL');
    // The price shown beside the indicators is the close they were computed on.
    assert.equal(screen({ min_rsi14: 50 }).rows.find((x) => x.symbol === 'AAPL').price, 110);
    tu.__set(null);
});

test('screen rows are copies: the cached index never gains price-trend fields', () => {
    tu.__set(SNAPSHOT);
    screen({ min_rsi14: 1 });
    const plain = chat.screenRows({ symbols: ['AAPL'] }).rows[0];
    assert.equal('rsi14' in plain, false);
    tu.__set(null);
});

test('the Ask tool adds the price-trend columns, their date and a not-a-signal note', async () => {
    tu.__set(SNAPSHOT);
    const out = await chat.runTool('screen_universe', { symbols: syms, sma200_position: 'above' }, {});
    const [header, ...lines] = out.table.split('\n');
    assert.match(header, /\|RSI14\|vs200dAvg%\|goldenCrossDaysAgo\|volumeVs20d\|from52wHigh%\|trend$/);
    assert.equal(lines.length, 3);
    assert.match(out.priceTrend, /as of 2026-10-23.*never present them as a buy, sell or timing signal/);
    assert.ok(out.claimable.percentages.includes(10), 'AAPL is 10% above its 200-day average');
    const plain = await chat.runTool('screen_universe', { symbols: syms }, {});
    assert.equal(plain.priceTrend, undefined);
    assert.doesNotMatch(plain.table.split('\n')[0], /RSI14/);
    tu.__set(null);
});

test('the screener page and adopted AI screens pass the new criteria through the whitelist', () => {
    const out = chat.screenArgsFromClient({ min_rsi14: '50', max_rsi14: 70, sma200_position: 'above', golden_cross_within_days: 30, min_volume_ratio_20: 2, bogus: 1 });
    assert.deepEqual(out, { min_rsi14: 50, max_rsi14: 70, sma200_position: 'above', golden_cross_within_days: 30, min_volume_ratio_20: 2 });
});
