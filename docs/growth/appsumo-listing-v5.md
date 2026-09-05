# AppSumo listing v5 — Dossier and Monitor lead, credits are the meter

> **STATUS: DRAFT. NOTHING SUBMITTED.** Owner reviews and approves before a single field
> is changed. Supersedes `appsumo-listing-v4-credit-model.md`, which was report-first in
> intent but still read as a feature list with Ask attached, and priced the product in an
> abstract unit.

⚠️ Do **not** edit listing *versions* in the Partner Portal — known mapping bug.
Email William for version and tier-spec changes. This document is listing text only.

✅ **The copy below is now backed by code** (2026-09-06). The Ask meter, the site copy and
this document were aligned in one pass; `backend/test/credit-meter-truth.test.js` fails if
any of them drift apart again. **One gate remains: the change has not been deployed.** See
"Before this is submitted".

---

## Why v5: three customers said the same thing

**Kris (Tier 2, 30 Aug)** — why he bought:
> "I checked the differences of all 4 reports... my perception is **the true value of your
> service lies in the dossier and filing monitor reports** because they can really open
> one's eyes to the blind folds that the regular financial media fails to and ignores to
> enlighten the investors."

**Alex (Tier 1 → Tier 2, 4 Sep)** — how to sell it, and how to price it:
> "Framing it as a **report first, then chat for more detail** I think would be much more
> successful."

> "You should definitely **clarify the credits** on the AppSumo website, rather than the
> questions limit."

Alex upgraded to Tier 2 the same afternoon he finally understood the meter. Clarity
converted; the listing was what stood in the way.

**The live listing still leads with** *"Answers any US stock question"* **and meters in Ask
questions** — the exact framing both of them told us to drop.

---

## Product title

> StockPortfolio.pro — SEC research dossiers and filing-change reports

Fallback if length-limited:
> StockPortfolio.pro — SEC research dossiers, cited to the filing

## Tagline

> The analyst report on any US stock, written for you — then kept current every time the
> company files.

## Opening

> The headline says revenue grew. The filing says something else.
>
> StockPortfolio.pro does two things, and both of them are reports.
>
> **It writes the research.** One click on a ticker returns an initiation-grade dossier on
> any covered US-listed company — the write-up an analyst bills 20–40 hours for. No
> prompting, no interrogation, every figure cited to the filing it came from.
>
> **It keeps the research current.** When that company files its next 10-K, 10-Q or 8-K,
> the Filing Change Monitor reads the new document against the old one and tells you what
> actually changed — which risk factors were edited, which language moved, which numbers
> shifted — ranked by how much it matters.
>
> Ask is in there too, for the follow-up question. It isn't the product.

## 1. The Research Dossier — the report, already written

> Twelve sections, the same twelve for every company, in the same order:
>
> - **Decision brief** — what this business is, what it earns, what would break it
> - **Filed trajectory** — up to **19 years** of statements, 76 quarters, a full economic
>   cycle. Margin drift, segment shifts and restructuring patterns only appear in the long view.
> - **Segments** — what each part of the business actually earns
> - **Valuation, including a reverse-DCF** — what today's price implies the company must do
> - **Bull and bear case**, written from the filings, not from sentiment
> - **Risks, health checks, growth records, insider activity**
>
> Every figure carries its fiscal period and a link to its SEC source. Because every dossier
> has the same structure, **two or three companies line up side by side in one click** —
> aligned metrics, briefs and risks. The difference you see is the company, not the
> questions you happened to ask.

## 2. The Filing Change Monitor — your analyst on retainer

> The dossier earns your research once. The Monitor keeps it earned.
>
> A new 10-K, 10-Q or 8-K is read against the previous filing of the same form: guidance
> and outlook language, risk-factor edits, demand and margin commentary, liquidity. You get
> the **before and the after, quoted verbatim**, each with its EDGAR link, ranked by
> materiality — never recalled from memory, never paraphrased.
>
> When a company quietly softens its outlook, you read the exact sentence it replaced.
>
> Watch **1 company on Starter, 4 on Investor, 8 on Pro.**

## 3. What your credits buy

