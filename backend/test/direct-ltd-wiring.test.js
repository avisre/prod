'use strict';
// Verifies the direct-LTD checkout guard against realistic Stripe Price
// objects, and asserts the app.js wiring invariants that keep the AppSumo and
// direct channels separately countable.
//
// NOTE ON SCOPE: this repo has no Stripe TEST key configured (backend/prod.env
// carries sk_live only), so no live Stripe API call is made from these tests,
// in test mode or otherwise. The Price objects below are the exact shapes
// stripe.prices.retrieve() returns, fed through the same validateStripePrice()
// the checkout route calls.
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ltd = require('../direct-ltd');

const env = {
  DIRECT_LTD_ENABLED: 'true',
  STRIPE_PRICE_ID_LTD_STARTER: 'price_test_starter',
  STRIPE_PRICE_ID_LTD_INVESTOR: 'price_test_investor',
  STRIPE_PRICE_ID_LTD_PRO: 'price_test_pro'
};

// Shape of a Stripe one-time Price as returned by prices.retrieve().
const stripePrice = (over = {}) => ({
  id: 'price_test_investor', object: 'price', active: true, currency: 'usd',
  unit_amount: 7999, type: 'one_time', recurring: null, livemode: false, ...over
});

test('a correctly configured test-mode Price passes and yields the charge amount', () => {
  const { amountUsd, drift } = ltd.validateStripePrice(stripePrice(), 2, env);
  assert.equal(amountUsd, 79.99);
  assert.equal(drift, false);
});

test('all three tiers validate at their advertised amounts', () => {
  const amounts = { 1: 3999, 2: 7999, 3: 14999 };
  for (const tier of ltd.TIER_NUMBERS) {
    const { amountUsd } = ltd.validateStripePrice(stripePrice({ unit_amount: amounts[tier] }), tier, env);
    assert.equal(amountUsd, ltd.TIERS[tier].directUsd, `tier ${tier}`);
  }
});

test('GUARD: a Stripe Price edited below the AppSumo tier blocks the sale', () => {
  // Someone lowers tier 2 to $69 in the Stripe dashboard. Nothing in this repo
  // changed, so only the runtime guard can catch it.
  assert.throws(
    () => ltd.validateStripePrice(stripePrice({ unit_amount: 6900 }), 2, env),
    (e) => e instanceof ltd.PriceFloorViolation && e.code === 'DIRECT_LTD_PRICE_FLOOR'
  );
});

test('GUARD: a Stripe Price edited to exactly the AppSumo tier blocks the sale', () => {
  assert.throws(
    () => ltd.validateStripePrice(stripePrice({ unit_amount: 7900 }), 2, env),
    (e) => e instanceof ltd.PriceFloorViolation
  );
});

test('GUARD: a Price above the floor but off the advertised amount is allowed and flagged as drift', () => {
  const { amountUsd, drift } = ltd.validateStripePrice(stripePrice({ unit_amount: 8999 }), 2, env);
  assert.equal(amountUsd, 89.99);
  assert.equal(drift, true); // exclusivity-safe, but /lifetime now advertises the wrong price
});

test('GUARD: a recurring Price is refused — a lifetime deal must not become a subscription', () => {
  assert.throws(
    () => ltd.validateStripePrice(stripePrice({ recurring: { interval: 'month' }, type: 'recurring' }), 2, env),
    (e) => e.reason === 'recurring'
  );
});

test('GUARD: an inactive or missing Price is refused', () => {
  assert.throws(() => ltd.validateStripePrice(stripePrice({ active: false }), 2, env), (e) => e.reason === 'inactive');
  assert.throws(() => ltd.validateStripePrice(null, 2, env), (e) => e.reason === 'missing');
});

test('GUARD: a non-USD Price is refused because it cannot be compared to the USD floor', () => {
  assert.throws(
    () => ltd.validateStripePrice(stripePrice({ currency: 'eur', unit_amount: 7999 }), 2, env),
    (e) => e.reason === 'currency'
  );
});

test('GUARD: an AppSumo price rise makes the already-live Stripe Price fail validation', () => {
  const raised = { ...env, APPSUMO_TIER2_PRICE_USD: '99' };
  assert.throws(
    () => ltd.validateStripePrice(stripePrice(), 2, raised),
    (e) => e instanceof ltd.PriceFloorViolation
  );
});

// ---- app.js wiring invariants ----------------------------------------------
const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('no analytics call site still infers the channel from appsumoRedeemedAt alone', () => {
  // A direct buyer also has appsumoRedeemedAt set, so this old ternary would
  // have booked direct revenue as AppSumo revenue.
  assert.equal(
    appSource.includes("user.appsumoRedeemedAt ? 'appsumo' : (user.stripeSubscriptionId ? 'stripe' : 'trial')"),
    false
  );
  assert.match(appSource, /function entitlementSourceFor\(user\)/);
});

test('the lifecycle event model accepts the direct-ltd channel as its own value', () => {
  assert.match(appSource, /enum: \['direct', 'social', 'stripe', 'appsumo', 'direct-ltd'\]/);
  assert.match(appSource, /'appsumo_redeemed', 'direct_ltd_redeemed'/);
});

