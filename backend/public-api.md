# StockPortfolio.pro public API + MCP

Filing-grounded US company financials and fund data, callable with an API
key or from any MCP-compatible client. Every deterministic value carries the
SEC filing it was drawn from.

## Who can get a key

API/MCP access is a top-tier feature: **Power, Desk, or the highest AppSumo/
DealMirror tier (tier 3)**. It's checked live on every call, not just at key
creation — a plan downgrade takes effect immediately, the same way Monitor
access does.

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

## Pricing: MCP is the base tier, REST API is 2x

| Action | MCP (`/mcp`) | REST API (`/api/v1`) |
|---|---:|---:|
| Deterministic lookup (financials/filing/compare/screen/fund) | 1 credit | 2 credits |
| AI-backed ask | 2 credits | 4 credits |

The REST API is priced at exactly 2x MCP by design — MCP is the cheaper,
agent-native on-ramp. The `ask` cost is the only one anchored to a real
inference cost: measured 2026-09, both Claude Fable 5.1 and GPT-6 Astra
price at $10/$50 per million input/output tokens, and this product's
measured average AI call (~10,779 tokens) works out to roughly $0.17 at
that rate — about 1.7 credits at the existing $0.10/credit rate, which is
where the 2-credit `mcp_ask` price sits. Lookup costs aren't inference-priced
at all (no LLM call happens for them) — they're flat, mainly to prevent
abuse of the underlying SEC/Yahoo fetch path.

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
| `GET /api/v1/financials/:ticker?tool=<slug>` | 1 | `tool` is any [free-tools](free-tools.js) slug, e.g. `earnings-quality`, `dilution`, `debt-snapshot` |
| `GET /api/v1/filing/:ticker` | 1 | recent 10-K/10-Q/8-K/Form 4 with EDGAR links |
| `GET /api/v1/compare?tickers=AAPL,MSFT` | 1 | exactly two tickers |
| `GET /api/v1/screen?tickers=AAPL,MSFT,NVDA` | 1 | up to ten tickers, ranked by filed revenue growth |
| `GET /api/v1/fund/:symbol` | 1 | ETF/mutual-fund profile — Yahoo-derived, **not redistributable** |
| `POST /api/v1/ask` `{ "question": "..." }` | 2 | AI-backed; source class (`filed`/`fund-data`/`live-web`) travels with the answer |

Every deterministic response wraps its payload in an envelope with a
`citation` block (filing source, period, a backlink to verify on-site).
A `402` means the month's wallet is exhausted (`resetsAt` tells you when it
refills); nothing is charged on an error response.

## MCP endpoint

`POST /mcp` — Streamable HTTP transport, stateless (no session id). Point
any MCP client at this URL with the same `Authorization: Bearer` header
used for the REST API. Seven tools, mirroring the REST surface:
`sp_financials`, `sp_filing`, `sp_compare`, `sp_screen`, `sp_fund`, `sp_ask`,
`sp_health` (free, no auth required for this one tool).

A local stdio version of the same tool set lives in `mcp-server/` for
Claude Desktop / local development — it talks to backend files directly on
disk and isn't the public launch surface described here.

## What's not redistributable

`sp_fund` / `GET /api/v1/fund/:symbol` return Yahoo-derived fund data.
There is no redistribution license for that data (see
`docs/growth/corpus-license-terms.md`) — use it for your own research, not
to republish or resell. Every filed (SEC) response has no such restriction:
filings are public domain.
