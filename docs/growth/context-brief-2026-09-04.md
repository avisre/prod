# StockPortfolio.pro — Context Briefing for Strategy Session

**Generated:** 2026-09-04, ~20:00 IST. Everything below was verified live during this session — nothing pulled from memory or prior docs without a fresh check. Sources are tagged per fact.

---

## 1. Git state

Source: `git log -5 --oneline`, `git status`, `git diff --stat`, `git rev-parse HEAD` (run in `/Users/drasharaghavan/prod`, 2026-09-04).

**HEAD:** `e2993088e4657aa75f275b66ca2ee379bb323bf8` on `main`, up to date with `origin/main`.

```
e2993088 Fix Ask citing stale 10-K as latest (search_filings ranks by relevance, not date)
d4bcfec5 HANDOFF: record 9/3 deploy — filing-change pages, fund-data fix, sitemap race
8936689f Fix: diffs sitemap shard invisible for 90 minutes after every restart
5712ec80 Public per-company filing-change pages + unblock partner affiliates
e66479cf Fund data: derive calendar-year returns, 404 unknown tickers, fix inverse-fund detection
```

**Uncommitted changes** (working tree, not staged):
- `backend/ai-chat.js` — 1-line diff, exports `toolSearchFilings` from the module (support wiring for the already-committed HEAD fix, itself not yet exported until this line lands).
- `backend/app.js` — new admin marketing-dashboard panel: breaks the GA4 "(direct)/(none)" bucket open by user-agent + landing page (`directBreakdownRows`/`directBreakdownPanel`), and flags known AI-assistant fetch signatures (`chatgpt-user`, `claude-user`, `perplexity-user`, `google-extended`, `anthropic-ai`, `meta-externalagent`, `cohere-ai`, `oai-searchbot`) as a distinct `ai_agent` traffic class instead of counting them as anonymous humans.
- `backend/marketing-attribution.js` — the UA-classifier half of the same change (`classifyUserAgent` gains the `ai_agent` branch).
- `backend/package-lock.json` — lockfile churn (61 lines), not inspected further.
- **Untracked:** `.claude/settings.json`, `backend/test/search-filings-accuracy.test.js`.

**This uncommitted work is not mentioned anywhere in `.claude/HANDOFF.md`.** It looks like an in-progress, undocumented feature (AI-agent traffic attribution on the internal marketing dashboard) layered on top of the already-committed `search_filings` fix. Treat it as WIP, not shipped, not reviewed.

**Drift vs CLAUDE.md:** the project's `CLAUDE.md` states *"There is no local `.git`. Pushing means cloning `avisre/prod` into the scratchpad..."* — this is **stale**. This working directory has a live `.git` with `origin` set to `https://github.com/avisre/prod.git`, and `main` is tracking `origin/main` directly. No clone-and-copy dance was needed to read git state this session. Worth correcting in CLAUDE.md, or at minimum treating that line as no longer reliable.

**Drift vs HANDOFF.md:** HANDOFF's top entry (dated 9/4) says the `search_filings` fix is *"FIXED LOCALLY, NOT DEPLOYED"* and frames it as a clean, complete change. In fact HEAD (`e2993088`) is already **pushed to `origin/main`** (`git status` confirms, and GitHub's `pushedAt: 2026-09-04T12:40:44Z` matches — see §3). What's *actually* still local-only is the smaller `toolSearchFilings` export line plus the unrelated marketing-attribution work. So "pushed to GitHub" and "deployed to Render" are two different unfinished states here, and HANDOFF conflates them — see §3 for why deploy is the part that's actually stuck.

---

## 2. Live prod check

All fetched live, 2026-09-04 ~20:00 IST.

| URL | Status |
|---|---|
| `https://stockportfolio.pro/api/health` | `{"ok":true}` |
| `https://stockportfolio.pro/pricing` | 200, tiers below |
| `https://stockportfolio.pro/llms.txt` | 200, tiers below |
| `https://stockportfolio.pro/verify-ledger` | 200, live claim-check table |

**`/pricing` tiers (exact, as served):**
- **Good (Monthly)** — $24.99/mo — 19yr statements, peer comparison, portfolio tracker, **50 Ask questions/month**, CSV export
- **Good (Annual)** — $199.99/yr ($16.67/mo effective, "saves $100 annually")
- **Pro** — $499.99/yr — 300 Ask/mo, Filing Change Monitor, Wash-sale guard, Filing Diff, Smart alerts, Daily attribution, Weekly portfolio briefing
- **Desk** — $1,999.99/yr — everything in Pro + client-facing commercial license for one named professional, priority support, onboarding call
- **Enterprise** — custom quote — multi-seat, custom coverage, security review support, dedicated contact
- **Lifetime** — AppSumo only, price not shown on `/pricing` itself

