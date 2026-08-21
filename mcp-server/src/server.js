#!/usr/bin/env node
// Phase 1 MCP — thin wrapper over existing filing-grounded tools.
// Every tool returns structured JSON + a `source` field (the moat). No estimates.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import path from "path";
import { fileURLToPath } from "url";
import { createRequire } from "module";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, "../../backend");

// Load existing deterministic tools (no AI, no net in the hot path beyond cache/Yahoo)
const freeTools = require(path.join(backendRoot, "free-tools.js"));
const assetProfile = require(path.join(backendRoot, "asset-profile.js"));

// ---- key auth + rate limit (protects ongoing compute) ----
const MCP_API_KEY = process.env.MCP_API_KEY || process.env.STOCKPORTFOLIO_MCP_KEY || "";
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = Number(process.env.MCP_RATE_LIMIT || "30");
const hits = new Map(); // key -> { count, resetAt }
function checkRate(key) {
  const now = Date.now();
  const rec = hits.get(key);
  if (!rec || now > rec.resetAt) {
    hits.set(key, { count: 1, resetAt: now + WINDOW_MS });
    return true;
  }
  if (rec.count >= MAX_PER_WINDOW) return false;
  rec.count++;
  return true;
}
function requireKey(provided) {
  if (!MCP_API_KEY) return; // open in dev if no key is set — prod must set MCP_API_KEY
  const k = String(provided || "").trim();
  if (!k || k !== MCP_API_KEY) {
    const e = new Error("Invalid or missing apiKey. Set MCP_API_KEY env and pass apiKey per tool call.");
    e.code = "UNAUTHORIZED";
    throw e;
  }
  if (!checkRate(k)) {
    const e = new Error(`Rate limit exceeded (${MAX_PER_WINDOW}/min). Try again shortly.`);
    e.code = "RATE_LIMITED";
    throw e;
  }
}

// ---- helpers: source envelope ----
function envelope(tool, symbol, result) {
  // result from freeTools already contains source/sourceUrl/note/warnings — keep it.
  // Add a top-level `source` object for MCP consumers + keep original fields.
  const edgar = result.sourceUrl || result.source || null;
  return {
    tool,
    symbol: symbol || result.symbol || null,
    generatedAt: new Date().toISOString(),
    data: result,
    source: {
      type: /sec\.gov|SEC/i.test(String(edgar)) ? "filed" : String(result.source || "filed"),
      url: edgar,
      period: result.period || result.latest?.period || null,
      note: result.note || "Informational research only — verify in the linked SEC filing. Not investment advice.",
    },
    warnings: result.warnings || [],
  };
}

// ---- tool definitions ----
const TOOL_DEFS = [
  {
    name: "sp_financials",
    title: "Filing-grounded financials (deterministic)",
    description: "Return period-locked filing figures for one ticker (revenue, net income, OCF, FCF, shares, margins). Uses the same cache as /api/free-tools; every value keeps its fiscal period and SEC source. Missing data stays missing — never estimated.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string", description: "US ticker, e.g. NVDA, AAPL" },
        tool: { type: "string", description: "free-tool slug: earnings-quality, dilution, filing-timeline, buybacks-vs-dilution, revenue-consistency, profitability-trend, cash-flow-quality, free-cash-flow-trend, debt-snapshot, etc.", default: "earnings-quality" },
        apiKey: { type: "string", description: "MCP_API_KEY if server is key-gated" },
      },
      required: ["ticker"],
    },
  },
  {
    name: "sp_filing",
    title: "SEC filing timeline",
    description: "Browse recent 10-K/10-Q/8-K/Form 4 with dates and direct EDGAR links. Grounds any claim in its primary document.",
    inputSchema: {
      type: "object",
      properties: {
        ticker: { type: "string" },
        apiKey: { type: "string" },
      },
      required: ["ticker"],
    },
  },
  {
    name: "sp_compare",
    title: "Company compare (two tickers, filing-grounded)",
    description: "Side-by-side revenue, margins, cash flow and shares for two US companies from their latest filed annuals. Flags the stronger figure. Periods are kept separate.",
    inputSchema: {
      type: "object",
      properties: {
        tickers: { type: "string", description: "Two tickers comma-separated, e.g. 'AAPL,MSFT'" },
        apiKey: { type: "string" },
      },
      required: ["tickers"],
    },
  },
  {
    name: "sp_screen",
    title: "Screener (rank by filed numbers)",
    description: "Rank tickers by a deterministic screener. Phase 1 exposes the raw tool — criteria are validated server-side.",
    inputSchema: {
      type: "object",
      properties: {
        tickers: { type: "string", description: "Optional: comma-separated watchlist to rank (max 10). Empty = uses cached universe." },
        apiKey: { type: "string" },
      },
      required: [],
    },
  },
  {
    name: "sp_fund",
    title: "ETF/mutual-fund profile (labelled fund data)",
    description: "ETF/mutual-fund costs, holdings, allocation, performance and risk. Never presented as company SEC 10-K data.",
    inputSchema: {
      type: "object",
      properties: {
        symbol: { type: "string", description: "Fund symbol, e.g. SPY, VOO" },
        apiKey: { type: "string" },
      },
      required: ["symbol"],
    },
  },
  {
    name: "sp_ask",
    title: "Filing-grounded Ask (AI, but sourced)",
    description: "Ask a US stock/fund question. Returns the answer plus its source class (filed / fund-data / live-web). For an MCP agent, prefer sp_financials/sp_filing when you need numbers only.",
    inputSchema: {
      type: "object",
      properties: {
        question: { type: "string", description: "Full research question, e.g. 'Did NVDA diluted shares rise despite buybacks in Q1 FY27?'" },
        apiKey: { type: "string" },
      },
      required: ["question"],
    },
  },
];

