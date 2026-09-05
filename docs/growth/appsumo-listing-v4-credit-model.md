# AppSumo listing v4 — report-first, credit-metered

> **STATUS: SUPERSEDED by `appsumo-listing-v5.md` (2026-09-06).** Kept for the customer
> quotes and the v3→v4 rationale. v5 gives Dossier and Monitor a section each, prices the
> credits in reports, fixes the "unlimited companies" claim (tiers cap at 1/4/8) and drops
> the unreachable Deep Dossier row. **Nothing submitted from either version.**
>
> Original status: DRAFT. NOTHING SUBMITTED. Owner reviews and approves before a single
> field is changed. Supersedes `appsumo-listing-ai-tool-reframe.md` (v3), whose
> feature order put Ask first — written before we had customer evidence saying the
> opposite.

⚠️ Do **not** edit listing *versions* in the Partner Portal — known mapping bug.
Email William for version and tier-spec changes. This document is listing text only.

---

## Why v4 exists: the customers told us

**Kris (Tier 2), 30 Aug — why he bought:**
> "I checked the differences of all 4 reports... my perception is **the true value of
> your service lies in the dossier and filing monitor reports** because they can really
> open one's eyes to the blind folds that the regular financial media fails to and
> ignores to enlighten the investors. These reports truly made me see the traps of
> blindly following the numbers through the rose colored Financial/analyst reports and
> their pseudo expert bluster."

**Alex (Tier 1), 4 Sep — how to sell it:**
> "instead of the tagline 'The report, not a chat.', do something more along the lines
> of Detailed Research Reports on Stocks based on REAL Data... **Framing it as a report
> first, then chat for more detail** I think would be much more successful."

Two customers, independently, same message: **the report is the product; Ask is the
follow-up.** v3 led with Ask. v4 leads with Dossier and Filing Monitor.

**And the meter was wrong.** Tiers differed only by Ask count (30/100/300) — a meter of
our cost, not the buyer's value. Result: after the listing went public, orders rose
**+167%** while average order value fell **58%** ($89 → $37.50). Everyone bought the
bottom rung because the bottom rung was the whole product. v4 meters one thing: AI
credits.

---

## Product title

> StockPortfolio.pro — AI research reports on any US stock, cited to the SEC filing

Fallback if length-limited:
> StockPortfolio.pro — AI stock research, cited to the filing

## Tagline

> Full research reports and filing-change alerts built from real SEC data. Every number
> links to the filing it came from.

## Opening

> The headline says revenue grew. The filing says something else.
>
> Financial media and most AI tools hand you a confident number with no way to check it.
> StockPortfolio.pro reads the actual SEC filing and gives you two things:
>
> **A full research report** on any covered US-listed company — statements, ratios,
> health checks, growth records, segments, insider activity, reverse-DCF — with up to
> 19 years of filed history and a source link on every figure.
>
> **A filing change report** that tells you what actually changed when a new 10-K, 10-Q
> or 8-K lands: which risk factors were edited, which language moved, which numbers
> shifted — ranked by materiality.
>
> Then, if you want to go further, you ask follow-up questions — answered from those
> same filings.

## Feature blocks — report first, chat last

> **1. Research Dossier — the full report, in minutes**
> Statements, ratios, health checks, growth records, segment breakdown, insider activity
> and a reverse-DCF for any covered US-listed company, with up to **19 years of filed
> history on every tier**. Every figure carries its fiscal period and its SEC source link.
>
> **2. Filing Change Monitor — what actually changed in the new filing**
> When a 10-K, 10-Q or 8-K lands, it's read against the previous one: risk-factor edits,
> language changes, the numbers that moved — ranked by materiality, each item linked to
> the filing. The first pass through a new filing, done for you.
>
> **3. Portfolio tracker with filing alerts**
> Track your holdings and get told when one of them files something that matters.
>
> **4. Ask — follow-up questions, answered from the filings**
> Ask anything about a covered company in plain English. Every figure keeps its fiscal
> period and its SEC source link. If a number hasn't been filed, the answer says so
> instead of estimating it.

## Proof block

> **Check it before you buy.** Our public Claim Ledger takes real financial headlines and
> checks them against the filings they describe — including where the numbers don't
> match: `stockportfolio.pro/verify-ledger`

## Plans — one simple meter

> **Every tier includes every feature**: Research Dossier, Filing Change Monitor,
> portfolio tracking, filing alerts, Ask, and up to 19 years of filed statements.
> Unlimited companies, unlimited portfolios. Tiers differ by monthly AI credits.
>
> | | Starter — $39 | Investor — $79 | Pro — $149 |
> |---|---|---|---|
> | AI credits per month | **100** | **300** | **800** |
> | Everything else | Included | Included | Included |
>
> **What things cost, so there are no surprises:**
>
> | Action | Credits |
> |---|---|
> | Ask a question | 2 |
> | Filing Monitor report | 5 |
> | Research Dossier | 10 |
> | Deep Dossier | 30 |
> | Compare two dossiers | 5 |
>
> Credits reset on the 1st of each month. Run dry early? Top up 150 credits for $14.99,
> any time — no subscription.

## Limits — keep verbatim, it converts

> Scope is deliberate: US-listed companies that report in USD to the SEC. No
> international coverage, no analyst estimates, no forward data, no price targets. If you
> want a market terminal, this isn't one.

## Integrity note

> We deleted a finished ETF grading feature the week we built it, because the upstream
> expense-ratio data had a 100× error we couldn't reliably detect. If we can't verify it,
> we don't ship it.

## Category and tags

- Primary category **AI** if the taxonomy allows; Finance secondary.
- Add: `ai`, `ai-assistant`, `research`, `sec-filings`, `due-diligence`
- De-emphasise: `portfolio-tracker` — wrong comparison set.

## Words to avoid

`revolutionary`, `game-changer`, `powered by cutting-edge AI`, `10x`. The whole promise
is "you can check this" — inflated copy argues against it.

---

## Owner checklist

- [ ] **Email William: correct the "Uses AI: No" flag.** Do this first — every word above
      is undercut while the listing formally declares the product is not an AI tool.
- [ ] **Email William: the tier spec change** (credits, not Ask counts). Not in the portal.
- [ ] Approve the copy above.
- [ ] Confirm the credit numbers match production before the listing goes live —
      `backend/credits.js` `LTD_CREDIT_ALLOWANCE` is the source of truth and currently
      reads `{ 1: 100, 2: 300, 3: 800 }`.
- [ ] Set `STRIPE_PRICE_ID_CREDITS_TOPUP` on Render to an active one-time $14.99 price,
      or delete the top-up line from the listing. **The recharge route refuses to sell
      without it**, so advertising it while unset is a promise the product cannot keep.
- [ ] Re-check category and tags.
- [ ] Do **not** touch listing versions in the portal.

## What changed vs v3

| | v3 | v4 |
|---|---|---|
| Lead feature | Ask (chat) | Research Dossier + Filing Monitor |
| Basis | positioning hypothesis | two customers, unprompted, in writing |
| Meter | Ask count 30/100/300 | AI credits 100/300/800 |
| Per-feature pricing | not published | published on the listing |
| History depth | unstated | 19 years, every tier |
| Top-ups | not mentioned | $14.99 / 150 credits |

**No existing buyer is narrowed by v4.** Old wallets were 60/200/600 (derived as Ask
limit ×2); new are 100/300/800. Every tier goes up, which is why this needs no
grandfather clause and no AppSumo downgrade approval — verified against all 13 live
accounts, zero downgrades.
