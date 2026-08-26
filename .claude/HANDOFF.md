# Handoff

## Task

Recruit AppSumo deal-review publishers as affiliates on the **direct** lifetime
deal. Plan: `~/.claude/plans/1-recruit-appsumo-deal-review-crystalline-phoenix.md`

Owner decisions: 30% commission, build the tracking rail *before* sending,
send from support@ after showing drafts.

Economics: tier-3 is $149.99. Direct at 30% → we keep $105 vs ~$45 via AppSumo.
Partner earns $44.99 vs AppSumo's ~$7.45 on a returning buyer (5%, 7-day
cookie). Our cookie is 60 days. **The pitch is the partner's number.**

## Phase A — tracking rail: DONE, tested, NOT deployed

Prior state: full affiliate system existed but `AFFILIATE_PROGRAM_ENABLED=false`
in prod, and the LTD checkout was the one path never wired into it.

1. **A1** `createDirectLtdCheckoutSession` (app.js) now takes `affiliateMetadata`
   and spreads it into session metadata; all 3 call sites pass
   `affiliateProgram.buildCheckoutMetadata()`, matching the other 4 builders.
2. **A2** New `recordStripeOneTimePaid()` in `affiliate-program.js`. Direct LTD
   is `mode:'payment'` → no invoice → `recordStripeInvoicePaid` never fired, so
   a referred LTD sale earned **nothing**. Keyed `cs:<session>`, basis =
   `amount_subtotal` (excludes tax), rate 3000bps via existing table (`planId`
   is already `'pro'`), held for `directLtd.refundDays()` (30). Called from the
   direct-LTD webhook branch after `handleDirectLtdPaid`, entitlement first.
3. **A3** No code change needed — reversal already matches on `paymentIntentId`,
   which the new commission and the order both carry. Proven by test, not
   assumption.
4. **A4** `AffiliateProfile.kind` (`ambassador`|`partner`). Admin invite accepts
   `partner: true` to skip the customer-purchase gate (external publishers are
   not customers and could not be enrolled at all). Default path unchanged.
   `canAcceptAmbassadorInvite` lets a partner activate.
5. **A5** Payout clamp: default minimum stays $100; absolute clamp lowered
   $100 → **$40** so one tier-3 sale ($44.99) is payable. Partner batches must
   pass `minAmountMinor: 4000` explicitly.
6. **UNPLANNED, required:** `ReferralClick.destination` was an allowlist of
   `['appsumo','pricing','home']` defaulting to **appsumo** — a partner link
   would have redirected traffic back to the AppSumo listing. Added `lifetime`
   → `/lifetime` in the enum, `safeDestination`, and `handleAffiliateReferral`.
   Partner links MUST carry `?destination=lifetime`.
7. **A6** Release-2 owner override recorded in `docs/AFFILIATE_PROGRAM.md`.
   **Flag NOT flipped, nothing deployed** — awaiting explicit authorization.

Changed: `backend/app.js`, `backend/affiliate-program.js`,
`docs/AFFILIATE_PROGRAM.md`, new `backend/test/direct-ltd-affiliate.test.js`.
Uncommitted.

### Verification done

- New suite 4/4: commission is exactly 4499 minor at 3000bps, pending, held
  ~30d; webhook replay is a no-op; refund reverses in full via payment_intent;
  organic + self-referral earn nothing; partner activation; payout clamp.
- affiliate + direct-ltd + direct-ltd-wiring + new suite: **51/51 pass**.
- Full backend suite: 248/253. The 5 failures (company-statements, sitemap-index,
  social-compose, 2 in paid-first-signup) were confirmed **pre-existing** by
  re-running them on a stashed clean tree. Not caused by this work.

## Phase B — campaign kit: DONE

`marketing/ltd-partners/` — `targets.md`, `emails.md`, `partner-terms.md`.
8 verified targets + 2 needing a contact check. Dropped **thewpgorilla.com**
(domain expired); "affigrab"/"stackgist" from the brief don't resolve to live
sites. Only **2 of 8** publish a usable email (affinityally, bloggingjoy) — the
rest are contact forms / Cloudflare-obfuscated / DM-only, so this is realistically
2 emails + 6 form-or-DM submissions, not 10 emails.

## Open decisions for the owner

1. **`/lifetime` undercuts this campaign.** The page tells visitors the deal is
   on AppSumo from $39 and "if price is the deciding factor, buy it on AppSumo
   instead". Referred traffic that reads this leaks to the marketplace: partner
   gets ~5%, we keep ~$45 not ~$105. Honest copy, deliberate price floor — but
   decide whether referred visitors should see different framing.
2. Authorize the deploy: `AFFILIATE_PROGRAM_ENABLED=true`,
   `AFFILIATE_ATTRIBUTION_DAYS=60` on Render, then deploy via the Render API
   (a commit alone does not deploy).

## Next bounded task

After deploy: verify `/api/admin/affiliates` returns 403 (not 404), enroll the
2 emailable partners via `/api/admin/affiliates/invite` with `partner: true`,
confirm one real `/r/amb-xxxx?destination=lifetime` click lands a ReferralClick
and redirects to `/lifetime`, then send the two approved drafts from support@.
