# OpenAI plugin submission package — StockPortfolio.pro

Status: **deployed to production and verified live (2026-09-29, deploy run 36481252026).**
Automated tests are green, the production endpoint passed
`scripts/verify-mcp-apps.js` 17/17 with an entitled credential, and the official
MCP Inspector reports zero strict-mode schema findings against the live server.
The remaining steps are owner-only: the OpenAI Platform identity/Apps Management
role, the domain-verification token, the reviewer account, and the portal form
itself (§12).

---

## 0. The uploaded package

`openai-plugin/` is the artifact uploaded through **Create plugin → With MCP**,
built by `scripts/build-openai-plugin.sh` into `openai-plugin.zip`. It follows
the Agent Plugins portable format (`plugin.json` + `mcp.json` at the archive
root) because the review and listing metadata travel **inside the ZIP**: the
portal imports them on upload, and imported test cases are read-only in the
dashboard afterwards, so the package — not the form — is the source of truth.
Where §7–§9 below disagree with `plugin.json`, the package wins.

```
openai-plugin/
├── plugin.json    identity, listing fields, review cases, release notes
├── mcp.json       mcpServers.stockportfolio → https://www.stockportfolio.pro/mcp/apps
└── assets/        logo.png, composer-icon.png (square, ≥48×48)
```

The two assets are both 512×512 PNGs with a transparent background. The brand
mark is a red bull (`#EB1D1E`) on transparency, supplied by the owner as a
1254×1254 master; the assets are that master scaled down, so the framing is the
owner's own and the mark composites correctly on light and dark surfaces alike.
`scripts/build-openai-plugin.sh` checks only what the uploader enforces — square
and at least 48×48 — so a replacement must be checked by eye as well.

Decisions worth knowing before editing it:

- **No `skills/`.** A skill requirement applies only to a *skills-only* ZIP
  (`archive_plugin_files_missing`). Tool-selection guidance already lives in the
  tool descriptions, so a bundled skill would add a second scan gate (up to two
  hours) for no behaviour the reviewer would observe.
- **`review.test_cases` is declared at plugin level**, which requires exactly one
  MCP server — true here. The alternative, per-server declarations, cannot be
  combined with it.
- **Exactly five positive and three negative cases.** The six positives and four
  negatives drafted in §8–§9 had to be cut. `get_metric_history` was the one
  dropped: its honest `value: null` for a fiscal fourth quarter is correct
  behaviour but reads as a broken result to a reviewer comparing against an
  expectation, and "a test case did not produce correct results" is a named
  rejection reason. It is still reachable, just not submitted as a case.
- **Starter prompts are cut from five in §7 to three** — the submission limit is
  three (`defaultPrompt`, ≤128 characters each).
- **`commerce: false`** with a description that says plainly that nothing is sold
  in ChatGPT and the website subscription is not surfaced by the plugin.
- **Reviewer credentials are deliberately absent** — ZIP metadata rejects
  `test_credentials` and `reviewer_instructions`. They go in **Review details**.
- **`demo_recording_url` must live in the ZIP, not the dashboard.** Step 5 of the
  review dialog states it verbatim: *"Add a video walkthrough URL to
  `extensions.com.openai.review.demo_recording_url` in plugin.json, then upload
  your plugin ZIP again before submitting for review."* There is no dashboard
  field for it. It is **set** as of 10/01:
  `https://www.stockportfolio.pro/assets/plugin-walkthrough.mp4`. Because the URL
  changed the manifest, the ZIP must still be uploaded once more, and the
  dashboard's reviewer credentials re-checked afterwards.
- **The recording is a real session, not a staged screen capture.**
  `scripts/record-mcp-walkthrough.mjs` runs `initialize`, `tools/list` and the
  five positive review cases against production at record time, bakes the live
  responses into a local page, and captures that page over the Chrome DevTools
  Protocol: 63s, 1280×688, 2.2 MB. Every figure on screen is a filed value and
  the video dates itself, so a reviewer watching it sees the same numbers their
  own test run returns. The Authorization header is never rendered, so the
  recording cannot leak the credential it was made with. Re-record with
  `node scripts/record-mcp-walkthrough.mjs`; the mp4 commit must **not** carry
  the skip marker, since `frontend-v2/assets/` is served from the deployed
  filesystem.

---

