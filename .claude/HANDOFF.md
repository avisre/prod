# Handoff

Durable working memory — **keep under 500 lines** (CLAUDE.md), enforced by
`backend/test/handoff-size.test.js`, which the pre-push gate runs whenever this file changes. Current state and open actions only, never a transcript. At ~400 lines,
snapshot this file to `.claude/handoff-archive/<date>.md` and rewrite it fresh; **delete superseded items to
the snapshot rather than compressing them here**.
Earlier snapshots: `handoff-archive/2026-10-17.md` (verbatim, taken 10/17 at 482 lines — the 10/10 and 10/11 write-ups:
AppSumo sales retired, Ask conditions / credits-until-spent, the multi-company comparison fix, Ask vs AI Paper
Portfolio split, customer-question fixes, trades + economic data, account actions, AI Portfolio accounting and owner
controls, deploy checks moved off GitHub, connector pricing (charged 1 / listed 2), saved screens, parked voice input,
peers by industry label, long-term asset lines, the 10/10 site-audit fixes, capex mapping, gurus, price history),
`handoff-archive/2026-10-11.md` (verbatim, 492 lines — the 10/08 owner decisions that are live and settled),
`handoff-archive/2026-10-10.md`, `2026-10-07.md` (the six 10/06 data-audit write-ups — read them before touching
core statement extraction), `2026-10-04.md`, `2026-10-03.md`, `2026-10-01.md`, `2026-09-30.md`, `2026-09-28.md`.
Deep history: `git log`, `notes/2026-09-*.md`, `docs/growth/`, `docs/seo/`, `~/.claude/plans/`.

## Ask chat parity + search cleanup — 2026-10-18 (committed locally, NOT pushed)
- `97f55bfe0`: search dropdown has no statement badges, drops futures/FX (`=`/`^` symbols); a whole-word company
  name narrows results to that company (`focusOnNamedCompany`); statements label column 248px so "Cash flow from
  operations" sits on one line at desktop (phone 180px column still wraps — left alone).
- Next commit: **Regenerate in place with versions** (‹ n / m ›; earlier answers kept on the message as `versions`,
  capped `ASK_ANSWER_VERSIONS_KEEP = 4` for Atlas), **Branch in new chat** (`POST /api/ask/threads/:id/branch
  {through}`), **Custom instructions** (`User.askInstructions` ≤1500, `GET/PUT /api/ask/instructions`, a system
  message after the rules in `askFresh`, report cache skipped when set). Stamp `20261018-ui23`. Verified end to end on
  localhost with real model calls. Tests: `test/ask-chat-parity.test.js`.
- Not built (bigger): Projects (chat folders with shared files/instructions), Canvas/Artifacts side editor.
- Known, pre-existing: new accounts' "Getting started" card covers the composer/answer foot on phones.

## Statements filled from SEC for every US stock — 2026-10-17 (local, NOT committed, NOT pushed)

Owner: every US stock's income, balance and cash-flow statement filled, dropdown rows included, and the search
dropdown should say how complete they are. Then: "refill the data first and then refix the saturday test to make
sure u only update the relevant info and not all of it". Plan: `~/.claude/plans/golden-chasing-waffle.md`.
Audit (before): `docs/statement-audit/summary.md` — 0 of 4,191 regular US reporters had every applicable row; the
page hides all-null rows (`company.js` around :1708), which is why Apple looked full.
- **Source is SEC filings only** (companyfacts XBRL, the original filing as backup). Nothing estimated.
- **`sec-facts.js`**: `EXTRACTION_VERSION` `20261017-rows1` for the main run; `20261017-eps1`/`eps2` for the 1,565
  issuers filing `EarningsPerShareBasicAndDiluted` and the 20 filing the partnership
  `NetIncomeLossPerOutstandingLimitedPartnershipAndGeneralPartnershipUnitBasicAndDiluted` (CQP from 2022). Both sit
  in `LAST_RESORT` (fill-only, tried after every original tag in BOTH taxonomies) and a per-share quarter never
  follows its year onto them (`resolve`, the yearLines reorder): Comstock's later filings restate Q3 2015 EPS for a
  1-for-5 reverse split (-59.05 vs -11.81 as filed) and the page split-adjusts again; Entera/Gravity have IFRS
  diluted EPS that must win. Result vs the pre-change files: 35,927 + 171 EPS cells added, each equal to the SEC
  fact it cites, 0 lost, 0 changed apart from Atlantic American's new 10-K (filed 2026-10-16).
