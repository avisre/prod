const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const mailer = require('../mailer');
const appSource = fs.readFileSync(require.resolve('../app'), 'utf8');

const base = { name: 'Ada', email: 'ada@example.com', type: 'stripe_paid', plan: 'Monthly', occurredAt: new Date('2026-10-07T22:05:27Z') };

test('the owner paid-subscriber email states the amount charged', () => {
  const mail = mailer.internalCustomerEventEmail({ ...base, amount: '79.99 USD' });
  assert.equal(mail.subject, 'New paid subscriber activated: ada@example.com — 79.99 USD');
  assert.match(mail.text, /\nPlan: Monthly\nAmount: 79\.99 USD\nWhen: /);
  assert.match(mail.html, /Amount<\/td><td>79\.99 USD<\/td>/);
});

test('a list-price fallback is labelled and kept out of the subject', () => {
  const mail = mailer.internalCustomerEventEmail({ ...base, amount: '79.99 USD (list price — charged amount not known here)' });
  assert.equal(mail.subject, 'New paid subscriber activated: ada@example.com');
  assert.match(mail.text, /Amount: 79\.99 USD \(list price/);
});

test('no amount means no amount row, and AppSumo mail is unchanged', () => {
  const none = mailer.internalCustomerEventEmail(base);
  assert.equal(none.subject, 'New paid subscriber activated: ada@example.com');
  assert.doesNotMatch(none.text, /Amount:/);
  const appsumo = mailer.internalCustomerEventEmail({ ...base, type: 'appsumo_redeemed', tier: 2 });
  assert.equal(appsumo.subject, 'New AppSumo buyer activated: ada@example.com');
  assert.doesNotMatch(appsumo.html, /Amount/);
});

test('both checkout-webhook activations pass what Stripe charged', () => {
  const calls = appSource.match(/recordCustomerLifecycleEvent\(user, 'stripe_paid', \{ source: 'stripe', amountMinor: payload\.amount_total, currency: payload\.currency \}\)/g) || [];
  assert.equal(calls.length, 2);
  assert.match(appSource, /amount: paidAmountLabel\(/);
});
