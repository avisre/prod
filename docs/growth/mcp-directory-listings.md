# MCP directory listings — draft submission copy

Draft text for four MCP directories. **Nothing here has been submitted.** A
human submits each one manually.

Prerequisite before submitting anywhere: the server has to be reachable. Today
`mcp-server/` runs over **stdio only** and is not deployed. Registries expect
either a published npm package or a public repo people can point their client
at. Decide that first — a listing pointing at nothing gets removed.

Shared facts, kept identical across all four so the listings agree:

- **Canonical name:** `stockportfolio-mcp`
- **Display name:** StockPortfolio.pro — Verified Financial Data
- **Homepage:** https://www.stockportfolio.pro
- **License:** MIT
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

**Name:** `io.github.<owner>/stockportfolio-mcp`
*(fill in the actual GitHub owner before submitting)*

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
**Repo:** *(add public repo URL — required by Glama's quality scoring)*

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
> Install: point your MCP client at `node /path/to/mcp-server/src/server.js`
> with `MCP_API_KEY` in the env. stdio transport.
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

- [ ] Decide how the server is distributed (npm package vs public repo) and fill
      in the repo/package URL in every listing above.
- [ ] Confirm the GitHub owner slug for the Anthropic registry name.
- [ ] Re-read each directory's current submission form; these fields change.
- [ ] Check the coverage caveat survived any editing. It is the one line that
      must not be trimmed for length.