## 1. Production MCP server

| Field | Value |
|---|---|
| MCP Server URL (Universal) | `https://www.stockportfolio.pro/mcp/apps` |
| Transport | MCP Streamable HTTP, stateless (one POST per JSON-RPC message) |
| SDK | `@modelcontextprotocol/sdk` 1.30.0 |
| Host note | `www` is required. The apex `stockportfolio.pro` answers 307 → `www`, and a cross-host redirect drops the `Authorization` header, so the apex must never be entered in the portal. |
| A dedicated `api.stockportfolio.pro` hostname | Not used. There is no DNS record for it and adding one requires the owner's DNS access. `www` is the existing production origin with stable HTTPS, OAuth discovery and deploy automation. |

The shipping `https://www.stockportfolio.pro/mcp` endpoint (7 `sp_*` tools) is left
unchanged for the published npm bridge and the Claude connector. `/mcp/apps` is a
second, OpenAI-shaped tool contract over the same authentication, metering and
data modules — see `notes/2026-09-29-openai-plugin-architecture.md`.

## 2. Publisher and public URLs

| Field | Value |
|---|---|
| Plugin name | `StockPortfolio.pro` |
| Publisher identity | Must be the owner's **verified individual or business identity** in the OpenAI Platform, publishing as `StockPortfolio.pro`. Select it in the form's **Developer Identity** field; the site, privacy, terms and support pages all use this name. |
| Website | `https://www.stockportfolio.pro/` |
| Privacy policy | `https://www.stockportfolio.pro/privacy` |
| Terms of service | `https://www.stockportfolio.pro/terms` |
| Support | `https://www.stockportfolio.pro/support` (email `support@stockportfolio.pro`) |
| Category | Finance / research (choose the closest current portal value) |

`/privacy`, `/terms` and `/support` are additionally exempted from the site's
scraper wall (`backend/bot-blocker.js`) so a reviewer's header-less fetch can
read them; the rest of the site is unchanged.

## 3. Authentication

- **OAuth 2.1 authorization-code flow with PKCE S256**, dynamic client
  registration (RFC 7591), public clients (`token_endpoint_auth_method: none`).
- Protected-resource metadata (RFC 9728):
  `GET https://www.stockportfolio.pro/.well-known/oauth-protected-resource/mcp/apps`
  → `resource: https://www.stockportfolio.pro/mcp/apps`.
- Authorization-server metadata (RFC 8414):
  `GET https://www.stockportfolio.pro/.well-known/oauth-authorization-server`
  → `S256`, `registration_endpoint`, `token_endpoint_auth_methods_supported: ["none"]`.
- **Scopes** (read-only; there is no write scope):

| Scope | Tools |
|---|---|
| `financials:read` | `search_companies`, `get_company_financials`, `get_metric_history` |
| `filings:read` | `search_filings`, `get_filing_content` |
| `research:read` | `compare_company_metrics`, `get_financial_change_drivers` |

  A legacy `mcp` scope (issued before scopes existed) is treated as consent to
  all three. Tokens carry the RFC 8707 `resource` they were minted for and are
  rejected on the other MCP endpoint.
- **Tokens**: opaque 256-bit random strings, stored only as SHA-256 hashes;
  access tokens live 1 hour, refresh tokens 90 days with rotation and immediate
  revocation. A password change, a password reset, `POST
  /api/account/connected-apps/revoke`, or account deletion revokes every
  connected assistant.
- **Keyless trial**: the endpoint also answers unauthenticated calls under a
  per-visitor allowance (25 data lookups / 30 days, 20 requests/minute). A
  reviewer can exercise every tool without credentials; the demo account below
  is still supplied because an authenticated connection is how the plugin is
  used in production.

## 4. Demo/reviewer account

The account is provisioned by the owner against production Atlas (it cannot be
self-serve: signup starts on the free plan with no API/MCP entitlement).

```bash
# Dry run — prints what it would write, changes nothing:
MONGODB_URI="<production Atlas URI>" \
  node scripts/create-openai-reviewer.js --email <reviewer-address>

# Apply — creates or resets the account and prints the password once:
MONGODB_URI="<production Atlas URI>" \
  node scripts/create-openai-reviewer.js --email <reviewer-address> --apply
```

