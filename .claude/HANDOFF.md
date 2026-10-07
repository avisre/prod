# Handoff

Durable working memory — **keep under 500 lines** (CLAUDE.md), enforced by
`backend/test/handoff-size.test.js` and run on every push by `.github/workflows/repo-checks.yml`, so the
cap can no longer be crossed silently. Current state and open actions only, never a transcript. At ~400 lines,
snapshot this file to `.claude/handoff-archive/<date>.md` and rewrite it fresh; **delete superseded items to
the snapshot rather than compressing them here**.
Earlier snapshots: `handoff-archive/2026-10-04.md` (verbatim, taken 10/04 at 395 lines — the SEC coverage
release narrative, the three earlier Ask quality/engineering release write-ups, the AppSumo v8 detail, the
OIDC fix, the breakthrough-hunt post-mortem, the Bing fix list), `handoff-archive/2026-10-03.md`,
`handoff-archive/2026-10-01.md`, `handoff-archive/2026-09-30.md`, `handoff-archive/2026-09-28.md`.
Deep history: `git log`, `notes/2026-09-*.md`, `docs/growth/`, `docs/seo/`, `~/.claude/plans/`.

## Segment names and off-balance-sheet commitments — 2026-10-07
- **Why:** the company page showed `meta:FamilyOfAppsMember` / "Reported segment member …" / `98.90180428530199%`.
  `sec-segment-observations.toolPayload` only had reviewed labels for AMD and AVGO; all 2,925 issuers with stored
  segment groups (10,619 distinct members) fell back to the raw XBRL member.
- **Fix:** `ask-inline-segments.label()` is the one humanizer (unglues "Assetand", upper-cases vowel-less
  initialisms, 365/LinkedIn/SaaS); `displayName()` and `preferred()` in `sec-segment-observations.js` are used by
  both the page (`segments.extractSegments`) and Ask. Ask's Sankey no longer requires a reviewed label, so it is
  eligible for any reconciled group (META, INOD, MSFT… were all "unverified" before). Cached dossiers are repaired
  on read in `dossier.refreshValuation` — no schema bump, nothing rebuilt.
- **New:** `backend/off-balance-sheet.js` reads leases not yet commenced, unrecorded purchase obligations,
  guarantees and unconsolidated-entity exposure from the latest 10-K/10-Q/20-F inline XBRL, each with its filing
  sentence; no model. Page section `#dos-off-balance`, in both Normal and Analyst views (it was Analyst-only until `segments4`). Measured live: META $279.0B leases + $28B RVG + $46.0B
  Louisiana venture exposure, MSFT $329.1B, ORCL $288B, GOOGL $85.2B, AMZN $137.2B, NVDA, CRWV. Never summed.
- **Selection (second commit):** `preferred().usable` picks the newest group with ≥2 rows covering 90–110% of
  revenue (segments before product lines); otherwise the stored breakdown is withheld and the older extraction
  path runs. `segments.storedSegments()` is re-run on every cached dossier read. `scripts/audit-segment-display.js`
  sweeps all issuers: 2,390 of 2,925 shown, 0 failures; 20 more (BRK) get a `partial` table (≥3 rows, 60–90%) when text extraction is empty, shown against its own year with the remainder named; 515 withheld;
  `test/segment-display.test.js` runs it. Page table caps at 8 rows + "Other segments" + "Not broken out".
- **Revenue sources (owner, 10/7, on AMZN):** product/service lines now lead over operating segments when the
  same year's lines are usable with ≥3 rows and either have more rows or the segments are purely geographic
  (AMZN → Online Stores/3P/AWS/Advertising…, AAPL → iPhone/Services…, MSFT, NVDA). Exact filed subtotals are
  removed before pruning (prune alone kept ORCL's "Software Revenues" beside its parts). Ask still uses `primary`.
- **Overhaul, plan `~/.claude/plans/federated-brewing-petal.md` (approved 10/7). Phases 1+5 shipped:**
  `backend/revenue-breakdown.js` is the only place that decides the breakdown and returns one contract
  (`grade` complete/partial/none, rows with shares of their own year, `remainder`, `reason`); the dossier build,
  every cached read, and Ask's `get_segments` use it; the page's `breakdownTable()` renders it without recomputing.
  Gate: `scripts/audit-segment-display.js` runs in `deploy-render.yml` validate; golden set of 63 tickers in
  `backend/test/fixtures/revenue-breakdown-golden.json` (regenerate with `--golden` when a change is intended);
  `scripts/render-dossier-gallery.js` writes a contact sheet to look at; live check without login:
  `GET /api/admin/revenue-breakdown/:symbol` with `x-admin-token`.
  **Baseline to beat in Phase 2:** S&P 500 complete 313 / partial 37 / none 153 (GOOGL, ADBE, AMD, BAC, CVX, XOM,
  WMT had nothing stored).
- **Phases 2+3 shipped as one data release (10/7):** two extractor bugs fixed — `sec-segment-observations.extract`
  threw a table away when a member was tagged under two revenue concepts or both before/after eliminations (now one
  candidate per concept and view, best kept); `sec-industry.enrich` discarded segments when an unrelated statement
  field failed validation (now keeps segments alone). `sec-original` reads the filing's label file (`*_lab.xml`, or
  the `.xsd` when embedded) and stores `filedLabel` per entry; `displayName` = reviewed → printed label → tag name.
  Industry `VERSION` is `20261007-industry4`; all 5,276 issuers re-extracted locally with
  `scripts/refresh-sec-industry.js` (45 `retrieval_failed`, mostly 20-F filers: HSBC, UBS, BP…), then
  `build-public-stock-index.js` + `build-screen-index.js`. **Result:** all issuers complete 2,288 → 2,770;
  S&P 500 complete 313 → 399, none 153 → 71; 41,396 of 41,598 entries carry a printed label.
