# SEO V1 production canary cohort

Status: **prepared only — not deployed** (2026-08-16).

Bing page/query exports were not available in this checkout, so the release
gate permits only this initial 20-page canary. Global template rollout is not
approved. No sitemap submission or IndexNow request is part of the canary.

## Exact URLs

These are existing stock/metric routes with a complete local raw-HTML gate
(including an explicit reporting period). No URLs were created.

1. `https://www.stockportfolio.pro/stocks/AAP/free-cash-flow`
2. `https://www.stockportfolio.pro/stocks/WAB/eps`
3. `https://www.stockportfolio.pro/stocks/WAB/shares-outstanding`
4. `https://www.stockportfolio.pro/stocks/WAB/dividend-history`
5. `https://www.stockportfolio.pro/stocks/AAP/revenue`
6. `https://www.stockportfolio.pro/stocks/AAP/eps`
7. `https://www.stockportfolio.pro/stocks/AAP/shares-outstanding`
8. `https://www.stockportfolio.pro/stocks/AAP/total-debt`
9. `https://www.stockportfolio.pro/stocks/AAP/net-income`
10. `https://www.stockportfolio.pro/stocks/AAP/pe-ratio`
11. `https://www.stockportfolio.pro/stocks/AAP`
12. `https://www.stockportfolio.pro/stocks/DELL/shares-outstanding`
13. `https://www.stockportfolio.pro/stocks/ACI`
14. `https://www.stockportfolio.pro/stocks/DBX`
15. `https://www.stockportfolio.pro/stocks/META`
16. `https://www.stockportfolio.pro/stocks/WAB/revenue`
17. `https://www.stockportfolio.pro/stocks/WAB/net-income`
18. `https://www.stockportfolio.pro/stocks/WAB/free-cash-flow`
19. `https://www.stockportfolio.pro/stocks/WAB/total-debt`
20. `https://www.stockportfolio.pro/stocks/WAB/pe-ratio`

## Excluded routes

- `/` and `/stocks` are not in this SSR canary because the local SEO renderer
  does not own those routes (`/` and `/stocks` returned local 404s). They need a
  separate production/static-shell smoke check before inclusion.
- Comparison pages are deliberately held out of this canary because their
  current first answer does not expose an explicit reporting period in raw
  HTML. They require a separate evidence-backed template decision.

## Canary checks

Before enabling any broader rollout, verify for each URL:

- production HTTP 200;
- canonical exactly equals the URL above;
- robots remains indexable;
- title, H1, first answer, period, source, methodology and crawlable links are
  present in raw mobile HTML;
- representative Googlebot, Bingbot and normal-user requests produce zero
  Ollama/external-LLM calls;
- no unexpected sitemap or `lastmod` change occurs.

The canary is the maximum approved rollout while Bing page/query evidence is
missing.
