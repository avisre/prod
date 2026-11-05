# Handoff

Durable working memory — **keep under 500 lines** (CLAUDE.md), enforced by
`backend/test/handoff-size.test.js`, which the pre-push gate runs whenever this file changes. Current state and open actions only, never a transcript. At ~400 lines,
snapshot this file to `.claude/handoff-archive/<date>.md` and rewrite it fresh; **delete superseded items to
the snapshot rather than compressing them here**.
Earlier snapshots: `handoff-archive/2026-11-01.md` (verbatim, 402 lines — bank/insurer fill, 10/31 page-gap fixes and
traps, as-filed statements (off), the 10/25 push, latency + price-trend + Ask quality work of 10/24, Ask chat parity,
the 10/17 statements fill (`EXTRACTION_VERSION` history, presented debt, weekly made incremental, FX/IAS 29)),
`2026-10-17.md` (10/10–10/11 write-ups), `2026-10-11.md` (10/08 owner decisions, live and settled), `2026-10-10.md`,
`2026-10-07.md` (the six 10/06 data-audit write-ups — read them before touching core statement extraction),
`2026-10-04.md`, `2026-10-03.md`, `2026-10-01.md`, `2026-09-30.md`, `2026-09-28.md`.
Deep history: `git log`, `notes/2026-09-*.md`, `docs/growth/`, `docs/seo/`, `~/.claude/plans/`.

## Every income cell filled, no wrong numbers — 2026-11-05 (owner order)
- Measured with scratch `cell-audit.js` (5 annual / 8 quarterly columns, rows the page shows): visible blank cells
  65,605 → 55,368 (step 1 identities) → 34,654. Remaining: 20,482 never filed for that period (page shows **n/r**),
  7,118 ratios with no meaning (loss tax rate; page shows **n/m**), 1,588 no companyfacts, ~1,430 Q4 EPS and ~1,400 Q4
  flows blocked by the guards below, ~1,100 tax/pretax where the issuer's periods don't satisfy pretax − tax = NI.
  Audit outputs: `~/Downloads/sec-bulk/cell-1105{,b,c,e}`.
- **Step 1 (`verified-fundamentals.js` `incomeIdentities`, serve-time, marked calculated):** Q4 EPS = FY − 3 filed
  quarters (share-basis guard), pretax/tax from NI where every period satisfies the identity, D&A from the cash-flow
  statement, and **Q4 flows = FY − Q1 − Q2 − Q3** only when a Q4 figure *filed as such* proves the four quarters add up
  to the year (a Q4 the extractor took as year − YTD is no evidence: IMSR de-SPAC). Loosening that guard adds ~500
  cells and puts SPAC-vs-opco arithmetic in Q4 — don't. Tests `income-identities.test.js`.
- **Step 2 (`sec-facts.js` `PART_SUMS`, `EXTRACTION_VERSION 20261105-parts1`):** a row the filing reports only in parts =
  their sum, fill-only, cited to each part, formula `sum_of_parts` / `sum_of_parts_ytd_difference` re-proved by
  `sec-coverage.verifiedField`. SG&A = G&A + selling/marketing; D&A = Depreciation + AmortizationOfIntangibleAssets unless
  any other D&A-like fact sits on the same accn+span (Fiserv files three more → refused; a same-value duplicate inside
  cost of sales is fine, Collegium); pretax = domestic + foreign; tax = current + deferred. Tests `part-sums.test.js`.
  Written by scratch `parts-merge.js` straight from the 11-05 bulk companyfacts into the stored files (blank cells only,
  each re-verified, validateFinancial must not gain an error): **52,481 cells, 1,763 issuers**; file and issuer
  `extractionVersion` left as they were (only this rule was applied). Pre-write backup:
  `~/Downloads/sec-bulk/backup-20261105-preparts/sec-financials.tgz`.
- Checked against StockAnalysis 11-05: ORCL SG&A ×3 + D&A, POWI, COLL, FENC exact. MTCH 2025, MBUU, ONTO 2025 differ
  because SA moves one-off items out of SG&A; ours equals the filed G&A + S&M lines.
