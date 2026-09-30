# StockPortfolio.pro public API + MCP

Filing-grounded US company financials and fund data, callable with an API
key or from any MCP-compatible client. Every deterministic value carries the
SEC filing it was drawn from.

## Who can get a key

API/MCP access is a paid feature: the **Dev plan** ($19.99/mo), **Power**, **Desk**,
the **highest AppSumo/DealMirror tier (tier 3)**, or **any AppSumo/DealMirror tier
purchased on or before 22 September 2026**. It's checked live on every call, not
just at key creation — a plan downgrade takes effect immediately, the same way
Monitor access does, and a refunded lifetime licence loses it on the next call.

Log in at stockportfolio.pro on a qualifying plan, then:

```
POST /api/account/api-keys        { "label": "my integration" }   -> { key, keyPrefix, ... }
GET  /api/account/api-keys                                        -> { keys: [...] }   (prefix only, never the key itself)
DELETE /api/account/api-keys/:id                                  -> { ok: true }
```

The raw key (`sp_live_...`) is shown exactly once, at creation. Store it —
it cannot be retrieved again, only revoked and replaced. Listing and
revoking your own keys always works, even if your plan later changes —
only *creating a new key* or *making a call* requires the qualifying tier.

API calls spend from the **same credit wallet** as your website account
(see the "What things cost" line on your Profile page). There is no
separate API quota to track.

## Pricing

| Action | MCP (`/mcp`) | REST API (`/api/v1`) |
|---|---:|---:|
| Deterministic lookup (financials/filing/compare/screen/fund) | 2 credits | 2 credits |
| AI-backed ask | 42 credits | 42 credits |

Both surfaces are priced identically, action for action: they run the same
call over the same filings, so neither is the cheap way in. Pick MCP because
your client speaks MCP, and REST because it speaks HTTP.

The `ask` cost is the only one anchored to a real inference cost. Both
Claude Fable 5.1 and GPT-6 Astra price at $10/$50 per million input/output
tokens. One `ask` is an agentic loop, not a single completion: measured over
301 real actions it makes 5.6 model calls and consumes **58,239 tokens**,
because each round re-sends the conversation, the system prompt and the tool
schemas. At the measured 95/5 input/output split that is $0.70 per action at
frontier rates; at 6x, and $0.09993/credit ($14.99 / 150), that is 42 credits.

Lookup costs aren't inference-priced at all (no LLM call happens for them) —
they're flat, mainly to prevent abuse of the underlying SEC/Yahoo fetch path.

These figures are derived in `credits.js` and asserted against
`credits.COST` by `backend/test/public-api-doc-truth.test.js`, so this
table cannot drift from the code again.

## Authenticating

Send the key as either header on every call:

```
Authorization: Bearer sp_live_...
X-Api-Key: sp_live_...
```

Missing or revoked keys get `401`. Calls are rate-limited per key
(`PUBLIC_API_RATE_LIMIT`, default 60/min).

## REST endpoints (`/api/v1`)

| Endpoint | Cost | Notes |
|---|---|---|
| `GET /api/v1/health` | free, unauthed | liveness check |
| `GET /api/v1/financials/:ticker?tool=<slug>` | 2 | `tool` is any [free-tools](free-tools.js) slug, e.g. `earnings-quality`, `dilution`, `debt-snapshot` |
| `GET /api/v1/filing/:ticker` | 2 | recent 10-K/10-Q/8-K/Form 4 with EDGAR links |
| `GET /api/v1/compare?tickers=AAPL,MSFT` | 2 | exactly two tickers |
| `GET /api/v1/screen?tickers=AAPL,MSFT,NVDA` | 2 | up to ten tickers, ranked by filed revenue growth |
| `GET /api/v1/fund/:symbol` | 2 | ETF/mutual-fund profile — Yahoo-derived, **not redistributable** |
| `POST /api/v1/ask` `{ "question": "..." }` | 42 | AI-backed; source class (`filed`/`fund-data`/`live-web`) travels with the answer |

Every deterministic response wraps its payload in an envelope with a
`citation` block (filing source, period, a backlink to verify on-site).
A `402` on the REST surface means the month's wallet is exhausted; nothing is
charged on an error response. The MCP endpoint never answers `402` — it
returns the same object inside its error result, so the agent can read it:

```json
{
  "error": "Out of credits for this month (used 200/200). This call costs 2, you have 0 left. Recharge 150 credits for $14.99, or the monthly allowance returns on its own.",
  "code": "QUOTA_EXCEEDED",
  "used": 200, "allowance": 200, "remaining": 0, "needed": 2,
  "resetsAt": "2026-10-01T00:00:00.000Z",
  "recharge": { "url": "https://www.stockportfolio.pro/recharge.html", "credits": 150, "price": "$14.99" },
  "upgradeUrl": "https://www.stockportfolio.pro/upgrade.html"
}
```

Recharge checkout is on the website (the link above), not the API — buying
credits is session-authenticated, so an API key cannot spend money.

## MCP endpoint

`POST /mcp` — Streamable HTTP transport, stateless (no session id). Point
any MCP client at this URL with the same `Authorization: Bearer` header
used for the REST API. Six tools, each named for what it returns:

| Tool | Returns | Cost |
|---|---|---|
| `search_companies` | Company name or ticker → ticker, name, SEC CIK | free |
| `get_company_fundamentals` | Filed statements by fiscal period, each figure carrying its filing | 2 |
| `search_filings` | Filings by type and date range, with direct EDGAR URLs | 2 |
| `get_filing` | One filing's metadata and content, by accession number or ticker | 2 |
| `ask_filings` | A filing-grounded answer with the figures and citations behind it | 42 |
| `sp_health` | Liveness probe | free |

**Discovery costs nothing and needs no credential.** `initialize` and
`tools/list` answer without a key and without a plan, so a directory scan or
a ChatGPT connector's "Scan Tools" pass can read this list before anyone has
signed in. Entitlement is checked when a metered tool is actually called,
and a refusal arrives as a tool error the model can read — never as an HTTP
`402` on the connection, which a client cannot distinguish from a dead
server.

For a client that can only run local stdio servers — Claude Desktop's config
file is stdio-only, and drops a `url` entry silently — a bridge to this same
hosted endpoint is published on npm as `stockportfolio-mcp`
(`npx -y stockportfolio-mcp`, key in `STOCKPORTFOLIO_API_KEY`). It proxies
every call here; it holds nothing but the key you give it and sends that key
nowhere else.

Step-by-step setup for each client — Claude, ChatGPT, the Anthropic and OpenAI
APIs, and the REST surface from your own code — is in the
[documentation](https://www.stockportfolio.pro/docs/api-mcp).

## What's not redistributable

`sp_fund` / `GET /api/v1/fund/:symbol` return Yahoo-derived fund data.
There is no redistribution license for that data (see
`docs/growth/corpus-license-terms.md`) — use it for your own research, not
to republish or resell. Every filed (SEC) response has no such restriction:
filings are public domain.
