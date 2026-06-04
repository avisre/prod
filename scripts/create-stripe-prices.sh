#!/usr/bin/env bash
#
# Creates the new Stock Portfolio Pro subscription prices in Stripe:
#   - Monthly: £27.00/month  (unit_amount=2700, gbp)
#   - Annual:  £270.00/year  (unit_amount=27000, gbp)
#
# Your secret key stays in your shell — it is never printed or stored.
#
# Usage:
#   export STRIPE_SECRET_KEY=sk_test_xxx     # use a TEST key first!
#   bash scripts/create-stripe-prices.sh
#
# When you're happy with the test prices, re-run with a live key (sk_live_xxx).
# Prices are immutable in Stripe: to change an amount you create a new price
# and archive the old one — this script always creates fresh prices.

set -euo pipefail

: "${STRIPE_SECRET_KEY:?Set STRIPE_SECRET_KEY first (use an sk_test_... key to start)}"

mode="LIVE"
case "$STRIPE_SECRET_KEY" in
  sk_test_*) mode="TEST" ;;
  sk_live_*) mode="LIVE" ;;
  *) echo "STRIPE_SECRET_KEY does not look like an sk_test_/sk_live_ key." >&2; exit 1 ;;
esac

echo "Using ${mode} Stripe key (${STRIPE_SECRET_KEY:0:8}…)"
read -r -p "Create the £27/mo and £270/yr prices in ${mode} mode? [y/N] " ok
[ "$ok" = "y" ] || { echo "Aborted — nothing created."; exit 1; }

# api <endpoint> [curl -d args...]  -> raw JSON, fails on HTTP error
api() { curl -sf "https://api.stripe.com/v1/$1" -u "${STRIPE_SECRET_KEY}:" "${@:2}"; }
jget() { python3 -c 'import sys,json; print(json.load(sys.stdin)["'"$1"'"])'; }

echo "Creating product 'Stock Portfolio Pro'…"
PRODUCT_ID=$(api products -d "name=Stock Portfolio Pro" | jget id)
echo "  product: ${PRODUCT_ID}"

echo "Creating monthly price (£27.00/month)…"
MONTHLY_ID=$(api prices \
  -d currency=gbp \
  -d unit_amount=2700 \
  -d "recurring[interval]=month" \
  -d "product=${PRODUCT_ID}" | jget id)
echo "  monthly: ${MONTHLY_ID}"

echo "Creating annual price (£270.00/year)…"
ANNUAL_ID=$(api prices \
  -d currency=gbp \
  -d unit_amount=27000 \
  -d "recurring[interval]=year" \
  -d "product=${PRODUCT_ID}" | jget id)
echo "  annual:  ${ANNUAL_ID}"

cat <<EOT

Done (${mode} mode). Paste these into backend/.env:

STRIPE_PRICE_ID=${MONTHLY_ID}
STRIPE_PRICE_ID_MONTHLY=${MONTHLY_ID}
STRIPE_PRICE_ID_ANNUAL=${ANNUAL_ID}
CORE_PLAN_PRICE=27.00
ANNUAL_PLAN_PRICE=270.00

Then restart the backend so it picks up the new prices.
EOT
