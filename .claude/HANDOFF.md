# Handoff

Durable working memory — **keep under 500 lines** (CLAUDE.md), enforced by
`backend/test/handoff-size.test.js`, which the pre-push gate runs whenever this file changes. Current state and open actions only, never a transcript. At ~400 lines,
snapshot this file to `.claude/handoff-archive/<date>.md` and rewrite it fresh; **delete superseded items to
the snapshot rather than compressing them here**.
Earlier snapshots: `handoff-archive/2026-11-07.md` (verbatim, 408 lines — the shipped 11-01..11-05 write-ups: every
income cell filled (identities, PART_SUMS), software FCF / trailing P/E / Mac nav, alt-tag fills and debt guards,
segment-note quarter lines; all on origin/main since `f9f3ef7d0`), `handoff-archive/2026-11-01.md` (verbatim, 402 lines — bank/insurer fill, 10/31 page-gap fixes and
traps, as-filed statements (off), the 10/25 push, latency + price-trend + Ask quality work of 10/24, Ask chat parity,
the 10/17 statements fill (`EXTRACTION_VERSION` history, presented debt, weekly made incremental, FX/IAS 29)),
`2026-10-17.md` (10/10–10/11 write-ups), `2026-10-11.md` (10/08 owner decisions, live and settled), `2026-10-10.md`,
`2026-10-07.md` (the six 10/06 data-audit write-ups — read them before touching core statement extraction),
`2026-10-04.md`, `2026-10-03.md`, `2026-10-01.md`, `2026-09-30.md`, `2026-09-28.md`.
Deep history: `git log`, `notes/2026-09-*.md`, `docs/growth/`, `docs/seo/`, `~/.claude/plans/`.

## Banks/insurers in Screener's layout, segment history, FDIC banks — 2026-11-06 (committed locally, NOT pushed)
- **Commits:** 604a04c0d (Screener row structure, assets first), e736523dc (431 banks/insurers re-extracted),
  7039e34e8 (segment history to FY2008, paid plans only), 561bff47a (OOM hotfix: 8 split-adjusted payloads, not 4000;
  push this one first if pushing separately), plus this session's sec-facts/segment fixes + a 480-issuer re-extraction.
- **Re-extraction diff vs HEAD (475 files):** +9,983 cells, 1,139 changed (mostly the intended fixes: shortTermDebt 232,
  loansGross 196, HTM 158, otherLiabilities 143), 1,764 lost (mostly the 2014-09-30 quarter rolling out of the 48-quarter
  window; 39 `shortLongTermDebtTotal` = the open owner decision). **Citi (0000831001):** SEC companyfacts on 11-06 had NO
  2026 10-Q facts (only the 10-K), so Q1 2026 dropped; the committed Q1 rows + their 65 sources were grafted back and
  the window trimmed to 48. **Trap:** Saturday's weekly run will drop Citi Q1 2026 again if SEC still serves that.
- **Segment history:** 168 issuers in `backend/data/segment-history/` (TRV, AIG, AAPL added 11-06; PGR has no segment
  table, never had one). Weekly job refreshes them from a cached filing store (`actions/cache`).
- **Segment history for ALL covered stocks (owner ask 11-06) — DONE 11-07, committed de5d491b5 (local):** 3,733
  issuers in `backend/data/segment-history/` (77 MB), builder `20261106-history3`; 139 have nothing to build. fe979b8d0
  read old axis names / `Revenues` as sales; f1b7610b4 reads pre-2018 `SalesRevenueGoodsNet`/`ServicesNet` only where
  its total equals the filed revenue total (AMD now FY2010-25, was FY2016+): 109 issuers start earlier, +530 years,
  0 lost. The FY2016 start cluster (447 left) is genuine: 305 of 314 product-axis ones never tagged that axis before
  ASC 606 (FY2018 10-Ks reach back to FY2016). Coverage outliers (<60%/>110% of revenue) 2.9% of 30,832 year-cells,
  same rate in the new years: a filer's extra member on the axis (Thor "Export"), pre-existing, not fixed.
  Local filing cache `.cache/` (749 MB, gitignored; backup of the pre-fix cache in `segment-run/cache-backup-history2`).
  6b5af3e2f: weekly refresh skips issuers with no new periodic filing (`unchanged`, tested) and stops starting issuers
  after `--budget-minutes 100` (tested; cached first). **CI's cache is cold for ~3,560 issuers**: the first weekly runs
  will warm it in slices; the rest keep their committed tables. Logs/lists: `~/Downloads/new/segment-run/`.