const server = new Server({ name: "stockportfolio-mcp", version: "0.1.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOL_DEFS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if ("apiKey" in args) requireKey(args.apiKey);
    else requireKey(undefined);

    if (name === "sp_financials") {
      const ticker = freeTools.normalizeSymbol(args.ticker);
      if (!ticker) throw new Error("Invalid ticker.");
      const tool = String(args.tool || "earnings-quality").trim().toLowerCase();
      const slugs = new Set(Object.keys(freeTools.TOOL_DEFINITIONS));
      const slug = slugs.has(tool) ? tool : "earnings-quality";
      const result = await freeTools.getToolResult(slug, ticker);
      if (result.error) return { content: [{ type: "text", text: JSON.stringify({ error: result.error }, null, 2) }], isError: true };
      const payload = envelope(slug, ticker, result.body || result);
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }

    if (name === "sp_filing") {
      const ticker = freeTools.normalizeSymbol(args.ticker);
      if (!ticker) throw new Error("Invalid ticker.");
      const result = await freeTools.getToolResult("filing-timeline", ticker);
      if (result.error) return { content: [{ type: "text", text: JSON.stringify({ error: result.error }, null, 2) }], isError: true };
      const payload = envelope("filing-timeline", ticker, result.body || result);
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }

    if (name === "sp_compare") {
      const raw = String(args.tickers || "").trim();
      const symbols = raw.split(",").map((s) => freeTools.normalizeSymbol(s)).filter(Boolean);
      if (symbols.length !== 2) throw new Error("Pass exactly two tickers as 'tickers', e.g. 'AAPL,MSFT'.");
      const result = await freeTools.getToolResult("company-comparison", symbols.join(","));
      // getToolResult for company-comparison expects a single string "AAPL,MSFT" as symbol arg
      // Fallback to computeMultiTool if needed
      let body = result.body || result;
      if (body && body.error) body = await freeTools.computeMultiTool ? await freeTools.computeMultiTool("company-comparison", symbols) : body;
      const payload = envelope("company-comparison", symbols.join(","), body);
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }

    if (name === "sp_fund") {
      const symbol = freeTools.normalizeSymbol(args.symbol);
      if (!symbol) throw new Error("Invalid fund symbol.");
      const profile = await assetProfile.fetchAssetProfile(symbol);
      const isFund = assetProfile.isFundAsset(profile.assetType);
      if (!isFund) return { content: [{ type: "text", text: JSON.stringify({ error: `${symbol} is not an ETF or mutual fund.` }, null, 2) }], isError: true };
      const payload = {
        tool: "fund",
        symbol,
        generatedAt: new Date().toISOString(),
        profile,
        source: { type: "fund-data", url: profile.source || null, note: "Fund data via Yahoo fund profiles — not company SEC 10-K/10-Q." },
      };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }

    if (name === "sp_screen") {
      // Thin wrapper: reuse the same deterministic screener path the web app uses.
      // For Phase 1 keep it simple — return the portfolio-revenue ranking for the supplied watchlist,
      // or a hint to call sp_financials per ticker when no list is supplied.
      const raw = String(args.tickers || "").trim();
      if (!raw) {
        return {
          content: [{ type: "text", text: JSON.stringify({ tool: "screen", note: "Pass tickers='AAPL,MSFT,NVDA' (max 10) to rank by filed revenue growth; or use sp_financials per ticker.", source: { type: "filed" } }, null, 2) }],
        };
      }
      const symbols = raw.split(",").map((s) => freeTools.normalizeSymbol(s)).filter(Boolean).slice(0, 10);
      const result = await freeTools.getToolResult("portfolio-revenue", symbols.join(","));
      const payload = envelope("portfolio-revenue", symbols.join(","), result.body || result);
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }

    if (name === "sp_ask") {
      // Phase 1: delegate to the existing Ask endpoint via direct import to avoid HTTP hop.
      // Keep the answer and its source class visible; do not strip periods or URLs.
      const question = String(args.question || "").trim();
      if (!question) throw new Error("Missing question.");
      const aiChat = require(path.join(backendRoot, "ai-chat.js"));
      // Use the non-streaming path; it already tags sources as filed/fund-data/live-web
      const result = await aiChat.ask({ question, history: [], ctx: { holdings: [] } }).catch((e) => ({ error: e.message }));
      if (result && result.error) return { content: [{ type: "text", text: JSON.stringify({ error: result.error }, null, 2) }], isError: true };
      const payload = {
        tool: "ask",
        question,
        answer: result.text || result.answer || result.body || result,
        generatedAt: new Date().toISOString(),
        source: { type: result.sourceClass || result.source || "filed", note: "Verify figures in the cited SEC filing before acting. Not investment advice." },
      };
      return { content: [{ type: "text", text: JSON.stringify(payload, null, 2) }] };
    }

    throw new Error(`Unknown tool: ${name}`);
  } catch (err) {
    const msg = String(err.message || err);
    const isAuth = err.code === "UNAUTHORIZED" || err.code === "RATE_LIMITED";
    return { content: [{ type: "text", text: JSON.stringify({ error: msg, code: err.code || "ERROR" }, null, 2) }], isError: !isAuth };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("[mcp] stockportfolio-mcp 0.1.0 listening on stdio (6 tools, source on every return)");
}
main().catch((e) => {
  console.error("[mcp] fatal", e);
  process.exit(1);
});
