# Next-feature ranking

## Decision first

Do **not** start a large new feature. The highest-return product work is to make the existing source-backed Ask workflow reliably produce an inspectable answer, then make filing changes the reason to return.

Recommended positioning:

> **Know what changed. Check the evidence in the filing.**

Keep “stock research with the evidence attached” as the category description. Use “Truth Engine” only as a named workflow if it describes concrete checks; do not reposition the entire product around “we audit the story” until buyers repeatedly use and pay for that behavior.

## Required direction scorecard

Scores are 1–10 composites of observed demand, market demand, willingness to pay, revenue/customer, retention, acquisition leverage, differentiation, technical/data risk, support burden and time to ship. A high score is a prioritization aid, not a revenue forecast.

| Direction | Score | Evidence | Decision |
|---|---:|---|---|
| A. Existing source-backed Ask | 9 | 6/7 redeemed buyers; all Tier 2/3; 76 calls | **Improve and promote now** |
| B. Filing Change Monitor | 7 | Monitoring supports recurrence; four buyers have stored alerts; competitors validate category | Improve only after reliability/open-value telemetry |
| C. Truth Engine / Earnings Reality Check | 8 | Fits review’s verification concern and provenance psychology; reuses existing evidence | Package as workflow, not a large separate product |
| D. Deal-to-Dollars | 5 | Interesting research angle; no current buyer request or usage | Small content experiment only |
| E. Goalpost Detector | 6 | Change-detection fit and differentiated narrative; no direct buyer evidence | Prototype within filing-change workflow |
| F. Verified Financial API | 4 | One explicit request; strong market competition and upstream/commercial-rights risk | Interview and price-test before build |
| G. MCP | 3 | One request; crowded via Fiscal.ai, Quartr, Hudson, FMP and data vendors | Do not build now |
| H. Student/SMIF | 3 | No paying-customer evidence; budget/procurement friction | Deprioritize |
| I. Investment club edition | 4 | Possible group workflow but no verified demand | Deprioritize pending interviews |
| J. Newsletter verification | 6 | Source-checking fits analyst/newsletter workflow; relevant partner leads exist | Sell service-assisted pilot before building |
| K. IR Peer Radar | 4 | Plausible B2B ACV; no current customer behavior | Do not build before paid design partner |
| L. Guru 13F alerts | 4 | Public Q&A interest is weak; existing pages get some use | Keep, do not expand |
| M. Portfolio freshness scanner | 6 | Portfolio is the third-largest observed buyer page family; repeat-value logic is strong | Improve after Ask reliability |
| N. TradingView enrichment | 2 | One prospect is technical-first; outside current evidence/data advantage | Explicitly do not build |

## Top implementation backlog, maximum ten

