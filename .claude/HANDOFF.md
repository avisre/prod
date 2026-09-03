# Handoff

## CEO decision set + B2B kit + two shipped fixes — LOCAL ONLY, NOT DEPLOYED (9/3)

Full context: `notes/2026-09-02-ceo-decisions` is not a file — the actual plan lives
in the session's plan artifact; the durable summary is here and in
`notes/2026-09-02-b2b-25-list-kit.md`. Strategy v3's $2,000/mo target got a 36-hour
measured check (Stripe/Mongo/prod HTTP, all $0 direct revenue, AppSumo net flat, 0
real checkout starts in 14d) and a "first $1,000" decision set. Pricing untouched
throughout — owner explicitly rejected surfacing the `/lifetime` SKU on the
storefront even at unchanged prices.

- **Shipped locally, suite green (444/444) after reconciling with concurrent
  ETF-grading edits below**: three stale GBP Stripe payment links deactivated live
  (`aFa14m84QgqA5f5ecC4sE00`, `3cI3cu4SEgqAePF8Si4sE01`, `fZu4gybh21vGfTJ0lM4sE02` —
  unreferenced in code, £49/yr and £149 one-time on a retired product, verified
  `active:false`, reversible).
- **Affiliate `/api/affiliate/accept` bug fixed**: the route recomputed eligibility
  inline (`appSumoLicenseActive || hasVerifiedStripeSubscription`), ignoring
  `kind: 'partner'` — every external publisher 409'd forever even though
  `affiliateProgram.canAcceptAmbassadorInvite()` two lines below already handled
  partners correctly. One-line fix at `app.js` (search
  "Partner profiles are external publishers"). 14/14 affiliate tests pass.
- **New public surface: `GET /filing-changes/:symbol`** (`app.js:2219`), rendering
  verbatim Was→Now quotes + EDGAR links from the 397-doc `filing_diffs` cache. AI
  narrative (headline/tone/what) stays gated — matches the existing
  `/filing-changes` page's stated promise. Sitemap gained a `diffs` shard, **353
  URLs**, via `refreshFilingDiffSitemapSnapshot()` (boot +20s) writing
  `backend/filing-diff-symbols.json` (same pattern as `indexable-shares.json`).
  Index rows at `/filing-changes` now link to the new pages only where a diff
  actually exists (checked against `filing_diffs.distinct('symbol')`) — no dead
  links. Edge cases fixed during testing: symbol regex now requires a leading
  letter (blocks path-traversal strings), and no-diff tickers redirect to the hub
  `/filing-changes`, not `/stocks/:symbol` (which itself 404s for uncovered
  tickers — was a soft-404 chain).
- **B2B outreach kit built**: `notes/2026-09-02-b2b-25-list-kit.md` — 18 real,
  web-verified newsletter-writer leads matched to our best diffs (TSLA/NVDA/PLTR/
  CAT/AMD/INTC/MSTR/NOW/UPS/FDX), 3 fully drafted personalized sends, and an honest
  note that the RIA leg (public Form ADV/IAPD) needs an interactive/Playwright
  session — IAPD is a JS search app, not fetchable statically, and no RIA names
  were fabricated to pad the count. **Nothing sent** — sends stay owner-gated,
  founder-personal-channel-only, never support@.
- **Decision 3 (env `APPSUMO_REVIEW_EMAILS=0→1`) investigated and deliberately
  NOT done**: the in-app review prompt isn't gated by that var at all (already
  live, 2 shown / 0 clicked / 2 dismissed) — the var gates an *email* sweep, and
  flipping it would immediately mail 6 real customers, 5 of them a stage-1
  onboarding message days after they already got the 9/1 wave. Left at 0.
- **Concurrency note**: mid-session, a different/concurrent process ran the ETF
  grading build-then-strip below (stamps flipped `fundgrade1`→`paywall1` under me).
  Verified both new routes above survived the revert with correct current stamps;
  re-ran full suite after to confirm (this also explains an earlier
  466→444-passing-tests scare that had nothing to do with my edits).
- **Not started**: Decision 2 (free filing-change email alerts, no account — builds
  on the new pages), Decision 5 (Bing/GSC zero-click query CTR rewrite), Decision
  6b (publisher recruiting now that 6a unblocks it). Two owner gates still open
  from v3: live $24.99 purchase+refund, and the AppSumo portal check on two 9/2
  tier-1 deactivations (same-day, might be refunds — portal is the only source).

## ETF A–E grading — BUILT, TESTED, THEN STRIPPED PER OWNER CALL (9/3)

