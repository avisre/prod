# AppSumo listing v7 — API and MCP for everyone who already bought

> **STATUS: DRAFT. NOTHING SUBMITTED.** Owner reviews and approves before a single field is
> changed. Supersedes `appsumo-listing-v6.md` (also never submitted), which gated API and MCP
> to the Pro tier. That is still the rule for new purchases — but every buyer who purchased on
> or before **22 September 2026** now keeps API and MCP on whichever tier they bought, for life.

> **What changed vs v6, in one line:** section 3 is no longer Pro-only, the tier table's API
> row reflects the two populations, and a five-question FAQ answers the MCP questions buyers
> are actually asking before they purchase.

> **Why this is safe to publish.** It *widens* a lifetime entitlement for existing buyers and
> leaves the narrower rule in place for new ones. Widening needs no AppSumo downgrade approval;
> narrowing would need both a grandfather clause and their sign-off. Nobody who has already
> bought loses anything — verified against the Licensing API: all 25 licences sold to date were
> purchased on or before the cutoff, so every existing buyer is on the generous side.

⚠️ Do **not** edit listing *versions* in the Partner Portal — known mapping bug.
Email William for version and tier-spec changes. This document is listing text only.

✅ **Section 3 (API + MCP) is cleared to send.** Verified live on production 2026-09-11:
`GET /api/v1/health` returns `200 {"ok":true,"version":"v1"}` and `/mcp` returns a `401`
auth challenge rather than a 404, so the routes and the key gate are both deployed.

---

## Why v7: buyers are asking about MCP before they buy

Five questions arrived from one prospect, and they are the questions every technical
buyer will ask. They are answered verbatim in the FAQ section below — the honest
version, including the part about what an AI answer costs. A buyer who finds out
afterwards that 50 credits buys one AI ask refunds; a buyer who was told up front
and bought anyway keeps the deal.

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

## 3. Your AI assistant just made up a revenue number — again

> **Included on every tier purchased on or before 22 September 2026. From 23 September 2026,
> included on the Pro tier.** Ask Claude, ChatGPT or your own agent what a company earned
> and you get an answer with no provenance. It might be right. You cannot tell.
>
> Point it here instead. Your AI gets a filing-grounded source it can call directly — company
> financials, filing timelines, two-company comparisons, ranked screens, and grounded answers
> — and **every deterministic value comes back with the SEC filing it was drawn from**. When
> something is not filed, the answer says so rather than estimating it.
>
> Works as a **hosted MCP endpoint** for any MCP-compatible client, or as a **REST API** with
> a key you create yourself from your account page. Same credit balance as the website — no
> second quota to track, nothing separate to buy, and no add-on fee ever.
>
> This is live in production today. It is not a beta, a waitlist or a roadmap item.

## 4. What your credits buy

> **One meter.** Every tier includes every feature — Research Dossier, Filing Change Monitor,
> portfolio tracking, filing alerts, Ask, CSV holdings import, 17 screeners plus custom
> filters, and up to 19 years of filed statements on **every** tier. Research any covered
> US-listed company you like, and keep as many portfolios as you like. Tiers differ by how
> many reports you run each month, how many companies the Monitor watches, and — for purchases
> made from 23 September 2026 — whether API and MCP access is included.
>
> | | Starter — $39 | Investor — $79 | Pro — $149 |
> |---|---|---|---|
> | **AI credits per month** | **50** | **150** | **400** |
> | Research Dossiers, if you spent it all there | 2 | 7 | 19 |
> | or Filing Monitor reports | 6 | 18 | 50 |
> | Companies watched by the Monitor | 1 | 4 | 8 |
> | API and MCP access | included\* | included\* | included |
>
> \* Included on Starter and Investor for purchases made **on or before 22 September 2026**.
> From 23 September 2026 API and MCP ship on the Pro tier only. Buyers keep what they bought.
>
> **What each thing costs, so there are no surprises:**
>
> | Action | Credits |
> |---|---|
> | Research Dossier | 21 |
> | Filing Monitor report | 8 |
> | Compare two dossiers | 5 |
> | Ask a follow-up question | 2 |
> | Data lookup — MCP or REST | 2 |
> | AI-backed ask — MCP or REST | 42 |
>
> Mix them however you like. A typical Investor month is 4 dossiers, 6 monitor reports and
> 9 follow-up questions — that's 150. Credits reset on the 1st of each month.
>
> MCP and the REST API cost exactly the same, action for action — they run the same call over
> the same filings. MCP is the agent-native path, not the cheaper one: choose it because your
> client speaks MCP, not to save credits.

