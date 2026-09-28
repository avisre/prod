#!/usr/bin/env bash
# Preflight for this repo. Prints every environment fact that has previously
# caused a mid-task failure, in ONE call — node version, where dependencies
# actually live, tool availability, and auth state.
#
# Usage: bash scripts/dev-doctor.sh
#
# Background: a prior session lost 5 tool calls rediscovering that `node` is
# v18 while v22 was installed, and that backend deps are in backend/ and not
# the repo root. This exists so that costs one call instead.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 1
ROOT="$PWD"

ok()   { printf '  \033[32mok\033[0m   %s\n' "$1"; }
warn() { printf '  \033[33mwarn\033[0m %s\n' "$1"; }
bad()  { printf '  \033[31mFAIL\033[0m %s\n' "$1"; }

echo "repo: $ROOT"
echo
echo "── node ─────────────────────────────────────────────"
DEFAULT_NODE="$(command -v node || true)"
if [ -n "$DEFAULT_NODE" ]; then
  DV="$("$DEFAULT_NODE" -v)"
  echo "  PATH node: $DV  ($DEFAULT_NODE)"
  case "$DV" in
    v1[0-9].*|v2[01].*) warn "too old for Playwright (>=20) and yahoo-finance2 (>=22)" ;;
    *) ok "new enough for Playwright and yahoo-finance2" ;;
  esac
else
  bad "no node on PATH"
fi

# The ~/.nvm installs this script used to hunt for are GONE -- the directory no
# longer exists, and the v22 path it printed fails with exit 127. PATH node
# satisfies Playwright and yahoo-finance2, so there is nothing left to search for.
# Printing a dead path here cost the very tool calls this script exists to save.
NODE_BIN="$DEFAULT_NODE"
if [ -n "$NODE_BIN" ]; then
  echo "  ↳ use this for tests, Playwright, yahoo-finance2:"
  echo "      $NODE_BIN"
fi

echo
echo "── dependencies ─────────────────────────────────────"
for d in . backend mcp-server; do
  if [ -d "$d/node_modules" ]; then
    ok "$d/node_modules ($(ls "$d/node_modules" | wc -l) packages)"
  elif [ -f "$d/package.json" ]; then
    bad "$d has package.json but NO node_modules — run npm install there"
  fi
done
echo "  ↳ BOTH installs are load-bearing and neither is redundant:"
echo "      backend/node_modules  - the server and most tests (mongoose, express, …)"
echo "      ./node_modules        - scripts/*.js (yahoo-finance2 + deps). Some tests"
echo "                              reach scripts/ and fail without it."
echo "  ↳ run backend code from backend/, or 'Cannot find module' on mongoose etc."

echo
echo "── search tooling ───────────────────────────────────"
command -v rg >/dev/null && ok "rg available" || warn "rg NOT installed — use 'grep -rn PATTERN path | head -n 80'"

echo
echo "── git / auth ───────────────────────────────────────"
[ -d .git ] && ok "local .git present" \
            || warn "no local .git — pushing means cloning avisre/prod into the scratchpad"
if command -v gh >/dev/null; then
  if gh auth status >/dev/null 2>&1; then
    ok "gh authenticated as $(gh api user --jq .login 2>/dev/null || echo '?')"
  else
    warn "gh NOT authenticated. Do NOT try to script 'gh auth login' — it needs a TTY."
    echo "       Ask the owner to run, in their own terminal:  gh auth login"
  fi
else
  warn "gh not installed"
fi

echo
echo "── backend env ──────────────────────────────────────"
if [ -f backend/.env ]; then
  ok "backend/.env present ($(grep -cE '^[A-Z_]+=' backend/.env 2>/dev/null || echo 0) vars)"
else
  warn "no backend/.env — MONGODB_URI / OLLAMA_API_KEY will be unset; unit tests still run"
fi
for v in MONGODB_URI OLLAMA_API_KEY ADMIN_TOKEN; do
  [ -n "${!v:-}" ] && ok "$v set in shell" || warn "$v not set in shell"
done

echo
echo "── durable memory ───────────────────────────────────"
HANDOFF_FILE=".claude/HANDOFF.md"
if [ -f "$HANDOFF_FILE" ]; then
  HL="$(wc -l < "$HANDOFF_FILE" | tr -d ' ')"
  SNAPS="$(ls .claude/handoff-archive/*.md 2>/dev/null | wc -l | tr -d ' ')"
  echo "  $HANDOFF_FILE: $HL lines, $SNAPS snapshot(s) in .claude/handoff-archive/"
  if [ "$HL" -gt 500 ]; then
    bad "OVER the 500-line cap -- snapshot it and rewrite fresh BEFORE adding anything else"
  elif [ "$HL" -gt 400 ]; then
    warn "past 400 lines -- rotate now: snapshot to .claude/handoff-archive/<date>.md, rewrite fresh"
  else
    ok "inside the 500-line cap"
  fi
else
  warn "$HANDOFF_FILE missing -- durable working memory is gone"
fi

echo
echo "── suggested test command ───────────────────────────"
echo "  cd $ROOT/backend && ${NODE_BIN:-node} --test test/credits.test.js"
echo "  cd $ROOT/backend && ${NODE_BIN:-node} --test test/          # full suite"
