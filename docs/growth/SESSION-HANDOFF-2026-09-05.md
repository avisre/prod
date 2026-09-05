# Session handoff — 2026-09-05

**Self-contained. A fresh thread needs nothing but this file.** Everything below was
measured or executed live on 2026-09-05 against production. Read §1 first.

---

## 1. AppSumo listing images — DONE (2026-09-05 04:35)

**Delivered: `marketing/campaign-2026-08-appsumo-sprint/assets/`** (dir created).
Owner supplied 3 screen grabs of the live signed-in product (NVDA) at ~04:29,
overriding the earlier capture problem. Ship these + the existing banner:

| # | File | View |
|---|---|---|
| 1 | `01-dossier-nvda-decision-brief.png` | Dossier, Analyst mode — "The case in two minutes" |
| 2 | `02-dossier-nvda-financial-trajectory.png` | Dossier — "The filed record, with the read beside it" |
| 3 | `03-filing-change-monitor-nvda.png` | Monitor — "Before and after, on comparable periods" |

Processing was **alpha + metadata strip only — no crop, no resize**. Full rationale,
compliance table and rejected candidates are in that folder's `README.md`.
**Uncommitted.**

### AppSumo image rules (verified at sell.appsumo.com/l/image-guidelines, 2026-09-05)

- Min **1920x1080**; max **5 MB**; **JPG/PNG only**; **one view per image**.
- **1 hero + up to 5 product images** — so 2 slots are still free, not 0.
- **No banners, compilations, watermarks, icons, overlay graphics, text or
  messaging.** Caption strips / annotated callouts **fail submission** — do not add them.

### Open decision

Nav in all three reads **"Ask AI"**. The report-first rename to **"Research"** is on
`relist-credit-meter` (`d22e0880`), unmerged. Ship as-is, or merge+deploy then re-grab
the same three views so screenshots match the listing copy.

### Rejected (do not re-propose without new evidence)

- `docs/qa/assets/2026-08-21/ask-desktop.png` — Ask **empty state**: no answer shown,
  ~40% blank, and reads "254 of 300 questions left this month", contradicting the
  credit meter. Ask is instead implicit — its bar sits at the foot of all three images.
- Compare grab (META vs PINS, 04:23) — **2304x986, fails the 1080 minimum**.

### Capture blocker is resolved (contradicts the old note below)

**ImageMagick (`/opt/homebrew/bin/magick`), `ffmpeg`, and Google Chrome are all
installed on this machine.** Headless Chrome can capture authenticated product UI
without `selenium-webdriver` — the missing dep that made
`scripts/generate-marketing-screenshots.js` unusable. That script is still wrong for
this job regardless (Linux Chrome paths, hardcoded to the public `/tools/*` markup,
and documented as never signing in — while Dossier/Monitor/Ask are behind
`proGate`/`monitorGate`). A dedicated `appsumo-screenshots@stockportfolio.pro`
account exists in `users` for exactly this.

---

## 2. Environment facts (verified this session — several contradict CLAUDE.md)

- **Node**: use `/opt/homebrew/bin/node` (**v26.4.0**). The path CLAUDE.md names,
  `~/.nvm/versions/node/v22.22.0/bin/node`, **does not exist on this machine**.
- **Run node/tests from `backend/`** — deps live there, not repo root. Tests:
  `cd backend && PATH="/opt/homebrew/bin:$PATH" npm test` (448 tests; **447 pass**, the
  only failure is `social-compose.test.js` needing selenium — pre-existing, expected).
- **There IS a local `.git`.** CLAUDE.md says there isn't; that line is **stale**.
  `origin` = `https://github.com/avisre/prod.git`, `main` tracks `origin/main`.
- `rg` is not installed — use `grep -rn`.
- Mongo: `MONGODB_URI` in `backend/.env`. DB name `DAT`. 61 collections.
- **Credentials available to the agent**: Stripe **live** secret + webhook secret (in
  `backend/.env`); GitHub via `gh`/osxkeychain as `avisre` (scopes `repo`, `workflow`).
  **No `RENDER_API_KEY` and no Render CLI** — all Render changes must be done by the owner.

---

## 3. Code shipped this session — ON A BRANCH, NOT DEPLOYED

Commit **`d22e0880`** on branch **`relist-credit-meter`**, pushed to GitHub.
**`main` is still at `e2993088`. Nothing is merged. Nothing is deployed.**
PR link: `https://github.com/avisre/prod/pull/new/relist-credit-meter`
Fast-forward when ready: `git checkout main && git merge --ff-only relist-credit-meter && git push origin main`
Deploy still needs the owner's public→deploy→private repo flip (auto-deploy is broken).

**Contents:**

