# API/MCP buyer candidates — "fintechs like Roo Money"

2026-09-11. **Two sends went out on 2026-09-11 from `support@stockportfolio.pro`** on
an explicit owner decision overriding the standing "never cold email from support@"
rule — see the Sent table at the end. Everything else here remains list-building and
contact verification only, owner-gated per `2026-09-01-stripe-2000-strategy-v3.md`.

**Sourcing note:** every company below was found via live web search on 2026-09-11 and
is a real, publicly identifiable business. Contact channels are marked **verified**
(with the page that shows them) or **excluded** — no `partnerships@`-style guesses,
same convention as `2026-09-02-b2b-25-list-kit.md`.

## What the reference example actually tells us

**Roo Money** (Code Pebble, Inc., Pleasant Grove UT; ~8 people; trademark via Code
Spark LLC) is a consumer budgeting app that consumes **bank** data via Plaid, MX and
Finicity. It is a *pattern template*, not a lead: it has no surface that needs SEC
filings today. The pattern worth chasing is one step over — **small fintech products
that already pipe in a financial-data API because Bloomberg/FactSet is out of reach.**
Those products have a live integration to swap or augment, and they feel the
provenance problem our filings layer solves.

Commercial scope is unchanged and load-bearing: **SEC-derived surface only**
(`sp_financials`, `sp_filing`, `sp_compare`, `sp_screen`, filing-change deltas).
`sp_fund` and `sp_ask` are not sellable (`docs/growth/mcp-api-lab-outreach.md`).

---

## Tier 1 — verified data consumers (best fit)

