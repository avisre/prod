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
        if (this.id === 'news-q-results') {
            this.searchSuggestions = [...this._html.matchAll(/<a href="#" data-sym="([^"]+)"/g)].map((m) => {
                const anchor = new FakeElement(); anchor.dataset.sym = m[1]; return anchor;
            });
        }
    }
    get innerHTML() { return this._html || ''; }
    addEventListener(type, callback) { (this.handlers[type] ||= []).push(callback); }
    fire(type, event = {}) { return Promise.all((this.handlers[type] || []).map((callback) => callback({ preventDefault() {}, ...event }))); }
    setAttribute(name, value) { this.attributes[name] = String(value); }
    getAttribute(name) { return this.attributes[name] ?? null; }
    querySelectorAll(selector) {
        if (selector === '.chip') {
            return this.chipButtons || [];
        }
        if (selector === 'a') return this.searchSuggestions || [];
        return [];
    }
    querySelector(selector) {
        return this.children[selector] ||= new FakeElement(`${this.id}:${selector}`);
    }
}

function makePage({ loggedIn = true } = {}) {
    const elements = new Map();
    const element = (id) => { if (!elements.has(id)) elements.set(id, new FakeElement(id)); return elements.get(id); };
    const pendingNews = [];
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
        if (url.includes('/market/strip')) return Promise.resolve({ ok: true, json: async () => ({ quotes: { SPY: { value: 100, pct: 1, date: '2026-09-28', closes: [95, 97, 100] } } }) });
        if (url.includes('/alpha/movers')) return Promise.resolve({ ok: true, json: async () => ({ top_gainers: [], top_losers: [{ ticker: 'LOSE', price: '4.5', change_percentage: '-2%' }], most_actively_traded: [{ ticker: 'ACT', price: '10', change_percentage: '1%' }] }) });
        return Promise.resolve({ ok: true, json: async () => [] });
    };
    const doc = { getElementById: element, cookie: 'sp_logged_in=1' };
    const box = { window: { V2, location: { origin: 'https://example.test' } }, document: doc, localStorage: { getItem: () => null }, URLSearchParams, fetch, console };
    let source = fs.readFileSync(require.resolve('../../frontend-v2/assets/news.js'), 'utf8');
    source = source.replace('    loadNews();\n})();', '    loadNews();\n})();');
    vm.runInNewContext(source, box);
    return { box, element, pendingNews };
}

const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const stories = (prefix, count) => Array.from({ length: count }, (_, i) => ({
    title: `${prefix} story ${i}`, url: `https://example.test/${prefix}/${i}`,
    time_published: '20260929T100000', source: 'Test', ticker_sentiment: []
}));
const respond = (pending, body, status = 200) => pending.resolve({ ok: status === 200, status, json: async () => body });

test('Markets page keeps the latest filter response, shows every story and preserves partial movers', async () => {
    const page = makePage();
    await tick();
    assert.equal(page.pendingNews.length, 1);
    respond(page.pendingNews.shift(), { feed: stories('Initial', 60) });
    await tick();
    assert.match(page.element('topics-row').innerHTML, />All topics<\/button>/);
    assert.match(page.element('assets-row').innerHTML, />All assets<\/button>/);
    assert.equal(page.element('news-result-meta').textContent, '60 stories · latest first');
    assert.match(page.element('tape').innerHTML, /S&P 500 ETF · SPY/);
    assert.match(page.element('tape').innerHTML, /Daily close · Sep 28, 2026/);
    assert.match(page.element('tape').innerHTML, /class="spark"/);
    assert.equal(page.element('tape').getAttribute('aria-busy'), 'false');
    assert.equal((page.element('news-stream').innerHTML.match(/class="stream-item/g) || []).length, 60);
    assert.match(page.element('movers-losers').innerHTML, /LOSE/);
    assert.match(page.element('movers-active').innerHTML, /ACT/);
    assert.match(page.element('movers-gainers').innerHTML, /No data right now/);

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
    assert.match(page.element('news-stream').innerHTML, /Technology story/);
    assert.doesNotMatch(page.element('news-stream').innerHTML, /Earnings story/);

    const stocks = page.element('assets-row').querySelectorAll('.chip').find((button) => button.dataset.k === 'stocks');
    await stocks.fire('click');
    await tick();
    const stockStories = page.pendingNews.shift();
    assert.match(stockStories.url, /topics=technology/);
    assert.match(stockStories.url, /tickers=SPY%2CQQQ%2CDIA%2CIWM/);
    respond(stockStories, { feed: stories('Stock filter', 1) });
    await tick();
    assert.equal(page.element('news-result-meta').textContent, '1 story for Stocks · Tech · latest first');
    assert.equal(page.element('news-clear-filters').hidden, false);
    await page.element('news-clear-filters').fire('click');
    await tick();
    const cleared = page.pendingNews.shift();
    assert.doesNotMatch(cleared.url, /topics=|tickers=/);
    respond(cleared, { feed: stories('All filters cleared', 1) });
    await tick();
    assert.equal(page.element('news-clear-filters').hidden, true);

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

    input.value = 'Microsoft';
    await input.fire('input');
    const suggestion = page.element('news-q-results').querySelectorAll('a')[0];
    assert.equal(suggestion.dataset.sym, 'MSFT');
    await suggestion.fire('click');
    await tick();
    const clicked = page.pendingNews.shift();
    assert.match(clicked.url, /tickers=MSFT/);
    respond(clicked, { feed: stories('Microsoft suggestion', 1) });
    await tick();

    input.value = 'AAPL';
    await input.fire('input');
    await input.fire('keydown', { key: 'Enter' });
    await tick();
    const entered = page.pendingNews.shift();
    assert.match(entered.url, /tickers=AAPL/);
    respond(entered, { feed: stories('Apple', 1) });
    await tick();
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
    assert.match(page.element('news-stream').innerHTML, /Recovered story/);
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
    assert.match(html, /assets\/news\.js\?v=20260930-yahoo-feed1/);
    assert.match(html, /Filter headlines by topic/);
    assert.match(html, /Filter headlines by asset class/);
    assert.match(html, /daily closes, not intraday index quotes/);
    assert.match(html, /Latest News/);
    assert.match(html, /aria-label="Latest news"/);
});
