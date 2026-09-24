# AppSumo listing v8 — the final-window repricing: 200 / 500 / 1000 at $149 / $299 / $499

> **STATUS: DRAFT. NOTHING SUBMITTED — and none of it is live yet.** The prices and the wallet
> below are NOT what production charges today. Supersedes `appsumo-listing-v7.md` (also never
> submitted). Owner reviews and approves before a single portal field is changed.

> **What changed vs v7, in one line:** the same listing text, repriced — $39/$79/$149 becomes
> $149/$299/$499, and the monthly wallet becomes 200/500/1000 on the same 1/4/8 Monitor ladder.
> The API and MCP populations, the per-action cost table, the copy and the classification are
> unchanged from v7.

> **Why this is safe to publish.** Two independent reasons, and both are load-bearing:
>
> 1. **The wallet only widens.** 200/500/1000 sits above BOTH earlier tables (100/300/800 and
>    50/150/400) on every tier, so nobody needs grandfathering and no AppSumo downgrade approval
>    is required. V2 was a narrowing and needed both; V3 needs neither. The code says the same
>    thing in the same words (`LTD_CREDIT_ALLOWANCE_V3`, `backend/credits.js`), and
>    `credit-meter-truth.test.js` fails the build if a future ladder ever inverts that.
> 2. **The price rise reaches only people who have not bought yet.** The 13 accounts already live
>    keep the tier they paid for and the wallet that was metering them. A *price* is not a lifetime
>    entitlement; a *wallet* is, which is why it only ever moves up.
>
> **For an existing buyer this changes nothing at all** — no wallet narrows, no Monitor cap moves,
> no API entitlement is touched.

⚠️ Do **not** edit listing *versions* in the Partner Portal — known mapping bug.
Email William for version and tier-spec changes. This document is listing text only.

✅ **Section 3 (API + MCP) is cleared to send.** Verified live on production 2026-09-11:
`GET /api/v1/health` returns `200 {"ok":true,"version":"v1"}` and `/mcp` returns a `401`
auth challenge rather than a 404, so the routes and the key gate are both deployed.

✅ **The per-action cost table is live.** Re-verified 2026-09-23: an MCP lookup debited exactly
2 credits (09:22 UTC), and an exhausted wallet returns the out-of-credits body on both surfaces,
with the $14.99 recharge link and the free-website alternative.

🚩 **The prices and the wallet are not live.** Read *The flip — exact values, exact order* below
before submitting: approving a listing that grants 200/month while production meters 50 is a
refund, not a rounding error.

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
> | | Starter — $149 | Investor — $299 | Pro — $499 |
> |---|---|---|---|
> | **AI credits per month** | **200** | **500** | **1000** |
> | Research Dossiers, if you spent it all there | 9 | 23 | 47 |
> | or Filing Monitor reports | 25 | 62 | 125 |
> | Companies watched by the Monitor | 1 | 4 | 8 |
> | API and MCP access | included\* | included\* | included |
>
> \* Included on Starter and Investor for purchases made **on or before 22 September 2026**.
> From 23 September 2026 API and MCP ship on the Pro tier only. Buyers keep what they bought.
>
> The ladder is priced so a credit costs less as the tier rises — $0.74 on Starter, $0.60 on
> Investor, $0.50 on Pro. That is the whole reason the Pro tier is the recommendation.
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
> Mix them however you like. A heavy Investor month is 12 dossiers, 20 monitor reports and
> 44 follow-up questions — that's 500. Credits reset on the 1st of each month.
>
> MCP and the REST API cost exactly the same, action for action — they run the same call over
> the same filings. MCP is the agent-native path, not the cheaper one: choose it because your
> client speaks MCP, not to save credits.
>
> Run dry early? Top up 150 credits for $14.99, any time — no subscription.

## FAQs — the portal's 5 slots

