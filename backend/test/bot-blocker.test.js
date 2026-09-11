'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const dns = require('dns').promises;
const botBlocker = require('../bot-blocker');

function fakeReq(overrides = {}) {
    return {
        path: '/stocks/AAPL',
        ip: '1.2.3.4',
        headers: {},
        ...overrides
    };
}

function fakeRes() {
    const res = {
        statusCode: null,
        body: null,
        contentType: null,
        status(code) { this.statusCode = code; return this; },
        type(t) { this.contentType = t; return this; },
        send(body) { this.body = body; return this; },
        set() { return this; },
        json(body) { this.body = body; return this; }
    };
    return res;
}

const isRawBodyWebhookPath = (p) => {
    const normalized = String(p || '').replace(/\/+$/, '') || '/';
    return normalized === '/stripe/webhook' || normalized === '/appsumo/webhook';
};

test.beforeEach(() => {
    botBlocker._resetForTest();
    delete process.env.BOT_BLOCK_ENABLED;
    delete process.env.BOT_BLOCK_DRY_RUN;
    delete process.env.BOT_BLOCK_BYPASS_TOKEN;
});

test('real browser UA with full header set is never blocked', () => {
    const req = fakeReq({
        headers: {
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0.0.0 Safari/537.36',
            'sec-ch-ua': '"Chromium";v="128"',
            'accept-language': 'en-US'
        }
    });
    assert.equal(botBlocker.classifyUa(req.headers['user-agent']), 'unknown');
    assert.equal(botBlocker.hasBrowserHeaders(req.headers), true);
});

test('named AI crawlers and social bots classify as denied', () => {
    const uas = [
        'meta-externalagent/1.1', 'GPTBot/1.0', 'ClaudeBot/1.0', 'PerplexityBot/1.0',
        'Bytespider', 'CCBot/2.0', 'anthropic-ai', 'facebookexternalhit/1.1'
    ];
    for (const ua of uas) {
        assert.equal(botBlocker.classifyUa(ua), 'denied', `expected ${ua} to be denied`);
    }
});

test('HTTP client libraries and empty user agent classify as denied', () => {
    const uas = ['curl/8.18.0', 'python-requests/2.31', 'Scrapy/2.11', 'PostmanRuntime/7.36', ''];
    for (const ua of uas) {
        assert.equal(botBlocker.classifyUa(ua), 'denied', `expected ${JSON.stringify(ua)} to be denied`);
    }
});

test('webhook paths are exempt even for a hostile user agent', () => {
    assert.equal(botBlocker.isExemptPath('/stripe/webhook', isRawBodyWebhookPath), true);
    assert.equal(botBlocker.isExemptPath('/appsumo/webhook', isRawBodyWebhookPath), true);
    assert.equal(botBlocker.isExemptPath('/api/anything', isRawBodyWebhookPath), true);
    assert.equal(botBlocker.isExemptPath('/robots.txt', isRawBodyWebhookPath), true);
    assert.equal(botBlocker.isExemptPath('/sitemap.xml', isRawBodyWebhookPath), true);
    assert.equal(botBlocker.isExemptPath('/stocks/AAPL', isRawBodyWebhookPath), false);
});

// The 403 body sends a refused crawler to /licensing, so that page must be
// reachable by the same user agent that was just blocked — otherwise the
// refusal names a destination the recipient cannot open.
test('/licensing is exempt so a blocked crawler can read the offer it was handed', () => {
    assert.equal(botBlocker.isExemptPath('/licensing', isRawBodyWebhookPath), true);
    assert.equal(botBlocker.isExemptPath('/licensing/extra', isRawBodyWebhookPath), false);
});

test('impostor detection: PTR does not belong to the claimed vendor', async (t) => {
    t.mock.method(dns, 'reverse', async () => ['evil-host.example.com']);
    const verdict = await botBlocker.resolveCrawlerIp('9.9.9.9', 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)');
    assert.equal(verdict, 'impostor');
});

