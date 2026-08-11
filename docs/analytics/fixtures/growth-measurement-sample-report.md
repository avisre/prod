# Growth Measurement V1 (28 days)

Generated with:

```bash
node scripts/report-growth-measurement.js \
  --fixture=docs/analytics/fixtures/growth-measurement-sample.json \
  --output=docs/analytics/fixtures/growth-measurement-sample-report.md
```

The fixture intentionally contains no production events or external snapshots;
zeros and em dashes below demonstrate the report shape without inventing data.

Window: 2026-07-14T00:00:00.000Z → 2026-08-11T00:00:00.000Z

## First-party funnel

| Metric | Value |
|---|---:|
| Unique visitors | 0 |
| Unique sessions | 0 |
| Registered users | 0 |
| CTA visitors | 0 |
| Signups | 0 |
| Activated accounts | 0 |
| Paid customers (AppSumo redemption or Stripe invoice) | 0 |

| Event | Count |
|---|---:|
| pricing_viewed | 0 |
| cta_clicked | 0 |
| appsumo_outbound_clicked | 0 |
| signup_started | 0 |
| checkout_started | 0 |
| signup_completed | 0 |
| research_outcome_completed | 0 |
| activation_completed | 0 |
| appsumo_redemption_started | 0 |
| appsumo_redemption_completed | 0 |
| stripe_checkout_created | 0 |
| stripe_checkout_completed | 0 |
| subscription_started | 0 |
| invoice_paid | 0 |
| payment_refunded | 0 |
| subscription_canceled | 0 |
| review_eligible | 0 |
| review_request_sent | 0 |
| review_received | 0 |
| support_outcome_confirmed | 0 |

## Conversion rates

All four rates are `—` because the fixture has no denominator.

## Attribution, pages, content, retention and data quality

The generated JSON sections are empty or zero-valued for this fixture. In a
real report they contain first-touch and last-non-direct channel funnels,
landing-page/CTA/content performance, D1/D7/D30 retention, missing-identifier
counts, duplicate event/dedupe keys, invalid canonical payloads, and internal,
QA and bot exclusions.

## External snapshots

GA4, Clarity, AppSumo Partner Portal and Stripe are `attached: false`. They are
never silently merged with first-party events; attach sanitized exports with
`--ga4`, `--clarity`, `--appsumo` and `--stripe` when available.