1. **Credit meter** — `backend/credits.js` gains explicit
   `LTD_CREDIT_ALLOWANCE = { 1:100, 2:300, 3:800 }`, replacing derived `askLimit × 2`
   (was 60/200/600) for lifetime accounts. `allowance()`, `balance()`, `check()` take a
   new optional `appsumoTier` arg; 3 call sites in `app.js` thread
   `req.user && req.user.appsumoTier`. **Every tier increases — verified against all 13
   live buyers, zero downgrades**, which is why no grandfather clause and no AppSumo
   downgrade approval are needed. Test added to `backend/test/credits.test.js`.
2. **`ENABLE_TIER_V2_LIMITS` and `MONITOR_CAP_V2_EFFECTIVE_FROM` stay OFF** — one meter
   only. Companies monitored, portfolios and history stay unlimited; 19 years on all tiers.
3. **Report-first nav** — `frontend-v2/assets/app.js`: desktop dropdown renamed
   `Ask AI` → `Research`, trigger now links `/dossier.html`, order Dossier → Monitor → Ask.
   Mobile: Dossier and Monitor promoted to top-level peers, ahead of Ask.
4. **Ask-limit contradiction fixed** (`/pricing` said 50, `/llms.txt` said 25; code is 50)
   in `frontend/llms.txt`, `frontend-v2/index.html:731`, and a stale `ai-chat.js:13` comment.
5. **Cache stamp** `20260904-recharge1` → **`20260905-relist1`**, all 91 occurrences
   across 44 files including server-rendered pages and the tests that pin it.
6. **Scheduled-email runner wired to a daily cron** — `startScheduledEmails()` in
   `app.js`, beside `startDigest()`. **Spawned as a child process on purpose**: the
   script calls `mongoose.disconnect()`, so requiring it in-process would tear down the
   server's own connection.
7. Includes the **pre-existing marketing-attribution WIP** that was already in the tree
   (AI-agent traffic class + admin dashboard panel). It was entangled with unrelated
   `app.js` edits and could not be split without interactive staging. **Not reviewed or
   tested by me** — the commit message says so.

---

## 4. Two silent bugs found and fixed (both in `scripts/run-scheduled-emails.js`)

**These are the most valuable findings of the session.**

1. **The review-request path could never have worked.** It used raw-driver
   `findOneAndUpdate(...).value`. The driver is **mongodb 6.20.0**, which returns the
   bare document — `.value` is always `undefined`, so every claim read as a loss and was
   skipped **after** the `$set` had already landed, permanently blocking that user from
   ever being asked. Fixed with `includeResultMetadata: true`. It is the **only**
   raw-driver `findOneAndUpdate` in the repo; Mongoose model calls return the document
   directly and are unaffected.
2. **The inactive-48h nudge would have insulted the best customers, daily.** It keyed
   solely on `meaningful_activation` funnel events, which are **zero for every account**.
   Once on a cron it would have mailed all 13 customers "you haven't got started yet" —
   Kris and pkotynski included — every day. Now also counts real usage:
   `credit_ledger`/`dossier_views`/`ask_reports` (keyed `userId`) plus
   `stocks`/`alerts`/`watchlists`/`portfolios` (keyed `user`). Nudges dropped **13 → 3**.

---

## 5. Production changes made this session (outward-facing — already happened)

- **13 emails sent**, 0 failed, queue fully drained (was 12 jobs sitting `scheduled`, 11
  overdue, never once attempted since 8/14):
  6 × `appsumo_onboarding`, 4 × `appsumo_review_5d`, 3 × `appsumo_inactive_48h`.
  Recipients of review asks: `imchrisvarnom`, `alex.aidan.behar`, `analyzewithzen`,
  `thunderconlive`. Inactive nudges: `ian.sterk99`, `analyzewithzen`, `thunderconlive`.
- **`khaledaziz130@gmail.com` corrected to Investor.** He was on a **Desk trial**
  (10,000-credit wallet, expiring 4 Oct, and `status:trialing` made him invisible to all
  automated email) instead of the intended Investor tier. Now `appsumoTier:2`,
  `appsumoAiCap:100`, `subscription.status:active`, `trialEndsAt:null`.
  Pre-change snapshot: scratchpad `khaled-before.json` (session-local, may be gone).
- **`gattomorto77@gmail.com` marked** `appsumoReviewStage:2` + `reviewRequestSentAt`
  = 2026-09-01, so the queue stops asking a customer who already reviewed on 9/1.
- **`STRIPE_PRICE_ID_CREDITS_TOPUP` set in `backend/.env`** to
  `price_1UAUOtAUeKapY1OPUcSIaloi` — an existing **live** $14.99 one-time USD price
  ("Credit refill — stockportfolio.pro") that had simply never been wired up. Validated
  against the route's own checks. **NOT set on Render**, so production still returns
  `TOPUP_UNAVAILABLE`.

