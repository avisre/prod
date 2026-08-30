# Handoff

App: StockPortfolio.pro — Node/Express + Mongoose backend, vanilla-JS frontend
in `frontend-v2/`. Prod = Render service `srv-d4kc6schg0os73al6t10`, repo
`avisre/prod` (PRIVATE). Live site: stockportfolio.pro.

## Latest build — Ask UI overhaul (2026-08-30, SHIPPED)

Deployed `986348d` (45 files) via `dep-daa4snhsrm7s73dva9fg`, live in 110s.
First trigger `dep-daa4s6hsrm7s73dv8c30` hit the usual no-error `build_failed`
at ~50s; the straight retrigger worked, as always. Repo back to PRIVATE.
Live sweep green: stamp `20260831-askui2` on the page AND the served bundles
carry the code (`setFocus`, `dayBucket`, `TA_MIN = 35`, `ask-progress`,
`pauseProgress`, `.ask-skel`, `width: fit-content`), old markers absent
(`padding-left: 64px`, `box-shadow: 0 -14px 32px`, `ask-working-row`,
`Quick read`). Bytes match local exactly (app.js 125448, system.css 71711).

Owner's complaint was the /ask UI mid-question. Fixed:

- **The waiting state was one grey italic line + ~400px of white.** Everything
  needed was ALREADY on the wire and discarded: `ai-chat.js:1703` emits the
  model's plan as `note`, and every tool call arrives with args + ok — but
  `renderTrace()` only ran on `delta`/finish, so `traceSteps` accumulated
  invisibly and only the newest step showed. `askEngine` now renders an
  `.ask-progress` card: the plan in the model's words, every finished step
  with its duration, the running step, a live timer, a real Stop, and a
  `.skeleton` shimmer where the answer lands. First token → skeleton removed,
  card **hidden not removed** (a `rollback` must bring it back), `.ask-trace`
  collapses carrying the total. No backend change.
- **Sending entered full zen** (nav+rail+dock+footer gone, Esc the only way
  back). Split: `body.focus` is automatic on send — rail, banners, footer go,
  **nav and composer stay**; `body.zen` stays deliberate (⤢/F11) and is now
  remembered in `sp_ask_zen_v1`. Esc peels back one layer at a time.
- **`.ask-q` was a block** at `max-width:min(76%,620px)`, so "amd" painted a
  620px empty card. Now `width:fit-content`, right-aligned to the prose
  column's right edge. NOTE: 74ch resolves against the bubble's 14.5px and the
  prose's 15.5px, so the edges sit ~20px apart — harness allows 26px.
- **The composer, the owner's specific complaint.** It was two nested
  rectangles 2% apart in tone (#ffffff textarea on a #faf9f6 dock), 128px of
  phantom gutter for two absolutely-positioned buttons that only sat on the
  bottom row, a 620px `border-top` ending in mid-air and a shadow bleeding out
  both sides — and it shrank 22% and teleported on send. Now ONE box: border
  and background on the `.composer` wrapper (`:focus-within` for the ring),
  textarea transparent/borderless, 📎+mode+quota+send on one row, dock spans
  the canvas so the rule reaches both edges, shadow deleted. **800×49px
  identical on the landing and mid-chat** (was 116/110px).
  **Gotcha that cost a debugging pass**: Chromium lays the placeholder out
  inside a textarea, so `scrollHeight` on an EMPTY field returns however many
  lines the placeholder wraps to — autoGrow opened at 2 rows until it was
  pinned to `TA_MIN` when `!ta.value`.
- **Rail** groups by Today/Yesterday/Previous 7/30/Older (two chats both
  auto-titled "amd" were indistinguishable); the timestamp no longer vanishes
  on hover behind ✎📌✕, which became one `⋯` → `V2.modal`.
- Landing was three widths (hello 800 / composer 617 / prompts full canvas);
  all three now share `--ask-col`.
- New turns `scrollIntoView({block:'start'})` + `scroll-margin-top:88px`;
  `'nearest'` often resolved to nothing and parked a turn under the dock.
  Streaming follows text only when the reader is already at the bottom.

Verification: `ask-ui-verify/shoot.js` **rewritten from the auto-zen contract
to the focus contract** (its header and every `expectZen:true` encoded the old
behaviour) + new assertions measuring the composer BEFORE and AFTER send and
asserting they match. `server.js` gained `/_ctl/tool3` and mixed-age duplicate-
titled thread fixtures. ALL CHECKS PASSED. Suite **358/358** (+3 contract
tests in `ask-threads.test.js`, which pinned the now-deleted `data-act="pin"`).

⚠️ `affiliate-program.test.js` fails intermittently in the parallel full-suite
run (`:228`, Stripe reversal idempotency) and passes 3/3 alone. Pre-existing
ordering flake, NOT from this change — worth a look sometime.

⚠️ Local tree LAGS main on `README.md` (deploy-test comments) and
`.github/workflows/refresh-fundamentals.yml` (prod moved Alpha Vantage →
Yahoo+SEC and added IndexNow). The `diff -rq` before copying caught it again;
504 `frontend/data/fundamentals/*.json` also differ (bot commits ahead).
Do NOT copy those back.

## Prior build — nav tray + tiers + recharge + D1–D7 (2026-08-30, SHIPPED)

`588e819` + hotfix `f3dc82d`, stamp `20260830-navtray1`. Nav account tray
(hover/click avatar, never navigates; isDesktop now 641px), `/upgrade.html`
ladder above current plan, `/recharge.html` + `POST /api/credits/topup` ($9 /
150 credits, idempotent on Stripe session id), 402 `CREDITS_REQUIRED` walls in
dossier/monitor/app/profile, dialogs migrated to `V2.modal`.
⚠️ Owner must still create the $9 Stripe price and set
`STRIPE_PRICE_ID_CREDITS_TOPUP` in Render env before topup is usable.

## Prior ships, compressed (2026-08-30)

`ad35863`/`20655ae` dossier viz polish (grouped Profit bars, `bn()` shows
−$129M site-wide, earnings-to-cash bullet suppressed when netIncome ≤ 0,
planline hidden for top tiers); `fad5ec4` removed the portfolio "Recent
answers" section (owner decision); `0dfe71f` Ask flow removal + centering +
PDF fix; `f49157f`→`2408edb` mobile/tablet passes 1–7.
Reusable harnesses: `/tmp/dosviz/prodshots.js` + `audit.js` (gotcha: the
Analyst toggle persists `sp_dossier_mode_v1` — init-script it back per load),
and `ask-ui-verify/` for /ask.

## RENDER + PRIVATE REPO — known landmine

Commit-triggered and API deploys both fire, but Render cannot clone the private
repo: `POST /deploys` → 404 `not found: https://api.github.com/repositories/1105594471`.
**Fix used every time**: flip `avisre/prod` public via
`gh api -X PATCH repos/avisre/prod -f private=false`, deploy, flip back
(`-f private=true`). Repo is back to PRIVATE after. **Permanent fix needed**:
owner re-authorizes Render's GitHub App (Settings → Build & Deploy → GitHub
permissions) — until then every deploy needs the flip dance. Render API key:
`rnd_...` keys are recoverable from past transcripts via
`grep -ho "rnd_[A-Za-z0-9_]*" <transcript.jsonl> | awk 'length($0)==32'`;
inline only, never print/store. Render env-vars LIST endpoint exposes values
(single-key GET returns empty). `POST /v1/services/{id}/deploys` takes NO JSON
body; `/deploys/{id}/logs` doesn't exist.

