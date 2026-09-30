# Handoff

Durable working memory — **keep under 500 lines** (CLAUDE.md), enforced by
`backend/test/handoff-size.test.js` and run on every push by `.github/workflows/repo-checks.yml`, so the
cap can no longer be crossed silently. Current state and open actions only, never a transcript. At ~400 lines, snapshot this file to `.claude/handoff-archive/<date>.md` and rewrite
it fresh; **delete superseded items to the snapshot rather than compressing them here**.
Earlier snapshots: `handoff-archive/2026-10-01.md` (verbatim, taken 10/01 at 409 lines — the `/mcp` rebuild
narrative, the CSP/CIMD scoping detail, the OIDC fix, the full five-case verification figures, the recording
capture traps and the logo-reupload credential check all live there), `handoff-archive/2026-09-30.md`,
`handoff-archive/2026-09-28.md`.
This file was **edited in place**, not rewritten, after that 10/01 snapshot, so the archive's Claude section
still carries the "blocked on a claude.ai sign-in" wording for an item that has since gone `In review`. One
snapshot per date is the rule — a second take of a near-identical file was taken, then dropped, because the
live file's own git history already holds it (`10c5769a`, `2d770e8b`).
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
- **`notes/filing-watch-*.csv` must stay untracked — the repo is PUBLIC** and they will hold prospect PII.

## In flight

**OpenAI ChatGPT plugin directory — submitted 10/01, package-side items all DONE; what remains is owner-only.**
(The Anthropic submission below is the second live submission; neither is blocked on us.)
Surface is `POST /mcp/apps` (`backend/mcp-apps.js` + `backend/mcp-financials.js`), 7 read-only intent tools over
the same auth/metering/data as `/mcp`. Package: `OPENAI_PLUGIN_SUBMISSION.md`; design note:
`notes/2026-09-29-openai-plugin-architecture.md`.
- **Live checks:** `scripts/verify-mcp-apps.js --review-cases` = **23/23** against production (re-run 10/01
  after every deploy); official MCP Inspector `--strict` = **0 findings**, 7/7 tools `ro/dest = true/false`;
  `/mcp` legacy contract unchanged. `POST /mcp/apps` (the submitted URL, **not** `/mcp`) answers
  unauthenticated `initialize` *and* `tools/list` with **200** — the keyless trial, 50 lookups/30 days per
  visitor.
- **`/mcp/apps` takes `company`; `/mcp` takes `ticker`.** `backend/scripts/test-mcp.mjs` speaks the `/mcp`
  shape, so running it with `--url .../mcp/apps` reports one FAILED metered call (`COMPANY_REQUIRED`). That is
  the harness, not the surface — do not "fix" it by editing the tool schema.
- **SUBMITTED FOR REVIEW 10/01 — no longer owner-blocked.** The dialog is a **six-item compliance attestation**
  (`button[role=checkbox]`, all unchecked, Submit greyed out until every one is ticked) — nothing in it shows
  the reviewer credentials. After Submit the page **navigated itself from the draft to `/plugins`**, and the
  state is now **Review status "In review"**, version chip **`1.0.0 · In review`** (was `· Draft`), and the
  header button changed from *Submit for review* to **Cancel review**. **That header-button change is the
  reliable confirmation** — the status chips took ~30s to flip and the modal sat on a spinner throughout, so
  a slow poll reads as "nothing happened" right up until it doesn't. While a review is active the metadata
  **"No Issues" badge is replaced** by *"Choose or upload a draft to check metadata"*; that is expected, not a
  regression. Skill scans can take two hours. **Only one review may be active per plugin** — *Cancel review* is
  now a live header control, so do not press it casually; it withdraws the submission.
- **Identity verification is still "Identity in review"** — the owner's part is DONE (Persona, OpenAI's
  verifier, returned *"Congratulations, you're done!"* on 9/30 18:24 UTC). Org settings says why it matters:
  *"Verify as an individual or business to access protected models and submit ChatGPT apps."* Publishing under
  an unverified name is an automatic rejection, so it must clear before the app goes live.
- **UNVERIFIED, and the one real loose end: the five reviewer-credential fields.** The *"Add review
  information"* button appeared in the header **only while the review dialog was loading** and was gone from
  the DOM once it settled, so the panel could not be reached and the credential-survival question was never
  answered. If the review comes back asking for access, the credentials are at
  **`~/.config/stockportfolio/reviewer-account.txt`** (mode 600 — moved out of `/tmp` on 10/01, which is what
  this line used to ask for). Still open, ours: the privacy policy's human legal review.
- **The ZIP upload is done (10/01).** Portal re-ran its metadata checks and reports **No Issues**; version
  still `1.0.0 · Draft`. The served mp4 is **byte-identical** to the committed file (sha256 `119862d7…`,
  1,483,166 bytes), so the reviewer's URL is exactly the recording.
