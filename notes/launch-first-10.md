# Zero-budget AppSumo plan — from 3 to 10 customers

Status: **current as of 26 July 2026**.

This supersedes the original `/founding` plan built around the former `£7/month` and `£70/year` subscription offer. The current campaign sells the live AppSumo lifetime deal through `/appsumo` and positions StockPortfolio.pro as a source-aware research workflow.

## Outcome

- Move from 3 to at least 10 AppSumo customers.
- Get the first 3 honest verified-buyer reviews, then work toward 10.
- Learn which research job converts: single-company filing questions, company comparison, screening, or portfolio review.
- Identify activation problems before increasing outreach volume.

Customer count alone is not enough. A successful sale is one where the buyer redeems, reaches a source-backed answer, and understands the product’s limits.

## Current offer

| Tier | Price | Monthly Ask allowance | Best initial fit |
|---|---:|---:|---|
| Starter | $39 one time | 30 | Occasional research and weekly review |
| Investor | $79 one time | 100 | Active DIY investor |
| Pro | $149 one time | 300 | High-volume researcher |

The live AppSumo listing controls the final terms. Check it before publishing prices, activation windows, refund language, or included features.

## Primary ICP

A self-directed fundamental investor who:

- follows primarily US-listed companies;
- holds or watches roughly 5–30 stocks;
- uses ChatGPT, Perplexity, TIKR, Koyfin, SEC filings, or spreadsheets today;
- asks questions about reported growth, margins, cash flow, capital allocation, risks, or company comparisons;
- dislikes uncited or period-confused AI financial answers;
- is willing to inspect the source before acting.

Secondary ICP: a finance writer or social creator who needs verifiable research inputs. Do not promise commercial or client-facing licensing; direct those questions to the current terms and support.

## Explicit non-ICP

- day traders looking for entry/exit signals;
- options, crypto, forex, or automated-strategy users;
- people requiring a global institutional terminal;
- users who require automatic broker aggregation;
- buyers looking for personalized picks, guaranteed accuracy, or guaranteed returns.

## Core message

> Ask a stock question. Inspect the filed number, fiscal period, calculation, and source.

Supporting proof:

- company fundamentals use supported SEC-filed data;
- fund research uses separately labelled fund data;
- post-filing facts can use dated live-web sources;
- unsupported evidence should produce a limitation rather than a number from model memory;
- no broker credentials are required for manual portfolio tracking.

## Funnel

```text
Helpful post / reply / personalized DM
  → /appsumo with an allowlisted channel source
  → one purchase action: /go/appsumo/<same-source>
  → AppSumo listing and tier selection
  → redemption
  → first source-backed answer
  → support check-in
  → honest review request, with no incentive
```

Campaign URL pattern (the server safely rewrites the fixed CTA to the same
allowlisted source):

```text
https://www.stockportfolio.pro/appsumo?source=<x|linkedin|reddit|stocktwits|creator|email>
```

Use platform post URLs and `marketing/appsumo-30-day/metrics.csv` for
post-level attribution; the first-party cookie deliberately records only the
channel, timestamp and random click ID.

## Activation definition

Count a buyer as activated after they complete at least one meaningful job:

1. ask a company question and open its evidence;
2. compare two companies and inspect a supporting company page;
3. run a screener and open a result;
4. add at least three portfolio positions and ask a portfolio question.

Do not ask for a review before the buyer has genuinely used the product.

## 14-day plan

### Day 1 — close the trust gaps

- Publish and smoke-test `/appsumo` on desktop and mobile.
- Open `/appsumo?source=x`, verify every CTA becomes `/go/appsumo/x`, and confirm the redirect reaches the live deal.
- Confirm the three displayed prices and Ask allowances against AppSumo.
- Open every demo, privacy, terms, and support link from the bridge page.
- Check that the AppSumo redemption flow works on a real buyer account.
- Verify the honest-review email sequence is sending and links directly to `/#reviews`.

### Day 2 — personally activate the existing 3 buyers

Send a plain support-first note to each current buyer:

```text
Hi [first name] — thank you for being one of the first StockPortfolio.pro buyers. I want to make sure you reach the useful part, not just the dashboard. Reply with one US stock and the question you are researching; I will point you to the right workflow and help if anything gets in the way.
```

After they complete a real research task, ask for an honest review without an incentive:

```text
If you have used it enough to form an opinion, would you leave an honest AppSumo review? The most useful review says what you researched, whether the source trail helped, and what still needs work: https://appsumo.com/products/stockportfoliopro/#reviews
```

Record activation friction and objections. Do not pressure a buyer who has not used the product or who needs support.

