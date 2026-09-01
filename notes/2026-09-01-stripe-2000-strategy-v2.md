# Strategy v2 (post-antagonist-review) — $2,000/mo Stripe MRR + max AppSumo/other revenue

> Saved 2026-09-01 at owner request. This is the reviewed-and-fixed v2 plan
> (conversion-first, direct-funnel-centric). A more aggressive CEO-level v3
> strategy supersedes it for execution decisions — see
> `2026-09-01-stripe-2000-strategy-v3.md` (when written). v2 remains the
> reference for the antagonist-review findings and the direct-funnel repair
> mechanics.

## Context

All measured figures from `prod-main/notes/2026-09-01-ceo-state-of-business.md`
(2026-09-01). Goal: **$2,000/mo MRR through Stripe**, AppSumo/other revenue
maximized on top. This is v2 — holes found in self-review are fixed here, and
the fixes are flagged **[fix]** so the delta from v1 is visible.

**Diagnosis (measured):**

1. Stripe: **$0 MRR ever, 0 payouts, 100% checkout abandonment** — but that rate
   rests on **3 human checkout starts/28d** (Clarity's sample: 1/30d). n=3:
   price, payment-method, and social-proof explanations are indistinguishable.
   12 users in `subscription.status: pending` = highest-intent direct leads.
2. Only proven willingness-to-pay: one-time LTD (AppSumo codes, 4.5%
   click→buy, net $22–$30/code — 90% rate is partner-driven only).
3. Anon ask gate (live 9/1, 1 day): 44 views → 18 asks (41%) → **2 walls → 1
   email**. Wall rarely triggers by design; scaling capture means raising it,
   which attacks the try-rate. One day = noise; it is a dial, not a machine.
4. Ladder live: Good $24.99/mo · $199.99/yr · Pro $499.99/yr · Desk
   $1,999.99/yr (never sold — don't plan against it) · $14.99 topup ·
   direct-LTD enabled (price-floored at AppSumo rates). Front door + ask floor
   shipped 9/1 (stamp `20260901-askfix1`).
5. Product wedge designed, unbuilt, estimates stale: pricing doc
   (2026-06-12) ranks Filing Diff (~days) and smart alerts (~days) — written
   before the Jobs cut; **re-estimate against today's codebase before
   committing dates.** WTP evidence is Reddit/Bogleheads research, not our
   12 buyers. Competitor snapshot 3 months old — re-check before shipping.
6. Search is Bing-only (~10 clicks/wk ≈ 5% of traffic); Google ~5 clicks/mo
   at position ~39 (page 4). WAB family 1,400 impr/28d 0 clicks = position
   problem, not page-count problem.
7. **[fix] Honest denominator:** 850 "human" sessions includes **internal
   243**; GA4 cities (Singapore 98/7d, China DCs) show DC residue survives
   the filter. Addressable external traffic ≈ **500–660/mo (~20/day)**.
8. UX: LCP 3.8s + CLS 0.36 — **[fix]** prime suspect is the runtime-injected
   GA4/Clarity tags; the measurement fix and the perf fix may be one fix.
9. GA4: 0 key events configured. **[fix]** Marking a key event assumes the
   event name actually fires (tag is runtime-injected, unverified) — verify
   event names exist before marking.
10. Env discrepancy: backup `APPSUMO_REVIEW_EMAILS=1` vs 0-at-deploy per brief
    — reconcile live value at next deploy window.

## The strategy in one line

Prove the pipe ownerless first, then buy the first non-owner Stripe dollar in
~2 weeks with a full-price recovery email + social proof; ship the Filing-Diff
wedge that justifies $24.99; grow paid adds from the ask-gate email rung and
**re-forecast monthly from measured adds and cohort churn** — with an explicit
kill criterion if direct demand doesn't appear; run AppSumo (reviews → rank →
BF spike) and direct-LTD as parallel one-time revenue.

## Phase 0 — Prove the pipe, then first dollar (weeks 1–2)

1. **[fix] Ownerless end-to-end checkout test FIRST, today:** local run of the
   real backend in test mode (the `DIRECT_LTD_TEST_MODE` pattern at
   `backend/app.js:650`, separate Stripe test account + 4242 test card) —
   verify session create → pay → webhook → plan-grant → receipt. Only after
   that passes does the owner do one **live** $24.99 purchase on prod (own
   card, refund after). Owner appears once, not three times, on this path.
2. **Checkout diagnosis (me, read-only)**: Stripe account config via API
   (payment methods — cards only? Link? PayPal? — currency residue, tax,
   session expiry) + code trace of the subscription webhook/grant path. With
   n=3 abandonment this can find nothing — if it finds nothing, the suspects
   move to price and social proof, which Phases 1–2 address.
3. **[fix] Recover the 12 pending leads at FULL PRICE first:** one plain
   support-channel email (`/admin/messages` → support@, owner approves before
   send): "you started checkout — what stopped you?" plus a 7-day reply
   window. **No discount, no LTD offer in email #1** — the 12 are the only
   near-term recurring cohort; discounting them into grandfathered $6.5/mo
   annuals or one-time LTDs cannibalizes exactly the MRR this plan exists to
   build, and a taken discount teaches us nothing about why full price failed.
   Fallback offer (Good-annual founding lock) only for non-responders, as a
   measured second send. Verify the 12 are real humans first (bot-flag,
   signup recency, email verified) before counting on them.
4. **[fix] Social proof on the direct surface (days, not weeks):** surface the
   5.0-taco AppSumo listing badge + 2–3 buyer quotes on /upgrade.html and the
   pricing page. A bare $24.99 checkout with category-wide billing distrust
   and zero proof is a first-order abandonment suspect; we already own the
   proof. Also inspect the runtime tag injection (measurement + LCP/CLS in
   one pass); GA4 key events only after confirming the event names fire.

**Gate M1 (2 wks): local pipe test passed · owner live purchase done · 12-lead email sent · social proof live. First non-owner Stripe dollar is the target, not a promise.**

## Phase 1 — The wedge that justifies $24.99 (weeks 2–6, parallel)

1. **Re-estimate Filing Diff + smart alerts against today's codebase** (the
   "~days" is a June estimate) — then build in this order: **Filing Diff**
   (Pro; watchdog + cached extraction already exist) → **smart fundamental
   alerts** (Good/Pro; Form 4 parser exists). Alerts double as the retention
   engine. Quick competitor re-check (3-month-old snapshot) before shipping.
