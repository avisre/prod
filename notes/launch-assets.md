# AppSumo launch assets — source-backed campaign

Status: **current as of 26 July 2026**.

This replaces the earlier portfolio-first `£7/month` / `£70/year` founding campaign. That positioning described an older version of the product and must not be reused in current posts, DMs, directory listings, screenshots, or price comparisons. The useful idea retained from that campaign is the calm, no-broker-credentials portfolio workflow; it is now supporting proof rather than the headline.

## Campaign destination

Use the dedicated bridge page with a server-allowlisted source. The server
rewrites the page's fixed AppSumo CTA to the same channel before setting the
first-party attribution cookie:

```text
https://www.stockportfolio.pro/appsumo?source=<x|linkedin|reddit|stocktwits|creator|email>
```

Examples:

- X post or reply: `https://www.stockportfolio.pro/appsumo?source=x`
- Creator DM: `https://www.stockportfolio.pro/appsumo?source=creator`
- Customer email: `https://www.stockportfolio.pro/appsumo?source=email`

Plain `/appsumo` uses `/go/appsumo/bridge`; an attributed page uses the
matching `/go/appsumo/<source>` path. Every one still resolves to the single
server-configured AppSumo destination. Do not replace it with a Stripe or
registration link during the AppSumo campaign.

## Positioning hierarchy

1. **Problem:** general AI can return plausible financial figures without a dependable audit trail.
2. **Promise:** ask a US-stock question and inspect the reported figure, fiscal period, calculation, and source used in the answer.
3. **Workflow:** Ask + filed fundamentals + screeners + company comparison + portfolio context.
4. **Offer:** AppSumo lifetime access from `$39`, with a monthly Ask allowance.
5. **Trust:** company fundamentals, fund data, and current web sources are labelled separately; no AI system is presented as infallible.

## One-liners

- Ask a stock question. Inspect the filed number, period, and source.
- AI-assisted stock research with an evidence trail, not an answer from model memory.
- Source-aware research for US stocks and funds — lifetime access on AppSumo from $39.
- Research the company. Open the source. Make up your own mind.

## Short description (150–180 characters)

Ask questions about US stocks and inspect the filed figures, periods, and sources behind each answer. Lifetime access on AppSumo from $39.

## Long description (directory / partner copy)

StockPortfolio.pro is a source-aware research workspace for US stocks, ETFs, and mutual funds. Reported company fundamentals are derived from supported SEC filings and retain their fiscal context; fund answers use labelled fund data, while current claims can use dated live-web sources. Use Ask, 17 screeners, company comparison, and portfolio tracking in one workflow. The AppSumo lifetime deal currently starts at $39 with 30 Ask questions per month.

## Exact current AppSumo offer

Checked against the live listing on 26 July 2026:

| Tier | One-time price | Ask allowance | Plain-language fit |
|---|---:|---:|---|
| Starter | $39 | 30/month | Occasional company checks and a focused weekly review |
| Investor | $79 | 100/month | Active DIY investor researching several holdings each week |
| Pro | $149 | 300/month | High-volume researcher who expects to use Ask most days |

The live listing describes the core deep-dive, 17-screeners, custom-filter, comparison, and portfolio features across all tiers. AppSumo controls the final inclusions, activation window, refund eligibility, and deal availability; check the listing before publishing dated terms.

## Coverage language to use

- **AppSumo deep dives:** the live deal lists 6,000+ US stock deep-dive pages. Available history and metrics vary by issuer and supported data.
- **Free screener:** 3,800+ US companies with available filed-fundamental filters.
- **Public research library:** 1,500+ browsable public company pages.
- **Statement depth:** up to 19 annual years and 48 quarters for covered US-listed companies that report in USD; newer or incomplete histories have less.
- **Funds:** ETFs and mutual funds use fund-specific costs, holdings, allocation, risk, and reported-performance data. Do not describe those facts as company SEC fundamentals.
- **Current information:** post-filing questions can use dated live-web sources, labelled separately.

## Feature bullets (pick 3–5)

- Ask company questions with the reported period and source context shown.
- Screen 3,800+ US companies by available filed fundamentals for free.
- Compare two companies across supported statement history and common ratios.
- Research stocks, ETFs, and mutual funds with asset-appropriate data.
- Track a mixed portfolio without providing broker credentials.
- Prepare source-aware research for sharing, then verify it before publishing.

## Trust copy

- No AI system is infallible. Inspect the cited source before making a material decision.
- Company fundamentals, fund-market data, and dated live-web sources are identified separately.
- No broker credentials are required; holdings can be entered manually.
- Informational research only — not investment advice, execution, or guaranteed picks.
- Monthly Ask allowances are explicit so the lifetime AI component is not described as unlimited.

## Do not say

- “The AI cannot hallucinate.”
- “Every number on screen comes from an SEC filing.”
- “Every US-listed company has 19 years of data.”
- “Real-time institutional data” or “Bloomberg replacement.”
- “Unlimited AI.”
- “Guaranteed accurate,” “guaranteed returns,” “winning stocks,” or personalized buy/sell language.
- “60-day refund guaranteed” without checking AppSumo’s current eligibility and redemption rules.
- Any outdated `£7`, `£70`, `/founding`, or subscription-first campaign copy.

