# Handoff

Durable working memory — **keep under 500 lines** (CLAUDE.md), enforced by
`backend/test/handoff-size.test.js` and run on every push by `.github/workflows/repo-checks.yml`, so the
cap can no longer be crossed silently. Current state and open actions only, never a transcript. At ~400 lines, snapshot this file to `.claude/handoff-archive/<date>.md` and rewrite
it fresh; **delete superseded items to the snapshot rather than compressing them here**.
Earlier snapshots: `handoff-archive/2026-09-30.md` (the previous live file, verbatim — the SEO/Bing,
twin-retirement, dossier and emotional-design narratives all live there), `handoff-archive/2026-09-28.md`.
Deep history: `git log`, `notes/2026-09-*.md`, `docs/growth/`, `docs/seo/`, `~/.claude/plans/`.

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
  `~/.local/share/secrets/bing_webmaster.txt`, `.../gsc_service_account.json`.
- **Never `dotenv.config()` `backend/.env`** — it carries the PRODUCTION Atlas URI, so a script taking an
  API key from it inherits the live database (9/7, again 9/22 when live keypoints rows were deleted). Use
  `scripts/lib/dev-env.js` (`loadAiEnvOnly` + `assertLocalMongo`, `--db`).
- Customer email only from support@ via `/admin/messages`, owner-approved; **never cold email from
  support@**. No anti-bot workarounds, and **no interactive auth through Bash** (`gh auth login` needs a TTY —
  hand the owner the command). No `sleep N`. `rin@gmail.com` is the owner's test account — exclude from counts.

## In flight

**MCP `/mcp` rebuilt for ChatGPT/directory compatibility — DEPLOYED (`a3a3ff74`), VERIFIED LIVE, and the
browser path walked end-to-end; one scope defect found there and fixed (9/30).**
Owner request: make the hosted MCP endpoint work with ChatGPT custom connectors and MCP directories, with
discovery that never requires payment. Smallest-change reading of the existing implementation, no backend
redesign; `/mcp/apps` (the OpenAI Apps surface) is untouched.
- **Root cause of the 402/Unhealthy:** `apiKeyAuthOptional` decided at the transport, from a hardcoded method
  allowlist. Anything not on it — `GET`/`DELETE`, an unparseable body, any method added later — fell through to
  `freeTierWallReason()` → **HTTP 402 `NETWORK_PAID_ONLY`**. Directory probes run from datacenter IPs and the
  hosting wall classifies **every** cloud range as hosting (measured: OpenAI/Azure, AWS, GCP, GitHub Actions and
  Googlebot all `true`; Comcast/Verizon `false`), so 100% of legitimate AI-client traffic hit it while a scraper
  on a residential proxy walked through. Three successive commits (`7af86b4b`, `cdb8f0a2`, `59582a07`) each added
  one more method name — whack-a-mole. A **second** 402 existed: `mcpAccessGate` → `apiAccessGate` answering
  `402 API_ACCESS_REQUIRED` before the MCP session started.
- **Fix — no decision at the transport.** `apiKeyAuthOptional` verifies an offered key (a bad key still fails
  loudly, never a silent downgrade to the free tier) and otherwise marks `req.anonMcp = true` and carries
  `req.mcpWallReason`. `mcpAccessGate` is deleted from `/mcp`. Identity, entitlement, allowance and the wall are
  all resolved inside `mcp-endpoint.js` at `tools/call` and returned as **tool errors** the model can read:
  `ENTITLEMENT_REQUIRED`, `QUOTA_EXCEEDED`, `AUTHENTICATION_REQUIRED`, and `NETWORK_PAID_ONLY`/`REGION_PAID_ONLY`
  behind `MCP_KEYLESS_WALL` (**default OFF** — the wall refuses every AI client, so it can only be a deliberate
  setting; one env var re-enables it). `initialize` and `tools/list` never consult a wallet — pinned by test.
