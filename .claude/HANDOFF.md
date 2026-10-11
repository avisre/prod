# Handoff

Durable working memory — **keep under 500 lines** (CLAUDE.md), enforced by
`backend/test/handoff-size.test.js`, which the pre-push gate runs whenever this file changes. Current state and open actions only, never a transcript. At ~400 lines,
snapshot this file to `.claude/handoff-archive/<date>.md` and rewrite it fresh; **delete superseded items to
the snapshot rather than compressing them here**.
Earlier snapshots: `handoff-archive/2026-10-11.md` (verbatim, taken 10/11 at 492 lines — the 10/08 owner decisions that
are live and settled: stock-based compensation on the company page, connector usage on the profile page, credit refill
sizes, the geo-wall crawler check, and the 10/07 price ladder), `handoff-archive/2026-10-10.md` (verbatim, taken 10/10 at 455 lines — the 10/04 production
state, the Day 41 AppLovin card, the breakthrough-product hunt, the 10/07 no-blue / profile side menu notes; the six
10/06 data-audit write-ups are in the 10/07 snapshot — read them before touching core statement extraction),
`handoff-archive/2026-10-07.md` (verbatim, taken 10/07 at 461 lines — the full
revenue-breakdown build narrative and the six dated 10/06 data-audit write-ups), `handoff-archive/2026-10-04.md` (verbatim, taken 10/04 at 395 lines — the SEC coverage
release narrative, the three earlier Ask quality/engineering release write-ups, the AppSumo v8 detail, the
OIDC fix, the breakthrough-hunt post-mortem, the Bing fix list), `handoff-archive/2026-10-03.md`,
`handoff-archive/2026-10-01.md`, `handoff-archive/2026-09-30.md`, `handoff-archive/2026-09-28.md`.
Deep history: `git log`, `notes/2026-09-*.md`, `docs/growth/`, `docs/seo/`, `~/.claude/plans/`.

## Ask answers what was asked, and runs until the credits are spent — 2026-10-11 (committed locally, NOT pushed)

Owner, on a "pick one stock … greater than 35% growth in the last 4 quarters, low SBC, buybacks, moat" answer that
named Booking (8% growth) and said it "cleared every bar": Ask must answer whatever is asked and keep working until
the user's credits are exhausted. Branch `ask-conditions-20261011`, three commits on top of `29a2df0ff`.
- **`query_universe`** (`ask-universe-query.js`): any formula over every company's statement lines; parsed, never
  executed. Data: `frontend/data/screen-facts.json` (22 MB, 12 quarters + 10 fiscal years, 32 lines), written by
  `build-public-stock-index.js` beside the screen index and added to the three refresh workflows' `git add`. It is
  not part of the dataset digest, so the deploy gate does not see it; the tool says so when the file is missing.
- **The question is written down, the draft is read against it** (`ask-requirements.js`): measured conditions are
  tested in code on the pick's own filed figures; the rest by a short second read. A miss is sent back with the
  companies that do pass. Runs for `focused`/`fund` questions of 40+ characters.
- **No fixed length for a signed-in reader with credits** (`ctx.budget`, streaming route only): ends when the answer
  passes, the credits cannot cover another round, the reader stops, or three rounds only repeat lookups. Bound of
  400 rounds. Anonymous trial, non-streaming, connector and API keep the 10-round run.
- **Charging** (`credits.askCredits`): 2 covers 150,000 tokens (measured p90 is 136,684, n=241), then 1 credit per
  30,000. Steps are ledger rows with `step: true` under an `askrun:` id; a failed run gets them back.
- Measured on the real model, the owner's question word for word, three runs: AppLovin twice (75–100 s, 2 credits,
  131k and ~90k tokens), once Nvidia withheld by the identity guard — now one rewrite before a receipt.
- **Open:** the ~20-question before/after set was not run (three live runs of one question only). The identity guard
  pattern that fired was not captured. A "pick" question still flips to the company-report policy once a tool names
  the company (`REPORT_WORDS` matches "business"). The same 8 tests fail as on untouched main.
- **This file is at ~465 lines: rotate it before the next entry.**

## Ask: a multi-company comparison came back empty — 2026-10-11 (committed locally, NOT pushed)

