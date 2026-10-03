# Verified SEC coverage release readiness — 2026-10-04

## Release decision

Ready for the separately authorized deployment after the committed release passes the clean-checkout checks below. No push or deployment was performed during this work.

The directory contains **6,099 securities**. **4,442 distinct companies** have recent annual SEC reports and the verified core financial data required for company coverage. Additional issuers have partial or historical data, labeled accordingly.

The release integrates the SEC implementation with production data commit `df49a84f35b82b46a9de3cb81014af24c8fc181d`. Fresh production quote inputs and the DMC provider input were retained when resolving the merge. Resolve the release SHA with `git log -1 --format=%H -- docs/sec-production-readiness-2026-10-04.md`; the final delivery also identifies the SHA.

## Verified counts

| Measure | Count |
| --- | ---: |
| Directory securities | 6,099 |
| Identified eligible equity issuers | 5,879 |
| Recent annual SEC reporting issuers | 5,274 |
| Ready issuers | 4,442 |
| Partial issuers | 391 |
| Historical-only issuers | 598 |
| Unavailable issuers | 448 |
| Screenable listings before issuer deduplication | 4,500 |
| Screenable issuers | 4,442 |

- Unresolved directory identities: **25** records; profiles remain accessible and excluded from verified issuer counts.
- Network verification failures: **0**. Financial verification failures: **0**.
- Successful submissions checks: **5,879/5,879 (100%)**; threshold 98%.
- Completed company-facts attempts for recent annual issuers: **5,274/5,274 (100%)**; threshold 95%.
- Verified issuer files: **5,724**. Retained verified values: **4,872,473**. Dataset audit errors: **0**.
- Calculation date: **2026-10-03 UTC**; generation timestamp: **2026-10-03T20:01:58.558Z**.
- Policy version **1**, public schema **1**, screen snapshot version **4**.
- Dataset ID: `c5fbcdb8247324a26e1aeb0f9e4b4efed40c44a8a46847c386af3ba063b26c09`. Both snapshots carry this generation.
- Public snapshot: **7,247,306 bytes**; screen snapshot: **5,807,328 bytes**. Both below 8 MiB.

Reporting and financial completeness are separate statuses. Of the historical-only issuers, 389 have a recent annual report but only older usable financial observations; their profiles explicitly state that the latest annual financial data is unavailable.

## Exact readiness definition

A validated ten-digit SEC CIK identifies an issuer. Its latest original annual report is a 10-K, 20-F or 40-F, selected by report-period end and then filing date. The original filing date is within the inclusive rolling 12 calendar months; the report-period end is valid, not future, and at most 18 calendar months old. A successful submissions check is at most 35 days old. An amendment does not reset the original annual filing clock.

The same qualifying annual report, or an established amendment for that report period, supplies net income, total assets, shareholders’ equity, operating cash flow, and at least one of revenue, basic EPS or diluted EPS. Each required figure has exact SEC fact provenance, compatible units and currency, and actual period dates. Annual duration facts cover 340–380 days; balance facts are instant values at that annual period end. Zero and negative figures remain valid. Missing fields stay null. Readiness does not claim timely completion of every required SEC filing.

## Fixes included

- Checked every populated financial field at the verified adapter boundary, including fields absent from source maps. Suppressed unsupported security-basis data and future facts.
- Preserved the last valid annual financial file when a same-period extraction loses verified fields; allowed genuine newer annual periods and verified zero-valued corrections.
- Removed 86,358 unsafe optional observations from 3,547 issuer files, including invalid subtotal substitutions and incompatible taxonomy meanings. Rebuilt financial digests and both snapshots.
- Included quotes, actual price-history contents, FX and screen rows in generation fingerprints. Fixed calculated CAGR precision across Node 22 and Node 26.
- Added paired snapshot publication with rollback and tests for a failed second rename. Runtime refuses incompatible generations.
- Unified offline and bounded on-demand refresh calculations, including optional USD presentation and genuine content-change dates.
- Moved public financial calculators to the verified adapter, with native-currency labels, exact-period joins, source metadata, null preservation and unit/right rejection. Comparisons require two ready companies; incompatible-currency monetary comparisons remain unavailable.
- Kept provider market data dated and separately labeled. Verified company quotes bypass legacy SEC-share overlays that infer security basis from provider scale.
- Preserved reported zero gross profit, rejected ratios with unsuitable denominators, selected prior quarters by dates, and required complete comparable annual profitability windows.
- Corrected historical-only profile wording, dated market tiles and unsupported-data indexing behavior.
- Added a disposable local MongoDB production-mode startup harness with an explicit environment that contains no production credentials.

