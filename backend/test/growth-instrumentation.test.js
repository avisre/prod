'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'app.js'), 'utf8');
const registerHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'register.html'), 'utf8');
const freeToolsSource = fs.readFileSync(path.join(__dirname, '..', 'free-tools.js'), 'utf8');
const appsumoHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'appsumo.html'), 'utf8');

test('growth funnel events use the existing funnel_events collection with new queryable fields', () => {
  assert.match(appSource, /collection: 'funnel_events'/);
  assert.match(appSource, /const FunnelEventSchema = new mongoose\.Schema/);
  assert.match(appSource, /eventType: \{ type: String, required: true, index: true \}/);
  assert.match(appSource, /sessionId: \{ type: String, default: null, index: true \}/);
  assert.match(appSource, /utm: \{/);
  assert.match(appSource, /meta: \{ type: mongoose\.Schema\.Types\.Mixed/);
});

test('CSP allows consented Clarity and Google sign-in assets', () => {
  assert.match(appSource, /https:\/\/scripts\.clarity\.ms/);
  assert.match(appSource, /styleSrc: \[\"'self'\", \"'unsafe-inline'\", 'https:\/\/fonts\.googleapis\.com', 'https:\/\/accounts\.google\.com'\]/);
});

test('funnel logging is fire-and-forget and failures cannot affect request handlers', () => {
  assert.match(appSource, /async function logFunnelEvent\(event, userId, plan, extra\)/);
  assert.match(appSource, /catch \(_\) \{ \/\* non-blocking/);
  assert.match(appSource, /function trackFunnel\(event, userId, plan, extra\) \{\s*return logFunnelEvent/);
  assert.match(appSource, /eventTypeFor\(event, data\)/);
});

test('UTM params are captured for 30 days and sent through signup and beacons', () => {
  assert.match(appJs, /const UTM_COOKIE = 'sp_utm'/);
  assert.match(appJs, /Max-Age=' \+ \(30 \* 24 \* 60 \* 60\)/);
  assert.match(appJs, /function getStoredUtm\(\)/);
  assert.match(appJs, /path: location\.pathname, referrer: document\.referrer, utm: getStoredUtm\(\)/);
  assert.match(registerHtml, /utm: V2\.getStoredUtm \? V2\.getStoredUtm\(\) : null/);
  assert.match(appSource, /signupUtm:/);
  assert.match(appSource, /const utm = requestUtm\(req\)/);
});

test('CTA and free-tool instrumentation are standardized', () => {
  assert.match(appSource, /app\.post\('\/api\/track\/cta_click'/);
  assert.match(appSource, /appsumo_outbound'\) return 'appsumo_click'/);
  assert.match(appSource, /tool_view/);
  assert.match(appSource, /tool_complete/);
  assert.match(freeToolsSource, /utm_source=website&utm_medium=free_tool&utm_campaign=engineering-tools/);
  assert.match(freeToolsSource, /data-content-id=/);
  assert.match(appJs, /\/api\/track\/cta_click/);
});

test('trial starts trigger one internal support notification without changing payment logic', () => {
  assert.match(appSource, /trialInternalNotifiedAt/);
  assert.match(appSource, /async function notifyTrialStartedInternal/);
  assert.match(appSource, /New trial started/);
  assert.match(appSource, /TRIAL_NOTIFY_EMAIL \|\| process\.env\.SUPPORT_INBOX_EMAIL \|\| 'support@stockportfolio\.pro'/);
  assert.match(appSource, /notifyTrialStartedInternal\(user,/);
});

test('AppSumo redemption schedules one five-day review email record', () => {
  assert.match(appSource, /const ScheduledEmailSchema = new mongoose\.Schema/);
  assert.match(appSource, /collection: 'scheduled_emails'/);
  assert.match(appSource, /template: 'appsumo_review_5d'/);
  assert.match(appSource, /5 \* 86400000/);
  assert.match(appSource, /scheduleAppSumoReviewRequest\(user, \{ licenseKey, tier \}\)/);
  const runner = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'run-scheduled-emails.js'), 'utf8');
  assert.match(runner, /appsumo_review_5d/);
  assert.match(runner, /appsumoReviewStage >= 2/);
  assert.match(runner, /appsumoReviewEmail\(user\.name, appUrl, 2/);
});

test('August growth reporting exposes aggregate lifecycle email observability only', () => {
  assert.match(appSource, /emailObservability:/);
  assert.match(appSource, /duplicatePreventedEmails/);
  assert.match(appSource, /deliveryConfirmed: false/);
  assert.doesNotMatch(appSource, /emailObservability:[\s\S]{0,500}user\.email/);
});

test('AppSumo landing has current common-question answers', () => {
  assert.match(appsumoHtml, /id="common-questions"/);
  assert.match(appsumoHtml, /Can I use the product for ETFs and mutual funds/);
  assert.doesNotMatch(appsumoHtml, /Placeholder objection/);
});

test('growth reporting scripts exist and are read-only where required', () => {
  const reconcile = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'reconcile-customers.js'), 'utf8');
  const exportMetrics = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'export-funnel-metrics.js'), 'utf8');
  assert.match(reconcile, /stripe\.subscriptions\.list/);
  assert.match(reconcile, /payingCustomers/);
  assert.doesNotMatch(reconcile, /updateOne|insertOne|deleteOne|deleteMany/);
  assert.match(exportMetrics, /marketing\/appsumo-30-day\/metrics\.csv/);
  assert.match(exportMetrics, /--since=YYYY-MM-DD/);
  assert.match(exportMetrics, /eventType/);
  assert.match(exportMetrics, /raw === 'paid'/);
  assert.match(exportMetrics, /sourceFor\(event\) === 'appsumo'/);
  assert.match(exportMetrics, /countedConversions/);
});
