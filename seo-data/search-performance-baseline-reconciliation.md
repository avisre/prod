# Search performance baseline reconciliation

This report keeps Search Console snapshots separate. It does not combine figures from different windows, filters or dimensions.

## Current local API dataset

- Property: `sc-domain:stockportfolio.pro` (domain property; service-account access recorded as Full user).
- Retrieval: `2026-08-10T07:39:58.124298+00:00`.
- Exact query aggregate window: `2026-05-10` to `2026-08-07`; search type `web`; no query/page, device, country or page filter in the aggregate request.
- Query rows: **632**; query-dimension sum: **5,503 impressions / 1 clicks / 0.02% CTR / 13.04 weighted position**.
- The query aggregate is a `DIMENSION TOTAL` and is not a site total; Search Console may omit anonymized/low-volume queries.

## Previously reported snapshots kept separate

| Snapshot | Reported window | Filters/dimensions known | Reported clicks | Reported impressions | CTR | Position | Status |
|---|---|---|---:|---:|---:|---:|---|
| Broad GSC analysis | 2026-05-10 to 2026-08-07 | Search Analytics aggregate; property summary | 17 | 9,332 | 0.18% | 12.29 | `SITE AGGREGATE` reported in prior audit; not recreated by adding CSV rows |
| Filtered 28-day snapshot | 2026-07-10 to 2026-08-06 | Domain property; filtered report scope from prior report; exact request body unavailable in repo | 5 | 2,270 | 0.22% | 11.3 | `SITE AGGREGATE` reported externally; not directly comparable |
| Current query export | 2026-05-10 to 2026-08-07 | Query dimension CSV | as above in query rows | as above in query rows | as above | as above | `DIMENSION TOTAL` |


## Why the figures differ

The 9,332/17 and 2,270/5 values cannot be reconciled arithmetically from the repository because the second report's exact request body is not preserved. Legitimate causes include the different date windows, property/report scope, filters, query versus page or query/page aggregation, privacy/anonymized-query exclusion, API row limits and Search Console's non-additive dimensions. The current export documents the request metadata and should be the single baseline for the ownership audit.

Do not add query totals, page totals and query/page totals. The application’s ownership report uses query/page rows only to map URLs, while site-level context uses the separate query aggregate.

## Interpretation guardrail

The discrepancy is not evidence of an API error or a canonical defect. Re-run both exact request bodies over the same window and filters before treating the snapshots as a trend. Google Search Console data is delayed and privacy-filtered.
