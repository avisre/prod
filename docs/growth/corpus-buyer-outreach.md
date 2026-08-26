# Corpus / bulk-data licence — buyer outreach draft

*Text only. Nothing here has been sent. You send manually, per the #13 gate.
Pairs with `docs/growth/corpus-license-terms.md` (the terms the buyer sees).*

## Who's actually a buyer here

This isn't a SaaS signup — it's a $500–2,000 one-off B2B data sale. The
existing `marketing/targeted-acquisition/` outreach list is built for a
different buyer profile (retail investors evaluating a research tool) and
isn't reusable for this. Three profiles are worth cold-emailing:

1. **Small fintech / AI-agent builders** — teams building a finance copilot,
   earnings-summarizer, or investing agent who need sourced fundamentals +
   filing-change deltas as training/eval data, without scraping EDGAR
   themselves. Best conversion: they have budget and a concrete need today.
2. **Quant / indie researchers** — people backtesting or building screening
   models who want clean structured fundamentals. Lower budget per person,
   but low-effort to reach via public channels rather than 1:1 email.
3. **Academic finance researchers** — thin or no margin, but a citable
   dataset builds credibility and can generate inbound later.

## Channels (no code, no build)

- **1:1 cold email** — profile 1 (fintech/AI builders). Highest intent,
  worth the personalization effort. Template below.
- **Show HN / r/algotrading / r/quant** — profile 2. One honest post
  ("built X while making a stock research tool, selling the byproduct"),
  link to `corpus-license-terms.md` or a landing summary of it. Passive,
  no per-person effort — but each of these communities tolerates exactly
  one honest post, not a campaign; don't repost if it doesn't land.
- **A Kaggle/data-marketplace listing** — passive, matches the "manual
  signed-URL, not self-serve" delivery model fine since the buyer still
  contacts you before anything is generated.

## Cold email template (profile 1: fintech/AI builders)

Same 80/20 rule as the existing outreach doc — lead with something true and
useful about their product, not a pitch.

```
Subject: SEC fundamentals + filing-change dataset (sourced, not scraped)

Hi [name],

[One sentence tied to something specific about their product — e.g. "Saw
[product] cites SEC filings in its answers" or "noticed you're building
[X] on top of fundamentals data" — fill in per-recipient, don't send this
generic.]

I run stockportfolio.pro — we maintain a cached panel of SEC fundamentals
(income statement / balance sheet / cash flow, as filed, ~19 years /
48 quarters) plus a filing-change table (period-over-period deltas with a
materiality score), every row carrying a sourceUrl back to the original
EDGAR filing. No market data, no user data — just the filed facts and the
deterministic differences between them.

Licensing it as a one-off export, $500–2,000 depending on scope. Terms and
what's/isn't included: [link to corpus-license-terms.md or a hosted copy].

If useful for what you're building, reply with the scope you'd want
(how many companies, how far back) and I'll quote a number.

[sign-off]
```

## Show HN / Reddit post draft

```
Title: SEC fundamentals + filing-change dataset for sale (sourced, one-off)

I've spent [time] building a filing-change monitor for stockportfolio.pro
— it diffs SEC filings period-over-period and flags what materially
changed. As a byproduct I have a clean panel of SEC fundamentals (as
filed, ~19yr/48q) plus the filing-change deltas, every row sourced back
to the original filing.

Selling it as a one-off export ($500-2,000 depending on scope) since
someone building or backtesting on this kind of data would otherwise
spend real time scraping/cleaning EDGAR themselves. No market data
(don't have redistribution rights), no user data.

Terms: [link]. Happy to answer questions about what's in it.
```

## Researched leads (real, verified via web search 2026-08-25)

Priority: X/LinkedIn first (per instruction), email only where genuinely
published — **no email was pattern-guessed for anyone below**; where no
real published email exists, the contact channel is X/LinkedIn/GitHub/site
contact form only.

| Lead | What they're building | Contact | Source |
|---|---|---|---|
| dgunning (EdgarTools) | Leading open-source Python lib for SEC EDGAR/XBRL, calls itself the default financial-data layer for AI projects; offers consulting | GitHub [@dgunning](https://github.com/dgunning/edgartools); site contact form | github.com/dgunning/edgartools |
| Stefano Amorelli (sec-edgar-mcp) | Solo builder, MCP server + agent toolkit for SEC filings/insider trading analysis | GitHub [@stefanoamorelli](https://github.com/stefanoamorelli/sec-edgar-mcp); GitHub Sponsors | github.com/stefanoamorelli/sec-edgar-mcp |
| sareegpt (EdgarTools MCP server) | Community MCP wrapper exposing EdgarTools to AI clients | GitHub [@sareegpt](https://github.com/sareegpt/edgartools-mcp) only | github.com/sareegpt/edgartools-mcp |
| Unlevered (@Unleveredai) | "The AI SEC Platform" — analyzes filings/IR materials/transcripts; small NY seed-stage team | X [@Unleveredai](https://x.com/unleveredai); site unlevered.ai | unlevered.ai, Crunchbase |
| SEC-API.io (sec-edgar-api) | Structured SEC filings/XBRL API — posts AI filing-summary demos on LinkedIn. **Note: closer to a competitor/reseller than an end buyer** — worth a different pitch angle | LinkedIn company page "sec-edgar-api" | LinkedIn posts |
| Pipeworx | Data gateway for AI agents; its `entity_profile` tool fans out across SEC EDGAR/XBRL/USPTO/GDELT for filings+fundamentals in one call | Site pipeworx.io — founder handle not confirmed, check site first | pipeworx.io |
| Financial Datasets (financialdatasets.ai) | "Stock Market API for AI Agents" — financials/filings for 27k+ tickers | Site financialdatasets.ai — founder handle not confirmed, check site first | financialdatasets.ai |
| RedChip Companies (RedChat) | AI chatbot giving small-cap/microcap investors filing-sourced Q&A across 2,000+ companies | Via redchip.com investor-relations contact | Nasdaq press release, 2025-02-03 |

**Not verified enough to include:** no genuine individually-published
personal email exists for any of these — matches the stated priority
(X/LinkedIn/GitHub over email). Pipeworx and Financial Datasets need a
manual site visit to grab the specific founder's handle before outreach.
Excluded Kaleidoscope/kscope.io, Brightwave, and Filing Navigator AI —
they read as funded/established rather than the small-buyer profile asked
for.

## What I did NOT do

- Did not send anything, DM anyone, or contact any of the leads above —
  this is a research list for you to act on.
- Did not guess or pattern-generate any email addresses.
- Did not verify Pipeworx/Financial Datasets founder identity by name —
  flagged above as a manual step before outreach.
