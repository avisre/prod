# Growth Measurement V1

Status: implemented on branch `feat/growth-measurement-v1`; not deployed.

This is a privacy-safe first-party measurement contract. It separates intent
(browser events) from business truth (server events) and keeps GA4/Clarity
diagnostic. Historical rows without attribution remain `unknown`; no backfill
is inferred.

## Verified baseline (11 August 2026)

These figures are preserved as separate system snapshots, not combined into a
funnel: GA4 has 773 active users in 90 days (669 Direct); it has no observed
AppSumo-click, signup, activation or checkout events. Clarity has 566 sessions
and 540 users. The AppSumo Partner Portal shows 7 sales, 0 refunds and a
$155.70 partner payout; buyer GMV is unavailable. The local database has 8
licence records (7 redeemed/user-linked and one unresolved). Stripe active
recurring MRR is $0. Existing first-party analytics has 10,735 retained events,
approximately 95.3% without source. Strongest public surfaces are `/compare`,
`/stocks` and individual stock pages. Affiliates remain disabled until three
customers confirm successful outcomes.

Never relabel 773 as funnel entrants, 669 as proven brand traffic, $155.70 as
GMV, 8 records as current paying customers, AppSumo payout as MRR, or a click /
redemption as a sale.

## What is captured

The signed `sp_growth_attr` cookie contains a random anonymous ID and three
allowlisted records: immutable `firstTouch`, `lastNonDirectTouch`, and
`currentSessionTouch`. A direct visit never overwrites the first or last
qualifying non-direct touch. Self-referrals are `internal`, and user agents are
classified as `bot`/`browser` before reporting. The default retention is 90 days
(`ATTRIBUTION_MAX_AGE_DAYS`), configurable without changing the event schema.
The existing `sp_mkt_sid` session cookie remains compatible.

Only `utm_source`, `utm_medium`, `utm_campaign`, `utm_content`, `utm_term`,
`content_id`, approved click IDs, referrer hostname, landing pathname, CTA ID
and environment are retained. Paths are stored without query strings.

## Canonical event dictionary

| Event | Owner | GA4 mapping | Meaning |
|---|---|---|---|
| `pricing_viewed`, `cta_clicked`, `appsumo_outbound_clicked`, `signup_started`, `checkout_started` | browser (consent required) | custom | Intent only; never a sale |
| `signup_completed` | `/api/subscribe`, social auth | `sign_up` | Account created on the server |
| `research_outcome_completed` | authenticated workflow | custom | Valid result plus source opened |
| `activation_completed` | server, once/account | custom | First qualified outcome |
| `appsumo_redemption_started`, `appsumo_redemption_completed` | AppSumo lifecycle | custom | License lifecycle only |
| `stripe_checkout_created`, `stripe_checkout_completed` | Stripe checkout/webhook | `begin_checkout`, custom | Checkout lifecycle; not proof of payment |
| `invoice_paid` | verified Stripe webhook | `purchase` | Paid recurring invoice |
| `subscription_cancel_scheduled`, `subscription_canceled` | verified Stripe webhooks | custom | Subscription status |
| `payment_refunded` | verified Stripe webhook | `refund` | Verified refund only |
| `review_eligible`, `review_request_sent`, `review_received`, `support_outcome_confirmed` | customer-success workflow | custom | Explicit lifecycle states |

Every new row has `eventId`, `eventName`, `schemaVersion`, `occurredAt`, opaque
user ID, attribution snapshots, page type/path, content/CTA ID, plan/billing,
entitlement source, feature type, environment and internal/test/bot flags.
`dedupeKey` is partial-unique when it is a real string; Stripe/AppSumo retries therefore do
not create another business event.

## Metric definitions

* **Signup**: a server-created account (`signup_completed`), not a GA4 user.
* **Activation**: one account-level `activation_completed` after a successful
  sourced Ask answer, comparison, portfolio with a holding, or Filing Monitor
  workflow. Underlying `research_outcome_completed` rows remain available.
* **AppSumo click**: outbound intent only. A sale is counted only from the
  Partner Portal export; redemption is not a sale.
* **Stripe paid recurring customer**: a verified, idempotent webhook linked to
  a user. A Stripe Customer object alone is never counted.
* **Active MRR**: normalized monthly value of active paid recurring subscription
  lines, excluding trials, canceled/unpaid/refunded/test activity and one-time
  payments. AppSumo payout and GMV are separate LTD metrics.