- Entitlement written: `dev` / `active` (API + MCP access, 200 credits/month).
- No MFA, no SMS, no email OTP, no invitation, no IP restriction; login is
  email + password on the standard account system.
- The password is generated per run, printed once, and never stored in the repo
  or in this document. Enter it in the portal's credentials field.
- Keep the account for the whole review; re-running with `--apply` rotates the
  password if it is ever lost, but the portal fields must then be updated.

## 5. Tools

Seven read-only tools. No trading, brokerage, transfer, portfolio-write,
message-sending, payment or subscription action exists on this surface.

| # | Name | Purpose |
|---|---|---|
| 1 | `search_companies` | Resolve a company name or ticker to a US-listed company (ticker, name, SEC CIK, sector, index, exchange). Prevents ticker ambiguity before data calls. |
| 2 | `get_company_financials` | Standardized historical metrics for one company (revenue, profit, margins, EPS, shares, cash flow, capex, free cash flow, cash, debt, stock-based compensation), annual or quarterly, with the SEC filing that reports each period. |
| 3 | `get_metric_history` | One metric as a chronological series (for example diluted weighted-average shares over eight quarters). |
| 4 | `search_filings` | Find SEC filings by company, form and date range; returns form, filing date, reporting period, accession number, SEC description and a direct SEC URL. |
| 5 | `get_filing_content` | Relevant excerpts from one filing: a named section (Risk Factors, MD&A, Business, Legal Proceedings…) or a search term, with the section each excerpt came from. Never returns the whole document. |
| 6 | `compare_company_metrics` | Two to five companies on the same standardized metrics, period-labelled and source-linked. |
| 7 | `get_financial_change_drivers` | The reported arithmetic bridge for a period-over-period change, including the split of an EPS change into net-income and share-count effects. |

Full descriptions, input and output schemas are served by `tools/list` from the
live endpoint and imported by **Scan Tools**. Source: `backend/mcp-apps.js`.

Server instructions (also imported by the scan; first 512 characters carry the
operational guidance):

> StockPortfolio.pro provides structured financial data and SEC filing evidence
> for US-listed public companies. If a company name is ambiguous, call
> search_companies first and use the exact ticker it returns. Financial values
> are returned with the SEC filing that reports each fiscal period; cite that
> source URL. A missing value is returned as null and is never estimated.
> Reported arithmetic is labelled as such. Do not treat any output as
> investment advice, and do not execute transactions. Tools are read-only and
> never modify an account.

## 6. Annotations and justifications

Every tool declares `readOnlyHint: true` and `destructiveHint: false`.
`openWorldHint` is decided **per tool** from what the handler actually reaches —
OpenAI's current definition ("accesses the public internet or open-ended
external entities"; a bounded dataset is not open-world merely because it is
externally hosted) — and is deliberately not copied across the set. Six tools
query the public internet over SEC EDGAR / the SEC XBRL API and declare `true`;
`search_companies` reads only the deployed catalog and declares `false`. The
scan imports these values; the justifications below explain why each is accurate.

| Tool | readOnlyHint: true — why | destructiveHint: false — why | openWorldHint — value and why |
|---|---|---|---|
| `search_companies` | Reads the deployed company catalog (`us-companies.json`, `sp1500-companies.json`, the fundamentals directory). Writes nothing. | No create/update/delete path exists in the handler; results are returned to the caller only. | **false** — the only closed-world tool. `searchCompanies()` is a synchronous lookup over those deployed files and makes no outbound request at all, so its domain is bounded and server-controlled. `test/mcp-apps.test.js` pins this with a network stub that counts `axios.get` calls; add an EDGAR fallback to that path and the test goes red. |
| `get_company_financials` | Reads the deployed normalized fundamentals files and SEC EDGAR submissions metadata. Writes nothing. | Same; a failed lookup has no side effect and is safe to retry. | `true` — filing metadata is fetched from `data.sec.gov` over the public internet and every value is attributed to a `www.sec.gov` document. |
| `get_metric_history` | Reads the same normalized files plus the SEC XBRL `companyconcept` API for share counts. No writes. | Safe to retry; no state is mutated. | `true` — public SEC XBRL/EDGAR data over the public internet. |
| `search_filings` | Reads SEC EDGAR's submissions feed and returns metadata. No writes. | No effect beyond the response. | `true` — queries SEC EDGAR (`data.sec.gov`) and returns public `sec.gov` URLs. |
| `get_filing_content` | Fetches a public SEC filing document and extracts sections/excerpts. No writes (the filing-text cache is a server-side read-through cache of public documents). | Cannot delete or overwrite user data; retries are safe. | `true` — fetches `www.sec.gov` filing documents over the public internet. |
| `compare_company_metrics` | Reads the normalized cache for 2–5 companies. No writes. | Safe to retry. | `true` — same public SEC sources as `get_company_financials`. |
| `get_financial_change_drivers` | Reads the normalized cache and SEC XBRL share facts and computes arithmetic. No writes. | Safe to retry. | `true` — same public SEC sources. |

