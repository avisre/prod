# Handoff

Durable working memory — **keep under 500 lines** (CLAUDE.md), enforced by
`backend/test/handoff-size.test.js` and run on every push by `.github/workflows/repo-checks.yml`, so the
cap can no longer be crossed silently. Current state and open actions only, never a transcript. At ~400 lines,
snapshot this file to `.claude/handoff-archive/<date>.md` and rewrite it fresh; **delete superseded items to
the snapshot rather than compressing them here**.
Earlier snapshots: `handoff-archive/2026-10-07.md` (verbatim, taken 10/07 at 461 lines — the full
revenue-breakdown build narrative and the six dated 10/06 data-audit write-ups), `handoff-archive/2026-10-04.md` (verbatim, taken 10/04 at 395 lines — the SEC coverage
release narrative, the three earlier Ask quality/engineering release write-ups, the AppSumo v8 detail, the
OIDC fix, the breakthrough-hunt post-mortem, the Bing fix list), `handoff-archive/2026-10-03.md`,
`handoff-archive/2026-10-01.md`, `handoff-archive/2026-09-30.md`, `handoff-archive/2026-09-28.md`.
Deep history: `git log`, `notes/2026-09-*.md`, `docs/growth/`, `docs/seo/`, `~/.claude/plans/`.

## Credit refill sizes — 2026-10-08 (owner decision)

`/recharge` sells five sizes: the existing $14.99 / 150 (Stripe price id, unchanged) plus $50 / $100 / $250 / $500 at
10 credits per dollar (table in `backend/credit-topup-packs.js`, dependency-free). The larger packs use inline `price_data`, so there
is no Stripe price or env var to create. The page sends only a pack id; the webhook grants only when
`settled()` sees the paid total match the table. The out-of-credits API/MCP body (`api-response.js`, new
`recharge.sizes`), the nudge email and the homepage quote the largest size. Tests: `test/credit-topup-packs.test.js`.
**Why:** Todd (todd@insideedgecapital.com, Monthly, connector only) spent his 100-credit month in 28 minutes on
2026-10-08; he was comped 500 month-scoped credits (ledger reason `comp`, expires 1 Nov) and emailed.
**Open:** no top-up has ever been bought, so the sizes are untested by demand; serving cost per lookup and per AI
answer is unmeasured; no paid pack purchase has been run end to end (the webhook grant is covered by tests only);
`assets/*.js` cards (profile, dossier, monitor) still name only the $14.99 pack, left to avoid a cache-stamp bump.

## Geo wall: crawler claims are verified inside walled countries — 2026-10-08 (`fa0c46c98`, live)

**What was seen:** GA realtime showed a Singapore user on `/screens/quality-compounders`. `funnel_events` had the same
hit (country `SG`, anonymous). Since 09-23 one user agent (`Macintosh; Intel Mac OS X 10_15_7 … Chrome/145.0.0.0`) made
60 SG content page views on 59 distinct deep pages, one view per fresh session, spread over all 24 hours. Every other
SG browser appears only on `/register`.

**Hole closed:** `wallAllPagesMiddleware` returned `next()` for any `allowed-claim`/`internal` UA before checking the
country, and `botBlocker.checkCrawlerClaim` serves the first request from an unseen address. Inside
`GEO_WALL_COUNTRIES` the wall now awaits `botBlocker.verifyCrawlerClaim`: `verified` is served, `impostor` is walled
like a visitor, `unknown` (lookup failed) gets 503 + `Retry-After`, never the 302. `internal` earns no exemption from a
walled country (the marker is in a public repo). Crawling from other countries is unchanged. Tests:
`test/geo-wall.test.js` runs the middleware cut out of `app.js`.

**Not proven:** that the SG client used this route. Successful page loads were not logged, so its document request was
never seen. Every page served to a walled country now logs `[geo-wall] {outcome:'served', reason}` (reasons
`verified-crawler`, `paid-account`); refused claims log `refused-crawler-claim`.

**Open:**
- Check `funnel_events` for SG content views by that UA after 2026-10-08 14:14 UTC. If they continue, read the
  `[geo-wall]` lines in the Render logs for the reason.
- `hostingWalled` still exempts an unverified crawler claim (first request from a hosting address is served).
- `backend/node_modules` is tracked on `main` as a symlink to `/Users/drasharaghavan/prod/backend/node_modules`, so
  `npm ci --prefix backend` in any worktree wipes and rewrites the `~/prod` install, and `git stash` in the worktree
  empties it. Never stage the resulting `D backend/node_modules`. Removing the symlink needs a check of the Render build.

## Revenue breakdown on the company page — state on 2026-10-07

