# Warm-lead 1:1 emails — plans 2 + 3 (drafted 2026-09-14, NOT SENT)

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

**Blocked until:** a 50%-off, `duration: once` coupon exists AND
`allow_promotion_codes` is enabled on the Pro-annual link. Without both, the
discount cannot be redeemed and this variant must not go out.

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

**Blocked until:** a $1,999.99/yr Desk payment link exists. Don't send a
different rung's link — the webhook grants whatever plan is stored on the user,
so a mismatched link charges one price and grants another.

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

- [ ] One live purchase + refund through a `client_reference_id` link, checking
      the grant actually lands (`credit_ledger` row, `stripe_paid` lifecycle
      event, receipt email) and reverses cleanly on refund.
- [ ] 50%-off `duration: once` coupon + `allow_promotion_codes` on the
      Pro-annual link (variant A only).
- [ ] Desk $1,999.99/yr payment link (variant C only).
