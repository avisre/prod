# Funnel analysis

Snapshot: 21 August 2026. This report separates marketplace commerce, product activation and traffic analytics. Counts from different windows are not combined into fake cohort conversion rates.

## The only fully reconciled commercial funnel

| Stage | Count | Denominator | Rate | Evidence quality |
|---|---:|---:|---:|---|
| AppSumo unique visitors, latest 7 days | 122 | — | — | Portal card; current screenshot |
| AppSumo orders, latest 7 days | 2 | 122 visitors | 1.64% | Portal card and order totals |
| AppSumo orders, all through Aug 20 | 9 | Marketplace visitor denominator unavailable for full period | UNKNOWN | Authoritative portal |
| Redeemed/activated real licences | 7 | 9 orders | 77.8% | Licence reconciliation |
| Unredeemed licences | 2 | 9 orders | 22.2% | One old, one less than a day old |
| Completed Ask at least once | 6 | 7 redeemed buyers | 85.7% | Ollama usage records; better coverage than canonical events |
| Used Ask on 2+ days | 2 | 7 redeemed buyers | 28.6% | Server-side usage days |
| Canonical `first_research_completed` | 0 recorded | 7 redeemed buyers | Not a real zero | Instrumentation gap: product activity exists |
| Canonical `seven_day_return` | 0 recorded | Eligible cohort not implemented reliably | UNKNOWN | Instrumentation gap |
| AppSumo refunds | 0 | 9 orders | 0% through Aug 20 | Authoritative portal |

This funnel does **not** prove that 85.7% of all purchasers activate Ask. It describes seven redeemed buyers; two orders never reached a product account.

## Canonical event funnel and data-quality warnings

The database contains roughly 16.2K funnel rows, but most are excluded, bot-like, internal or missing durable identity/source. Current event counts cannot be read as a clean visitor funnel.

Major defects in the existing reporting layer:

1. `scripts/report-growth-measurement.js` counts AppSumo redemptions as paid customers even though the analytics contract says redemptions are not orders.
2. Its query projection omits amount and currency, forcing Stripe revenue/refund sums to zero.
3. Its stage rates divide independent event counts within a window, not one cohort moving through stages; ratios can exceed 100%.
4. Missing source is treated as Direct in one legacy exporter. Direct must remain `Unknown`.
5. Canonical `first_ask_succeeded` records only four buyers, while provider usage proves six completed Ask. `first_research_completed` and `seven_day_return` also undercount observable behavior.
6. Page attribution is available for only four of seven redeemed buyers and essentially absent for registered nonbuyers.

Consequently, do not use the current dashboard’s “paid customers,” stage conversion, revenue or source labels as finance truth until those definitions are corrected in a separately approved implementation phase.

## Segment view

| Source | Traffic/action evidence | Orders | Gross | Founder revenue | What can be concluded |
|---|---:|---:|---:|---:|---|
| AppSumo | 122 unique visitors in latest 7-day portal card | 9 total; 2 latest 7d | $801 | $183.97 | Only channel proven to transact |
| Direct Stripe | 88 checkout sessions; 87 expired/unpaid; one paid | 1 historical | £7 | £0 after refund | Direct checkout has not retained revenue |
| X | 37 native link clicks in available 3-month export | 0 attributable | $0 attributable | $0 attributable | Generates clicks, not proven buyers |
| Google organic | 19 GSC clicks over full available period | 0 attributable | $0 attributable | $0 attributable | Comparison pages generate clicks; purchase link unknown |
| Bing organic | 38 clicks over 67 days | 0 attributable | $0 attributable | $0 attributable | Traffic is real; commercial outcome unknown |
| Direct/unknown | Large analytics bucket | UNKNOWN | UNKNOWN | UNKNOWN | Not verified brand demand |

## Biggest leaks ranked by revenue impact

1. **Marketplace visitor → order:** latest portal window has 120 nonbuyers out of 122 visitors. This is the largest measured volume leak, but the portal does not show why they left.
2. **Order → redemption:** two of nine buyers have not activated. One is an old Tier 3 order and is the clearest recoverable revenue-at-risk/value-delivery gap; the new Tier 2 order deserves normal activation time.
3. **Redemption → repeated value:** six buyers tried Ask, but only two used Ask on multiple days and one buyer accounts for 71% of calls.
4. **Traffic → identified user:** Google, Bing and X clicks have no verified order join. The problem is partly performance and partly observability.
5. **Direct checkout → retained payment:** 87 of 88 checkout sessions expired/unpaid; the one paid £7 charge was refunded. Session intent and QA contamination are not fully known, so the ratio must not be advertised as a public conversion rate.

## What likely blocks conversion—and what remains unknown

Observed signals:

- The only review praises efficiency but explicitly says accuracy still needs cross-verification.
- Buyer questions ask about ETF coverage, mapping AppSumo to website plans, Ask reliability, exports/API/MCP and smart alerts.
- A creator prospect asked whether the product “just bring[s] up a list of filings,” exposing a positioning-clarity problem.
- The listing contains absolute phrases such as “never made up” and “can’t hallucinate,” which are broader than a system containing derived values, fallback fields and external data.

These support a trust/clarity hypothesis: show one complete workflow with its filing evidence, state the limits plainly, and make tier boundaries easy to compare. They do **not** prove why any specific one of the 120 recent nonbuyers left; only recordings, survey/interview evidence or a controlled test can do that.

## Aha analysis

| Candidate behavior | Buyers | Nonbuyers | Observed lift | Confidence |
|---|---:|---:|---:|---|
| Completed Ask | 6/7 | 0 observed/29 | Not reported | Medium: nonbuyer linkage is incomplete |
| Summary or briefing | 5/7 | 0 observed/29 | Not reported | Low–medium |
| Stored alerts | 4/7 | 5/29 | 3.3× raw association | Low: alert documents may be generated and cohorts differ |
| Activity on 2+ days | 6/7 | 0 observed/29 | Not reported | Low–medium: measurement coverage differs |
| Dossier before purchase | 1/7 observable | UNKNOWN | Not reported | Low |

The defensible activation hypothesis is **first useful cited Ask answer**, followed by **returning to research another company or filing change**. It is not a causal purchase model yet.

## Why this might be wrong

- The paying sample is nine orders and seven redeemed users.
- AppSumo visitors and product users are measured in different systems.
- AppSumo buyers purchase before StockPortfolio account creation.
- Older users lack durable identity linkage.
- Clarity is observational and its bot filter differs from backend filters.
- Zero attributed revenue from search or X may reflect missing joins, not zero influence.
