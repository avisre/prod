# AppSumo activation day — 2026-08-03

This checklist records what can be verified from the application and what still
requires an authenticated AppSumo, email, or social session. A blank item is
not treated as completed.

## Verified from production

- [x] `/api/health` returns HTTP 200.
- [x] `/appsumo/redeem` returns HTTP 200 and shows the activation page.
- [x] AppSumo test webhook returns `{ "event": "test", "success": true }`.
- [x] Earnings-quality, dilution, and filing-timeline APIs return HTTP 200 for AAPL.
- [x] The Ask recovery and AppSumo FAQ deployment is live on commit `e20eb388`.

## Requires authenticated business sessions

- [ ] Export AppSumo Sales & Analytics redeemed-code CSV.
- [ ] Export AppSumo refunded-code CSV and refund reasons.
- [ ] Reconcile gross orders, redemptions, unredeemed licenses, refunds, and
  payout with MongoDB.
- [ ] Exercise one real activation end-to-end with a testable purchase/license:
  tier grant, login, Ask allowance, portfolio save, ETF/fund research, Monitor,
  and refund revocation.
- [ ] Contact existing buyers individually through `support@stockportfolio.pro`.
- [ ] Ask for an honest review only after confirmed product use; never offer an
  incentive.
- [ ] Submit listing clarifications to AppSumo and confirm the comparison prices.
- [ ] Email William about revenue share, attribution, creator/affiliate tracking,
  audience labels, and Radar milestones.
- [ ] Contact the deduplicated warm-user cohort.
- [ ] Publish five sourced, intent-led replies and record their tracked URLs.
- [ ] Contact five relevant creators with unique tracked links.
- [ ] Record end-of-day orders, redemptions, refunds, conversations, reviews,
  qualified visits, AppSumo clicks, and reported problems.

## Guardrails

Do not call an outbound click a purchase, do not request a review before use,
do not send cold bulk email, and do not change pricing or Ask limits today.
AppSumo's Partner Portal is authoritative for purchases and refunds; MongoDB
is authoritative for redemption and in-product activation.

