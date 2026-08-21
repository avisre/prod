# StockPortfolio.pro customer forensics

Snapshot: 21 August 2026. All customer labels are audit-only pseudonyms. No email address, licence code, payment identifier, prompt, portfolio holding, or raw user identifier is included.

## Cohort and limits

- Nine real AppSumo orders exist in the authenticated Partner Portal: $801 gross GMV, $88.58 discounts, $183.97 partner revenue, and zero refunds through 20 August.
- Seven orders have been redeemed into active accounts. Two have not: the 22 July Tier 3 order and the 20 August Tier 2 order. The latter is too recent to call abandonment.
- One additional AppSumo QA redemption is excluded. Five owner/developer/internal accounts are excluded from the registered-nonbuyer comparison.
- AppSumo checkout happens before StockPortfolio signup/redemption. Six of seven redeemed buyers predate durable browser attribution, so the product cannot reconstruct what persuaded them before the external purchase.
- Missing telemetry is `UNKNOWN` or `NA`, not zero. Page counts below are lower bounds.

## What the cohort actually proves

The only purchase channel proven to have produced money is AppSumo. Discovery is high-confidence for only one buyer, who explicitly said they found the lifetime deal on AppSumo before buying Tier 3. Discovery for the other eight orders is unknown: the portal’s “existing AppSumo buyer” field describes the buyer’s AppSumo status, not whether AppSumo internal discovery or a founder link caused the sale.

Post-purchase, completed Ask is the strongest observed value action: six of seven redeemed buyers made 76 completed Ask calls. Every redeemed Tier 2/3 buyer used Ask. Usage is highly skewed: one Tier 3 buyer produced 54 calls and the top two buyers produced 67 of 76. That is an activation/retention signal, not evidence that Ask caused the purchase.

## Timeline: CUSTOMER-01

- Discovery: `UNKNOWN`
- Attribution confidence: `UNKNOWN`
- First touch and landing page: `UNKNOWN`
- Purchase: 20 July, AppSumo Investor/Tier 2, $79 gross, $16.35 partner revenue
- Signup/redemption: 21 July, approximately four minutes from account setup to redemption
- Pre-purchase journey: `UNKNOWN`; purchase occurred outside StockPortfolio before signup
- Post-purchase activity: 13 completed Ask calls, screener activation, portfolio activation, two stored alert documents
- Active days / last activity: 3 / 13 August
- Most-used feature: Ask
- Most-used page family: `UNKNOWN` because page identity is unavailable
- Current engagement: `ACTIVE` at snapshot
- Likely JTBD: source-backed company research combined with portfolio/screening work
- Confidence: medium; action is observed, purchase motive is not

## Timeline: CUSTOMER-02

- Discovery: `UNKNOWN`
- Attribution confidence: `UNKNOWN`
- Purchase: 22 July, AppSumo Pro/Tier 3, $149 gross, $31.52 partner revenue
- Signup/redemption: none
- Pre-purchase and post-purchase journey: `UNKNOWN` / no product account
- Current engagement: `BOUGHT AND NEVER ACTIVATED`
- Likely JTBD: `UNKNOWN`; a future-use LTD purchase is possible but unproved
- Important clue: this is a real revenue event without product activation, so purchase is not product-market fit

## Timeline: CUSTOMER-03

- Discovery and landing page: `UNKNOWN`
- Attribution confidence: `UNKNOWN`
- Purchase/redemption: 24 July, AppSumo Pro/Tier 3, $149 gross, $36.24 partner revenue; redemption about seven minutes after account setup
- Pre-purchase journey: `UNKNOWN`
- Post-purchase activity: two completed Ask calls, one company summary, 25 stored alert documents
- Active days / last activity: 3 / 12 August
- Most-used feature: monitoring objects by count; Ask by verified user action
- Current engagement: `ACTIVE` at snapshot
- Likely JTBD: ask questions, then keep companies under monitoring
- Confidence: medium; stored alerts do not prove alerts were opened or valued

## Timeline: CUSTOMER-04

