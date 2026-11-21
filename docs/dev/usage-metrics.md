# Per-user usage measurement

Answers: **who** uses StockPortfolio.pro, **on which surface** (website / REST
API / MCP connector), **what they ask for** (routes, tools, companies, metrics),
and **what their requests cost in bytes** — including the company-evidence cache
read/write a request triggers, which the 2026-11-21 bandwidth audit could only
estimate.

## Why

The bandwidth bill was dominated by work no one could attribute: a request for a
company the in-process cache did not hold re-read a ~2.9 MB document from Mongo,
and every cache write uploaded one. `mcp_calls.bytes` measured connector result
sizes, and the path meter measured bytes per route, but neither knew the user and
neither saw the cache. This adds that missing link.

## How a request is attributed

`backend/usage-context.js` runs one mutable store for the life of each request
(`AsyncLocalStorage`). The evidence cache adds its counters to that store, and
the response hook reads it back when the response finishes.

```
request → usage-context store (cacheHits/Misses/readBytes/writeBytes)
        → auth resolves req.userId (read at finish, no middleware change)
        → res 'finish' → usage-aggregate.record() + recordEvent()
        → flush every 60s → usage_daily / usage_counts / usage_events
```

Surface is derived from the route and the credential:

| condition | surface |
|---|---|
| `POST /mcp` | `mcp` |
| `POST /mcp/apps` | `mcp-apps` |
| `/api/*` with an OAuth token | `mcp` |
| `/api/*` with an `sp_live_` key | `rest` |
| `/api/*` with a session token | `web` |
| anything else (pages, assets, crawlers) | not recorded |

MCP calls are recorded once, from the tool callback (which knows the tool, the
tickers and the result size), not from the transport.

## Collections

| collection | one row per | updated with | retention |
|---|---|---|---|
| `usage_daily` | userKey + surface + day (IST) | `$inc`/`$min`/`$max` | kept |
| `usage_counts` | userKey + surface + day + kind + key | `$inc` | 400d TTL |
| `usage_events` | one `/api/*` request or MCP call | append | 90d TTL |

`userKey` is `u:<accountId>`, `a:<salted-monthly-hash>` for a keyless connector
caller (never an IP), or `system:<job>` for work the server does for itself
(boot warmup, watchdog) so it can never be mistaken for a customer.

Dimensions live in `usage_counts` rather than nested objects in `usage_daily`
because a route such as `/api/company/*` contains a dot, and Mongo forbids dots
in field names.

## Bounds and failure behaviour

- 4 000 buckets in memory, 400 dimension keys per bucket per dimension, 500
  buffered events. Overflow is counted in `stats().dropped`, never a heap leak.
- Writes are fire-and-forget; a DB outage re-queues the counters instead of
  losing them and never blocks a response.
- `USAGE_METRICS=false` disables it without a deploy.
- Single-process assumption (Render runs one). Persisted rows are incremented,
  so a restart loses at most the current minute.

## Reading it

```bash
# Admin API (owner account only)
GET /api/admin/usage/report?days=30&limit=25
GET /api/admin/usage/report?days=90&userId=<accountId>   # drill-down

# CLI; masks emails unless --full
node scripts/report-user-usage.js --days=30 --limit=25
node scripts/report-user-usage.js --userId=<accountId> --days=90 --json=/tmp/usage.json --full
```

## What it is not

- No client-side beacon, no GA4 change, no cookies change. `funnel_events` still
  owns navigation.
- Measurement only. It does not rate-limit, gate or downgrade anyone.
- No payload is stored: only route/tool names, company symbols, metric names and
  byte counts.