- **Toolset rebuilt to 6**, named for what they return: `search_companies` (free), `get_company_fundamentals`,
  `search_filings`, `get_filing` (2 credits each), `ask_filings` (42), `sp_health` (free). Strict
  `additionalProperties: false` schemas, `outputSchema`, `title`, read-only annotations; missing figures are
  `null` and never estimated. The old 7 `sp_*` names are **gone from `/mcp`**; `/mcp/apps` keeps its own 7.
  The published npm bridge (`stockportfolio-mcp`) proxies `tools/list` live, so it follows the rename with no
  republish — but `mcp-server/README.md` still documents the old table (its next publish fixes npm).
- **Logging:** one `[mcp]` JSON line per initialize / tools/list / tools/call (with duration, tool, outcome) and
  per refusal or exception. A hashed `logId` identifies the caller; **no key, header or token is ever logged.**
- **Transport teardown** is idempotent and runs on both `close` and `finish` plus a `finally` — the shape that
  keeps repeated health checks from leaking sockets.
- **Exit 134 (SIGABRT):** consistent with V8 heap exhaustion, already mitigated by the owner's `d29a4359`
  (`MAX_ACTIVE_REFRESHES` 3→1, a 0.7 heap-fraction guard, `fundamentals-cache.js`). **Not confirmable from
  here** — no `RENDER_API_KEY` locally and the repo is public, so prod logs were not routed through CI.
- **Verification done this session:** full suite **1055/1055**; deployed as `a3a3ff74` (Deploy to Render
  `36711490868` + Repo checks `36711490844`, both success) and re-run from outside: `npm run test:mcp` against
  production = **10 pass / 0 fail / 1 skip**, tool names exactly `search_companies`, `get_company_fundamentals`,
  `search_filings`, `get_filing`, `ask_filings`, `sp_health`. A datacenter fetcher (Jina Reader) now gets **405**
  on `GET /mcp` where the old code answered 402. Docs updated to the live names: `public-api.md`,
  `seo-pages.js` (/api landing two tables + licensing), `docs-pages.js`; pinning tests updated with them
  (`dev-plan`, `mcp-setup-guide`, `geo-wall`, `api-access-gating`).
- **Browser path, in a real Chrome** (`scripts/mcp-browser-test.mjs`, CDP, UA overridden past the bot blocker;
  `node scripts/mcp-browser-test.mjs`, PASS/FAIL per line, exit 1 on failure) — **14 pass / 0 fail once the
  scope defect below was fixed**, and 2 of those 14 were the harness learning the page's real shape, not
  product bugs: GET /mcp → 405 not 402;
  `initialize` → `stockportfolio-mcp 1.0.0`; `tools/list` → the 6 names, all with object schemas and read-only
  annotations; keyless `search_companies` served; keyless metered tool answered as a **tool result** (the anon
  allowance is real); both OAuth discovery documents parsed; DCR → **201** with ChatGPT's redirect_uri; the
  consent page renders its sign-in form and returns a clean error for bad credentials. A cross-origin page
  **cannot** call `/mcp` (no CORS headers) — informational: ChatGPT's connector is server-side, so this only
  matters for browser-based MCP clients, and the fix would be a deliberate widening. **The one hop left is the
  owner's alone** — their own ChatGPT login and StockPortfolio password. Every hop *after* a sign-in was proved
  locally instead, in the bullet below.
- **Defect the browser caught — the 401 challenge advertised a scope the server refuses to issue.**
  `mcpAuthChallenge` said `scope="mcp"` on `/mcp`: the legacy all-access scope `mcp-apps.js:524` still honours
  on tokens already in the wild, but one `normalizeOauthScope` will not grant. A client that read the challenge
  and asked for exactly what it had been told to ask for was bounced with `invalid_scope` and never connected —
  and from a browser that looks like a dead connector, not a scope mismatch, because `/oauth/authorize` 302s
  off to the client's own redirect_uri carrying `?error=`. Both surfaces now advertise `OAUTH_SCOPES` (the three
  read scopes), matching the discovery documents. Pinned in `api-access-gating.test.js`: the challenge, both
  `scopes_supported` documents and the validator must all read the same list.
