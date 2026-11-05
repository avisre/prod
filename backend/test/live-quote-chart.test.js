'use strict';

// Live prices come from Yahoo's chart endpoint because the quote endpoint's
// crumb handshake is refused 429 from the production host (Render logs,
// 2026-11-05), which left every page on the overnight snapshot. These tests
// stub yahoo-finance2 so nothing touches the network.

const test = require('node:test');
const assert = require('node:assert/strict');

const yahooSource = require('../yahoo-source');
const quoteStore = require('../quote-store');

const yf = yahooSource._yf;
const realChart = yf.chart;
const realQuote = yf.quote;
const snapshot = (symbol) => quoteStore.getDailyQuote(symbol, { useLegacySecShares: false });

function chartMeta(symbol, price, extra = {}) {
    return {
        meta: {
            symbol, currency: 'USD', exchangeName: 'NMS', fullExchangeName: 'NasdaqGS', instrumentType: 'EQUITY',
            longName: `${symbol} Inc.`, shortName: symbol,
            regularMarketPrice: price, regularMarketTime: new Date('2026-11-05T21:00:00Z'),
            fulldayChange: -10, regularMarketChangePercent: -2.36,
            fiftyTwoWeekHigh: 658.52, fiftyTwoWeekLow: 188.22,
            currentTradingPeriod: { regular: { start: new Date('2026-11-05T14:30:00Z'), end: new Date('2026-11-05T21:00:00Z') } },
            ...extra
        }
    };
}

test.afterEach(() => {
    yf.chart = realChart;
    yf.quote = realQuote;
    yahooSource._crumbState.reset();
});

test('chart meta is shaped like a quote: previous close, market state and names', () => {
    const q = yahooSource.quoteFromChartMeta(chartMeta('AMD', 414).meta, Date.parse('2026-11-05T15:00:00Z'));
    assert.equal(q.regularMarketPrice, 414);
    assert.equal(q.regularMarketPreviousClose, 424);
    assert.equal(q.regularMarketChangePercent, -2.36);
    assert.equal(q.marketState, 'REGULAR');
    assert.equal(q.longName, 'AMD Inc.');
    assert.equal(q.quoteType, 'EQUITY');
    assert.equal(q.liveSource, 'chart');
    const after = yahooSource.quoteFromChartMeta(chartMeta('AMD', 414).meta, Date.parse('2026-11-05T22:00:00Z'));
    assert.equal(after.marketState, 'CLOSED');
    assert.equal(yahooSource.quoteFromChartMeta({ regularMarketPrice: null }), null);
});

test('a live price comes from the chart while quote() is refused, with ratios re-priced to it', async () => {
    let quoteCalls = 0;
    // a past session, so the label does not depend on when the test runs
    const pastSession = { currentTradingPeriod: { regular: { start: new Date('2026-11-04T14:30:00Z'), end: new Date('2026-11-04T21:00:00Z') } } };
    yf.chart = async (sym) => chartMeta(sym, 414, pastSession);
    yf.quote = async () => { quoteCalls += 1; throw new Error('Failed to get crumb, status 429 Too Many Requests'); };
    const snap = snapshot('AMD');
    assert.ok(snap && snap.price > 0 && snap.trailingPE > 0, 'AMD snapshot row needed');

    const q = await quoteStore.getQuote('AMD', { useLegacySecShares: false });
    assert.equal(q.source, 'live');
    assert.equal(q.price, 414);
    assert.equal(q.freshness, 'market_closed');
    assert.equal(quoteCalls, 0, 'the chart answered, so quote() is never asked');
    const r = 414 / snap.price;
    assert.ok(Math.abs(q.trailingPE - snap.trailingPE * r) < 1e-9);
    assert.ok(Math.abs(q.forwardPE - snap.forwardPE * r) < 1e-9);
    assert.equal(q.sharesOutstanding, snap.sharesOutstanding);
    assert.equal(q.marketCap, Math.round(414 * snap.sharesOutstanding));
    assert.equal(q.fiftyTwoWeekHigh, 658.52);
});

test('a crumb refusal switches quote() off process-wide, and a total failure is logged and labelled stale', async () => {
    let quoteCalls = 0;
    yf.chart = async () => { throw new Error('chart down'); };
    yf.quote = async () => { quoteCalls += 1; throw new Error('Failed to get crumb, status 429 Too Many Requests'); };
    const warnings = [];
    const realWarn = console.warn;
    console.warn = (line) => warnings.push(String(line));
    try {
        const first = await quoteStore.getQuote('AAPL', { useLegacySecShares: false });
        assert.equal(first.freshness, 'stale_fallback');
        assert.equal(first.price, snapshot('AAPL').price);
        assert.equal(quoteCalls, 1);
        assert.ok(yahooSource._crumbState.blockedUntil > Date.now(), 'breaker open');

        const second = await quoteStore.getQuote('NVDA', { useLegacySecShares: false });
        assert.equal(second.freshness, 'stale_fallback');
        assert.equal(quoteCalls, 1, 'no second crumb handshake while the breaker is open');
    } finally {
        console.warn = realWarn;
    }
    assert.ok(warnings.some((w) => /\[quote\] fallback AAPL reason=chart down/.test(w)), warnings.join('\n'));
    assert.ok(warnings.some((w) => /\[quote\] fallback NVDA/.test(w)));
});

test('concurrent callers for one symbol share a single Yahoo request', async () => {
    let chartCalls = 0;
    yf.chart = async (sym) => { chartCalls += 1; await new Promise((r) => setTimeout(r, 20)); return chartMeta(sym, 200); };
    const [a, b, c] = await Promise.all([yahooSource.liveQuote('MSFT'), yahooSource.liveQuote('MSFT'), yahooSource.fetchQuote('MSFT')]);
    assert.equal(chartCalls, 1);
    assert.equal(a.regularMarketPrice, 200);
    assert.equal(b, a);
    assert.equal(Number(c['Global Quote']['05. price']), 200);
});

test('a live request that outlasts the timeout still fills the cache for the next reader', async () => {
    yf.chart = async (sym) => { await new Promise((r) => setTimeout(r, 2700)); return chartMeta(sym, 99); };
    const first = await quoteStore.getQuote('KO', { useLegacySecShares: false });
    assert.equal(first.freshness, 'stale_fallback');
    await new Promise((r) => setTimeout(r, 400));
    const next = await quoteStore.getQuote('KO', { useLegacySecShares: false });
    assert.equal(next.source, 'live');
    assert.equal(next.price, 99);
});
