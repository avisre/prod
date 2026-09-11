# AppSumo listing v6 — the problem first, the product second

> **STATUS: DRAFT. NOTHING SUBMITTED.** Owner reviews and approves before a single field is
> changed. Supersedes `appsumo-listing-v5.md`, which put Dossier and Monitor in front — the
> right order — but still described what they *are* rather than what they *fix*.

⚠️ Do **not** edit listing *versions* in the Partner Portal — known mapping bug.
Email William for version and tier-spec changes. This document is listing text only.

✅ **Section 3 (API + MCP) is cleared to send.** Verified live on production 2026-09-11:
`GET /api/v1/health` returns `200 {"ok":true,"version":"v1"}` and `/mcp` returns a `401`
auth challenge rather than a 404, so the routes and the key gate are both deployed.

---

## Why v6: the same three words kept coming back

v5 was written from Kris's and Alex's feedback and it fixed the ordering problem. Reading it
back, every section still opens on machinery — twelve sections, forms read against forms,
credits as a unit. A buyer skimming an AppSumo page does not start from machinery. They start
from a worry.

So v6 keeps v5's structure, verified numbers and integrity notes intact, and changes only
where each section *starts*: with the thing that goes wrong, then the thing that fixes it.

One section is new. The public API and MCP endpoint shipped on 11 Sep, and the problem it
solves — an AI assistant that invents financial figures — is the most concrete problem this
product has ever been able to answer.

---

## Product title

> StockPortfolio.pro — SEC research dossiers and filing-change reports

Fallback if length-limited:
> StockPortfolio.pro — SEC research dossiers, cited to the filing

## Tagline

> Know what you actually own. Find out the moment the story changes. And give your AI a
> source it can cite.

## Opening

> The headline says revenue grew. The filing says something else.
>
> Three things go wrong when you research a stock on your own, and this fixes all three.
>
> **You decide on thin evidence.** Four headlines, a chart, and a number someone quoted on a
> podcast. The filing that would settle it is 180 pages long and you have eleven other
> companies to look at.
>
> **The story changes and nobody tells you.** A company softens its outlook in February. You
> notice in June, in the price.
>
> **Your AI makes things up.** Ask any general assistant what a company earned last quarter
> and you get a confident, uncited, occasionally invented number — with no way to tell which
> kind you just got.

## 1. You are about to put real money into a company you have read three headlines about

> Type the ticker. Twelve minutes later you have the write-up an analyst bills 20–40 hours
> for — and you did not have to know which questions to ask.
>
> - **The case in two minutes** — what this business is, what it earns, what would break it
> - **Up to 19 years of filed statements, 76 quarters** — a full economic cycle. Margin
>   drift, segment shifts and restructuring patterns do not exist in a five-year view; they
>   only show up in the long one.
> - **What each part of the business actually earns**, from the segment tables
> - **A reverse-DCF** — what today's price is already assuming the company will do
> - **The bull and the bear case**, written from the filings rather than from sentiment
> - **Risks, health checks, growth records, insider activity**
>
> Every figure carries its fiscal period and a link to the SEC filing it came from. Nothing
> is recalled from memory; if it is not filed, it is not there.
>
> And because every dossier has the same twelve sections in the same order, two or three
> companies line up side by side in one click. **The difference you see is the company, not
> the questions you happened to ask.**

## 2. The story changed in February. You found out in June, in the price.

> Companies do not announce that they have gone quiet on a customer, or that a risk factor
> grew two paragraphs, or that "strong demand" became "resilient demand". They file it.
>
> When a company you watch files its next 10-K, 10-Q or 8-K, the Filing Change Monitor reads
> it against the previous filing of the same form and shows you **the before and the after,
> quoted verbatim**, each with its EDGAR link, ranked by how much it matters — guidance and
> outlook language, risk-factor edits, demand and margin commentary, liquidity.
>
> When a company quietly softens its outlook, you read the exact sentence it replaced.
>
> Watch **1 company on Starter, 4 on Investor, 8 on Pro.**

## 3. Your AI assistant just made up a revenue number — again *(Pro tier)*

> **Included on the Pro tier.** Ask Claude, ChatGPT or your own agent what a company earned
> and you get an answer with no provenance. It might be right. You cannot tell.
>
> Point it here instead. Your AI gets a filing-grounded source it can call directly — company
> financials, filing timelines, two-company comparisons, ranked screens, and grounded answers
> — and **every deterministic value comes back with the SEC filing it was drawn from**. When
> something is not filed, the answer says so rather than estimating it.
>
> Works as a **hosted MCP endpoint** for any MCP-compatible client, or as a **REST API** with
> a key you create yourself from your account page. Same credit balance as the website — no
> second quota to track, nothing separate to buy.

## 4. What your credits buy

