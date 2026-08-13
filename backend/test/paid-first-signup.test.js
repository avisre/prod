const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const appSource = fs.readFileSync(require.resolve('../app'), 'utf8');
const registerSource = fs.readFileSync(require.resolve('../../frontend-v2/register.html'), 'utf8');
const homepageSource = fs.readFileSync(require.resolve('../../frontend-v2/index.html'), 'utf8');
const dossierSource = fs.readFileSync(require.resolve('../../frontend-v2/assets/dossier.js'), 'utf8');
const envExampleSource = fs.readFileSync(require.resolve('../prod.env.example'), 'utf8');
const socialSource = fs.readFileSync(require.resolve('../../frontend-v2/assets/social.js'), 'utf8');
const termsSource = fs.readFileSync(require.resolve('../../frontend-v2/terms.html'), 'utf8');

test('new registrations use paid-first Stripe checkout with no Stripe trial', () => {
  assert.match(appSource, /REQUIRE_INITIAL_STRIPE_PAYMENT/);
  assert.match(appSource, /paymentRequired = initialPaymentRequiredForSignup/);
  assert.match(appSource, /skipTrial: paymentRequired/);
  assert.match(appSource, /initialSignup: paymentRequired/);
  assert.match(appSource, /appsumoActivationSignup/);
});

test('published checkout plans have a safe active-price fallback when Render lacks a Price ID', () => {
  assert.match(appSource, /resolveStripeCheckoutPlan/);
  assert.match(appSource, /active: true/);
  assert.match(appSource, /productName: 'power — stockportfolio\.pro'/);
  assert.match(appSource, /productName: 'desk — stockportfolio\.pro'/);
  assert.match(appSource, /price\?\.recurring\?\.interval === spec\.interval/);
});

test('Power monthly is a complete, consistently priced published plan', () => {
  assert.match(appSource, /POWER_MONTHLY_PLAN_ID = 'power-monthly'/);
  assert.match(appSource, /POWER_MONTHLY_PLAN_PRICE = parseFloat\(process\.env\.POWER_MONTHLY_PLAN_PRICE \|\| '64\.00'\)/);
  assert.match(appSource, /\[POWER_MONTHLY_PLAN_ID\]: \{ amount: 64, currency: 'USD', interval: 'month'/);
  assert.match(appSource, /STRIPE_PRICE_ID_POWER_MONTHLY/);
  assert.match(envExampleSource, /^STRIPE_PRICE_ID_POWER_MONTHLY=/m);
  assert.match(registerSource, /power-monthly/);
  assert.match(registerSource, /\$64 billed today, then monthly/);
  assert.match(homepageSource, /\$64<span>\/month<\/span>/);
  assert.match(homepageSource, /register\.html\?plan=power-monthly/);
  assert.match(homepageSource, /\$579\/year/);
  assert.match(dossierSource, /Start Power — \$64\/mo/);
  assert.match(dossierSource, /\$579\/yr — save 25%/);
  assert.match(termsSource, /\$64\/month or \$579\/year \(Power\)/);
  assert.match(termsSource, /\$1,961\/year \(Desk\)/);
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
  assert.match(registerSource, /\$12 charged today/);
  assert.match(registerSource, /\$33 charged today/);
  assert.doesNotMatch(termsSource, /7-day free trial \(no card required\)/);
});