**Correction to an earlier claim in this session:** I initially said no review request
had ever been sent. Wrong — 6 customers (`drmakineni`, `pkotynski`, `conleec`,
`ian.sterk99`, `fruitfulfinancellc`, `appsumo.abe`) had `reviewRequestSentAt` set
12–18 Aug at stage 3 via a different path. The **queue** path was the broken one; today's
4 were genuinely the never-asked. 11 of 13 have now been asked; only `trendbm` never has,
and Khaled's is queued for 9/7.

---

## 6. Plan status

Approved plan lives at `~/.claude/plans/make-me-a-plan-resilient-engelbart.md`.

| | Item | Status |
|---|---|---|
| A2 | Listing v4 drafted | ✅ `docs/growth/appsumo-listing-v4-credit-model.md` |
| A3 | Credit meter 100/300/800 | ✅ code + test |
| A3 | Recharge / top-ups | ⚠️ local only — **needs Render env var** |
| A4 | Margin math | ⚠️ all measured except the **monthly Ollama bill** (owner must supply) |
| A5.1 | Monitor in nav | ✅ |
| A5.2 | "Monitor my holdings" one-click | ❌ |
| A5.3 | Credit cost shown before each spend | ❌ |
| A5.4 | CSV/Excel holdings import | ❌ (Gattomorto's explicit request) |
| A5.5 | PDF / shareable report export | ❌ |
| B6 | Drain email queue | ✅ 13 sent |
| B7 | Daily cron | ✅ |
| B8 | Reply to Kris re Monitor | ❌ |
| B9 | Personal emails to all 13 | ❌ |
| B10 | Khaled annual-plan offer | ⚠️ tier fixed; **offer email not sent** |
| C11 | Report-first copy sitewide | ⚠️ nav done; `index.html` + starter tagline still say "The report, not a chat." |
| C12 | Credit costs on `/pricing` | ❌ |
| C13 | Research-vs-chat credit clarity | ❌ |
| C14 | Ask-limit 25→50 | ✅ |
| D15 | Wire thumbs endpoint | ❌ `ai_chat_feedback` has **0 rows**; no frontend calls `POST /api/ai/chat/feedback` (`app.js:8099`) |
| D16 | Map $149 SKU in Stripe webhook | ❌ HANDOFF item 7: purchase takes money, delivers nothing |
| D17 | Alex as first subscriber | ❌ |
| D18 | Hand-sold research service | ❌ |
| A1 | Owner: 2× William emails + Ollama bill | ❌ |

---

## 7. The listing — key decisions to defend or overturn

Full copy: **`docs/growth/appsumo-listing-v4-credit-model.md`**.
Rendered version published as an artifact (owner has the link).
Supersedes `appsumo-listing-ai-tool-reframe.md` (v3), whose feature order put Ask first.

**Why report-first.** Two customers, unprompted, in writing:

> **Kris (Tier 2), 8/30:** "the true value of your service lies in the **dossier and
> filing monitor reports** because they can really open one's eyes to the blind folds
> that the regular financial media fails to… the traps of blindly following the numbers
> through the rose colored Financial/analyst reports and their pseudo expert bluster."

> **Alex (Tier 1), 9/4:** "instead of the tagline 'The report, not a chat.', do something
> more along the lines of Detailed Research Reports on Stocks based on REAL Data…
> **Framing it as a report first, then chat for more detail** I think would be much more
> successful."

**Why the meter changed.** Tiers differed only by Ask count (30/100/300) — a meter of
*our cost*, not buyer value. `lib/tier-limits.js` says so in its own comments. The portal
proves it: after going public, orders rose **+167%** while AOV fell **58% ($89 → $37.50)**.
Everyone bought the bottom rung because the bottom rung was the whole product.

**Published per-feature costs** (deliberate — most listings hide the meter; these weights
were already calibrated against 25 real tickers):
`Ask 2 · Monitor 5 · Dossier 10 · Deep Dossier 30 · Compare 5`. Top-up 150 for $14.99.

**Dropped tag:** `portfolio-tracker` — wrong comparison set, loses on price.

---

## 8. SECURITY — unrotated exposed secrets (highest urgency)

An env snapshot with real values was pasted into Claude sessions. **Git is clean** —
420 commits scanned, no `.env` ever committed, only placeholders. **Shell history clean.**
Exposure is confined to 5 local transcript files, **one written 2026-09-05 03:18**:

- `~/.claude/projects/-Users-drasharaghavan/9052d41a-….jsonl` — all 6 secrets
- `~/.claude/projects/-Users-drasharaghavan-prod/32b1c69e-….jsonl` — all 6
- `…-prod/d4241262-….jsonl` — SMTP, JWT, Google, Ollama
- `…/cacd891c-….jsonl` — SMTP, JWT, Google
- `…-prod/2c82c73e-….jsonl` — SMTP, JWT

**Rotation order (none done yet).** Note each must change at source **and** in Render,
back-to-back, or checkout/webhooks break in between:
1. `STRIPE_SECRET_KEY` (**live**, moves money, usable from this machine right now)
2. `STRIPE_WEBHOOK_SECRET` (forged webhooks mint free lifetime entitlements)
3. `JWT_SECRET` (forges a session for any account incl. admin; rotating logs everyone out)
4. `SMTP_PASS` · 5. `GOOGLE_CLIENT_SECRET` · 6. `OLLAMA_API_KEY`
7. Separately: revoke the old GitHub PAT (HANDOFF item 4).

Offered but **not done**: scrubbing the values out of those 5 transcripts in place.
Scrubbing is not a substitute for rotating.

---

## 9. Owner-only blockers

1. **Email William: fix the "Uses AI: No" flag.** Highest-leverage marketing fix — the
   whole listing is undercut while the marketplace formally says it isn't an AI tool.
2. **Email William: the tier spec change.** Never edit listing versions in the Partner
   Portal — known version-mapping bug.
3. **Set `STRIPE_PRICE_ID_CREDITS_TOPUP` on Render** = `price_1UAUOtAUeKapY1OPUcSIaloi`,
   or cut the top-up line from the listing.
4. **Merge + deploy** (see §3).
5. **Provide the monthly Ollama Cloud bill** — the one input needed to state margin in
   dollars. Formula ready: `cost per credit = monthly bill ÷ credits consumed`.
6. **Rotate the secrets** (§8).

---

## 10. Evidence base — numbers worth not re-deriving

- **13 paying customers.** Excluding `rin@gmail.com` (**owner's test account** — 30 of 41
  Asks, 9 of 18 Dossier views), all customers combined produced **11 Ask questions ever**
  and hold 11–18 portfolio positions each. They use it as a portfolio tracker.
- **Total credits spent by all customers, ever: 257** (`ask` 66 = 132cr, `dossier` 10 =
  100cr, `compare` 5 = 25cr). **`monitor`: 0 — Filing Change Monitor has never been used
  once**, and it is *not gated*: all 13 pass `hasMonitor()`. Kris asked to be given a
  feature he has had since 21 July. It was buried in a dropdown labelled "Ask AI".
- **Cache economics:** users track 79 distinct companies; **44% already have a built
  Dossier, 59% a built filing report** → marginal cost ≈ 0. From
  `scripts/ai-usage-report.js`: *"Cost scales with distinct companies × filings per year
  — never with headcount."*
- **AI spend measured:** 23.6M tokens / 2,122 completed calls all-time. Ask averages
  14,850 tokens; Dossier ~75K across 11–13 calls; Monitor ~18K across 4–6.
- **Direct Stripe has never worked:** 88 checkout sessions → 1 paid → refunded → $0 net.
- **SEO:** 24,255 indexed URLs → ~18 clicks/week → **0 attributable orders ever**.
- **Bot traffic:** 68% of all traffic. Full analysis in
  **`docs/growth/bot-crawler-situation-2026-09-05.md`** (includes a retraction of an
  earlier false "Singapore bot farm" claim — do not repeat it).

---

## 11. Explicitly ruled out (don't re-propose without new evidence)

- **No new SEO work** — 0 attributable orders, ever.
- **No direct-Stripe self-serve push** — 88 sessions, $0 net.
- **No metering of companies/portfolios/history** — one meter only (owner's call: "make
  it simple don't complicate it").
- **No ungating of Monitor** — every tier already has it; nothing to give away.
- **Selling MCP access to AI labs** — assessed and argued against in the bot brief:
  `robots.txt` is `Allow: /`, so there is no leverage; only Meta has real volume.

## 12. Doc index

| File | What |
|---|---|
| `docs/growth/appsumo-listing-v4-credit-model.md` | The listing copy (this session) |
| `docs/growth/bot-crawler-situation-2026-09-05.md` | Bot/crawler analysis (this session) |
| `docs/growth/context-brief-2026-09-04.md` | Prior-day full context brief |
| `~/.claude/plans/make-me-a-plan-resilient-engelbart.md` | The approved plan |
| `.claude/HANDOFF.md` | Durable memory — **492 lines, over its own 160-line cap, needs trimming** |
| `docs/growth/appsumo-tier-v2-proposal.md` | Superseded — meter is credits, not companies |
| `docs/growth/mcp-directory-listings.md` | Never opened; relevant to MCP-as-distribution |
| `docs/qa/BUGS-2026-08-21.md` | BUG-001 is fixed in prod (anon Ask verified working live) |
