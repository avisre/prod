'use strict';
// The AppSumo activation email must inventory what the redeemed tier opens.
// A real buyer ran the product for two months without discovering the Filing
// Change Monitor he had already paid for — the activation email named no
// surfaces at all. These guards keep the inventory present, tier-capped via
// LTD_MONITOR_CAP, and absent from non-AppSumo lifecycle mail.
const test = require('node:test'); const assert = require('node:assert/strict');
const { customerLifecycleEmail } = require('../mailer');

const APPSUMO = { name: 'Zen Ng', type: 'appsumo_redeemed', plan: 'Pro — AppSumo (Starter)', tier: 1, appUrl: 'https://www.stockportfolio.pro' };

test('AppSumo activation names the report surfaces and the tier Monitor cap', () => {
  const mail = customerLifecycleEmail(APPSUMO);
  assert.match(mail.subject, /AppSumo access is active/);
  for (const part of [mail.html, mail.text]) {
    assert.match(part, /Your plan includes/);
    assert.match(part, /Research Dossiers/);
    assert.match(part, /Filing Change Monitor/);
    assert.match(part, /up to 12 companies/); // mirrors LTD_MONITOR_CAP[1]
    assert.match(part, /plain.English/i);
  }
});

test('tier 2 inventories its own cap; unknown/unset tier resolves UP to unlimited', () => {
  assert.match(customerLifecycleEmail({ ...APPSUMO, tier: 2 }).html, /up to 40 companies/);
  const unlimited = customerLifecycleEmail({ ...APPSUMO, tier: null }).html;
  assert.match(unlimited, /unlimited companies/);
  assert.doesNotMatch(unlimited, /up to 12/);
});

test('the Monitor cap in the email follows the buyer cohort, not a hardcoded ladder', () => {
  // This line used to restate 12/40/unlimited by hand. Once the v2 caps are
  // live that would email "unlimited companies" to a buyer capped at 8 — a
  // written promise, sent automatically, on the day they paid. The cap is now
  // resolved from lib/tier-limits.js, so the two cohorts must read differently.
  // process.env is mutated and restored here because customerLifecycleEmail
  // reads the cutover from it; same pattern as ltd-monitor-entitlement.test.js.
  const prior = process.env.MONITOR_CAP_V2_EFFECTIVE_FROM;
  try {
    const cutover = '2026-09-10T00:00:00.000Z';
    process.env.MONITOR_CAP_V2_EFFECTIVE_FROM = cutover;
    const ms = Date.parse(cutover);
    const grandfathered = customerLifecycleEmail({ ...APPSUMO, tier: 3, redeemedAt: new Date(ms - 86400000) }).html;
    const newBuyer = customerLifecycleEmail({ ...APPSUMO, tier: 3, redeemedAt: new Date(ms + 86400000) }).html;

    assert.match(grandfathered, /unlimited companies/);
    assert.match(newBuyer, /up to 8 companies/);
    // The failure that matters: the new buyer must NOT be promised unlimited.
    assert.doesNotMatch(newBuyer, /unlimited companies/);

    // Tier 1 post-cutover reads singular, not "up to 1 companies".
    const tier1 = customerLifecycleEmail({ ...APPSUMO, tier: 1, redeemedAt: new Date(ms + 86400000) }).html;
    assert.match(tier1, /up to 1 company\b/);
  } finally {
    if (prior === undefined) delete process.env.MONITOR_CAP_V2_EFFECTIVE_FROM;
    else process.env.MONITOR_CAP_V2_EFFECTIVE_FROM = prior;
  }
});

test('Stripe lifecycle mail stays as it was — no inventory block, no Monitor promise', () => {
  const mail = customerLifecycleEmail({ name: 'Priya', type: 'stripe_paid', plan: 'Pro', appUrl: 'https://www.stockportfolio.pro' });
  assert.match(mail.subject, /subscription is active/);
  assert.doesNotMatch(mail.html, /Your plan includes/);
  assert.doesNotMatch(mail.text, /Filing Change Monitor/);
  assert.match(mail.html, /Open your dashboard/);
});