# Handoff

Durable working memory — **keep under 500 lines** (CLAUDE.md), enforced by
`backend/test/handoff-size.test.js` and run on every push by `.github/workflows/repo-checks.yml`, so the
cap can no longer be crossed silently. Current state and open actions only, never a transcript. At ~400 lines, snapshot this file to `.claude/handoff-archive/<date>.md` and rewrite
it fresh; **delete superseded items to the snapshot rather than compressing them here**.
Earlier snapshots: `handoff-archive/2026-09-28.md`. Deep history: `git log`, `notes/2026-09-*.md`,
`docs/growth/`, `~/.claude/plans/`.

## Session start
- `bash scripts/dev-doctor.sh` once. Local mongo: `brew services start mongodb-community`; harnesses use
  `mongodb://127.0.0.1:27017/<scratch>`.
- **Verify every deploy from outside** (`gh run list` + a live fetch) — the workflow's own conclusion lied
  once. `deploy-render.yml` 404'd on push through 9/24 (Render lost the repo) and works again;
  `set-render-env.yml` alone never deploys. A push to `main` ships to prod.
- **Parallel sessions share this working tree.** On 9/28 another session pushed `f5be04fd` mid-task and left
  `backend/discovered-compares.json` deleted-but-unstaged. A push range starting at a SHA you do not recognise
  means someone committed between your `git add` and your push — check `git log`/`git status` before staging
  anything broad, because `git add -A` would have committed their deletion.

## Hard constraints — do not violate
- **The AI provider is a trade secret.** `ai-client.js`'s `leaksIdentity()` is a backstop, not a licence;
  never name the model to users, in copy, or in an error message.
- **Never store or inline keys.** `~/.config/stockportfolio/api-key` (`sp_live_`),
  `~/.local/share/secrets/bing_webmaster.txt`, `.../gsc_service_account.json`.
- **Never `dotenv.config()` `backend/.env`** — it carries the PRODUCTION Atlas URI, so a script taking an
  API key from it inherits the live database (9/7, again 9/22 when live keypoints rows were deleted). Use
  `scripts/lib/dev-env.js` (`loadAiEnvOnly` + `assertLocalMongo`, `--db`).
- Customer email only from support@ via `/admin/messages`, owner-approved; **never cold email from
  support@**. No anti-bot workarounds, and **no interactive auth through Bash** (`gh auth login` needs a TTY —
  hand the owner the command). No `sleep N`. `rin@gmail.com` is the owner's test account — exclude from counts.

## In flight

