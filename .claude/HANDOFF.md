# Handoff

## Task
China segment bet: geo tracking + Alipay/WeChat Pay/UnionPay + Simplified
Chinese content. Full plan (approved, user proceeded despite no confirmed
real China demand — Stripe has zero CN checkouts ever, GA4 is blocked in
mainland China without a VPN):
/home/hardoker77/.claude/plans/zippy-growing-shore.md

User instruction this round: "do it all and don't bother me until all the
work is done and pushed to github" — explicit one-turn authorization to
build Phase 0+1+2 and `git push` without further check-ins.

## Phase 0 — first-party geo capture: DONE, tested, committed

`geoip-country` (local MMDB) + `ip-address` override for 2 CVEs (0 vuln
after). `resolveCountry(ip)` in `marketing-attribution.js`, `country` field
now flows through `requestFields()` → `funnel_events` (schema is
`strict:false`, no migration needed). `collectMarketingDashboard()` gained
a `countryMap`/`countryRows` aggregation + a "Traffic by country" panel on
`/admin/marketing` (also in the JSON API; no CSV column added, out of
scope). Verified: `node -c`, 19/19 attribution tests, CN/US IP smoke test,
read-only prod check confirming old docs (missing `country`) don't break
the new aggregation (`'unknown'` bucket).

## Phase 1 — Alipay/WeChat Pay via Stripe: DONE, tested, committed

**Corrected the plan's premise via Stripe docs + a live `stripe.accounts.
retrieve()` capability check:** both payment methods are structurally
excluded from Checkout `mode: 'subscription'`/`'setup'` (not just a beta
question), and neither is Dashboard-enabled on this account yet. Built as
a separate **one-time CNY annual pass** (`mode: 'payment'`, ¥1788/yr —
matches the existing $250/yr Pro-annual price), not a Stripe Subscription:
- `app.js`: `chinaCheckoutPaymentMethods()` reads `STRIPE_ENABLE_ALIPAY`/
  `STRIPE_ENABLE_WECHAT_PAY` (both default off — feature is fully built but
  inert until the Stripe Dashboard toggle + these env vars are set).
  `grantChinaAnnualPass()`/`expireChinaAnnualPasses()`/
  `createChinaAnnualCheckoutSession()`. New `chinaAnnualExpiresAt` field on
  `SubscriptionSchema` — `activateSubscription()`'s `status:'active'` never
  expires on its own, so this one-time payment needed its own expiry path,
  scoped to `stripeSubscriptionId: null` so it can never touch a real
  Stripe subscriber.
- Routes: `GET /api/checkout/china/availability`, `POST /api/checkout/china`.
- Webhook (`/stripe/webhook`): `checkout.session.completed` now branches on
  `metadata.checkoutType === 'china_annual_pass'` *before* the existing
  subscription/no-subscription logic (that `else` branch was dead code
  today but would have granted permanent access to a one-time payment).
  Added `checkout.session.async_payment_succeeded`/`_failed` handling since
  Alipay/WeChat Pay confirm asynchronously — both route through the shared
  `handleChinaAnnualPassPaid()`.
- `expireChinaAnnualPasses()` wired into the existing daily
  `runTrialLifecycleSweep()` (app.js ~8819).
- UnionPay needs no code — it's `card` once toggled on in the Dashboard.

**Verification:** `node -c`, full suite (179/185 pass — the 6 failures are
pre-existing on HEAD, confirmed via `git stash`/rerun before this work
touched anything: sitemap-index, 2 cache-bust tests, Power-monthly pricing
test, signup-no-card-trial test, and `social-compose.test.js` which fails
in this environment on a missing `selenium-webdriver` module). No Stripe
test-mode key exists here (`sk_live` only) — true end-to-end checkout/
webhook exercise against Stripe wasn't possible; logic was verified by
reading the exact code paths and testing `chinaCheckoutPaymentMethods()`'s
empty-array 503 path manually.

**Still inert in production:** `STRIPE_ENABLE_ALIPAY`/`STRIPE_ENABLE_WECHAT_PAY`
are unset (default off) and Alipay/WeChat Pay aren't Dashboard-enabled on
the Stripe account yet — both are prerequisites the account holder must do
outside this codebase before the China checkout button does anything but
show "coming soon."

## Phase 2 — Simplified Chinese content: DONE (narrow scope), committed

Scoped down to a single page per the plan's own recommendation (no i18n
threading through the shared `nav()`/`footer()` in `app.js`, which every
page in the app depends on — too much blast radius for an unconfirmed-
demand bet). Built `frontend-v2/zh/index.html` as a **standalone static
page** (own inline header/footer, not routed through app.js's JS chrome):
hero + a single Pro-annual pricing card (¥1788/yr, translated feature
list) + a checkout button calling `POST /api/checkout/china` (shows a
"coming soon, email support@" message on the current 503, since Phase 1's
prerequisites aren't done yet — honest about actual state, nothing faked).
Reciprocal `hreflang` tags added both directions (`index.html` ↔ `zh/
index.html`, plus `x-default`). Added `/zh` to `seo-pages.js` `coreRoutes`
(sitemap). Deliberately **not done**: comparison-page translation (the
plan's stretch scope) — deferred, since mistranslating competitor pricing/
claims is a real accuracy risk and there's still no confirmed China demand
to justify it; the zh page links to the English `/compare` hub instead.

**Verification:** isolated `express.static` smoke test (not the live app,
to avoid touching live Stripe/Mongo) confirmed `/zh/` serves the new page
(200, correct title) and `/zh` 301-redirects to it, matching the existing
`coreRoutes` pattern for other extensionless routes.

## Committed and pushed
All of Phase 0+1+2 above, plus two small pre-existing uncommitted
attribution fixes from before this task (referral-hostname breakout,
internal-host classification — same two files). See git log for the
commit(s). Pushed to GitHub per explicit user instruction this turn.
**Not done: no Render deploy** — separate action, not requested, and this
repo's auto-deploy-on-push is disconnected anyway.

## Next bounded task
Nothing blocking. When there's appetite to actually turn this on:
1. Enable Alipay + WeChat Pay in the Stripe Dashboard (Settings → Payment
   methods) for this account, then set `STRIPE_ENABLE_ALIPAY=true`/
   `STRIPE_ENABLE_WECHAT_PAY=true` in Render env.
2. Get the `/zh/` pricing copy reviewed by a native speaker before any
   real marketing spend targets it (LLM-translated, not professionally
   reviewed — flagged as a risk in the original plan).
3. Watch `countryRows` on `/admin/marketing` for a few weeks before
   investing further in Phase 2 — this whole segment is still an
   unconfirmed bet.

## Prior phase (complete, compacted)
Visual-first Normal mode (Ask/Dossier/Monitor) + unit economics + Ask
research-tool gap — shipped and live-verified 2026-08-24 (plan:
`/home/hardoker77/.claude/plans/the-changes-currently-implemented-floofy-wall.md`).
Only remaining item: a real-browser visual + mobile 390px pass, blocked on
browser access.