> **One meter.** Every tier includes every feature — Research Dossier, Filing Change Monitor,
> portfolio tracking, filing alerts, Ask, CSV holdings import, 17 screeners plus custom
> filters, and up to 19 years of filed statements on **every** tier. Research any covered
> US-listed company you like, and keep as many portfolios as you like. Tiers differ by how
> many reports you run each month, how many companies the Monitor watches, and whether API
> and MCP access is included.
>
> | | Starter — $39 | Investor — $79 | Pro — $149 |
> |---|---|---|---|
> | **AI credits per month** | **50** | **150** | **400** |
> | Research Dossiers, if you spent it all there | 5 | 15 | 40 |
> | or Filing Monitor reports | 10 | 30 | 80 |
> | Companies watched by the Monitor | 1 | 4 | 8 |
> | API and MCP access | — | — | included |
>
> **What each thing costs, so there are no surprises:**
>
> | Action | Credits |
> |---|---|
> | Research Dossier | 10 |
> | Filing Monitor report | 5 |
> | Compare two dossiers | 5 |
> | Ask a follow-up question | 2 |
> | MCP lookup | 1 |
> | MCP ask | 2 |
> | REST API lookup | 2 |
> | REST API ask | 4 |
>
> Mix them however you like. A typical Investor month is 8 dossiers, 10 monitor reports and
> 10 follow-up questions — that's 150. Credits reset on the 1st of each month.
>
> MCP is the cheaper of the two programmatic paths on purpose: it is the agent-native one.

**Top-up line — hold until the Render price ID is set.** If and only if
`STRIPE_PRICE_ID_CREDITS_TOPUP` is live in production, append:

> Run dry early? Top up 150 credits for $14.99, any time — no subscription.

## Ask, in one line

> Once you have read the report, ask follow-up questions in plain English — same filings,
> same citations, same refusal to estimate a number nobody filed.

## Proof block — unchanged from v5

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

Unchanged from v5, and still not done in the portal.

**Best for.** Every buyer so far is an individual doing their own due diligence — one LLC
among sixteen sales. "Small businesses" and "Businesses" put the listing in front of an
audience with no use for a 10-K diff, and set up the "too limited" refund reason. Keep
**Solopreneurs**; add **Consultants** if the taxonomy offers it (RIAs and independent
analysts are the one professional shape that fits); drop the other two. Pick from the
portal's own dropdown — do not invent values.

