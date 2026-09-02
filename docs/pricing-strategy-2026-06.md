# Pricing & Packaging Strategy — stockportfolio.pro (2026-06-12)

Derived from: full codebase feature audit (36 features), live competitor pricing verified June 2026, and pain-point research across Reddit/Bogleheads/Trustpilot/surveys. See session of 2026-06-12 for sources.

## 1. First-principles cost model

- Data is ~free: Yahoo Finance + SEC EDGAR are public. Competitors gate data depth because they PAY for licensed data (S&P CapIQ etc.). We don't → gating data depth is copying their constraint, not ours.
- The only real marginal cost is AI tokens (already metered: 5 free / 300 Pro per month) and SEC-extraction compute (cached forever after first hit).
- Therefore: give data away (acquisition), meter AI (cost), charge for monitoring/intelligence (value + retention).

## 2. Feature buckets (by job, not by tech)

| Bucket | Job | Features | Marginal cost |
|---|---|---|---|
| A. Acquire (free, SEO) | Get found, prove credibility | Screener (1,500), /stocks/:ticker SEO pages, filings list, insider filings tool page (6 most recent Form 4s), guru top-5 teaser, demo | ~0 |
| B. Track | "Is my money OK?" | Portfolio, watchlist, dashboard charts, CSV export | ~0 |
| C. Monitor (retention engine) | "Tell me when something changes" | Filing watchdog, health-flip alerts, weekly briefing, X-Ray | ~0 + tiny AI |
| D. Research depth | "Should I buy/hold this?" | 19-yr fundamentals, health checks, peers, key points, segments, insights | ~0 (cached) |
| E. AI conversational | "Just answer my question" | Ask (portfolio + company Q&A), AI summaries | REAL token cost — meter |

## 3. Market facts (verified June 2026)

- Dominant retail conversion band: **$18–25/mo annual-billed** (10 of 12 competitors land an offer there).
- Prosumer band $39–79 (Fiscal.ai Pro $39, Koyfin Plus $39, TIKR Pro $55).
- **White space: no conversational-AI equity research below $39/mo** (Danelfin $22 is scores-only). Nobody owns "ask AI about YOUR holdings" at any retail price.
- Fiscal.ai = benchmark: free 10y + 10 AI prompts; Pro $39/$49.
- Stock Rover re-tiered 2.5–3x up in 2025-26 (cheap data tiers unsustainable). Danelfin launched $1,608/yr Elite Apr 2026 — AI tools pushing upmarket.
- Category-wide billing distrust (SA/SWS auto-renew complaints) → transparent billing is a cheap wedge.

## 4. Recommended pricing

| Tier | Price | Contents | Rationale |
|---|---|---|---|
| **Free** (no card) | £0 | Buckets A + 1 watchlist (10) + **3 Ask q/mo** + 1 AI summary taste | Resolves the open free-tier decision: YES. Competitor norm, SEO flywheel, AI-taste drives upgrade. Cost ≈ pennies/user/mo. |
| **Core** | £9/mo · £90/yr | + B, C, D (everything except AI-heavy + Pro intelligence) + 25 Ask q/mo | Keep £9 — structural undercut ("all-in-one for the price of Sharesight Starter"). Raise free Ask 5→25 here so Core feels AI-included. |
| **Pro** | £25/mo · **NEW £190/yr (~$20/mo eq.)** | + 300 Ask, segments, insights, summaries, weekly briefing+, **new intelligence features (Filing Diff, attribution, smart alerts)** | £25 monthly anchors high; £190 annual lands effective price dead-center of the $18–25 band AND the <$39 AI white space. |
| **(Later) Desk** | £49/mo | Unlimited-ish Ask, wash-sale/tax guard, export/API, priority extraction | Only after Pro intelligence features ship. Matches $39–79 band. |

Principles: no first-year-discount/renewal-jump games (trust wedge); quotas hit naturally in use (Ask count); annual discount ~30-37% headline. Consider dual-currency: all-US universe + GBP-only checkout is friction for US buyers.

## 5. Five unserved high-WTP pain-point features

Ranked by (pain × willingness-to-pay × fit to our stack):

1. **Filing Diff — "What changed this quarter"** (Pro): per-holding redline digest of new 10-K/Q vs prior — guidance language, risk factors, segment numbers, tone — linked to exact passages. Today this is BamSEC/Hudson Labs at institutional prices; #1 stated reason retail adopts AI is "save time on research" (48%, eToro 2025). Build: watchdog already detects the filing; segments/keypoints already fetch + extract 10-K text; add prior-filing fetch + diff prompt + alert hook. ~Days.
2. **Smart fundamental alerts** (Pro): insider cluster-buy alerts (Form 4 parser EXISTS), guidance-change alerts (from Filing Diff), dividend-cut-risk flag, user valuation thresholds ("alert me if AAPL P/E < 25"). Price alerts are noise; event alerts are a proven cottage industry. Build: extends watchdog. ~Days.
3. **Portfolio movement attribution — "why am I down today"** (Pro, daily brief): quantified per-holding contribution + cause ("−1.2% today: NVDA −0.9% on earnings, sector beta −0.3%"), delivered only when material. Micro-startups (PRISM, Gainwise) exist solely for this; brokers show the red number with zero explanation. Build: have prices, holdings, news endpoint, briefing infra. ~Week.
4. **Cross-account wash-sale guard / tax-lot intelligence** (Desk tier or paid add-on): broker CSV import → real tax lots → pre-trade wash-sale warnings incl. IRA poison case → Form 8949 adjustments. Monetary pain (permanently disallowed losses, CPA fees); brokers legally only see their own accounts; NO tracker does it. Biggest build (CSV ingestion per broker) but highest standalone WTP — this is the post-Mint hole.
5. **Reverse-DCF "what's priced in"** (Core/Pro): per stock, back out market-implied FCF growth from current price and show it against the company's actual 19-yr record, editable assumptions, every input sourced. Counters the #1 distrust of black-box "fair value" (Simply Wall St criticism); free calculators exist but are disconnected from live data — ours plugs into the cache. ~Days; great SEO block on /stocks pages too.

Compounding insight from research: pains 1+2+3 + our grounded Ask = one coherent product — "portfolio-aware, filings-grounded intelligence with verifiable numbers" — exactly the gap between research terminals (no portfolio context) and trackers (no research intelligence). 30% of US retail already uses AI for investing while ~half of generic-AI financial references are wrong; source-linked grounding is the trust unlock.

## 6. Migration notes

- AI_PRO_FOR_ALL=true currently gives Core users AI — fine for now; flip to false when Pro intelligence ships so Pro has real teeth.
- Grandfather existing subscribers at current terms.
- Stripe: add price IDs for Pro Annual £190 and (later) Desk; free tier = REQUIRE_ACTIVE_SUBSCRIPTION=false path + quota middleware (screener/SEO already public).
