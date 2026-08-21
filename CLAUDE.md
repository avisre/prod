# Local Claude Code workflow (Qwen / LM Studio)

This project uses a local Qwen model through LM Studio. The usable Claude Code
 working window is 262k tokens, with auto-compact targeted at 220k. Treat that
 as a hard budget: tool output and file
contents are part of the budget.

## Task source

The requested StockPortfolio.pro work is defined by
`/home/hardoker77/Downloads/stockportfolio-main-implementation-plan.md`.
Treat that document as the implementation specification, but inspect it by
headings and bounded ranges only. Do not paste or read the complete document
into the conversation.

## Context-safe rules (mandatory)

1. Work in one implementation phase at a time. Do not continue into a new phase
   until the current phase is implemented, tested, and recorded in
   `.claude/HANDOFF.md`.
2. Never read an entire large file, implementation plan, lockfile, log, test
   report, build folder, or generated file in a single tool call.
3. Before reading a new large file, inspect its size and headings first. Read at
   most 120 lines or 12 KB per command. Use targeted searches rather than broad
   recursive output.
4. Cap command output. Prefer `rg -n PATTERN path | head -n 80`, focused file
   ranges, and one directory level at a time. Never run unrestricted `find`,
   `git diff`, `cat`, test output, or log output when it could be large.
   For JavaScript helper searches, use a bounded command such as
   `timeout 10s rg -n 'trackGrowthEvent|getStoredUtm' frontend-v2/assets --glob '*.js' | head -n 40 || true`.
   Never pass an escaped wildcard such as `frontend-v2/assets/\*.js` to Bash or
   `--glob '\*.js'` to `rg`; single quotes should protect `*.js` without adding
   a backslash. Never use an unbounded `grep` over the asset directory.
5. Summarize findings in 10 bullets or fewer. Do not paste raw large output into
   the chat, even when a tool produced it.
6. If the conversation has compacted once during a phase, reduce reads to 80
   lines. If it compacts again or reports rapid refill, stop immediately: update
   `.claude/HANDOFF.md`, run `/clear`, then start a fresh session from that
   handoff. Do not retry the same broad read.
7. For the stock-portfolio implementation plan, first make a short phase brief
   from only the relevant headings. Never read the complete plan in one request.
   The P0 engineering queue is around lines 796-815. Lines 190-230 are the
   detailed proof-funnel section, not the P0 queue; label them correctly if
   they are needed for event-field details.

## Required phase lifecycle

1. Read `.claude/HANDOFF.md` and identify exactly one next phase.
2. Inspect only the files directly required for that phase using bounded reads.
3. Implement the smallest complete change.
4. Run focused tests or a focused smoke check; cap test output.
5. Update `.claude/HANDOFF.md` with changed files, verification, decisions, and
   the next bounded task.
6. Stop and report. A later session can continue from the handoff.

## Handoff file limits

Keep `.claude/HANDOFF.md` under 160 lines and under 12 KB. Replace completed
detail with a compact summary; it is durable working memory, not a transcript.
