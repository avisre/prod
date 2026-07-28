# Engineering as Marketing: 30-tool local backlog

All 30 tools are implemented and previewable locally. Each tool is deterministic, public,
source-linked, rate-limited, canonicalized to its landing page, and connected
to a tracked StockPortfolio.pro/AppSumo CTA. No tool may make a price forecast
or invent a missing filing value.

## Filing and accounting

1. **Earnings Quality Checker** — revenue, net income, operating cash flow, FCF, cash conversion.
2. **Share Dilution Calculator** — filed share counts, change, split warning.
3. **SEC Filing Timeline** — recent 10-K, 10-Q, 8-K, Form 4 and proxy filings.
4. **Filing Change Detector** — latest filing versus prior filing by key XBRL line items.
5. **Revenue Growth Consistency** — annual revenue history, CAGR, positive-growth years.
6. **Profitability Trend** — net margin and operating margin across annual filings.
7. **Cash-Flow Quality** — operating cash flow versus net income across five years.
8. **Free-Cash-Flow Trend** — operating cash flow, capex and FCF direction.
9. **Working-Capital Analyzer** — receivables, inventory, payables and cash conversion.
10. **Debt Maturity Snapshot** — current debt, long-term debt and balance-sheet trend.

## Ownership, capital allocation and risk

11. **Buyback vs Dilution Checker** — repurchases compared with net share-count change.
12. **Insider Filing Explorer** — recent Form 4 activity with direct SEC links.
13. **Institutional Ownership Timeline** — available ownership filings and dates.
14. **Stock-Based Compensation Checker** — SBC against revenue, operating cash flow and dilution.
15. **Dividend Safety Checker** — dividend cash outflow versus FCF and earnings.
16. **Interest-Coverage Checker** — operating income versus interest expense.
17. **Altman-Style Balance-Sheet Signals** — transparent component values and limitations.
18. **Goodwill Concentration Checker** — goodwill relative to assets and equity.
19. **Receivables Warning Check** — receivables growth versus revenue growth.
20. **Inventory Warning Check** — inventory growth versus revenue growth.

## Portfolio, ETF and comparison workflows

21. **Portfolio Filing Alert Scanner** — latest filing activity across selected holdings.
22. **Portfolio Revenue Exposure** — aggregate revenue-growth and margin profile.
23. **Portfolio Dilution Monitor** — share-count change across holdings.
24. **ETF Holdings Overlap** — shared holdings and concentration between two funds.
25. **ETF Sector Concentration** — sector weights and largest-position contribution.
26. **Company Comparison Snapshot** — revenue, margin, FCF and share-count comparison.
27. **Peer Cash-Conversion Ranking** — comparable cash-conversion ratios across peers.

## Source-backed workflow accelerators

28. **Ask Question Builder** — construct a cited filing question from a company/ticker.
29. **Filing Evidence Checklist** — checklist of primary documents for a research claim.
30. **Research Dossier Starter** — assemble filing links, periods and metrics for the existing dossier workflow.

## Build gate

Implement tools in batches of five. Before each batch, inspect Search Console and
Bing demand, then score search intent, data reuse, workflow relevance, effort,
and financial-accuracy risk. Do not create indexable ticker-result pages. After
30 days, keep only tools that produce completed uses plus qualified CTA activity,
signups, trials, activations, or customers.

## Google and Bing release checklist

The catalog page and all 30 landing pages are included in the existing `core`
sitemap shard. Do not submit localhost or unpublished URLs to either search
engine. After the approved production deployment:

1. Smoke-test `/tools` and all 30 tool URLs in production, including their
   canonical tags, mobile layout and company/ticker autocomplete.
2. Confirm `https://www.stockportfolio.pro/sitemaps/core.xml` contains exactly
   30 `/tools/…` URLs and that the root sitemap index still returns HTTP 200.
3. Submit `https://www.stockportfolio.pro/sitemap.xml` to both the historical
   URL-prefix and the domain Search Console properties. Preserve the URL-prefix
   property because its historical data does not migrate.
4. Confirm the Search Console service account has Full permission and a page
   query succeeds before recording the submission as complete.
5. Resubmit the same root sitemap in Bing Webmaster Tools, then verify the feed
   status and URL count with `scripts/bing-webmaster-stats.py`.
6. Use URL Inspection for `/tools` and the three initial pilot pages. Request
   indexing only after the live HTML and canonical URLs are verified.
7. Send the 31 newly deployed URLs (`/tools` plus 30 landing pages) through
   IndexNow. Do not use `--all`; unchanged site URLs do not need resubmission.
8. Record indexed status, impressions, clicks, completed uses, CTA clicks,
   signups and trials per tool after 7, 14 and 30 days.

Google/Bing submission is intentionally a post-deployment task: the current
local preview is not crawlable and the user has not approved a production push.