**`/llms.txt` tiers (exact, as served):**
- Free — screener + stock pages
- Monthly — $24.99/mo — **25 Ask questions monthly**
- Annual — $199.99/yr
- Pro — $499.99/yr — 300 Ask/mo, Dossier + Filing Diff
- Desk — $1,999.99/yr — professional license, priority support
- Credit top-ups — $14.99 for 150 credits

**🚩 MISMATCH FLAGGED:** `/pricing` advertises **50 Ask questions/month** on the Good/Monthly tier; `/llms.txt` says **25**. These are two live, currently-served pages describing the same tier with different numbers. This is exactly the kind of discrepancy an LLM (including whatever's answering via `/ask` or being crawled by AI agents — see the uncommitted `ai_agent` traffic-class work in §1) would surface inconsistently to a user or a crawler. Needs a decision on which number is correct and a fix to whichever page is wrong.

**`/verify-ledger`** — live "Claim Ledger" fact-check tool comparing headlines to filings. Currently tracks 4 tickers (AMD, MSFT, AAPL, NVDA), 5 rows, all showing "Headline vs Filing — numbers differ" or period-mismatch verdicts. Sample figures visible: AMD revenue $35B, MSFT FCF $332B, AAPL revenue $416B, NVDA revenue $216B, with filing periods spanning 2025-09-30 through 2026-06-30. This page isn't mentioned in `docs/growth/EXECUTIVE-ANSWER.md` (dated 8/21) or `.claude/HANDOFF.md`'s recent entries — it exists and is live, but its provenance/ship date wasn't traceable from the docs checked this session.

---

## 3. Deploy status — Render `srv-d4kc6schg0os73al6t10`

Source: leftover session artifacts `/private/tmp/render-service.json` and `/private/tmp/render-log.json` (both timestamped 2026-09-04 19:29–19:30 IST, i.e. from earlier in *this* session — not stale), plus `gh repo view avisre/prod`.

**Service config** (`render-service.json`):
- `autoDeploy: yes`, trigger on `commit`, branch `main`, repo `https://github.com/avisre/prod`
- Region: Frankfurt, plan: starter, `updatedAt: 2026-09-04T12:46:38Z`
- Live URL: `https://prod-gpln.onrender.com`

**Most recent deploy log** (`render-log.json`, timestamps UTC 2026-09-04 12:40:48–12:41:43):
```
==> Downloading cache...
==> It looks like we don't have access to your repo, but we'll try to clone it anyway.
==> Cloning from https://github.com/avisre/prod
fatal: could not read Username for 'https://github.com': terminal prompts disabled
==> Retrying git clone...   (×5, same fatal error each time)
==> Unable to clone https://github.com/avisre/prod
```

**Repo visibility right now** (`gh repo view avisre/prod`): `"visibility":"PRIVATE"`, `"pushedAt":"2026-09-04T12:40:44Z"`.

**Conclusion: the most recent deploy attempt (12:40–12:41 UTC today) FAILED** because the repo was private at the moment Render tried to clone it — consistent with HANDOFF's documented deploy dance (`../trigger-deploy.sh`: flip public → deploy → flip back), which apparently either wasn't run this time or the timing raced the flip. **Prod is very likely still serving whatever commit was live before this attempt — not `e2993088`.** I could not confirm prod's exact deployed commit (no version/commit field in `/api/health` — it only returns `{"ok":true}`), and I do not have `RENDER_API_KEY` in this session (searched home directory and env vars, not found) to query the Deploys API directly for a definitive last-successful-deploy SHA.

**Action needed:** re-run the flip-public → deploy → flip-private dance (per HANDOFF's "Render / deploy mechanics" section) to actually ship `e2993088` (and decide whether to also commit+ship the pending `ai-chat.js`/`app.js`/`marketing-attribution.js` changes from §1 first, or ship them separately).

---

## 4. Repo docs — what's new/changed

Source: `find docs/growth -mtime -14`, `find docs/qa -mtime -14`, reading `.claude/HANDOFF.md` in full.

**Note on the 14-day filter:** every file in `docs/growth/` and `docs/qa/` currently has an mtime inside the last 14 days (all show `Sep 3 23:15` as their last-modified time — that reads as a bulk touch/checkout event, not 30+ genuinely-edited files). Filtering by mtime alone doesn't distinguish "recently written" from "recently touched by tooling," so treat the list below as content-based, not mtime-based.

**`.claude/HANDOFF.md`** (full, read this session) is the single most current source of truth in the repo and is far more current than anything in `docs/growth/`. Highlights, newest first:
- **9/4, not yet resolved live:** the `search_filings` stale-10-K bug traced to a real AppSumo refund (buyer Khaled Aziz — got NVIDIA's FY2025 10-K when FY2026 was already cached). Fix committed as `e2993088` but — per §3 above — **not confirmed live**. A courtesy reply to the buyer is queued but not sent, pending deploy.
- **9/3, confirmed deployed:** fund-data `performance` fix (was returning `{null,null,null,null}` on `/api/assets/:symbol/profile`), filing-change public pages (`/filing-changes/:symbol`), affiliate `partner`-kind 409 bug fix, and a subtle bug found only by verifying: the sitemap's `diffs` shard was invisible in the sitemap **index** for 90 minutes after every restart (two separate caches populate before the boot+20s snapshot). Now fixed.
- **9/3, built then deliberately stripped:** an A–E ETF quality-grading feature was fully built, tested (466/466), then removed same-day because Yahoo's underlying data had a **100× expense-ratio error on FXAIX** with no reliable way to detect bad figures — owner's call: "if we can't verify it we won't have it." Three unrelated bug fixes found during that work were kept.
- **9/2–9/3:** AI menu reorder, MRR/referral kit (GATTOMORTO promo live), monitor-cap v2 shipped dark (env var still blank, so inert), a graphite rebrand tried and fully reverted same day (owner rejected it on sight).
- **9/1:** Strategy v3 approved as the operating plan (`notes/2026-09-01-stripe-2000-strategy-v3.md`) — three engines (warm humans, founder-led B2B, Intelligence founding $149/yr SKU), honest bound of $2,000/mo recurring over 9–15 months conditional on B2B converting, $300–700/mo realistic 90-day case. Week-1 forensics done: direct-Stripe channel has never converted ($0 MRR ever), AppSumo is the only proven paying channel.
- **Owner actions still pending** (HANDOFF's own list): trigger the Render deploy (directly relevant — see §3), two live payment-link/checkout+refund tests, revoke an old PAT, rotate the Bing key, decide on AppSumo listing v3 submission, and rotate several secrets that were pasted into a chat session on 9/1 (Stripe secret key, SMTP pass, JWT secret, Google client secret, AI keys) — **this has apparently not happened yet as of this session** based on HANDOFF's phrasing ("at the next deploy window, snapshot first").

**`docs/growth/EXECUTIVE-ANSWER.md`** is dated **21 August 2026** — 14 days old as of today, right at the edge of "recent" but its numbers are meaningfully stale next to HANDOFF:
- States 9 AppSumo orders total, $801 gross GMV, $0 refunds through Aug 20.
- HANDOFF's 9/2 and 9/4 entries describe **two additional AppSumo refunds** since then (Khaled Aziz's traced refund, plus one earlier untraceable one) — so EXECUTIVE-ANSWER's "zero refunds" and 9-order count are **out of date**. Do not quote EXECUTIVE-ANSWER's revenue table as current without re-pulling the AppSumo portal (see §6).
- Its core thesis (AppSumo is the only proven channel, direct-Stripe is $0 net, Ask is the retention driver) is still directionally consistent with HANDOFF's more recent notes — the *strategy* hasn't been contradicted, only the specific revenue figures have aged.

No other file under `docs/growth/` or `docs/qa/` was read in full this session beyond `EXECUTIVE-ANSWER.md`, `BUGS-2026-08-21.md`, and `FEATURE-COVERAGE-SUMMARY.md` (see §5). The other ~28 files in `docs/growth/` (competitor map, funnel analysis, buyer psychology, SEO research, etc.) were not opened — listed by filename only in §7 if a deeper pull is wanted later.

---

## 5. Open bugs

Source: `docs/qa/BUGS-2026-08-21.md` and `docs/qa/FEATURE-COVERAGE-SUMMARY.md`, both dated 21 August 2026 — **this is the only bug list in the repo; there is no newer one.** Treat everything below as 14-day-old local-QA findings, not re-verified live this session (verifying them live was out of scope for this pass — flagged as a gap, not silently assumed current).

Summary at time of writing (8/21): 53 scenarios — 38 PASS, 0 FAIL, 8 PARTIAL, 5 BLOCKED, 2 NOT IMPLEMENTED. P0: 0, P1: 1, P2: 3, P3: 2, Environmental: 1.

| ID | Severity | Summary | Status as of 8/21 |
|---|---|---|---|
| BUG-001 | P1 | Homepage implies "3 free Ask questions, no signup"; `ANON_ASK_LIMIT=0` in practice means anon Ask 401s immediately — marketing/config mismatch | NOT FIXED — needs owner decision (set env to 3, or change copy) |
| BUG-002 | P2 | Local dev-only: port 8765 collides with an unrelated `localyze-dashboard` process | WORKAROUND (use 8766), environmental, not prod-relevant |
| BUG-003 | P3 | `npm test` 1/171 fails: `social-compose.test.js` needs `selenium-webdriver`, not installed | NOT FIXED, deliberately — optional dep, not on production path |
| BUG-004 | P3 | Compare tool silently accepts `AAPL,AAPL` (duplicate ticker), no warning | NOT FIXED, low priority |
| BUG-005 | P2 | No CSV export on free-tools pages (admin CSV export exists but is auth-gated) | NOT IMPLEMENTED — correct per spec, not a regression |
| BUG-006 | P2 | Filing Change Monitor / smart alerts / Filing Diff correctly gated behind Power/Desk/Pro; couldn't be exercised without a paid test account | BLOCKED (test-account limitation, not a product bug) |

**What's changed since 8/21:** HANDOFF's 9/3–9/4 entries describe fixes to areas adjacent to but distinct from this bug list (fund-data nulls, sitemap race, affiliate 409, stale-10-K in Ask) — none of BUG-001 through BUG-006 above are mentioned as touched. **BUG-001 in particular (the anon-Ask marketing/config mismatch) appears to still be open** — nothing in HANDOFF references `ANON_ASK_LIMIT` being changed. Worth a live 401-check against `/api/ai/chat` anon if this matters for the strategy session (not done this pass — see §6).

---

## 6. Bing Webmaster Tools — live pull (2026-09-04)

Source: Bing Webmaster API (`ssl.bing.com/webmaster/api.svc/json/...`), `siteUrl=https://stockportfolio.pro`, key supplied live this session and saved to `~/.local/share/secrets/bing_webmaster.txt` (matching the path HANDOFF already expected). `GetRankAndTrafficStats`, `GetQueryStats`, `GetPageStats`, `GetCrawlStats` all responded; `GetUrlTrafficInfo` errored (`SiteUriSchemeIsNotSupported`) and `GetQueryTrafficInfo`/`GetQueryParameters` returned nothing useful (not valid/empty endpoints) — not chased further.

**Traffic (`GetRankAndTrafficStats`, daily series 2026-06-13 → 2026-09-02, 82 days):**
- Full 82-day window: **67 clicks / 6,078 impressions**.
- Last 30 days: **47 clicks / 4,966 impressions**.
- Last 7 days: **16 clicks / 1,201 impressions**, and trending up day over day: 8/29 → 0 clicks/72 impr, 8/30 → 3/114, 8/31 → 5/189, 9/1 → 1/237, 9/2 → 3/278.

**🚩 Corrects a stale figure:** `.claude/HANDOFF.md`'s 9/1 note says *"Bing ~10/wk"* — the actual last-7-day rate is 16 clicks, and impressions have grown roughly 4x within that same week. `docs/growth/EXECUTIVE-ANSWER.md` (8/21) cites the same "~10/wk" framing when comparing Bing favorably to Google's "~5 clicks/mo" — Bing's lead over Google looks even larger now than either doc assumed, though I don't have a fresh Google number to compare it against (see §7).

**Top queries (`GetQueryStats`, 604 rows, all-time):** no single query has more than 1 click yet — this channel is still long-tail, not concentrated. Sample of the highest-impression/click rows: "tesla outstanding shares history today" (1 click/2 impr), "stockportfolio pro" — a branded query (1/2), "tesla last 10 years p/e year by year" (1/4), plus one-off data-lookup queries for NVDA, AAPL, ZTS, BWXT, AMKR, VTOL. Consistent with EXECUTIVE-ANSWER's read that comparison/data pages, not brand awareness, drive what search traffic exists.

**Top pages (`GetPageStats`, 421 rows, all-time):** homepage (3 clicks/40 impr), `/stocks/ZTS` (3/29), `/stocks/TSLA/shares-outstanding` (2/73), `/stocks/AMKR` (2/4). Worth flagging for a CTR pass: `/stocks/AAPL/shares-outstanding` has **153 impressions but only 1 click** — the single biggest impression/click gap in the data, i.e. the page is being shown but not chosen.

**Crawl/index health (`GetCrawlStats`, most recent day 2026-09-03):** 24,255 URLs `InIndex`, up from 21,272 four days earlier (8/30) — indexation growing roughly **~1,000 URLs/day** over this window. Same day: 1,888 pages crawled, 28,684 requests returned 2xx, only 2 `4xx` and 4 `5xx` responses, 3 URLs blocked by robots.txt. No crawl errors of concern.

**Note on the key:** it now lives on disk at the path HANDOFF's working-rules section already names, so future sessions following existing HANDOFF conventions will find it there without needing it re-pasted.

---

## 7. AppSumo Partner Portal — manually confirmed (owner screenshot, 2026-09-04)

Source: owner-supplied screenshot of the AppSumo Partner Portal "Performance" tab, "All time" filter, window shown as **Jun 2026 – Sep 2026**. Not scraped by me — read directly off the image the owner posted in this session.

| Metric | Value (all-time, as shown) | 8/21 snapshot (EXECUTIVE-ANSWER.md) | Change |
|---|---:|---:|---:|
| Orders | 15 total (13 net after refunds, shown in the tier donut) | 9 | **+6 orders** |
| Gross sales | $1,026 | $801.00 | +$225 |
| Payout | $237 | $183.97 (displayed partner revenue) | +$53.03 |
| Refunds | 2 of 15 orders — **13.3% refund rate** | 0 refunds through Aug 20 | **+2 refunds** |
| Page views | 1,016 | not tracked in EXECUTIVE-ANSWER | — |
| Conversion rate | 1.48% of page views | 1.64% (last-7-day card, not directly comparable) | roughly flat |
| Listing status | **"Public"** (badge next to the product name) | "listing v3 still in review" | **now live/public** |

**Confirms HANDOFF's refund narrative from the portal side:** HANDOFF (9/2–9/4) describes exactly 2 recent refunds — one traced to Khaled Aziz (Ask serving a stale 10-K, exit-survey reason "Old data, not fresh") and one earlier, untraceable one (exit-survey reason "Product's functionality was too limited" / "Lacking Depth"). The portal's refund panel shows 2 refunds under a single reason bucket labeled **"Product's functionality was too limited"** — count matches, but note the portal's reason field looks like a fixed dropdown category, not the free-text exit-survey quote HANDOFF captured per buyer, so don't read this as the portal contradicting Khaled's "old data" reason — it's a coarser categorization, not a second data source disagreeing with the first.

**🚩 Strategically relevant, not just a stale-number fix:** Strategy v3 and EXECUTIVE-ANSWER's "shortest path to $1,000" plan is built on landing **7 new-to-AppSumo Tier 3 orders at a 90% partner-link revenue share**. The portal's actual payout/gross ratio here is **$237 / $1,026 ≈ 23%** — consistent with the *old* ~23% ratio implied by the 8/21 figures ($183.97/$801), not the 90% the plan is betting on. Nothing in this screenshot confirms the 90% partner-link economics have kicked in yet for any order. That's the exact "kill criterion" EXECUTIVE-ANSWER itself names ("re-model after the first order if the 90% economics are not recorded") — worth raising directly in the strategy session rather than assuming the plan's core assumption is validated.

**Still not visible from this screenshot:** per-tier order breakdown (the donut needs a hover to reveal it), review count/text, and Q&A activity — the portal has separate "Q&A" and "Payments" tabs that weren't captured here.

---

## 8. Microsoft Clarity — manually confirmed (owner CSV export, 2026-09-04)

Source: owner-exported CSV, project "StockPortfolio", date range **08/29/2026 – 09/04/2026** (7 days). Not scraped by me — read directly from the file the owner provided.

**Sessions & engagement:**
- 183 total (counted/human) sessions, **196 bot sessions excluded** — bots roughly at parity with human traffic now, a real improvement on the 8/21 snapshot where bots outnumbered humans ~2.8:1 (86 bot vs 31 human in a 3-day window; human share of raw traffic was ~26.5% then vs **~48.3% now**).
- 166 unique users, 166 new-user sessions, 17 returning.
- 1.42 pages/session (up from 1.19 on 8/21).
- 66.5% average scroll depth (up from 57.89%).
- Active time 105s vs total time 294s — **only ~36% of session time is active**, consistent with 8/21's finding that raw duration overstates engagement (backgrounded/idle tabs).

**Insights (friction signals):**
- Rage clicks: 0 (0%) — same as 8/21, still no rage-click issue.
- Dead clicks: 2 sessions (1.09%) — 8/21 had 1 of 31 (3.23%); rate improved.
- Excessive scrolling: 0 (0%) — unchanged.
- Quick-back clicks: 8 sessions (4.37%) — 8/21 had 1 of 31 (3.23%); broadly similar, slightly higher.

**Web Vitals (Performance overview) — 🚩 updates a figure quoted in both HANDOFF and EXECUTIVE-ANSWER:**
- Performance score: 68.57/100.
- **LCP 3.083s** — improved from the 3.8s figure HANDOFF's 9/1 note and EXECUTIVE-ANSWER (8/21) both cite.
- **CLS 0.38375** — essentially flat vs. the 0.36 both docs cite (technically up slightly, likely within noise, not a fix).
- INP 186ms (not previously tracked in either doc).
- JavaScript errors: 0 total across the window.

**New signal not in any prior doc — referrers:** of 183 sessions, 96 were internal (stockportfolio.pro→stockportfolio.pro), and the external referrers include **`chatgpt.com` (2 sessions) and `copilot.microsoft.com` (1 session)** — i.e., AI-assistant referral traffic that *does* carry a Referer header. This is worth connecting to §1: the uncommitted `marketing-attribution.js`/`app.js` changes sitting in the working tree right now are specifically about catching AI-agent traffic that arrives with **no** Referer at all (the "(direct)/(none)" bucket) — this Clarity data shows that's only part of the picture, since some AI-assistant traffic is already visible via normal referrer tracking and wouldn't need that fix to be counted. Other external referrers: bing.com (5), duckduckgo.com (2), google.com (2), yahoo search (2 combined), appsumo.com (1).

**New signal — smart events (7 days):** Submit form 11 (6.01% of sessions), Login 4 (2.19%), **Checkout 2 (1.09%)**, Outbound click 2, Upgrade 1. Two checkout-intent sessions in a week is a small but real, current data point against HANDOFF/EXECUTIVE-ANSWER's characterization of the direct-Stripe channel as essentially dead — it doesn't confirm a completed sale (Clarity's "Checkout" smart event marks reaching/interacting with the page, not payment success), but it's more direct-channel activity than either doc credits, and worth checking against Stripe once that's pulled.

**Top pages (7 days):** `/company.html` (25 sessions), `/dashboard.html` (23), `/screener.html` (17), `/ask` (8), `/profile.html` (8), homepage (6), `/compare` (6), `/news.html` (6) — consistent with 8/21's read that company/portfolio/screener pages, not the homepage, carry most engaged traffic.

**Bot traffic breakdown:** webScraperBot 60, suspiciousDeviceBot 188, suspiciousInteractionBot 195, ppcAdFraudBot 0, other 1. These sub-category counts sum to far more than the 196 total bot sessions, meaning a single bot session can trip multiple detection flags at once — read as overlapping signals, not additive counts.

---

## 9. Google Analytics 4 — manually confirmed (owner CSV export, 2026-09-04)

Source: owner-exported GA4 "Reports snapshot" CSV. Account/property both labeled **"grok"** in the export header — an unexpected name for a StockPortfolio.pro property, but the page-title data throughout (Portfolio, Ask, ticker pages, `stockportfolio.pro` branding) is unambiguously this site, so treat the label as a naming quirk, not a wrong-property pull. Window: **2026-08-30 to 2026-09-04** (6 days). Not scraped by me — read directly from the file the owner provided.

**Headline aggregate:** 440 active users, 434 new, 1,738 events, **15.39s average engagement time per active user**.

**🚩 The number most worth raising in the strategy session — likely bot-inflated user count:** city breakdown shows **Singapore = 291 of 440 active users (66%)**. Every other city is in the single digits (next-highest: Kashgar Prefecture 6, Shanghai/Zhangjiajie/Zhengzhou 5 each, Beijing/Chicago/Verona 4 each) — there is no second real cluster, just a long globally-scattered tail of 1s and 2s. A single city carrying two-thirds of a week's "active users," alongside a 15-second average engagement time, points to automated/datacenter traffic rather than real visitors (Singapore is a common cloud/VPN egress region). This is corroborated by two other things in this same brief:
  - **Clarity (§8)** separately reports 196 bot sessions against 183 human sessions for almost the same window — GA4, unlike Clarity, has no bot-filtering step, so a comparable bot share here would land GA4's real human count well below the 440 headline.
  - **Page-level bounce data** (below) shows the same pattern at scale.
  Recommend not repeating "440 active users" as a real audience figure without a bot-adjusted number to sit next to it.

**Key events: confirmed still zero.** The export's "Platform / Key events" table has no data rows — GA4 has no key events configured or firing. This is the same gap HANDOFF's 9/1 note flagged ("GA4 0 key events") — **still unfixed as of today**, not a stale figure needing correction, an open item that has sat for at least 4 days untouched.

**Traffic source — `(direct)/(none)` dominates almost completely:** 419 of 440 users (first-user source) and 433 of ~440 sessions are `(direct) / (none)`. Everything else is small: `bing/organic` 5, `chatgpt.com/ai-assistant` 3, `cn.bing.com/referral` 2, `duckduckgo/organic` 2, `google/organic` 2, `api.microsoft.ai/referral` 1, `appsumo.com/referral` 1, `copilot.com` (ai-assistant medium 1 + blank/none medium 2), `perplexity/(not set)` 1, `yahoo` (organic 1 + uk.search referral 1).
  - **Directly explains why the uncommitted code in §1 matters:** GA4's own channel grouping already tags some AI-assistant referrer traffic (`chatgpt.com`, `copilot.com`) when a Referer header is present — but the 419/433 `(direct)/(none)` mass is exactly the bucket GA4 *can't* see through, which is precisely what the uncommitted `marketing-attribution.js`/`app.js` changes sitting in your working tree right now are built to decompose by user-agent. This export is concrete evidence for why that unfinished feature is worth finishing: ~95% of GA4's traffic currently sits in a bucket only the unshipped code can open up.

**New vs. returning, by day (Aug30→Sep4):** 31/70/70/148/91/26 new users, returning basically negligible each day (2/5/3/1/3/0). **9/2 (day index 3) spikes to 148 new users — roughly double any other day** — with no obvious explanation in HANDOFF's 9/2 entries (busiest day in the log: AI menu reorder, MRR ladder + GATTOMORTO promo live, X-ad prep, monitor-cap v2 shipped dark), none of which plausibly drives a 2x user spike on their own. Could be the same Singapore/bot pattern concentrating that day rather than a real traffic event — not resolved by this data alone, worth a follow-up pull isolating that day's geography.

**Page-level engagement confirms the split between real product usage and shallow/bot landings:** logged-in product pages show real, low-bounce engagement — Portfolio (21 views, 7 users, 27.8% bounce), Ask (14 views, 3 users, 28.6% bounce), Screener (7 views, 4 users, 25% bounce), homepage (7 views, 5 users, 20% bounce). By sharp contrast, essentially every individual "Ticker — Fair Value & Financials" / "Ticker Metric History" long-tail SEC-data page in the export — dozens of them (Dillard's, Grab Holdings, NVDA Shares Outstanding, AAPL Price History, MSFT Fair Value, AVGO P/E, and roughly 250+ more rows) — shows **100% bounce rate at ~1 pageview per user**, near-universally, with almost no exceptions in the full page list. This is the same "shallow single-page landing" pattern EXECUTIVE-ANSWER and Clarity's 8/21 sample both flagged qualitatively, now visible at scale and consistent with the Singapore-heavy, low-engagement-time user base — read together, this looks like automated crawling of the long-tail page inventory (search/AI-model indexing bots, scrapers) rather than prospective buyers browsing.

---

## 10. Google Search Console — manually confirmed (owner CSV export, 2026-09-04)

Source: owner-exported GSC CSVs (Chart, Countries, Devices, Pages, Queries, Search appearance, Filters). Filter: **Search type = Web, Date = Last 7 days** — daily rows run **2026-08-27 to 2026-09-02**, which is the *identical window* to the Bing "last 7 days" figures already in §6, making the two directly comparable.

**Totals for the week:** 2 clicks / 464 impressions / 0.43% CTR / ~59 average position (impression-weighted).

**🚩 Directly comparable to Bing, same week — Bing wins by roughly 8x on clicks:**

| | Google (this pull) | Bing (§6) |
|---|---:|---:|
| Clicks (8/27–9/2) | **2** | **16** |
| Impressions | 464 | 1,201 |

This sharpens EXECUTIVE-ANSWER's (8/21) framing of "Google ~5 clicks/mo vs Bing ~10/wk" — that comparison used mismatched windows (monthly vs weekly); on an apples-to-apples same-week basis, Bing is outperforming Google by roughly **8x on clicks and 2.6x on impressions** right now. If the strategy session is weighing where to spend limited SEO effort, this is a stronger, more current data point than either doc had.

**All of this week's clicks came from comparison pages — confirms the existing "protect comparisons" channel decision with fresh data:** both clicks in the entire week are `/compare/TRI-vs-WCN` and `/compare/FLNG-vs-KRP` (1 click each, 100% CTR, position 2 and 4 respectively). Every other page in the export — including high-impression pages like `/stocks/AAPL/price-history` (109 impressions) and `/stocks/TSLA` (36) — got **zero** clicks. Average position across those pages is deep (50s–100s), which explains the zero CTR: they're not ranking high enough to be seen, let alone clicked.

**Device split is worth a look:** Mobile has zero clicks despite 19 impressions, but an average position of **5.16** — genuinely strong ranking, just not converting to clicks (small sample, but worth watching). Desktop carries almost all impressions (444) at a weak average position (61.54) and 1 click. Tablet's "100% CTR" is 1 click on 1 impression — not a meaningful rate.

**Queries:** long-tail, mostly Apple/Amazon historical-price and P/E lookups ("apple stock price history," "amazon p/e ratio," etc.), almost all at position 40–100, zero clicks. A few competitor/tool-name queries appear too (`sharesight`, `simply wall st`, `simply wall street`) — traceable to the site's own `/vs/sharesight`, `/vs/simply-wall-st` comparison pages, not brand confusion.

---

## 11. Gaps — needs a manual pull, not derivable from code or this session

I could not check these; don't let a stale number stand in for them:

- ~~AppSumo Partner Portal~~ — **manually confirmed via owner screenshot, see §7.**
- ~~Microsoft Clarity~~ — **manually confirmed via owner CSV export, see §8.**
- ~~Google Analytics 4~~ — **manually confirmed via owner CSV export, see §9.**
- ~~Google Search Console~~ — **manually confirmed via owner CSV export, see §10.**
- **Stripe Dashboard** — owner reports **$0 sales** (stated directly in this session, 2026-09-04) — consistent with EXECUTIVE-ANSWER's and HANDOFF's existing "$0 direct-Stripe" narrative, not a change. No further detail (MRR/ARR breakdown, subscription count, refund-secret-rotation status) was pulled beyond this readout — treat the underlying "direct channel still isn't converting" conclusion as reconfirmed, but the specific dashboard numbers (owner-action items #3 and #8 in HANDOFF) as still unverified in detail.
- ~~Bing Webmaster Tools~~ — **pulled live this session, see §6.**
- **RENDER_API_KEY / Render Deploys API** — I don't have this key in the current session (checked env vars and the home directory locations HANDOFF names; not present). This means §3's deploy conclusion is inferred from a log snippet already sitting in `/tmp` from earlier in this session, not from a fresh, authenticated Deploys-list query. A definitive "prod is running commit X" answer needs either that key or a manual check of the Render dashboard.
- **Live re-check of BUG-001** (anon Ask 401 vs marketing copy) — not re-verified against the current live site this session; §5's status is 14 days old.
- **The `/pricing` vs `/llms.txt` Ask-limit mismatch (§2)** — I can tell you it exists right now; I can't tell you which number is correct without checking the actual `AI_CHAT_CORE_LIMIT`/plan config that's live, which HANDOFF's 9/2 entry says may itself be stale (`AI_CHAT_CORE_LIMIT` described there as "now redundant" after a different default took over).

---

## 12. Reference — docs/growth/ and docs/qa/ files not opened this session

Listed for completeness in case any are wanted for the strategy session; none of these were read, so nothing about their content is asserted here.

`docs/growth/`: `180-to-1000-plan.md`, `7-day-revenue-sprint.md`, `appsumo-analysis.md`, `appsumo-listing-ai-tool-reframe.md`, `appsumo-qa-drafts.md`, `appsumo-tier-v2-proposal.md`, `artifact.json`, `buyer-psychology.md`, `channel-attribution.md`, `clarity-observations.md`, `competitor-market-map.md`, `corpus-buyer-outreach.md`, `corpus-license-terms.md`, `customer-forensics.csv` / `.md`, `direct-ltd-refund-policy.md`, `evidence-flywheel-plan-2026-08-21.md`, `evidence-ledger.csv`, `fast-track-to-1000-2026-08-21.md`, `forensic-growth-audit.ipynb`, `funnel-analysis.md`, `mcp-directory-listings.md`, `next-feature-ranking.md`, `paying-feature-matrix.csv`, `paying-page-matrix.csv`, `quarterly-filing-change-brief.md`, `report.html`, `search-opportunity.md`, `seo-market-research-2026-08-21.md`, `x-performance.md`.

`docs/qa/`: `FULL-FEATURE-INVENTORY.md`, `FULL-FEATURE-QA-MATRIX.md`, `assets/2026-08-21/*` (8 screenshots).