* **Traffic**: `direct`, `unknown`, `internal`, `bot`, or an allowlisted named
  channel. GA4 active users and first-party event counts are not interchangeable.

## GA4 and Clarity configuration

Normal browser GA4/Clarity loading remains consent-gated. The optional server
augment is disabled unless all are set in Render/local secrets:

```text
GA4_MP_ENABLED=false
GA4_MEASUREMENT_ID=G-XXXXXXXXXX
GA4_API_SECRET=<server secret, never commit>
ATTRIBUTION_MAX_AGE_DAYS=90
```

Set `GA4_MP_ENABLED=true` only after validating in development with
`backend/ga4-server.js`'s `validationUrl()`. Register these GA4 custom
dimensions manually (no property mutation is performed here):
`content_id`, `cta_id`, `page_type`, `feature_type`, `entitlement_source`,
`traffic_category`, `event_name`, and `schema_version`. Mark `sign_up`,
`purchase`, `refund` and `activation_completed` as key events only after QA.

Clarity receives low-cardinality event names/tags (`page_type`, `cta_id`) after
consent. Inputs and authenticated content remain masked. No email, name, prompt,
answer, holding, licence code or raw user ID is sent.

## Read-only reports and imports

```bash
node scripts/report-growth-measurement.js --days=28 --output=/tmp/growth.md
node scripts/report-growth-measurement.js --days=90 --ga4=/tmp/ga4-sanitized.json --clarity=/tmp/clarity-sanitized.json --appsumo=/tmp/appsumo-sanitized.json --stripe=/tmp/stripe-sanitized.json --output=/tmp/growth-90.md
node scripts/report-growth-measurement.js --fixture=docs/analytics/fixtures/growth-measurement-sample.json --output=/tmp/growth-fixture.md
node scripts/import-x-analytics.js --input=/tmp/x-content.csv
node scripts/import-appsumo-portal.js --input=/tmp/portal.csv --output=/tmp/portal.json
node scripts/import-appsumo-portal.js --input=/tmp/portal.csv --apply=true
node scripts/migrate-growth-measurement-indexes.js --apply=false
```

The AppSumo command is dry-run by default and stores only a one-way row
fingerprint plus aggregate fields when explicitly applied. It cannot reconcile
the unresolved eighth local license without authoritative portal evidence.

The report keeps unique visitors, sessions and registered users separate;
reports conversion by first and last non-direct touch; includes landing-page,
CTA and content-ID tables; calculates eligible D1/D7/D30 activated-user
retention; compares the selected period with the preceding equal period; and
surfaces data-quality counts (missing identifiers, duplicate IDs/dedupe keys,
invalid canonical payloads, client/server event counts and excluded traffic).
Optional external snapshots are allowlisted and redacted before appearing in
the report. The Stripe snapshot schema is aggregate-only (`paidConversions`,
`activeMrr`, `recurringRevenue`, `scheduledToCancelMrr`, `churn`, `refunds`,
`testModeExcluded`); it never accepts customer or invoice identifiers.

`migrate-growth-measurement-indexes.js` is read-only unless `--apply=true` is
explicitly supplied. It aborts before creating the partial unique dedupe index
when duplicate keys are present. No migration was executed for this branch.

Campaign URLs are generated by `scripts/campaign-link.js`; stable IDs can be
created with `buildCampaignId({source, date, kind, sequence})`. The registry is
`marketing/content-registry.csv`.

## Privacy and rollback

The new endpoint rejects browser events without explicit consent and drops QA,
bot and internal traffic from reportable output. `metaForFunnel` strips common
sensitive fields before persistence. If a regression appears, set
`GA4_MP_ENABLED=false`, stop using `/api/track/event`, and remove the
`sp_growth_attr` cookie; legacy funnel rows and payment logic remain intact.
No production data migration is required.

## Manual launch checklist

1. Review the event dictionary and event payloads in a staging Mongo database.
2. Confirm GA4 Measurement Protocol validation returns no PII warnings.
3. Confirm consent granted/declined behavior and Clarity masking in both desktop
   and mobile browsers.
4. Replay Stripe/AppSumo test webhooks; verify partial dedupe keys prevent repeats.
5. Run backend tests and inspect a sanitized report for Direct/Unknown/Internal/Bot.
6. Configure GA4 custom dimensions manually if approved.
7. Deploy only after the owner reviews this branch; no deploy is part of V1.
