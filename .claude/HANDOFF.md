# Handoff

Durable working memory — **keep under 500 lines** (CLAUDE.md), enforced by
`backend/test/handoff-size.test.js` and run on every push by `.github/workflows/repo-checks.yml`, so the
cap can no longer be crossed silently. Current state and open actions only, never a transcript. At ~400 lines, snapshot this file to `.claude/handoff-archive/<date>.md` and rewrite
it fresh; **delete superseded items to the snapshot rather than compressing them here**.
Earlier snapshots: `handoff-archive/2026-10-01.md` (the previous live file, verbatim — the long `/mcp`
rebuild narrative, the CSP/CIMD scoping detail and the 9/29 OpenAI-package assumptions live there),
`handoff-archive/2026-09-30.md`, `handoff-archive/2026-09-28.md`.
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
- **Never log API keys, authorization headers, session tokens or sensitive data** — including into this
  transcript. `/tmp/fill-creds.mjs` shows the pattern for a secret a browser form needs: read the file
  in-process, hand it straight to the DOM, never through argv or stdout.

## In flight

**OpenAI ChatGPT plugin directory — the ONLY submission still moving. Portal draft is MCP-COMPLETE and the
review form is saved; three owner-only items and one click remain (10/01).**
Surface is `POST /mcp/apps` (`backend/mcp-apps.js` + `backend/mcp-financials.js`), 7 read-only intent tools over
the same auth/metering/data as `/mcp`. Package: `OPENAI_PLUGIN_SUBMISSION.md`; design note:
`notes/2026-09-29-openai-plugin-architecture.md`.
- **Live checks:** `scripts/verify-mcp-apps.js` = **17/17 keyed**; official MCP Inspector `--strict` against
  prod = **0 findings**, 7/7 tools `ro/dest = true/false`; `/mcp` legacy contract unchanged. `POST /mcp/apps`
  (the submitted URL, **not** `/mcp`) answers unauthenticated `initialize` *and* `tools/list` with **200** —
  the keyless trial, 50 lookups/30 days per visitor.
- **`/mcp/apps` takes `company`; `/mcp` takes `ticker`.** `backend/scripts/test-mcp.mjs` speaks the `/mcp`
  shape, so running it with `--url .../mcp/apps` reports one FAILED metered call (`COMPANY_REQUIRED`). That is
  the harness, not the surface — do not "fix" it by editing the tool schema.
- **Owner-only, in order:** (1) identity verification — submitted 9/30, reads **"Identity in review"**;
  publishing under an unverified name is an automatic rejection. (2) **Submit for review** (skill scans can
  take two hours). Still open, ours: the privacy policy's human legal review.
- **Both package-side blockers cleared on 10/01: the logo and the demo recording.** The recording requirement
  is step 5 of the review dialog and has **no dashboard field** — the URL must live in **`plugin.json`**
  (`extensions.com.openai.review.demo_recording_url`) and the ZIP must be uploaded again, which is the one
  upload that still has to happen. Because the ZIP carries the reviewer credentials' neighbours but *not* the
  credentials, **re-check the dashboard's five reviewer fields after that upload** (same check the logo
  re-upload got: `url=41 tenant=0 user=32 pw=32 steps=257`).

### The package
- **`openai-plugin/` → `openai-plugin.zip` via `scripts/build-openai-plugin.sh`** (Agent Plugins portable
  format; `plugin.json` + `mcp.json` at the archive root, assets under `assets/`, members listed explicitly
  because `plugin_root_has_siblings` rejects a plugin dir with sibling files). The script validates every
  referenced asset is square and ≥48×48 via `magick`, and now **warns when `demo_recording_url` is missing** —
  the one submission requirement no other check catches.
- **The logo is the owner's own, and it shipped 10/01.** `assets/{logo,composer-icon}.png` are both
  **512×512 PNGs on a transparent background**, scaled from the owner's 1254×1254 red-bull master (body
  `#EB1D1E`, corners `srgba(0,0,0,0)` — the master is transparent, not black, so it composites on light and
  dark surfaces alike). `magick <master> -resize 512x512 -strip -define png:color-type=6 <out>`. The build
  script only enforces what the uploader enforces — square and ≥48×48 — so a future swap needs an eye check
  too. This replaces the `frontend/Media/icon.png` placeholder the package shipped before.
