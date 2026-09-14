# StockPortfolio.pro — Growth State

**As of 2026-09-12.** One-file snapshot of marketing, sales, channels and metrics.
Every number is sourced. Refresh by re-running the commands in §8.

> Note: this repo is **public**. Nothing here that isn't already in tracked
> `notes/` and `docs/growth/` — and no AI-provider identity (trade secret).

---

## 1. TL;DR

- **Revenue: $0 direct MRR, ever.** A live Stripe audit on 9/12 shows every
  price at 0 active / 0 trialing / 0 past_due. The only subscription object ever
  created is a £7 GBP/mo, cancelled and refunded.
- **AppSumo is the only channel that has ever transacted** — and it started
  refunding in September. 19 licences issued lifetime: **13 active, 4 deactivated
  (refunded), 2 never redeemed**. July–August sold 13 with **zero** refunds;
  **September sold 6 and kept 1**. All four refunds are entry tier (t1, $39), and
  two happened within 4 hours of redemption. Prior baseline was $1,028 gross /
  ~$308 net lifetime (`notes/2026-09-01-ceo-state-of-business.md`, 9/1, when
  refunds were 0) — roughly $156 gross / ~$90–120 net of that is now clawed back.
- **Last 14 days added 6 users** (measured 9/12): 1 no-card Stripe trial in
  progress and 5 AppSumo licences — of which **3 are confirmed refunds**, not
  stale records. No new paying Stripe customer.
- **The current bet is the developer funnel**: self-serve API/MCP at
  $19.99/mo (Dev plan) — landing page live, Stripe price live, npm package
  built but **unpublished**, and the checkout **never exercised by a purchaser**.
- **Search is Bing-shaped**: ~19,762 sitemap URLs, but Google sends ~5 clicks/28d
  and Bing ~10 clicks/wk. Bing/Copilot is the only search channel with signal.
- **37 checkout sessions have been created all-time and none has ever produced a
  paid invoice.** The GBP/404 defect was fixed 8/31; 2 sessions since, both
  unpaid. The 24 warm leads were already emailed on 9/1 and produced 2 attempts
  and 0 payments. The payment completion step has never been tested by anyone —
  this is the binding constraint (§12a).

---

## 2. Product & positioning

Two halves, per `docs/product-principles.md`:

1. **Research Dossier** — structured, comparable company reports; every figure
   cited to its SEC filing; 12 sections, up to 19 years / 76 quarters, reverse-DCF,
   bull/bear. (Progressive dossiers shipped mid-September.)
2. **Filing Change Monitor** — verbatim before/after quotes when a new 10-K/10-Q/8-K
   lands; the retention engine for Power/Desk (`backend/monitor-digest.js`).

AI Ask/chat is deliberately **demoted** as "the commodity part" — the product
principle is the "Alex test": does this make reports more comparable, or more like
a chatbot?

**Taglines in use** ("AI stock analyst grounded in SEC filings" — `marketing/listings/g2.md`,
`frontend/llms.txt`); index title sells "SEC filing stock research, AI answers and
portfolio tracking". B2B-facing: publisher org `stockportfolio.pro`, founded 2024,
solo builder (Avinash Sreekumar), support@stockportfolio.pro.

**Commercial surfaces**: web app, public REST API (`/api/v1`), hosted MCP
(`POST /mcp`, 7 tools `sp_*`), embeddable widgets, Research Briefing newsletter,
bulk data corpus licensing (`/licensing`, $5k–15k/yr).

---

## 3. Pricing / SKU ladder

Source of truth: `backend/app.js` checkout specs (`CHECKOUT_STRIPE_PRICE_SPECS`
~line 665), `backend/credits.js`, `backend/direct-ltd.js`.

| SKU | Price | Notes |
|---|---|---|
| Monthly (Core) | $24.99/mo | 7-day no-card trial |
| Annual | $199.99/yr | no trial |
| Pro-Annual | $499.99/yr | no trial |
| Desk | $1,999.99/yr | full Pro + API/MCP + Monitor |
| **Dev (API/MCP)** | **$19.99/mo, 200 credits** | API only — `userTier('dev')` = `'free'`, no web features, **no trial (deliberate)** |
| Credit top-up | $14.99 / 150 credits | one-time; ~$0.0999/credit, at parity with Dev's rate |
| Research Briefing | $149/yr | hand-written, 2 companies/mo; buyer needs no account |
| AppSumo LTD | $39 / $79 / $149 | tiers 1/2/3 (askCap 30/100/300) |
| Direct LTD | $39.99 / $79.99 / $149.99 | runtime MFN guard keeps it above AppSumo |
| DealMirror | mirrors AppSumo tiers | `backend/dealmirror.js` |
| China annual pass | ¥1,788 one-time | Alipay/WeChat; **off** (capabilities missing) |

