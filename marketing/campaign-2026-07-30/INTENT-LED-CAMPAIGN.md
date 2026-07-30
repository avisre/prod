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
4. Attach a current screenshot when it proves the point.
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