> **One meter.** Every tier includes every feature — Research Dossier, Filing Change
> Monitor, portfolio tracking, filing alerts, Ask, CSV holdings import, 17 screeners plus
> custom filters, and up to 19 years of filed statements on **every** tier. Research any
> covered US-listed company you like, and keep as many portfolios as you like. Tiers differ
> by how many reports you run each month.
>
> | | Starter — $39 | Investor — $79 | Pro — $149 |
> |---|---|---|---|
> | **AI credits per month** | **50** | **150** | **400** |
> | Research Dossiers, if you spent it all there | 5 | 15 | 40 |
> | or Filing Monitor reports | 10 | 30 | 80 |
> | Companies watched by the Monitor | 1 | 4 | 8 |
>
> **What each thing costs, so there are no surprises:**
>
> | Action | Credits |
> |---|---|
> | Research Dossier | 10 |
> | Filing Monitor report | 5 |
> | Compare two dossiers | 5 |
> | Ask a follow-up question | 2 |
>
> Mix them however you like. A typical Investor month is 8 dossiers, 10 monitor reports
> and 10 follow-up questions — that's 150. Credits reset on the 1st of each month.

**Top-up line — hold until the Render price ID is set.** If and only if
`STRIPE_PRICE_ID_CREDITS_TOPUP` is live in production, append:

> Run dry early? Top up 150 credits for $14.99, any time — no subscription.

## 4. Ask — the follow-up, not the headline

> Once you've read the report, ask it anything in plain English. Answers come from the same
> filings, every figure keeps its fiscal period and its SEC source link, and if a number
> hasn't been filed the answer says so instead of estimating it.

## Proof block — unchanged from v4

> **Check it before you buy.** Our public Claim Ledger takes real financial headlines and
> checks them against the filings they describe — including where the numbers don't match:
> `stockportfolio.pro/verify-ledger`

## Limits — keep verbatim, it converts

> Scope is deliberate: US-listed companies that report in USD to the SEC. No international
> coverage, no analyst estimates, no forward data, no price targets. If you want a market
> terminal, this isn't one.

## Integrity note

> We deleted a finished ETF grading feature the week we built it, because the upstream
> expense-ratio data had a 100× error we couldn't reliably detect. If we can't verify it,
> we don't ship it.

## Classification — who this is for, and what it is compared against

The live listing currently classifies the product as **Best for: Small businesses ·
Solopreneurs · Businesses** and **Alternative to: Bloomberg Terminal · Koyfin ·
SeekingAlpha**. Both are wrong in ways that cost money.

**Best for.** Every buyer so far is an individual doing their own due diligence — one
LLC among sixteen sales. "Small businesses" and "Businesses" put the listing in front of
an audience with no use for a 10-K diff, and set up the "too limited" refund reason.
Keep **Solopreneurs**; add **Consultants** if the taxonomy offers it (RIAs and independent
analysts are the one professional shape that fits); drop the other two. Pick from the
portal's own dropdown — do not invent values.

