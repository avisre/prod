# Channel attribution

## Answer

**AppSumo is the only channel proven to have generated money.** It processed all nine real orders: $801 gross GMV and $183.97 partner revenue through 20 August, with zero recorded refunds. This does not mean AppSumo internal discovery caused all nine purchases.

Discovery is known with high confidence for one buyer, who explicitly said they saw the lifetime deal on AppSumo before purchasing Tier 3. The other eight are unknown. Portal classification says all nine were existing AppSumo users and zero were new AppSumo users; that is buyer status, not a source/medium field.

## Revenue-ranked attribution

| Rank | Channel | Verified buyers | Gross | Founder revenue | Confidence |
|---:|---|---:|---:|---:|---|
| 1 | AppSumo checkout | 9 | $801 | $183.97 | High for transaction channel; low for original discovery |
| 2 | Direct Stripe | 0 retained | £7 gross then refunded | £0 | High |
| — | X | 0 attributable | $0 attributable | $0 attributable | Medium |
| — | Google organic | 0 attributable | $0 attributable | $0 attributable | Medium |
| — | Bing organic | 0 attributable | $0 attributable | $0 attributable | Medium |
| — | LinkedIn/Reddit/email/referral/direct | 0 attributable | UNKNOWN | UNKNOWN | Low/unknown |

## Traffic and intent evidence

- AppSumo: 122 unique visitors and two orders in the latest seven-day portal card, or 1.64% visitor-to-order conversion.
- X: 37 link clicks in the native export but no verified signup, activation or purchase. The best tracked original research post generated seven clicks.
- Google: 19 clicks over the full available period, 16 from comparison pages, with no buyer join.
- Bing: 38 clicks across 67 days, with no buyer join.
- GA4: the read-only API is unavailable because the Analytics Data API is disabled in the configured GCP project. Historical UI snapshots are not customer-level attribution.
- Direct: should remain unknown. A missing source is not evidence of direct brand demand.

## Partner-link economics

The authenticated AppSumo promotion screen states that a partner earns 90% of total revenue from each **new customer brought to AppSumo** through the unique partner URL. Current portal data says all nine customers were existing AppSumo buyers, so none validates that higher rate.

This creates a testable acquisition route: drive a small number of genuinely new-to-AppSumo, high-intent investors through the unique URL and verify the order-level payout. Do not assume every click or existing AppSumo buyer earns 90%.

## Attribution repair priorities for a later implementation phase

1. Preserve a privacy-safe acquisition ID from landing through signup and redemption.
2. Import order truth separately; never infer orders from redemption events.
3. Mark missing source as unknown.
4. Link only with stable, nonempty identifiers; the audit found that joining on a missing anonymous ID can falsely assign thousands of common events to every buyer.
5. Exclude owner, QA, monitoring and bots consistently across frontend, backend and dashboards.
6. Keep finance truth in Stripe/AppSumo and behavioral truth in event systems.

## Why this might be wrong

Attribution can under-credit assisted channels. A buyer may discover the product through X or search and later buy inside AppSumo without a durable join. The correct conclusion is “not attributable,” not “definitely did not influence.”