- **Retired rungs** (not purchasable): Power $1,499.99/yr, power-monthly $149.99,
  pro-monthly $79.99. Grandfathered subscribers keep legacy prices
  (`LEGACY_PLAN_PRICE_SPECS`, e.g. monthly $12, annual $118).
- **Paid-first**: `REQUIRE_INITIAL_STRIPE_PAYMENT` defaults true; free accounts
  only in rollback mode.
- **Credits** (per action): ask 2, monitor 5, dossier_deep 30, mcp_lookup 1,
  mcp_ask 4, api_lookup 2, api_ask 8 — REST is exactly 2× MCP. Allowance floors:
  power 2,000, desk 10,000, dev 200. Repriced 9/11 against a **measured**
  13,820-token average chat call (`backend/credits.js`).
- **Priced leak closed**: Dev subscribers are refused web Ask
  (`API_PLAN_NO_WEB_ASK`) — otherwise 200 flat credits would undercut Monthly.
- Free tier: 3 Ask/mo; anonymous 3/browser with 6/day/IP and 400/day global caps;
  upgrade copy sells "50 a month from $24.99".

---

## 4. Measured numbers

| Metric | Value | As of | Source |
|---|---|---|---|
| Active Stripe subscriptions (any price) | **0** (all 40+ prices: 0 active/trialing/past_due) | 9/12 | `backend/tmp-stripe-reuse-audit.js` run 9/12 |
| Only Stripe sub ever created | £7 GBP/mo — cancelled + refunded | 9/12 | same |
| Dev plan subscriptions | 0 (price live, never purchased) | 9/12 | same |
| Users created, last 14 days | 6 — 1 Stripe no-card trial (in progress), 5 AppSumo (2 active, 3 `cancelled`) | 9/12 | `backend/tmp-query-recent-users.js` run 9/12 |
| AppSumo licences (lifetime) | **19 issued — 13 active, 4 refunded, 2 unredeemed**; 21.1% refund rate | **9/12** | `backend/tmp-appsumo-cancelled-audit.js` run 9/12 |
| AppSumo Jul–Aug vs Sep | Jul–Aug: 13 sold, **0 refunds**. Sep: **6 sold, 4 refunded, 1 unredeemed, 1 active** | **9/12** | same |
| Refund concentration | **4 of 4 are tier 1 ($39)**; 2 refunded within 4h of redeeming (42 min and 4.1h) | **9/12** | same |
| AppSumo gross / net | $1,028 gross; $308.56 net lifetime; ~$80/mo run-rate | 9/1 | same |
| Per-code net | ~$22–30 | 9/1 | same |
| Human traffic (28d) | 1,736 views / 850 sessions (raw ~15.5K → ~95% bots) | 9/1 | same |
| Direct funnel (28d) | 850 sessions → 7 signups → 3 checkouts → **0 paid** | 9/1 | same |
| Warm pending-checkout leads | 24 (12 high-ACV: 5 pro-annual, 5 pro, 1 power, 1 desk = $7,499.88) | **9/14** | `backend/tmp-build-lead-links.js` |
| Payment-link sessions ever / paid | **18 / 0** | **9/14** | live Stripe API |
| Free users emailable for a direct-LTD flash | **2** (52 of 58 users already hold an `appsumoTier`) | **9/14** | `backend/tmp-direct-ltd-pool-count.js` |
| Active LTD buyers already asked for a review | **13 of 14** (11 at stage 3) | **9/14** | read-only Mongo query |
| Filing-diff corpus (zero marginal cost briefs) | 447 diffs / 455 reports / **392 symbols**; 342 at materiality ≥50 | **9/14** | `backend/tmp-build-ria-briefs.js` |
| AppSumo outbound → purchase | 288 clicks → ~4.5% | 9/1 | `notes/2026-09-01-ceo-state-of-business.md` |
| GSC (3 months, 5/10–8/7 export) | 17 clicks / 9,332 impressions / 0.18% CTR / avg pos 12.29 | 8/7 | `seo-data/current-seo-audit.md` |
| Google vs Bing | ~5 clicks/28d vs ~10 clicks/wk | 9/1 | `notes/2026-09-01-ceo-state-of-business.md` |
| X/Twitter | 123 posts / 4,196 impressions / 37 link clicks / **0 buyers** | 8/21 | `docs/growth/x-performance.md` |
| GA4 | 684 active users/28d; **0 conversion events configured** | 9/1 | `notes/2026-09-01-ceo-state-of-business.md` |
| Clarity | 475 sessions/30d | 9/1 | same |
| AI usage (30d) | 24.47M tokens, 2,270 calls, ~82k tokens per charged credit | 9/11 | `.claude/HANDOFF.md` |
| Heaviest real customer month | 118 credits | 9/11 | same |

