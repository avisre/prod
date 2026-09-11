# Handoff

## Deploy + market round (9/12) — Phases 2+3 committed, NOT pushed, NOT deployed

Branch **`api-mcp-dev-tier`**, cut fresh from `origin/main` (see below) with two
cherry-picks on top: `2ad99eae` (Dev plan) and the Phase 2+3 commit. Backend
604/605 — only the pre-existing selenium `social-compose` failure. mcp-server
11/11, `npm pack` = 3 files (README + dist/server.js + package.json), leak gate
clean. Nothing is live.

**`funds/bond-credit-quality` is a dead end — do not merge it.** It is based on
an old main: `origin/main` is **28 commits ahead** of it and already contains
`7c3de09f` (progressive dossiers) plus newer work (`frontend-v2/1668f45a…txt`,
`discovered-compares.test.js`, the bot-blocker fix). Merging the old branch
would drag main backwards; branch off `origin/main` and cherry-pick instead.
The one conflict was a line-count NOTE in this file.

**Verified, not assumed — the deploy order gate is real.** With no
`STRIPE_PRICE_ID_DEV` in Render, `resolveStripeCheckoutPlan` falls back to the
unconfigured plan config and the checkout route throws
`500 "<plan> Stripe price is not configured"` ([app.js:4539](backend/app.js#L4539)).
So the **owner's Stripe step must land before the push**, or the Dev buy button
500s on the live site. The price is $19.99/mo on the existing product
`stockportfolio.pro`; `scripts/create-dev-stripe-price.sh` creates it and prints
the `gh workflow run set-render-env.yml` line (the owner types the value).

**Phase 2 (npm)** — `mcp-server/src/bridge.js` is a real stdio↔Streamable-HTTP
bridge to `POST /mcp`; the published bundle carries no backend code. Default URL
is the **www** host on purpose: the apex answers 307 → www and `fetch` drops
`Authorization` across a host-changing redirect (measured against a local 307 →
`{"sawAuth":null}`). `prepack` = esbuild bundle + `no-leak-check.js`, so publish
fails closed on any provider-adjacent string. npm name `stockportfolio-mcp` is
free (E404).

**Phase 3 (embeds)** — `/embed/earnings-quality` and `/embed/filing-timeline`
via [embed-widgets.js](backend/embed-widgets.js) + [embed-config.js](backend/embed-config.js)
(SSR, one `<iframe>`, no key, `frame-ancestors *`, `X-Robots-Tag: noindex`,
`s-maxage=900`). All CSS inline and **no `/assets/` reference**, so the widgets
stay out of the `?v=` cache-stamp cascade — `test/embed-widgets.test.js` pins
that. The tool pages and the renderer share `embed-config`, and a test asserts
the published snippet's `src` resolves on the mounted route.

**Next**: owner Stripe price → `STRIPE_PRICE_ID_DEV` → push `api-mcp-dev-tier`
→ `deploy-render.yml` → live checks → directory listings + `npm publish` →
customer announcement copy (Step 6, not written yet).

## Viral growth plan for the MCP + API — Phase 1 shipped (9/11, committed as 2ad99eae)

Full plan: `~/.claude/plans/i-wan-to-advertsie-snappy-llama.md`. Owner decisions
locked: cheap self-serve Dev plan (not free), npm publish with a CLOSED-SOURCE
package, $0 budget, built-in virality. 5 phases; this is Phase 1 (the
conversion point every later loop feeds).

**Phase 1 done — the Dev plan exists and `/api` can sell it:**
- **Dev tier**: planId `dev`, **$19.99/mo, 200 credits**, no trial, on its **own
  new Stripe price** (owner creates it on product `stockportfolio.pro`). It was
  briefly $24.99/250 sharing Monthly's price id under a no-new-Stripe-objects
  constraint; the owner lifted that for this rung on 9/11 ("separate it") and it
  returned to the growth plan's price. A distinct amount also keeps
  `resolveStripeCheckoutPlan`'s amount+product matcher unambiguous — a second
  $24.99/mo price on the same product would have matched twice and refused.
- **Disambiguation kept as belt-and-braces.** While the ids were shared,
  `getPlanConfigByPriceId` (first-match-wins, Dev's branch above Monthly's) would
  have re-resolved every Monthly renewal as Dev — and `userTier('dev')` is
  `'free'`, so paying Monthly customers would silently lose the web app. Both
  fixes stay: (a) `ambiguousStripePriceIds()` returns null for any id claimed by
  two distinct plans, and (b) `syncSubscriptionFromStripe` consults
  `metadata.planId` **before** the price id, with a round-trip check so an
  unknown value can't fall into `getPlanConfig`'s Monthly default. Nothing
  collides today; a mis-set env var is all it takes.
- **Entitlement stays narrow**: `userTier()` returns `'free'` for an active
  `dev` plan; `hasApiAccess()` adds `'dev'`. Dossier/Monitor already out of reach.
- **Priced leak closed**: Ask (`/api/ai/chat`) has NO tier gate, only credit
  metering, so Dev's flat 200 credits would have bought 100 web asks against
  Monthly's 50 — for $5 less a month. Refused with code
  `API_PLAN_NO_WEB_ASK`, before the wallet is consulted.
- **Credit repricing (same day)**: `mcp_ask` 2→**4**, `api_ask` 4→**8** (REST
  stays exactly 2x MCP); lookups unchanged at 1/2. Anchor is 2x frontier
  ($10/$50 per M tokens) applied to the **measured `chat`-shaped call at 13,820
  tokens**, not the 10,779 all-purposes blend credits.js used before — that
  blend is dragged down by shorter `summary` calls. The published AppSumo cost
  table (`docs/growth/appsumo-listing-v6.md` + `.txt`) moved with it;
  `credit-meter-truth.test.js` pins that sync. **Unaffected by the plan reprice**
  — these are frontier-anchored, not plan-anchored.
- **Split now recorded**: `ollama-usage-tracker.js` `publicEvent()` carries
  `promptTokens`/`completionTokens`. It used to read them in `finish()` and
  discard them, which made the anchor's 85/15 assumption unmeasurable in
  principle. After a few weeks, replace the assumption with data.
- **`/api` landing page**: `renderApiLanding()` in `seo-pages.js` — real
  captured NVDA payload (not a mock-up), 7-tool table, copy-paste Claude
  Desktop/Cursor `mcpServers` config, $19.99 CTA with per-call costs. Routed in
  app.js, in the sitemap core routes, exempted in `bot-blocker.js` (`/^\/api$/`).
- **register.html**: `dev` in PLANS + PLAN_VALUE + DIRECT_PLANS (so `?plan=dev`
  renders a clean single-plan checkout instead of falling back to Monthly).
  Deliberately NOT a picker card — it is a developer direct-link plan.
- Tests: `test/dev-plan.test.js`; `api-access-gating.test.js` and
  `public-api.test.js` amended. Suite green except the pre-existing
  `selenium-webdriver` gap in `scripts/social-compose.js`, unrelated. No
  `assets/*.js` or `system.css` edit → **no cache-stamp bump**.
- **Owner-only, still to do**: create the NEW **$19.99/mo** recurring Stripe
  price on product `stockportfolio.pro` and set `STRIPE_PRICE_ID_DEV` to it.
  Unset is survivable (checkout resolves by amount+product) but the amount must
  stay unique in the account. Nothing is deployed.
- **Found, NOT fixed**: `frontend-v2/terms.html` (~line 66) enumerates "current
  pricing" and does not list the Dev plan. Legal copy was deliberately left
  untouched (plan Phase 1, item 5) — the owner decides that wording.

**Phase 2 next** (npm closed-source publish + directory listings), then embeds,
referral credits, and API SEO pages. Hard gate in the plan: phases 3-5 wait
until the Dev tier is live; a Wave-1 outreach buyer committing preempts all.

Note: CLAUDE.md's "there is no local `.git`" line is now stale — this repo has
a working `.git` and `gh` is authenticated as `avisre` (per `dev-doctor.sh`).
Also HANDOFF is at 916 lines, well over its 160-line budget.

## Progressive dossier serving (9/11, on funds/bond-credit-quality, NOT yet committed/deployed)

Dossier builds now publish a "partial" (every data section, narrative empty)
to `company_dossiers` right after gathering (~23s of a ~99s build), before
`onStage('writing')`; the finished payload overwrites it. `peekDossier` serves
fresh partials to polls (payload carries `partial: true`; frontend renders it,
shows a note, keeps polling); `cachedDossier` skips partials (lease/build
re-checks must not treat a draft as done); partials older than
`DOSSIER_PARTIAL_STALE_MS` (10 min, builder died mid-write) are a miss so a
non-poll request rebuilds. app.js poll path peeks BEFORE returning 202 (was:
inflight check first, which hid the partial from same-instance pollers).
Frontend stamp `?v=20260911-progserve1` in dossier.html. Tests:
`test/dossier-progressive.test.js` + read paths verified against real Mongo
with a synthetic WIT partial (served/skipped/stale-miss all correct).
Measured on a forced BABA rebuild: content at 23s, full at 99s (was 99s blind).

## ADR dossier fix + credit-charge fix pushed (9/11, commit fc1061bd)

NTES dossier failed + customer charged 10 credits. Both fixed and pushed to
`funds/bond-credit-quality` (NOT deployed to Render yet — needs a deploy to
go live). Full plan in `~/.claude/plans/humming-conjuring-harbor.md`.

- **ADRs work end to end**: gate removed in `fundamentals-fetch.js`
  (currency read from Yahoo stamp BEFORE backfill), `sec-source.js` unit
  selection pinned to reporting currency (was mixing USD convenience
  translations into CNY rows), `fx-conversion.js` runs at cache write with a
  quote-anchored EPS guard (VALE stamps BRL but values are USD — converting
  understated revenue 5.6x), per-share math on ADS basis
  (`valuation-dcf.js`, `insights.js`), 20-F/40-F as annual forms everywhere
  (watchdog, monitors, keypoints, filing-diff, filing-fetcher, ai-chat),
  20-F item map 3.D/4/5/11 in `filing-sections.js` (minChars beats
  self-citation matches in risk factors).
- **Credits charged only after successful build** (`app.js` dossier route):
  `costKey`/`planId` hoisted above the build IIFE (block-scoped there, would
  have thrown → every build 404), reservation map
  `_dossierReserved` prevents overdraft across concurrent tabs, release
  strictly after spend.
- EPS basis gotcha: filed `dilutedEPS` is ALREADY per-ADS; ordinary-share
  count is for statement-internal series only. Yahoo `SharesOutstanding` is
  ADS-basis (= marketCap÷price).
- `mergeWithCached` in fundamentals-fetch preserves nightly-only keys
  (dividends) — an on-demand rebuild no longer clobbers them.
- Measured: NTES 18 annual yrs, rev $15.72B, DCF $115.63, P/E band sane;
  15-ADR sweep OK (9 of 16 fall back to Yahoo's 4 yrs — IFRS filers lack
  us-gaap XBRL tags; ifrs-full taxonomy support = deferred follow-up).
- Tests 577/578 (pre-existing selenium failure in social-compose). New
  `test/dossier-credits.test.js` (6 structural tests).
- **Open**: refund for wrongly-charged users still deferred by owner
  (`credits.grant()` is the idempotent tool; affected rows = dossier spends
  with no matching company_dossiers doc). Full end-to-end NTES dossier build
  on prod never run (user interrupted — costs real AI credits).
- Gotcha hit: an AAPL-only `scripts/refresh-fundamentals.js` run rewrites
  `top-100-fundamentals-index.json` with count=1 — always restore via
  `git checkout` if a single-symbol run is used for testing.

## Public API + hosted MCP endpoint shipped, NOT deployed (9/11)

Owner overrode `next-feature-ranking.md`'s "do not build" (3-buyer/rights-
verification gate) and explicitly chose to include `sp_fund` despite the
Yahoo redistribution-rights conflict in `corpus-license-terms.md` — both
called out and accepted before building, not missed.

**New**: `backend/api-keys.js` (hashed `sp_live_...` keys, `api_keys`
collection), `backend/public-api.js` (`/api/v1/*`: financials/filing/
compare/screen/fund/ask + health), `backend/mcp-endpoint.js` (`/mcp`,
Streamable HTTP, stateless — SDK confirmed v1.30.0 by installing it, not
guessed), `backend/api-response.js` (shared envelope/citation), self-serve
`/api/account/api-keys` CRUD behind existing `authMiddleware`. Docs:
`backend/public-api.md`.

**The identity bridge `credits.js`'s header called out as missing is now
closed**: a new `apiKeyAuth` middleware in `app.js` resolves a key to its
owner and populates `req.userId/user/subscription/tier` exactly like
`authMiddleware` does — so `effectiveAskLimit()` and every existing
`credits.check/spend` call site work unmodified, and an API/MCP caller
spends from the SAME wallet as their web account.

**Pricing (revised same session, per owner direction) and access, both now
live-gated, not just at key issuance:**
- `credits.js` COST: `mcp_lookup: 1`, `mcp_ask: 2`, `api_lookup: 2`,
  `api_ask: 4` — REST API is exactly 2x MCP by owner instruction, not an
  independent guess. `mcp_ask` (the only cost with real inference behind
  it — lookups are cache/SEC/Yahoo, zero LLM) is anchored to measured
  frontier pricing: Claude Fable 5.1 AND GPT-6 Astra both $10/$50 per M
  input/output tokens as of 2026-09 (cross-checked via the claude-api skill
  and a live web search — they independently match), and this product's
  measured ~10,779 tokens/call blended average prices out to ≈1.7 credits
  at the existing $0.10/credit rate. The 85/15 input/output split used to
  get there is an assumption, not a measurement — `ollama-usage-tracker.js`
  only ever stored the combined total (a gap already flagged below), so the
  split itself still isn't recoverable from stored data.
- Access is now `app.js`'s new `hasApiAccess`/`apiAccessGate`: **Power/Desk
  or AppSumo/DealMirror tier 3 only** — deliberately narrower than Monitor's
  `isLifetimeBuyer()` (any LTD tier). DealMirror tier 3 was included by
  inference (owner said "AppSumo" specifically; the codebase treats AppSumo
  and DealMirror as parallel everywhere else in `credits.js`/`tier-limits.js`)
  — flag to the owner if that wasn't intended. Checked live on every call
  (key creation AND each API/MCP request), so a downgrade takes effect
  immediately; listing/revoking existing keys stays ungated so a downgraded
  account can still manage what it already has. `/api/credits` now also
  returns `hasApiAccess` so `profile.js`'s price line can gate on it, same
  as the existing `hasMonitor`/`aiPaperBeta` rows.
- New `backend/test/api-access-gating.test.js` pins both the 2x pricing
  relationship and the gate's exact tier list (source-text asserted, same
  pattern as `ai-paper-gating.test.js`) so either can't silently drift.

