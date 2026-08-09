# AppSumo activation day — 2026-08-03

This checklist records what can be verified from the application and what still
requires an authenticated AppSumo, email, or social session. A blank item is
not treated as completed.

## Verified from production

- [x] Rechecked at 03:37 IST: health, AppSumo redemption and the earnings-quality tool each return HTTP 200.
- [x] `/api/health` returns HTTP 200.
- [x] `/appsumo/redeem` returns HTTP 200 and shows the activation page.
- [x] AppSumo test webhook returns `{ "event": "test", "success": true }`.
- [x] Earnings-quality, dilution, and filing-timeline APIs return HTTP 200 for AAPL.
- [x] The Ask recovery and AppSumo FAQ deployment is live on commit `e20eb388`.

### Current database baseline (read-only, 2026-08-03)

- 4 AppSumo licenses exist in MongoDB.
- 3 licenses are redeemed and linked to user accounts.
- 1 license is currently unredeemed.
- The unredeemed license is inactive; no live customer access was granted to it.
- Tier mix among the three redeemed licenses: two tier-2 accounts and one tier-3 account.
- MongoDB does not establish refunds or gross sales; AppSumo Partner Portal export is still authoritative for those fields.

### Funnel snapshot (MongoDB, trailing 30 days)

- Page views: 5,831
- AppSumo outbound events: 118
- Free-tool views/completions: 95 / 30
- Signups/trial starts: 15 / 11
- Paid/activation events: 4 / 4
- Recorded source events: website 96, X 11, bridge 4, AppSumo 4, creator 2,
  LinkedIn 2, newsletter 1, partner 1, Reddit 1.

These are application events, not a substitute for AppSumo Sales & Analytics.
They should not be presented as verified gross sales, refunds, or channel
revenue until the Partner Portal export is reconciled.

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
- [x] Email William about revenue share, attribution, creator/affiliate tracking,
  audience labels, and Radar milestones.
- [ ] Contact the deduplicated warm-user cohort.
- [x] Publish five sourced, intent-led replies and record their tracked URLs.
- [ ] Contact five relevant creators with unique tracked links.
- [ ] Record end-of-day orders, redemptions, refunds, conversations, reviews,
  qualified visits, AppSumo clicks, and reported problems.

### Execution notes

- The connected Gmail identity is a personal Gmail account, not
  `support@stockportfolio.pro`; no customer or creator email was sent from the
  wrong identity. Reconnect the support mailbox (or configure its SMTP sender)
  before sending the drafts.
- `support@stockportfolio.pro` webmail was authenticated in Brave. Sent the
  William/AppSumo partner email to `partners@appsumo.com` from the support
  mailbox and verified it in Sent mail.
- Buyer lifecycle email was not duplicated: two older redeemed buyers already
  have stage-1 onboarding recorded, the newest redeemed buyer is not yet 24
  hours old, and no buyer currently qualifies for an honest review request.
- Private Email currently shows an active vacation notice and an active
  auto-forwarding warning. These were not changed during the campaign.
- A prior test/admin email address, `rin@gmail.com`, bounced as non-existent
  from Gmail. Do not rely on that mailbox for operational notifications unless
  the address is corrected.
- The authenticated Brave/X session was available. Six replies were posted and
  verified:
  - Zohaib thanks: https://x.com/avisre/status/2084043940945424456
  - Haz Codex memory: https://x.com/avisre/status/2084044049754067126
  - Mansa Tesla: https://x.com/avisre/status/2084044174723354982
  - QInvestor anti-dilutive: https://x.com/avisre/status/2084044284987396238
  - QInvestor IONQ per-share: https://x.com/avisre/status/2084044409239388566
  - Solybiz FORTY: https://x.com/avisre/status/2084044519159599437
- The five creator target list is not safe to send as-is: only one target has a
  verified public email in the repository. The remaining four need a current
  public contact or an authenticated platform message before outreach.

## Guardrails

Do not call an outbound click a purchase, do not request a review before use,
do not send cold bulk email, and do not change pricing or Ask limits today.
AppSumo's Partner Portal is authoritative for purchases and refunds; MongoDB
is authoritative for redemption and in-product activation.
