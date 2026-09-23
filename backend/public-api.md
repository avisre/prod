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
A `402` means the month's wallet is exhausted; nothing is charged on an error
response. The body is actionable rather than just descriptive — the MCP
endpoint returns the same object inside its error result:

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