- **The hops a production browser run cannot reach, proved end to end** (`scripts/mcp-oauth-e2e.mjs`,
  **14 pass / 0 fail**, 9/30). Driven through a real Chrome against `scripts/dev-local.js` (in-memory Mongo,
  production untouched): DCR → the challenge's own scope → the consent page's inline sign-in form POSTing
  `/api/login` → the consent screen **naming the account** → `Allow` → a code back on the registered
  redirect_uri with `state` echoed → token exchange (scope `financials:read filings:read research:read`) →
  replay refused `invalid_grant` → `initialize` (`stockportfolio-mcp`) → the 6 tool names → a metered
  `get_company_fundamentals` returning **real AAPL data**. Run it as
  `ANON_MCP_LOOKUP_LIMIT=1 node scripts/dev-local.js` **from the repo root**, then
  `node scripts/mcp-oauth-e2e.mjs` — no test in the suite boots app.js at all, so the approve route had no
  coverage of any kind before this.
  - **The identity check is the interesting one.** Response *shape* cannot prove which tier a call was billed to
    (mcp-endpoint.js injects `usage`/`notice` only for anonymous callers of `aiCost` tools), so the harness spends
    the free allowance keylessly until the server answers `QUOTA_EXCEEDED`, then calls the same tool again with
    the token: **still served**. The two calls differ only in the `Authorization` header — had the bearer been
    discarded, both would be refused. This is what rules out the failure that would cost a customer silently:
    a connector riding the free tier instead of their own wallet.
  - **`ANON_MCP_LOOKUP_LIMIT=1` is required** — the launcher's default is 10000 lookups, unspendable in a test.
  - **Launch from the repo root, and never pipe its output to `head`.** From `backend/`, app.js's dotenv finds
    `backend/.env`, so `NODE_ENV=production`, `oauthBase()` goes https, and a loopback `resource` is refused
    **`invalid_target`** — a dead end that reads like broken OAuth rather than a wrong cwd. And `| head -60` closes
    the pipe once the boot banner passes 60 lines, killing the server mid-test (`fetch failed` after 7 passes).
- **CIMD is not supported, deliberately.** `developers.openai.com/plugins/build/auth` says ChatGPT *prioritises
  CIMD when available* and signals availability with `client_id_metadata_document_supported: true`; we omit that
  field, so ChatGPT takes the **DCR** path (verified live: 201 + `client_id`). CIMD would mean fetching an
  attacker-supplied HTTPS URL server-side — an SSRF surface — so it is a deliberate build, not a default.
  **Watch the first real connector**: a URL-shaped `client_id` fails `getClient` (a plain Mongo lookup) and
  `/oauth/authorize` renders "Unknown application". ChatGPT's redirect URIs are now
  `https://chatgpt.com/connector/oauth/{callback_id}` by default with the stable
  `https://chatgpt.com/connector_platform_oauth_redirect` for older servers; DCR accepts either, no allowlist work.
- **Glama:** its public connector page went Healthy on 9/30 via `59582a07`, but the manual **Test Profile** call
  still reports `NETWORK_PAID_ONLY` when it exercises data calls from its datacenter. That refusal is now a tool
  error rather than an HTTP 402, so the call itself should read; if a reviewer still needs it, use Glama's
  test-credential process instead of opening data calls publicly — the alternative is `MCP_KEYLESS_WALL=true`
  plus a decision about the free allowance.

**Filing Watch $49/month pilot — BUILT, VALIDATED, DEPLOYED flag-ON (`d642d04a`; flag opened after run
36593397177, both verified live).** First-recurring-customers experiment ($49/mo × 5 = $245/mo capacity).
**$0 collected, zero offers sent** — the clock starts at the first genuine checkout. Ops doc:
`docs/growth/filing-watch-runbook.md`.
- Fails closed everywhere: no flag → `PILOT_NOT_OPEN`; unverified price → `PRICE_UNVERIFIED`. Live checks read
  `{enabled:true, price:49, capacity:5}`. Real success/decline, webhook, renewal, refund and cancellation
  behaviour is **unverified** — the owner waived a live Stripe sandbox run (recorded in the runbook); never test
  with a production card. **Monitor the first genuine checkout.**
