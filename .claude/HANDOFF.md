# Handoff

## Customer-thread bug pass (2026-09-02) — local, rides the next deploy

From the gattomorto77 website-interaction thread. Stamp → `20260902-navfix1`
(all pages + server-rendered + pinning tests). Ships at the owner's next
deploy trigger (same one pending for `3bf46b0` screener bands).

- **AppSumo tier-3 (Pro) = top tier → only the $14 AI-credit recharge.**
  Root cause was deeper than the frontend: `/api/session` never returned
  `appsumo`, so EVERY AppSumo branch in nav/upgrade.html was dead code and
  tier-3 buyers fell through to the full ladder. Session now mirrors the
  quota payload `{isAppSumo, tier, upgradeUrl}`; upgrade.html + nav tray
  gate tier 3 to the highest-tier/Recharge copy. Tiers 1/2 keep the AppSumo
  upgrade link (now actually live — 429 Ask wall already excluded tier 3).
- **Nav Messages badge** no longer renders as literal `<span>` text
  (row() escaped the whole label; badge is now a raw-suffix param).
- **Unread badge vanished on profile load**: messages.js fetched the thread
  on page load, which zeroes `userUnread` server-side before the section is
  opened. Fetch now deferred to first open of #messages-details (inbox.html
  unchanged; the #messages-details deep link still works via the toggle
  event).
- **Perf (slow profile + slow admin thread click)**: boot-time
  `ensureMeteringIndexes()` — credit_ledger {userId,month,at:-1} (was 3
  COLLSCANs per /api/credits, a nav hot path), ai_chat_usage {userId,month},
  personal_memory {userId}. Admin thread click updates the clicked row in
  place instead of re-running the full customer-directory scan.
- Diagnosed but NOT shipped (bigger surgery, deferred): authMiddleware
  fetches the full ~140-field User doc (and may save it) on every authed
  request (~7× per profile page load); no User.createdAt index for the
  admin directory sort.
- After deploy: reply to gattomorto77 from support@ via /api/admin/messages.

## Monitor cap v2 (1/4/8) SHIPPED DARK (2026-09-02)

`MONITOR_CAP_V2_EFFECTIVE_FROM` is **blank** — code is inert, everyone still
gets 12/40/∞. Setting it starts 1/4/8 for redemptions from that moment; earlier
buyers are grandfathered permanently by redemption date. Cap + label + watchlist
gate all resolve from `lib/tier-limits.js` (`monitorCapLabel`,
`wouldExceedMonitorCap`); the redemption email and profile page no longer
hardcode the ladder — that drift would have promised "unlimited" to a capped
buyer. Cache stamp → `20260902-monitorcap1`. Full suite 434/434
(`direct-ltd-affiliate` is order-flaky, passes in isolation). No AppSumo
approval needed: nothing is taken from an existing buyer.

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
- **Abandonment explained**: FOUR price generations — a 404'd GBP price,
  live GBP prices shown to US buyers, June-USD prices; 8/31 re-pricing
  fixed the pipe; hosted page verified healthy (US$24.99, 0 errors).
- **Warm pool 25 leads, not 12** (→ ~6 REAL humans; rest owner-test
  signups — see reply-wave note). Rung mapping in the readout; desk =
  founder-led close.
- **Referral bucket**: 74% owner-local; real external ≈60–70 sessions/mo
  (appsumo.com 41, t.co 16, yahoo 10, github 7). No hidden channel.
- `STRIPE_PRICE_ID_*` env keys ABSENT from env backup → DONE 9/1, see #7.
- Drafts: `notes/2026-09-01-week1-email-drafts.md` (SENT 38/38).
- Filing Diff kit: `notes/2026-09-01-week1-filing-diff-demand-kit.md`
  (TSLA/UPS/FDX briefs, early-access copy, B2B template; exemplar = TSLA).

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

## LOCAL-ONLY builds — RESOLVED 9/1 (historical)

9/1 diff vs origin/main proved ladder/topup/front door/hero/ask caches were
all in the 8/31 pushes (`2cd178c1`+`74a7fdab`, live); only docs+lockfile
lagged → pushed as `7ee7dbf` (yahoo-finance2 moved out of devDependencies —
prevents a repeat of the 8/31 boot crash). Ship log: ladder (menu4) · topup
wired · front door anon gate (sales1) · hero + Beta chip + ask caches
(askfix1) · `docs/appsumo-listing-v3.md`.

## Owner actions pending

1. Owner logged in to gh 9/1; docs+lockfile pushed as `7ee7dbf`. **Owner:
   trigger the Render deploy** (flip avisre/prod public → deploy → flip
   back). All env PUTs (#7) activate at this deploy. Auto-deploy on push is
   broken — deploy must be triggered manually. **Deploy again for `3bf46b0`
   (9/2): screener one-toggle market-cap bands — built on owner directive
   after gattomorto77's request; verified 411/411 + live API bands.**
2. Owner E2E locally on :4001 (upgrade ladder, compare beta, front door).
3. **Strategy Week-1 owner gates — REMAINING:** (a) live payment-link
   purchase+refund (links created 9/1, verified rendering); (b) live $24.99
   checkout+refund. Sends DONE 9/1: 38/38 via /api/admin/messages (25 leads
   + 12 review asks + 1 preview); watch replies in /admin/messages.
4. Revoke old PAT; rotate Bing key (`~/.local/share/secrets/bing_webmaster.txt`).
5. AppSumo listing v3 submission owner's call; review harvest to 6–10
   (review 1 in: gattomorto77 — see `notes/2026-09-02-reply-wave-1.md`;
   owner pastes other Gmail replies, I can't read the mailbox).
6. Strategy gate at day 14 (≈2026-09-15): re-forecast per Appendix C of v3.
7. **Render env PUTs DONE 9/1, deploy DONE** (live `dep-dabcorgu01pc73eqnta0`
   @ `481fc04`; env changes active). All five STRIPE_PRICE_ID_* audited
   CORRECT as-is — featured Pro $499.99/yr = planId `pro-annual` →
   PRO_ANNUAL key (`pro` is the retired rung). PUT this session:
   ASK_WARM_TICKERS=NVDA,AMD,INTC,AAPL,TSLA,V,MA and APPSUMO_REVIEW_EMAILS=0
   (both re-GET-verified). **Intelligence founding SKU live 9/1**: $149/yr
   product `prod_VBJ9tuIAexvOf8` / price `price_1UAwXPAUeKapY1OPhzEkQNNA` /
   link https://buy.stripe.com/9B6eVcbh2fmwgXNb0q4sE06 (verified US$149.00).
   Offered to gattomorto77. TODO: manual entitlement grant on purchase
   (webhook doesn't map this SKU yet).
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