- **Third pass, `20261007-industry5` (owner: "make sure 4000+ are covered"):** the extractor now also reads
  revenue by region (`kind` `regions`, used only when no segment or product table is usable), insurer premium
  measures, and the one allowed composite — a bank's segment = `InterestIncomeExpenseNet` + `NoninterestIncome`,
  each part stored in `entry.components` with its own receipt and checked by `validGroup`. A group not stated in
  revenue carries `measure`, which the page prints. Run with `SEC_ORIGINAL_MAX_MB=64` (0 fetch failures).
  **Screenable coverage (4,923):** complete 3,201 + partial 155 = 3,356; no revenue 464; single business 253;
  filing read and reports no usable breakdown 850 (measured on a 70-filing sample: these tag nothing by any axis).
  S&P 500: 430 complete / 35 partial / 38 none. Kinds: product lines 1,752, segments 1,287, regions 317.
  Known: BAC shows regions (segment revenue is under a custom `bac:` concept); PGR none; HD "Primary / Other".
  **Phase 4:** `opexParts()` splits the Operating expenses band into filed R&D / SG&A plus a named remainder
  (only `researchAndDevelopment` and `sellingGeneralAndAdministrative` are mapped — AMZN's fulfillment/technology
  lines and META's separate S&M/G&A are not, so those stay one band or "Other operating costs"). Both views share
  `sankey`, `breakdownTable` data and `offBalanceHtml`, pinned by a parity test.
- **Not done:** Ask has no tool for this; off-book questions still go through `search_filings` + `fetch_page`
  and the provenance gate at `ask-answer-quality.js` ~867. 20-F filers (TSM) return nothing. This file is past
  400 lines and due for rotation — left alone because two other sessions have it open with uncommitted edits.
- Asset stamp `20261007-breakdown3`.

## Session start
- `bash scripts/dev-doctor.sh` once. Local mongo: `brew services start mongodb-community`; harnesses use
  `mongodb://127.0.0.1:27017/<scratch>`.
- **Verify every deploy from outside** (`gh run list` + a live fetch) — the workflow's own conclusion lied
  once. `deploy-render.yml` 404'd on push through 9/24 (Render lost the repo) and works again;
  `set-render-env.yml` alone never deploys. A push to `main` ships to prod.
- **The MCP endpoint has a live checker: `cd backend && npm run test:mcp`** (`scripts/test-mcp.mjs`) — the 10
  scenarios a directory scan or ChatGPT connector performs, against a real URL, PASS/FAIL per line, exit 1 on
  any failure. Key is read from `~/.config/stockportfolio/api-key`; it is fingerprinted, never printed.
- **The browser path has a checker too: `node scripts/mcp-browser-test.mjs`** — walks the ChatGPT-connector flow
  in a real headless Chrome (CDP, UA overridden past the bot blocker), PASS/FAIL per line, exit 1 on failure.
  Needs no credential; the two hops it cannot cover are a successful sign-in and the approve POST that follows.
  Each run registers a real DCR client (`mcpc_*`) in the **production** database — harmless, but they accumulate,
  so don't leave it in a loop.
- **Parallel sessions share this working tree.** On 9/28 another session pushed `f5be04fd` mid-task and left
  `backend/discovered-compares.json` deleted-but-unstaged. A push range starting at a SHA you do not recognise
  means someone committed between your `git add` and your push — check `git log`/`git status` before staging
  anything broad, because `git add -A` would have committed their deletion.

## Hard constraints — do not violate
- **The AI provider is a trade secret.** `ai-client.js`'s `leaksIdentity()` is a backstop, not a licence;
  never name the model to users, in copy, or in an error message.
- **Never store or inline keys.** `~/.config/stockportfolio/api-key` (`sp_live_`),
  `~/.local/share/secrets/bing_webmaster.txt`, `.../gsc_service_account.json`,
  `~/.config/stockportfolio/reviewer-account.txt` (mode 600).
- **Never `dotenv.config()` `backend/.env`** — it carries the PRODUCTION Atlas URI, so a script taking an
  API key from it inherits the live database (9/7, again 9/22 when live keypoints rows were deleted). Use
  `scripts/lib/dev-env.js` (`loadAiEnvOnly` + `assertLocalMongo`, `--db`).
- Customer email only from support@ via `/admin/messages`, owner-approved; **never cold email from
  support@**. No anti-bot workarounds, and **no interactive auth through Bash** (`gh auth login` needs a TTY —
  hand the owner the command). No `sleep N`. `rin@gmail.com` is the owner's test account — exclude from counts.
- **Never log API keys, authorization headers, session tokens or sensitive data** — including into this
  transcript. `/tmp/fill-creds.mjs` shows the pattern for a secret a browser form needs: read the file
  in-process, hand it straight to the DOM, never through argv or stdout.
- **`notes/filing-watch-*.csv` must stay untracked — the repo is PUBLIC** and they will hold prospect PII.

## Every changed revenue figure checked one by one — 2026-10-06 (ninth)

`docs/qa/data-audit-2026-10-06/revenue-changes.csv`: all 2,137 revenue figures (461 companies; 231 newest-year,
1,906 earlier) that differ between production rules and the new rules, each with old/new value, old/new line, filing
and a verdict (scratchpad `each.js`). 1,352 confirmed by the filing's own arithmetic; 401 definitional (248 bank sum
of two filed parts, 153 financial-firm net revenues); 350 part replaced by the filing total and corroborated; 8 fit
adjacent years better; **26 not confirmed automatically** — 19 of those recognised as right (ETN 2011–14 from $0,
PG 2012, HSY 2011, PSMT, COP 2022, BP 2018, ENS 2018, KKR, BAM, TPG, FRO, SDRL, MRX), 7 are tiny companies with
nothing to check against (AHR 2017–18, INSE 2015, IPHA, MRNO, LGHL, CHGA, AUPH).
The check exposed four rule gaps, now fixed: net revenues win only for financial SIC codes (Kornit); two lines with
the same confirmed amount are one total (Xylem); revenue including assessed tax never outranks excluding (Cronos);
an exact ×1,000 / ×1,000,000 line is a scale slip (SS Innovations).