The portal has exactly five FAQ slots and they are all in use, so the five MCP questions
buyers ask are merged into slot 4, and the credit arithmetic into slot 3, rather than
displacing the report-first answers. The five questions answered one by one live in the
reply bank further down, for email.

**1. What is a Research Dossier?**

> The full write-up on a covered US-listed company — decision brief, filed trajectory,
> segments, valuation including a reverse-DCF, bull and bear case, risks. The same twelve
> sections for every company, so two or three line up side by side. Every figure carries its
> fiscal period and a link to its SEC source.

**2. What does the Filing Change Monitor do?**

> When a company files a new 10-K, 10-Q or 8-K, it reads the new document against the
> previous one of the same form and shows what changed — risk-factor edits, guidance
> language, the numbers that moved — quoted verbatim with an EDGAR link, ranked by
> materiality.

**3. How do the credits work?**

> Every tier includes every feature; tiers differ by how many reports you run each month —
> 200, 500 or 1000 credits. A Research Dossier costs 21, a Filing Monitor report 8, a
> comparison 5, a follow-up question 2. Over the API or MCP, a data lookup costs 2 and an
> AI-written answer 42, from the same wallet. Credits reset on the 1st; top up 150 for
> $14.99 any time.

**4. Are API and MCP included — on which tiers, and is there any extra fee?**

> Yes, and they are live now, not a beta. Bought on or before 22 September 2026: every
> tier includes them, permanently. Bought from 23 September 2026: the Pro tier. There is
> no add-on fee, second subscription or future payment — you create your own key and it
> spends the same monthly credits as the website. The limits are the credit wallet and 60
> requests a minute per key: Starter's 200 credits is 100 data lookups or four AI answers.

**5. Does the AI ever make up numbers, and is this investment advice?**

> No, and no. It answers from a company's actual SEC filings on EDGAR and shows the figure
> and its source so you can verify it; if the filing doesn't say it, neither does the app.
> It surfaces reported numbers for you to analyse — it does not tell you what to buy.

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

## Before this is submitted — v8 blockers

**Do not submit this listing until the wallet cutover is live in production.** The page will say
200/500/1000 per month; production meters 50/150/400 today. A buyer sold 200 credits who can only
spend 50 refunds, and every refund traced on this listing so far has been an expectation gap
rather than a product defect. The *price* is the safer half of that pair: a page priced above the
live listing loses clicks, it does not create a refund.

v7's own API/MCP blockers, still standing:

1. [x] `LTD_API_ACCESS_CUTOFF=2026-09-22T23:59:59.999Z` stored on Render 2026-09-23 09:24 UTC
   via the `set-render-env` workflow (HTTP 200, 24 characters). Render's API stored it but did
   not redeploy, so the running process could not see it; an empty commit (`3cb0c6c1`) was
   pushed to redeploy, and the cutoff took effect at 09:34 UTC. Unset, the code grants nobody
   the widening — it ships dark on purpose.
2. [ ] `node scripts/import-grandfathered-licences.js --apply`, run once. It reads the AppSumo
   Licensing API, where a licence's `created_at` is the purchase instant, and flags buyers whose
   purchase date beats their redemption date. Dry run by default; re-runnable.
3. [x] Live proof, 2026-09-23 09:34 UTC: a throwaway tier-1 AppSumo account redeemed in August got `200` from
   `/api/v1/filing/MSFT`, and the same account redeemed after the cutoff gets `402
   API_ACCESS_REQUIRED`. The probe creates and deletes its own account, key and ledger rows.

Measured when that was written (Licensing API, 25 licences): every licence sold was purchased
on or before the cutoff — 13 active, of which **9 are tier 1 or 2 and newly gain access** — and
6 are bought but unredeemed, which is exactly the case step 2 exists to catch.

### The flip — exact values, exact order

**None of this has been done.** The code half is written and deployed (V3 ships dark behind its
cutover); what remains is two env moves and one push. Both env moves need a deploy to reach the
running process — `set-render-env` stores the value but Render does not restart, so a value only
takes effect when the next deploy lands (step 1 of the v7 blockers above is the worked example).