- **The ZIP is the source of truth, not the form.** Listing text, the exactly-five-positive/three-negative
  review cases and the release notes all travel inside it and import on upload; the dashboard shows them
  **read-only** afterwards (`ro=true`, verified on tabs 1–2 of each step). `OPENAI_PLUGIN_SUBMISSION.md` §0
  records the deliberate choices: no `skills/` (that requirement is scoped to skills-only ZIPs); three starter
  prompts (the `defaultPrompt` cap is three); `commerce: false`; **no reviewer credentials** (ZIP metadata
  rejects `test_credentials`/`reviewer_instructions` — they go in the dashboard, which is what makes the
  re-upload risk below real); `demo_recording_url` is **set** as of 10/01 (see below). Every one of the
  five positive cases was **run against production** before its expected result was written down.
- **The walkthrough recording is real, and lives at `/assets/plugin-walkthrough.mp4`** (63s, 1280×688, 2.2 MB,
  made 10/01 by `scripts/record-mcp-walkthrough.mjs`). It is not a staged screen capture: the script runs
  `initialize`, `tools/list` and the five review cases **against production**, bakes those live responses into
  a local page, then captures that page over CDP — so every figure on screen is a filed value and the video
  dates itself. The Authorization header is never rendered, so the recording cannot leak the key it was made
  with. Re-record any time with `node scripts/record-mcp-walkthrough.mjs` (needs Chrome on CDP 9333 + ffmpeg);
  publish by committing the mp4, which **must not carry the skip marker** or production stays on the old file.
  Two capture traps, both hit for real: `Page.startScreencast` is **change-driven** and silently truncated a
  take at test case 3 — a 30s video for a 48s page, no error — so the script polls `Page.captureScreenshot`
  instead and **fails loudly** if the capture span is short; and `Emulation.setDeviceMetricsOverride` taller
  than the real window **clips** the bottom off every frame rather than scaling, so the window is sized first
  and the measured `innerHeight` is emulated exactly.
- **All five were RE-RUN against production 10/01, after OIDC and the comparison fixes deployed, and all five
  still match** — the expectations are not stale, which was the real risk: MSFT's latest 10-Q reading
  2026-03-31 looks outdated in October until you remember the June quarter is the 10-K, so a pipeline that was
  merely *correct* would have looked broken. Verified figures: AAPL revenue 416,161 / 391,035 / 383,285 /
  394,328M, FY2021 period ending **2021-09-25**; MSFT latest 10-Q filing 2026-04-29 accession
  `0001193125-26-191507` of 18 matched; AMZN 10-K filed 2026-02-06 accession `0001018724-26-000004` with
  `search_scope: extracted_sections` and 3 AWS excerpts; operating margin MSFT 46.7808 / GOOGL 32.0326 /
  AMZN 11.1553 **each carrying `ticker`** (the `86c1612d` fix, live) with the note reading *"up to 181 days
  apart … not simultaneous"* (the warning that used to never fire); MSFT revenue 331,839 against 281,724
  (**17.7887%**) with `eps_decomposition` 17.95 / 13.64 → net income 4.2756 + shares 0.0288.
  **The check is now permanent:** `node scripts/verify-mcp-apps.js --review-cases` (the flag adds only these
  five calls; full run is 23/23) reads each expectation **out of plugin.json** and requires every date,
  accession number and value in it to appear in the live response — so plugin.json stays the single source of
  truth and a filing that advances turns the check red instead of surprising the reviewer. It also proves it
  can fail: each figure is re-checked with its last digit changed and must then NOT match, because the first
  cut of this check passed vacuously — a value at the end of a sentence was truncated by a lookahead to
  `36581700000`, an 11-digit substring of the real 12-digit figure, so it would have matched anything.
  Decimals are skipped on purpose: the prose rounds some ("4.28" for 4.275553), so asserting on them would
  fail on wording, not drift.
- **Two real defects came out of that, fixed in `mcp-financials.js` + `mcp-apps.js` (`86c1612d`):**
  (a) `compare_company_metrics` flattened every company's observations into one series per metric with **no
  company identifier**, so a three-way comparison was a column of numbers whose owner could only be recovered
  by resolving the CIK inside each filing URL — each observation now carries `ticker`. (b) the misalignment
  warning computed its spread as **first minus last in the caller's order** rather than max minus min, so
  AMZN/MSFT/GOOGL — where the June-ending company sits in the middle — reported a 0-day spread and **the
  warning the tool's own description promises never fired**. Now max−min; `mcp-apps.test.js` pins both, and the
  middle-of-list case fails against the old code.

