#!/bin/sh
# Runs the deploy checks for a push, on the PC when it answers and here when it
# does not (owner decision 2026-10-10). Called by .githooks/pre-push:
#
#   scripts/predeploy-remote.sh <range> <sha>
#
# The PC is described in an untracked file, so nothing about the owner's
# network is committed:   ~/.config/stockportfolio/predeploy.env
#   PREDEPLOY_HOST=user@pc-name-or-ip      # ssh target
#   PREDEPLOY_DIR=C:/dev/prod              # the checkout on the PC
# Setup of the PC itself: docs/dev/predeploy-pc.md.
#
# The commit travels Mac -> PC directly over SSH (git push to the PC's own
# checkout), never through GitHub.
set -u
range="$1"; sha="$2"
root="$(git rev-parse --show-toplevel)"
conf="${PREDEPLOY_CONF:-$HOME/.config/stockportfolio/predeploy.env}"
[ -f "$conf" ] && . "$conf"

run_here() { echo "predeploy: $1; running on this machine"; exec node "$root/scripts/predeploy.js" --range "$range"; }

[ -n "${PREDEPLOY_HOST:-}" ] && [ -n "${PREDEPLOY_DIR:-}" ] || run_here "no PC configured ($conf)"
ssh -o BatchMode=yes -o ConnectTimeout=4 "$PREDEPLOY_HOST" "exit 0" >/dev/null 2>&1 || run_here "PC $PREDEPLOY_HOST is not answering"

# Hand the PC the exact commit. Its checkout accepts pushes to a side ref; the
# checks then run on a detached checkout of that commit.
if ! git push --quiet --force --no-verify "ssh://$PREDEPLOY_HOST/$PREDEPLOY_DIR" "$sha:refs/predeploy/incoming" 2>/dev/null; then
  run_here "could not send the commit to the PC"
fi
echo "predeploy: running on $PREDEPLOY_HOST"
# One command string with forward slashes: valid in both cmd and PowerShell.
ssh -o BatchMode=yes "$PREDEPLOY_HOST" "cd /d \"$PREDEPLOY_DIR\" 2>nul || cd \"$PREDEPLOY_DIR\" && git checkout --quiet --force --detach $sha && node scripts/predeploy.js --range $range"
