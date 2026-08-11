# Measurement definitions

GA4 active users, Clarity sessions, first-party events, AppSumo portal sales,
partner payout, buyer GMV and Stripe MRR are separate measures. Do not add them
together or label a payout as GMV/MRR. Missing historical source attribution is
`unknown`, not direct. A 7/28/90-day report must state its non-overlapping
window and exclude internal, QA, bot and test events from conversion rates.

Verified Stripe event revenue is the selected-period sum of
`invoice_paid.amountMinor` less `payment_refunded.amountMinor`. Active MRR is a
current-subscription snapshot and is never inferred from a Stripe Customer
object, a checkout click or a one-time payment.
