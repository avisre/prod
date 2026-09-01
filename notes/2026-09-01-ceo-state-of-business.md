# CEO state-of-business — 2026-09-01

Every number here is **measured, not estimated**, from the named source on the
named date. Owner-login readouts (AppSumo Partner Portal, GA4, GSC, Clarity)
were collected on 2026-09-01 via the owner's logged-in browser session; the
appsumo.com public listing, Bing Webmaster API, MongoDB first-party funnel and
live Stripe account were pulled programmatically on 2026-09-01.

---

## 1. Revenue — where the money actually is

### Direct channel (Stripe, live account `acct` in Render env) — $0

- **Active subscriptions: 0. Lifetime charges: one £7.00 charge (2026-06-07,
  "Subscription update"), refunded. Payouts ever: $0.** (Source: Stripe API
  via scripts, 2026-09-01.)
- **MRR: $0.** 35 raw `stripe_checkout_created` events in the last 28 days
  (≈3 human ones after bot filtering) → **zero completions. subscription_started
  events ever: 0.** Every "paid" funnel event in the DB is `source: appsumo`.
- 12 users sit in `subscription.status: pending` (12 Monthly, 5 Pro, 5 Pro
  Annual, 1 Annual, 1 Power, 1 Desk pending) — checkout-started-but-never-paid.
  These are warm leads worth an email (scripts/pull-abandoned-checkouts.js).
- The one "Desk — active" user (`rin@gmail.com`) is a **legacy £29.90/yr**
  subscription on the **old** Stripe account (price `price_1ShhUd…` ≠ current
  acct `…AUeKapY1OP`), created 2025-11-19. ≈ $3/mo equivalent, grandfathered,
  not the $1,999.99 rung. **The Desk rung has never sold.**

### AppSumo — the only revenue channel that has ever paid

- **Licenses: 13 total, 12 redeemed & active** (tier 1: 6, tier 2: 2 redeemed
  of 3, tier 3: 4). 12 users carry `appsumoLicenseKey`. (MongoDB, 2026-09-01.)
- **Authoritative payout snapshot (Partner Portal CSV, imported 2026-08-11,
  `manual_gmv_snapshots` 2026-08-09): 7 payable codes, total partner payout
  $155.70, 0 refunds.** Per-code payouts: $8.87, $9.43, $16.35, $17.34,
  $31.52, $35.95, $36.24 — **avg $22.24 net per code** (16–39% of list,
  portal CSV exposes no gross GMV).
- 5 more codes were redeemed 2026-08-12 → 08-31 (after the last CSV import):
  the portal now shows a **next payout of $152.86** for them (~$30.57/code —
  higher than the Aug-11 CSV average because tier mix shifted up).
- **Portal dashboard (2026-09-01): lifetime gross sales $1,028.00, orders
  completed 13, next payout $152.86.** Portal states "Keep 90% on sales you
  drive" — that 90% applies to partner-driven sales only; marketplace-sourced
  sales net the lower measured ~$22–$30/code above.
- AppSumo net rate is therefore **~$22–$30 per code** after the marketplace's
  cut.

### Cumulative net to date (both views)

| View | Figure |
|---|---|
| **Cumulative net collected** | **$155.70 banked (7 codes) + $152.86 accrued (next portal payout) ≈ $308.56 lifetime net** |
| **Monthly run-rate now** | **$0 direct MRR + AppSumo ≈ 13 orders/4.5 wks ≈ $70–$95/mo net — call it ~$80/mo** |
| Target | **$2,000/mo net → ~25× current run-rate** |

## 2. Traffic & funnel (first-party, human-filtered, 28d to 2026-09-01)

Bot note: raw `page_view` count is 15,494/28d, but with the admin panel's
human filter (reportable, non-internal, non-bot) it is **1,736 views /
850 sessions** — **~95% of raw hits are bots**. All numbers below are
human-filtered.