- **Dataset `asOf` = 2026-11-05** (`sec-reporting.json`; every `lastReconciledCycle` 2026-11-01 relabelled 11-05,
  `lastSuccessfulCheckAt` untouched). The 11-05 refresh took every filer in EDGAR's form indexes 10-30..11-05 plus
  `current.atom`, so an issuer it skipped filed nothing new. Labelling the cycle 11-01 instead (done earlier this
  session) makes validate fail with ~52k "future source" errors, because the data holds 10-Qs filed 11-02..11-05.
  NAVI's new holding-company CIK 0002152623 added (no 10-K under it yet).
- `sec-coverage.verifiedField` re-proves the serve-time identities (`fy_less_three_quarters`, `net_income_plus_tax`,
  `pretax_less_net_income`, `cash_flow_statement`); before, Apple's Q4 EPS failed `sec-financial-consumers.test.js`.
  Sweep of every served cell on 756 issuers (1-in-8): all of them pass; the only failures left are older —
  prospectus-sourced rows (424B4/S-1 HTML, CLBK, ALMR; ~690 cells) and the serve-time capex rules
  (`software_capitalisation` KC, `printed_statement_line` GPK). `sec-release-regressions` now expects the sum of parts.
- Index rebuild 23:24–23:54 IST on this data: validate `--bootstrap` ok, 0 errors; verify-pages errors []; perf ok;
  screenable listings 5,063. The index builders and validate have no per-symbol mode, so any data change costs a
  full ~30 min rebuild (an incremental builder would cut that; not built).
- **Open:** extractor `ytd_difference` at a de-SPAC Q4 subtracts the SPAC's 9M from the opco's year (IMSR Q4 2025 NI
  −31.2m stored) — pre-existing, needs a guard on a change of reporting entity. Not yet done from the plan: custom
  (company-prefix) tags, foreign half-year columns, SPAC annual statements, InterestExpenseDebt / CostsAndExpenses opex.

## FCF for software issuers, trailing P/E, Mac nav, Q3 data — 2026-11-05
- Commits (local, **unpushed** unless `git log origin/main..` says otherwise): `b164a249d` live price (routes
  normalize the reader payload with `adjustClone`, not the 6h snapshot), `8bceae045` code (below), then the data commit.
- **Software FCF** (`verified-fundamentals.js` `softwareCapex`, SIC 737x only, annual AND quarterly): a filed
  `softwarePurchases` stands in as capex (Yahoo's method; APP FY2025 FCF $3,942.8M); a row with no capex line where its
  fiscal year files none either gets `_noCapexLine` and FCF = OCF with capex left a dash (StockAnalysis's method; APP Q2
  2026 $869.0M). A quarter whose year files capex is a derivation gap and keeps no FCF. Readers: `company.js`
  `fcfOf`, `mcp-financials.js`, `financial-metrics.js`. Test `software-fcf.test.js`.
- **Trailing P/E** (`company.js` `earningsSeries`): an unfiled Q4 EPS = FY EPS − three filed quarters, else NI ÷ the
  adjacent quarter's weighted diluted shares — never a balance-sheet count (WMT showed 37× from a pre-split count).
  When `coverage.latestEarningsRelease` is newer than the last 10-Q/10-K the provider's `trailingPE` shows, labelled.
- **Nav**: 1024–1360px keeps Screener / Stocks & funds / AI ▾ / Portfolio and folds Tools, Compare, Markets, Gurus,
  Pricing into "More ▾"; hamburger only ≤1023px. Lookbehind regexes removed from profile/monitor/dossier/
  compare-dossiers (Safari < 16.4). Stamp `20261105-fcf8`.
- **Trap hit:** killing a `refresh-sec-industry.js --jobs` run loses the shards' results (they live in
  `/tmp/sec-industry-*`) while the enriched files stay on disk, so the next run dies at once on
  `FINANCIAL_DIGEST_MISMATCH`. Recovery = adopt a file's digest only when it carries the current industry `VERSION` for
  the issuer's current 10-K accession (scratch script did this for 240), then resume with the same `--symbols`.
- Cron left weekly: runs take 150–187 min, daily Mon–Sat ≈ 4,400 Actions min/month on a private repo — owner's call.

## Alt-tag fills and debt guards — 2026-11-01/02
- Source: `docs/statement-audit/missing-financial-cells-2026-11-01.csv` — SEC tags a blank page row under a second
  name. `EXTRACTION_VERSION` **20261101-alt4**. All fills are fill-only (`ALTS_ADDED` join `FILLS`), so they never
  displace a filed figure and never add a period.
