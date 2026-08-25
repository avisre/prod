'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const pricingExperiment = require('../pricing-experiment');

test('off by default', () => {
  assert.equal(pricingExperiment.mode({}), 'off');
});

test('off without an activation timestamp even if mode says ltd_only', () => {
  assert.equal(pricingExperiment.mode({ PRICING_EXPERIMENT_MODE: 'ltd_only' }), 'off');
});

test('on when mode + fresh activation timestamp are both set', () => {
  const env = { PRICING_EXPERIMENT_MODE: 'ltd_only', PRICING_EXPERIMENT_ACTIVATED_AT: new Date().toISOString() };
  assert.equal(pricingExperiment.mode(env), 'ltd_only');
});

test('off once the duration has elapsed', () => {
  const env = {
    PRICING_EXPERIMENT_MODE: 'ltd_only',
    PRICING_EXPERIMENT_ACTIVATED_AT: new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString()
  };
  assert.equal(pricingExperiment.mode(env), 'off');
});

test('checkAndRevertIfExpired flips env back to off and reports true', () => {
  const env = {
    PRICING_EXPERIMENT_MODE: 'ltd_only',
    PRICING_EXPERIMENT_ACTIVATED_AT: new Date(Date.now() - 10000).toISOString(),
    PRICING_EXPERIMENT_DURATION_MS: '5000'
  };
  const reverted = pricingExperiment.checkAndRevertIfExpired(env);
  assert.equal(reverted, true);
  assert.equal(env.PRICING_EXPERIMENT_MODE, 'off');
});

test('checkAndRevertIfExpired is a no-op before expiry', () => {
  const env = {
    PRICING_EXPERIMENT_MODE: 'ltd_only',
    PRICING_EXPERIMENT_ACTIVATED_AT: new Date().toISOString(),
    PRICING_EXPERIMENT_DURATION_MS: '600000'
  };
  const reverted = pricingExperiment.checkAndRevertIfExpired(env);
  assert.equal(reverted, false);
  assert.equal(env.PRICING_EXPERIMENT_MODE, 'ltd_only');
});

test('revertsAt reflects activation + duration only while on', () => {
  const at = new Date();
  const env = { PRICING_EXPERIMENT_MODE: 'ltd_only', PRICING_EXPERIMENT_ACTIVATED_AT: at.toISOString(), PRICING_EXPERIMENT_DURATION_MS: '600000' };
  const expected = new Date(at.getTime() + 600000).toISOString();
  assert.equal(pricingExperiment.revertsAt(env).toISOString(), expected);
  assert.equal(pricingExperiment.revertsAt({}), null);
});
