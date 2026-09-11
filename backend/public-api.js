'use strict';

// Public REST API (/api/v1/*). External callers authenticate with an API key
// (api-keys.js) that resolves to the same website account and spends from
// the same credit_ledger wallet as the web app (credits.js) — see
// apiKeyAuth in app.js, which populates req.userId/req.user/req.subscription/
// req.tier identically to authMiddleware so every downstream helper
// (effectiveAskLimit, credits.check/spend) works unmodified.
//
// Deterministic tools reuse free-tools.js/asset-profile.js exactly as the
// web app and the MCP endpoint do; nothing here recomputes data. Built as a
// factory (not a plain require of app.js) to avoid a require cycle — app.js
// requires this module, so this module cannot require app.js back.

const express = require('express');
const freeTools = require('./free-tools');
const assetProfile = require('./asset-profile');
const { envelope } = require('./api-response');

function buildPublicApiRouter({ credits, effectiveAskLimit, aiChat, apiKeyAuth, apiAccessGate, apiKeyRateLimit, jsonParser }) {
    const router = express.Router();

    router.get('/health', (req, res) => {
        res.json({ ok: true, version: 'v1', generatedAt: new Date().toISOString() });
    });

    // Access is tier-gated (Power/Desk, or the top AppSumo/DealMirror
    // tier — see app.js's apiAccessGate) BEFORE the rate limiter, so a
    // caller who isn't entitled gets a clear 402 rather than counting
    // against the shared per-key rate budget.
    router.use(apiKeyAuth, apiAccessGate, apiKeyRateLimit);

    // Checks the wallet BEFORE doing the (potentially expensive) lookup, and
    // never charges a call that returns an error — same "gate first, spend
    // only on success" order every other credits.js call site in app.js uses.
    async function gate(req, res, cost) {
        const planId = req.subscription && req.subscription.planId;
        const check = await credits.check(req.userId, cost, effectiveAskLimit(req), planId, req.user);
        if (!check.ok) {
            res.status(402).json({
                error: `Out of credits for this month (used ${check.used}/${check.allowance}).`,
                resetsAt: check.resetsAt,
            });
            return null;
        }
        return check;
    }

    router.get('/financials/:ticker', async (req, res) => {
        const slugs = new Set(Object.keys(freeTools.TOOL_DEFINITIONS));
        const requested = String(req.query.tool || 'earnings-quality').trim().toLowerCase();
        const slug = slugs.has(requested) ? requested : 'earnings-quality';
        if (!(await gate(req, res, 'api_lookup'))) return;
        const { status, body } = await freeTools.getToolResult(slug, req.params.ticker);
        if (status !== 200) return res.status(status).json({ error: body.error });
        await credits.spend(req.userId, 'api_lookup', `api:${slug}`, req.params.ticker);
        res.json(envelope(slug, freeTools.normalizeSymbol(req.params.ticker), body));
    });

    router.get('/filing/:ticker', async (req, res) => {
        if (!(await gate(req, res, 'api_lookup'))) return;
        const { status, body } = await freeTools.getToolResult('filing-timeline', req.params.ticker);
        if (status !== 200) return res.status(status).json({ error: body.error });
        await credits.spend(req.userId, 'api_lookup', 'api:filing-timeline', req.params.ticker);
        res.json(envelope('filing-timeline', freeTools.normalizeSymbol(req.params.ticker), body));
    });

    router.get('/compare', async (req, res) => {
        const raw = String(req.query.tickers || '');
        if (!(await gate(req, res, 'api_lookup'))) return;
        const { status, body } = await freeTools.getToolResult('company-comparison', raw);
        if (status !== 200) return res.status(status).json({ error: body.error });
        await credits.spend(req.userId, 'api_lookup', 'api:company-comparison', raw);
        res.json(envelope('company-comparison', raw.toUpperCase(), body));
    });

    router.get('/screen', async (req, res) => {
        const raw = String(req.query.tickers || '');
        if (!(await gate(req, res, 'api_lookup'))) return;
        const { status, body } = await freeTools.getToolResult('portfolio-revenue', raw);
        if (status !== 200) return res.status(status).json({ error: body.error });
        await credits.spend(req.userId, 'api_lookup', 'api:portfolio-revenue', raw);
        res.json(envelope('portfolio-revenue', raw.toUpperCase(), body));
    });

    // Yahoo-derived, not SEC — kept out of the free-tools cache path
    // deliberately. Flagged as non-redistributable in the response note; see
    // corpus-license-terms.md for the underlying rights constraint.
    router.get('/fund/:symbol', async (req, res) => {
        const symbol = freeTools.normalizeSymbol(req.params.symbol);
        if (!symbol) return res.status(400).json({ error: 'Invalid fund symbol.' });
        if (!(await gate(req, res, 'api_lookup'))) return;
        let profile;
        try { profile = await assetProfile.fetchAssetProfile(symbol); }
        catch (_) { return res.status(502).json({ error: 'Fund profile is temporarily unavailable.' }); }
        if (!profile || !assetProfile.isFundAsset(profile.assetType)) {
            return res.status(404).json({ error: `${symbol} is not an ETF or mutual fund.` });
        }
        await credits.spend(req.userId, 'api_lookup', 'api:fund', symbol);
        res.json({
            tool: 'fund',
            symbol,
            generatedAt: new Date().toISOString(),
            profile,
            source: {
                type: 'fund-data',
                url: profile.source || null,
                note: 'Fund data via Yahoo fund profiles — not company SEC 10-K/10-Q. Not redistributable; informational use only.',
            },
        });
    });

    router.post('/ask', jsonParser, async (req, res) => {
        const question = String((req.body && req.body.question) || '').trim();
        if (!question) return res.status(400).json({ error: 'Missing "question".' });
        if (!(await gate(req, res, 'api_ask'))) return;
        const result = await aiChat.ask({ question, history: [], ctx: { holdings: [] } }).catch((e) => ({ error: e.message }));
        if (result && result.error) return res.status(502).json({ error: result.error });
        await credits.spend(req.userId, 'api_ask', 'api:ask');
        res.json({
            tool: 'ask',
            question,
            answer: result.answer || result.text || result.body,
            toolsUsed: result.toolsUsed || [],
            generatedAt: new Date().toISOString(),
            source: {
                type: result.sourceClass || result.source || 'filed',
                note: 'Verify figures in the cited SEC filing before acting. Not investment advice.',
            },
        });
    });

    return router;
}

module.exports = { buildPublicApiRouter };
