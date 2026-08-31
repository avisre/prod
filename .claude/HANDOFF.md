# Handoff

## Four-rung ladder verified + $14.99 topup live (2026-09-01, LOCAL ONLY)

- Ladder parity vs the pasted spec: **upgrade.html / register.html / backend
  specs all match it already** — 4 sellable rungs (Good $24.99/mo, Good-annual
  $199.99/yr w/ cross-sell line on the Good card, Pro $499.99 featured, Desk
  $1,999.99 featured), retired ghosts rank but never render; sell-order mask
  proven per-tier (free → 3 cards/4 buttons; monthly → [annual, pro-annual,
  desk] with no $24.99 buyable; desk → top-up fallback). register picker shows
  monthly/annual/pro only; `?plan=power|power-monthly|desk` = direct single-plan
  outreach mode by design (backend refuses fresh power sales).
- **Two real fixes found by verification** (both LOCAL ONLY, no stamp needed —
  page-local markup/CSS only): (1) upgrade.html IIFE shadowed the DOM `sub`
  element → "You're on <plan>" line never rendered; renamed local to `owned`.
  (2) upgrade.html + recharge.html used `.price-card/.price-fig/.price-list`
  with **no definitions anywhere** (system.css lacks them; only index.html
  defines them locally) → copied the homepage block into both; the ladder now
  renders as real 3-column price cards and the $14.99 gets the 34px figure.
- **$14.99 topup**: Stripe price already existed (created 8/31) —
  `price_1UAUOtAUeKapY1OPUcSIaloi`, product "Credit refill — stockportfolio.pro",
  $14.99 one-time USD, active; route validation (active/1499/usd) passes live.
  Wired into the prototype boot env (`/tmp/cmp-verify/proto.env`), server
  restarted — the button on :4001 now mints a real Stripe checkout. **RENDER
  STILL LACKS IT**: add `STRIPE_PRICE_ID_CREDITS_TOPUP=price_1UAUOtAUeKapY1OPUcSIaloi`
  to the deploy per-key PUT list next to the four plan price ids.
- **Four rung prices CREATED in live Stripe (owner go — 2026-09-01)**, on the
  already-existing active products `stockportfolio.pro` (prod_UC7quLwRatRazA)
  and `Desk — stockportfolio.pro` (prod_UhUluCSafsSkCN):
  monthly `price_1UAcD3AUeKapY1OPQRXpEyZl` ($24.99/mo), annual
  `price_1UAcD4AUeKapY1OPTO4RiYSi` ($199.99/yr), pro-annual
  `price_1UAcD5AUeKapY1OPdN21eUjX` ($499.99/yr), desk
  `price_1UAcD5AUeKapY1OPEaZfjKxI` ($1,999.99/yr). **Validated with the
  resolver's exact match** (active+amount+interval+product name lowercase):
  1 match each → checkout resolves from live Stripe even with NO env ids.
  Optional belt-and-braces at deploy: per-key PUT the four ids as
  STRIPE_PRICE_ID_MONTHLY/ANNUAL/PRO_ANNUAL/DESK (resolver validates them;
  stale/wrong ids are rejected and fall through to the live lookup).
- New pin file `backend/test/pricing-ladder.test.js` (6 tests: ladder parity,
  retired masking, **Enterprise contact rung**, shadow regression guard, page
  price-component styles, topup route/refuse-to-sell/webhook grant). Suite
  **410/410**.
- **Enterprise line added (owner caught the omission)**: it existed only as a
  collapsed details card + mask logic. Now (a) upgrade.html LADDER carries
  `enterprise` as a `contact: true` rung — mailto support@ CTA, never
  data-plan/checkout, renders for every rung below it (Desk no longer
  dead-ends into "nothing to upgrade"); enterprise holders rank past the whole
  ladder as before; (b) homepage subscription grid = Monthly/Pro/Annual/
  **Enterprise** visible (dup Enterprise card removed from the For-professionals
  details, which keeps Desk only). Harness 24/24.
