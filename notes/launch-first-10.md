# Zero-budget AppSumo plan — from 3 to 10 customers

Status: **current as of 30 July 2026**.

## Corrected baseline and operating rules (28 July 2026)

The campaign baseline is now **3 AppSumo purchases, 2 redemptions, 11 trial
starts, 23 signups, 16 AppSumo outbound clicks, and 0 reviews**. The immediate
objective is seven additional AppSumo customers (10 total), while measuring
activation rather than counting purchases alone.

Daily cadence:

- Publish one source-backed X insight and make five useful, specific finance or
  investing replies.
- Attach a current StockPortfolio.pro evidence screenshot to every substantive
  X reply. The visible period, units, metric definition, and source trail must
  support the exact written claim; decorative product images do not qualify.
- Use Ask for company-specific replies when synthesis adds real value, then
  sanity-check its periods, calculations, and cited source against the filed or
  deterministic view before publishing. Reject inconsistent Ask output and use
  the relevant deterministic tool or research page instead.
- Reply to every genuine response and repurpose the strongest insight for
  LinkedIn.
- Use only allowlisted campaign sources (`x`, `linkedin`, `reddit`, `creator`,
  `newsletter`, `email`) and log the bridge visit, signup, trial, activation,
  redemption, and customer outcome.

### Intent-led reply allocation (30 July update)

Reach and conversion are separate jobs. The first three days showed that replies
under established finance accounts distribute well, but no reply has produced a
verified AppSumo customer yet. For the next 14 days, allocate replies as follows:

- **60% help/intent:** real investors, analysts, founders, or finance users who
  explicitly describe a workflow problem the product can solve (finding filing
  evidence, comparing periods, checking dilution, replacing spreadsheet work,
  or evaluating a research tool).
- **30% creator distribution:** relevant established accounts whose discussion
  gives us a legitimate opportunity to add a filed number, calculation,
  limitation, or screenshot. The purpose is reach and qualified profile visits.
- **10% customer/community:** genuine replies to our posts, product questions,
  objections, and existing-customer conversations.

An intent reply must solve part of the problem before mentioning the product.
When a link is useful, disclose that we built the tool and link to the exact free
tool or research page—not the homepage or a naked AppSumo pitch. Every link must
carry `source`, an allowlisted `content_id`, and a unique `click_id`. The free
result supplies the contextual AppSumo bridge.

Score intent candidates before replying: explicit problem (0–2), product fit
(0–2), evidence we can show (0–2), apparent genuine account (0–1), and recency
(0–1). Reply only at 6/8 or above. Never infer personal finances, provide a
recommendation, or intrude on an unrelated conversation.

Compare the two reply motions after at least 30 qualified replies each:

- intent replies: tool visits, tool completions, AppSumo visits, purchases;
- creator replies: reach, profile visits, assisted tool use, assisted purchases.

The working files are `marketing/campaign-2026-07-30/INTENT-LED-CAMPAIGN.md`
and `marketing/campaign-2026-07-30/intent-tracker.csv`.

The current publish-ready drafts, reply bank, seven-day queue, and measurement
tracker are in `marketing/campaign-2026-07-28/CONTENT-PACK.md` and
`marketing/campaign-2026-07-28/tracker.csv`.

The engineering-as-marketing layer now adds three curated research assets:
`/research/shares-outstanding`, `/research/pe-ratio-history`, and
`/research/dilution-scorecard` (including a downloadable CSV). Each uses a
distinct allowlisted content ID, so the private marketing dashboard separates
research-page views, AppSumo CTA clicks, trials, activations and conversions.
The launch copy, evidence requirements, helpful reply bank, tailored outreach
template and 7/14/30-day decision gate are appended to the campaign content
pack. These assets complement the 30 public calculators; they do not authorize
another large programmatic URL set.

### High-impression X packaging (integrated from the competitor audit)

The competitor's reach appears to come from packaging a prosecutable thesis for
an active ticker community—not from making unsupported claims. Borrow the
distribution mechanics while keeping StockPortfolio.pro's source standard:

