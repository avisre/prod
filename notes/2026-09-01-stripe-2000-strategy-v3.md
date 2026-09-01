# Strategy v3 — the aggressive, honest path to $2,000 MRR (+$5K/$10K)

Written 2026-09-01. **Supersedes v2 for execution decisions** (v2 preserved at
`2026-09-01-stripe-2000-strategy-v2.md` — its antagonist-review findings and
checkout mechanics carry forward). Approved by the owner 2026-09-01.

Provenance: produced by an 11-agent strategy panel (5 independent operator
lenses — marketplace, monetize-existing, B2B, funnel-economics, contrarian —
each adversarially red-teamed, plus a completeness critic) against the
measured CEO brief (`2026-09-01-ceo-state-of-business.md`), then a second
verification panel (4 adversarial verifiers + an idea generator) answered the
owner's timeline-compression question. Where panels contradicted themselves,
the CEO call is stated. Every measured number traces to the brief or the
panel journals; every projection is labeled with its assumption.

---

## The CEO verdict — what changes from v2

1. **v2's center of gravity is wrong.** v2 and the brief's Scenarios B/C bet
   the $2,000 on a consumer funnel that has never converted once (0
   completions ever, 3 checkout starts/28d) fed by ~600 external sessions/mo.
   Panel arithmetic, independently converged by three lenses and confirmed by
   every red team: **the consumer rung at $24.99 is a $300–700/mo component
   at its everything-goes-right ceiling, 12–18 months out — not the engine.**
   Keep it on life support: fix, measure, no scale spend.
2. **The $2,000 comes from three places v2 underweighted:** the 24 warm
   humans who already raised their hands (12 buyers + 12 pending-checkout
   leads), founder-led B2B at high rungs, and an Intelligence attach layer on
   a marketplace-grown buyer pool.
3. **The most valuable fact in the business is unexplained:** 100% checkout
   abandonment by users who selected rungs up to $1,999.99 (12 Monthly, 5
   Pro, 5 Pro-annual, 1 Power, 1 Desk, 1 Annual pending) — against a June-doc
   flag of GBP-only checkout friction and a legacy Stripe account residue
   (old price `price_1ShhUd…` ≠ current account `…AUeKapY1OP`). Multi-rung
   intent + total failure smells like a mechanical defect, not price shock.
   If it's an hour-long config fix, it unlocks the entire direct channel.
   **This is the first move, before any strategy matters.**
   **Measured the same day (see the Week-1 forensics readout): CONFIRMED,
   and already fixed.** Leads hit four price generations — a 404'd GBP price,
   live GBP prices shown to US buyers, and June-USD prices. The warm pool is
   **25 pending leads, not 12**. The 8/31 re-pricing + resolver already
   repaired the pipe; the live hosted page is verified healthy (US$24.99,
   Apple Pay + card, zero console errors). Only the final payment attempt
   awaits the owner's live purchase. The recovery email's confidence is
   upgraded: we can honestly say "our checkout was broken when you tried;
   it's fixed."
4. **The honest timeline, stated plainly:** no composition on the board —
   even at full success — reaches $2,000/mo Stripe recurring before roughly
   mid-2027. The credible 90-day outcome is **$300–700/mo net**. Any plan
   that hides this is lying to its owner.
5. **Two facts nobody had examined (critic finds, adopted):**
   - **188 referral sessions/28d** — the second-largest external source,
     ~4× Bing+Google *combined*, origin and conversion never queried. (Found
     while grounding this plan: `source:'referral'` is a collapsed catch-all
     bucket for unrecognized referrers — `backend/app.js:10650` — breakable
     down via `referrerHostname`; see the Compression section's Week-1 item.)
   - **The job hunt can succeed.** No plan survives it unless a
     minimum-maintenance mode is designed (section below).

## The single most important unanswered question

**"Will any human who has already touched this product pay a single recurring
dollar?"** Mechanically: is the abandonment a defect (currency, old-account
price, payment methods, tag reflow) or absence of demand? Behaviorally: do
the 24 warm humans have recurring WTP for anything? Every MRR forecast on the
board assumes an answer. It costs **under 4 founder hours** to answer. Week 1
exists to answer it.

## Three engines