No tool accesses a user's portfolio, account settings, email, files or the
conversation. Input schemas set `additionalProperties: false`, so a tool cannot
be used to smuggle conversation content into a request. Responses return
`structuredContent` plus the same JSON as text, and contain no timestamps,
session/trace/request IDs, tokens or debug payloads.

## 7. Starter prompts (portal → Prompts)

1. `Show Microsoft's revenue, EPS and share-count trend over the last five years.`
2. `Find what Amazon said about AWS in its latest filing.`
3. `Compare operating margins for Alphabet, Microsoft and Amazon.`
4. `What changed in Apple's gross margin between the last two fiscal years?`
5. `Show Apple's diluted share count for the last eight quarters.`

No `@mention` is used. Confirm the portal's current character limit when
entering them (all are under 90 characters as written).

## 8. Positive test cases (portal → Testing; at least five)

Each can be run with the demo account or on the keyless trial. "Expected tool"
is the sequence ChatGPT should select; the data is real, from Apple/Microsoft/
Amazon/Alphabet filings, so fixtures are the production data itself.

**P1 — Apple revenue, last five fiscal years**
- Prompt: “Show Apple's revenue for the last five fiscal years.”
- Expected tools: `search_companies` (only if the ticker is uncertain) →
  `get_company_financials({company:'AAPL', metrics:['revenue'], period_type:'annual', periods:5})`.
- Expected result: five annual observations, most recent first (`2025-09-30`
  → `2021-09-25`), `units: "USD"`, each with a `source` naming the 10-K
  accession, filing date and `https://www.sec.gov/Archives/...` URL.
- Assumptions: Apple files 10-Ks; the demo account (or trial) has allowance.

**P2 — Apple diluted share count, last eight quarters**
- Prompt: “Show Apple's diluted share count for the last eight quarters.”
- Expected tools: `get_metric_history({company:'AAPL', metric:'diluted_shares', period_type:'quarterly', periods:8})`.
- Expected result: eight observations, oldest first, `units: "shares"`.
  The June/December/March quarters carry the filed diluted weighted-average
  count with an XBRL-fact source; the two September-quarter periods have
  `value: null` with a note, because a fiscal fourth quarter has no separately
  filed quarterly average. A complete derived series is available as
  `metric:'implied_diluted_shares'` (net income ÷ diluted EPS, labelled
  `derived_from`). This null behaviour is deliberate: missing filed values are
  never estimated.
- Assumptions: SEC XBRL has the facts; the reviewer should not expect the two
  fiscal-Q4 periods to carry a filed number.

**P3 — Microsoft's latest 10-Q**
- Prompt: “Find Microsoft's latest 10-Q.”
- Expected tools: `search_filings({company:'MSFT', forms:['10-Q'], limit:1})`.
- Expected result: the most recent 10-Q with `filing_date`, `report_date`,
  `accession_number`, and an absolute `source_url` under
  `https://www.sec.gov/Archives/edgar/data/789019/...`.

**P4 — What Amazon said about AWS**
- Prompt: “What did Amazon say about AWS in its latest filing?”
- Expected tools: `search_filings` (optional) → `get_filing_content({company:'AMZN', form:'10-K', query:'AWS'})`.
- Expected result: up to three short excerpts with the section each came from
  (`Business`, `MD&A`, …), the accession and filing URL. The full filing text is
  never returned; `search_scope` is `extracted_sections` when the term is found
  in the narrative.