**Verified live against a real local boot** (`scripts/dev-local.js`), not
just unit tests: logged in as the seeded dev user, created a real key,
hit `/api/v1/financials/AAPL` (real SEC data back), drove `/mcp` with the
actual MCP SDK client (`tools/list` + `sp_financials` MSFT), then confirmed
`/api/credits` showed BOTH spends (`api:earnings-quality` AAPL,
`mcp:earnings-quality` MSFT) on the one web account's ledger — proves the
bridge, not just that routes return 200.

The existing stdio `mcp-server/` package (local dev / Claude Desktop) is
untouched and not the public launch surface.

**Regression caught and fixed**: adding the `COST` keys tripped
`profile-consolidation.test.js`'s "price list names every billable action"
guard — correctly, since a user could otherwise be surprised by an
undisclosed charge. `profile.js`'s price list now shows all four
(`MCP lookup/ask`, `API lookup/ask`), gated behind `hasApiAccess` so it's
invisible to accounts that can't reach the feature. Two `frontend-v2/
assets/*.js` edits this session → **two** stamp bumps on `profile.js`'s own
independent stamp (separate from the shared app.js/system.css one):
`20260908-cmpcredit1` → `20260911-apicost1` → `20260911-apicost2`, kept in
sync in `profile.html` and the pin in `ask-threads.test.js:314`. Full suite:
569/570 (`social-compose` pre-existing, missing `selenium-webdriver`,
unrelated). Both the tier gate (blocks a plain-Pro seeded account, opens
after promoting it to Desk in Mongo) and the 2x pricing (1 vs 2 credits for
the same lookup on MCP vs REST) were verified live against
`scripts/dev-local.js`, not just asserted in tests.

**Owner action before this reaches real external users**: nothing code-side
is blocking — it's live on a local boot only. Before a real launch:
(1) decide whether `sp_fund` really ships given the rights exposure just
waived, not just accepted in the abstract; (2) `avisre/prod` is still
flagged public elsewhere in this file — a public API surface makes that
more consequential, not less; (3) confirm DealMirror tier 3 belongs in the
access gate alongside AppSumo tier 3 (inferred, not explicitly stated);
(4) `PUBLIC_API_RATE_LIMIT` (default 60/min) is still a first guess, not
measured against real external traffic — the credit costs, at least, are
now anchored to something real.

**Follow-on, same session: public page reconciled + a real key-management UI
built (owner asked "where will pricing/docs live" — the honest answer was
"nowhere public yet").**
- Found `/licensing` (`backend/seo-pages.js` `renderLicensing()`) already
  live-advertised MCP access under a DIFFERENT, stale model: per-seat,
  bundled with the $5–15K/yr bulk corpus licence, sold via an email quote,
  "monthly quota" (the old stdio server's local `quota.json`, not this
  session's credit ledger). Owner chose **replace**, not run both. Rewrote
  the section (new `#mcp-api` block) to state the real system: self-serve,
  Power/Desk/AppSumo-DealMirror-tier-3 only, credit-metered 1/2/2/4, no
  quote needed — kept the bulk-corpus pricing block untouched since that
  product is real and unrelated. No test pinned the old copy, so this was a
  pure content swap, no test churn.
- Backend key routes had **no UI** — a qualifying customer would have had
  to `curl` `/api/account/api-keys` themselves. Owner chose to build it now.
  New "Developer access" `<details class="psec">` section on `profile.html`
  (after Usage, ships `hidden`), `mountApiKeys()` in `profile.js` (generate
  → show raw key once + copy button, list by prefix/label/last-used, revoke
  with a confirm), gated on the new `hasApiAccess` field `/api/credits` now
  returns — same reveal pattern as `admin-section`. Third `profile.js` edit
  this session → third stamp bump, `20260911-apicost2` → `20260911-apikeyui1`,
  synced in `profile.html` + `ask-threads.test.js:314`. Full suite still
  569/570.
- **Verified in an actual browser, not just curl** — real headless Chrome
  driven over raw CDP (Node's built-in `WebSocket`, no Playwright/Puppeteer
  in this repo): logged in via a same-origin `fetch` (sets the real
  `sp_auth` cookie), navigated to `/profile.html`, and drove the full
  generate → list → revoke cycle through actual DOM clicks — new key
  appeared with its live prefix, revoke fired the confirm dialog and
  flipped the row to "revoked". Also confirmed the section is genuinely
  `hidden` (not just failing to load) for a demoted-back-to-Pro account.
  **Found and worked around, but didn't fix**: this machine's Chrome
  152 still sends "HeadlessChrome" in `navigator.userAgent` even under
  `--headless=new`, which `bot-blocker.js` correctly 403s (it's doing its
  job) — the verification run used `BOT_BLOCK_ENABLED=false` on
  `dev-local.js` only, nothing prod-facing touched.

## The 403 turned into an inbound licensing channel (9/11, after the block)

The block below creates the channel every earlier licensing idea lacked: a
refused crawler's operator reads 403s, so the refusal now carries the offer.
Three surfaces a blocked agent can still fetch were all misconfigured for it —
each pointed at the owner's personal Gmail, and `llms.txt` (the file AI
companies read deliberately) said nothing about licensing at all.

**Shipped:** `bot-blocker.js` FORBIDDEN_BODY now names `support@stockportfolio.pro`
+ the `/licensing` URL; `/licensing` added to `EXEMPT_PATH_PATTERNS` (a denial
pointing at a blocked page is useless) with a test asserting it; `robots.txt`
contact + a "denied ≠ unavailable" note; licensing sections in `llms.txt` and
`llms-full.txt`; new `seoPages.renderLicensing()` + `/licensing` route + sitemap
`coreRoutes`. Full suite 563/564 — the one failure (`social-compose.test.js`,
missing `selenium-webdriver`) is pre-existing and unrelated.

**Outreach (now sent — see the doc's send tables for the live record):**
`docs/growth/mcp-api-lab-outreach.md` — long-form MCP/API pitch + 3-wave send
sequence. **10 sends total, all 2026-09-11, all SMTP-accepted, zero replies**
(replies land in support@). All from `support@` on the owner-accepted risk
recorded in the doc.

- 4 microcap IR firms + Mistral `contact@mistral.ai`
- Chinese labs, bilingual EN+中文: Zhipu `service@zhipuai.cn` (商务合作),
  Moonshot `growth@moonshot.cn`, MiniMax `api@minimaxi.com` (商务合作),
  Alibaba Qwen `qianwen_opensource@alibabacloud.com` (no BD intake exists — the
  QwenLM org address is the only route in)
- Perplexity `publishers@perplexity.ai` — Western-lab batch, carries the
  owner-directed **quiet-door acquisition signal**

**Form-only, owner action** (no email exists anywhere): OpenAI Data Partnerships,
Microsoft PCM, 01.AI (Feishu 生态合作), Baidu (ERNIE enterprise). **No intake at
all** — not form-only, genuinely no door: DeepSeek, xAI, Anthropic, Meta, Google.
**Never send the quiet door to Microsoft** — their published policy refuses
unsolicited proposals, and the hint would risk the legitimate licensing
submission. Of the seven Western labs only Perplexity has a channel that can
carry the signal; the rest have no corp-dev route (those deals move via bankers
and warm intros). Full reasoning + per-lab field mappings in the doc.

Two constraints found while writing it:
(1) `sp_fund` is Yahoo-derived (`asset-profile.js:6`), so the sellable surface is
SEC-only — selling the full MCP contradicts `corpus-license-terms.md`;
(2) `next-feature-ranking.md` already ruled MCP/API "do not build now" pending
**three buyers committing to a price**, so Wave 1 is a demand test, not a build.
`mcp-directory-listings.md` already has finished registry copy — submit, don't rewrite.

NOTE: this file is 1,000+ lines against CLAUDE.md's 160-line cap. Needs a trim pass.

## Bot-blocker re-deployed after a Render bandwidth alert (9/11)

Render emailed 9/10: Hobby-plan workspace (5GB/mo bandwidth) at 70%+ usage 10
days into the month. Root cause matches the 9/5 analysis below almost
exactly — 68% of traffic is bots, Meta's AI crawler alone was 53% of ALL
traffic, and the fix built that day was reverted before shipping. The
bandwidth cost that made the 9/5 revert decision uncertain ("never measured")
is now measured and is the new evidence to act on.

**Re-implemented and shipped**, per owner decision to accept the same
tradeoffs as 9/5 (social-preview cards break; the small chatgpt.com/
copilot.microsoft.com human referral trickle stops):
- `backend/bot-blocker.js` (new) — 4-layer defense: UA denylist, IP
  verification (reverse+forward DNS) for anything claiming Googlebot/Bingbot,
  browser-header consistency check, per-IP nav rate limit. Fails open on an
  unseen IP; a DNS failure never becomes "impostor". `stats()` exposed at
  `GET /api/admin/bot-blocker/stats`.
- `frontend/robots.txt` rewritten: default `Disallow: /`, explicit `Allow: /`
  only for Googlebot/Googlebot-Image/Google-InspectionTool/Storebot-Google/
  Bingbot/BingPreview. `Google-Extended` gets its own explicit refusal.
- Mounted in `app.js` right after `compression()`, ahead of every rate
  limiter, `ssrCacheMw`, and `express.static`. Reuses the existing
  `isRawBodyWebhookPath` helper (passed in, not re-derived) so `/stripe/
  webhook` and `/appsumo/webhook` can never drift out of sync with the
  exemption list — the spec's own "most dangerous edge."
- Tests: `backend/test/bot-blocker.test.js` (new, 13 tests, mocks
  `dns.promises` via `node:test`'s built-in mock) and
  `backend/test/robots-policy.test.js` (new, 7 tests — the load-bearing one
  asserts robots.txt's Allow-listed agents exactly match
  `bot-blocker.js`'s `ALLOWED_UAS`, so the two files can't silently drift).
- Env switches documented in `backend/prod.env.example`:
  `BOT_BLOCK_ENABLED` (kill switch), `BOT_BLOCK_DRY_RUN` (canary — log/count
  without blocking), `BOT_BLOCK_BYPASS_TOKEN`, `BOT_BLOCK_NAV_MAX`.

**Owner action before this does anything in prod**: set
`BOT_BLOCK_DRY_RUN=true` on Render via `gh workflow run set-render-env.yml
-f key=BOT_BLOCK_DRY_RUN -f value=true` BEFORE this merges, so the first
deploy ships in canary mode. After ~24h, check `stats()` (impostor count
near 0, forged-browser/rate-limit counts near 0, verified count growing) and
Search Console/Bing Webmaster crawl stats haven't dropped, then flip
`BOT_BLOCK_DRY_RUN=false` via the same workflow. Real success signal: the
Render billing dashboard trending down over the following days
(https://dashboard.render.com/w/tea-cspuc9pu0jms7384ahsg/billing).

## Compare pages: "Listed YYYY" cells + 52-week fallback — 9/8 ship

Owner report ("free version shows em-dash in the performance area", LB-vs-MUR):
LB listed 2024, so its 3/5/10-year return cells rendered bare `—` — honest but
reads as broken. `seo-extra.js`:
- `compareData` now computes `listedA/listedB` (first monthly-close year) and
  `fmtRet()`; uncovered return windows render `Listed 2024` instead of `—`, on
  BOTH the free and pro pages (shared via the return object + pro destructure).
- New `fiftyTwoWeekRange(data)`: quote `52WeekHigh/Low` wins; when missing,
  fall back to the last 12 unadjusted monthly bars' `2. high`/`3. low` (real
  prices, monthly granularity, <12 months = no fabricated range). Belt-and-
  suspenders: a 9/8 census via the app's own `loadFundamentals` found ZERO
  renderable (screen-index) tickers missing the quote — an earlier "2,023
  missing" count was my own filename-mapping artifact (`symbolToFile` maps
  `[^A-Z0-9]`→`_`, not dot→underscore). Dead tickers already 302 at
  `metricsFor`, so no route guard was needed.
- Pinned in `seo-research.test.js`: "Listed YYYY" test (3 pins free + 3 pro)
  and `fiftyTwoWeekRange` unit test (quote wins / monthly fallback / <12mo
  nulls). Suite: seo-research 25/25, then full suite.

## Dossier Analyst cards: true-scale bars + dead-space kill — DEPLOYED (9/8)

Owner reported (Agilent dossier, Analyst mode): flat/compressed bars in
"Visual evidence" + dead space in both decision-grid cards. Fix is
frontend-only, dossier page only:

- `frontend-v2/assets/dossier.js` — `miniBars()` floor 8→3 (true scale);
  new `trendChangeLine()` (first→latest: `+N.N pts` for pct metrics,
  `×N.N total`/`±N% total` for dollars, '' when endpoints missing);
  `decisionTrends()` renders a `2019→2026 · <change>` sub-line under each
  row label. Rows: Revenue / opMarginPct / fcf / roicPct.
- `frontend-v2/dossier.html` — v3 CSS block: grid sections are flex
  columns; `.dos-trends { flex:1; align-content:space-evenly }`; rows
  `126px minmax(110px,1fr) 86px`, 56px `.dos-mini-bars`;
  `.dos-decision-copy { flex:1; justify-content:space-evenly }`;
  `.dos-key-strip { margin-top:auto }` (tiles bottom-anchored). ≤820px
  stacks naturally; ≤520px bars 40px. Stamp →
  `assets/dossier.js?v=20260908-dostrend1` (dossier.html only; the shared
  `20260907-aipaper3` app.js/system.css stamp is pinned by
  profile-consolidation and untouched).
- Verified via `/tmp/dosstub/server.js` stub (port 5077, serves
  frontend-v2 + Agilent fixture + injects `sp_dossier_mode_v1=analyst`):
  desktop 1440px + mobile 400px screenshots, DOM has 4 dos-trend-rows with
  change sub-lines and no empty-state string. NOTE: the API's `fy` values
  are 4-digit year strings (`fiscalDateEnding.slice(0,4)`,
  dossier-analysis.js:196) — a `FY19`-style fixture makes
  `financialReadings` print "NaN% a year" (`Number('FY19')` is NaN);
  fixture must use `2019` etc. 400px headless window clips the page edge
  page-wide (nav included) — pre-existing headless quirk, not from this
  change. Deployed 9/8: commit 8cafb07 via the flip-public → push → workflow
  success → flip-private ritual; live HTML serves ?v=20260908-dostrend1 and the
  bundle contains trendChangeLine. No tests pin dossier.js.

## Compare pro page: collapsible metric groups — DEPLOYED (9/8, commit `2d197d3b`)

Follow-up to the probe fix below. `renderComparePagePro` now renders one
`<tbody class="cmp-sec">` per group (7 groups; first "Size and latest FY"
fully open, the rest collapsed with ONE teaser row visible — `cmp-prev` —
and the remaining rows hidden). Group rows are click/Enter toggles
(`role=button`, `aria-expanded`); chevron `▾/▸` and an "N metrics" count
badge in the header. Also fixed the free-page probe's one-shot flag: the
`sp2up` sessionStorage flag is now consumed on the `?sp=2` load itself
(before: the visit right after an upgrade silently did nothing — likely
part of "Firefox still shows the old page"). Pins in `seo-research.test.js`
(cmp-sec cmp-open, exactly 7 groups, exactly 6 cmp-prev teaser rows).
Shipped per the standing sequence (deploy 34179227473 green, repo back
private); live free page verified (probe present, no pro leakage). Owner
click test pending: logged-in core/pro visit to any /compare page should
auto-upgrade and show the collapsible layout.

## Compare paid-upgrade probe fixed (cookie gate) — DEPLOYED (9/8, commit `6db2adfd`)

The 9/8 compare-split ship (`9a067766`) never upgraded anyone: the in-page
probe gated on `localStorage.getItem('token')`, but auth is 100% cookie-based
(`sp_auth` HttpOnly + `sp_logged_in=1` marker; login never writes localStorage)
→ probe exited early for every real user. Owner confirmed: logged in on prod,
still the free page. Fix in `backend/seo-extra.js` (free-page probe): gate on
the `sp_logged_in=1` cookie marker regex (same one V2.token uses), plain
`fetch('/api/session')` with no Authorization header — same-origin fetch
carries `sp_auth`, which authTokenFromRequest accepts. The verdict sections'
`tok?{headers}:{}` fallback was already correct. Regression pin added in
`seo-research.test.js` (probe must match `sp_logged_in=1`; the localStorage
hard-gate `…getItem('token')…if(!tok)return;` sequence is banned). Shipped
per the standing sequence (deploy 34177438338 green, repo back private);
live free page verified: probe gate present, no pro-design leakage
(`AI VERDICT`/`cmp-grp` absent). NOTE: the local working tree's
`backend/seo-extra.js` is MISSING commit `bcc62b01`'s discovered-compares
block (removed the local file wholesale from the clone would have reverted
it) — the fix was applied onto the clone's file instead; the local tree is
behind the repo for seo-extra.js. Owner: a logged-in core/pro visit to any
`/compare/...` now auto-upgrades; `?sp=2` stays as the manual path; if that
still shows the free page, the account tier isn't core/pro — check
`/api/session` `"tier"`.

## Credit recharge — phase 2: Stripe serialization bug (the real one) — DEPLOYED & OWNER-CONFIRMED (9/8, commit `d5de8475`)

Phase 1 (auth gate, `6334cdb6`) got the owner's click past 401 — and surfaced the
actual defect: 500 "Unable to start checkout right now." on every logged-in
click. Root cause: authMiddleware sets `req.userId = user._id` (raw mongoose
ObjectId, app.js:4733); the topup route was the ONLY checkout call site passing
it raw to Stripe (`client_reference_id: req.userId`, app.js:6430). Proven by
localhost interception (no Stripe contact): stripe-node SDK serializes a
non-string object param by walking its properties → request body carried
`client_reference_id[buffer]=<binary>` → Stripe rejects the unknown bracketed
param → create throws → 500. This is why ZERO `credit_topup` sessions were ever
creatable. All other call sites already used `user._id.toString()`.

- Fix: `client_reference_id: req.userId.toString()` (one line, backend/app.js).
- Pins: pricing-ladder bans the raw form; NEW hermetic
  `backend/test/stripe-param-encoding.test.js` intercepts the SDK's actual
  request encoding on localhost (http server + `{host,port,protocol}` client
  config, zero Stripe contact) — asserts plain string encoding, reproduces the
  bracketed `[buffer]` bug as the control case. Suite 540/541 (social-compose
  pre-existing).
- Shipped `d5de8475` (fast-forwarded the owner's sitemap commit `bcc62b01`),
  deploy run 34176378243 green, repo private again.
- **Owner live-tested: checkout opens — recharge fixed end-to-end.** Remaining
  unobserved hop: if they paid, the webhook +150 grant (idempotent) should show
  as "Recharge — credits added" in profile → Usage.

## Bing recs: IndexNow key hosted + sitemap picks up externally-discovered compare pairs — DEPLOYED (9/8, commit bcc62b01)

Bing recs 105/106 shared one root cause: `/compare/*` renders ANY pair live but
the sitemap only emitted algorithmic pairs (sector-adjacency + POPULAR). Fix in
an isolated worktree off origin/main (uncommitted owner work untouched):

- `seo-extra.js`: `noteDiscoveredCompare(a,b)` — records pairs that actually
  render with metrics on both sides to `backend/discovered-compares.json`
  (deduped, bounded 1000, 5s write-behind; same snapshot contract as
  indexable-shares/filing-diff-symbols). Fired from free `renderComparePage`.
- `seo-pages.js`: `buildSitemapInventory()` merges that snapshot into the
  comparisons shards (deduped vs `comparePairs()`, tickerMtime lastmod).
- `frontend-v2/1668f45a03ea53cf94c51b61c43163d4.txt`: IndexNow key file.

Verified live: key file 200; PANW-vs-SNDK 200 + recorded on first post-deploy
render; URL submitted via BWT API (quota 99/day left); sitemap resubmitted via
BWT API (GetFeeds Success, 25,831 URLs); IndexNow POST → 202. Pair lands in the
live sitemap within the 30-min inventory TTL after a render. Recs clear on
Bing's next scan. Recs 107 (noindex /login+/news — intentional) and 108
(backlinks) left alone. BWT API key inline/temp only (never stored in repo).

**Re-checked 9/11 (owner: "why isn't the Bing issue fixed yet") — the tiles are
a lagging indicator, and Bing is converging.** All three tiles still show; the
fix is live and the index is filling in. Measured via the BWT API, not guessed:
`GetFeeds` shows the sitemap index last crawled **9/10**, Status Success,
UrlCount 22,474 — vs 22,198 URLs actually published (core 94 / stocks 1,506 /
comparisons 6,350 / metrics 13,880 / diffs 368). `GetCrawlStats` is the real
signal: **InIndex 24,255 (9/3) → 29,598 (9/10)**, +5.3K in a week at ~400–2,600
pages crawled/day, 4xx ≈ 0, robots-blocked 3–4. So Bing is indexing ~800
pages/day net, and the red "missing from your sitemaps" rec should age out.
Corrected a wrong first read: the per-statement pages (`/stocks/X/revenue` …)
are NOT missing — all 11 live in the `metrics-*` shards (I had grepped the
wrong shard; AAPL 11/11 in metrics-1). Also drained the 9-URL local
`seo-data/indexnow-queue.json` (statement-page changes) → IndexNow HTTP 200,
queue now 9 submitted, and resubmitted the sitemap (`SubmitFeed` → `d:null`).
**Still unknown, owner-only:** the red tile's "Investigate" list names the exact
URLs, and there is no API for it — probed `GetRecommendations`,
`GetSiteScanResults`, `GetRecommendedUrls`, `GetCrawlIssues` (all empty) and
`GetCrawlIssues` is genuinely empty, so this is a UI-only read. Owner must open
the tile and paste the list; only then is it worth changing the sitemap.
IndexNow drains weekly (in `refresh-fundamentals.yml`, last run 9/6, next
~9/13), not continuously — that is the queue's normal cadence, not a bug.

## Credit recharge fixed (auth gate + expired-session recovery) — DEPLOYED (9/8, commit 6334cdb6)

Diagnosis first (all read-only): Stripe has **zero** `credit_topup` sessions ever
created and Atlas **zero** `topup` ledger rows — recharge never worked. The only
logged attempt (owner 9/7 19:11Z) was `POST /api/credits/topup` → **401**. Server
side always fine (price active $14.99, env set, route + idempotent webhook
sound). The defect was recharge.html having no logged-out state and no 401
recovery — a dead button showing the raw API error.

- Fix (frontend-only, `frontend-v2/recharge.html`, mirror of profile.html's
  `#locked`): `#recharge-locked` gate shown when `!window.V2.token()` (price
  card stays hidden, nothing wired); on 401 from the topup call → "Your session
  expired — please log in again." + button swaps to `/login.html?next=%2Frecharge.html`.
- Pins in `pricing-ladder.test.js` (`recharge.html gates on auth…`). No stamp
  bump — recharge.html references shared assets only, isn't a stamped asset.
- Local-verified via headless CDP against a static serve: logged-out shows the
  gate; logged-in shows the card + wired button; stubbed-401 click shows the
  recovery message and the login link. Suite 539/540 (social-compose pre-existing).
- Shipped: clone → commit `6334cdb6` → public → push (one transient 403 on
  push, retry worked) → deploy run 34175621999 green → private again. Live
  markup verified via curl.
- **Owner's one live test remains** (live Stripe writes are hard-blocked): while
  logged in, click "Recharge 150 credits — $14.99" — Stripe checkout opening
  proves the fix; paying also proves the webhook grant (+150, reason
  "Recharge — credits added").

## AI Paper beta: live research feed + pause & edit + owner steering — DEPLOYED (9/7, commit 618ada51)

Stamp now `20260907-aipaper3` (45 files). 537 tests, 536 pass (social-compose =
missing selenium-webdriver, pre-existing). ai-paper suites: 33/33.

- **Live feed**: every tool call/result is emitted and persisted as a capped
  (120) `buildLog: String[]` on the doc (`logStamp` mm:ss UTC lines, mind label
  baked into research lines at the emit layer). Chat-SSE `ai_paper` frames stay
  instant; ask.html + dashboard poll /detail (2.5s) and append new lines by
  index (dedupe counters `paperFeedSeen` / `aiPaperFeedSeen`).
- **Pause**: `activeBuilds` registry + `assertLive()` checks at every round top,
  between tool calls, and every create() stage boundary → `PauseError` →
  `pauseBuild` sets status `'paused'` (keeps `setup {guruId, constraints}` +
  feed; NOT a failure). `POST /stop` → `stopBuild` (registry flag; falls back to
  pausing a building doc after a restart). Resume = `ai_portfolio_setup` with
  the FULL edited setup; constraints (≤5 × ≤140 chars) injected into BOTH minds
  as "OWNER'S HARD REQUIREMENTS".
- **Steering** `applySteering(userId, action, params)`: only committed/tracking,
  zero AI; `rules` (≤5 × ≤160 → `steeringRules` + injected into nightly review
  prompt), `allocate` (guruPct/aiPct % of TOTAL, fixWeights, official closes,
  weighted-avg basis on the growing slot), `override` (same dollars at new
  close). Each success logs a decision type `'steering'`, persona `'owner'`.
- **REAL BUG fixed**: spreading a mongoose subdoc (`{...pos}`) into `$set`
  copies `$__`/`_doc` internals → cast wrote STALE positions (allocate looked
  successful but doc kept originals + new cash = inconsistent). Fixed with
  `plainPos(p)` = `p.toObject()` in both steering writers. Positions still
  written by exactly two paths (construction commit + steering) — pinned.
- Shipped 9/7: 49 files, commit `618ada51`, Render deploy green, repo private
  again; live stamp `20260907-aipaper3` verified on /ask, /stop 401-gated.
  Owner-tested against the local in-memory server (rin seeded, pw 'devlocal').
  Also: HANDOFF.md is 730 lines vs the 160-line guideline — trim next session.

## Credit meter rewritten on profile → Usage — LOCAL, NOT DEPLOYED (9/7)

Stamp `20260907-creditmeter1` (44 files + profile.js). 504 tests, 503 pass
(`social-compose` = missing `selenium-webdriver`, pre-existing).

Three shipped defects, all visible in one seeded month (screenshots taken via
`scripts/dev-local.js`-style in-memory boot; harness in the session scratchpad):

1. **A recharge rendered as `Credit use −0 credits`.** `topup` rows are positive
   deltas; `activityLabel` had no case for them and the row renderer clamped
   with `Math.max(0, -delta)`. A $14.99 purchase had no receipt anywhere.
2. **The per-feature split vanished above the activity cap.** It was summed
   client-side from the 12–20 capped `recent` rows and hidden when they fell
   short of `used()`. Now `credits.monthBreakdown()` — one uncapped aggregate —
   so the split always adds up; `creditSplit()` stays as the legacy fallback.
3. **`dossier-compare` was in no bucket.** It counted toward the covered≥used
   check but no feature row, silently under-reporting Dossier spend, and showed
   in the ledger as an unexplained "Credit use".

Also: `balance()` now returns `plan`/`purchased` (wallet composition was
invisible), Deep Dossier (30) reached the price list, `/api/credits` takes
`activityLimit` (clamped 1–200) for "show the whole month", and the panel leads
with remaining + a running-balance ledger + a pace line.

## Expense ratios now come from the filed prospectus — LOCAL, NOT DEPLOYED (9/7)

Follow-on to the holdings work below; owner called expense ratio one of the most
important metrics for choosing a fund. Stamp is now `20260907-fees1` (44 files).
483 tests, 482 pass (`social-compose` = missing `selenium-webdriver`, pre-existing).

**Measured first.** Yahoo is accurate for ETFs and unreliable for mutual funds:

| | Yahoo | filed | |
|---|---|---|---|
| SWPPX | 1.24% | 0.02% | 62x |
| FZROX | 0.99% | 0.00% | — |
| FXAIX | 0.69% | 0.015% | 46x |
| FSKAX | 0.66% | 0.015% | 44x |
| VWELX | 0.99% | 0.24% | 4x |
| DODGX | 0.00% | 0.51% | zero |
| VTSAX | 0.08% | 0.04% | 2x |
| VOO SPY GLD TLT SCHD ARKK XLK QQQ SGOV VNQ BND JEPI | correct | correct | ✓ |

The wrong values track the fund's Morningstar **category average**, so the
cheapest index funds are the worst hit — the exact funds people pick on cost.
This is the same class of error (FXAIX 1.53%) that pulled the ETF grade on 9/3.

**Source: the prospectus fee table, per share class.** Every '40 Act fund tags
it in XBRL on Form 485BPOS (`oef:ExpensesOverAssets`, `oef:NetExpensesOverAssets`,
management/12b-1/other/acquired-fund legs). New `backend/fund-fees.js`;
`sec-fund-index.js` holds the EDGAR plumbing now shared with `fund-holdings.js`
(ticker→series/class map, filing lookup, instance fetch). Verified against 24
funds: every mutual fund now matches its prospectus, and IVV/IWM/SOXX/EFA/AGG/HYG
resolve too.

**Two things to know:**
- A class-context match is mandatory — one prospectus covers the whole trust, so
  reading the first fee fact in the document returns a *sibling fund's* fee.
  Guarded by test.
- Some filings ship the fee table only as inline XBRL inside a 40MB HTML doc
  with no extracted instance (iShares' 2026-07-27 485BPOS for IVV). The module
  walks back up to 3 recent 485BPOS + 2 recent 497s and takes the first that
  parses, so IVV resolves from the 2025-07-22 filing. **The filing date always
  travels with the number** and is shown on the tile.

**Wiring:** `fetchAssetProfile` races the lookup against `FEE_TIMEOUT_MS = 2500`
(cold 2-8s, cached 30 days in Mongo + memory) and leaves the pending fetch
running so it warms the cache. Fallback order: filed → Yahoo **for ETFs only** →
null. A mutual fund with no filed table shows nothing, deliberately. New
`GET /api/assets/:symbol/fees` lets the page correct the tile on the same visit
instead of waiting out the 30-minute profile cache. `profile.fees` also carries
the gross/net/management/12b-1/other/acquired-fund breakdown, unused so far.

Not done: nothing else on the fund page is cross-checked against a filed source
— net assets, yield and the trailing returns are all still Yahoo's.

## Fund holdings: complete portfolios from N-PORT + 3 measured bugs — LOCAL, NOT DEPLOYED (9/7)

Owner asked why ETFs/funds don't show all holdings and why not all ETFs are
findable. Four causes, all measured, all fixed. Stamp `20260907-holdings1`
(44 files). 466 tests, 465 pass (`social-compose` fails on a missing
`selenium-webdriver` — pre-existing).

1. **Yahoo's `topHoldings` module returns exactly 10 rows for every fund** —
   verified across SPY/VOO/QQQ/VTI/ARKK/VFIAX/JEPI/SCHD/IWM/VXUS. The
   `.slice(0, 15)` was never the constraint. New `backend/fund-holdings.js`
   pulls the complete portfolio from the fund's latest **SEC Form N-PORT**
   (VOO 520, VTSAX 3,546, BND 17,409, IVV 508). New paged route
   `GET /api/assets/:symbol/holdings`; the fund page renders Yahoo's ten first
   and swaps in the full list with its as-of date and a link to the filing.
   **Issuer files are NOT usable**: iShares' and Vanguard's holdings endpoints
   both answer 200 with an Akamai HTML shell, not data (measured 9/7 — my own
   first pass mis-read those as working because I checked status+size, not
   content). GLD/IBIT correctly return nothing: grantor trusts file no N-PORT.
   Lag is real and labelled — N-PORT is public ~60 days after the period end.
   Consistent with the 9/3 "if we can't verify it we won't have it" call: this
   is the primary filing with its date shown, not a derived figure.
2. **Sector exposure was empty on every fund page, and the public
   `etf-sector-concentration` tool returned zero rows.** Yahoo sends
   `sectorWeightings`/`bondRatings` as `[{realestate: 0.018}]`, and
   `normalizeWeights` read `.name`/`.weight` off that and filtered everything
   out. Fixed; SPY now shows 11 sectors, BND 6 rating buckets.
3. **ETF-overlap tool** intersected two ten-row lists and called it portfolio
   overlap. Now full N-PORT portfolios: VOO vs VTI = 517 shared securities,
   **88.4%** overlap (was "10 shared holdings").
4. **Search couldn't reach most ETFs.** `local.concat(remote).slice(0, limit)`
   put the 99-company directory ahead of everything, so "v"/"s"/"i"/"a" each
   filled all 8 slots with equities and zero funds. Now both sources are ranked
   on one relevance scale with a floor of `limit/2` for funds. Yahoo *itself*
   returns no funds for 1–2 letter queries, so `scripts/build-fund-directory.js`
   generates `frontend/data/top-funds.json` (205 funds, every name and AUM from
   a live quote, nothing typed from memory). Also: `.L` suffixes slipped the
   old `{2,4}` filter (SPYY.L was offered for "SPY" and would 404).
   **Still excluded by design:** non-US listings (IWDA.AS, ARKK.L) — enabling
   them needs `symbolKey`'s dot→dash rule reworked, since it would turn
   `IWDA.AS` into `IWDA-AS` and 404.

Rebuild the directory with `node scripts/build-fund-directory.js` (run from
`backend/`, it needs `yahoo-finance2`). Not yet checked: whether Yahoo's 100×
expense-ratio error (FXAIX, found 9/3) still stands — the fund page still shows
that number.

**This file is 600+ lines against a 160-line budget; it needs a trim pass.**

## Credit wallet halved for NEW buyers only — LOCAL, NOT DEPLOYED (9/6)

`LTD_CREDIT_ALLOWANCE_V2 = {1:50, 2:150, 3:400}` in `credits.js`, gated on
`CREDIT_ALLOWANCE_V2_EFFECTIVE_FROM` (unset = nobody on V2). Mirrors the
`LTD_MONITOR_CAP_V2` / `isMonitorCapV2Cohort` pattern in `lib/tier-limits.js`:
**all 18 existing buyers keep 100/300/800 permanently**, and an account that cannot be
classified (bare tier, no redemption date) fails closed to V1 — it never loses half its
wallet by accident. The five `credits.balance/check` call sites in `app.js` now pass
`req.user` instead of the bare tier so the cohort is readable.

**Why: measured, not guessed.** `ollama_usage_events`, 30 days: 24.47M tokens, 2,270 calls,
**~82k tokens per charged credit**. Ollama Pro is $20/mo = **$60 of usage credits**;
glm-5.1 is $1.00/M in, $3.20/M out (~$1.20/M blended here) → current spend **~$30/mo, half
the allowance**. One tier-3 buyer spending a full 800 = 65.9M tokens ≈ **$80/mo, more than
the whole plan**. Heaviest real customer month ever: **118 credits**. One account (almost
certainly the owner's testing) is **18.76M tokens = 77% of everything**.

The Ask floor (30/100/300) is what protects the halved tiers: V2 wallets buy fewer Asks
than the floor, so the OR-gate floor governs and no buyer loses questions.

Published everywhere: listing v5 doc, `frontend-v2/appsumo.html`, the portal draft.
`credit-meter-truth.test.js` gained a cohort test; 453/454 (social-compose pre-existing).

**`CREDIT_ALLOWANCE_V2_EFFECTIVE_FROM` = `2026-09-06T00:00:00Z` is SET on Render** (9/6, via
the new `set-render-env.yml` dispatch workflow — the API key is a write-only repo secret, so
that workflow is the only path to it from a local session). Latest redemption before the line
was 9/5 17:46 UTC, so all 18 buyers are grandfathered. **It stays inert until `c5d7decc` is
deployed** — Render still cannot fetch the repo. Also: `ollama-usage-tracker.js` reads
`prompt_tokens`/`completion_tokens` at :148-149 but persists only `totalTokens` — storing
the split turns the ±20% blended-rate estimate into an exact margin figure.

## Listing v5: PRODUCT deployed, **AppSumo listing still UNCHANGED** (9/6)

**Read this first:** the code and stockportfolio.pro are live with the credit meter. The
**AppSumo listing itself has not been touched** — same Ask-count tiers, same 4 original
1920x1080 images, same "Best for: Small businesses", same "Uses AI: No". Changing it means
editing the portal draft and submitting it, which only the owner can do. Do not assume any
listing change has shipped.

`docs/growth/appsumo-listing-v5.md` (v4 marked superseded). Dossier and Monitor get a
section each; **credits are priced in reports** (100/300/800 = 10/30/80 dossiers or
20/60/160 monitor reports) because "100 credits" told a buyer nothing. Driven by Alex
(T1→T2, 9/4: "clarify the credits on the AppSumo website, rather than the questions
limit"; "report first, then chat") and Kris (8/30: "the true value lies in the dossier and
filing monitor reports").

**The bug the listing would have shipped:** Ask was metered twice. `credits.spend` debited
the wallet at `app.js:7530/:7557` while `effectiveAskLimit` hard-stopped Ask at 30/100/300
— so v4's "100 credits, Ask costs 2" overstated Starter by 67%. Now an **OR-gate**
(`app.js:7452`): allowed when `credits.check().ok` **or** the counter is under cap. Every
tier widens (T1 30→up to 50 Asks), nobody loses the floor they own, and non-LTD plans are
unaffected because their wallet is exactly 2× their Ask limit.
**Also caught: v4 line 99 said "unlimited companies"** — no tier grants that
(`lib/tier-limits.js` = 12/40/unlimited, live page = 1/4/8). v5 publishes 1/4/8.

**`backend/test/credit-meter-truth.test.js` (new, 5 tests)** is the guard: it asserts the
OR-gate is still in `app.js`, that the listing document's tables equal `credits.js`
(wallet, derived report counts, per-action costs, and that the worked example sums to 300),
that "unlimited companies" never returns, and that the listing never prices Deep Dossier
while `dossier.js` can't request it. It failed on my own first draft of the copy.

**Site aligned:** `appsumo.html` (credits + 1/4/8 kept), `index.html` pricing cards carry
each plan's allowance, tagline → "Detailed research reports on stocks, built from real SEC
data." (Alex's words; 6 sites + `anon-ask-trial` pin), `llms.txt` report-first,
`ask.html`/`profile.js` show credits — killing the "0 / 30 Ask questions used this month"
line Alex named. `/api/ai/chat/quota` gained an additive `credits` + `cost` block.
Pre-spend cost now shows on dossier and monitor **before** the click. Removed two
unbuyable promises: Deep Dossier pricing and the `$14.99/150 credits` top-up link
(prod returns `TOPUP_UNAVAILABLE` until the Render env var is set).
Stamp `20260905-fallback3` → **`20260906-credits1`**, 91 occurrences, 44 files.
Suite **452/453** (`social-compose` selenium import, pre-existing).

**Deployed** as `b716edaf` + `e46e6613` (owner triggered it manually in Render; verified on
prod — stamp `20260906-credits1`, `/appsumo` shows 100/300/800 credits and 1/4/8, the new
tagline and `llms.txt` are live). **The tier-spec email to William is now unblocked.**

**The auto-deploy is still broken, and now we know why.** The workflow's `curl -f` was
hiding the body; it now prints it. The key is fine and can see `srv-…6t10 prod` — Render's
own reply is `{"message":"not found: https://api.github.com/repositories/1105594471"}`,
i.e. **Render cannot reach the GitHub repo** for API-triggered deploys (1105594471 =
`avisre/prod`). Fix is in Render/GitHub, not in code: reconnect the repo on the service
(Settings → Build & Deploy → Repository) or grant Render's GitHub App access at
github.com/settings/installations. Owner-only — interactive OAuth.

**`avisre/prod` is PUBLIC** (`gh api repos/avisre/prod --jq .private` → `false`), against
HANDOFF's 9/3 "repo verified back to private". `backend/ai-client.js`,
`ollama-usage-tracker.js` and `CLAUDE.md` are tracked and name the provider, so the trade
secret CLAUDE.md protects is world-readable while this stands. Not changed by me — flipping
repo visibility is the owner's call.

**Still owner-only:** the two William emails (the "Uses AI: No" flag one is independent),
`STRIPE_PRICE_ID_CREDITS_TOPUP` on Render to re-enable the top-up line, and replies to Kris
(Monitor) and Gattomorto (his three asks — market-cap filter, multi-portfolio, CSV import
with date/qty/price — are all already shipped).

**This file is 540+ lines against CLAUDE.md's 160 cap and needs a trim.**

## Bots: server-side block built then reverted same day (9/5)

Built `backend/bot-blocker.js` (403 all bots except Google/Bing, 4-layer
verification) plus a rewritten `frontend/robots.txt` and two test files.
**Owner reverted it the same day** — code deleted, `robots.txt` restored to the
prior allow-all version, no trace left in `app.js`. Full rationale, traffic
measurements (68% of traffic was bots, Meta alone 53%) and the design that was
reverted are preserved in `docs/growth/bot-crawler-situation-2026-09-05.md` if
this gets revisited.

Also confirmed: `~/.nvm/.../v22.22.0/bin/node` **does not exist on this
machine**; the working binary is `/opt/homebrew/bin/node` (v26.4.0). CLAUDE.md
is stale on this.

## AppSumo relist on a credit meter + the email queue that had never run (9/5)

**The find:** `scheduled_emails` held 12 jobs (onboarding + review asks, one pair per
buyer since 8/14), all `status:scheduled`, 11 overdue, `lastError` empty — never
attempted. `scripts/run-scheduled-emails.js` was complete but wired to no cron;
nothing read `dueAt`. Fixed and drained: **13 emails sent, 0 failed.**

**Two real bugs found while draining, both silent:**
1. `run-scheduled-emails.js` used raw-driver `findOneAndUpdate(...).value`. Driver is
   **6.20.0**, which returns the bare document — `.value` is always `undefined`, so
   every review claim read as a loss and was skipped, *after* the `$set` had already
   landed and permanently blocked that user. Fixed with `includeResultMetadata: true`.
   Four users were poisoned by the first run; claims cleared, jobs reopened, all four
   sent on the re-run. Only raw-driver call in the repo; Mongoose calls are unaffected.
2. The inactive-48h pass keyed solely on `meaningful_activation` funnel events, which
   are **zero for every account** — so it would have mailed all 13 customers "you
   haven't got started", including Kris and pkotynski, *daily* once crontab'd. Now also
   counts real usage (credit_ledger/dossier_views/ask_reports + stocks/alerts/
   watchlists/portfolios). Nudges dropped 13 → 3, and the 3 are genuinely dormant
   (ian.sterk99 T3, thunderconlive T3, analyzewithzen).

**Credit meter (the relist):** `credits.js` now has explicit `LTD_CREDIT_ALLOWANCE =
{1:100, 2:300, 3:800}`, replacing derived `askLimit x2` (60/200/600) for LTD accounts.
**Every tier goes UP** — verified against all 13 live buyers, zero downgrades — so no
grandfather clause and no AppSumo downgrade approval needed. `ENABLE_TIER_V2_LIMITS`
and `MONITOR_CAP_V2_EFFECTIVE_FROM` stay OFF: one meter only, companies/portfolios/
history stay unlimited, 19yr history on every tier. Test added, 448 tests, 447 pass
(only pre-existing `social-compose` selenium failure).

**Listing v4 drafted, NOT submitted:** `docs/growth/appsumo-listing-v4-credit-model.md`.
Report-first (Dossier + Monitor lead, Ask last) on Kris's and Alex's direct feedback;
supersedes the Ask-first v3. Owner must email William for the "Uses AI: No" flag and
the tier spec — never the portal (version mapping bug).

**Data fixes:** Khaled was on a Desk *trial* (10,000 credits, 4 Oct cliff, invisible to
email since `trialing` != `active`) instead of the intended Investor — set to tier 2 /
cap 100 / active / no trial end (snapshot in scratchpad). gattomorto marked
`appsumoReviewStage:2` so the queue stops asking a customer who already reviewed 9/1.

**Also:** nav is report-first (dropdown renamed Ask AI -> Research, Dossier+Monitor lead;
mobile promoted to peers). Ask limit 25-vs-50 contradiction fixed in `llms.txt`,
`index.html:731`, `ai-chat.js:13` (code is 50). Cache stamp `20260904-recharge1` ->
`20260905-relist1`, 91 occurrences, 44 files.

**Credit top-ups — half done.** A matching LIVE price already existed and had simply
never been wired: `price_1UAUOtAUeKapY1OPUcSIaloi` ("Credit refill — stockportfolio.pro",
$14.99 one-time USD, active). Set in `backend/.env` and validated against the route's
own checks (active + unit_amount 1499 + usd) — local would sell.
**OWNER: set the same var on Render** — no RENDER_API_KEY or CLI on this machine, so
prod still returns `TOPUP_UNAVAILABLE` and the listing's "$14.99 for 150 credits" line
stays a promise prod cannot keep until it is set. Also: `ai_chat_feedback` has 0
rows because no frontend calls the thumbs endpoint; `trendbm` has never had a review
ask; this file is 441 lines against the 160-line cap in CLAUDE.md and needs trimming.

## Ask bug: `search_filings` could serve a stale 10-K as "the latest" — FIXED AND DEPLOYED (9/4, confirmed by owner 9/5)

Root cause of a real AppSumo refund. Traced from AppSumo's 9/4 refund-summary
email (2 refunds, no names/reasons given) → matched by tier+timestamp to the
two `appsumolicenses` deactivations in Mongo → one buyer (Khaled Aziz,
khaledaziz130@gmail.com) had redeemed, asked Ask one NVDA question, and
canceled 39 min later. His AppSumo exit-survey reason ("Old data, not
fresh") checked out: his Ask session got NVIDIA's **FY2025 10-K** (filed
2025-02-26) when the real latest was the **FY2026 10-K** (filed 2026-02-25,
already sitting in our own `filing_text` cache).

- **Cause**: `toolSearchFilings` (`ai-chat.js`, tool `search_filings`) queries
  `efts.sec.gov/LATEST/search-index` with no sort param — EDGAR ranks by
  relevance, not recency. Reproduced live: a plain "risk factors" / forms=10-K
  query for NVDA returned 2023→2024→2025→2026 in that order, so the 2025
  filing (position 3) looked as good as the 2026 one (position 4) to the
  model, which picked it and called it "the latest."
- **Scope check**: `grep -rl efts.sec.gov backend/` — `search_filings` is the
  **only** place in the backend that hits EDGAR's relevance search. Every
  other filing-dependent tool (`get_segments`, `get_key_points`,
  `get_governance`, `get_esg`, `get_unit_economics`, `get_filing_diff`,
  `get_red_flags`, `get_peer_context`, Filing Monitor, the dossier builder)
  already routes through `watchdog.fetchRecentFilings` →
  `data.sec.gov/submissions/CIK{cik}.json`, SEC's own chronological feed —
  not affected by this bug.
- **Fix** (`ai-chat.js`, `toolSearchFilings`): when a query names one ticker
  and restricts to periodic forms (10-K/10-Q) with no date range — the "what
  does the latest filing say" shape — cross-check against
  `watchdog.fetchRecentFilings` (same reliable source the rest of the product
  uses) and merge those in as `confirmedLatest: true`. All returned results
  are now sorted newest-first regardless, so recency is never something the
  model has to infer from list order.
- **Verified live against real EDGAR, 15 tickers across 15 GICS sectors**
  (NVDA, MSFT, JPM, XOM, JNJ, WMT, DIS, CAT, NEE, PLD, LIN, TSLA, UNH, KO,
  BA): 15/15 now return the actual latest 10-K as the top result, each
  flagged `confirmedLatest`. XOM needed its documented CIK-override fallback
  (shell/co-registrant CIK issue, already handled by `watchdog`) to confirm
  ground truth — matched exactly once resolved.
- Full suite: 441/442 (`social-compose.test.js` fails on missing
  `selenium-webdriver`, pre-existing, unrelated to this change).
- **Not yet deployed** — needs the usual Render trigger dance + cache-stamp
  check (this change touches no frontend assets, so no `?v=` bump needed).
- Reply to Khaled not sent — his refund already processed; a courtesy note
  once this ships would be a fair reason to re-engage.
- The other 9/2 refund ("Product's functionality was too limited" /
  "Lacking Depth") traced to a license that was **never redeemed** — no site
  activity at all in the purchase window, so that complaint reflects the
  AppSumo listing page or a reflexive refund-flow click, not product use.
  Not actionable, no identity recoverable from our DB (AppSumo's webhook
  carries no buyer email).

## Earlier sessions, 9/1–9/3 — all shipped, condensed (was ~320 lines)

- **9/3 CEO decisions, deployed (`8936689`)**: fixed `/api/assets/:symbol/profile`
  returning null performance for every ETF (Yahoo dropped the fields Ask relied
  on); new public `/filing-changes/:symbol` pages (verbatim Was→Now quotes,
  AI narrative stays gated); fixed affiliate `/accept` 409-ing every partner
  profile; 18-lead B2B outreach kit built (nothing sent — owner-gated).
  Sitemap diffs-shard cache-invalidation race found and fixed (shard served
  353 URLs while the index omitted it for 90 min post-restart).
- **ETF A–E grading — built, tested, then stripped same day, owner's call.**
  Yahoo reports FXAIX's expense ratio as 1.53% (real 0.015%, a 100× error)
  with no reliable way to detect a bad figure from a good one. Owner: "if we
  can't verify it we won't have it." **Don't re-propose without a fix for the
  underlying data-verification gap.** Three unrelated bug fixes from that
  session were kept (ETF performance nulls, unknown-ticker 500, leveraged-ETF
  regex).
- **9/2 shipped and live**: Monitor Normal-mode verified-quote cards; AI menu
  reorder (Dossier → Monitor → Ask); MRR ladder + GATTOMORTO referral code;
  Monitor cap v2 (1/4/8) wired but shipped dark (`MONITOR_CAP_V2_EFFECTIVE_FROM`
  blank — inert until set); customer-thread bug pass (AppSumo tier-3 session
  bug, nav badge escaping, unread-badge-vanishes bug, boot-time index fixes).
- **Graphite rebrand — tried and fully reverted same day.** Owner picked it
  from a preview, hated it live, full revert via the push-clone (NOT the
  "pre-change backup" tar, which was taken after the edit and was worthless).
  **Lesson kept**: next color change restores from git/push-clone, never an
  ad-hoc tar snapshot.
- **9/1 strategy + shipped state**: Strategy v3 approved (warm humans + founder
  B2B + $149/yr Intelligence founding SKU), honest bound $2,000/mo recurring
  conditional on B2B converting. Direct checkout channel measured at $0 MRR
  ever; AppSumo is the only paying channel. New pricing ladder shipped live
  (`2cd178c1`+`74a7fdab`), boot-crash root cause fixed (yahoo-finance2 moved
  from devDependencies).

Full detail on any of the above (exact commits, verification steps, dollar
figures) is in git history and `notes/2026-09-0{1,2,3}-*.md` if it's ever
needed again — not repeated here since none of it has an open action item.

## Owner actions pending

This list was fully rewritten 9/11 — the previous version dated to 9/1–9/2
and referenced deploys/gates long since resolved by later sessions (see git
log for what actually shipped since). If a topic below has a more detailed
section elsewhere in this file dated later than the item, that section is
the current source of truth.

1. **Bot-blocker canary → enforce** (this session, see top entry): set
   `BOT_BLOCK_DRY_RUN=true` on Render before merge, check `stats()` after
   ~24h, then flip to `false`.
2. **Secrets exposed in local transcripts, never rotated as of 9/5**
   (`docs/growth/SESSION-HANDOFF-2026-09-05.md` §8): `STRIPE_SECRET_KEY`
   (live), `STRIPE_WEBHOOK_SECRET`, `JWT_SECRET`, `SMTP_PASS`,
   `GOOGLE_CLIENT_SECRET`, `OLLAMA_API_KEY` — rotate at source AND on Render
   back-to-back per key (checkout/webhooks break if they're out of sync
   mid-rotation). Also revoke the old GitHub PAT. **Status since 9/5 unknown
   from this file — verify before assuming either way.**
3. **`STRIPE_PRICE_ID_CREDITS_TOPUP` on Render** — repeatedly flagged (9/5
   through 9/8) as set locally but not on Render, so prod returns
   `TOPUP_UNAVAILABLE`. Check current status before re-flagging.
4. **AppSumo listing v5 + William emails** — `docs/growth/appsumo-listing-v5.md`
   is the current copy; check the latest `Listing v5:` -prefixed commits for
   whether the William reply/portal update actually went out.
5. **Monthly Ollama Cloud bill** — the one input needed to state AI margin in
   dollars (formula: cost per credit = bill ÷ credits consumed). Owner-only.
6. **`avisre/prod` repo visibility** — flagged public as of 9/6, which
   exposes `ai-client.js`/`ollama-usage-tracker.js` naming the AI provider
   (a stated trade secret). Owner's call whether/when to flip back private.

## Render / deploy mechanics

- **Deploy automation**: `../trigger-deploy.sh` (workspace root, next to the
  env backup) does the whole dance — flip public via gh → POST
  `/v1/services/srv-d4kc6schg0os73al6t10/deploys` → poll → flip private,
  auto-retries the known ~50s `build_failed` flake. `RENDER_API_KEY` lives in
  the env backup file (owner pasted it 9/2 and directed it be stored there) —
  the script auto-reads it; no export needed.
  PERMANENT fix (owner, 2 min): re-authorize Render's GitHub App with access
  to avisre/prod → its webhook installs (repo currently has 0 webhooks —
  verified live 9/2) → push auto-deploys, dance dead forever.
- Render cannot clone private repo: flip `avisre/prod` public → deploy → flip
  back. First build sometimes no-error `build_failed` ~50s — retrigger.
- **Render env: per-key PUT only, never collection PUT** (8/31 incident).
- Stamp ritual: any `frontend-v2/assets/*` or `system.css` edit ⇒ new `?v=`
  on ALL pages + server-rendered (free-tools.js, comparison-pages.js,
  seo-pages.js, app.js, affiliate-dashboard.html) + pinning tests.
- Local tree LAGS GitHub on README, workflows refresh-fundamentals.yml,
  docs/, 504 frontend/data/fundamentals/*.json — do NOT copy those back.

## Working rules

- Node: PATH node is v26.4.0 at `/opt/homebrew/bin/node` — use it for
  everything. The old nvm v22.22.0 path in earlier entries above no longer
  exists on this machine (corrected 9/5, confirmed still true 9/11); tests
  from `backend/`; deps in `backend/node_modules`; no `rg`.
- Measure, don't estimate. No `sleep N`; no interactive auth via Bash.
- AI provider identity is a trade secret — never surface. Never store keys;
  inline/temp only. No anti-bot workarounds. Customer email only from
  support@ via /admin/messages (owner approves); NEVER cold email from
  support@ — separate identity for cold outreach.
- MONGODB_URI + STRIPE_SECRET_KEY parse from `render-env-backup-20260831.env`
  (workspace root; 8/31 snapshot also pasted into the 9/1 session — rotate
  exposed secrets, owner action #8). Bing key
  `~/.local/share/secrets/bing_webmaster.txt` (curl works; python
  requests gets ConnectionReset).