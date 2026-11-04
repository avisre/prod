# IR-page feasibility findings — can investor-relations pages fill the missing cells?

Generated 2026-11-01, local research only (no production writes, nothing pushed).
Evidence: live fetches of each company's IR site + robots.txt, earnings press
releases, SEC 10-Q documents, and the 2026-11-01 audit data.

## Executive verdict

**No — IR scraping is not the right fix for the main problem.** The dominant
fillable gap buckets (`sec_has_mapped_tag` 1,440 + `sec_has_alt_tag` 20,843 =
22,283 cells across 4,542 stocks) are values **already inside the SEC XBRL data
the app downloads**. Those are extraction bugs in our own pipeline: fixing the
extractor fills them with one standardized, already-licensed data flow. IR
pages would be a strictly worse source for the same numbers (unstructured,
condensed, per-company formats, partial periods).

IR pages can only ever fill a small slice — and only for a minority of stocks.

## Decision table by gap bucket

| Bucket | Cells | IR-fillable? | Evidence |
|---|---|---|---|
| `sec_has_mapped_tag` | 1,440 | **No — pointless** | Value already in our SEC cache under a tag the extractor reads. EML's 55 gaps are almost all this bucket; its IR site (easterncompany.com/financial-news) contains no statement tables at all. Fix the extractor instead. |
| `sec_has_alt_tag` | 20,843 | **No — pointless** | Value already in our SEC cache under a us-gaap tag we don't read yet. Adding tag mappings fills it. E.g. FUL's gaps are mapped/alt-heavy; its IR release contains only a condensed subset (~15-20 line items, quarter+YTD only) of the same figures. |
| `not_reported` | 105,086 | **Mostly no (small partial)** | Company files no such figure to SEC. IR press releases only carry headline metrics. FLYX's Q2-2026 earnings PDF (fetched): revenue, gross profit %, adjusted EBITDA, guidance — **zero balance sheet, zero cash flow, zero income statement**. FUL/INFQ releases do include condensed balance sheet + cash flow, but only selected lines. Rare wins: FUL's press release shows cash & equivalents where SEC `Cash & short-term investments` is blank — but only half the app row (no ST investments). Biotech (ZURA 35/53, HSCS 22/39): releases show cash/R&D/net-loss only. |
| `no_statement_rows` | 24,407 (288 stocks) | **No — misdiagnosed** | SEC file exists; extraction produced zero rows. That's an extractor failure, not a data absence. IR scraping can't out-yield the full XBRL filing we already have. |
| `no_sec_file` | 1,280 (19 stocks) | **Yes — the one real IR case** | No SEC filing on record (e.g. some foreign/odd filers). IR press releases are the only public source. But it's 19 stocks and the releases are condensed. |
| `missing_unchecked` | 13,970 | **No** | Tier-2 stocks with no XBRL facts in our bulk zip. Fix = broaden the SEC facts download, not IR scraping. |

## Spot-check evidence (all fetched 2026-11-01)

| Sym | Gaps | IR destination | What it actually contains |
|---|---|---|---|
| EML | 63 (55 mapped) | easterncompany.com → Financial News / Financial Reporting | Menu pages only; no statement tables, news items are wire links. Adds nothing. |
| BTBD | 44 | btbrands.com | **Shell site** (cookie-consent script, no content). No IR presence at all. |
| FUL | 40 (mapped/alt-heavy) | investors.hbfuller.com (Q4 Inc. platform); Q3-2026 release on newsroom.hbfuller.com | Condensed B/S + cash flow + income lines: total current assets, AP, total liabilities, cash, inventory, PP&E, goodwill, debt, CFO, D&A, interest, tax, diluted EPS. ~15-20 lines, quarter+YTD only. Cannot fill 5 annual periods. |
| GIFT | 58 (29 mapped) | giftifyinc.com/investor-relations | Page exists but contains **no financial tables** — links to SEC filings and Nasdaq press releases. Adds nothing. |
| FLYX | 52 (26 mapped) | ir.flyexclusive.com + Q2-2026 release PDF (fetched) | Prose + headline metrics only (revenue $111.1M, gross margin 20.4%, adj. EBITDA $4.2M, guidance). **No B/S, no C/F, no I/S.** Fills ≤8 cells/quarter. |
| BLBD | 36 (25 mapped) | investors.blue-bird.com (Q4 Inc. platform) | Earnings releases + quarterly presentation PDFs; releases are condensed income + cash flow, no balance sheet. Values already in SEC data. |
| INFQ | 53 (22 mapped) | ir.infleqtion.com; Q2-2026 release (fetched) | Condensed B/S + C/F in release (total assets/liabilities, cash, SBC); 27 not_reported lines don't appear anywhere. |
| ZURA | 53 (35 not_reported) | investors.zurabio.com | Site live but WAF blocks scripted fetch (403). Biotech-style releases: cash, R&D, G&A, net loss, shares. The 35 not_reported cells mostly won't appear. |
| AIB | 53 | none found | aibdatacenters.com parked (registrar IP), no website in the 10-Q. Only source = SEC. |
| HSCS | 39 | heartsciences.com (real site) | heart-sciences.com is parked; real site has /news only, no IR section. ir.hearttest.com dead. Releases on GlobeNewswire, condensed. |