- Prompted by Sandra (`Fruitfulfinancellc`, AppSumo) asking for an A–E ETF
  ranking to lever a buy-borrow-die strategy against. Built `fund-grade.js`
  (neutral quality grade, cost/consistency/tenure/size/risk-adjusted, published
  rubric at `/etf-grading`, badge on the fund page), wired into
  `fetchAssetProfile`/`rank_funds`/Ask, 22 tests, 466/466 suite, verified
  against 30 live tickers.
- Hardening pass found real bugs along the way: inverse funds mislabelled
  Income (T-bill collateral yield), the leveraged detector missing plain
  `ProShares Short <index>` names, an A possible with cost+size both unknown,
  an unknown ticker throwing a 500. All fixed and verified.
- Then found Yahoo reports **FXAIX's expense ratio as 1.53%** (real: 0.015%,
  a 100× source error) in every field, with no way to detect a bad figure from
  a real one without inventing data. Owner's call: **"if we can't verify it we
  won't have it."** Correct call for a number customers borrow against.
- **Stripped 9/3, same session**: `backend/fund-grade.js` and its test file
  deleted, `/etf-grading` route removed from `app.js`, the badge/details block
  removed from `frontend-v2/assets/company.js`, grade-related tool
  descriptions reverted in `ai-chat.js`, `fund-ranking.js`'s ranked rows and
  methodology string reverted. Stamp back to `20260903-paywall1` everywhere in
  the live tree (93 occurrences, 44 files — `.push-clone`/`prod-push` never
  had the fund-grade stamp, confirmed clean). Suite green after strip (see
  count below — this repo has no local git, so "revert" here means these
  literal edits, not a checkout).
- **3 fixes KEPT — verified independently, nothing to do with the grade:**
  1. `asset-profile.js`: Yahoo no longer returns
     `numYearsUp`/`numYearsDown`/`best|worstOneYrTotalReturn` —
     `profile.performance` was `{null,null,null,null}` **live on prod**
     (confirmed via `GET /api/assets/SCHD/profile`, 9/3). `get_fund_profile`
     spreads the whole profile to the model (`ai-chat.js`), so Ask has been
     answering every ETF question with zero calendar-year record. Now derived
     from `fundPerformance.annualTotalReturns.returns`, also exposed as
     `profile.annualReturns` (14 yrs for SCHD).
  2. `asset-profile.js`: unknown ticker (`yahoo.quote()` resolves `undefined`
     instead of throwing) crashed with a TypeError → now a clean 404.
  3. `fund-ranking.js`: `leveragedOrInverse` regex now catches plain
     `ProShares Short <index>` names (SH/PSQ/DOG/RWM — no "3x"/"ultra"/
     "inverse" in the name), with a lookahead so `Short-Term`/`Short Duration`
     bond funds (SHY, VGSH, BSV) are never misflagged.
- Reply to Sandra not sent. Should tell her plainly the grading tool isn't
  shippable yet — Yahoo's fund data has a confirmed 100× error on at least one
  fund and nothing catches it reliably — rather than ship something unverified
  against a leverage decision. Point her at `get_fund_profile`/`rank_funds`,
  which already cover most of what she asked for.

## Monitor Normal mode shows verified quotes — LIVE `f19ec71` (deploy dep-dac6cjvavr4c738og690, 9/2)

- Normal mode's "What the words changed" cards now render single-source
  verified passages (`mon-quote-single`, "New filing"), not just Was→Now
  pairs — same character-for-character evidence rule as Analyst mode. NVDA's
  live 10-Q report: 0 quoted cards in Normal before → 6 after (measured in
  headless Chrome on prod).
- monitor.js stamp `20260902-normquote1` (monitor.html is its only carrier;
  app.js/system.css untouched, still `20260903-paywall1`). Tests: 28/28
  (filing-evidence, monitor-free-usage, monitor-credits, profile-consolidation).
- Same session: ₹1000 X-ad package finished in `notes/x ad campaign/` —
  promote variant E (263 counted chars) → `/tour?utm_source=x&utm_campaign=sep1000`;
  creative `x-ad-1000-card-real.png` is a REAL capture of the NVDA redline
  (via `scripts/generate-x-ad-screenshot-2026-09-02.js`, anonymous cached
  report, zero credits). Organic milestone post ($1,000 sales) goes first —
  never say MRR/ARR. Kill rule: CTR <0.5% AND 0 signups → no re-up.

