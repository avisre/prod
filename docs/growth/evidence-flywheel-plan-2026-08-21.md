# The Evidence Flywheel — $183.97 → $1,000 founder proceeds

**Unique plan + feature list + adversarial review | 2026-08-21**

Source of truth for every number below: the 2026-08-21 forensic audit
(`docs/growth/customer-forensics.csv`, `forensic-growth-audit.ipynb`, Partner
Portal data) plus the existing `docs/growth/*` plans. Read-only; no production
mutation. Nothing here is pushed, deployed, or emailed until separately approved.

---

## 1. The honest position (restated, because the plan follows from it)

| Fact | Number | Implication |
|---|---:|---|
| Current founder proceeds | $183.97 | Gap to $1,000 = **$816.03** |
| Current AppSumo gross | $801 | Gap to $1,000 gross = **$199** |
| 9 orders | all existing AppSumo customers | **Zero new-to-AppSumo buyers** → the advertised 90% partner share is **unvalidated** |
| Listing conversion | 2 orders / 122 visitors = 1.64% | The only observed conversion benchmark |
| Organic clicks, 3 months | 19 (16 from compare pages) | **Compare pages are the only proven click source** |
| Best content result | NVDA original: 7 clicks / 355 impressions | Long-form sourced originals beat reply volume |
| Activation | 6/7 redeemed buyers used Ask; 1 buyer = 54/76 calls | Ask is the retention engine; concentration risk |

Three conclusions:

1. **"Viral" as K-factor > 1 is a fantasy for a $149 single-purchase investing tool.
   "Viral" as a compounding share-and-index loop is achievable.** The product
   already produces the one artifact people share and rank: **a cited, verified
   claim.** That artifact is trapped inside a login. Free it.
2. **The 90% new-customer economics are the highest-leverage unknown.** One
   validated new-to-AppSumo Tier 3 order proves the whole partner-link math.
   Everything in this plan routes shares through that tracked link.
