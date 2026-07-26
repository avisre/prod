# AppSumo attribution and public research sharing

This document covers the first-party campaign attribution and durable, unlisted
research links used by StockPortfolio.pro's social-to-AppSumo funnel.

## Campaign links

Use the bridge page when a buyer should see the tailored AppSumo explanation
before the marketplace listing:

```text
https://www.stockportfolio.pro/appsumo?source=x
https://www.stockportfolio.pro/appsumo?source=reddit
https://www.stockportfolio.pro/appsumo?source=creator
```

`source` is normalized against a fixed server-side allowlist. For an accepted
source, the server changes only the page's fixed `/go/appsumo/bridge` CTA paths
to the corresponding allowlisted path. Invalid values are ignored and are never
placed into HTML. Plain `/appsumo` keeps `bridge` as its source, which represents
unattributed traffic that arrived on the website's AppSumo page.

Use an outbound link directly when no bridge page is needed:

```text
https://www.stockportfolio.pro/go/appsumo/x
https://www.stockportfolio.pro/go/appsumo/newsletter
https://www.stockportfolio.pro/go/appsumo/partner
```

Accepted canonical sources are `x`, `linkedin`, `reddit`, `facebook`,
`instagram`, `whatsapp`, `youtube`, `stocktwits`, `email`, `newsletter`,
`website`, `app`, `report`, `creator`, `partner`, `direct`, and `bridge`.
`twitter` is normalized to `x`, and `site` to `website`. Unknown sources return
404 instead of creating an open redirect.

`GET /go/appsumo/:source` always redirects to the server-configured destination;
no request parameter controls that destination. Set:

```dotenv
APPSUMO_ATTRIBUTED_URL=https://appsumo.com/products/stockportfoliopro/
```

The value must be HTTPS, have no embedded credentials or nonstandard port, and
use `appsumo.com` or one of its subdomains. Invalid or missing configuration
falls back to `https://appsumo.com/products/stockportfoliopro/`.

Each accepted outbound click writes an `appsumo_outbound` event to
`funnel_events` with the allowlisted `source`, a random click ID, and (for a CTA
on a public report) the validated `reportId`. The endpoint also sets a signed,
90-day, HttpOnly, SameSite=Lax acquisition cookie. It contains only version,
source, timestamp, and a random click ID—no email address, user ID, IP address,
license, or report text. On stockportfolio.pro it uses a narrowly scoped
first-party domain cookie so attribution survives the apex-to-`www` transition
to the AppSumo OAuth callback.

When the same browser later completes `/api/appsumo/activate`, a valid,
unexpired cookie contributes `acquisitionSource`, `acquisitionClickId`, and
`acquisitionClickedAt` to the existing `paid` funnel event. AppSumo webhook
activations, cross-device purchases, cleared cookies, and purchases more than 90
days after the click remain intentionally unattributed.

The post-redemption email sequence is use-based, not sentiment-based: stage 1
onboarding can send on schedule, while stages 2 and 3 (which contain neutral
review requests) require at least one recorded Ask use. Ratings, thumbs feedback,
support requests, and inferred satisfaction never affect review eligibility.

## Durable unlisted research links

The share controls explain before any action that clicking creates an unlisted
public copy. Rendering or hovering never creates one. On the first explicit
social or Copy click, the browser sends:

```http
POST /api/research-shares
Content-Type: application/json

{
  "title": "MSFT research",
  "content": "Plain-text research…",
  "sourceUrl": "https://www.stockportfolio.pro/company.html?symbol=MSFT"
}
```

Authentication is optional so logged-out public research surfaces can still be
shared. This anonymous write surface is capped at 20 creations per client IP per
hour (with proxy-aware IP handling). Inputs are capped at 64 KB total, 180 title
characters, 20,000 content characters, and 2,000 source-URL characters.

Before persistence, script/style blocks and other markup are removed, control
characters are stripped, and content becomes normalized plain text. A source URL
must be same-origin and public; authentication, API, account, reset, dashboard,
and arbitrary query data are discarded. Only a validated `symbol` query is
retained. MongoDB stores the result in `public_research_shares` with a 96-bit
cryptographically random URL-safe ID and, when available, a private owner
reference. There is no TTL and no update route, so links used in posts and
newsletters remain stable.

The API returns the durable URL once:

```json
{
  "id": "AbCdEf0123_-xyZ9",
  "url": "https://www.stockportfolio.pro/r/AbCdEf0123_-xyZ9",
  "visibility": "unlisted-public",
  "createdAt": "2026-07-26T12:00:00.000Z"
}
```

The current page reuses that URL for every later platform click. If persistence
is unavailable, the social flow still works with the original page URL and tells
the user that the public link could not be created.

`GET /r/:id` renders escaped plain text, Open Graph and Twitter metadata, a
canonical URL, an unlisted-public notice, and an AppSumo CTA routed through
`/go/appsumo/report?rid=:id`. Both the HTML and response headers ask crawlers not
to index the page. `noindex` is not access control: anyone with the random URL can
view it, as disclosed in the share UI and on the report itself. There is no raw
HTML, JavaScript, comment form, or user-controlled outbound URL on this page.

For abuse response or a user's removal request, delete the exact record from
`public_research_shares` by `publicId`; the public route will then return 404.
Avoid bulk deletion because these links are intentionally durable.

## Deployment and verification

1. Set `APP_PUBLIC_URL` to the canonical HTTPS origin.
2. Set `APPSUMO_ATTRIBUTED_URL` to the official AppSumo deal/tracking URL.
3. Deploy with a stable, secret `JWT_SECRET`; rotating it invalidates existing
   acquisition cookies but does not affect public report URLs.
4. Open `/appsumo?source=x`, inspect a CTA, and confirm it points to
   `/go/appsumo/x`.
5. Follow the CTA and confirm a 302 to AppSumo plus an `sp_as_acq` cookie.
6. Share a non-sensitive research result, check its `/r/:id` preview, then reuse
   another social button and confirm the same URL is used.
7. Verify `appsumo_outbound`, `research_share_created`, and the eventual `paid`
   event in `funnel_events` before calculating source conversion.

Run the focused and full regression suites from `backend/`:

```bash
node --test test/attribution-sharing.test.js
npm test
```