### The portal (draft `plugin_asdk_app_6abd5ccb15d48191a50f8fc678fd3732`, dev identity Individual — AVINASH SREEKUMAR)
- **MCP configuration is COMPLETE.** The MCPs tab has no warning dot and lists the server `stockportfolio` →
  `https://www.stockportfolio.pro/mcp/apps`, **Domain verified**, and all **seven discovered tools**:
  `search_companies`, `get_company_financials`, `get_metric_history`, `search_filings`, `get_filing_content`,
  `compare_company_metrics`, `get_financial_change_drivers`. Tabs **Metadata & Skills** = *No Issues*;
  Publication *Not published*; Review *Not submitted*.
- **The domain challenge is verified.** `OPENAI_APPS_CHALLENGE` (43 chars) is set on Render via
  `gh workflow run set-render-env.yml` (run `36763010793`, HTTP 200, value never echoed). **Render's
  env-triggered redeploy never appears in `gh run list`**, so `/.well-known/openai-apps-challenge` kept 404ing
  until `deploy-render.yml` was dispatched explicitly (run `36763142470`); after that it returns **HTTP 200
  with the exact token** and **Verify Domain** went green. If it 404s again, check the deployed service's env
  before the code. The route 404s by design when the var is unset (`backend/app.js:5784`).
- **Authentication is OAuth and the flow is verified end-to-end in production.** The modal first read
  *Authorization unavailable*, then *Authorization required* once the config saved with Authentication=OAuth.
  **Continue** opened `https://www.stockportfolio.pro/oauth/authorize?…`, which served our own consent screen
  (`Connect ChatGPT`, signed in as rin@gmail.com, Allow access / Cancel); approving it returned to the editor
  with discovery complete. **This is the path ChatGPT itself takes, so the reviewer WILL be asked to sign in —
  the demo account is required, not a fallback.** The editor also says it *"automatically determines the OAuth
  configuration of your MCP through discovered metadata"*, so the `/.well-known` documents are load-bearing and
  must stay reachable. The `Authentication` listbox could not be opened by synthetic pointer or mouse events
  (it is a `span[role=button]` React Aria listbox), which is part of why OAuth was kept rather than switched.
- **Review details are entered and saved** ("Progress saved"). Step 1 Countries = *All supported countries*,
  translations empty. Step 2 reviewer credentials: Login URL `https://www.stockportfolio.pro/login.html`,
  username `openai-review@stockportfolio.pro`, the 32-char password read from
  `/tmp/openai-reviewer-credentials.txt` by `/tmp/fill-creds.mjs`, plus sign-in steps naming the login page,
  the absence of MFA/emailed codes, and approving the OAuth consent screen. Step 5 shows the release notes
  imported and **"No video walkthrough URL provided"** — the only red item left.
- **The logo reupload was verified in production, 10/01.** Metadata came back **No Issues**, MCP
  configuration stayed **Configured**, and — the risk that actually mattered — **all five reviewer-credential
  fields survived** (`url=41`, `tenant=0`, `user=32`, `pw=32`, `steps=257`), because those live in the
  dashboard and the ZIP does not carry them. Test case 1 re-imported identically. "Incomplete review
  information" remains and is expected: it is the missing video URL and nothing else.
- **The upload entry point moves.** After review details are saved, the header's **"Upload new version"**
  disappears; the path is the right-panel drop zone **"Upload plugin to make changes"**, which is a real
  `input[type=file]` once clicked (attach with `DOM.setFileInputFiles`). The dialog that follows is "Reupload
  draft".
