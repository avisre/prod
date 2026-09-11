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

module.exports = { SITE, UTM, siteLink, attribution, envelope };
