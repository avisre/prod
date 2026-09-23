'use strict';

// public-api.js — the credit-gating contract for the public REST API:
// missing/invalid key -> 401, exhausted wallet -> 402 with nothing spent, a
// successful lookup spends exactly its cost, and an errored lookup spends
// nothing. Real credit_ledger (in-memory Mongo, same pattern as
// test/credits.test.js) so the aggregate-sum gating logic is exercised for
// real; free-tools/asset-profile/ai-chat are stubbed (monkey-patched on
// their shared module exports) so the test never touches the network or the
// on-disk fundamentals cache.

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const credits = require('../credits');
const freeTools = require('../free-tools');
const assetProfile = require('../asset-profile');
const aiChat = require('../ai-chat');
const { buildPublicApiRouter } = require('../public-api');

// A stand-in for app.js's real apiKeyAuth: resolves identity from a plain
// test header instead of hitting Mongo for a hashed key, but populates the
// exact same fields (userId/user/subscription/tier) the real middleware
// does — that field contract is what public-api.js's gate() depends on.
function fakeApiKeyAuth(req, res, next) {
    const userId = req.get('x-test-user');
    if (!userId) return res.status(401).json({ error: 'Missing API key.' });
    req.userId = userId;
    req.user = { _id: userId };
    req.subscription = { planId: 'free' };
    req.tier = 'free';
    req.apiKeyId = `key-${userId}`;
    next();
}

// allowance = limit x 2 (credits.js allowance()), so 40 -> an 80-credit wallet:
// enough for one api_ask (42) plus the lookups above it, and still small and
// deterministic. Sized off COST so a reprice does not silently 402 this test.
function effectiveAskLimit() { return Math.max(10, credits.COST.api_ask); }

