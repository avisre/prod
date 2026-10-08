'use strict';

// Shared response envelope for the public REST API (public-api.js) and the
// hosted MCP endpoint (mcp-endpoint.js) — both wrap the same underlying
// free-tools.js/asset-profile.js results, so the citation/attribution shape
// only needs to exist once. Mirrors the envelope the original stdio
// mcp-server/src/server.js built inline, before the hosted endpoint
// replaced it as the public launch surface.

const SITE = 'https://www.stockportfolio.pro';
const UTM = 'utm_source=api&utm_medium=integration&utm_campaign=stockportfolio-api';

function siteLink(pathname = '/') {
    return `${SITE}${pathname}${pathname.includes('?') ? '&' : '?'}${UTM}`;
}

function attribution(symbol, sourceUrl, period) {
    const where = symbol ? `/stocks/${encodeURIComponent(symbol)}` : '/';
    return {
        filingSource: sourceUrl || null,
        period: period || null,
        verifyAt: siteLink(where),
        poweredBy: 'StockPortfolio.pro — filing-grounded US company data',
    };
}

// `result` is a free-tools.js tool body (already carries source/sourceUrl/
// note/warnings for most tools) — this adds the top-level envelope shape and
// the citation block, without discarding any of the original fields.
function envelope(tool, symbol, result) {
    const body = result || {};
    const sourceUrl = body.sourceUrl || body.source || null;
    const resolvedSymbol = symbol || body.symbol || null;
    return {
        tool,
        symbol: resolvedSymbol,
        generatedAt: new Date().toISOString(),
        data: body,
        source: {
            type: /sec\.gov|SEC/i.test(String(sourceUrl)) ? 'filed' : String(body.source || 'filed'),
            url: sourceUrl,
            period: body.period || (body.latest && body.latest.period) || null,
            note: body.note || 'Informational research only — verify in the linked SEC filing. Not investment advice.',
        },
        warnings: body.warnings || [],
        citation: attribution(resolvedSymbol, sourceUrl, body.period || null),
    };
}

// Credit-exhaustion body, shared by the REST API (public-api.js) and the
// hosted MCP endpoint (mcp-endpoint.js). Both used to return only prose
// ("Out of credits for this month (used 40/40)"), which left an API-only
// caller with no machine-readable way to see HOW short they were and no
// pointer to the fix — /api/credits/topup is session-authenticated, so a key
// holder cannot buy programmatically and has to be told where to go. The
// numbers mirror the web cards in dossier.js/monitor.js; the price constants
// track CREDIT_TOPUP_PRICE/CREDIT_TOPUP_CREDITS in app.js, which are what the
// /recharge checkout actually charges.
const RECHARGE_CREDITS = parseInt(process.env.CREDIT_TOPUP_CREDITS || '150', 10);
const RECHARGE_PRICE = parseFloat(process.env.CREDIT_TOPUP_PRICE || '14.99');
const creditTopupPacks = require('./credit-topup-packs');

function quotaError(gate) {
    const used = Number(gate && gate.used) || 0;
    const allowance = Number(gate && gate.allowance) || 0;
    const needed = Number(gate && gate.cost) || 0;
    const remaining = Number(gate && gate.remaining) || 0;
    const resetsAt = (gate && gate.resetsAt) || null;
    return {
        error: `Out of credits for this month (used ${used}/${allowance}). `
            + `This call costs ${needed}, you have ${remaining} left. `
            + `Recharge ${RECHARGE_CREDITS} credits for $${RECHARGE_PRICE.toFixed(2)} (larger refills up to ${creditTopupPacks.largestLabel()}), `
            + `keep going free on the website, or wait for the monthly allowance to return.`,
        code: 'QUOTA_EXCEEDED',
        used,
        allowance,
        remaining,
        needed,
        resetsAt,
        recharge: {
            url: siteLink('/recharge.html'),
            credits: RECHARGE_CREDITS,
            price: `$${RECHARGE_PRICE.toFixed(2)}`,
            // Every size on the recharge page, smallest first. `credits`/`price`
            // above stay the base refill so existing readers keep working.
            sizes: [{ credits: RECHARGE_CREDITS, price: `$${RECHARGE_PRICE.toFixed(2)}` },
                ...Object.values(creditTopupPacks.PACKS).map((p) => ({ credits: p.credits, price: `$${p.usd}` }))],
        },
        upgradeUrl: siteLink('/upgrade.html'),
        // The deterministic tools behind every lookup are served free and
        // unauthenticated on the website (app.js's /api/free-tools/:tool), so
        // an exhausted wallet is never a dead end. Saying so costs nothing —
        // the caller can find it in thirty seconds anyway — and it is the
        // difference between a 402 that reads as a wall and one that reads as
        // a choice.
        //
        // This is a link for the HUMAN who reads the error, not a fallback
        // endpoint for the agent to call: /tools is a rendered HTML page and
        // the anti-bot layer 403s non-browser user agents, so an integration
        // that "helpfully" retries against it gets a refusal, not data. Do not
        // turn this into a machine-callable URL without changing that first.
        freeAlternativeUrl: siteLink('/tools'),
    };
}

module.exports = { SITE, UTM, RECHARGE_CREDITS, RECHARGE_PRICE, siteLink, attribution, envelope, quotaError };