**Filing Watch $49/month pilot — BUILT, VALIDATED, DEPLOYED flag-off (`d642d04a`, deploy run 36525421832 — verified live 9/29).**
First-recurring-customers experiment ($49/mo × 5 = $245/mo capacity; $0 collected, zero offers sent — the
plan's clock starts at actual launch). Ops doc: `docs/growth/filing-watch-runbook.md` (committed with the code).
- **Done:** `backend/filing-watch.js` (5 email-bound seats, hashed one-time invites, no seat recycling once a
  checkout starts), `/filing-watch` + `/filing-watch-sample` + `/filing-watch/start`, register.html plan card
  (email/password only — social sign-in off for this plan), admin invitation/queue/revoke/delivery APIs behind
  the owner token, wall + bot-blocker exemptions for the two public prose pages, `.html` twin 301s, sitemap
  core.xml 119 → 121. `scripts/verify-filing-watch.js` = **29/29** (real app, in-memory Mongo, Stripe mocked);
  full suite **1023/1023**. Live price verified read-only: `price_1UKsebAUeKapY1OP7d68Qp7r` (exactly one
  matching $49/mo price). Fails closed everywhere: no flag → `PILOT_NOT_OPEN`; unverified price →
  `PRICE_UNVERIFIED`; no promo box/trial/discount on filing seats; plan subscription writes are hard-saved.
- **Verified live from outside after the owner pushed** (my push was classifier-blocked twice; the deploy was the
  owner's explicit instruction): run 36525421832 success — `/filing-watch` 200 with the honest flag-off copy
  ("Pilot checkout is not open yet"), `/filing-watch-sample` 200, both `.html` twins 301 to clean routes,
  `/api/filing-watch/status` = `{enabled:false,price:49,capacity:5}`, core.xml **119 → 121** with both new
  routes, `/register` 200. Two 403s during the check were my thin-header curl (the `hasBrowserHeaders` trap);
  re-checked clean with the full header set.
- **Remaining launch gates, in order:** (1) real **Stripe sandbox acceptance** per the runbook (needs a Stripe
  TEST key + webhook forwarding; `scripts/filing-watch-stripe.js --mode test` checks the sandbox price);
  (2) set `STRIPE_PRICE_ID_FILING_WATCH=price_1UKsebAUeKapY1OP7d68Qp7r` then `FILING_WATCH_ENABLED=true` on
  Render (only after acceptance); (3) deployed-checkout external checks. Outreach starts only after all three.
- **Prospects: 1 of 5** — `ncdorc`/ATOS (Stocktwits, Sep 9) is conditional: verify live product retrieval for
  ATOS before contacting, and Stocktwits' self-promotion rules must be met. Five documented rejects in
  `notes/2026-09-29-filing-watch-prospects.md`. `notes/filing-watch-outreach.csv` + `filing-watch-payments.csv`
  are header-only and **must stay untracked — the repo is PUBLIC** and will hold prospect PII (the runbook keeps
  the outreach log private/local on purpose). Never send outreach without the owner's explicit authorization.

**OpenAI plugin (remote MCP) — DEPLOYED + VERIFIED LIVE; only owner-only portal steps left (9/29).**
Implementation on `main` (`febf5892`, follow-ups `576ae002`): the OpenAI surface is `POST /mcp/apps`
(`backend/mcp-apps.js` + `backend/mcp-financials.js`), 7 read-only intent tools over the same
auth/metering/data as `/mcp`, which is untouched. Full package: `OPENAI_PLUGIN_SUBMISSION.md`; design note:
`notes/2026-09-29-openai-plugin-architecture.md`.
- **Live now** (deploy run 36481252026): `scripts/verify-mcp-apps.js` = **17/17 keyed**; official MCP
  Inspector `--strict` against prod = **0 findings**, all 7 tools `ro/dest = true/false`;
  `/privacy`, `/terms`, `/support` now 200 to a non-browser UA; `/mcp` legacy contract unchanged.
- **Annotation-accuracy fix (9/29, `03a2b382`, deploy run 36523702050 — DEPLOYED, verified live):**
  `search_companies` declared `openWorldHint: true` like the other six, and the package justified it with
  an "SEC EDGAR ticker→CIK on a cold cache" fetch that does not exist — `searchCompanies()` is synchronous
  file I/O over the deployed catalog and never touches the network. Under OpenAI's current definition
  ("accesses the public internet or open-ended external entities") that is **false**, and the other six
  (SEC EDGAR / XBRL) stay true. `test/mcp-apps.test.js` pins per-tool values and proves the claim
  behaviourally — a call-counting network stub asserts `search_companies` makes zero `axios.get` calls,
  with a positive control on `get_company_financials` so a dead stub cannot pass it — and
  `verify-mcp-apps.js` asserts the same map against production. **Live re-check after the deploy: 7/7** —
  the same checker that read `ow=true` for `search_companies` before the deploy (negative control, run
  from outside) reads `ow=false` now. Scan Tools and the Inspector run can proceed.
- **Owner-only remaining:** (1) verified identity + **Apps Management: Write** in the OpenAI Platform;
  (2) run `scripts/create-openai-reviewer.js --apply` with the prod Atlas URI for the review account;
  (3) portal: With MCP → `https://www.stockportfolio.pro/mcp/apps` (must be **www**; the apex 307 drops
  `Authorization`) → Scan Tools → set `OPENAI_APPS_CHALLENGE` from the portal and Verify Domain → paste
  demo credentials → submit. Never submit before Scan Tools is clean.
- **The brief Render 404 (`not found: github repo 1105594471`) recovered on its own** — the next push
  deployed. If it recurs: Render dashboard → service → Settings → Build & Deploy → Repository → reconnect,
  then `gh workflow run deploy-render.yml`.
- Commerce rule enforced in code: `/mcp/apps` entitlement/quota errors carry no plan, price, `/upgrade` or
  `/recharge` link (tests pin this). `/mcp` keeps its old upsell copy — it is not under OpenAI review.

**Claude plugin directory — repo PUBLIC and installable NOW; only the submission form is left (9/25).**
`github.com/avisre/stockportfolio-claude-plugin` (public, MIT, 7 files — config and prose, no source). It
carries `.claude-plugin/marketplace.json`, so `claude plugin marketplace add avisre/stockportfolio-claude-plugin`
+ `claude plugin install stockportfolio@stockportfolio` works today. Package:
`docs/growth/claude-plugin-submission.md`; validation + leak gate pass.
- **Chose the free plugin route, not the Connectors Directory** — that portal needs a Team/Enterprise org,
  2 seats × $25 = **$50/month just to unlock the form**. The free form (`platform.claude.com/plugins/submit`)
  lists into the **community** catalog `claude-community`; the official one takes no submissions at all.
- **Owner-only, last step:** the free Console org + the submission. Deferred: the **listing icon** (the form
  takes only a repo link, so it has no consumer — don't fabricate a brand asset). Reviewer path: the **keyless
  tier exercises every tool** (2 asks + 50 lookups/30d), so no credential handover; `sp_fund` proxies
  third-party fund data we don't own — declare it.
- Shipped 9/25 and verified from outside: `tools/list` returns 7 tools, all 7 with `readOnlyHint`;
  `/docs/api-mcp` + `/privacy` serve a non-browser UA while `/docs`, `/terms`, `/privacyx`,
  `/docs/api-mcp/extra` still 403 — the exemption is real but not over-broad.

**AppSumo final-window repricing — v8 copy DONE (11/11 guards pass); the flip partly started, NOT finished.**
Exact values + order: `docs/growth/appsumo-listing-v8.md` (target 149/549 · 299/1099 · 499/1849, wallet
200/500/1000; draft read 9/25 showed 39/144 · 79/288 · 149/432 with credits 50/150/400).
- **Done, verified from outside:** `CREDIT_ALLOWANCE_V3_EFFECTIVE_FROM` stored on Render (36070122159,
  owner-set), deploy followed (36070525625, prod 200). **Unprovable from outside by design** — no wallet field
  is published, so the first redemption after 22:55:55Z is the proof.
- **Three writes were BLOCKED by the auto-mode classifier** — the Render env set, the grandfathered-licence
  importer (`scripts/import-grandfathered-licences.js --apply`; reads `…/secrets/appsumo_licensing.txt` and
  loads `backend/.env` = PRODUCTION Atlas), and the portal draft values. **Hand over, don't retry.**
- **Portal is a browser surface**, driven headfully over CDP (`node /tmp/as-drive.mjs`, Chrome :9222, profile
  `~/.appsumo-portal-profile`). **Never touch `/self-submission/231048/build`** (mapping bug), never press EXIT.
  Partner MCP is a dead end; the Licensing key is read-only.
- **Remaining:** nine price/wallet values, long description, five FAQ slots, API+MCP row wording; then Submit →
  reply in Yena's thread. Push the price half **only once the live page shows $299/$499** — a page selling 200
  credits while production meters 50 is the refund this ordering avoids.

**Prices split from fundamentals + truthful freshness — COMMITTED 9/28 (`e99c645b`, `0ba72c2d`); the backfill's 22 broken stragglers were re-fetched and shipped the same day (`aaf4ea41`, deployed via `gh workflow run` — see the skip-marker trap).**
- `backend/quote-store.js` = the one place pages ask for a price: live Yahoo (60s cache, browser UAs only,
  120/min budget) → `frontend/data/quotes.json` (S&P 1500 daily snapshot, ~212 KB).
  `scripts/refresh-quotes.js` + `refresh-quotes.yml` (Tue–Sat 01:30Z) write it. `/stocks/:sym` bypasses the
  6h SSR cache for humans and serves crawlers the snapshot; `stored-fundamentals.js` prefers the snapshot on
  the Yahoo-down path. Market cap / P/E / 52-week now ride the same quote (`fetchQuoteExtras`), not the blob.
- **Freshness = the data's own dates, never mtime** (`backend/fundamentals-date.js`, `STALE_DAYS=45`) — same
  trap as the sitemap `<lastmod>`. `refresh-fundamentals.js` stamps `fetchedAt`; `fundamentals-fetch.js`
  stamps and exposes `maybeRefresh` (background rebuild on a browser visit, 6h cooldown). User-facing
  surfaces now label everything: quote tiles "as of … · live/last close"; stale filings get
  "Not the latest data — a newer SEC filing may exist" plus their date (stock, metric, price-history,
  compare). All "refreshed nightly" copy removed — the weekly job only ever covered the S&P 500.
- **Monthly full-universe refresh:** `refresh-fundamentals-monthly.yml` (sp1500, 1st 03:00Z, 360 min,
  CONCURRENCY=6). The local backfill left **22 symbols broken** — 16 with a daily series frozen at 2026-06-11, TRX at
  2026-08-13, and CXAI/FFAI/GPUS/HOVR/ONFO with an entirely empty overview/daily/monthly (those pages had no price
  series to show). Re-fetched 2026-09-28T13:54-13:57Z; all 22 now carry a 138-day window ending 9/28, committed
  `aaf4ea41`. The refresh also rebased MUX's pre-2019 EPS, which had never been split-adjusted — every changed row
  moved by exactly 10x, so the shipped numbers are more correct than what was live, not less. **A fundamentals commit
  must deploy** (`frontend/data/fundamentals/` is read from the deployed filesystem).
- **Audit (10 mid + 10 small vs SEC XBRL, 9/28):** annual revenue/NI/assets matched except definitional
  gaps — banks report gross interest vs the cache's net revenue; VSEC net income 53.5M (continuing ops) vs
  SEC 11.7M. Open data quality: 531 files missing shares outstanding, 1,014 missing market cap, 2,023
  placeholders, 31 funds with negative "revenue". Quarterly staleness (2,949 companies on Q1 2026) is what
  the monthly job fixes.
- **Dead-ticker catch (built 9/28):** the refresh now records per-symbol outcomes in
  `frontend/data/fundamentals-status.json` (`backend/fundamentals-status.js`), classifying Yahoo's
  "Quote not found" against transient errors. Two *separate days* of not-found marks a ticker unlisted
  (same-day retries never count); a later success clears it. Effect: excluded from the sitemap, the page
  says "No longer listed under this ticker", `quote-store` stops live lookups for it. The monthly workflow
  also rebuilds `sp1500-companies.json` from Wikipedia first, so index removals drop out naturally.
  Seeded 9/28 with the 15 dead tickers (day 1); the 10/1 run makes it day 2. The weekly workflow writes the
  status file but does not stage it — sp500 coverage therefore lands via the monthly run.

**Dossier redesign — "The Plain Filing" — mockup done, awaiting review.** Plan
`~/.claude/plans/valiant-singing-parnas.md`; `docs/design/dossier-plain-filing.html` (Newsreader / IBM Plex) is
a document, not a dashboard. **Step 2 — the port — has NOT started** and its CSS must be re-derived.
Regenerate with `node scripts/build-dossier-mockup-artifact.js`; never hand-edit it.

**Emotional design** — plan `~/.claude/plans/warm-orbiting-sketch.md` (approved). Thesis: confetti imports a
*trade* emotion; this product's emotions are comprehension, vindication and time, and its vocabulary is ink,
not glitter. **Phases 0-5 SHIPPED 9/24-25** — portfolio-action voice, motion vocabulary on `window.V2`
(`app.js:2246-2308`), "Since you bought", the red pen on `verify.html`, the X-Ray reveal, quiet alarms; each
pinned by its own test file. Phase log: `handoff-archive/2026-09-28.md` + `git log`.
- **Standing rules, still binding:** the error overlay's "Nothing was changed" is an explicit `unchanged: true`
  opt-in (the multi-ticker path reports a PARTIAL success as an error, so a blanket claim would lie); X-Ray
  exposure is summed in **DOLLARS** (percentages of different bases cannot be added); an EMPTY alert list
  renders a quiet card rather than hiding the section (a working monitor and a broken feed looked identical).
- **Phases 6-7 NOT started** (year in filings, comprehension streak); thesis letter and anniversaries untouched.

**MCP/API setup guide — SHIPPED 9/25, deployed**; `/docs/api-mcp` carries 8 per-client blocks, pinned by
`test/mcp-setup-guide.test.js`. Claude and ChatGPT authenticate over **OAuth** — neither can send a static
bearer to a custom connector — so never say "paste a key". **AI portfolio creator — announced 9/25 as
in-development, no date promised, no spec file yet.**

## Walls (live in prod)
- Geo wall `GEO_WALL_COUNTRIES` (`SG,CN,HK`); hosting/VPN wall `HOSTING_WALL_ENABLED` (ON) from
  `backend/data/hosting-ranges.bin`. Hard paywall `WALL_ALL_PAGES` — off since the wall week (3 signups /
  9 days, 0 paid); **`/docs` is the only product surface readable signed out.** Kill switches + deploy:
  `GEO_WALL_COUNTRIES=` · `HOSTING_WALL_ENABLED=false` · `WALL_ALL_PAGES=false`.
- **Load-bearing, both walls:** the visitor IP comes from `marketingAttribution.requestIp()`
  (CF-Connecting-IP in prod), **never `req.ip` — that is an intermediate proxy hop**. The crawler exemption is
  not optional either: Googlebot/Bingbot crawl from cloud ranges that ARE in the hosting table, so without it
  the wall 302s them and deindexes the site (exempt only a positive `bot-blocker.classifyUa` claim of
  `allowed-claim`/`internal`).
- **Unclosed:** ~25 keyless `/api/*` endpoints serve product data with no auth and no country check.

## SEO / discovery — measured; do not re-derive
- **The bottleneck is indexing and site-level trust, not content, targeting or segment** — titles/H1s match
  the queries and canonicals are clean, yet Google gives ~340 human impressions/month, ~0 clicks, median
  position ~52 across ~21,700 URLs, while Bing ranks the same site well (7.7% CTR, pos 6.1).
- **87% of raw "impressions" are rank tools, not people** (filter `site:`/`inurl:`, quoted phrases, `- wab`);
  `seo-data/search-opportunities.md`'s P1 rows are phantoms. Parse GSC/Bing CSVs RFC4180; `split(',')` yields NaN.
- **Google names the reason itself:** crawled-but-not-indexed means "insufficient value **or user demand**".
  Demand follows links, so **external links/citations are the unmeasured, unattempted lever**. Never `noindex`
  an unwanted URL — use robots.txt, a one-way door, or emit fewer URLs.
- **The URL Inspection API reports the LAST CRAWL, never a live fetch.** The 9/15 hard paywall (`f4af1ee5`)
  was the real deindexing cause: 16,574 → 9,940 in two step changes, fixed 9/24.
- **Gemini cannot be targeted as a crawler — none exists.** AI Overviews ground on Googlebot (already allowed)
  and `Google-Extended` never arrives as a UA, so this lever IS the indexing lever.

**Bing diagnosis + fixes — COMMITTED + DEPLOYED 9/28 (`97fc9a16`), verified from outside.** Full write-up:
`docs/seo/bing-diagnosis-2026-09-28.md`. It had to land on top of the prices/fundamentals split, because
`seo-pages.js` and `seo-extra.js` require `fundamentals-date.js` / `quote-store.js`; committing the Bing
files alone would have left the app requiring an untracked module. **Measured live after the deploy:
21,339 URLs across all 7 shards, 0 on the frozen date, all `2026-09-28`** — it shipped 21,272 frozen
(97.7%). The key file answers 200 to a plain curl UA with a 32-byte body. Don't re-derive:
- **`<lastmod>` was frozen at 2026-07-19 on 21,272 of 21,780 live URLs (97.7%)** — `isoDataMtime`'s
  `SITEMAP_DEPLOY_MS` clamp fires on every git-checkout deploy. Now reads the committed manifest
  `frontend/data/fundamentals-changed.json`, which the workflow **must** stage (`refresh-fundamentals.yml`);
  clamp deleted, pinned by `test/sitemap-lastmod.test.js`. **The manifest now holds 1,003 per-symbol
  dates, all `2026-09-28`** — the backfill rewrote every symbol's data that day, so one date is truthful,
  not a collapse. Variation starts with the first *partial* weekly refresh. A git-history backfill was
  evaluated and rejected (965 MB data dir).
- **The report's headline summed a capped top-N list** — `GetPageStats`/`GetQueryStats` return exactly **100
  rows per week bucket**; only `GetRankAndTrafficStats` is exhaustive. Was 4.6x low on impressions, 3.6x high
  on CTR; "Week totals" now equals its own Daily table. Fixes are in `scripts/bing-webmaster-stats.py`
  (`window_totals`, `flag_phantom_queries`).
- **IndexNow's key file 403'd every non-browser UA** while the ping saw 200 and reported success; now exempt
  in `bot-blocker.js` (`test/indexnow-key.test.js`), and `seo-data/indexnow-queue.json` is untracked +
  gitignored so it matches its comment. **Owner-only:** the orphan key `1668f45a03ea53cf94c51b61c43163d4.txt`
  is hosted and referenced nowhere, left in place deliberately — only the owner can confirm its registration.
- **One synthetic query (`aap 2024 free cash flow guided flat strategic costs`) is 42.8% of attributed
  impressions** (1,181 impressions, 0 clicks). Excluding it CTR is **7.55%** not 4.32%, and positions 4-10 are
  **4.67% not 2.46%** — the "titles are failing" premise in `bing-title-review.md` was this same artifact.
- **Metric-page titles/descriptions rewritten** in `renderMetricPage`: the `…` is gone (3/50 → 0). The
  same 50-sample measurement claimed titles were fine — **that was a sampling artifact**; see the sitewide
  sweep below. Server-rendered, so **no `?v=` stamp**.
- Operator Python needs **`.venv/bin/python3`** — Homebrew Python is PEP 668-managed, so `pip install --user`
  is refused and no `scripts/*.py` could run at all. `scripts/requirements.txt` documents it.

**SERP length sweep — COMMITTED + DEPLOYED 9/28 (`1164057f`), verified from outside.** Bing's UI (its API
surfaces never showed this) filed **"Title too long" (High, 6 pages)** against `/`, three `/compare` pairs and
two `/screens` pages; URL Inspection shows the same two errors on `/`. Bing's limit is **70 title / 25-160
description**. Rendering **every** page the site can emit, not a sample:
- `/stocks/:symbol` **1,469 of 1,502** descriptions over (worst 204) · metric pages **1,165 of 12,338** (worst
  193) · `/compare/:pair` **9,863 violations across 5,887 pairs** (title max 156, desc max 290) · `/screens`
  **all 17 titles** (worst 88) · `/vs/` 17 violations across 14 pages · hubs, tools, docs, 9 served pages.
- **One cause:** a fixed boilerplate tail appended to a variable-length name with no budget, in almost every
  SSR head. Aggravated by a legal-suffix stripper in `seo-extra.js`/`app.js` missing the `(?:&|and)?` that
  `seo-pages.js` already had — it shipped **"JPMorgan Chase &"** and **"Becton, Dickinson and"** as live titles
  — and by the long metric noun (`total debt (short- plus long-term borrowings)`) going into the description.
- **Fix:** `clipName` / `fitTwoNames` in `seo-pages.js`, required by the stock, metric, pair and `/company`
  heads; they clip the *name* to the room left **on word boundaries** and full names stay in H1/body. Budgets
  **65 title / 158 description** — inside Bing's 70/160 *and* Google's ~60 truncation. METRICS gained a short
  `metaNoun` (`total debt`) for the description only. Re-measured after: **0 over in every family**.
- **Guard:** `test/serp-meta-length.test.js` (6 tests) derives its worst case from the longest names in
  `sp1500-companies.json` rather than a hardcoded list; `/screens` titles are parsed statically because
  `renderScreenPage` needs the live screen index. Suite 996.
- **Live: 16/16 in budget** — the six Bing-named URLs plus each family's worst case, browser UA. Run as a
  **negative control first** (mid-deploy it failed 7/16 naming the old templates), so the pass is a
  measurement. IndexNow HTTP 200 for the 20 highest-value changed URLs; the other ~19,700 changed URLs ride on
  the sitemap `<lastmod>`. Full write-up: `docs/seo/bing-diagnosis-2026-09-28.md` §6.
- A metric URL that 302s to its stock page (`/stocks/AAOI/total-debt`) means **no data**, not a defect —
  `/stocks/:ticker/:metric` redirects when `renderMetricPage` returns null (`seo-extra.js:2426`).

**`.html` URL twins retired — COMMITTED + DEPLOYED 9/28 (`0a570df9`), verified from outside.** Second round on the same Site Scan
panel: the API-side analysis could not see that the *link graph itself* was feeding the duplicates.
**Measured live after the deploy: 24/24 twins 301 to exactly their clean route, query strings preserved
(`?plan=`, `?symbol=`), the private twins still 200, every 301 target a real 200, `/pricing` 301 and
`core.xml` at 119** — then the 49 changed URLs were pushed to IndexNow (HTTP 200).
- **The defect:** `express.static(..., { extensions: ['html'] })` answered every public page at **both**
  spellings — the extension fallback resolves the file, it does not redirect (`node_modules/send`). 22
  indexable twins, each duplicating a sitemapped URL's title and description verbatim; 3 with no canonical;
  72 internal hrefs pointing at them.
- **The fix:** an exact 301 table (24 entries) registered before the wall and before `express.static`,
  GET-only, query preserved. **Never `/(.+)\.html$/`** — the 17 noindex private twins keep both spellings
  (`/upgrade` + `/recharge` carry `?next=%2Fupgrade.html`; `/profile.html` is the `/inbox` target).
- **Four things an anchor-only sweep misses, all served markup or code:** the homepage JSON-LD
  `SearchAction.target`, a `gurus.html` navigation string, four alert-email URLs (`smart-alerts` ×3,
  `watchdog` ×1), and **the paywall's own target** — `wallRedirect(res, '/register.html')` made every
  anonymous wall hit a two-hop redirect; it now goes straight to `/register`.
  `test/legacy-html-redirects.test.js` guards all four classes (any twin reference in an indexable page; any
  twin URL carrying `?`/`#` in a module) and derives its expected key set from the files, so a new page
  without an entry goes red.
- **Sitemap `core.xml` 114 → 119 live:** `/verify`, `/compare-dossiers`, `/partners`, `/partners-apply`,
  `/lifetime` were linked but in no shard. **`/company` is deliberately excluded** — bare `/company` is a
  JS-only skeleton that nothing links, and `/stocks/:symbol` already covers per-symbol pages. A sitemap row
  is not an inbound link, so `/lifetime` (0 inbound) still needs one.
- **Two live 404s in shipped docs prose fixed:** `docs-pages.js` linked `/markets.html` and
  `/portfolio.html`; they now point at `/news` and `/dashboard`, the pages the shared nav calls Markets and
  Portfolio. The v1 `founding.html` / `demo-dashboard.html` are left alone — `index,follow` but already
  canonicalising to their intended target, and `/fundamentals(.html)` is robots-disallowed.
- **Deferred on purpose:** `/demo` stays a **302** (its target is noindex by design, so "permanent" would be
  wrong and would forfeit the URL if a real demo page replaces it); `frontend-v2/assets/app.js` still names
  34 twins in the sitewide nav/footer — the 301 makes those clicks work, so it is cosmetic, and editing it
  costs the shared `?v=` stamp bump across ~40 pages plus 11 test literals.
- Also unrecorded elsewhere: `backend/tmp-human-7d.js` and `tmp-register-detail.js` filter analytics rows on
  `pagePath === '/register.html'`, which no longer occurs for new traffic (the 301 lands first).
- **CLOSED 9/28 (`fa6bcd7c`, deployed, verified live):** `verify.html`, `partners.html` and
  `partners-apply.html` were the only sitemapped pages with **no `<link rel=canonical>` at all** — a sitemap
  row naming a page that never states its own URL. Each now carries a self-canonical, and
  `legacy-html-redirects.test.js` derives the requirement from the file list, so a new indexable page
  without one goes red. Live re-check after the deploy: **12/12** — three canonicals present on 200, twins
  301 with the query preserved (`/ask.html?x=1` → `/ask?x=1`, `/register.html?plan=monthly` →
  `/register?plan=monthly`), `/pricing` 301, `/login.html` + `/upgrade.html` untouched. The three changed
  URLs went to IndexNow (HTTP 200). Suite 990.
- **Pushing Bing to recrawl — done 9/28, all HTTP 200:** `SubmitFeed` re-fetch of `sitemap.xml`,
  `SubmitUrlBatch` for the 24 clean routes and the 24 twin URLs, IndexNow for the 3 canonicals and the 24
  twins. **The URL submission API is small — `GetUrlSubmissionQuota` said 100/day, 300/month — and it
  counts 301-ing URLs too** (this spent 48: 52/day, 252/month left), so check the quota first and send only
  index-worthy URLs there; **IndexNow is the free channel for moved ones**.
- **Why the Site Scan cards still look unchanged (measured, not assumed):** the panel is a *snapshot of
  the last scan run* and Bing's own crawl data still ends **2026-09-27** — its sitemap read is
  **2026-09-27T20:13:54Z**, 18h before the first fix shipped; `/verify` has never been crawled *or
  discovered*, and the clean route `/ask` was last crawled **2026-08-21**. `GetCrawlIssues` = 0.
  `GetSiteScan`, `SubmitSiteScan`, `RunSiteScan`, `StartSiteScan` all 404 — **Site Scan is UI-only**, so
  re-running it is an owner action, and card-4's noindex list stays forever by design (those pages *do*
  carry noindex; the fix removed the links to them, not the tags).

## AI model + cost
- **Prod runs glm-5.1 on all three purposes**, at a measured **$28.91/mo ≈ 48% of the $60 allowance**
  (`scripts/ollama-cost-projection.js`). Real split is 95/5 chat and 90/10 summary, not 85/15 as `credits.js` assumed.
- **glm-5.3-flash on MCP/API Ask: validated and REJECTED** — fails the tool-set gate (60% against an 80% bar)
  and is *slower* with the 32 schemas attached (1.55x), emitting 1.65x the tool calls.
- **Trap:** `promptTokens`/`completionTokens` are *missing* (not null) before 9/11, so `$ne: [field, null]`
  does not exclude them. Use `$isNumber` and apportion each group's FULL `totalTokens`. Coverage ~295/2,349.

## Traps that have already cost real time
- `users.updatedAt` reads "3d ago" for every account uniformly — a bulk-write artifact. **Measure activity
  from `ollama_usage_events`, never `updatedAt`.**
- **A broadcast's recipient list is not a customer list.** The 9/23 "general" send's 47 non-owner recipients
  had **0 live userIds** (24 were QA artifacts); only 13 of 60 were customers.
- **~95% of first-party "unique visitors" are a botnet hitting `/register.html`**, which the bot classifier
  misses. Check distinct user agents before quoting any visitor count.
- Chrome headless sends "HeadlessChrome", which `bot-blocker.js` correctly 403s — override the UA (or
  `BOT_BLOCK_ENABLED=false` on dev-local only). A bare curl UA also 403s: `hasBrowserHeaders` needs the full
  browser header set. Browser checks go through CDP (`scripts/screenshot-cdp.js`).
- `access_token()` in the GSC script returns a **tuple** `(token, client_email)`; treating it as a string 401s.
- zsh does not word-split unquoted variables: bulk `sed` needs `… | xargs sed -i '' …`.
- **Suite GREEN as of 9/28 (990 pass, 0 fail, exit 0, after the market-cap fixes + the twin-canonical test).** **No CI job runs it** — `repo-checks.yml`
  runs only `handoff-size` (dependency-free by design); 23 files need mongo, 25 touch the network and 8
  need root `node_modules`, so a full-suite gate is a real job, not a config line. The two long-standing failures are fixed — do not
  re-report them: `ga4-consent-resolution` sliced a fixed 2000 chars and the route had outgrown it (the
  assertion was wrong, not the code); `social-compose` could not load without the optional
  `selenium-webdriver`, now required lazily so its draft-safety tests actually run.
- Cache stamps: `app.js`/`system.css` share ONE `?v=` across every page, but **every other asset carries its
  own** (`company.js`, `news.js`, …). Bump the asset you edited AND its pinned test literal — a stale per-file
  stamp still passes `profile-consolidation` (it checks only the shared pair) and serves old JS for a year.
- **A test can encode a coincidence and still look like an invariant.** `sitemap-index.test.js` asserted
  that lastmod must *vary* across the inventory. That held only while `core.xml`'s file mtimes and the data
  manifest's date happened to differ — and is false on the day the refresh runs, which is what the weekly
  pipeline does by design. It went red on 9/28 against a **correct** tree and had to be rebuilt as the real
  invariant: no shard carries the frozen constant, and the inventory carries the manifest's date. Ask what
  a green assertion would do on the day the feature works as intended, not just whether it passes today.
- **The CI-skip marker matches ANYWHERE in a commit message — not just at the start.** A data commit whose body
  said "no skip marker on purpose" to explain why it had to deploy was silently skipped by *both* workflows, leaving
  production on the old data with a green-looking `git push`. Detect it by the absence of a run for the new SHA
  (`gh run list`), not by the push output; the fix is `gh workflow run deploy-render.yml --ref main`, which deploys
  current HEAD without rewriting history. `frontend/data/fundamentals/**` must never carry it (`app.js:3240` reads
  the deployed filesystem) — see CLAUDE.md's corrected rule.
- **Live verification has a request budget: 100 non-asset requests per 5 min per IP** (`navMax()`,
  `bot-blocker.js:158`; the limiter's handler returns the *same* 403 body as a UA deny, so the two are
  indistinguishable from outside). A 119-URL canonical sweep exceeded it and the very next run read
  **403 for all 24 twins** — which reads exactly like a mass regression and was reported as one twice in
  one session before the source was read. Split any sweep over 100 URLs across windows, never run a
  second sweep immediately after a big one, and re-check a 403 before believing it.

## Owner actions pending
1. **Submit the plugin** at `platform.claude.com/plugins/submit` — the repo is public and both
   preconditions are deployed and verified; see above.
2. **Dossier mockup review** — step 2, the port, has not started.
3. **URL Inspection → Request Indexing** on the highest-value pages — `Page with redirect` (604) + `Server
   error (5xx)` (2) need the UI drill-down; the API has neither. Re-run **Site Scan** and click
   **Investigate** on the identical-titles / identical-descriptions / noindex / **Title-too-long** cards: the
   9/28 fixes answer all four, and those URL lists exist only in the Bing UI. For the title/description card,
   the six URLs it named are `1164057f`'s target — re-inspect `/`, `/compare/AMR-vs-SMCI`,
   `/compare/CPT-vs-KREF`, `/compare/HONA-vs-LHX`, `/screens/stocks-below-book-value`,
   `/screens/undervalued-tech-stocks` (all 16 checked URLs are live in budget). Card 5 (inbound links) needs
   links that a sitemap row cannot supply.
4. **`avisre/prod` visibility** — it names the AI provider while public.
5. **Rotate the secrets exposed in local transcripts** (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, JWT_SECRET,
   SMTP_PASS, GOOGLE_CLIENT_SECRET, the provider key) at source AND on Render back-to-back per key, or
   checkout and webhooks break mid-rotation. Also revoke the old GitHub PAT and npm token pasted 9/14.
6. **List-Unsubscribe + DMARC `rua`** before the next bulk send.
7. **Reopen-10-accounts script** (`scratchpad/.../reopen/run.js`) was blocked by the classifier — needs approval.
8. **`scripts/verify-receipts-panel.js` and `scripts/verify-send-receipt.js` are untracked.**
9. **AppSumo listing** is portal-only: paste + approval. The unredeemed buyers are unreachable — AppSumo holds
   their email, not us.
10. **Monthly provider bill** — the one input that states AI margin in dollars.
11. **Orphan IndexNow key** `1668f45a03ea53cf94c51b61c43163d4.txt` — confirm it is registered with an engine,
    or say to delete it.
