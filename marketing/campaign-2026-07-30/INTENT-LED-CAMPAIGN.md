# Intent-led X campaign — 30 July to 12 August 2026

## Commercial objective

Generate verified AppSumo purchases. Impressions, likes, profile visits, tool
visits, and outbound clicks are diagnostic steps—not the final result.

## Daily allocation

- 3 replies to genuine users expressing a current research/tool problem.
- 2 evidence-led replies in larger relevant finance conversations.
- 1 original filing-backed post with a current product screenshot.
- Respond to every substantive reply to our posts on the same day.
- LinkedIn: three evidence-led posts per week, not daily filler.

## 30 July evidence post

- Topic: Apple cash conversion across matching annual fiscal periods.
- Live result: 2025 net income $112.01B, operating cash flow $111.48B,
  cash conversion 0.995x (displayed as 1x).
- Visual: `evidence/aapl-cash-flow-quality-20260730.png`, captured from the
  production Cash Flow Quality Checker after selecting AAPL.
- X destination: the exact free tool with `content_id=tool-cash-flow-quality`
  and unique click ID `x-20260730-aapl-cfq`.
- LinkedIn destination: the same tool with `source=linkedin` and unique click
  ID `li-20260730-aapl-cfq`.
- The post describes the trend as a cross-check, not a verdict or prediction.

## Live execution baseline — 30 July, 7:58 PM IST

- AppSumo: 3 licenses, 2 redeemed, 0 reviews; no new license, signup, trial, or
  paid event since the previous watch run.
- Raw three-day funnel: 721 page views, 62 free-tool views, 15 free-tool
  completions, 47 AppSumo outbound events, and 1 activation.
- Raw last 24 hours: 568 page views, 52 free-tool views, 12 free-tool
  completions, and 9 AppSumo outbound events; no signup, trial, or paid event.
- The raw counts include QA/bot/unclassified activity. Only 106 reportable
  referral/internal page views appeared in the three-day source breakdown, so
  raw page-view and AppSumo-outbound totals must not be presented as verified
  human traffic.
- Google: both the URL-prefix and domain properties have Full access. The root
  sitemap was downloaded successfully with zero warnings and zero errors.
- Bing: sitemap status Success, 16,112 indexed pages, and zero active crawl
  issues. IndexNow found no materially changed production URLs to resubmit.
- Immediate conclusion: today needs qualified, intent-led distribution. More
  unqualified page views are not the goal; the post/replies should produce
  identifiable tool completions, signups, and AppSumo purchases.

## Finding genuine intent

Search recent X posts for combinations of these phrases and finance terms:

- `"is there a tool" (SEC OR filing OR portfolio OR dilution)`
- `"how do I" (10-K OR 10-Q OR cash flow OR shares outstanding)`
- `"looking for" (stock research tool OR portfolio tracker)`
- `"alternative to" (Koyfin OR Finviz OR Simply Wall St OR spreadsheet)`
- `"can someone explain" (filing OR dilution OR free cash flow)`
- `"tired of" spreadsheet (portfolio OR stocks OR filings)`

Only use recent, apparently genuine accounts. Exclude engagement bait, giveaway
posts, bots, job requests, investment-signal requests, and questions that the
product does not actually solve.

## Candidate score

| Signal | Points |
|---|---:|
| Explicit current problem or request | 0–2 |
| Direct fit with a working product flow | 0–2 |
| We can show current visual/source evidence | 0–2 |
| Account appears genuine | 0–1 |
| Posted recently enough for a useful answer | 0–1 |

Reply only when the candidate scores at least 6/8.

## Reply structure

1. Answer the actual question in the first sentence.
2. Add one concrete filing fact, calculation, or reproducible check.
3. State the important period/definition limitation.
4. When a public free tool directly answers the question, run it for the exact
   ticker(s) and attach a fresh screenshot of the completed result. Keep the
   ticker, period/date, units, result, limitation, and source/methodology cue
   visible. Otherwise use the primary filing/research evidence or no image.
5. If the tool is directly helpful: “I built this” plus the exact tracked tool
   URL. Do not pretend to be an unaffiliated user.

Example—adapt only after verifying the target post and source:

> A clean dilution check needs both filed share counts and their exact dates;
> comparing across a split can produce a meaningless percentage. I built a free
> checker that labels suspected split/reorganisation periods instead of forcing
> the calculation: [unique tracked dilution-tool URL]

## Link rule

Create one URL per post or reply:

```bash
node scripts/campaign-link.js \
  --source x \
  --content-id tool-dilution \
  --click-id x-20260730-intent01 \
  --path /tools/dilution
```

The link must land on the exact useful result path. The site preserves the
signed source/click through tool completion, signup, trial, activation, and the
AppSumo bridge.

## Screenshot acceptance check

- The image was captured from the live production tool for this reply, not from
  an old draft or a different ticker.
- The written claim is visible or reproducible from the result shown.
- Any missing-data, split, period-comparability, or coverage warning remains
  visible and is explained in the reply.
- The result is readable on a phone and contains no account, customer, or
  private portfolio data.
- Alt text names the ticker(s), result, period, and key limitation.
- The tracker records the tool ID, ticker(s), screenshot filename/capture time,
  reply URL, and unique tracked link.

Do not attach a generic product screenshot to manufacture relevance. One
well-matched result image is preferable to several promotional images, and a
useful text-only reply is preferable to an irrelevant visual.

## Decision rules

- High reply views but no tool visits: the answer/visual is useful but the
  bridge is unclear; improve the disclosed next step.
- Tool views but fewer than 35% completions: fix input, result speed, or intent
  match before posting more.
- Completions but no AppSumo visits: improve the contextual CTA after the result.
- 30 verified AppSumo visits without a purchase: diagnose the listing, demo,
  trust, limits, or offer—not X reach.
- Compare intent and creator cohorts only after 30 qualified replies in each.

## Safety and quality

- No financial advice, price targets, guaranteed returns, or unverified claims.
- No automated likes, follows, DMs, or mass replies.
- Ask output can be used only after checking the visible period, calculation,
  and cited source. Use a deterministic tool when Ask is inconsistent.
- Drafts are reviewed before publication. No emails are part of this campaign.
