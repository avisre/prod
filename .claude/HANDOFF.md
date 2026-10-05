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

## Production state — 2026-10-04
- **The industry-personalized Ask framework is deployed.** Production commit `6898cdb4` went live as Render
  deploy `dep-db181bvavr4c73an2krg` through workflow `37216736433`; the workflow confirmed the deployed
  commit. `/api/health` returned 200 with `{"ok":true}`. Direct requests to `/ask` and the stamped asset
  returned 403 from this environment, so authenticated rendered-page verification is still unavailable.
  Asset stamp: `20261005-navtray1`.
- The earlier rollback `97c61b35` deployed as `dep-db0uvplg1s2s73fplsq0` through workflow `37182036116`.
  Its historical evidence remains in `docs/qa/ask-rollback-2026-10-04/release.json`.
- Earlier the same day, the SEC coverage release `73186a12` deployed and passed independent production
  checks: 6,099 securities, 4,440 ready issuers, 4,498 screenable listings; live stock sitemap matched the
  snapshot exactly; 403s blocked automated stock-profile/alias checks, so authenticated Ask stayed unverified
  there. Evidence: `docs/qa/ask-live-readiness-2026-10-04/`.
- The release restored the Ask modules onto current `main` while keeping the SEC data and dependency files.
  The tested source branch remains `ask-production-ready-20261004` at `ed11f4e7`.

## Ask framework for every stock — deployed

The owner's request: apply the Broadcom-shaped answer framework (framing → segment split → quarterly/annual
tables with a Context column → chart → what makes it different → key risks → valuation snapshot →
**"The read" —** → **`> Next:`** button) to **every** stock, personalised by the company's sector/industry.
Plan: `~/.claude/plans/twinkling-tickling-taco.md`, phases 0–4.

**Shipped:** prose means prose (table rows no longer charged to the word budget); one canonical GICS
vocabulary (`backend/sector.js`) with the Yahoo value kept when the GICS store is empty, so sector coverage
goes ~25% → ~57% and peer positioning/sector medians come back for ~1,968 companies; an industry archetype
profile (`backend/ask-industry-profile.js`) delivered as `get_peer_context.industryProfile` so the metric rows
differ by industry; `get_ratios_history` routed in the research-tools line; `FRAMEWORK_ANALYST` (nine parts)
and a fully rewritten `FRAMEWORK_NORMAL` (ANSWER SHAPE — same evidence and substance, plain English);
faceted bars (`facetBarsBlock`, `app.js:611`) for metrics spanning >10×; chart palette tokens
`--chart-1/2/3`.

**Two deliberate deviations from the plan, both the owner's instruction:**
1. **Caps raised** to 480 analyst / 320 normal (plan said keep 250/350). Measured: the owner's own target
   shape runs 348–432 prose words once tables are excluded, so the old cap made the requested shape
   unshippable.
2. **5% length tolerance** (`ceiling = ceil(limit * 1.05)`). "Cut at least N words" is the instruction the
   model follows least: 331→329 on a "cut 11", and 481 against a 480 cap published a receipt over one word.

**Seven defects found by measurement, not review** (each has a regression test):
1. A prose cap below the owner's own target shape (above).
2. **A range dash read as a minus sign**: `$188.22–$645.46` negated the supplied 52-week high, so the one
   figure in a clean normal-mode answer was unclaimable.
3. **Rejection wording invited invented precision**: "use the exact verified value" produced `$14,181
   million` for a rejected `$14.2bn`; "state it exactly as the tool results give it" produced
   `$1,176,299,062,416`. Both issue texts and the rewrite directive are now **deletion-only**.
4. Normal mode was thin; it now carries the analyst evidence in everyday English (`SIMPLE, NOT THIN`).
5. **One-letter tickers**: bare `O` (Realty Income) was answered as an interjection, 0 tools.
6. **`viz` cannot facet** — a live answer emitted a line chart with `"facet": true`, the renderer ignored it
   and drew net income as a flat line at the baseline (40× spread). The validator flags it and the prompt
   asks for faceted bars; a deterministic output normalizer now converts a valid `viz` facet request into
   the renderer's supported `bars` + `facet:true` shape, preserving every point.
7. **R&D intensity was not a claimable calculation**: `percentageEvidence` whitelisted only the three margins,
   so `8,091/34,639 → "23% of revenue"` on AMD was rejected as unsourced.
8. **Named peer percentages were not harvested**: measured `get_peer_context.peerPositioning.comps` supplies
   Intel at -7.5% and Palantir at 32.6% 5-year revenue CAGR, but only the company and peer medians were
   claimable. `percentageEvidence` now includes the same supported percentage fields for each returned peer.

**Live harness + evidence.** `node scripts/dev-ask-review.js` (repo root) serves the real engine and product
renderer at http://127.0.0.1:5056 with no database. It **holds the backend modules in memory — restart it
after every source edit or you are measuring the old build** (this cost an hour on 10/04). Probe sweeps:
`/tmp/probe-drafts.js` writes `pass*.md` (the model's own rejected draft) + the audit issues to `/tmp/drafts`.
The original six-probe sweep had **5 of 6 publish** (JPM 494w→1 issue→485w clean, PFE 530→7→492 clean,
WMT 476→3→470 clean, O/REIT 404→9→395 clean, AMD normal 277w clean with no rewrite). AMD analyst was the
fallback: its first measured draft had R&D intensity plus two ratio mis-roundings (49.3% for a supplied 49.35,
printed by the tool as "49.4"; 48.3% for 48.25, printed "48.2"). The prompt now says to quote each ratio
exactly as the `get_ratios_history` table prints it. A later probe confirmed the named-peer evidence gap and
reproduced `facet:true` on a `viz` block; after the comp collector and chart normalizer fixes, bare AMD analyst
published at **479 prose words**, `source: ai`, zero audit issues, with a five-period faceted bars chart.
The earlier five successful answers pre-date these two fixes; AMD has now passed separately.

**Verification state:** the feature worktree passed **1239/1239** backend tests on Node 26.9.0. The clean
release tree passed **398/398** tests in the deployment's targeted gate; its full suite passed 1233/1239.
All six failures reproduced on the untouched pre-release production tree (stale metric-page, formatter,
model-routing and reliability assertions, plus a long SEO description). GitHub's committed dataset,
exhaustive public rendering and resource gates all passed. Faceted bars render
correctly at 1100px and 390px — one panel per metric, values printed, all five period labels survive at phone
width, no horizontal overflow. Cache stamp `20261005-navtray1` sits on all 88 pages that load
`app.js`/`system.css` plus the `${STAMP}` server-rendered pages (the three HTML files without it do not
reference the assets).

## Local Ask review — 2026-10-04
`node scripts/dev-ask-review.js --examples docs/qa/local-ask-review-2026-10-04` serves
http://127.0.0.1:5056/ with the real Ask engine and product renderer, no database connection.
Generate examples, switch Simple/Analyst mode or ask custom follow-ups. SEC data is read-only, account tools
are unavailable. QA files are local/untracked; see `docs/local-ask-review.md`.

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
