# Canadian companies audit — 2026-11-08

Sources audited (all local, dataset asOf 2026-11-07):

- `frontend/data/fundamentals/*.json` — 4,642 Alpha Vantage-sourced files (overview Country/Currency + prices)
- `frontend/data/financial-coverage.json` — 5,512 SEC coverage records
- `frontend/data/screen-index.json` — 5,065 rows with `financialCurrency`, `latestQuarterEnd`, coverage status
- `frontend/data/quotes.json` — 6,142 quotes, asOf 2026-11-06
- `frontend/data/stock-universe-manifest.json` — universe = **US exchange-listed common equities incl. operating-company ADRs** (SEC-based; TSX-only companies are out of scope by definition)
- `docs/global-companies/snapshot-2026-10-26.json` — 50 famous non-SEC global companies

## How many Canadian companies we have

Total identifiable: **~158**, found two different ways:

1. **86** flagged `Country = Canada` in their fundamentals overview.
2. **+72** more that file in CAD in `screen-index` but have no Country flag in fundamentals — includes the big banks and majors missing from set 1: TD, BMO, BNS, CM, CNQ, CP, MFC, TRP, IMO, CVE, SLF, CCJ, FTS, TECK, PBA, BCE, RCI, GIB, GFL, EMA, TU, CAE, STN, GOOS, …

> Caveat: `financial-coverage.json` records carry no country field, and 1,595/4,642 fundamentals files have empty overviews, so a USD-reporting Canadian with no overview flag would be invisible to both methods. 158 is a floor, not a proven complete count.

## Coverage status of the 86 fundamentals-flagged Canadians

| Status | Count | Tickers |
|---|---|---|
| ready | 78 | — |
| historical_only | 3 | ASM, CGAU, XNDU |
| partial | 2 | HSLV, TMCR |
| unavailable | 2 | AYA (`no_facts`/404), OGC (no recent annual, 0 annual periods on record) |
| not in coverage dataset | 1 | OBAWU (Oxley Bridge Acquisition — a SPAC *unit*) |

## Data-quality findings

1. **Quarterly data is systematically stale for Canadian names.**
   18/78 indexed Canadians (23%) have `latestQuarterEnd < 2026-06-30` vs 6.2% universe-wide.
   Worst offenders: AEM (2014-06-30), IAG (2017-12-31), GROY (2022-12-31), POET (2023-12-31).
   Also stale: B, BN, BEP, FNV, WPM, TRI (2025-06), DSGX (2025-07), RY (2026-01, normal bank lag), AQN, DCBO, ELVA, TFPM, TRX, USAS.

2. **Root cause = filing form.** 62/85 (73%) of covered Canadians use `issuer_specific_interim` cadence vs 20% universe-wide. These are 40-F / 6-K foreign private issuers; the quarterly extractor mostly fails on their interim reports even though `latestInterim` and `financialAttemptResult: success` show the checks themselves are running (interims fresh to 2026-09/10/11).

3. **Consecutive-quarter income coverage is dramatically worse.**
   `fourConsecutiveIncomeQuarters` true for only **16/85 (19%)** of Canadians vs 3,499/5,512 (63%) universe-wide. Any Ask/screen feature depending on quarter runs will under-serve Canadian tickers.

4. **Currency mislabeling risk.** All 86 fundamentals overviews say `Currency = USD` (listing feed). Actually **75** Canadians in screen-index file in CAD — including 3 inside the fundamentals-Canada set: **ENB, RY, HOVR**. TTM/ratio fields sourced from the US-priced feed may mix trading currency and reporting currency.

5. **Fundamentals freshness unverifiable / old.** Only 8/86 files carry `fetchedAt`: 7 from a 2026-09-28 batch (EXK FSM GAU TRX MUX SVM HOVR) and LULU (2026-10-04). The other 78 have no stamp at all.
   (Quotes are fine: all 86 present in `quotes.json`, asOf 2026-11-06.)

6. **Sector skew:** Basic Materials 47/86 (55%) — the cross-listed set is dominated by miners/royalty names.

7. **TSX-only companies are entirely absent.** The global-companies snapshot of 50 famous non-SEC companies contains **zero** Canadians (Germany 10, France 7, CH 6, JP 6…). Marquee TSX-only names (Couche-Tard, Dollarama, Loblaw, Constellation Software, Bird Construction BDT.TO, Coveo CVO.TO, Covalon COV.V) are out of scope — consistent with past connector lookups (BDT.TO, BIRDF, CVO, CVALF all returned COMPANY_NOT_FOUND).

## Sanity checks passed

- No ticker collisions inside fundamentals Canada set: `T` = AT&T and `PPL` = PPL Corp are US; Canadian telecom/pipeline sit under TU/BCE/RCI and TRP/PBA/ENB. `B` = Barrick Mining Corp (2025 re-ticker from GOLD) is correct.
- Zero parse errors across all 4,642 fundamentals files.
- AYA (newly Nasdaq-listed) failing with `no_facts` is expected for a fresh foreign listing without XBRL companyfacts yet; OGC shows an interim (2026-09-30) but no annual on record.

## Suggested priorities (no changes made)

1. Fix the 40-F/6-K interim extractor gap — it single-handedly explains findings 1–3 for ~62 names.
2. Add a `country` field to coverage records (or snapshot the fundamentals Country into them) so this audit becomes reproducible instead of heuristic.
3. Reconcile `Currency` (listing) vs `financialCurrency` (filings) wherever a CAD filer shows USD overview data (ENB, RY at minimum).
4. Decide whether TSX-only Canadian coverage matters commercially (Maj's custom-table request suggests buyer interest exists) before extending the global snapshot to Canada.