| # | Step | What breaks if it is skipped |
|---|---|---|
| 1 | `CREDIT_ALLOWANCE_V3_EFFECTIVE_FROM=<flip instant, UTC ISO>` on Render | New buyers are metered at V2 while the page says 200 — a refund |
| 2 | `APPSUMO_TIER1_PRICE_USD=149`, `_TIER2_=299`, `_TIER3_=499` | The MFN floor keeps comparing against $39/$79/$149, so it is laxer than the marketplace it exists to guard |
| 3 | Push the prepared `appsumo-final-window` branch | /lifetime and /appsumo still advertise the old numbers, and direct checkout stays at $39.99 — which the floor then blocks the moment the listing rises |
| 4 | Verify from outside: a live `/lifetime` fetch and `/api/lifetime/config` | A deploy can report success and still not be live; the workflow's own conclusion has lied once |

**Step 1 is a future timestamp, on purpose.** The cutover is a redemption-time comparison, so
pointing it at the instant the new prices take effect grants V3 exactly from that moment and
leaves every earlier redemption on V2 — the widening is bounded rather than open-ended, and if
the listing slips, the fix is to move that one env var forward. Getting it wrong in the other
direction only over-delivers.

**Steps 2 and 3 land together, and only once AppSumo is charging the new prices.** Set early,
`/lifetime`'s gap sentence reads "the difference is 99 cents a tier" while AppSumo still sells at
$39 — understating a real $110 difference in the one direction that produces a refund. Set late,
the page keeps quoting $39 after the listing has already moved.

**What moves together in step 3** — one commit, because splitting it breaks either the MFN floor
or the page's own arithmetic:

- `backend/direct-ltd.js`: `appsumoUsd` 39 / 79 / 149 → **149 / 299 / 499**, and `directUsd`
  39.99 / 79.99 / 149.99 → **149.99 / 299.99 / 499.99** — still exactly $0.99 above, so direct
  remains strictly the dearer channel and `assertPriceFloor` keeps passing.
- `frontend-v2/appsumo.html`: three meta descriptions ("from $39"), the deal card, the deal-facts
  strip ($39/$79/$149 and 50/150/400), all three plan prices, and every per-plan credit line.
  **Also fix, in the same file:** the section intro prices a Dossier at 10 credits and a Monitor
  report at 5. The real table is 21 and 8, so the page currently overstates what a wallet buys —
  the same class of false storefront claim this file's test exists to catch.
- `frontend-v2/lifetime.html`: the meta descriptions and the JSON-LD `offers` prices. The visible
  cards need no edit — they render dynamically from `/api/lifetime/config`.
- Tests: `direct-ltd.test.js`, `direct-ltd-wiring.test.js` and `appsumo-landing.test.js` all pin
  the old literals; `credit-meter-truth.test.js` gains the listing-vs-reference price check.
- **No cache-stamp bump**, because none of it touches `assets/*.js` or `system.css`.

**Rollback.** Revert the commit and clear the two env moves; V3's cutover is the only thing that
changes an entitlement, and unsetting it returns every new redemption to V2 immediately.

## Portal field map — v8

The portal draft is **not** seeded from the live listing: any field left empty wipes the live
one. Fill every field below. The live values to fall back on are backed up verbatim in
`docs/appsumo-portal-fields-v5.md` Part 1 (in git history; the working copy was deleted).

**Plans — CHANGED, and the anchors move with them.** The compare-at fields are not optional:
$149 is *above* the current $144 anchor, so leaving them would render a negative discount.

| Tier | Price | Compare-at ("was") | Badge |
|---|---|---|---|
| Starter | **$149** | $549 | −73% |
| Investor | **$299** | $1,099 | −73% |
| Pro | **$499** | $1,849 | −73% |

