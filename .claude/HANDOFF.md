# Handoff

Durable working memory — **keep under 160 lines** (CLAUDE.md). State and open actions only, never a
transcript. Deep history: `git log`, `notes/2026-09-*.md`, `docs/growth/`, `~/.claude/plans/`.

## Session start
- `bash scripts/dev-doctor.sh` once. Local mongo: `brew services start mongodb-community`; harnesses use
  `mongodb://127.0.0.1:27017/<scratch>`.
- **Verify every deploy from outside** (`gh run list` + a live fetch) — the workflow's own conclusion lied
  once. `deploy-render.yml` 404'd on push through 9/24 (Render lost the repo) and works again;
  `set-render-env.yml` alone never deploys. A push to `main` ships to prod.

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

**Claude plugin directory — package READY, not submitted; two preconditions open (9/25).** Drafted in
`docs/growth/claude-plugin-submission.md`; built and passing at
`/Users/drasharaghavan/stockportfolio-claude-plugin` (NOT a git repo yet, NOT pushed): manifest + `.mcp.json`
(remote `https://www.stockportfolio.pro/mcp`, OAuth/DCR, no key paste) + one skill + one slash command.
`claude plugin validate . --strict` passes; the leak gate (`mcp-server/scripts/no-leak-check-plugin.cjs`) is
clean, and a local install showed 2 skills + 1 MCP server loaded (`claude mcp list` → `✔ Connected`).
- **Chose the free plugin route, not the Connectors Directory.** The connector portal needs a
  Team/Enterprise claude.ai org — 2 seats × $25 = **$50/month just to unlock the form**. The escape hatch for
  individual authors is Console: `platform.claude.com/plugins/submit`.
- **PRECONDITION 1 — a deploy is required.** Prod `tools/list` measured 9/25: **7 tools, 7 titles, ZERO
  annotations.** The `readOnlyHint: true` fix is in `backend/mcp-endpoint.js` in the working tree but not
  live, and the hint is a hard review requirement.
- **PRECONDITION 2 — the bot-blocker fix must ship too.** `/docs/api-mcp` and `/privacy` are declared to
  Anthropic and must not 403 their scanner (same trap as the AppSumo listing, 9/23).
- **Owner-only:** create the free Console org and authorise the public repo
  `avisre/stockportfolio-claude-plugin` (must NOT be `avisre/prod` — public, and it names the provider).
  Deferred: the **listing icon** — the plugin form takes only a repo link, so it has no consumer; do not
  fabricate a brand asset without sign-off.
- Reviewer test path: the **keyless tier exercises every tool** (2 asks + 50 lookups/30d), so no credential
  handover is needed. `sp_fund` proxies third-party fund data we don't own — declare it.

**AppSumo final-window repricing — v8 copy DONE (11/11 guards pass); the flip is partly started, NOT
finished.** v8 = prices ($149/$299/$499, anchors $549/$1,099/$1,849), wallet 200/500/1000; *the flip — exact
values, exact order* is in `docs/growth/appsumo-listing-v8.md`.
- **Done, verified from outside:** `CREDIT_ALLOWANCE_V3_EFFECTIVE_FROM` is stored on Render (run 36070122159,
  owner-set) and the deploy followed (run 36070525625, success, prod 200). **Unprovable from outside, by
  design** — the public config publishes no wallet field, so the first redemption after 22:55:55Z is the proof.
- **Three writes were BLOCKED for me by the auto-mode classifier** — the Render env set (owner ran it), the
  grandfathered-licence importer (`scripts/import-grandfathered-licences.js` then `--apply`; it reads
  `~/.local/share/secrets/appsumo_licensing.txt` and loads `backend/.env` — PRODUCTION Atlas), and the portal
  draft values. **Hand these over rather than retrying.**
- **The portal is the path and it is a browser surface**, driven headfully over CDP (`node /tmp/as-drive.mjs`,
  Chrome :9222, profile `~/.appsumo-portal-profile`). **Never touch the `/self-submission/231048/build` version
  flow** (known mapping bug), never press EXIT. The partner MCP is a dead end (`cached needs-auth`); the
  Licensing key can't edit a listing (read-only).
