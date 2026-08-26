# StockPortfolio.pro customer ambassador program (Release 1)

This is a customer-first, invite-only referral MVP. It is deliberately behind
`AFFILIATE_PROGRAM_ENABLED=false` by default. It does not change prices,
AppSumo lifetime entitlements, Stripe plan access, coupons, or AI limits.

## Who can participate

Only an existing, reconciled paying customer can be invited. The operator first
marks the customer `successful_user` after a useful onboarding session, then
uses the admin invite action. The customer must accept the terms on the logged-in
`/affiliate` page before the public link becomes active. Public reviews and
private support conversations never create commission eligibility.

## External partners (Release 2, owner override recorded 2026-08-26)

The staged plan in `AFFILIATE_PROGRAM_DESIGN_RESEARCH_2026-08-13.md` holds
external affiliates until three customer ambassadors are active and five
attributable purchases exist, "unless the owner records an explicit override".
**The owner has taken that override** in order to recruit AppSumo deal-review
publishers onto the direct lifetime deal, where a referred sale returns roughly
$105 against roughly $45 through the AppSumo listing.

What that adds, and its limits:

* An `AffiliateProfile.kind` of `partner` marks an external publisher. Partners
  are enrolled only by an explicit `partner: true` on the admin invite action;
  the customer-purchase gate is unchanged for everyone else.
* Partners are not customers and are never expected to buy, so their
  eligibility comes from that deliberate enrollment rather than a purchase.
* Referral links may target `destination=lifetime` (`/lifetime`). Without it a
  partner link defaults to the AppSumo listing, which would hand the sale back
  to the marketplace at the lower share.
* Direct lifetime deals are one-time `mode: 'payment'` Checkout sessions and
  produce no invoice, so they earn through `recordStripeOneTimePaid` rather
  than `recordStripeInvoicePaid`. Commission is held for the direct refund
  window (30 days) and is clawed back on refund or dispute via `payment_intent`.
* Payout still requires manual approval and a manual batch. The default
  threshold remains $100; a partner batch may be run at an explicit lower
  minimum (clamped at $40) so a single tier-3 sale can actually be paid.

There is still no public application, no automatic invitation, and no automatic
payout. Open enrollment remains a separate, later decision.

## Referral and commission rules

* `/r/:slug` records a first-party click and sets an HttpOnly, Secure,
  SameSite=Lax signed cookie for 60 days (configurable to 1–365 days).
* The cookie contains only a random click id, timestamp and opaque slug. It does
  not contain an email, user id, password, license key or payment information.
* A later eligible affiliate click replaces an earlier affiliate click. Direct,
  organic and internal visits do not erase it.
* Existing customers are excluded from new-customer commissions and self-referrals
  are rejected.
* Stripe: 30% of collected first-year revenue for monthly/annual plans through
  Power, 20% for Desk and 10% for Firm/Enterprise. Monthly is limited to the
  first 12 paid invoices; annual is limited to the first paid invoice.
* AppSumo: 25% of actual net partner proceeds after discounts, fees, credits and
  refunds. The AppSumo CSV reconciliation workflow is authoritative for the
  proceeds amount.
* Refunds and disputes reverse or suspend commissions. Stripe has a 30-day hold;
  AppSumo has a 60-day hold. The minimum payout is 100.00 (10,000 minor
  units) per ambassador in one currency; balances from different ambassadors
  or currencies are not combined to reach it.
* Release 1 never sends an invitation automatically, creates a payout
  automatically, or calls a payout provider. An administrator approves and marks
  a manually paid batch with a reference.

## Owner endpoints

All `/api/admin/affiliates/*` and `/admin/affiliates` routes require the existing
`x-admin-token: $ADMIN_TOKEN` header and the feature flag. They return no
passwords, tokens, license keys or service credentials.

* `GET /api/admin/affiliates/reconciliation` — read-only paying-customer report.
* `POST /api/admin/affiliates/status` — set support/onboarding status.
* `POST /api/admin/affiliates/invite` — create/activate an invite record; sends
  no email and returns `sentEmail: false`.
* `GET /api/admin/affiliates` — ambassador clicks, orders and commission totals.
* `GET /api/admin/affiliates/commissions` — review commission records.
* `POST /api/admin/affiliates/commissions/:id/approve` — approve after the hold.
* `POST /api/admin/affiliates/payout-batches` — create a draft batch at/above
  the minimum; no money moves.
* `GET /api/admin/affiliates/payout-batches/:id.csv` — export a manual payout
  file for the draft/approved batch.
* `POST /api/admin/affiliates/payout-batches/:id/paid` — manually record an
  external payment reference; the reference is required.
* `POST /api/admin/affiliates/payout-batches/:id/cancel` — cancel an unpaid
  draft/exported batch and release its approved commissions for later review.
* `POST /api/admin/affiliates/appsumo/reconcile` — JSON body `{csv, dryRun,
  mapping}`; dry-run is the default and returns a normalized preview. A mapping
  such as `{ "net_proceeds": "partner payout" }` can be supplied when the
  portal uses different column names. Repeated imports are idempotent. Monetary CSV
  columns are parsed as major currency units (for example `39.50` USD) and
  stored as integer minor units.

## Customer endpoints

* `GET /api/affiliate/me` — the logged-in invited customer's link, clicks,
  orders and commission totals.
* `POST /api/affiliate/accept` with `{ "acceptTerms": true,
  "termsVersion": "customer-ambassador-v1-2026-08-13" }` — accept the exact
  current terms and activate a genuinely invited, verified-customer link.
* `GET /affiliate` — the logged-in private dashboard with a forwardable
  disclosed message, privacy-safe order status and currency-separated
  commission ledger.
* `GET /affiliate-terms.html` — the noindex, versioned customer ambassador
  terms referenced by the acceptance control.

## Security and operations

Set a high-entropy `AFFILIATE_COOKIE_SECRET` outside Git. Keep the flag off until
the reconciliation report, support status and Stripe/AppSumo webhook behaviour
have been reviewed. Rotate the cookie secret only with an intentional migration;
rotation invalidates existing referral cookies. Keep CSV uploads under 2MB and
use dry-run first. The existing Stripe/AppSumo entitlement paths are untouched.