**Engine A — Warm humans (days).** 12 lifetime buyers (8 weekly-active) +
12 pending-checkout leads. Founder-voiced support@ email: "you started
checkout and stopped — price, payment method, or something broken? If you
still want it, I'll set you up directly." **A Stripe payment link in the
reply closes $499 sales without the possibly-broken checkout** — decoupling
warm revenue from the funnel defect. Forecast honestly: 0–2 conversions;
anything more is upside.

**Engine B — Founder-led B2B at high rungs (weeks).** Pro $499.99/yr and
Desk-as-quote-rung to finance newsletter writers and small RIAs, sold on
Filing Diff as the demo artifact (a hand-made redline of a company the
prospect covers IS the pitch — BamSEC/Hudson Labs are the only incumbents,
at institutional prices). **Warm-first:** the pending leads' own rung choices
(11 Pro/Pro-annual/Power/Desk selections) are the warmest B2B list that
exists. Cold pilot is **10 emails, not 100**, from a separate send identity —
never support@ (one spam flag poisons the reserved customer channel).

**Engine C — Marketplace → attach layer (continuous, BF as the event).**
Reviews (realistic 6–10 from a 12-buyer pool, not 25), listing v3 landing,
and **Black Friday 2026 (Nov 24–30) as the buyer-pool expansion event**.
Every code buyer enters an attach lifecycle at redemption. Intelligence
pricing decision (resolves the panel's subscription-vs-one-time split): a
**founding annual $149/yr Intelligence add-on** — one payment, the buying
behavior this pool has proven, zero year-1 churn, Stripe-recurring economics
that compound with pool size.

## Week 1 — diagnosis and unblocking ONLY (no builds, no cold outreach)

1. **Checkout forensics:** ownerless local test-mode run first
   (`DIRECT_LTD_TEST_MODE` pattern, `backend/app.js:650`), then owner live
   $24.99 purchase + refund. Plus 30-min read-only Stripe config audit:
   currency residue, payment methods, old-account price IDs, webhook grant
   path, tag reflow on the payment page.
2. **GA4 key events** (verify event names fire first — tag is
   runtime-injected; the same inspection likely fixes LCP 3.8s/CLS 0.36).
3. **Topup per-key PUT** (`STRIPE_PRICE_ID_CREDITS_TOPUP`; snapshot env,
   per-key only, never collection PUT) — a live SKU blocked by a minutes task
   is a defect, not backlog. (Revenue expectation: near zero — 146 credits/mo
   across 4 users in Aug — unblock it anyway.)
4. **Referral query:** where do the 188 referral sessions/28d come from, and
   do they convert?
5. **Two owner-approved support@ sends:** the 12 pending leads (Engine A
   copy + payment link) and the 8 active buyers (review ask, use-case
   framing). Reconcile `APPSUMO_REVIEW_EMAILS` (backup says 1, live says 0).
6. **AppSumo attribution ticket:** partner support on the 288 self-driven
   clicks + one tagged test purchase. The measured campaign already
   falsified the 90%-keep on our own clicks ($22–30/code net) — verify before
   booking a single dollar on "Keep 90%". **Do NOT reroute self-driven
   traffic to the direct-LTD rung** (worst trade on the board: the only 4.5%
   proven funnel into a 0%-completion checkout).

## Weeks 2–3 — demand validation before build (house rule applied to features)

7. **Filing Diff demand test:** hand-produce redlines for 2–3 active buyers'
   actual holdings; offer paid early-access ($49–99/yr or Pro upgrade) to the
   12 buyers; interview the 4 tier-3 $149 buyers on the Pro pitch and
   packaging. **Commit the full build only if 2–3 pay.** In the same window,
   measure the real build cost the house way: extractor on 10 real
   prior/current filing pairs, hand-verified — the June "~days" estimate is
   3 months stale; red teams price it 1–3+ weeks with gating and tests.
   **Measured since: Filing Diff is ALREADY built, live, and cached — 397
   real redlines in `filing_diffs`, newest 2026-08-31, endpoint
   `backend/app.js:7649` behind `authMiddleware, proGate`.** The "commit the
   build" question mostly disappears; the demand test still gates exposing
   it as a product.
8. **Payment links live for Pro/Desk** (built in minutes) — founder-led
   closes stop depending on self-serve checkout entirely.

## Weeks 3–6 — the engines at speed

9. **If (only if) demand validated:** Filing Diff ships with a **mandatory
   manual quality gate** before any redline reaches a professional — one
   hallucinated change in a writer's redline kills the wedge and the review
   harvest with it. BF backstop: if validation passes by early Oct it ships
   before Nov 24; if late, BF runs on reviews+v3+bonus tier and Intelligence
   becomes the Q1 attach. Never a half-shipped diff for BF.
10. **Intelligence attach layer:** founding $149/yr to the existing pool;
    attach sequence at every redemption; annual-default consumer headline
    after checkout is verified (a copy/config change judged by 8 weeks of
    first-party adds — no A/B; at 3 starts/mo an experiment frame is
    unpowered by two orders of magnitude).
11. **Warm-first B2B close-out:** payment-link closes with pending leads,
    then the 10-writer cold pilot (separate identity), scaled to 10–15/wk
    only if the pilot produces demos.

## Compression — what actually bends the timeline, and what can't

Owner question: *"is there any way to accelerate the revenue run rate and
compress the timeline?"* Answered by the second verification panel (4
adversarial verifiers on candidate levers + an idea generator; the refutation
pass was interrupted — CEO rulings applied to the generated ideas, below).
Two new measured facts came out of grounding it:

- **Filing Diff is already built, live, and cached** — 397 real redlines,
  newest 2026-08-31, endpoint at `backend/app.js:7649` behind `proGate`. The
  wedge is a gating/monetization task measured in **days**, not the 1–3-week
  build the panel priced.
- **The AppSumo engine is 85% marketplace-organic** (776 of 914 Aug
  `appsumo_outbound` clicks are `source=website` from the listing itself;
  x=92, bridge=16, newsletter=15, creator=8 — founder-controlled channels
  touch ~10%). So reviews + listing v3 are the levers on the dominant source
  — and that source does not scale with founder hours.

### What compresses (adopted — moves first dollars from ~week 4 to ~week 1)

1. **Payment links go out IN PARALLEL with checkout diagnosis, not after
   it.** Verifiers said "no lead email before a verified transaction" — but a
   Stripe payment link is a different mechanism from our checkout-session
   code path; it cannot inherit the suspected defect. Ruling: owner makes one
   live payment-LINK purchase (minutes, refund after) to prove the link
   path, then the 12-lead send goes out the same day diagnosis starts. This
   is the single biggest schedule compression on the board.
2. **Intelligence sells THIS WEEK as a manual SKU** — $149/yr price + payment
   link created in the Stripe dashboard, entitlement granted via the existing
   `scripts/grant-trial.js` pre-grant pattern, feature subset defined
   explicitly (Filing Diff + segments + briefing — NOT proGate-everything, so
   it doesn't undercut Pro $499.99/yr by 70%). No self-serve checkout build
   inside the window.
3. **Sample-first B2B: the demo is already written.**
   `backend/filing-monitor.js:330-400` emits materiality-scored executive
   briefs cached per accession — marginal cost per prospect is zero. Send
   prospects a finished brief on a company THEY cover, not a pitch. Expect
   0–2 closes from 20–30 sends (bounded).
4. **Ungated exemplar diff as the public demo** — one dramatic 10-K redline
   from the 397, free, shareable, machine-legible. Feeds Bing + the
   chatgpt/copilot citation channels that already refer sessions unbidden.
   Newest-diff-free, history/multi-symbol/watchdog gated behind Pro.
5. **Topup env PUT + attach at the two existing wall points** (Ask-cap
   message for license holders — the quota endpoint already exposes
   `changePlanUrl` for license rows; post-answer panel on the anon gate).
   Hours of work, pure margin, validates the payment path end-to-end.
6. **Show HN as the one launch circuit worth its hours** — lean version
   ~16–30 founder hrs, ungated diff demo as the hook, X thread same morning
   (Monday ~00:00 UTC best odds), 3–5 hrs live on-thread answering comments.
   Product Hunt deferred until 6–10 reviews + v3 live (wrong audience now,
   credibility/backlink play later; never same week as Show HN). Reddit fails
   by rule and category. **UTM capture into `marketing_attributions`
   (currently 0 rows) FIRST** — otherwise the one-shot spike teaches
   nothing. Never spike during the warm-outreach window.
7. **Affiliate engine — only after checkout is proven** (commissions on
   abandoned checkouts are $0). Real blocker first: `POST
   /api/affiliate/accept` returns an unconditional `verifiedPurchase` 409
   that blocks partner-kind profiles (`backend/app.js`; rate table
   `backend/affiliate-program.js:16-34`, partner eligibility :240-257,
   owner's 2026-08-26 partner override documented in
   `docs/AFFILIATE_PROGRAM.md`). First recruits: the 8 active buyers as
   ambassadors (they pass the purchase gate today) and deal-site publishers
   pointed at `destination=lifetime` (~$105 net vs ~$45 through the
   marketplace). Pitch "30% of first year" honestly — never "recurring".
   Recruit via founder personal email/LinkedIn only — never support@, never
   a cold blast from the domain.
8. **Time-boxed founding LTD sale** (if run): $39.99/$79.99/$149.99 — the
   tiers are already coded at exactly these; **never parity**
   (`assertPriceFloor`, `direct-ltd.js:163-184`, blocks parity at boot and
   at every checkout). 5–7 day window AFTER listing v3 clears review, banner
   off for appsumo.com-referrer sessions, funnel instrumented source-tagged
   so the direct conversion rate finally gets n > 3. The 12 pending leads
   stay OUT of it — full-price recovery at their chosen rungs is worth more
   recurring than the whole sale.

### What does NOT compress (the honest bound, unanimously)

- **The $2,000/mo recurring date itself.** The warm pool at an impossible
  100% conversion is ~$8–9k ARR ≈ $700/mo recurring — under half the target.
  $2,000 needs ~4 Desks or ~48 Good-monthly equivalents; no measured pool
  produces that, so it stays 9–15 months conditional on B2B converting.
- **Founder hours past ~2×:** measured multiplier is ~1.2–1.6× revenue, not
  2× — and most of that is pull-forward of bounded tasks (schedule change,
  not trajectory change). Marketplace-organic traffic, review accumulation
  past the ask, the BF calendar (fixed Nov 24–30), and v3 approval are all
  outside founder-hours control.
- **Going full-time now:** 90-day outcome of a full-time sprint ≈
  $400–900/mo total cash vs $300–700 part-time — a $100–300/mo delta that
  any salary out-earns. Ruling: **a 2–3 week part-time burst executing the
  compression moves, then the gate.** Full-time is justified only if the
  gate trips (checkout verified converting + B2B showing a real reply rate),
  and any sprint is framed as **running through Black Friday**, not an
  open-ended 60–90 days. B2B conversion is the one mechanism where 40 hrs/wk
  could matter — and it is completely unmeasured (0 affiliate rows, 0
  attributions, no reply data), so test it at 25–50 contacts before betting
  the job hunt on it.
- **Killed (CEO ruling):** rerouting the 776 listing-organic clicks to a
  direct-LTD parity page (generator idea). AppSumo's terms likely prohibit
  steering listing-referred traffic off-marketplace; it trades 13 verified
  sales for possible listing termination of the only paying channel. Dead
  unless a terms review says otherwise — and even then, a BF-window option
  only.

**Compressed milestones:** first Stripe dollar: **week 1** (payment link,
not week 4). Intelligence first attach: week 1–2. $300–700/mo net: ~day 30–45
(pull-forward), not day 90. $2,000 recurring: unchanged, 9–15 mo — the only
mechanisms that bend it are pool-expansion events (Show HN spike, BF, v3 +
reviews), each of which multiplies the attach base, and the B2B reply rate,
which is the thing to go measure.

## Stop doing — unanimous panel consensus, adopted as policy

- **Zero founder hours on Google SEO** beyond the two <1-day zero-click
  fixes. Position 39, 0.2% CTR, 5 clicks/month.
- **No paid ads, permanently**, until organic direct converts. Finance CPCs
  $3–10 vs $24.2/mo net and a 0% funnel.
- **No revenue planning against Desk self-serve** — it is a quote rung for
  founder-led sales or it does not exist.
- **No free tool #31.** Point the existing 30 at the AppSumo landing instead.
- **No consumer-funnel scale spend** before the first non-owner dollar.
- **No GA4-as-decision-source** before key events exist; first-party
  human-filtered stays the truth.
- **AppSumo one-time run-rate reported as a separate line** from Stripe MRR,
  never conflated.
- **No cold email from support@** — ever.

## $2,000 composition and the honest path

| Horizon | Net/mo | Composition (assumptions stated) |
|---|---|---|
| 90 days | **$300–700** | 1–3 warm/B2B closes + attach trickle + marketplace ~$80–150 run-rate |
| ~6 mo | $800–1,500 | 8–12 B2B (10% reply/30% close founder-led norms) + 10–20 Intelligence + consumer floor |
| 9–15 mo | **$2,000 recurring** | ~20 Pro-annual ($816) + ~6 Desk-equivalents ($978) + ~30 Intelligence/annual subs (~$300+) + consumer floor $200–500 |

$2,000 without B2B is not credible on these numbers. Mid-2027 consumer-only
is the honest bound. Re-forecast monthly from first-party adds/churn.

## $5K / $10K and asymmetric upside

**$5K (8–12 mo):** the $2K mix scaled — 20–25 B2B accounts ($2,000–3,300),
Intelligence on a BF-grown pool, consumer ceiling $500–1,200, AppSumo toward
45 codes/mo (~$990 one-time run-rate). Requires ~1 B2B close/wk sustained.

**$10K (12–18 mo): NOT reachable at 15–25 hrs/wk on current architecture.**
Requires multi-seat firm pricing ($2K base + $500/seat; 25–30 firms ≈ $5K/mo)
or full-time founder hours. Plan the first hire or the job decision against
it.

**Asymmetric bets, ranked:** (1) one firm-level Desk deal = months of
consumer MRR — and the US RIA list (Form ADV/IAPD) is public and free;
(2) BF 2026 — the one event that can 10–25× the buyer pool in a week;
(3) AI-assistant citations — chatgpt/copilot already refer 2–4 sessions/wk
each, unbidden, free, growing, while Google is dead; keep top pages
machine-legible (SSR facts, llms.txt); (4) buyer-affiliates from the 8 active
enthusiasts; (5) the referral channel, pending the week-1 query.

## Kill criteria

- **Consumer:** checkout verified + ≥10 gate emails + warm replies in, and
  still 0 paid at day 28 → direct goes LTD-first; consumer gets zero further
  build.
- **Filing Diff:** fewer than 2 of 12 buyers pay early-access → no product
  exposure; it stays a concierge/demo artifact only.
- **Cold B2B:** 10-writer pilot produces 0 demos → cold outreach dropped,
  warm motion only.
- **Reviews:** <6 reviews by mid-Oct → BF plan assumes current rank, no
  velocity uplift.

## Risks the plan carries (CEO must own these)

- **AppSumo single point of failure** — hedge (second marketplace) only if
  BF underdelivers; don't spend now.
- **Regulatory/liability:** YMYL AI research sold to regulated RIAs — a
  one-time disclaimers/ToS pass BEFORE the B2B push; no advice-adjacent
  claims in outreach.
- **AI-supplier concentration:** the only real marginal cost and the whole
  Intelligence line depend on one supplier; never surface its identity in
  any B2B material or demo.
- **Churn is unmeasured** — annual-everywhere bias until a cohort exists.
- **Substitution:** AI assistants answer "what changed in NVDA's 10-Q" for
  free — the moat is source-linked verifiability, not the diff concept.

## Minimum-maintenance mode (if the job hunt lands)

Designed so the business survives 0–5 hrs/wk:

**Keeps running unattended:**
- The anon ask gate and its email capture (already shipped; the funnel
  accumulates leads with zero effort).
- The Filing Diff cache — the generator keeps computing diffs on new filings;
  whatever is exposed stays fresh with no work.
- The affiliate attach lifecycle for buyers (automated emails, if enabled).
- AppSumo marketplace-organic engine (85% of clicks, zero founder input).
- BF offer, if pre-built in October (banner + pricing set ahead of Nov 24).

**Explicitly abandoned in this mode:**
- Cold B2B outreach (hours-hungry, unmeasured).
- Consumer-funnel conversion work (no build, no scale spend).
- Google SEO, any new free tools, any new channels.
- Intelligence manual closes (founder-time per sale).

**One weekly 1-hour ritual:** check Stripe + DB `subscription.status`,
forward any support@ replies to the owner, confirm the marketplace engine
didn't stall. Everything else is read-only monitoring.

## Execution split

**Me (week 1, mostly):** local test-mode checkout run; read-only Stripe
config audit; GA4 key events + tag fix; referral-channel query; payment
links; review-ask + pending-lead email drafts; AppSumo attribution ticket
draft; strategy doc; minimum-maintenance mode (above); Filing Diff
demand-test kit (concierge redlines for 2–3 buyers).

**Owner gates (approve/act):** live $24.99 purchase+refund · the two support@
sends · `APPSUMO_REVIEW_EMAILS` + topup per-key PUTs (env snapshot first) ·
listing v3 chase (already with AppSumo) · cold-pilot send identity · every
git push + Render deploy watch · BF offer.

---

## Appendix A — panel contradictions and CEO rulings

| Contradiction | Ruling |
|---|---|
| Reroute self-driven traffic to direct-LTD vs fix attribution first | **Don't reroute.** The only 4.5%-proven funnel into a 0%-completion checkout is the worst trade on the board. Fix attribution, verify rates, then decide. |
| Desk rung: sell now vs hold | **Quote rung only.** Founder-led closes with payment links; no self-serve revenue planning against it. |
| Intelligence: subscription vs one-time | **Founding annual $149/yr.** One payment matches proven buyer behavior; recurring economics compound with pool size. |
| Pricing A/B test on the consumer rung | **No.** At ~3 checkout starts/mo the frame is unpowered by two orders of magnitude. Judge copy/config changes by 8 weeks of first-party adds. |
| Filing Diff: build now vs demand-gate | **Demand-gate, with BF backstop** — but measured since: it's already built, so the question is exposure/packaging, not build. |
| Cold outreach volume | **10-writer pilot, separate send identity.** Never support@. Scale only on demos. |
| Review target | **6–10 from the 12-buyer pool, not 25.** Anything more needs a bigger pool (BF). |
| Full-time founder sprint now | **No — 2–3 week part-time burst, then the gate.** Measured multiplier of 2× hours is ~1.2–1.6× revenue. |

## Appendix B — compression-panel rulings (2026-09-01)

The generator produced 6 ideas; the refutation pass was interrupted. CEO
rulings:

1. **Fix checkout / convert the 12 pending carts** — adopted; it IS week 1.
   Modification: payment-link sends run in parallel (Compression #1).
2. **Ship the invisible $14.99 topup rung + attach at two wall points** —
   adopted as-is (hours-scale, pure margin).
3. **Sell Filing Diff / Intelligence to the 13 buyers now** — adopted as
   Compression #2 (manual SKU this week). One check flagged: confirm which
   URL the license row's `changePlanUrl` carries so AppSumo buyers' upgrade
   path doesn't route through AppSumo's cut unintentionally.
4. **Un-gate the 397 diffs as indexable "what changed in TICKER" pages** —
   adopted in bounded form (Compression #4: newest-diff-free exemplar).
   Full 397-page indexing deferred — a low-authority domain may not carry
   it, and giving away the headline feature needs the newest-free/history-
   gated mitigation.
5. **Direct-LTD parity page for listing-organic clicks** — **KILLED.**
   Marketplace-terms risk to the only paying channel; see Compression.
6. **Sample-first B2B with precomputed filing briefs** — adopted as-is
   (Compression #3).

All 4 verifiers independently gated every lever on the same first step:
**fix and verify the checkout before any sale exists.** The only accepted
exception is payment links, whose mechanism is independent of our checkout
code path.

## Appendix C — 14-day re-forecast protocol

At day 14 (≈ 2026-09-15), re-forecast from first-party data only:
- checkout start→complete rate after the fix (the n=3 statistic finally
  gets replaced);
- replies and conversions from the two support@ sends, per rung;
- Intelligence attach rate on the 13-buyer pool;
- gate email capture rate vs the 8/31 baseline (18 asks → 1 email);
- referral-channel composition (the 188 sessions/28d, broken down);
- AppSumo codes since 9/1 and review count.
Compare against the 90-day $300–700/mo composition; update the $2,000
composition table with measured rates, not panel norms.