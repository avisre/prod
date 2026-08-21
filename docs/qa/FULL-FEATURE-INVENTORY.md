# StockPortfolio.pro — Full Feature Inventory
**Date:** 2026-08-21  
**Source inspection (bounded, max 120 lines / 12KB per read):** `frontend-v2/*.html` (25 files), `backend/app.js` `grep -n "app\.\(get\|post\)"` (177 routes), `backend/free-tools.js` `TOOL_DEFINITIONS` (30 tools), `frontend-v2/assets/app.js` nav links, `PLAN_ID` grep in `backend/app.js`, `docs/` tree, `mcp-server/src/server.js` + README, `backend/ai-chat.js` limits, `backend/growth-measurement.js`. No production deploy or mutation.

Conventions: **Auth** = None | Optional | Required (authMiddleware). **Plan gate** = free (public) | core (any active paid) | pro (Pro/Power/Desk) | monitor (Power/Desk only). Tier ladder: `free < core < pro`; `monitor` is orthogonal Power/Desk entitlement. All `core`/`pro` gates return 402 when unmet; `AI_PRO_FOR_ALL=false` by default.

---

## 1. PUBLIC / MARKETING

| Feature | Route / Page | Description | Auth | Plan Gate |
|---|---|---|---|---|
| Homepage marketing | `/`, `/index.html`, `/v2`, `/landing-v2` | Hero, live filing strip, Ask/Dossier/Monitor marquee, pricing anchor, research library (1,500+ stocks), AppSumo badges | None | free |
| Features overview | `/features.html`, `/features` | Source-aware AI research — Ask, Monitor & Dossier explainer | None | free |
| Product tour (60s) | `/tour.html`, `/tour` + video `assets/tour-720p.mp4` | 60-second product tour with poster | None | free |
| Support / Contact | `/support.html`, `/support` + `POST /api/support` | Contact form → support inbox + DB; rate-limited | None (POST limited) | free |
| Legal: Privacy | `/privacy.html`, `/privacy` | Privacy policy (static) | None | free |
| Legal: Terms | `/terms.html`, `/terms` | Terms of use | None | free |
| Legal: Affiliate terms | `/affiliate-terms.html` | Customer Ambassador Terms | None | free |
| Sitemap (human) | `/sitemap.html`, `/sitemap` | Crawlable link hub; includes `/tools`, `/stocks`, `/screener`, etc. | None | free |
| SEO sitemap (XML) | `/sitemap.xml`, `/sitemaps/:shard.xml` | Sharded XML sitemap for crawlers (SSR) | None | free |
| Robots / LLMs / Security | `/robots.txt`, `/llms.txt`, `/llms-full.txt`, `/humans.txt`, `/.well-known/security.txt`, `/security.txt` | Crawler/AI disclosure & security.txt | None | free |
| SEO: Stocks index | `/stocks` | SSR list of US companies (search engine entry) | None | free |
| SEO: Stock page | `/stocks/:ticker` | SSR per-ticker filing page (title `… financials, ratios & health checks`) | None | free |
| SEO: Stocks metric | `/stocks/:ticker/:metric` | Metric history deep-links (alias via SEO router) | None | free |
| SEO: Comparison | `/compare/:pair`, `/vs/:competitor` | Side-by-side SSR comparison | None | free |
| SEO: Methodology etc. | `/methodology`, `/editorial-policy` | Methodology / editorial policy SSR pages | None | free |
| 404 | `/404.html` (+ catch-all) | Branded 404 | None | free |
| Markets / News | `/news.html`, `/news`, `GET /api/alpha/news` (coreGate), `GET /api/market/strip`, `GET /api/news-image` | Market movers + news headlines with image proxy; SSR + API | None for page; API `news` needs Core | free page / core for API |
| Campaign redirect | `/pricing` → `/#pricing` | Guessable URL → pricing anchor | None | free |
| Demo routes | `/demo`, `/demo/fundamentals`, `/demo-dashboard.html`, `/demo-fundamentals.html`, `GET /api/demo/*` | Demo portfolio & fundamentals without auth (public showcase) | None | free |

## 2. AUTH / ACCOUNT

