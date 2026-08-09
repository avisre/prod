# Thirty-day customer ambassador operating plan

This is an operating checklist, not an automated campaign. Use only
`support@stockportfolio.pro` for approved customer communication. Drafts are
prepared manually; this feature never sends invitations or bulk email.

## Days 1–3 — reconcile and support

1. Run `node scripts/reconcile-affiliates.js` with the same Mongo environment as
   production. Confirm the eight paying-account records, seven redeemed
   AppSumo accounts, and any Stripe warning without changing data.
2. Review `/api/admin/affiliates/reconciliation` and mark support status.
3. Personally help each verified buyer reach a sourced result. Do not invite
   anyone who has not reached meaningful value.

## Days 4–7 — onboarding evidence

Aim for five customer responses and four useful onboarding/research sessions.
Record `successful_user`, `needs_support`, `declined` or `unresponsive` with the
admin endpoint. Keep support questions and feedback in the normal support
workflow.

## Days 8–10 — invite approximately three customers

Use the admin invite endpoint only for `successful_user` customers. Send the
approved invitation manually from support@stockportfolio.pro. The customer must
log in, read the disclosure and accept terms at `/affiliate`.

## Days 11–14 — observe

Review clicks, AppSumo activation records, Stripe checkout attribution and
commission holds. Improve the forwardable message if links are shared but do
not receive clicks. Do not recruit external affiliates yet.

## Days 15–30 — gate expansion

Prepare (but do not send) a small external-affiliate list only after at least
three customer ambassadors are active and five attributable purchases exist.
Pause if refunds exceed 10%, the product is unreliable, or support objections
remain unresolved.

## Decision rules

* Fewer than four of eight customers respond → improve onboarding first.
* Referral visitors but fewer than 5% start a trial → improve the landing page.
* Trials but fewer than 10% purchase → investigate reliability, onboarding and
  positioning.
* Scale an ambassador only after three non-refunded purchases.
* Do not build expensive automation before 10 attributable direct purchases.

