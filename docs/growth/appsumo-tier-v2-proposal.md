# AppSumo tier meter v2 — proposal

*Status: code shipped dark behind `ENABLE_TIER_V2_LIMITS` (default `false`). Nothing is live. This document exists so a human can decide.*

## The problem in one sentence

Our three AppSumo tiers are separated by a meter that measures **our cost**, not **the buyer's value** — so Tier 1 already does everything a buyer wants, and nobody has a reason to climb.

## What the tiers meter today

| Tier | Price | Monthly Ask queries |
|---|---|---|
| 1 — Starter | $39 | 30 |
| 2 — Investor | $79 | 100 |
| 3 — Pro | $149 | 300 |

Every other capability is identical across the three. The only difference a buyer can feel is how many AI questions they get in a month.

## Why that meter doesn't work

**30 Asks a month is already more than a casual buyer uses.** The Ask cap was set to protect margin on a one-time payment — that is a cost-control number, and it does its job. But it was then reused as the *product ladder*, and as a ladder it fails: a buyer only feels the boundary if they run out. Most don't. A meter nobody hits is a meter nobody pays to raise.

**It prices the wrong axis.** LTD buyers on a research tool don't get more serious by asking more questions; they get more serious by **watching more companies** and **looking further back**. Those are the two things that grow with commitment, and neither is metered at all right now. A buyer tracking 3 tickers and a buyer tracking 60 pay the same $39.

**It advertises a limit rather than a capability.** "30 AI questions" reads as a restriction on the listing page. "10 companies monitored, 5 years of history" reads as a spec — and the next tier up reads as a bigger product, not as a lifted punishment.

**It makes the upgrade decision abstract.** Nobody knows in advance whether they'll use 30 or 100 questions, so Tier 1 is the rational hedge at purchase time. Everybody knows in advance roughly how many companies they follow.

## Proposed meter

Keep the existing Ask caps exactly where they are — they still do their cost-control job. Add two dimensions that meter coverage and depth:

| Tier | Price | Monitored companies | Filing history | Monthly Asks (unchanged) |
|---|---|---|---|---|
| 1 — Starter | $39 | 10 | 5 years | 30 |
| 2 — Investor | $79 | 40 | 10 years | 100 |
| 3 — Pro | $149 | Unlimited | Full | 300 |

The upgrade trigger becomes concrete and self-selecting: you hit it the moment you add the eleventh company you actually care about, which is exactly the moment the product has proven itself to you.

## The hard constraint: no retroactive downgrade

Everyone who has already redeemed a code bought unlimited coverage and unlimited history, because that is what we sold them. Metering them afterwards is a refund event, a one-star-review event, and a marketplace-policy problem.

This is enforced structurally, not by intention. `lib/tier-limits.js` returns unlimited unless **both** hold:

1. `ENABLE_TIER_V2_LIMITS=true` — off by default.
2. The account's `appsumoRedeemedAt` is on or after `TIER_V2_EFFECTIVE_FROM`.

An unset or unparseable cutover date meters **nobody**. There is no code path in which an existing redeemer receives a finite limit. This is covered by `backend/test/tier-v2-limits.test.js`.

## What is already built

- `lib/tier-limits.js` — per-tier config, the grandfather cutover, and the two meter helpers.
- Enforcement points: `POST /api/watchlist/:symbol` (monitored companies) and `GET /api/alpha/fundamentals/:symbol` (history depth). Both no-ops while the flag is off.
- `backend/test/tier-v2-limits.test.js` — 6 tests, the load-bearing one being "existing redeemed codes are never retroactively downgraded".

## Decisions a human has to make

1. **Do we change the meter at all?** The evidence for the diagnosis is structural (nobody upgrades, Tier 1 satisfies) rather than instrumented. Before flipping anything, check the actual distribution of Ask usage among redeemers — if a meaningful share are hitting 30, the diagnosis is wrong.
2. **The numbers 10 / 40 / unlimited and 5 / 10 / full** are a starting proposal, not a derived result.
3. **AppSumo tier changes must be raised with our partner contact, not edited in the Partner Portal** (known version-mapping bug on this listing).
4. **Existing-buyer communication.** Even with a clean grandfather clause, changing the published tier spec on a live listing should be announced, not discovered.

Nothing in this document has been sent to anyone.