- **"No video walkthrough URL provided" is static dashboard copy — do not chase it.** The review panel prints
  that line next to the step-5 instruction even after a successful upload, and would print it whatever the ZIP
  contained, because the dashboard has no field for the URL by its own wording. The authoritative check is
  `unzip -p openai-plugin.zip plugin.json`, never anything the portal renders.
- **The reviewer-credential re-check needs the Submit-for-review wizard, and that is the owner's to open.**
  The review-information panel holds the five credential fields (`url=41 tenant=0 user=32 pw=32 steps=257` when
  last checked) and the step-5 status. It is **not in the DOM** on the details tab and not merely hidden:
  `documentElement.innerHTML` contains neither "Reviewer credentials" nor "Add review information", and there
  are **no `[role=dialog]` elements at all**, so it renders only on entering the wizard. The header's **"Submit
  for review"** is the only such control (`disabled:false`, `aria-disabled:null`, no verification warning
  anywhere on the page), and **whether it opens the wizard or fires the submission could not be determined from
  outside, so it was not clicked.**
  **Correction (10/01): the "mapping bug / never press EXIT" rule belongs to the AppSumo portal, not this
  wizard** — an earlier note carried it over here by mistake. The real reason to leave this to the owner is
  simply that a submission is irreversible and one-shot. Check the credentials at the same sitting: they live in
  the dashboard, and the ZIP does not carry them.

### The package
- **`openai-plugin/` → `openai-plugin.zip` via `scripts/build-openai-plugin.sh`** (Agent Plugins portable
  format; `plugin.json` + `mcp.json` at the archive root, assets under `assets/`, members listed explicitly
  because `plugin_root_has_siblings` rejects a plugin dir with sibling files). The script validates every
  referenced asset is square and ≥48×48 via `magick`, and **warns when `demo_recording_url` is missing** —
  the one submission requirement no other check catches.
- **The logo is the owner's own and shipped 10/01.** `assets/{logo,composer-icon}.png` are both **512×512 PNGs
  on a transparent background**, scaled from the owner's 1254×1254 red-bull master (body `#EB1D1E`). The build
  script only enforces what the uploader enforces — square and ≥48×48 — so a future swap needs an eye check too.
- **The ZIP is the source of truth, not the form.** Listing text, the exactly-five-positive/three-negative
  review cases and the release notes all travel inside it and import on upload; the dashboard shows them
  **read-only** afterwards (`ro=true`, verified on tabs 1–2 of each step). `OPENAI_PLUGIN_SUBMISSION.md` §0
  records the deliberate choices: no `skills/` (that requirement is scoped to skills-only ZIPs); three starter
  prompts (the `defaultPrompt` cap is three); `commerce: false`; **no reviewer credentials** (ZIP metadata
  rejects `test_credentials`/`reviewer_instructions` — they go in the dashboard, which is what makes the
  re-upload risk real); `demo_recording_url` set. Every positive case was **run against production** before its
  expected result was written down.
- **The walkthrough recording is real and lives at `/assets/plugin-walkthrough.mp4`** (64.6s, 1280×688, 1.4 MB,
  made 10/01 by `scripts/record-mcp-walkthrough.mjs`). It is not a staged capture: the script runs
  `initialize`, `tools/list` and the five review cases **against production**, bakes those live responses into
  a local page, then captures that page over CDP — every figure on screen is a filed value. The Authorization
  header is never rendered, so the recording cannot leak the key it was made with. The script's own header
  comment documents the three capture traps (screencast truncation, viewport clipping, page-timer throttling)
  — read it before changing the capture. Re-record with `node scripts/record-mcp-walkthrough.mjs` (Chrome on
  CDP 9333 + ffmpeg); **publish by committing the mp4, which must NOT carry the skip marker**, and **a
  re-recording needs a new filename** — `staticCacheHeaders` gives `.mp4` the same `ONE_YEAR` immutable header
  as `.js`, so overwriting would never reach anyone who already fetched it.
- **The five review cases are checked permanently: `node scripts/verify-mcp-apps.js --review-cases`.** It reads
  each expectation **out of plugin.json** and requires every date, accession number and value in it to appear in
  the live response, so plugin.json stays the single source of truth and a filing that advances turns the check
  red instead of surprising the reviewer. It also proves it can fail: each figure is re-checked with its last
  digit changed and must then NOT match. Decimals are skipped on purpose — the prose rounds some ("4.28" for
  4.275553), so asserting on them would fail on wording, not drift.
