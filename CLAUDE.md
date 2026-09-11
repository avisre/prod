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
  (48 test files; `npm test` runs all of them).
- There is no local `.git`. Pushing means cloning `avisre/prod` into the
  scratchpad, copying files in, and committing there.

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
  under 160 lines — it is durable working memory, not a transcript).
- The AI provider (Ollama Cloud, `glm-5.1`) is a trade secret. `ai-client.js`
  has `leaksIdentity()` regex backstops; don't surface model identity to users.
