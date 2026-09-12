'use strict';

// Two payment-path invariants, both of which were violated in production code
// and both of which are invisible in normal use until a real buyer hits them.
//
// A. No checkout entry point may resolve to a RETIRED plan id.
//    pro / power / power-monthly were retired in the 2026-08-31 ladder cut and
//    have no STRIPE_PRICE_ID_* configured, so createCheckoutSessionForUser
//    throws `<plan> Stripe price is not configured` (500). Three separate
//    entry points could still reach that throw:
//      - the email login-resume gate (stored planId, unmapped)
//      - the /api/auth/social login-resume gate (same, missed in the first pass)
//      - POST /api/checkout, which literally DEFAULTED to 'pro'
//
// B. No Stripe webhook branch may report a processing failure as success.
//    Every branch was `catch (err) { console.error(err) }` falling through to
//    200. Stripe never retries an event it was told succeeded, so a transient
//    failure permanently stranded a paid buyer.
//
// The plan-resolution half runs the REAL functions (they are pure — no DB, no
// network), extracted from app.js in a vm. The route/webhook half is pinned at
// the source level, matching this repo's convention for monolith-embedded
// logic (paid-first-signup.test.js, api-access-gating.test.js et al).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const appSource = fs.readFileSync(require.resolve('../app'), 'utf8');

// --- load the real plan-resolution functions ------------------------------
function sliceBetween(start, end, label) {
  const a = appSource.indexOf(start);
  const b = appSource.indexOf(end);
  assert.ok(a > -1 && b > a, `could not locate ${label} in app.js — the extraction anchors need updating`);
  return appSource.slice(a, b);
}

const planCtx = vm.createContext({});
vm.runInContext([
  [...appSource.matchAll(/^const [A-Z_]*PLAN_ID = '[^']*';$/gm)].map((m) => m[0]).join('\n'),
  sliceBetween('const CHECKOUT_STRIPE_PRICE_SPECS', '\n// Grandfathered subscribers', 'CHECKOUT_STRIPE_PRICE_SPECS'),
  sliceBetween('function normalizePlanSelection', '\n// A pending (never-paid) account', 'normalizePlanSelection'),
  sliceBetween('const RETIRED_PLAN_ID_REMAP', '\nfunction getPlanConfig', 'RETIRED_PLAN_ID_REMAP'),
  sliceBetween('function isPublishedStripePlan', '\nasync function resolveStripeCheckoutPlan', 'isPublishedStripePlan')
].join('\n'), planCtx);

const resolve = (plan) => vm.runInContext(`remapRetiredPlanId(normalizePlanSelection(${JSON.stringify(plan)}))`, planCtx);
const sellable = (planId) => vm.runInContext(`isPublishedStripePlan({ planId: ${JSON.stringify(planId)} })`, planCtx);

const RETIRED = ['pro', 'power', 'power-monthly'];

test('every retired plan id resolves to a plan that can actually be sold', () => {
  for (const retired of RETIRED) {
    const resolved = resolve(retired);
    assert.notEqual(resolved, retired, `${retired} must not resolve to itself — it has no configured Stripe price`);
    assert.equal(sellable(resolved), true,
      `${retired} -> ${resolved} must be in CHECKOUT_STRIPE_PRICE_SPECS, or checkout 500s`);
  }
});

test('the retired ids are genuinely unsellable — the bug this guards is real', () => {
  // If this ever fails, the rung was un-retired and the remap should be
  // reconsidered rather than silently redirecting a now-valid plan.
  for (const retired of RETIRED) {
    assert.equal(sellable(retired), false, `${retired} is expected to be retired/unsellable`);
  }
});

test('current plans are never remapped', () => {
  for (const current of ['monthly', 'annual', 'pro-annual', 'desk', 'dev']) {
    assert.equal(resolve(current), current, `${current} must pass through untouched`);
    assert.equal(sellable(current), true);
  }
});

test('POST /api/checkout does not default to a retired plan', () => {
  const start = appSource.indexOf("app.post('/api/checkout'");
  assert.ok(start > -1, '/api/checkout route exists');
  const routeBody = appSource.slice(start, start + 1600);
  assert.doesNotMatch(routeBody, /normalizePlanSelection\(req\.body\?\.plan \|\| 'pro'\)/,
    "defaulting to 'pro' sends every plan-less call into the unconfigured-price 500");
  assert.match(routeBody, /remapRetiredPlanId\(normalizePlanSelection\(req\.body\?\.plan \|\| PRO_ANNUAL_PLAN_ID\)\)/);
  // Prove the default itself is sellable, not just that the text changed.
  assert.equal(sellable(resolve(vm.runInContext('PRO_ANNUAL_PLAN_ID', planCtx))), true);
});

test('both login-resume gates remap the stored plan id before creating checkout', () => {
  // Email login gate.
  assert.match(appSource, /planId: remapRetiredPlanId\(user\.subscription && user\.subscription\.planId\)/,
    'the email login-resume gate must remap');
  // Social login gate — missed in the first pass; a pending social signup on a
  // retired plan could not resume checkout at all.
  assert.match(appSource, /\? remapRetiredPlanId\(user\.subscription\.planId\)/,
    'the /api/auth/social resume gate must remap too');
});

test('every Stripe webhook branch reports a processing failure as a failure', () => {
  const start = appSource.indexOf("app.post('/stripe/webhook'");
  const end = appSource.indexOf("app.get('/appsumo/webhook'");
  assert.ok(start > -1 && end > start, 'located the stripe webhook handler');
  const webhook = appSource.slice(start, end);
  const catches = (webhook.match(/\} catch \(err\) \{/g) || []).length;
  const fiveHundreds = (webhook.match(/return res\.status\(500\)\.send\(\{ received: false \}\)/g) || []).length;
  assert.ok(catches > 0, 'expected branch-level catch blocks');
  assert.equal(fiveHundreds, catches,
    `every branch-level catch must return 500 so Stripe redelivers — found ${catches} catches but ${fiveHundreds} returning 500. ` +
    'A swallowed failure tells Stripe the event was handled and it is never retried.');
});

test('signature failures still return 400, not 500 — that one must NOT retry', () => {
  const start = appSource.indexOf("app.post('/stripe/webhook'");
  const head = appSource.slice(start, start + 1400);
  assert.match(head, /return res\.status\(400\)\.send\('Webhook signature invalid'\)/,
    'an unverifiable signature is not a transient failure; redelivering it would be pointless');
});