- `sec-facts.js` MAPS gained: revenue (`InterestAndDividendIncomeOperating` — financial SIC 60/61/62/67 only,
  `RealEstateRevenueNet`), operating income (`…IncomeLossFromContinuingOperationsBeforeInterestExpense…`), SG&A
  (`GeneralAndAdministrativeExpense` alone, guarded), cost of revenue (`CostOfServices`), operating expenses
  (`OperatingCostsAndExpenses`, `NoninterestExpense`), interest income (`InvestmentIncomeInterestAndDividend`,
  `InterestIncomeOther`), tax (`CurrentIncomeTaxExpenseBenefit`), pre-tax (Domestic/Foreign, mutually guarded), D&A
  (plain `Depreciation`, guarded on both statements), cash with restricted cash (guarded), receivables
  (`AccountsNotesAndLoansReceivableNetCurrent`), debt (`LongTermDebt`, `LongTermDebtAndCapitalLeaseObligations`,
  `SeniorNotes`, `ConvertibleNotesPayable`, `LongTermLineOfCredit`, `NotesPayable`, and for short-term debt
  `ShortTermBorrowings`/`LongTermDebtCurrent`/`CommercialPaper`), intangibles (finite/indefinite halves, guarded),
  investments (`EquityMethodInvestments`, AFS noncurrent), PP&E (`RealEstateInvestmentPropertyNet`), other assets
  (`OtherAssets`, guarded), payables-and-accrued (guarded), SBC (`…ShareBasedPaymentAwardCompensationCost`),
  working-capital changes (`IncreaseDecreaseInOperatingAssets`/`…Liabilities`, guarded), equity proceeds (stock
  options, equity sale), REIT capex (`PaymentsToDevelopRealEstateAssets`).
- `FIELD_GUARDS` (new): field-scoped witnesses — a whole-of-debt or combined tag is the row only when the same filing
  reports no other part of it (a guard, not `FILL_GUARDS`, which applies to every field reading the tag).
  **`LongTermDebtAndCapitalLeaseObligations` is deliberately unguarded**: it IS the noncurrent line (900 of 938
  sampled filings sit below the same filing's `…IncludingCurrentMaturities`); guarding it blanked 3,089 rows,
  Ampco-Pittsburgh's presented "Long-term debt" among them.
- `shortTermDebt` reads its parts as well as `DebtCurrent`. When both parts are filed the row is their **sum**: a new
  `combine()` rule lets the sum replace a value that resolved from one of the two parts first (10,328 rows were one
  part instead of the sum). A lone part is the row when the filing reports nothing else of it — total debt then sums
  that part with the long-term line (`financial-foundation.test.js` updated to this by design).
- `restrictedFallback`: when the latest annual report's own XBRL leaves a face line untagged, a later filing's
  comparative fills it (annual forms only, all facts at that end agreeing); it never sets the row's span.
- Annual rows keep the fact that shares the row's own start (ZURA's restated merger stub no longer displaces it) and
  the latest annual period's figures come from the annual filing's own accession (ATEN). `presentedDebt` now records
  `PRESENTED_TOTAL_REFUSED` when a total it built from parts fails the face check, and treats a zero current-debt
  figure as no line (META).
- `refresh-sec-coverage.js` treats `REJECTED_PART` **and** `PRESENTED_TOTAL_REFUSED` as prior losses (not new ones)
  and keeps a field whose figure is unchanged when only its provenance moved to a later filing. `verifiedField`
  tolerates ±4 days on an annual row's start (a 52/53-week comparative). `audit-statement-rows.js` matches facts
  exactly (same end, same start, annual only from 10-K/20-F/40-F), reports `rejected_by_validation`, and no longer
  accepts `LiabilitiesAndStockholdersEquity` for total liabilities.