**One module decides:** `backend/revenue-breakdown.js` returns a graded contract (`complete`, `partial` with a named
`remainder`, or `none` with a plain `reason`; rows carry shares of their own fiscal year). The dossier build, every
cached dossier read (`dossier.refreshValuation`), Ask's `get_segments` and the page's `breakdownTable()` all use it;
nothing downstream recomputes a share, a remainder or a year. Selection and naming rules live in
`backend/sec-segment-observations.js` (`extract`, `shown`, `preferred`, `displayName`, `validGroup`).

**What the stored data holds** (`frontend/data/sec-financials/*.json`, industry `VERSION` `20261007-industry6`):
- `segmentObservations`: one table per axis and year — operating segments, product/service lines, regions. Each entry
  has the filed value with its receipt and `filedLabel` (the company's printed label, read from `*_lab.xml` or the
  `.xsd`). A table not stated in revenue carries `measure` (insurer premiums; a bank's
  `InterestIncomeExpenseNet` + `NoninterestIncome`, stored in `entry.components`; an issuer's own
  `RevenuesNetOfInterestExpense…` concept, e.g. BAC).
- `operatingExpenseLines`: the expense lines the filer reports (R&D, sales and marketing, G&A, fulfillment,
  technology) with printed labels; `opexParts()` in `frontend-v2/assets/dossier.js` draws the set that adds up to
  the filed total and never counts a combined line twice.
- Total revenue may be cited to an amendment (10-K/A, 20-F/A) of the same report; any other filing is rejected.

**Display rules:** product/service lines lead when they have ≥3 rows and say more than the segments or the segments
are geography; regions only when nothing else is usable; operating segments are never pruned to fit and, where they
sell to each other (110–160% of revenue: CVS, HUM, UNH), are shown with shares of the segment total and a note;
roll-up members ("Reportable Segment, Aggregation", "Total") are never rows; a table at 60–98% is `partial`.
**Over-counted tables get a second, stricter reading** (`shown()` → `read(g, true)`, only when the first reading is
not usable and is over 110%, and kept only if the result is usable — so a table that already works cannot change):
drops a member equal to the filed total or named Entity-wide / Consolidated entities / Operating segments, a
`Currency…` memo member, and a second member carrying an exact value already seen (one figure tagged twice); and when
the leading rows add exactly to the total, takes them as the table (segments then countries on one axis: CETX, BHST).
**Measured and rejected, do not retry:** withholding any table with a negative entry (kills TSN, MO, TFC, RTX — a
negative eliminations line is normal) and de-duplicating in every table (reshuffled ~190 good tables).

