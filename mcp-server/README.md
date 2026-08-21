# Verified Financial Data MCP Server (Phase 1)

> Wire **verified, filing-grounded** stock numbers into your own agents — every value ships with its SEC source.

Thin wrapper over `backend/free-tools.js` + `asset-profile.js` + `ai-chat.js`. Numbers come from the same cache as the web app; nothing is re-estimated.

## Tools (6, small + rock-solid)

| tool | what | source |
|------|------|--------|
| `sp_financials(ticker, tool?)` | `earnings-quality` (default), `dilution`, `buybacks-vs-dilution`, `filing-timeline`, etc. | `sec.gov` + XBRL period |
| `sp_filing(ticker)` | 10-K/10-Q/8-K timeline | EDGAR |
| `sp_compare(tickers="AAPL,MSFT")` | side-by-side filed annuals | filed |
| `sp_screen(tickers="AAPL,MSFT…")` | ranking for a watchlist (max 10) | filed |
| `sp_fund(symbol)` | ETF/MF costs/holdings/allocation | fund-data |
| `sp_ask(question)` | filing-grounded answer + source class | `filed / fund-data / live-web` |

Every return includes `source: { type, url, period, note }` and `warnings` where the filing is incomplete. Missing data stays `null`.

## Run

```bash
cd mcp-server
npm install
MCP_API_KEY=your-key node src/server.js  # stdio
```

In Claude Desktop / Cursor (`~/.config/Claude/claude_desktop_config.json`):
```json
{
  "mcpServers": {
    "stockportfolio": {
      "command": "node",
      "args": ["/absolute/path/to/mcp-server/src/server.js"],
      "env": { "MCP_API_KEY": "…same key you hand to nl8/buyers…" }
    }
  }
}
```

Test in an agent: "Use sp_financials for NVDA with tool buybacks-vs-dilution and show the period + source."

## Auth + limits

- Key gate: set `MCP_API_KEY` in env; every tool call checks `apiKey` arg (when the var is set). Leave unset for local dev.
- Rate limit: `MCP_RATE_LIMIT` per minute per key (default 30). Returns `RATE_LIMITED`.
- Hard cap: keep a higher tier (Founding Integrator) with bounded calls/month; this STDIO server is the thin layer — the HTTP API (Phase 2) will enforce per-key quotas.

## What this is not (Phase 2/3)

Compound alerts, MD/PDF export — ship only after Phase 1 is selling. No estimates, no recommendations.
