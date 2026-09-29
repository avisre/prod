// Local Filing Watch lifecycle integration. Stripe is mocked; this is NOT a Stripe sandbox payment test.
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
const subscriptions = new Map();
let priceValid = true;
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
    retrieve: async id => subscriptions.get(id),
    update: async (id, fields) => Object.assign(subscriptions.get(id), fields)
  },
  invoices: { retrieve: async (id) => ({ id, status: 'paid', status_transitions: { paid_at: Math.floor(Date.now() / 1000) }, payment_intent: 'pi_1', charge: 'ch_1' }) },
  prices: {
    list: async () => ({ data: [] }),
    retrieve: async id => ({ id, active: priceValid, unit_amount: id === 'price_test_filing' ? 4900 : 2499, currency: 'usd', billing_scheme: 'per_unit', recurring: { interval: 'month', interval_count: 1, usage_type: 'licensed' }, product: { name: 'stockportfolio.pro' } })
  },
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
  if (request === 'dotenv') return { config: () => ({}), parse: realLoad(request, parent, isMain).parse };
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
  process.env.PORT = '39119';
  process.env.FILING_WATCH_ENABLED = 'true';
  process.env.ADMIN_TOKEN = 'filing-test-admin';
  process.env.STRIPE_PRICE_ID_FILING_WATCH = 'price_test_filing';
  process.env.LAUNCH_PROMO_COUPON_ID = 'should-not-discount-filing-watch';
  process.env.LAUNCH_PROMO_UNTIL = '2099-12-31';
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
  const assert = require('node:assert/strict');

  const mongoose = realLoad(path.join(BACKEND, 'node_modules/mongoose'), module, false);
  const base = 'http://127.0.0.1:39119';
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  for (let i = 0; i < 60 && mongoose.connection.readyState !== 1; i++) await wait(500);
  await wait(1500);

  const User = mongoose.model('User');
  const PendingSignup = mongoose.model('PendingSignup');
  let checks = 0;
  const check = (name, condition) => { assert.ok(condition, name); checks++; console.log('PASS ' + name); };
  const post = async (route, body, headers = {}) => {
    const response = await fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const admin = { 'x-admin-token': 'filing-test-admin' };
  const webhook = (type, object, id = 'evt_' + Math.random()) => post('/stripe/webhook', { id, type, data: { object } }, { 'stripe-signature': 'stub-local-only' });
  // Verify the price gate before it is warmed in the resolver cache.
  priceValid = false;
  let r = await post('/api/admin/filing-watch/invitations', { email: 'pilot@example.com' }, admin);
  check('wrong or inactive Stripe price refuses invitations', r.status === 503 && r.body.code === 'PRICE_UNVERIFIED');
  priceValid = true;
  r = await post('/api/admin/filing-watch/invitations', { email: 'pilot@example.com' });
  check('invitation administration requires authentication', r.status === 403);
  r = await post('/api/admin/filing-watch/invitations', { email: 'pilot@example.com' }, admin);
  check('verified price allows one personal invitation', r.status === 200 && !!r.body.url);
  const token = new URL(r.body.url).searchParams.get('invite');
  r = await post('/api/subscribe', { email: 'wrong@example.com', password: 'Passw0rdd', plan: 'filing-watch', filingWatchInvite: token });
  check('invitation cannot pay for a different email', r.status === 409);
  r = await post('/api/subscribe', { email: 'pilot@example.com', password: 'Passw0rdd', plan: 'filing-watch', filingWatchInvite: token, next: 'filing-watch/start' });
  check('invited customer reaches embedded checkout', r.status === 200 && !!r.body.clientSecret);
  const pending = await PendingSignup.findOne({ email: 'pilot@example.com' });
  const session = sessions.get(pending.stripeSessionId);
  check('one exact $49 monthly price and no extra software charge', session._params.line_items.length === 1 && session._params.line_items[0].price === 'price_test_filing' && session._params.line_items[0].quantity === 1);
  check('no launch discount, promo-code entry or trial', !session._params.discounts && session._params.allow_promotion_codes === false && !session._params.subscription_data.trial_period_days);
  check('checkout subscription metadata preserves the service plan', session._params.subscription_data.metadata.planId === 'filing-watch');
  check('paid return takes the buyer to ticker onboarding', session._params.return_url.includes('filing-watch%2Fstart'));
  check('unpaid checkout creates no user', await User.countDocuments({ email: 'pilot@example.com' }) === 0);
  const before = sessions.size;
  r = await post('/api/subscribe', { email: 'pilot@example.com', password: 'Different1', plan: 'filing-watch', filingWatchInvite: token });
  check('retry cannot duplicate a charge or change pending password', r.status === 409 && sessions.size === before);
  r = await post('/api/checkout/claim', { sessionId: session.id });
  check('unpaid claim is refused', r.status === 402);
  await webhook('checkout.session.completed', session);
  check('unpaid callback still creates no account', await User.countDocuments({ email: 'pilot@example.com' }) === 0);
  const subscription = { id: 'sub_filing', status: 'active', customer: 'cus_test_1', cancel_at_period_end: false, latest_invoice: 'in_filing_1', trial_end: null, metadata: { planId: 'filing-watch' }, items: { data: [{ price: { id: 'price_test_filing' } }] } };
  subscriptions.set(subscription.id, subscription);
  session.payment_status = 'paid'; session.subscription = subscription.id;
  r = await webhook('checkout.session.completed', session, 'evt_paid');
  check('paid callback is accepted', r.status === 200);
  let user = await User.findOne({ email: 'pilot@example.com' });
  check('payment creates and activates Filing Watch account at $49', user && user.subscription.planId === 'filing-watch' && user.subscription.price === 49 && user.subscription.status === 'active');
  await webhook('checkout.session.completed', session, 'evt_paid');
  check('redelivered callback creates no duplicate customer', await User.countDocuments({ email: 'pilot@example.com' }) === 1);
  r = await post('/api/login', { email: 'pilot@example.com', password: 'Passw0rdd' });
  check('original registration password still signs in', r.status === 200 && !!r.body.token);
  const auth = { Authorization: 'Bearer ' + r.body.token };
  r = await post('/api/filing-watch/tickers', { tickers: ['AAPL','FORM','SHAZ'] }, auth);
  check('paid buyer can submit supported tickers and start 48-hour deadline', r.status === 200 && !!r.body.baselineDueAt);
  const queue = await (await fetch(base + '/api/admin/filing-watch', { headers: admin })).json();
  check('founder queue has payment identity, tickers and deadline', queue.rows[0].stripeSubscriptionId === 'sub_filing' && queue.rows[0].tickers.length === 3 && !!queue.rows[0].baselineDueAt);
  r = await post('/api/admin/filing-watch/invitations', { email: 'pilot@example.com' }, admin);
  check('existing app customers cannot enter new-customer pilot', r.status === 409 && r.body.code === 'EXISTING_CUSTOMER');
  r = await webhook('invoice.paid', { id: 'in_renewal', subscription: subscription.id, customer: subscription.customer, billing_reason: 'subscription_cycle', amount_paid: 4900, currency: 'usd', livemode: false });
  check('renewal callback preserves the $49 service subscription', r.status === 200 && (await User.findById(user._id)).subscription.planId === 'filing-watch');
  subscription.status = 'past_due';
  r = await webhook('invoice.payment_failed', { id: 'in_failed', subscription: subscription.id, customer: subscription.customer, livemode: false });
  check('failed renewal pauses service and paid access', r.status === 200 && (await User.findById(user._id)).subscription.status === 'pending');
  r = await post('/api/filing-watch/tickers', { tickers: ['AAPL','FORM','SHAZ'] }, auth);
  check('unpaid customer cannot request fulfilment', r.status === 403);
  subscription.status = 'active';
  await webhook('invoice.paid', { id: 'in_recovered', subscription: subscription.id, customer: subscription.customer, billing_reason: 'subscription_cycle', amount_paid: 4900, currency: 'usd', livemode: false });
  check('paid recovery restores access', (await User.findById(user._id)).subscription.status === 'active');
  r = await post('/api/subscription/cancel', {}, auth);
  check('existing cancellation route schedules period-end cancellation', r.status === 200 && subscription.cancel_at_period_end === true);
  await webhook('customer.subscription.updated', subscription);
  check('update webhook preserves cancellation state', (await User.findById(user._id)).subscription.status === 'cancel_at_period_end');
  await webhook('customer.subscription.deleted', subscription);
  check('ended subscription removes paid access', (await User.findById(user._id)).subscription.status === 'cancelled');
  r = await post('/api/subscribe', { email: 'standard@example.com', password: 'Passw0rdd', plan: 'monthly' });
  check('standard monthly checkout still works without invitation', r.status === 200 && !!r.body.clientSecret);
  const standard = Array.from(sessions.values()).find(s => s.customer_email === 'standard@example.com');
  check('standard monthly retains its price and launch promotion', standard._params.line_items[0].price === 'price_test_monthly' && !!standard._params.discounts);
  console.log(checks + '/' + checks + ' local integration checks passed. Stripe API was mocked; real sandbox acceptance is separate.');
  await mongoose.disconnect(); await mongod.stop(); process.exit(0);
})().catch(error => { console.error(error.message); process.exit(1); });
