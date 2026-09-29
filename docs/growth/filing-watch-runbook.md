# Filing Watch pilot

One $49 USD/month subscription includes founder-prepared public-filing updates
for three supported US-listed stocks and the standard Monthly software tier.
Five customers maximum; entirely new buyers; factual assistance for personal
use. The first brief is due within 48 hours of ticker submission, followed by
one email each Friday for every paid month. Existing initial-payment refund
and cancellation routes apply. This is service-plus-software recurring revenue.

## Launch state and configuration

The implementation defaults CLOSED (`FILING_WATCH_ENABLED` absent or false).
The live price created and verified on September 29, 2026 is
`price_1UKsebAUeKapY1OP7d68Qp7r`: USD 4,900 cents, recurring every one month,
on the existing `stockportfolio.pro` product. Creating a price charged nobody.
Do not enable the offer until real Stripe sandbox acceptance is recorded.

Public offer: `/filing-watch`. Sourced sample: `/filing-watch-sample`.
Post-payment stock selection: `/filing-watch/start`.
No shared frontend bundle was changed; existing cache stamps stay intact.

Price verification and setup (keys stay in a local file or environment):

```sh
# Read-only by default. A raw test-key file or env file is accepted.
node scripts/filing-watch-stripe.js --mode test --key-file /path/to/test-key
# Only if that reports no matching price:
node scripts/filing-watch-stripe.js --mode test --key-file /path/to/test-key --apply
# Live price already exists; verification is read-only:
node scripts/filing-watch-stripe.js --mode live --key-file backend/.env
```

The helper parses only Stripe credentials and never loads a database URI or
mail configuration. Do not run the application locally with `backend/.env`.
Use a scratch local MongoDB and explicit test environment settings instead.
For production set `STRIPE_PRICE_ID_FILING_WATCH` to the verified live id.
Set `FILING_WATCH_ENABLED=true` only after acceptance and deployment checks.
Switching the flag off stops new invitations/checkouts, not fulfilment for
existing paid customers.

## Required validation

```sh
node scripts/verify-filing-watch.js
cd backend
npm test
```

`verify-filing-watch.js` starts the real app and a disposable local MongoDB,
with Stripe **mocked** and dotenv loading disabled. It exercises unpaid and
paid signup, invitation identity, duplicate prevention, price verification,
fulfilment intake, renewal failure/recovery, cancellation and standard Monthly
checkout. It is not proof of a real Stripe transaction.

Complete these separately in Stripe sandbox before launch:

1. Configure a local/staging instance with sandbox secret, publishable key,
   webhook secret, expected account id and the matching sandbox $49 price.
   Forward sandbox webhooks to `/stripe/webhook`. Use only a local scratch DB;
   disable mail and keep all production keys out of that process.
2. Issue a personal invitation through the admin API; open its registration
   URL. Confirm a single $49/month line item, no trial and no promo field.
3. Submit Stripe's successful test payment method. Confirm the paid invoice,
   account activation, standard Monthly entitlements, and three-ticker intake.
4. Use a separate invited buyer for a declined payment. Confirm no active
   account or revenue; successful retry must use the same Checkout session.
5. Exercise a renewal with Stripe test clocks; check invoice amount, app plan
   identity, failed-renewal suspension and paid recovery.
6. Cancel through the app. Verify access until period end, then cancellation
   removes paid access. Verify initial-payment refund cancels the subscription.
7. Verify the existing Monthly, Annual, Pro, Desk, Dev and AppSumo paths.

Use [Stripe sandbox testing](https://docs.stripe.com/testing). Do not make a
real-card production purchase merely to test billing. Record real sandbox
session/invoice ids and results privately. The first live payment should be a
genuine buyer. A successful browser return alone is not payment evidence.

After deployment check the offer, sample, redirects, registration summary,
admin authentication and cancellation from outside. Opening the public page
does not prove the paid flow. If any gate fails, keep the flag off and send no
paid offers.

## Five invitations and fulfilment

All admin APIs require `x-admin-token` from the existing owner secret; never
put it in a URL, document, shell argument or source control.

- `POST /api/admin/filing-watch/invitations`, JSON `{"email":"buyer@example.com"}`,
  returns the one-time, email-bound registration URL. Send it only after
  interest and a live check that the requested companies' filings are
  available. No existing app account may enter the pilot. Registration uses
  email/password for this pilot; other plans retain social sign-in.
- `GET /api/admin/filing-watch` is the private daily service queue. It includes
  account/subscription identity, tickers, deadlines and sent-report references.
  Invitations and queue rows are not verified revenue.
- `POST /api/admin/filing-watch/:seat/revoke` releases an unused invitation.
  It refuses any seat whose checkout has started. Do not recycle started,
  paid or cancelled seats without checking Stripe and the pilot capacity.
- `POST /api/admin/filing-watch/:seat/deliveries`, JSON containing
  `weekEnding` (YYYY-MM-DD), `evidence` (sent message/thread reference) and
  `baseline: true` for the first brief, records an actual delivery. It sends
  nothing by itself. Never record a draft as sent.

Check the queue each working day and again Friday before delivery. A support
notification is attempted when the buyer submits tickers; the saved queue
remains authoritative if mail fails. Check the customer email against the
paid account and confirm active payment before preparing each report.

For each stock, read the dated filing feed and the underlying primary filing.
Include the review window, relevant changes, source links/sections, calculations
labelled as calculations, and questions the evidence does not answer. Say
“no new filings in the checked window” only after a successful feed check.
Report unavailable sources as gaps; do not silently reuse an old report.
Send via the established customer message/email workflow, then record its
reference. Ask which section was useful after the first delivery.

Checkout sessions expire after one hour. Failed creation or abandonment holds
the seat to avoid duplicate charges. First inspect the seat, PendingSignup and
Stripe session (including pending-signup metadata). If still open, help the
buyer finish that same checkout. If the response was lost, search Stripe by
the pending-signup id before considering any replacement. Only an operator
who has established that no payable session/subscription remains may reset a
started seat. There is deliberately no automatic seat-recycling job.

## Acquisition experiment

Budget $0; founder time 60–90 minutes/day. Target 5 qualified individual offers
in the first 48 hours **after the launch gates pass**, 20 total by day 10, then
finish permitted follow-ups and review by day 14. Dates start from actual
launch, not from code completion. No unattended sends or follow-ups are set.

A qualified prospect needs a public filing-help request dated within 30 days,
an exact stock, verified product coverage, a suitable public contact route,
and a prior-conversation/customer/opt-out check. Exclude old outreach,
commercial newsletter writers and communities that prohibit the offer. A
search snippet alone is not enough to send. Store qualification evidence and
actual messages in the private/local outreach log.

Prepare one verified finding before contact:

> You asked about [specific question]. The filing says [finding]: [source].
> I run stockportfolio.pro. I offer a personally prepared weekly filing update
> for three stocks, including software access, for $49/month. Here is a sample:
> https://www.stockportfolio.pro/filing-watch-sample . Would this help with the
> companies you follow?

Use Avinash's authorized personal account for cold contact, never support@.
One follow-up after at least two days if no reply; stop on decline/opt-out.
An interested reply gets the invitation; a call is optional.

Track prospects, contact evidence, interested replies, signups, invoice ids,
refunds and renewals separately. Count only genuine paid recurring invoices
linked to real new customers; exclude test/owner, unpaid, refunded and lifetime
orders. Five customers would produce $245/month before fees; it is capacity,
not a forecast. After ten offers without interest, revise targeting/message.
After twenty qualified offers with no payment, stop expanding the batch and
review objections. Expand to ten only after reliable delivery and renewal
interest.
