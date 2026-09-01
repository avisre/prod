# Handoff

## STRATEGY v3 APPROVED — the operating plan (2026-09-01)

`notes/2026-09-01-stripe-2000-strategy-v3.md` (supersedes v2 —
`notes/2026-09-01-stripe-2000-strategy-v2.md` kept for checkout mechanics).
Three engines: **warm humans** (payment links, sent IN PARALLEL with checkout
diagnosis) · **founder-led B2B** at Pro/Desk (sample-first: cached filing
briefs as demos) · **Intelligence founding $149/yr** attach on the AppSumo
pool (manual SKU week 1: price + payment link + `scripts/grant-trial.js`
grant; feature subset = Filing Diff + segments + briefing, never
proGate-everything). Consumer $24.99 rung = life support only ($300–700/mo
ceiling). Honest bound: $2,000/mo recurring 9–15 mo, conditional on B2B
converting; 90-day realistic $300–700/mo net. Full-time founder hours only
if the gate trips (checkout verified converting + B2B reply rate real);
any sprint framed as running through Black Friday (Nov 24–30).

Key measured facts: Filing Diff **already built** (397 cached redlines,
endpoint `backend/app.js:7649` behind proGate); AppSumo engine **85%
marketplace-organic** (776/914 Aug clicks source=website) so reviews + v3 are
the levers, not founder hours. Affiliate blocker: `POST
/api/affiliate/accept` unconditional verifiedPurchase 409 blocks
partner-kind profiles.

Week-1 (diagnosis + unblocking only): local test-mode checkout
(`DIRECT_LTD_TEST_MODE`, app.js:650) → owner live purchase; Stripe config
audit (GBP residue, old-account price `price_1ShhUd…`, payment methods);
GA4 key events (verify event names fire first — also likely fixes LCP 3.8s /
CLS 0.36); topup per-key PUT; referral query; two support@ sends (12 pending
leads + 8-buyer review ask) after ONE live payment-link purchase+refund;
AppSumo attribution ticket. Kill criteria + 14-day re-forecast protocol
(2026-09-15) in the doc's Appendices.

**WEEK-1 FORENSICS DONE (2026-09-01, ownerless) —
`notes/2026-09-01-week1-checkout-forensics.md`:**
- **Abandonment explained**: Aug leads hit FOUR price generations — 3 leads
  got a **404 price** (`price_1U7kok…`, GBP £9/mo, not on current account),
  2 more were shown GBP £7/£9, rest hit June-USD prices. The 8/31 re-pricing
  already fixed the pipe; live session + hosted Stripe page verified healthy
  (US$24.99, Apple Pay + card, 0 console errors).
- **Warm pool is 25 pending leads, not 12** (10+2 monthly, 5 pro, 1+4
  pro-annual, 1 annual, 1 power, 1 desk) — all signed up in August. Rung
  mapping in the readout; desk lead = founder-led close.
- **Referral bucket resolved**: 74% is owner-local testing (localhost/
  127.0.0.1); real external ≈ 60–70 sessions/mo (appsumo.com 41, t.co 16,
  yahoo 10, github 7, copilot 6, betalist 5, checkout.stripe.com 5). No
  hidden channel.
- `STRIPE_PRICE_ID_*` env keys ABSENT from env backup — add all 5 to the
  per-key PUT list at next deploy.
- Email drafts: `notes/2026-09-01-week1-email-drafts.md` (25-lead recovery +
  8-buyer review ask; owner approves, support@ only, after live payment-link
  test).
- Filing Diff kit: `notes/2026-09-01-week1-filing-diff-demand-kit.md`
  (TSLA/UPS/FDX exemplar briefs, early-access copy, B2B sample template,
  verification checklist; public exemplar = TSLA).

## CEO state-of-business — COMPLETE (2026-09-01)

Brief: `notes/2026-09-01-ceo-state-of-business.md` — every number measured,
sources named. Headline: **direct channel never converted ($0 MRR ever,
0 payouts, 100% checkout abandonment on n=3); AppSumo only paying channel**
(13 codes, net $22–30/code, next payout $152.86; listing v3 still in review).
GA4 0 key events; Google ~5 clicks/mo vs Bing ~10/wk; Clarity LCP 3.8s /
CLS 0.36; funnel 850 sessions → 3 checkouts → 0 paid; 12 warm leads in
`subscription.status: pending`.

**Headed-browser session recipe**: real snap Brave against profile clone
`/tmp/ceo-collect/brave-clone/Brave-Browser` (rsync of
`~/snap/brave/current/.config/BraveSoftware/Brave-Browser`, caches excluded),
`--remote-debugging-port=9333`, DISPLAY=:0. Owner logs in themselves (2SV).
Raw dumps: `/tmp/ceo-collect/*.txt`. AppSumo portal subpages 404 at guessed
URLs — nav is JS-rendered; click through.

## SHIPPED — production live on the new ladder (2026-09-01)

`2cd178c1` + `74a7fdab` on `avisre/prod` main; Render deploy
`dep-daav5ecs728c73e8udsg` live, verified (stamp `20260901-askfix1`, all 5
ladder cards, /upgrade /recharge /monitor 200). Boot-crash root cause:
`yahoo-finance2` devDep required unconditionally at app.js:17 — moved to
`dependencies`. Suite 411/411. Emailed William (review-eligibility +
in-review check + v3 heads-up). Nothing submitted to the portal — owner's
call.

## LOCAL-ONLY builds — RESOLVED 9/1: all already on origin/main

