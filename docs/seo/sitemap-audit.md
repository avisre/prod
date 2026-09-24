# Sitemap audit

Generated: **2026-09-23T22:27:15.550Z**

> This audit exercises the existing sitemap generator locally. It does not submit sitemaps or change Search Console/Bing state. Production HTTP status and URL Inspection still require a controlled deployment check.

## Summary

- Entries: **21,327**.
- Duplicate/contract issues found: **2**.
- Shards: `core` 114, `stocks-1` 1506, `comparisons-1` 5000, `comparisons-2` 828, `metrics-1` 5000, `metrics-2` 5000, `metrics-3` 3879.
- Page families: `core` 112, `comparisons` 5830, `stocks` 1506, `metrics` 13879.

## Representative URL checks

| Route | Listed | Lastmod | Local status | Local indexable | Result |
|---|---|---|---:|---|---|
| `/stocks/AAP/free-cash-flow` | yes | 2026-07-19 | 200 | yes | OK |
| `/stocks/WAB/eps` | yes | 2026-07-19 | 200 | yes | OK |
| `/stocks/WAB/shares-outstanding` | yes | 2026-07-19 | 200 | yes | OK |
| `/stocks/WAB/dividend-history` | yes | 2026-07-19 | 200 | yes | OK |
| `/stocks/AAP` | yes | 2026-07-19 | 200 | yes | OK |

## Issue list

- **PRIVATE_ROUTE**: `/register`
- **PRIVATE_ROUTE**: `/docs/account`

## Lastmod guardrail

- `lastmod` is read from the existing data/page mtime logic. It must represent a meaningful data or page change, not every deploy.
- No redirect, canonical, robots, URL, or sitemap membership changes were made by this audit.