**Coverage, 4,923 screenable issuers:** complete 3,273 + partial 154 = 3,427; filed revenue is zero 47; single-row
295; tags no table 609; covers <60% 127; over 110% 10; **no total revenue in our statement data ~416**.
**Those 422 were checked one by one** (`docs/qa/revenue-missing-check-2026-10-07.csv`, SEC company facts + each
latest annual filing): 146 have never filed revenue (pre-revenue, R&D only); only 18 file an undimensioned total, and
most of those are fragments the revenue rule rejects on purpose (`partialRevenueConcept`: a bank's fee line).
`sec-facts.js` now has a helper field `reportedRevenueTotal` (us-gaap `RegulatedOperatingRevenue`, ifrs-full
`RevenueAndOperatingIncome`) that fills `totalRevenue` **only when it is null** and the line is ≥ |net income|:
filled HSBC, UBS, ARGX, BCH, OGS, GGAL; rejected BBVA (a €316M fragment). The rest stay empty and the page says why
(`REASONS.revenueInParts` for lenders filing interest/fees/premiums separately, else `revenueMissing`) — owner's
rule 10/7: never show a figure the company did not file; say it is not available and why; fill only genuine cases.
LHX, MTH tag revenue only by segment/product with no company total; APA, NRP, TG use company-specific concepts.
**Do not run `refresh-sec-coverage.js --symbols` on a day after `sec-reporting.json` `asOf`:** the new check
timestamps post-date the snapshot and `sec-runtime.test.js` fails; the six fills above were capped to the asOf day.
S&P 500: 438 complete / 35 partial / 30 none. Rerun the numbers with
`node scripts/audit-segment-display.js --sp500` (0 violations required; it runs in the deploy gate).

**Measured, do not redo:** reading untagged tables from annual-report text recovered **0 of 39** sampled issuers
(48 model calls; nothing passed the literal-quote check), so no text-extraction layer was built.

**The <60% and >110% groups were examined 10/7 and are correctly withheld:** of the 127 under 60%, 100 are banks and
12 REITs whose only tagged table is fee or ancillary income (net interest income / rent is not broken out). The 10 over
110%: PBR (four tables on one axis; segments are 171% before eliminations), TYGO (filer tagged thousands as millions —
not rescaled, by the owner rule), MBI (a segment with negative revenue), TII (a gross-to-net reconciliation), DARE,
and INBX/ATOM/RLYB/NMTC/UTMD (one line tagged twice, i.e. really a single line).

**Known gaps, with cause:** CVX — Upstream/Downstream are tagged with a second dimension the reader skips;
PGR — Personal/Commercial Lines premiums are not captured; ELV — segments only by premiums with a "Total" member;
HD — its filing tags "Primary / Other"; AZO — regions are just US / Non-US; ~790 small issuers tag nothing at all.

**How to change data safely:** edit the extractor, bump `VERSION` in `backend/sec-industry.js`, run
`SEC_ORIGINAL_MAX_MB=64 node scripts/refresh-sec-industry.js` (≈2.5 h, all issuers; `--symbols` for a subset), then
`build-public-stock-index.js`, `build-screen-index.js`, `audit-segment-display.js --golden`, full tests and the four
gate scripts. Golden set: `backend/test/fixtures/revenue-breakdown-golden.json` (63 tickers).

**Checking a deploy without a login:** `GET /api/admin/revenue-breakdown/:symbol` with `x-admin-token`.
`scripts/render-dossier-gallery.js` renders real sections to look at. **Nobody has viewed a logged-in company page
for this work** — a script to sign a test-account session was refused by the permission layer; the owner should
open one.

**Off-balance-sheet section:** `backend/off-balance-sheet.js` reads leases not yet commenced, unrecorded purchase
obligations, guarantees and unconsolidated-entity exposure from the latest 10-K/10-Q inline XBRL with the filing
sentence; shown in both views (`offBalanceHtml`). Ask has no tool for it. 20-F filers return nothing.

Asset stamp `20261007-breakdown4`.


## 2026-10-07 — new price ladder, direct lifetime sales retired, /connect (stamp `20261007-price1`)
- **Ladder: Dev $200 · Monthly $79.99 · Annual $649.99 · Pro $799.99/yr · Desk $1,999.99.** Dev went from
  $19.99 to $200/mo (still 200 credits) on 2026-10-08, and sells nothing until the $200 Stripe price exists
  (`scripts/create-dev-stripe-price.sh`); Desk did not move. Annual is $54.17/mo effective, saves $309.89, "32% off". Owner decision; nothing was measured —
  Monthly had been $49.99 for one day and no subscription existed on any replaced price.
- **Stripe (live, done):** created `price_1UNszxAUeKapY1OPEr0yxh1S` (79.99/mo) and
  `price_1UNszxAUeKapY1OP1glIJtcG` (649.99/yr); Pro reuses the 8/31 `price_1UAUOfAUeKapY1OP0cr1G3pD`
  (799.99/yr). **Archived** `price_1UAUOoAUeKapY1OPKtXHogz4` (the retired Pro-monthly 79.99, zero subs) so each
  amount has exactly one active match. The 49.99 / 419.99 / 499.99 prices stay ACTIVE and are grandfathered
  by id in `LEGACY_REPRICED_20261007` (code defaults — no Render change needed).
- **`resolveStripeCheckoutPlan` does NOT fail closed on a mismatch.** With zero or two active matches it
  returns the config unchanged, i.e. the stale `STRIPE_PRICE_ID_*` from Render at the OLD amount. Exactly one
  active Stripe price per amount is what keeps checkout honest; re-run the matcher replay before any reprice.
- **Top-up now undercuts Pro per credit** ($0.100 vs $0.111). Copy on /recharge was made true; the top-up
  price itself is an open owner decision.
- **Direct lifetime sales are OFF in code:** `direct-ltd.js` `SALES_RETIRED` → config disabled, both
  checkout routes 410, `/lifetime*` 301 → `/#pricing`, out of the sitemap, page noindex. `enabled()` and
  `DIRECT_LTD_ENABLED` are untouched because webhooks/refunds for existing buyers read them. /appsumo untouched.
- **`/connect`** is the landing page for the Claude and ChatGPT directory listings (hero badge + `#connect`
  section on the homepage, footer link). Listing URLs live ONLY in `lib/connector-listings.js`: Claude's is
  the known slug, never seen loading from outside; **ChatGPT's is not recorded** (set `CHATGPT_LISTING_URL`).
  Outreach drafts, nothing sent: `docs/growth/connector-launch-2026-10-07.md`.
- Suite: **6 failures pre-exist on `main`** with a proper `npm ci` (mcp-apps, metric-ownership, money-formatter,
  reasoning-effort-coupling, reliability-guard), untriaged. Borrowing `node_modules` from the stale `~/prod`
  tree adds ten fake ones (no `htmlparser2`). A stray `*.html` in `frontend-v2/` fails
  `legacy-html-redirects` — never write temp files there.

## Session start
- `bash scripts/dev-doctor.sh` once. Local mongo: `brew services start mongodb-community`; harnesses use
  `mongodb://127.0.0.1:27017/<scratch>`.
- **Verify every deploy from outside** (`gh run list` + a live fetch) — the workflow's own conclusion lied
  once. `deploy-render.yml` 404'd on push through 9/24 (Render lost the repo) and works again;
  `set-render-env.yml` alone never deploys. A push to `main` ships to prod.
- **The MCP endpoint has a live checker: `cd backend && npm run test:mcp`** (`scripts/test-mcp.mjs`) — the 10
  scenarios a directory scan or ChatGPT connector performs, against a real URL, PASS/FAIL per line, exit 1 on
  any failure. Key is read from `~/.config/stockportfolio/api-key`; it is fingerprinted, never printed.
- **The browser path has a checker too: `node scripts/mcp-browser-test.mjs`** — walks the ChatGPT-connector flow
  in a real headless Chrome (CDP, UA overridden past the bot blocker), PASS/FAIL per line, exit 1 on failure.
  Needs no credential; the two hops it cannot cover are a successful sign-in and the approve POST that follows.
  Each run registers a real DCR client (`mcpc_*`) in the **production** database — harmless, but they accumulate,
  so don't leave it in a loop.
- **Parallel sessions share this working tree.** On 9/28 another session pushed `f5be04fd` mid-task and left
  `backend/discovered-compares.json` deleted-but-unstaged. A push range starting at a SHA you do not recognise
  means someone committed between your `git add` and your push — check `git log`/`git status` before staging
  anything broad, because `git add -A` would have committed their deletion.

## Hard constraints — do not violate
- **The AI provider is a trade secret.** `ai-client.js`'s `leaksIdentity()` is a backstop, not a licence;
  never name the model to users, in copy, or in an error message.
- **Never store or inline keys.** `~/.config/stockportfolio/api-key` (`sp_live_`),
  `~/.local/share/secrets/bing_webmaster.txt`, `.../gsc_service_account.json`,
  `~/.config/stockportfolio/reviewer-account.txt` (mode 600).
- **Never `dotenv.config()` `backend/.env`** — it carries the PRODUCTION Atlas URI, so a script taking an
  API key from it inherits the live database (9/7, again 9/22 when live keypoints rows were deleted). Use
  `scripts/lib/dev-env.js` (`loadAiEnvOnly` + `assertLocalMongo`, `--db`).
- Customer email only from support@ via `/admin/messages`, owner-approved; **never cold email from
  support@**. No anti-bot workarounds, and **no interactive auth through Bash** (`gh auth login` needs a TTY —
  hand the owner the command). No `sleep N`. `rin@gmail.com` is the owner's test account — exclude from counts.
- **Never log API keys, authorization headers, session tokens or sensitive data** — including into this
  transcript. `/tmp/fill-creds.mjs` shows the pattern for a secret a browser form needs: read the file
  in-process, hand it straight to the DOM, never through argv or stdout.
- **`notes/filing-watch-*.csv` must stay untracked — the repo is PUBLIC** and they will hold prospect PII.

## 2026-10-06 data-audit work — moved to the snapshot

Six dated write-ups (revenue figures checked one by one; quarter reconciliation and bank revenue; earlier-year
revenue check; full data audit and the revenue-line fix; data foundation repair; shipped 10/06) are verbatim in
`.claude/handoff-archive/2026-10-07.md`. Read them there before touching core statement extraction.

## Production state — 2026-10-04
- **The industry-personalized Ask framework is deployed.** Production commit `6898cdb4` went live as Render
  deploy `dep-db181bvavr4c73an2krg` through workflow `37216736433`; the workflow confirmed the deployed
  commit. `/api/health` returned 200 with `{"ok":true}`. Direct requests to `/ask` and the stamped asset
  returned 403 from this environment, so authenticated rendered-page verification is still unavailable.
  Historical Ask asset stamp: `20261004-askfacet1`.
- The earlier rollback `97c61b35` deployed as `dep-db0uvplg1s2s73fplsq0` through workflow `37182036116`.
  Its historical evidence remains in `docs/qa/ask-rollback-2026-10-04/release.json`.
- Earlier the same day, the SEC coverage release `73186a12` deployed and passed independent production
  checks: 6,099 securities, 4,440 ready issuers, 4,498 screenable listings; live stock sitemap matched the
  snapshot exactly; 403s blocked automated stock-profile/alias checks, so authenticated Ask stayed unverified
  there. Evidence: `docs/qa/ask-live-readiness-2026-10-04/`.
- The release restored the Ask modules onto current `main` while keeping the SEC data and dependency files.
  The tested source branch remains `ask-production-ready-20261004` at `ed11f4e7`.

## In flight

**Day 41 AppLovin card — re-rendered in the house theme (10/03, DONE; `marketing/` is gitignored).**
`marketing/applovin-growth/applovin-axon-q2-2026.{html,png}`: the ChatGPT dark card's content in the
`applovin-growth-2020-2025.html` skeleton. PNG is 3072×2048, rendered by headless Chrome
`--force-device-scale-factor=2` — `scripts/screenshot-cdp.js` pins `deviceScaleFactor: 1`.
- **The published labels do not compound:** 0.98 × 1.58 = 1.5484, so the strict endpoint is 154.8, not 153.
- **`applovin-axon-q2-2026-artifact.html` is the share page and is NOT PUBLISHED.** This session
  authenticates with `ANTHROPIC_AUTH_TOKEN`, which takes precedence over a claude.ai login, so **every
  `Artifact` call is refused** — unset the var, `/login` as a Claude account, then publish.
- **Trap for scaled poster pages:** without `*{box-sizing:border-box}` the board's 56px padding sits outside
  its 1536px width and the scaled sheet clips the right 56px. The reset must not zero `:root` padding.

**Breakthrough-product hunt (10/01–10/02) — completed; the result is a negative with a sharp conclusion.**
75-agent adversarial funnel (26 ideas → 15 after dedup): all 15 passed the live novelty kill-squad, all 15 died
at the 3-lens adversarial panel, and a manual re-review of all 45 refutes confirms the kills. Repeated
findings: every high-price version sells to buyers behind enterprise procurement this company cannot reach;
incumbents hold them; EDGAR/XBRL-derived moats are copyable. Strongest near-miss: "Audited Alpha" (creator
track-record registry), viable only reframed at $49–149/mo self-serve; never panel-tested in that form.
`notes/2026-10-02-breakthrough-product-hunt-result.md`.

**OpenAI ChatGPT plugin directory — owner reports APPROVED AND PUBLIC (10/07), not independently verified.**
Surface is `POST /mcp/apps` (`backend/mcp-apps.js` + `backend/mcp-financials.js`), 7 read-only intent tools.
Package: `OPENAI_PLUGIN_SUBMISSION.md`; design note: `notes/2026-09-29-openai-plugin-architecture.md`.
- **Live checks:** `scripts/verify-mcp-apps.js --review-cases` = **23/23** against production (re-run after
  every deploy); official MCP Inspector `--strict` = **0 findings**; `/mcp` legacy contract unchanged.
- **`/mcp/apps` takes `company`; `/mcp` takes `ticker`.** `backend/scripts/test-mcp.mjs` speaks the `/mcp`
  shape, so running it against `/mcp/apps` reports one FAILED metered call — that is the harness, not the
  surface.
- **Review state: "In review", version `1.0.0`, identity verification still "Identity in review"** —
  publishing under an unverified name is an automatic rejection. **Only one review may be active per plugin**;
  *Cancel review* withdraws it, so never press it casually.
- **The one real loose end: the five reviewer-credential fields were never re-checked** (the panel renders
  only inside the one-shot Submit wizard). Credentials: `~/.config/stockportfolio/reviewer-account.txt`.
  Also still open, ours: the privacy policy's human legal review.
- **The ZIP is the source of truth, not the form.** Rebuild with `scripts/build-openai-plugin.sh`; read its
  header for the three capture traps. The walkthrough mp4 is real and **a re-recording needs a new filename**
  (`.mp4` gets the same one-year immutable header as `.js`).
- **OIDC (fixed `656d4b52`, verified live):** discovery metadata, `openid` + `email` scopes, UserInfo with
  `email_verified`. **No ID token is issued** (deliberate).
- **The ChatGPT connector itself is LIVE in the owner's account (9/30).** **CIMD is not supported.**

**Claude / Anthropic directory — BOTH submissions are IN (10/01). Nothing is blocked on us.**
Submit at **claude.ai/directory/manage** (the Console form is retired).
- **Plugin bundle — `Publish requested`**; repo public, MIT, `claude plugin validate .` passes. **Do not press
  `Cancel review`.**
- **MCP connector — `Published` (10/07, community connector)**, listing slug **`stockportfolio`** (permanent). The portal only re-reads a
  tool list on reconnect, not on reload.
- **Auth is declared `Required when the server asks` + DCR** — honest (the free tier is real), but a directory
  user is not forced to sign in. One click on Settings changes it to `Always required`.
- **Reviewer account: `openai-review@stockportfolio.pro`** — declared as a `UserSchema` path
  (`reviewAccount`); four reads skip it (`trackActivation`, the `mcp_oauth_authorized` event,
  `/api/admin/customers`, the trial-lifecycle drip). **Mongoose strips undeclared paths, so the schema half is
  the one that fails invisibly.** Package + history: `docs/growth/claude-plugin-submission.md`.

**AppSumo final-window repricing — v8 copy DONE (11/11 guards); the flip partly started, NOT finished.**
Values + order: `docs/growth/appsumo-listing-v8.md` (target 149/549 · 299/1099 · 499/1849, wallet
200/500/1000). `CREDIT_ALLOWANCE_V3_EFFECTIVE_FROM` is stored on Render, deploy followed — **unprovable from
outside by design**. **Three writes were BLOCKED by the auto-mode classifier** (the Render env set, the
grandfathered-licence importer, the portal draft values) — hand over, don't retry. Portal is browser-only
(`node /tmp/as-drive.mjs`, Chrome :9222, profile `~/.appsumo-portal-profile`); **never touch
`/self-submission/231048/build`**, never press EXIT. **Remaining:** nine price/wallet values, long
description, five FAQ slots, API+MCP row wording; then Submit → reply in Yena's thread.

**Filing Watch $49/month pilot — BUILT, VALIDATED, DEPLOYED flag-ON (`d642d04a`). $0 collected, zero offers
sent.** Ops doc: `docs/growth/filing-watch-runbook.md`. Fails closed (`PILOT_NOT_OPEN`, `PRICE_UNVERIFIED`).
Real success/decline, webhook, renewal, refund and cancellation behaviour is **unverified** — never test with
a production card. **Prospects: 1 of 5** (`ncdorc`/ATOS, qualified). **Never send outreach without the owner's
explicit authorization.**

**Dossier redesign — "The Plain Filing" — mockup done, awaiting review.** Plan
`~/.claude/plans/valiant-singing-parnas.md`; `docs/design/dossier-plain-filing.html` (Newsreader / IBM Plex).
**Step 2 — the port — has NOT started.** Regenerate with
`node scripts/build-dossier-mockup-artifact.js`; never hand-edit it.

**Emotional design** — plan `~/.claude/plans/warm-orbiting-sketch.md` (approved). Phases 0-5 shipped 9/24-25;
**phases 6-7 NOT started** (year in filings, comprehension streak).
- **Standing rules, still binding:** the error overlay's "Nothing was changed" is an explicit `unchanged: true`
  opt-in; X-Ray exposure is summed in **DOLLARS**; an EMPTY alert list renders a quiet card rather than hiding
  the section.

**AI portfolio creator — announced 9/25 as in-development, no date promised, no spec file yet.**

## Walls (live in prod)
- Geo wall `GEO_WALL_COUNTRIES` (`SG,CN,HK`); hosting/VPN wall `HOSTING_WALL_ENABLED` (ON) from
  `backend/data/hosting-ranges.bin`. Hard paywall `WALL_ALL_PAGES` — off since the wall week (3 signups /
  9 days, 0 paid); **`/docs` is the only product surface readable signed out.**
- **Load-bearing, both walls:** the visitor IP comes from `marketingAttribution.requestIp()`
  (CF-Connecting-IP in prod), **never `req.ip`**. The crawler exemption is not optional either: Googlebot/Bingbot
  crawl from cloud ranges that ARE in the hosting table, so without it the wall 302s them and deindexes the site.
- **The MCP transport is the ONE surface the walls no longer decide.** `apiKeyAuthOptional` makes no decision
  at the transport; identity, entitlement, allowance and the wall resolve inside `mcp-endpoint.js` at
  `tools/call` and return as **tool errors** the model can read. The old 402 is gone because directory probes
  run from datacenter IPs and the hosting wall classified every cloud range as hosting.
- **Unclosed:** ~25 keyless `/api/*` endpoints serve product data with no auth and no country check.

## SEO / discovery — measured; do not re-derive
- **The bottleneck is indexing and site-level trust, not content, targeting or segment** — titles/H1s match
  the queries and canonicals are clean, yet Google gives ~340 human impressions/month, ~0 clicks, median
  position ~52 across ~21,700 URLs, while Bing ranks the same site well (7.7% CTR, pos 6.1).
- **87% of raw "impressions" are rank tools, not people**; `seo-data/search-opportunities.md`'s P1 rows are
  phantoms. Parse GSC/Bing CSVs RFC4180; `split(',')` yields NaN.
- **Google names the reason itself:** crawled-but-not-indexed means "insufficient value **or user demand**".
  Demand follows links, so **external links/citations are the unmeasured, unattempted lever**. Never `noindex`
  an unwanted URL — use robots.txt, a one-way door, or emit fewer URLs.
- **The URL Inspection API reports the LAST CRAWL, never a live fetch.** The 9/15 hard paywall (`f4af1ee5`)
  was the real deindexing cause; fixed 9/24.
- **Gemini cannot be targeted as a crawler — none exists.** AI Overviews ground on Googlebot, so this lever IS
  the indexing lever.
- Operator Python needs **`.venv/bin/python3`** (Homebrew Python is PEP 668-managed).
- **Pushing Bing to recrawl:** the URL submission API is small (100/day, 300/month) and **counts 301-ing URLs
  too**; **IndexNow is the free channel for moved URLs**. `GetSiteScan`/`SubmitSiteScan` 404 — **Site Scan is
  UI-only**.

## Prices, freshness, dead tickers (deployed 9/28, still load-bearing)
- `backend/quote-store.js` is the one place pages ask for a price.
- **Freshness = the data's own dates, never mtime** (`backend/fundamentals-date.js`, `STALE_DAYS=45`).
- **A fundamentals commit must deploy** (`frontend/data/fundamentals/` is read from the deployed filesystem).
- **Dead-ticker rule:** two *separate days* of Yahoo "Quote not found" mark a ticker unlisted; a later success
  clears it. The weekly workflow writes `fundamentals-status.json` but does not stage it.

## AI model + cost
- **Every purpose resolves to `glm-5.3`** (`ai-client.js:20`); `glm-5.1` is retired. `glm-5.3` needs
  `reasoning_effort: 'low'` (`ai-client.js:82`).
- Cost baseline was a measured **$28.91/mo ≈ 48% of the $60 allowance** on glm-5.1
  (`scripts/ollama-cost-projection.js`); real split 95/5 chat, 90/10 summary. **Re-measure after the swap.**
- **glm-5.3-flash on MCP/API Ask: validated and REJECTED** — fails the tool-set gate (60% against an 80% bar)
  and is slower with the 32 schemas attached (1.55x).
- **Trap:** `promptTokens`/`completionTokens` are *missing* (not null) before 9/11, so `$ne: [field, null]`
  does not exclude them. Use `$isNumber` and apportion each group's FULL `totalTokens`.

## Traps that have already cost real time
- **The local Ask harness holds backend modules in memory** — restart it after every edit, or every
  measurement is against the old build.
- **The model mis-rounds ratios.** The tool's own `table` column is the quote source, and a value restated one
  tenth off is rejected as unsourced (49.3% for a supplied 49.35). The prompt now says so explicitly.
- **A fence field the renderer ignores fails silently.** `"facet": true` on a `viz` line chart was simply
  dropped; the answer still validated and still published a flat-line chart. Anything the prompt advertises
  needs a validator rule or a renderer branch, not just prose.
- `users.updatedAt` reads "3d ago" for every account uniformly — a bulk-write artifact. **Measure activity
  from `ollama_usage_events`, never `updatedAt`.**
- **A broadcast's recipient list is not a customer list.** The 9/23 "general" send's 47 non-owner recipients
  had **0 live userIds**.
- **~95% of first-party "unique visitors" are a botnet hitting `/register.html`.** Check distinct user agents
  before quoting any visitor count.
- Chrome headless sends "HeadlessChrome", which `bot-blocker.js` correctly 403s — override the UA. Browser
  checks go through CDP (`scripts/screenshot-cdp.js`).
- **A CSP failure that exists only in production is invisible to a same-origin harness.** Chrome enforces
  `form-action` across *redirects*, and it failed *silently* while the loopback e2e passed 14/14. When a
  browser button "does nothing", read `Log.entryAdded` + `Network.loadingFailed` over CDP first.
- `access_token()` in the GSC script returns a **tuple** `(token, client_email)`; treating it as a string 401s.
- zsh does not word-split unquoted variables: bulk `sed` needs `… | xargs sed -i '' …`.
- **The clean release tree has six pre-existing full-suite failures** (1233 pass, 6 fail), reproduced on the
  pre-release production tree. The feature worktree's dirty, unrelated local fixes made its full suite green
  (1239 pass). **No CI job runs the full suite** — `repo-checks.yml` runs only `handoff-size`; 23 files need
  mongo, 25 touch the network and 8 need root `node_modules`.
- **A test can encode a coincidence and still look like an invariant.** `sitemap-index.test.js` asserted
  lastmod must *vary* — true only while two dates happened to differ.
- **A source-pinning test slices source, and the slice is a silent expiry date.** Slice to the next function,
  not to a character count.
- **The CI-skip marker matches ANYWHERE in a commit message.** Detect a skipped deploy by the absence of a run
  for the new SHA (`gh run list`), not by the push output. `frontend/data/fundamentals/**` must never carry it.
- **Live verification has a request budget: 100 non-asset requests per 5 min per IP** (`navMax()`,
  `bot-blocker.js:158`; the limiter returns the *same* 403 body as a UA deny). Split sweeps across windows.

## Owner actions pending
1. **Pay the overdue Claude Pro invoice — this one blocks you directly.** `Settings → Billing`: past due and
   paused on **Discover •••• 4563**, so Claude cannot send a message at all. Only you can do this.
2. **OpenAI plugin submission — "In review".** Watch for the verdict; identity verification has not cleared and
   the reviewer-credential fields were never re-checked. Do not press **Cancel review**.
3. **Claude / Anthropic directory — nothing for you to do.** Two judgement calls if you want to revisit them:
   the connector's auth declaration and reusing the OpenAI reviewer account. The signed-in session lives in
   the scratch Chrome profile (`/tmp/claude-console-profile`, CDP :9335) — **still live**.
4. **Dossier mockup review** — step 2, the port, has not started.
5. **URL Inspection → Request Indexing** on the highest-value pages — `Page with redirect` (604) + `Server
   error (5xx)` (2) need the UI drill-down; the API has neither. Re-run **Site Scan** and click **Investigate**
   on the identical-titles / identical-descriptions / noindex / **Title-too-long** cards.
6. **`avisre/prod` visibility** — it names the AI provider while public.
7. **Rotate the secrets exposed in local transcripts** (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, JWT_SECRET,
   SMTP_PASS, GOOGLE_CLIENT_SECRET, the provider key) at source AND on Render back-to-back per key, or
   checkout and webhooks break mid-rotation. Also revoke the old GitHub PAT and npm token pasted 9/14.
8. **List-Unsubscribe + DMARC `rua`** before the next bulk send.
9. **Reopen-10-accounts script** (`scratchpad/.../reopen/run.js`) was blocked by the classifier — needs approval.
10. **`scripts/verify-receipts-panel.js` and `scripts/verify-send-receipt.js` are untracked.**
11. **AppSumo listing** is portal-only: paste + approval. The unredeemed buyers are unreachable — AppSumo holds
    their email, not us.
12. **Monthly provider bill** — the one input that states AI margin in dollars.
13. **Orphan IndexNow key** `1668f45a03ea53cf94c51b61c43163d4.txt` — confirm it is registered, or delete it.
14. **`mcp-server` republish** — its README documents the retired `sp_*` tool names.
15. **Publish the Day 41 share page (optional).** Unset `ANTHROPIC_AUTH_TOKEN` and `/login` with a Claude
    account, then re-run the publish.
16. **ChatGPT connector polish** (optional): the icon is the default placeholder, and the plugin still reads
    `DEVELOPMENT` review status. Separate from the directory submission in item 2.

## 2026-10-07 — no blue, profile side menu, account tray (stamp `20261007-offbalance1`)
- **Blue is gone from the main site.** `--accent` is now the ink, `--accent-tint` a warm grey, `--chart-1` the ink; prose links are underlined instead (`system.css` anchor rules). 228 hard-coded blue and slate literals in `backend/` + `lib/` (emails, widgets, server-rendered pages) mapped to the same ink and warm greys. Checked in a headless browser: 0 blue computed colours on 15 pages.
- **Still blue, not touched:** the four legacy pages served from `frontend/` (`/fundamentals.html`, `/founding.html`, `/demo-dashboard.html`, `/demo-fundamentals.html`) — an old dark theme, unlinked from the site. Owner to decide: retire or redirect.
- **Profile is a side menu at 861px+** (`profile.html`, `profile.js`): each section is still a `<details>`, the menu picks which is open, `#usage-details`-style hashes still work. New Account section (email, reset password, sign out).
- **Messages are a reading view, newest first.** A broadcast is a "product update": title = the broadcast title, body reads `# `, `- `, `**bold**`, blank line (`messages.js` and `customerMessageHtml` in `app.js` for the email). `CustomerMessage.title` is new. Body cap is still 4,000 characters.
- **Account tray** paints before it opens (session + credits cached in `sessionStorage`, credits prefetched at idle); it used to show an empty box until two requests returned.
- This file is past 400 lines: rotate it at the next edit.