| Feature | Route / Page | Description | Auth | Plan Gate |
|---|---|---|---|---|
| Register | `/register.html`, `/register` + `POST /api/subscribe` (email + plan) | Email registration, UTM & attribution capture, plan selection (`?plan=monthly\|annual\|pro\|pro-annual\|power\|power-monthly\|desk\|free`), trial handling | None → creates session | free → sets tier |
| Login | `/login.html`, `/login` + `POST /api/login` | Email/password login, sets `sp_auth` HttpOnly cookie + Bearer | None | free |
| Social login | `GET /api/auth/providers`, `POST /api/auth/social` (Google) | OAuth providers list + social signup/login; creates trial where applicable | None | free |
| Logout | `POST /api/logout` | Clears `sp_auth` cookie (host-only + apex domain) | Optional | free |
| Session | `GET /api/session` | Returns user + normalized subscription, tier | Required | free (returns tier) |
| Check email availability | `POST /api/check-email` | Pre-signup email validation (guard enumeration) | None | free |
| Forgot password | `/forgot-password.html` + `POST /api/password/forgot` | Sends reset email (rate-limited) | None | free |
| Reset password | `/reset-password.html` + `POST /api/password/reset` | Token-based reset | None | free |
| Change password (authed) | `POST /api/password/change` | Authed password change | Required | free |
| Onboarding | `/onboarding.html` | Post-signup first-research prompt (“Start your first research question”) | Required (or just-signed-up) | free |
| Account lifecycle | Stripe `POST /stripe/webhook`, `POST /api/billing/refund`, `POST /api/subscription/cancel`, `POST /api/checkout` | Subscription create/cancel/refund (7-day window), checkout upgrade, trial expiry to `free` | Required for billing ops | core/pro per plan |
| Admin comp grant (reviewers) | `POST /api/admin/comp` | Grants complimentary access | Admin key | — |

## 3. ASK / RESEARCH

| Feature | Route / Page | Description | Auth | Plan Gate |
|---|---|---|---|---|
| Ask AI (chat) | `/ask.html`, `POST /api/ai/chat` (askAuth shim) | Filing-grounded Q&A streaming SSE + non-stream; tools: fundamentals, filings, fund-data, live-web; citations + source class | **Anon teaser or Required** (askAuth: anon → trial, authed → metered) | **Quota gated** — not hard 402, but monthly limits (see Pricing). Anonymous trial limited by `ANON_ASK_LIMIT` (default 0/prod 1 if `ALLOW_ANON_AI=true`), per-IP 6/day, global 400/day |
| Ask quota | `GET /api/ai/chat/quota` | Returns `{used, limit, remaining}` | Required | tier-based |
| Ask feedback | `POST /api/ai/chat/feedback` | Thumbs up/down per exchange | Required | free for any authed |
| Research Dossier | `/dossier.html`, `GET /api/company/:symbol/keypoints` (optionalAuth), insights/segments behind pro | Auto-generated 10-K grounded report: key points extracted from latest 10-K (~20s first visit), financial record, thesis grading | Dossier page optional; `keypoints` optionalAuth; deeper dossier via AI Ask | `insights`/`segments` = **proGate**; `keypoints` free |
| Ask question builder (tool) | `/tools/ask-question-builder` (free tool) | Deterministic research-question builder from filed periods | None | free |
| Filing evidence checklist (tool) | `/tools/filing-evidence-checklist` | Checklist of primary SEC docs to verify a claim | None | free |
| Research dossier starter (tool) | `/tools/research-dossier-starter` | Filing links + headline metrics pack for dossier workflow | None | free |

**Quota defaults:** `AI_CHAT_FREE_LIMIT=3`, `AI_CHAT_CORE_LIMIT=25`, `AI_CHAT_PRO_LIMIT=300` per month; AppSumo/DealMirror caps via `effectiveAskLimit()` (cap = min(base, appsumoAiCap)). Month resets on 1st.

## 4. COMPANY / METRIC RESEARCH