These hold the −73% story the live page already tells ($39 was $144, $79 was $288) and apply it
consistently to all three — at a 73% discount the compare-at is roughly price ÷ 0.27. The live
Pro anchor was only 2.9× its price ($149 was $432, −66%), so Pro's badge was already the weakest
of the three; this flattens them. If the owner would rather preserve each tier's *current* ratio
than flatten it, that instead gives $550 / $1,090 / $1,447 and a −66% badge on Pro — decide
before submitting, not after.

**Product title** — *Product title* above. **Tagline** — *Tagline* above.

**Feature matrix — tier-varying rows first.** Entered in the portal draft directly (see Sequence):

1. `<b>200/mo</b> · <b>500/mo</b> · <b>1000/mo</b> AI credits — a Research Dossier costs 21, a Filing Monitor report 8, a comparison 5, a follow-up question 2`
2. `<b>1 company</b> · <b>4 companies</b> · <b>8 companies</b> watched by the Filing Change Monitor`
3. `API + MCP access for your AI assistant — Pro tier (every tier for purchases on or before 22 Sep 2026)`
4. `Research Dossier — the full report on any covered US stock, every figure cited to its SEC filing`
5. `Filing Change Monitor — what changed in each new 10-K, 10-Q or 8-K, quoted verbatim with EDGAR links`
6. `Up to 19 years of filed statements — on every tier`
7. `Deep-dive pages for 6,000+ US stocks`
8. `17 stock screeners + custom filters`
9. `Side-by-side compare + portfolio tracking`

If the editor caps rows, keep 1–5 and drop from the bottom.

**Long description** — paste *Opening* through *Ask, in one line* (sections 1–4 and the FAQ
block excluded — FAQs have their own fields), then the Proof block, Limits and the Integrity
note. Or paste the generated `appsumo-listing-v8.txt`, which is exactly the buyer-facing text.

**FAQs** — the five slots in *FAQs — the portal's 5 slots*, in that order.

**Attributes** — Deal type **Software** (not an AI Skill). Category **Finance & Accounting** /
**Investing & Crypto**. Best for, Alternative to and tags: see *Classification* above.

### What is live right now (read 2026-09-25)

**This replaces a 2026-09-23 note that said the live page was still the v4-era spec** — tiers
selling "AI Ask 30/100/300 per month" with no credits, no Monitor ladder, no Dossier row and no
API/MCP. Read from the public page on 2026-09-25, the live listing carries:

- **$39** (was $144, −73%) Starter — 50 credits/month, 1 Monitor company
- **$79** (was $288, −73%) Investor — 150/month, 4 companies
- **$149** (was $432) Pro — 400/month, 8 companies
- the per-action costs (Dossier 21, Monitor 8, compare 5, ask 2) and the 150-credit top-up at $14.99
- the API + MCP row with the two-population 22 September wording

So the live page already carries v7's *substance*, which means v8's price and wallet rows are the
only genuinely new content here — everything else has been on the page since some point after that
9/23 note. Re-read the page before submitting anyway. It changes nothing about the process: the
portal draft is still not seeded from live and an empty field still wipes the live one, so every
field in the map above is filled again regardless.

### Sequence — the process changed on 14 September

Yena (covering for William) consolidated every thread into *"StockPortfolio.pro — final-period
promotion and deal-end confirmation"* and set the process:

- **You edit the Partner Portal draft yourself.** AppSumo no longer uploads copy or tier specs by
  email — the portal now carries that, tier fields included.
- **The draft reflects your original submission, not the live page.** Every field below must be
  filled or the live one is replaced with stale or empty text.
- **Founder FAQs and product-update posts are NOT part of the draft** — they are edited in their
  own place and are never overwritten by a submission.

1. Edit every draft field against *Portal field map — v7* above.
2. Replace the five founder FAQs with *FAQs — the portal's 5 slots* (separate editor).
3. Submit. Reply in Yena's thread that it is submitted — she approves same day. A Gmail draft of
   that reply is waiting.
