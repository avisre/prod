# Week-1 forensics readout — checkout, Stripe account, referral bucket

2026-09-01, all ownerless, all read-only except one live checkout-session
creation (no charge possible without card details; session expires in 24h).
Scripts: `/tmp/ceo-collect/{checkout-forensics,price-list,inspect-checkout,pending-dating,pending-prices,referral2}.js`.
This is the measured readout for strategy v3's Week-1 items 1, 2 (forensics
part), 3 (audit part), and 4.

## 1. The August abandonment is EXPLAINED — a real mechanical defect, now mostly fixed

**The 25 pending-checkout leads (not 12 — see §2) attempted FOUR different
price generations, two of them broken:**

| Attempted price | Leads | Status today |
|---|---|---|
| `price_1U7kok…` GBP £9/mo | **3 (monthly)** | **NOT ON CURRENT ACCOUNT — 404. Checkout hard-failed.** |
| `price_1TDjao…` GBP £7/mo, `price_1TgXC1…` GBP £9/mo | 2 (monthly) | Active GBP prices — US-facing buyers shown **pounds** |
| June USD generation: $12/mo, $33/mo pro, $250/yr pro-annual, $579/yr power, $1,961/yr desk, $90/yr annual | ~15 | Active but superseded by the 8/31 ladder |
| No price id stored (plan choice only) | 5 | checkout never reached session creation, or pre-price schema |

All dated pending leads signed up in **2026-08** — before the 8/31 price
creation and 9/1 ladder deploy. Funnel months confirm: every
`stripe_checkout_created` event (35) is 2026-08; one more on 2026-09-01.

**The current pipe is verified healthy, ownerlessly:**
- Live account `acct_1TDj4gAUeKapY1OP` (GB): `charges_enabled=true`,
  `payouts_enabled=true`, `details_submitted=true`, `card_payments=active`,
  Link/Klarna/Amazon Pay etc. active.
- All 8/31 ladder prices exist, active, **USD**: Good $24.99/mo, Good-annual
  $199.99/yr, Pro $499.99/yr, Desk $1,999.99/yr, topup $14.99 one-time
  (+ $39.99/$79.99/$149.99 LTD tiers + legacy June prices).
- A live subscription checkout session was created against the Good-monthly
  price without error, and the hosted Stripe page was loaded headless:
  **US$24.99/month, Apple Pay + card (Visa/MC/Amex/UnionPay/…), product
  image, zero console errors** (screenshot `/tmp/ceo-collect/checkout-page.png`).

**CEO read:** the "100% abandonment" was substantially a broken/£-mixed
checkout across three price generations, not pure price shock. The 8/31
re-pricing already removed most of the defect; the hosted page is verified
clean today. What remains unverified is the final payment attempt itself
(requires one owner live purchase+refund — the standing week-1 gate).

**Consequences:**
1. The 12-lead recovery email (v3 §Week-1 item 5) is upgraded in confidence:
   we can honestly tell leads "our checkout was broken when you tried; it's
   fixed" — and we now know several were shown GBP prices for a USD product.
2. **The warm pool is 25 leads, not 12**: 10+2 monthly, 5 pro, 1+4 pro-annual,
   1 annual, 1 power, 1 desk. Run mapping for the new ladder:
   monthly→Good $24.99/mo · pro→Pro $499.99/yr · pro-annual→Pro $499.99/yr
   (they chose a $250/yr rung; anchor on Pro) · annual→Good-annual
   $199.99/yr · power→Pro $499.99/yr (retired rung) · desk→Desk $1,999.99/yr
   (quote rung — founder-led).
3. `STRIPE_PRICE_ID_*` env keys are **absent from the 8/31 env backup** —
   checkout still worked because `resolveStripeCheckoutPlan` validates at
   request time, but the per-key PUT list at next deploy should include the
   four rung price IDs + topup to remove the runtime-lookup dependency.

## 2. Pending-lead count correction

`users.find({'subscription.status':'pending'})` → **25** (the brief's 12 was
a filtered/windowed subset). Subscription subdoc carries no timestamps and no
stored `stripeSessionId`, so intent dating comes from `createdAt` (all
August) — treat "hasSessionId=false" as "no recorded session", not "no
attempt": the 35 Aug funnel events prove sessions were created; the user-row
just never linked them.

## 3. Referral bucket resolved — not a hidden channel

`trafficSource:'referral'` human events/28d = 535, broken down by referrer
hostname (`marketingAttribution.referrerHostname` logic):

- **localhost 310 + 127.0.0.1 82 + prod-gpln.onrender.com 4 = 396 (74%)** —
  owner's own local testing leaking into the "referral" bucket. Not external
  demand.
- Real external referral, by sessions: **appsumo.com 41** (the listing
  backlink), t.co 16, search.yahoo.com 10, github.com 7,
  **copilot.microsoft.com 6** (AI assistant), betalist.com 5,
  **checkout.stripe.com 5** (users returning mid-checkout), then a metasearch
  long tail (mamma, webcrawler, alhea, teoma, qwant… 1–2 each).
- One yuanbao.tencent.com session (Tencent's AI assistant).

**CEO read:** the 188-session "referral" row in the brief is ~3/4 owner
self-traffic; the genuine external referral surface is ~60–70 sessions/mo,
dominated by the AppSumo listing backlink and a small AI-assistant tail.
No second-best acquisition surface exists here — Engine C's AI-citation bet
(copilot/yuanbao appearing unbidden) is the only part worth attention. The
admin panel's internal re-derivation (app.js:10647–10656) already re-labels
localhost correctly for its own tables; the raw bucket remains opaque in
ad-hoc queries.

## 4. Not yet done from Week-1 (owner gates)

- One live owner purchase + refund through the real checkout (the last
  unverified link).
- The two support@ sends — drafts ready, owner approval required.
- Topup + price-ID per-key PUTs at next deploy (env snapshot first).