## Constraints discovered

- **Robots/ToS**: of the live sites checked, most are permissive (flyexclusive,
  hbfuller, infleqtion, zurabio all allow crawling); blue-bird.com blocks bots
  (403), zurabio.com WAF-blocks scripted fetches (403), easterncompany's is a
  58KB Shopify robots file.
- **Formats**: Q4 Inc. IR platforms (FUL, BLBD, and the majority of listed
  companies) render press-release lists via client-side JS APIs — scraping
  needs per-platform API reverse-engineering, not HTML parsing. Releases are a
  mix of HTML, PDF, and wire-service syndication (BusinessWire, GlobeNewswire,
  PRNewswire), each with its own layout and its own ToS.
- **Cadence**: IR releases exist for ~4-5 periods/year, not 5 annual + 8
  quarterly; they are condensed; historical archives are inconsistent.
- **Coverage of offender list**: 2 of 10 stocks have **no functional IR
  presence at all** (BTBD, AIB), 2 more have none with financial content
  (EML, GIFT). The audit's "IR page" assumption fails for small caps.

## Cost comparison

| Fix XBRL extraction | Build IR scraper |
|---|---|
| 1 pipeline, data already downloaded | N per-company scrapers (or N platform adapters) |
| Fills 22,283 cells across 4,542 stocks | Fills at most a few hundred headline cells for companies that publish them |
| Standardized us-gaap tags, machine-validated | Free-text parsing, PDF extraction, definitional drift (non-GAAP vs GAAP) |
| No ToS/WAF risk (SEC is the sanctioned source) | Blocking, ToS, maintenance churn per site |
| Days of work | Months of work, then ongoing upkeep |

## Recommendation (phased)

1. **Fix the extractor first** (fills 22,283 cells for 4,542 stocks):
   - `sec_has_mapped_tag` (1,440): find why extraction drops values for tags
     already in the mapping — likely a validation/period-matching bug. The
     audit already names the exact tag per cell.
   - `sec_has_alt_tag` (20,843): extend the tag map with the alt tags the
     audit identified.
   - `no_statement_rows` (24,407): diagnose why 288 issuers extract zero rows
     (fresh zip now available at ~/.cache/sec-bulk).
2. **Do not build a general IR scraper.** Keep IR as a manual, per-case
   fallback only for the `no_sec_file` bucket (19 stocks) and for a curated
   allowlist of companies whose IR releases publish lines SEC lacks (e.g.
   FUL-style cash breakdowns). Even there, store with a
   `source=ir_press_release` provenance flag and a non-GAAP caveat.
3. **Treat these as correct-by-design blanks** (neither SEC nor IR publishes
   them): banks' COGS/gross-profit, most biotech balance-sheet detail,
   royalty-trust income lines, and the ~35-40% of `not_reported` cells in the
   spot-check set.

## What data would still be missing after phase 1

- 105,086 `not_reported` cells minus small IR-recoverable wins — the company
  reports no such figure anywhere; the blank is the honest display.
- Quarterly cells where the company files only annually.
- The 19 `no_sec_file` issuers until individually researched.