- **Two defects that check caught are fixed and pinned** (`86c1612d`, `mcp-financials.js` + `mcp-apps.js`):
  `compare_company_metrics` flattened companies into one series with no company identifier (each observation now
  carries `ticker`), and the misalignment warning computed first-minus-last instead of max-minus-min so it
  **never fired** for mid-list companies. `mcp-apps.test.js` pins both.

### The portal (draft `plugin_asdk_app_6abd5ccb15d48191a50f8fc678fd3732`, dev identity Individual — AVINASH SREEKUMAR)
- **MCP configuration is COMPLETE.** MCPs tab has no warning dot and lists the server `stockportfolio` →
  `https://www.stockportfolio.pro/mcp/apps`, **Domain verified**, and all **seven discovered tools**.
  **Metadata & Skills** = *No Issues*; Publication *Not published*; Review *Not submitted*.
- **The domain challenge is verified.** `OPENAI_APPS_CHALLENGE` (43 chars) is set on Render via
  `gh workflow run set-render-env.yml` (value never echoed). **Render's env-triggered redeploy never appears in
  `gh run list`**, so the route kept 404ing until `deploy-render.yml` was dispatched explicitly; if it 404s
  again, check the deployed service's env before the code. It 404s by design when the var is unset
  (`backend/app.js:5784`).
- **Authentication is OAuth and the flow is verified end-to-end in production.** The editor says it
  *"automatically determines the OAuth configuration of your MCP through discovered metadata"*, so the
  `/.well-known` documents are load-bearing and must stay reachable. The `Authentication` listbox could not be
  opened by synthetic pointer or mouse events (a `span[role=button]` React Aria listbox), which is part of why
  OAuth was kept rather than switched.
- **Review details are entered and saved** ("Progress saved"). Step 1 Countries = *All supported countries*.
  Step 2 reviewer credentials: Login URL `https://www.stockportfolio.pro/login.html`, username
  `openai-review@stockportfolio.pro`, the 32-char password read in-process by `/tmp/fill-creds.mjs` from
  `~/.config/stockportfolio/reviewer-account.txt` (was `/tmp/openai-reviewer-credentials.txt` until 10/01),
  plus sign-in steps naming the login page, the absence of MFA/emailed codes, and
  approving the OAuth consent screen. **This is the path ChatGPT itself takes, so the reviewer WILL be asked to
  sign in — the demo account is required, not a fallback.**
- **The upload entry point moves.** After review details are saved, the header's **"Upload new version"**
  disappears; the path is the right-panel drop zone **"Upload plugin to make changes"**, which becomes a real
  `input[type=file]` once clicked (attach with `DOM.setFileInputFiles`). The dialog that follows is "Reupload
  draft".
