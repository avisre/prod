# Handoff

Durable working memory — **keep under 160 lines** (CLAUDE.md). State and open actions only,
never a transcript. Deep history: `git log`, `notes/2026-09-*.md`, `docs/growth/`,
`~/.claude/plans/`.

## Session start
- Local mongo: `brew services start mongodb-community`; harnesses use
  `mongodb://127.0.0.1:27017/<scratch>`.
- **Verify every deploy from outside** (`gh run list` + a live fetch) — the workflow's own conclusion
  lied once. `deploy-render.yml` 404'd on push through 9/24 (Render's GitHub app lost the repo) and
  works again; `set-render-env.yml` alone never deploys. A push to `main` ships to prod.

## Hard constraints — do not violate
- **The AI provider is a trade secret.** `ai-client.js`'s `leaksIdentity()` is a backstop, not a
  licence; never name the model to users, in copy, or in an error message.
- **Never store or inline keys.** `~/.config/stockportfolio/api-key` (`sp_live_`),
  `~/.local/share/secrets/bing_webmaster.txt`, `.../gsc_service_account.json`.
- **Never `dotenv.config()` `backend/.env`** — it carries the PRODUCTION Atlas URI, so a script
  taking an API key from it inherits the live database (9/7, and again 9/22 when live keypoints
  rows were deleted). Use `scripts/lib/dev-env.js` (`loadAiEnvOnly` + `assertLocalMongo`, `--db`).
- Customer email only from support@ via `/admin/messages`, owner-approved; **never cold email
  from support@**.
- No anti-bot workarounds, and **no interactive auth through Bash** (`gh auth login` needs a TTY
  and always times out — hand the owner the command). No `sleep N`. `rin@gmail.com` is the owner's
  test account — exclude from every customer/funnel count.

## In flight
**Emotional design** — plan `~/.claude/plans/warm-orbiting-sketch.md` (approved). Thesis: confetti
imports a *trade* emotion; this product's emotions are comprehension, vindication and time, and its
vocabulary is ink, not glitter.
- **Phase 0 SHIPPED (9/24)** — portfolio-action voice in `dashboard.js`: the error overlay LEADS with
  `'Nothing was changed — your portfolio is exactly as you left it.'` That reassurance is an explicit
  opt-in `unchanged: true`, **not** derived from `error`, because the multi-ticker path reports a
  PARTIAL success as an error ("3 of 5 added") — a blanket "nothing changed" there would be a lie.
- **Phase 1 SHIPPED (9/25)** — motion vocabulary + the arrival card. `V2.settle`/`V2.arrive`/
  `V2.heldLabel`/`V2.motionOff` on the existing `window.V2` (`app.js:2246-2308`), not a new asset file.
  `arrivalPayload()` supplies **real** counts wrapped in `.catch(() => null)` so a payload failure can
  never fail the save; an absent field is absent, never estimated. The multi-ticker path carries **no**
  arrival card (a partial success cannot claim the portfolio went live). Settle writes the true value
  FIRST and animates away from zero, so reduce-motion/stale bundle/killed tab all leave the honest
  number on screen.
- **Phase 2 PART SHIPPED (9/25)** — "Since you bought" (`renderSinceBought`, `#since-section`):
  purchase dates reflected back. Durations come ONLY from the stored `purchaseDate`, never a saved-at
  stamp, and an undated holding gets **no** row — it is counted and disclosed ("1 of 3 came without a
  purchase date"). Still to do: thesis letter, anniversaries.
- **Phase 4 SHIPPED (9/25)** — the red pen on `verify.html` (`.vf-pen`): told figure struck through,
  filed figure stamped in beside it.
- **REAL DEFECT FOUND AND FIXED (9/25)** — the headline-vs-filing `money()` formatter chose its decimal
  from the RAW amount (`abs >= 100`), so that branch was dead code and every figure printed whole-unit:
  `$15.5B` → `"$16 billion"`. Three copies (`verify.html`, `backend/app.js`, `backend/seo-pages.js`)
  fixed to `Math.abs(v) >= 1000` + a trillion tier, pinned by `test/money-formatter.test.js`. Found by
  the browser harness, not by reading.
- **Phase 3 SHIPPED (9/25)** — the X-Ray reveal. `backend/look-through.js` `buildReveal()` expands each
  fund's real SEC N-PORT Part C holdings (`fund-holdings.fetchFundHoldings`; `xray.computeXray` does
  NOT) and returns `payload.reveal` from `/api/portfolio/xray` under a 9s `Promise.race` — a slow or
  failed SEC read degrades to `null` and gets a 4-minute cache TTL, not the hour (the N-PORT fetch
  keeps running and warms the 7-day fund cache). **Exposure is summed in DOLLARS**: fund weights are
  fractions of that fund's own net assets, so percentages of different bases cannot be added. Measured
  live 9/25: 3 tickers → **3,514 companies**, largest NVIDIA 6.8% inside VOO+VTSAX (`direct: false`),
  0.5% non-equity. Bonds/derivatives/blank categories are excluded and `otherPct` disclosed; an
  unreadable fund is named in `notExpanded` with its weight and `coveredPct` drops, so a partial
  expansion announces itself (`largestIsUntyped` is `!top[0].direct`). `test/look-through.test.js`.
