'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { hasScreenerExport } = require('../../lib/tier-limits');

const active = (planId) => ({ planId, status: 'active' });
const ltd = (tier, status = 'active') => ({ appsumoTier: tier, subscription: { planId: 'pro', status } });

test('screener export: Investor and Pro lifetime tiers, never Starter', () => {
    assert.equal(hasScreenerExport(ltd(3)), true, 'Pro lifetime tier');
    assert.equal(hasScreenerExport(ltd(2)), true, 'Investor lifetime tier');
    // Every lifetime buyer is stored with planId 'pro'; a plan-first check
    // would let Starter through. This is the case the rule exists for.
    assert.equal(hasScreenerExport(ltd(1)), false, 'Starter lifetime tier');
    assert.equal(hasScreenerExport({ dealMirrorTier: 2, subscription: active('pro') }), true, 'DealMirror tier 2');
    assert.equal(hasScreenerExport({ dealMirrorTier: 1, subscription: active('pro') }), false, 'DealMirror tier 1');
});

test('screener export: a refunded lifetime buyer loses it', () => {
    assert.equal(hasScreenerExport(ltd(3, 'cancelled')), false);
    assert.equal(hasScreenerExport(ltd(2, 'cancelled')), false);
});

test('screener export: Pro-and-up recurring plans only', () => {
    for (const plan of ['pro', 'pro-annual', 'power', 'power-monthly', 'desk', 'enterprise']) {
        assert.equal(hasScreenerExport({}, active(plan)), true, plan);
    }
    for (const plan of ['free', 'core', 'basic', 'dev']) {
        assert.equal(hasScreenerExport({}, active(plan)), false, plan);
    }
    assert.equal(hasScreenerExport({}, { planId: 'desk', status: 'cancelled' }), false, 'lapsed Desk');
    assert.equal(hasScreenerExport(null, null), false, 'signed out');
});

test('screener export: a Starter lifetime buyer who also pays for Desk keeps it through Desk', () => {
    assert.equal(hasScreenerExport({ appsumoTier: 1, subscription: active('desk') }), true);
});

test('the export route is signed-in and gated, and shares the public screen criteria', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.match(src, /app\.get\('\/api\/screener\/export', authMiddleware, screenerExportGate,/);
    assert.match(src, /tierLimits\.hasScreenerExport\(req\.user, req\.subscription\)/);
    // Both routes build their query from the one mapping, so the file can
    // never hold a different set of companies than the page showed.
    assert.equal((src.match(/aiChat\.screenRows\(screenerCriteria\(/g) || []).length, 2);
});