*The 9/1 figures come from the CEO state-of-business note; the 9/12 rows were
measured fresh for this file.*

---

## 5. Channels

### 5.1 AppSumo / lifetime deals — the only proven channel
- Listing drafts evolved v2→v6; **v6 is current and NOT submitted**
  (`docs/growth/appsumo-listing-v6.md`; assets `marketing/appsumo-listing-v6/`).
  Section 3 (API + MCP) is cleared to send.
- Urgency/countdown module: `backend/august-campaign.js`.
- Two secondary LTD channels: DealMirror and direct (priced above AppSumo).
- GMV is **manual**: Partner Portal CSV → `manual_gmv_snapshots` collection.
  Buyer emails never arrive by webhook — license-key lookup only.

### 5.2 Direct Stripe consumer — $0, and the warm pool is already spent
- 100% abandonment cause (GBP prices to US buyers; a 404'd price) measured and
  fixed 8/31. `scripts/pull-abandoned-checkouts.js` exports the warm-lead pool.
- **The recovery emails were already sent on 2026-09-01** — 38/38 delivered, every
  one `emailStatus: "sent"`, rung-mapped, from `support@` via `/admin/messages`
  with owner approval (`notes/2026-09-01-week1-email-drafts.md`). This pool is
  **not untapped**.
- **Result, 11 days on: 2 checkout sessions created (last 09-02 13:50), 0 paid.**
  All 24 remaining leads are still `subscription.status: 'pending'` with no Stripe
  customer. So the email worked well enough to produce attempts; the *payment*
  did not complete.
- Note the sequencing deviation recorded in that file: the send was authorised
  *before* the live payment-link purchase that was supposed to gate it, and the
  links were verified only by headless page-load — which cannot catch a failure at
  the charge step. See §12a.
- **Current warm pool: 24 leads** (the 9/1 forensics counted 25; one is gone).
  Year-1 pipeline if all converted ≈ **$11.0K**, of which **68% ($7.5K) sits in
  just 12 high-ACV leads** (1 desk, 5 pro, 5 pro-annual, 1 power). The other 12
  (11 monthly, 1 annual) are the batch tier.
- **Do not send the same "it's fixed" email again** — it has been spent, and it
  would be sent into the same unverified checkout. The high-ACV 12 warrant a
  personal one-to-one approach after §12a passes, not a second self-serve link.

### 5.3 SEO — a Bing/Copilot channel with a Google-sized inventory

> **Read §11 before making any SEO decision from impression counts.** Roughly
> two-thirds of the reported Google impressions are a single ticker's
> bot-generated queries, and the surface that earns clicks is not the surface
> that was scaled.

- **Inventory ≈ 19,762 URLs** (`docs/seo/sitemap-audit.md`; GSC baseline in
  `seo-data/current-seo-audit.md`):
  - ~1,506 company pages `/stocks/TICKER` (`backend/seo-pages.js`)
  - ~14K metric-history pages `/stocks/TICKER/<metric>` — 10 metrics; the
    highest-volume tier and "the pages that actually earn Bing traffic and
    Copilot citations" (now in the sitemap via `SITEMAP_INCLUDE_METRICS=1`)
  - compare pages `/compare/A-vs-B` — 12 hand-picked + 2 nearest same-sector
    neighbours each (capped after 4 produced 11,602 URLs), plus discovered pairs
    appended live (`backend/discovered-compares.json`, 1 entry)
  - 8 vendor "X alternative" pages `/vs/<slug>` (`backend/comparison-pages.js`)
  - 17 screener presets `/screens/<slug>`, 7 research guides `/research/*`
  - 30 free tools `/tools/<slug>` (`backend/free-tools.js`)
- **Sitemap**: index + 5,000-URL shards; truthful lastmod; video extensions for
  `/tour` and `/monitor-demo`.
- **robots.txt (9/11): deny-all except Googlebot + Bingbot.** All AI crawlers,
  scrapers and social-preview bots blocked; enforced server-side by
  `backend/bot-blocker.js` (403) because Meta's crawler alone was 53% of traffic
  against a 5GB/mo Render bandwidth allowance. Blocked crawlers are pointed at
  `/licensing`.
- **IndexNow**: key hosted; queue written nightly, flushed by
  `scripts/indexnow-ping.js`; queue currently drained (9 AAPL metric URLs,
  all submitted).
- Dark pilot: `SEO_ACTIVATION_PILOT` (organic → signup CTA), gated by a
  GSC-derived eligibility manifest.

### 5.4 Free tools + embeds — the intended viral loop
- 30 deterministic tools (no AI) at `/tools/<slug>` — dilution, earnings quality,
  ETF overlap, portfolio scanners, etc.
- **2 embeddable widgets** (`backend/embed-config.js`): `/embed/earnings-quality`
  and `/embed/filing-timeline` — keyless server-rendered iframes,
  `frame-ancestors *`, 900s cache, UTM-tagged "Powered by StockPortfolio.pro"
  badge links back. Snippets published on tool pages and on `/api`.

### 5.5 API / MCP developer funnel — the newest bet, unproven
- **Offer**: Dev $19.99/mo, 200 credits, all 7 tools, 60 req/min; REST `/api/v1`
  and hosted `/mcp` (Streamable HTTP); keys `sp_live_*` (hash-only storage,
  self-serve CRUD in Profile → Developer access). Also included with
  Power/Desk/top AppSumo tier.
- **`/api` landing** (`renderApiLanding()`, `backend/seo-pages.js`) advertises
  three keyless install configs: Cursor native `url`+`headers`, Claude Desktop via
  `mcp-remote`, and `claude mcp add --transport http` for Claude Code.
- **npm package `stockportfolio-mcp` v0.3.0**: built, publish-ready, leak-gated
  (`mcp-server/`), but **NOT published** — no credential on this machine. The
  `npx` snippet was pulled from `/api` on 9/12 (commit `1aecce5b`) and
  `backend/test/dev-plan.test.js` **pins the npm name as absent** — flip that
  assertion when it publishes.
- **Directory listings** drafted, nothing submitted
  (`docs/growth/mcp-directory-listings.md`); planned slug
  `io.github.avisre/stockportfolio-mcp`.
- **Lab/partner outreach** (`docs/growth/mcp-api-lab-outreach.md`): copy for
  OpenAI Data Partnerships, Perplexity Publishers, Microsoft PCM, Mistral, x.ai.
  10 sends on 9/11, **0 replies**. Human-gated; commercial-scope table limits
  what may be sold (SEC-derived surface yes; fund data and mixed-source Ask no).

### 5.6 Affiliate program — built, invite-only, off by default
- `backend/affiliate-program.js`; `AFFILIATE_PROGRAM_ENABLED` (default off).
- Terms (`docs/AFFILIATE_PROGRAM.md`, `frontend-v2/affiliate-terms.html`):
  **30% of first-year Stripe revenue** (monthly/annual/Pro), 20% Desk, 10%
  Firm/Enterprise; AppSumo 25% of net proceeds. $100 payout minimum, 30/60-day
  holds, manual approval — nothing automated.
- Click tracking `/r/amb-<slug>`, signed 60-day cookie, new-customer-only.
- Dashboard `/affiliate` (`backend/affiliate-dashboard.html`).

### 5.7 Email / lifecycle
- SMTP via nodemailer, support@stockportfolio.pro; scheduled via
  `scheduled_emails` + `scripts/run-scheduled-emails.js`.
- Streams: new-user onboarding, trial-ending/expired win-back, weekly **Filing
  Monitor digest**, review asks, AppSumo buyer onboarding, briefing welcome.
- **Anonymous Ask email capture** (`POST /api/ask-trial/email` → verify) trades an
  address for +2 questions — the only non-signup email capture on the site.
- No public newsletter/waitlist form exists.

### 5.8 Social / content
- X posting is scripted (`scripts/social-compose.js`, pre-approved queue);
  `marketing/content-registry.csv` is empty (0 rows logged). **No social profile
  links on the site.** Zero attributable buyers from X.
- No blog. Content marketing = the programmatic SEO surfaces (§5.3) + the paid
  Research Briefing.

---

## 6. Marketing & analytics infrastructure

**Instrumented**
- GA4 `G-4K10D2FPTT` (consent-gated) + Microsoft Clarity `x0dsu053xa`; Meta Pixel
  and Google Ads conversions are env-gated (`backend/pixels.js`), shared
  `window.spTrack()`. GA4 has **zero conversion events configured — because it has
  never received one.** See §12b; this is a code defect, not a GA4 settings gap.
- First-party: `funnel_events` collection + ~45 canonical event names
  (`backend/growth-measurement.js`), attribution (`backend/attribution.js`,
  `backend/marketing-attribution.js`), idempotent `dedupeKey`.
- Server-side GA4 Measurement Protocol available, off by default.
- Event docs: `docs/analytics/event-dictionary.md`, `metric-definitions.md`.

**Where to look**
- `GET /admin/funnel` — lifetime views/signups/trials/paid + conversion table
- `GET /admin/marketing` (+ `/api/admin/marketing` JSON/CSV) — 30-day human-filtered
  funnel, per-source performance, per-tool and per-page funnels
- `GET /admin/growth/august-2026` — AppSumo sprint: GMV, activations, reviews,
  email observability
- `/api/admin/customers` — full customer export by channel
- `/api/admin/bot-blocker/stats`, `/admin/ollama` (AI usage metering)

**Key collections**: `users`, `pending_signups` (abandoned checkouts = warm
leads), `funnel_events`, `customer_lifecycle_events` (append-only revenue audit
trail), `ask_trial_leads`, `manual_gmv_snapshots`, `credit_ledger`,
`api_keys`, `ollama_usage_events`.

---

## 7. Key documents (read these before strategy work)

| Doc | What it says |
|---|---|
| `notes/2026-09-01-stripe-2000-strategy-v3.md` | **The approved strategy**: $0 direct MRR ever; consumer rung capped at $300–700/mo (12–18mo); $2,000/mo from warm leads + founder B2B + intelligence attach; honest $2K ≈ mid-2027; credible 90-day $300–700/mo net |
| `notes/2026-09-01-ceo-state-of-business.md` | Measured baseline (§4 numbers) |
| `docs/growth/180-to-1000-plan.md` | Path to $1,000 |
| `docs/growth/funnel-analysis.md`, `channel-attribution.md`, `customer-forensics.md` | 8/21 funnel + channel truth |
| `docs/growth/competitor-market-map.md` | Competitive landscape |
| `docs/growth/appsumo-listing-v6.md` | Current listing draft (unsubmitted) |
| `docs/growth/mcp-directory-listings.md`, `mcp-api-lab-outreach.md` | Dev-funnel distribution (unsubmitted / 0 replies) |
| `docs/pricing-strategy-2026-06.md` | Original thesis: data free, meter AI, charge for monitoring/intelligence |
| `docs/product-principles.md` | The "Alex test" |
| `.claude/HANDOFF.md` | Durable working memory: live state, open faults |

---

## 8. Open items & risks

**Blocking revenue**
1. **First Dev checkout never exercised** — no test key exists locally, so the
   purchase path is unproven end-to-end.
2. **npm package unpublished** — `stockportfolio-mcp` is built but not on npm;
   `/api` no longer advertises it. Publishing unlocks the npx path, the MCP
   directories, and requires flipping the pin in `backend/test/dev-plan.test.js`.
3. **AppSumo listing v6 not submitted**; directory listings not submitted.

**Platform / ops**
4. **Deploy automation half-broken**: `deploy-render.yml` intermittently fails
   with `404 repositories/1105594471` — Render's GitHub App can't resolve the
   repo; owner must reconnect in Render. No in-repo workaround.
5. `STRIPE_PRICE_ID_CREDITS_TOPUP` repeatedly flagged as missing on Render →
   credit top-up may be dead in production.
6. Secrets exposed in past transcripts **never rotated** (status unknown);
   owner action. The repo is public, which also exposes the trade secret.
7. Bot-blocker canary → enforce; Render bandwidth overage is the cost driver.
8. Branch `funds/bond-credit-quality` is a **dead end — do not merge**.
9. Monthly AI-provider bill is not recorded anywhere → AI margin uncomputable.

**Measurement gaps**
10. GA4 has zero conversion events; `ai_chat_feedback` has 0 rows (no frontend
    caller); `credit_ledger` only exists since 8/29; AppSumo GMV is manual.
11. **RESOLVED, and it is the most urgent item here:** the 3 `cancelled` accounts
    are genuine AppSumo `deactivate` webhooks — real refunds, not upgrade misfires
    or stale subdocs. See §10.
12. **Entitlement bug:** `khaledaziz130@gmail.com` holds `user.appsumoTier = 2`
    against a `licence.tier = 1` row — granted more than was purchased.
13. **Join footgun:** `funnel_events.userId` is stored as a **string** while
    `customer_lifecycle_events.userId` is an **ObjectId**. Any ad-hoc join across
    the two silently returns nothing. (The 4 `subscription_canceled` events *are*
    recorded correctly — instrumentation is fine; only cross-collection queries
    are hazardous.)

---

## 9. Targets

- **North star: $2,000/mo net.** Strategy v3 is explicit that this does **not**
  come from direct consumer MRR (that has never produced $1); it comes from warm
  pending-checkout leads, founder-led B2B (Desk/LTD), and attaching intelligence
  products to AppSumo buyers.
- **Credible 90-day band: $300–700/mo net.** Honest $2K timeline: ~mid-2027.
- Consumer rung ceiling 12–18 months out: $300–700/mo.

---

## 10. The September refund cluster (measured 9/12)

The single most commercially important fact in this file. Investigated with
`backend/tmp-appsumo-cancelled-audit.js` (read-only).

**What happened.** `revokeAppSumoAccess` (`backend/app.js:9769`) is the only writer
of `subscription.status = 'cancelled'` for an AppSumo user, and it fires solely
from an AppSumo `deactivate` webhook — a refund or cancellation. An *upgrade* also
fires `deactivate` on the old key, but `backend/app.js:9968` guards that by
revoking only when the deactivated key is still the user's current one. All three
accounts failed that guard check the bad way: **the deactivated licence IS the
current licence.** These are real refunds.

**Cohort split — the channel inverted in September:**

| Cohort | Sold | Active | Refunded | Never redeemed |
|---|---|---|---|---|
| July–August | 13 | 12 | **0** | 1 |
| **September** | **6** | **1** | **4** | 1 |

**Every refund is tier 1 ($39). No tier 2 or tier 3 has ever refunded.**

**Timeline (UTC), against commits that tightened entry-tier entitlements:**

| When | Event |
|---|---|
| 09-02 15:36 | `72492f6a` paywall: insider activity + guru portfolio moved to Core, Key Points free cap |
| 09-02 17:39 → **18:18** | licence `89cc9754` redeemed, refunded **42 minutes later** |
| 09-02 18:35 | licence `690e003f` deactivated (never redeemed) |
| 09-04 21:53 | `d22e0880` AppSumo relist: credit meter, report-first nav |
| 09-05 20:30 | `b716edaf` "one meter that Ask actually honours, priced in reports" |
| 09-05 17:46 → **21:52** | licence `e3d6a32f` redeemed, refunded **4.1 hours later** |
| 09-05 23:46 | `c5d7decc` LTD credit wallet halved for new buyers (100/300/800 → 50/150/400) |
| 09-12 01:57 | licence `0fe61f10` refunded (redeemed 09-05, 167h) |

**Leading hypothesis:** refunds cluster within hours of changes that narrowed what
a $39 buyer can actually do. Two refunds land 42 minutes and 4.1 hours after
redemption — that is not value disappointment over time, that is a buyer opening
the product and immediately finding less than the listing implied.

**Explicitly ruled out:** the credit-wallet halving (`c5d7decc`) did **not** cause
three of the four — it was committed 09-05 23:46 UTC, *after* the 09-02 and 09-05
refunds. Only the 09-12 refund postdates it. Its own comment ("not a change anyone
should feel") is defensible for the tail; the *gating* changes are the suspect.

**Caveats, stated plainly:** n=4. Commit time is not deploy time. This is
correlation with a plausible mechanism, not proof. The cheap confirmation is to
ask AppSumo Partner Portal for the refund reasons — that is one email and it
settles the question.

**Money at stake:** 4 × $39 ≈ $156 gross, ~$90–120 net at the measured $22–30/code
rate — roughly a third of the ~$308 lifetime net. And the forward rate matters
more than the clawback: at September's rate the channel no longer accumulates.

---

## 11. What the SEO inventory actually earns (measured 9/12)

Recomputed from `seo-data/gsc/*` and `seo-data/bing/*`. Two findings, both of
which contradict how the inventory has been prioritised.

### 11a. Two-thirds of Google impressions are not human

In `seo-data/gsc/query-page-3m.csv` (981 rows, 7,535 impressions), **one ticker —
WAB — accounts for 4,880 impressions (64.8%) and zero clicks**, at a weighted
average position of **2.49**.

Every WAB query uses the exact-match quote operator with systematic suffix
permutation: `"earnings per share - wab"`, then `+ finance`, `+ financial`,
`+ financial data`, `+ financial statement`, `+ financial statements`, and paired
with `"shares outstanding - wab"`. No person searches that way; a script does.

A genuine result at position ~2.5 converts at roughly 15–25%. Expected clicks if
this were human: **732–1,220. Observed: 0.** That is not a CTR problem to be fixed
with better titles — it is non-human traffic inflating the denominator.

**Consequence:** the headline "9,332 impressions / 0.18% CTR / striking distance"
in `seo-data/current-seo-audit.md:37-40` is inflated by roughly this much, and the
recommendation built on it (rewrite titles to capture near-miss rankings) targets
queries no human issues. Impression counts should not be used as an opportunity
measure until WAB is excluded.

*Caveat:* GSC privacy-filters query rows and its dimension totals are not
additive, so the query-page export understates clicks (1) versus the page export
(17). Use the page export for click attribution and the query export only for
query shape.

### 11b. Clicks come from compare pages; the 14,000-page tier earns ~nothing

From `seo-data/gsc/pages-3m.csv`, all 17 Google clicks in 3 months:

| Page type | URLs in export | Clicks | Impressions | CTR |
|---|---|---|---|---|
| `/compare/A-vs-B` | 767 | **14** | 2,699 | **0.52%** |
| home / other | 92 | 2 | 757 | 0.26% |
| `/stocks/:t/:metric` | 520 | **1** | 7,162 | **0.01%** |
| `/screens/:slug` | 3 | 0 | 62 | 0.00% |
| `/stocks/:ticker` | 315 | 0 | 1,142 | 0.00% |

Compare pages convert **50x** better than metric pages and earn 82% of all clicks.
The metric tier — ~14,000 URLs, the largest single build in the site — earns one
click per quarter, and most of its impressions are the WAB artifact.

Meanwhile `seo-data/bing/ai-grounding-queries.csv` shows **screens** leading AI
citations despite being nearly invisible in Google: "low pe ratio stocks" 53
citations / 30.8% share, "low PE ratio meaning" 43.8%, "most profitable small cap
stocks" 27.3%, "most profitable stocks right now" 12.5%. Bing organic queries are
question-shaped too ("what was fhb's net income in 2023?", "does moderna stock pay
dividends", "energy stocks ranked by dividend").

**Consequence:** the two surfaces that earn — compare (Google clicks) and screens
(Bing/Copilot citations) — are the two that were deliberately throttled. The
compare neighbour count is capped at 2 (`backend/seo-extra.js` ~line 1071, after a
widening to 4 produced 11,602 URLs) and only 17 screen presets exist
(`backend/seo-extra.js` ~line 1852). The justification for
`SITEMAP_INCLUDE_METRICS=1` — that metric pages "earn Bing traffic and Copilot
citations" — is contradicted by both exports and should be revisited.

---

## 12. Owner actions (blocking; measured 9/12)

### 12a-UPDATE (2026-09-14): the path is proven in TEST mode; a live card still hasn't paid

The section below is kept because its evidence still stands, but its conclusion
has moved. The purchase path was exercised end to end on 9/14:

- A real test-mode payment charged **exactly $250.00**, carried
  `client_reference_id` through the URL parameter, and created a subscription.
- Replaying that **real paid session** at `/stripe/webhook` against the real app
  (in-memory Mongo, `backend/tmp-webhook-replay.js`) turned a `pending`
  pro-annual lead into an **active** one, wrote `stripeCustomerId` /
  `stripeSubscriptionId`, and recorded `stripe_paid`.
- Direct-LTD **tiers 1/2/3 all mint** a licence; the **briefing** records a
  subscriber and correctly grants no app access.

**So the code is no longer the suspect.** What remains untested is a real card:
**18 payment-link sessions exist and all 18 are unpaid**, and the only paid
session in the account's history is a £0.00 GBP one from the app's own signup
flow. The 0-for-37 record is a *completion* problem, not a plumbing one.

**Critical mechanism for the warm-lead sends:** a bare payment link grants
nothing (no userId, no metadata, no client_reference_id → the webhook resolves
nobody). `?client_reference_id=<user _id>` fixes it, and the plan then resolves
off the buyer's stored `subscription.planId` — so **the link's rung and the
lead's stored plan must match** or they are charged for one and granted another.

### 12a. Complete one live purchase — the last unverified link

`notes/2026-09-01-week1-checkout-forensics.md:93` flagged this on 9/1 and it is
still open. This needs a real card; it cannot be rehearsed (no `sk_test_` key
exists locally).

**The evidence that this is the binding constraint, measured 9/12:**

- **37 `stripe_checkout_created` events all-time. `invoice_paid`: 0.**
- Stripe's own API (authoritative) shows **0 active / trialing / past_due across
  every price**, and exactly one subscription object ever created in the site's
  history — the £7 GBP/mo, since cancelled and refunded.
- Since the 8/31 pricing rebuild: **2 checkout sessions created, 0 completed.**
- All 24 warm leads: **0 with a `stripeCustomerId`, 0 with any payment.**

A 0-for-37 record spanning four price generations, two currencies and a full
pricing rebuild is no longer explainable as price shock or as the GBP defect
(fixed 8/31). The remaining untested link is the payment completion step itself —
and a headless page-load check cannot detect a failure there, because the page
renders correctly right up until the card is charged. **$19.99 settles it.**

Buy both rungs that matter, then refund:

1. **Dev — $19.99/mo** at `/register?plan=dev`. Then confirm:
   - `backend/tmp-stripe-reuse-audit.js` shows `active=1` on the Dev price
   - `credit_ledger` granted **200** credits (`PLAN_ALLOWANCE_FLOOR.dev`)
   - `customer_lifecycle_events` wrote a `stripe_paid` row
   - a key can be minted at Profile → Developer access, and `sp_live_…` authenticates
     against `POST /mcp` and `/api/v1`
   - web Ask is correctly **refused** (`API_PLAN_NO_WEB_ASK` — the priced leak guard)
   - receipt email arrived
2. **Monthly — $24.99/mo** at `/register?plan=monthly` (this is where the 25 warm
   leads are being sent, so it must be verified before any outreach). Confirm the
   7-day trial applies and `subscription.status` becomes `trialing`.
3. **Refund both**, then confirm entitlement actually revokes and
   `initialRefundStatus` updates.

Record the result in `.claude/HANDOFF.md`. Until this passes, hold Tracks B and C.

### 12b. GA4 conversions cannot be "switched on" — the transport is broken

The mapping exists (`backend/growth-measurement.js:33`):
`signup_completed → sign_up`, `stripe_checkout_created → begin_checkout`,
`invoice_paid → purchase`. **None of the three has ever reached GA4**, for two
independent reasons:

1. `GA4_MP_ENABLED=false` is the documented default
   (`docs/analytics/growth-measurement.md:93`) and the keys are absent locally.
2. **Even with it enabled, they still would not arrive.** The only sender
   (`backend/app.js:3422`, inside `logFunnelEvent`) is gated on
   `data.consent === true`. All three of those events originate server-side — the
   Stripe webhook's `invoice_paid` call at `backend/app.js:9554` passes no
   `consent` field, and **no caller anywhere passes one**: `consent: true` occurs
   exactly once in `app.js`, at line 3427, inside the outgoing payload itself.

So revenue never reaches GA4 by any path. GA4 only receives the client-side
`gtag('event', …)` calls at `frontend-v2/assets/app.js:76`, which send the **raw
internal names**, not the GA4 recommended names.

**Mark these as key events today** (they are what actually arrives, from
`BROWSER_EVENTS`): `signup_started`, `checkout_started`, `pricing_viewed`,
`cta_clicked`, `appsumo_outbound_clicked`. These are leading indicators only —
no revenue event is among them.

**To get real conversions into GA4** requires a code change, not a settings
change: either thread browser consent through to the server-originated events, or
add a dedicated Measurement Protocol send at the Stripe webhook. Worth doing only
after 12a proves a purchase can complete at all.

---

### Refresh procedure

```bash
cd backend
node tmp-query-recent-users.js      # last-14-day signups / trials / paid (read-only)
node tmp-stripe-reuse-audit.js      # live per-price subscriber counts (read-only)
cd .. && node scripts/report-growth-measurement.js   # funnel_events report
```
Admin dashboards and the strategy notes in §7 carry the rest. Update §4's table
rather than appending history.