4. Post the product update below.
5. Compare the live page against this map and flag anything lost.

The deal closes permanently on **4 October** (LTD sunset; subscription-only after). The
"Pro tier from 23 September" rule therefore governs an eleven-day window — which is exactly why
it has to be on the page rather than discovered after purchase.

### Product-update post — for existing buyers

This is the only channel that reaches the Starter and Investor buyers who just gained access.

> **API and MCP access is now included on your tier.**
>
> If you bought StockPortfolio.pro on or before 22 September, API and MCP access is now part of
> your lifetime deal on whichever tier you hold — Starter and Investor included. Nothing to buy
> and nothing to upgrade.
>
> Create a key from your account page and point Claude, ChatGPT or your own agent at the hosted
> MCP endpoint, or call the REST API directly. Every figure comes back with the SEC filing it
> came from. It spends the same monthly credits as the website: 2 per data lookup, 42 per
> AI-written answer.
>
> Setup guide: stockportfolio.pro/docs/api-mcp

## Reply bank — the five MCP questions, verbatim

For email, when a buyer asks these one by one. Same facts as FAQ slots 3 and 4.

1. **Permanently included?** Yes, if you purchase on or before 22 September 2026: part of your
   lifetime entitlement on whichever tier you bought, it does not expire, and it is re-checked on
   every call — so it also stops immediately if a licence is refunded. From 23 September 2026 it
   is included on the Pro tier.
2. **Which tiers?** On or before 22 September 2026: Starter, Investor and Pro. From 23 September
   2026: Pro only. Nobody loses what they already bought.
3. **Any subscription, add-on or future payment?** No. You generate your own key from your
   account page; it authenticates both the REST API and the hosted MCP endpoint. The $14.99 top-up
   is optional, for *more* usage — never required to keep access.
4. **Limits?** The credit wallet you already have — 200, 500 or 1000 a month — spent identically on
   MCP and REST: 2 per data lookup, 42 per AI-written answer. Starter's 200 is 100 lookups or four AI
   answers. Plus 60 requests a minute per key.
5. **Beta — keep it afterwards?** It is live in production, not a beta or a waitlist; there is
   nothing to re-qualify for. Seven tools today: financials, filing timeline, compare, screen,
   fund data, ask and health.

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
the prices *on that date*; the ask has since been repriced to 42 (see Numbers verified below). The key was minted
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

### The two-population rule has to stay visible

v6 gated Section 3 to the Pro tier in its heading. v7 cannot, because it is true on every
tier for buyers from on or before 22 September — so the **first line of Section 3, the tier
table's footnote, feature-matrix row 3 and FAQ slot 4** each state both halves of the rule.
A Starter buyer from 23 September who reads Section 3 and then hits a `402` is a refund, and
refunds on this listing have already been traced to expectation gaps, not product defects.

### Numbers verified this session (2026-09-23; wallet row re-derived 2026-09-25)

Against `backend/credits.js`: `LTD_CREDIT_ALLOWANCE_V3 = {1:200, 2:500, 3:1000}` for redemptions
on or after the V3 cutover, `LTD_CREDIT_ALLOWANCE_V2 = {1:50, 2:150, 3:400}` for the round before
it, and `LTD_CREDIT_ALLOWANCE = {1:100, 2:300, 3:800}` underneath both. `COST = {ask:2, monitor:8,
dossier_standard:21, dossier_compare:5, mcp_lookup:2, api_lookup:2, mcp_ask:42, api_ask:42}`. MCP
and REST are priced identically — the old "REST is 2× MCP" rule was retired on 22–23 September.
`credit-meter-truth.test.js` fails the build if the tables above drift from those values, if the
ladder ever stops rewarding the higher tiers, or if the paste-ready .txt goes stale.

