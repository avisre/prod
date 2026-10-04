# Ask financial visuals: release readiness — 2026-10-04

Status: release candidate passed local acceptance checks; deployment is separate and has not been performed.

Release branch: `ask-visuals-release-20261004`. Prepared on current `origin/main` (`afe2a0360f0ca669586a050f6a8c3b93a4ec5b92`), retaining the previously committed SEC coverage implementation. The final release SHA is supplied with the release handoff.

## What changed

- Generic on-demand research for all 5,974 stock listings; 125 units/rights cannot receive company financial analysis. Funds receive structured unavailable responses.
- Grouped vertical revenue, net income and SBC bars use actual SEC dates, reported currency, verified zeros and missing gaps. A single available metric can still be shown.
- Native segment extraction uses exact annual filing identity, literal text and inline XBRL receipts. Comparative periods cannot displace the selected annual period. A Sankey requires multiple segments totaling 98–100% of same-filing SEC revenue, with the remainder explicit.
- Separate horizontal obligation bars require explicitly scaled, dated, currency-verified disclosures. Recognized lease liabilities, uncommenced leases, commitments and entity exposure keep distinct labels. They are never summed or described as evidence of concealment.
- Ask uses an issuer-level version 2 segment cache, bounded concurrency, cooldowns and memory limits. Legacy company-page/dossier `revenueUsd` responses are preserved.
- Frontend assets and pinned references use `20261004-askviz6`.
- Patched dependency lock: Axios 1.20.0, Nodemailer 10.0.14 and affected transitive packages. Runtime transport compatibility is tested using a local MIME stream, without sending email. Backend production dependency audit reports zero vulnerabilities.

## Actual coverage

The directory contains 6,099 securities. 4,440 distinct companies have recent annual SEC reports and the verified core financial data required for company coverage. Other issuers have partial, historical or unavailable data, labeled accordingly.

| Count | Value |
|---|---:|
| Eligible stock listings | 5,974 |
| Identified issuers | 5,879 |
| Recent annual issuers | 5,272 |
| Financial ready issuers | 4,440 |
| Partial financial issuers | 391 |
| Historical-only issuers | 600 |
| Unavailable financial issuers | 448 |
| Screenable listings | 4,498 |
| Screenable issuers | 4,440 |
| Unresolved directory identities | 25 |
| Network verification failures | 0 |

Submissions verification: 100% of resolvable issuers. Completed facts attempts: 100% of recent annual issuers. The validator checked 5,724 financial files and 4,872,473 populated verified values without provenance errors. Missing identities are explicit outcomes, not verified coverage.

Readiness requires a validated same-issuer annual 10-K/20-F/40-F original filing within 12 UTC calendar months, period end within 18 months, and submissions check within 35 days. That qualifying annual period must contain source-verified net income, assets, equity, operating cash flow, and at least revenue or basic/diluted EPS, with compatible currency, units and duration. Zero and negative values remain valid. Amendments do not reset the original filing clock.

Dataset as of 2026-10-04; generated 2026-10-04T04:39:57.202Z; coverage policy 1; public schema 1. Public/screen dataset ID: `33502d5144407925bf082a4b39d3040181c924a26e8b35f663ae3a9b53b69102`. Snapshot sizes: 7,247,176 / 5,804,711 bytes, both below 8 MiB.

## Acceptance results

- Node 22.23.3: **385 regression tests passed, zero failed or skipped**, using isolated test copies. This includes policy, provenance, cross-industry/currency fixtures, screener, AI, MCP, paywall and legacy segment compatibility.
- Real disposable local MongoDB: versioned segment evidence persisted, invalid legacy evidence rejected, fresh module reload retrieved the same issuer cache for two share classes.
- Read-only bootstrap validator: passed, zero errors.
- Offline exhaustive render: **6,099 profiles, 27,788 metric URLs, 2,897 comparison URLs and nine sitemap shards**, zero errors.
- Fresh `npm ci` installs in isolated checkout: passed. No production environment files were present.
- Full application startup on Node 22, production mode, `DISABLE_BACKGROUND_JOBS=1`, disposable local MongoDB: health, coverage, screener, sitemap and ready/partial/historical/unavailable/unit/right profile requests returned HTTP 200 with expected canonical/robots behavior.
- Real Chrome rendering of generated answers: 320, 390 and 1,440px viewports, no horizontal overflow, chart JSON leakage or missing chart blocks; native JPY and explicit SBC gaps present.

Performance, 256 MiB heap, isolated HTTP harness:

| Measurement | Result |
|---|---:|
| Cold public snapshot | 150.3 ms |
| Cold screen snapshot | 205.6 ms |
| Cold sitemap | 112.8 ms |
| All sitemap shards | 3.2 ms |
| RSS | 223.4 MiB |
| Maximum event-loop delay | 10.5 ms |
| Maximum health batch latency | 45.9 ms |

This harness is separate from full application startup and is not a production load test.

## Live answer checks

Real AI and SEC requests ran through the release checkout on Node 22 with database connections disabled. Existing local AI configuration was inherited through an explicit allowlist; no environment files were loaded.

| Example | Prose words / limit | Time | Charts | Result |
|---|---:|---:|---|---|
| short | 54 / 80 | 4.3s | none | ai |
| complex | 148 / 450 | 34.1s | bars, sankey, bars | partial |
| adr | 56 / 150 | 12.1s | bars | partial |
| obligations | 45 / 150 | 16.2s | bars | partial |

The complex Meta sample has three visuals. Its two segment values reconcile exactly to USD 200.966 billion for 2025-12-31 in accession `0001628280-26-003942`. The focused obligation sample labels leases not yet commenced separately from contractual commitments. MUFG uses JPY and March 31 period ends; missing SBC is a gap.

The complex, ADR and obligation answers used the checked partial fallback after model rewrite failed validation. Their sourced charts remain usable; the product explicitly reports the remaining evidence gaps. This sample demonstrates the checked fallback, and does not establish that every initial model answer passes.

Local review: http://127.0.0.1:5058/ — the real Ask engine and shipped chart renderer, without a database connection. Saved public examples and measurements are in [QA evidence](qa/ask-live-readiness-2026-10-04/verification.json).

## Remaining supported limits and release action

- Missing custom facts, ambiguous currencies, unsupported segment dimensions or literal label bindings, incomplete/single-segment breakdowns and conflicting observations remain unavailable. A complete Sankey is limited to ten segments.
- No automatic ADR or share-class EPS conversion is introduced. Ambiguous per-share bases remain suppressed.
- Filing excerpts are bounded. Missing amounts in an excerpt do not establish absence in the full filing. Search/provider failures return truthful partial or unavailable outcomes.
- The directory resolution audit covers every eligible listing; live external research was sampled, rather than refreshing the universe on a request.
- Production credentials, production database and deployment were not used. Authenticated production rendering and deployed commit verification remain release checks after a separately authorized deployment.

The deployment workflow validates the triggering SHA before deployment and passes that SHA through Render `commitId`. The scoped release contains code, required new modules, paired snapshots and public QA evidence; unrelated original-worktree notes, CSVs, mockups and comparison discoveries are excluded.
