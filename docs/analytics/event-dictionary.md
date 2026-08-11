# Growth Measurement V1 event dictionary

The canonical event names, owners and GA4 mapping live in
`backend/growth-measurement.js`. The Mongo collection remains
`funnel_events`; legacy `event`/`eventType` values are preserved for existing
reports while `eventName` and `schemaVersion` provide the versioned contract.

Browser events require `{consent:true}` and accept only page type, pathname,
allowlisted content/CTA IDs and feature type. Server events must be emitted by
the signup, activation, Stripe or AppSumo owner; clients cannot claim payment,
redemption or activation.
