'use strict';

// Yahoo sometimes emits a placeholder quote row for a session whose OHLC was
// never populated — close null, every price field shaped to ''. Measured in
// production 2026-09-24: EVERY symbol's daily series carried one for
// 2026-09-22, and because the market tape reads the two newest dates directly,
// that single row blanked the tape for every visitor, silently, while the
// pass-through demo route still "worked" — the empty row only breaks consumers
// that PARSE the series.
//
// The shaper now drops rows with no close. The tape also walks past holes of
// its own, because its fallback (the nightly store) can still contain blobs
// shaped before this fix.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { buildDailySeries, buildMonthlySeries } = require('../yahoo-source');

// The measured shape: a real session, then the placeholder, then a real one.
const chart = (withHole) => ({
    quotes: [
        { date: new Date('2026-09-23T20:00:00Z'), open: 81.47, high: 81.5, low: 80.22, close: 80.46990203857422, volume: 35703559 },
        withHole
            ? { date: new Date('2026-09-22T20:00:00Z'), open: null, high: null, low: null, close: null, volume: null }
            : { date: new Date('2026-09-21T20:00:00Z'), open: 80, high: 81, low: 79, close: 80.5, volume: 1000 },
        { date: new Date('2026-09-21T20:00:00Z'), open: 80, high: 81, low: 79, close: 80.5, volume: 1000 }
    ]
});

// What the tape does to the result — the exact arithmetic from the route.
function tapeLatestPrior(series) {
    const dates = Object.keys(series)
        .filter((d) => Number.isFinite(parseFloat((series[d] || {})['4. close'])))
        .sort((a, b) => (a < b ? 1 : -1));
    return [parseFloat(series[dates[0]]['4. close']), parseFloat(series[dates[1]]['4. close'])];
}

test('a placeholder row with no close is dropped, not shaped into empty strings', () => {
    const built = buildDailySeries('TLT', chart(true), 'compact')['Time Series (Daily)'];
    assert.equal(built['2026-09-22'], undefined, 'the placeholder session is not in the series at all');
    assert.ok(built['2026-09-23'] && built['2026-09-21'], 'real sessions survive');
    const [latest, prior] = tapeLatestPrior(built);
    assert.equal(latest, 80.46990203857422);
    assert.equal(prior, 80.5, 'the tape compares against the newest session that HAS a close');
});

test('without the placeholder the series is unchanged', () => {
    const built = buildDailySeries('TLT', chart(false), 'compact')['Time Series (Daily)'];
    // two rows share the 09-21 date, so the series keys them into one
    assert.equal(Object.keys(built).length, 2);
    const [latest, prior] = tapeLatestPrior(built);
    assert.ok(Number.isFinite(latest) && Number.isFinite(prior));
});

test('the monthly shaper drops the same placeholders', () => {
    const built = buildMonthlySeries('TLT', chart(true))['Monthly Adjusted Time Series'];
    assert.equal(built['2026-09-22'], undefined);
    assert.equal(Object.keys(built).length, 2);
});

test('a row with a close but a missing open is kept — only close-less rows are dropped', () => {
    const built = buildDailySeries('X', { quotes: [
        { date: new Date('2026-09-23T20:00:00Z'), open: null, high: null, low: null, close: 10, volume: null }
    ] }, 'compact')['Time Series (Daily)'];
    assert.ok(built['2026-09-23']);
    assert.equal(built['2026-09-23']['4. close'], '10');
});

test('the tape walks past holes itself, so a stale nightly-store blob cannot blank it', () => {
    // The strip builder must keep filtering historical placeholder rows even
    // when fetchAlphaCached returns a nightly-store fallback.
    const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const strip = source.slice(source.indexOf("app.get('/api/market/strip'"));
    assert.match(strip, /buildMarketStripQuote\(series\)/);
});

// KRWUSD=X as Yahoo returned it on 2026-10-17: the pair trades on London time, so the April and
// October bars are stamped 23:00 UTC on the last day of the month before.
test('a monthly bar is dated by its exchange day, so London summer months keep their own month', () => {
    const bar = (iso, close) => ({ date: new Date(iso), open: close, high: close, low: close, close, volume: 0 });
    const quotes = [bar('2025-03-01T00:00:00Z', 1), bar('2025-03-31T23:00:00Z', 2), bar('2025-09-30T23:00:00Z', 3), bar('2025-11-01T00:00:00Z', 4)];
    const london = buildMonthlySeries('KRWUSD=X', { meta: { exchangeTimezoneName: 'Europe/London' }, quotes })['Monthly Adjusted Time Series'];
    assert.deepEqual(Object.keys(london), ['2025-03-01', '2025-04-01', '2025-10-01', '2025-11-01']);
    assert.equal(Number(london['2025-04-01']['4. close']), 2);
    // a US listing's bar at 00:00 New York time is the same day in UTC and is unchanged
    const ny = buildMonthlySeries('AAPL', { meta: { exchangeTimezoneName: 'America/New_York' }, quotes: [bar('2025-04-01T04:00:00Z', 5)] })['Monthly Adjusted Time Series'];
    assert.deepEqual(Object.keys(ny), ['2025-04-01']);
    // no zone, or one Intl does not know, keeps the UTC day
    assert.deepEqual(Object.keys(buildMonthlySeries('X', { meta: { exchangeTimezoneName: 'Not/AZone' }, quotes: [bar('2025-03-31T23:00:00Z', 2)] })['Monthly Adjusted Time Series']), ['2025-03-31']);
});

test('a daily FX bar is dated by its London session, so 1 April is not read as 31 March', () => {
    const quotes = [{ date: new Date('2025-03-31T00:00:00Z'), open: 1, high: 1, low: 1, close: 1, volume: 0 }, { date: new Date('2025-03-31T23:00:00Z'), open: 2, high: 2, low: 2, close: 2, volume: 0 }];
    const series = buildDailySeries('KRWUSD=X', { meta: { exchangeTimezoneName: 'Europe/London' }, quotes }, 'full')['Time Series (Daily)'];
    assert.deepEqual(Object.keys(series).sort(), ['2025-03-31', '2025-04-01']);
    assert.equal(Number(series['2025-04-01']['4. close']), 2);
});
