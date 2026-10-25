# Website conversion measurement

`backend/pixels.js` supplies the public Google Ads tag ID and action labels.
They are website identifiers, not credentials. Environment variables override
the deployment defaults: `GOOGLE_ADS_ID`,
`GOOGLE_ADS_CONVERSION_LABEL_SUBSCRIBE`, and
`GOOGLE_ADS_CONVERSION_LABEL_SIGNUP`. Setting `GOOGLE_ADS_ID` to an explicitly
empty string disables Ads. `META_PIXEL_ID` is optional and off by default.

The primary Ads action is **Paid subscription (verified checkout)**. The
secondary action is **Account created (paid signup)**, with zero revenue value.
Account creation is an observation step, not an additional paid customer.

## What counts

For new paid-first email and social registrations, `/api/checkout/claim`
retrieves the session from Stripe, verifies payment, and creates/signs in the
account. `checkout-conversions.js` returns a sanitized receipt for a live,
nonzero subscription checkout. Amount and currency come from Stripe, not the
return URL or the advertised plan price. `PendingSignup.createdAccount`
preserves whether the payment created an account when the webhook wins the
race with the checkout return.

`spTrackPaidSignup` waits briefly for configuration and the event callback
before redirecting. It requires explicit analytics consent on the production
hostname. A pending receipt survives navigation in session storage for up to
24 hours, permitting later consent. Sent receipts are locally deduplicated;
each action includes a stable `transaction_id` for Google to deduplicate
retries. Stripe session IDs, names, email addresses and account IDs are not
sent to Google by this helper; identifiers are hashes.

An unpaid/test checkout, a success URL by itself, login to an active
subscription, and review accounts do not generate paid conversions. Enhanced
conversions/customer identity upload are not part of this implementation.
Legacy `spTrack` hooks do not emit Ads conversions.

## Scope and verification

This measures acquisition through new paid-first registrations. Renewals,
existing-account upgrades, AppSumo activations, refunds, and buyers who never
return from Stripe are outside this browser path. Refused consent and blocked
advertising scripts can prevent measurement. Session-storage receipts are
measurement hints, not authentication/entitlement evidence. Conversion value
is the initial checkout payment, not lifetime subscription revenue.

`node --test backend/test/checkout-conversions.test.js` tests receipt
validation, the actual claim handler with local stubs, consent, callback/config
races, navigation persistence, deduplication, expiry and both checkout return
paths. It never contacts Stripe, sends Google events or creates accounts.

After deployment check `/api/analytics/config`, the cache stamps on the
register page/app bundle, and Google Ads goal settings. Google can show
Awaiting conversions until a legitimate consented purchase is received.
Creating goals and passing local tests do not prove Google received a sale.
Do not fabricate production purchases for verification.