2. New ladder story: free = data + metered Ask; Good = tracking + alerts;
   Pro = Filing Diff + 300 Ask. Today $24.99 buys "more of the same" — that's
   the fix.
3. If full-price checkout is verified working AND the 12-lead replies point at
   price: use the existing `backend/pricing-experiment.js` machinery to test
   Good price points rather than guessing.

## Phase 2 — Conversion machinery (weeks 3–8)

1. Watch the ask gate **14 days** vs the 8/31 baseline; treat wall-frequency
   as an explicit value-vs-capture experiment (raise wall → measure try-rate
   cost vs email gain). Re-forecast from measured emails→trial→paid, never
   from day-1 numbers.
2. Verify the ask floor is on the top SEO pages (TSLA EPS, AAPL price,
   net-income) and watch 7d bounce fall from 100%.
3. Fix LCP/CLS (likely the same fix as tag injection).
4. **[fix] Demoted to background:** WABTE page + title/CTR pass is content
   maintenance, not a lever — position ~39 on Google won't move because we
   published one page, and Bing's entire contribution is ~5% of traffic. Do
   it only if it costs < a day.

**Gate M2 (6 wks): ≥5 Stripe subs or a named, evidenced reason why not · 10+ AppSumo reviews · listing v3 live.**

## Phase 3 — AppSumo & other revenue (continuous)

1. **Review harvest 1 → 10+** (usage-gated in-app prompt, 8 active buyers;
   reconcile the review-emails env flag — backup says 1, live says 0).
2. **Land listing v3** (in review with William).
3. **Black Friday 2026:** plan by mid-Oct. **[fix]** Model it honestly: BF
   sales are marketplace-sourced (net $22–30/code, not 90%) and a one-month
   **spike**, not a run-rate — e.g. +10–20 codes ≈ +$250–500 in the month,
   then back to baseline.