- **Homepage grid re-pinned to the ladder table ("this and lets talk",
  2026-09-01)**: grid now reads **Good $24.99/mo → Good — annual $199.99/yr
  ("Same Good, priced once a year") → Pro $499.99/yr featured → Desk
  $1,999.99/yr featured → Enterprise "Let's talk"** — Desk promoted out of the
  collapsed For-professionals details (that section is now just the licence
  provenance). Also fixed two ladder violations found en passant: both
  "Start Pro checkout" CTAs pointed at **`?plan=pro` — the RETIRED $79.99
  monthly rung** (register !PLANS guard falls back to Monthly; now they point
  at pro-annual), and the Monitor section sold "On Pro, **Power** and Desk"
  (retired name; now Pro and Desk). New pin in pricing-ladder.test.js
  (grid order/featured/no plan=pro); suite **411/411**, harness 24/24 +
  `/tmp/ladder-check/home-table.js` (homepage grid checks, 6/6).
- **Grid layout re-cut ("desk and lets talk on the next line", strikethrough
  on 199)**: homepage line 1 = **Good $24.99 · Pro $499.99 (featured) ·
  Good — annual $199.99 with the actual monthly-billed $299.88 struck
  through** (`.price-was`, 3-col grid override scoped to
  `#pricing-subscription-grid`, collapses to 1 col ≤760px); line 2 = **Desk
  (featured) + Enterprise "Let's talk"**, same card width, col 3 empty.
  All card-local/index.html — no stamp. Harness now also pins row geometry
  (line-1 tops equal, Desk top ≥ line-1 + 300) and the line-through style.
- Harness: `/tmp/ladder-check/check.js` (24/24, session-stubbed Playwright on
  :4001; screenshots upgrade-free/monthly/desk/enterprise, recharge,
  register-monthly).
- **"Old prices on the homepage" — root cause**: the 1-week LTD pricing-swap
  experiment (`PRICING_EXPERIMENT_MODE=ltd_only`, activated 8/25) was still
  armed in the LOCAL boot env — `/tmp/cmp-verify/proto.env` *sources the
  pre-recovery Render backup*, which still carries `PRICING_EXPERIMENT_*`
  (deliberately NOT re-PUT to Render on 8/31). It hid the subscription grid
  and showed LTD tiers $39.99/$79.99/$149.99 instead. Fixed by appending
  `PRICING_EXPERIMENT_MODE=off` to proto.env (after the sources). Render is
  already clean; experiment is retired — if ever revived, the 7-day auto-revert
  applies. Homepage + /pricing now show only the four rungs (verified).

## Compare = Beta + AppSumo listing v3 (2026-09-01, LOCAL ONLY)

