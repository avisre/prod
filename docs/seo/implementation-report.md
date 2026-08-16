# Organic Search Acquisition Engine V1 — local implementation report

Status: **LOCAL / NOT DEPLOYED** (2026-08-16). No production routes, Search Console settings, Bing settings, prices, entitlements, authentication, AppSumo, Stripe, customer data, or AI allowances were changed by this work.

## 1. Baseline

### Google Search Console

- Prior business snapshot: 2,270 impressions / 5 clicks / approximately 0.22% CTR / position 11.3 (28 days); 9,332 / 17 / approximately 0.18% / position 12.29 (three months). These are reported snapshots, not recomputed here.
- Repository export: domain property `sc-domain:stockportfolio.pro`, retrieved 2026-08-10 UTC, window 2026-05-10 through 2026-08-07.
- Export dimensions: 632 query rows, 1,697 page rows, 981 query/page rows. Their sums are 5,503 / 1 click, 11,822 / 17 clicks, and 7,535 / 1 click respectively; they are non-additive Search Console dimensions and must not be presented as a site total.

### Bing

- Supplied directional snapshot: 2,312 impressions / 26 clicks / approximately 1.12% CTR / approximately 17,493 indexed pages / zero active crawl issues.
- A Bing page/query CSV is not present in this checkout. The opportunity generator therefore emits a header-only Bing opportunity file and does not invent AAP’s 425-impression row. Run `node scripts/seo/find-search-opportunities.js --bing=/path/to/export.csv` when the export is available.

## 2. Architecture discovered

The route/template/data ownership map is in [architecture-audit.md](./architecture-audit.md). Public company and metric pages are server-rendered from the bounded fundamentals cache. Sitemap inventory is segmented into core, stocks, metrics and comparisons with mtime-based `lastmod`. The existing SEO activation pilot is dark unless `SEO_ACTIVATION_PILOT=true` and an observed eligibility manifest matches.

Ordinary SEO renders use deterministic data and do not invoke Ollama. Ask/research remains the intentional AI boundary.

## 3. Query ownership

The conservative audit is in [query-page-ownership.md](./query-page-ownership.md) and [query-page-ownership.csv](./query-page-ownership.csv), with compatibility aliases [query-ownership.md](./query-ownership.md) and [query-ownership.csv](./query-ownership.csv).

Current Google query/page export counts: 30 `WRONG_METRIC`, 127 `CORRECT`, 440 `AMBIGUOUS`, and 35 `UNKNOWN`. WAB explicit EPS and shares queries are wrong-route dominant in the observed rows. Generic `earnings`, `profit`, `sales`, `dilution`, `buyback`, `valuation`, and bare `cash flow` are not used to justify rewrites. Ownership rate is always intended-route impressions divided by relevant metric-route impressions for the same query.

## 4. Implemented page/template change

Only `backend/seo-extra.js` was changed in the application renderer:

- AAP/free-cash-flow now exposes the latest deterministic operating-cash-flow and absolute capex inputs, the derived FCF result, and the `OCF − capex` method before the chart/history.
- Total-debt pages expose derived total debt, cash balance and net debt/net cash when the filed inputs exist.
- Metric titles keep the exact ticker/metric phrase first and use a bounded company-name suffix; latest values remain in the description and answer so long legal names do not crowd the semantic owner out of the title.
- No URL, canonical, robots, sitemap, title ownership convention, authentication, pricing, entitlement, Ask allowance or payment logic was changed.
- The existing exact metric labels, source links, split-adjustment wording and derived-value disclosures remain intact.

The existing WAB metric renderer already has distinct title/H1/opening answer/history heading/methodology fields; the local similarity and anchor audits verify this without generic filler.

## 5. Opportunity and linking outputs

