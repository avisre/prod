# Retargeting pixels — Meta Pixel + Google Ads

This documents the env-driven Meta Pixel and Google Ads conversion tracking added
in the `growth/seo-pixel-pass` branch. **Everything is off by default.** With the
environment variables unset (the current production state), nothing loads, no
network calls fire, and there are zero console errors — shipping this with the IDs
absent is completely safe.

## Environment variables

| Variable | Purpose | Unset behaviour |
| --- | --- | --- |
| `META_PIXEL_ID` | Meta (Facebook) Pixel ID | Meta Pixel never loads |
| `GOOGLE_ADS_ID` | Google Ads tag ID, e.g. `AW-1234567890` | Ads tag never loads |
| `GOOGLE_ADS_CONVERSION_LABEL_SIGNUP` | Conversion label for the signup action | signup conversion not sent |
| `GOOGLE_ADS_CONVERSION_LABEL_SUBSCRIBE` | Conversion label for the paid action | subscribe conversion not sent |

Set them as Render environment variables on the backend service. No code change,
no redeploy of assets — the next render of an SSR page and the next
`/api/analytics/config` fetch pick them up. To turn the pixels back off, unset the
variables; the site returns to a clean no-pixel state.

Nothing is hardcoded. `ADMIN_TOKEN` and anything under `secrets/` are untouched.

## Architecture (one source of truth, two delivery paths)

All pixel logic lives in [`backend/pixels.js`](../backend/pixels.js):

- `pixelConfig()` reads the four env vars and returns `{ metaPixelId, googleAdsId,
  signupLabel, subscribeLabel }` (empty strings when unset).
- `pixelHeadSnippet()` returns the inline `<head>` `<script>` — **or `''`** when no
  IDs are configured.

Two surfaces deliver it because the site is split:

1. **SSR marketing pages** (`/stocks`, `/stocks/:ticker`, `/compare`,
   `/compare/:pair`, `/screens/*`, `/vs/:competitor`) render server-side and do
   **not** load `assets/app.js`. They inject `pixelHeadSnippet()` directly into
   `<head>`, right where they already load GA4/Clarity — see
   [`backend/seo-pages.js`](../backend/seo-pages.js) and
   [`backend/comparison-pages.js`](../backend/comparison-pages.js).

2. **App pages** (the 19 static `frontend-v2/*.html` pages) load
   [`frontend-v2/assets/app.js`](../frontend-v2/assets/app.js). After analytics
   consent, `loadAnalytics()` calls `loadPixels()`, which fetches
   `GET /api/analytics/config` and injects the same Meta + Ads tags. The endpoint
   mirrors the existing `/stripe/config` pattern.

Both paths expose the same `window.spTrack(name, params)` helper and read the same
`window.__spPixelCfg`, so a funnel event fires identically wherever it is raised.
`window.spTrack` is **always defined** and is a safe no-op until a pixel actually
loads — handlers can call it unconditionally.

## PageView

The site is a multi-page app (every navigation is a full page load), so a single
`fbq('track','PageView')` in the base snippet and the gtag `config` fire **once per
navigation** automatically. There is no SPA router, so no extra route-change wiring
is needed — every route change is a real page load and tracks itself.

## Funnel events (wired at the real handlers)

Wired in the inline script of
[`frontend-v2/register.html`](../frontend-v2/register.html) — the live email
signup/checkout flow (not a stub):

| `spTrack(...)` | Meta event | Google Ads | Real handler |
| --- | --- | --- | --- |
| `signup` | `CompleteRegistration` | conversion @ `SIGNUP` label | no-card success: `r.ok && data.token && !data.url` |
| `trial_start` | `StartTrial` | — | same branch, when `plan !== 'free'` (no-card trial) |
| `initiate_checkout` | `InitiateCheckout` | — | paid redirect: `r.ok && data.url` → Stripe |
| `subscribe` | `Purchase` (value + currency) | conversion @ `SUBSCRIBE` label (value + currency) | Stripe return `?session=success` → login token |

`Purchase` value comes from the `PLAN_VALUE` map in `register.html`
(Monthly 12, Annual 118, Pro 33, Pro Annual 250, Power 579, Power-monthly 64,
Desk 1961).

### ⚠️ Currency: USD, not GBP

The task spec asked for `Purchase` in **GBP**. This app **bills in USD** — every
plan price in `backend/app.js` (`CORE_PLAN_CURRENCY = 'USD'`, etc.) and on the
register page is USD. Reporting GBP values while charging USD amounts would feed
the ad platforms a wrong conversion value (currency is a multiplier in ROAS
math). So `Purchase` and the Ads subscribe conversion fire with **`currency:
'USD'`** — the real charged currency. If the business actually moves to GBP
pricing, change `PLAN_VALUE` and the `currency` argument together. **Flagged for
your call.**

## ⚠️ Consent + the banner copy change

Pixels on app pages load **only after the user grants analytics consent**
(`sp_analytics_consent_v1 === 'granted'`), reusing the existing consent gate. On
SSR marketing pages — which already load GA4/Clarity unconditionally and never
showed a consent banner — the pixel snippet loads on the production hostname but
**skips entirely if the visitor previously clicked "Decline"** on an app page.

The old consent banner copy promised *"nothing else, no ad tracking."* That is no
longer true once retargeting pixels load behind it, so the copy was updated to:

> **Optional analytics & marketing.** We'd like to measure which pages convert
> and, with our ad partners, show you relevant ads off-site. Allow it?

**Please review this copy.** Depending on your audience/jurisdiction (GDPR/ePrivacy
for EU/UK visitors), you may want the pixels gated behind consent on the SSR pages
too, or a region-specific banner. Right now SSR marketing pages fire pixels for
visitors who never explicitly declined.

## Known limitations / recommended follow-ups

- **Social (Google) sign-ups** go through `V2Social` (`assets/social.js`), a
  different success path than the email handlers instrumented here. Those signups
  are **not** yet pixel-tracked. TODO: raise `spTrack('signup')` in the social
  success callback.
- **In-app upgrades** (the trial-banner "Keep Pro" → Stripe flow in `app.js`)
  return to the dashboard, not the `register.html` `?session=success` handler, so
  that `Purchase` is not captured client-side. TODO: instrument the dashboard
  return, or prefer the server-side path below.
- **Client-side `Purchase` is best-effort.** Instant navigation after the event
  can occasionally drop the beacon. The reliable source of truth is the Stripe
  webhook (`trackFunnel('paid')` in `app.js`). **Recommended:** wire Meta
  Conversions API (CAPI) and Google Ads offline conversions to that webhook for
  deduplicated, ad-blocker-proof conversion tracking.

## Verifying the no-op (IDs unset)

- `GET /api/analytics/config` → `{"metaPixelId":"","googleAdsId":"","signupLabel":"","subscribeLabel":""}`
- SSR page source contains **no** `connect.facebook.net` / `googletagmanager.com/gtag/js?id=AW-` markup.
- Browser console is clean; `window.spTrack('signup')` is callable and does nothing.
