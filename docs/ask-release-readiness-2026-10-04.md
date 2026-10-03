# Ask release readiness — 2026-10-04

## Release decision

The scoped Ask changes are validated locally and ready for the separate release action. They replace the earlier Ask hold recorded in the initial evaluations. Branch: `ask-production-ready-20261004`. Shared asset stamp: `20261004-askquality2`.

No push, deployment or authenticated production-page verification was performed. The commit SHA is recorded in the release handoff and local QA receipt after committing this report.

## Changes

- Financial charts must match supplied source values in their declared currency and raw units. Category comparisons use bars; time-series dates and metric labels are checked. Missing values remain missing.
- Displayed monetary claims and percentages are checked against supplied observations and compatible calculations. Annual comparisons preserve actual periods, currency, scope, derivations and input sources.
- Dividend-plus-buyback coverage uses both cash-outflow magnitudes. Apple's FY2025 FCF was USD98.767bn versus USD106.132bn of distributions, a USD7.365bn shortfall.
- Share-class and ADR restrictions have accurate missing-data explanations. Unit/right errors retain the instrument type, while other supported research continues.
- Invalid output gets one bounded rewrite. If it still fails, Ask returns a clearly labeled partial response containing verified figures. A synthesis outage after successful research also preserves those figures. Financial streaming text is held until these checks finish.
- Ordinary answer budgets are 250 prose words in normal mode and 350 in analyst mode, with support for explicitly requested detail. Default financial histories are shorter; explicit history requests and pagination remain supported.
- Charts resize to their actual container, use readable currency axes and preserve complete accessible labels. Tables support keyboard scrolling; long links wrap on mobile. Zero bars remain zero.
- Known retired direct-service configuration migrates to its supported successor in both streaming and ordinary requests. Explicit supported configurations and custom endpoints remain intact. No production environment file was changed.
- The existing deployment regression runner now includes answer-quality and connection-configuration regressions. Authentication, paywall and non-company routes retain their existing behavior.

## Acceptance evidence

| Check | Result |
| --- | --- |
| Targeted regression runner | 343 passed, zero failures on Node 22.23.3 and Node 26.9.0; repeated successfully from the staged checkout on Node 22 |
| Final real AI sample | 10 answers: all passed final checks; two needed the bounded rewrite |
| Desktop/mobile answer rendering | 20 renders at 1440px/390px; zero page overflow; all eight expected chart renders present |
| Displayed answer length | 131–286 words; median 187.5 across the ten desktop renders |
| Sample answer latency | 2.7–9.6 seconds |
| Read-only dataset audit | Passed; zero structural, provenance or fingerprint errors |
| Exhaustive public rendering | 6,099 profiles, 27,800 metrics, 2,899 comparisons, nine sitemap shards; zero errors |
| Node 22 resource harness, 256 MiB heap | Cold sitemap 96.3 ms; RSS 221.3 MiB; maximum event-loop delay 8.7 ms; maximum health batch 35.9 ms |
| Clean staged-checkout startup | Passed on Node 22 and Node 26; health, coverage, screener, sitemap and six representative profiles returned HTTP 200 |

The final sample covers normal and analyst answers, actual financial streaming, quarterly growth, JPY statements, suppressed share-class/ADR metrics, partial data, historical data, units/rights, a follow-up and annual FCF. It uses the actual configured AI connection and financial tools, with an authorized AI-only credential loader and production database connections disabled. The final saved answers also passed a separate read-only re-audit.

Local evidence is retained under `docs/qa/ask-release-2026-10-04/`, including raw answers, tool traces, streamed events, revision attempts, audit results and screenshots. Those artifacts are local and are not part of the release commit. Earlier rounds and the repeat run are retained separately; they are not counted as ten additional final-code successes. A repeat-run rejection demonstrated the partial fallback, and regression fixtures exercise incorrect scale, false coverage, bad percentages, missing-basis explanations, rewrite failure and synthesis outages.

Browser checks use the actual shared renderer and CSS in an isolated answer harness. They do not certify the authenticated full Ask page. The clean checkout excludes production environment files, reuses installed dependencies and uses disposable local MongoDB; it is not a fresh dependency-install check. The performance measurements are an isolated local HTTP harness, not a production load test.

## Coverage remains unchanged

Dataset date: `2026-10-03`; policy version 1. Dataset ID: `e00d33938091d035f2a36c1ec432bc38bddb7466b7a35d011a272f27dc932aa0`.

| Count | Value |
| --- | ---: |
| Directory securities | 6,099 |
| Identified issuers | 5,879 |
| Recent annual SEC reporting issuers | 5,274 |
| Financially ready issuers | 4,442 |
| Partial / historical-only / unavailable issuers | 391 / 598 / 448 |
| Screenable listings / issuers | 4,500 / 4,442 |
| Unresolved identity mappings | 25 |
| Network / financial verification failures | 0 / 0 |
| Successful submissions / completed facts attempts | 100% / 100% |

Readiness requires validated issuer identity, a qualifying original annual SEC report within twelve calendar months, a valid annual period within eighteen months, a submissions check within 35 days, and sourced annual net income, assets, equity, operating cash flow and at least revenue or EPS from that annual filing or its verified amendment. Country and operating location do not affect eligibility. These are dataset audit counts; this Ask release does not expand the underlying coverage or establish ambiguous per-share/ADR conversions.

## Limits and follow-up

The checks validate specific numeric, chart, currency, date and coverage rules. They are not a universal semantic verifier of every causal sentence or a guarantee that every future response will be correct. Some sampled answers still repeat a figure or add an unrequested comparison. Incomplete SEC facts, unresolved security bases and unavailable market data remain explicit gaps. Buffering financial synthesis trades immediate prose streaming for validation; research progress remains visible.

After separately releasing the validated commit, verify the deployed SHA, authenticated Ask in both modes and streaming, representative ready/partial/historical/instrument requests, coverage counts and health. Do not substitute an HTTP403 response for rendered-page verification.

## Reproduce local gates

```sh
node scripts/test-stock-coverage.js
node scripts/validate-stock-coverage.js --bootstrap
node scripts/verify-public-stock-pages.js
node --max-old-space-size=256 scripts/check-stock-coverage-performance.js
# Run only in a checkout without production environment files:
node scripts/check-stock-coverage-startup.js
```

The same regression and startup gates were also run using the supported Node22 runtime. Review and stage only the scoped source, tests, asset references and readiness documents; unrelated worktree changes remain excluded.