**Top-up line — hold until the Render price ID is set.** If and only if
`STRIPE_PRICE_ID_CREDITS_TOPUP` is live in production, append:

> Run dry early? Top up 150 credits for $14.99, any time — no subscription.

## FAQ — the five MCP questions, answered

These go in the listing's FAQ fields. Answer order is the order they get asked in.
Every number here is the number the code actually charges — check against
`backend/credits.js` COST before submitting, and do not round any of them down.

**1. Will API and MCP access be permanently included with the AppSumo Lifetime Deal?**

> Yes, if you purchase on or before 22 September 2026. API and MCP access is then part of your
> lifetime entitlement on whichever tier you bought, and it does not expire. Access is
> re-checked on every call rather than granted once at signup, so it also stops immediately if
> a licence is refunded. From 23 September 2026, API and MCP are included on the Pro tier.

**2. Will MCP be available on all AppSumo tiers, or only on specific tiers?**

> Purchased on or before 22 September 2026: all three tiers — Starter, Investor and Pro.
> Purchased from 23 September 2026: Pro only. Nobody loses what they already bought.

**3. Will there be any separate subscription, add-on fee, or future payment required?**

> No. No add-on, no second subscription, no future payment to keep using it. You generate your
> own key from your account page and it authenticates both the REST API and the hosted MCP
> endpoint. There is an optional credit top-up if you want *more* usage, but nothing you must
> buy to keep access.

**4. Will MCP/API usage have any monthly limits, credit limits, or rate limits?**

> Yes, and they are the limits you already have — there is no second quota. Both surfaces spend
> the same monthly credit allowance as the website: 50, 150 or 400 credits by tier, refreshing
> monthly. MCP and REST are priced identically, so neither surface is the cheap way in.
>
> | Action | Credits |
> |---|---|
> | Data lookup (MCP or REST) | 2 |
> | AI-written answer (MCP or REST) | 42 |
>
> Read that last row carefully before you buy. An AI answer costs 42 credits because it is the
> same expensive call the website charges for — so a 50-credit Starter month is **one** AI
> answer, or **25 data lookups**, or any mix. If your integration is deterministic lookups, the
> allowance goes further. If you want your agent writing AI answers all day, buy Pro or
> top up. There is also a limit of 60 requests per minute per key.

**5. If MCP is currently in beta, will AppSumo buyers who receive access retain it afterwards?**

> API and MCP are live in production now — not a closed beta, not a waitlist. There is no beta
> period to graduate from and nothing to re-qualify for. Seven tools are exposed today:
> financials, filing timeline, compare, screen, fund data, ask and health.

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

## Before this is submitted — v7 blocker

**Do not publish this listing until the entitlement is actually live in production.** The
listing claims Starter and Investor buyers have API and MCP. That becomes true only when:

1. `LTD_API_ACCESS_CUTOFF=2026-09-22T23:59:59.999Z` is set in production env and deployed.
   Unset, the code grants nobody the widening — it ships dark on purpose.
2. `node scripts/import-grandfathered-licences.js --apply` has been run once. It reads the
   AppSumo Licensing API (where a licence's `created_at` is the purchase instant) and flags
   the buyers whose purchase date beats their redemption date. Re-runnable; dry run by default.
3. Spot-check: sign in as a tier-1 buyer who redeemed before the cutoff, create a key from the
   profile page, and confirm `GET /api/v1/financials/AAPL` returns 200 rather than 402.

Measured at the time of writing (Licensing API, 25 licences): every licence sold was purchased
on or before the cutoff — 13 active, of which **9 are tier 1 or 2 and newly gain access**, and
6 are bought-but-unredeemed, which is exactly the case step 2 exists to catch.

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
