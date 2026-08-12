'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const dm = require('../dealmirror');
const env = { DEALMIRROR_INITIAL_CAP: '50', DEALMIRROR_ABSOLUTE_CAP: '100', DEALMIRROR_REDEMPTION_DAYS: '60', DEALMIRROR_CODE_PEPPER: 'x'.repeat(32) };
test('DealMirror config is fail-closed and absolute cap is not overrideable', () => {
  assert.equal(dm.validConfig(env), true); assert.equal(dm.config({ ...env, DEALMIRROR_ABSOLUTE_CAP: '101' }).absoluteCap, 100); assert.equal(dm.validConfig({ ...env, DEALMIRROR_INITIAL_CAP: '51' }), false);
});
test('batch allocation is exactly 20/20/10 and cap is 100', () => {
  assert.deepEqual(dm.INITIAL_ALLOCATION, { starter: 20, investor: 20, pro: 10 }); assert.equal(Object.values(dm.INITIAL_ALLOCATION).reduce((a, b) => a + b, 0), 50); assert.equal(dm.ABSOLUTE_CAP, 100); assert.equal(dm.sameAllocation({ starter: 20, investor: 20, pro: 11 }), false);
});
test('codes are normalized and keyed hashes do not retain plaintext', () => {
  const code = 'spp-dm1-ABcd_12 34'; const hash = dm.codeHash(code, env.DEALMIRROR_CODE_PEPPER); assert.equal(dm.normalizeCode(code), 'SPPDM1ABCD1234'); assert.match(hash, /^[a-f0-9]{64}$/); assert.equal(hash.includes('ABCD'), false); assert.equal(dm.maskedSuffix(code), 'ABCD1234'.slice(-6));
});
test('tier mapping matches fixed monthly Ask allowances', () => {
  assert.deepEqual(Object.fromEntries(Object.entries(dm.TIERS).map(([k, v]) => [k, v.askCap])), { starter: 30, investor: 100, pro: 300 });
});
test('second batch requires every recorded decision gate', () => {
  assert.equal(dm.validSecondBatchApproval({}), false);
  const approval = Object.fromEntries(dm.SECOND_BATCH_GATES.map((key) => [key, true]));
  assert.equal(dm.validSecondBatchApproval(approval), true);
  assert.equal(dm.validSecondBatchApproval({ ...approval, refundRateBelow10: false }), false);
});
test('licence schema contains a partial unique active-user index', () => {
  const { DealMirrorLicence } = dm.models();
  const index = DealMirrorLicence.schema.indexes().find(([fields, options]) => fields.userId === 1 && options.unique && options.partialFilterExpression);
  assert.ok(index, 'active DealMirror licences must be unique per user');
});
