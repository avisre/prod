// End-to-end proof that no account is created before Stripe takes the money.
//
//   node scripts/verify-paid-first-signup.js
//
// Boots the real backend/app.js against an in-memory MongoDB with Stripe, the
// Google token verifier and the Stripe account preflight stubbed out, then
// drives both signup routes through abandon, pay, webhook redelivery and the
// post-checkout claim. Deliberately NOT part of `npm test`: it starts the whole
// server (jobs, watchdog, listeners) and exits the process itself, which does
// not belong in the fast unit run. The invariants it proves are pinned in
// backend/test/paid-first-signup.test.js.
const Module = require('module');
const path = require('path');
const BACKEND = path.join(__dirname, '..', 'backend');
const realLoad = Module._load;

const sessions = new Map();
let sessionSeq = 0;
const stripeStub = {
  checkout: {
    sessions: {
      create: async (params) => {
        const id = `cs_test_${++sessionSeq}`;
        const s = {
          id,
          url: `https://checkout.stripe.com/${id}`,
          client_secret: `${id}_secret`,
          metadata: params.metadata || {},
          client_reference_id: params.client_reference_id,
          customer: 'cus_test_1',
          customer_email: params.customer_email,
          payment_status: 'unpaid',
          subscription: null,
          livemode: false,
          _params: params
        };
        sessions.set(id, s);
        return s;
      },
      retrieve: async (id) => sessions.get(id) || null
    }
  },
  subscriptions: {
    retrieve: async (id) => ({
      id, status: 'active', customer: 'cus_test_1', cancel_at_period_end: false,
      latest_invoice: 'in_test_1', trial_end: null,
      items: { data: [{ price: { id: 'price_test_monthly' } }] },
      metadata: {}
    })
  },
  invoices: { retrieve: async (id) => ({ id, status: 'paid', status_transitions: { paid_at: Math.floor(Date.now() / 1000) }, payment_intent: 'pi_1', charge: 'ch_1' }) },
  prices: { list: async () => ({ data: [] }), retrieve: async () => null },
  webhooks: { constructEvent: (raw) => JSON.parse(raw.toString('utf8')) }
};

const realAxios = realLoad(path.join(BACKEND, 'node_modules/axios'), module, false);
const axiosStub = new Proxy(realAxios, {
  get(target, prop) {
    if (prop === 'get') {
      return async (url, opts) => {
        if (String(url).startsWith('https://api.stripe.com/v1/account')) {
          return { data: { id: process.env.STRIPE_ACCOUNT_ID } };
        }
        return target.get(url, opts);
      };
    }
    return target[prop];
  }
});

Module._load = function (request, parent, isMain) {
  if (request === 'stripe') return Object.assign(() => stripeStub, { default: () => stripeStub });
  if (request === 'axios') return axiosStub;
  if (request === 'google-auth-library') {
    return {
      OAuth2Client: class {
        async verifyIdToken({ idToken }) {
          const p = JSON.parse(Buffer.from(idToken, 'base64').toString('utf8'));
          return { getPayload: () => p };
        }
      }
    };
  }
  return realLoad(request, parent, isMain);
};