| Feature | Route / Page | Description | Auth | Plan Gate |
|---|---|---|---|---|
| Company workspace | `/company.html`, `/company?symbol=AAPL` + `GET /api/assets/:symbol/profile`, `GET /api/assets/search` | Single instrument file: masthead price + chart (price/P/E + market-cap overlay), key numbers, About, peers, statements | `profile` None; page None | **Price/fundamentals API** → **coreGate** for Alpha time-series (`/api/alpha/*`) but profile/search public |
| Price chart + market strip | `GET /api/alpha/time-series/daily`, `/monthly`, `/quote/:symbol`, `/api/market/strip` | Daily/monthly prices, quote, movers; chart ranges 6M/1Y/5Y/10Y/Max; market strip ticker | Required + coreGate (daily/monthly/quote/movers) ; strip public | **core** |
| Fundamentals | `GET /api/alpha/fundamentals/:symbol`, `GET /api/demo/alpha/fundamentals/:symbol` | Up to 19y of filed fundamentals (XBRL), currency conversion to USD where requested | Required + coreGate | **core** |
| Key numbers grid | Rendered in `assets/company.js` from fundamentals | Revenue, net income, FCF, margins, etc., period-locked | Same as fundamentals | **core** for full history |
| About facts | Company description + facts table | From asset profile | None | free |
| Dossier link | Button `#co-dossier` → `/dossier.html?symbol=X` | Deep-link to dossier | Optional | free |
| Watch button | `POST /api/watchlist/:symbol` toggle | Add to watchlist from company page | Required | free (watchlist itself) |
| Reverse DCF | `GET /api/company/:symbol/reverse-dcf` | Implied growth calculator from filings + price | Required | **coreGate** |
| All fundamentals (free tools) | Single-ticker tools under `/tools/*` (see §5) | Deterministic filing calculations with period + EDGAR source | None | free |

## 5. FILINGS

| Feature | Route / Page | Description | Auth | Plan Gate |
|---|---|---|---|---|
| SEC filing list | `GET /api/company/:symbol/filings` | 10-K / 10-Q / 8-K / Form 4 timeline with dates + direct SEC EDGAR URLs | None | free |
| Filing diff (Pro) | `GET /api/company/:symbol/filing-diff` | Line-by-line filed financial diff (latest two annual periods) — the Pro differentiator | Required | **proGate** |
| Filing timeline tool | `/tools/filing-timeline` | Public timeline explorer (deterministic, paginated, split-aware) | None | free |
| Filing change detector | `/tools/filing-change` | Compares key filed line items across two annuals | None | free |
| Insider filings explorer | `/tools/insider-filings` + `GET /api/company/:symbol/insider-history` | Form 4 browsing with SEC links | None / API None | free |
| Institutional filings timeline | `/tools/institutional-filings` | Recent 13F filings for an entity (EDGAR) | None | free |
| Ownership (13F-derived) | `GET /api/company/:symbol/ownership` | Institutional ownership snapshot (Yahoo-derived label) | None | free |
| Segments (Pro) | `GET /api/company/:symbol/segments` | Revenue by segment (when filed) | Required | **proGate** |
| Insights (Pro) | `GET /api/company/:symbol/insights` | AI-generated insights (Pro, filing-grounded) | Required | **proGate** |
| AI summary (Pro) | `GET /api/stocks/:symbol/ai-summary` | One-shot AI company summary | Required | **proGate** |
| Keypoints (optional auth) | `GET /api/company/:symbol/keypoints` | Extracted 10-K key points | Optional | free |

Additional filing-grounded single-ticker free tools (all **None/free**, deterministic, no AI):
`earnings-quality` (`/tools/earnings-quality`), `dilution`, `revenue-consistency`, `profitability-trend`, `cash-flow-quality`, `free-cash-flow-trend`, `working-capital`, `debt-snapshot`, `buybacks-vs-dilution`, `stock-compensation`, `dividend-safety`, `interest-coverage`, `balance-sheet-signals`, `goodwill-concentration`, `receivables-warning`, `inventory-warning` — each shows period, refresh context, source link, warnings, and limitations.

## 6. SCREENERS

| Feature | Route / Page | Description | Auth | Plan Gate |
|---|---|---|---|---|
| Screener page | `/screener.html`, `/screener` (SSR injects default top-50) + `GET /api/screener` | 3,800+ US companies by filed fundamentals; filters: sector, market cap, PE, margins, CAGR, etc.; SSR crawlable rows | None | free |
| Screener API | `GET /api/screener?sector=&limit=50` | Deterministic filed-data screener JSON; sectors list via `sectorList()` | None | free |
| Company search (typeahead) | `GET /api/companies/top100`, `GET /api/companies/search`, `GET /api/search/:query`, `GET /api/alpha/search` | Top 100 + fuzzy search (nav + screener + portfolio add) | `top100/search/:query` Required; `alpha/search` Required | free (no gate) |
| Asset search (public) | `GET /api/assets/search?q=&limit=10` | Public ticker/name search for tools & nav | None | free |
| Screener→company activation | Funnel event `screener_company` | Counts as meaningful activation for growth metrics | Required (attributed) | — |

