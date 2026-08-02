# AppSumo first-50 operating plan

AppSumo remains the primary checkout until StockPortfolio.pro reaches 50 net
active customers. The operating target is 55 gross orders with no more than
five refunds. These are planning targets, not forecasts.

## Definition of an activated customer

A customer is activated after they complete all three steps:

1. One successful stock, ETF, or fund analysis.
2. At least three holdings added.
3. Ask used or Portfolio/Filing Monitor enabled.

Track redemption, activation, repeat use in a second week, support response
time, refunds, and honest reviews separately from purchase count.

## Funnel and attribution

External traffic uses first-party `/go/appsumo/:source` bridge links with an
allowlisted `source`, signed campaign cookie, and optional `content_id`. The
AppSumo activation form also asks buyers where they first discovered the
product. This self-reported field is intentionally separate from signed
technical attribution because purchases can happen on another device or
inside AppSumo.

Use the admin marketing dashboard and customer CSV together. AppSumo's Partner
Portal remains authoritative for gross orders, refunds, refund reasons, and
unredeemed codes; MongoDB is authoritative for redemption and product
activation. Never infer a purchase conversion rate from outbound clicks alone.

## Eight-week working cadence

Aim for 60–75 qualified AppSumo visits per week. The planned gross-order
targets are 4, 5, 6, 6, 7, 7, 8, and 8 across weeks 1–8, starting from the
verified current baseline. Reallocate most effort after two weeks toward the
two sources producing activated buyers, not the sources producing likes.

Daily:

- Capture the previous AppSumo day after its UTC reset (around 6:30–7:00 PM IST).
- Review qualified clicks, tool completions, signups, trials, redemptions,
  activations, support failures, and refunds by cohort.
- Publish or reply only when there is a genuine investor question and a
  source-backed result to show.

Weekly:

- Reconcile redeemed/refunded AppSumo CSVs with MongoDB.
- Review the three best activated-buyer sources and content IDs with clicks but
  no purchase.
- Review tier mix, support tags, refund reasons, and review conversion.
- Make one conversion change; do not change listing, onboarding, and channel
  strategy simultaneously.

## Review and support policy

Ask for an honest review only after the buyer has used the product. Never offer
credits, upgrades, gifts, or other incentives. Keep customer lifecycle email
through `support@stockportfolio.pro`, preserve opt-outs, and avoid cold bulk
email. The first response target is under four hours during US daytime.

## Stop and adjust rules

- Fewer than five purchases after 100 qualified external clicks: change the
  message or listing.
- Fewer than 70% of redemptions reach first value: fix onboarding before adding
  traffic.
- Refunds above 10% or two activation failures in one week: pause acquisition
  and fix the underlying issue.
- More than 70% Starter selection: clarify Investor/Pro differentiation.
- Creator traffic below 5% conversion after 100 clicks: change creator
  targeting.
- Do not buy ads until revenue share, mature refunds, and lifetime AI/support
  cost are known.

