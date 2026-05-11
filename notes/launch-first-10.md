# Zero-budget plan: first 10 paying customers

This plan is designed for `stockportfolio.pro` to get the first 10 paying customers with a `£0` budget. It avoids spam, focuses on high-trust 1:1 outreach, and uses a dedicated page (`/founding`) so you can measure conversion.

## Offer (simple + credible)

- Annual: `£70/year` (best value, immediate access)
- Monthly: `£7/month` with `7-day trial` (lower-friction test)
- Positioning: calm portfolio review workflow for long-term investors (not trading)
- Promise: “Review your holdings, allocation, fundamentals and performance in minutes.”

## The goal

- 10 paying customers (annual preferred)
- 100 high-intent conversations
- 20 “yes, I’ll try it” clicks to `https://stockportfolio.pro/founding`

## Funnel

- Outreach message -> `https://stockportfolio.pro/founding?utm_source=<channel>&utm_campaign=founding10`
- CTA on page -> `register.html?plan=annual` or `register.html?plan=monthly`
- Stripe Checkout -> access

## Day-by-day (14 days)

Day 1: Setup
- Update Google OAuth origins so Google signup works on `https://stockportfolio.pro` and `https://www.stockportfolio.pro` (optional but recommended).
- Prepare your “concierge onboarding” script (below).
- Create a list of 100 targets.

Day 2-6: Outreach sprint
- 20 personalized DMs/day (100 total).
- 5 “public replies” per day on posts where people are asking for portfolio tracking workflows.
- Log every contact in a sheet/CSV.

Day 7: Improve conversion
- Review the top 3 objections you saw.
- Update `founding.html` copy with the exact language prospects use.

Day 8-14: Second sprint + referrals
- 10 DMs/day (70 total), but higher quality.
- Ask every activated user for 1 referral (“one friend who uses spreadsheets for investing”).

## Target list (where to look)

- Spreadsheet investors asking about “allocation”, “portfolio tracker”, “holdings spreadsheet”, “rebalance”, “concentration risk”.
- People posting “monthly portfolio review” workflows.
- Personal finance creators (small newsletters, YouTube, blogs) who cover DIY investing.

## Concierge onboarding script (10 minutes)

1. “What broker/spreadsheet do you use today?”
2. “What do you check weekly? (allocation? performance? fundamentals?)”
3. “Let’s add 3 tickers + quantities now.”
4. “Here’s the allocation view: what surprises you?”
5. “Here’s performance: does this match your mental model?”
6. “Export exists, no broker link, cancel anytime.”
7. “If you want the calm weekly review workflow, annual is best value; otherwise start monthly trial.”

## DM templates (use, then personalize)

Template A (problem -> outcome)
“Saw your post about tracking your portfolio in a spreadsheet. I built `stockportfolio.pro` so you can review holdings + allocation + performance in minutes. No broker connection. If you want, I’ll help you set it up quickly. Want a link?”

Template B (value-first)
“Quick question: do you review your portfolio weekly or monthly? I’m building a calm workflow for long-term investors and looking for 10 founding users. If you try it and it’s not useful, you can cancel anytime. Want to see it?”

Follow-up (48h)
“Bumping this once: if you want to test it, start with monthly (7-day trial). Here’s the page: `https://stockportfolio.pro/founding`”

## Public post templates (non-spam)

Post 1 (checklist)
“I used to do portfolio reviews in spreadsheets and it always turned into a weekend. I built a calm weekly workflow (holdings, allocation, performance). If anyone wants to try it, I’m onboarding 10 early users this week: `https://stockportfolio.pro/founding`”

Post 2 (insight)
“One thing that improved my investing: a 10-minute weekly portfolio review. Allocation first, then performance, then fundamentals. I built a small tool around that workflow: `https://stockportfolio.pro/founding`”

## Metrics to watch

- Visits to `/founding` by source (UTM)
- Register starts / completion
- Stripe checkout starts / completion
- Objections (collect in notes)
