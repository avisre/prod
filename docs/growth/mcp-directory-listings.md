# MCP directory listings — draft submission copy

Draft text for four MCP directories. **Nothing here has been submitted yet
(9/14).** A human submits each one manually.

**Prerequisites are now cleared, both of them:**
- `stockportfolio-mcp` is **live on npm** (`npx stockportfolio-mcp`), v0.3.1,
  `mcpName: "io.github.avisre/stockportfolio-mcp"` and a `repository` field
  now in `package.json`.
- The server is also reachable with **no install at all**: a hosted Streamable
  HTTP endpoint at `POST https://www.stockportfolio.pro/mcp` (keyless tier: 2
  free asks + 50 lookups/IP/30d, or OAuth 2.1 + DCR for a paying account —
  shipped 9/14). `mcp-server/src/bridge.js` is what the npm package runs
  under the hood; it bridges stdio to that same hosted endpoint.
- **`avisre/stockportfolio-mcp` now exists** (created 9/14, standalone
  `mcp-server/` subtree, leak-gate clean, 11/11 tests pass):
  https://github.com/avisre/stockportfolio-mcp

**Still do not point any listing at `avisre/prod`.** That repo is public and
contains `backend/ai-client.js` and `CLAUDE.md`, which name the AI provider —
the one trade secret this business has. Sending AI-ecosystem discovery traffic
at it would actively worsen that exposure. Every listing below points at the
standalone repo/package instead.

Shared facts, kept identical across all four so the listings agree:

- **Canonical name:** `stockportfolio-mcp`
- **Display name:** StockPortfolio.pro — Verified Financial Data
- **Homepage:** https://www.stockportfolio.pro
- **npm package:** https://www.npmjs.com/package/stockportfolio-mcp
- **Repo:** https://github.com/avisre/stockportfolio-mcp (standalone — see above, NOT avisre/prod)
- **License:** MIT (matches `mcp-server/package.json` and `mcp-server/LICENSE`)
- **Transport:** stdio
- **Tools:** 7 (`sp_financials`, `sp_filing`, `sp_compare`, `sp_screen`,
  `sp_fund`, `sp_ask`, `sp_health`)
- **Auth:** optional API key (`MCP_API_KEY`), per-minute rate limit + persisted
  monthly quota
- **Coverage caveat that must appear in every listing:** US-listed companies
  that report in USD to the SEC. Not global. Say it up front — a listing that
  hides it just earns bad first impressions.

---

## 1. Anthropic MCP registry

**Name:** `io.github.avisre/stockportfolio-mcp`

**Description (one line, ~100 chars):**
> Filing-grounded US financial data — every value returns with its SEC filing source. No estimates.

**Long description:**
> An MCP server for US-listed company fundamentals sourced from SEC filings.
> Seven tools cover period-locked financial statements, the 10-K/10-Q/8-K
> timeline, two-company comparison, watchlist ranking, ETF/mutual-fund profiles,
> a filing-grounded natural-language Ask, and a health probe.
>
> The design rule is that nothing is estimated. Every value keeps its fiscal
> period and the SEC filing URL it came from, and every response ships a citation
> line naming that filing. Where a company has not filed a figure, it comes back
> `null` rather than interpolated — an agent gets a missing value it can reason
> about instead of a plausible wrong one.
>
> Coverage is US-listed companies reporting in USD. No international equities,
> no analyst estimates, no forward data.

**Category:** Finance
**Keywords:** `sec`, `edgar`, `filings`, `financial-data`, `stocks`, `fundamentals`

---

## 2. Glama

**Name:** StockPortfolio.pro — Verified Financial Data

**Tagline:**
> SEC-filing-grounded US company data for agents. Every number links to the filing it came from.