- [production-baseline.md](./production-baseline.md) / JSON: 19 representative local pages, including AAP FCF, all WAB priority pages, metric families, a comparison, and top Google pages. Bing cohort is marked missing until an export is supplied.
- [search-opportunities.md](./search-opportunities.md), [google-opportunities.csv](./google-opportunities.csv), [bing-opportunities.csv](./bing-opportunities.csv): position buckets, expected CTR gap, conservative page-family confidence and priority. These are observational prioritisation, not forecasts.
- [internal-metric-link-audit.md](./internal-metric-link-audit.md): no semantic-anchor flags in the focused render sample.
- [internal-link-graph.md](./internal-link-graph.md) / CSV: representative authority flow; low-sample destinations are flagged for review, not mass rewrites.
- [sitemap-audit.md](./sitemap-audit.md): 19,762 local entries, 7 shards, zero local contract issues.
- [bing-ai-performance.csv](./bing-ai-performance.csv): header-only because no authenticated citation export was available.

## 6. IndexNow

`scripts/seo/indexnow-queue.js` provides a deduplicated, non-blocking local queue with URL, ticker, reason, data version, changed/submitted timestamps, status, attempt count and backoff. `scripts/indexnow-ping.js --queue` is an opt-in sender; the existing default sitemap sender is unchanged. No IndexNow request was sent in this task.

## 7. Tests and checks

- Backend suite: **170/170 passed** (`backend/npm test`).
- Focused SEO/control-plane tests: **7/7 passed**.
- Existing GSC analysis tests: **7/7 passed** (`python3 scripts/test-analyze-gsc-seo.py`).
- Syntax checks passed for all new SEO scripts, `scripts/indexnow-ping.js`, and `backend/seo-extra.js`.
- Local control-plane scripts completed: page baseline, ownership, internal links, sitemap, opportunities and IndexNow diagnostics.
- `git diff --check`: passed.
- Ordinary renderer test covers AAP FCF, WAB EPS, NVDA revenue, AAPL shares and a stock hub; output contains server-rendered H1/table/source and no Ollama/OpenAI/AI route calls. This is a local regression proof, not production traffic telemetry.

## 8. Staged rollout

1. Review this report and generated artifacts.
2. Supply a current Bing page/query export and, if available, Bing/Copilot citation export.
3. Run representative production HTTP/canonical/robots/mobile checks without changing code.
4. Deploy only the approved renderer/control-plane diff with the activation pilot still dark.
5. Stage cohort 1: AAP FCF, WAB EPS/shares/dividend and approximately 20 high-confidence pages.
6. Wait for recrawl; compare non-overlapping PRE/POST windows and ownership rates. Do not call a result successful from impressions alone.
7. Expand to FCF, then EPS/revenue/shares, then debt/cash/dividend/margin families only after regression and evidence gates pass.

## 9. Rollback

- Revert only the renderer commit or disable the SEO activation pilot (`SEO_ACTIVATION_PILOT=false`).
- Do not delete URLs, change canonicals, alter robots/noindex, or remove sitemap entries as a rollback shortcut.
- Stop IndexNow queue submission (`scripts/indexnow-ping.js --queue`) without affecting page serving.

## 10. Delivery boundary

- Commits produced: **none**. The repository contains unrelated pre-existing dirty changes; this work was not bundled with them.
- Production deployment: **not performed**.
- Google Search Console/Bing recrawl or IndexNow submission: **not performed**.
- Internal-link rewrites: **none**; the focused audit found no semantically wrong anchors, so the graph output is evidence for a later cohort rather than a mass rewrite.
- Bing opportunity rows and Bing/Copilot citation rows remain unavailable until the corresponding exports are supplied; no values were inferred from the directional snapshot.

## 11. Remaining risks and decisions

- Bing page-level opportunity ranking is blocked by the missing export; indexed-page and API snapshots are directional only.
- Search Console recrawl/reporting delay means ownership will not change immediately after deployment.
- The local internal-link graph is a representative sample, not a full 19k-page crawl.
- Response latency, cache hit rate, DB query counts, crawler share and Render CPU require production observability; no values are fabricated.
- No AI citation export is available.
- No new page families should be generated until an existing family demonstrates impressions plus qualified research activity or customers.
- This task intentionally does not change commercial terms, AI limits, payment, authentication, customer data or AppSumo behavior.
