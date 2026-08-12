# DealMirror pilot — architecture and approval notes

## Architecture

- `dealmirror_batches`, `dealmirror_licences`, `dealmirror_imports` and `dealmirror_audit_events` are separate from AppSumo and affiliate collections.
- Plaintext codes are generated only by `scripts/generate-dealmirror-codes.js`; MongoDB stores a HMAC-SHA-256 hash plus a six-character support suffix.
- Batch allocation is fixed at 20 Starter, 20 Investor and 10 Pro. The absolute issued-code ceiling is hard-coded at 100.
- Redemption uses a conditional `findOneAndUpdate` from `available` to `redeemed`, unique code hashes, and a unique active-code-per-user check. This avoids relying on MongoDB transactions, which are not confirmed as available in the current Render/Mongo configuration.
- DealMirror grants existing Pro capability with tier Ask caps of 30/100/300 through a separate DealMirror marker. It rejects active Stripe and AppSumo lifetime accounts and does not alter their records.
- CSV reconciliation only accepts strong licence-code or order-ID matches; it never matches names. A committed refund removes only DealMirror access while preserving AppSumo/Stripe/professional access.

## Risk-ordered gates

1. **Contractual:** written AppSumo permission and DealMirror price-floor/inventory controls are required before publication.
2. **Commercial:** revenue share, payout timing, refund/chargeback ownership and exports must be documented.
3. **Security:** set the pepper only in Render/secret management, run dark-deployment smoke tests, then generate the protected one-time export.
4. **Operational:** validate the DealMirror CSV headings and use a dry run before any commit.
5. **Product:** verify every listing claim and collect screenshots/video; do not invent a review.

## Existing-system conflicts / limitations found

- The requested historical baseline says 109 backend tests, while the current clean suite contains 138 pre-existing tests; the DealMirror additions bring it to 142.
- Current `backend/prod.env.example` contains legacy/transition price settings that do not match every price in the request. No pricing variable or entitlement was modified by this pilot.
- MongoDB transaction support cannot be established from repository configuration alone; the implementation deliberately does not require it.
- The application has no universal CSRF-token system for authenticated JSON APIs. The pilot follows the existing JWT/same-site request pattern; production security review should decide whether to add a shared CSRF layer rather than bolt one onto only this route.
- No authenticated DealMirror vendor integration, vendor API, written AppSumo permission, DealMirror commercial terms, screenshots, video, or genuine review is present. These remain explicit go-live blockers.
