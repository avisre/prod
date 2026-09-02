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

test('mailer refuses personal SMTP credentials even when a password is present', () => {
  const previous = {
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
  };
  process.env.SMTP_HOST = 'smtp.gmail.com';
  process.env.SMTP_USER = 'avinashsreekumar007@gmail.com';
  process.env.SMTP_PASS = 'test-only';
  try {
    assert.equal(mailer.isMailerConfigured(), false);
    assert.equal(mailer.smtpStatus().userIsSupport, false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('mailer accepts only the support mailbox as its SMTP identity', () => {
  const previous = {
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
  };
  process.env.SMTP_HOST = 'mail.privateemail.com';
  process.env.SMTP_USER = 'support@stockportfolio.pro';
  process.env.SMTP_PASS = 'test-only';
  try {
    assert.equal(mailer.isMailerConfigured(), true);
    assert.equal(mailer.smtpStatus().userIsSupport, true);
    assert.equal(mailer.smtpStatus().from, 'StockPortfolio.pro Support <support@stockportfolio.pro>');
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('MongoDB customer events are unique and cover signup, Stripe, and AppSumo', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(source, /collection: 'customer_lifecycle_events'/);
  assert.match(source, /eventKey: \{ type: String, required: true, unique: true/);
  assert.match(source, /recordCustomerLifecycleEvent\(user, 'signup'/);
  assert.match(source, /recordCustomerLifecycleEvent\(user, 'stripe_paid'/);
  // The lifetime grant is shared by the AppSumo and direct-LTD channels, so
  // the event type is selected per channel. Both values must still be emitted
  // from that one call site, and they must stay distinct so revenue reporting
  // never sums the two channels.
  assert.match(source, /recordCustomerLifecycleEvent\(user, isDirect \? 'direct_ltd_redeemed' : 'appsumo_redeemed'/);
});

test('funnel events preserve signed campaign attribution from visit through conversion', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  assert.match(source, /function acquisitionFunnelFields\(acquisition\)/);
  assert.match(source, /trackFunnel\('signup', user\._id, planConfig\.planName, \{[\s\S]*\.\.\.acquisitionFunnelFields\(acquisition\)/);
  assert.match(source, /app\.post\('\/api\/track\/page_view',[\s\S]*parseAcquisitionCookieHeader/);
  assert.match(source, /function acquisitionStripeMetadata\(acquisition\)/);
  assert.match(source, /payload\.metadata\?\.acquisitionSource/);
  assert.match(source, /app\.get\('\/api\/free-tools\/:tool'/);
  assert.match(source, /free_tool_view/);
  assert.match(source, /free_tool_complete/);
  assert.match(source, /contentId: acquisition \? acquisition\.contentId/);
  assert.match(source, /stockportfolio-marketing-tools\.csv/);
  assert.match(source, /researchRows/);
  assert.match(source, /Organic research hubs/);
});

test('engineering-as-marketing routes remain public and are included in the sitemap', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const seoSource = fs.readFileSync(path.join(__dirname, '..', 'seo-pages.js'), 'utf8');
  assert.match(source, /definition\.path/);
  assert.match(source, /renderToolPage/);
  assert.match(source, /freeToolLimiter/);
  assert.match(seoSource, /\/tools\/earnings-quality/);
  assert.match(seoSource, /\/tools\/dilution/);
  assert.match(seoSource, /\/tools\/filing-timeline/);
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
  assert.match(html, /assets\/dashboard\.js\?v=20260902-ports2/);
});

test('portfolio value shows a complete-basis inception gain without overstating partial data', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'dashboard.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'dashboard.html'), 'utf8');
  assert.match(html, /id="pf-inception-gain" hidden/);
  assert.match(source, /const hasCompleteCostBasis = rows\.length > 0/);
  assert.match(source, /const costBasis = rows\.reduce/);
  assert.match(source, /since inception/);
  assert.match(source, /inceptionGain\.hidden = true/);
});

test('portfolio chart reconciles missing history and discloses excluded symbols', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'dashboard.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'dashboard.html'), 'utf8');
  assert.match(html, /id="perf-note" hidden/);
  assert.match(source, /function historyGaps\(rows, seriesBySym\)/);
  assert.match(source, /const currentTotal = rows\.reduce/);
  assert.match(source, /latest chart point is reconciled to the current portfolio total/);
  assert.match(source, /Historical prices are unavailable for/);
});