## Acceptance evidence

| Check | Result |
| --- | --- |
| Targeted regression suites, Node 22.23.3 | 236 passed; 0 failed; 0 skipped |
| Read-only dataset audit and bootstrap thresholds | Passed on Node 22 and Node 26 |
| Exhaustive offline rendering | 6,099 profiles; 27,800 metric pages; 2,899 comparisons; 9 sitemap shards; no errors |
| Cold sitemap inventory and root XML | 110.1 ms; limit 500 ms |
| Cold public snapshot | 142.1 ms |
| Cold screen snapshot/tool load | 181.8 ms |
| Service RSS in 256 MiB heap harness | 223.9 MiB; limit 400 MiB |
| Maximum event-loop delay | 16.9 ms; limit 500 ms |
| Maximum concurrent health/request batch | 35.3 ms; limit 500 ms |
| Production-mode application startup | Health, coverage, screener and sitemap HTTP 200; ready, partial, historical-only, unavailable, unit and right profiles HTTP 200 with correct canonical and robots directives |
| Fresh dependency installs | Root and backend `npm ci` passed; Node 22 used for release acceptance |
| Release scope | Unrelated notes, analytics, comparison discoveries and mockups preserved; no whole-worktree staging |

The performance figures come from a separate local HTTP harness. They are neither a production load test nor live-site verification. Full application startup uses fresh dependencies, no environment files, disabled background jobs and a disposable local database. The committed SHA is rechecked in an isolated clean checkout before delivery.

### Reproduce acceptance

```sh
npm ci --no-audit --no-fund
npm ci --prefix backend --no-audit --no-fund
node scripts/test-stock-coverage.js
node scripts/validate-stock-coverage.js --bootstrap
node scripts/verify-public-stock-pages.js
node --max-old-space-size=256 scripts/check-stock-coverage-performance.js
node scripts/check-stock-coverage-startup.js
```

Use Node 22. The startup check requires a local `mongod` binary and refuses checkouts containing production environment files. The deployment workflow validates the triggering SHA, gates deployment on success, passes that SHA as Render `commitId` and checks the returned deployed commit. The initial audit retains honest partial and unavailable outcomes.

## Remaining supported limits

- Company Facts may omit custom, segmented or otherwise nonstandard taxonomy facts. Missing data is not manufactured.
- US GAAP and IFRS core readiness mappings are supported. Optional subtotal concepts with different meanings remain unavailable.
- EBITDA, complete debt, capex, dividends, ratios and growth history have individual availability rules; ready coverage does not guarantee any specific optional metric.
- Share-class and ADR conversion overrides have not been invented. Ambiguous EPS, share counts, P/E and per-share calculations are suppressed.
- USD monetary presentations require complete stored FX evidence. Native-currency figures remain unchanged; missing conversion remains unavailable.
- Financial eligibility does not guarantee quote freshness or price history. Market figures keep their own dates and sources.
- Stored evidence ages: daily UTC eligibility recalculation removes expired issuers from current counts and screening. Scheduled refreshes are required after deployment.
- No deployment or authenticated live browser verification was performed. After deployment, verify the exact commit, health, screener, coverage counts, sitemap membership, representative profiles and aliases. An HTTP 403 is not rendered-page verification.