async function withServer(t, run) {
    const app = express();
    app.use(buildPublicApiRouter({
        credits, effectiveAskLimit, aiChat,
        apiKeyAuth: fakeApiKeyAuth,
        apiAccessGate: (req, res, next) => next(), // tier gating lives in app.js; tested there
        apiKeyRateLimit: (req, res, next) => next(),
        jsonParser: express.json(),
    }));
    const server = http.createServer(app);
    await new Promise((resolve) => server.listen(0, resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    return run(base);
}

test('public API: auth, credit gating, and spend-only-on-success', { timeout: 60000 }, async (t) => {
    const mem = await MongoMemoryServer.create();
    await mongoose.connect(mem.getUri());
    t.after(async () => { await mongoose.disconnect().catch(() => {}); await mem.stop(); });

    const origGetToolResult = freeTools.getToolResult;
    const origFetchAssetProfile = assetProfile.fetchAssetProfile;
    const origIsFundAsset = assetProfile.isFundAsset;
    const origAsk = aiChat.ask;
    t.after(() => {
        freeTools.getToolResult = origGetToolResult;
        assetProfile.fetchAssetProfile = origFetchAssetProfile;
        assetProfile.isFundAsset = origIsFundAsset;
        aiChat.ask = origAsk;
    });

    await withServer(t, async (base) => {
        // No key at all -> 401, matching apiKeyAuth's contract.
        let res = await fetch(`${base}/financials/AAPL`, {});
        assert.equal(res.status, 401);

        // health is unauthenticated and never touches credits.
        res = await fetch(`${base}/health`);
        assert.equal(res.status, 200);
        assert.equal((await res.json()).ok, true);

        // Stub a successful deterministic lookup.
        freeTools.getToolResult = async (slug, ticker) => ({
            status: 200,
            body: { symbol: ticker, tool: slug, revenue: 1000, sourceUrl: 'https://sec.gov/x' },
        });

        let before = await credits.balance('u1', effectiveAskLimit());
        res = await fetch(`${base}/financials/AAPL`, { headers: { 'x-test-user': 'u1' } });
        assert.equal(res.status, 200);
        const body = await res.json();
        assert.equal(body.symbol, 'AAPL');
        assert.equal(body.source.type, 'filed', 'sec.gov URL classifies as filed');
        let after = await credits.balance('u1', effectiveAskLimit());
        assert.equal(after.used, before.used + credits.COST.api_lookup, 'a successful lookup spends exactly api_lookup — the same price as the MCP surface');

        // A different user's key never touches u1's wallet.
        const otherBefore = await credits.balance('u1', effectiveAskLimit());
        await fetch(`${base}/financials/AAPL`, { headers: { 'x-test-user': 'u2' } });
        const otherAfter = await credits.balance('u1', effectiveAskLimit());
        assert.equal(otherAfter.used, otherBefore.used, "u2's call never spends from u1's ledger");

        // An errored lookup (e.g. unknown ticker) spends nothing.
        freeTools.getToolResult = async () => ({ status: 400, body: { error: 'Enter a valid ticker symbol.' } });
        before = await credits.balance('u1', effectiveAskLimit());
        res = await fetch(`${base}/financials/ZZZZ`, { headers: { 'x-test-user': 'u1' } });
        assert.equal(res.status, 400);
        after = await credits.balance('u1', effectiveAskLimit());
        assert.equal(after.used, before.used, 'a failed lookup never spends');

        // Exhaust a FRESH user's wallet exactly, then confirm 402 with no
        // further spend past the ceiling. Derived from COST so the loop always
        // lands on zero rather than assuming a particular price.
        freeTools.getToolResult = async (slug, ticker) => ({ status: 200, body: { symbol: ticker, tool: slug } });
        const lookupsToDrain = (effectiveAskLimit() * 2) / credits.COST.api_lookup;
        for (let i = 0; i < lookupsToDrain; i++) {
            await fetch(`${base}/financials/AAPL`, { headers: { 'x-test-user': 'u3' } });
        }
        before = await credits.balance('u3', effectiveAskLimit());
        assert.equal(before.remaining, 0, 'wallet fully spent by the loop');
        res = await fetch(`${base}/financials/AAPL`, { headers: { 'x-test-user': 'u3' } });
        assert.equal(res.status, 402);
        after = await credits.balance('u3', effectiveAskLimit());
        assert.equal(after.used, before.used, '402 spends nothing further');

        // The 402 must be actionable, not just prose: an API-only caller
        // cannot reach the session-authenticated /api/credits/topup, so the
        // shortfall numbers and the recharge link are the whole remedy.
        const quota = await res.json();
        assert.equal(quota.code, 'QUOTA_EXCEEDED');
        assert.equal(quota.remaining, 0);
        assert.equal(quota.needed, credits.COST.api_lookup, '402 states what the refused call would have cost');
        assert.equal(quota.used, before.used);
        assert.ok(quota.resetsAt, '402 says when the allowance returns');
        assert.ok(/\/recharge\.html/.test(quota.recharge.url), '402 links the recharge page');
        assert.equal(quota.recharge.credits, 150);
        assert.equal(quota.recharge.price, '$14.99');

        // /fund: non-redistributable note is present, and a non-fund symbol 404s.
        assetProfile.fetchAssetProfile = async (symbol) => ({ assetType: 'ETF', source: 'https://finance.yahoo.com/x', symbol });
        assetProfile.isFundAsset = (type) => type === 'ETF';
        res = await fetch(`${base}/fund/SPY`, { headers: { 'x-test-user': 'u4' } });
        assert.equal(res.status, 200);
        const fundBody = await res.json();
        assert.match(fundBody.source.note, /Not redistributable/);

        assetProfile.fetchAssetProfile = async (symbol) => ({ assetType: 'EQUITY', symbol });
        res = await fetch(`${base}/fund/AAPL`, { headers: { 'x-test-user': 'u4' } });
        assert.equal(res.status, 404);

        // /ask spends api_ask, not api_lookup. Since 2026-09-22 api_ask and
        // mcp_ask share one 6x-frontier anchor; only lookups keep the 2x split.
        aiChat.ask = async ({ question }) => ({ answer: `Answer to: ${question}`, source: 'filed' });
        before = await credits.balance('u5', effectiveAskLimit());
        res = await fetch(`${base}/ask`, {
            method: 'POST', headers: { 'content-type': 'application/json', 'x-test-user': 'u5' },
            body: JSON.stringify({ question: 'What was NVDA revenue?' }),
        });
        assert.equal(res.status, 200);
        const askBody = await res.json();
        assert.match(askBody.answer, /What was NVDA revenue/);
        after = await credits.balance('u5', effectiveAskLimit());
        assert.equal(after.used, before.used + credits.COST.api_ask, '/ask spends api_ask');
    });
});