- **Owner order 11-06: show single-segment and <60% tables anyway** → 3551328aa (local). `preferred()` falls back:
  2+ rows any coverage → one row ≈100% named → generic "Reportable Segment" member (kept by `read()`, shown as
  "Single reportable segment"; NFLX shows "Streaming") → one line any coverage. Never: only "All Other"/corporate/
  eliminations rows (CVX), or >110%. Remainder calculated + named on page/contract/Ask; segment view leads with
  "Partial breakdown: these lines cover N%…" or "reports a single segment". Text (model) reads keep 60%/2 rows.
  Measured on the 439 hidden: 242 complete, 161 partial, 36 still none, 0 contract violations. Golden: only NFLX moved.
  History: `lead().single` (6b5af3e2f) lets a one-row table build; the 453 newly eligible issuers are in de5d491b5.
- **Gap fills, builder `20261107-history4` (owner order 11-07: leave perfect stocks alone, redo only the ones with
  gaps) — 984126110 code + e85a993e5 data, local.** Fill rules + refusals: comments in `sec-segment-history.js`, one
  test each in `segment-history.test.js` (21). `current()`: a history3 file with no in-span gap counts as current, so
  2,221 complete issuers are never rebuilt (verified byte-identical from cache). 1,512 gap issuers rebuilt: 2,601 cells
  filled / 799 issuers; gaps 15,332 → 12,776; 0 filed cells changed or lost from their own report. **Trap (hit 11-07):**
  reports read only to fill a gap must stay `fillOnly` in `.cache/` — as column sources a newer repeat took columns
  over and blanked/restated 134 filed cells (Masco, Quantum). The builder ignores them for columns, measure, labels and
  Q4 nine months; `collect()` promotes one it needs. **Trap:** a file written as history4 is current, so a later
  builder change does not redo it — bump VERSION.
  Run dir `~/Downloads/new/segment-gaps/` (before/ snapshot of all 3,733, verify2.json).
