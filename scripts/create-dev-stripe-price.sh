#!/usr/bin/env bash
#
# Creates the ONE new Stripe price the Dev plan needs: $19.99/month, USD,
# recurring, on the EXISTING product named `stockportfolio.pro`.
#
# Why this exists and create-stripe-prices.sh is not reused:
#
#   * That script creates a NEW product called "Stock Portfolio Pro". The Dev
#     plan's checkout spec (backend/app.js CHECKOUT_STRIPE_PRICE_SPECS) matches
#     a price's product name EXACTLY (case-insensitively) against
#     `stockportfolio.pro`, so a price on a differently-named product is never
#     found — the buy button would answer 500 "Stripe price is not configured".
#   * The amount is the only thing that tells Dev apart from Monthly. They share
#     a product, and resolveStripeCheckoutPlan REFUSES unless exactly one active
#     price matches amount+currency+interval+product. No legacy price in this
#     account is $19.99/mo, so the amount is unique — this script checks that
#     before creating anything and stops if it is not.
#
# Your secret key stays in your shell — it is never printed or stored.
#
# Usage:
#   export STRIPE_SECRET_KEY=sk_test_xxx     # TEST first, always
#   bash scripts/create-dev-stripe-price.sh
#
# Then, when the printed id resolves and a test-mode checkout works end to end,
# re-run with the live key (sk_live_xxx) and set the printed id on Render:
#
#   gh workflow run set-render-env.yml \
#     -f key=STRIPE_PRICE_ID_DEV -f value=price_...
#
# Prices are immutable in Stripe: to change the amount later you create a new
# price and archive this one — never edit it.

set -euo pipefail

: "${STRIPE_SECRET_KEY:?Set STRIPE_SECRET_KEY first (use an sk_test_... key to start)}"

# Must equal the spec's productName in backend/app.js exactly (modulo case).
export P_NAME="stockportfolio.pro"
export P_AMOUNT=1999        # $19.99 in cents
export P_CURRENCY="usd"
export P_INTERVAL="month"

mode="LIVE"
case "$STRIPE_SECRET_KEY" in
  sk_test_*) mode="TEST" ;;
  sk_live_*) mode="LIVE" ;;
  *) echo "STRIPE_SECRET_KEY does not look like an sk_test_/sk_live_ key." >&2; exit 1 ;;
esac

echo "Using ${mode} Stripe key (${STRIPE_SECRET_KEY:0:8}…)"
echo "Target: \$$(printf '%d.%02d' $((P_AMOUNT / 100)) $((P_AMOUNT % 100)))/${P_INTERVAL} $(printf %s "$P_CURRENCY" | tr a-z A-Z) on product '${P_NAME}'"

if [ "$mode" = "LIVE" ]; then
  read -r -p "This is a LIVE key. Create the price for real? [y/N] " ok
else
  read -r -p "Create the price in ${mode} mode? [y/N] " ok
fi
[ "$ok" = "y" ] || { echo "Aborted — nothing created."; exit 1; }

# api <endpoint> [curl -d args...]  -> raw JSON on stdout, non-zero on HTTP error
api() { curl -sf "https://api.stripe.com/v1/$1" -u "${STRIPE_SECRET_KEY}:" "${@:2}"; }

# jsonlines <python-expression>  — `d` is the decoded JSON, the expression is
# eval'd (so it can be passed as a bare argv string, no nested quoting) and must
# evaluate to a list of strings, printed one per line. Filter values come in via
# the exported P_* variables.
#
# An empty match prints NOTHING, not a blank line. That is load-bearing: the
# clash check below tests its output with `-s` (non-empty file), so a stray "\n"
# would read as "another price already uses this amount" on every clean run and
# block the price from ever being created — measured on 9/12 against the live
# account, where the match list was genuinely empty.
jsonlines() {
  python3 -c '
import os, sys, json
d = json.load(sys.stdin)
value = eval(sys.argv[1])
if value:
    print("\n".join(str(v) for v in value))
' "$1"
}

# NOTE: the two id lists below are filled with a read loop, not mapfile — this
# must run on macOS's stock bash 3.2, which has neither mapfile/readarray nor
# ${var^^} (see the target line above). jsonlines emits one blank line when it
# matches nothing, so blanks are skipped instead of stored. The `if` is not
# cosmetic: `[ -n "$l" ] && arr+=("$l")` leans on how set -e treats a
# short-circuited AND-list, and this file has enough at stake not to.


