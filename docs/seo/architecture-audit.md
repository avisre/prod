# StockPortfolio.pro SEO architecture audit

Generated from the current repository on 2026-08-16. This is an implementation map, not a production deployment claim.

## Render path

| Surface | Current owner | Evidence | Change status |
|---|---|---|---|
| Per-company page (`/stocks/:ticker`) | `backend/seo-pages.js::renderStockPage` | server-rendered HTML and shared `head()` | preserve |
| Metric page (`/stocks/:ticker/:metric`) | `backend/seo-extra.js::renderMetricPage` | `METRICS` registry and deterministic rows | preserve; staged semantic fixes only |
| Comparison landing | `backend/seo-extra.js::renderComparePage` | server-rendered comparison response | preserve |
| `<title>`, description, canonical, robots | `backend/seo-pages.js::head` and metric renderer | emitted in initial HTML | protected regression fields |
| H1/H2/answer/table/source | `renderStockPage` and `renderMetricPage` | visible before client JavaScript | preserve answer-first order |
| Structured data | page renderers | Breadcrumb/WebPage/Corporation/FAQ JSON-LD | audit truthfulness; no fabricated ratings |
| Financial data | `frontend/data/fundamentals/*.json` via `loadFundamentals` | local cache, file mtime | preserve cache and date semantics |
| Sitemap index/shards | `backend/seo-pages.js::buildSitemap*` | core/stocks/metrics/comparisons shards | audit only; no URL/lastmod rewrite |
| Robots | existing app/static route | production verification required | unchanged |
| IndexNow | `scripts/indexnow-ping.js` | current submission helper | queue/dedupe design only until integration review |
| Internal metric links | `seo-pages.js`, `seo-extra.js` siblings/related links | crawlable `<a href>` links | audit wrong anchors before edits |
| Ask CTA | `seo-extra.js::pilotAction` | dark `SEO_ACTIVATION_PILOT` + observed manifest | keep dark; structured state only |
| Attribution/events | `backend/marketing-attribution.js`, frontend event emitters | existing funnel contract | no PII/raw query changes |

## Ollama boundary

The public SEO renderers call deterministic cache/formatting helpers and do not call Ollama. AI is reached through deliberate Ask/research flows, not through stock/metric/company/sitemap rendering. A regression test must stub the AI boundary and render representative routes with zero calls.

## Cache and infrastructure findings

- Fundamentals are loaded from a bounded in-process cache in `seo-pages.js`; the cache is capped to avoid retaining the full universe.
- Sitemap inventory is TTL-cached and uses data/page mtimes for meaningful `lastmod` values.
- Metric pages compute values from cached structured data and do not make per-request SEC/vendor calls.
- Response-size, latency, DB and crawler telemetry are not available as a complete local export; this remains a production measurement gap rather than a fabricated metric.

## Protected architecture

Do not change URL paths, canonical host rules, robots/noindex, sitemap membership, HTTP status behavior, trailing-slash normalization, AppSumo/Stripe/authentication, portfolio logic, private data, pricing, entitlements or AI allowances as part of this SEO phase. Any genuine defect must be evidenced with an affected URL and a regression test first.

## Staged implementation boundary

1. Audit and baseline (AAP FCF, WAB EPS/shares/dividend, representative metric families).
2. Conservative ownership and internal-anchor evidence.
3. Deterministic answer-first semantics and snippet sanity checks.
4. Opportunity scoring and change-based IndexNow queue design.
5. Dark, small cohort only after local regression gates; production rollout remains a separate approval step.
