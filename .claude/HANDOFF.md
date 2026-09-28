# Handoff

Durable working memory — **keep under 500 lines** (CLAUDE.md). Current state and open actions only,
never a transcript. At ~400 lines, snapshot this file to `.claude/handoff-archive/<date>.md` and rewrite
it fresh; **delete superseded items to the snapshot rather than compressing them here**.
Earlier snapshots: `handoff-archive/2026-09-28.md`. Deep history: `git log`, `notes/2026-09-*.md`,
`docs/growth/`, `~/.claude/plans/`.

## Session start
- `bash scripts/dev-doctor.sh` once. Local mongo: `brew services start mongodb-community`; harnesses use
  `mongodb://127.0.0.1:27017/<scratch>`.
- **Verify every deploy from outside** (`gh run list` + a live fetch) — the workflow's own conclusion lied
  once. `deploy-render.yml` 404'd on push through 9/24 (Render lost the repo) and works again;
  `set-render-env.yml` alone never deploys. A push to `main` ships to prod.

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

**Prices split from fundamentals + truthful freshness — code DONE 9/28, NOT COMMITTED; 1,500-company backfill running.**
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
  CONCURRENCY=6). Backfill of all 1,500 started locally 9/28 — it reaches prod only via commit + deploy.
- **Audit (10 mid + 10 small vs SEC XBRL, 9/28):** annual revenue/NI/assets matched except definitional
  gaps — banks report gross interest vs the cache's net revenue; VSEC net income 53.5M (continuing ops) vs
  SEC 11.7M. Open data quality: 531 files missing shares outstanding, 1,014 missing market cap, 2,023
  placeholders, 31 funds with negative "revenue". Quarterly staleness (2,949 companies on Q1 2026) is what
  the monthly job fixes.

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

**Bing diagnosis + fixes — code DONE 9/28 in the working tree, NOT YET COMMITTED.** Full write-up:
`docs/seo/bing-diagnosis-2026-09-28.md`. `seo-pages.js` and `seo-extra.js` both require the in-flight
`fundamentals-date.js` / `quote-store.js`, so **this has to land with that work, not before** — committing
the Bing files alone leaves the app requiring an untracked module. Don't re-derive:
- **`<lastmod>` was frozen at 2026-07-19 on 21,272 of 21,780 live URLs (97.7%)** — `isoDataMtime`'s
  `SITEMAP_DEPLOY_MS` clamp fires on every git-checkout deploy. Now reads the committed manifest
  `frontend/data/fundamentals-changed.json`, which the workflow **must** stage (`refresh-fundamentals.yml`);
  clamp deleted, pinned by `test/sitemap-lastmod.test.js`. **Per-symbol dates accrue from the next weekly
  refresh** — until then every data-driven URL carries the manifest-wide date. A git-history backfill was
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
- **Metric-page titles/descriptions rewritten** in `renderMetricPage`: the `…` is gone (3/50 → 0), and
  descriptions over 160 chars went 44/50 → 2/50 with the boilerplate tail cut. Server-rendered, so **no `?v=`
  stamp**. A bounded test, not a promised gain.
- Operator Python needs **`.venv/bin/python3`** — Homebrew Python is PEP 668-managed, so `pip install --user`
  is refused and no `scripts/*.py` could run at all. `scripts/requirements.txt` documents it.

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
- **Suite GREEN as of 9/28 (955 pass, 0 fail, exit 0).** The two long-standing failures are fixed — do not
  re-report them: `ga4-consent-resolution` sliced a fixed 2000 chars and the route had outgrown it (the
  assertion was wrong, not the code); `social-compose` could not load without the optional
  `selenium-webdriver`, now required lazily so its draft-safety tests actually run.
- Cache stamps: `app.js`/`system.css` share ONE `?v=` across every page, but **every other asset carries its
  own** (`company.js`, `news.js`, …). Bump the asset you edited AND its pinned test literal — a stale per-file
  stamp still passes `profile-consolidation` (it checks only the shared pair) and serves old JS for a year.

## Owner actions pending
1. **Submit the plugin** at `platform.claude.com/plugins/submit` — the repo is public and both
   preconditions are deployed and verified; see above.
2. **Dossier mockup review** — step 2, the port, has not started.
3. **URL Inspection → Request Indexing** on the highest-value pages — `Page with redirect` (604) + `Server
   error (5xx)` (2) need the UI drill-down; the API has neither.
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