## 7. COMPARE

| Feature | Route / Page | Description | Auth | Plan Gate |
|---|---|---|---|---|
| Compare page | `/compare` (nav) + SSR `/compare/:pair` & `/vs/:competitor` | Company-to-company compare; same as screener comparison flow | None | free |
| Company snapshot compare (tool) | `/tools/company-comparison` | Two tickers side-by-side: revenue, margins, OCF, share count, FCF; flags stronger figure; period-separated | None | free |
| Peer cash-conversion ranking (tool) | `/tools/peer-cash-conversion` | Rank up to 10 peers by OCF / net income (latest filed) | None | free |
| In-company peers table | `#peers-section` in `company.html` | Same-sector S&P 1500 peers by market cap; compare input → `#cmp-table` + indexed price chart | None render; data from profile/fundamentals | free |

## 8. PORTFOLIO

| Feature | Route / Page | Description | Auth | Plan Gate |
|---|---|---|---|---|
| Portfolio tracker | `/dashboard.html`, `/dashboard` | Holdings table, total value, inception gain, sector allocation, price sparkline, add/remove holdings | Required | **coreGate** (entire portfolio) |
| Portfolio CRUD | `GET /api/portfolio`, `POST /api/portfolio` (add/update with shares, purchasePrice), `POST /api/portfolio` delete flow | Enriched holdings (name, sector, currentPrice, value) + historical price reconciliation | Required | **coreGate** |
| Portfolio X-Ray | `GET /api/portfolio/xray` | Sector / fund-category concentration + overlap diagnostics (cached) | Required | **coreGate** |
| Demo portfolio | `/dashboard.html?demo=1`, `GET /api/demo/portfolio` | 5-holding demo (AAPL/MSFT/JNJ/JPM/XOM) with indicative prices, public | None | free |
| Reverse DCF (per holding) | `GET /api/company/:symbol/reverse-dcf` (also portfolio context) | Implied growth from filings+price | Required | **coreGate** |
| Holdings autocomplete | Shared `assets/app.js` `searchAssets` in dashboard add-input | Ticker suggest without navigating away | Required | free |

## 9. WATCHLIST / ALERTS / MONITORING

| Feature | Route / Page | Description | Auth | Plan Gate |
|---|---|---|---|---|
| Watchlist | `POST /api/watchlist/:symbol`, `GET /api/watchlist` (+ toggle on `company.html` `☆ Watch`) | Flat set of tickers per user; stores symbol + enriched name/sector/marketCap etc. | Required | free for any authed user |
| Alerts inbox | `GET /api/alerts`, `POST /api/alerts/seen` | Periodic filing / price alerts feed; “seen” marker | Required | free |
| Smart alert rules (Pro) | `GET /api/alert-rules`, `POST /api/alert-rules`, `DELETE /api/alert-rules/:id` | User valuation thresholds (Pro, `backend/smart-alerts.js`) | Required | **proGate** |
| Filing Change Monitor | `/monitor.html`, `/monitor-demo.html`, `/monitor` | Power feature: reads latest 10-K/10-Q/8-K for watched symbols, narrates material changes with citations, ranks by materiality; separates newer 8-K event filings from periodic comparison; deep-links to EDGAR doc, `ask.html`, `dossier.html`, statements | Page None (shows upgrade); API for monitor is **not** a standalone key but rendered via dossier/filing-diff + `monitor.js` | **monitorGate** (Power, Power-monthly, Desk, Enterprise) — Pro explicitly excluded (Filing Diff is Pro, Monitor is Power/Desk) |
| Wash-sale guard (Monitor) | `POST /api/tax/import`, `GET /api/tax/accounts`, `DELETE /api/tax/accounts/:account`, `GET /api/tax/wash-sales`, `GET /api/tax/wash-check?symbol=X` | Cross-account CSV import, wash-sale report, pre-trade check (`backend/wash-sale.js`) | Required | **monitorGate** |
| Portfolio alerts in dashboard | Dashboard `notice alert-link` strip per holding | Latest filing headline + EDGAR link; rendered via portfolio briefing/alerts join | Required | **core** for briefing, **monitor** for wash |