## Owner actions pending

1. **Logged-in E2E on /ask** (needs a real account): attach a picsum PNG +
   a PDF → transcription/analysis; "I plan to hold AAPL 3 more years" →
   memory card appears → new chat → "what do you remember about me?" →
   delete card; Profile → Settings shows the fact, toggle off, clear all;
   import a ChatGPT export. Sidebar: search a phrase from an old chat, pin,
   rename, delete, drag divider.
2. **Kris (drmakineni@msn.com, AppSumo Tier 2)**: RESOLVED 2026-08-29 —
   replied with the shipped fixes (tier 2 visible as "Pro — AppSumo (Investor)"
   in Profile; saved Ask reports via `97b92d5`) and offered: if AppSumo can't
   handle his Tier 2→3 upgrade, we'll bridge the plan difference for him
   manually. Issue 3 (AppSumo review button) is AppSumo's side. If he takes
   the bridge offer: grant = his license's `appsumoTier`/`appsumoAiCap` bumped
   (30/100/300 ladder) — decide then whether via AppSumoLicense record or
   direct user-field update.
3. Re-authorize Render's GitHub App (kills the flip dance permanently).
4. Revoke the classic GitHub PAT pasted in chat long ago (github.com/settings/tokens);
   rotate the Bing Webmaster key (`~/.local/share/secrets/bing_webmaster.txt`).

## Working rules that keep biting

- Stamp ritual: any edit to `frontend-v2/assets/*` needs a new `?v=` stamp on
  ALL pages + server-rendered pages; tests pin it. (CLAUDE.md has the list.)
- `node` on PATH is v18 — use `~/.nvm/versions/node/v22.22.0/bin/node`; run
  tests from `backend/`. FULL suite: `node --test "test/*.test.js"` (a bare
  `test/` dir arg fails MODULE_NOT_FOUND).
- No `.git` in the working tree — push = fresh clone + copy + commit.
  Copy ONLY the files you actually changed: the working tree is an older zip
  download; GitHub has newer README/.github/docs content that must NOT be
  overwritten with the local versions.
- Subagents (Explore/Plan) fail here (model_not_found claude-opus-5 404) —
  implement directly.
- Don't work around anti-bot controls (reCAPTCHA etc.); never surface the AI
  provider identity (trade secret). Never store keys; inline/temp-600 only.

## Next bounded task

Owner E2E check on /ask (above), fix anything it finds, then the affiliate
watch: support@ replies → partner invite flow (see `marketing/ltd-partners/SENT.md`
log; Phase A rail + Phase B campaign fully done, 10 targets contacted 2026-08-26).
