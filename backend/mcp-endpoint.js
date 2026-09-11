'use strict';

// Hosted MCP endpoint — mounted at POST /mcp in app.js using the MCP SDK's
// Streamable HTTP transport (stateless: no session id, no server-initiated
// SSE, since every tool call here is a single request/response). Same 7
// tools as the original stdio dev server (mcp-server/src/server.js, kept
// as-is for local Claude Desktop testing), but:
//   - auth moves from a per-tool-call `apiKey` argument to the standard
//     `Authorization` header, resolved once at the Express route (app.js's
//     apiKeyAuth) before the transport ever sees the request;
//   - metering moves from a local `data/quota.json` file to the same
//     credit_ledger wallet the website account already has (credits.js),
//     via the identity bridge apiKeyAuth establishes;
//   - tool handlers call free-tools.js/asset-profile.js/ai-chat.js directly,
//     in-process — this endpoint lives inside the trusted backend itself, so
//     there's no external distribution boundary to protect the way the
//     stdio version had to reason about.
//
// Built as a factory, not a module-level singleton: app.js builds a fresh
// Server per request (stateless transport, so this is cheap) and closes it
// over that request's already-resolved user/tier so tool handlers never
// need to re-derive identity.

const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const freeTools = require('./free-tools');
const assetProfile = require('./asset-profile');
const { envelope } = require('./api-response');

const SERVER_VERSION = '1.0.0';

const TOOL_DEFS = [
    {
        name: 'sp_financials',
        title: 'Filing-grounded financials (deterministic)',
        description: 'Return period-locked filing figures for one ticker (revenue, net income, OCF, FCF, shares, margins). Missing data stays missing — never estimated.',
        inputSchema: {
            type: 'object',
            properties: {
                ticker: { type: 'string', description: 'US ticker, e.g. NVDA, AAPL' },
                tool: { type: 'string', description: 'free-tool slug: earnings-quality, dilution, filing-timeline, buybacks-vs-dilution, revenue-consistency, profitability-trend, cash-flow-quality, free-cash-flow-trend, debt-snapshot, etc.', default: 'earnings-quality' },
            },
            required: ['ticker'],
        },
    },
    {
        name: 'sp_filing',
        title: 'SEC filing timeline',
        description: 'Browse recent 10-K/10-Q/8-K/Form 4 with dates and direct EDGAR links.',
        inputSchema: { type: 'object', properties: { ticker: { type: 'string' } }, required: ['ticker'] },
    },
    {
        name: 'sp_compare',
        title: 'Company compare (two tickers, filing-grounded)',
        description: 'Side-by-side revenue, margins, cash flow and shares for two US companies from their latest filed annuals.',
        inputSchema: { type: 'object', properties: { tickers: { type: 'string', description: "Two tickers comma-separated, e.g. 'AAPL,MSFT'" } }, required: ['tickers'] },
    },
    {
        name: 'sp_screen',
        title: 'Screener (rank by filed numbers)',
        description: 'Rank up to ten tickers by filed revenue growth.',
        inputSchema: { type: 'object', properties: { tickers: { type: 'string', description: 'Comma-separated watchlist, max 10' } }, required: ['tickers'] },
    },
    {
        name: 'sp_fund',
        title: 'ETF/mutual-fund profile (labelled fund data)',
        description: 'ETF/mutual-fund costs, holdings, allocation, performance and risk. Yahoo-derived, not SEC company data; not redistributable.',
        inputSchema: { type: 'object', properties: { symbol: { type: 'string', description: 'Fund symbol, e.g. SPY, VOO' } }, required: ['symbol'] },
    },
    {
        name: 'sp_ask',
        title: 'Filing-grounded Ask (AI, but sourced)',
        description: "Ask a US stock/fund question. Returns the answer plus its source class (filed / fund-data / live-web). Prefer sp_financials/sp_filing when you need numbers only.",
        inputSchema: { type: 'object', properties: { question: { type: 'string' } }, required: ['question'] },
    },
    {
        name: 'sp_health',
        title: 'Health check',
        description: 'Liveness probe: server version and tool count. Safe to call before any other tool; does not consume quota.',
        inputSchema: { type: 'object', properties: {} },
    },
];

function textResult(payload, isError) {
    const out = { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] };
    if (isError) out.isError = true;
    return out;
}

