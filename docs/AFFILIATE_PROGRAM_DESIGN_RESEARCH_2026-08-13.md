# Affiliate program design decision brief

**Date:** 2026-08-13  
**Scope:** Product and UX decisions for the existing StockPortfolio.pro customer
ambassador program. The Release 1 dashboard and safety hardening described here
are implemented locally behind the disabled feature flag; this document does
not change customer access or deployment state.

## Decision

Release 1 remains a **customer-first, invite-only ambassador program**.

- Only an existing, reconciled paying customer who has achieved a useful
  research outcome and is marked `successful_user` may be invited.
- The customer must sign in, read the disclosure and terms, and explicitly
  accept them before the referral link becomes active.
- There is **no public application or open enrollment in Release 1**.
- Invitations are not automatic.
- Commission approval and payout remain manual.
- There is **no automatic payout provider or automatic transfer of money**.
- Reviews and private support conversations never create commission
  eligibility.

This is intentionally more conservative than the instant-enrollment pattern
used by some large programs. TradingView permits immediate dashboard access but
verifies affiliates and their traffic sources before withdrawal. HubSpot and
Seeking Alpha review applications before acceptance. For a small financial
research product, approving the ambassador before activating the link provides
the clearer trust boundary.

## Authoritative Release 1 commercial rules

This brief preserves the rules already documented in
`docs/AFFILIATE_PROGRAM.md`.

| Area | Release 1 rule |
| --- | --- |
| Attribution | The last **eligible affiliate click** within 60 days wins. A later eligible affiliate click replaces an earlier one; direct, organic and internal visits do not erase it. |
| Tracking | First-party, signed 60-day cookie containing only an opaque ambassador slug, random click ID and timestamp. |
| Eligibility | New customers only. Existing-customer purchases and self-referrals are ineligible. |
| Stripe through Power | 30% of collected first-year eligible revenue. Monthly plans earn on no more than the first 12 paid invoices; annual plans earn only on the first paid invoice. |
| Stripe Desk | 20% under the same eligible-invoice rules. |
| Stripe Firm/Enterprise | 10% under the same eligible-invoice rules. |
| AppSumo | 25% of **actual net partner proceeds**, after discounts, fees, credits and refunds. The reconciled AppSumo Partner Portal CSV is authoritative, not the displayed retail sale price. |
| Hold | 30 days for Stripe commissions; 60 days for AppSumo commissions. |
| Minimum payout | 100.00 per ambassador in one currency of approved, unreversed commission; ambassadors and currencies are not pooled. |
| Refunds/disputes | Reverse or suspend the related commission. |
| Payout | Administrator-reviewed, manually exported and manually paid. An external payment reference is recorded afterwards. |

Do not describe the rule simply as "last click" without the words **eligible
affiliate click**. That distinction explains why direct visits do not erase an
ambassador's attribution and why self-referrals and existing-customer upgrades
do not qualify.

## Release 1 invitation and activation experience

The recommended flow is:

1. Reconcile the paying customer and resolve outstanding support issues.
2. Record evidence that the customer achieved a successful research outcome.
3. Mark the customer `successful_user`.
4. Invite the customer manually. The invitation action itself sends no email.
5. The customer signs in with the existing StockPortfolio.pro account.
6. `/affiliate` shows the terms, disclosure, exact commission rules, hold
   periods and manual-payout explanation before enabling sharing.
7. The customer accepts the terms; only then does the link become active.
8. The ambassador shares the active link with the required disclosure.
9. The dashboard reports privacy-safe activity and commission status.
10. An administrator reviews mature commissions, creates a manual payout batch,
    pays it externally, and records the payment reference.

The customer-facing status should be visible in plain language:

`Invited -> Terms accepted -> Link active -> Commission pending -> Approved -> Paid`

Exceptional states must also be explicit: `Suspended`, `Reversed` and
`Ineligible`. Never leave an ambassador to infer a status from a zero balance.

## Dashboard information architecture

Release 1 should stay compact. It does not need marketplace discovery,
leaderboards, badges, gamification, public recruitment or complex campaign
management.

### 1. Overview

- Program status and terms-acceptance date.
- Eligible clicks, attributed purchases and conversion rate, with a defined
  date range and timezone.
- Pending, approved and paid commission totals shown separately.
- A clear warning that pending commission is not yet payable.

### 2. Referral link

- One canonical `/r/amb-...` link using an opaque public identifier.
- Copy button with an accessible success message.
- Allowed destination shown before copying.
- A short explanation of the 60-day last-eligible-affiliate-click rule.
- A safe link-test action that cannot create a self-referral commission.

Release 1 should not expose arbitrary redirect URLs. Allowlisted deep links and
campaign sub-IDs belong to Release 2 after attribution has been verified.

### 3. Referrals

- Privacy-safe referral/order identifier.
- Provider (`stripe` or `appsumo`), eligible plan, order date and lifecycle
  status.
- No referred customer's name, email, research activity, portfolio, AppSumo
  code or payment identifiers.

### 4. Commissions and payouts