- **Reviewer account verified 10/01** — `openai-review@stockportfolio.pro` signs in on production
  (`POST /api/login` → 200, session issued, **no MFA / no emailed code / no magic link**), and the stored
  document carries `reviewAccount: true`, all four mail opt-outs and `analyticsConsent: false`
  (`scripts/create-openai-reviewer.js` writes through the **native collection**, bypassing `UserSchema`).
  **Exclusion is DONE (10/01).** `reviewAccount` is now a declared path on `UserSchema` — that mattered more
  than it looks: mongoose strips undeclared paths, so `User.findById` in `oauthCurrentUser` returned
  `undefined` and any guard would have silently never fired. Four reads now skip it: `trackActivation`
  (reviewer walks every tool by design, so counting it fabricates activation), the `mcp_oauth_authorized`
  event (the dashboard reads that as *"a real user approved a client"* and the reviewer MUST approve the OAuth
  client to exercise the plugin), the `/api/admin/customers` registry, and the trial-lifecycle drip.
  `test/internal-review-account.test.js` pins the flag, the schema path and all four exclusions — the schema
  half especially, because that is the one whose absence is invisible in Mongo.
- **Driving the portal over CDP:** `node /tmp/cdp-drive.mjs` (Chrome :9333, profile `/tmp/chatgpt-drive`).
  Synthetic `Input.dispatchMouseEvent` on a React tab does nothing — a plain `el.click()` works; and when two
  buttons share a label (e.g. the card's `Connect` behind the modal's), pick by bounding rect, not DOM order.

### OpenAI's OIDC requirement — found and fixed 10/01 (`656d4b52`, VERIFIED LIVE)
OpenAI requires an OAuth plugin to publish OIDC discovery metadata, advertise AND issue `openid` + `email`,
and expose a UserInfo endpoint returning `email` with `email_verified: true`. We had none of the three, and
`normalizeOauthScope` **rejected** every scope outside `OAUTH_SCOPES` — while ChatGPT asks for openid/email by
default from any server that ADVERTISES them. The connection would have been refused `invalid_scope` and read
as a dead connector, the same shape as the earlier `'mcp'` challenge bug. Added `OIDC_SCOPES`,
`OAUTH_SCOPES_SUPPORTED` (the union — what authorize validates and what both discovery documents advertise),
`/.well-known/openid-configuration` and `GET /oauth/userinfo`; claim-building lives in `oauth-oidc.js` so it is
unit-tested rather than source-pinned. **The RFC 9728 resource document still advertises data scopes only** —
the resource is the filings API and openid/email unlock nothing it reads. **No ID token is issued**: OpenAI
calls one optional, and a `jwks_uri` with no key set behind it is worse than the omission.

**The ChatGPT connector itself is LIVE in the owner's account (9/30)** — installed at `chatgpt.com/plugins`
(`/mcp`, Authentication OAuth), and a real chat called `search_companies("Nvidia")` →
`get_company_fundamentals(NVDA, quarterly, 1)` and answered from the 2026-07-26 10-Q (revenue $96.22B, net
income $59.69B, diluted EPS $2.46, FCF $21.40B), naming the four tools it did *not* call. Shares outstanding
returned *Not reported / null* — the never-estimate rule holding in the wild. **CIMD is not supported,
deliberately** (it would mean fetching an attacker-supplied HTTPS URL server-side); we omit
`client_id_metadata_document_supported`, so ChatGPT takes the DCR path (verified live: 201 + `client_id`).

**Glama:** its public connector page went Healthy on 9/30 via `59582a07`, but the manual **Test Profile** call
still reports `NETWORK_PAID_ONLY` when it exercises data calls from its datacenter. That refusal is now a tool
error rather than an HTTP 402, so the call itself should read; if a reviewer still needs it, use Glama's
test-credential process instead of opening data calls publicly.

**Filing Watch $49/month pilot — BUILT, VALIDATED, DEPLOYED flag-ON (`d642d04a`).** First-recurring-customers
experiment ($49/mo × 5 = $245/mo capacity). **$0 collected, zero offers sent** — the clock starts at the first
genuine checkout. Ops doc: `docs/growth/filing-watch-runbook.md`.
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