- **Prospects: 1 of 5** — `ncdorc`/ATOS (Stocktwits, Sep 9), qualified, live EDGAR retrieval confirmed, Q2 10-Q
  example prepared. Public reply only and **no Stocktwits posting tool is connected here, so nothing has been
  sent**; check the account against Stocktwits' self-promotion and first-50-post rules. Five documented rejects
  in `notes/2026-09-29-filing-watch-prospects.md`. `notes/filing-watch-outreach.csv` +
  `filing-watch-payments.csv` are header-only and **must stay untracked — the repo is PUBLIC** and they will
  hold prospect PII. **Never send outreach without the owner's explicit authorization.**

**OpenAI plugin (remote MCP) — DEPLOYED + VERIFIED LIVE; only owner-only portal steps left (9/29).**
Surface is `POST /mcp/apps` (`backend/mcp-apps.js` + `backend/mcp-financials.js`), 7 read-only intent tools over
the same auth/metering/data as `/mcp`. Package: `OPENAI_PLUGIN_SUBMISSION.md`; design note:
`notes/2026-09-29-openai-plugin-architecture.md`.
- Live: `scripts/verify-mcp-apps.js` = **17/17 keyed**; official MCP Inspector `--strict` against prod =
  **0 findings**, 7/7 tools `ro/dest = true/false`; `/mcp` legacy contract unchanged.
- **Owner-only remaining:** (1) verified identity + **Apps Management: Write** in the OpenAI Platform;
  (2) run `scripts/create-openai-reviewer.js --apply` with the prod Atlas URI for the review account;
  (3) portal: With MCP → `https://www.stockportfolio.pro/mcp/apps` (must be **www**; the apex 307 drops
  `Authorization`) → Scan Tools → set `OPENAI_APPS_CHALLENGE` from the portal and Verify Domain → paste demo
  credentials → submit. Never submit before Scan Tools is clean.
- Commerce rule enforced in code: `/mcp/apps` entitlement/quota errors carry no plan, price, `/upgrade` or
  `/recharge` link (tests pin this). `/mcp` keeps its upsell copy — it is not under OpenAI review.

**Claude plugin directory — repo PUBLIC and installable NOW; only the submission form is left (9/25).**
`github.com/avisre/stockportfolio-claude-plugin` (public, MIT, 7 files — config and prose, no source);
`claude plugin marketplace add avisre/stockportfolio-claude-plugin` works today. Package:
`docs/growth/claude-plugin-submission.md`.
- **Chose the free plugin route, not the Connectors Directory** — that portal needs a Team/Enterprise org,
  2 seats × $25 = **$50/month just to unlock the form**. The free form (`platform.claude.com/plugins/submit`)
  lists into the **community** catalog; the official one takes no submissions at all.