Live check of the customer-question fixes (signed-out trial path, own wording): screen filters, dossier link and the
unknown-ticker trade all pass. The seven-company comparison ran every lookup, then returned the receipt with sources
only, 1 run in 2 live and 2 in 4 locally. Three causes, fixed on branch `ask-comparison-fallback-20261011`:
- **Screen figures were not claimable.** The numerical review is skipped when only `screen_universe` ran, and switches
  on with any other research tool; it then rejected every screen figure. The tool now returns `claimable`.
- **Category rows under a `viz` fence** draw nothing on the page and fail the audit; `normalizeFacetedViz` relabels
  them `bars`.
- **`salvage` could not drop two charts with the same fault** (one shared finding, so removing either changed
  nothing) and the whole answer was replaced. Each standing chart is now judged alone.
- After: 6 of 6 local real-model runs answer with all seven companies. **Still open:** every cross-company chart is
  removed, because the chart audit wants exact filed values and period-end labels. Guard: `ask-customer-screen-fixes`.
- The stored reviewer account is on the Dev plan, which web Ask refuses; account-action and AI Portfolio page checks
  need a sign-in with web Ask. Full suite needs `frontend/data` (5.8 GB); a slim checkout fails 35 tests without it.

## Ask and the AI Paper Portfolio are separate pages — 2026-10-11 (committed locally, NOT pushed)

Owner: "make sure ask and ask ai exp feature have different pages and dont share the same workspace." I read "ask ai
exp" as the 🧪 AI Paper Portfolio experiment, the only experimental mode inside Ask (my reading, not confirmed).
- **`/ai-portfolio` is the experiment's page.** It is the Ask template served with `<body data-surface="paper">`
  (`aiPortfolioPage()` in `app.js`); the script in `ask.html` branches on that marker. No second HTML file, so the
  cache-stamp and page-list tests have nothing new to track. Noindex, no-store.
- **Ask no longer shows the 🧪 toggle and never sends `aiPaperMode`.** Old links (`/ask?aiPaper=1&q=…`, still emitted
  by the nav menu in `assets/app.js`) are redirected by the server and by the page, so `app.js` was left untouched.
- **Chats are kept apart by `AskThread.surface`** (`ask` | `paper`; chats saved before the split have no value and
  stay with Ask). Listing, search, opening, continuing and the 50-chat cap are all per page. A chat id from the
  other page starts a new chat. The experiment neither reads nor writes Ask's rolling history (`ai_chat_log`).
- **An account outside the experiment, or a signed-out visitor, is sent from `/ai-portfolio` to `/ask`.**
- Checked in a real browser against a throwaway database (16 checks; script in the session scratchpad,
  `e2e-surface.js`). Guard: `test/ask-surface-split.test.js`.
- **Trap:** `ask.html` says `<body>` inside a CSS comment above the real tag, so a first-match replace marks the
  comment. The marker is applied with `/^<body>$/m`.

## Ask: fixes from real customer questions — 2026-10-11 (committed locally, NOT pushed; owner said stop before deploy)

Reviewed all 24 questions 7 customers have asked Ask since 30 Aug (10 were screens). Read-only scripts for the review
are in the session scratchpad; the test set is 11 questions written for it (customer wording must not be replayed to
the model: the permission system blocks it as customer data).
- **Screen rows carry three new figures** (`financial-metrics.screenRow`, so every data job produces them): `price`,
  `netIncomeCagr5Pct`, `priceVsAvg10mPct`. `screen-index.json` and `public-stock-index.json` were rebuilt with them
  (7.06 MB of the 8 MiB cap). **No EPS growth figure on purpose:** filed EPS is not restated across stock splits
  (Nvidia reads 3.85 then 0.17), so profit growth stands in and Ask says so. **No 200-day average:** the stored daily
  series is 145 days, so the trend filter is price against the last ten month-end closes, and Ask says that too.
- **New screen filters** (`ai-chat.js` `screenRows`, also accepted from the Screener page and saved screens): `index`
  (sp500 / sp100 / nasdaq100), `min_price`, `max_price`, `min_net_income_cagr_5y_pct`,
  `min_price_vs_10_month_avg_pct`, and `symbols` (a named list compared in one call).
- **`frontend/data/index-members.json`** holds the Nasdaq 100 and S&P 100, copied 2026-10-11 from the pages named in
  the file. **No job refreshes it**; redo it when an index is reconstituted (Nasdaq: every December).
