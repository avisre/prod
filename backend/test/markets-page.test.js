'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class FakeElement {
    constructor(id = '') {
        this.id = id;
        this.value = '';
        this.hidden = false;
        this.textContent = '';
        this.dataset = {};
        this.attributes = {};
        this.handlers = {};
        this.children = {};
        this.open = false;
        this.focused = false;
        this.classList = { toggle: (name, enabled) => { this.attributes[`class:${name}`] = enabled; } };
        this.innerHTML = '';
    }
    set innerHTML(value) {
        this._html = String(value);
        if (this.id === 'topics-row' || this.id === 'assets-row') {
            this.chipButtons = [...this._html.matchAll(/<button[^>]*data-k="([^"]+)"[^>]*aria-pressed="([^"]+)"[^>]*>([^<]+)<\/button>/g)].map((m) => {
                const button = new FakeElement(); button.dataset.k = m[1]; button.textContent = m[3]; button.attributes['aria-pressed'] = m[2]; return button;
            });
        }
        if (this.id === 'watch-list') {
            this.watchButtons = [...this._html.matchAll(/<button[^>]*data-symbol="([^"]+)"[^>]*aria-pressed="([^"]+)"/g)].map((m) => {
                const button = new FakeElement(); button.dataset.symbol = m[1]; button.attributes['aria-pressed'] = m[2]; return button;
            });
        }
    }
    get innerHTML() { return this._html || ''; }
    addEventListener(type, callback) { (this.handlers[type] ||= []).push(callback); }
    focus() { this.focused = true; }
    fire(type, event = {}) { return Promise.all((this.handlers[type] || []).map((callback) => callback({ preventDefault() {}, ...event }))); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    querySelectorAll(selector) {
        if (selector === '.chip') {
            return this.chipButtons || [];
        }
        if (selector === '.watch-row') return this.watchButtons || [];
        if (selector === 'a') return [...this.innerHTML.matchAll(/<a href="#" data-sym="([^"]+)"/g)].map((m) => {
            const anchor = new FakeElement(); anchor.dataset.sym = m[1]; return anchor;
        });
        return [];
    }
    querySelector(selector) {
        return this.children[selector] ||= new FakeElement(`${this.id}:${selector}`);
    }
}

function makePage({ loggedIn = true, deferTrendingQuotes = false } = {}) {
    const elements = new Map();
    const element = (id) => { if (!elements.has(id)) elements.set(id, new FakeElement(id)); return elements.get(id); };
    const pendingNews = [];
    const pendingQuotes = [];
    const requestedQuoteSymbols = [];
    const searchAssets = async (query) => query.toLowerCase() === 'microsoft'
        ? [{ symbol: 'MSFT', name: 'Microsoft Corporation' }]
        : query.toUpperCase() === 'AAPL' ? [{ symbol: 'AAPL', name: 'Apple Inc.' }] : [];
    const V2 = {
        API: '/api', token: () => loggedIn ? 'cookie' : '', esc: (value) => String(value ?? ''),
        fixed: (value, digits = 2) => Number(value).toFixed(digits), sparkline: () => '<svg class="spark"></svg>',
        nav() {}, footer() {}, searchAssets
    };
    const fetch = (url) => {
        if (url.includes('/alpha/news')) return new Promise((resolve) => pendingNews.push({ url, resolve }));
        if (url.includes('/market/strip')) {
            const query = new URLSearchParams(String(url).split('?')[1] || '');
            const symbols = (query.get('symbols') || '').split(',').filter(Boolean);
            requestedQuoteSymbols.push(symbols);
            if (symbols.length <= 8) {
                if (deferTrendingQuotes) return new Promise((resolve) => pendingQuotes.push({ symbols, resolve }));
                return Promise.resolve({ ok: true, json: async () => ({ quotes: Object.fromEntries(symbols.map((symbol) => [symbol, {
                    value: 100, pct: 1, date: '2026-09-28', closes: [95, 97, 99, 100]
                }])) }) });
            }
            return Promise.resolve({ ok: true, json: async () => ({ quotes: {
                SPY: { value: 100, pct: 1, date: '2026-09-28', closes: [95, 97, 100] },
                QQQ: { value: 120, pct: -0.5, date: '2026-09-28', closes: [122, 121, 120] }
            } }) });
        }
        if (url.includes('/alpha/movers')) return Promise.resolve({ ok: true, json: async () => ({ top_gainers: [], top_losers: [{ ticker: 'LOSE', price: '4.5', change_percentage: '-2%' }], most_actively_traded: [{ ticker: 'ACT', price: '10', change_percentage: '1%' }] }) });
        return Promise.resolve({ ok: true, json: async () => [] });
    };
    const doc = { getElementById: element, cookie: 'sp_logged_in=1' };
    const box = { window: { V2, location: { origin: 'https://example.test' } }, document: doc, localStorage: { getItem: () => null }, URLSearchParams, fetch, console };
    let source = fs.readFileSync(require.resolve('../../frontend-v2/assets/news.js'), 'utf8');
    source = source.replace('    loadNews();\n})();', '    loadNews();\n})();');
    vm.runInNewContext(source, box);
    return { box, element, pendingNews, pendingQuotes, requestedQuoteSymbols };
}