Diff of the local tree vs origin/main (9/1) proved the ladder, topup wiring,
front door, hero rebuild and ask caches were ALL in the 8/31 pushes
(`2cd178c1`+`74a7fdab`) and are live. Earlier "awaiting one combined push"
framing was stale — no code was ever unpushed. Only docs/lockfile were
behind: pushed as `7ee7dbf` (6 notes docs + HANDOFF + package-lock.json
with yahoo-finance2 correctly out of devDependencies — prevents the next
Render build from repeating the 8/31 boot crash). Remaining for owner:
E2E on :4001 + trigger the deploy (env changes from #7 activate at it).
The build list below is kept only as a ship log:

- **Four-rung ladder** (Good $24.99/mo, Good-annual $199.99/yr, Pro
  $499.99/yr, Desk $1,999.99/yr; Enterprise contact rung; sell-order mask).
  Tests: `pricing-ladder.test.js` + `/tmp/ladder-check/check.js` (24/24).
  Stamp `20260831-ladder1`→`20260831-menu4`.
- **$14.99 topup wired** (price exists). RENDER LACKS IT: per-key PUT
  `STRIPE_PRICE_ID_CREDITS_TOPUP=price_1UAUOtAUeKapY1OPUcSIaloi`.
- **Front door**: anon gate on, email rung (`AskTrialLead`,
  /api/ask-trial/*, sp_ask_bonus +2), ask floor on SEO surfaces. Stamp
  `20260901-sales1`. Tests `anon-ask-trial.test.js` (7). Baseline
  `notes/2026-09-sales-funnel-baseline.md`.
- **Landing hero rebuild** (`#home-try` 3-free demo card), Compare Beta chip
  (stamp `20260901-beta1`), ask-latency caches (peer_context 35.2s→2.4s;
  `ASK_WARM_TICKERS` suggested `NVDA,AMD,INTC,AAPL,TSLA,V,MA`), landing ask
  box no-reflow (`20260901-askfix1`).
- **Six feedback decisions (8/31)** in `docs/product-principles.md`;
  `docs/appsumo-listing-v3.md` draft ready — WATCH caps 1/2/6 vs shipped
  grant 12/40/∞, owner must reconcile.

## Owner actions pending

1. Owner logged in to gh 9/1; docs+lockfile pushed as `7ee7dbf`. **Owner:
   trigger the Render deploy** (flip avisre/prod public → deploy → flip
   back). All env PUTs (#7) activate at this deploy. Auto-deploy on push is
   broken — deploy must be triggered manually.
2. Owner E2E locally on :4001 (upgrade ladder, compare beta, front door).
3. **Strategy Week-1 owner gates — REMAINING:** (a) live payment-link
   purchase+refund (links created 9/1: Good-mo/Good-annual/Pro, verified
   rendering; preview email sent to the admin account); (b) live $24.99
   checkout+refund (last unverified link in the pipe).
   **Sends are DONE (9/1, owner-approved): 38/38 accepted via
   /api/admin/messages — 25 lead recoveries + 12 buyer review asks + 1
   preview; watch replies in /admin/messages.**
4. Revoke old PAT; rotate Bing key (`~/.local/share/secrets/bing_webmaster.txt`).
5. AppSumo listing v3 submission owner's call; review harvest to 6–10
   (review-ask emails WENT OUT 9/1 to all 12 buyers).
6. Strategy gate at day 14 (≈2026-09-15): re-forecast per Appendix C of v3.
7. **Render env PUTs DONE 9/1** (owner provided API key; per-key PUT only).
   Audited all 65 live keys against the code: all five STRIPE_PRICE_ID_* were
   ALREADY CORRECT — incl. PRO=`…KtXHogz4` ($79.99/mo): `pro` is the RETIRED
   rung (app.js:499, upgrade.html:79); featured Pro $499.99/yr = planId
   `pro-annual` → PRO_ANNUAL key. (This list previously said PUT
   PRO=dN21eUjX — WRONG, would have broken the retired rung.) PUT this
   session, both re-GET-verified: ASK_WARM_TICKERS=NVDA,AMD,INTC,AAPL,TSLA,V,MA
   and APPSUMO_REVIEW_EMAILS=0 (owner's 8/31 decision; manual asks already
   sent to all 12 buyers — leaving it on would double-ask).
   DESK/PRO_ANNUAL_PLAN_PRICE already live. Changes apply at NEXT deploy.
8. **Rotate secrets exposed in chat 9/1** (env snapshot pasted into the
   session): STRIPE_SECRET_KEY, SMTP_PASS, JWT_SECRET, GOOGLE_CLIENT_SECRET,
   AI keys — at the next deploy window, snapshot first.

## Render / deploy mechanics

- Render cannot clone private repo: flip `avisre/prod` public → deploy → flip
  back. First build sometimes no-error `build_failed` ~50s — retrigger.
- **Render env: per-key PUT only, never collection PUT** (8/31 incident).
- Stamp ritual: any `frontend-v2/assets/*` or `system.css` edit ⇒ new `?v=`
  on ALL pages + server-rendered (free-tools.js, comparison-pages.js,
  seo-pages.js, app.js, affiliate-dashboard.html) + pinning tests.
- Local tree LAGS GitHub on README, workflows refresh-fundamentals.yml,
  docs/, 504 frontend/data/fundamentals/*.json — do NOT copy those back.

## Working rules

- Node v22: `~/.nvm/versions/node/v22.22.0/bin/node` (PATH node is v18);
  tests from `backend/`; deps in `backend/node_modules`; no `rg`;
  subagents/workflows WORK here now (env-facts memory corrected 9/1).
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