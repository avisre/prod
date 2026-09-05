# AppSumo portal draft — every field, paste-ready (listing v5)

Captured from the live listing 2026-09-06. **Part 1 is a verbatim backup**: William warned
the draft is not seeded from the live page and that submitting "will overwrite the entire
page content wise," so anything missing from the draft is lost. Part 2 is what to paste.

Machine-readable snapshot of the whole live deal object: re-fetch any time with the
`__NEXT_DATA__` blob on `appsumo.com/products/stockportfoliopro/`.

---

# PART 1 — what is live right now (restore from this if a field is blanked)

## Plans
| Tier | Public name | Price | Original |
|---|---|---|---|
| 1 | Starter | $39 | $144 |
| 2 | Investor | $79 | $288 |
| 3 | Pro | $149 | $432 |

## Feature matrix — 4 rows, and the problem in one glance
1. `<b>30/mo</b> · <b>100/mo</b> · <b>300/mo</b> AI Ask - grounded answers from SEC filings (per month)`
2. `Deep-dive pages for 6,000+ US stocks` (all tiers)
3. `17 stock screeners + custom filters` (all tiers)
4. `Side-by-side compare + portfolio tracking` (all tiers)

**There is no Research Dossier row and no Filing Change Monitor row.** The only thing that
varies by tier is the Ask count. The two features customers say are the product do not
appear in the table a buyer scans before choosing a tier — and the tier ladder we describe
everywhere else (Monitor 1/4/8) is invisible here.

## Attributes / taxonomy
- Group: **Operations**
- Category: **Finance & Accounting** · Sub category: **Investing & Crypto**
- Deal type: **Software** ← keep, do not let this become an AI Skill
- Best for: **Small businesses · Solopreneurs · Businesses**

## FAQs (verbatim — re-enter if the draft blanks them)
1. **Does the AI ever make up numbers?** — No - by design. It only answers from a company's actual SEC filings (10-K/10-Q on EDGAR), and shows the figure so you can verify it. If the filing doesn't say it, neither does the app.
2. **Which companies are covered?** — 6,000+ US-listed stocks, each with a deep-dive page - revenue, margins, free cash flow, ROE and valuation history - built from filed fundamentals and recomputed nightly.
3. **What can I do besides ask questions?** — Run 17 prebuilt screeners plus custom filters, compare any two companies side by side, and track a portfolio with alerts.
4. **Where does the data come from?** — Straight from SEC EDGAR - the same 10-K and 10-Q filings companies are required to publish. It refreshes as new filings come in.
5. **Is this investment advice?** — No. It surfaces real reported numbers and lets you analyze them; it doesn't tell you what to buy. Always do your own due diligence.

## Media currently on the page — opened and identified 2026-09-06

**Banner/hero is a SEPARATE field from the product images.** `media_url` and
`featured_image_url` both point at AppSumo's generic `appsumo-hero-16x9.jpg`, and
`banner_details` is empty — there is no custom banner to lose. `product_logo` is our own
PNG. Replacing the product images below touches neither.

The four product images, all 1920x1080, all screenshots — **three of the four show the
free logged-out pages, not the paid product**:

| # | File | What it actually shows |
|---|---|---|
| 1 | `f028e56e…` | **Ask AI answer** — "NVIDIA ($NVDA) — Is Free Cash Flow Keeping Up with Capex?" Signed-in product, but it is the chat, i.e. the exact framing v5 moves away from |
| 2 | `8403e1e4…` | Public screener page, "Stocks With the Highest Free Cash Flow (2026)" — **free, no account** |
| 3 | `a7e641bc…` | Public stock page, "NVIDIA Corporation (NVDA) Stock Analysis" — **free, no account** |
| 4 | `55423dd3…` | Public comparison page, "AAPL vs MSFT: Which Stock Is the Better Buy?" — **free, no account** |

So a buyer evaluating the deal sees one chat answer and three pages they can already use
without paying. Neither the Research Dossier nor the Filing Change Monitor — the two
things the tiers are actually sold on — appears anywhere in the image set.

## Other live state (not editable content, do not lose sight of it)
- **18 purchases**, 2 reviews at 5.0, 5 product-update posts, 60-day refundable, Radar/Labs.

---

# PART 2 — paste this

## Product title
```
StockPortfolio.pro — SEC research dossiers and filing-change reports
```

