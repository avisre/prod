'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const briefing = require('../briefing-subscription');

const env = { STRIPE_PRICE_ID_BRIEFING_ANNUAL: 'price_briefing_live', BRIEFING_ANNUAL_USD: '149' };

test('selling is gated on the price id being configured', () => {
  assert.equal(briefing.enabled({}), false);
  assert.equal(briefing.enabled({ STRIPE_PRICE_ID_BRIEFING_ANNUAL: '   ' }), false);
  assert.equal(briefing.enabled(env), true);
});

test('price defaults to $149 and never to zero or NaN', () => {
  assert.equal(briefing.priceUsd({}), 149);
  assert.equal(briefing.priceUsd({ BRIEFING_ANNUAL_USD: 'nonsense' }), 149);
  assert.equal(briefing.priceUsd({ BRIEFING_ANNUAL_USD: '0' }), 149);
  assert.equal(briefing.priceUsd({ BRIEFING_ANNUAL_USD: '199' }), 199);
});

test('a session is recognised by metadata alone, with no line items fetched', () => {
  const payload = { metadata: { checkoutType: 'briefing_annual' } };
  assert.equal(briefing.matches(payload, [], env), true);
  // and even when the price id is not configured at all, since metadata is explicit
  assert.equal(briefing.matches(payload, [], {}), true);
});

test('a payment link built without metadata is still caught by its price id', () => {
  const payload = { metadata: {} };
  assert.equal(briefing.matches(payload, ['price_briefing_live'], env), true);
  assert.equal(briefing.matches(payload, ['price_something_else'], env), false);
});

test('another product’s checkout is never mistaken for a briefing sale', () => {
  const ltd = { metadata: { checkoutType: 'direct_ltd' } };
  assert.equal(briefing.matches(ltd, ['price_ltd_pro'], env), false);
  const topup = { metadata: { checkoutType: 'credit_topup' } };
  assert.equal(briefing.matches(topup, [], env), false);
});

test('no configured price means no accidental match on an empty id', () => {
  assert.equal(briefing.matches({ metadata: {} }, [''], {}), false);
  assert.equal(briefing.matches({ metadata: {} }, [null, undefined], {}), false);
});

test('buyer email is taken from customer_details first and normalised', () => {
  assert.equal(briefing.buyerEmail({ customer_details: { email: '  Ian@Example.COM ' } }), 'ian@example.com');
  assert.equal(briefing.buyerEmail({ customer_email: 'B@x.io' }), 'b@x.io');
  assert.equal(briefing.buyerEmail({}), '');
});

test('the cadence the welcome email promises is the one the module states', () => {
  assert.equal(briefing.COMPANIES_PER_MONTH, 2);
  const mailer = require('../mailer');
  const mail = mailer.briefingWelcomeEmail({ name: 'Ian', priceUsd: 149, companiesPerMonth: briefing.COMPANIES_PER_MONTH });
  assert.match(mail.text, /2 companies a month/);
  assert.match(mail.text, /\$149\.00 a year/);
  // The two promises that keep an existing lifetime buyer out of support.
  assert.match(mail.text, /not app access/);
  assert.match(mail.text, /not personalised investment advice/);
});

test('the owner alert flags an overlapping app account', () => {
  const mailer = require('../mailer');
  const overlap = mailer.briefingOwnerEmail({ email: 'ian@example.com', priceUsd: 149, alreadyACustomer: true });
  assert.match(overlap.text, /ALSO holds an app account/);
  const cold = mailer.briefingOwnerEmail({ email: 'new@example.com', priceUsd: 149, alreadyACustomer: false });
  assert.match(cold.text, /No app account/);
});
