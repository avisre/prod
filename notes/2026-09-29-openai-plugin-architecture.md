# OpenAI plugin (remote MCP) — architecture note, 2026-09-29

Internal note written before the change, per the OpenAI-plugin task. Facts below
were read out of the repo, not assumed.

## What already exists (do not duplicate)

| Layer | Where | Notes |
|---|---|---|
| Backend | Express 4 (`backend/app.js`, ~15k lines) on Render, behind Cloudflare | `www.stockportfolio.pro`, single service `srv-d4kc6schg0os73al6t10` |
| Deploy | `.github/workflows/deploy-render.yml` on push to `main` | Calls Render API directly; `[skip ci]` in the message skips it |
| Public REST API | `backend/public-api.js` at `/api/v1` | API key via `api-keys.js`, spends `credits.js` wallet |
| Hosted MCP (v1) | `backend/mcp-endpoint.js` at `POST /mcp`, 7 `sp_*` tools | Stateless Streamable HTTP, `@modelcontextprotocol/sdk@1.30.0`; consumed by the published npm bridge `mcp-server/` and the Claude plugin/connector |
| Keyless trial | `backend/mcp-anon.js` | per-IP allowance (2 asks / 50 lookups / 30d) + global ask ceiling |
| OAuth 2.1 + DCR | `backend/oauth-mcp.js` + routes in `app.js` | Public clients, PKCE S256, opaque SHA-256-hashed tokens, refresh rotation, RFC 9728 + RFC 8414 discovery |
| Entitlement | `hasApiAccess()` (`app.js:161`) | Power/Desk/Dev plus top LTD tier + grandfathered cohort |
| Deterministic data | `backend/free-tools.js`, `backend/fundamentals-fetch.js`, `frontend/data/fundamentals/*.json` | 6,042 symbol files, annual + quarterly income/balance/cash rows, `overview` (CIK/exchange/currency) |
| SEC filings | `backend/watchdog.js` (`fetchRecentFilings`, `fetchFilingsDeep`), `backend/sec-source.js` (XBRL companyfacts + backfill), `backend/filing-fetcher.js` (`filing_text` Mongo cache), `backend/filing-sections.js` (10-K/20-F section extractor) | |
| Filing timeline tool | `sp_filing` / `free-tools.filingTimeline` | form, date, EDGAR URL; no accession/report-date/description |
| Rate limits | `apiKeyRateLimit` 60/min per key, `anonMcpRateLimit` 20/min per IP | express-rate-limit |

## Current OpenAI requirements (read 2026-09-29, `developers.openai.com/plugins/*.md`)

- Plugin = remote MCP server, submitted **With MCP** at `platform.openai.com/plugins`; `Scan Tools` imports tool metadata from the live endpoint.
- Every tool needs name, title, description, input schema, output schema where structured data is returned, and **accurate `readOnlyHint` / `destructiveHint` / `openWorldHint`** with a written justification.
- Structured results: return `structuredContent` and the same object JSON-encoded in `content`.
- OAuth 2.1 for authenticated servers: protected-resource metadata, AS metadata, PKCE S256, `resource` echoed through the flow and enforced as audience, scope enforcement, short-lived tokens.
- Commerce: plugins may **not** display plans, promote upgrades, or link to checkout/upgrade. Entitlement failures must be explained without a purchase path.
- Domain verification: exact token at `https://<mcp-host>/.well-known/openai-apps-challenge`, plain text only.
- Demo account: no MFA/SMS/email-OTP, works off-network, entitled for every tool.
- Tool responses must not carry timestamps, session/trace/request IDs, debug payloads, or unneeded personal data.

## Decisions

1. **Keep `/mcp` as the shipping v1 `sp_*` contract** (npm bridge, Claude plugin/connector use it). Add the OpenAI Apps surface at **`POST /mcp/apps`** — same auth, metering and data modules, different tool contract. The task allows a non-`/mcp` path when the existing architecture makes `/mcp` inappropriate; silently renaming a published tool surface would break live consumers.
2. **Tool set on `/mcp/apps`** (7, intent-based, read-only):
   `search_companies`, `get_company_financials`, `get_metric_history`,
   `search_filings`, `get_filing_content`, `compare_company_metrics`,
   `get_financial_change_drivers`.
   No trading, no portfolio writes, no AI-written answers (`sp_ask` stays off this surface), no fund data.
3. **Data path**: normalized fundamentals files (instant) + a Mongo/memory-cached SEC filing index (`data.sec.gov/submissions`) that maps each fiscal period to the actual accession/filing URL. Diluted weighted-average shares come from SEC XBRL `companyconcept` (cached), because the fundamentals cache has no share-count history. `get_filing_content` reuses `filing-fetcher`/`filing-sections` and the `filing_text` cache.
4. **Honesty**: the filing link is labelled `linkage: "filing_period"` (the filing that reports this fiscal period) unless the value came from a SEC XBRL fact with its own accession (`linkage: "xbrl_fact"`). Missing values stay null; nothing is estimated.
5. **Auth**: existing OAuth server, extended with scopes `financials:read` / `filings:read` / `research:read`, `resource` validation, and per-tool scope enforcement. Keyless trial stays (reviewers can exercise the tools without credentials); an entitled demo account is prepared separately for portal credentials.
6. **Commerce**: `/mcp/apps` entitlement errors say only that the capability is not included in the connected account — no plan names, prices, checkout or upgrade links. No purchase surface of any kind.
7. **Domain challenge**: `GET /.well-known/openai-apps-challenge` returns `OPENAI_APPS_CHALLENGE` verbatim as plain text when set; unset returns 404. No fake token committed.

## Files

- `backend/mcp-financials.js` — data layer (search, metric catalog, series, filing index, share history, filing text/sections, comparison, drivers)
- `backend/mcp-apps.js` — tool definitions + server factory for `/mcp/apps`
- `app.js` — routes, challenge endpoint, OAuth metadata/scopes/resource
- `oauth-mcp.js` — scope/resource on codes and tokens
- `backend/test/mcp-financials.test.js`, `backend/test/mcp-apps.test.js`
- `OPENAI_PLUGIN_SUBMISSION.md` — submission package
