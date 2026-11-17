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
  assert.doesNotMatch(appSource, /trial_period_days/);
  assert.doesNotMatch(appSource, /startNoCardTrial|startSignupTrial|SIGNUP_TRIAL_DAYS/);
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
  // Pro annual is back at $799.99 as of 2026-10-07 (it was cut to $499.99 on 8/31).
  assert.match(appSource, /\[PRO_ANNUAL_PLAN_ID\]: \{ amount: 799\.99/);
  assert.doesNotMatch(appSource, /\[POWER_PLAN_ID\]: \{ amount: 1499\.99/);
  assert.match(appSource, /LEGACY_STRIPE_PRICE_ID_POWER_MONTHLY/);
});

test('the four-rung menu prices hold across homepage, register, upgrade, dossier and terms', () => {
  assert.match(registerSource, /amount: '\$79\.99', cadence: 'per month'/);
  assert.match(registerSource, /amount: '\$649\.99', cadence: 'per year'/);
  assert.match(registerSource, /'pro-annual': \{\s*\n\s*name: 'Pro', amount: '\$799\.99', cadence: 'per year'/);
  assert.match(registerSource, /\$1,999\.99', cadence: 'per year'/);
  assert.doesNotMatch(registerSource, /amount: '\$39\.99'/);
  assert.match(homepageSource, /\$79\.99<span>\/month<\/span>/);
  assert.match(homepageSource, /\$649\.99<span>\/year<\/span>/);
  assert.match(homepageSource, /\$799\.99<span>\/year<\/span>/);
  assert.match(homepageSource, /\$1,999\.99<span>\/year<\/span>/);
  assert.match(homepageSource, /register\?plan=pro-annual/);
  assert.doesNotMatch(homepageSource, /register(?:\.html)?\?plan=power-monthly/);
  assert.match(dossierSource, /plan=pro-annual"\>Start Pro checkout/);
  assert.match(dossierSource, /plan=desk"\>\$1,999\.99\/yr/);
  assert.match(termsSource, /\$79\.99\/month \(Monthly\), \$649\.99\/year \(Annual\), \$799\.99\/year \(Pro/);
  assert.match(termsSource, /\$1,999\.99\/year \(Desk\)/);
});

test('seven-day refund state is recorded and protected by an authenticated route', () => {
  assert.match(appSource, /initialRefundUntil/);
  assert.match(appSource, /recordInitialStripePayment/);
  assert.match(appSource, /app\.post\('\/api\/billing\/refund', authMiddleware/);
  assert.match(appSource, /initialRefundStatus: 'requested'/);
  assert.match(appSource, /stripe\.refunds\.create/);
});

test('every initial refund is the full payment within a fixed 7 days, connector accounts included', () => {
  // Owner decision 2026-11-12: no env value can shorten the window, and no plan
  // deducts credits used.
  assert.match(appSource, /const INITIAL_REFUND_DAYS = 7;/);
  assert.doesNotMatch(appSource, /process\.env\.INITIAL_REFUND_DAYS/);
  assert.doesNotMatch(appSource, /refund-quote|initialRefundDeductsUsage|REFUND_NOTHING_LEFT/);
  const route = appSource.slice(appSource.indexOf("app.post('/api/billing/refund'"), appSource.indexOf("app.post('/api/subscription/cancel'"));
  const create = route.slice(route.indexOf('stripe.refunds.create'), route.indexOf('stripe.refunds.create') + 400);
  assert.doesNotMatch(create, /amount/, 'no partial amount: Stripe refunds the whole charge');
  // Trial accounts and connector signups get the window on their first paid
  // invoice even though neither starts life with paymentRequiredAt.
  assert.match(appSource, /function owesInitialPayment\(user\) \{\s*return Boolean\(user && \(user\.paymentRequiredAt \|\| user\.signupTrialAt \|\| \(user\.mcpTrial && user\.mcpTrial\.grantedAt\)\)\);/);
  assert.match(appSource, /if \(!user \|\| !invoice \|\| !owesInitialPayment\(user\) \|\| user\.initialPaymentAt\) return false;/);
  assert.match(appSource, /if \(!user\.paymentRequiredAt\) user\.paymentRequiredAt = user\.signupTrialAt \|\| user\.mcpTrial\.grantedAt;/);
  assert.equal((appSource.match(/if \(owesInitialPayment\(user\) && !user\.initialPaymentAt && subscription\.latest_invoice\)/g) || []).length, 2, 'checkout claim + webhook');
  assert.match(appSource, /initialSignup: owesInitialPayment\(req\.user\) && !req\.user\.initialPaymentAt/);
});

test('a refund request must carry a reason, which is stored and sent to the owner', () => {
  const route = appSource.slice(appSource.indexOf("app.post('/api/billing/refund'"));
  const claim = route.indexOf('User.findOneAndUpdate');
  const guard = route.indexOf('REFUND_REASON_REQUIRED');
  assert.ok(guard > 0 && guard < claim, 'the reason is validated before the refund is claimed');
  assert.match(route.slice(0, claim), /REFUND_DETAILS_REQUIRED/);
  assert.match(route, /initialRefundReason: reason/);
  assert.match(route, /refundReason: reason/);
  assert.match(route, /refundRequestedOwnerEmail/);
  assert.match(appSource, /initialRefundReason: \{ type: String/);

  const mailer = require('../mailer');
  const mail = mailer.refundRequestedOwnerEmail({
    name: 'Ada', email: 'ada@example.com', plan: 'Monthly', reason: 'Too expensive',
    details: '<b>price</b> went up', amountMinor: 7999, currency: 'usd', paidAt: new Date('2026-10-07T22:05:24Z')
  });
  assert.match(mail.subject, /ada@example\.com — Too expensive/);
  assert.match(mail.text, /Refunded: 79\.99 USD/);
  assert.match(mail.text, /Details: <b>price<\/b> went up/);
  assert.match(mail.html, /&lt;b&gt;price&lt;\/b&gt; went up/);

  const dashboardHtml = fs.readFileSync(require.resolve('../../frontend-v2/dashboard.html'), 'utf8');
  const dashboardJs = fs.readFileSync(require.resolve('../../frontend-v2/assets/dashboard.js'), 'utf8');
  assert.match(dashboardHtml, /id="billing-refund-reason"/);
  assert.match(dashboardJs, /JSON\.stringify\(\{ reason: reason\.value, details: details\.value\.trim\(\) \}\)/);
  assert.doesNotMatch(registerSource, /no questions/);
  // A validation prompt must clear once the customer picks a reason or types.
  assert.match(dashboardJs, /reason\.addEventListener\('change', \(\) => \{[\s\S]{0,260}clearPrompt\(\);/);
  assert.match(dashboardJs, /details\.addEventListener\('input', clearPrompt\)/);
  // The card must be reachable: other pages link to it, and it answers the link.
  assert.match(dashboardHtml, /Refund your first payment/);
  assert.match(dashboardJs, /location\.hash === '#billing-refund'/);
  for (const page of ['support.html', 'terms.html', 'upgrade.html']) {
    assert.match(fs.readFileSync(require.resolve(`../../frontend-v2/${page}`), 'utf8'), /href="\/dashboard\.html#billing-refund"/, page);
  }
});

test('signup surfaces explain the 72-hour trial, its AI limit and the price after it', () => {
  assert.match(registerSource, /72-hour free trial/);
  assert.match(registerSource, /5 standard AI questions/);
  assert.match(registerSource, /No card required at signup/);
  assert.match(registerSource, /\$79\.99/);
  assert.match(registerSource, /full refund within 7 days on every plan/);
  assert.match(socialSource, /data\.subscription && data\.subscription\.isActive/);
  assert.match(termsSource, /72-hour free trial/);
  assert.match(termsSource, /five \(5\) standard AI questions/);
  assert.match(termsSource, /initial subscription payment is refundable in full within 7 days/);
  assert.doesNotMatch(termsSource, /minus the credits/);
  // The signup page must not require Stripe at account creation.
  assert.doesNotMatch(registerSource, /Continue to secure checkout/);
  assert.doesNotMatch(registerSource, /clientSecret/);
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

test('the trial account is created immediately, but product access waits for the email link', () => {
  assert.match(appSource, /const trialSignup = SIGNUP_TRIAL\.enabled/);
  assert.match(appSource, /if \(trialSignup\) \{/);
  assert.match(appSource, /signupTrial\.grant\(user, trialPlan\)/);
  assert.match(appSource, /const verifyUrl = issueEmailVerification\(user, req\)/);
  assert.match(appSource, /verificationRequired: true/);
  assert.match(appSource, /EMAIL_VERIFICATION_REQUIRED/);
  // The paid-first holding pen remains for Filing Watch / AppSumo, but the
  // ordinary self-serve path no longer sends the visitor to Stripe.
  assert.match(appSource, /app\.post\('\/api\/checkout\/claim', checkoutClaimLimiter/);
  assert.match(appSource, /withCheckoutSessionIdParam/);
  assert.match(registerSource, /verificationRequired/);
  assert.doesNotMatch(registerSource, /\/checkout\/claim/);
});

// --- AppSumo redemption must never be routed into Stripe ------------------
// The buyer already paid AppSumo. If the paid-first policy reaches this path,
// a lifetime customer is charged a second time for what they own for life.
test('an AppSumo redemption is exempt from paid-first checkout on both signup routes', () => {
  // Social sign-in reads the same signed activation token /api/subscribe uses.
  assert.match(appSource, /const appsumoActivationSignup = isAppSumoActivationSignup\(req\);\s*\n\s*const trialSignup = SIGNUP_TRIAL\.enabled && !appsumoActivationSignup;\s*\n\s*const paymentRequired = initialPaymentRequiredForSignup\(planConfig\.planId, appsumoActivationSignup\);/);
  // AppSumo accounts still bypass trial/paid-first account creation.
  assert.match(appSource, /if \(appsumoActivationSignup\) \{[\s\S]{0,400}appsumoActivation: true/);
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

test('Monthly lists at $79.99 and $24.99 subscribers are grandfathered', () => {
  assert.match(appSource, /process\.env\.CORE_PLAN_PRICE \|\| '79\.99'/);
  assert.match(appSource, /\[MONTHLY_PLAN_ID\]: \{ amount: 79\.99, currency: 'USD', interval: 'month'/);
  assert.match(appSource, /LEGACY_MONTHLY_2499_PRICE_ID = process\.env\.LEGACY_STRIPE_PRICE_ID_MONTHLY_2499 \|\| ''/);
  assert.match(appSource, /priceId === LEGACY_MONTHLY_2499_PRICE_ID\) \{\s*return \{ \.\.\.getPlanConfig\(MONTHLY_PLAN_ID\), stripePriceId: priceId, price: LEGACY_MONTHLY_2499_PRICE \}/);
  assert.match(registerSource, /name: 'Monthly', amount: '\$79\.99', cadence: 'per month'/);
  assert.match(homepageSource, /"name": "Monthly", "price": "79\.99"/);
  assert.doesNotMatch(registerSource + homepageSource, /24\.99/);
});
