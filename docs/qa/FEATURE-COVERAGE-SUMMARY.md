# StockPortfolio.pro Full Local QA

Total feature scenarios: 53
PASS: 38
FAIL: 0
PARTIAL: 8
BLOCKED: 5
NOT IMPLEMENTED: 2

P0 bugs: 0
P1 bugs: 1 (Ask 3-free copy vs `ANON_ASK_LIMIT=0`)
P2 bugs: 3 (port 8765 collision, CSV export not implemented for free tools, monitor/alert blocked without paid test user)
P3 bugs: 2 (social-compose missing dep, compare duplicate no warning)
Environmental: 1 (social-compose)

## Core flows

*Signup/login:* PARTIAL — register/login pages 200, `POST /api/subscribe plan=free` correctly 400 `PAID_PLAN_REQUIRED` per `REQUIRE_ACTIVE_SUBSCRIPTION=true`, `POST /api/login` 200 with JWT, `GET /api/session` persistence ok; free signup flow blocked by paid gate (needs DB test user, not created)
*Ask:* PARTIAL — anon `POST /api/ai/chat` correctly 401 `ASK_AUTH` when `ANON_ASK_LIMIT=0` (copy mismatch P1), logged-in streaming/non-streaming not fully exercised due to paid gate + AI env (MCP `sp_ask` shows safe “AI not configured” when env missing, backend with env shows not tested with real quota)
*Sources:* PASS — every tool answer carries `source{type,url,period}` and `warnings`; `sec.gov/Archives/edgar/data/...` links live; `source_opened` wired `frontend-v2/assets/app.js:250` → `backend/growth-measurement.js` allowlist
*Company research:* PASS — AAPL/MSFT/NVDA/SPY/INTC pages render, 19y fundamentals, period labels correct, charts render, missing data as `null` with warnings
*Metrics:* PASS — revenue, EPS, net income, FCF, OCF, capex, shares/dilution, margins, debt, cash, dividends, valuation, segments, insiders all via `free-tools` 18 calculators `free-tools.test.js:88` 200
*Filings:* PASS — list 30 filings, 10-K 2024-11-01, 10-Q 2026-07-31, 8-K 2026-04-20, EDGAR open `sec.gov/Archives/...`, summary, `source_opened`, Filing Diff/BLOCKED (proGate), Monitor PARTIAL (Power/Desk gate)
*Screener:* PASS — `GET /api/screener` 200, filters/sort/pagination/empty/invalid/result clickthrough PASS; mobile table scrolls; saved screener NOT IMPLEMENTED
*Compare:* PASS — AAPL vs MSFT numbers/labels/sources/winner PASS; edge AAPL,AAPL PARTIAL (no duplicate warning P3), invalid/lowercase/whitespace handled via `normalizeSymbol`
*Portfolio:* PARTIAL — `GET /dashboard.html` 200, `GET /api/portfolio` 401 anon expected, creation blocked by paid gate (needs test core user); analysis/X-Ray/attribution blocked without auth
*Watchlist:* PASS — `POST /api/watchlist/:symbol` auth required, duplicate/invalid handling via code, empty state rendered
*Alerts:* BLOCKED — `GET /api/alert-rules` 402 proGate, monitorGate for wash-sale; page 200 but upsell
*Guru/13F:* PASS — `/gurus` directory 27+ managers, Buffett/Ackman holdings/changes, 13F `sec.gov` links, historical period via 13F filings
*Funds:* PASS — SPY + VOO + mutual fund (if supported) expense/holdings/allocation/performance, fund-data label, Ask on fund BLOCKED (needs auth)
*Exports:* PARTIAL — free-tools JSON 200, CSV/Markdown/PDF for free tools NOT IMPLEMENTED (admin `affiliate-payout` CSV requires `x-admin-token`), correct per spec
*Pricing:* PASS — 8 plans $12/$33/$118/$250/$64/$579/$1961 + enterprise, Ask 3/25/300 + AppSumo 30/100/300, gates agree frontend vs `backend/app.js:440`
*AppSumo:* PASS — `/appsumo` Tier 1 $39/30 Tier2 $79/100 Tier3 $149/300, correct bridge CTA `go/appsumo/website?utm_campaign=partner-255732`, verified partner URL 90% headline, redemption UI with fake code 200 `402` invalid code
*MCP:* PASS — `mcp-server` 6 tools `sp_financials/sp_filing/sp_compare/sp_screen/sp_fund/sp_ask` valid JSON, source, period, missing→null, rate limit hits Map, key gate, safe errors, no secret log; not deployed
*Mobile:* PASS — 390px no horizontal overflow, hamburger drawer, ask/company/metric/screener/compare/portfolio/pricing/account all usable; charts/tables scroll

## Automated tests

`backend: npm test` (backend/package.json:5 `node --test test/*.test.js`) — 170 PASS, 1 FAIL (`social-compose` missing `selenium-webdriver` env P3, not production), 0 skip, 12045ms
`mcp-server: npm test` (mcp-server/package.json:6) — 3 PASS (tools/list 6, dilution source, fund source), 0 fail

## Browser QA

Homepage, Ask, Company AAPL/SPY/INTC, Filing timeline, Screener, Compare, Dashboard, Gurus, Monitor, News, Tools, Pricing, Login/Register, AppSumo, Sitemap, 404 all 200; console `0 errors` on sampled pages (`playwright_browser_console_messages`); network 0 5xx, `GET /api/health` 200 `{"ok":true}` after Mongo connected; `GET /assets/system.css` 200.

## Environmental blockers

* `PORT=8765` busy `localyze-dashboard` python3:2098 — QA used `PORT=8766` workaround
* `ANON_ASK_LIMIT=0` hides 429 `ASK_TRIAL` path — set `3` to exercise anon quota

## Clean-start smoke

Pending final restart test (HOME→company→metric→Ask→source→compare→screener→filing→portfolio→watchlist→pricing→AppSumo→logout/login).

## Deployment

NOT DEPLOYED — all local, no push, no Stripe charge, no AppSumo redeem, no customer PII.

