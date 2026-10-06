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

## Ask for every kind of company: typing, model-free segments, report cache — 2026-10-06 (fourth, NOT pushed)

Branch `fix/ask-detail-restore-20261006` in this worktree, on top of `68f1bc0e` (lean model view, also unpushed).
Owner asked for a proper answer for every kind of company and for far fewer model calls. Nothing is pushed; push needs owner approval.

**Census (no model calls, 4,649 screenable companies).** 2,248 had no industry label and no sector and were answered with
the catch-all metric set. Annual form: mostly 10-K, 733 20-F, 108 40-F; ~200 report in a currency other than USD; 933 have a
fiscal year that does not end in December. 1,961 had no stored segment facts (`sec-financials/<cik>.json`
`segmentObservations`), 1,466 had a business-segment group, 1,222 only a product/service group.

**What changed**
- `ask-industry-profile.js`: `sicArchetype`/`sicFor`; `profile(industry, sector, sic)`. Industry label still wins, then the
  SEC SIC code, then sector. New types `mining`, `telecom-media`, `services`. Generic bucket 2,248 → 14 (BDCs with no SIC).
- `ask-inline-segments.js` `groups()`: reads segment, product-line and regional revenue straight from the filing's inline
  XBRL — no model. Handles the extra `ConsolidationItemsAxis=OperatingSegmentsMember` dimension (why JPM, PFE, WELL read as
  empty), segments split again by region (CVX), insurer premiums by segment (CB, flagged `measure`), filed subtotals
  (`dropSubtotals` for segments, `prune` for product lines), roll-up members.
- `ask-segments.js`: tagged read runs before the extraction model and is cached (`askseg-inline:v1:*`, memory + Mongo);
  filing fetched as bytes and scanned as latin1 (half the memory); amended-filing revenue no longer blocks the tagged read;
  memory guard is `ASK_SEGMENT_RSS_LIMIT_MB` (default 400, was a hard 320 — at ~315 MiB resting RSS that refused nearly
  every request as "busy"). **Watch memory after deploy**; set the env var lower if the instance is tight.
- `ai-chat.js` `toolGetSegments`: newest stored period, readable member names, product lines added beside segments,
  product lines lead when the segment axis has one member (LLY, MA).
- `ai-chat.js` same-day report cache (`ask_report_cache`, 12 h, memory + Mongo): a plain company report with no history,
  attachments, saved memories or word limit is replayed after the first checked `source: ai` answer. `ASK_REPORT_CACHE=0`
  turns it off. Key = policy version, symbol, story/report, mode, UTC date, leftover question words.
- Removed the last "name specific gaps" instruction from the pre-generation system note.

**Measured.** Tagged read works (no model): WMT, GOOGL, TSLA, TSM, JPM, WELL, CVX, CB, HOOD, PFE, GE, BHP (partial).
Real answers on the online path: `jpmorgan` 70 s and `chevron` 58 s, both `source: ai`, eight parts, 12/12 pulls ok, no
process talk; `JPM` asked again returned from cache in 0 s. Tests: Ask files 228/228; full suite 1,413/1,419 — the five
known baseline failures plus `mcp-apps` "responses carry no timestamps" (a `freshness` key; MCP financials, not this change).

**Still open (data foundation, not Ask code)**
- XOM: no verified annual statements at all (new holding-company CIK) → no ratios, no segments. NVS, SNY: latest annual
  `totalRevenue` is null (IFRS sales concept not mapped). These need the dataset rebuild, not a prompt.
- NEE, BAC, AZN, TD, ASML do not tag segment revenue in a way the tagged read accepts → they fall to the extraction model.
- Foreign filers have no quarterly ratios (they file half-yearly) and mostly no provider valuation; the report omits those rows.
- BHP's tagged read misses iron ore (conflicting values) — shows Copper and Coal only, marked partial.
- Labels are de-camel-cased member names ("Assetand Wealth Management"); only AMD and AVGO have reviewed labels.
- `toyota` asks which listing; expected.

Earlier Ask releases of 10-04 → 10-06 (story recovery, eight-part report, detail restore, lean view) and the data
foundation release gates are in `.claude/handoff-archive/2026-10-06.md`.

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