(async () => {
  const { MongoMemoryServer } = realLoad(path.join(BACKEND, 'node_modules/mongodb-memory-server'), module, false);
  const mongod = await MongoMemoryServer.create();
  process.env.MONGODB_URI = mongod.getUri('spverify');
  process.env.PORT = '39117';
  process.env.JWT_SECRET = 'test-secret-for-verification';
  process.env.STRIPE_SECRET_KEY = 'sk_test_stub';
  process.env.STRIPE_ACCOUNT_ID = 'acct_1TDj4gAUeKapY1OP';
  process.env.STRIPE_WEBHOOK_SECRET = 'whsec_stub';
  process.env.STRIPE_PRICE_ID_MONTHLY = 'price_test_monthly';
  process.env.STRIPE_PRICE_ID_PRO = 'price_test_pro';
  process.env.REQUIRE_INITIAL_STRIPE_PAYMENT = 'true';
  process.env.GOOGLE_CLIENT_ID = 'test-google-client-id';
  process.env.GOOGLE_ALLOWED_HOSTS = '127.0.0.1,localhost';
  process.env.NODE_ENV = 'test';
  process.env.PREWARM = 'off';

  process.chdir(BACKEND);
  require(path.join(BACKEND, 'app.js'));

  const mongoose = realLoad(path.join(BACKEND, 'node_modules/mongoose'), module, false);
  const base = 'http://127.0.0.1:39117';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60 && mongoose.connection.readyState !== 1; i++) await wait(500);
  await wait(1500);

  const User = mongoose.model('User');
  const PendingSignup = mongoose.model('PendingSignup');
  const results = [];
  const check = (name, cond, detail = '') => {
    results.push({ name, ok: !!cond, detail });
    console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  };

  // ---------- 1. email/password signup creates NO account ----------
  let r = await fetch(`${base}/api/subscribe`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'buyer@example.com', password: 'Passw0rdd', plan: 'monthly' })
  });
  let body = await r.json();
  check('POST /api/subscribe returns embedded clientSecret', r.status === 200 && !!body.clientSecret, `status=${r.status} ${JSON.stringify(body).slice(0,160)}`);
  check('no token/cookie handed out before payment', !body.token && !(r.headers.get('set-cookie') || '').includes('sp_logged_in=1'));
  check('NO User document exists after signup submit', (await User.countDocuments({})) === 0, `users=${await User.countDocuments({})}`);
  check('one PendingSignup row is held instead', (await PendingSignup.countDocuments({})) === 1);

  const pending = await PendingSignup.findOne({ email: 'buyer@example.com' });
  const sessionId = pending.stripeSessionId;
  check('pending row is keyed to the Stripe session', /^cs_test_/.test(sessionId || ''), String(sessionId));
  const sess = sessions.get(sessionId);
  check('checkout metadata carries pendingSignupId, not userId', sess.metadata.pendingSignupId === String(pending._id) && !sess.metadata.userId);
  check('return_url carries the session id template', String(sess._params.return_url).includes('session_id={CHECKOUT_SESSION_ID}'), sess._params.return_url);

  // ---------- 2. abandoning checkout: unpaid webhook creates nothing ----------
  const post = (url, payload, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(payload) });
  const unpaidEvent = { id: 'evt_unpaid', type: 'checkout.session.completed', data: { object: { ...sess, payment_status: 'unpaid' } } };
  r = await post(`${base}/stripe/webhook`, unpaidEvent, { 'stripe-signature': 'x' });
  check('unpaid checkout.session.completed is accepted', r.status === 200, `status=${r.status}`);
  check('unpaid session still creates NO account', (await User.countDocuments({})) === 0, `users=${await User.countDocuments({})}`);

  // ---------- 3. payment lands -> account is created ----------
  sess.payment_status = 'paid';
  sess.subscription = 'sub_test_1';
  const paidEvent = { id: 'evt_paid', type: 'checkout.session.completed', data: { object: sess } };
  r = await post(`${base}/stripe/webhook`, paidEvent, { 'stripe-signature': 'x' });
  check('paid checkout.session.completed is accepted', r.status === 200, `status=${r.status}`);
  await wait(600);
  const created = await User.findOne({ email: 'buyer@example.com' });
  check('account exists only after payment', !!created);
  check('account is active on the paid plan', created && created.subscription.status === 'active', created && created.subscription.status);
  check('refund window opened from the paid invoice', !!(created && created.initialPaymentAt));

  // ---------- 4. webhook redelivery is idempotent ----------
  r = await post(`${base}/stripe/webhook`, paidEvent, { 'stripe-signature': 'x' });
  await wait(400);
  check('redelivered webhook does not create a second account', (await User.countDocuments({ email: 'buyer@example.com' })) === 1, `users=${await User.countDocuments({})}`);

  // ---------- 5. the buyer can log in with the credentials they typed ----------
  r = await post(`${base}/api/login`, { email: 'buyer@example.com', password: 'Passw0rdd' });
  body = await r.json();
  check('buyer can sign in with the password from the register form', r.status === 200 && !!body.token, `status=${r.status}`);

  // ---------- 6. social sign-in: new identity gets checkout, not an account ----------
  const cred = Buffer.from(JSON.stringify({ sub: 'google-uid-1', email: 'social@example.com', name: 'Social Buyer', email_verified: true, aud: 'test-google-client-id' })).toString('base64');
  r = await fetch(`${base}/api/auth/social`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', host: 'localhost' },
    body: JSON.stringify({ provider: 'google', flow: 'register', credential: cred, plan: 'monthly' })
  });
  body = await r.json();
  check('social sign-in returns a checkout URL', r.status === 200 && !!body.url && body.checkoutRequired === true, `status=${r.status} ${JSON.stringify(body).slice(0,200)}`);
  check('social sign-in hands out NO token before payment', !body.token && !(r.headers.get('set-cookie') || '').includes('sp_logged_in=1'));
  check('social sign-in creates NO account', (await User.countDocuments({ email: 'social@example.com' })) === 0);

  // ---------- 7. claim on return creates the account and signs in ----------
  const socialPending = await PendingSignup.findOne({ email: 'social@example.com' });
  const socialSession = sessions.get(socialPending.stripeSessionId);
  r = await post(`${base}/api/checkout/claim`, { sessionId: socialSession.id });
  check('claim refuses an unpaid checkout', r.status === 402, `status=${r.status}`);
  check('refused claim created no account', (await User.countDocuments({ email: 'social@example.com' })) === 0);

  socialSession.payment_status = 'paid';
  socialSession.subscription = 'sub_test_2';
  r = await post(`${base}/api/checkout/claim`, { sessionId: socialSession.id });
  body = await r.json();
  check('claim on a paid checkout returns a session token', r.status === 200 && !!body.token, `status=${r.status} ${JSON.stringify(body).slice(0,200)}`);
  check('claim sets the auth cookie', String(r.headers.get('set-cookie') || '').includes('sp_logged_in=1'));
  const socialUser = await User.findOne({ email: 'social@example.com' });
  check('social account now exists and is active', !!socialUser && socialUser.subscription.status === 'active', socialUser && socialUser.subscription.status);
  check('social account is linked to the Google identity', !!socialUser && socialUser.googleId === 'google-uid-1');

  r = await post(`${base}/api/checkout/claim`, { sessionId: socialSession.id });
  check('a claimed checkout cannot be replayed', r.status === 409, `status=${r.status}`);

  // ---------- 8. returning social user still signs in normally ----------
  r = await fetch(`${base}/api/auth/social`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', host: 'localhost' },
    body: JSON.stringify({ provider: 'google', flow: 'login', credential: cred, plan: 'monthly' })
  });
  body = await r.json();
  check('returning paid social user signs straight in', r.status === 200 && !!body.token && !body.url, `status=${r.status} ${JSON.stringify(body).slice(0,200)}`);

  // ---------- 9. AppSumo redemption must NEVER touch Stripe ----------
  // The buyer already paid AppSumo. If either redemption path creates a
  // checkout session, a lifetime customer gets charged a second time.
  const jwt = realLoad(path.join(BACKEND, 'node_modules/jsonwebtoken'), module, false);
  const mintRt = (key, tier) => jwt.sign(
    { asLicenseKey: key, asTier: tier, asRedeem: true },
    process.env.JWT_SECRET,
    { expiresIn: '60m' }
  );

  // 9a. Google one-click: no typing, no Stripe.
  const sessionsBefore = sessions.size;
  const sumoCred = Buffer.from(JSON.stringify({ sub: 'google-uid-sumo', email: 'sumo.google@example.com', name: 'Sumo Google', email_verified: true, aud: 'test-google-client-id' })).toString('base64');
  r = await post(`${base}/api/auth/social`, {
    provider: 'google', flow: 'register', plan: 'pro',
    credential: sumoCred, appsumoRedeemToken: mintRt('lic-google-1', 3)
  });
  body = await r.json();
  check('AppSumo + Google returns a session, not a checkout', r.status === 200 && !!body.token && !body.url && body.appsumoActivation === true, `status=${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  check('AppSumo + Google creates NO Stripe checkout session', sessions.size === sessionsBefore, `sessions ${sessionsBefore} -> ${sessions.size}`);

  r = await post(`${base}/api/appsumo/activate`, { rt: mintRt('lic-google-1', 3), discoverySource: 'appsumo' }, { Authorization: `Bearer ${body.token}` });
  const act = await r.json();
  check('AppSumo + Google activation succeeds', r.status === 200 && act.ok === true, `status=${r.status} ${JSON.stringify(act).slice(0, 160)}`);
  let sumoUser = await User.findOne({ email: 'sumo.google@example.com' });
  check('Google buyer gets tier 3 lifetime Pro', !!sumoUser && sumoUser.appsumoTier === 3 && sumoUser.appsumoAiCap === 300, sumoUser && `tier=${sumoUser.appsumoTier} cap=${sumoUser.appsumoAiCap}`);
  check('Google buyer subscription is active and never expires', !!sumoUser && sumoUser.subscription.status === 'active' && sumoUser.subscription.trialEndsAt === null && sumoUser.stripeSubscriptionId === null);

  // 9b. Email + password: the non-Google path, also no Stripe.
  const sessionsBefore2 = sessions.size;
  r = await post(`${base}/api/subscribe`, {
    email: 'sumo.pass@example.com', password: 'Passw0rdd', plan: 'pro',
    appsumoRedeemToken: mintRt('lic-pass-1', 2)
  });
  body = await r.json();
  check('AppSumo + password returns a session, not a checkout', r.status === 200 && !!body.token && !body.clientSecret && body.appsumoActivation === true, `status=${r.status} ${JSON.stringify(body).slice(0, 200)}`);
  check('AppSumo + password creates NO Stripe checkout session', sessions.size === sessionsBefore2, `sessions ${sessionsBefore2} -> ${sessions.size}`);
  check('AppSumo + password holds no PendingSignup row', (await PendingSignup.countDocuments({ email: 'sumo.pass@example.com' })) === 0);

  r = await post(`${base}/api/appsumo/activate`, { rt: mintRt('lic-pass-1', 2) }, { Authorization: `Bearer ${body.token}` });
  check('AppSumo + password activation succeeds', r.status === 200, `status=${r.status}`);
  const passUser = await User.findOne({ email: 'sumo.pass@example.com' });
  check('password buyer gets tier 2 lifetime Pro', !!passUser && passUser.appsumoTier === 2 && passUser.subscription.status === 'active', passUser && `tier=${passUser.appsumoTier} status=${passUser.subscription.status}`);

  // 9c. The password rules the page prints are the rules the server enforces.
  r = await post(`${base}/api/subscribe`, {
    email: 'sumo.weak@example.com', password: 'sumo123', plan: 'pro',
    appsumoRedeemToken: mintRt('lic-weak-1', 1)
  });
  body = await r.json();
  check('weak password is rejected with the documented rule', r.status === 400 && body.code === 'PASSWORD_POLICY_FAILED', `status=${r.status} ${JSON.stringify(body).slice(0, 160)}`);
  check('rejected signup created no account', (await User.countDocuments({ email: 'sumo.weak@example.com' })) === 0);

  const failed = results.filter((x) => !x.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('HARNESS ERROR:', e); process.exit(2); });
