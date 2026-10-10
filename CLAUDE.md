# Claude Code working rules for StockPortfolio.pro

Context and tool rules for this repo. Every line here is loaded into context on
every turn, so it stays short and only says things that are true on this machine.

## Environment facts (verified — these caused real failures)

Run `bash scripts/dev-doctor.sh` once at the start of a session. It prints all
of the below in one call, which is cheaper than rediscovering it by trial.

- **`node` on PATH is v26.4.0 at `/opt/homebrew/bin/node` — use it for
  everything (tests, Playwright, yahoo-finance2).** The old `~/.nvm` v18/v22
  installs are GONE (the nvm dir no longer exists); the documented v22.22.0
  path now fails with exit 127. PATH node v18 is also gone — `node` is just
  v26 and satisfies all of this repo's needs (verified 9/7: full suite passes
  on it).
- **Backend dependencies live in `backend/node_modules` (196 packages), not the
  repo root (26).** Run node/tests from `backend/`, or `require` fails with
  "Cannot find module 'mongoose'".
- **`rg` is NOT installed.** Use `grep -rn`. There is also no Grep or Glob tool
  exposed in this harness, so searching via Bash is correct here, not a fallback.
- Tests: `cd backend && node --test test/<file>.test.js`
  (197 test files; `npm test` runs all of them).
- **GitHub runs no checks (owner decision 2026-10-10). The pre-push hook is the only gate.**
  `node scripts/predeploy.js` works out which test files a change can affect
  (`scripts/lib/test-map.js`) and runs only those, plus each of the four stock-data checks only
  when its own inputs changed. `--list` shows the plan and the reason for each item, `--all`
  forces everything. An unmapped source file runs the whole suite, so targeting can only run too
  much. `.githooks/pre-push` runs it for every push to `main` through
  `scripts/predeploy-remote.sh`: on the owner's Windows PC over SSH when
  `~/.config/stockportfolio/predeploy.env` names it and it answers, otherwise on this Mac
  (setup: `docs/dev/predeploy-pc.md`). Enabled per clone with
  `git config core.hooksPath .githooks`. Tests already failing on `main` are listed in
  `scripts/predeploy-known-failures.json`; fix one, remove its line. `deploy-render.yml` only
  tells Render to deploy. Never push with `--no-verify`.
- **There IS a local `.git`** — remote `avisre/prod`, branch `main`, verified
  2026-09-24 (this line used to say there was none, and that stale claim would
  send you down a needless clone-and-copy path). Commit and push from the repo
  root. A push to `main` runs `deploy-render.yml` and deploys to production.
  **Docs-only or analytics-only commits** (`docs/`, `notes/`, `seo-data/`,
  HANDOFF) carry the skip marker to avoid restarting the service.
  **`frontend/data/fundamentals/**` is the exception and must NOT:** it is read
  from the deployed filesystem (`app.js:3240`), so skipping the deploy leaves
  production on old numbers indefinitely — `refresh-fundamentals.yml:98` and
  `deploy-render.yml:9` both spell this out. The marker matches **anywhere** in
  the commit message, including inside a sentence explaining why you are not
  using it: on 9/28 a data commit that argued against the marker in its own body
  was silently skipped and had to be deployed with `gh workflow run`.

## Never push without the owner's say-so (owner rule, 2026-10-10)

- **Do not `git push`, and do not start a deploy (`gh workflow run`), until the owner says to push in that
  conversation.** This covers every branch and every kind of commit, docs and handoff included. An approved plan
  is not the go-ahead, even when the plan has a shipping section. On 10/10 a fix was pushed to `main` straight
  after plan approval and the owner said: "in the future do not push until i say so."
- Commit locally, run the tests and the deploy-gate checks, then stop and report: what is committed, that it is
  unpushed, and what pushing would do.

## Do not roll back production (2026-10-08 — this happened, read before any push)

- **Two things deploy every push to `main`.** Render auto-deploys the pushed commit in
  about 4 minutes. `deploy-render.yml` then makes sure the same commit is live (it stopped
  validating on 10/10; the checks run before the push now). Until the afternoon of 10/08 that run deployed **its own
  `$GITHUB_SHA`** even when newer commits were already live, and runs queued instead of
  cancelling, so a run on an OLDER commit rolled production back. On 10/08 this silently
  removed a live customer fix 35 minutes after it had been verified working.
- **Fixed in `deploy-render.yml` (10/08):** a new push cancels the older run
  (`cancel-in-progress: true`); the deploy job skips when its commit is no longer the head
  of `main`; and it skips the redundant redeploy when Render is already live on that
  commit. Do not undo any of the three. A manual `workflow_dispatch` still deploys the
  commit it is run on.