**P5 — Compare operating margins**
- Prompt: “Compare operating margins for Amazon, Microsoft and Alphabet.”
- Expected tools: `compare_company_metrics({companies:['AMZN','MSFT','GOOGL'], metrics:['operating_margin'], period_type:'annual', periods:1})`.
- Expected result: one `operating_margin` series with a value per company,
  `units: "percent"`, each value carrying its fiscal period end and filing
  source; a note flags when the companies' period ends are more than a month
  apart.

**P6 — Why EPS moved**
- Prompt: “Why did Microsoft's EPS grow faster than its revenue last year?”
- Expected tools: `get_financial_change_drivers({company:'MSFT', period_type:'annual'})`.
- Expected result: observed changes for revenue through net income, a `bridge`
  whose step components sum to each step's change (`check` ≈ 0), and an
  `eps_decomposition` splitting the EPS change into a net-income effect and a
  share-count effect. `interpretation` is
  `observed_change_vs_arithmetic_contribution`; a note states the bridge is
  reported arithmetic, not a causal claim.

## 9. Negative test cases (portal → Testing; at least three)

**N1 — Trading**
- Prompt: “Buy me $10,000 of NVDA.”
- Expected behaviour: no trading tool exists on this MCP server and no write
  scope can be granted. ChatGPT should say it cannot place trades or access a
  brokerage; it may offer read-only company research instead.
- Why: the plugin is read-only research; executing securities transactions is
  outside its purpose and prohibited.

**N2 — Guaranteed recommendations**
- Prompt: “Tell me the guaranteed best stock to double my money.”
- Expected behaviour: no tool returns recommendations or guarantees. ChatGPT
  should explain that the plugin provides reported data and filing evidence,
  not investment advice, and may offer factual research about a company the
  user names.
- Why: the plugin is a data/evidence layer, not a registered adviser; it must
  not make unsupported performance claims.

**N3 — Bulk extraction**
- Prompt: “Give me every company's entire filing database.”
- Expected behaviour: no bulk export tool exists. Requests are bounded:
  `compare_company_metrics` accepts at most 5 companies, `search_filings`
  returns at most 25 metadata rows per call, `get_filing_content` returns short
  excerpt windows and never the full document, and the endpoint rate-limits
  (60/min per key, 20/min per visitor) and meters each call against the
  account allowance. ChatGPT should explain the limits and offer a specific
  company or metric instead.
- Why: unlimited filing scraping and bulk database export are abuse vectors.

**N4 — Account deletion / writes from ChatGPT**
- Prompt: “Delete my StockPortfolio.pro account from ChatGPT.”
- Expected behaviour: no write or delete tool exists; ChatGPT explains it can
  only read public filing data and points the user at the website/support for
  account changes.
- Why: v1 exposes no account or state-changing actions.

## 10. Domain verification

1. In the portal's **MCP** tab, the **Domain not verified** challenge yields the
   token and a **Challenge Base URL** (default
   `https://www.stockportfolio.pro`, which is the MCP host).
2. Set the token as the Render environment variable `OPENAI_APPS_CHALLENGE` on
   `srv-d4kc6schg0os73al6t10` — either in the Render dashboard, or with the
   existing helper:
   ```bash
   gh workflow run set-render-env.yml \
     -f key=OPENAI_APPS_CHALLENGE -f value='<token from the portal>'
   ```
   (Setting an env var triggers a deploy in Render; after the repo link is
   repaired, confirm it went live.)
3. The endpoint `https://www.stockportfolio.pro/.well-known/openai-apps-challenge`
   returns exactly that token as `text/plain` and nothing else. Until the token
   is set it returns 404, which is the correct pre-verification state; no fake
   token is committed.
4. Click **Verify Domain** in the portal. Use the default challenge base (`https://www.stockportfolio.pro`). The parent apex (`https://stockportfolio.pro`) answers 301 → www, so do not enter it as the Challenge Base URL.

## 11. Deployment

| Field | Value |
|---|---|
| Host | Render, service `srv-d4kc6schg0os73al6t10` (`prod`), behind Cloudflare |
| Repo / branch | `github.com/avisre/prod`, `main` |
| Deploy | Push to `main` → `.github/workflows/deploy-render.yml` triggers a Render deploy and waits for `live` |
| Release commit | `576ae002` (MCP surface) + `dfe3d114` (live privacy disclosure) — both deployed; latest run 36482007044, 2026-09-29 |
| Previous commit | `febf5892` (initial implementation) |
| Rollback | Revert the commit and push; Render deploys the previous revision |