**Alternative to.** Drop **Bloomberg Terminal.** It contradicts our own Limits paragraph five
screens below it — *"If you want a market terminal, this isn't one"* — and it invites exactly
the expectation behind the 2 Sep refund ("Product's functionality was too limited / Lacking
Depth") from a licence that was never even redeemed. Keep **Koyfin** and **SeekingAlpha**:
research tools individual investors genuinely compare against, and both comparisons we win on
sourcing.

**Category and tags.**

- Primary category **AI** if the taxonomy allows; Finance secondary.
- Add: `research`, `sec-filings`, `due-diligence`, `ai`, `ai-assistant`
- With Section 3 live, `mcp` and `api` become worth adding too.
- De-emphasise: `portfolio-tracker` — wrong comparison set, loses on price.

## Words to avoid

`revolutionary`, `game-changer`, `powered by cutting-edge AI`, `10x`. The whole promise is
"you can check this" — inflated copy argues against it. That applies to v6's problem-first
headings as much as anything: they are allowed to be blunt, not lurid.

---

## Before this is submitted

### Section 3's deploy gate — CLEARED 2026-09-11

This section was drafted on hold. HANDOFF recorded the API/MCP surface as *"shipped, NOT
deployed… live on a local boot only"*, and selling a surface a buyer cannot reach is the
precise failure `backend/test/credit-meter-truth.test.js` exists to prevent.

**That note was stale.** Measured against production on 2026-09-11:

```
GET /api/v1/health  ->  200  {"ok":true,"version":"v1","generatedAt":"2026-09-11T08:43:42Z"}
GET /mcp            ->  401  {"error":"Missing API key. Pass Authorization: Bearer <key>..."}
```

The 401 rather than a 404 is the load-bearing part: the route and its key gate are both
deployed. **Section 3 goes to William with the rest.**

**Every advertised tool was then exercised under a real key on production** (2026-09-11), so
Section 3 does not point buyers at anything untested:

| Tool | Endpoint | Result |
|---|---|---|
| financials | `GET /api/v1/financials/AAPL?tool=earnings-quality` | 200 |
| filing | `GET /api/v1/filing/AAPL` | 200 |
| compare | `GET /api/v1/compare?tickers=AAPL,MSFT` | 200 |
| screen | `GET /api/v1/screen?tickers=AAPL,MSFT,NVDA` | 200 |
| ask | `POST /api/v1/ask` | 200, answered from filed data |

The wallet moved 155 → 167, i.e. exactly 12 credits for four lookups at 2 and one ask at 4 —
so the published REST prices are the prices production actually charges. The key was minted
for the test and revoked immediately afterwards.

`/api/v1/fund` was deliberately not exercised: the listing does not advertise it, for the
redistribution reason below.

### Why the fund endpoints are not advertised

The API and MCP surfaces both expose a fund profile route (`sp_fund` on MCP,
`/api/v1/fund/:symbol` on REST). `backend/public-api.md` labels it Yahoo-derived and **not
redistributable**, and `docs/growth/corpus-license-terms.md` says the same thing about
quote-derived data generally: *"We don't have redistribution rights to those."*

An AppSumo lifetime deal is a permanent entitlement. v4's "unlimited companies" line is the
standing precedent for what it costs to publish a promise that later has to be narrowed —
it cannot be. So the listing advertises the SEC-derived surface only: financials, filings,
compare, screen, ask. The fund route keeps working for signed-in web users; we simply do not
sell redistribution rights we do not hold. This is the same conclusion
`docs/growth/mcp-api-lab-outreach.md` reached independently.

`credit-meter-truth.test.js` now asserts the listing copy never names a fund endpoint, so a
future copy edit cannot quietly undo this.

### The tier-3 gate has to stay visible

`backend/public-api.md` gates API/MCP to Power, Desk, or AppSumo tier 3, checked live on
every call rather than only at key creation. Section 3 is the only headline section that is
not available on every tier, so **"Pro tier" appears in its heading and again in its first
line**, and the tier table carries its own row. A Starter buyer who reads a third headline
and then hits a paywall is a refund, and refunds on this listing have already been traced to
expectation gaps rather than product defects.

### Numbers verified this session

Against `backend/credits.js`: `LTD_CREDIT_ALLOWANCE_V2 = {1:50, 2:150, 3:400}` and
`COST = {ask:2, monitor:5, dossier_standard:10, dossier_compare:5, mcp_lookup:1, mcp_ask:2,
api_lookup:2, api_ask:4}`. The REST tier is exactly 2× MCP by design, per `public-api.md`.
`frontend-v2/appsumo.html` already publishes 50/150/400 and the 1/4/8 Monitor ladder, so the
site and the listing agree.

Deep Dossier remains deliberately unpriced: `?depth=deep` is URL-only and
`frontend-v2/assets/dossier.js` never sends it, so no buyer can invoke it.

## Owner checklist

- [x] **Emailed William: the "Uses AI: No" flag.** Sent 2026-09-11 to `partners@appsumo.com`,
      subject *"StockPortfolio.pro — please correct the 'Uses AI' flag on our listing"*.
- [x] **Emailed William: the copy, tier spec and classification.** Sent 2026-09-11, subject
      *"StockPortfolio.pro — updated listing copy and tier spec"*. Carries the full copy, the
      50/150/400 wallet with the per-action costs, the Monitor 1/4/8 ladder, and the
      Best-for / Alternative-to / tag corrections. It states explicitly that existing buyers
      keep their larger wallet permanently and only new redemptions get 50/150/400, so the
      change is not read as a downgrade of sold licences.
- [x] **Deploy `/api/v1` + `/mcp`** — confirmed live on production 2026-09-11, so Section 3
      ships with the rest. All five advertised tools verified 200 under a real key, and the
      REST prices verified against the wallet (12 credits for 4 lookups + 1 ask).
- [ ] **Reply to William with the three images** when he says where to send them — the email
      asks. Keep the existing hero; only the three product shots change.
- [ ] Set `STRIPE_PRICE_ID_CREDITS_TOPUP` on Render (`price_1UAUOtAUeKapY1OPUcSIaloi`), or
      leave the top-up line out. The route refuses to sell without it.
- [ ] Do **not** touch listing versions in the portal.

## What changed vs v5

| | v5 | v6 |
|---|---|---|
| Section openings | name the feature ("The Research Dossier — the report, already written") | name the buyer's problem ("You are about to put real money into a company you have read three headlines about") |
| Opening | two things, both reports | three problems, stated before any feature |
| API + MCP | absent | a headline section, Pro-tier-gated, SEC-surface only, held for deploy |
| Ask | a short section | one line under its own heading |
| Cost table | four actions | eight, including the two MCP and two REST prices |
| Tier table | three rows | four — API/MCP access added as an explicit Pro differentiator |

**No existing buyer is narrowed by v6.** The wallet, the Monitor ladder and the per-action
costs are unchanged from v5; the only additions are prices for surfaces that did not exist
when v5 was written. All 18 buyers who redeemed before
`CREDIT_ALLOWANCE_V2_EFFECTIVE_FROM` keep 100/300/800 permanently.