// Builds one MCP Server bound to an already-authenticated caller. `ctx`
// carries exactly what apiKeyAuth resolved: userId, user (Mongoose doc),
// tier, subscription. `deps` carries the app.js functions this module can't
// require directly without a cycle.
function buildMcpServer(ctx, deps) {
    const { credits, effectiveAskLimit, aiChat } = deps;
    const server = new Server({ name: 'stockportfolio-mcp', version: SERVER_VERSION }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));

    server.setRequestHandler(CallToolRequestSchema, async (req) => {
        const { name, arguments: args = {} } = req.params;
        try {
            if (name === 'sp_health') {
                return textResult({ tool: 'health', status: 'ok', version: SERVER_VERSION, toolCount: TOOL_DEFS.length, generatedAt: new Date().toISOString() });
            }

            const cost = name === 'sp_ask' ? 'mcp_ask' : 'mcp_lookup';
            const planId = ctx.subscription && ctx.subscription.planId;
            const gate = await credits.check(ctx.userId, cost, effectiveAskLimit({ tier: ctx.tier, user: ctx.user }), planId, ctx.user);
            if (!gate.ok) {
                return textResult({ error: `Out of credits for this month (used ${gate.used}/${gate.allowance}). Resets ${gate.resetsAt}.`, code: 'QUOTA_EXCEEDED' }, true);
            }

            if (name === 'sp_financials') {
                const ticker = freeTools.normalizeSymbol(args.ticker);
                if (!ticker) return textResult({ error: 'Invalid ticker.' }, true);
                const slugs = new Set(Object.keys(freeTools.TOOL_DEFINITIONS));
                const requested = String(args.tool || 'earnings-quality').trim().toLowerCase();
                const slug = slugs.has(requested) ? requested : 'earnings-quality';
                const { status, body } = await freeTools.getToolResult(slug, ticker);
                if (status !== 200) return textResult({ error: body.error }, true);
                await credits.spend(ctx.userId, cost, `mcp:${slug}`, ticker);
                return textResult(envelope(slug, ticker, body));
            }

            if (name === 'sp_filing') {
                const ticker = freeTools.normalizeSymbol(args.ticker);
                if (!ticker) return textResult({ error: 'Invalid ticker.' }, true);
                const { status, body } = await freeTools.getToolResult('filing-timeline', ticker);
                if (status !== 200) return textResult({ error: body.error }, true);
                await credits.spend(ctx.userId, cost, 'mcp:filing-timeline', ticker);
                return textResult(envelope('filing-timeline', ticker, body));
            }

            if (name === 'sp_compare') {
                const raw = String(args.tickers || '');
                const { status, body } = await freeTools.getToolResult('company-comparison', raw);
                if (status !== 200) return textResult({ error: body.error }, true);
                await credits.spend(ctx.userId, cost, 'mcp:company-comparison', raw);
                return textResult(envelope('company-comparison', raw.toUpperCase(), body));
            }

            if (name === 'sp_screen') {
                const raw = String(args.tickers || '');
                if (!raw.trim()) return textResult({ note: "Pass tickers='AAPL,MSFT,NVDA' (max 10) to rank by filed revenue growth." });
                const { status, body } = await freeTools.getToolResult('portfolio-revenue', raw);
                if (status !== 200) return textResult({ error: body.error }, true);
                await credits.spend(ctx.userId, cost, 'mcp:portfolio-revenue', raw);
                return textResult(envelope('portfolio-revenue', raw.toUpperCase(), body));
            }

            if (name === 'sp_fund') {
                const symbol = freeTools.normalizeSymbol(args.symbol);
                if (!symbol) return textResult({ error: 'Invalid fund symbol.' }, true);
                let profile;
                try { profile = await assetProfile.fetchAssetProfile(symbol); }
                catch (_) { return textResult({ error: 'Fund profile is temporarily unavailable.' }, true); }
                if (!profile || !assetProfile.isFundAsset(profile.assetType)) {
                    return textResult({ error: `${symbol} is not an ETF or mutual fund.` }, true);
                }
                await credits.spend(ctx.userId, cost, 'mcp:fund', symbol);
                return textResult({
                    tool: 'fund', symbol, generatedAt: new Date().toISOString(), profile,
                    source: { type: 'fund-data', url: profile.source || null, note: 'Fund data via Yahoo fund profiles — not company SEC 10-K/10-Q. Not redistributable; informational use only.' },
                });
            }

            if (name === 'sp_ask') {
                const question = String(args.question || '').trim();
                if (!question) return textResult({ error: 'Missing question.' }, true);
                const result = await aiChat.ask({ question, history: [], ctx: { holdings: [] } }).catch((e) => ({ error: e.message }));
                if (result && result.error) return textResult({ error: result.error }, true);
                await credits.spend(ctx.userId, cost, 'mcp:ask');
                return textResult({
                    tool: 'ask', question, answer: result.answer || result.text || result.body,
                    generatedAt: new Date().toISOString(),
                    source: { type: result.sourceClass || result.source || 'filed', note: 'Verify figures in the cited SEC filing before acting. Not investment advice.' },
                });
            }

            return textResult({ error: `Unknown tool: ${name}` }, true);
        } catch (err) {
            return textResult({ error: String(err.message || err) }, true);
        }
    });

    return server;
}

// One-shot request handler for the stateless POST /mcp route: builds a
// fresh Server + Transport bound to this caller, connects, handles the
// single request, then tears both down when the response finishes — no
// state survives between calls, matching the SDK's stateless-mode contract.
async function handleMcpRequest(req, res, ctx, deps) {
    const server = buildMcpServer(ctx, deps);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
}

module.exports = { TOOL_DEFS, buildMcpServer, handleMcpRequest };