4. **Direct-LTD founding rung** for AppSumo-season traffic and the 12-lead
   non-responders (already enabled, price-floored). One-time revenue — counts
   toward "other," never against MRR.
5. **$14.99 topups** as margin attach (verify
   `STRIPE_PRICE_ID_CREDITS_TOPUP` present in Render at next deploy —
   per-key PUT only, never collection PUT).

## Phase 4 — Retention (from month 1, not month 3) **[fix]**

There is zero churn history. From the first subscriber: instrument cohort
retention in first-party events, bias the mix **annual-heavy** (year-1 churn
≈ 0, cash upfront) until measured churn says otherwise, and ship the
alerts/briefing retention engine with Phase 1 — it must exist before
subscribers have a chance to leave, not after.

## **[fix] Kill criterion (the failure branch v1 lacked)**

If by **week 8**: pipe verified end-to-end, social proof live, ≥10 emails
captured from the gate, 12-lead replies in — and **paid conversions are still
0** → conclude direct demand at $24.99/mo is unproven-to-absent. Pivot: run
the site LTD-first (direct-LTD already enabled), keep AppSumo as the primary
channel, and re-think the ladder (pricing-experiment machinery) instead of
pushing the same price harder. State this date in the strategy doc and hold
to it.

## Milestones — targets, not forecasts **[fix: assumptions stated, re-forecast monthly]**

| Checkpoint | Target | Stated assumption (re-forecast at each step) |
|---|---|---|
| M1 · 2 wks | first non-owner $ | pipe works; 12 leads yield ≥1 full-price buy |
| M2 · 6 wks | ~5 subs · 10 reviews | ≥3% checkout→paid on small n; gate ≥10 emails/mo |
| M3 · 3 mo | ~$150–300 MRR | ~3–5 adds/mo hold; Filing Diff shipped |
| M4 · 6 mo | ~$500–1,000 MRR | ~5–8 adds/mo; churn ≤7% measured |
| M5 · 9–18 mo | **$2,000 MRR** | ~8 adds/mo at blended ~$27 net (~50 Good-mo + 25 Good-annual + 10 Pro) on **~600 external sessions/mo = ~1.3% session→paid**, churn ≤7% (at 10% churn the date roughly doubles) |

Every M3+ figure is an **assumption-driven target**, re-forecast monthly from
measured adds/churn. The 1.3% session→paid figure is 2–4× typical consumer
SaaS — that gap is the plan's biggest known risk, and it is why the kill
criterion exists.

## Execution split

**Me:** local test-mode checkout run + report, strategy doc, read-only Stripe
diagnosis, recovery-email draft, social-proof patch (local + verify; deploy =
git push + Render watch per deploy memory), GA4 event-name verification +
key events, ask-gate 14-day report, funnel/cohort reports, BF model, WABTE
page only if <1 day.

**Owner gates (approve/act):** live $24.99 purchase (once, after local pass)
· 12-lead email send · listing v3 submission (already with AppSumo) ·
review-emails flag flip · Render env PUTs · git pushes · BF offer · any
discount fallback to the 12.

## Deliverables

1. `prod-main/notes/2026-09-01-stripe-2000-strategy.md` — this strategy,
   expanded, with the antagonist-review appendix (holes found + fixes).
2. Local test-mode checkout verification report (same day).
3. 12-lead recovery email draft (full price, owner approves, support channel
   only).
4. GA4 event-name check + key-event config.
5. HANDOFF.md updated (<160 lines) with strategy pointer + owner-gate list.

## Verification

- Every measured number carries source + date; **all projections are labeled
  as assumptions with re-forecast dates**; no secret values printed; AI-provider
  identity never surfaces.
- All external calls read-only except: GA4 key-event config (owner's account,
  visible) and the support email (owner-approved before send).
- Cross-checks re-run at each milestone: Stripe statuses vs DB
  `subscription.status`; monthly funnel report
  (`scripts/generate-daily-funnel-report.js`); the 13=13 license↔order match
  already holds.