## Quarter reconciliation and bank revenue — 2026-10-06 (eighth)

- Newest-year quarters are read as filed up to the annual report; if they do not add up to the year the later-filed
  (restated) reading is tried and the reconciling one kept (APP); neither → issue `QUARTERS_DO_NOT_SUM`.
- Quarters follow their fiscal year's line for every multi-tag field (net income parent vs consolidated).
- A full-year figure mis-dated as Q4 in SEC's feed is dropped (NiSource). `QUARTER_MAX_DAYS` 119.
- Banks (SIC 602/603/609) with both parts filed: revenue = net interest + noninterest income, over a stray `Revenues`
  tag (FBNC $68m → $390m, GBFH $1.24bn → $0.08bn). This makes bank revenue net of interest expense throughout.
- Partnership per-unit earnings read as EPS (AB, NRP).

**Final regression, 5,251 issuers, production rules vs these**: 271 become complete; newest-year revenue changes 231
(200 up); provider-copy agreement 3,048 → 3,176 of 3,394 (138 fixed, 10 differ — HOG and bank net-revenue cases);
four quarters ≠ year on revenue **100 → 11** of 3,456; no other annual field changed; 4 old cash-flow values dropped
(RDN 2011, RH 2015); gross profit > revenue 55 → 29 issuers. Tests 1,423/1,429 (same six failures).

**Checked and left alone**: of the 130 "complete except revenue" issuers, 86 are blank-check shells (SIC 67) with no
revenue to report and class-specific EPS — not a data error. ~100 report a first or successor period shorter than a
year. MC tags only `InvestmentBankingRevenue`; using it as revenue would be wrong for banks, so it is not used.

## Earlier-year revenue check and the five follow-ups — 2026-10-06 (seventh)

Owner asked to check the earlier-year revenue changes and fix the remaining gaps. `EXTRACTION_VERSION` stays `core4`
(nothing has been published with it yet). Scripts: scratchpad `sim8.js` (earlier years + blockers), `fallback.js`.

- **Earlier years, all 5,251 issuers**: 1,699 revenue figures change in 421 companies — 943 match the provider copy,
  534 have no second figure, 56 match neither, 166 matched the old figure. The provider copy's older years were
  extended from our own SEC extraction, so "matched the old figure" is not independent evidence; the ones recognised
  are corrections (HAS 2014 $2.0bn→$4.3bn, MA 2019 gross $25.0bn→net $16.9bn, TAP net sales, WMB, EQT).
  The switch now stays inside the filing the original line came from, so an as-reported year is never swapped for a
  restated one (eBay 2014 stays $17.9bn).
- **Small revenue gaps**: three more arithmetic checks (operating income + operating expenses; pre-tax income + total
  costs; operating income + cost of sales + SG&A). GM $185.0bn, WMT $713.2bn, CVX $189.0bn now total. COP, SNA, RSG have
  nothing to arbitrate and keep the original line.
- **Quarters vs year**: the newest year's quarters use figures filed up to its annual report (later 10-Qs restate
  them: APTV, BDX, ACA), and quarters follow the revenue line of their fiscal year (BG, CRC, LYFT, AAT). Newest-year
  revenue mismatches: 100 under production rules → 53.
- **16-week quarters**: `QUARTER_MAX_DAYS` 105 → 119. Albertsons and Kroger had no first quarter at all.
- **Descriptions**: `scripts/refresh-profiles.js` → `frontend/data/company-profiles.json` (description, sector, industry;
  1,500 symbols a run, in `refresh-quotes.yml`); `stock-universe.withIdentity` merges it where the fundamentals file
  has none. Dry run: 59 of 60 filled; 2,814 symbols wanted.
