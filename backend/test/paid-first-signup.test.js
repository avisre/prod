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
  // 2026-08-31 Jobs cut: Pro-monthly and Power are retired from new sales —
  // they are absent from CHECKOUT_STRIPE_PRICE_SPECS but resolve through
  // LEGACY_PLAN_PRICE_SPECS for grandfathered subscribers.
  assert.match(appSource, /productName: 'desk — stockportfolio\.pro'/);
  assert.doesNotMatch(appSource, /productName: 'power — stockportfolio\.pro', \}\s*\n\s*\}/);
  assert.match(appSource, /price\?\.recurring\?\.interval === spec\.interval/);
});

test('retired rungs keep legacy pricing but cannot be freshly purchased', () => {
  // The Pro-monthly and Power rungs stay resolvable for legacy subscribers
  // (LEGACY_PLAN_PRICE_SPECS at the old amounts) but are unsellable: they are
  // absent from the new-sale checkout spec map entirely.
  assert.match(appSource, /LEGACY_PLAN_PRICE_SPECS/);
  assert.doesNotMatch(appSource, /\[PRO_ANNUAL_PLAN_ID\]: \{ amount: 799\.99/);
  assert.doesNotMatch(appSource, /\[POWER_PLAN_ID\]: \{ amount: 1499\.99/);
  assert.match(appSource, /LEGACY_STRIPE_PRICE_ID_POWER_MONTHLY/);
});

test('the four-rung menu prices hold across homepage, register, upgrade, dossier and terms', () => {
  assert.match(registerSource, /amount: '\$24\.99', cadence: 'per month'/);
  assert.match(registerSource, /amount: '\$199\.99', cadence: 'per year'/);
  assert.match(registerSource, /'pro-annual': \{\s*\n\s*name: 'Pro', amount: '\$499\.99', cadence: 'per year'/);
  assert.match(registerSource, /\$1,999\.99', cadence: 'per year'/);
  assert.doesNotMatch(registerSource, /amount: '\$39\.99'/);
  assert.match(homepageSource, /\$24\.99<span>\/month<\/span>/);
  assert.match(homepageSource, /\$199\.99<span>\/year<\/span>/);
  assert.match(homepageSource, /\$499\.99<span>\/year<\/span>/);
  assert.match(homepageSource, /\$1,999\.99<span>\/year<\/span>/);
  assert.match(homepageSource, /register\.html\?plan=pro-annual/);
  assert.doesNotMatch(homepageSource, /register\.html\?plan=power-monthly/);
  assert.match(dossierSource, /plan=pro-annual"\>Start Pro checkout/);
  assert.match(dossierSource, /plan=desk"\>\$1,999\.99\/yr/);
  assert.match(termsSource, /\$24\.99\/month \(Monthly\), \$199\.99\/year \(Annual\), \$499\.99\/year \(Pro/);
  assert.match(termsSource, /\$1,999\.99\/year \(Desk\)/);
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
  assert.match(registerSource, /Continue to secure checkout/);
  assert.match(registerSource, /refund within 7 days/);
  assert.doesNotMatch(registerSource, /no card required/);
  assert.match(socialSource, /data\.subscription && data\.subscription\.isActive/);
  assert.match(termsSource, /initial payment is refundable within 7 days/);
  assert.match(registerSource, /amount: '\$24\.99', cadence: 'per month'[\s\S]{0,160}Charged today through Stripe/);
  assert.doesNotMatch(termsSource, /7-day free trial \(no card required\)/);
});

// --- account creation is gated on the payment, not on the form submit -------
// The failure this locks out: a Google sign-in (or an abandoned card form)
// created a live User, sent the welcome + "New signup" owner email, and took
// the email address — with nothing in Stripe. See
// scripts/verify-paid-first-signup.js for the end-to-end proof.
test('a self-serve registration creates no account until Stripe reports the payment', () => {
  // The holding pen exists and expires itself, so an abandoned checkout
  // leaves no row and never squats the email address.
  assert.match(appSource, /const PendingSignup = mongoose\.model\('PendingSignup', PendingSignupSchema\)/);
  assert.match(appSource, /PENDING_SIGNUP_TTL_MS/);
  assert.match(appSource, /expiresAt: \{ type: Date, default: \(\) => new Date\(Date\.now\(\) \+ PENDING_SIGNUP_TTL_MS\), expires: 0 \}/);

  // Both signup routes hold the identity instead of writing a User.
  assert.match(appSource, /if \(paymentRequired\) \{\s*\n\s*const pending = await createPendingSignup\(\{/);
  assert.match(appSource, /findOrCreateSocialUser\(profile, \{ createIfMissing: !paymentRequired \}\)/);
  assert.match(appSource, /if \(!createIfMissing\) return \{ user: null, created: false \}/);

  // The checkout is keyed to the pending row, never to a userId that does
  // not exist yet.
  assert.match(appSource, /pendingSignupId: pendingSignup\._id\.toString\(\)/);
  assert.match(appSource, /client_reference_id: subjectRef/);
});

test('the payment is the only thing that can create the account', () => {
  // materializePendingSignup() is the single birth site and refuses outright
  // on anything other than a paid Stripe session.
  assert.match(appSource, /async function materializePendingSignup\(pendingSignupId, session = \{\}\) \{/);
  assert.match(appSource, /if \(String\(session\.payment_status \|\| ''\) !== 'paid'\) \{/);
  // Idempotent across webhook redelivery and the browser's claim call.
  assert.match(appSource, /if \(pending\.userId\) \{\s*\n\s*const already = await User\.findById\(pending\.userId\);/);
  assert.match(appSource, /if \(error && error\.code === 11000\) \{/);
  // The owner notification and welcome email now describe a paying customer.
  assert.match(appSource, /if \(created\) \{[\s\S]{0,600}sendNewUserEmails\(\{/);
  // The webhook materialises before it does anything else with the session.
  assert.match(appSource, /const pendingSignupId = payload\.metadata\?\.pendingSignupId \|\| null;/);
});

test('the buyer is signed in by claiming the paid checkout, not by pre-issuing a token', () => {
  assert.match(appSource, /app\.post\('\/api\/checkout\/claim', checkoutClaimLimiter/);
  assert.match(appSource, /if \(session\.payment_status !== 'paid'\) \{/);
  // Pending-signup only: a leaked session id can never mint a session for a
  // pre-existing account, and a used one cannot be replayed.
  assert.match(appSource, /if \(!pendingSignupId\) \{\s*\n\s*return res\.status\(404\)/);
  assert.match(appSource, /if \(pending && pending\.claimedAt\) \{/);
  assert.match(appSource, /withCheckoutSessionIdParam/);
  // Social sign-in hands back a checkout, not a session.
  assert.match(appSource, /checkoutRequired: true,\s*\n\s*pendingSignup: true/);
  assert.match(socialSource, /\/checkout\/claim/);
  assert.match(registerSource, /\/checkout\/claim/);
});

// --- AppSumo redemption must never be routed into Stripe ------------------
// The buyer already paid AppSumo. If the paid-first policy reaches this path,
// a lifetime customer is charged a second time for what they own for life.
test('an AppSumo redemption is exempt from paid-first checkout on both signup routes', () => {
  // Social sign-in reads the same signed activation token /api/subscribe uses.
  assert.match(appSource, /const appsumoActivationSignup = isAppSumoActivationSignup\(req\);\s*\n\s*const paymentRequired = initialPaymentRequiredForSignup\(planConfig\.planId, appsumoActivationSignup\);/);
  assert.match(appSource, /if \(REQUIRE_INITIAL_STRIPE_PAYMENT && !appsumoActivationSignup && planConfig\.planId === FREE_PLAN_ID\)/);
  // And returns a real session before any Stripe branch can be reached.
  assert.match(appSource, /if \(appsumoActivationSignup\) \{[\s\S]{0,400}appsumoActivation: true/);
});

test('the AppSumo redeem page opens on signup and offers one-click Google', () => {
  // Almost everyone arriving from AppSumo's Redeem button has no account yet,
  // so login-by-default was the most likely cause of a stalled redemption.
  assert.match(appSource, /var mode = 'signup';/);
  assert.match(appSource, /<button id="go">Create account &amp; activate<\/button>/);
  assert.match(appSource, /<button id="alt" class="alt">I already have an account<\/button>/);
  // One click, no typing: Google verifies the email, then the existing
  // activation call attaches the licence.
  assert.match(appSource, /accounts\.google\.com\/gsi\/client/);
  assert.match(appSource, /provider:'google', flow:'register', plan:'pro', credential: response\.credential, appsumoRedeemToken: DATA\.rt/);
  // The password rules are stated up front rather than on rejection.
  assert.match(appSource, /At least 8 characters, with one capital letter, one lowercase letter and one number\./);
  // Stepping away mid-activation should not send the buyer back to AppSumo.
  assert.match(appSource, /asRedeem: true \}, JWT_SECRET, \{ expiresIn: '60m' \}\)/);
});
