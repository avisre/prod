# Metric ownership measurement plan

This plan separates ownership from ranking and uses non-overlapping Search Console windows.

## Baseline (PRE)

- Export retrieved: `2026-08-10T07:39:58.124298+00:00`.
- PRE window: `2026-05-10` to `2026-08-07`.
- Record for each explicit query: intended metric, intended route, intended-route impressions, wrong-route impressions, total relevant metric impressions, intended ownership rate, dominant URL, dominant-route correctness, intended-route position, wrong-route position, overall position, clicks and CTR.

## Post-fix window (POST)

- Deployment timestamp: `PENDING — record actual production deployment`.
- First meaningful post-GSC date: `PENDING — use the first date after deployment plus recrawl buffer`.
- POST window: `PENDING — non-overlapping with PRE`.
- Flag: `PARTIAL_RECRAWL_POSSIBLE` until all affected metric pages have recrawled.
- For low traffic, extend POST rather than mixing PRE rows into a rolling three-month sample.

## Decision fields

- Primary: intended ownership rate with absolute intended/wrong/total impression counts.
- Secondary: impressions, dominant URL, intended/wrong/overall position and CTR.
- Do not declare a win from CTR or ranking alone. Report ownership, authority and ranking separately.