- **Remaining v8 fields:** the nine price/wallet values (draft read 9/25: 39/144 · 79/288 · 149/432, credits
  50/150/400 → target **149/549 · 299/1099 · 499/1849**, **200/500/1000**), the long description from
  `appsumo-listing-v8.txt`, five FAQ slots, the API+MCP row wording. Then Submit → reply in Yena's thread.
- Live page read 23:32Z: still $39/$79/$149, **no $299/$499** (watcher re-armed). Set the three
  `APPSUMO_TIER*_PRICE_USD` vars and push the price half **only once the page shows $299/$499** — a page
  selling 200 credits while production meters 50 is the refund this ordering avoids.

**Emotional design** — plan `~/.claude/plans/warm-orbiting-sketch.md` (approved). Thesis: confetti imports a
*trade* emotion; this product's emotions are comprehension, vindication and time, and its vocabulary is ink,
not glitter. **Phases 0-5 SHIPPED (9/24-25)**, each pinned by its own test file — details in `git log`: the
portfolio-action voice, motion vocabulary on `window.V2` (`app.js:2246-2308`), "Since you bought", the red pen
on `verify.html`, the X-Ray reveal, quiet alarms.
- **Two REAL DEFECTS found by shipping, not by reading:** (1) the backend had written the add day into
  `purchaseDate` on undated adds/imports since launch — our clock laundered into the user's memory slot;
  fixed at all three write paths and at display (`test/portfolio-since.test.js`). (2) the headline-vs-filing
  `money()` formatter chose its decimal from the RAW amount (`abs >= 100`), so that branch was dead code and
  every figure printed whole-unit (`$15.5B` → `"$16 billion"`); three copies fixed, `test/money-formatter.test.js`.
- Standing rules: the error overlay's "Nothing was changed" is an explicit `unchanged: true` opt-in (the
  multi-ticker path reports a PARTIAL success as an error, so a blanket claim would lie); X-Ray exposure is
  summed in **DOLLARS** (percentages of different bases cannot be added); an EMPTY alert list renders a quiet
  card rather than hiding the section (a working monitor and a broken feed looked identical).
- **Phases 6-7 NOT started** (year in filings, comprehension streak); thesis letter and anniversaries
  untouched. **Dossier redesign stays untouched** — leave the mockup alone.

**MCP/API setup guide — SHIPPED 9/25 and deployed** (verified from outside). `/docs/api-mcp` carries 8
per-client blocks, pinned by `test/mcp-setup-guide.test.js`. **Verified against prod:** Claude and ChatGPT
authenticate over OAuth — neither can send a static bearer to a custom connector — so never say "paste a key".

**AI portfolio creator — announced 9/25 as in-development, no date promised. No spec or plan file yet.**

**Dossier redesign — "The Plain Filing" — mockup done, awaiting review.** Plan
`~/.claude/plans/valiant-singing-parnas.md`. `docs/design/dossier-plain-filing.html` is a document, not a
dashboard (Newsreader / IBM Plex). **Step 2 — the port into the real page — has NOT started**, and its CSS
must be re-derived. Regenerate with `node scripts/build-dossier-mockup-artifact.js`; never hand-edit it.
Artifact publishing is refused here.

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
  `test/social-compose.test.js` **always fails** (needs `selenium-webdriver`, not installed) — pre-existing.
- Cache stamps: any edit to `frontend-v2/assets/*.js` needs a new `?v=` stamp everywhere at once (all
  `frontend-v2/*.html` + the server-rendered pages in `backend/`) plus the pinned test literals.

## Owner actions pending
1. **Authorise the plugin repo + deploy the two preconditions** (annotations, bot-blocker), then submit at
   `platform.claude.com/plugins/submit` — see above.
2. **Dossier mockup review** — step 2, the port, has not started.
3. **URL Inspection → Request Indexing** on the highest-value pages — `Page with redirect` (604) + `Server
   error (5xx)` (2) need the UI drill-down; the API has neither.
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
