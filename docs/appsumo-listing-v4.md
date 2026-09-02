# AppSumo listing v4 — "Institutional research, one click" (draft, September 2026)

Supersedes `appsumo-listing-v3.md`. Three things changed since v3:

1. **Customer evidence hardened.** An AppSumo buyer who ran five Dossiers in one
   sitting and never opened the Ask box told us in writing that the chat is a
   commodity and the structured report is the product. That quote now carries
   the long description.
2. **Compare removed from the tier table.** `backend/app.js` (the
   `/api/dossier/compare` route) hard-caps a comparison at **3 companies for
   every tier**, is stateless (there is no saved-comparison object to count) and
   is already credit-metered. A tiered "1/4/8 comparisons" row described a
   feature that does not exist. Compare stays in the bullets, described
   truthfully.
3. **Monitor watchlist is the tier ladder**, per owner instruction 2026-09-02:
   **1 / 4 / 8** companies, alongside history depth 5 / 10 / 19 years.

Contracted facts: **$39 / $79 / $149 one-time**, **30 / 100 / 300** Ask
questions per month, 6,000+ US stocks, 17 + custom screeners, no broker
connections.

⚠️ **The shipped code over-delivers against this copy, deliberately.**
`lib/tier-limits.js` grants **12 / 40 / unlimited** monitored companies, and
history depth is unmetered while `ENABLE_TIER_V2_LIMITS` is off. Buyers
therefore receive more than the listing promises — the safe direction. Narrowing
the code to match would narrow a lifetime entitlement, which that file forbids;
any such change needs a redemption-date cutover and leaves all existing buyers
on 12 / 40 / unlimited permanently. AppSumo's live page remains the final
authority on terms.

---

## Title (<= 60 chars)

StockPortfolio.pro — SEC Research Dossiers + Filing Monitor

## Tagline

Institutional-grade research, without the analyst's desk.

## Headline / first line of the description

One click, one report. Zero prompting.

## Bullet highlights (the scannable list)

- **The Dossier — the report, already written.** One click on a ticker returns
  the initiation report an analyst bills 20–40 hours for: decision brief, filed
  trajectory, segments, valuation, bull and bear case, risks. No prompts to
  engineer, no interrogation — every figure cited to its SEC filing, and written
  in plain English rather than filing-speak.

- **Compare rides on structure, not effort.** Because every dossier follows the
  same twelve sections in the same order, you can put **up to three companies
  side by side** in one click — aligned metrics, briefs and risks. The
  difference you see is the company, not the questions you happened to ask.

- **The Filing Monitor — your analyst on retainer.** The dossier earns your
  research once; the monitor keeps it current. Watch **1, 4 or 8 companies** by
  tier. When a new 10-K, 10-Q or 8-K lands, you get a plain-English summary of
  what changed and how much it matters, ranked by materiality.

- **Filing Diff — the redline institutions pay for.** Hedge funds pay BamSEC and
  Hudson Labs to see exactly what a company reworded between filings. We diff the
  newest 10-K or 10-Q against the previous one of the same form: guidance and
  outlook language, risk-factor changes, demand and margin commentary, liquidity
  — **quoted from the documents, never recalled from memory.** When a company
  quietly softens its outlook, you read the before and the after.

- **Depth that matches your diligence.** Up to **19 years** of filed statements
  — 76 quarters, a full economic cycle. Margin trajectories, segment drift and
  restructuring patterns only appear in the long view.

- **Everything else stays out of the way.** A sourced AI research assistant for
  loose ends (its answers name their source class), 17 screeners plus custom
  filters, mixed stock/ETF/fund portfolios — and no brokerage credentials, ever.

## Also included — on every tier, including $39

Every item below ships today and is available on all three tiers. They are
`proGate`d in code, not tier-gated, and AppSumo buyers resolve to `pro`
(`backend/app.js` userTier) — so this is what a $39 buyer actually receives.