- **Sessions by source (28d):** direct 279 · internal 243 · referral 188 ·
  bing 45 · google 36 · duckduckgo 33 · creator 13 · appsumo.com→us ("website")
  11 · x 5 · linkedin 3. **Organic search is ~13% of traffic.**
- **AppSumo outbound clicks: 288 in 28d** (our /appsumo.html landing →
  marketplace). At 12–13 redemptions from the campaign window, that is a
  **~4.5% click→purchase rate** — the one conversion rate that is actually
  proven.
- **Direct funnel is the broken one:** ~850 human sessions/28d → 7 signup
  events → 3 checkout events → **0 paid**. 100% checkout abandonment.
- **Countries (28d, human):** US 1,336 raw sessions but unknown dominates
  (GeoIP misses); DE 1,638, RU 417, IN 76, GB 60. GA4's city view adds
  Singapore 177 and heavy China datacenter traffic — see the GA4 readout.
- **Top pages (28d):** / (881), /company.html (477), /dashboard.html (437),
  /ask.html (321), /screener.html (286), /dossier.html (184), /tools (168),
  /login.html (166), /register.html (145), /monitor.html (123), /compare (123).
- **AI usage (credit_ledger):** Aug: 146 credits spent, 47 events, 4 users;
  Sep 1: 2 credits. Cost side is negligible at current volume.

### Last 7 days (all four sources, 2026-09-01 readout)

| Source | Last 7 days | vs 28d rate |
|---|---|---|
| GA4 (Aug 25–31) | 228 active users, 1.2K events, 24s engagement | in line (684/28d) |
| GA4 sessions | direct 227 · bing 9 · ddg 3 · appsumo 2 · chatgpt 2 · copilot 2 | — |
| GSC (Aug 23–29) | **1 click / 408 impressions / 0.2% / pos 62.6** | Google stays a non-channel |
| Bing (daily API, last 8 buckets) | **~4 clicks / ~63 impressions** | consistent with ~10 clicks/wk |
| Clarity (Aug 25–31) | 125 sessions (300 bots excl.), 109 users, 87% new, pages/session 1.96, rage 0%, dead 0%, quick-backs 8% (10) | faster pages/session, same story |
| Clarity smart events (7d) | submit-form 6 · log-in 4 · upgrade 1 · checkout 1 · signup_started 1 · appsumo_outbound 1 | — |

Last-week GA4 top pages confirm the SEO-page pattern: TSLA EPS History,
AAPL Price History and AAPL Net Income pages pull in 5–7 users each at
**100% bounce** — they land on one page and leave; no ask-floor engagement
showing up as a second page yet.
- **Anon ask gate (live since 2026-09-01, ~1 day):** 44 human page views →
  **18 anon asks started, 19 done, 2 walls shown, 1 email captured, 1 verified.**
  41% of page-viewers tried Ask; the email rung converted 1 of 2 walls. One day
  is noise, but it is the right shape. Baseline to compare:
  prod-push/notes/2026-09-sales-funnel-baseline.md.

## 3. Marketplace surface (appsumo.com public listing, 2026-09-01)

- Listing live, prices **$39 / $79 / $149**, all reviews Approved.
- **Review count: 1 (5 tacos).** With 12 buyers, reviews are the single
  biggest under-harvested marketplace asset — the in-app usage-gated review
  prompt is the machinery; APPSUMO_REVIEW_EMAILS=0 at deploy per owner call.
- Version edit "in review" per partners@appsumo.com thread; listing v3 draft
  ready at docs/appsumo-listing-v3.md — still owner's call to submit.

## 4. Search (Bing Webmaster API, 2026-09-01)

- **Last 4 weeks: impressions 626, 636, 304, 160; clicks 12, 11, 8, 10.**
  ~1–3 clicks/day, CTR ~1.5–3%.
- One query dominates and gets nothing: *"aap 2024 free cash flow guided flat
  strategic costs"* — 1,109 impressions, **0 clicks**. Everything else is
  long-tail (shares-outstanding, P/E queries, 4–15 impressions each).