**Claude plugin directory — repo PUBLIC and installable NOW; only the submission form is left (9/25).**
`github.com/avisre/stockportfolio-claude-plugin` (public, MIT, 7 files — config and prose, no source);
`claude plugin marketplace add avisre/stockportfolio-claude-plugin` works today. Package:
`docs/growth/claude-plugin-submission.md`. **Chose the free plugin route, not the Connectors Directory** —
that portal needs a Team/Enterprise org, 2 seats × $25 = **$50/month just to unlock the form**. The free form
(`platform.claude.com/plugins/submit`) lists into the **community** catalog. Reviewer path: the **keyless tier
exercises every tool** (2 asks + 50 lookups/30d), so no credential handover. The npm/Claude bridge sees the
**six-tool `/mcp` catalog**; if the reviewer needs fund data, that is REST-only (`/api/v1/fund/:symbol`) —
declare it rather than implying `sp_fund` still exists on `/mcp`.

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
- **The MCP transport is the ONE surface the walls no longer decide.** `apiKeyAuthOptional` makes no decision
  at the transport: it verifies an offered key (a bad key still fails loudly, never a silent downgrade) and
  otherwise marks `req.anonMcp = true`. Identity, entitlement, allowance and the wall resolve inside
  `mcp-endpoint.js` at `tools/call` and return as **tool errors** the model can read;
  `initialize`/`tools/list` never consult a wallet. The old 402 (`NETWORK_PAID_ONLY`) is gone because directory
  probes run from datacenter IPs and the hosting wall classified **every** cloud range as hosting (measured:
  OpenAI/Azure, AWS, GCP, GitHub Actions and Googlebot all `true`; Comcast/Verizon `false`). The REST free
  tools and anonymous Ask still refuse at the route.
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
- **A CSP failure that exists only in production is invisible to a same-origin harness.** Chrome enforces
  `form-action` across *redirects*, so any POST-then-302-to-another-origin flow — the OAuth consent → client
  callback is the one that bit — needs that origin in the policy. The consent button was dead for every external
  MCP client while the loopback e2e passed 14/14, and it failed *silently*: no request, nothing a user would
  see. When a browser button "does nothing", read `Log.entryAdded` + `Network.loadingFailed` over CDP before
  touching the handler.
- `access_token()` in the GSC script returns a **tuple** `(token, client_email)`; treating it as a string 401s.
- zsh does not word-split unquoted variables: bulk `sed` needs `… | xargs sed -i '' …`.
- **Suite GREEN as of 10/01 (1067 pass, 0 fail).** **No CI job runs it** — `repo-checks.yml`
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
1. **OpenAI plugin submission** — the three items under In flight: the demo-recording URL, the logo, then
   Submit. This is the only submission that is still moving.
2. **Submit the Claude plugin** at `platform.claude.com/plugins/submit` — the repo is public and both
   preconditions are deployed and verified; see above.
3. **Dossier mockup review** — step 2, the port, has not started.
4. **URL Inspection → Request Indexing** on the highest-value pages — `Page with redirect` (604) + `Server
   error (5xx)` (2) need the UI drill-down; the API has neither. Re-run **Site Scan** and click **Investigate**
   on the identical-titles / identical-descriptions / noindex / **Title-too-long** cards: the 9/28 fixes answer
   all four, and those URL lists exist only in the Bing UI. Card 5 (inbound links) needs links that a sitemap
   row cannot supply.
5. **`avisre/prod` visibility** — it names the AI provider while public.
6. **Rotate the secrets exposed in local transcripts** (STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, JWT_SECRET,
   SMTP_PASS, GOOGLE_CLIENT_SECRET, the provider key) at source AND on Render back-to-back per key, or
   checkout and webhooks break mid-rotation. Also revoke the old GitHub PAT and npm token pasted 9/14.
7. **List-Unsubscribe + DMARC `rua`** before the next bulk send.
8. **Reopen-10-accounts script** (`scratchpad/.../reopen/run.js`) was blocked by the classifier — needs approval.
9. **`scripts/verify-receipts-panel.js` and `scripts/verify-send-receipt.js` are untracked.**
10. **AppSumo listing** is portal-only: paste + approval. The unredeemed buyers are unreachable — AppSumo holds
    their email, not us.
11. **Monthly provider bill** — the one input that states AI margin in dollars.
12. **Orphan IndexNow key** `1668f45a03ea53cf94c51b61c43163d4.txt` — confirm it is registered with an engine,
    or say to delete it.
13. **`mcp-server` republish** — its README documents the retired `sp_*` tool names; the published bridge
    proxies `/mcp` live so nothing is broken, but the npm page is now stale.
14. **ChatGPT connector polish** (optional, not blockers): the icon is the default placeholder, and the plugin
    still reads `DEVELOPMENT` review status — publish it from the plugin page if you want it directory-listed.
    Note this is the *connector* in your account, separate from the directory submission in item 1.