- **Before pushing:** `gh run list --workflow deploy-render.yml --limit 5`. A run started
  BEFORE that fix (older than the commit that changed the workflow) still uses the old
  rules and can still roll production back when it finishes.
- **After pushing:** the change is live once Render shows "Deploy live" for your commit
  (about 4 minutes). Verify against the live site then. The workflow run only deploys
  when Auto-Deploy failed.
- **Never ship whole-file copies from the `~/prod` working tree.** It sits on an old
  branch with uncommitted edits and does NOT contain what is on `main` (its
  `backend/app.js` lacks the 10/08 access fix). Start from `origin/main` and patch in
  only your own hunks.
- **Owner decision 10/08, do not revert:** `hasApiAccess` (`backend/app.js`) includes
  `monthly`, `annual` and `pro-annual` alongside `power`, `power-monthly`, `desk`, `dev`.
  A paying Monthly customer was refused on every Claude connector call before this.
  Bare `'pro'` must stay OUT of that list (lifetime grants are stored as `pro`).
  Guard: `test/api-access-gating.test.js`.

## Editing frontend assets — bump the cache stamp

`backend/app.js` serves every `.js`/`.css` with
`Cache-Control: public, max-age=31536000, immutable`. The **only** invalidation
is the `?v=` stamp in the URL. So **any edit to `frontend-v2/assets/*.js` or
`system.css` must be accompanied by a new stamp**, applied everywhere at once:

- all `frontend-v2/*.html`, **and**
- the server-rendered pages, which are easy to miss because they aren't files
  in `frontend-v2/`: `backend/free-tools.js`, `comparison-pages.js`,
  `seo-pages.js`, `app.js`, `affiliate-dashboard.html`.

Several tests pin the current stamp (`company-statements`, `ask-recovery`,
`free-tools`, `seo-research`) and `profile-consolidation` asserts that every
page carries the *same* one — update those literals in the same change.

Skipping this ships a silent bug: the code is correct in the repo and correct
in review, but browsers keep running the old bundle for up to a year. It has
already happened once (the nav duplicated because the idempotency guard never
reached users).

## Tool rules

1. **Batch independent tool calls into one message.** Context replay is the
   dominant cost — roughly 260K tokens are re-sent every turn, so an extra
   round-trip costs far more than an extra tool call. Before sending a call,
   ask whether the next one depends on its result; if not, send them together.
   Typical batches: `node -c` across changed files, syntax check + test run,
   reading several files before an edit, independent grep probes.
2. **Prefer Read over `cat`/`head`/`tail`/`sed`/`awk` in Bash.** Read has not
   failed once here; those Bash forms are also explicitly discouraged by the
   harness. `grep`/`find` in Bash are fine (see above — no tool alternative).
3. **Never `sleep N; <cmd>`** — the harness blocks it. Use a background Bash
   command with an `until` loop, or Monitor.
4. **Never drive interactive auth (`gh auth login`, OAuth device flows) through
   Bash.** It needs a TTY and always times out. Stop after the first failure and
   give the owner the exact command to run themselves.
5. Cap output. `grep -rn PATTERN path | head -n 80`, bounded file ranges, one
   directory level at a time. Never unbounded `find`, `git diff`, or log dumps.
6. Don't re-read a file you just edited to verify — Edit errors if it failed.

## Model routing

Switch deliberately; leaving the expensive model on through mechanical work is
the main avoidable cost (measured ~5x per-turn difference).

- **Sonnet** for: file edits, running tests, `node -c`, git clone/copy/push,
  screenshot harnesses, dependency installs, reading logs. Most work is this.
- **Opus** for: billing/credit correctness, concurrency and race analysis,
  pricing calibration, reviewing a plan before it ships, and deciding whether to
  deviate from an approved plan. Switch back afterwards.

## Working style the owner expects

- **Measure, don't estimate.** Pricing and cost questions get answered by running
  the real extractors against real tickers, not by picking a plausible number.
  A confirmed guess still gets overturned by measurement.
- Work one phase at a time; record it in `.claude/HANDOFF.md` (keep that file
  under 500 lines — it is durable working memory, not a transcript). At ~400
  lines, snapshot it verbatim to `.claude/handoff-archive/<date>.md` and rewrite
  the live file fresh, dropping superseded items to the snapshot. Back up and
  rewrite — never hand-compress. Compression destroys detail and buys one session
  at most, which is how this file reached 2,391 lines anyway.
- The AI provider (Ollama Cloud, `glm-5.1`) is a trade secret. `ai-client.js`
  has `leaksIdentity()` regex backstops; don't surface model identity to users.