### Days 3–6 — evidence-led X sprint

Each day:

- publish one original research lesson or product proof post;
- make 5 genuinely useful replies to people discussing filing data, AI financial errors, company comparisons, or research workflows;
- send at most 5 personalized DMs to people whose public posts show a clear fit;
- follow up on open support conversations;
- log the exact post/reply/DM that produced each bridge-page visit or sale.

Content rotation:

1. one filed metric across several fiscal periods;
2. one company-vs-company comparison;
3. one “how to verify an AI financial answer” checklist;
4. one transparent product limitation;
5. one shipped change based on buyer feedback;
6. one stock-versus-fund source distinction.

Never publish a ticker claim without checking the underlying product output and source on the day of posting.

### Day 7 — conversion review

For each channel and asset, record:

- impressions or people reached;
- meaningful replies;
- bridge visits;
- AppSumo purchases, where attributable;
- redemptions;
- activations;
- reviews;
- refunds or support blockers;
- exact objections in the prospect’s words.

Choose the best message by **activated customers per conversation**, not likes.

Update copy only when several prospects show the same misunderstanding. Do not change the positioning after one low-impression post.

### Days 8–11 — double down on the winning job

- Turn the best-performing research job into a short screen recording.
- Publish one annotated result with the reported period and source visible.
- Rework the bridge-page hero only if the winning job differs from the current promise.
- Ask activated buyers for one introduction to a person with the same research workflow; do not attach a review incentive.
- Continue at most one DM follow-up per prospect after 48–72 hours.

### Days 12–14 — proof and founder cadence

- Publish one permissioned buyer mini-case study.
- Post a factual founder update on AppSumo: what shipped, what was fixed, and what is next.
- Reply promptly to every AppSumo question and review.
- Add recurring objections to the FAQ.
- Decide whether the next milestone should optimize for 10 reviews, a specific tier, or a specific ICP.

## Concierge onboarding script (10 minutes)

1. “What company or fund are you researching today?”
2. “What exact question do you need answered?”
3. “Which period or comparison matters?”
4. Run the question in Ask.
5. Identify whether the answer used filing data, fund data, or a dated web source.
6. Open one cited source and verify one material figure together.
7. Show the relevant follow-on workflow: compare, screener, or portfolio.
8. Ask: “What would stop you using this again next week?”

Do not lead onboarding with every feature. Get to one verified answer first.

## Outreach templates

### Problem-specific DM

```text
Saw your post about [specific company / metric / filing issue]. I built StockPortfolio.pro around the verification step: ask the question, keep the fiscal period attached, and open the source behind the answer. If useful, I can send the 60-second demo and AppSumo lifetime deal.
```

### General-AI user

```text
You mentioned using [ChatGPT / Perplexity] for stock research. Do you have a reliable way to catch period mismatches or unsupported financial figures? I am testing a narrower workflow that shows the company source behind the answer. Happy to send the demo if that is a real pain for you.
```

### Follow-up — once

```text
One quick follow-up in case the source-checking workflow is relevant: [TRACKED /appsumo URL]. If it is not a fit, no need to reply; one blunt objection is also useful.
```

## Public post framework

Every product post should contain:

1. a useful research observation that stands alone;
2. one concrete example or screenshot;
3. the source limitation or verification step;
4. one CTA to the tracked `/appsumo` page.

Avoid generic “I launched” posts without a research lesson. Earlier portfolio-first launch posts produced little visible engagement and should not be repeated unchanged.

## Review policy

- Ask only verified buyers who have genuinely tried the product.
- Ask for an **honest** review, never a positive rating.
- Never offer credits, upgrades, discounts, gifts, refunds, roadmap priority, or other consideration.
- Route product support through support first; do not use the Questions section for support.
- Reply to critical reviews with the same source-specific, non-defensive tone used on the bridge page.

## Metrics sheet

Track one row per prospect or buyer:

```text
date, source, content_id, profile, fit_reason, first_touch, reply, bridge_visit,
purchase, tier, redeemed, activated, activation_job, review, refund, objection,
next_action, notes
```

Core ratios:

- conversation → bridge visit;
- bridge visit → AppSumo purchase;
- purchase → redemption;
- redemption → activation;
- activation → review;
- refund rate by message and tier.

## Stop / continue rules

- Stop a message after 20 qualified conversations with no bridge visits.
- Stop an audience after 30 qualified conversations with no activation unless a clear product blocker appears.
- Continue a post format when it produces qualified questions or activated buyers, even if raw impressions are modest.
- Pause new outreach if redemption, source links, or core Ask output is failing; repair activation before adding traffic.
