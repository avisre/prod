# v2 cutover plan — for the user to approve (nothing here is executed)

Goal: make `frontend-v2/` the product at `/`, retire the v1 surface gracefully,
deploy as one release. Everything below is local prep + a deploy-day checklist.

## What flips
1. **Static root**: serve `frontend-v2/` at `/` and keep `frontend/` mounted at
   `/v1` for a transition window (one line each in app.js).
2. **Page routes**: `/dashboard`, `/login`, `/register` sendFile targets switch
   to the v2 files. `/demo` → `/dashboard?demo=1`.
3. **Internal links**: v2 pages currently use absolute `/v2/...` hrefs — switch
   to root-relative (`/company.html?...`) at flip time. One find/replace across
   frontend-v2 (grep `'/v2/'`).
4. **SEO pages** (already v2-styled): change CTAs from `/v2/...` back to root
   paths in seo-pages.js at the same moment.
5. **Stripe return**: `next` param in v2 register becomes `dashboard.html`
   (drop the `v2/` prefix). The success URL still lands on register.html which
   must then be the v2 one — verify its `session=success` handling, or port
   v1's `attemptPostCheckoutLogin` into v2 register before flip (currently the
   loop relies on the v1 page; this is the ONE functional gap).
6. **Sitemap/canonicals**: seo-pages.js sitemap already lists root URLs — no
   change. Landing canonical stays `/`.

## What stays v1 (transition window)
- privacy.html / terms.html (legal text, restyle later)
- news-image proxy, market strip API consumers
- founding.html, /vs/* comparison pages (restyle in v2 language later)

## Pre-flip checklist (local)
- [ ] Port post-checkout auto-login into v2 register (item 5 above)
- [ ] Find/replace `/v2/` hrefs → root-relative across frontend-v2
- [ ] Re-run the 375px overflow sweep + full Selenium suite
- [ ] One real-card trial signup end-to-end (user)
- [ ] Lighthouse pass on / (landing), /company, /screener

## Deploy-day checklist
- [ ] Commit everything (5 stints + v2) — suggest separate commits: data fixes,
      backend features, v1 funnel fixes, v2 app
- [ ] Deploy (user's button)
- [ ] Smoke: /, /screener, /company?symbol=AAPL, /stocks/AAPL, register flow,
      Ask streaming, alerts on a real account
- [ ] Watch Clarity/GA for 404s and rage-clicks in the first hour

## Rollback
v1 remains in the repo untouched; flip the two static mounts back and redeploy.