- **Ask's growth-ranked lists put established companies first** (profitable in 5+ of the last 10 years); the Screener
  page ordering is unchanged (`established_first` is set only by the Ask tool).
- **Budgets no longer tell Ask to stop:** the over-limit and allowance-used messages said "answer now with what you
  already have", which ended a seven-company comparison after one round. Round cap 12 → 16.
- **Standing rules added:** every named company in one answer; gaps (analyst estimates, management quality) said
  first; requests for "the dossier / analyst report / filing monitor report" get a focused answer plus a link to the
  real page, never an imitation. One-click "full check" starter on the Ask page.
- **Left out on the owner's word:** thin coverage of foreign filers. Guard: `test/ask-customer-screen-fixes.test.js`.

## Ask answers the question asked; trades; economic data — 2026-10-10 (pushed on the owner's word)

Owner: "make a swing trade for frgth" came back as a company report on AMD. Plan: `~/.claude/plans/dude-we-have-a-toasty-spindle.md`.
- **Cause (measured):** after the first tool result named a company, `ai-chat.js` re-selected the policy and
  `ask-report-policy.select()` made any question with no punctuation and no NARROW keyword a `company_report`
  (shipped 10/05, `4ab5b41f9`). A trailing "?" avoided it, which is why no test saw it.
- **Now:** the report is for a bare name or explicit report words only; `SPECIFIC` openers (who/why/should/is…) stay
  focused. New policy kind `trade`. A typed symbol nobody lists is named with its nearest listing
  (`unknownTicker`), and the engine prefixes that line itself. Guard: `test/ask-question-answered.test.js`.
- **`model_trade`** (`ask-trade-model.js`): entry, stop (ATR multiple by horizon), 2R/3R targets, size, protective
  option from the live chain; stop only when no options are listed. Protection is on unless the user declines. The
  engine appends the AI-generated / do-your-own-research line. Broker: the prompt has the model web-search what the
  named broker offers. Measured: 276 daily bars for 10 of 10 tickers, option chains for 9 of 10 (not FRGT).
- **`get_economic_data`** (`ask-macro-data.js`): 30 US government series via the FRED API, keyless FRED CSV as
  fallback, BLS API as backup; 3 h cache in memory and Mongo `ask_macro_cache`; stale value served with a warning.
  Privately owned series are refused in search. The FRED notice is appended to those answers.
- **Scope:** Ask answers any lawful question; the finance-only refusal and NO ADVICE rule are gone.
- **Audit:** a tool result's `claimable` money and percentages count as supplied figures.
- **Owner still to do:** add `FRED_API_KEY` and `BLS_API_KEY` to Render (values in `~/.config/stockportfolio/`).
  Until then production uses the keyless download and series search is off.