## 10. GURU / 13F

| Feature | Route / Page | Description | Auth | Plan Gate |
|---|---|---|---|---|
| Guru directory | `/gurus.html`, `/gurus` | 27+ famous investors (Buffett, Ackman, Burry, Klarman…) — delayed 13F disclosures, not live signals | None | free |
| Guru holdings list | `GET /api/gurus`, `GET /api/gurus/:id` (+ `backend/gurus.js`) | List + per-guru holdings: positions, weights, adds/increases/decreases/removals vs prior quarter; source EDGAR 13F-HR | List None; holdings `optionalAuth` | **Free for perf+activity; analysis gated** |
| Guru AI analysis | `GET /api/gurus/:id/analysis` | On-demand AI analysis of guru portfolio | Required | **proGate** (tier-aware response: `pro` = full, `core` = strip analysis, `free` = extra gating) |

## 11. ETF / MUTUAL FUNDS

| Feature | Route / Page | Description | Auth | Plan Gate |
|---|---|---|---|---|
| Fund workspace | `GET /api/assets/:symbol/profile` (fund profile path), `fund-profile` section in `company.html` (`#fund-section`) | Costs, holdings, allocation, performance, risk for ETFs/MFs (Yahoo fund profile; never presented as 10-K) | None | free |
| ETF overlap (tool) | `/tools/etf-overlap` | Shared top holdings of two ETFs (multi-ticker) | None | free |
| ETF sector concentration (tool) | `/tools/etf-sector-concentration` | Sector weights + top-holding concentration via latest reported profile | None | free |
| Dossier/monitor separation | Fund-flag in `asset-profile.isFundAsset()` | Labels fund data vs `filed` to prevent misrepresentation | — | — |

## 12. EXPORTS

| Feature | Route / Page | Description | Auth | Plan Gate |
|---|---|---|---|---|
| Marketing tools CSV | `GET /api/admin/marketing-tools.csv?format=csv` (inside `GET /api/marketing/tools` handling) | Export of research-interest rows; streams `text/csv` | Admin / marketingDashboardOnly | — |
| Customer export (admin) | `GET /api/admin/customers.csv?format=csv&source=stripe\|appsumo` | Mongo User export for ops | `affiliateAdminAuth`/`marketingDashboardOnly` | — |
| Affiliate payout CSV | `GET /api/admin/affiliates/payout-batches/:id.csv` | Affiliates payout batch receipt CSV | `affiliateAdminAuth` | — |
| Share-copy + Research shares | `POST /api/ai/share-copy` (optionalAuth), `POST /api/research-shares` (optionalAuth), `GET /r/:id` | Deterministic share link generation for AI answers / research snapshots; public `/r/:id` render (affiliate refs via `amb-`) | Optional | free |
| DealMirror / AppSumo CSV reconcile | `POST /api/admin/dealmirror/reconcile`, `POST /api/admin/affiliates/payout-batches/:id.csv` + affiliate CSV reconcile | Admin CSV ingestion for entitlements | Admin auth | — |

Note: No bulk portfolio CSV download for end users in Phase 1; exports are admin/ops + share links.

## 13. EMAIL / BRIEFINGS

| Feature | Route / Page | Description | Auth | Plan Gate |
|---|---|---|---|---|
| Weekly portfolio briefing | `GET /api/portfolio/briefing` | Deterministic, non-LLM template briefing per portfolio (value, holdings narrative); 500-entry cache, `no-store` on sample | Required | **coreGate** |
| Sample briefing | `GET /api/portfolio/briefing/sample` | Demo briefing for free/logged-out users (preview of paid feature) | None | free |
| Transactional email | `backend/mailer.js` + `POST /api/subscribe` signup emails, `POST /api/support` ticket mail, AppSumo onboarding | Owner + user onboarding, trial notify, support ticket → `support@stockportfolio.pro` / owner | Triggered by server events | free |
| AppSumo onboarding email | `appsumo_onboarding` template (dedupe `appsumo-onboarding:userId`) | Post-redemption onboarding (fire-and-forget) | After redemption | appsumo tier |
| Review / activation emails | `activation_completed`, `research_outcome_completed`, `support_outcome_confirmed` tracking → lifecycle email gate | 3× “Yes, clearly” required before affiliate enable; `review_eligible` tracking | Server events | — |
| Email observability (admin) | `GET /api/admin/growth/august-2026` dashboard section | Scheduled/attempted/sent/failed/suppressed/duplicate-prevented counts (application delivery only) | marketingDashboardOnly | — |

