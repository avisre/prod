# Organic SEO Market Research — StockPortfolio.pro

**Date:** 2026-08-21 · **Status:** research + ideas + adversarial review
**Source of truth:** live GSC data (19 clicks / 10,016 impressions / 0.19% CTR, 3 months), the seo-data/ audits, and 5 parallel web-research sweeps (SERP landscape, programmatic SEO, competitors, link building, content formats). All external claims carry sources; third-party traffic/backlink figures are directional estimates.

---

## 1. The honest diagnosis

The technical SEO is not the problem. SSR, canonicals, sitemap sharding, JSON-LD, robots, 20k-page sitemap — all healthy. The problem is three-fold:

1. **Authority ≈ zero.** The site has essentially no backlink profile. StockAnalysis (the #1 competitor) has 1.34M backlinks from 14.3k domains and DR 74. You cannot out-rank it on head terms with content alone.
2. **Content differentiation is thin.** The 20k metric pages are template + data swap. That is *exactly* the pattern Google's March 2026 core update enforcement targets ("stock comparison pages with swapped financial data but identical structure"). The pages get impressions but no clicks — the classic signature of quality suppression + intent mismatch.
3. **CTR is 0.19%.** Position-1 CTR has collapsed industry-wide (28%→19%), and your titles/descriptions are not converting the impressions you do have.

**The one proven asset:** the `/compare/A-vs-B` family — 16 of 19 organic clicks. Research confirms this is the right bet: comparison queries trigger AI Overviews at 78–95% (highest of any type), versus pages are the single strongest predictor of AI-search traffic (Spearman 0.65), and the stock-comparison SERP is fragmented with **no dominant player**. But the March 2026 update makes undifferentiated comparison pages a liability, not just an opportunity.

**The honest timeline:** SEO is a compounding channel. First long-tail movement in 3–4 months; meaningful gains 6–12 months; competitive finance head terms 12–18+ months. It will not produce the next $816 in founder proceeds this week — the AppSumo marketplace work remains the near-term revenue engine. SEO is the channel that compounds without ongoing spend.

---

## 2. What the research says (condensed, with sources)

### SERP landscape (2026)
- AI Overviews on ~43–48% of queries; **financial-information queries 52%** — but **stock ticker/price queries only 7%**, calculators 9%. Your core data queries are in the traditional-SEO safe zone. [TechCrunch](https://techcrunch.com/2026/07/27/googles-ai-search-is-rapidly-becoming-the-default-new-data-shows/) · [SEJ](https://www.searchenginejournal.com/ai-overviews-disappears-on-certain-kinds-of-finance-queries/565389/)
- AIO cuts organic CTR ~61% when present; position-1 clicks drop ~58% on AIO SERPs. [SEJ](https://www.searchenginejournal.com/ai-overview-ctr-fell-61-but-clicks-didnt-collapse/572993/)
- **March 2026 core update** = "go to the source" correction; explicitly enforces scaled-content-abuse against template+data-swap pages, including stock comparison pages. What survived: proprietary data, hands-on analysis, interactive tools, named expert reviewers. [SEOCompare](https://seocompare.co.uk/blog/google-march-2026-core-update/) · [SEJ](https://www.searchenginejournal.com/in-depth-look-at-google-spam-policies-updates/511005/)
- **Information gain** is the strongest differentiator: pages with 15+ unique data points score 62/100 originality vs 40/100 for 0–1. [On-Page.ai](https://api.on-page.ai/whitepapers/information-gain-study-2026.pdf)
- YMYL finance = highest scrutiny; trust is the most important E-E-A-T pillar; named authors, credentials, freshness, primary-source citations. [Search Engine Land](https://searchengineland.com/google-updates-search-quality-raters-guidelines-adding-ai-overview-examples-ymyl-definitions-461908)

### Programmatic SEO
- Winners hold proprietary data (Wise, Zillow, Zapier). NerdWallet: 1.2% of pages drive >50% of traffic; 4,000+ zero-traffic pages is normal; they prune 1.6k–3k pages/yr. [Backlinko](https://backlinko.com/programmatic-seo) · [Ahrefs](https://ahrefs.com/blog/nerdwallet-seo-case-study/)
- Impressions-without-clicks = quality suppression or intent mismatch. Fix the **dataset**, not the template. Modifier test: remove the keyword; if the content is generic, the dataset is too shallow. [Patrick Stox](https://patrickstox.com/programmatic-seo/risks/thin-content/)
- Freshness is query-dependent (QDF) and can beat authority on time-sensitive queries; date-bumping earns no credit. [theStacc](https://thestacc.com/blog/query-deserves-freshness-guide/)
- Cautionary case: a 287k-page stock-comparison site indexed only 0.9% of pages, DR 0, flagged thin. [DEV](https://dev.to/apex_stack/i-built-a-287000-page-website-heres-what-i-learned-about-programmatic-seo-4d5h)

### Competitors
- **StockAnalysis** (7.32M visits/mo, 1.34M backlinks): winning page anatomy = answer-first summary, metric cards, interactive chart, 22-row history table, data-source attribution, freshness indicators ("Last updated: Jul 29, 2026"), definition block, related stocks. [Semrush](https://www.semrush.com/website/stockanalysis.com/overview/)
- **"X stock revenue history" SERP** is dominated by StockAnalysis / WallStreetNumbers / Macrotrends. WallStreetNumbers (founded 2022, low authority) wins top-3 by offering the longest history (since 1982) + analyst estimates + sector percentiles — **data depth beats domain age**. [WSN](https://wallstreetnumbers.com/stocks/msft/revenue)
- **"X vs Y" comparison SERP is fragmented** — FinanceCharts, Yahoo, StatMuse, GoodMoat, Tickeron, no dominant player. Sites with 21+ comparison pages get 900% more median AI sessions. [Siege Media](https://www.siegemedia.com/research/versus-pages)
- **Wisesheets** (DR 24, 58 referring domains, 133k visits) ranks for "Google Sheets stocks" tutorials — content-led SEO works at near-zero authority. [Website Informer](https://website.informer.com/wisesheets.io)
- **MarketBeat** (6.17M visits/mo, 304M backlinks): 3 content tiers (human / template automation / gen-AI), ~$60M/yr, ~90% ads/affiliate. [Ross Simmonds](https://rosssimmonds.com/blog/marketbeat/)

### Link building
- Backlinks still correlate with rankings (0.255, strongest link metric) but matter less than 2019; in YMYL finance, **content quality is the gate, links amplify**. [Ahrefs](https://ahrefs.com/blog/links-matter-less-but-still-matter/)
- **Data journalism is the #1 tactic**: a single data campaign lands 30–80 editorial links; original research earns 3.3x more AI citations per page. [Link Building Journal](https://linkbuildingjournal.co.uk/data-journalism-for-seo/) · [SEJ](https://searchengineland.com/why-most-original-data-never-gets-cited-481676)
- **Free tools are the strongest linkable asset** (50–300+ referring domains); tools producing a quotable public statistic earned 140 links vs 4 for personal-answer tools. [Link Building Journal](https://linkbuildingjournal.co.uk/free-tools-for-link-building/)
- Unlinked brand mentions correlate 0.737 with AI visibility — the strongest signal measured. [Link Building Journal](https://linkbuildingjournal.co.uk/unlinked-brand-mentions/)
- Realistic solo-founder output: 30–80 quality links over 12 months; 5–10 quality links in 6 months beats 100 PBN links. [Mention Agent](https://mentionagent.ai/blog/link-building-for-bootstrapped-saas/)
- Embeddable widgets are NOT a link strategy (link-scheme risk); the durable play is a canonical "source of record" data page. [Link Building Journal](https://linkbuildingjournal.co.uk/embeddable-live-chart-links/)

### Content formats
- Comparison pages are the highest-converting format: verdict in first 2–3 sentences, static HTML tables (not JS-rendered), criterion-by-criterion verdicts, pros/cons, "Choose X if…" framing, honest acknowledgment of competitor strengths. [Vydera](https://vydera.com/en/lab/comparison-page-seo) · [Semrush](https://www.semrush.com/blog/effective-comparison-pages/)
- Position-1 CTR fell 32% (28%→19%); **positions 6–10 rose 30.6%** — striking-distance pages matter more than ever. [GrowthSRC](https://growthsrc.com/google-organic-ctr-study/)
- FAQ rich results were **removed May 7, 2026**; HowTo removed 2023; Dataset is not a SERP rich result. Schema is still parsed "for understanding" but barely moves AI citations. [SEJ](https://www.searchenginejournal.com/google-drops-faq-rich-results-from-search/574429/)
- ~58.5% of searches end without a click. [SEO.com](https://www.seo.com/wp-content/uploads/2025/05/inside-zero-click-searches.pdf)

---

## 3. The ideas (ranked by leverage ÷ effort)

### I1 — Harden the compare family (protect + scale the only proven click source)
The compare pages are the only proven click source AND the highest-value format. But the March 2026 update makes undifferentiated comparison pages a liability. Do:
- **Explicit verdict statements** in the first 2–3 sentences (2.9x more likely cited in AIO).
- **Pros/cons sections** and **"Choose X if…" framing** per company.
- **Honest acknowledgment** of each company's strengths (biased pages get penalized).
- **Static HTML tables** (3–5 cols, 4–8 rows, query-matched headers) — not JS-rendered.
- **Freshness indicators**: "as of" filing dates, "Last updated" on each page.
- **Ground the AI verdict**: the existing `compare-verdict.js` LLM prose must be deterministic/grounded (the evidence-flywheel publish gate), not free-form on every page — free-form LLM verdicts at scale are the scaled-content-abuse pattern.
- **Scale selectively**: the SERP is fragmented and 21+ comparison pages = 900% more AI sessions, but only add pairs with real demand (GSC-observed), not all 20k² combinations.

### I2 — Enrich the metric pages (fix impressions-no-clicks)
One template change, not 20k edits. Close the gap to StockAnalysis's winning anatomy:
- **Growth rates** (YoY/QoQ) on every metric — the site already computes these.
- **Peer comparison** (this stock vs sector median) on each metric page.
- **Filing dates + "as of" dates** (freshness — the genuine moat).
- **Definition blocks** for each metric.
- **Modifier test**: pages that can't be differentiated → noindex or consolidate into per-stock hub pages. Do NOT build new thin pages.

### I3 — Freshness as the moat (QDF)
SEC data updates quarterly. Publish "as of" filing dates, "Last updated" indicators, update on filing. This is real QDF credit static competitors lack. IndexNow for meaningful changes (Bing; Google doesn't consume it). Cheap, honest, aligns with the evidence flywheel.

### I4 — SEC-data journalism (the authority play)
Publish cross-sectional SEC benchmarks: "X% of S&P 500 companies cut guidance in Q2", "Which sectors raised dividends most in 2026", "The 10 most shorted stocks". Format: benchmark answering "which is best", methodology box, stable URL, downloadable data. This is the #1 link tactic (30–80 editorial links/campaign) and over-indexes in AI citations (3.3x). Realistic: 1 benchmark/month, 3–4 months to first movement.

### I5 — Make the 30 free tools linkable
Research: free tools earn 50–300+ referring domains; quotable-stat tools earn 140 links vs 4 for personal-answer tools. Make one tool produce a **quotable public statistic** (e.g., screener output "X% of sector Y has negative FCF"), no signup gate. Cheap to test.

### I6 — E-E-A-T hardening (YMYL table stakes)
Named author (the founder), a methodology page, freshness dates, disclaimers, primary-source citations. The site already cites SEC sources — the honest E-E-A-T is **data provenance**, not fake credentials. Cheap.

### I7 — AI-citation optimization (GEO)
Structure pages for extractable, citable data blocks: direct answers in 40–60 words, question-matched H2/H3s, semantic HTML tables, explicit verdicts. The evidence cards are already this format; extend to compare + metric pages. Cheap, future-proofs against AIO.

### I8 — Prune/consolidate weak pages (risk reduction)
NerdWallet prunes 1.6k–3k pages/yr. Apply the modifier test; noindex or consolidate pages that can't be differentiated AND have no impressions. Protects against scaled-content-abuse and improves crawl budget. Conservative.

### I9 — Bing (secondary, cheap)
Bing already gives 38 clicks / 17.7k indexed pages. IndexNow for meaningful changes, Bing Webmaster Tools. Low effort, real but small.

---

## 4. Adversarial review

*Two independent passes: my own, plus a dedicated adversarial agent that was given the site's real numbers and told to break the plan. The agent's verdict is harsher than the ideas section — and mostly correct.*

### The premise attack (the strongest one)

**"19 clicks / 3 months is not a channel, it's noise."** Even a 10x improvement at 0.19% CTR is still nothing. The constraint is **authority + real demand**, and neither is fixable with on-page work. You have ~zero backlinks in a vertical where the leader has 1.34M. The March 2026 core update is actively demoting the template+data-swap pattern your whole 20k-page footprint is. **Opportunity cost:** 15 hrs/week on SEO is 15 hrs not spent on AppSumo — the actual revenue engine. SEO is a 12–24 month bet with low probability; AppSumo is a near-term event.

**Response:** agreed, with one caveat. The compare pages are the only thing that has *ever* produced a click, and they're cheap to maintain. The correct posture is **defensive SEO + one authority bet**, not a growth program. The site's own evidence-flywheel plan already says this: "Search is a compounding channel, not the shortest route to the next $816."

### Per-idea verdicts

| Idea | Verdict | Strongest attack |
|---|---|---|
| I1 Harden compare family | **Keep (maintenance, not growth)** | 16 clicks/3 months is noise; hardening won't create demand. Adding more templated verdict/pros-cons blocks to a zero-authority site is itself the pattern being demoted. Do it only as cheap protection of the one proven asset. |
| I2 Enrich 20k metric pages | **Kill** | The WAB data is damning: position 1–3, thousands of impressions, zero clicks = rank-check/test demand, not users. You'd be polishing pages nobody reads, and enriching the template+data-swap footprint *increases* penalty surface. |
| I3 Freshness as moat | **Low value** | You already rank 1–3 and get zero clicks — the constraint is CTR and authority, not ranking. Freshness is table stakes. Do only if free. |
| I4 SEC-data journalism | **Keep, but I4-lite** | "30–80 editorial links per campaign" is fantasy for a DR-0 site with no journalist relationships. The S&P 500 guidance-cut story is already covered by Reuters/Bloomberg/WSJ. A solo founder at 15 hrs/week can't sustain a journalism cadence. But it's the *only* idea that builds the missing asset (authority). |
| I5 Make tools linkable | **Low value alone** | Nobody cites statistics from a zero-authority site. Tools are linkable only once authority exists. Pair with I4 or skip. |
| I6 E-E-A-T hardening | **Table stakes, not a lever** | A solo founder with no finance credentials can't manufacture E-E-A-T. A named author with no bio is a checkbox. |
| I7 AI-citation optimization | **Kill** | Speculative — LLMs cite authoritative sources, and you're not one. On a YMYL finance site, LLM-generated answer blocks are a penalty magnet under scaled-content-abuse. |
| I8 Prune/consolidate | **Keep as hygiene** | Pruning 20k pages risks the 17.7k Bing-indexed pages and the (fake) impression base. Do it conservatively. |
| I9 Bing | **Keep as freebie** | Bing already outperforms Google for you (38 vs 19 clicks), but the ceiling is ~38 clicks. Never invest in it. |

### Dangerous ideas

**I2 and I7 are actively dangerous** — they double down on the exact template+data-swap pattern the March 2026 update targets, on a zero-authority YMYL site. **I4 carries a secondary risk:** a misread SEC number in a finance vertical is a trust/legal liability — the publish gate must be hard.

### What to actually do (merged recommendation)

1. **Stop SEO as a growth program.** Freeze new programmatic pages. Keep the compare pages (cheap hardening: verdicts, static HTML tables, freshness dates — one template change). Noindex the worst metric pages. **One hour/week of SEO maintenance, max.**
2. **Put the other 14 hours into AppSumo** — answer every Q&A, respond to every review, fulfill redemptions, push the marketplace deal. That closes the $816 gap.
3. **One SEO-adjacent bet only:** 2–3 genuinely differentiated data pieces (I4-lite) that *double as AppSumo marketing content* — e.g., "X% of S&P 500 cut guidance in Q2" as a lead magnet for the listing. If they earn links, great; if not, they still served the marketplace.
4. **Revisit in 6 months with real data.** If AppSumo brings users, they create branded search demand — the only kind this site has ever converted. SEO only becomes worth pursuing once real demand exists.