- **Guru tracker.** What Warren Buffett, Michael Burry, Bill Ackman, Seth
  Klarman, Stanley Druckenmiller and George Soros actually filed — 13F holdings
  straight from EDGAR, refreshed daily.

- **Smart alerts that aren't price alerts.** Every broker tells you a stock
  moved. These watch what price can't: **insider cluster buys** (two or more
  insiders filing open-market purchases inside 14 days — single buys are noise,
  clusters are the studied signal), **dividend-cut risk** (a payout stretched
  past what net income or free cash flow actually supports), and **your own
  valuation thresholds** ("tell me when AAPL's P/E drops below 25").

- **The real insider trail.** Three years of Form 4s per company, with genuine
  open-market buys and sales separated from awards, option exercises and tax
  withholding — the noise most screeners leave in.

- **"Why is my portfolio down today?"** Your broker shows the red number and
  stops. We attribute it: each holding's move × its weight, ranked by what
  actually mattered, with the headlines attached to the biggest movers.

- **A weekly briefing that never leaves the building.** Your portfolio's week in
  plain English, computed in-process — **your holdings are never sent to any
  model or outside service.**

- **Reverse-DCF.** Not "what is it worth" but *what growth does today's price
  already assume* — so you can decide whether that expectation is one you would
  take the other side of.

⚠️ Internal note, not listing copy: the above is true while `AI_PRO_FOR_ALL=true`
(`backend/prod.env.example`). Setting it to `false` drops AppSumo buyers to
`core` and silently revokes all of it, which would make this section false.

## Short description (~150 words)

StockPortfolio.pro gives retail investors the two things an institutional
research desk has that no chatbot replaces.

**One: the Research Dossier.** One click on any of 6,000+ US stocks returns
initiation-grade research — the same twelve cited sections, in the same order,
every time. Every figure links to its SEC filing. Because the structure never
changes, companies compare side by side instead of interview by interview.

**Two: the Filing Monitor.** Every new 10-K, 10-Q and 8-K on your watchlist is
read for you and digested into plain English, ranked by how much it actually
matters. You never do the manual first pass through a filing again.

Around them: up to 19 years of filed statements, 17 screeners with custom
filters, mixed stock/ETF/fund portfolios, and a sourced AI assistant for the
loose ends.

One-time purchase. Three tiers. No brokerage credentials required.

## Long description ("From the founding team")

**Why we rebuilt the pitch.**

We asked our lifetime customers a blunt question: what would make you open this
every week? The answer that changed our roadmap was not a feature request. It
was a correction — from a buyer who had run five Dossiers in one sitting and
never once opened the chat box:

> "Being able to chat about companies based on their filings is not something
> that differentiates your product. Basic AI chatbots with internet access can
> do that. The real special part is the ability to leverage AI to create reports
> in structured formats that are comparable across companies without needing the
> prompting. That is why dossiers is successful."
> — AppSumo buyer, August 2026

They were right. A chat is a commodity now. What is not is the thing the chat
was pretending to be: **the research itself — written down, in a consistent
professional structure, with sources.** So we stopped shipping chat-first and
shipped the workflow that was missing.

**Two institutional habits, made one click:**

**1. The Dossier. Click the ticker, read the report.**
A research desk starts a company with an initiation report: business,
trajectory, segments, valuation, cases, risks. We generate exactly that from the
company's SEC filings — same sections, same order, every company, every figure
linked to the filing it came from. You never open a prompt box, because the
questions are already asked, and they are an analyst's questions.

**Compare rides on structure.** Because every dossier is built identically, up
to three companies line up side by side in one click — aligned growth, margins,
what keeps the money, what is priced in, cases and risks.

**2. The Monitor. Every filing on your watchlist, read for you.**
The dossier earns your research; the monitor keeps it current. Add your
companies once. Each new 10-K, 10-Q or 8-K comes back as plain English — what
changed, how material it is, a link into the filing. Quarterly updates stop
being a weekend of PDFs.