| # | Candidate | What they are | Why they buy | Contact channel |
|---|---|---|---|---|
| 1 | **Monarch Money** | Consumer money app; AI Insights, Weekly Recap, investment tracking | Publicly disclosed data source: **Financial Modeling Prep** for investment prices/history ([help doc](https://help.monarch.com/hc/en-us/articles/41855507661076-Investments-in-Monarch)). Their AI features state numbers without a checkable source — the exact failure mode our citation envelope exists for | **No public BD email.** Decision-maker: **Erin Bream, Head of Partnerships** ([LinkedIn](https://linkedin.com/company/monarch-money)). Published addresses are `press@monarch.com` ([press room](https://www.monarch.com/press)) and `support@monarch.com` — media/general, **not** a partnerships route |
| 2 | **Stock Unlock** ([stockunlock.com](https://stockunlock.com/fundamental-investors.html)) | Value-investing app: 35-yr statements, DCF, screener; ~5 people, NY, ~$500K raised | Disclosed providers: **Finnhub** (statements) + **Fiscal.ai** (KPIs/segments). A filing-cited feed is a direct substitute for the Fiscal.ai piece, and their whole pitch is fundamental rigour | **`support@stockunlock.com`** — verified on their official [LinkedIn](https://www.linkedin.com/company/stockunlock). Alternates: LinkedIn company page, [@stock_unlock](https://twitter.com/stock_unlock) |
| 3 | **Wealthfolio** ([wealthfolio.app](https://wealthfolio.app/docs/concepts/market-data-and-fx/)) | Open-source (AGPL-3.0) local-first portfolio tracker, ~8.5K stars, pluggable BYO-key data providers | Provider architecture is explicitly extensible and has **no fundamentals provider** — a natural integration surface rather than a sales conversation | **No email channel.** Maintainer **afadil** via [github.com/wealthfolio/wealthfolio](https://github.com/wealthfolio/wealthfolio/), the official Discord, or an addon PR in `wealthfolio-addons`. Treat as distribution/credibility, not near-term revenue |

## Tier 2 — Roo-Money-shaped consumer apps (weaker fit, same shape)

| # | Candidate | Why plausible | Honest caveat |
|---|---|---|---|
| 4 | **Origin** ([useorigin.com](https://useorigin.com/resources/blog/copilot-vs-monarch-vs-origin-which-personal-finance-app-is-actually-worth-it)) | AI Advisor answers questions grounded in the user's real investment data | Those answers are mostly about the user's own accounts, not company fundamentals |
| 5 | **Copilot Money** | Most portfolio-like of the budgeting apps (holdings, dividends, per-security returns) | Tracker-first; no fundamentals surface today |
| 6 | **getquin** / **Portseido** / **Sharesight** | Portfolio trackers with analytics ambitions; Sharesight runs a formal [API Technology Partners](https://www.sharesight.com/api-technology-partners/) program | Several skew non-US; the quote-licensing exclusion does not apply to the SEC surface, so the pitch stays clean |

## Tier 2b — trading platforms (contacts verified first)

Fit caveat up front: brokers already license exchange and quote data, so the pitch is
**augmentation** — filing-grounded fundamentals and filing-change deltas for their
company-research / news / insights features — never core trading data.

| # | Platform | Verified contact | Fit note |
|---|---|---|---|
| 7 | **Webull** | **`partner@webull.com`** — verified on [Webull Financial's LinkedIn](https://linkedin.com/company/webullfinancialllc) | Best-verified contact in this tier; institutional/API-minded |
| 8 | **Trading 212** | No public BD email. Partnerships team via LinkedIn: **Toni Yotov** (Senior Partnerships Manager), **Richard Heaton** (Partnerships Manager since Apr 2026, **ex-TradingView**) — [team listing](https://theorg.com/org/trading-212/teams/partnerships-management). General: `info@trading212.com`; media: [trading212.com/press](https://www.trading212.com/press) | Team in flux — Head of Partnerships departed Jan 2026 |
| 9 | **eToro** | Data-partnership decision-maker: **Yossi Brandes, VP Execution Services** — quoted on the LSEG / [Deutsche Börse](https://www.etoro.com/news-and-analysis/press-releases/etoro-partners-with-deutsche-borse-to-add-290-more-listed-german-stocks-to-the-platform/) / Nasdaq deals. Media: `pr@etoro.com` | Most active broker in data partnerships, but all exchange-side; the filings gap is real |
| 10 | **TradingView** | Intake: [brokerage-integration form](https://www.tradingview.com/brokerage-integration/). Named heads: **Helena Jarabakova** (Americas, ex-CME data partnerships), **Oleg Morgunov** (Europe/LATAM) — LinkedIn | Largest reach; the form is brokerage-focused, so LinkedIn-first is likelier to land |
| 11 | Freetrade / Stake | **No verified contact found — excluded** until one surfaces | Non-US skew, weaker SEC-filings relevance |

## Tier 3 — pattern evidence, not leads

Live indie/edu projects on the exact shape we replace — fundamentals API + LLM layer:
PaPs Mercados (FMP + Massive + Claude), SmokeNMirror (Yahoo + Finnhub + Polygon + FMP),
renhotsai/stock-review (FMP + OpenAI), a Purdue MGMT 690 dashboard (FMP + OpenAI/Groq).
None are commercial buyers; they are evidence the integration shape is common, and
useful as demos of what the filing-delta layer adds.

## Do-not-pitch — competitors on the same surface (verified)

[Valuein](https://valuein.biz/mcp) (118 MCP tools; $49 Pro / $499 institutional),
[Drillr](https://drillr.ai/), [Orbit](https://www.orbitfin.ai/platform/MCP),
[EvidInvest](https://evidinvest.com/lp/sec-filings) (55 tools, credit packs),
**Wisesheets** (now claims primary-sourced EDGAR XBRL plus its own MCP server). Useful
for price anchoring and positioning copy only — pitching them is a rights problem, not
just a wasted email.

## Lead with

**Filing-change deltas + materiality score** — what materially moved between
consecutive filings of the same form, with both periods' values, direction and a
materiality score. It does not come free from EDGAR; re-deriving it is most of the
work. Same hook as the 18-lead newsletter kit.

## Sent 2026-09-11 — from `support@stockportfolio.pro`

Sent via `mailer.js` `sendMail()` on an explicit owner decision overriding the
"never cold email from support@" rule (same override as the IR list in
`docs/growth/mcp-api-lab-outreach.md`, same day). Reply-To is support@, so replies
land there. SMTP accepted both; acceptance is not delivery confirmation.

| Sent | Recipient | Address | Subject | Evidence used |
|---|---|---|---|---|
| 2026-09-11 | Webull | `partner@webull.com` | SEC-derived filing-change data for company research surfaces (no quote data) | NVDA 10-Q vs prior: Vera Rubin shipping pulled forward; long-term debt 7,470 → 32,366 |
| 2026-09-11 | Stock Unlock | `support@stockunlock.com` | The filing-delta layer that does not come free from EDGAR (GE example) | GE 10-Q vs prior: IEEPA tariff refund stance reversed; air travel "up 1.7%" → "roughly flat" |

Every quotation in both bodies was a literal substring of an `evidenceVerified`
payload pulled from `filing_diffs` on 2026-09-11, with SEC source links included in
the mail. NVDA's supply-commitments item was **excluded** — it is flagged
`evidenceVerified: false` in the cache. Each body carried a one-line opt-out.

**Risk accepted, recorded so it isn't forgotten:** the `support@` transporter also
sends password resets, signup/verification, trial-expiry and AppSumo redemption mail.
If either recipient marks this as spam, the deliverability hit lands on that
transactional mail. This is the second override the same day — if activation or reset
emails start going missing, check here first.

**Not reachable by email** (LinkedIn/form/GitHub only, so no send was possible):
Monarch's decision-maker Erin Bream, Trading 212, eToro's data lead, TradingView,
Wealthfolio, Origin, Copilot, getquin/Portseido/Sharesight.

## Before the next send

1. Pull the real `changes[]` payload for the target's own ticker(s) from
   `filing_diffs` — no placeholder ever leaves the building (kit rule).
2. Run the 4-point check: quote matches payload, numbers cross-checked, no AI-provider
   identity, no advice-adjacent language.