- **After ANY local re-extraction, rebuild `build-public-stock-index.js` then `build-screen-index.js` (6 min
  each).** The server loads a file only when its digest matches the index (`company-evidence.js:17`); without the
  rebuild 1,300 re-extracted stocks rendered "No data filed for this view". **Page stamps must not share a prefix
  with `EXTRACTION_VERSION`**: a stamp sed for `20261017-rows11` once rewrote the extraction version too. Page
  stamps now use `-uiNN`. 41 tags added (`ROWS_ADDED`, fill-only: they never
  create a year or quarter). New fields: D&A and other non-operating income (income); accounts payable, other
  current assets, cash & short-term investments, short-term investments, non-current liabilities, common stock,
  treasury stock (balance); cash-flow net income, working-capital changes, debt issued / repaid, short-term
  borrowing, stock issued, net change in cash (cash). `BORROWED`: a cash or income row made only of lines borrowed
  from another statement is not published (a cash row of net income alone would invent a period).
- **Working-capital changes are stored as filed** (positive = the balance grew; checked against balance-sheet
  deltas for AAPL, MSFT, CAT, NKE). The page reverses receivables, inventory and other operating assets to show
  the cash effect (`cashEffect` in `company.js`).
- **Page (`company.js`, stamp `?v=20261017-ui12` on every page; pinned in `company-statements`, `ask-recovery`,
  `free-tools`, `seo-research`, `profile-consolidation`, `ask-threads`, `portfolio-arrival` tests)**: income order
  Revenue → Cost of revenue → Gross profit; revenue = cost of revenue + gross profit when only those two are filed
  (VIV); P/E chart marks loss years and >100× as NM; SPAC units/rights hide the statement controls. EBIT = operating income; EBITDA = operating income + filed D&A; income
  shares row is weighted-average shares; cash net income reads `cashFlowNetIncome`; SBC moved under operations;
  debt shown as issued / repaid / short-term net (no more summing two different lines); dividends fall back to
  common-only dividends; cash & short-term investments falls back to cash alone.
- **Sample (20 issuers):** 0 changed and 0 lost values, 190/190 new values equal SEC companyfacts, size +26%.
- **Full re-extraction:** `scripts/reextract-local.js` (facts from SEC's nightly bulk zip via
  `companyfacts-bulk.documentForCik`, filing index and original documents live at ≤8 req/s). Needs a bulk zip
  under 36 h old in `SEC_BULK_DIR`. Resumable: skips issuers already at the version.
- **A core re-extraction drops each file's industry data** (`segmentObservations`, `operatingExpenseLines`,
  `industryObservations`, `industryExtraction`; AAPL had 9 segment groups). The weekly restores it in its next
  stage, so after a local re-extraction **run `node scripts/refresh-sec-industry.js` too** before building.
- **Weekly made incremental (owner ask):** `refresh-sec-coverage.js --weekly` no longer forces every issuer. An
  issuer is re-read only for a new or amended filing, an extractor/validator version change, a file that no
  longer matches its digest, a failed last attempt, or an original document SEC did not return. The industry
  stage reads a 10-K once per filing and VERSION (it used to re-download every issuer's 10-K every Saturday and
  rewrite every file for a timestamp). Guards: two tests at the end of `sec-release-regressions.test.js`.
- **Saturday conflict:** the GitHub weekly (Sat 22:30 UTC) runs whatever is on `main`. If this work is not pushed
  first, it rewrites all ~5,700 files with the old code and this data must be re-extracted on top of it.
