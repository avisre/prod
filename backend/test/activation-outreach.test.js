'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-with-enough-entropy';
const outreach = require(path.join(__dirname, '../../scripts/run-activation-outreach'));

const user = { _id: '64b64b64b64b64b64b64b64b', name: '<Taylor & Co>' };

test('buyer outreach asks for a ticker and does not ask for a review', () => {
  const email = outreach.buyerEmail(user, 'https://www.stockportfolio.pro');
  assert.match(email.text, /What ticker have you been researching/);
  assert.match(email.text, /Send me one question/);
  assert.doesNotMatch(email.text, /review/i);
  assert.match(email.text, /\/api\/appsumo\/unsubscribe\?token=/);
  assert.match(email.html, /&lt;Taylor/);
});

test('expired-trial outreach is honest and has a trial opt-out', () => {
  const email = outreach.expiredTrialEmail(user, 'https://www.stockportfolio.pro');
  assert.match(email.text, /trial has ended/);
  assert.match(email.text, /one ticker/);
  assert.doesNotMatch(email.text, /review/i);
  assert.match(email.text, /\/api\/trial\/unsubscribe\?token=/);
});

test('email masking never returns the full address', () => {
  assert.equal(outreach.maskEmail('someone@example.com'), 's***e@example.com');
});