- **Account actions (second commit, committed locally, NOT pushed — needs the owner's word):** `ask-site-actions.js`
  gives the signed-in chat `manage_portfolio`, `manage_watchlist`, `manage_saved_screens`, `manage_alert_rules`,
  `manage_thesis`. Each calls the site's own endpoint as the user (`askSiteRequest` in `app.js`, loopback), so plan
  gates and limits are the pages' own. In code: a write runs only if the user's own message asked for it; deleting a
  portfolio needs a second confirming message. Proven on a local app + scratch Mongo, including one real chat request.
  Not offered to the trial, the public API or the connector. Guard: `test/ask-site-actions.test.js`.
- **Dashboard gain follows the chart range (third commit, local, NOT pushed):** the line beside the total was always
  "since inception". It now shows the move over 1M / 3M / 1Y / Max, labelled "today's holdings" because the chart
  prices current shares back in time, and a new **Inception** button shows the cost-basis gain. A period is measured
  from the first day every holding has a price. `dashboard.js` stamp is `20261010-range1`. Checked in a browser on
  the demo dashboard: all five buttons change the figure.
  Each holdings table also ends with a **Total** row: total paid, value, weight and gain in dollars and percent;
  no gain total when any holding in the group lacks a price paid.
- **AI Portfolio: one account, in the menu (committed locally, NOT pushed):** owner decision 10/10 — still an
  experiment, only `rin@gmail.com`. The address is fixed in `ai-paper-portfolio.js` (`EXPERIMENT_ACCOUNT`);
  `AI_PORTFOLIO_BETA_EMAILS` is no longer read and `AI_PAPER_PORTFOLIO=0` only switches it off (it is on by default
  now). `/api/session` returns `aiPortfolio: true` for that account and the nav adds "AI Portfolio · Experimental"
  under Research, below Ask, linking to `/ask.html?aiPaper=1`. `app.js` stamp is `20261010-aiport1` (51 files).
- **AI Portfolio accounting fixed after an audit (committed locally, NOT pushed):** measured first — swapping a
  halved stock put a −25% portfolio back to 0%, trimming a winner lost the gain sold, a rebalance after gains was
  refused. Steering now trades at the latest quote and re-splits current VALUE; sales book `realizedPl`. Splits:
  `applySplits` (provider split events; the daily series has none) adjusts shares and cost together. Unpriced
  positions are flagged in the snapshot. A tick with no data hands its claim back. A failed review is retried up to
  3 times, not charged, not counted. Builds and reviews check credits (`setCreditGate` in `app.js`). Guard:
  `test/ai-paper-accounting.test.js`. Not done: the dashboard does not yet show `unpriced` or `realizedPl`; no
  live build was run.
- **AI Portfolio owner controls (committed locally, NOT pushed):** a local build finished in 24 s but the Ask feed
  froze on its second-to-last line and the credits line stayed stale, so it looked stopped. The poll now prints the
  final line and refreshes credits. New `POST /api/ai-paper-portfolio/control`: `pause_build`, `stop_build`
  (discard), `pause_tracking`, `resume_tracking`, `end` (needs confirm). Buttons sit by the feed and on the card.
- **Not done:** live broker connection; rotating this file (over 400 lines, today's snapshot name is taken).
- Live check, real model, 5 questions: all answered as asked, no fallback. The full report path was not re-run live.

## Deploy checks moved off GitHub — 2026-10-10 (pushed `06cec9aa4` on the owner's word; live)

Owner: "bring the workflow u do on github to zero", then "i want all of this test to be done on my pc… make a more
targeted test series". Rules for using it are in CLAUDE.md; this is the state.
- **Done:** `scripts/predeploy.js` (targeted), `scripts/lib/test-map.js`, `scripts/predeploy-remote.sh`,
  `.githooks/pre-push`, `docs/dev/predeploy-pc.md`; `deploy-render.yml` has no `validate` job; `repo-checks.yml` removed.
- **Measured on the Mac:** whole suite 33 s (GitHub 2 min 20 s); dataset validation 101 s; revenue contract 13 s; every
  stock page + sitemap 670 s; memory 1 s. The connector-notice change needs 9 test files, 7 s, no data check.
  Docs-only commits run nothing. The ordering bug that failed GitHub twice on 10/10 fails the targeted run.
- **The "PC" is the owner's Windows laptop** (HARDROKER-7, i5-12500H; SSH alias `sp-pc`, key-only, home network
  only). Set up and working 10/10: whole suite 83–88 s there against 33 s on the Mac, same failures. Long SSH sessions
  to it drop after about 3 minutes on Wi-Fi, so runs start detached (`scripts/predeploy-win.cmd`) and are polled; code
  travels as snapshot bundles. Not yet tried: a push with the laptop switched off, and the data checks' timings there.
- **7 tests were already failing on `main`** before this work (`scripts/predeploy-known-failures.json`). Unfixed.
- **Deploys are blocked for a separate reason:** the GitHub repo is private and Render cannot read it. Nothing pushed
  on 10/10 is live. Owner decides: repo public again, or connect GitHub inside Render.

## Connector, pricing, saved screens — 2026-10-10 (one commit, pushed on the owner's word)

Plan: `~/.claude/plans/fix-the-monthly-allowance-graceful-lightning.md`. Everything below shipped together.
- **A lookup is CHARGED 1 credit, PUBLISHED at 2** (owner decision; he weighed 0.5 and chose 1, and said to leave the
  site at 2). `credits.COST` charges; `credits.LISTED_COST` is what pages, docs, emails and messages quote. To bring
  them into line later, delete the two overrides in `credits.js`. Measured first: three real questions through Claude
  (Haiku 5.5) cost 1, 7 and 3 lookups and no AI answer; a lookup makes no model call; `ask_filings` is about $0.07.
- **Account notices in connector results** (`backend/connector-notices.js`, both `/mcp` and `/mcp/apps`): credits
  added since the account's last connector call are announced once; a low wallet says so at 80% used and for the last
  five lookups. Derived from the ledger each call, nothing stored. Neutral wording on `/mcp/apps`. Off switch:
  `CONNECTOR_ACCOUNT_NOTICES=false`. **Why:** Todd ran dry mid-batch on 10/08 and never saw the 500-credit comp.
- **Sign-in issues a client secret when asked** (`oauth-mcp.js`): for `client_secret_post`/`client_secret_basic`, and
  for registrations returning to `perplexity.ai` or `teams.microsoft.com` (`OAUTH_SECRET_REDIRECT_HOSTS` adds hosts).
  A registration naming no method stays public, so Claude and ChatGPT get what they got. Both Microsoft 365 Copilot
  and Perplexity refuse a server that issues none. **Re-test a fresh Claude and ChatGPT connect after each deploy
  that touches this.**
- **Saved screens** (`backend/saved-screens.js`, `/api/screens`, Ask tool `save_screen`, buttons under an Ask answer
  that ran a screen, `screener.js` reads `?criteria=` / `?screen=`; browser-saved screens move to the account once).
  One criteria set per screen; still no index-membership, share-price or moving-average filter.
- **Voice input is PARKED and ships off.** Server route needs `STT_API_KEY`; the in-browser open-source model
  (`assets/voice-worker.js`) needs `VOICE_LOCAL_MODEL=true`, which also adds its CSP entries. With neither, the button
  is hidden and the CSP unchanged. The in-browser route has never run in a real browser. Measured: our AI provider's
  cloud takes no audio (all 18 models refused a real clip); Whisper needs 1.7 GB in our process; audio does work on
  a self-run Ollama with `gemma4:e2b`/`e4b` (16 kHz mono WAV, base64 in `images`), not on its cloud.
- **Listings.** Perplexity: submitted 10/09 through its Connector Marketplace form; write-up and the commitments made
  are in `docs/growth/perplexity-connector-2026-10-09.md`. Microsoft: agent package in
  `integrations/microsoft-365-copilot/` (README has the steps); Partner Center enrolment done, business verification
  with Microsoft. The Gmail connector rewrites links in sent mail; use web forms for outside mail.
- **`backend/node_modules` is no longer tracked.** It was a link to `~/prod/backend/node_modules` since `7df03ce05`,
  so any worktree `npm ci` emptied `~/prod`'s copy (three times on 10/9 to 10/10).
- Not checked before push: a real model calling `save_screen`; any real Microsoft or Perplexity client.
- Stale outside the repo: nothing (the published price was left at 2 everywhere).

## Stocks & funds page: peers, Pre-tax income, long-term assets — 2026-10-10 (`601587f5b`)

Owner report, reproduced with Fair Isaac (FICO).
- **Peers** are now same industry label, closest in market value: `GET /api/company/:symbol/peers`
  (`backend/company-peers.js`), falling back to the 4-digit SIC code, then the sector, when fewer than 3 match. The
  page used to show the first 7 rows of the sector screen, i.e. the sector's largest (NVDA, AAPL for every tech name).
  **Measured, do not retry SIC as the primary key:** on 20 tickers the industry label gives BA → LMT, GD, RTX; SIC
  gives BA → JOBY, ACHR and DIS → DKNG. FICO lands in "Software - Application" (TYL, GWRE, DOCU), not with the credit
  bureaus; no free classification puts it there.
- Labels come from committed `frontend/data/industry-map.json` (6,254 tickers, 145 labels), built by
  `node scripts/build-industry-map.js` from each `fundamentals/*.json` overview, then `company-profiles.json`. The
  weekly job rebuilds and stages it. The sector-based peer analysis in the dossier and Ask
  (`dossier-analysis.peerAnalysis`) is unchanged and still compares against the whole sector.
- **Pre-tax income** folds: two bank-only `solo` rows sat between it and its components in `ROWS.income`
  (`company.js`). A test now fails if any indented row in any statement has no parent.
- **Long-term assets:** `sec-facts.js` `MAPS.balance` gained `totalNonCurrentAssets`, `propertyPlantEquipment`,
  `operatingLeaseRightOfUseAsset`, `intangibleAssetsExcludingGoodwill`, `longTermInvestments`, `deferredTaxAssets`,
  `otherNonCurrentAssets`; each is a filed line, no remainder is computed. `EXTRACTION_VERSION` was deliberately
  NOT bumped (it is hashed into every source id). Stored data is unchanged until the weekly re-extraction
  (Saturdays 22:30 UTC) — until then only Goodwill unfolds. Checked on live SEC facts: FICO's six lines add to 1,164
  against 1,163 filed; existing figures and periods identical for FICO, JPM, SAP.
- **Open:** after the first weekly run, confirm FICO unfolds to six lines and that the gate passed with the new
  fields; `FiniteLivedIntangibleAssetsNet` is not read (a fragment for some filers), so Adobe shows no intangibles.
- Suite: 7 failures pre-exist on `main` (mcp-apps ×2, metric-ownership, money-formatter, reasoning-effort-coupling,
  reliability-guard, legacy-html-redirects). Asset stamp `20261010-peers1`.

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

## In flight

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
  (1239 pass). **No CI job runs the suite** (since 10/10 the pre-push gate does); 23 files need
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


## 2026-10-10 — site audit fixes (committed locally, NOT pushed)
- Stamp is now `20261010-audit1` (app.js, system.css, company.js, dossier.js; all pages + pinned tests).
- Fixed: `/api/portfolio/xray` 500 for a portfolio with nothing priced (`buildReveal` returns null, not a promise);
  company price chart axis no longer goes below $0; Form 4 names/roles decoded (`&amp;`) in `insiders.js`;
  "Filings last checked" shows a plain date; Ask on a phone lost the 44vh resize-grip gap and the cut-off credits line;
  Dossier says "every dollar", whole-number unit counts, no doubled sector label.
- Capex mapping widened in `sec-facts.js` and EXTRACTION_VERSION is now `20261010-capex1` (committed, unpushed).
  Measured: 1,968 of 5,138 issuers had no latest-year capex; a 200-issuer re-read filled 99. Pages do NOT self-heal:
  after the push, run `gh workflow run refresh-fundamentals.yml` (up to 6 h, no pushes to main meanwhile). Until then
  admin freshness reads "stale" (version mismatch); that is a warning, not the deploy gate.
- Stamp `20261010-audit2`. Gurus: options are separate rows tagged PUT/CALL (`keyOf`), tickers attached, names tidied,
  sidebar search. Ratios table opens on the newest year. Dossier trend charts side by side. Phone Dashboard/Screener fit.
- Local audit rig: `scratchpad/audit.js` (per-page overflow/console/404 metrics + screenshots over CDP).
- Gurus: 27 -> 57 (`backend/gurus.js` GURU_LIST + `GURU_META` bios in `gurus.html`). All 30 built locally from live 13Fs.
  Held back: Citadel, Millennium, D. E. Shaw, Point72 (2,400-7,200 rows, +100 MB while parsing), Tudor and Gotham
  (no performance strip), Harris/Oakmark (build returns nothing). 13F put/call rows are still listed as holdings.
- Comparison pages: negative money is `-$12.71B`; cells wrap under 600px (was 76px sideways scroll on a phone).
- Stamp `20261010-chart5`. Dossier flow chart: statement currency on labels, non-USD segments drawn, over-total segments drawn in proportion (measured 5,520 issuers: bands 2,974 -> 3,409; 889 have no stored breakdown, 154 single-business). Company answer cached gzipped 10 min (`_fundamentalsResponses`, app.js); page requests it at once. Stock and fund charts restyled after the Markets chart: card, round-number gridlines, soft
  fill, 2.2px line; phones get their own 420-wide drawing (`NARROW` GEOM in company.js; `area`/`fullWidth` in V2 chart).
  Screener phone cards were NOT restored: 031fdd2dc (June) replaced them with frozen-column scroll on purpose.
- Price history: chart series were unrefreshed since the 10/03 switch to the SEC job (1,250 stocks ended 2026-06-11, 1,572
  empty). New `backend/price-history.js` (reader top-up, 4-day staleness, 6 h memory) + `scripts/refresh-price-history.js`
  + weekly `refresh-price-history.yml`. All 4,358 files refreshed 10/10 and snapshots rebuilt; six gate checks passed
  locally. NOTE: the rebuilt coverage summary now says rules `capex1` although statements are still `core4` until the
  weekly rebuild runs, so admin freshness will NOT warn. 1,246 universe stocks have no fundamentals file at all.