- **Done 10/17:** industry stage (64 MB limit: `SEC_ORIGINAL_MAX_MB=64`, as in the workflow), the weekly build chain,
  re-audit (Tier 1 rows filled 44.1% -> 59.9%, before/after in `docs/statement-audit/summary.md`), 10 page
  checks (screenshots + cells against SEC), search badge (`statement-completeness.js`), Ask gaps, predeploy.
  The 10 MB `by-stock.csv` stays out of git. `stash@{0}` holds the old ai-data-gaps flag (superseded; drop it).
- **Total debt from the presented balance sheet:** `build-statement-lines.js` stores each 10-K/10-Q balance sheet's
  debt lines from FSDS `pre.txt` (`k:'debt'`); `sec-facts.presentedDebt` sets `shortLongTermDebtTotal` =
  their sum (`sum_presented_lines`, re-checked in `sec-coverage.verifiedField`) when every presented line is held
  from that filing and no held debt figure sits off the face (Amazon). It also fixes the old `shortTermDebt`
  double count (one line filed under two tags: AMD 874+874). Applied in place by `scripts/apply-presented-debt.js`
  (1,400 issuers) because a re-extraction drops industry data; a refresh that re-extracts applies it in `extract`.
- **Reconciliation cycle:** `validate-stock-coverage.js --bootstrap` requires every in-scope issuer's
  `lastReconciledCycle` to equal `asOf`. `reextract-local.js` now stamps it on live runs (not
  `--offline-reporting`), like `refresh-sec-coverage.js:110`. The 10/16–17 live run predated that, so its 5,517
  issuers were stamped afterwards (each had a live filing-index check dated 10-16 or 10-17).
- **Ask:** `get_financials` lists blank added fields once (`unavailableFields`), keeps compact mode to the old
  fields, and the supplemental-only answer (FDIC banks such as OZK) respects `limit`/`before` (was 44 KB).
  Ask gaps before -> after: debt-to-equity 4,534 -> 3,781 stocks blank, interest expense 4,368 -> 2,559.
- **Non-USD issuers shown in USD (10/17, owner ask):** the page requests `?presentationCurrency=USD` again (8d8e0a56f
  had dropped it). FX fixes: Yahoo FX bars are dated in London time (`exchangeDay`, yahoo-source.js); month rates
  are month-end DAILY closes with a ±5-day median filter (`monthEndSeries`), because Yahoo's monthly bars had strays
  (KRW 9.07 for Feb 2015 put SKM 2015 at $25T). `sec-fx.json` regenerated. SKHY (no 20-F yet) Yahoo observations
  convert too. **IAS 29:** ARS (from 2018-07) and TRY (from 2022-06) cells convert at the closing rate of the month
  their filing measures in (20-F: last FYE before filing date; 6-K: its latest period if furnished ≤6 months
  after, else null) — the period average had GGAL 2023 at $35B, now $6.6B. `HYPERINFLATION` in sec-presentation.js.
  Verified: TEO FY25 P$8,328,814M and TKC FY25 TRY 241,471M match their releases. Indexes rebuilt after it.

## Unpushed local work from earlier sessions (details in the 10/17 snapshot)
- Branches `ask-conditions-20261011`, `ask-comparison-fallback-20261011`, and the Ask/AI-Portfolio split, Ask
  customer-question fixes, account actions, AI Portfolio accounting and controls — all committed locally, NOT pushed.
- Owner still to add `FRED_API_KEY` and `BLS_API_KEY` to Render (values in `~/.config/stockportfolio/`).
- `frontend/data/index-members.json` (Nasdaq 100, S&P 100) has no refresh job; redo it at reconstitution.
- AppSumo listing itself is still live and selling; ending it is the owner's step with AppSumo.