- Discovery and landing page: `UNKNOWN`
- Attribution confidence: `UNKNOWN`
- Purchase/redemption: 2 August, AppSumo Investor/Tier 2, $79 gross, $17.34 partner revenue; redemption about 3 hours 22 minutes after purchase/account flow
- Pre-purchase journey: `UNKNOWN`
- Post-purchase activity: 15 attributable page views—portfolio 5, company 4, home 3, and tools/news/guru one each—plus three Ask calls and 16 stored alerts
- Active days / last activity: 2 / 3 August
- Most-used feature/page: portfolio page
- Current engagement: `LIGHT`
- Likely JTBD: examine holdings and companies, then ask focused questions
- Confidence: medium

## Timeline: CUSTOMER-05

- Discovery: AppSumo lifetime deal, explicitly stated in a presale email
- Attribution confidence: `HIGH`
- First product landing: home
- Pre-purchase journey: home → dossier → home → dossier → home
- Last meaningful action before purchase: dossier view
- Purchase/redemption: 4 August, AppSumo Pro/Tier 3, $149 gross, $35.95 partner revenue; redemption about 1.5 minutes after account setup
- Post-purchase activity: 54 completed Ask calls and two summaries across five AI-use days; company 9 views; Ask 2; compare, tools, screener, news and home one each
- Active days / last activity: 5 / 20 August
- Most-used feature: Ask
- Most-used page family: company research
- Current engagement: `ACTIVE`
- Likely JTBD: repeated source-backed company research
- Confidence: high for discovery and behavior, medium for motive
- Important clue: this is the only observed product journey before purchase and the strongest retained user, but one person cannot establish dossier as the causal aha moment

## Timeline: CUSTOMER-06

- Discovery and pre-purchase journey: `UNKNOWN`
- Attribution confidence: `UNKNOWN`
- Purchase/redemption: 4 August, AppSumo Starter/Tier 1, $39 gross, $9.43 partner revenue; redemption about one minute after account setup
- Post-purchase activity: 27 page views—home 9, portfolio/company 4 each, tools/guru 2 each, and screener, stocks/funds, news, dossier and filings one each—plus one NVDA summary and no completed Ask
- Active days / last activity: 2 / 5 August
- Most-used page: home, then portfolio/company
- Current engagement: `LIGHT`
- Likely JTBD: broad product exploration; sustained job is unproved
- Confidence: low
- Important clue: breadth without a completed Ask did not produce visible continued activity after the next day

## Timeline: CUSTOMER-07

- Discovery and pre-purchase journey: `UNKNOWN`
- Attribution confidence: `UNKNOWN`
- Purchase/redemption: 5 August, AppSumo Starter/Tier 1, $39 gross, $8.87 partner revenue; redemption about 28 minutes after account setup
- Post-purchase activity: two Ask calls, one AAPL summary, one research share; home 3, company/guru/portfolio 2 each, tools/dossier/screener one each
- Active days / last activity: 3 / 8 August
- Most-used feature/page: light Ask; home and company/portfolio exploration
- Current engagement: `ACTIVE` under a 14-day snapshot rule, but usage is light
- Likely JTBD: concise company research with a shareable output
- Confidence: medium

## Timeline: CUSTOMER-08

- Discovery: `UNKNOWN`; acquisition flow is contaminated by an internal/QA-like flag and cannot be used for channel attribution
- Purchase/redemption: 14 August, AppSumo Starter/Tier 1, $39 gross, $9.22 partner revenue; redemption about six minutes after account setup
- Pre-purchase journey: `UNKNOWN`
- Post-purchase activity: two Ask calls, two briefings, two stored alerts, 15 free-tool completions and Ask/portfolio/screener/comparison activation. Thirteen completions were buybacks-versus-dilution and two revenue-consistency. The observed ticker was SEZL.
- Active days / last activity: 1 / 14 August
- Current engagement: `LIGHT`
- Likely JTBD: support-assisted, multi-workflow company research
- Confidence: medium
- Important clue: the user explicitly rated the result “somewhat” useful. This is activation evidence, not a strong success outcome.

## Timeline: CUSTOMER-09

- Discovery: `UNKNOWN`
- Attribution confidence: `UNKNOWN`
- Purchase: 20 August, AppSumo Investor/Tier 2, $79 gross, $19.05 partner revenue
- Signup/redemption: none at the 21 August snapshot
- Product activity: none because the code is unredeemed
- Current engagement: `BOUGHT AND NEVER ACTIVATED`, with a critical caveat that the order is less than one day old
- Likely JTBD: `UNKNOWN`

