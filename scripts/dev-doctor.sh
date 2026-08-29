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

# Highest installed nvm node, whatever the version numbers happen to be.
NODE22="$(ls -d "$HOME"/.nvm/versions/node/v* 2>/dev/null | sort -V | tail -1)"
if [ -n "$NODE22" ] && [ -x "$NODE22/bin/node" ]; then
  echo "  newest installed: $("$NODE22/bin/node" -v)  ($NODE22/bin/node)"
  echo "  ↳ use this for tests, Playwright, yahoo-finance2:"
  echo "      $NODE22/bin/node"
else
  warn "no nvm-installed node found under ~/.nvm/versions/node"
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
echo "── suggested test command ───────────────────────────"
echo "  cd $ROOT/backend && ${NODE22:-$HOME/.nvm/versions/node/vXX}/bin/node --test test/credits.test.js"