- **Reviewer account verified 10/01** — `openai-review@stockportfolio.pro` signs in on production (`POST
  /api/login` → 200, session issued, **no MFA / no emailed code / no magic link**). **Exclusion is DONE
  (10/01).** `reviewAccount` is a declared path on `UserSchema` — that mattered more than it looks: mongoose
  strips undeclared paths, so `User.findById` in `oauthCurrentUser` returned `undefined` and any guard would
  have silently never fired (`scripts/create-openai-reviewer.js` writes through the **native collection**,
  bypassing the schema). Four reads now skip it: `trackActivation` (the reviewer walks every tool by design, so
  counting it fabricates activation), the `mcp_oauth_authorized` event (the dashboard reads that as *"a real
  user approved a client"* and the reviewer MUST approve to exercise the plugin), `/api/admin/customers`, and
  the trial-lifecycle drip. `test/internal-review-account.test.js` pins the flag, the schema path and all four
  exclusions — the schema half especially, because its absence is invisible in Mongo.
- **Driving the portal over CDP:** `node /tmp/cdp-drive.mjs` (Chrome :9333, profile `/tmp/chatgpt-drive`).
  Synthetic `Input.dispatchMouseEvent` on a React tab does nothing — a plain `el.click()` works; and when two
  buttons share a label, pick by bounding rect, not DOM order.

### OpenAI's OIDC requirement — fixed 10/01 (`656d4b52`, VERIFIED LIVE)
OpenAI requires an OAuth plugin to publish OIDC discovery metadata, advertise AND issue `openid` + `email`, and
expose a UserInfo endpoint returning `email` with `email_verified: true`. We had none of the three, and
`normalizeOauthScope` **rejected** every scope outside `OAUTH_SCOPES` — while ChatGPT asks for openid/email by
default from any server that ADVERTISES them, so the connection would have been refused `invalid_scope` and read
as a dead connector. Added `OIDC_SCOPES`, `OAUTH_SCOPES_SUPPORTED` (the union — what authorize validates and
what both discovery documents advertise), `/.well-known/openid-configuration` and `GET /oauth/userinfo`;
claim-building lives in `oauth-oidc.js` so it is unit-tested rather than source-pinned. **The RFC 9728 resource
document still advertises data scopes only**, and **no ID token is issued** — OpenAI calls one optional, and a
`jwks_uri` with no key set behind it is worse than the omission.

**The ChatGPT connector itself is LIVE in the owner's account (9/30)** — installed at `chatgpt.com/plugins`,
and a real chat called `search_companies("Nvidia")` → `get_company_fundamentals(NVDA, quarterly, 1)` and answered
from the 2026-07-26 10-Q, naming the four tools it did *not* call; shares outstanding returned *Not reported /
null*, the never-estimate rule holding in the wild. **CIMD is not supported, deliberately** (it would mean
fetching an attacker-supplied HTTPS URL server-side); we omit `client_id_metadata_document_supported`, so
ChatGPT takes the DCR path.

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
  in `notes/2026-09-29-filing-watch-prospects.md`. **Never send outreach without the owner's explicit
  authorization.**

**Claude / Anthropic directory — BOTH submissions are IN, 10/01. Nothing is blocked on the owner.**
Submit at **claude.ai/directory/manage**, not `platform.claude.com/plugins/submit` — the Console form is
retired ("no longer supported"), and the old **$50/month Team blocker died with it**: the account is **Claude
Pro**, which can submit, and on Pro there is no role check. **Two submissions, not one.**
- **Plugin bundle — `Publish requested`, waiting for an Anthropic reviewer.** Repo public, MIT, plugin at the
  root; `claude plugin validate .` passes. It had been **shipping seven tools that do not exist** (the skill
  described the npm bridge's `sp_*` names while `.mcp.json` connects the six-tool hosted endpoint), rewritten
  against live `tools/list` and pushed as `1376fc6`. **Do not press `Cancel review`** — it withdraws.
- **MCP connector — `In review`**, listing slug **`stockportfolio`** (permanent), at
  `claude.ai/directory/manage/stockportfolio`. Its Tools step first flagged **all six tools "Missing title
  annotation"** because the checker reads `ToolAnnotations.title`, a *separate field* from `Tool.title`; fixed
  in `backend/mcp-endpoint.js` **and** `backend/mcp-apps.js` as `annotations: { title: def.title, ...def.annotations }`
  (`10c5769a`, deployed, re-measured live — all six now carry it). **The portal only re-reads a tool list when
  you reconnect** (Step 1 → `Change` → paste the URL → `Connect and authorize` → approve as the reviewer
  account); the six suggestions cleared on the first re-read after the deploy.
- **Auth is declared `Required when the server asks` + Dynamic Client Registration.** The portal renders that
  as *"No sign-in. Anyone can connect."* on the Settings tab, and the free tier is real, so it is the honest
  answer — but it means a directory user is **not** forced to sign in and will hit the keyless wall (3 asks +
  50 lookups/30d) rather than an OAuth prompt, because `/mcp` never 401s for the anonymous tier. If you would
  rather every directory user sign in, **Settings → Change authentication → `Always required`** is the one
  click; it contradicts the README's keyless-start paragraph, which is why it was not chosen.
- **Reviewer test account: `openai-review@stockportfolio.pro`**, credentials now at
  **`~/.config/stockportfolio/reviewer-account.txt`** (mode 600; moved out of `/tmp`). The *same* account is
  the OpenAI reviewer's — deliberate, it is a test account with no personal data. The connector form's
  Test & launch step carries the login URL, the password, the scopes and the six verified tool calls, so the
  handover is in the submission itself. All six tools were **called against production before the checkbox was
  ticked**: each `HTTP 200`, `isError=false`.
- Package and history: `docs/growth/claude-plugin-submission.md`.

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
  browser header set (an `Accept-Language` alone is enough; mp4 is in `STATIC_ASSET_RE`, so our own `.mp4`
  assets serve to any real browser). Browser checks go through CDP (`scripts/screenshot-cdp.js`).
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
1. **OpenAI plugin submission — SUBMITTED 10/01, now "In review".** Watch for the verdict. Two things could
   still bite: identity verification has not cleared, and the reviewer-credential fields were never
   re-checked. Do not press **Cancel review** unless you mean to withdraw it.
2. **Claude / Anthropic directory — SUBMITTED 10/01, nothing for you to do.** Both the plugin bundle
   (`Publish requested`) and the connector (`In review`, slug `stockportfolio`) are with Anthropic; the
   verdict arrives by email at the primary contact. Two judgement calls are recorded above if you want to
   revisit them: the connector's auth declaration (one click on Settings), and reusing the OpenAI reviewer
   account for Anthropic too. The scratch Chrome profile that held the signed-in session has been deleted.
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