- Make the first line a concrete tension: what investors are celebrating versus
  what the filing appears to show. Do not open with a generic launch or feature
  announcement.
- Use one falsifiable observation: a reported metric, period, divergence,
  calculation, or changed filing passage. Never invent a price target or imply
  fraud without evidence.
- Put an annotated filing screenshot or chart in the post when it is the
  argument. Highlight the exact period, units, and source—not decorative brand
  artwork.
- Choose a single, actively debated company or fund only when the evidence is
  material and current. Do not bait, brigade, insult, or target a person.
- End with a conditional consequence and a genuine question to both sides, such
  as “What explains the gap?” The goal is informed disagreement, not outrage.
- Use a four-part sequence: contrarian observation → evidence image →
  conditional implication → question. Put the tracked AppSumo CTA in the first
  reply after helping the reader, not in every main post.
- Build follow-ups that test the thesis after the next filing or material event;
  link back to the original post so profile visits become a useful research
  trail.
- Allocate the X mix as roughly 60% contrarian filing findings, 25%
  evidence-led replies under active discussions, 10% thesis follow-ups, and 5%
  direct product/offer posts. Keep the existing five-reply daily minimum.

Example template (fill only with figures verified that day):

```text
$TICKER investors may be watching the wrong number.

[Metric A] rose [X%], but [Metric B] moved [Y%] in the same reported period.
That divergence may change how we read [cash conversion / margin quality /
leverage].

[Annotated filing screenshot with period and source]

Bulls—what explains the gap?
```

The post must stand alone as useful research. A low-impression post can still
continue when it creates qualified questions, bridge visits, or activations;
raw likes are not the success metric. Account-level X impressions are only
reported when the authenticated X Analytics view is available.

Weekly cadence:

- One short product demonstration, one filing or comparison analysis, one
  transparent limitation, and one founder update.
- Ten tailored creator, newsletter, or community contacts; no untargeted bulk
  email.

Organic growth flywheel:

1. Analyze a filing with the product and publish the source-backed page.
2. Repurpose it as an X post, LinkedIn post, and relevant helpful replies.
3. Add contextual internal links and a tracked AppSumo CTA.
4. Improve existing pages ranking in positions 6–20 or receiving impressions
   without clicks. Start with the best 100–500 pages, adding original analysis,
   filing dates, methodology, primary sources, related comparisons, and CTAs.
5. Do not create more programmatic pages until Search Console shows index rate
   and query demand across the existing 25,733 URLs. Publish a monthly,
   source-worthy dataset that finance writers can cite.

Measurement windows are 24 hours for reach, 7 days for clicks/signups, and 30
days for trials, activations, and customers. Judge channels by activated
customers per qualified conversation, not likes. Stop a message after 20
qualified conversations with no bridge visits, or an audience after 30 with no
activation. Pause acquisition if Ask, source links, redemption, or onboarding is
broken.

The private marketing dashboard reports estimated browser sessions by source,
unique tool use, and excluded QA/bot activity separately. Owner screenshots and
smoke tests must enable QA exclusion before browsing public pages. AppSumo
webhook licenses measure purchases visible to the application; the Partner
Portal remains the definitive record for an unredeemed purchase that has not
reached the webhook.

The metrics template is `marketing/appsumo-30-day/metrics.csv`; trial fields are
`trial_started_at`, `trial_ends_at`, `auth_method`, `acquisition_source`,
`activation_job`, `converted_via`, and `converted_at`.

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

The product funnel now carries that signed source and click ID through page
views, email/Google/Facebook signups, no-card trials, Stripe checkout metadata,
and paid webhooks. Treat an event with no `acquisitionSource` as unattributed:
it must not be counted as proof that X, LinkedIn, or another channel converted
the customer. Review the dashboard after 24 hours for reach, seven days for
qualified visits/signups, and 30 days for activations and paid customers.

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