**Description:**
> Wire verified financial data into your agent without adding a hallucination
> surface. `sp_financials` returns period-locked revenue, net income, operating
> and free cash flow, share counts and margins for a US-listed company, each with
> its fiscal period and SEC source URL. `sp_filing` returns the 10-K/10-Q/8-K/
> Form 4 timeline with direct EDGAR links. `sp_compare` puts two companies'
> latest filed annuals side by side without blending periods. `sp_ask` answers a
> research question in English and tells you the source class of the answer
> (filed / fund-data / live-web) rather than presenting all three the same way.
>
> Key-gated, with a per-minute rate limit and a persisted per-key monthly quota.
> `sp_health` reports version, uptime, module readiness and remaining quota, and
> answers even when the quota is spent.
>
> Scope is deliberately narrow: US-listed companies that report in USD. If you
> need global coverage or analyst estimates, this is not the right server.

**Category:** Finance / Data
**Repo:** https://github.com/avisre/stockportfolio-mcp

---

## 3. mcp.so

**Name:** stockportfolio-mcp

**Short description (under 160 chars):**
> SEC-filing-grounded US stock fundamentals for agents. Every value ships with its filing source and period. Missing data stays missing — nothing estimated.

**Description:**
> Seven tools over SEC filing data for US-listed companies: financials,
> filing timeline, two-company comparison, watchlist ranking, fund profiles,
> filing-grounded Ask, and a health check. Every response includes the SEC
> filing URL the values were drawn from.
>
> Install: `npx -y stockportfolio-mcp` (stdio, bridges to the hosted
> endpoint), or point an HTTP-capable client straight at
> `https://www.stockportfolio.pro/mcp` — both keyless (rate-limited) and
> `sp_live_...` key auth work.
>
> Coverage: US-listed, USD-reporting companies only.

**Category:** Finance
**Tags:** `finance`, `sec`, `edgar`, `stocks`, `research`, `data`

---

## 4. Smithery

**Qualified name:** `stockportfolio/verified-financial-data`
**Display name:** Verified Financial Data (StockPortfolio.pro)

**Description:**
> Filing-grounded US company financials for agents. Seven tools — financials,
> filing timeline, compare, screen, funds, Ask, health — each returning the SEC
> filing URL and fiscal period behind every value. Nothing is estimated or
> interpolated; unfiled figures return null.
>
> Includes a persisted per-key monthly quota and a per-minute rate limit, so a
> shared key cannot run away with your compute.

**Config schema to declare on the listing:**

| key | required | default | notes |
|---|---|---|---|
| `MCP_API_KEY` | no | *(unset)* | when unset the server is open — set it for anything shared |
| `MCP_RATE_LIMIT` | no | `30` | calls per minute per key |
| `MCP_MONTHLY_QUOTA` | no | `2000` | calls per key per calendar month |
| `MCP_QUOTA_FILE` | no | `data/quota.json` | quota counter path; must be writable |

**Category:** Finance
**Homepage:** https://www.stockportfolio.pro

---

## Before submitting — checklist for the human

- [x] ~~Decide how the server is distributed~~ — both: npm package
      (`stockportfolio-mcp`) and standalone repo (`avisre/stockportfolio-mcp`),
      done 9/14.
- [x] ~~Confirm the GitHub owner slug~~ — `io.github.avisre/stockportfolio-mcp`,
      now in `package.json`'s `mcpName` field.
- [x] ~~Anthropic registry needs an interactive login~~ — **wrong, and now
      automated.** `avisre/stockportfolio-mcp` carries `server.json` plus
      `.github/workflows/publish-mcp.yml`, which authenticates with **GitHub
      OIDC** (no device flow, no stored token — OIDC also proves the
      `io.github.avisre/*` namespace from the repo itself). Verified on 9/14:
      a real run passed `login` and `validate`.
- [ ] **Publish `stockportfolio-mcp@0.3.1` to npm.** This is the ONLY thing
      still blocking the registry listing. The registry refuses a package whose
      *published* package.json lacks `mcpName`; that field landed in 0.3.1 and
      npm still serves 0.3.0. Its exact words:
      `NPM package 'stockportfolio-mcp' is missing required 'mcpName' field.`
      Needs an npm credential. Then just `gh workflow run publish-mcp.yml`.
- [ ] Glama / mcp.so / Smithery: web-form submissions against a logged-in
      account, so they stay manual. Worth doing the official registry first —
      several aggregators index from it, so one submission may cover more than
      one listing.
- [ ] Check the coverage caveat survived any editing. It is the one line that
      must not be trimmed for length.