const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const stories = (prefix, count) => Array.from({ length: count }, (_, i) => ({
    title: `${prefix} story ${i}`, url: `https://example.test/${prefix}/${i}`,
    time_published: '20260929T100000', source: 'Test', ticker_sentiment: []
}));
const respond = (pending, body, status = 200) => pending.resolve({ ok: status === 200, status, json: async () => body });
const respondQuotes = (pending, quotes, status = 200) => pending.resolve({ ok: status === 200, status, json: async () => ({ quotes }) });

test('Markets page keeps the latest filter response, shows every story and preserves partial movers', async () => {
    const page = makePage();
    await tick();
    assert.equal(page.pendingNews.length, 1);
    const initialStories = stories('Initial', 60);
    initialStories[0].ticker_sentiment = [{ ticker: 'NVDA', relevance_score: '0.8', ticker_sentiment_score: '0.2' }];
    respond(page.pendingNews.shift(), { feed: initialStories });
    await new Promise((resolve) => setImmediate(resolve));
    await tick();
    assert.match(page.element('topics-row').innerHTML, />All topics<\/button>/);
    assert.match(page.element('assets-row').innerHTML, />All assets<\/button>/);
    assert.equal(page.element('asset-filter-selected').textContent, 'All assets');
    assert.deepEqual(page.element('topics-row').querySelectorAll('.chip').map((button) => button.textContent), [
        'All topics', 'Top stories', 'Markets', 'Earnings', 'Tech', 'Macro', 'Monetary', 'IPO', 'M&A', 'Energy', 'Finance', 'Life sciences', 'Real estate', 'Retail'
    ]);
    assert.deepEqual(page.element('assets-row').querySelectorAll('.chip').map((button) => button.textContent), [
        'All assets', 'Stocks', 'Crypto', 'Forex', 'Bonds', 'Commodities', 'ETFs', 'Sectors'
    ]);
    assert.equal(page.element('news-result-meta').textContent, '60 stories · latest first');
    assert.match(page.element('tape').innerHTML, /S&P 500 ETF · SPY/);
    assert.match(page.element('tape').innerHTML, /Daily close · Sep 28, 2026/);
    assert.match(page.element('tape').innerHTML, /class="spark"/);
    assert.equal(page.element('tape').getAttribute('aria-busy'), 'false');
    assert.equal(page.element('news-stream-col').hidden, false);
    assert.equal(page.element('watch-symbol').textContent, 'SPY');
    assert.equal(page.element('watch-price').textContent, '$100.00');
    assert.match(page.element('watch-chart').innerHTML, /class="chart-line"/);
    assert.match(page.element('trending-list').innerHTML, /NVDA/);
    assert.match(page.element('trending-list').innerHTML, /class="spark"/);
    assert.doesNotMatch(page.element('trending-list').innerHTML, /Neutral|Positive|Negative|ticker-tone|tone-dot/);
    assert.ok(page.requestedQuoteSymbols.some((symbols) => symbols.includes('NVDA')));
    assert.doesNotMatch(page.element('trending-list').innerHTML, /mention/i);
    const watchButtons = page.element('watch-list').querySelectorAll('.watch-row');
    assert.equal(watchButtons.length, 2);
    await watchButtons[1].fire('click');
    assert.equal(page.element('watch-symbol').textContent, 'QQQ');
    assert.equal(page.element('watch-price').textContent, '$120.00');
    assert.equal((page.element('news-stream').innerHTML.match(/class="stream-item"/g) || []).length, 49);
    assert.match(page.element('movers-losers').innerHTML, /LOSE/);
    assert.match(page.element('movers-active').innerHTML, /ACT/);
    assert.match(page.element('movers-gainers').innerHTML, /No data right now/);
    assert.equal(page.element('movers-gainers').hidden, false);
    await page.element('movers-tab-losers').fire('click');
    assert.equal(page.element('movers-gainers').hidden, true);
    assert.equal(page.element('movers-losers').hidden, false);
    assert.equal(page.element('movers-tab-losers').getAttribute('aria-pressed'), 'true');

    const topics = page.element('topics-row').querySelectorAll('.chip');
    const earnings = topics.find((button) => button.dataset.k === 'earnings');
    const technology = topics.find((button) => button.dataset.k === 'technology');
    const startEarnings = earnings.fire('click');
    await tick();
    const older = page.pendingNews.shift();
    const startTechnology = technology.fire('click');
    await tick();
    const newer = page.pendingNews.shift();
    assert.equal(technology.getAttribute('aria-pressed'), 'true');
    respond(newer, { feed: stories('Technology', 1) });
    await Promise.all([startTechnology, tick()]);
    respond(older, { feed: stories('Earnings', 1) });
    await Promise.all([startEarnings, tick()]);
    assert.match(page.element('news-feature').innerHTML, /Technology story/);
    assert.doesNotMatch(page.element('news-feature').innerHTML, /Earnings story/);

    const stocks = page.element('assets-row').querySelectorAll('.chip').find((button) => button.dataset.k === 'stocks');
    page.element('asset-filter-menu').open = true;
    await stocks.fire('click');
    await tick();
    const stockStories = page.pendingNews.shift();
    assert.match(stockStories.url, /topics=technology/);
    assert.match(stockStories.url, /tickers=SPY%2CQQQ%2CDIA%2CIWM/);
    respond(stockStories, { feed: stories('Stock filter', 1) });
    await tick();
    assert.equal(page.element('news-result-meta').textContent, '1 story for Stocks · Tech · latest first');
    assert.equal(page.element('asset-filter-selected').textContent, 'Stocks');
    assert.equal(page.element('asset-filter-menu').open, false);
    assert.equal(page.element('asset-filter-summary').focused, true);
    assert.equal(page.element('news-clear-filters').hidden, false);
    await page.element('news-clear-filters').fire('click');
    await tick();
    const cleared = page.pendingNews.shift();
    assert.doesNotMatch(cleared.url, /topics=|tickers=/);
    respond(cleared, { feed: stories('All filters cleared', 1) });
    await tick();
    assert.equal(page.element('news-clear-filters').hidden, true);
    assert.equal(page.element('asset-filter-selected').textContent, 'All assets');

    const crypto = page.element('assets-row').querySelectorAll('.chip').find((button) => button.dataset.k === 'crypto');
    await crypto.fire('click');
    await tick();
    const cryptoOnly = page.pendingNews.shift();
    assert.match(cryptoOnly.url, /tickers=BTC%2CETH%2CCOIN%2CMARA%2CRIOT/);
    respond(cryptoOnly, { feed: stories('Crypto filter', 6) });
    await tick();
    const markets = page.element('topics-row').querySelectorAll('.chip').find((button) => button.dataset.k === 'financial_markets');
    await markets.fire('click');
    await tick();
    const cryptoMarkets = page.pendingNews.shift();
    assert.match(cryptoMarkets.url, /topics=financial_markets/);
    respond(cryptoMarkets, { feed: stories('Crypto markets', 6) });
    await tick();
    assert.equal(page.element('news-result-meta').textContent, '6 stories for Crypto · Markets · latest first');
    assert.equal(page.element('news-stream-col').hidden, true);

    const input = page.element('news-q');
    input.value = 'Microsoft';
    await input.fire('input');
    await page.element('news-go').fire('click');
    await tick();
    const searched = page.pendingNews.shift();
    assert.match(searched.url, /tickers=MSFT/);
    respond(searched, { feed: stories('Microsoft', 1) });
    await tick();
    assert.match(page.element('news-q-active').textContent, /MSFT/);

    input.value = 'AAPL';
    await input.fire('input');
    await input.fire('keydown', { key: 'Enter' });
    await tick();
    const entered = page.pendingNews.shift();
    assert.match(entered.url, /tickers=AAPL/);
    respond(entered, { feed: stories('Apple', 1) });
    await tick();
});

