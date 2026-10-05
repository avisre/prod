'use strict';

// Prices are split out of the weekly fundamentals bundle. These tests pin the
// two behaviors that split exists for:
//   1. a page given a quote shows that price, labelled with its as-of date;
//   2. when Yahoo is unavailable, the fallback prefers the daily price snapshot
//      over the months-old close sitting in a mid/small-cap fundamentals file
//      (measured 2026-09-28: EXEL cached 53.13 vs live 58.16).
// Nothing here touches the network: allowLive === false reads the snapshot.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const quoteStore = require('../quote-store');
const seo = require('../seo-pages');
const extra = require('../seo-extra');
const stored = require('../stored-fundamentals');

const QUOTES_FILE = path.join(__dirname, '..', '..', 'frontend', 'data', 'quotes.json');

function snapshot() {
    return JSON.parse(fs.readFileSync(QUOTES_FILE, 'utf8'));
}

test('the daily snapshot exists and covers large, mid and small caps with a price and an as-of date', () => {
    const q = snapshot();
    for (const symbol of ['AMD', 'EXEL', 'HCI']) {
        const row = q[symbol];
        assert.ok(row, `${symbol} missing from quotes.json`);
        assert.ok(Number(row.price) > 0, `${symbol} price must be positive`);
        assert.match(String(row.asOf), /^\d{4}-\d{2}-\d{2}$/, `${symbol} needs an as-of date`);
    }
});

test('getQuote serves the snapshot without touching the network', async () => {
    const q = await quoteStore.getQuote('EXEL', { allowLive: false });
    assert.ok(q, 'EXEL quote');
    assert.equal(q.price, snapshot().EXEL.price);
    assert.equal(q.asOf, snapshot().EXEL.asOf);
    assert.equal(q.source, 'daily');
});

test('getQuote knows no symbol and still resolves null instead of throwing', async () => {
    assert.equal(await quoteStore.getQuote('ZZ-NOT-A-SYMBOL', { allowLive: false }), null);
    assert.equal(await quoteStore.getQuote('', { allowLive: false }), null);
});

test('dotted and hyphenated class shares resolve to the same row', async () => {
    const dotted = await quoteStore.getQuote('BRK.B', { allowLive: false });
    const hyphen = await quoteStore.getQuote('BRK-B', { allowLive: false });
    assert.ok(dotted && hyphen);
    assert.equal(dotted.price, hyphen.price);
});

test('only browser-shaped user-agents are treated as humans', () => {
    assert.equal(quoteStore.isLikelyCrawler('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36'), false);
    assert.equal(quoteStore.isLikelyCrawler('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), true);
    assert.equal(quoteStore.isLikelyCrawler('node-superagent/8.1.2'), true);
    assert.equal(quoteStore.isLikelyCrawler('curl/8.4.0'), true);
    assert.equal(quoteStore.isLikelyCrawler(''), true);
});

test('the stock page shows the supplied price with its as-of label', () => {
    const daily = seo.renderStockPage('EXEL', { quote: { price: 58.16, asOf: '2026-09-25', source: 'daily' } });
    assert.match(daily, /<div class="l">Price<\/div><div class="v">\$58\.16<\/div><div class="n">as of 2026-09-25 · last close<\/div>/);

    const live = seo.renderStockPage('EXEL', { quote: { price: 58.4, asOf: '2026-09-28', source: 'live' } });
    assert.match(live, /\$58\.40<\/div><div class="n">as of 2026-09-28 · dated quote<\/div>/);

    // Sync callers (scripts, older tests) still render, labelled as cached.
    assert.match(seo.renderStockPage('EXEL'), /cached/);
});

test('the price-history page says "last traded" when it has a quote', () => {
    const html = extra.renderPriceHistoryPage('EXEL', { quote: { price: 58.16, asOf: '2026-09-25', source: 'daily' } });
    assert.ok(html, 'EXEL price-history renders');
    assert.match(html, /last traded at <strong>\$58\.16<\/strong>/);
    assert.match(html, /latest quote/);
});

test('snapshot rows carry the price-derived fields the pages need', async () => {
    const q = await quoteStore.getQuote('EXEL', { allowLive: false });
    assert.ok(q.marketCap > 0, 'market cap');
    assert.ok(q.trailingPE > 0, 'trailing P/E');
    assert.ok(q.fiftyTwoWeekHigh > 0 && q.fiftyTwoWeekLow > 0, '52-week range');
});

test('the stock page prefers the live market cap, P/E and 52-week range over the stale overview', () => {
    const html = seo.renderStockPage('EXEL', {
        quote: {
            price: 58.16, marketCap: 14410983424, trailingPE: 18.29,
            fiftyTwoWeekHigh: 59.72, fiftyTwoWeekLow: 33.76, asOf: '2026-09-25', source: 'daily'
        }
    });
    assert.match(html, /<div class="l">Market Cap<\/div><div class="v">\$14\.41B<\/div>/);
    assert.match(html, /<div class="l">P\/E Ratio<\/div><div class="v">18\.29<\/div>/);
    assert.match(html, /<div class="l">52-Week High<\/div><div class="v">\$59\.72<\/div>/);
});

test('the Yahoo-down fallback prefers the daily snapshot over a stale fundamentals close', () => {
    // A fundamentals blob frozen in June, exactly the shape that shipped the
    // wrong price before this split. The snapshot must win.
    const frozen = {
        overview: { Name: 'Exelixis, Inc.' },
        daily: { 'Time Series (Daily)': { '2026-06-10': { '4. close': '53.13' } } }
    };
    const quote = stored.globalQuote('EXEL', frozen)['Global Quote'];
    assert.equal(Number(quote['05. price']), snapshot().EXEL.price);
    assert.equal(quote['07. latest trading day'], snapshot().EXEL.asOf);
    assert.notEqual(Number(quote['05. price']), 53.13);
});

test('the fallback still uses the fundamentals series when the snapshot has no row', () => {
    const frozen = {
        overview: { Name: 'No Snapshot Co' },
        daily: { 'Time Series (Daily)': { '2026-06-10': { '4. close': '10.00' }, '2026-06-11': { '4. close': '11.00' } } }
    };
    const quote = stored.globalQuote('ZZNOSNAP', frozen)['Global Quote'];
    assert.equal(Number(quote['05. price']), 11);
    assert.equal(quote['07. latest trading day'], '2026-06-11');
});
