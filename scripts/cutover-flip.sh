#!/usr/bin/env bash
# v2 cutover — mechanical part of frontend-v2/CUTOVER.md.
# RUN ONLY AT FLIP TIME, after reading the plan. Reversible via git checkout.
set -euo pipefail
cd "$(dirname "$0")/.."

echo "1/3 Rewriting absolute /v2/ links to root-relative across frontend-v2/…"
grep -rl "/v2/" frontend-v2 --include='*.html' --include='*.js' --include='*.md' | while read -r f; do
  [ "$f" = "frontend-v2/CUTOVER.md" ] && continue
  sed -i 's|/v2/|/|g' "$f"
  echo "   $f"
done

echo "2/3 Rewriting seo-pages.js CTAs to root paths…"
sed -i 's|/v2/|/|g' backend/seo-pages.js

echo "3/3 Manual app.js changes still required (see CUTOVER.md):"
cat <<'EOT'
   - app.use(express.static(.../frontend-v2)) BEFORE the frontend mount
   - app.use('/v1', express.static(.../frontend)) for the transition window
   - sendFile targets for /dashboard /login /register /demo → frontend-v2 files
   - then: restart, full Selenium sweep, real-card trial test, deploy (user)
EOT
echo "Done. Nothing deployed — this only edited local files."
