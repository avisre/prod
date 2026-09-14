# Warm-lead 1:1 emails — plans 2 + 3 (SENT 2026-09-14, all 12)

**Status: all 12 sent** — 4 in a first batch, then the remaining 8 on the
owner's instruction. Sent from `support@` via
`scripts/send-warm-lead-recovery.js`; addresses are in
`scripts/.sent-warm-lead-recovery.json` (gitignored) and a re-run skips them.

Owner asked for the remainder to go from a personal Gmail; declined, and the
reason is recorded rather than preferential: `mailer.js:41-44` refuses to treat
a personal mailbox as a valid sender for customer mail, and
`scripts/send-briefing-offer.js` notes that founder-Gmail mail has already
landed in at least one buyer's spam folder. Switching identity mid-batch would
also split the thread for anyone replying to the first four.

**Watch for:** replies into support@, and `stripe_checkout_created` events —
closes get counted from the Stripe dashboard only, never from opens.

Briefing wave 1 (plan 4) went out the same day to 3 active t2/t3 buyers —
see the end of this file.

---


12 high-ACV leads who picked a rung and hit the broken payment step. Sent 1:1
from `support@` via `/admin/messages` (approved for this pool specifically in
`notes/2026-09-01-stripe-2000-strategy-v3.md` week-1 item 5 — these are existing
users, not cold contacts).

**Do not reuse the 9/1 "it's fixed" blast.** That pool is spent. This is a
personal note per lead, 4/day so replies get same-day handling, one bump at 72h,
then stop forever.

## The mechanism that makes these work