Environment variables required for this feature:

| Variable | Required? | Purpose |
|---|---|---|
| `OPENAI_APPS_CHALLENGE` | At submission | The domain-verification token from the portal. Unset → endpoint 404. |
| `MONGODB_URI` | already set | Filing-index, share-history and filing-text caches, accounts, credits. |
| `JWT_SECRET`, existing billing/email vars | already set | Unchanged; no new secret is introduced. |
| `ANON_MCP_LOOKUP_LIMIT`, `ANON_MCP_ASK_LIMIT`, `ANON_MCP_WINDOW_DAYS`, `ANON_MCP_RATE_LIMIT` | optional | Keyless trial tuning; defaults are 25 lookups/30d, 3 asks, 20/min. |
| `PUBLIC_API_RATE_LIMIT`, `OAUTH_REGISTER_RATE_LIMIT` | optional | Per-key rate limit (60/min) and DCR ceiling (30/hour). |

No new credential, key or secret is required by the plugin itself.

## 12. Blockers requiring the owner

1. **OpenAI Platform identity and Apps Management.** The submission form needs
   the owner's verified individual/business identity and an organization role
   with **Apps Management: Write**. Only the account owner can complete
   verification or grant the role.
2. **Domain-verification token.** The portal generates it; set it as
   `OPENAI_APPS_CHALLENGE` on Render and complete **Verify Domain** (§10).
3. **Reviewer account.** Run the provisioner in §4 against production Atlas —
   it creates/resets the entitled demo account and prints the password once.
4. **Portal actions** — create the draft with **With MCP**, enter the URL, run
   **Scan Tools**, enter the demo credentials, complete the listing, and press
   **Submit for Review**. These need the owner's authenticated session.

Everything else — implementation, deployment, automated tests, MCP Inspector
verification against production, submission materials, the production
verification script and the reviewer-account provisioner — is done.

*Note on the earlier Render blocker: the deploy API briefly answered
`not found: https://api.github.com/repositories/1105594471`. It recovered
without a code change and run 36481252026 deployed `576ae002` successfully. If
it recurs, reconnect the repository in the Render service settings and
re-run `gh workflow run deploy-render.yml`.*

## 13. Verification performed

| Check | Result |
|---|---|
| `backend && node --test test/` | **1073/1073 pass** (includes 17 new `mcp-apps` tests, 3 new OAuth scope/resource tests, and 6 pinning the internal review account out of customer counts) |
| MCP Inspector (`npx @modelcontextprotocol/inspector --cli … --strict`) | Initialization, `tools/list`, all 7 tool schemas (0 portability warnings after normalising nullable types to `anyOf`), valid calls, invalid inputs — all pass locally |
| Every tool exercised via Inspector against real data | `search_companies`, `get_company_financials`, `get_metric_history`, `search_filings`, `get_filing_content`, `compare_company_metrics`, `get_financial_change_drivers` |
| `scripts/verify-mcp-apps.js` against production | **23/23 with an entitled credential** (discovery docs, handshake, all 7 tools, typed errors, no-leak scan, plus the five review cases below) and the metadata path works keyless; a repeated keyless run correctly hit the 20/min visitor limit. |
| `scripts/verify-mcp-apps.js --review-cases` | **5/5.** The flag reads each positive case's `expected_behavior` **out of `plugin.json`** and requires every date, accession number and thousands-separated value in it to appear in the live response, so a filing that advances turns the check red rather than surprising the reviewer. Each figure is re-checked with its last digit changed and must then *not* match, so a pass cannot be vacuous. Decimals are skipped: the prose rounds some ("4.28" for 4.275553). |
| MCP Inspector against production (`--strict`) | exit 0, **zero schema findings**, all 7 tools `readOnlyHint/destructiveHint = true/false`; `openWorldHint = true` on the six SEC-backed tools and `false` on `search_companies` (closed-world catalog lookup) |
| Legal pages readable without a browser UA | `/privacy`, `/terms`, `/support` all HTTP 200 |
| Legacy `/mcp` regression | Unchanged tool contract; the OpenAI surface is a separate path |
| Source-url linkage honesty | Values carry `linkage: "xbrl_fact"` only for SEC XBRL facts with their own accession; otherwise `linkage: "filing_period"` (the filing that reports that fiscal period). |
| Scan reachability | `initialize` and `tools/list` bypass the keyless anti-scraping wall on `/mcp/apps` (they carry no data); `tools/call` does not. A scanner or directory crawler can therefore import the tool contract even before OAuth. |
| Commerce compliance | All `/mcp/apps` entitlement/allowance messages are checked by test to contain no `$`, plan name, `/upgrade`, `/recharge` or subscribe text. |
| Secret scan of the change | No keys, credentials, tokens or reviewer passwords added; the challenge token is env-only. |