Two rows are derived and the test computes them rather than trusting the copy: at 21 credits a
Dossier the wallet is **9 / 23 / 47** dossiers, and at 8 a Monitor report it is **25 / 62 / 125**.
The "heavy Investor month" line (12 + 20 + 44 = 500) is asserted to total the Investor wallet.

`frontend-v2/appsumo.html` publishes the OLD numbers today (39/79/149 and 50/150/400) and moves
with the flip. That lag is deliberate: a page advertising 200 credits while production meters 50
is exactly the false storefront claim this test file exists to prevent.

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
- [x] `STRIPE_PRICE_ID_CREDITS_TOPUP` set on Render via the `set-render-env` workflow, so the
      top-up line is now in Section 4 and FAQ slot 3.
- [ ] **Decide the anchor** in *Portal field map — v8*: flatten every tier to −73%
      ($549 / $1,099 / $1,849), or keep each tier's current ratio ($550 / $1,090 / $1,447, Pro
      badge −66%). Then enter v8 in the portal draft field by field and replace the founder FAQs.
- [ ] **Set `CREDIT_ALLOWANCE_V3_EFFECTIVE_FROM`** to the instant the new prices are meant to take
      effect — before submitting, not after. It needs a deploy to reach the running process.
- [ ] **After AppSumo shows the new prices**: set the three `APPSUMO_TIER*_PRICE_USD` vars and push
      the prepared `appsumo-final-window` branch (direct prices, site copy, test literals) — then
      verify `/lifetime` from outside.
- [ ] **Submit**, then send the waiting Gmail reply to Yena. She approves same day.
- [ ] Post the product update for existing buyers — only if the v7 API/MCP post has not gone out.
      This repricing gives an existing buyer nothing new, so there is no v8 equivalent to send.
- [ ] Clear the remaining API/MCP blocker (the grandfathered-licence importer) before submitting.
- [ ] Do **not** touch listing versions in the portal.

## What changed vs v7

| | v7 | v8 |
|---|---|---|
| Prices | $39 / $79 / $149 | $149 / $299 / $499 |
| Compare-at anchors | $144 / $288 / $432 (−73% / −73% / −66%) | $549 / $1,099 / $1,849, all −73% |
| Monthly wallet | 50 / 150 / 400 (V2) | 200 / 500 / 1000 (V3) |
| Derived rows | 2/7/19 dossiers, 6/18/50 monitor reports | 9/23/47 dossiers, 25/62/125 monitor reports |
| "Credits buy" example | 4 + 6 + 9 = 150 | 12 + 20 + 44 = 500 |
| Pro's per-credit price | $0.37 (best of three) | $0.50 (best of three) |
| Monitor ladder, API rule, cost table, copy, classification | — | unchanged |
| New tier-table line | — | the per-credit line, so the Pro recommendation is checkable |

**Nobody is narrowed by v8.** The wallet strictly widens on every tier, so there is no grandfather
clause and nothing for AppSumo to approve; the price rise reaches only buyers who have not
purchased yet. Existing accounts keep the tier, the price and the wallet they already have.

## What changed vs v6

| | v6 | v7 |
|---|---|---|
| API + MCP | Pro tier only, "Pro tier" in the Section 3 heading | every tier bought on or before 22 Sep 2026; Pro from 23 Sep |
| Tier table API row | — / — / included | included\* / included\* / included, footnoted |
| MCP vs REST price | MCP lookup 1, REST lookup 2 (MCP "half the price") | both 2 — priced identically |
| Cost table | eight rows, MCP and REST separately | six — one lookup row and one AI row, "MCP or REST" |
| Top-up | held back | in Section 4 and FAQ slot 3 — the price ID is set |
| FAQ | none in the listing text | the portal's 5 slots, MCP questions merged into slot 4 |
| Portal map | lived in the v5 field doc | *Portal field map — v7*, with a nine-row feature matrix |

**Nobody is narrowed by v7.** The only price that rose — the MCP lookup, 1 → 2 — had never been
paid by a customer: the production ledger held no customer rows on either surface at the time.

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