- Compare labeled Beta: chip in both dossier.js header render sites ("Compare ↔
  Beta") + on compare-dossiers.html hero title. Stamp `20260901-dosfix1` →
  `20260901-beta1` in **dossier.html only**; compare-dossiers.html carries its
  own chip (page-only edit, no stamp). New pin in dossier-compare.test.js —
  suite **404/404**. Note: /api/dossier peek 401s for anonymous sessions, so the
  runtime chip check needs a logged-in owner eyeball; code level is pinned.
- Listing rewrite: `docs/appsumo-listing-v3.md` (v2 kept). Spine: institutional-
  grade research for retail + "one click, zero prompting" hook; opens with the
  real Alex quote (Aug 2026 feedback round); whole listing orbits Dossier +
  Monitor as the halo (analyst/screeners/portfolio demoted to "kept in its
  place"). Facts: $39/$79/$149 · 30/100/300 asks · 6,000+ stocks. **Watch caps
  set to 1/2/6 by owner (2026-09-01)** — shipped grant is still 12/40/unlimited
  (`lib/tier-limits.js` LTD_MONITOR_CAP); owner must decide if the grant
  follows (existing buyers keep 12/40/∞ regardless — ratchet).
- Demo deal page for finalizing: `/tmp/appsumo-demo/deal-page.html` (verified
  desktop+mobile headless, screenshots in /tmp/appsumo-demo/). Rating left as a
  placeholder on purpose; gallery slots list which 3 screenshots to capture.
- Owner's headed browser opened at https://partners.appsumo.com/portal
  (profile /tmp/appsumo-portal-profile, throwaway; login is owner-driven +
  owner-typed).

## Landing hero rebuild — try-first demo (2026-09-01, LOCAL ONLY)

Owner-approved ASCII → built. `frontend-v2/index.html` ONLY (inline CSS + inline
JS; no asset-file edits, so no stamp bump — `app.js` remains `20260901-askfix1`).

- Hero right column is now the LIVE demo card `#home-try` ("Try 3 questions
  free", no account): ask bar + 2 sample chips + a FIXED-HEIGHT (360px, 330px
  mobile) proof stack that holds the AAPL specimen (score dots 3.5/5, brief,
  KPIs) and a Filing Monitor sample on load, and streams real Ask answers into
  itself via `V2.askEngine(#try-exchange)`. Answers scroll the stack
  internally (stream-follow at stack level, hands control back on scroll-up);
  page height is frozen — verified 6613px before/after a landed answer.
- 3-free mechanics are the existing anon trial: `ALLOW_ANON_AI`, limit 3, wall
  → email rung → paid. Nothing new server-side.
- Left column: h1 unchanged (test pin), sub, CTAs (Try 3 free → #home-try,
  Build a dossier →), and a "Free entry points" ✓ checklist; columns end
  flush (0px measured) and `#verify-headline` margin-top 12px kills the dead
  space the owner rejected.
- Test pin added: 'Homepage hero carries the live 3-free demo card' in
  `anon-ask-trial.test.js` (suite 403/403). Harness `/tmp/lp-verify/shoot.js`
  (desktop+mobile, flush/gap/freeze assertions) — DONE OK.
- Wired with `V2.askEngine(exchange)` deliberately — the old test pins
  `V2.mountAsk(host` as ABSENT, and the id is `home-try`, not `home-ask`.

## Render env incident (2026-08-31) — RESOLVED, rule in `render-env-bulk-put-destroys`

A bulk-PUT destroyed the env set; all 52 app vars recovered byte-for-byte via
SSH to the old instance (`/proc/<pid>/environ`) + 42 per-key PUTs. Final: 63
vars, JWT_SECRET = ORIGINAL. Deliberate deltas: SKIPPED `ANON_ASK_LIMIT=0` and
4 stale display-price overrides; DELETED `PRICING_EXPERIMENT_*`;
`ALLOW_ANON_AI=true`. **Only write path: per-key PUT; snapshot first.**

App: StockPortfolio.pro — Node/Express + Mongoose backend, vanilla-JS frontend
in `frontend-v2/`. Prod = Render service `srv-d4kc6schg0os73al6t10`, repo
`avisre/prod` (PRIVATE). Live site: stockportfolio.pro.

## Latest build — SIX customer-feedback decisions (2026-08-31, LOCAL ONLY)

From the support-inbox read (12 feedback asks → 2 replies): chat-with-filings is
a commodity; Dossier + Monitor are the product. Direction in
`docs/product-principles.md` (the Alex test). All six decisions implemented:

- **A — Dossier Compare (NEW)**: `GET /api/dossier/compare?symbols=A,B,C`
  (app.js, registered BEFORE `/api/dossier/:symbol`; peekDossier only — never
  builds; missing → `{missing, buildCost}` with NO charge; 5 credits when all
  cached). `credits.js` COST gains `dossier_compare: 5`. "Compare ↔" button in
  both dossier.js header render sites. REBUILD at full depth (2026-09-01,
  owner requirement: compare must match Simple-mode dossier depth, not a
  summary): verdict strip (same score arithmetic as the dossier), winner-bolded
  10-row metrics table, shared-axis growth-index chart, per-company trend /
  money-split / unit-economics / segments / bull / bear / risk-meter /
  priced-in / peer / latest-filing panels, paired health-check grid, scenario
  bands, per-company collapsible analyst detail (forensics, peers, DCF,
  governance, ESG, ratio history), print button. Section-parity pin + shape
  pin (7 tests in dossier-compare.test.js). Verdict area rebuilt UNIFORM
  (20260901-cmp4, owner: "pretty and simple, less jargon"): one anchor banner
  per report top — score dots + "3.5 / 5" per company, then three shared
  plain-word stat rows (growth / keeps as profit / price÷earnings) with
  green winner ●; all values toFixed(1), no raw floats; hero + heading + Print
  toolbar simplified. Stamp `20260901-cmp4` on compare-dossiers.js +
  plainviz.js added to compare-dossiers.html. BUG (same
  day): dossier page headers printed '[object Object]' when the industry
  build succeeded — payload `industry` is the drivers object, header joined
  [d.sector, d.industry]; fixed via metaLine() in BOTH render sites, stamp
  `20260901-cmp1`→`20260901-dosfix1` on dossier.js (dossier.html ONLY).
- **B — homepage Dossier-first, Ask REMOVED from primary marketing** (owner
  correction; Ask is replaced, not merely demoted): hero is now "The report,
  not a chat." with a static dossier-specimen card (12-section proof, credits
  line) in place of the live ask box; hero CTAs /dossier.html + /monitor —
  zero /ask.html links in the hero; #ask-feature section deleted; home-ask
  mount block gone from the inline script while `?ask=verified` handling stays
  (email-rung verify still lands there). Section order:
  dossier → briefing → monitor → dashboard → gurus. Tests: anon-ask-trial
  homepage pin rewritten; mobile-ux comparison-table pin retargeted to
  compare-dossiers.html. ask.html itself untouched (still the Ask product page).
- **H — AppSumo listing v2**: paste-ready copy in
  `docs/appsumo-listing-v2.md` (Dossier/Monitor-led; tier facts unchanged);
  appsumo.html rewritten — hero "The report, not a chat.", workflow steps now
  Dossier → Compare → Monitor, tier cards lead with the Monitor cap
  (12/40/unlimited), Ask shown as allowance; FAQ + og/twitter updated.
- **C — activation email tier inventory**: mailer.js `customerLifecycleEmail`
  gains "Your plan includes" block for `appsumo_redeemed` (Dossier, Monitor
  with tier cap from LTD_MONITOR_CAP, cited numbers); `tier` threaded from
  caller.
- **D — weekly digest for lifetime buyers**: runDigestSweep filter now also
  matches `appsumoRedeemedAt`/`dealMirrorRedeemedAt`; symbols trimmed via
  `tierLimits.capSymbols` so tier-1 buyers never build past their cap.
- **G — entry-tier Monitor cap widened 10 → 12** (irreversible ratchet, owner
  approved): tier-limits.js both maps + profile.js copy + tier-v2-limits test.
- **6b — duplicate review-ask fixed**: sweep path now skips users with an
  `appsumo-review-5d` ScheduledEmail scheduled/sent (cross-path dedup with
  scripts/run-scheduled-emails.js) and writes stage 3 + reviewRequestSentAt
  unconditionally on success. Test: appsumo-review-dedup.test.js (4).
- **6c — email review asks OFF at deploy**: per-key PUT
  `APPSUMO_REVIEW_EMAILS=0` (in-app usage-gated prompt machinery already
  covers asks). Owner action at same deploy as the rest.
- **6a — SPF/DMARC**: SPF verified good (`v=spf1 include:spf.privateemail.com
  -all`). `_dmarc` is `p=quarantine` with **no rua** → Namecheap record:
  `v=DMARC1; p=quarantine; rua=mailto:support@stockportfolio.pro; adkim=s; aspf=s`.
  Also: keep cold blasts (~50 addresses) off the support domain.

New/changed tests: dossier-compare.test.js (5), appsumo-review-dedup.test.js (4),
lifecycle-email-inventory.test.js (3), tier-v2-limits literal 10→12.
**Stamp: `20260901-cmp1`** on dossier.js (dossier.html) + profile.js
(profile.html) + new compare-dossiers.js. Shared app.js/system.css stamp
`20260901-askfix1` UNCHANGED (those files untouched). Docs: `docs/product-principles.md`,
`docs/appsumo-listing-v2.md`.

## Prior build — FRONT DOOR REBUILD (2026-08-31, LOCAL ONLY — stacked on the four-rung cut)

Both today's builds are in the local tree awaiting the owner's one combined
test+approval. Front-door changes (sales-memo plan, scores ~9.8/10):

- **A+B — free-query gate on, homepage ask box**: `ALLOW_ANON_AI=true` is
  already in the recovered Render env (ANON_ASK_LIMIT defaults 3). Wall copy
  no longer says "create a free account" — it offers the **email rung** then
  paid checkout. index.html hero ask box (V2.mountAsk #home-ask + sample
  table) REMOVED in the later Ask-removal (see item B above); the email rung
  itself is untouched — verify still 302s to `/?ask=verified`.
- **C — SKU cut to three**: hero AppSumo ghost button + `data-appsumo-deadline`
  and the stale "$12 founding rate" line REMOVED; `#pro-plans` collapsed to a
  one-line `<details>` (Desk/Enterprise content preserved verbatim); pricing
  grid keeps Monthly/Annual/Pro + "Prefer to pay once? See the lifetime
  option →" demote line; AppSumo badge dropped from the Featured-on strip.
  AppSumo demoted, NOT deleted (only measured conversion channel).
- **D — email rung (NEW)**: `AskTrialLead` collection; `POST /api/ask-trial/email`
  (8/hr limiter, 16-domain disposable blocklist, mailer verify link →
  `anon_email_captured`); `GET /api/ask-trial/verify?token=` (3d JWT → 302
  `/?ask=verified` + 30d `sp_ask_bonus` HttpOnly cookie → `anon_email_verified`);
  effective anon limit = ANON_ASK_LIMIT (3) + ASK_TRIAL_BONUS (2, env-overridable).
  Funnel events: anon_ask_started / anon_ask_done / anon_wall_shown(+reason).
- **E — shares indexable**: `/r/:id` keeps `X-Robots-Tag: noindex` ONLY for
  anonymous/ambient-created reports; auth-created ones get index meta,
  Article JSON-LD, canonical and a `shares` sitemap shard fed by
  `backend/indexable-shares.json` (noteIndexableShare, newest 500). Share
  cards on Ask answers were already live.
- **F — ask floor on SEO surfaces**: body `data-ask-floor="1"` +
  `data-ask-placeholder` auto-mounts `V2.mountAskFloor` (guarded). Added to
  /stocks/:ticker, /stocks directory, /screener, all free-tool shells.
- **G — credibility**: quotaWall ladder lost the unsellable "Free — $0/forever"
  card (now Monthly $24.99 / Pro $499.99). llms.txt was already USD.
- **H — ship mechanics**: new stamp `20260901-sales1` across 43 files, 0 stale;
  new test `backend/test/anon-ask-trial.test.js` (7 tests). Baseline snapshot:
  `notes/2026-09-sales-funnel-baseline.md` (ask ≈2 credits/query; the
  ANON_ASK_GLOBAL_DAY=400 ceiling bounds anon spend regardless).

Verified locally on :4001: home-ask mounts, both wall variants return the new
copy, email endpoint accepts/blocks (disposable+invalid), verify → 302 +
sp_ask_bonus cookie, anon share stays noindex + unledgered, /stocks/AAPL +
free tools carry the ask floor, funnel events land in funnel_events.
Suite **388/388** under Node v22 (7 new).

## Earlier build today — Jobs cut: FOUR prices (2026-08-31, LOCAL ONLY)

Owner's governing instruction: "do push deploy first, we will test it locally
and only push to prod when I am satisfied with the product." So:
- The already-pushed commit `ef788c3` (old 8-rung ladder) is what deploy waits on.
- The Jobs cut below exists ONLY in the local tree — DO NOT PUSH until the
  owner has tested locally and approved.

**The four-rung menu** (market research 2026-08-31: monitoring is a $10–79
commodity; $24.99 is the defensible rung):
- Monthly $24.99/mo · Annual $199.99/yr · Pro $499.99/yr (annual-only; now
  includes the Filing Change Monitor — `hasMonitor` gains 'pro-annual') ·
  Desk $1,999.99/yr. Topup stays $14.99/150.
- RETIRED from new sales: pro ($79.99/mo), power-monthly, power. They stay in
  `LEGACY_PLAN_PRICE_SPECS` + `getPlanConfig` + `LEGACY_STRIPE_PRICE_ID_*` env
  (grandfathered display prices 33/64/579) and as `retired: true` ghosts in
  upgrade.html LADDER (rank masking only, filtered from render). Absent from
  `CHECKOUT_STRIPE_PRICE_SPECS` ⇒ unsellable new.
- LTD/AppSumo marketplace tiers ($39.99/$79.99/$149.99) deliberately untouched.

**Files touched**: backend/app.js (defaults 24.99/199.99/499.99-legacy/499.99/
1999.99 + specs + hasMonitor), upgrade.html, index.html (JSON-LD + cards),
register.html (PLANS/PLAN_VALUE, `?plan=pro` falls back to Monthly),
terms.html, seo-pages.js/comparison-pages.js (LTD prose untouched),
recharge.html, monitor.js/dossier.js/app.js copy, llms.txt + llms-full.txt,
test/paid-first-signup.test.js (3 pins rewritten).
Stamp `20260831-ladder1` → `20260831-menu4` across 43 files, 0 remaining.
`local-pricing-overlay.env` (workspace; never push): overrides
DESK/PRO_ANNUAL for local boot since Render env still holds 1961/250.

Verified: suite **381/381** under Node v22; boot on :3903 (prod env + overlay)
served root:200 with all four rungs on index/upgrade/register.

## Deploy status (2026-08-31) — BLOCKED: repo is PRIVATE, gh token invalid

Two deploys of `ef788c3` → `update_failed`; POST /deploys returns
`not found: https://api.github.com/repositories/1105594471` = Render cannot
clone the PRIVATE repo. Code is fine (boots clean locally). `gh` classic PAT is
REVOKED → only the owner can unblock: run `gh auth login -h github.com`
themselves (interactive). Then: flip repo public → deploy `ef788c3` → verify →
flip private. **At that same deploy: create the 4 new Stripe prices
(24.99/199.99/499.99/1999.99) from sk_live in the backup env and per-key PUT
STRIPE_PRICE_ID_MONTHLY/ANNUAL/PRO_ANNUAL/DESK + per-key PUT
DESK_PLAN_PRICE=1999.99, PRO_ANNUAL_PLAN_PRICE=499.99 (Render env still carries
the old 1961/250). After the four-rung push deploys: live sweep.**

## GA4 funnel read-back — COULD NOT RUN

`scripts/report-ga4-readonly.js` needs `GA4_PROPERTY_ID` + `GA4_SERVICE_ACCOUNT_JSON`
— neither present locally nor in local env files. Run on a machine that has the
service account (or add to Render env once) — needed to judge the $12→$39.99
entry-rung conversion risk within weeks of launch. $24.99 fallback rung exists.

## Prior build — Ask UI overhaul (2026-08-30, SHIPPED `986348d`, dep-daa4snhsrm7s73dva9fg)

- Waiting state: `.ask-progress` card (plan note from `ai-chat.js:1703`, every
  finished step + duration, live timer, real Stop, skeleton where answer lands;
  hidden not removed on first token so rollback can restore it).
- Send split: `body.focus` automatic (nav+composer stay), `body.zen` deliberate
  (⤢/F11, remembered `sp_ask_zen_v1`), Esc peels one layer.
- Composer: ONE box (border/bg on wrapper), 800×49px identical landing/mid-chat;
  gotcha: Chromium textarea placeholder counts in scrollHeight → TA_MIN pin.
- `.ask-q` width:fit-content; rail day buckets + `⋯` modal; landing widths
  unified to `--ask-col`; scrollIntoView block:start + margin 88px.
- Harness `ask-ui-verify/shoot.js` rewritten to focus contract; ALL PASSED.

⚠️ `affiliate-program.test.js` was an intermittent parallel-suite flake (`:228`)
— passed 380/380 in this run, so no longer repro. Watch it.

⚠️ Local tree LAGS GitHub on `README.md`, `.github/workflows/refresh-fundamentals.yml`,
`docs/`, and 504 `frontend/data/fundamentals/*.json` — do NOT copy those back on push.

## RENDER + PRIVATE REPO — known landmine

Render cannot clone the private repo (404). Every deploy: flip `avisre/prod`
public via `gh api -X PATCH repos/avisre/prod -f private=false`, deploy, flip
back. First deploy often no-error `build_failed` at ~50s — straight retrigger
works. Render env LIST endpoint exposes values; inline keys only, never print.

## Owner actions pending

1. `gh auth login -h github.com` (replaces the revoked PAT) — unblocks deploy
   and ends the public-flip dance if Render's GitHub app is re-authorized.
2. GA4 service-account creds wherever the funnel report should run.
3. Owner E2E on /ask logged in (attachments, memory cards, sidebar search/pin).
4. Revoke old classic GitHub PAT; rotate Bing Webmaster key
   (`~/.local/share/secrets/bing_webmaster.txt`).
5. Desk watch: one Desk sale = 76 Power-monthly months; GA4 + Stripe after
   launch decides a Desk price UP-test.

## Working rules that keep biting

- Stamp ritual: edit to `frontend-v2/assets/*` ⇒ new `?v=` stamp on ALL pages +
  server-rendered (`free-tools.js`, `comparison-pages.js`, `seo-pages.js`,
  `app.js`, `affiliate-dashboard.html`) + pinning tests.
- `node` on PATH is v18 — use `~/.nvm/versions/node/v22.22.0/bin/node`; run
  tests from `backend/`; `node --test test/*.test.js` (bare dir arg fails).
- Subagents fail here (404) — implement directly. No `rg` — use `grep -rn`.
- Never surface the AI provider identity (trade secret). No anti-bot workarounds.
  Never store keys; inline/temp only. No `sleep N` in Bash; no interactive auth.

## Ask latency (measured 2026-09-01, glm-5.1 kept)

- Tools now parallel (concurrency 6) + `get_peer_context`'s industry build is
  Mongo-cached per (symbol, accession, v1) in `industry_context.payload`; EDGAR
  filing-metadata is memoized in-process 6h (`filing-fetcher.js`). Boot warm
  pre-builds demo tickers behind `ASK_WARM_TICKERS` (per-key Render env PUT at
  deploy; suggested `NVDA,AMD,INTC,AAPL,TSLA,V,MA`). Measured: peer_context
  35.2s→2.4s; Costco ask 140.7s→79.4s; remaining wall is model streaming
  (owner chose 5.1). Tool events now carry per-tool `ms`. Suite 388/388.
- glm-5.3-flash A/B (owner rejected): 2.5-9x faster but skips ratio-history
  tools and once broke a viz JSON. Not used.

- Landing ask box no longer reflows the page: `.ask-panel .ask-a` capped to
  min(58vh,520px) with inner scroll + stream-follow (app.js stickInner); /ask
  chat page keeps page-flow reading (exempt). Stamp bumped
  `20260901-sales1`→`20260901-askfix1` tree-wide (pages, server-rendered,
  test pins). Verified headless: page growth bounded by the box cap (456px
  for a 3.9k-char answer), inner scroll works. Suite 388/388.

## Next bounded task

1. Owner runs `gh auth login -h github.com` → deploy `ef788c3` (flip dance) →
   live sweep → flip private → owner tests BOTH new builds locally on :4001.
2. On owner approval: push both builds together, create the 4 Stripe prices
   (24.99/199.99/499.99/1999.99) from sk_live, per-key PUT
   STRIPE_PRICE_ID_MONTHLY/ANNUAL/PRO_ANNUAL/DESK + DESK_PLAN_PRICE=1999.99
   + PRO_ANNUAL_PLAN_PRICE=499.99. No other env changes needed for the front
   door (ALLOW_ANON_AI=true already in recovered env; ASK_TRIAL_BONUS
   defaults to 2).
3. Live sweep: stamps `20260831-menu4`→`20260901-sales1` on page AND
   byte-matched bundles; anon curl /api/ai/chat → wall → email rung; /r/:id
   indexability split; homepage headless screenshot (ask-ui-verify/shoot.js).
4. ~2 weeks post-launch: GA4 funnel report + anon_* funnel events vs
   notes/2026-09-sales-funnel-baseline.md.