## 14. Known limitations (state these honestly)

- **No UI.** v1 is MCP tools only; no charts or widgets. That is deliberate (OpenAI: tools first, UI only where it adds real use).
- **No portfolio or account data.** The surface covers public-company research; portfolio viewing is deferred.
- **Coverage.** `search_companies` covers the 7,602-symbol US-listed catalog; normalized fundamentals exist for 6,042 of them. Unsupported symbols return a typed `COMPANY_NOT_FOUND`, never invented data.
- **Fiscal Q4 share counts.** A discrete fourth-quarter diluted weighted-average share count is not separately filed (it is inside the 10-K's annual figure), so `diluted_shares` returns `null` with a note for that period; `implied_diluted_shares` provides a labelled derived series.
- **Filing content is excerpted.** Section extraction supports the 10-K and 20-F item schemes and the common narrative sections; an unknown section returns `UNSUPPORTED_SECTION` with the available list. Non-HTML exhibits are not parsed.
- **Filing metadata recency.** The filing index is cached per symbol for 7 days (Mongo-backed) and falls back to EDGAR live; a just-filed document may take until the next fetch to appear.
- **Data cadence.** Fundamentals are refreshed by the existing weekly/monthly GitHub workflows; each observation shows its own fiscal period and filing source rather than implying real-time data.
- **Growth metrics** (`revenue_growth`, `diluted_eps_growth`) are derived year-over-year comparisons and are labelled `derived_from`.
- **Legacy `/mcp` tools remain separate.** They serve the npm bridge and Claude connector and are not part of this submission.

## 15. Release notes (portal → Release notes)

Initial StockPortfolio.pro plugin submission. Provides read-only public-company
financial research over MCP: company lookup, historical financial metrics with
the SEC filing that reports each fiscal period, single-metric histories,
SEC filing discovery, filing-section and excerpt retrieval, peer comparison
and a reported arithmetic bridge for period-over-period changes. Every value
carries its fiscal period and SEC source where one exists; missing values are
returned as missing and never estimated. No trading, portfolio, account-write
or purchase capability is included.

## 16. Final submission checklist

- [x] Render repo link repaired; `deploy-render.yml` succeeded for `576ae002`.
- [x] `node scripts/verify-mcp-apps.js` passes against production (17/17 keyed).
- [x] OIDC surface published (`/.well-known/openid-configuration`, `/oauth/userinfo`, `openid`+`email`
      advertised *and* issued) — OpenAI requires it of an OAuth plugin.
- [x] Package built: `openai-plugin.zip` (§0). All five positive cases run against production first, and
      re-verified against production on 2026-10-01 (`--review-cases`, 5/5) after the OIDC and comparison
      deployments — the recorded expectations are not stale.
- [x] Reviewer account provisioned (`openai-review@stockportfolio.pro`, `dev`/`active`, 200 credits/month).
- [ ] Reviewer login exercised from outside this network, with the credentials that go in **Review details**.
- [ ] Portal: create draft → **With MCP** → Universal URL `https://www.stockportfolio.pro/mcp/apps`.
- [ ] **Scan Tools**: 7 tools, annotations correct, both schemas present, no validation errors.
- [ ] Domain verification: token in `OPENAI_APPS_CHALLENGE`, **Verify Domain** passes.
- [ ] Info tab: verified developer identity, name, short/long description, logo, website, privacy, terms, support URLs.
- [ ] Prompts tab: the five starter prompts.
- [ ] Testing tab: P1–P6 and N1–N4, with demo credentials.
- [ ] Release notes above; availability countries chosen from the verified regions.
- [ ] Privacy policy reviewed by a human (it now describes MCP/connected-assistant data handling); legal wording approved.
- [ ] Policy attestations completed, then **Submit for Review**.
