'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

let searchFeed = [];
let searchByQuery = {};
let searchCalls = [];
let rssIndex = [];
let tickerRss = [];
let rssRequests = [];
class MockYahooFinance {
    async search(query) {
        searchCalls.push(query);
        return { news: searchByQuery[query] || searchFeed };
    }
}
function rssXml(items) {
    return `<rss>${items.map((item) => `<item><title>${item.title}</title><link>${item.link}</link><description>${item.summary || ''}</description><pubDate>Tue, 29 Sep 2026 10:00:00 GMT</pubDate></item>`).join('')}</rss>`;
}
const axiosMock = {
    get: async (url) => {
        rssRequests.push(url);
        return { data: rssXml(url.includes('rssindex') ? rssIndex : tickerRss) };
    }
};
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
    if (request === 'yahoo-finance2') return { default: MockYahooFinance };
    if (request === 'axios') return axiosMock;
    return originalLoad.call(this, request, parent, isMain);
};
const yahooSource = require('../yahoo-source');
Module._load = originalLoad;

test('topic filter keeps matching earnings stories and removes unrelated stories', async () => {
    searchFeed = [
        { title: 'Acme beats quarterly earnings estimates', link: 'https://example.test/earnings', relatedTickers: ['ACME'], providerPublishTime: 1790685600 },
        { title: 'Acme announces a new product launch', link: 'https://example.test/product', relatedTickers: ['ACME'], providerPublishTime: 1790685500 }
    ];
    rssIndex = [];
    const result = await yahooSource.fetchNews({ topics: 'earnings', limit: 60 });
    assert.deepEqual(result.feed.map((item) => item.title), ['Acme beats quarterly earnings estimates']);
});

test('Top stories searches the market headline feed and keeps relevant stories', async () => {
    searchFeed = [{ title: 'New consumer gadget launches today', link: 'https://example.test/gadget', providerPublishTime: 1790685500 }];
    searchByQuery = {
        'stock market today': [
            { title: 'Stock Market Today: S&P 500 rises as yields ease', link: 'https://example.test/market-today', providerPublishTime: 1790685600 },
            { title: 'Unrelated gadget review', link: 'https://example.test/unrelated-gadget', providerPublishTime: 1790685550 }
        ],
        'market news': [{ title: 'Wall Street weighs new inflation data', link: 'https://example.test/inflation', providerPublishTime: 1790685400 }]
    };
    searchCalls = [];
    rssIndex = [];
    const result = await yahooSource.fetchNews({ topics: 'top_stories', limit: 60 });
    assert.deepEqual(result.feed.map((item) => item.title), [
        'Stock Market Today: S&P 500 rises as yields ease',
        'Wall Street weighs new inflation data'
    ]);
    assert.ok(searchCalls.includes('stock market today'));
});

test('Real estate searches a property-focused feed and matches common property terms', async () => {
    searchFeed = [{ title: 'A chipmaker unveils a new product', link: 'https://example.test/chips', providerPublishTime: 1790685000 }];
    searchByQuery = {
        'real estate market': [{ title: 'Real estate market activity picks up', link: 'https://example.test/property', providerPublishTime: 1790685600 }],
        'housing market': [{ title: 'Housing market cools as mortgage rates rise', link: 'https://example.test/housing', providerPublishTime: 1790685500 }],
        'REIT stocks': [{ title: 'REIT stocks gain after a strong quarter', link: 'https://example.test/reit', providerPublishTime: 1790685400 }]
    };
    searchCalls = [];
    rssIndex = [];
    const result = await yahooSource.fetchNews({ topics: 'real_estate', limit: 60 });
    assert.deepEqual(result.feed.map((item) => item.title), [
        'Real estate market activity picks up',
        'Housing market cools as mortgage rates rise',
        'REIT stocks gain after a strong quarter'
    ]);
    assert.ok(searchCalls.includes('real estate market'));
    assert.ok(searchCalls.includes('housing market'));
});

test('ticker filter excludes general RSS headlines and unrelated search results', async () => {
    searchFeed = [
        { title: 'Apple reports earnings', link: 'https://example.test/apple', relatedTickers: ['AAPL'], providerPublishTime: 1790685600 },
        { title: 'Unrelated oil market update', link: 'https://example.test/oil', relatedTickers: ['USO'], providerPublishTime: 1790685500 }
    ];
    rssIndex = [{ title: 'General market outlook', link: 'https://example.test/general' }];
    tickerRss = [{ title: 'Apple shares rise after results', link: 'https://example.test/apple-rss' }];
    rssRequests = [];
    const result = await yahooSource.fetchNews({ tickers: 'AAPL', limit: 60 });
    assert.deepEqual(result.feed.map((item) => item.title), [
        'Apple reports earnings', 'Apple shares rise after results'
    ]);
    assert.equal(rssRequests.some((url) => url.includes('rssindex')), false);
    assert.equal(result.feed[1].ticker_sentiment[0].ticker, 'AAPL');
});

test('unrecognized topic leaves the feed unchanged for API compatibility', async () => {
    searchFeed = [{ title: 'Apple reports earnings', link: 'https://example.test/apple', relatedTickers: ['AAPL'], providerPublishTime: 1790685600 }];
    rssIndex = [];
    const result = await yahooSource.fetchNews({ topics: 'future_topic', limit: 60 });
    assert.equal(result.feed.length, 1);
});

test('ticker matching uses normalized related symbols or whole ticker words', () => {
    assert.equal(yahooSource.newsMatchesTickers({ title: 'AAPL shares move higher' }, ['AAPL']), true);
    assert.equal(yahooSource.newsMatchesTickers({ title: 'AAPLX announces earnings' }, ['AAPL']), false);
    assert.equal(yahooSource.newsMatchesTickers({ relatedTickers: ['BRK.B'] }, ['BRK.B']), true);
});

test('topic matching normalizes punctuation but requires a whole keyword phrase', () => {
    assert.equal(yahooSource.newsMatchesTopic({ title: 'Company reports quarterly results' }, 'earnings'), true);
    assert.equal(yahooSource.newsMatchesTopic({ title: 'The earnings report is out' }, 'ipo'), false);
});