## Buyer/nonbuyer comparison

The comparison cohort contains 29 registered nonbuyers, but only 13 have direct event linkage and none has attributable page views. Five nonbuyers have 22 stored alert documents, proving that zero linked events does not equal zero product use.

| Signal | Redeemed buyers | Registered nonbuyers | Interpretation |
|---|---:|---:|---|
| Cohort size | 7 | 29 | Tiny and incomplete |
| Completed Ask ever | 6/7 | 0 observed | Strongest observed buyer activation signal; nonbuyer denominator is coverage-limited |
| Summary/briefing ever | 5/7 | 0 observed | Same caveat |
| Stored alerts | 4/7 | 5/29 | Possible monitoring signal; documents are not confirmed opens |
| Research share | 1/7 | 0 observed | Too rare to rank |
| Two or more observed active days | 6/7 | 0 observed | Strong retention association; linkage differs by cohort |

No lift ratio is reported because exposure measurement is not comparable. Calculating a large numeric “buyer lift” would create false precision.

### Reliable feature aggregates

The table below uses the seven redeemed real buyers. “Repeat” means at least two observed uses. A zero is used only where the underlying provider/event collection had cohort-wide coverage; otherwise the value is unknown.

| Feature/action | Buyers using | Total uses | Average per redeemed buyer | Median | Repeat-use rate | Nonbuyer signal | Buyer/nonbuyer ratio |
|---|---:|---:|---:|---:|---:|---|---|
| Completed Ask | 6/7 (85.7%) | 76 | 10.86 | 2 | 6/7 (85.7%) | 0 observed among 29; only 13 have direct event linkage | Not reported; coverage differs |
| Summary/briefing | 5/7 (71.4%) | 7 | 1.00 | 1 | 2/7 (28.6%) | 0 observed; same linkage caveat | Not reported |
| Stored alerts | 4/7 (57.1%) | 45 | 6.43 | 2 | 4/7 (57.1%) | 5/29 users, 22 documents | 3.31× descriptive prevalence only |
| Free-tool completion | 1/7 (14.3%) | 15 | 2.14 | 0 | 1/7 (14.3%) | Not reliably joined | Not reported |
| Research share | 1/7 (14.3%) | 1 | 0.14 | 0 | 0/7 | 0 observed; linkage caveat | Not reported |

The 3.31× alert ratio is not a causal lift estimate: alerts may be system-generated, document counts do not prove opens, and buyer/nonbuyer event coverage differs. For metric pages, filings, screener, compare, portfolio, guru, fund/ETF and export actions, the row-level matrix preserves `NA` rather than turning missing identity linkage into zero.

## Candidate aha moment

There is no defensible pre-purchase aha moment across the cohort. Only CUSTOMER-05 has observable product page activity before buying, and that sequence repeatedly visited dossier. The strongest post-purchase activation moment is a successful cited Ask answer: six of seven redeemed buyers used Ask, while the only strongly retained buyer made 54 calls across five days.

Use the finding as: **“Ask is the best observed activation behavior.”** Do not convert it into: **“Ask caused buyers to purchase.”**

## What buyers use, return to and ignore

- Strongest feature: completed Ask, 6/7 redeemed buyers and 76 calls.
- Strongest recurring behavior: repeated Ask/company research, driven mostly by one Tier 3 buyer.
- Page leaders among the four buyers with page telemetry: company 19, home 16, portfolio 11.
- Monitoring hypothesis: 45 stored alerts across four buyers, but open/value behavior is uninstrumented.
- Underused or unproved: exports, CSV, watchlist, Filing Diff, Filing Change Monitor, Form 4, segments, API, MCP and Reality Check. For many of these, the correct statement is “no reliable buyer telemetry,” not “nobody used it.”
- Free tools are not a demonstrated acquisition bridge: the one buyer with 15 tool completions used them after purchase.

## Why this might be wrong

- Seven redeemed buyers are far too few for statistical inference.
- AppSumo LTD buyers may behave differently from subscription buyers.
- Six buyers lack durable browser identity and page attribution.
- Server-side Ask is measured better than many non-AI features, making it easier to observe.
- Stored alerts may be system-generated and do not prove active monitoring.
- One heavy Ask user distorts averages.
- Two unredeemed orders have different age: one is old; one is less than a day old.