- **Phase 5 SHIPPED (9/25)** — quiet alarms. `watchdog.quietFacts()` returns only measured facts: the
  watched count under the SAME `assetType: {$nin:[etf,mutual_fund,crypto]}` rule `scan()` uses (pinned
  by comparing both literals), `WATCH_FORMS`, and the **OLDEST** `filingsCheckedAt` — the weakest claim
  the whole set supports (`checkedThrough` is the newest). An EMPTY alert list now renders the quiet
  card instead of hiding the section: a working monitor and a broken feed used to look identical.
  `test/quiet-alerts.test.js`.
- **Phases 6-7 NOT started** (year in filings, comprehension streak); thesis letter and anniversaries
  also untouched. **Dossier redesign stays untouched** — the owner said leave the mockup alone.

**Dossier redesign — "The Plain Filing" — mockup done, awaiting review.**
Plan `~/.claude/plans/valiant-singing-parnas.md`. `docs/design/dossier-plain-filing.html` is a
document, not a dashboard (Newsreader / IBM Plex, not Inter). **Step 2 — the port into the real page
— has NOT started**, and its visual half is superseded, so its CSS must be re-derived. Regenerate
`dossier-plain-filing.artifact.html` with `node scripts/build-dossier-mockup-artifact.js`; never
hand-edit it. Artifact publishing is refused here (this session uses `ANTHROPIC_AUTH_TOKEN`). Shoot
with `scripts/screenshot-cdp.js` — `chrome --screenshot --window-size` lays out at macOS's ~500px
floor and silently crops wrong mobile images.

## Walls (live in prod)
- Geo wall `GEO_WALL_COUNTRIES` (default `SG,CN,HK`); hosting/VPN wall `HOSTING_WALL_ENABLED`
  (default ON) from `backend/data/hosting-ranges.bin` (refresh ~monthly:
  `node scripts/refresh-hosting-ranges.js`). Hard paywall `WALL_ALL_PAGES` — off since the wall week
  (3 signups / 9 days, 0 paid); **`/docs` is the only product surface readable signed out**.
  Kill switches, each followed by a deploy: `GEO_WALL_COUNTRIES=` · `HOSTING_WALL_ENABLED=false` ·
  `WALL_ALL_PAGES=false`.
- **Load-bearing, both walls:** the visitor IP comes from `marketingAttribution.requestIp()`
  (CF-Connecting-IP in prod), **never `req.ip` — that is an intermediate proxy hop in prod**. The
  crawler exemption is not optional either: Googlebot/Bingbot crawl from cloud ranges that ARE in the
  hosting table, so without it the wall 302s them and deindexes the site (exempt only a positive
  `bot-blocker.classifyUa` claim of `allowed-claim`/`internal`). The paywall now exempts that claim
  (deployed 9/24), so re-arming can no longer take the index down; verified on dev-local —
  Googlebot/Bingbot 200, Chrome **and GPTBot** 302.
- **Unclosed on both walls:** ~25 keyless `/api/*` endpoints serve product data with no auth and no
  country check, because `/api` is exempt from the page wall.

## SEO / discovery — measured; do not re-derive
- **The bottleneck is indexing and site-level trust, not content, targeting or segment.** Titles, H1s
  and descriptions already match the queries and the sitemap/canonicals are clean, yet Google gives
  ~340 human impressions/month, ~0 clicks and median position ~52 across ~21,700 URLs, while Bing ranks
  the same site well (7.7% CTR, position 6.1) and Google shows it for exactly one of Bing's top-10.
- **87% of raw "impressions" are rank tools, not people** (filter `site:`/`inurl:`, quoted phrases,
  `- wab`); `seo-data/search-opportunities.md`'s P1 rows are phantoms — do not act on them. Parse GSC
  and Bing CSVs RFC4180; a naive `split(',')` silently yields NaN.