Each ledger row should explain:

- eligible proceeds basis;
- commission rate;
- gross commission;
- reversal amount, if any;
- provider;
- hold-until date;
- current state;
- plain-language reason for a reversal or ineligibility;
- payment date/reference after manual payment.

### 5. Sharing rules and support

- Required disclosure copy.
- Allowed and prohibited promotion methods.
- Approved product descriptions and screenshots.
- Support contact and program terms.

A larger creative library, application workflow and performance reports remain
Release 2 work, not Release 1 requirements.

## Commission and payout-state presentation

The current persisted commission states are `pending`, `approved`, `reversed`
and `paid`; payout batches are `draft`, `exported`, `paid` or `cancelled`.
Customer-facing labels should explain these existing states rather than invent
an unsupported payout promise:

| Stored state | Recommended customer label | Explanation |
| --- | --- | --- |
| `pending` before `holdUntil` | Pending — refund hold | Recorded but still inside the 30- or 60-day hold. |
| `pending` after `holdUntil` | Pending review | Hold has elapsed but an administrator has not approved it. |
| `approved` | Approved for manual payout | Eligible for a future manual batch once that ambassador reaches 100.00 in one currency. |
| `reversed` | Reversed | Refunded, disputed or otherwise ineligible; show the non-sensitive reason. |
| `paid` | Paid | Paid externally and recorded with a date/reference. |

Do not call a date "guaranteed." If shown, label it as the **earliest review
date** or **estimated availability date** because refund review, reconciliation
and the minimum threshold still apply.

PartnerStack's current dashboard is a useful benchmark: it separates pending,
available and declined commission, exposes decline reasons and estimated dates,
and provides withdrawal history and CSV exports. Rewardful similarly separates
Pending, Due and Paid and makes the payout threshold visible. StockPortfolio
should adopt that clarity while retaining its existing manual process.

## Disclosure and financial-research trust rules

The disclosure must be shown beside the referral link and included in the
forwardable message, not hidden only in terms or a profile page.

Recommended default wording:

> Affiliate link — I may earn a commission if you purchase, at no extra cost to
> you. StockPortfolio.pro is research software, not personal investment advice.

The disclosure must be in the same language as the endorsement and remain hard
to miss. An ambassador must not rely only on a platform's disclosure tool.

Program rules should prohibit:

- guaranteed returns, investment performance or business-longevity claims;
- invented product experience, testimonials or research results;
- presenting AI output as verified fact without checking the cited source;
- speaking as if the ambassador is StockPortfolio.pro;
- personalized buy/sell recommendations made on StockPortfolio.pro's behalf;
- spam, automated unsolicited outreach and misleading redirects;
- self-referrals, multiple affiliate identities and cookie manipulation;
- brand-search bidding, impersonating domains or unauthorized brand assets;
- unauthorized discounts, cashback or incentives;
- hiding the compensated relationship.

Approved promotional material should demonstrate the product's actual trust
loop:

`research question -> filing evidence -> source link -> limitation`

It should not use profit screenshots, fabricated scarcity, price targets or
"beat the market" language.

The FTC requires a material relationship to be disclosed clearly and with the
endorsement itself. TradingView's financial-product program separately
prohibits spam, self-referrals, brand bidding, misleading imitation and
unauthorized incentives. FCA and SEC rules may add obligations where a specific
communication or business falls inside their regulatory perimeter; legal
applicability must be assessed rather than assumed.

## Privacy and security decisions

- Keep the signed referral cookie `HttpOnly`, `Secure` and `SameSite=Lax`.
- Keep email addresses, account IDs, license keys and payment data out of the
  cookie and public URL.
- Show opaque referral IDs—not customer identity—in the ambassador dashboard.
- Keep administrative payout exports behind existing administrator
  authorization.
- Do not expose customer research questions, securities, portfolios or Ask
  output to ambassadors.
- Record terms acceptance, commission changes, reversals and payout references
  in the administrator audit trail.
- Treat payout-detail changes as high-risk actions when payout automation is
  eventually designed; use strong reauthentication and notifications.
- Explain the referral cookie and retention period in the privacy/cookie notice,
  and apply jurisdiction-appropriate consent behavior. The ICO's 2026 guidance
  specifically identifies affiliate tracking IDs and pixels as storage/access
  technologies.

## Mobile and accessibility decisions

- Stack summary metrics on narrow screens rather than shrinking labels and
  amounts beyond readability.
- Present ledger rows as labelled blocks on mobile, with the same amounts,
  dates, reasons and statuses available as desktop.
- Never communicate Pending, Approved, Reversed or Paid by color alone.
- Use semantic headings, tables and buttons; all controls must work by keyboard.
- Give Copy and terms-acceptance actions accessible names and visible focus.
- Announce copy success and state changes through an accessible status message.
- Meet WCAG 2.2's 24-by-24 CSS-pixel minimum target requirement; aim for
  44-by-44 for primary touch actions.
- Preserve text zoom and reflow without page-level horizontal scrolling.

