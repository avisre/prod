# Hacker News — Show HN

HN rewards technical honesty and substance, and punishes marketing speak. Lead with
what's genuinely interesting (filing-grounded answers, no hallucination), be upfront
that it's a paid product with a free tier, and be ready to reply fast.

## Submission
- Type: **Show HN** (submit the URL, not a text post)
- URL: `https://www.stockportfolio.pro`
- Title (≤ 80 chars):

> Show HN: AI stock analyst that answers only from SEC filings, not memory

Alternates:
> Show HN: stockportfolio.pro – stock research grounded in 10-K/10-Q filings
> Show HN: I built a stock analyst that refuses to answer from memory

## First comment (post immediately after submitting)

I got tired of asking ChatGPT about stocks and getting numbers that were confidently
wrong — a made-up gross margin or revenue figure is a great way to lose money.

So I built the opposite: an analyst that answers **only from official SEC filings
(10-K/10-Q via EDGAR), never from model memory**, and shows the source under every
figure. Ask "how has NVIDIA's gross margin moved over the last 12 quarters?" and you
get a chart, a table, and the filing each number came from. If it can't ground a
claim in a filing, it says so instead of inventing one.

How it works under the hood:
- Fundamentals are computed deterministically from the filings (parsed from EDGAR),
  not scraped from estimate aggregators — up to ~19 years, split-adjusted.
- The "Ask" layer is tool-use over that structured data + filing text, so answers
  are constrained to retrieved facts; figures render as charts/tables with citations.
- Around it: a screener over the US universe, side-by-side company comparison with an
  AI verdict, guru-portfolio tracking, a Filing Monitor for new filings, and a
  portfolio tracker.

It's a paid product ($12/mo, Pro $33/mo with the full analyst) but there's a free
tier and a 7-day no-card trial, and a live demo with no signup at /demo — I'd rather
you kick the tires than take my word.

I'd genuinely love feedback on the Ask answers: where is it still not nuanced enough,
or where would you expect a citation that's missing? Happy to go deep on the parsing
/ grounding approach in the comments.

<!-- TODO: if you want, add one concrete "it caught X that aggregators got wrong"
example — HN loves a specific, verifiable claim. Only use one you can defend. -->

## Playbook
- Post **weekday morning ~8–10am ET**. Avoid weekends/Fri afternoon.
- Reply to **every** comment in the first 2 hours, technically and without defensiveness.
- Don't ask for upvotes (HN bans for it). Don't argue; engage.
- Expect skepticism on "AI + finance" — your defense is the grounding/citations; lean in.