- **Google names the reason itself:** crawled-but-not-indexed means "insufficient value **or user
  demand**". Demand follows links, so **external links/citations are the unmeasured, unattempted
  lever** (internal linking is done). Never `noindex` an unwanted URL — Google fetches and discards it,
  wasting crawl; use robots.txt, a one-way door, or emit fewer URLs.
- **The URL Inspection API reports the LAST CRAWL, never a live fetch** — only a re-crawl moves it.
- **The real Google issue was the 9/15 hard paywall** (`f4af1ee5` 302'd every page): indexed 16,574 →
  9,940 in two step changes, and re-indexing waits on crawl schedule. Fixed 9/24: `/ask?q=…` serves
  `noindex, follow` (3,012 near-duplicate titles); `/register` canonical; `/tour`'s missing
  `uploadDate` (a Video rich result failing while the page read PASS — index status alone is not a
  health check); `bot-blocker.js` read `req.ip` (a real deindexing bug).
- **Gemini cannot be targeted as a crawler — none exists.** AI Overviews ground on Googlebot (already
  allowed) and `Google-Extended` never arrives as a UA, so this lever IS the indexing lever.
## AI model + cost
- **Prod runs glm-5.1 on all three purposes**, at a measured **$28.91/mo ≈ 48% of the $60 allowance**
  (`scripts/ollama-cost-projection.js`). The real input/output split is 95/5 chat and 90/10 summary,
  not the 85/15 `credits.js` assumed, so the anchored fair price is ~3.3 credits and `mcp_ask: 4` sits
  slightly ABOVE the owner's own 2x rule. Left as is.
- **glm-5.3-flash on MCP/API Ask: validated and REJECTED** — fails the tool-set gate (60% against an
  80% bar) and is *slower* with the 32 schemas attached (1.55x), emitting 1.65x the tool calls.
- **Trap:** `promptTokens`/`completionTokens` are *missing* (not null) before 9/11, so
  `$ne: [field, null]` does not exclude them. Use `$isNumber` and apportion each group's FULL
  `totalTokens`. Coverage is still only ~295 of 2,349 calls.

## Traps that have already cost real time
- `users.updatedAt` reads "3d ago" for every account uniformly — a bulk-write artifact. **Measure
  activity from `ollama_usage_events`, never `updatedAt`.**
- **A broadcast's recipient list is not a customer list.** The 9/23 "general" send's 47 non-owner
  recipients had **0 live userIds** (24 were QA artifacts); only 13 of 60 were customers.
- **~95% of first-party "unique visitors" are a botnet hitting `/register.html`**, which the bot
  classifier misses. Check distinct user agents before quoting any visitor count.
- Chrome headless sends "HeadlessChrome", which `bot-blocker.js` correctly 403s — override the UA
  (or `BOT_BLOCK_ENABLED=false` on dev-local only).
- `access_token()` in the GSC script returns a **tuple** `(token, client_email)`; treating it as a
  string yields a 401.
- zsh does not word-split unquoted variables: bulk `sed` needs `… | xargs sed -i '' …`, or every
  filename arrives as one argument. `test/social-compose.test.js` **always fails** (requires
  `selenium-webdriver`, not installed) — pre-existing, never a regression; browser checks go through
  CDP (`scripts/screenshot-cdp.js`).

## Owner actions pending
1. **Dossier mockup review** — step 2, the port, has not started.
2. **URL Inspection → Request Indexing** on the highest-value pages, watching `Indexed` recover —
   `Page with redirect` (604) + `Server error (5xx)` (2) need the UI drill-down; the API has neither.
3. **`avisre/prod` visibility** — it names the AI provider while public.
4. **Rotate the secrets exposed in local transcripts** (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET,
   JWT_SECRET, SMTP_PASS, GOOGLE_CLIENT_SECRET, the provider key) at source AND on Render
   back-to-back per key, or checkout and webhooks break mid-rotation. Also revoke the old GitHub PAT
   and the npm token pasted into chat on 9/14.
5. **List-Unsubscribe + DMARC `rua`** before the next bulk send.
6. **Reopen-10-accounts script** (`scratchpad/.../reopen/run.js`, 7-day comp trial + email) was
   blocked by the permission classifier — needs approval.
7. **`scripts/verify-receipts-panel.js` and `scripts/verify-send-receipt.js` are untracked.**
8. **AppSumo listing** is portal-only (the Licensing API serves licences, not the listing): paste +
   William's approval. The unredeemed buyers are unreachable — AppSumo holds their email, not us.
9. **Monthly provider bill** — the one input that states AI margin in dollars.
