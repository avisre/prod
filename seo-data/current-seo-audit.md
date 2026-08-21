# StockPortfolio.pro current SEO audit

Audit date: 2026-08-10. Repository inspected: server-rendered StockPortfolio.pro production architecture.

## Routing and rendering

- `backend/app.js` is the Express entry point. Public SEO routes are registered before static serving and are rendered by `backend/seo-pages.js` and `backend/seo-extra.js`.
- The core crawlable surfaces are `/`, `/stocks`, `/stocks/:ticker`, `/stocks/:ticker/:metric`, `/compare`, `/compare/:pair`, `/screens/:slug`, `/research/*`, `/screener`, `/tools` and the 30 deterministic free-tool pages.
- `/company?symbol=` is an interactive view with server-injected title, description and canonical pointing to `/stocks/:ticker` when a canonical stock page exists.
- The screener is server-rendered with an initial table and then hydrated by client JavaScript; stock links are present in initial HTML.
- SSR responses are cached only for allowlisted public HTML/XML routes, with no `Set-Cookie`, in `backend/ssr-cache.js`.

## Page types inspected

- Company/security pages: annual and quarterly fundamentals, filing-derived metrics, health checks, sources, FAQs, related metric links and peer comparisons.
- Metric pages: revenue, net income, gross profit, EPS, EBITDA, free cash flow, debt, shares outstanding, dividend history and P/E history, each with a table, chart, SEC source and CSV link.
- ETF/fund/bond support: the public stock SEO universe is primarily US equity/company pages; the interactive asset/fundamental APIs handle supported funds and non-equity instruments. They should not be added to the stock sitemap unless a real indexable page exists.
- Screeners and comparisons: crawlable preset pages under `/screens/` and canonical alphabetical `/compare/A-vs-B` pages with source-backed tables and contextual tool links.
- SEC and research tools: 30 public deterministic tools plus `/research/*` guides and `/monitor`/filing-related product surfaces.

## On-page SEO

- Server-rendered pages emit one `<title>`, a meta description, `robots=index, follow`, canonical URL, Open Graph/Twitter metadata, organization/software JSON-LD and page-specific Breadcrumb/FAQ/WebPage/ItemList data where appropriate.
- Public pages use a sensible H1 and H2 sections. Metric pages expose the answer, fiscal period, methodology, SEC link and downloadable CSV in initial HTML.
- The metric title template now puts the exact metric phrase and ticker first (for example, `WAB Earnings per Share (EPS) History...`) so abbreviations cannot make Google associate a query with a neighboring metric page.
- Financial claims are computed from cached SEC filings; pages state refresh context, limitations and no-advice language. No generic AI articles are generated.

## Crawl and duplication controls

- `frontend/robots.txt` allows public research surfaces and disallows `/api/`, dashboards, legacy `/v1`/`/v2` paths and authenticated utility surfaces. Login/news pages remain crawlable where needed so their `noindex` can be observed.
- `/sitemap.xml` is a sitemap index. Child shards separate core, stock, metric and comparison URLs; only metrics with real data and canonical comparisons are included. `/tools` and all 30 tool routes are in the core shard.
- Trailing slashes are normalized by the server. Query-string variants retain the path canonical; acquisition parameters are not separate indexable pages.
- Interactive `/company?symbol=` URLs canonicalize to their server-rendered stock page. Invalid stock symbols return a safe 404/stock-directory response rather than fabricated content.

## Findings from the real GSC data

- 3 months (2026-05-10 to 2026-08-07): Search Analytics aggregate totals are 17 clicks, 9,332 impressions, 0.18% CTR and average position 12.29. The exported query rows are privacy-filtered (632 queries; 5,503 summed query impressions), and exported page rows sum to 11,822 impressions because Search Console dimension totals are not additive.
- 12 months returns the same sampled rows and totals, indicating that the property/API has only recent available data rather than a full historical baseline.
- The strongest clusters by query impressions are earnings/profit (2,935), other (1,626), shares/dilution (591), revenue (137), and comparisons (124).
- One comparison query/page pair generated a click. Most financial queries are in positions 4–20 with no click yet: these are striking-distance opportunities, not evidence that more pages should be generated.
- Several WAB queries for “earnings per share” and “shares outstanding” were associated with neighboring metric URLs. This prompted the exact-phrase/ticker-first title-template fix in `backend/seo-extra.js`.

## What is healthy

Canonical tags, SSR content, source links, sitemap sharding, robots directives, structured data, and authenticated/public route boundaries are already implemented. No broad infrastructure rewrite is justified by this snapshot.