- **Feed-less annual filings** (264 issuers; SEC's facts feed has nothing for the 20-F/40-F/10-K): with the
  multi-document read and `SEC_ORIGINAL_MAX_MB=64` in the weekly workflow, 203 become complete (TM, BHP, SONY, HDB,
  CLX); 27 stay partial, 32 have no readable tagged figures, 2 have an undecided currency.
- BDC top line: `GrossInvestmentIncomeOperating` as last-resort revenue (OTF, OBDC, PFLT now complete).

**Still open**: ~130 issuers complete except revenue and EPS (advisory firms like MC that tag neither total; IFRS
banks); ~102 with stub or successor periods instead of a full year (PSKY, WOLF); 13 companies that have not filed in
15 months; COP/SNA/RSG revenue line; 53 revenue and 39 net-income quarter mismatches; BHP iron ore; segment labels.

## Full data audit and the revenue-line fix — 2026-10-06 (sixth)

Owner asked for an audit of every company's stored data, then "fix this and the ones found before".
Audit scripts (no model): scratchpad `dbaudit.js` (stored data), `verify.js` (vs live SEC facts), `sim2.js` (old vs new rules).

**Audit of the 4,593 covered issuers (data as of 2026-10-05)**
- All 19,666 newest-year core figures are identical to the SEC record for the same filing (no copying errors).
- **Revenue understated for 187 issuers, 86 by >20%**: the customer-contract tag was tried before total `Revenues`
  (AMT $0.9bn of $10.6bn, ADM $25bn of $80bn, AXP $41bn of $72bn, URI, BG, CCI, EXR, ESS, UDR, WELL).
- Price/market value on only 1,463 of 4,649 listings; sector on ~32%; share count ~32%; description ~56%; segments ~58%.
  `quotes.json` was last refreshed 2026-10-03 against the old 1,502-symbol list; `us-companies.json` now has 6,099 and
  `refresh-quotes.yml` reads it, so the next scheduled run fills prices, market value and share counts
  (dry run on 199 uncovered symbols: 199/199 returned).
- 153 covered issuers a quarter behind: SEC's company-facts feed has no facts for their newest 10-Q (ABT, ACHC, AAT).

**Fixes (EXTRACTION_VERSION `20261006-core4`)**
- `sec-facts.js` revenue: within the newest filing reporting the period — net revenues if a financial firm reports
  them (≥25% of the largest line); else the line that equals gross profit + cost of revenue, or operating income +
  `CostsAndExpenses`; else the largest line only when the original line is under 80% of it; otherwise unchanged.
  Derived quarters use the same line as their year-to-date total. Helper inputs sit last in `MAPS` and new tags never
  add a reporting period.
- `scripts/refresh-sec-coverage.js`: reads the newest 10-Q itself when the feed has not produced its quarter.
- `backend/sector.js` `fromSic` + `build-public-stock-index.js`: a company with no curated sector takes its SIC sector.

**Measured, production rules vs new rules, all 5,251 issuers with an annual report**: 263 become complete; newest-year
revenue changes for 188 (172 up, 16 down); agreement with the provider copy 3,048 → 3,161 of 3,380 (118 fixed, 5 now
differ: HOG, PGY, CRON, TIGR, BRLS); gross profit larger than revenue 55 → 18 issuers; no other field changes.
Dropped: 40 derived gross-profit values in old years (2009–2022, revenue and cost now come from different filings)
and 4 old cash-flow values (RDN 2011, RH 2015). Tests: full suite 1,421/1,427, same six failures as before.

**Not fixed**: small-gap revenue cases with nothing to arbitrate keep the original line (GM $168bn vs $185bn total,
COP, WMT net sales, SNA, RSG); business descriptions for ~44% of covered issuers; ACI-style 10-Qs the direct read
does not parse; derived-Q4 mismatches (APTV); the 266 partial / 253 history-only issuers listed below.

## Data foundation repair: missing core figures, currency, recency, Exxon — 2026-10-06 (fifth, NOT pushed)

Owner: "our entire business lives and dies by the accuracy of our data". Audit of the stored statements (no model):
1,104 stock issuers lacked at least one of the five core figures in their newest annual report; 1,450 listed stocks were
not screenable at all (MU, XOM, BKNG, JCI, APD, BDX, PDD, JD, BABA...). Causes found and fixed in the extraction code —
**the stored data only changes when the weekly workflow re-runs** (`gh workflow run refresh-fundamentals.yml`; the
`EXTRACTION_VERSION` bump to `20261006-core3` forces every issuer to be re-extracted).

- `sec-facts.js`: revenue tag was misspelt (`RevenueNetOfInterestExpense` → `RevenuesNetOfInterestExpense`: MS, GS had no
  revenue); added utility revenue, partners'/members' capital, total liabilities-and-equity as total assets, net income to
  common and continuing-operations cash flow (both only when the filing shows no preferred dividend / discontinued cash
  flow), continuing + discontinued cash flow summed, IFRS net sales + other revenue summed only when gross profit + cost
  of sales confirms it (NVS $56.674bn, SNY €46.716bn). New tags are `LAST_RESORT`: tried after every original tag.
- Currency: a dollar convenience translation beside the reporting currency was "ambiguous" and dropped every year
  (253 issuers; PDD stuck at 2017). Now the currency with ≥1.5× the core figures inside the reporting filing wins.
- `sec-coverage.js`: recent annual = filed within **15** months (was 12; MU and 8 others fell out for the days before
  this year's filing). The 18-month period test is unchanged. `verifiedField` accepts the two new sums.
- `sec-original.js`: when the primary document is only a cover page, the filing's other documents are read with the
  shared period declarations (CLX FY2026 now ready).
- `scripts/lib/us-listings.js` `REGISTRATION_CONTINUITY`: XOM keeps CIK 0000034088 until 2027-03-31 (ExxonMobil Holdings,
  new CIK 0002115436 since 2026-07-01, has no annual report of its own).
- `ask-report-policy.js`: `COMMON_NAMES` and `narrow()` — google→GOOGL (was a hedged fund), exxon→XOM (was nothing),
  toyota/shell/berkshire/alphabet no longer ask which listing. `ask-segments.js` download limit 32 MB (ASML).

**Measured** (old vs new rules on live SEC facts, 1,484 issuers incl. 380 already-ready as a regression sample; the
filing-read fallback is not in this run): 263 issuers become ready (122 partial, 141 historical-only), 887 annual periods
gained, **0 figures lost, 0 existing figures changed**. Tests: SEC files 74/74, Ask files 233/233, full suite 1,419/1,425
(same six failures as before this work).

**Still open after this**: 266 partial and 115 historical-only issuers in the affected set (SU, DB, VALE, NGG, CNI, KEP,
SKT — 40-F exhibits, co-registrants, filings over 18 MB, IFRS banks with no revenue total); LHX revenue (SEC feed has a
wrong start date); NEE, BAC, AZN, TD segments still need the model; BHP iron ore; de-camel-cased segment names.

## Shipped 2026-10-06, detail in `.claude/handoff-archive/2026-10-06.md (second snapshot)`

- Ask for every kind of company: SIC typing (`ask-industry-profile.js`), model-free segment/product/region read
  (`ask-inline-segments.js` `groups`), same-day report cache (`ask_report_cache`, `ASK_REPORT_CACHE=0` disables),
  `ASK_SEGMENT_RSS_LIMIT_MB` (default 400 — watch memory).
- Data foundation repair (first pass): missing core figures, convenience-translation currency, 15-month recency,
  Exxon registration continuity until 2027-03-31, common-name resolution in Ask.

## Production state — 2026-10-04
- **The industry-personalized Ask framework is deployed.** Production commit `6898cdb4` went live as Render
  deploy `dep-db181bvavr4c73an2krg` through workflow `37216736433`; the workflow confirmed the deployed
  commit. `/api/health` returned 200 with `{"ok":true}`. Direct requests to `/ask` and the stamped asset
  returned 403 from this environment, so authenticated rendered-page verification is still unavailable.
  Historical Ask asset stamp: `20261004-askfacet1`.
- The earlier rollback `97c61b35` deployed as `dep-db0uvplg1s2s73fplsq0` through workflow `37182036116`.
  Its historical evidence remains in `docs/qa/ask-rollback-2026-10-04/release.json`.
- Earlier the same day, the SEC coverage release `73186a12` deployed and passed independent production
  checks: 6,099 securities, 4,440 ready issuers, 4,498 screenable listings; live stock sitemap matched the
  snapshot exactly; 403s blocked automated stock-profile/alias checks, so authenticated Ask stayed unverified
  there. Evidence: `docs/qa/ask-live-readiness-2026-10-04/`.
- The release restored the Ask modules onto current `main` while keeping the SEC data and dependency files.
  The tested source branch remains `ask-production-ready-20261004` at `ed11f4e7`.

## In flight

**Day 41 AppLovin card — re-rendered in the house theme (10/03, DONE; `marketing/` is gitignored).**
`marketing/applovin-growth/applovin-axon-q2-2026.{html,png}`: the ChatGPT dark card's content in the
`applovin-growth-2020-2025.html` skeleton. PNG is 3072×2048, rendered by headless Chrome
`--force-device-scale-factor=2` — `scripts/screenshot-cdp.js` pins `deviceScaleFactor: 1`.
- **The published labels do not compound:** 0.98 × 1.58 = 1.5484, so the strict endpoint is 154.8, not 153.
- **`applovin-axon-q2-2026-artifact.html` is the share page and is NOT PUBLISHED.** This session
  authenticates with `ANTHROPIC_AUTH_TOKEN`, which takes precedence over a claude.ai login, so **every
  `Artifact` call is refused** — unset the var, `/login` as a Claude account, then publish.
- **Trap for scaled poster pages:** without `*{box-sizing:border-box}` the board's 56px padding sits outside
  its 1536px width and the scaled sheet clips the right 56px. The reset must not zero `:root` padding.

**Breakthrough-product hunt (10/01–10/02) — completed; the result is a negative with a sharp conclusion.**
75-agent adversarial funnel (26 ideas → 15 after dedup): all 15 passed the live novelty kill-squad, all 15 died
at the 3-lens adversarial panel, and a manual re-review of all 45 refutes confirms the kills. Repeated
findings: every high-price version sells to buyers behind enterprise procurement this company cannot reach;
incumbents hold them; EDGAR/XBRL-derived moats are copyable. Strongest near-miss: "Audited Alpha" (creator
track-record registry), viable only reframed at $49–149/mo self-serve; never panel-tested in that form.
`notes/2026-10-02-breakthrough-product-hunt-result.md`.

**OpenAI ChatGPT plugin directory — SUBMITTED 10/01, "In review"; package-side items all DONE.**
Surface is `POST /mcp/apps` (`backend/mcp-apps.js` + `backend/mcp-financials.js`), 7 read-only intent tools.
Package: `OPENAI_PLUGIN_SUBMISSION.md`; design note: `notes/2026-09-29-openai-plugin-architecture.md`.
- **Live checks:** `scripts/verify-mcp-apps.js --review-cases` = **23/23** against production (re-run after
  every deploy); official MCP Inspector `--strict` = **0 findings**; `/mcp` legacy contract unchanged.
- **`/mcp/apps` takes `company`; `/mcp` takes `ticker`.** `backend/scripts/test-mcp.mjs` speaks the `/mcp`
  shape, so running it against `/mcp/apps` reports one FAILED metered call — that is the harness, not the
  surface.
- **Review state: "In review", version `1.0.0`, identity verification still "Identity in review"** —
  publishing under an unverified name is an automatic rejection. **Only one review may be active per plugin**;
  *Cancel review* withdraws it, so never press it casually.
- **The one real loose end: the five reviewer-credential fields were never re-checked** (the panel renders
  only inside the one-shot Submit wizard). Credentials: `~/.config/stockportfolio/reviewer-account.txt`.
  Also still open, ours: the privacy policy's human legal review.
- **The ZIP is the source of truth, not the form.** Rebuild with `scripts/build-openai-plugin.sh`; read its
  header for the three capture traps. The walkthrough mp4 is real and **a re-recording needs a new filename**
  (`.mp4` gets the same one-year immutable header as `.js`).
- **OIDC (fixed `656d4b52`, verified live):** discovery metadata, `openid` + `email` scopes, UserInfo with
  `email_verified`. **No ID token is issued** (deliberate).
- **The ChatGPT connector itself is LIVE in the owner's account (9/30).** **CIMD is not supported.**

**Claude / Anthropic directory — BOTH submissions are IN (10/01). Nothing is blocked on us.**
Submit at **claude.ai/directory/manage** (the Console form is retired).
- **Plugin bundle — `Publish requested`**; repo public, MIT, `claude plugin validate .` passes. **Do not press
  `Cancel review`.**
- **MCP connector — `In review`**, listing slug **`stockportfolio`** (permanent). The portal only re-reads a
  tool list on reconnect, not on reload.
- **Auth is declared `Required when the server asks` + DCR** — honest (the free tier is real), but a directory
  user is not forced to sign in. One click on Settings changes it to `Always required`.
- **Reviewer account: `openai-review@stockportfolio.pro`** — declared as a `UserSchema` path
  (`reviewAccount`); four reads skip it (`trackActivation`, the `mcp_oauth_authorized` event,
  `/api/admin/customers`, the trial-lifecycle drip). **Mongoose strips undeclared paths, so the schema half is
  the one that fails invisibly.** Package + history: `docs/growth/claude-plugin-submission.md`.

**AppSumo final-window repricing — v8 copy DONE (11/11 guards); the flip partly started, NOT finished.**
Values + order: `docs/growth/appsumo-listing-v8.md` (target 149/549 · 299/1099 · 499/1849, wallet
200/500/1000). `CREDIT_ALLOWANCE_V3_EFFECTIVE_FROM` is stored on Render, deploy followed — **unprovable from
outside by design**. **Three writes were BLOCKED by the auto-mode classifier** (the Render env set, the
grandfathered-licence importer, the portal draft values) — hand over, don't retry. Portal is browser-only
(`node /tmp/as-drive.mjs`, Chrome :9222, profile `~/.appsumo-portal-profile`); **never touch
`/self-submission/231048/build`**, never press EXIT. **Remaining:** nine price/wallet values, long
description, five FAQ slots, API+MCP row wording; then Submit → reply in Yena's thread.

**Filing Watch $49/month pilot — BUILT, VALIDATED, DEPLOYED flag-ON (`d642d04a`). $0 collected, zero offers
sent.** Ops doc: `docs/growth/filing-watch-runbook.md`. Fails closed (`PILOT_NOT_OPEN`, `PRICE_UNVERIFIED`).
Real success/decline, webhook, renewal, refund and cancellation behaviour is **unverified** — never test with
a production card. **Prospects: 1 of 5** (`ncdorc`/ATOS, qualified). **Never send outreach without the owner's
explicit authorization.**

**Dossier redesign — "The Plain Filing" — mockup done, awaiting review.** Plan
`~/.claude/plans/valiant-singing-parnas.md`; `docs/design/dossier-plain-filing.html` (Newsreader / IBM Plex).
**Step 2 — the port — has NOT started.** Regenerate with
`node scripts/build-dossier-mockup-artifact.js`; never hand-edit it.

**Emotional design** — plan `~/.claude/plans/warm-orbiting-sketch.md` (approved). Phases 0-5 shipped 9/24-25;
**phases 6-7 NOT started** (year in filings, comprehension streak).
- **Standing rules, still binding:** the error overlay's "Nothing was changed" is an explicit `unchanged: true`
  opt-in; X-Ray exposure is summed in **DOLLARS**; an EMPTY alert list renders a quiet card rather than hiding
  the section.

**AI portfolio creator — announced 9/25 as in-development, no date promised, no spec file yet.**

## Walls (live in prod)
- Geo wall `GEO_WALL_COUNTRIES` (`SG,CN,HK`); hosting/VPN wall `HOSTING_WALL_ENABLED` (ON) from
  `backend/data/hosting-ranges.bin`. Hard paywall `WALL_ALL_PAGES` — off since the wall week (3 signups /
  9 days, 0 paid); **`/docs` is the only product surface readable signed out.**
- **Load-bearing, both walls:** the visitor IP comes from `marketingAttribution.requestIp()`
  (CF-Connecting-IP in prod), **never `req.ip`**. The crawler exemption is not optional either: Googlebot/Bingbot
  crawl from cloud ranges that ARE in the hosting table, so without it the wall 302s them and deindexes the site.
- **The MCP transport is the ONE surface the walls no longer decide.** `apiKeyAuthOptional` makes no decision
  at the transport; identity, entitlement, allowance and the wall resolve inside `mcp-endpoint.js` at
  `tools/call` and return as **tool errors** the model can read. The old 402 is gone because directory probes
  run from datacenter IPs and the hosting wall classified every cloud range as hosting.
- **Unclosed:** ~25 keyless `/api/*` endpoints serve product data with no auth and no country check.

## SEO / discovery — measured; do not re-derive
- **The bottleneck is indexing and site-level trust, not content, targeting or segment** — titles/H1s match
  the queries and canonicals are clean, yet Google gives ~340 human impressions/month, ~0 clicks, median
  position ~52 across ~21,700 URLs, while Bing ranks the same site well (7.7% CTR, pos 6.1).
- **87% of raw "impressions" are rank tools, not people**; `seo-data/search-opportunities.md`'s P1 rows are
  phantoms. Parse GSC/Bing CSVs RFC4180; `split(',')` yields NaN.
- **Google names the reason itself:** crawled-but-not-indexed means "insufficient value **or user demand**".
  Demand follows links, so **external links/citations are the unmeasured, unattempted lever**. Never `noindex`
  an unwanted URL — use robots.txt, a one-way door, or emit fewer URLs.
- **The URL Inspection API reports the LAST CRAWL, never a live fetch.** The 9/15 hard paywall (`f4af1ee5`)
  was the real deindexing cause; fixed 9/24.
- **Gemini cannot be targeted as a crawler — none exists.** AI Overviews ground on Googlebot, so this lever IS
  the indexing lever.
- Operator Python needs **`.venv/bin/python3`** (Homebrew Python is PEP 668-managed).
- **Pushing Bing to recrawl:** the URL submission API is small (100/day, 300/month) and **counts 301-ing URLs
  too**; **IndexNow is the free channel for moved URLs**. `GetSiteScan`/`SubmitSiteScan` 404 — **Site Scan is
  UI-only**.

## Prices, freshness, dead tickers (deployed 9/28, still load-bearing)
- `backend/quote-store.js` is the one place pages ask for a price.
- **Freshness = the data's own dates, never mtime** (`backend/fundamentals-date.js`, `STALE_DAYS=45`).
- **A fundamentals commit must deploy** (`frontend/data/fundamentals/` is read from the deployed filesystem).
- **Dead-ticker rule:** two *separate days* of Yahoo "Quote not found" mark a ticker unlisted; a later success
  clears it. The weekly workflow writes `fundamentals-status.json` but does not stage it.

## AI model + cost
- **Every purpose resolves to `glm-5.3`** (`ai-client.js:20`); `glm-5.1` is retired. `glm-5.3` needs
  `reasoning_effort: 'low'` (`ai-client.js:82`).
- Cost baseline was a measured **$28.91/mo ≈ 48% of the $60 allowance** on glm-5.1
  (`scripts/ollama-cost-projection.js`); real split 95/5 chat, 90/10 summary. **Re-measure after the swap.**
- **glm-5.3-flash on MCP/API Ask: validated and REJECTED** — fails the tool-set gate (60% against an 80% bar)
  and is slower with the 32 schemas attached (1.55x).
- **Trap:** `promptTokens`/`completionTokens` are *missing* (not null) before 9/11, so `$ne: [field, null]`
  does not exclude them. Use `$isNumber` and apportion each group's FULL `totalTokens`.

## Traps that have already cost real time
- **The local Ask harness holds backend modules in memory** — restart it after every edit, or every
  measurement is against the old build.
- **The model mis-rounds ratios.** The tool's own `table` column is the quote source, and a value restated one
  tenth off is rejected as unsourced (49.3% for a supplied 49.35). The prompt now says so explicitly.
- **A fence field the renderer ignores fails silently.** `"facet": true` on a `viz` line chart was simply
  dropped; the answer still validated and still published a flat-line chart. Anything the prompt advertises
  needs a validator rule or a renderer branch, not just prose.
- `users.updatedAt` reads "3d ago" for every account uniformly — a bulk-write artifact. **Measure activity
  from `ollama_usage_events`, never `updatedAt`.**
- **A broadcast's recipient list is not a customer list.** The 9/23 "general" send's 47 non-owner recipients
  had **0 live userIds**.
- **~95% of first-party "unique visitors" are a botnet hitting `/register.html`.** Check distinct user agents
  before quoting any visitor count.
- Chrome headless sends "HeadlessChrome", which `bot-blocker.js` correctly 403s — override the UA. Browser
  checks go through CDP (`scripts/screenshot-cdp.js`).
- **A CSP failure that exists only in production is invisible to a same-origin harness.** Chrome enforces
  `form-action` across *redirects*, and it failed *silently* while the loopback e2e passed 14/14. When a
  browser button "does nothing", read `Log.entryAdded` + `Network.loadingFailed` over CDP first.
- `access_token()` in the GSC script returns a **tuple** `(token, client_email)`; treating it as a string 401s.
- zsh does not word-split unquoted variables: bulk `sed` needs `… | xargs sed -i '' …`.
- **The clean release tree has six pre-existing full-suite failures** (1233 pass, 6 fail), reproduced on the
  pre-release production tree. The feature worktree's dirty, unrelated local fixes made its full suite green
  (1239 pass). **No CI job runs the full suite** — `repo-checks.yml` runs only `handoff-size`; 23 files need
  mongo, 25 touch the network and 8 need root `node_modules`.
- **A test can encode a coincidence and still look like an invariant.** `sitemap-index.test.js` asserted
  lastmod must *vary* — true only while two dates happened to differ.
- **A source-pinning test slices source, and the slice is a silent expiry date.** Slice to the next function,
  not to a character count.
- **The CI-skip marker matches ANYWHERE in a commit message.** Detect a skipped deploy by the absence of a run
  for the new SHA (`gh run list`), not by the push output. `frontend/data/fundamentals/**` must never carry it.
- **Live verification has a request budget: 100 non-asset requests per 5 min per IP** (`navMax()`,
  `bot-blocker.js:158`; the limiter returns the *same* 403 body as a UA deny). Split sweeps across windows.

## Owner actions pending
1. **Pay the overdue Claude Pro invoice — this one blocks you directly.** `Settings → Billing`: past due and
   paused on **Discover •••• 4563**, so Claude cannot send a message at all. Only you can do this.
2. **OpenAI plugin submission — "In review".** Watch for the verdict; identity verification has not cleared and
   the reviewer-credential fields were never re-checked. Do not press **Cancel review**.
3. **Claude / Anthropic directory — nothing for you to do.** Two judgement calls if you want to revisit them:
   the connector's auth declaration and reusing the OpenAI reviewer account. The signed-in session lives in
   the scratch Chrome profile (`/tmp/claude-console-profile`, CDP :9335) — **still live**.
4. **Dossier mockup review** — step 2, the port, has not started.
5. **URL Inspection → Request Indexing** on the highest-value pages — `Page with redirect` (604) + `Server
   error (5xx)` (2) need the UI drill-down; the API has neither. Re-run **Site Scan** and click **Investigate**
   on the identical-titles / identical-descriptions / noindex / **Title-too-long** cards.
6. **`avisre/prod` visibility** — it names the AI provider while public.
7. **Rotate the secrets exposed in local transcripts** (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, JWT_SECRET,
   SMTP_PASS, GOOGLE_CLIENT_SECRET, the provider key) at source AND on Render back-to-back per key, or
   checkout and webhooks break mid-rotation. Also revoke the old GitHub PAT and npm token pasted 9/14.
8. **List-Unsubscribe + DMARC `rua`** before the next bulk send.
9. **Reopen-10-accounts script** (`scratchpad/.../reopen/run.js`) was blocked by the classifier — needs approval.
10. **`scripts/verify-receipts-panel.js` and `scripts/verify-send-receipt.js` are untracked.**
11. **AppSumo listing** is portal-only: paste + approval. The unredeemed buyers are unreachable — AppSumo holds
    their email, not us.
12. **Monthly provider bill** — the one input that states AI margin in dollars.
13. **Orphan IndexNow key** `1668f45a03ea53cf94c51b61c43163d4.txt` — confirm it is registered, or delete it.
14. **`mcp-server` republish** — its README documents the retired `sp_*` tool names.
15. **Publish the Day 41 share page (optional).** Unset `ANTHROPIC_AUTH_TOKEN` and `/login` with a Claude
    account, then re-run the publish.
16. **ChatGPT connector polish** (optional): the icon is the default placeholder, and the plugin still reads
    `DEVELOPMENT` review status. Separate from the directory submission in item 2.

## 2026-10-07 — no blue, profile side menu, account tray (stamp `20261007-offbalance1`)
- **Blue is gone from the main site.** `--accent` is now the ink, `--accent-tint` a warm grey, `--chart-1` the ink; prose links are underlined instead (`system.css` anchor rules). 228 hard-coded blue and slate literals in `backend/` + `lib/` (emails, widgets, server-rendered pages) mapped to the same ink and warm greys. Checked in a headless browser: 0 blue computed colours on 15 pages.
- **Still blue, not touched:** the four legacy pages served from `frontend/` (`/fundamentals.html`, `/founding.html`, `/demo-dashboard.html`, `/demo-fundamentals.html`) — an old dark theme, unlinked from the site. Owner to decide: retire or redirect.
- **Profile is a side menu at 861px+** (`profile.html`, `profile.js`): each section is still a `<details>`, the menu picks which is open, `#usage-details`-style hashes still work. New Account section (email, reset password, sign out).
- **Messages are a reading view, newest first.** A broadcast is a "product update": title = the broadcast title, body reads `# `, `- `, `**bold**`, blank line (`messages.js` and `customerMessageHtml` in `app.js` for the email). `CustomerMessage.title` is new. Body cap is still 4,000 characters.
- **Account tray** paints before it opens (session + credits cached in `sessionStorage`, credits prefetched at idle); it used to show an empty box until two requests returned.
- This file is past 400 lines: rotate it at the next edit.