## 14. GROWTH / ATTRIBUTION

| Feature | Route / Page | Description | Auth | Plan Gate |
|---|---|---|---|---|
| Campaign config | `GET /api/campaign/config`, `GET /api/campaign/august-2026` | Signed campaign cookie, deadline label, GMV target | None | free |
| AppSumo redirect tracking | `GET /go/appsumo/:source` | UTM + campaign-aware outbound to AppSumo with attribution pass-through | None | free |
| Funnel events (server) | `POST /api/track/event`, `POST /api/track/page_view`, `POST /api/track/seo_event`, `POST /api/track/free_tool_view/complete` via `growth-measurement.js` + `marketing-attribution.js` | Canonical events `growth-measurement-v1` → Mongo `funnel_events` + GA4 mapping; validates `{consent:true}` + allowlisted path/contentId/featureType; caps 900/15min global, beacon-specific limiter | OptionalAuth / None (browser beacon) | free; browser events only allow pageType/pathname/contentId/CTA; server-only events (purchase/refund/activation) cannot be self-attested |
| Browser growth beacons | `V2.trackGrowthEvent()`, `V2.trackCustomerSuccess()`, `getStoredUtm()`, `window.spGrowthTrack` in `assets/app.js` | `pricing_viewed`, `cta_clicked`, `appsumo_outbound_clicked`, `signup_started`, `checkout_started`, `source_opened`, `proof_view`, `second_session`, etc. | None | free |
| Attribution storage | `user.analyticsAnonymousId`, `analyticsFirstTouch`, `analyticsLastNonDirectTouch`, `signupUtm` | First-touch / last-non-direct-touch UTM capture at signup | At signup | free |
| Growth measurement v1 | `backend/growth-measurement.js` (`SCHEMA_VERSION=growth-measurement-v1`) | Normalizes `eventName`, `source`, `pagePath`, `term` etc.; GA4 alias map, 30+ EVENT_NAMES | — | — |
| SEO events | `trackSeoEvent()` → `/api/track/seo_event` | Proof views, internal link audits | None | free |
| August sprint dashboard | `GET /api/admin/growth/august-2026`, `POST /api/admin/growth/gmv`, `GET /api/admin/growth/gmv`, `GET /api/admin/growth/content` | Manual GMV snapshots + meaningful activation counts + customer-success gate (3× yes) | marketingDashboardOnly | — |
| Ollama usage stream | `GET /api/admin/ollama/usage`, `…/usage/stream` | AI provider observability (not user-facing) | marketingDashboardOnly | — |

**Event dictionary** lives in `docs/analytics/event-dictionary.md`; GA4 checklist in `ga4-checklist.md`.

## 15. APPSUMO

| Feature | Route / Page | Description | Auth | Plan Gate |
|---|---|---|---|---|
| AppSumo landing | `/appsumo.html`, `/appsumo` (SSR) + `GET /go/appsumo/:source` | Lifetime deal page with CTA `data-appsumo-campaign-link`, deadline, pricing comparison | None | free |
| AppSumo redeem (lifetime) | `/appsumo/redeem` (SSR) → onboarding flow + `POST /api/appsumo/activate` | Links AppSumo licence key to StockPortfolio.pro account; one licence per account, no stacking | Required | appsumo entitlement (Tier 1 Ask 30, Tier 2 Ask 100, Tier 3 Ask 300) |
| AppSumo webhook (IPN) | `GET /appsumo/webhook` (health), `POST /appsumo/webhook` (raw) | AppSumo purchase/revoke → commission record, tier assignment, `appsumoAiCap` | AppSumo signature | — |
| DealMirror redeem (parallel) | `/dealmirror/redeem` → `frontend-v2/dealmirror-redeem.html` + `POST /api/dealmirror/redeem` (auth + `dealMirrorRedeemLimiter`) | Alternate lifetime deal (single named user, no commercial/API/bulk export); fixed monthly limits; redemption deadline | Required | dealmirror tier (maps to Pro ladder) |
| AppSumo outbound CTA | `data-appsumo-campaign-link` in every free-tool CTA panel | “Explore StockPortfolio.pro on AppSumo →” with `contentId` tracking | None | free |