**Alternative to.** Drop **Bloomberg Terminal.** It contradicts our own Limits paragraph
five screens below it — *"If you want a market terminal, this isn't one"* — and it invites
exactly the expectation behind the 2 Sep refund ("Product's functionality was too limited /
Lacking Depth") from a licence that was never even redeemed. Keep **Koyfin** and
**SeekingAlpha**: research tools individual investors genuinely compare against, and both
comparisons we win on sourcing.

**Category and tags.**

- Primary category **AI** if the taxonomy allows; Finance secondary.
- Add: `research`, `sec-filings`, `due-diligence`, `ai`, `ai-assistant`
- De-emphasise: `portfolio-tracker` — wrong comparison set, loses on price.

## Words to avoid

`revolutionary`, `game-changer`, `powered by cutting-edge AI`, `10x`. The whole promise is
"you can check this" — inflated copy argues against it.

---

## Before this is submitted

**Done in code, 2026-09-06 — not yet deployed:**

1. **The Ask meter now matches the credit table.** `backend/app.js` used to hard-stop Ask at
   30 / 100 / 300 per tier regardless of the wallet, so credits were debited for Ask but
   never gated it — the table above would have overstated Starter by 67%. The gate is now
   an OR: an Ask is allowed when the wallet can pay it **or** the per-tier counter is still
   under cap. Every tier widens, no buyer loses the Asks they have today.
   Guarded by `backend/test/credit-meter-truth.test.js`, which also asserts this document's
   own numbers against `backend/credits.js`.
2. **Deep Dossier is deliberately absent from the cost table.** `?depth=deep` is URL-only and
   `frontend-v2/assets/dossier.js` never sends it — no buyer can invoke it. It goes back on
   the listing when it has a control; the test enforces that pairing.
3. **The site no longer contradicts the listing.** `frontend-v2/appsumo.html` publishes
   credits (100/300/800) priced in reports and keeps the 1/4/8 Monitor ladder; the
   `index.html` pricing cards carry each plan's credit allowance; the tagline is Alex's own
   framing; `frontend/llms.txt` leads with Dossier and Monitor; the Ask header and the
   profile page show credits instead of "0 / 30 Ask questions used this month". Cache stamp
   moved to `20260906-credits1` (91 occurrences, 44 files). Suite: 452/453, the one failure
   being the pre-existing `social-compose` selenium import.

**The remaining gate is the deploy.** Until this ships, production still enforces the old
30/100/300 Ask cap, so the tier-spec email to William must wait.

## Owner checklist

- [ ] **Email William: correct the "Uses AI: No" flag.** Do this first — every word here is
      undercut while the marketplace formally declares this is not an AI tool. Independent
      of everything else; send any time.
- [ ] **Email William: the tier spec** — 100 / 300 / 800 AI credits replacing 30 / 100 / 300
      Ask questions, the per-action cost table, Monitor 1 / 4 / 8. **Send only once the Ask
      OR-gate is deployed**, or the email claims something the running code refuses.
- [ ] Approve the copy above.
- [ ] **Set `CREDIT_ALLOWANCE_V2_EFFECTIVE_FROM` on Render** to the date this listing goes
      live. Until it is set, every new buyer keeps the larger V1 wallet — the code
      over-delivers against the page, which is the safe direction but not the intent.
- [ ] Confirm the numbers against production: `backend/credits.js` `LTD_CREDIT_ALLOWANCE_V2`
      is `{ 1: 50, 2: 150, 3: 400 }` and `COST` is
      `{ ask: 2, monitor: 5, dossier_standard: 10, dossier_deep: 30, dossier_compare: 5 }`.
- [ ] Set `STRIPE_PRICE_ID_CREDITS_TOPUP` on Render (`price_1UAUOtAUeKapY1OPUcSIaloi`), or
      leave the top-up line out. The route refuses to sell without it.
- [ ] Re-check category and tags.
- [ ] Do **not** touch listing versions in the portal.

## What changed vs v4

| | v4 | v5 |
|---|---|---|
| Dossier / Monitor | one bullet each | a section each, twelve dossier sections named, verbatim Was→Now quoted |
| Ask | fourth feature block | demoted, and the opening says outright it isn't the product |
| Credits | "100 / 300 / 800" as a bare unit | priced in **reports** — 10 / 30 / 80 dossiers, 20 / 60 / 160 monitor reports, plus a worked month |
| Monitor companies | "unlimited companies" (false — tiers cap at 1/4/8 on the live page) | 1 / 4 / 8, stated in the Monitor section and the table |
| Deep Dossier | 30-credit row | removed — unreachable in the UI |
| Top-up | stated unconditionally | conditional on the Render price ID being set |

**No existing buyer is narrowed by v5.** The published wallet (50/150/400) applies only to
redemptions on or after `CREDIT_ALLOWANCE_V2_EFFECTIVE_FROM`. All 18 buyers who redeemed
before it keep 100/300/800 permanently — `credits.js` `isCreditAllowanceV2Cohort()` fails
closed, so an account that cannot be classified keeps the larger wallet. The Monitor numbers
published here are the ones already on the live listing, and the Ask OR-gate keeps every
tier's 30/100/300 question floor regardless of wallet size.

**Why the wallet halved.** Measured provider cost: ~82,000 tokens per charged credit, so a
tier-3 buyer spending a full 800 would cost more in a month than the entire AI plan budget.
The heaviest real customer month on record is 118 credits, so this bites nobody today — it
caps the tail.
