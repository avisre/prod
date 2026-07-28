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

test('auth cookies are shared across the apex and www production hosts', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(source, /Domain=\.stockportfolio\.pro/);
  assert.match(source, /authCookieDomain\(req\)/);
  assert.match(source, /setAuthCookie\(res, body\.token, req\)/);
  assert.match(source, /clearAuthCookie\(res, req\)/);
});

test('production trusts the Render proxy hop for per-client rate limits', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(source, /DEFAULT_TRUST_PROXY_HOPS = process\.env\.NODE_ENV === 'production' \? '1' : '0'/);
  assert.match(source, /process\.env\.TRUST_PROXY_HOPS \|\| DEFAULT_TRUST_PROXY_HOPS/);
  assert.match(source, /app\.set\('trust proxy', TRUST_PROXY_HOPS \|\| false\)/);
});

test('login page inline JavaScript parses before it attaches the submit handler', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'login.html'), 'utf8');
  const inlineScripts = [...html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi)]
    .map((match) => match[1].trim())
    .filter(Boolean);
  assert.ok(inlineScripts.length > 0);
  for (const source of inlineScripts) {
    assert.doesNotThrow(() => new Function(source));
  }
});

test('populated portfolios use the grouped holdings renderer', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'dashboard.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'dashboard.html'), 'utf8');
  assert.match(source, /const rows = \(Array\.isArray\(list\) \? list : \[\]\)\.map\(holdingToRow\);\s*renderHoldings\(rows\);/);
  assert.doesNotMatch(source, /\$\('holdings-body'\)/);
  assert.match(html, /assets\/dashboard\.js\?v=20260728-holdings1/);
});