test('impostor detection: PTR matches vendor domain but forward-confirm returns a different IP', async (t) => {
    t.mock.method(dns, 'reverse', async () => ['crawl-1.googlebot.com']);
    t.mock.method(dns, 'resolve4', async () => ['5.5.5.5']);
    t.mock.method(dns, 'resolve6', async () => { throw new Error('no AAAA'); });
    const verdict = await botBlocker.resolveCrawlerIp('9.9.9.9', 'Googlebot/2.1');
    assert.equal(verdict, 'impostor');
});

test('legitimate crawler: PTR matches vendor domain and forward-confirm returns the same IP', async (t) => {
    t.mock.method(dns, 'reverse', async () => ['crawl-66-249.googlebot.com']);
    t.mock.method(dns, 'resolve4', async () => ['66.249.66.1']);
    t.mock.method(dns, 'resolve6', async () => { throw new Error('no AAAA'); });
    const verdict = await botBlocker.resolveCrawlerIp('66.249.66.1', 'Googlebot/2.1');
    assert.equal(verdict, 'verified');
});

test('DNS failure resolves to unknown, never impostor', async (t) => {
    t.mock.method(dns, 'reverse', async () => { throw new Error('NXDOMAIN'); });
    const verdict = await botBlocker.resolveCrawlerIp('9.9.9.9', 'Googlebot/2.1');
    assert.equal(verdict, 'unknown');
});

test('an unseen IP fails open — first sight is not blocked while resolution runs in the background', async (t) => {
    let resolved = false;
    t.mock.method(dns, 'reverse', async () => { resolved = true; return ['crawl.googlebot.com']; });
    t.mock.method(dns, 'resolve4', async () => ['66.249.66.2']);
    t.mock.method(dns, 'resolve6', async () => { throw new Error('no AAAA'); });
    const verdict = botBlocker.checkCrawlerClaim('66.249.66.2', 'Googlebot/2.1');
    assert.equal(verdict, 'unseen');
    // background resolution kicked off but hasn't necessarily settled yet
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(resolved, true);
});

test('dry-run mode counts what would be blocked without an env-level enforcement check', () => {
    // classifyUa/isExemptPath are pure; dry-run behavior lives in middleware(),
    // exercised at the app.js integration level. Here we confirm the switch
    // itself is read from the environment as documented.
    process.env.BOT_BLOCK_DRY_RUN = 'true';
    const mw = botBlocker.middleware({ isRawBodyWebhookPath });
    const req = fakeReq({ headers: { 'user-agent': 'curl/8.18.0' } });
    const res = fakeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true, 'dry-run must still call next()');
    assert.equal(res.statusCode, null, 'dry-run must not send a response');
    assert.equal(botBlocker.stats().dryRunWouldBlock, 1);
});

test('enforcement mode blocks a denied UA with 403', () => {
    const mw = botBlocker.middleware({ isRawBodyWebhookPath });
    const req = fakeReq({ headers: { 'user-agent': 'curl/8.18.0' } });
    const res = fakeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, false);
    assert.equal(res.statusCode, 403);
});

test('bypass token and internal UA marker both pass a denied UA through', () => {
    process.env.BOT_BLOCK_BYPASS_TOKEN = 'let-me-in';
    const mw = botBlocker.middleware({ isRawBodyWebhookPath });

    const req1 = fakeReq({ headers: { 'user-agent': 'curl/8.18.0', 'x-bot-bypass': 'let-me-in' } });
    const res1 = fakeRes();
    let next1 = false;
    mw(req1, res1, () => { next1 = true; });
    assert.equal(next1, true);

    const req2 = fakeReq({ headers: { 'user-agent': 'curl/8.18.0 stockportfolio-internal' } });
    const res2 = fakeRes();
    let next2 = false;
    mw(req2, res2, () => { next2 = true; });
    assert.equal(next2, true);
});

test('BOT_BLOCK_ENABLED=false is a full kill switch', () => {
    process.env.BOT_BLOCK_ENABLED = 'false';
    const mw = botBlocker.middleware({ isRawBodyWebhookPath });
    const req = fakeReq({ headers: { 'user-agent': 'meta-externalagent/1.1' } });
    const res = fakeRes();
    let nextCalled = false;
    mw(req, res, () => { nextCalled = true; });
    assert.equal(nextCalled, true);
    assert.equal(res.statusCode, null);
});
