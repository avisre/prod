# Ask repairs — 2026-10-04

## Status

The six engineering findings from the Ask evaluation are repaired locally. The release includes tests and a matching public/screener snapshot pair. It has not been pushed or deployed. A broader real-model answer benchmark remains pending because this shell has no AI credentials; production environment files were not read.

## Repairs and evidence

| Finding | Repair | Verified outcome |
| --- | --- | --- |
| Wrong year-over-year quarter | Date and duration matching with deterministic growth; prior-year inputs included regardless of requested row limit | Apple June 27, 2026 versus June 28, 2025: revenue 16.3565%, net income 27.1187% |
| Invented calendar month ends | Explicit fiscal dates in observations and prompt instructions | Annual Apple cash periods remain September 27, 2025 and September 28, 2024 |
| Unclear cash calculation | FCF formula and both verified input references | FY2025 FCF USD 98,767,000,000; FY2024 USD 108,807,000,000 |
| Full issuer source history in every request | Selected field observations, scoped sources, raw values, derivations and sign transformations | Two-year Apple income approximately 16 KB, versus approximately 812 KB before repair |
| Unsupported instruments abort all research | Catch each tool failure, return structured error codes and continue supported calls | Unit/right failures and Apple results coexist in the same successful synthesis |
| Share-basis bypass in quotes | Quote tool consumes the verified market view; shared adapter suppresses unresolved P/E/share counts | BRK.B, GOOGL and MUFG do not expose ambiguous EPS or P/E |
| Conflicting currency and freshness claims | Native currencies and chart units; separate market, period, filing and check dates | MUFG reports JPY; quote financial date is the actual annual period, not provider-fetch date |
| Missing sources and unsupported model-memory numbers | Exact SEC links supplied and appended; numeric financial answers with no research get one retry then a truthful fallback | Scripted unsupported numbers cannot become a successful financial answer |

Each tool result is bounded to 64 KiB and research results are bounded to 192 KiB per question. Oversized histories explicitly disclose omitted older periods and support the `before` cursor. Results that exceed the remaining budget return an availability error instead of silently losing observations. Every tool call still receives a response. Ratio observations include formulas and verified inputs, with period/currency checks and matched scopes for ROE.

Ask line charts keep null/placeholder observations as gaps; bars omit missing observations and retain reported zero. Native-currency formatting is covered by executable renderer tests.

The shared asset stamp is `20261004-askverified1`, updated across static pages, server renderers and pinned tests. The deployment validation runner includes the Ask evidence, loop, streaming, history and access regressions.

## Verification

- 322 targeted release regressions passed, including 23 new Ask evidence cases. Local Node: v26.9.0.
- Apple regression periods use a fixed verified SEC fixture, so daily refreshes do not rewrite expected growth figures.
- Existing directory and coverage counts remain unchanged: 6,099 listings; 4,442 ready issuers; 4,500 screenable listings.
- Resource harness: cold sitemap 107.6 ms; RSS 274.9 MiB; maximum event-loop delay 9.2 ms; health/request batch 35.4 ms. This is a local harness, not a production load test.
- Read-only dataset validation passed with no structural, provenance or fingerprint errors; submissions/facts verification remains 100% / 100%.
- Exhaustive offline rendering passed: 6,099 profiles, 27,800 metric pages, 2,899 comparisons and nine sitemap shards.
- Clean-checkout full application startup passed: health, coverage, screener and sitemap HTTP 200; representative ready, partial, historical-only, unavailable, unit and right profiles HTTP 200. The checkout excludes production environment files, reuses installed dependencies and starts disposable local MongoDB; no fresh dependency install or production connection was performed.

Reproduce with:

```sh
node scripts/test-stock-coverage.js
node scripts/validate-stock-coverage.js --bootstrap
node scripts/verify-public-stock-pages.js
node --max-old-space-size=256 scripts/check-stock-coverage-performance.js
# Only in a checkout without production environment files:
node scripts/check-stock-coverage-startup.js
```

## Remaining verification limits

The tests exercise real financial tool handlers and scripted model responses. They prove the corrected inputs, arithmetic and control flow; they do not prove that every real model answer will use those inputs correctly. The no-research guard is not a claim-by-claim semantic verifier of all generated prose. Exact source links allow checking reported claims, but an appended source list alone does not certify the answer.

Before release approval for Ask, rerun real answers in both modes across quarterly comparisons, foreign currencies, multiple share classes, missing data, historical data, units/rights and follow-ups. Verify both streaming and final responses. No authenticated browser or deployed repair has been verified in this task.
