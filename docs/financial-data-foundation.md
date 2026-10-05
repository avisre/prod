# Financial data foundation

## Coverage definitions

`frontend/data/stock-universe-manifest.json` records an explicit include,
exclude or review decision for every row in the two authoritative Nasdaq
Trader directories. Its source timestamps and hashes identify the listing
snapshot. Common and ordinary shares, operating-company ADRs, REITs and SPAC
common shares count as stocks. Distinct share classes remain separate listings;
unique confirmed CIKs count as issuers. ETFs, confirmed closed-end funds,
preferred shares, debt, warrants, rights, units and test issues do not count as
stocks. Legacy URLs remain resolvable and identify the instrument's status.

`frontend/data/financial-coverage.json` records every in-scope listing, including
issuers with no usable financial history. Counts distinguish accessible SEC
filings, usable structured statements, current annual core fields, five annual
core periods, four consecutive income quarters and relevant industry fields.
Field coverage is not a promise that every issuer discloses every metric.
Industry coverage lists supported standard fields and remaining custom gaps
separately. `/api/stock-coverage` retains the existing counts and adds this audit
summary, its dated universe, source fingerprints and denominator descriptions.

## Stored and requested evidence

The committed financial files are the durable baseline. Customer features use
`getCompanyEvidence(symbol, requiredFields, requestedPeriods, checkFreshness)`.
Offline public-page builds and bulk screening retain the synchronous snapshot
reader. A missing requested period or a filing check older than six hours starts
a shared issuer retrieval. Complete older history does not hide a missing latest
filed period. The synchronous stage is bounded at 15 seconds; slower work
continues through the shared task and reports its status.

Source order is SEC structured facts and original filings, supported original
issuer releases, then Yahoo Finance for missing fields or periods. Exact numeric
receipts, identity, periods, units, currency, accounting basis, scope and source
versions are validated before use. Supplemental observations stay separately
attributed. Same-period compatible filed figures take precedence. Adjusted,
foreign-currency and provider-reported figures remain distinct. Unsupported
original tables and custom concepts receive specific gaps; no fuzzy tag mapping,
remembered figure or search snippet supplies a financial value.

The original-filing parser handles standard inline XBRL and reviewed segment
contexts. Reviewed issuer-defined table mappings currently include Realty
Income's FFO/AFFO reconciliation. Untagged tables, other custom KPI definitions
and foreign interim disclosure formats need reviewed mappings before they can
be claimed. Retrieval success does not mean those measures are complete.

Annual-minus-nine-month derivations apply to compatible monetary flows only.
Quarterly EPS and weighted share counts are not obtained by subtraction. Debt
keeps current, noncurrent and combined definitions distinct. Bank net revenue
excludes customer-contract fee revenue and requires compatible net-interest and noninterest observations. Insurers use comprehensive reported revenue, rather than customer-contract revenue that excludes insurance and investment activity. Financial
calculations retain their inputs; missing values never substitute for zero.

The public Mongo cache uses dedicated collections:

- `public_financial_requests`: capped at 64 MiB; application memory is bounded
  at 8 MiB. No account or portfolio data belongs in this collection.
- `public_financial_rate_limits`: coordinates SEC allocations across application
  and refresh workers, with one request slot every 125 milliseconds.

Outages preserve committed and validated last-good evidence. Failed checks and
retrieval reasons remain visible. The runtime cache never edits the committed
fundamentals directory. Weekly promotion revalidates both cached additions and
previously committed supplemental bundles, retaining dated last-good values.

Quotes have a 60-second cache and carry the actual market timestamp, market
state and delayed/stale status. Daily closing history remains a separate job.
An old weekly profile's valuation is not represented as a current market value.
Dossier financial conclusions use an evidence fingerprint; quote changes refresh
valuation separately from the saved narrative and disclose its date.

## Weekly operation

`.github/workflows/refresh-fundamentals.yml` runs Saturday 22:30 UTC, which is
Sunday 04:00 Asia/Kolkata. It reconciles the complete issuer universe with two
workers and checkpoints every 20 issuers. It retries incomplete core requests
and transient original-document failures within the same cycle. A failed issuer
retains its prior validated record and an explicit failure state.

The job classifies the directories, checks submissions and facts, extracts
supported original industry/segment disclosures, revalidates public-cache
additions, and builds public, screening and coverage snapshots with one matching
generation. Only a validated candidate is committed and published. No model is
called by these scripts. Daily price-history snapshots remain independent.

To resume an interrupted weekly run, dispatch the workflow with `resume_run_id`.
It restores that run's checkpoint artifact and accepts a cycle no older than
seven days. The old monthly rotation no longer drives fundamental freshness.

## Release checks and rollback

Run these after all data-writing stages finish:

```sh
node scripts/test-stock-coverage.js
node scripts/validate-stock-coverage.js --bootstrap
node scripts/verify-public-stock-pages.js
node --max-old-space-size=256 scripts/check-stock-coverage-performance.js
```

The validation gate checks source-row outcomes, listing identities, numerical
provenance, matching fingerprints and screening eligibility. Bootstrap requires
at least 98% recent submissions checks and 95% completed facts checks for issuers
with recent annual reports. Those retrieval percentages are not metric
completeness percentages. Keep the full backend suite's unrelated baseline
failures in the release receipt.

Local browser QA uses real SEC fixtures and explicitly labelled layout-only
provider evidence at 1100px and 390px; it invokes no model or financial provider.
Production health/API checks do not establish authenticated rendered-page
behaviour. Record inaccessible pages as unmet checks.

A push to `main` invokes deployment gates and deploys the committed generation.
Keep the preceding Git commit/dataset as the rollback point. Rollback restores
the matching financial, reporting, public, screening and coverage generation
together. Do not reset a shared dirty checkout. The stopped longer Ask-report
release remains a separate task.
