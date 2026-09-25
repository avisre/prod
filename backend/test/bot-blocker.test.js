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
        'meta-externalagent/1.1', 'GPTBot/1.0', 'ClaudeBot/1.0', 'Perplexity-User/1.0',
        'Bytespider', 'CCBot/2.0', 'anthropic-ai', 'facebookexternalhit/1.1'
    ];
    for (const ua of uas) {
        assert.equal(botBlocker.classifyUa(ua), 'denied', `expected ${ua} to be denied`);
    }
});

// The two answer-engine index crawlers are admitted, and admitting them is the
// whole point of the change: OAI-SearchBot's documentation states an opted-out
// site "won't appear in ChatGPT search answers", so a 'denied' here silently
// removes the site from two answer engines. They are 'allowed-claim' — not
// trusted on the UA alone — because their vendors publish IP ranges rather
// than reverse-DNS hostnames, and bot-blocker verifies against those.
test('answer-engine index crawlers are admitted, not denied', () => {
    for (const ua of ['OAI-SearchBot/1.0', 'PerplexityBot/1.0',
        'Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)']) {
        assert.equal(botBlocker.classifyUa(ua), 'allowed-claim', `expected ${ua} to be admitted`);
    }
    // Their training-only and on-behalf-of-user siblings must stay out.
    for (const ua of ['GPTBot/1.0', 'ChatGPT-User/1.0', 'Perplexity-User/1.0']) {
        assert.equal(botBlocker.classifyUa(ua), 'denied', `expected ${ua} to stay denied`);
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
// The keyless MCP tier exists so ChatGPT and claude.ai users can reach this
// server at all (neither client can send a static bearer token). Both send a UA
// that DENY_PATTERNS matches, so without this exemption the feature is
// unreachable from the exact two clients it was built for — and a PAYING
// customer calling a tool from their chatbot is refused too.
test('/mcp is exempt, or the agents the deny list names can never call a tool', () => {
    assert.equal(botBlocker.isExemptPath('/mcp', isRawBodyWebhookPath), true);
    // Scoped tightly: the exemption is the endpoint itself, not a prefix that
    // could be extended later into something that does serve crawlable content.
    assert.equal(botBlocker.isExemptPath('/mcp/anything', isRawBodyWebhookPath), false);
    assert.equal(botBlocker.isExemptPath('/mcpx', isRawBodyWebhookPath), false);
});

test('/appsumo/redeem is exempt, or AppSumo cannot validate the redirect URL', () => {
    // The partner portal checks the registered OAuth redirect_uri server-side
    // before a listing version can be submitted; a 403 here blocks submission.
    assert.equal(botBlocker.isExemptPath('/appsumo/redeem', isRawBodyWebhookPath), true);
    // Exact path only — the exemption must not open any other /appsumo page.
    assert.equal(botBlocker.isExemptPath('/appsumo', isRawBodyWebhookPath), false);
    assert.equal(botBlocker.isExemptPath('/appsumo/redeem/extra', isRawBodyWebhookPath), false);
});

test('/oauth/* is exempt, or the machine legs of the OAuth flow cannot run', () => {
    // Registration and token exchange are made by the chatbot vendor's servers,
    // not the user's browser: no browser headers, so the forged-browser check
    // would 403 them and no customer could ever authenticate.
    assert.equal(botBlocker.isExemptPath('/oauth/register', isRawBodyWebhookPath), true);
    assert.equal(botBlocker.isExemptPath('/oauth/token', isRawBodyWebhookPath), true);
    assert.equal(botBlocker.isExemptPath('/oauth/authorize', isRawBodyWebhookPath), true);
    assert.equal(botBlocker.isExemptPath('/oauth/authorize/decision', isRawBodyWebhookPath), true);
    // Scoped to the prefix and nothing adjacent to it.
    assert.equal(botBlocker.isExemptPath('/oauthx', isRawBodyWebhookPath), false);
});

test('the deny list still names the chatbot agents — the exemption is what saves them', () => {
    // If these ever leave DENY_PATTERNS the /mcp exemption stops being
    // load-bearing, and this test should be revisited rather than deleted.
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'bot-blocker.js'), 'utf8');
    assert.match(src, /chatgpt-user/i, 'ChatGPT\'s on-behalf-of-user agent is still denied site-wide');
    assert.match(src, /claude-user/i, 'claude.ai\'s on-behalf-of-user agent is still denied site-wide');
});

test('/licensing is exempt so a blocked crawler can read the offer it was handed', () => {
    assert.equal(botBlocker.isExemptPath('/licensing', isRawBodyWebhookPath), true);
    assert.equal(botBlocker.isExemptPath('/licensing/extra', isRawBodyWebhookPath), false);
});

// A connector-directory submission declares a documentation URL and a privacy
// policy URL, and Anthropic reads both during review. Their fetches carry no
// browser headers and a UA the deny list matches, so without these exemptions
// the submission is rejected on two URLs that are only unreadable to Anthropic.
test('/docs/api-mcp is exempt, or Anthropic cannot read the declared docs URL', () => {
    assert.equal(botBlocker.isExemptPath('/docs/api-mcp', isRawBodyWebhookPath), true);
    // Trailing slash is the same page (app.js canonicalises it), so it must not
    // be the one spelling that 403s.
    assert.equal(botBlocker.isExemptPath('/docs/api-mcp/', isRawBodyWebhookPath), true);
    // Exact path only: no other documentation page opens up.
    assert.equal(botBlocker.isExemptPath('/docs/api-mcp/extra', isRawBodyWebhookPath), false);
    assert.equal(botBlocker.isExemptPath('/docs', isRawBodyWebhookPath), false);
    assert.equal(botBlocker.isExemptPath('/docs/terms', isRawBodyWebhookPath), false);
});

test('/privacy is exempt, or Anthropic cannot read the declared privacy policy URL', () => {
    assert.equal(botBlocker.isExemptPath('/privacy', isRawBodyWebhookPath), true);
    assert.equal(botBlocker.isExemptPath('/privacy/', isRawBodyWebhookPath), true);
    assert.equal(botBlocker.isExemptPath('/privacy/extra', isRawBodyWebhookPath), false);
    assert.equal(botBlocker.isExemptPath('/privacyx', isRawBodyWebhookPath), false);
    // The neighbouring legal pages are deliberately NOT exempt.
    assert.equal(botBlocker.isExemptPath('/terms', isRawBodyWebhookPath), false);
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

test('crawler verification resolves the visitor IP, not the Cloudflare edge hop', async (t) => {
    // Behind Render's Cloudflare edge req.ip is an intermediate proxy hop, not
    // the caller. Verifying that hop means a real Googlebot is checked against
    // someone else's PTR record — and lands in the 'impostor' cache for six
    // hours. The address must come from the same visitor resolution the rest
    // of the app uses (app.js visitorIp / marketing-attribution requestIp).
    process.env.NODE_ENV = 'production';
    t.after(() => { delete process.env.NODE_ENV; });
    const reversed = [];
    t.mock.method(dns, 'reverse', async (ip) => { reversed.push(ip); return ['crawl-66-249-66-9.googlebot.com']; });
    t.mock.method(dns, 'resolve4', async () => ['66.249.66.9']);
    t.mock.method(dns, 'resolve6', async () => { throw new Error('no AAAA'); });

    const mw = botBlocker.middleware({ isRawBodyWebhookPath });
    const req = fakeReq({
        ip: '172.71.0.1', // the Cloudflare edge hop the origin actually sees
        headers: { 'user-agent': 'Googlebot/2.1', 'cf-connecting-ip': '66.249.66.9' }
    });
    const res = fakeRes();
    mw(req, res, () => {});
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(reversed, ['66.249.66.9'],
        'reverse DNS must ask about the visitor, never the edge hop');
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

// --- Layer 2b: published-range verification for the AI answer-engine crawlers ---

test('published IP ranges parse and match, including the /0 and /32 edges', () => {
    const nets = ['104.210.140.128/28', '13.66.216.176/28', '135.234.64.0/24', '3.224.62.45/32']
        .map((c) => botBlocker.parseCidr(c));
    assert.ok(nets.every(Boolean), "every prefix shape the vendors ship must parse");
    assert.equal(botBlocker.ipInNets('104.210.140.130', nets), true, 'inside a /28');
    assert.equal(botBlocker.ipInNets('104.210.140.143', nets), true, 'last address of a /28');
    assert.equal(botBlocker.ipInNets('104.210.140.144', nets), false, 'first address past a /28');
    assert.equal(botBlocker.ipInNets('135.234.64.7', nets), true, 'inside a /24');
    assert.equal(botBlocker.ipInNets('3.224.62.45', nets), true, 'a /32 matches exactly');
    assert.equal(botBlocker.ipInNets('3.224.62.46', nets), false, 'a /32 excludes its neighbour');
    assert.equal(botBlocker.ipInNets('not-an-ip', nets), false, 'garbage must never match');
    // A /0 is the one case JS cannot express by shifting: 1<<32 is a no-op, so
    // the all-addresses prefix needs its own branch or it would match nothing.
    assert.equal(botBlocker.ipInNets('8.8.8.8', [botBlocker.parseCidr('0.0.0.0/0')]), true);
    assert.equal(botBlocker.parseCidr('nonsense/24'), null);
    assert.equal(botBlocker.parseCidr('10.0.0.0/33'), null);
    assert.equal(botBlocker.parseCidr('10.0.0.256/24'), null);
});

// The regression this guards: neither vendor publishes a reverse-DNS hostname,
// so routing either one down the PTR path finds no matching suffix and marks a
// GENUINE crawler an impostor — the exact bug that made this more than a
// two-line change. vendorForUa is what keeps them on the range path.
test('vendor routing sends each crawler to the verification method its vendor publishes', () => {
    assert.equal(botBlocker.vendorForUa('OAI-SearchBot/1.0'), 'openai');
    assert.equal(botBlocker.vendorForUa('PerplexityBot/1.0'), 'perplexity');
    assert.equal(botBlocker.vendorForUa('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), 'google');
    assert.equal(botBlocker.vendorForUa('Mozilla/5.0 (compatible; bingbot/2.0)'), 'bing');

    assert.ok(botBlocker.RANGE_VENDORS[botBlocker.vendorForUa('OAI-SearchBot/1.0')],
        'the OpenAI crawler must take the range path');
    assert.ok(botBlocker.RANGE_VENDORS[botBlocker.vendorForUa('PerplexityBot/1.0')],
        'the Perplexity crawler must take the range path');
    assert.equal(botBlocker.RANGE_VENDORS[botBlocker.vendorForUa('Googlebot/2.1')], undefined,
        'Google must NOT take the range path — it is PTR-verified');
});

// The invariant that makes "bounded rate" true rather than aspirational.
// Verification and rate limiting are separate jobs: verifying the AI crawlers
// stops an impostor wearing their name, and the nav limit is what bounds their
// crawl on a 5GB plan. Letting verification imply exemption would hand OpenAI
// and Perplexity unthrottled access to a 21,689-URL sitemap.
test('verification does not imply exemption — only Google and Bing skip the nav limit', () => {
    botBlocker._resetForTest();
    botBlocker._seedVerdictForTest('104.210.140.130', 'verified', 'openai');
    botBlocker._seedVerdictForTest('3.224.62.45', 'verified', 'perplexity');
    assert.equal(botBlocker.isLimiterExempt('104.210.140.130'), false,
        'a verified OpenAI crawler must stay rate limited');
    assert.equal(botBlocker.isLimiterExempt('3.224.62.45'), false,
        'a verified Perplexity crawler must stay rate limited');

    botBlocker._seedVerdictForTest('66.249.66.1', 'verified', 'google');
    botBlocker._seedVerdictForTest('40.77.167.1', 'verified', 'bing');
    assert.equal(botBlocker.isLimiterExempt('66.249.66.1'), true, 'verified Googlebot skips the limit');
    assert.equal(botBlocker.isLimiterExempt('40.77.167.1'), true, 'verified Bingbot skips the limit');

    botBlocker._seedVerdictForTest('203.0.113.9', 'impostor', 'google');
    assert.equal(botBlocker.isLimiterExempt('203.0.113.9'), false, 'an impostor is never exempt');
    botBlocker._resetForTest();
});