## 16. PRICING / ENTITLEMENTS

| Plan | ID | Price | Interval | Trial | Tier | Entitlement (code) |
|---|---|---|---|---|---|---|
| Free | `free` | $0 | — | 0 | free | Public surfaces only; free/tools, screener, company search, demo, guru list; Ask quota 3 |
| Monthly (Core) | `monthly` | $12 | month | 7 days (no-card Pro trial) | core | `coreGate`: portfolio, fundamentals/quote/time-series/movers/news, reverse-dcf, briefing, X-Ray, alerts inbox, screener (already free) — Ask 25 |
| Annual (Core) | `annual` | $118 | year | 0 | core | Same as Monthly; **no trial** |
| Pro Monthly | `pro` | $33 | month | 7 days | pro | Core + `proGate`: Ask 300, filing-diff, attribution, smart alert-rules, segments, insights, AI summary, guru analysis, watch-sale guard? No (monitorGate). |
| Pro Annual | `pro-annual` | $250 | year | 0 | pro | Same as Pro Monthly, annual billing, **no trial** |
| Power Annual | `power` | $579 | year | 0 | pro + monitor | Pro + `monitorGate`: Filing Change Monitor + wash-sale guard (all tax routes) |
| Power Monthly | `power-monthly` | $64 | month | 0 | pro + monitor | Same as Power Annual, monthly |
| Desk | `desk` | $1,961 | year | 0 | pro + monitor | Power + RIA/fund positioning, professional support |
| Enterprise | `enterprise` | Contact | — | 0 | pro + monitor | Custom (implicit in `hasMonitor()` check) |

**Stripe mapping:** `PLAN_DEFINITIONS[planId]` with `amount/currency/interval/productName`; `STRIPE_PRICE_ID_*` env vars; `createStripeSubscription` trial handling via `trial_period_days`. `NO_TRIAL_PLAN_IDS = [annual, pro-annual, power, power-monthly, desk, enterprise]`. `requireInitialStripePayment` toggles free-tier checkout requirement.

**AppSumo mapping:** `APPSUMO_TIER_CONFIG {1: Starter 30, 2: Investor 100, 3: Pro 300}` → `appsumoAiCap`; `effectiveAskLimit() = min(base tier limit, appsumoAiCap)`; caps never exceed Pro quota. DealMirror mirrors Pro ladder with per-tier askCap.

**Upgrade surfaces:** Pricing anchor `/#pricing` in `index.html` (monthly/annual toggle, pro/power/desk cards), `monitor.js` Power/Desk CTAs, `dashboard.js` 402 prompts → `/register.html?plan=X`, `app.js` nav Upgrade chip + `V2` banner; `dealmirror-redeem.html` no-card trial ladder in `userTier()`.

## 17. MCP PHASE 1

| Feature | Route / Page | Description | Auth | Plan Gate |
|---|---|---|---|---|
| STDIO MCP server | `mcp-server/src/server.js` (`stockportfolio-mcp@0.1.0`, `@modelcontextprotocol/sdk`, `zod`) + `mcp-server/README.md` | Thin wrapper over `free-tools.js` + `asset-profile.js` + `ai-chat.js`; every return includes `source {type, url, period, note}` + `warnings`; no estimates; config `~/.config/Claude/claude_desktop_config.json` example | `MCP_API_KEY` env (pass `apiKey` per tool); rate `MCP_RATE_LIMIT` default 30/min (`RATE_LIMITED`) | free (Phase 1 has no paid quota; Phase 2 HTTP API will enforce per-key monthly caps) |
| `sp_financials(ticker, tool?)` | MCP tool | Filed figures: default `earnings-quality`; alt `dilution`, `buybacks-vs-dilution`, `filing-timeline`, `revenue-consistency`, etc.; period-locked, SEC source | key | free |
| `sp_filing(ticker)` | MCP tool | 10-K/10-Q/8-K/Form 4 timeline with EDGAR links | key | free |
| `sp_compare(tickers="AAPL,MSFT")` | MCP tool | Side-by-side latest filed annuals | key | free |
| `sp_screen(tickers="AAPL,MSFT…")` | MCP tool | Watchlist ranking (max 10) via `portfolio-revenue` deterministic path; hint when empty | key | free |
| `sp_fund(symbol)` | MCP tool | ETF/MF costs/holdings/allocation (labelled `fund-data`, never as 10-K) | key | free |
| `sp_ask(question)` | MCP tool | Filing-grounded answer + `sourceClass` (`filed / fund-data / live-web`); non-streaming `aiChat.ask()` | key | free (Phase 1) |

