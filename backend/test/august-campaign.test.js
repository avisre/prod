'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const campaign = require('../august-campaign');

test('August campaign does not invent a deadline', () => {
  const old = process.env.APPSUMO_DEAL_END_AT;
  delete process.env.APPSUMO_DEAL_END_AT;
  const cfg = campaign.config(new Date('2026-08-09T00:00:00Z'));
  assert.equal(cfg.configured, false);
  assert.equal(cfg.expiration, null);
  assert.equal(cfg.deadlineLabel, 'Lifetime deal available now');
  assert.equal(cfg.salesVideoUrl, 'https://www.stockportfolio.pro/assets/appsumo-sales-demo.mp4');
  assert.equal(cfg.onboardingVideoUrl, 'https://www.stockportfolio.pro/assets/appsumo-onboarding.mp4');
  if (old === undefined) delete process.env.APPSUMO_DEAL_END_AT;
  else process.env.APPSUMO_DEAL_END_AT = old;
});

test('configured deadline has bounded urgency and tracked AppSumo path', () => {
  const old = process.env.APPSUMO_DEAL_END_AT;
  process.env.APPSUMO_DEAL_END_AT = '2026-08-12T00:00:00Z';
  const cfg = campaign.config(new Date('2026-08-10T00:00:00Z'));
  assert.equal(cfg.configured, true);
  assert.equal(cfg.urgency, '72-hours');
  assert.match(campaign.appsumoPath({ source: 'x', contentId: 'tool-dilution' }), /^\/go\/appsumo\/x\?content_id=tool-dilution$/);
  if (old === undefined) delete process.env.APPSUMO_DEAL_END_AT;
  else process.env.APPSUMO_DEAL_END_AT = old;
});