- **Builder `20261107-history5` (owner order 11-07: fill edge cells + the issuers with no table), local, NOT pushed.**
  `buildHistory` is now a wrapper over `build(filings, lead, {statement, edges, units})`: (1) strict build; (2) if it
  builds nothing, statement mode (the statement's revenue as filed: same-filing `MAPS.income.totalRevenue` concepts,
  else `lead().totals` = verified, non-derived `totalRevenue` per period; units kept apart; generic members take their
  filed label, e.g. Lamar "Billboard"); (3) else a units-apart rebuild taken only if `keeps()` — every strict column,
  row and filed figure unchanged, no new over-total column (92 foreign filers gain their latest CNY/TWD year; 104 cols);
  (4) an edges build (cells outside a row's first..last value) merged only into empty cells, refused where it carries
  a column past total ×1.005 or makes a derived Q4 negative for a year ≥ 0. Applied globally the statement fallback
  and units grouping each disturbed 100+ tables — hence the gating. Against HEAD: 3,733 tables, 7,483 new cells in
  1,176 tables, 0 changed/lost cells, rows or columns, 0 new over-total columns. `COMPATIBLE = []` (all rewritten from
  cache, `builtAt` kept). Group 3 (139 with observations but no table): 135 built from SEC (12,940 cells, every
  non-derived one present as a filed fact; Wendy's/Lamar totals = SEC companyconcept), 4 no history. Not built: 36
  with no usable/partial lead table, 3 banks (fee-only table vs a composite total), Elevra (stale AUD lead).
- **Builder `20261107-history6` (11-07, local, NOT pushed): derived Q4 on one footing.** A Q4 is year − nine months;
  when a later report recast one of them the pair mixed footings (Targa Q4 2025 Logistics $14,170M / Gathering
  −$1,130M; 3M Q4 2022 total $11M; Harmonic SaaS −$72.7M). `onFooting()` redraws a pair only when it is plainly broken
  (Q4 segments > 2× its total, total ≤ 0 under positive segments, or a segment the year files positive going below
  −2% of the quarter) and only onto a pair that fits (`footing()`: every segment the year shows is in the nine months,
  segments within the year's own segment/total ratio ×1.02; recast-year segments taken through `scored()` so subtotals
  drop). Else the next nine months filed, else another annual report's year (named per cell, `part: 'year'`), else
  left as filed. `q4Total()` refuses a total it cannot be on (another 10-K's year total, recorded as `from.yearTotal`,
  or null). Against history5: broken Q4 columns 149 → 0, negative-segment Q4 columns 375 → 189 (rest have no fitting
  pair; an insurer's investment line can be negative), 647 Q4 cells corrected, 217 new, 0 changes outside derived Q4,
  0 lost, 0 new over-total columns. Tests: segment-history (25). Tried and dropped: a SEC pass reading repeat reports
  for cells just outside a row's span — pilot 60 issuers, 52 reports → 4 cells; the edges are real absences.
  Also fixed: the flaky suite tests — `mcp-usage-log` polled for one of two indexes; `ai-paper-portfolio` feed writes
  were fire-and-forget so a research line could land after "Paused" (also a prod feed-order bug; now queued, the pause
  awaits them). direct-ltd-affiliate / Stripe-reversal flakes did not reproduce in 3 predeploy-style runs.
- **FDIC banks (TOWN, HIFS, NBN, FRBA, SSBI, RCBC, ASBH, + WCCB sole-subsidiary):** no SEC statements (they file with
  their bank regulator under §12(i)), so `company.js` `fdicReports()` builds income + balance from the FDIC Call Report
  rows in `supplemental-financials/` when a payload has no SEC rows at all (SEC always wins). No cash-flow statement
  exists in a Call Report → message says so. NBN (June FY) annual columns read CY. `fetch-fdic-financials.js` now maps
  27 lines (10 flows incl. ESAL staff cost, 17 balance lines) and rejects a record unless equity, liabilities and
  cash-and-due equal their FDIC parts (held on 432/432 records). Weekly workflow runs it before the listings stage.
  TOWN Q2 2026 Other Income $276.1M is the FDIC's own NONIIQ (Q1 $88.0M), not a bug. FDIC Q3 Call Reports not out yet.
  Stamp `20261106-fdic1`. Tests: `fdic-financials`, `company-statements` (FDIC page test).
- **Open for owner:** Voya total debt null; 44 issuers' doubled short-term debt now rejected (blank, not doubled);
  whether to bump the industry VERSION.

## Live prices, faster portfolio, Mongo backup — 2026-11-06 (owner order; committed locally, NOT pushed)
- **Root cause (Render logs):** Yahoo answers `quote()`'s crumb handshake `429 Too Many Requests` from the Render IP
  (AMD 2026-11-05T20:09Z, AAPL/INTC/BAC…, ~1 call/hour → IP block, not volume). `quote-store.fetchLive` swallowed it, so
  every page showed the `quotes.json` overnight close (AMD $488.78 vs live ~$414) and the fundamentals route cached that
  10 min. `chart()` needs no crumb and works from Render.
- **Fix:** `yahoo-source.liveQuote` = chart meta first (`quoteFromChartMeta`), `quote()` only if the chart fails, and a
  crumb failure turns `quote()` off process-wide 15 min; per-symbol in-flight dedupe. `fetchQuote`/`fetchQuoteExtras`,
  `asset-profile`, crypto price/profile all go through it. `quote-store`: chart lacks P/E, yield, shares, cap → re-priced
  from the snapshot (`fillFromSnapshot`, ratio live/snap); `[quote] fallback SYM reason=…` logged once/symbol/10 min; a
  request that outlasts the 2.5 s timeout still fills the cache. Fundamentals response cache 60 s unless the price is
  `market_closed` (or crawler). Add/import no longer stores a `profile.stale` price.
- **Portfolio speed:** `stocks` had only `_id` in prod → `{user,portfolioId}` index (schema + explicit `createIndex` at
  connect); `.lean()` reads (`holdingRow` restores `assetType`/`portfolioId` defaults); `/api/portfolios` one `$group`;
  outbound gate 400→150 ms. `[timing] route=portfolio|portfolios|xray|attribution|fundamentals` lines in Render logs —
  read them after the push to get real before/after numbers.
- Measured locally: AMD live $414.04, P/E 104.44→88.47, cap $798B→$676B; 15 holdings priced 2.1 s cold / 0.85 s warm.
  Tests `live-quote-chart.test.js`.
- **Backup:** `scripts/mongo-backup.js` (EJSON gz per collection + indexes + manifest, verify pass) →
  `~/Downloads/stockportfolio-backups/mongo-20261105T202224Z/` (mode 700). `scripts/mongo-restore.js` refuses non-local
  targets without `--target-is-production`. `scripts/mongo-storage-report.js` → `storage-report-20261105.md`: 377 MB /
  512 MB; funnel_events 144 MB (no TTL), insider_form4 85 MB, public_financial_requests 64 MB capped, company_dossiers
  34 MB, filing_text 28 MB (TTL ok). **Nothing deleted — owner picks from the report.**
- **Prod is missing schema indexes** (stocks, `pendingsignups` TTL, `*_free_usage`, `users.resetPasswordToken`); cause
  not found, no errors logged. Not fixed beyond the stocks index.

## Open
- **From the shipped 11-05 work:** extractor `ytd_difference` at a de-SPAC Q4 subtracts the SPAC's 9M from the opco's
  year (IMSR Q4 2025 NI −31.2m stored) — needs a guard on a change of reporting entity. Not done from that plan: custom
  (company-prefix) tags, foreign half-year columns, SPAC annual statements, InterestExpenseDebt / CostsAndExpenses opex.
  Refresh cron is still weekly (runs 150–187 min; daily Mon–Sat ≈ 4,400 Actions min/month) — owner's call.
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
