# Draft email to William (AppSumo partner team) — SUPERSEDED, DO NOT SEND

> **Superseded 2026-09-06 by `appsumo-william-listing-v5-email.md`.** This draft asks
> AppSumo to approve a **feature reduction** (Monitor watchlist narrowed to 1/4/8 with
> grandfathering) and notes that such a request "may require ending the current listing
> and creating a replacement." That reduction was never made: the code still grants
> 12/40/unlimited and the listing publishes the 1/4/8 already shown on the live page, so
> there is nothing to downgrade. Sending this would put the listing at risk for no gain.


**Status: DRAFT. Do not send until (1) the v4 listing copy is ready to paste,
(2) the code changes to enforce 1/4/8 with grandfathering are deployed, and (3)
you are ready to wait up to 1 business week for AppSumo's approval decision.**

This email requests approval for a **feature reduction** (Monitor watchlist
caps) alongside a repositioning update. Per AppSumo's Partner Listing & Updates
Policy, downgrading features may require ending the current listing and creating
a replacement, and there is no guarantee the request will be approved.

- **From:** avinashsreekumar007@gmail.com (personal Gmail)
- **To:** partners@appsumo.com
- **Thread:** reply into the existing "StockPortfolio.pro — final-period
  promotion and deal-end confirmation" thread
- **Timing:** Only after `lib/tier-limits.js` code changes are deployed with
  `MONITOR_CAP_V2_EFFECTIVE_FROM` set to a future date, so the grandfather
  clause is live before AppSumo rules on the request

---

## Subject

Re: StockPortfolio.pro — listing update request (repositioning + tier change)

## Body

Hi William,

I am requesting an update to the StockPortfolio.pro listing. This combines a
repositioning (new copy based on buyer feedback) with a **tier structure
change** that reduces Monitor watchlist limits for new buyers while
grandfathering all existing purchasers. I understand this requires your team's
approval and may need the Deal Updates Form.

**1) Repositioning — buyer evidence changed the pitch.**

Our lifetime customers told us directly that an AI chat over filings is a
commodity, and that the structured research report is what makes the product
worth buying. One buyer who ran five Dossiers in one sitting and never opened
the Ask box said:

> "Being able to chat about companies based on their filings is not something
> that differentiates your product. Basic AI chatbots with internet access can
> do that. The real special part is the ability to leverage AI to create reports
> in structured formats that are comparable across companies without needing the
> prompting."

The updated listing copy now leads with the two differentiated features — the
one-click Research Dossier and the Filing Change Monitor — and de-emphasizes
the chatbot. I have the new copy ready to paste if this is approved.

**2) Tier change — Monitor watchlist caps (requires approval).**

I am requesting to **reduce the Monitor watchlist limits** for **new buyers
only**, effective on a future redemption date. The change:

| Tier | Current (promised 1 Sept 2026) | Proposed for NEW buyers |
|---|---|---|
| Starter ($39) | 12 companies | **1 company** |
| Investor ($79) | 40 companies | **4 companies** |
| Pro ($149) | Unlimited | **8 companies** |

**All 13 existing buyers are permanently grandfathered at 12 / 40 / unlimited.**
The code enforces this via a redemption-date cutover: anyone who has already
redeemed keeps the wider limits forever, and the product will continue to
deliver those wider limits to them regardless of what the new listing says.

I deleted the 1 September founder update email that announced 12/40/unlimited,
so new buyers arriving after this change will not see that promise. However, I
recognize this is still a reduction from terms that were live, and I am
requesting your approval rather than assuming it is permissible.

**Why this change:** buyer feedback shows the Monitor is a high-value feature,
and tighter limits create a clearer upgrade path (the buyer hits the limit
exactly when the product has proven itself). The Ask question allowances stay
unchanged at 30 / 100 / 300.

**3) The review button issue (still unresolved).**

This is the item from my 31 August note. Kris Makineni (drmakineni@msn.com)
bought Tier 2, redeemed, has been using the product, and cannot leave a review
— the "Write a review" control is greyed out for him. With the 4 October date
on the calendar for the 90-day live/transactable requirement, verified buyers
being unable to review is costing us the social proof window. Could someone
take a look at that account specifically?

**How to proceed:**

If the repositioning + tier change is approvable, I am ready to paste the new
listing copy and can provide the redemption cutover date once you confirm. If
the tier change is not approvable under the current listing, please let me know
whether I need to end this listing and create a replacement, per the policy on
downgrading features.

Happy to fill out the Deal Updates Form if that is the required path, or to
provide redemption references or anything else that helps.

Thanks,
Avinash
StockPortfolio.pro

---

## Notes before sending

**Do not send until:**
1. `lib/tier-limits.js` is updated with `LTD_MONITOR_CAP_V2 = {1: 1, 2: 4, 3: 8}`
   and `MONITOR_CAP_V2_EFFECTIVE_FROM` env var
2. That code is deployed to production with the cutover date set to **after**
   you expect William's approval (e.g., 7-10 days out)
3. You have tested that an account with `appsumoRedeemedAt` before the cutover
   still gets 12/40/unlimited, and one after gets 1/4/8

**Expected timeline:**
- William's team reviews: up to 1 business week
- If denied: you are back to repositioning-only (keep 12/40/unlimited)
- If approved: you paste the v4 copy into the portal and the cutover happens on
  the date you set

**AppSumo policy risk:**
Per https://appsumo.com/partner-terms/listing-policy/, downgrading features may
require ending the listing and creating a new one. This email asks for a ruling
on whether the grandfather clause makes it permissible. If they say no, you
drop the 1/4/8 change and keep the repositioning.

**Clawback risk if you skip approval:**
Reducing entitlements without AppSumo's consent "may result in listing removal,
refunds, withheld payments, and clawback of previous earnings" (~$344 net to
date). Do not deploy the 1/4/8 caps or send this email unless you are willing
to wait for their ruling.

**The buyer quote** is used with his own wording, volunteered unprompted. If
AppSumo wants an attributed testimonial, ask him first.

**Trade secret:** do not name the AI provider or model in any correspondence.
