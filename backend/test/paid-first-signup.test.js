const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const appSource = fs.readFileSync(require.resolve('../app'), 'utf8');
const registerSource = fs.readFileSync(require.resolve('../../frontend-v2/register.html'), 'utf8');
const socialSource = fs.readFileSync(require.resolve('../../frontend-v2/assets/social.js'), 'utf8');
const termsSource = fs.readFileSync(require.resolve('../../frontend-v2/terms.html'), 'utf8');

test('new registrations use paid-first Stripe checkout with no Stripe trial', () => {
  assert.match(appSource, /REQUIRE_INITIAL_STRIPE_PAYMENT/);
  assert.match(appSource, /paymentRequired = initialPaymentRequiredForSignup/);
  assert.match(appSource, /skipTrial: paymentRequired/);
  assert.match(appSource, /initialSignup: paymentRequired/);
  assert.match(appSource, /appsumoActivationSignup/);
});

test('self-serve checkout has a safe active-price fallback when Render lacks a Price ID', () => {
  assert.match(appSource, /resolveStripeCheckoutPlan/);
  assert.match(appSource, /active: true/);
  assert.match(appSource, /productName === 'stockportfolio\.pro'/);
  assert.match(appSource, /price\?\.recurring\?\.interval === spec\.interval/);
});

test('seven-day refund state is recorded and protected by an authenticated route', () => {
  assert.match(appSource, /initialRefundUntil/);
  assert.match(appSource, /recordInitialStripePayment/);
  assert.match(appSource, /app\.post\('\/api\/billing\/refund', authMiddleware/);
  assert.match(appSource, /initialRefundStatus: 'requested'/);
  assert.match(appSource, /stripe\.refunds\.create/);
});

test('signup surfaces describe payment and refund terms instead of a no-card trial', () => {
  assert.match(registerSource, /Continue to secure checkout/);
  assert.match(registerSource, /refund within 7 days/);
  assert.doesNotMatch(registerSource, /no card required/);
  assert.match(socialSource, /data\.subscription && data\.subscription\.isActive/);
  assert.match(termsSource, /initial payment is refundable within 7 days/);
  assert.match(registerSource, /£9 charged today/);
  assert.match(registerSource, /£25 charged today/);
  assert.doesNotMatch(termsSource, /7-day free trial \(no card required\)/);
});