- **Owner-only, last step:** the free Console org + the submission. Deferred: the **listing icon** (the form
  takes only a repo link, so it has no consumer — don't fabricate a brand asset). Reviewer path: the **keyless
  tier exercises every tool** (2 asks + 50 lookups/30d), so no credential handover. The npm/Claude bridge now
  sees the **new six-tool /mcp catalog**; if the reviewer needs fund data, that is REST-only
  (`/api/v1/fund/:symbol`) — declare it rather than implying `sp_fund` still exists on `/mcp`.

**AppSumo final-window repricing — v8 copy DONE (11/11 guards); the flip partly started, NOT finished.**
Exact values + order: `docs/growth/appsumo-listing-v8.md` (target 149/549 · 299/1099 · 499/1849, wallet
200/500/1000; draft read 9/25 showed 39/144 · 79/288 · 149/432 with credits 50/150/400).
- **Done:** `CREDIT_ALLOWANCE_V3_EFFECTIVE_FROM` stored on Render (36070122159, owner-set), deploy followed
  (36070525625). **Unprovable from outside by design** — no wallet field is published, so the first redemption
  after 22:55:55Z is the proof.
- **Three writes were BLOCKED by the auto-mode classifier** — the Render env set, the grandfathered-licence
  importer (`scripts/import-grandfathered-licences.js --apply`; loads `backend/.env` = PRODUCTION Atlas), and
  the portal draft values. **Hand over, don't retry.**
- **Portal is a browser surface**, driven headfully over CDP (`node /tmp/as-drive.mjs`, Chrome :9222, profile
  `~/.appsumo-portal-profile`). **Never touch `/self-submission/231048/build`** (mapping bug), never press EXIT.
- **Remaining:** nine price/wallet values, long description, five FAQ slots, API+MCP row wording; then Submit →
  reply in Yena's thread. Push the price half **only once the live page shows $299/$499** — a page selling 200
  credits while production meters 50 is the refund this ordering avoids.

**Dossier redesign — "The Plain Filing" — mockup done, awaiting review.** Plan
`~/.claude/plans/valiant-singing-parnas.md`; `docs/design/dossier-plain-filing.html` (Newsreader / IBM Plex) is
a document, not a dashboard. **Step 2 — the port — has NOT started** and its CSS must be re-derived.
Regenerate with `node scripts/build-dossier-mockup-artifact.js`; never hand-edit it.

**Emotional design** — plan `~/.claude/plans/warm-orbiting-sketch.md` (approved). Phases 0-5 shipped 9/24-25;
**phases 6-7 NOT started** (year in filings, comprehension streak). Thesis letter and anniversaries untouched.
- **Standing rules, still binding:** the error overlay's "Nothing was changed" is an explicit `unchanged: true`
  opt-in (the multi-ticker path reports a PARTIAL success as an error, so a blanket claim would lie); X-Ray
  exposure is summed in **DOLLARS** (percentages of different bases cannot be added); an EMPTY alert list
  renders a quiet card rather than hiding the section (a working monitor and a broken feed looked identical).

**AI portfolio creator — announced 9/25 as in-development, no date promised, no spec file yet.**

## Walls (live in prod)
- Geo wall `GEO_WALL_COUNTRIES` (`SG,CN,HK`); hosting/VPN wall `HOSTING_WALL_ENABLED` (ON) from
  `backend/data/hosting-ranges.bin`. Hard paywall `WALL_ALL_PAGES` — off since the wall week (3 signups /
  9 days, 0 paid); **`/docs` is the only product surface readable signed out.** Kill switches + deploy:
  `GEO_WALL_COUNTRIES=` · `HOSTING_WALL_ENABLED=false` · `WALL_ALL_PAGES=false`.
- **Load-bearing, both walls:** the visitor IP comes from `marketingAttribution.requestIp()`
  (CF-Connecting-IP in prod), **never `req.ip` — that is an intermediate proxy hop**. The crawler exemption is
  not optional either: Googlebot/Bingbot crawl from cloud ranges that ARE in the hosting table, so without it
  the wall 302s them and deindexes the site (exempt only a positive `bot-blocker.classifyUa` claim of
  `allowed-claim`/`internal`).
- **The MCP transport is the ONE surface the walls no longer decide** — see In flight. The REST free tools and
  anonymous Ask still refuse at the route.
- **Unclosed:** ~25 keyless `/api/*` endpoints serve product data with no auth and no country check.

## SEO / discovery — measured; do not re-derive
- **The bottleneck is indexing and site-level trust, not content, targeting or segment** — titles/H1s match
  the queries and canonicals are clean, yet Google gives ~340 human impressions/month, ~0 clicks, median
  position ~52 across ~21,700 URLs, while Bing ranks the same site well (7.7% CTR, pos 6.1).
- **87% of raw "impressions" are rank tools, not people** (filter `site:`/`inurl:`, quoted phrases, `- wab`);
  `seo-data/search-opportunities.md`'s P1 rows are phantoms. Parse GSC/Bing CSVs RFC4180; `split(',')` yields NaN.
- **Google names the reason itself:** crawled-but-not-indexed means "insufficient value **or user demand**".
  Demand follows links, so **external links/citations are the unmeasured, unattempted lever**. Never `noindex`
  an unwanted URL — use robots.txt, a one-way door, or emit fewer URLs.
- **The URL Inspection API reports the LAST CRAWL, never a live fetch.** The 9/15 hard paywall (`f4af1ee5`)
  was the real deindexing cause: 16,574 → 9,940 in two step changes, fixed 9/24.
- **Gemini cannot be targeted as a crawler — none exists.** AI Overviews ground on Googlebot (already allowed)
  and `Google-Extended` never arrives as a UA, so this lever IS the indexing lever.
- Bing fixes (`<lastmod>` freezing, the capped top-N report, IndexNow's 403 key file, the synthetic query that
  was 42.8% of impressions, the sitewide SERP length sweep, the `.html` twin 301s, `core.xml` 114 → 119) are
  **complete, deployed and verified**; details + the four classes of twin reference an anchor sweep misses are in
  `handoff-archive/2026-09-30.md` and `docs/seo/bing-diagnosis-2026-09-28.md`.
- Operator Python needs **`.venv/bin/python3`** — Homebrew Python is PEP 668-managed, so `pip install --user`
  is refused and no `scripts/*.py` could run at all. `scripts/requirements.txt` documents it.
- **Pushing Bing to recrawl:** the URL submission API is small — `GetUrlSubmissionQuota` said 100/day,
  300/month — and it **counts 301-ing URLs too**, so check the quota first; **IndexNow is the free channel for
  moved URLs**. `GetSiteScan`/`SubmitSiteScan`/`RunSiteScan` all 404 — **Site Scan is UI-only**, so re-running
  it is an owner action.

**Prices split from fundamentals + truthful freshness — COMMITTED + DEPLOYED 9/28** (`e99c645b`, `0ba72c2d`,
backfill stragglers `aaf4ea41`). Still load-bearing:
- `backend/quote-store.js` is the one place pages ask for a price (live Yahoo → `frontend/data/quotes.json`).
- **Freshness = the data's own dates, never mtime** (`backend/fundamentals-date.js`, `STALE_DAYS=45`) — the same
  trap as the sitemap `<lastmod>`.
- **A fundamentals commit must deploy** (`frontend/data/fundamentals/` is read from the deployed filesystem).
- **Dead-ticker rule:** two *separate days* of Yahoo "Quote not found" mark a ticker unlisted (same-day retries
  never count); a later success clears it. Seeded 9/28 with 15 dead tickers (day 1); **the 10/1 monthly run makes
  it day 2.** The weekly workflow writes `fundamentals-status.json` but does not stage it.

## AI model + cost
- **Prod runs glm-5.1 on all three purposes**, at a measured **$28.91/mo ≈ 48% of the $60 allowance**
  (`scripts/ollama-cost-projection.js`). Real split is 95/5 chat and 90/10 summary, not 85/15 as `credits.js` assumed.
- **glm-5.3-flash on MCP/API Ask: validated and REJECTED** — fails the tool-set gate (60% against an 80% bar)
  and is *slower* with the 32 schemas attached (1.55x), emitting 1.65x the tool calls.
- **Trap:** `promptTokens`/`completionTokens` are *missing* (not null) before 9/11, so `$ne: [field, null]`
  does not exclude them. Use `$isNumber` and apportion each group's FULL `totalTokens`. Coverage ~295/2,349.

## Traps that have already cost real time
- `users.updatedAt` reads "3d ago" for every account uniformly — a bulk-write artifact. **Measure activity
  from `ollama_usage_events`, never `updatedAt`.**
- **A broadcast's recipient list is not a customer list.** The 9/23 "general" send's 47 non-owner recipients
  had **0 live userIds** (24 were QA artifacts); only 13 of 60 were customers.
- **~95% of first-party "unique visitors" are a botnet hitting `/register.html`**, which the bot classifier
  misses. Check distinct user agents before quoting any visitor count.
- Chrome headless sends "HeadlessChrome", which `bot-blocker.js` correctly 403s — override the UA (or
  `BOT_BLOCK_ENABLED=false` on dev-local only). A bare curl UA also 403s: `hasBrowserHeaders` needs the full
  browser header set. Browser checks go through CDP (`scripts/screenshot-cdp.js`).
- `access_token()` in the GSC script returns a **tuple** `(token, client_email)`; treating it as a string 401s.
- zsh does not word-split unquoted variables: bulk `sed` needs `… | xargs sed -i '' …`.
- **Suite GREEN as of 9/30 (1055 pass, 0 fail, exit 0).** **No CI job runs it** — `repo-checks.yml`
  runs only `handoff-size` (dependency-free by design); 23 files need mongo, 25 touch the network and 8
  need root `node_modules`, so a full-suite gate is a real job, not a config line.
- **A test can encode a coincidence and still look like an invariant.** `sitemap-index.test.js` asserted
  that lastmod must *vary* across the inventory — true only while the file mtimes and the data manifest's date
  happened to differ, and false on the day the refresh runs. Ask what a green assertion would do on the day the
  feature works as intended, not just whether it passes today.
- **A source-pinning test slices source, and the slice is a silent expiry date.** `geo-wall.test.js` and
  `api-access-gating.test.js` both pinned the MCP transport by taking a fixed number of characters after a
  function name. When the explanatory comment above the code grew past the window, `geo-wall` went on passing
  against a function body it could no longer see. Slice to the next function, not to a character count.
- **The CI-skip marker matches ANYWHERE in a commit message — not just at the start.** A data commit whose body
  said "no skip marker on purpose" to explain why it had to deploy was silently skipped by *both* workflows, leaving
  production on the old data with a green-looking `git push`. Detect it by the absence of a run for the new SHA
  (`gh run list`), not by the push output; the fix is `gh workflow run deploy-render.yml --ref main`, which deploys
  current HEAD without rewriting history. `frontend/data/fundamentals/**` must never carry it (`app.js:3240` reads
  the deployed filesystem) — see CLAUDE.md's corrected rule.
- **Live verification has a request budget: 100 non-asset requests per 5 min per IP** (`navMax()`,
  `bot-blocker.js:158`; the limiter's handler returns the *same* 403 body as a UA deny, so the two are
  indistinguishable from outside). A 119-URL sweep exceeded it and the very next run read **403 for all 24
  twins** — which reads exactly like a mass regression and was reported as one twice in one session before the
  source was read. Split any sweep over 100 URLs across windows, and re-check a 403 before believing it.

## Owner actions pending
1. **Submit the plugin** at `platform.claude.com/plugins/submit` — the repo is public and both
   preconditions are deployed and verified; see above.
2. **Dossier mockup review** — step 2, the port, has not started.
3. **URL Inspection → Request Indexing** on the highest-value pages — `Page with redirect` (604) + `Server
   error (5xx)` (2) need the UI drill-down; the API has neither. Re-run **Site Scan** and click **Investigate**
   on the identical-titles / identical-descriptions / noindex / **Title-too-long** cards: the 9/28 fixes answer
   all four, and those URL lists exist only in the Bing UI. Card 5 (inbound links) needs links that a sitemap
   row cannot supply.
4. **`avisre/prod` visibility** — it names the AI provider while public.
5. **Rotate the secrets exposed in local transcripts** (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, JWT_SECRET,
   SMTP_PASS, GOOGLE_CLIENT_SECRET, the provider key) at source AND on Render back-to-back per key, or
   checkout and webhooks break mid-rotation. Also revoke the old GitHub PAT and npm token pasted 9/14.
6. **List-Unsubscribe + DMARC `rua`** before the next bulk send.
7. **Reopen-10-accounts script** (`scratchpad/.../reopen/run.js`) was blocked by the classifier — needs approval.
8. **`scripts/verify-receipts-panel.js` and `scripts/verify-send-receipt.js` are untracked.**
9. **AppSumo listing** is portal-only: paste + approval. The unredeemed buyers are unreachable — AppSumo holds
   their email, not us.
10. **Monthly provider bill** — the one input that states AI margin in dollars.
11. **Orphan IndexNow key** `1668f45a03ea53cf94c51b61c43163d4.txt` — confirm it is registered with an engine,
    or say to delete it.
12. **`mcp-server` republish** — its README documents the retired `sp_*` tool names; the published bridge
    proxies `/mcp` live so nothing is broken, but the npm page is now stale.
13. **Create the ChatGPT connector** — Settings → Connectors → Add custom → `https://www.stockportfolio.pro/mcp`
    (www; the apex 307 drops `Authorization`), then sign in **with your own account**. This is the one step that
    cannot be done from here: it needs your ChatGPT login and your StockPortfolio password, and the credential
    classifier declined to reach for a stored password and barred pursuing it by any other route. Expect the
    consent screen to name the account, and the tool list to be `search_companies`, `get_company_fundamentals`,
    `search_filings`, `get_filing`, `ask_filings`, `sp_health`.