echo
echo "Looking for product '${P_NAME}'…"
products=$(api "products?limit=100&active=true")
product_ids=()
while IFS= read -r line; do
  if [ -n "$line" ]; then product_ids+=("$line"); fi
done < <(printf '%s' "$products" | jsonlines '
[p["id"] for p in d["data"]
 if (p.get("name") or "").strip().lower() == os.environ["P_NAME"].lower()]
')

if [ "${#product_ids[@]}" -eq 0 ]; then
  echo "no active product named '${P_NAME}' in this ${mode} account." >&2
  echo "Active products this key can see:" >&2
  printf '%s' "$products" | jsonlines '["  %s  %s" % (p["id"], p.get("name")) for p in d["data"]]' >&2
  echo >&2
  echo "Do not create a product here — the plan's spec matches this exact name." >&2
  exit 1
fi
if [ "${#product_ids[@]}" -gt 1 ]; then
  echo "${#product_ids[@]} active products are named '${P_NAME}': ${product_ids[*]}" >&2
  echo "Archive the duplicate(s) so exactly one remains, then re-run." >&2
  exit 1
fi
PRODUCT_ID="${product_ids[0]}"
echo "  product: ${PRODUCT_ID}"

echo "Checking no active price on it already matches the target…"
prices=$(api "prices?limit=100&active=true&product=${PRODUCT_ID}")
existing=()
while IFS= read -r line; do
  if [ -n "$line" ]; then existing+=("$line"); fi
done < <(printf '%s' "$prices" | jsonlines '
[p["id"] for p in d["data"]
 if p.get("unit_amount") == int(os.environ["P_AMOUNT"])
 and (p.get("currency") or "").lower() == os.environ["P_CURRENCY"].lower()
 and ((p.get("recurring") or {}).get("interval") or "") == os.environ["P_INTERVAL"]]
')

if [ "${#existing[@]}" -gt 0 ]; then
  echo "  A matching active price already exists: ${existing[0]}"
  echo
  echo "Nothing created. If that is the price the site should sell, just set it:"
  echo
  echo "  STRIPE_PRICE_ID_DEV=${existing[0]}"
  exit 0
fi

# The amount must be unique among the PLANS, not just this product — that is
# what identifies Dev. Report any other active recurring price at the same amount.
echo "Checking the amount is unique across every active recurring price…"
api "prices?limit=100&active=true&type=recurring" | jsonlines '
["  %s  %s %s/%s  product=%s" % (
    p["id"],
    "{:.2f}".format((p.get("unit_amount") or 0) / 100.0),
    (p.get("currency") or "").upper(),
    ((p.get("recurring") or {}).get("interval") or ""),
    p.get("product"))
 for p in d["data"]
 if p.get("unit_amount") == int(os.environ["P_AMOUNT"])
 and (p.get("currency") or "").lower() == os.environ["P_CURRENCY"].lower()
 and ((p.get("recurring") or {}).get("interval") or "") == os.environ["P_INTERVAL"]]
' > /tmp/dev-price-clashes.txt

if [ -s /tmp/dev-price-clashes.txt ]; then
  echo "Another active price already uses this amount:" >&2
  cat /tmp/dev-price-clashes.txt >&2
  echo "An amount shared by two plans makes resolveStripeCheckoutPlan match twice and" >&2
  echo "refuse to sell. Archive it (if retired) or pick a different amount." >&2
  exit 1
fi
echo "  none — the amount is unique"

echo
echo "Creating the price…"
PRICE_ID=$(api prices \
  -d currency="${P_CURRENCY}" \
  -d unit_amount="${P_AMOUNT}" \
  -d "recurring[interval]=${P_INTERVAL}" \
  -d "product=${PRODUCT_ID}" \
  -d "nickname=Dev — API/MCP" \
  -d "metadata[plan]=dev" | jsonlines '[" ".join([d["id"], d.get("currency",""), str(d.get("unit_amount",""))])]')
PRICE_ID="${PRICE_ID%% *}"
echo "  created: ${PRICE_ID}"

cat <<EOT

Done (${mode} mode). Nothing else in the account changed.

Now point the app at it — locally in backend/.env, and on Render with:

  gh workflow run set-render-env.yml \\
    -f key=STRIPE_PRICE_ID_DEV -f value=${PRICE_ID}

Then verify a checkout really works: open https://stockportfolio.pro/api, click
the Dev buy button, and confirm the Stripe page shows \$19.99/month. If it
answers 500 "Stripe price is not configured", the price is not active, is not on
'${P_NAME}', or the env var has not reached Render yet.
EOT