## X posts — ready to tailor

### Post 1 — the problem

```text
The dangerous thing about a wrong financial number from AI is how plausible it looks.

I built StockPortfolio.pro around a stricter workflow:
• retrieve the company data
• keep the fiscal period attached
• show the source
• say when the evidence is missing

Lifetime access is on AppSumo from $39:
[CAMPAIGN URL]
```

### Post 2 — show one research job

```text
Question: Did NVIDIA's free cash flow keep up with capex?

The useful answer is not a confident paragraph. It is the filed figures by period, the calculation, and a source you can open.

That evidence trail is the core of StockPortfolio.pro.

See the 60-second product flow + AppSumo deal:
[CAMPAIGN URL]
```

Only publish the named example after checking that the linked demo currently shows the stated question and evidence.

### Post 3 — tier clarity

```text
StockPortfolio.pro is now on AppSumo as a lifetime deal:

$39 → 30 Ask questions/month
$79 → 100/month
$149 → 300/month

All three list the core research workspace: deep dives, 17 screeners, compare, and portfolio tracking.

Choose by research volume:
[CAMPAIGN URL]
```

### Post 4 — fit / not fit

```text
StockPortfolio.pro is for fundamental investors who want to inspect the source behind an AI-assisted answer.

It is not a trading terminal, broker, stock-pick service, or substitute for checking the filing.

If that narrower workflow sounds right, the AppSumo lifetime deal starts at $39:
[CAMPAIGN URL]
```

### Post 5 — fund support without source confusion

```text
Stocks and funds should not be analysed as if they were the same object.

In StockPortfolio.pro:
• company fundamentals use supported SEC filings
• ETF / mutual-fund research uses costs, holdings, allocation, risk, and reported performance
• the source type stays visible

[CAMPAIGN URL]
```

### Post 6 — founder build-in-public update

```text
What changed in StockPortfolio.pro this week:
1. [specific shipped improvement]
2. [specific bug fixed]
3. [specific buyer request addressed]

I am building this as a solo founder and publishing the limits as clearly as the features.

AppSumo lifetime deal:
[CAMPAIGN URL]
```

Never invent a weekly update. Replace every bracket with a shipped, verifiable item.

## Helpful public replies

Use these only when the post actually raises the problem. Lead with the answer; mention the product after helping.

```text
For reported company figures, I would open the 10-K/10-Q and check the fiscal period before comparing the number. A lot of apparent contradictions are annual vs quarterly or GAAP vs adjusted. I built a tool around keeping that context attached; happy to share it if useful.
```

```text
One useful test for any AI stock answer: can you open the source, identify the period, and reproduce the calculation? If not, treat it as a lead rather than evidence. That verification workflow is exactly what I am working on in StockPortfolio.pro.
```

## Founder DMs

Personalize the first sentence with the person’s actual post, ticker, workflow, or tool. Do not bulk-send unchanged text.

### DIY investor

```text
Saw your post about checking [company / metric] across filings. I built StockPortfolio.pro for that exact research step: ask the question, then inspect the reported period and source behind the answer. I can send the 60-second demo and AppSumo lifetime deal if that would be useful.
```

### Finance writer / creator

```text
Your [specific thread/newsletter] made me think you may care about the audit trail behind financial figures. StockPortfolio.pro keeps company periods and filing context attached to AI-assisted research, then prepares the result for sharing. Want the demo link?
```

### Follow-up (once, after 48–72 hours)

```text
One quick follow-up in case the research workflow is relevant: [CAMPAIGN URL]. No pressure if it is not a fit — I would still value one blunt objection after you see the page.
```

## Honest-review request for verified AppSumo buyers

Do not offer credits, upgrades, gifts, refunds, or any other incentive.

```text
Hi [first name] — you have had a little time with StockPortfolio.pro now. If anything is unclear or broken, reply and I will help first. If you have used it enough to form an opinion, would you leave an honest AppSumo review? Specific feedback about the question you researched, the source trail, and what still needs work will help other buyers decide whether it fits them: https://appsumo.com/products/stockportfoliopro/#reviews
```

## Objection replies

### “Why not just use ChatGPT?”

```text
General AI is broader. StockPortfolio.pro is narrower: supported company fundamentals, filing periods, screeners, comparisons, and saved portfolio context are already part of the workflow. You should still open the source; the product is designed to make that check easier.
```

### “Can it still be wrong?”

```text
Yes. No AI or extraction pipeline is infallible. The difference is that the period and source are exposed so you can verify a material claim instead of trusting a confident answer blindly.
```

### “Why does one page say 6,000+, another 3,800+, and another 1,500+?”

```text
They are different surfaces: the AppSumo deal lists 6,000+ deep-dive pages, the free screener covers 3,800+ companies, and the public browseable library has 1,500+ pages. Filing depth varies by issuer and availability.
```

### “Will lifetime AI be sustainable?”

```text
The deal does not describe AI as unlimited. Each tier has an explicit monthly Ask allowance — 30, 100, or 300 — while the core research workspace remains available under the deal terms. Check the live listing for the final commitment.
```

### “Does it connect to my broker?”

```text
No broker credentials are required. Holdings are added manually. That is a good fit for people who prefer separation and a poor fit for anyone who requires automatic account aggregation.
```