- Run: 5,507 issuers re-extracted in 12 shards, then `refresh-sec-industry.js --jobs 12` (5,201 merged — a
  re-extraction strips the original-document stage) and the four index builders; audit regenerated from 8 shards.
  Diff vs HEAD over the 5,454 changed files: **438,450 cells filled**, 1,105 values changed, 236 new periods, 10 lost.
  3,266 cells went blank: 2,380 total debt and 691 long-term debt are deliberate refusals, 630 have **no refusal
  record yet** (AgEagle's whole Q4 2022 income column, `shortLongTermDebtTotal`) — review next session.
- 39 issuers (ECL, MOD, NSC, PM …) keep their earlier files: the guard still reports `shortLongTermDebtTotal` lost, and
  their alt2 files already lost long-term debt. They need a decision, not another re-run.
- Statement audit after: tier 1 `sec_has_alt_tag` 19,946 → 3,029, `rejected_by_validation` 0 → 3,657,
  `not_reported` 87,981 → 89,656, `sec_has_mapped_tag` 1,255 → 150 — mostly the exact matcher (a one-day-off year
  end or a 10-Q comparative no longer counts as "SEC has it"), not lost extraction.
- In the tree and **not** part of this batch: `backend/following.js`, `scripts/global-companies-*.js`,
  `job-search-sprint/`, `docs/global-companies/history/ANT.json`, `docs/statement-audit/ir-page-feasibility-*`,
  `docs/statement-audit/by-stock.csv` (untracked, as before), `.appsumo-watch-state.json`,
  `backend/discovered-compares.json`.

## Quarter lines tagged only in the segment note — 2026-11-01
- Owner: Innodata's March/June 2026 quarters showed no gross profit or operating income though Yahoo had them.
  Innodata reports one operating segment (ASU 2023-07 segment disclosure, interim periods from FY2025) and tags those
  two lines only on `srt:ConsolidationItemsAxis=us-gaap:OperatingSegmentsMember`; SEC's companyfacts drops every
  dimensional fact, so the feed never had them.
- `sec-original.js`: a single-segment filing's (no `…SegmentsAxis` anywhere) consolidation-total fact stands for an
  income line the statements leave untagged, once every note figure that the statements also tag for the same period
  equals them (abs value: the note shows tax as a deduction). Income-statement lines only (a cash-flow figure there
  is a quarter beside a year-to-date statement); an expense line only when positive and no anchor was sign-flipped.
- `refresh-sec-coverage.js`: a 10-Q of the current fiscal year (`sec-reporting.js` `yearPeriodics`, not stored) whose
  quarter lacks a line its year-earlier quarter carried is read from its own document, and the result is **kept only
  if it adds lines** — any filed value changed or lost → `lineGapExtraction` status `rejected_changes_filed_values`
  (ImageneBio June 2026). Only facts ending on the report date are merged: comparatives replaced other periods
  (Alnylam). `EXTRACTION_VERSION` `20261101-seg1`. Tests in `sec-original` and `sec-release-regressions`.
- Final run (556 issuers + industry stage, diff vs HEAD): 0 values lost; changed only FE/AEP below. Filled: Innodata
  Mar/Jun 2026 gross profit + operating income, CBIZ Q1 2026, Alnylam's whole Q1 2026 (revenue $1,167,175K = its 8-K).
  Rejected (data unchanged): GHC Q1, CIK 1818201 Q1, CIK 1835579 Q2. Retrieval failed: CIKs 765880, 1655050, 1633336.
  Side effect: ~340 issuers last extracted at `rev3` gained the bank/insurer-era fields from the current extractor
  (e.g. Salesforce long-term debt $14,439M, matches companyconcept).
- Scan of 1,203 empty income cells over 561 issuers: segment-only 27 cells/16 issuers, filed plainly but missing 230,
  other dimensions only 98, not tagged at all 841, no filing 7. Most segment-only cells are expense lines the note shows
  as deductions (left out by design); a "plain" fact with empty text is a filed blank.
- Waters (Q4 2024/2025 net income came from an earlier 10-K read that no longer triggers) and OneMain kept at their
  pre-batch files; FirstEnergy/AEP June 2026 net income and equity now parent-attributable (FE $288M = its release).
- Removed from the company page (owner): the price-trend band (trend, RSI, 50/200-day, cross, volume, 52-week high).
  The `/api/company/:symbol/technicals` route, the snapshot and Ask's `get_technicals` stay. Stamp `20261101-ui52`.
- Render runtime pinned to Node 22.23.4 (`09671381d`, security release; production had been on the 22.16.0 default).

## Open
- **Alt-tag batch follow-ups (2026-11-02):** 630 blanked cells have no refusal record (AgEagle's whole Q4 2022
  income column, `shortLongTermDebtTotal` in older quarters); 39 issuers keep their alt2 files because the guard still
  reports `shortLongTermDebtTotal` lost (ECL, MOD, NSC, PM, …). Neither is pushed.
- **Stale-cache fix (2026-11-01, committed, unpushed):** a failed re-extract keeps old statements but stores the new
  check time, so a cache outranked a newer committed file (MCY 10-25 rev1 → losses+LAE null). `getCompanyEvidence` now
  keeps whichever statements have the later `fetchedAt`. MCY's runtime re-extract will keep failing
  `EXTRACTION_HISTORY_REGRESSION` by design: runtime `extract` has no statement data sets, so it lacks the 2024/2025
  `statement_line` losses+LAE and 26 `shortLongTermDebtTotal` sums. Live MCY was already right on 11-01 (cache rolled to ind3).
- Phase D of the 10/25 audit: 380 issuers with no statements, 30 stale (10-KT, 40-F switchers, NT filers), stored gaps
  into refresh jobs. Phase 4 auto-follow and Phase 5 checklist grid (10/24 plan) not started.
- As-filed statements are built but **off** (`AS_FILED_ON = false` in company.js) until the owner designs per-industry
  layouts; `scripts/build-as-filed.js` must be rerun each quarter from SEC's FSDS zips.
- Not yet done: cleanup of `~/Downloads/new/checkpoint-parts` + the `prod-weekly-20261024` worktree (awaiting owner OK).

## Data refresh traps (read before re-extracting)
- **After ANY local re-extraction rebuild the indexes** — the server loads a file only when its digest matches
  `public-stock-index.json`: `build-financial-coverage.js`, `build-public-stock-index.js` (`--max-old-space-size=1536`),
  `build-screen-index.js`, `build-industry-map.js`, then `validate-stock-coverage.js --bootstrap`.
- **A manual `refresh-sec-coverage.js --symbols` strips the industry stage's fields** for the issuers it rewrites
  (segment/opex/industry observations); follow with `refresh-sec-industry.js --symbols <same> --jobs 4`
  (`SEC_ORIGINAL_MAX_MB=40` for big 10-Ks) before the index rebuild. `revenue-breakdown.test.js` goldens catch it.
- **Merging with origin's weekly reconciliation:** take `lastReconciledCycle` / `lastAttemptAt` /
  `lastSuccessfulCheckAt` along with each entry, or `validate-stock-coverage.js --bootstrap` fails for every issuer.
- Page stamps use `-uiNN` and must never share a prefix with `EXTRACTION_VERSION`.
- Compare a batch against a snapshot taken immediately before it — a stale snapshot shows earlier commits'
  fills (10/31 bank fields) as this batch's.
- The deploy-skip marker matches anywhere in a commit message; `frontend/data/fundamentals/**` and
  `frontend/data/sec-financials/**` commits must never carry it.

## Earlier-session work — now all on origin/main (verified 2026-11-05)
- The 10/17-snapshot list (`ask-conditions-20261011`, `ask-comparison-fallback-20261011`, the Ask/AI-Portfolio
  split, Ask customer-question fixes, account actions, AI Portfolio accounting) landed with the October
  merges; `751f3aaea` (peers tab) and `1bba0cf27` (Ads conversions) are ancestors of origin/main too.
- `frontend/data/index-members.json` (Nasdaq 100, S&P 100) has no refresh job; redo it at reconstitution.
- AppSumo listing itself is still live and selling; ending it is the owner's step with AppSumo.
- Still unpushed: the three WIP stashes (two mcp-server sessions, one 10/16 pre-merge page-copy set) and the
  untracked `mcp-server/server.json` / `mcp.json` / `.cursor-plugin/` / `assets/` (Cursor-plugin session,
  never committed) — see `git stash list`.

## Session start
- `bash scripts/dev-doctor.sh` once. This Ubuntu checkout has no `mongod` (run the server with a dead
  `MONGODB_URI` for page checks; `scripts/dev-local.js` on :5055). Harnesses use `mongodb://127.0.0.1:27017/<scratch>`.
  Stop dev-local before `npm test`/predeploy. The pre-push hook is enabled here (`core.hooksPath=.githooks`).
- **Verify every deploy from outside** (`gh run list` + a live fetch) — the workflow's own conclusion lied
  once. `set-render-env.yml` alone never deploys. A push to `main` ships to prod.
- **The MCP endpoint has a live checker: `cd backend && npm run test:mcp`** (`scripts/test-mcp.mjs`), and the
  browser path `node scripts/mcp-browser-test.mjs` (each run registers a real DCR client in the **production**
  database — don't loop it). Key from `~/.config/stockportfolio/api-key`, fingerprinted, never printed.
- **Parallel sessions share this working tree.** A push range starting at a SHA you do not recognise means
  someone committed between your `git add` and your push — check `git log`/`git status` before staging broadly.
- Full suite needs `frontend/data` (5.8 GB). Tests already failing on `main`: `scripts/predeploy-known-failures.json`.

## Hard constraints — do not violate
- **The AI provider is a trade secret.** `ai-client.js`'s `leaksIdentity()` is a backstop, not a licence;
  never name the model to users, in copy, or in an error message.
- **Never store or inline keys.** `~/.config/stockportfolio/api-key` (`sp_live_`),
  `~/.local/share/secrets/bing_webmaster.txt`, `.../gsc_service_account.json`,
  `~/.config/stockportfolio/reviewer-account.txt` (mode 600).
- **Never `dotenv.config()` `backend/.env`** — it carries the PRODUCTION Atlas URI. Use
  `scripts/lib/dev-env.js` (`loadAiEnvOnly` + `assertLocalMongo`, `--db`).
- Customer email only from support@ via `/admin/messages`, owner-approved; **never cold email from
  support@**. No anti-bot workarounds, and **no interactive auth through Bash**. No `sleep N`.
  `rin@gmail.com` is the owner's test account — exclude from counts.
- **Never log API keys, authorization headers, session tokens or sensitive data.**
- **SEC requests use the project's contact address** (`HEADERS` in `sec-reporting.js`), never the owner's
  personal email.
- **`notes/filing-watch-*.csv` must stay untracked** — they will hold prospect PII.
- Statement values are as filed, never estimated; a missing line stays a dash.

## In flight
- **OpenAI ChatGPT plugin directory — owner reports APPROVED AND PUBLIC (10/07), not independently verified.**
  Surface `POST /mcp/apps` (7 read-only tools). `scripts/verify-mcp-apps.js --review-cases` = 23/23 against
  production; re-run after every deploy. `/mcp/apps` takes `company`; `/mcp` takes `ticker`. Only one review may
  be active; never press *Cancel review*. The ZIP (`scripts/build-openai-plugin.sh`) is the source of truth.
- **Claude directory (verified 10/25):** plugin bundle Published, live v0.2.3 (`307aceb`); MCP connector Published,
  slug `stockportfolio`. Custom icon awaits review. Receipts:
  `~/.local/share/stockportfolio-context/claude-listing-2026-10-25/README.md`. Reviewer account
  `openai-review@stockportfolio.pro` is a `UserSchema` path (`reviewAccount`).
- **Connector sign-in** (`oauth-mcp.js`) issues a client secret only when asked or for Perplexity / Teams
  redirect hosts. **Re-test a fresh Claude and ChatGPT connect after each deploy that touches it.**
- **Filing Watch $49/month pilot** — deployed flag-on, $0 collected, zero offers sent. Never send outreach
  without the owner's explicit authorization. Runbook `docs/growth/filing-watch-runbook.md`.
- **Dossier redesign "The Plain Filing"** — mockup awaiting review; the port has not started
  (`node scripts/build-dossier-mockup-artifact.js`, never hand-edit).
- **Voice input is parked and ships off** (`STT_API_KEY` / `VOICE_LOCAL_MODEL=true`).
- Technicals snapshot (Mongo `technicals_snapshot`) still builds daily for the screener and Ask.

## Walls (live in prod)
- Geo wall `GEO_WALL_COUNTRIES` (`SG,CN,HK`); hosting/VPN wall `HOSTING_WALL_ENABLED` (ON) from
  `backend/data/hosting-ranges.bin`. **Paid-platform mode (2026-11-05): `WALL_ALL_PAGES` + `WALL_PAID_ONLY`
  are ON in production** (set on Render; `backend/prod.env` is the local mirror, loaded by app.js:230).
  Commit `cbd39434d` closed the page wall to trials, /api/demo, /api/free-tools, the anonymous company
  allowance and the MCP trial; the follow-up (same day) closed every remaining keyless product-data route
  via `paidOnlyDataGate` — screener, stock-coverage, company peers/as-filed/technicals/keypoints,
  insights/segments, assets search, market strip, news-image proxy, briefing sample, sbc sector-rank,
  POST /api/verify|/api/lie and /api/ask-trial/email. Deliberately public: /api/health(+data), campaign
  config, checkout/auth config, /api/verify-ledger (public proof artifact), /api/ask-trial/verify.
  Unset `WALL_PAID_ONLY` restores the open behaviour with no redeploy.
- **`GEO_WALL` load-bearing:** the visitor IP comes from `marketingAttribution.requestIp()` (CF-Connecting-IP), **never
  `req.ip`**; the crawler exemption is required (Googlebot/Bingbot crawl from hosting ranges).
- **The MCP transport is the one surface the walls do not decide**; entitlement resolves at `tools/call` as tool
  errors.
- Anonymous Ask stays off in production (`ALLOW_ANON_AI` unset → `ANON_ASK_LIMIT=0`).

## SEO / discovery — measured; do not re-derive
- **The bottleneck is indexing and site-level trust**: Google ~340 human impressions/month, ~0 clicks, median
  position ~52 across ~21,700 URLs, while Bing ranks the same site well (7.7% CTR, pos 6.1).
- **87% of raw "impressions" are rank tools.** Parse GSC/Bing CSVs RFC4180.
- Crawled-but-not-indexed = "insufficient value or user demand"; external links are the unattempted lever. Never
  `noindex` an unwanted URL — use robots.txt, a one-way door, or emit fewer URLs.
- The URL Inspection API reports the last crawl, never a live fetch. Bing URL submission is 100/day; IndexNow is free.

## Prices, freshness, dead tickers
- `backend/quote-store.js` is the one place pages ask for a price. Freshness = the data's own dates, never mtime
  (`fundamentals-date.js`, `STALE_DAYS=45`). A fundamentals commit must deploy.
- Dead-ticker rule: two separate days of Yahoo "Quote not found" mark a ticker unlisted; a success clears it.
- Price history: `backend/price-history.js` + weekly `refresh-price-history.yml`.

## AI model + cost
- Every purpose resolves to `glm-5.3` (`ai-client.js:20`), which needs `reasoning_effort: 'low'`
  (`ai-client.js:82`). Cost baseline $28.91/mo ≈ 48% of the $60 allowance on glm-5.1 — re-measure.
- `promptTokens`/`completionTokens` are missing before 9/11: use `$isNumber`.
- Connector lookups are charged 1 credit, published at 2 (`credits.COST` vs `credits.LISTED_COST`; owner decision).

## Traps that have already cost real time
- **The local Ask harness holds backend modules in memory** — restart it after every edit.
- **The model mis-rounds ratios**; a value one tenth off is rejected as unsourced.
- **A fence field the renderer ignores fails silently** — anything the prompt advertises needs a validator rule
  or a renderer branch.
- `users.updatedAt` is a bulk-write artifact; measure activity from `ollama_usage_events`.
- A broadcast's recipient list is not a customer list. ~95% of first-party "unique visitors" are a botnet on
  `/register.html`.
- Chrome headless's UA is 403'd by `bot-blocker.js` — override it; browser checks via CDP
  (`scripts/screenshot-cdp.js`). Live verification budget: 100 non-asset requests per 5 min per IP.
- A test can encode a coincidence; a source-pinning test should slice to the next function, not a char count.
- `ask.html` has `<body>` inside a CSS comment; mark the real tag with `/^<body>$/m`.
- Filed EPS is not restated across splits (Nvidia 3.85 then 0.17); use profit growth.

## Owner actions pending
1. **OpenAI plugin submission** — watch for the verdict; do not press **Cancel review**.
2. **Dossier mockup review** — the port has not started.
3. **URL Inspection → Request Indexing** on the highest-value pages; re-run Bing **Site Scan**.
4. **`avisre/prod` visibility** — it names the AI provider while public. Render must be able to read the repo.
5. **Rotate the secrets exposed in local transcripts** (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, JWT_SECRET,
   SMTP_PASS, GOOGLE_CLIENT_SECRET, the provider key) at source AND on Render back-to-back per key; revoke the old
   GitHub PAT and npm token pasted 9/14.
6. **List-Unsubscribe + DMARC `rua`** before the next bulk send.
7. **`FRED_API_KEY` and `BLS_API_KEY` on Render** (values in `~/.config/stockportfolio/`).
8. **Monthly provider bill** — the one input that states AI margin in dollars.
9. Orphan IndexNow key `1668f45a03ea53cf94c51b61c43163d4.txt`; `mcp-server` README lists retired `sp_*` names.
