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

# Hand the PC the two trees to compare, as history-free snapshot commits, in one
# bundle file copied over SSH. A plain `git push` to Windows' OpenSSH fails (cmd
# does not understand the quoting git uses), and the full history is 2.4 GB;
# a snapshot is the files only, and after the first one only what changed.
SSH="ssh -o BatchMode=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=8"
base="${range%%.*}"
git rev-parse -q --verify "$base^{tree}" >/dev/null 2>&1 || run_here "the push has no earlier commit to compare with"
last="$(git rev-parse -q --verify refs/predeploy/sent 2>/dev/null || true)"
pc_has="$($SSH "$PREDEPLOY_HOST" "git -C $PREDEPLOY_DIR rev-parse -q --verify refs/predeploy/incoming" 2>/dev/null | tr -d '\r\n')"
if [ -n "$last" ] && [ "$pc_has" = "$last" ]; then
  snap_a="$(git commit-tree "$base^{tree}" -p "$last" -m base)"; not="^$last"
  deps="$(git diff --name-only "$last" "$sha" -- package-lock.json backend/package-lock.json)"
else
  snap_a="$(git commit-tree "$base^{tree}" -m base)"; not=""; deps=first
fi
snap_b="$(git commit-tree "$sha^{tree}" -p "$snap_a" -m head)"
git update-ref refs/predeploy/out "$snap_b"
bundle="$(mktemp -t predeploy).bundle"
trap 'rm -f "$bundle"' EXIT
# shellcheck disable=SC2086
git bundle create -q "$bundle" refs/predeploy/out $not 2>/dev/null || run_here "could not pack the change"
scp -q -o BatchMode=yes -o ServerAliveInterval=15 "$bundle" "$PREDEPLOY_HOST:$PREDEPLOY_DIR/.git/incoming.bundle" 2>/dev/null || run_here "could not send the change to the PC"
mode=run; [ -n "$deps" ] && mode=install
echo "predeploy: running on $PREDEPLOY_HOST"
win_dir="$(printf '%s' "$PREDEPLOY_DIR" | tr '/' '\\')"
# cmd syntax (Windows' default SSH shell). The checks run as a detached job:
# long SSH sessions to the PC drop, and a dropped session kills its children.
$SSH "$PREDEPLOY_HOST" "cd /d $PREDEPLOY_DIR && git fetch -q .git/incoming.bundle +refs/predeploy/out:refs/predeploy/incoming && git -c core.protectNTFS=false checkout -q -f --detach refs/predeploy/incoming && del .git\\predeploy.rc 2>nul & powershell -NoProfile -Command \"exit (Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='cmd /c $win_dir\\scripts\\predeploy-win.cmd $mode $snap_a..$snap_b'; CurrentDirectory='$win_dir'}).ReturnValue\"" >/dev/null 2>&1 || run_here "could not start the checks on the PC"
status=""; quiet=0
while [ -z "$status" ]; do
  sleep 4
  out="$($SSH -o ConnectTimeout=6 "$PREDEPLOY_HOST" "type $win_dir\\.git\\predeploy.rc" 2>/dev/null | tr -d '\r\n ')"
  case "$out" in 0|1) status="$out" ;; *) quiet=$((quiet + 1)) ;; esac
  # 90 minutes without a result: the PC went away mid-run.
  [ "$quiet" -gt 1350 ] && run_here "the PC stopped answering"
done
$SSH "$PREDEPLOY_HOST" "type $win_dir\\.git\\predeploy.log" 2>/dev/null | tr -d '\r'
[ "$status" = 0 ] && git update-ref refs/predeploy/sent "$snap_b"
exit "$status"
