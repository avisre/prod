'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const t = require('../technicals');

const day = (i) => new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString().slice(0, 10);
const series = (closes, volume = () => 1000) => closes.map((close, i) => ({ date: day(i), close, volume: volume(i) }));

test('Wilder RSI matches a hand-worked example', () => {
    // 14 changes: seven +1, seven -1 -> avg gain 0.5, avg loss 0.5 -> RSI 50
    const closes = [10]; for (let i = 0; i < 14; i++) closes.push(closes[closes.length - 1] + (i % 2 ? -1 : 1));
    assert.equal(t.rsi(closes), 50);
    // one more +1: gain (0.5*13+1)/14 = 7.5/14, loss 6.5/14 -> RS 15/13 -> 100 - 100/(28/13) = 53.5714...
    closes.push(closes[closes.length - 1] + 1);
    assert.ok(Math.abs(t.rsi(closes) - (100 - 100 / (1 + 7.5 / 6.5))) < 1e-9);
    assert.equal(t.rsi([...Array(15).keys()]), 100, 'no losses is 100 by definition');
    assert.equal(t.rsi([1, 2, 3]), null, 'fewer than 15 closes has no RSI');
});

test('short series give null long-window indicators rather than partial ones', () => {
    const out = t.compute(series(Array.from({ length: 120 }, (_, i) => 100 + i)));
    assert.equal(out.sessions, 120);
    assert.ok(out.sma50 > 0);
    assert.equal(out.sma200, null);
    assert.equal(out.lastCross, null);
    assert.equal(out.trend, null);
    assert.equal(out.pctFrom52wHigh, null);
    assert.equal(t.compute([]), null);
});

test('a golden cross is dated on the first session the 50-day sits above the 200-day', () => {
    // 260 falling sessions then 60 rising ones: the fast average turns up first
    const closes = [...Array.from({ length: 260 }, (_, i) => 300 - i * 0.5), ...Array.from({ length: 60 }, (_, i) => 170 + i * 4)];
    const rows = series(closes), out = t.compute(rows);
    assert.equal(out.lastCross.type, 'golden');
    // independent check: brute-force the first index where sma50 > sma200 after being below
    const avg = (end, n) => closes.slice(end - n, end).reduce((s, v) => s + v, 0) / n;
    let first = null; for (let end = 201; end <= closes.length; end++) if (avg(end, 50) > avg(end, 200) && avg(end - 1, 50) <= avg(end - 1, 200)) first = end;
    assert.equal(out.lastCross.date, rows[first - 1].date);
    assert.equal(out.lastCross.sessionsAgo, closes.length - first);
    assert.equal(out.trend, 'uptrend');
    assert.ok(Math.abs(out.sma200 - avg(closes.length, 200)) < 1e-3);
});

test('volume ratio compares the latest session with the 20 before it; 52-week distance uses the highest close', () => {
    const closes = Array.from({ length: 260 }, (_, i) => (i === 100 ? 200 : 100));
    const out = t.compute(series(closes, (i) => (i === 259 ? 3000 : 1000)));
    assert.equal(out.volumeRatio20, 3);
    assert.equal(out.pctFrom52wHigh, -50);
    assert.equal(out.asOf, day(259));
});

test('Alpha-shaped daily series prefer the adjusted close', () => {
    const rows = t.fromAlphaDaily({ '2025-01-02': { '4. close': '10', '5. adjusted close': '9.5', '6. volume': '7' } });
    assert.deepEqual(rows, [{ date: '2025-01-02', close: 9.5, volume: 7 }]);
});

test('forSymbol shares one fetch, keeps the result six hours, and forgets failures', async () => {
    t.__reset();
    let calls = 0;
    const fetcher = async () => { calls++; return series(Array.from({ length: 30 }, (_, i) => 50 + i)); };
    const [a, b] = await Promise.all([t.forSymbol('ko', { fetcher }), t.forSymbol('KO', { fetcher })]);
    assert.equal(calls, 1); assert.equal(a, b); assert.equal(a.sessions, 30);
    await t.forSymbol('KO', { fetcher, now: Date.now() + 7 * 3600 * 1000 });
    assert.equal(calls, 2);
    await assert.rejects(t.forSymbol('BAD', { fetcher: async () => { throw new Error('down'); } }));
    assert.equal((await t.forSymbol('BAD', { fetcher })).sessions, 30);
});