| Rank | Feature | Problem solved | Current-user evidence | Behavior evidence | Market evidence | Competitor evidence | Psychology/value mechanism | Build effort | Revenue mechanism | Retention mechanism | Acquisition mechanism | Confidence | Decision |
|---:|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Reliable cited Ask activation | A user needs one useful answer they can inspect, not another opaque AI summary | 6/7 redeemed buyers used Ask; all four Tier 2/3 buyers used it; 76 completed calls | One Tier 3 buyer made 54 calls across five AI-use days; the top two buyers made 67/76 calls, so demand is real but concentrated | The one review values efficiency but still asks for cross-verification; broader willingness to pay specifically for reliability is unknown | Fiscal.ai, Marvin Labs and AlphaSense already sell AI research; cited AI alone is not unique | Reduces uncertainty and perceived error risk by pairing speed with provenance | Low–medium | Can strengthen the current 100/300-Ask higher-tier story; conversion lift is unproved | Repeated company questions can create a research habit | A question → answer → filing-source proof is the strongest demonstrable product story | High | **Improve and promote now** |
| 2 | Evidence-opening workflow | Users need to verify an answer quickly when accuracy is uncertain | The public review explicitly calls for cross-verification; no buyer-level source-open confirmation is available | Ask use is high, but source-open telemetry is missing, so evidence inspection cannot yet be tied to retention | Trust and accuracy objections appear in the review and AppSumo conversations; denominator and prevalence are unknown | BamSEC centers the original filing; Marvin Labs and AlphaSense foreground citations/source material | Provenance supplies authority, control and risk reduction | Low | May remove listing/demo trust friction; revenue effect is not measured | Fast verification can make cited research repeatable | Visible answer-to-source proof can improve demos and proof-led posts | Medium | **Improve and promote** |
| 3 | Filing-change return loop | One-time research lacks a reason to come back | Four of seven buyers have 45 stored alert documents | Alert documents exceed the five nonbuyers' 22, but alerts may be system-generated and opens/value are not tracked | One AppSumo question explicitly requests logical smart alerts; broader paid demand is unknown | BamSEC offers alerts; Marvin Labs offers scheduled/automatic research; AlphaSense sells monitoring | Uses salience and loss aversion: notify the user when evidence changes | Medium | Could support recurring Power/Desk value after willingness to pay is verified | New filings provide a natural recurring trigger | “Know what changed” is a differentiated, source-backed acquisition story | Medium | **Improve only after reliability and open/value telemetry** |
| 4 | Reality-check template inside Ask | Earnings headlines can hide cash conversion, dilution and period mismatch | Ask reaches 6/7 buyers, but no buyer explicitly requested this named template | The retained power user repeats company research; template-specific use is unmeasured | The review's verification concern supports the problem; direct market demand for this packaging is unknown | Generic cited AI is crowded; filing comparison exists in BamSEC/AlphaSense, so differentiation depends on the check itself | Reduces cognitive load by turning an ambiguous research task into a repeatable checklist | Low | Can sharpen the Tier 3 demo without creating a new product; incremental sales are unproved | Earnings cycles create repeat use | A concrete “earnings vs cash” proof can power source-backed content | Medium | **Test inside Ask; do not rebuild** |
| 5 | Portfolio freshness scan | Investors need to know which holdings have materially changed | Portfolio is the third-largest observable buyer page family: 11 views across 3/7 buyers; B01 and B07 have portfolio activation events | No buyer has a stored portfolio document in the audited snapshot, and no freshness-scan event exists | No explicit buyer request; recurring portfolio-monitoring demand is a hypothesis | Koyfin, TIKR and Stock Analysis already offer mature portfolio/alert workflows | Endowment, goal salience and loss aversion make changes to owned positions more relevant | Medium | Could provide Power/annual-plan rationale; no paid test exists | Weekly or filing-triggered portfolio review | A personalized holdings-change audit could attract high-intent investors | Low–medium | **Prototype only after #1–3** |
| 6 | Goalpost-change check | KPI definitions, guidance or management framing can move between filings | No direct buyer request or verified current-user usage | Existing filing-change behavior is not instrumented at this level | Market gap is hypothesized; no priced conversation or demand count exists | BamSEC supports document comparison and AlphaSense monitoring, but exact “goalpost” positioning is not verified | Highlights inconsistency and surprise, helping users avoid narrative anchoring | Medium | A higher-value workflow is plausible, but revenue evidence is absent | Earnings-cycle comparison can prompt returns | Source-backed before/after examples may earn attention | Low–medium | **Run a content/manual test only** |
| 7 | Newsletter verification pilot | Analysts and writers need defensible source trails before publishing | Relevant prospects have engaged, but no paying buyer requested or bought this workflow | No newsletter-workflow event or retained-user evidence exists | A relevant prospect cohort exists; no sale, budget or conversion is verified | Marvin Labs, BamSEC and AlphaSense already serve professional research workflows | Reduces reputational risk and the effort of substantiating claims | Low as a service; unknown as software | A founder-assisted Desk pilot could test willingness to pay before development | Repeated publishing creates recurring need | Personalized verification samples can open qualified founder conversations | Low–medium | **Sell the service-assisted pilot before building** |
| 8 | Export clarity and reliability | Users need to save, reuse or move research output | One purchase-intent AppSumo Q&A asks for PDF/CSV/Markdown, API or MCP; no buyer usage telemetry exists | Export actions are not reliably instrumented, so current use and failure rates are unknown | One explicit request; prevalence and willingness to pay are unknown | Stock Analysis advertises CSV/Excel/Sheets export; BamSEC exports tables; FINVIZ includes export/API | Portability increases control and reduces fear of workflow lock-in | Low to audit/document existing capability; format gaps unknown | Removes a concrete objection rather than creating a new tier; sales effect unmeasured | Saved outputs can embed the product in an existing research process | Clear listing/Q&A wording can convert users with portability concerns | Medium | **Verify and document existing capability first** |
| 9 | Compound alert design interview | A user wants multi-condition, entity-aware monitoring | One explicit question asks for Boolean sector/guru/share-sale logic | Stored alerts exist, but no rule-creation or compound-condition usage event proves this workflow | One request only; no price, budget or follow-up commitment | TradingView and FINVIZ validate alerts broadly; exact guru/Boolean parity is not verified | Control and vigilance reduce fear of missing a material event | High | Could justify Power/Desk only if buyers commit to a price | Reliable event-driven alerts could be sticky | A narrow, concrete alert example could reach advanced investors | Low | **Interview only** |
| 10 | Verified API pricing test | Users want StockPortfolio evidence inside their own agents and workflows | One explicit AppSumo question requests API/MCP; no paid commitment exists | Zero API usage is possible because no public API exists; behavioral demand is therefore unknown | One request; addressable volume and willingness to pay are unknown | Fiscal.ai, Quartr, Massive, Alpha Vantage and Financial Modeling Prep already offer API/MCP paths; TIKR and Koyfin do not | Automation leverage and integration switching costs can create high perceived value | High, with material data-rights and support risk | Potential high-ACV integration only if rights and price are validated | Embedded workflows can create switching cost | A narrowly targeted developer/agent test can qualify demand | Low | **Landing-page/interview test only; do not build now** |

## Build explicitly not recommended

- A broad MCP/API platform before three buyers commit to a price and upstream commercial rights are verified.
- TradingView/technical-analysis enrichment; it dilutes the SEC/fundamentals advantage.
- New thin programmatic SEO pages.
- A student/SMIF edition without a paid institutional design partner.
- More generic AI summaries; the market is crowded and the differentiated value is evidence plus change detection.
- Automated investment advice, predictions or return promises.

## Why this might be wrong

- Ask is the best-instrumented action and may appear stronger partly because other features are poorly tracked.
- LTD buyers may overuse AI because marginal price is zero and may not support recurring economics.
- Alert documents do not prove monitoring engagement.
- Competitor features demonstrate supply, not demand for StockPortfolio’s implementation.
- One API/MCP request and one review can distort priorities if treated as a market.