test('trending price charts ignore stale quote responses and omit sentiment labels', async () => {
    const page = makePage({ deferTrendingQuotes: true });
    await tick();
    const firstStory = stories('NVDA', 1)[0];
    firstStory.ticker_sentiment = [{ ticker: 'NVDA', relevance_score: '0.8', ticker_sentiment_score: '0' }];
    respond(page.pendingNews.shift(), { feed: [firstStory] });
    await tick();
    const oldQuotes = page.pendingQuotes.shift();
    assert.deepEqual(oldQuotes.symbols, ['NVDA']);

    const marketTopic = page.element('topics-row').querySelectorAll('.chip').find((button) => button.dataset.k === 'financial_markets');
    await marketTopic.fire('click');
    await tick();
    const latestStory = stories('AAPL', 1)[0];
    latestStory.ticker_sentiment = [{ ticker: 'AAPL', relevance_score: '0.9', ticker_sentiment_score: '0' }];
    respond(page.pendingNews.shift(), { feed: [latestStory] });
    await tick();
    const freshQuotes = page.pendingQuotes.shift();
    assert.deepEqual(freshQuotes.symbols, ['AAPL']);

    respondQuotes(freshQuotes, { AAPL: { closes: [170, 171, 169, 173] } });
    await tick();
    respondQuotes(oldQuotes, { NVDA: { closes: [120, 121, 122, 124] } });
    await tick();
    assert.match(page.element('trending-list').innerHTML, /AAPL/);
    assert.match(page.element('trending-list').innerHTML, /class="spark"/);
    assert.doesNotMatch(page.element('trending-list').innerHTML, /NVDA|Neutral|Positive|Negative/);
});