**Written for investors, not auditors.** Early buyers told us the output read
too much like an SEC audit. We rewrote it to lead with the thesis in three or
four sentences, then the numbers that prove it, then the risk that would break
it.

**What it is not,** stated plainly: no trade execution, no brokerage
aggregation, no tick-by-tick terminal, no investment advice. Filings land
quarterly — the value is the digest, not millisecond latency.

**Pricing:** lifetime access from **$39 one time**. Three tiers differ by
watchlist size, history depth and monthly question allowance.

## At a glance (AppSumo's structured block)

- **Level:** Intermediate
- **Efficiency:** High
- **AI-driven analysis:** Yes
- **Works with:** US-listed stocks, ETFs, mutual funds
- **Requirements:** Any modern browser
- **Broker access needed:** None
- **Data basis:** SEC filings + labelled fund data + dated live web

## Tier table

| | Starter — $39 | Investor — $79 | Pro — $149 |
|---|---|---|---|
| Research Dossiers (6,000+ US stocks) | ✓ | ✓ | ✓ |
| Filing Monitor watchlist | 1 company | 4 companies | 8 companies |
| Statement history | 5 years (20 quarters) | 10 years (40 quarters) | 19 years (76 quarters) |
| AI research assistant — questions / month | 30 | 100 | 300 |
| Filing Diff redlines | ✓ | ✓ | ✓ |
| Guru 13F tracker | ✓ | ✓ | ✓ |
| Smart fundamental alerts | ✓ | ✓ | ✓ |
| Insider Form 4 history | ✓ | ✓ | ✓ |
| Reverse-DCF & movement attribution | ✓ | ✓ | ✓ |
| Screeners | 17 + custom | 17 + custom | 17 + custom |
| Portfolio tracking (stocks + ETFs + funds) | ✓ | ✓ | ✓ |
| Brokerage credentials required | Never | Never | Never |

## Deal-page talking points (for the summary card & TL;DR)

- "One click is the whole method — the questions are already asked."
- "Every number cited to the filing it came from. Never guessed."
- "Same twelve sections for every company — compare the company, not the prompts."
- "Your analyst reads every new filing on your watchlist, in plain English."
- "19 years of filed statements. A full cycle, not a snapshot."
- Not: trade execution, advice, brokerage aggregation, tick-by-tick terminals.

## FAQ

**How is this different from asking a general AI assistant about a stock?**
A chat is a commodity — every major assistant reads SEC filings now. What they
do not give you is **structure** (the same twelve sections, same order, every
company, so two line up side by side without re-prompting) or **persistence** (a
monitor that keeps that research current, filing by filing). Use the AI
assistant for loose ends. The Dossier and Monitor are the foundation.

**Where do the numbers come from?**
The company's SEC filings. Each figure in a dossier links to the filing it came
from, and the assistant's answers are labelled by source class. If the filings
do not support a claim, the product says so rather than inventing one.

**Do I need to connect a brokerage account?**
No. Nothing in the product needs broker credentials, ever.

**How recent is the research?**
Dossiers build from the latest filed statements, with up to 19 years of history.
The Monitor digests each new filing as it lands, including 8-Ks.

**What does the Monitor watchlist limit mean?**
It is how many companies the Monitor tracks for you continuously. Starter
follows 1, Investor 4, Pro 8. Dossiers and screeners are not limited by it — you
can research any of 6,000+ stocks on any tier.

**Is there a monthly fee?**
No. This is one-time for lifetime access. Tiers differ by watchlist size,
history depth and monthly assistant questions.

**What if a company I follow is not covered?**
6,000+ US stocks are covered today. Anything missing reports back honestly
instead of inventing a report.

## CTA text suggestions

- Primary: **Buy once, research forever**
- Secondary: "Try the free screener → no account needed"
- Underline under CTA: "One-time purchase · three tiers · no subscription"
