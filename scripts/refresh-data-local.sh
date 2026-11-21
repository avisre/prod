#!/usr/bin/env bash
# Data refreshes run on the owner's machine, never on GitHub (owner decision 2026-11-21).
# GitHub only holds the data that a push brings; see KNOWN-ISSUES.md #1 for why.
#
#   scripts/refresh-data-local.sh quotes        # was refresh-quotes.yml        (Tue-Sat, ~10 min)
#   scripts/refresh-data-local.sh prices        # was refresh-price-history.yml (weekly, ~1 h)
#   scripts/refresh-data-local.sh fundamentals  # was refresh-fundamentals.yml  (weekly, up to 6 h)
#
# Each mode refreshes, rebuilds and validates the snapshots, then makes one LOCAL commit.
# It never pushes. Push yourself afterwards; the pre-push hook runs scripts/predeploy.js.
#
# fundamentals: an interrupted run resumes from the checkpoint left in the working tree.
# Run it again with the same FINANCIAL_AS_OF=YYYY-MM-DD (within 7 days).
set -euo pipefail

mode="${1:-}"
root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$root"

die() { echo "refresh-data-local: $*" >&2; exit 1; }
[[ "$mode" =~ ^(quotes|prices|fundamentals)$ ]] || die "usage: $0 quotes|prices|fundamentals"
[ -d node_modules ] && [ -d backend/node_modules ] || die "install dependencies first: npm ci && npm ci --prefix backend"

export SEC_COVERAGE_DISABLE_ON_DEMAND=1 DISABLE_BACKGROUND_JOBS=1
# test-stock-coverage.js copies frontend/data (8+ GB) into the temp dir; keep that off a RAM-backed /tmp.
export TMPDIR="${TMPDIR_DATA:-$HOME/.cache/stockportfolio-refresh-tmp}"
mkdir -p "$TMPDIR"

snapshots=(frontend/data/public-stock-index.json frontend/data/screen-index.json frontend/data/screen-facts.json
  frontend/data/financial-coverage.json frontend/data/financial-coverage-summary.json frontend/data/financial-reporting-index.json)
case "$mode" in
  quotes) paths=(frontend/data/quotes.json frontend/data/us-companies.json frontend/data/company-profiles.json "${snapshots[@]}") ;;
  prices) paths=(frontend/data/fundamentals "${snapshots[@]}") ;;
  fundamentals) paths=(frontend/data/weekly-watchdog.json frontend/data/sec-reporting.json frontend/data/sec-financials
    frontend/data/sec-fx.json frontend/data/us-companies.json frontend/data/stock-universe-manifest.json
    frontend/data/legacy-instruments.json frontend/data/industry-map.json frontend/data/supplemental-financials
    backend/data/segment-history "${snapshots[@]}") ;;
esac
existing=(); for p in "${paths[@]}"; do [ -e "$p" ] && existing+=("$p"); done

# Start from the published data, so the commit contains only this refresh.
git fetch --quiet origin main
[ "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)" ] || die "HEAD is not origin/main; check out an up-to-date main first"
if [ -z "${FINANCIAL_AS_OF:-}" ] && [ -n "$(git status --porcelain -- "${existing[@]}")" ]; then
  die "uncommitted changes in the files this refresh writes; commit or discard them first"
fi

stamp="$(date -u +%Y-%m-%dT%H:%MZ)"
case "$mode" in
  quotes)
    node scripts/refresh-quotes.js frontend/data/us-companies.json
    node scripts/refresh-profiles.js frontend/data/us-companies.json || echo "profiles refresh failed; continuing"
    message="data: refresh quotes snapshot ($stamp)"
    ;;
  prices)
    node scripts/refresh-price-history.js frontend/data/us-companies.json
    message="data: refresh price history ($stamp)"
    ;;
  fundamentals)
    export FINANCIAL_AS_OF="${FINANCIAL_AS_OF:-$(date -u +%F)}"
    node -e 'const d=process.env.FINANCIAL_AS_OF;if(!/^\d{4}-\d{2}-\d{2}$/.test(d)||Date.now()-Date.parse(d)>7*86400000)throw new Error("FINANCIAL_AS_OF must be a date within the last 7 days")'
    # Every stage reads the production cache URI from Render; the key stays in the owner's secrets file.
    export RENDER_SERVICE=srv-d4kc6schg0os73al6t10
    if [ -z "${RENDER_API_KEY:-}" ] && [ -z "${PUBLIC_FINANCIAL_CACHE_URI:-}" ]; then
      RENDER_API_KEY="$(cat "$HOME/.local/share/secrets/render_active.txt")" || die "no Render key"
      export RENDER_API_KEY
    fi
    # Regulator-filing banks; an FDIC outage keeps last week's rows.
    node scripts/fetch-fdic-financials.js || echo "FDIC refresh failed; keeping last week's rows"
    node scripts/run-financial-stage.js listings
    node --max-old-space-size=1536 scripts/run-financial-stage.js core
    node --max-old-space-size=1536 scripts/run-financial-stage.js core   # retry incomplete issuers
    node scripts/normalize-financial-source-ids.js
    node scripts/run-financial-stage.js identities
    node scripts/run-financial-stage.js listings
    node --max-old-space-size=1536 scripts/run-financial-stage.js core
    node scripts/normalize-financial-source-ids.js
    node --max-old-space-size=1536 scripts/run-financial-stage.js industry
    node --max-old-space-size=1536 scripts/run-financial-stage.js industry-retry
    node scripts/run-financial-stage.js promote
    # The filing cache in backend/data/segment-history/.cache stays on this machine between runs.
    node -e 'const fs=require("fs");fs.writeFileSync(process.env.TMPDIR+"/segment-ciks.json",JSON.stringify(fs.readdirSync("backend/data/segment-history").filter(f=>/^\d{10}\.json$/.test(f)).map(f=>f.slice(0,10))))'
    timeout 120m node --max-old-space-size=1536 scripts/refresh-segment-history.js --ciks-file "$TMPDIR/segment-ciks.json" --jobs 4 --budget-minutes 100 \
      || echo "segment history refresh failed; last week's tables stay"
    node scripts/refresh-sec-fx.js
    message="data: weekly complete-universe financial reconciliation"
    ;;
esac

node --max-old-space-size=1536 scripts/build-public-stock-index.js
node scripts/build-screen-index.js
if [ "$mode" = fundamentals ]; then
  node scripts/build-industry-map.js
  node scripts/test-stock-coverage.js
  node scripts/validate-stock-coverage.js --bootstrap
  node scripts/verify-public-stock-pages.js
  node --max-old-space-size=256 scripts/check-stock-coverage-performance.js
  node scripts/write-weekly-watchdog-cycle.js
else
  node scripts/validate-stock-coverage.js
fi

existing=(); for p in "${paths[@]}"; do [ -e "$p" ] && existing+=("$p"); done
git add -- "${existing[@]}"
if git diff --cached --quiet; then echo "refresh-data-local: no changes"; exit 0; fi
git commit --quiet -m "$message"
echo "refresh-data-local: committed $(git rev-parse --short HEAD) locally ($(git diff --name-only HEAD~1 | wc -l) files). Not pushed."
echo "Next: git push origin main (the pre-push hook runs the deploy checks)."