## Staged release gates

### Release 1 — invited customer ambassadors

Keep `AFFILIATE_PROGRAM_ENABLED=false` until production attribution,
Stripe/AppSumo commission calculation, refunds, webhook idempotency and manual
payout-batch behavior have been verified. Then:

- invite only successful, reconciled customers;
- begin with three ambassadors;
- manually inspect initial clicks and purchases;
- keep all commissions pending through their correct hold period;
- approve and pay manually only after reconciliation and the per-ambassador, per-currency 100.00 threshold;
- stop or disable the flag if attribution, entitlement or reversal behavior is
  unexpected.

There is no public signup, automatic invitation or automatic payout in this
stage.

### Release 2 — external affiliates

Do not open applications until:

- at least three customer ambassadors are active;
- at least five attributable purchases exist, unless the owner records an
  explicit override;
- customer/ambassador feedback is recorded; and
- production attribution has been verified.

Only then design the public application and approval workflow, allowlisted
deep-link generator, creative library, campaign tracking, fraud flags and
external dashboard. Release 2 still requires an explicit decision before open
enrollment; meeting the gate does not automatically enable it.

### Release 3 — professional partners and payout automation

Do not add payout-provider automation or professional partner workflows until:

- at least 10 attributable direct purchases exist;
- at least five partners have generated a purchase;
- refund performance is acceptable; and
- commission calculations and manual payouts have been verified.

At that point, assess a managed payout provider or Stripe Connect hosted or
embedded onboarding. Do not build custom bank/KYC collection when a maintained,
localized provider flow can handle changing requirements.

## Primary and official sources

- [TradingView Partner Program](https://www.tradingview.com/partner-program/) —
  partner tools, real-time tracking, reporting, payment and attribution-window
  presentation.
- [TradingView Partner Program Rules](https://www.tradingview.com/partner-rules/) —
  enrollment verification, eligible purchases, refunds, chargebacks,
  self-referrals, spam, brand bidding and payout rules.
- [Seeking Alpha Affiliate Program](https://about.seekingalpha.com/affiliate-program) —
  application review, referral link, 30-day cookie, last-click attribution and
  Net 30 payment.
- [HubSpot Affiliate Program](https://www.hubspot.com/partners/affiliates) —
  application review, dashboard platform, cookie, payout methods and minimum.
- [Webflow affiliate program overview](https://help.webflow.com/hc/en-us/articles/33961372613011-Webflow-s-affiliate-program-overview) —
  dashboard coverage of links, traffic, conversions, payments and program
  communication.
- [PartnerStack dashboard overview](https://support.partnerstack.com/hc/en-us/articles/360016866594-Comprehensive-overview-of-the-partner-dashboard) —
  information architecture for links, referrals, performance, reporting and
  commissions.
- [PartnerStack payout guide](https://support.partnerstack.com/hc/en-us/articles/360009501113-How-do-I-get-paid) —
  pending/available states, estimated dates, decline visibility, withdrawals and
  CSV exports.
- [Rewardful campaign settings](https://help.rewardful.com/en/articles/14148863-campaign-settings-overview) —
  private invite-only campaigns, first/last-touch attribution, opaque links and
  customer-identity controls.
- [Rewardful commission payout guide](https://help.rewardful.com/en/articles/2773351-how-do-i-pay-commissions) —
  Pending/Due/Paid states, thresholds and manual payout responsibilities.
- [Stripe Connect onboarding](https://docs.stripe.com/connect/onboarding) —
  hosted and embedded identity, payout and compliance onboarding patterns for a
  later automated release.
- [FTC Disclosures 101](https://www.ftc.gov/business-guidance/resources/disclosures-101-social-media-influencers) —
  clear, conspicuous and proximate disclosure of compensated relationships.
- [FCA social-media financial-promotion guidance](https://www.fca.org.uk/publications/finalised-guidance/fg24-1-finalised-guidance-financial-promotions-social-media) —
  fair, clear and non-misleading communications and balanced presentation where
  the financial-promotion perimeter applies.
- [SEC investment-adviser marketing guidance](https://www.sec.gov/resources-small-businesses/small-business-compliance-guides/investment-adviser-marketing) —
  compensated endorsement disclosure and oversight where the adviser marketing
  rule applies.
- [ICO storage and access technology guidance](https://ico.org.uk/for-organisations/direct-marketing-and-privacy-and-electronic-communications/guidance-on-the-use-of-storage-and-access-technologies/what-are-storage-and-access-technologies/) —
  current affiliate-cookie and tracking-pixel example.
- [WCAG 2.2 target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum) and
  [focus appearance guidance](https://www.w3.org/WAI/WCAG22/Understanding/focus-appearance) —
  mobile target and keyboard-focus requirements.

## Final design principle

For a financial-research product, trust comes from explaining **who qualifies,
what was attributed, how commission was calculated, why it is pending, and what
could reverse it**. Release 1 should optimize for a small number of credible
customer ambassadors and an auditable manual ledger—not recruitment volume,
gamification or payout speed.
