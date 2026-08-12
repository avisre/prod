# DealMirror launch checklist

- [ ] AppSumo written approval for the higher-priced LTD and its 120-day obligations.
- [ ] DealMirror written price-floor, no-coupon, no-reseller, no-syndication, no-restock and sold-out commitments.
- [ ] Revenue share, payout timing, refund and chargeback obligations documented.
- [ ] Final preview and terms approved; genuine-review field resolved without inventing a review.
- [ ] Dark deployment passes with `DEALMIRROR_CAMPAIGN_ENABLED=false`.
- [ ] Batch 1 generated once: exactly 20/20/10, files outside Git with mode 600.
- [ ] Dedicated production-safe code redemption test passes.
- [ ] Explicit founder approval before enabling, uploading codes, publishing or messaging customers.

Batch 2 requires all first-batch decision gates, explicit admin approval, and `DEALMIRROR_SECOND_BATCH_APPROVED=true`; it never generates automatically.
