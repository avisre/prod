# Research Dossier — baseline & gap analysis (2026-06)

Baseline = the **University of Waterloo 2024 CFA Institute Research Challenge global-winning report** on Cargojet (TSX: CJT), a real, award-judged initiation-of-coverage report. PDF saved locally at `/tmp/analyst-baselines/` (NOT committed — third-party). Also: CFA "Equity Research Report Essentials" rubric + written-report guidelines.

## Anatomy of a real initiation report (21 pages: ~10 core + ~9 appendix, ~32 figures)

1. **Cover + disclosures** — ownership, compensation, position, market-making, disclaimer ("not investment advice").
2. **First page (the money page)** — header band: company, ticker, sector, **Recommendation (Buy/Hold/Sell)**, **Target Price + upside %**, current price/date. Then Executive Summary (initiate coverage, target, methodology, one-line thesis) + **Investment Thesis Highlights (3 theses, bolded)**. Sidebar tables: Company Data, **Valuation Results (per method + target + implied return)**, Financial Data (Rev/EBITDA/margin across 22A–25E). Expert quote callout.
3. **Business Overview** — founding/HQ, key operating segments, value-chain position, recurring-revenue/growth history. Charts: segment pie, business-model flows, value chain.
4. **Industry Overview** — each driver tagged **Positive/Negative**, expert interviews, market-size charts.
5. **Competitive Positioning** — the moat, why customers can't leave, comparison table vs alternatives.
6. **Investment Summary** — each thesis with deep evidence, reverse-DCF, charts, expert quotes.
7. **Valuation** — **multi-method**: DCF (5yr projection, segment revenue, **WACC buildup** — cost of debt/equity, CAPM, beta; terminal growth + exit multiple) + **comparable companies** (EV/NTM EBITDA peer bars) + **scenario analysis (bear/base/bull** with rev CAGR, margins, implied return) + **target-price bridge** (range per method), with method weighting (e.g. 80% DCF / 20% comps).
8. **Financial Analysis** — **DuPont table** (gross/EBITDA/net margin, asset turnover, ROA, ROE, ROIC, current/quick, interest coverage, debt/EBITDA) across 2019A–2028E + narrative (growth, margins, returns, FCF, credit). Charts: ROIC, dividend growth, buybacks, debt/EBITDA.
9. **Investment Risks** — Risk #1–4, **each with a Mitigant**, plus a **Risk Matrix (likelihood × impact)**.
10. **ESG** — E/S/G, ESG scorecard vs rating agencies + peers, Glassdoor reviews, exec comp, ownership, board, management bios.
11. **Appendices** — expert-interview list, segment breakdown, competitor profiles, ownership/warrants, peer performance, reverse-DCF model, DCF model, statements, mgmt bios.

## Where our dossier stands vs the baseline

| Baseline section | Our dossier |
|---|---|
| Exec summary | ✅ + Bull/Bear (sharper than one-sided) |
| Investment thesis (3) | ⚠️ bull/bear + Edge instead of a thesis-led spine |
| Business overview + segments | ✅ |
| Industry overview (Pos/Neg drivers) | ❌ |
| Competitive positioning + peer table | ✅ NEW (vs N sector peers, medians, verdict, closest comps) |
| Valuation — reverse-DCF | ✅ |
| Valuation — peer multiples | ✅ NEW (trades X× vs peer median Y×, premium/discount) |
| Valuation — **forward DCF + WACC buildup** | ❌ (we're historicals-grounded, no projections) |
| Valuation — **scenario bear/base/bull** | ❌ TODO |
| **DuPont / ratio table across years** | ❌ TODO (have the inputs) |
| Financial analysis narrative | ⚠️ partial (key figures + health checks) |
| Risks with **trigger + impact + mitigant + severity** | ✅ NEW |
| Risk matrix (likelihood × impact) | ❌ TODO (have severity) |
| Recent developments | ✅ (the Monitor — *better*: it's live) |
| Edge / unique forensic signals | ✅ NEW — our differentiator (expectation gap, FCF conversion, accruals, Rule of 40, margin trajectory, leverage, capital allocation) |
| ESG | ❌ (no data source) |
| Governance/ownership/mgmt | ⚠️ partial (insider Form 4 exists; exec comp needs DEF 14A) |
| Charts/figures (~32) | ❌ mostly text + tables — biggest visual gap |
| **Recommendation + single target price** | ❌ **deliberately omitted — see decision** |

## Shipped this round (commit after this doc)
Competitive positioning + peer-multiples valuation, structured Risks (trigger/impact/mitigant/severity), and the **Edge** section (deterministic forensic signals → model narrates the standouts). Verified on AAPL (~31s): expectation gap +12pts, op-margin 24.1%→32.0%, Rule of 40 = 36, vs 431 peers, 4 risks with mitigants.

## Remaining to reach full-initiation parity (priority order)
- **T1 Scenario valuation (bear/base/bull fair-value range)** — descriptive, no buy call. Extend reverse-dcf to a forward range under 3 assumption sets.
- **T1 DuPont / ratio table** across years (deterministic).
- **T1 Charts** — revenue/EBITDA/margin/ROIC trends, peer bars, scenario bridge (SVG; reuse V2 chart helper). Closes the visual gap.
- **T2 Industry overview** with Positive/Negative driver tags.
- **T2 Governance & ownership** from Form 4 + 13F + DEF 14A.
- **T2 "Management's own words"** quotes from filings (our analog to expert interviews).

## The one decision (regulatory fork)
The baseline's spine is a **Buy/Hold/Sell + 12-month target price**. We deliberately omit it: auto-generating "BUY, target $X" for retail users is investment advice and an RIA/regulatory minefield. Recommendation: **keep no buy/sell call**; deliver the analytical substance as a **scenario fair-value range (bear/base/bull) + what's-priced-in**, with the standard not-advice disclaimer (the CFA report itself carries one). This is also the *feature* for the RIA/compliance buyer. Only add an explicit target price if the user accepts that positioning/legal change.