3. **Every dollar above $183.97 so far came from AppSumo.** The plan treats
   direct sales as a bonus, not the base case, until a direct checkout
   converts (the plan's 7-day test decides).

---

## 2. The unique engine: the Evidence Flywheel

The existing docs treat "Ask" as an in-app feature and "compare pages" as an SEO
surface. This plan **unifies them**: turn Ask outputs into the *same content
format that already earns your only organic clicks*, and make every unit of
that content a share node on the tracked partner link.

### Loop A — Evidence Cards (share → signup → question → new card)

- Every Ask answer is now a URL. The card shows: the question, the answer with
  **filing-linked sources**, the period, and a deterministic "verification
  summary" (which figures are direct filing numbers vs. computed vs. LLM prose).
- A **share rule, hard-coded**: only answers whose numbers are 100% filing- or
  fund-data-grounded can publish. Any answer containing an LLM judgment,
  projection, or unsupported figure stays behind the login. This is the rule
  that makes the flywheel safe to index — the only thing that can go public is
  the thing that is already verified.
- Each card carries:
  - an **OG share image** with the headline number and source (the format that
    earned the NVDA clicks);
  - **source links** direct to sec.gov;
  - a **free-question CTA** (the anonymous teaser you fixed — 3 free, no
    signup) so a visitor can ask the follow-up;
  - a **partner-link CTA** (AppSumo Tier 3 through the new-customer link —
    official share is 95% of new-buyer revenue; this product's portal
    advertises 90%, so the first attributed order settles the actual rate).
- Every card is `index,`ed (sitemap + IndexNow already configured), so each
  card is a **rankable page**. Compare pages proved investors search this exact
  shape: "NVDA vs AMD free cash flow 10 years" type pages rank, and now the
  answer itself can.

**Loop:** visitor lands on a card → reads a verified claim with sources →
tries the free question → hits the limit → buys the LTD through the 90% link,
OR shares the card → their network lands on the same card. Every stage is
tracked; the funnel is one URL deep.

### Loop 2 — Compare-family amplification (the only proven click source)

- Compare pages earned 16 of 19 organic clicks. Do **not** build more pages
  yet — **attach the evidence cards to the existing pages** in a row: "What
  changed in the last 10 years — [verified card link]" under each compare
  table. The compare page stays the door, the cards are the rooms behind it.
- The cards add fresh, dated, cited content to pages Google already favors
  (freshness + authority signals), lifting the 0.19% CTR on the same URLs.

### Loop 3 — AppSumo listing flywheel

- **Review requests are now bounded, honest, and evidence-led** (the
  buyer-psychology doc's rule): ask the six active buyers for a review only
  after they complete one *useful* Ask, and offer no incentive. One more
  4–5 taco review is worth more than any single feature build.
- **One 60–90 second proof video**: Ask a question → card appears with cited
  SEC sources → share link. Upload to the listing and X. Video is the
  AppSumo-favorite medium and this product has zero.
- **Q&A table published on the listing** — answer the four recurring anxieties
  (ETF coverage, tier mapping, Ask reliability, export/API) in the exact tier
  table format they already approved.
- **Performance-based amplification (AppSumo's actual promotion engine,
  verified 2026-08-21):** every deal gets the Monday Tool Drop email (~1.3M
  subscribers). Top performers unlock "Top 5 Trending" (prior-day sales +
  reviews + taco ratings), #1/#2-performer emails, weekly leaderboards,
  affiliate spotlights and dedicated ad spend — weighted by sales, reviews,
  taco ratings, revenue/session and AOV. Marketplace amplification is *earned,
  not bought*: one concentrated review week is what flips it on. The listing
  flywheel is not decoration — it is the key to AppSumo's organic audience.

### Loop 4 — Earnings-season "Reality Check" pipeline

- Build once, schedule forever: the calendar of upcoming earnings dates (the
  data already exists) fires a **verified, cited Reality Check card** for
  5–10 high-intent tickers each week. Each is an evidence card by design —
  same format, same share button, same partner link.
- Earnings-season search interest is lumpy, schedule-driven, and — critically —
  **forecastable**: cards are ready 48 hours before each earnings date.

---

## 3. Features to build (ranked, bounded, tied to revenue)

| # | Feature | Why (revenue link) | Effort | Build/no-build |
|---|---|---|---|---|
| F1 | **Evidence Card URL + share + OG image for Ask answers** | The flywheel. Turns retention into distribution. | Medium | **Build** |
| F2 | **Publish gate: only fully-cited answers go public** | Safety rule that makes F1 indexable. Non-negotiable. | Small | **Build** |
| F3 | **Partner-link CTA on every card** | Routes new-customer orders to the 90% link. | Small | **Build** |
| F4 | **Evidence-card row under compare pages** | Amplifies the only proven click source. | Small | **Build** |
| F5 | **Earnings "Reality Check" card generator** | Forecastable weekly content + shares. | Medium | **Build** |
| F6 | **Buyer share link** (one click) | The 6 active buyers become a distribution network, at zero cost. | Small | **Build** |
| — | **API / MCP** | One request, unvalidated demand, upstream rights unresolved. | Huge | **Do NOT build** |
| — | **TradingView import / price change** | Not needed for this goal; adds surface area. | — | **Do NOT build** |

**Anti-scope rule:** nothing in this list changes pricing, adds a
subscription tier, or touches the AppSumo versions mapping (never edit versions
in the Partner Portal).

---

## 4. The math — honest paths to $1,000

### Path A — New-to-AppSumo Tier 3 through the new-customer link (validated first)
- **Requires:** 7 eligible new-customer Tier 3 purchases. Official AppSumo
  policy: **95% of new-buyer revenue** (new = never invoiced on AppSumo, free
  or paid). The Partner Portal advertises 90% for this product — the first
  correctly attributed order settles which applies.
  - At 95%, no discount: 7 × $149 × 0.95 = **~$990.85** incremental →
    cumulative **~$1,174.82** (clears $1,000 with headroom).
  - At 95% with the 10% AppSumo Plus discount: 7 × $134.10 × 0.95 =
    **~$891.77** incremental → cumulative **~$1,075.74** (still clears).
  - At the portal's 90%: 7 × $149 × 0.90 = **~$938.70** incremental →
    cumulative **~$1,122.67** (clears with ~5% headroom).
- **Validation gate (7 days):** first correctly attributed new-customer order
  shows the actual partner share in the portal. If it is materially below
  90%, **re-model immediately**.
- This path assumes you can find **430 qualified landings** at the observed
  1.64% visitor→order rate. The Evidence Flywheel is the engine that
  produces those 430 landings — no other lever can.

### Path B — Observed marketplace economics (backup)
- 24 additional Tier 3 orders at $34.57 avg → ~$1,013.65. Slow (12 wks at 2
  orders/wk) and order-heavy; the fallback, not the bet.

### Path C — Two Power Annual (direct, unvalidated)
- 2 × $579 → $1,158 direct gross; before costs, **$1,341.97** cumulative signal.
- Direct demand is unvalidated (the audit: 0 retained direct subscribers, 1
  refunded Stripe). Tested at 20 qualified conversations max, then killed.

### Path D — One Desk annual
- 1 × $1,961 → clears both targets outright. Highest upside, least proven.

**This plan's stance:** pursue **A as the primary with the flywheel as its
engine**, keep C as the live safety valve, and keep B/D as checkpoints, not
bets.

---

## 5. Execution — 7 / 14 / 30 / 60-day gates

### Days 1–7 — Prove the engine + validate the 90% economics
- [ ] Deploy the Ask teaser fix (`ALLOW_ANON_AI=true`, `ANON_ASK_LIMIT=3`).
- [ ] Ship F1+F2+F3: a public evidence card end-to-end on one ticker.
- [ ] Wire the partner link onto the card. **First eligible new-customer order
  = the partner-share economics test** (official policy: 95% of new-buyer
  revenue; portal shows 90% — the order settles it). If no order: continue;
  the test only counts on the first correctly-attributed order.
- [ ] Activate the old unredeemed Tier 3 buyer (support-first, one touch).
- [ ] Record baseline: cards indexed, 122/7-day listing rate.

### Days 8–14 — Amplify the proven shape
- [ ] F4: evidence-card strip under compare pages (no page changes).
- [ ] One weekly earnings "Reality Check" card, published with the calendar.
- [ ] AppSumo: 60–90s proof video + Q&A table submission.
- [ ] Review requests to the 6 active buyers (post-useful-Ask, no incentive).

### Days 15–30 — Distribution
- [ ] Three partner-link demos (the plan already has the prospect list).
- [ ] One high-intent X original in the NVDA pattern (source + surprising
      number + card link), max five relevant replies.
- [ ] 10 Desk discovery conversations; kill at 15 if no budget signal.

### Days 31–60 — Scale the winner, kill the rest
- [ ] If first new-customer order validated the 90%: double the card rate.
- [ ] If ≤1 eligible order by day 60: pause the partner link, re-model.
- [ ] If ≥10 Desk demos but 0 closes: hold Desk, don't build for it.

**Numeric gates (from the 180-to-1000 plan):**
- Kill Path A message/landing combo at 100 qualified partner-link visits with
  zero orders.
- Kill Path C at 20 qualified conversations without 2 retained purchases.
- Kill the flywheel only if cards get no measurable index/rank signal in 45 days
  (or if a published card ever contains an error — that's a shutdown, not a
  pause).

---

## 6. Adversarial review — attacks on this plan, with responses

This section assumes the reviewer's job is to break it. Every attack listed
here has been deliberately considered, and each has either a mitigation or a
kill rule.

1. **The 90% partner share is a claim, not a fact. Only the portal knows.**
   *Response:* correct — official AppSumo policy is 95% for new buyers, but
   this product's portal advertises 90%; the plan's first gate is the first
   correctly attributed new-customer order. If the payout doesn't match, Path
   A dies and B/C remain. The flywheel still produces value either way
   (ranking cards bring free-trial users and direct prospects).

2. **"Viral" is a lie; K-factor is ~0.**
   *Response:* agreed. The flywheel does not depend on a K-factor. It depends
   on (a) search interest in this format (proven by compare clicks) and (b)
   buyer-shared cards (6 active buyers, each a mini distribution node). The
   bet is compounding, not exponential.

3. **Indexed answer pages cannibalize paid Ask.**
   *Response:* the publish gate is the answer — only cited/verifiable answers
   go public. The free teaser (3) stays an intro, not a substitute; the
   shared card is a *sample* of the subscription, and every visitor who needs
   the second, third, or deeper question must pay. Also explicitly stated in
   the plan: if measured cannibalization of Ask traffic appears, cards drop
   to non-indexed (link-only) within 7 days.

4. **The free anonymous teaser costs money at the global cap (400/day).**
   *Response:* the cap is small and the CTA is the funnel; the 3-question
   limit prevents meaningful drain. If a card publishes during an earnings
   spike and the daily cap is hit, that's a traffic problem, not a cost
   problem — and it's budgeted by the cap.

5. **A public "verified" card on a known fake-number post is a liability.**
   *Response:* yes. That's why the publish gate is *hard-coded*, not
   editor-discretion: no model-generated number without a filing/fund source
   can ever become a card. Cards are the *verification* surface, not the
   *opinion* surface. Reviews/actions must not weaken this — it is the
   reputational moat.

6. **Existing buyers won't share — they don't have incentive.**
   *Response:* they get a working verification tool and a community-linked
   card. The share button is zero-effort, and the one 54-question buyer is a
   natural superuser. But the plan does not depend on them: the compare row
   and search loop are the base.

7. **The compare pages are the only proven click source — touching them
   risks the funnel.**
   *Response:* the plan does *not* touch compare pages. It *adds* a row
   beneath the tables (a DOM append), which is the low-risk version of the
   "contextual next step" experiment already ranked #9. Rollback is deleting
   the row.

8. **Search volume for "evidence card" style queries is tiny.**
   *Response:* the format is the same as the compare pages that already rank
   (0.19% CTR is bad but the clicks are the only proof that the *shape* ranks).
   The bet is that dated, cited, answer pages for long-tail investor questions
   rank better than static tables. 45-day index/rank gate decides — no faith
   required.

9. **Earnings-content is seasonal and lumpy; the founder does everything.**
   *Response:* true — the generator is a 5–10 ticker auto-card pipeline (one
   build), not a daily editorial hand-crafted one. The plan's X activity is
   capped at one original + five replies/week. This is a solo founder with 15
   hours — the engine is built to *automate the card*, not to create a content
   treadmill.

10. **FTC: reviews with no incentive vs. AppSumo's own policy.**
    *Response:* the review request has no incentive — explicitly the
    buyer-psychology rule. Any blog/marketing claim about cards being
    "verified" says "verification = cited filing source," never "this is
    financial advice." The marketing mouth must be honest — the flywheel's
    whole value is that it is real.

11. **Partner-link attribution is a black box; orders can be misattributed.**
    *Response:* yes — the portal is the source of truth (the audit's own
    statement). The plan tracks the link on every share and validates against
    the portal. If attribution is unreliable after 30 days of shares, the
    link stays a rank/sign-up tool and the sales bet moves to direct Path C.

12. **You haven't priced the AI cost of the flywheel.**
    *Response:* each card costs exactly one Ask call, which the quota system
    already meters (300/Pro). The extra cost is the *teaser* questions (3/day
    free) — capped globally at 400/day. When a card goes public, the *answer*
    is free to see — the question is already answered, so it costs nothing
    more per view. This is the design lever that keeps the flywheel
    cheap: **the card is a finished artifact, not a live query.**

---

## 7. Market research — verified 2026-08-21

The web tools were broken mid-plan (the small-fast + subagent models were
pinned to `claude-haiku-4-5-20251001`, which this environment's proxy cannot
serve; both now point at the session model). These facts were re-verified
live and supersede the map rows where they differ.

**AppSumo partner economics (official policy):**
- New buyers (never invoiced on AppSumo — free or paid): **95% of revenue**,
  minus a ~5% processing fee. Returning customers: **70%** (negotiated).
  This product's Partner Portal advertises 90% for new customers — the
  first-order test in Path A settles which applies.
- Affiliate program (separate from the product's own partner share):
  affiliates earn 100% of new-buyer transactions up to $100, 5% after.
- Net revenue = gross − AppSumo Plus 10% discount − refunds. Net-60 settlement.

**AppSumo promotion = performance-based scaling** (verified):
every deal gets the weekly Tool Drop email (~1.3M subscribers); top performers
unlock Top-5 emails, weekly leaderboards, "Top 5 Trending", affiliate
spotlights and dedicated ads — weighted by sales, reviews, taco ratings,
revenue/session, AOV. The marketplace amplifies what already performs.

| Competitor | Verified pricing 2026-08-21 | Old map row |
|---|---|---|
| Fiscal.ai (ex-FinChat) | Free / Pro $39-mo annual, $49 monthly / Max $79-mo annual, $99 monthly; 10 / 250 / unlimited Copilot prompts; Max = click-through audit to source filings + full export | $24–64 → **corrected** |
| BamSEC | Pro $69/mo billed annually; Enterprise = AlphaSense, "contact us" | confirmed |
| StockAnalysis | Free; Pro $79/yr (~$6.58/mo); Unlimited ~$199/yr ($16.58/mo) | confirmed |
| TIKR | Free; Plus $24.95/mo; Pro $54.95/mo; Ultimate $119.95/mo; ~30% off annual | confirmed |

**Competitive read:** Fiscal.ai's Max tier sells "click-through to source
filings" as its headline feature at ~$948/yr — the exact evidence-in-the-filing
workflow the flywheel makes free to share. It confirms the positioning thesis:
citation is no longer a trust badge; it is the product.

Remaining to re-check in the Partner Portal (JS-rendered, requires login):
the exact partner-share percentage this product receives for new vs. returning
customers, and whether the one 5-taco review is still live.

---

## 8. Anti-features and stop-conditions

- **No API/MCP** until ≥3 priced commitments *and* verified commercial rights.
- **No TradingView import, no pricing change, no new tier, no versions edit.**
- **No paid acquisition** until refunds, payout, and lifetime AI cost are
  mature.
- **Never email review asks with incentives; never claim "verified" beyond
  the crate-source meaning.**

Kill the flywheel or go slow at any of these, with the plan's gates as the
decision point, and the plan's docs as the paper trail.
