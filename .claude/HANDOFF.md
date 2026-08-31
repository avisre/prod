# Handoff

App: StockPortfolio.pro — Node/Express + Mongoose backend, vanilla-JS frontend
in `frontend-v2/`. Prod = Render service `srv-d4kc6schg0os73al6t10`, repo
`avisre/prod` (PRIVATE). Live site: stockportfolio.pro.

## Latest build — reprice to .99 ladder + growth copy overhaul (2026-08-31, NOT SHIPPED YET)

Local tree is ready and green (suite **380/380** under Node v22, stamp bumped
`20260831-blue1` → `20260831-ladder1` on all 37 pages/server files + 5 pinning
tests). NOT pushed/deployed — gated on Stripe prices (below).

**Prices** (backend/app.js):
- New ladder: Monthly 39.99, Annual 399.99, Pro 79.99, Pro-Annual 799.99,
  Power-monthly 149.99, Power-annual 1,499.99, Desk 2,999.99; topup 14.99/150.
  CHECKOUT_STRIPE_PRICE_SPECS amounts match exactly (deploy gate stays armed).
- NEW `LEGACY_PLAN_PRICE_SPECS` + `LEGACY_STRIPE_PRICE_ID_*` env map: old price
  ids keep OLD display prices (12/118/33/250/64/579/1961), resolved
  before the checkout spec map, so grandfathered subs show their real price.
- `applyPlanToSubscription` now trusts a caller-resolved plan config (passed
  through from activateSubscription / syncSubscriptionFromStripe) instead of
  re-deriving and overwriting legacy amounts.
- Founding rate preserved in copy: "lock the founding $12/month rate" (index).

**UI overhaul shipped in the same tree**:
- index.html: hero "AI that has read every SEC filing for you.", CTA reorder, all
  pricing cards + JSON-LD offers at .99 ladder.
- ask.html: same hero sentence, 2 new curated prompts first (NVDA margin
  compression, TSLA 10-K risks), anon quota foot line rewritten.
- upgrade.html: LADDER regrouped good/better/best, monthly+annual variants share
  one card (annual = ghost button); planIds unchanged (checkout keys).
- dossier.html/dossier.js: professional hero ("the write-up an analyst bills
  20–40 hours for"), visible credit costs (Standard 10 / Deep 30; Pro 600 /
  Power 2,000 / Desk 10,000 per month — measured from credits.js ×2 rule),
  upsell card repriced. Monitor.html: professional repositioning.
- llms.txt + llms-full.txt: USD, full ladder + feature lines (was showing GBP!).
- comparison-pages.js / seo-pages.js: prose + JSON-LD offers + aggregate
  highPrice 2999.99. All other price strings swept (app.js quota walls,
  credits.js default, register/terms/recharge, monitor.js/profile.js).

## Owner gates before deploy (in Render dashboard + Stripe)

1. Stripe: create NEW prices at the new amounts (never edit live prices) —
   Monthly $39.99/mo, Annual $399.99/yr, Pro $79.99/mo, Pro-Annual $799.99/yr,
   Power $149.99/mo, Power $1,499.99/yr, Desk $2,999.99/yr, credits topup
   $14.99 one-time. Set `STRIPE_PRICE_ID_*` (8 keys incl.
   `STRIPE_PRICE_ID_CREDITS_TOPUP`) to the new price ids.
2. Optionally set `LEGACY_STRIPE_PRICE_ID_CORE/ANNUAL/PRO/PRO_ANNUAL/POWER/POWER_MONTHLY/DESK`
   to today's price ids so existing subs keep old display prices to renewal.
3. Set `ALLOW_ANON_AI=true` if the homepage "Try the AI analyst — free" CTA
   should actually have a working anon teaser (currently OFF in prod).
4. Re-authorize Render's GitHub App (still doing the public-flip dance).
   Then push (clone avisre/prod to scratchpad, copy ONLY changed files, commit).

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

1. Stripe prices + env keys + ALLOW_ANON_AI (gates above), then OK to deploy.
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

## Next bounded task

Owner gates (above) → push + deploy + live sweep (stamp `20260831-ladder1` on
page AND served bundles byte-matching local) → GA4 funnel report after ~2 weeks
→ entry-rung $39.99 vs $24.99 decision on measured data.