- GSC readout (owner login, 2026-09-01): Google delivered **5 clicks / 1.75K
  impressions in 28d** — see section 3's readout. **Bing is currently the
  only search channel that sends traffic at all** (~10 clicks/wk vs Google's
  ~1/wk).

## 5. Owner-login readouts (collected 2026-09-01, headed browser)

### AppSumo Partner Portal
- Lifetime gross sales **$1,028.00** · orders completed **13** · next payout
  **$152.86** · listing 5.0 tacos, Public, **"Updated version in review"**
  (the v3 edit is with AppSumo's team now).
- 13 orders matches the DB's 13 licenses exactly — no reconciliation gap.

### GA4 (property "grok" p490788259 — page titles confirm stockportfolio.pro)
- **Last 28 days (Aug 4–31): 684 active users, 685 new users, 3.4K events,
  0 key events.** No conversion events are configured — GA4 cannot measure
  any purchase today. Average engagement: 24s/active user.
- First-user source: direct 596 · bing 27 · ddg 11 · appsumo.com 7 · yahoo 7 ·
  copilot.com (AI assistant) 5 · chatgpt.com (AI assistant) 4.
- Sessions by source: direct 651 · bing 29 · appsumo.com 21 · ddg 11 ·
  yahoo 9 · copilot 6 · chatgpt 4.
- Top cities: Singapore 177 · Urumqi 30 · Bortala (CN) 19 · Ashburn 15 ·
  Kashgar 15 · Shenzhen 12 · The Dalles 12 — a large share of GA4 "users" are
  datacenter/bot-adjacent (Ashburn/The Dalles = cloud DCs). First-party
  human-filtered counts remain the funnel source of truth.

### Google Search Console (sc-domain:stockportfolio.pro)
- **Last 28 days: 5 clicks, 1,750 impressions, 0.3% CTR, avg position 39.2.**
- Last 3 months: 22 clicks, 10.7K impressions, 0.2% CTR, position 16.8.
- Query mix is dominated by zero-click junk: the WAB ("earnings per share -
  wab") family = ~1,400 impressions/28d with 0 clicks; "playtika ltd. yelp"
  979 impressions/3mo, 0 clicks. **Google organic is effectively a
  non-channel: 5 clicks/month.** Bing (10 clicks/wk) out-delivers Google.

### Microsoft Clarity (project "StockPortfolio", x0dsu053xa, last 30 days)
- **475 sessions** (914 bot sessions excluded), 436 unique users, 84.6% new.
- Pages/session 1.36 · scroll depth 64% · active time 1.5 min of 3.7 min.
- **Rage clicks 0% · dead clicks 2.3% (11 sessions) · quick backs 3.6%
  (17 sessions)** — no acute UX anger signals.
- Smart events: submit-form 28 · log-in 11 · outbound click 6 ·
  signup_started 5 · appsumo_outbound_clicked 3 · signup_completed 1 ·
  checkout 1. Only 1 checkout start in 30d in Clarity's sample.
- Referrers: direct 231 · bing 20 · appsumo.com 9 · ddg 7 · yahoo 7 ·
  copilot 6 · google 4 · chatgpt 1.
- Page performance: score 75/100 — **LCP 3.8 s (needs improvement)** and
  **CLS 0.36 (poor)** are the two real findings; INP 170 ms is good.

## 6. The path to $2,000/mo net — gap math

Measured unit economics: AppSumo code nets **~$22** · Monthly $24.99/mo nets
~$24.2 (Stripe fees ~2.9%+30¢) · Good-annual $199.99/yr ≈ $16.3/mo · Pro
$499.99/yr ≈ $40.8/mo · Desk $1,999.99/yr ≈ $163/mo.

**Three scenario mixes (net/mo, Stripe fees applied):**

| Scenario | Mix | Net/mo |
|---|---|---|
| A — Marketplace-led | 45 AppSumo codes (~$22) + 20 Monthly + 15 Pro-annual | ~$990 + $484 + $612 ≈ **$2,086** |
| B — Direct-led | 60 Monthly + 24 Pro-annual + 8 Good-annual | $1,452 + $979 + $130 ≈ **$2,561** |
| C — Balanced (recommended) | 30 AppSumo codes + 30 Monthly + 25 Pro-annual + 10 Good-annual | $660 + $726 + $1,020 + $163 ≈ **$2,569** |

**What each scenario demands at today's measured rates:**

- **Scenario A** needs ~10 AppSumo codes/wk (3× current velocity) → ~2×
  outbound traffic (~575→1,150 clicks/mo) at the proven 4.5% click→buy, **or**
  the same traffic with listing conversion lifted (reviews + v3 listing).
- **Scenario B/C** need a direct funnel that has **never converted once** —
  this is not a traffic problem first, it is a **broken-checkout diagnosis
  problem first** (price shock at $24.99? payment methods? UX? The 12 pending
  users are the cheapest possible research: email them).
- Cumulative view: to bank $2,000 total from today's ~$155.70 + ~$75/mo
  run-rate takes **~2 years** — the run-rate view is the only plan that
  matters.

## 7. Ranked levers (each with the owner action it needs)

1. **Diagnose the 100% direct-checkout abandonment** — email the 12 pending
   users (support channel rules apply) + pull-abandoned-checkouts report;
   test one live $24.99 purchase ourselves end-to-end on prod. No direct
   scenario is real until the first $24.99 lands.
2. **AppSumo review harvest** — 12 buyers, 1 review. Get to 10+ reviews via
   the in-app usage-gated prompt (review-ask emails are OFF by owner call;
   reconsider for the 8/12 who are 7d-active). Reviews → marketplace rank
   → Scenario A's traffic.
3. **Submit listing v3 to William** (draft at docs/appsumo-listing-v3.md) —
   repositioning, no price/feature changes, already discussed with
   partners@appsumo.com.
4. **Watch the anon-gate funnel for 14 days** vs the 8/31 baseline — 1-day
   signal is 18 asks / 1 email; decide on the wall copy and the 6/IP backstop
   with data.
5. **SEO is a trickle, not a lever, yet** — Bing ~10 clicks/wk; Google ~5
   clicks/month. The 1,109-impression AAP query with 0 clicks and the ~1,400
   WAB impressions/28d with 0 clicks are the two cheapest content fixes; the
   WAB query family implies a dedicated WABTE earnings/shares page.
6. **Desk rung unproven** — do not plan revenue against it until one sale
   lands (it stays $1,999.99 per the Jobs-cut decision).

## 8. Cross-checks & open discrepancies

- DB 13 licenses vs portal **13 orders — exact match.** Portal lifetime gross
  $1,028 over 13 orders ≈ $79 avg gross per order; measured partner net
  $22–$30/code implies the marketplace keeps roughly 60–75% of gross on
  marketplace-sourced sales.
- DB "Desk active" user is real but is **old-account, £29.90/yr** — any "we
  have a Desk customer" claim must carry that asterisk.
- GA4 vs first-party: GA4 684 active users/28d vs first-party 850 human
  sessions/28d — different definitions (users vs sessions) and different bot
  filtering; GA4's city table (Singapore 177, Ashburn 15, The Dalles 12) shows
  cloud-DC "users" that first-party filtering removes. **Treat first-party
  human-filtered counts as the source of truth for the funnel, GA4/Clarity for
  UX and acquisition color.** GA4's biggest gap: 0 key events configured, so
  it can never show a conversion until one is set up.
- GA4 tag finding: the deployed www homepage HTML serves without a visible
  gtag/Clarity snippet, yet the GA4 property and Clarity both receive live
  stockportfolio.pro data — the tags are being injected at runtime (or served
  on inner pages). Tag presence on the live page should be re-verified before
  concluding any measurement loss.
- Owner's GA4 account also holds empty/unrelated properties ("Digital asset
  tracker" G-RTXEQMNVQT has zero events ever) — don't confuse that property's
  blank Home with "the site has no traffic."