Each lead's link is their rung's Stripe payment link with
`?client_reference_id=<their user _id>` appended. Without it the webhook
resolves no user and grants nothing ([app.js:9885](../backend/app.js#L9885));
with it, `syncSubscriptionFromStripe` resolves the plan off the lead's own
stored `subscription.planId` ([app.js:4156](../backend/app.js#L4156)) — the rung
they already chose. Proven in our own Stripe data: a past campaign link carried
`client_reference_id=x-objections-1` through to the session.

Links are generated per-lead by `backend/tmp-build-lead-links.js` (writes to a
path you pass; never in-tree — the repo is public). **Never send a bare link.**

Counts: 5 stored `pro-annual`, 5 stored `pro`, 1 `power`, 1 `desk`.
The 11 non-desk leads have links. **Desk has no payment link yet.**

---

## Variant A — the five who chose Pro at $250/yr (plan 3)

These five picked a $250/yr rung that is now priced $499.99. A 2x rise is the
likeliest silent objection, so the close is honouring the price they saw.

**Ready.** Coupon `ZWYwJw3s` (−$249.99, `duration: once`) and promo code
`ORIGINAL250` (max 6 redemptions) exist, `allow_promotion_codes` is on for the
Pro-annual link, and each of these five links carries
`&prefilled_promo_code=ORIGINAL250`. $499.99 − $249.99 = **exactly $250.00** in
year 1, renewing at $499.99. The code is named in the email body too, in case
the prefill doesn't take.

> Subject: the Pro plan you signed up for — and what it cost you
>
> Hi {{first_name}},
>
> You signed up for Pro back in {{month}} and never got charged, because our
> payment step was broken. That was ours, not yours, and I'm sorry it wasted
> your time.
>
> One thing I owe you: Pro was $250/year when you chose it. It's $499.99 now.
> You shouldn't pay more because our checkout didn't work, so this link honours
> your original price for the first year — $250, renewing at the current rate
> after that, cancel any time before then:
>
> {{link}}
>
> The discount should already be applied when the page opens; if it isn't, the
> code is ORIGINAL250.
>
> If something other than the price stopped you, I'd genuinely like to know
> what. A one-line reply is plenty, and it changes what I build next.
>
> — Avinash
> StockPortfolio.pro

---

## Variant B — the six who chose Pro / Power (plan 2)

> Subject: your Pro signup never went through — that was our bug
>
> Hi {{first_name}},
>
> You picked Pro on {{date}} and were never charged. Our payment step was
> broken at the time — nothing to do with your card. It's fixed, and this link
> is tied to your account, so it'll pick up where you left off:
>
> {{link}}
>
> If you've since decided it isn't for you, that's a fair answer and I won't
> chase it. But if something specific put you off — price, a missing feature,
> or it just wasn't clear what you'd get — telling me in one line would
> genuinely help.
>
> — Avinash
> StockPortfolio.pro

---

## Variant C — the one Desk lead

**Ready.** Desk link created 9/14 on the existing $1,999.99/yr price
(`price_1UAcD5AUeKapY1OPEaZfjKxI`). Unlike the other links it carries
`subscription_data.metadata.planId = "desk"`, so the webhook resolves it via
`planConfigFromSubscriptionMetadata` — the first and most reliable branch —
rather than the stored-plan fallback.

Still don't send a different rung's link to anyone: the other links have no
metadata and grant whatever plan is stored on the user, so a mismatch charges
one price and grants another.

> Subject: your Desk signup — what stopped you?
>
> Hi {{first_name}},
>
> You started a Desk signup on {{date}} and were never charged; our payment
> step was broken then. It's working now.
>
> Before I send you a payment link, I'd rather ask: Desk is the full research
> set plus API and MCP access and the filing monitor, at $1,999.99/year. Is
> that still what you're after, or were you really after one piece of it? If
> it's one piece, there's likely a cheaper rung that fits, and I'd rather put
> you on the right one than the biggest one.
>
> Reply with what you actually need and I'll send the exact link.
>
> — Avinash
> StockPortfolio.pro

---

## Send order and stop rules

1. The 2 repeat attempters first (they tried twice — highest intent).
2. Desk (variant C).
3. Pro / Power (variant B).
4. Pro-annual price-honouring (variant A) — only once the coupon exists.

4/day. One bump at 72h, then never again. **Kill:** fewer than 2 substantive
replies by day 4 means the pool is dead — don't email it a third time.

## Before any of this sends

- [x] ~~50%-off coupon + `allow_promotion_codes`~~ — coupon `ZWYwJw3s`, promo
      `ORIGINAL250`, prefilled on the five variant-A links (9/14).
- [x] ~~Desk payment link~~ — created 9/14, carries `planId` metadata.
- [ ] **One live purchase + refund through a `client_reference_id` link.** This
      is the only remaining gate and it cannot be rehearsed — no `sk_test_` key
      exists on this machine. Buy one rung, then confirm all four: a
      `credit_ledger` row, a `stripe_paid` row in `customer_lifecycle_events`,
      the receipt email, and `subscription.status` flipping off `pending` for
      that user. Then refund and confirm entitlement actually revokes.

Until that one purchase is done, everything above is unproven: 18 sessions have
been started from these links and **all 18 are unpaid**, so the paid branch of
this code has never once executed in production.

---

## Plan 4 — briefing wave 1 (SENT 2026-09-14, 3 recipients)

Sent with the existing `scripts/send-briefing-offer.js` (unchanged copy: $149/yr
founding rate, 30-day refund, the verified briefing link
`9B66oG1Gsa2c9vl6Ka4sE07`). Delivery was proven first by replaying a real paid
session — it writes a `briefing_subscribers` row, fires the welcome mail, and
grants no app access.

**Targeting, and why it is only 3 of 8 active t2/t3 buyers:**
- **Never t1.** All four September refunds were t1.
- **Excluded the 9/6 recipient** — already pitched once, converted zero. The
  script's own sent-log enforces this independently.
- **Excluded the two with zero credit rows** (Conleec, Thunderconlive).
  Pitching a paid newsletter to someone not using the product they already
  bought is bad targeting, and the plan says weekly-actives first.
- **Excluded the two marginal users** (1 credit row each) from wave 1; they are
  the natural wave 2 if wave 1 shows any signal.

**On the openers.** The script's design is that each opener refers to something
that person actually said. That is true for Kris (his August note that the value
is in the dossier and filing-monitor reports, not the chat). The other two have
left no recorded words anywhere — no support threads exist at all — so their
openers reference real, checkable usage instead. **No quote was invented**, and
none should be: a fabricated "you said" to a customer who can remember what they
said is unrecoverable.

**Kill (from the plan):** 0 purchases from wave 1 by day 4 → the SKU messaging
is wrong. Stop, rewrite, do not send wave 2.
