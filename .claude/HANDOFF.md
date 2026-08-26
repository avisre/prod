# Handoff

## Task

Recruit AppSumo deal-review publishers as affiliates on the **direct** lifetime
deal. Plan: `~/.claude/plans/1-recruit-appsumo-deal-review-crystalline-phoenix.md`

Owner decisions: 30% commission; build the tracking rail *before* sending; send
from support@; mint referral links only when a partner replies (not up front).

Economics: tier-3 is $149.99. Direct at 30% → partner earns $44.99, we keep
~$105 vs ~$45 via AppSumo. Our cookie is 60 days; AppSumo's is 7.
**AppSumo's published affiliate terms: 100% up to $50 on a customer new to
AppSumo, 0-15% (contract-dependent) on a returning one.** So AppSumo pays a
deal blog *better* on a first-time AppSumo buyer — the pitch is that a deal
blog's audience is overwhelmingly *returning* AppSumo customers, where the
comparison is $44.99 vs 0-15%. Emails say this outright; do not repeat the
earlier invented "5% / $7.45" figure, which was wrong.

## Phases A1-A7 — DONE, tested, COMMITTED, DEPLOYED

Commit `80871f84` on `origin/main`, deploy `dep-da7f89ijnfac738l39ng` live.
(First deploy `dep-da7f777lk1mc73elava0` build_failed on Render's GitHub
access, not the code; owner flipped the repo public, redeployed, and it is
**back to PRIVATE** — verified.)

Prior state: full affiliate system existed but `AFFILIATE_PROGRAM_ENABLED=false`
in prod, and the LTD checkout was the one path never wired into it.

1. **A1** `createDirectLtdCheckoutSession` takes `affiliateMetadata`; all 3 call
   sites pass `affiliateProgram.buildCheckoutMetadata()`.
2. **A2** New `recordStripeOneTimePaid()`. Direct LTD is `mode:'payment'` → no
   invoice → `recordStripeInvoicePaid` never fired, so a referred LTD sale
   earned **nothing**. Keyed `cs:<session>`, basis `amount_subtotal`, 3000bps,
   held 30d. Called from the direct-LTD webhook branch, entitlement first.
3. **A3** Reversal already matched on `paymentIntentId` — proven by test.
4. **A4** `AffiliateProfile.kind` (`ambassador`|`partner`); invite accepts
   `partner: true` to skip the customer-purchase gate.
5. **A5** Payout absolute clamp $100 → **$40** so one tier-3 sale is payable.
   Partner batches must pass `minAmountMinor: 4000` explicitly.
6. **UNPLANNED, required:** `ReferralClick.destination` allowlist defaulted to
   **appsumo** — a partner link would have bounced traffic to the marketplace.
   Added `lifetime` → `/lifetime`. Partner links MUST carry
   `?destination=lifetime`.
7. **A7** `/lifetime` leak fix. Old copy said "priced from $39" under a $149.99
   card and "if price is the deciding factor, buy it on AppSumo instead" — a
   ~$110 inference on a real gap of **$0.99 at every tier**. `publicTiers()`
   now emits `appsumoPriceUsd`/`appsumoPriceDisplay` via `appsumoReferenceUsd`,
   and the page computes the gap client-side so an `APPSUMO_TIER*_PRICE_USD`
   override is reflected without a deploy. The sentence hides entirely unless
   every tier reports a positive gap. Cheapest-price disclosure and the AppSumo
   link stay (MFN is contractual, `direct-ltd.js:16-18`); only the imperative
   is gone.
8. **Payout destination** (gap found pre-send): `payoutMethod` /
   `payoutHandle` / `payoutCurrency` on `AffiliateProfileSchema`, accepted by
   the invite route and a new `POST /api/admin/affiliates/:id/payout-method`,
   and emitted in the payout batch CSV. Method + low-sensitivity handle only —
   no raw bank numbers.

Changed: `backend/app.js`, `backend/affiliate-program.js`, `backend/direct-ltd.js`,
`frontend-v2/lifetime.html`, `docs/AFFILIATE_PROGRAM.md`, tests.

### Verification

- Suites affiliate + direct-ltd + direct-ltd-wiring + direct-ltd-affiliate pass.
- Full backend suite 248/253. The 5 failures (company-statements, sitemap-index,
  social-compose, 2 in paid-first-signup) are **pre-existing**, confirmed on a
  stashed clean tree.
- **Booting the app caught what tests missed:** `/r/` returned 503 because
  `AFFILIATE_COOKIE_SECRET` did not exist on Render at all. Every partner link
  would have 503'd. Set via the Render single-key endpoint
  (`PUT /v1/services/{id}/env-vars/{key}` — a keyless PUT replaces all 53 vars).
- Prod after deploy: `/api/admin/affiliates` 403 (was 404); `/r/amb-nope` 404
  not 503; config exposes 99-cent gaps on all 3 tiers; old copy gone.

## Phase B — campaign: 2 sent, 6 pending manual submission

Kit in `marketing/ltd-partners/` (gitignored, local only): `targets.md`,
`emails.md`, `partner-terms.md`, `SENT.md`.

**Sent 2026-08-26 from support@stockportfolio.pro** (mail.privateemail.com:465,
terms attached as `StockPortfolio-partner-terms.txt`): AffinityAlly
(bdasraf22@gmail.com) and BloggingJoy (contact@bloggingjoy.com). Message-IDs in
`SENT.md`. Bodies were parsed programmatically from `emails.md` to avoid
transcription drift. No referral code in either — they say "say the word and
I'll set up your tracking link".

Only 2 of 8 verified targets publish a usable email. The other 6 (Lifetime Deal
Tech, Alston Antony, SaasTrac, Blogging Den, 99signals, FutureToolLab) are
contact forms or DM-only; drafts in `emails.md` are written to paste as-is.
Dropped thewpgorilla.com (domain expired); "affigrab"/"stackgist" don't resolve.
bestlifetimedeals.com and imisofts.com still need a contact-route check.

Do **not** attach `appsumo-verification.png` — it is a marketing banner, not a
listing screenshot. Emails cite `appsumo.com/products/stockportfoliopro/`
(HTTP 200) instead.

## Next bounded task

Owner submits the 6 form/DM drafts. On any reply: create the account, then
`POST /api/admin/affiliates/invite` with `{ userId, partner: true,
payoutMethod, payoutHandle, payoutCurrency }`, and send them
`stockportfolio.pro/r/<slug>?destination=lifetime`. An invited-but-not-accepted
profile returns 404, not a redirect — they must accept terms first.