test('the User model carries an indexed ltdChannel restricted to the two lifetime channels', () => {
  assert.match(appSource, /ltdChannel: \{ type: String, default: null, enum: \[null, 'appsumo', 'direct-ltd'\], index: true \}/);
});

test('the webhook handles the one-time direct session before the subscription branches', () => {
  const branch = appSource.indexOf('payload.metadata?.checkoutType === directLtd.CHECKOUT_TYPE');
  const china = appSource.indexOf("payload.metadata?.checkoutType === 'china_annual_pass'");
  assert.ok(branch > 0, 'direct LTD webhook branch is present');
  assert.ok(branch < china, 'direct LTD branch precedes the other one-time branch');
  assert.match(appSource, /handleDirectLtdPaid\(user, payload, event\)/);
});

test('the direct purchase reuses the existing grant and license collection, not a copy', () => {
  assert.match(appSource, /await AppSumoLicense\.create\(\{[\s\S]*?licenseKey,/);
  assert.match(appSource, /await grantAppSumoProAccess\(user, \{[\s\S]*?channel: directLtd\.CHANNEL/);
});

test('a direct buyer is never sent the AppSumo review request', () => {
  assert.match(appSource, /if \(!isDirect\) \{\s*\n\s*scheduleAppSumoReviewRequest/);
});

test('the grant defaults to the appsumo channel so existing callers are unchanged', () => {
  assert.match(appSource, /channel = 'appsumo'/);
});

test('checkout refuses to sell on a price-floor violation instead of degrading', () => {
  assert.match(appSource, /error instanceof directLtd\.PriceFloorViolation/);
  assert.match(appSource, /LIFETIME_UNAVAILABLE/);
});

test('the direct checkout session is one-time, never a subscription', () => {
  const start = appSource.indexOf('async function createDirectLtdCheckoutSession');
  const body = appSource.slice(start, start + 3000);
  assert.match(body, /mode: 'payment'/);
  assert.equal(body.includes("mode: 'subscription'"), false);
});

test('lifetime entitlements do not stack across channels', () => {
  const start = appSource.indexOf('async function createDirectLtdCheckoutSession');
  const body = appSource.slice(start, start + 3000);
  assert.match(body, /user\.appsumoRedeemedAt \|\| user\.dealMirrorRedeemedAt/);
});

test('the paid handler is idempotent on the Stripe session id', () => {
  assert.match(appSource, /AppSumoLicense\.findOne\(\{ 'raw\.stripeSessionId': payload\.id \}\)/);
});

test('/lifetime and its public config route are registered', () => {
  assert.match(appSource, /app\.get\('\/lifetime'/);
  assert.match(appSource, /app\.get\('\/api\/lifetime\/config'/);
  assert.match(appSource, /app\.post\('\/api\/checkout\/lifetime'/);
});

// ---- landing page ----------------------------------------------------------
const page = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'lifetime.html'), 'utf8');

test('the /lifetime page states all three prices', () => {
  for (const price of ['39.99', '79.99', '149.99']) {
    assert.ok(page.includes(price), `page mentions $${price}`);
  }
});

test('the /lifetime page renders prices from the server, not hard-coded copy', () => {
  assert.match(page, /fetch\('\/api\/lifetime\/config'/);
  assert.match(page, /t\.priceDisplay/);
});

test('the /lifetime page never disparages AppSumo and points buyers there on price', () => {
  // Word-boundary matched: a bare substring check flags "description" for
  // containing "rip".
  const forbidden = [
    /\bmiddlemen?\b/i, /\bno marketplace fees\b/i, /\brip[- ]?off\b/i, /\bscam\b/i,
    /\bgreedy\b/i, /\btakes? a cut\b/i, /\bavoid appsumo\b/i, /\bbetter than appsumo\b/i,
    /\bworse\b/i, /\bunlike appsumo\b/i, /\bcheaper than appsumo\b/i
  ];
  for (const pattern of forbidden) {
    assert.equal(pattern.test(page), false, `page must not match ${pattern}`);
  }
  // Neutral, factual, and honest that AppSumo is the cheaper route.
  assert.match(page, /buy it on AppSumo/);
  assert.match(page, /lowest price this deal is offered at anywhere/);
});

test('the /lifetime page states the real per-tier gap instead of pushing buyers out', () => {
  // The old copy read "priced from $39" directly beneath a $149.99 card, which
  // invites the reader to infer a ~$110 saving over a gap that is 99 cents.
  assert.equal(/priced from \$\d/.test(page), false, 'gap must not be hard-coded copy');
  assert.equal(/\$39\b(?![.]99)/.test(page.replace(/"[^"]*"/g, '')), false, 'no bare AppSumo price in body copy');

  // It comes from the same server payload as the prices themselves, so an
  // APPSUMO_TIER*_PRICE_USD override cannot leave the page misstating the gap.
  assert.match(page, /id="lt-gap"/);
  assert.match(page, /function renderAppsumoGap/);
  assert.match(page, /t\.appsumoPriceUsd/);
  assert.match(page, /renderAppsumoGap\(tiers\)/);

  // Disclosure stays; the instruction to leave does not.
  assert.equal(/buy it on AppSumo<\/a> instead/.test(page), false);
  assert.equal(/if price is the deciding factor/i.test(page), false);
});