Phase 2/3 explicitly deferred: compound alerts, MD/PDF export. Server logs `stockportfolio-mcp 0.1.0 listening on stdio (6 tools, source on every return)`.

## 18. MOBILE / RESPONSIVE

| Feature | Route / Page | Description | Auth | Plan Gate |
|---|---|---|---|---|
| Responsive layout | All `frontend-v2/*.html` + `assets/system.css?v=20260728-tools1` (Inter font, CSS vars) | Fluid containers, `flex-wrap`, `grid` breakpoints; chart responsive (`chart-wrap`), table horizontal scroll (`table-wrap`, `attachHScroll`) | None | free |
| Mobile nav drawer | `assets/app.js` `nav()` `#v2-ham` + `#v2-mobile-nav` (`nav-mobile-dim`, `nav-mobile-panel`, `role=dialog`) | Hamburger → slide-in panel (NOT nested in header); links: Screener, Tools, Compare, Stocks & funds, Markets, Ask AI, Research Dossier, Filing Monitor, Portfolio, Guru Portfolios, Pricing; auth buttons swap via `token` | None | free |
| Nav search (mobile) | `#v2-search-results` + `searchAssets` | Same typeahead as desktop, capped 10, hidden until input | None for public search; gated data behind core where applicable | free |
| Touch targets | `btn`, `seg` (chart/market-cap), `chip`, `nav-mobile-close` | 44px-ish tappable buttons (`btn-sm`, `btn-primary`, `btn-ghost`, `btn-quiet`) | None | free |
| Viewport + noindex | `<meta name="viewport" content="width=device-width,initial-scale=1">` + `dashboard.html`/`ask.html` robots `noindex` where appropriate | Mobile scaling; private pages not indexed | None | free |
| Progressive disclosure | Company `clamp` + “Read more ▾” (`#about-more`), dossier lazy-load (`#kp-body` skeleton → 10-K extraction), funding via `V2.mountAsk` | Keeps mobile payload small | — | — |

---

### Checklist: every `frontend-v2/*.html` mapped

`404.html`→PUBLIC, `affiliate-terms.html`→PUBLIC, `appsumo.html`→APPSUMO, `ask.html`→ASK, `company.html`→COMPANY/FILINGS/ETF, `dashboard.html`→PORTFOLIO, `dealmirror-redeem.html`→APPSUMO, `dossier.html`→ASK, `features.html`→PUBLIC, `forgot-password.html`→AUTH, `gurus.html`→GURU, `index.html`→PUBLIC/PRICING, `login.html`→AUTH, `monitor-demo.html`+`monitor.html`→WATCHLIST/MONITORING, `news.html`→PUBLIC, `onboarding.html`→AUTH, `privacy.html`→PUBLIC, `register.html`→AUTH/PRICING, `reset-password.html`→AUTH, `screener.html`→SCREENERS, `sitemap.html`→PUBLIC, `support.html`→PUBLIC, `terms.html`→PUBLIC, `tour.html`→PUBLIC.

### Source completeness note

Backend `app.js` gates audited: `coreGate` (portfolio, fundamentals, time-series, movers, news, reverse-dcf, briefing, xray), `proGate` (ask 300, portfolio/ask strict, attribution, alert-rules, insights/segments/filing-diff/ai-summary, guru analysis*), `monitorGate` (tax import/accounts/wash), `askAuth` anonymous shim. Free-tool routes (`/tools`, `/api/free-tools/:tool`, `GET /sitemaps/:shard.xml`, `GET /api/screener`, `GET /api/assets/search`, `GET /api/company/:symbol/filings`, `GET /api/company/:symbol/ownership`, `GET /api/gurus`) remain public by design.

---

*Generated for QA — do not deploy. Verify locally (`npm run build` / smoke `frontend-v2/` + `backend/`), then update `.claude/HANDOFF.md` per phase lifecycle before any push.*
