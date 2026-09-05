# Email to William (AppSumo partner team) — listing v5 — READY TO SEND, NOT SENT

**Supersedes `appsumo-william-listing-update-draft.md`, which must NOT be sent.**
That draft requested approval for a **feature reduction** (narrowing the Monitor
watchlist to 1/4/8 with grandfathering) and warned it "may require ending the current
listing and creating a replacement." We are not narrowing anything. v5 publishes the
1/4/8 Monitor ladder that is *already on the live listing*, while the code keeps
over-delivering at 12/40/unlimited. Every change below is an increase.

- **From:** avinashsreekumar007@gmail.com (personal Gmail — not support@)
- **To:** partners@appsumo.com
- **Thread:** reply into "StockPortfolio.pro — final-period promotion and deal-end
  confirmation" (last message from William, 31 Aug)
- **Precondition (MET, 2026-09-06):** the credit meter is deployed. Production now
  honours the wallet on every action including Ask, so nothing below describes
  behaviour the running code refuses.
- **Do not** edit the listing version in the Partner Portal — known mapping bug.

---

## Subject

Re: StockPortfolio.pro — listing update: new copy, credit-based tiers (no feature reduction)

## Body

Hi William,

Three requests and one flag correction. **Nothing here reduces what any tier includes** —
the tier change is an increase across the board — so I don't believe this needs a downgrade
review, but tell me if you'd rather I file it differently.

**1) Tier spec: the meter changes from Ask questions to AI credits.**

Currently listed: 30 / 100 / 300 Ask questions per month.
Requested: **100 / 300 / 800 AI credits per month**, where a Research Dossier costs 10
credits, a Filing Monitor report 5, a comparison 5, and a follow-up question 2.

| | Starter $39 | Investor $79 | Pro $149 |
|---|---|---|---|
| AI credits per month | 100 | 300 | 800 |
| Research Dossiers, if spent entirely there | 10 | 30 | 80 |
| or Filing Monitor reports | 20 | 60 | 160 |
| Companies watched by the Monitor | 1 | 4 | 8 |

Every tier gains capacity: the old Ask allowance was worth 60 / 200 / 600 credits at these
prices, so this is a 67% / 50% / 33% increase. The Monitor watchlist stays exactly as
listed at 1 / 4 / 8. Every feature stays included on all three tiers.

Why: buyers could not tell what an Ask-count tier actually bought them. A Tier 1 customer
wrote to me on 4 September asking me to "clarify the credits on the AppSumo website, rather
than the questions limit" — and upgraded to Tier 2 the same afternoon once he understood
it. The change is live in the product as of today, so the listing is now the only place
still describing the old meter.

**2) New listing copy.** Full text below/attached. It leads with the two reports (Research
Dossier and Filing Change Monitor) instead of the AI chat, on the direct written feedback of
two buyers, and prices the credits in reports rather than abstract units.

**3) Classification corrections.**

- **Best for:** currently "Small businesses · Solopreneurs · Businesses". Every buyer so far
  is an individual investor doing their own due diligence. Please set **Solopreneurs**, plus
  **Consultants** if that value exists, and remove "Small businesses" and "Businesses".
- **Alternative to:** currently "Bloomberg Terminal · Koyfin · SeekingAlpha". Please
  **remove Bloomberg Terminal** — the listing's own scope paragraph says "if you want a
  market terminal, this isn't one", and that mismatched expectation is the most likely
  source of a "functionality too limited" refund we took on 2 September from a licence that
  was never even redeemed. Keep Koyfin and SeekingAlpha.
- **Category:** AI as primary if the taxonomy allows, Finance secondary.
- **Tags:** add `research`, `sec-filings`, `due-diligence`, `ai`, `ai-assistant`; drop
  `portfolio-tracker`.

**4) Flag correction: the listing currently declares "Uses AI: No".** That is wrong — the
product is built on AI over SEC filings, and the flag undercuts the entire listing. Please
correct it.

**5) Images.** Keep the existing hero/banner unchanged. Product images, in this order:

1. `01-dossier-nvda-decision-brief.png` — Research Dossier, Analyst mode ("The case in two minutes")
2. `02-dossier-nvda-financial-trajectory.png` — Research Dossier ("The filed record, with the read beside it")
3. `03-filing-change-monitor-nvda.png` — Filing Change Monitor ("Before and after, on comparable periods")

All three are unretouched screen grabs of the live signed-in product on NVDA — no crop, no
resize, no overlays — and meet the image guidelines (min 1920x1080, under 5 MB, PNG, one
view per image). Two product-image slots remain free.

Thanks,
Avinash

---

## Paste-in copy

The listing text to paste is `docs/growth/appsumo-listing-v5.md` — sections *Product title*
through *Words to avoid*. Do not paste the "Before this is submitted", "Owner checklist" or
"What changed vs v4" sections; they are internal.

## After sending

- Log the send date here and in `.claude/HANDOFF.md`.
- William's team has taken 1–2 business days to reply on past threads; the 31 Aug thread got
  a same-day answer.
- The `$14.99 / 150 credits` top-up line is **deliberately absent** from the copy. Add it
  only once `STRIPE_PRICE_ID_CREDITS_TOPUP` is set on Render — until then the route returns
  `TOPUP_UNAVAILABLE` and it would be an unsellable promise.