## AI menu reorder — LIVE `730af27` (deploy dep-dac2v98jo6nc739duqm0, 9/2)

- Dropdown now Research Dossier → Filing Monitor → Ask (trigger label + click
  target still "Ask AI" → /ask.html). Mobile subs were already Dossier-first —
  untouched. Stamp `20260902-aiorder1` (45 files, 89/89 diff lines). 434/434.
- Verified LIVE: page stamp aiorder1 + served bundle carries Dossier →
  Monitor → Ask order. Deploy ran via `../trigger-deploy.sh` with the owner's
  Render API key (pasted inline 9/2; export RENDER_API_KEY to re-run — the key
  is NOT stored in any file). Repo flipped back to private (verified).

## MRR ladder + referral kit (2026-09-02) — LIVE + SENT, nothing pending

- Prod serves `2b698ea` (measured: live checkout session has
  `allow_promotion_codes: true`), so the Good 50/mo code default is live too —
  the `AI_CHAT_CORE_LIMIT` env key is now redundant (still fine if added).
- **GATTOMORTO promo code is live**: Stripe coupon `referral-25-off`
  ($24.99 off first invoice, once, ≤50 redemptions) + code `GATTOMORTO`
  (`promo_1UBETZAUeKapY1OPgKtdxJS9`). Clover-API gotcha: promo codes now need
  `promotion[type]=coupon&promotion[coupon]=<couponId>` (flat `coupon=` is gone).
- **+1 AI month applied**: gattomorto77's 2026-09 `ai_chat_usage` counter
  deleted (was 1 → 0). Per-referral renewals later = `appsumoAiCap` +30, revert
  by SETTING back to 30/100/300 — never `$unset`.
- **Email sent 9/2** via POST /api/admin/messages/threads (HTTP 201, sender is
  structurally support@): features live + GATTOMORTO code + +1 AI month per
  friend who stays. His `customerMessageEmailsOptOut` is false, same pipe
  delivered 9/1 (he replied to it). Admin-token recipe that worked:
  mint JWT `{userId, v: authVersion}` for rin@gmail.com from the env-backup
  JWT_SECRET → `Cookie: sp_auth=` → **www.stockportfolio.pro** (apex 301 drops
  the cookie). One probe checkout session (cs_live_b1G5…) sits open; expires
  in 24h. One-offs: /tmp/spdev/{send-gatto,probe-promo,reset-gatto}.js.
- Ask wall anchors annual; homepage Good-annual featured ("Best value —
  $16.67/month"); stamp `20260902-mrr1` live. 434/434.
- 7-day no-card trial exists (`startNoCardTrial`) but is legacy-rollback-only
  (`REQUIRE_INITIAL_STRIPE_PAYMENT` gates it off) — surfacing it is an owner
  billing decision, deferred.

## Graphite rebrand TRIED AND REVERTED (2026-09-02) — tree back at `c05049c`

Owner hated the blue accent, picked graphite from a browser preview, it was
applied tree-wide (both themes, emails, charts, admin, SVG/PNG/WebP art,
stamp `20260902-graphite`) — then owner saw it live and rejected it as
hideous. Full revert done same day: rsync of frontend/, frontend-v2/, lib/,
backend/ from clean `.push-clone` @ `c05049c` (diff vs clone: byte-identical),
suite 434/434, stamps back at `20260902-navfix1`. Blue `#1a4fd6`/`#3b82f6`
are the live accents again. LESSON: the "pre-change backup"
(/tmp/pre-desat-backup.tar.gz) was actually taken AFTER the token edit and is
worthless — the push clone was the real baseline. No blue-change is pending;
next color change should restore from `.push-clone`/git, not ad-hoc tars.
Nothing was ever pushed for the rebrand.

## Customer-thread bug pass (2026-09-02) — PUSHED `c05049c`, rides next deploy

From the gattomorto77 website-interaction thread. Stamp → `20260902-navfix1`
(all pages + server-rendered + pinning tests). Pushed to origin/main as
`c05049c` — which also carried previously-unpushed local work (monitor-cap
v2 + multi-portfolio switcher/CSV) that origin lacked; verified 434/434 in
the push clone before pushing. Ships at the owner's next deploy trigger
(same one pending for `3bf46b0` screener bands).

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
   broken — deploy must be triggered manually. **One trigger now ships
   `3bf46b0` (9/2, screener market-cap bands — owner directive after
   gattomorto77's request; verified 411/411 + live API bands) AND
   `c05049c` (customer-thread fixes + monitor-cap v2 + multi-portfolio,
   434/434).**
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