test('Top stories and Real estate chips select visibly and request their matching topics', async () => {
    const page = makePage();
    await tick();
    respond(page.pendingNews.shift(), { feed: stories('Initial', 1) });
    await tick();

    for (const [key, label] of [['top_stories', 'Top stories'], ['real_estate', 'Real estate']]) {
        const chip = page.element('topics-row').querySelectorAll('.chip').find((button) => button.dataset.k === key);
        const requestPromise = chip.fire('click');
        await tick();
        const request = page.pendingNews.shift();
        assert.match(request.url, new RegExp(`topics=${key}`));
        assert.equal(chip.getAttribute('aria-pressed'), 'true');
        assert.equal(page.element('news-result-meta').textContent, 'Loading headlines…');
        respond(request, { feed: stories(label, 2) });
        await Promise.all([requestPromise, tick()]);
        assert.equal(page.element('news-result-meta').textContent, `2 stories for ${label} · latest first`);
        assert.match(page.element('news-feature').innerHTML, new RegExp(`${label} story`));
    }
});

test('missing trending price history falls back to a dash instead of sentiment text', async () => {
    const page = makePage({ deferTrendingQuotes: true });
    await tick();
    const story = stories('SPCX', 1)[0];
    story.ticker_sentiment = [{ ticker: 'SPCX', relevance_score: '0.8', ticker_sentiment_score: '0' }];
    respond(page.pendingNews.shift(), { feed: [story] });
    await new Promise((resolve) => setImmediate(resolve));
    const quoteRequest = page.pendingQuotes.shift();
    respondQuotes(quoteRequest, {}, 502);
    await tick();
    assert.match(page.element('trending-list').innerHTML, /ticker-chart-unavailable/);
    assert.match(page.element('trending-list').innerHTML, />—<\/span>/);
    assert.doesNotMatch(page.element('trending-list').innerHTML, /Neutral|Positive|Negative|ticker-tone|tone-dot/);
});

