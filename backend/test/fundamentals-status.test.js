'use strict';

// The sensor that catches a delisted or renamed ticker. Without it a dead
// symbol is retried forever, keeps its last file, stays in the sitemap and
// shows a stale page (measured 2026-09-28: 15 S&P 1500 tickers returning
// "Quote not found").

const test = require('node:test');
const assert = require('node:assert/strict');

const status = require('../fundamentals-status');

test('classify separates a dead ticker from a transient outage', () => {
    assert.equal(status.classify(['Quote not found for symbol: NSA']), 'not-found');
    assert.equal(status.classify(['No data found, symbol may be delisted']), 'not-found');
    assert.equal(status.classify(['429 Too Many Requests']), 'transient');
    assert.equal(status.classify(['socket hang up']), 'transient');
    assert.equal(status.classify([]), 'empty');
});

test('a single bad day does not condemn a ticker', () => {
    const next = status.recordRun({ symbols: {} }, [{ symbol: 'NSA', ok: false, reasons: ['Quote not found for symbol: NSA'] }], '2026-09-28');
    assert.equal(next.symbols.NSA.consecutive, 1);
    assert.equal(next.symbols.NSA.unlistedSince, undefined);
});

test('a same-day retry does not count as a second failure', () => {
    const day1 = status.recordRun({ symbols: {} }, [{ symbol: 'NSA', ok: false, reasons: ['Quote not found'] }], '2026-09-28');
    const again = status.recordRun(day1, [{ symbol: 'NSA', ok: false, reasons: ['Quote not found'] }], '2026-09-28');
    assert.equal(again.symbols.NSA.consecutive, 1);
    assert.equal(again.symbols.NSA.unlistedSince, undefined);
});

test('two separate days of "not found" mark the ticker unlisted', () => {
    const day1 = status.recordRun({ symbols: {} }, [{ symbol: 'NSA', ok: false, reasons: ['Quote not found'] }], '2026-09-28');
    const day2 = status.recordRun(day1, [{ symbol: 'NSA', ok: false, reasons: ['Quote not found'] }], '2026-10-01');
    assert.equal(day2.symbols.NSA.consecutive, 2);
    assert.equal(day2.symbols.NSA.unlistedSince, '2026-10-01');
});

test('transient failures never mark a ticker unlisted, however many', () => {
    let manifest = { symbols: {} };
    for (const day of ['2026-09-01', '2026-09-08', '2026-09-15', '2026-09-22']) {
        manifest = status.recordRun(manifest, [{ symbol: 'PRA', ok: false, reasons: ['429 Too Many Requests'] }], day);
    }
    assert.equal(manifest.symbols.PRA.consecutive, 4);
    assert.equal(manifest.symbols.PRA.unlistedSince, undefined);
});

test('a successful run clears the entry, including an unlisted flag', () => {
    const day1 = status.recordRun({ symbols: {} }, [{ symbol: 'NSA', ok: false, reasons: ['Quote not found'] }], '2026-09-28');
    const day2 = status.recordRun(day1, [{ symbol: 'NSA', ok: false, reasons: ['Quote not found'] }], '2026-10-01');
    assert.equal(day2.symbols.NSA.unlistedSince, '2026-10-01');
    const back = status.recordRun(day2, [{ symbol: 'NSA', ok: true, reasons: [] }], '2026-11-01');
    assert.equal(back.symbols.NSA, undefined);
});

test('one run can carry successes and failures together', () => {
    const next = status.recordRun({ symbols: {} }, [
        { symbol: 'AMD', ok: true, reasons: [] },
        { symbol: 'NSA', ok: false, reasons: ['Quote not found'] }
    ], '2026-09-28');
    assert.equal(next.symbols.AMD, undefined);
    assert.equal(next.symbols.NSA.consecutive, 1);
});
