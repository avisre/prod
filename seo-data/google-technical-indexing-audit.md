# Google technical indexing audit

Audit evidence checked: `2026-08-10T07:39:58.124298+00:00` plus live representative requests on 2026-08-10.

## Canonical host audit

The application configuration and emitted sitemap/canonical tags use `https://www.stockportfolio.pro` as the canonical host.

| Variant | Initial/final result | Redirect hops | Final URL | Canonical / OG URL | Finding |
|---|---|---:|---|---|---|
| `http://stockportfolio.pro/stocks/WAB/eps` | 301 → 301 → 200 | 2 | `https://www.stockportfolio.pro/stocks/WAB/eps` | matching www HTTPS URL | stable but two edge hops |
| `https://stockportfolio.pro/stocks/WAB/eps` | 301 → 200 | 1 | `https://www.stockportfolio.pro/stocks/WAB/eps` | matching www HTTPS URL | stable |
| `http://www.stockportfolio.pro/stocks/WAB/eps` | 301 → 200 | 1 | `https://www.stockportfolio.pro/stocks/WAB/eps` | matching www HTTPS URL | stable |
| `https://www.stockportfolio.pro/stocks/WAB/eps` | 200 | 0 | same | matching canonical and OG URL | canonical endpoint |

Trailing slash `/stocks/WAB/eps/` returns one 301 to the slashless canonical path. No loop was observed. Sitemap and internal rendered links use the www HTTPS host.

## Diagnosis

Classification: **`HISTORICAL_ALREADY_FIXED` for the reported duplicate/canonical warning; no current canonical instability demonstrated.** The remaining two-hop HTTP non-www edge redirect is an efficiency observation, not proof of ownership or ranking causality, and is outside the application’s routing layer. No new host redirect was added.

## Duplicate/canonical warning

The local export contains no exact URL list or Google-selected-canonical payload for the prior warning. Without those URLs, a URL-level duplicate classification cannot be stronger than `UNRESOLVED_INSUFFICIENT_EVIDENCE`; current representative routes emit one canonical matching the final URL.

## 5xx validation

No exact URLs from the July 28 validation report were available in the local evidence. Three consecutive live requests each returned HTTP 200 for WAB EPS, DELL revenue, GOOGL net income and GM revenue; `/api/health` returned 200 and slash normalization returned one 301. Classification: **`UNRESOLVED_INSUFFICIENT_EVIDENCE` for the historical URL set**, with no current application defect demonstrated. Do not modify production code for a historical 5xx claim without exact failing URLs or reproducible logs.

## Google versus Bing

Bing’s stronger reported clicks and zero active issues are directional only. Crawling, indexing, ranking, audience and SERP layouts differ. The data does not prove that canonicalization caused Google’s lower CTR; current Google-specific technical problems remain a plausible contributor, not a demonstrated cause.
