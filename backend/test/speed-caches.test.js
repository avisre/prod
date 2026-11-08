'use strict';

// Speed fixes measured on production 2026-11-09: one /api/screener call held
// the 0.5-CPU instance for ~1.5 s, an X-Ray rebuilt the whole screen index per
// holding, the nav tray's /api/credits ran three ledger queries on every page,
// and each /stocks/:ticker view re-loaded the company's evidence payload.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

test('the screen index is built once per snapshot view and shared read-only', () => {
    const aiChat = require('../ai-chat');
    const a = aiChat.buildScreenIndex();
    const b = aiChat.buildScreenIndex();
    assert.ok(a.length > 100, 'the committed index loads');
    assert.equal(a, b, 'a repeat call returns the same rows without rebuilding');
    assert.ok(Object.isFrozen(a), 'callers cannot sort the shared array in place');
    for (const sym of ['AAPL', 'MSFT', 'KO', 'NOT-A-TICKER']) {
        assert.equal(aiChat.metricsFor(sym), a.find((r) => r.symbol === sym) || null, `metricsFor(${sym}) matches a scan`);
    }
    assert.deepEqual(aiChat.sectorList(), [...new Set(a.map((r) => r.sector).filter(Boolean))].sort());
    const screen = aiChat.screenRows({ limit: 5 });
    assert.equal(screen.listedUniverse, a.length);
    assert.equal(screen.issuerUniverse, new Set(a.map((r) => r.cik)).size);
    assert.equal(aiChat.buildScreenIndex(), a, 'screening did not disturb the shared rows');
});

test('the credits display cache never outlives a spend, grant or refund', { timeout: 60000 }, async (t) => {
    const server = await MongoMemoryServer.create();
    await mongoose.connect(server.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await server.stop(); });
    const credits = require('../credits');
    const user = 'speed-cache-user';
    const shown = async () => {
        const [bal, recent, breakdown] = await Promise.all([
            credits.balance(user, 300, null, null, { cached: true }),
            credits.recentActivity(user, 20, { cached: true }),
            credits.monthBreakdown(user, { cached: true })
        ]);
        return { used: bal.used, remaining: bal.remaining, rows: recent.length, reasons: Object.keys(breakdown).sort() };
    };

    assert.deepEqual(await shown(), { used: 0, remaining: 600, rows: 0, reasons: [] });

    // A write behind the module's back is invisible while the entry is fresh:
    // that is the cache working.
    await mongoose.connection.collection('credit_ledger').insertOne({ userId: user, month: credits.monthKey(), delta: -1, reason: 'outside', at: new Date() });
    assert.equal((await shown()).used, 0, 'served from the cache');
    assert.equal((await credits.balance(user, 300)).used, 1, 'billing reads never go through the cache');

    await credits.spend(user, 'ask', 'ask', 'q1');
    let s = await shown();
    assert.equal(s.used, 1 + credits.COST.ask, 'a spend clears the cached balance');
    assert.equal(s.rows, 2);
    assert.deepEqual(s.reasons, ['ask', 'outside']);

    await credits.grant(user, 50, 'admin_grant', 'g1');
    s = await shown();
    assert.equal(s.remaining, 600 + 50 - 1 - credits.COST.ask, 'a grant clears it');

    await credits.spendAskStep(user, 3, 'run-1');
    assert.equal((await shown()).used, 1 + credits.COST.ask + 3, 'an Ask step clears it');
    await credits.refundRun(user, 'run-1');
    assert.equal((await shown()).used, 1 + credits.COST.ask, 'a refunded run clears it');
});

test('/api/credits reads through the display cache; nothing else does', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const route = app.slice(app.indexOf("app.get('/api/credits', authMiddleware"), app.indexOf('async function connectorUsageRows'));
    assert.match(route, /credits\.balance\(req\.userId, effectiveAskLimit\(req\), planId, req\.user, \{ cached: true \}\)/);
    assert.match(route, /credits\.recentActivity\(req\.userId, activityLimit, \{ cached: true \}\)/);
    assert.match(route, /credits\.monthBreakdown\(req\.userId, \{ cached: true \}\)/);
    assert.equal((app.match(/\{ cached: true \}\)/g) || []).length, 3, 'no billing path opts into the cache');
});

test('rendered /stocks pages are kept a few minutes, crawlers and readers apart', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    const route = app.slice(app.indexOf("app.get('/stocks/:ticker'"), app.indexOf("app.get('/vs/:competitor'"));
    assert.match(app, /const STOCK_PAGE_TTL_MS = 3 \* 60 \* 1000;/);
    assert.match(route, /isLikelyCrawler\(req\.get\('user-agent'\)\) \? 'crawler' : 'reader'/);
    assert.ok(route.indexOf('_stockPageCache.get') > route.indexOf('res.redirect(301'), 'the canonical redirect still runs first');
    assert.ok(route.indexOf('_stockPageCache.set') > route.indexOf('if (!html) return res.status(404)'), 'only a rendered page is kept');
});

test('attribution fetches the movers\' headlines together and keeps each headline on one mover', async () => {
    const yahoo = require('../yahoo-source');
    const orig = { fetchQuote: yahoo.fetchQuote, fetchNews: yahoo.fetchNews };
    let inFlight = 0, peak = 0;
    const day = new Date().toISOString().slice(0, 10);
    const stamp = day.replace(/-/g, '') + 'T120000';
    yahoo.fetchQuote = async (s) => ({ 'Global Quote': { '05. price': '100', '10. change percent': `${{ A: 5, B: -4, C: 3 }[s]}%`, '07. latest trading day': day } });
    yahoo.fetchNews = async ({ tickers }) => {
        inFlight += 1; peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 30));
        inFlight -= 1;
        return { feed: [{ title: 'Shared story', url: 'https://x.test/shared', time_published: stamp }, { title: `${tickers} story`, url: `https://x.test/${tickers}`, time_published: stamp }] };
    };
    try {
        delete require.cache[require.resolve('../attribution')];
        const out = await require('../attribution').computeAttribution([{ symbol: 'A', shares: 10 }, { symbol: 'B', shares: 10 }, { symbol: 'C', shares: 10 }]);
        assert.equal(peak, 3, 'all three headline fetches ran at once');
        const titles = out.movers.flatMap((m) => m.headlines.map((h) => h.title));
        assert.equal(titles.filter((x) => x === 'Shared story').length, 1, 'a shared headline stays on the first mover only');
        assert.equal(out.movers[0].symbol, 'A');
        assert.ok(out.movers[0].headlines.some((h) => h.title === 'Shared story'));
    } finally {
        Object.assign(yahoo, orig);
    }
});

test('/news asks the edge for resized images and handles a failed one without inline handlers', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'news.js'), 'utf8');
    assert.match(js, /\/cdn-cgi\/image\/width=\$\{width\},quality=75,format=auto,fit=scale-down\//);
    assert.doesNotMatch(js.replace(/^\s*\/\/.*$/gm, ''), /onerror=/, 'the CSP (script-src-attr none) blocks inline handlers');
    assert.match(js, /document\.addEventListener\('error'[\s\S]*?, true\)/);
    assert.equal((js.match(/feedImg\('/g) || []).length, 3, 'feature, secondary and stream images all resized');
});
