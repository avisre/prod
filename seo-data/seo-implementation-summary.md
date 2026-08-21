# SEO implementation summary

## Implemented

1. Added `scripts/analyze-gsc-seo.py`.
   - Fetches real Search Analytics data for 3-month and 12-month windows.
   - Retrieves queries, pages and direct query+page dimensions.
   - Writes normalized CSVs and non-secret acquisition metadata.
   - Scores opportunities by impressions, striking-distance position, CTR gap, product relevance, commercial intent, scalability and implementation difficulty.
   - Produces the CSV and Markdown opportunity reports.
2. Changed the reusable metric-page title template in `backend/seo-extra.js`.
   - EPS pages now say “Earnings per Share (EPS)” instead of only “EPS”.
   - Titles put the ticker and exact metric phrase first, followed by the latest filed value and company name.
   - This directly addresses the GSC query/page mismatch observed for WAB earnings-per-share and shares-outstanding searches without creating new thin pages.
3. Preserved the existing source-backed architecture: SEC citations, fiscal periods, charts, CSV exports, canonical URLs, JSON-LD, sitemap inclusion and contextual links remain intact.

## No speculative changes

- No new programmatic page set was generated.
- No financial figures were hard-coded.
- No AI-generated editorial pages were added.
- No healthy robots, canonical, sitemap or analytics infrastructure was changed.

## Verification

- Python acquisition/analysis script completed against the authorized domain property.
- 3-month and 12-month CSV schemas and row counts were checked.
- `python3 -m py_compile scripts/analyze-gsc-seo.py` passed.
- `node --check backend/seo-extra.js` passed.
- SEO, sitemap, public-tool, reliability and customer-registry tests passed: **25/25**.
- Representative rendered metric pages contain title, canonical, meta description, H1, source link, chart, table, JSON-LD and CSV link.

## Remaining manual Search Console action

No authorization repair is required: the service account has `siteFullUser` on `sc-domain:stockportfolio.pro`. After the deployment containing the title-template fix is live, use Search Console URL Inspection or wait for recrawl; Search Console will not reflect the new titles until Google crawls the affected pages.