## Session start
- `bash scripts/dev-doctor.sh` once. On the Mac, local mongo is `brew services start mongodb-community`; this
  Ubuntu checkout has no `mongod` (run the server with a dead `MONGODB_URI` for page checks). Harnesses use
  `mongodb://127.0.0.1:27017/<scratch>`.
- **Verify every deploy from outside** (`gh run list` + a live fetch) — the workflow's own conclusion lied
  once. `set-render-env.yml` alone never deploys. A push to `main` ships to prod.
- **The MCP endpoint has a live checker: `cd backend && npm run test:mcp`** (`scripts/test-mcp.mjs`), and the
  browser path `node scripts/mcp-browser-test.mjs` (each run registers a real DCR client in the **production**
  database — don't loop it). Key from `~/.config/stockportfolio/api-key`, fingerprinted, never printed.
- **Parallel sessions share this working tree.** A push range starting at a SHA you do not recognise means
  someone committed between your `git add` and your push — check `git log`/`git status` before staging broadly.
- Full suite needs `frontend/data` (5.8 GB); a slim checkout fails 35 tests without it. 7 tests already fail on
  `main` (`scripts/predeploy-known-failures.json`).

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

## In flight
- **OpenAI ChatGPT plugin directory — owner reports APPROVED AND PUBLIC (10/07), not independently verified.**
  Surface `POST /mcp/apps` (7 read-only tools). `scripts/verify-mcp-apps.js --review-cases` = 23/23 against
  production; re-run after every deploy. `/mcp/apps` takes `company`; `/mcp` takes `ticker`. Only one review may
  be active; never press *Cancel review*. Reviewer-credential fields were never re-checked. The ZIP
  (`scripts/build-openai-plugin.sh`) is the source of truth; a re-recorded walkthrough needs a new filename.
  No ID token is issued (deliberate). CIMD is not supported.
- **Claude / Anthropic directory:** plugin bundle `Publish requested` (do not press `Cancel review`); MCP connector
  `Published` 10/07, slug `stockportfolio`. Reviewer account `openai-review@stockportfolio.pro` is a `UserSchema`
  path (`reviewAccount`) — Mongoose strips undeclared paths, so the schema half fails invisibly.
- **Connector sign-in** (`oauth-mcp.js`) issues a client secret only when asked or for Perplexity / Teams
  redirect hosts. **Re-test a fresh Claude and ChatGPT connect after each deploy that touches it.**
- **AppSumo v8 repricing** — superseded by retiring AppSumo sales; values in `docs/growth/appsumo-listing-v8.md`.
- **Filing Watch $49/month pilot** — deployed flag-on, $0 collected, zero offers sent. Never send outreach
  without the owner's explicit authorization. Runbook `docs/growth/filing-watch-runbook.md`.
- **Dossier redesign "The Plain Filing"** — mockup awaiting review; the port has not started
  (`node scripts/build-dossier-mockup-artifact.js`, never hand-edit).
- **Emotional design** phases 6-7 not started. Standing rules: the error overlay's "Nothing was changed" is an
  explicit `unchanged: true` opt-in; X-Ray exposure is summed in dollars; an empty alert list renders a quiet card.
- **Voice input is parked and ships off** (`STT_API_KEY` / `VOICE_LOCAL_MODEL=true`).

## Walls (live in prod)
- Geo wall `GEO_WALL_COUNTRIES` (`SG,CN,HK`); hosting/VPN wall `HOSTING_WALL_ENABLED` (ON) from
  `backend/data/hosting-ranges.bin`. Hard paywall `WALL_ALL_PAGES` off; `/docs` is the only product surface
  readable signed out.
- **Load-bearing:** the visitor IP comes from `marketingAttribution.requestIp()` (CF-Connecting-IP), **never
  `req.ip`**; the crawler exemption is required (Googlebot/Bingbot crawl from hosting ranges).
- **The MCP transport is the one surface the walls do not decide**; entitlement resolves at `tools/call` as tool
  errors.
- **Unclosed:** ~25 keyless `/api/*` endpoints serve product data with no auth and no country check.

## SEO / discovery — measured; do not re-derive
- **The bottleneck is indexing and site-level trust**: Google ~340 human impressions/month, ~0 clicks, median
  position ~52 across ~21,700 URLs, while Bing ranks the same site well (7.7% CTR, pos 6.1).
- **87% of raw "impressions" are rank tools.** Parse GSC/Bing CSVs RFC4180.
- Crawled-but-not-indexed = "insufficient value or user demand"; external links are the unattempted lever. Never
  `noindex` an unwanted URL — use robots.txt, a one-way door, or emit fewer URLs.
- The URL Inspection API reports the last crawl, never a live fetch. There is no Gemini crawler.
- Bing URL submission is 100/day and counts 301s; IndexNow is the free channel. Site Scan is UI-only.
- Operator Python needs `.venv/bin/python3` on the Mac.

## Prices, freshness, dead tickers
- `backend/quote-store.js` is the one place pages ask for a price. Freshness = the data's own dates, never mtime
  (`fundamentals-date.js`, `STALE_DAYS=45`). A fundamentals commit must deploy.
- Dead-ticker rule: two separate days of Yahoo "Quote not found" mark a ticker unlisted; a success clears it.
- Price history: `backend/price-history.js` + weekly `refresh-price-history.yml`.

## AI model + cost
- Every purpose resolves to `glm-5.3` (`ai-client.js:20`), which needs `reasoning_effort: 'low'`
  (`ai-client.js:82`). Cost baseline $28.91/mo ≈ 48% of the $60 allowance on glm-5.1 — re-measure.
- glm-5.3-flash on MCP/API Ask was validated and rejected (60% against an 80% tool-set bar, 1.55x slower).
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
  (`scripts/screenshot-cdp.js`). A CSP failure that exists only in production is invisible to a same-origin
  harness; read `Log.entryAdded` + `Network.loadingFailed` first.
- `access_token()` in the GSC script returns a tuple.
- A test can encode a coincidence; a source-pinning test should slice to the next function, not a char count.
- **The deploy-skip marker matches anywhere in a commit message.** `frontend/data/fundamentals/**` and
  `frontend/data/sec-financials/**` must never carry it.
- Live verification budget: 100 non-asset requests per 5 min per IP (`bot-blocker.js:158`).
- `ask.html` has `<body>` inside a CSS comment; mark the real tag with `/^<body>$/m`.
- Filed EPS is not restated across splits (Nvidia 3.85 then 0.17); use profit growth.
- **Re-extracting statements removes industry data until `refresh-sec-industry.js` runs** (see the 10/17 entry).

## Owner actions pending
1. **Push decision for the statements work** (10/17 entry) before Saturday 22:30 UTC, or accept a re-extraction
   after that weekly lands.
2. **OpenAI plugin submission** — watch for the verdict; do not press **Cancel review**.
3. **Dossier mockup review** — the port has not started.
4. **URL Inspection → Request Indexing** on the highest-value pages; re-run Bing **Site Scan** and investigate the
   duplicate-title/description/noindex/title-too-long cards.
5. **`avisre/prod` visibility** — it names the AI provider while public. Render must be able to read the repo.
6. **Rotate the secrets exposed in local transcripts** (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, JWT_SECRET,
   SMTP_PASS, GOOGLE_CLIENT_SECRET, the provider key) at source AND on Render back-to-back per key; revoke the old
   GitHub PAT and npm token pasted 9/14.
7. **List-Unsubscribe + DMARC `rua`** before the next bulk send.
8. **`FRED_API_KEY` and `BLS_API_KEY` on Render.**
9. **Monthly provider bill** — the one input that states AI margin in dollars.
10. Orphan IndexNow key `1668f45a03ea53cf94c51b61c43163d4.txt`; `mcp-server` README lists retired `sp_*` names;
    `scripts/verify-receipts-panel.js` and `scripts/verify-send-receipt.js` are untracked.
