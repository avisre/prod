'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mailer = require('../mailer');

test('all customer-facing mail is pinned to the support mailbox', () => {
  const previous = process.env.MAIL_FROM;
  process.env.MAIL_FROM = 'Founder Personal <founder@example.com>';
  try {
    const config = mailer.config();
    assert.equal(config.from, 'StockPortfolio.pro Support <support@stockportfolio.pro>');
    assert.equal(config.support, 'support@stockportfolio.pro');
    assert.equal(mailer.SUPPORT_EMAIL, 'support@stockportfolio.pro');
  } finally {
    if (previous == null) delete process.env.MAIL_FROM;
    else process.env.MAIL_FROM = previous;
  }
});

test('MongoDB customer events are unique and cover signup, Stripe, and AppSumo', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(source, /collection: 'customer_lifecycle_events'/);
  assert.match(source, /eventKey: \{ type: String, required: true, unique: true/);
  assert.match(source, /recordCustomerLifecycleEvent\(user, 'signup'/);
  assert.match(source, /recordCustomerLifecycleEvent\(user, 'stripe_paid'/);
  assert.match(source, /recordCustomerLifecycleEvent\(user, 'appsumo_redeemed'/);
});

test('admin customer registry supports filtered JSON and CSV exports', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(source, /app\.get\('\/api\/admin\/customers'/);
  assert.match(source, /x-admin-token/);
  assert.match(source, /stockportfolio-customers-\$\{source\}\.csv/);
  assert.match(source, /customerEmailedAt/);
  assert.match(source, /ownerNotifiedAt/);
});

test('marketing dashboard is restricted to the rin account and not ADMIN_TOKEN', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(source, /function marketingDashboardOnly\(req, res, next\)/);
  assert.match(source, /email !== 'rin@gmail\.com'/);
  assert.match(source, /app\.get\('\/api\/admin\/marketing', authMiddleware, marketingDashboardOnly/);
  assert.match(source, /app\.get\('\/admin\/marketing', authMiddleware, marketingDashboardOnly/);
  const routeStart = source.indexOf("app.get('/api/admin/marketing'");
  const routeEnd = source.indexOf("app.get('/admin/marketing'");
  assert.equal(source.slice(routeStart, routeEnd).includes('ADMIN_TOKEN'), false);
});