## Tagline / short description
```
The analyst report on any US stock, written for you — then kept current every time the company files.
```

## Feature matrix — replace all four rows with these
Tier-varying rows first; they are what a buyer compares.

1. `<b>100/mo</b> · <b>300/mo</b> · <b>800/mo</b> AI credits — a Research Dossier costs 10, a Filing Monitor report 5, a comparison 5, a follow-up question 2`
2. `<b>1 company</b> · <b>4 companies</b> · <b>8 companies</b> watched by the Filing Change Monitor`
3. `Research Dossier — the full report on any covered US stock, every figure cited to its SEC filing`
4. `Filing Change Monitor — what changed in each new 10-K, 10-Q or 8-K, quoted verbatim with EDGAR links`
5. `Up to 19 years of filed statements — on every tier`
6. `Deep-dive pages for 6,000+ US stocks`
7. `17 stock screeners + custom filters`
8. `Side-by-side compare + portfolio tracking`

If the editor caps the number of rows, keep 1–4 and drop from the bottom.

## Long description
Paste sections *Opening* → *Ask* from `docs/growth/appsumo-listing-v5.md`, then the Proof
block, the Limits paragraph and the Integrity note. Do not paste the internal sections.

**Omit both of these** — production cannot honour them yet:
- the `$14.99 / 150 credits` top-up line (`STRIPE_PRICE_ID_CREDITS_TOPUP` unset on Render)
- any Deep Dossier price (`?depth=deep` is URL-only; no buyer can invoke it)

## FAQs — 5 slots, report-first
1. **What is a Research Dossier?**
   The full write-up on a covered US-listed company — decision brief, filed trajectory, segments, valuation including a reverse-DCF, bull and bear case, risks. The same twelve sections for every company, so two or three line up side by side. Every figure carries its fiscal period and a link to its SEC source.
2. **What does the Filing Change Monitor do?**
   When a company files a new 10-K, 10-Q or 8-K, it reads the new document against the previous one of the same form and shows what changed — risk-factor edits, guidance language, the numbers that moved — quoted verbatim with an EDGAR link, ranked by materiality.
3. **How do the credits work?**
   Every tier includes every feature; tiers differ by how many reports you run each month. A Research Dossier costs 10 credits, a Filing Monitor report 5, a comparison 5, and a follow-up question 2. Starter's 100 credits is 10 dossiers or 20 filing reports a month. Credits reset on the 1st.
4. **Does the AI ever make up numbers?**
   No — by design. It answers from a company's actual SEC filings (10-K/10-Q on EDGAR) and shows the figure so you can verify it. If the filing doesn't say it, neither does the app.
5. **Where does the data come from, and is this investment advice?**
   Straight from SEC EDGAR — the same filings companies are required to publish, refreshed as new ones land. It is not investment advice: it surfaces real reported numbers and lets you analyse them. Always do your own due diligence.

## Attributes
- Deal type: **Software** — unchanged, this is a hosted research app, not an AI Skill
- Category **Finance & Accounting** / Sub category **Investing & Crypto** — unchanged
- Best for: **William's side** — Individual investors / Finance researchers / Financial
  analysts (custom values; he offered this on 31 Aug). Remove Small businesses and Businesses.
- Group is currently **Operations**. If a better group exists, move it; if not, leave it.

## Media
Hero/banner unchanged. Product images in this order:
1. `01-dossier-nvda-decision-brief.png`
2. `02-dossier-nvda-financial-trajectory.png`
3. `03-filing-change-monitor-nvda.png`

(Local, gitignored: `marketing/campaign-2026-08-appsumo-sprint/assets/`. Nav in them reads
"Ask AI" where the product now says "Research" — owner decided 2026-09-06 to ship as-is.)

## Left to William
- The **"Uses AI: No"** flag.
- Custom **Best for** values.
- **Alternative to**: drop Bloomberg Terminal, keep Koyfin and SeekingAlpha.

---

## Sequence — do not deviate

1. **Wait for William's answer on what the overwrite covers.** Asked 2026-09-06. If FAQs
   and images live outside the version, we need to know before submitting, not after.
2. Edit every field in the draft against Part 2. Anything not in Part 2, restore from Part 1.
3. Submit in the portal.
4. Email William that it is submitted — he approves it onto the live page.
5. Compare the live page against Part 1 and flag anything lost.

The listing must stay **live and transactable through 4 October** (90-day Radar minimum).