test('failed news filter clears stale articles and retry reloads the feed', async () => {
    const page = makePage();
    await tick();
    respond(page.pendingNews.shift(), { feed: stories('Before failure', 1) });
    await tick();
    const topicButton = page.element('topics-row').querySelectorAll('.chip').find((button) => button.dataset.k === 'ipo');
    const request = topicButton.fire('click');
    await tick();
    assert.equal(page.element('news-feature').hidden, true);
    respond(page.pendingNews.shift(), { message: 'upstream failed' }, 502);
    await Promise.all([request, tick()]);
    assert.equal(page.element('news-error').hidden, false);
    const retry = page.element('news-retry').fire('click');
    await tick();
    assert.equal(page.pendingNews.length, 1);
    respond(page.pendingNews.shift(), { feed: stories('Recovered', 1) });
    await Promise.all([retry, tick()]);
    assert.equal(page.element('news-error').hidden, true);
    assert.match(page.element('news-feature').innerHTML, /Recovered story/);
});

test('unmatched company search clears old headlines and invalidates an older filter response', async () => {
    const page = makePage();
    await tick();
    respond(page.pendingNews.shift(), { feed: stories('Current', 1) });
    await tick();

    const topicButton = page.element('topics-row').querySelectorAll('.chip').find((button) => button.dataset.k === 'earnings');
    await topicButton.fire('click');
    await tick();
    const staleRequest = page.pendingNews.shift();

    const input = page.element('news-q');
    input.value = 'No matching company';
    await input.fire('input');
    await tick();
    await page.element('news-go').fire('click');
    await tick();
    assert.equal(page.element('news-feature').hidden, true);
    assert.equal(page.element('news-result-meta').textContent, 'No ticker or fund matched that search.');

    respond(staleRequest, { feed: stories('Stale response', 1) });
    await tick();
    assert.equal(page.element('news-feature').hidden, true);
    assert.equal(page.element('news-result-meta').textContent, 'No ticker or fund matched that search.');
});

test('signed-out and paid-gated visitors see clear copy and no locked controls', async () => {
    const anonymous = makePage({ loggedIn: false });
    await tick();
    assert.equal(anonymous.element('news-controls').hidden, true);
    assert.equal(anonymous.element('news-signedout').hidden, false);
    assert.match(anonymous.element('news-signedout').querySelector('h2').textContent, /paid plans/);

    const paidGated = makePage();
    await tick();
    const bootstrapRequest = paidGated.pendingNews.shift();
    const paidRequest = paidGated.element('topics-row').querySelectorAll('.chip').find((button) => button.dataset.k === 'ipo').fire('click');
    await tick();
    respond(paidGated.pendingNews.shift(), { message: 'subscription required' }, 402);
    await paidRequest;
    await tick();
    assert.equal(paidGated.element('news-controls').hidden, true);
    assert.equal(paidGated.element('news-signedout').hidden, false);
    assert.match(paidGated.element('news-signedout').querySelector('.signedout-actions').innerHTML, /\/pricing/);
    respond(bootstrapRequest, { feed: stories('Stale', 1) });
    await tick();
    assert.equal(paidGated.element('news-controls').hidden, true);
});

test('Markets page cache-busts the immutable news asset after changing its behavior', () => {
    const html = fs.readFileSync(path.join(__dirname, '../../frontend-v2/news.html'), 'utf8');
    assert.match(html, /assets\/news\.js\?v=20260930-markets-topic-queries1/);
    assert.match(html, /<h1 class="visually-hidden">Markets<\/h1>/);
    assert.doesNotMatch(html, /Market headlines, daily closing prices, and the companies behind each story\./);
    assert.match(html, /<details class="asset-filter-menu" id="asset-filter-menu">/);
    assert.match(html, /<summary id="asset-filter-summary">Asset class/);
    assert.match(html, /Filter headlines by topic/);
    assert.match(html, /Filter headlines by asset class/);
    assert.match(html, /daily closes, not intraday index quotes/);
    assert.match(html, /Market watch/);
    assert.match(html, /Market movers/);
    assert.match(html, /id="movers-tab-gainers"/);
});
