'use strict';

// MRR paywall move (2026-09): insider activity and guru portfolios shift from
// free to Core, Key Points gets a 5-distinct-stocks-per-month free cap, and a
// flag-gated 3-day no-card Core trial is available at signup. This file
// covers the module-level behaviour (keypoint-free-usage) and asserts the
// route/source wiring stays consistent with what backend/gurus.js and
// backend/insiders.js already expose internally.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { Mongoose } = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');
const usage = require('../keypoint-free-usage');

const appSource = () => fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const companyJsSource = () => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'company.js'), 'utf8');
const gurusHtmlSource = () => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'gurus.html'), 'utf8');

test('free Key Points allowance is durable, atomic, and capped at N distinct stocks/month', { timeout: 120000 }, async (t) => {
    const server = await MongoMemoryServer.create();
    const firstDb = new Mongoose();
    await firstDb.connect(server.getUri());
    t.after(async () => { await firstDb.disconnect().catch(() => {}); await server.stop(); });

    const Model = usage.createModel(firstDb);
    const clientKey = 'ip:' + crypto.createHmac('sha256', 'test-only-salt').update('203.0.113.7').digest('hex');
    const context = { clientKey, monthKey: '2026-09', expiresAt: new Date('2026-11-01T00:00:00Z') };

    assert.equal((await usage.claim(Model, context, 'AAPL', 5)).allowed, true);
    assert.equal((await usage.claim(Model, context, 'MSFT', 5)).allowed, true);
    assert.equal((await usage.claim(Model, context, 'NVDA', 5)).allowed, true);
    assert.equal((await usage.claim(Model, context, 'AMZN', 5)).allowed, true);
    assert.equal((await usage.claim(Model, context, 'GOOG', 5)).allowed, true);

    // A stock already counted this month is free — re-reading never burns
    // the allowance, and no new symbol is added.
    const repeat = await usage.claim(Model, context, 'AAPL', 5);
    assert.equal(repeat.allowed, true);
    assert.equal(repeat.known, true);
    assert.equal(repeat.remaining, 0);

    // The 6th distinct stock this month is refused.
    const sixth = await usage.claim(Model, context, 'TSLA', 5);
    assert.equal(sixth.allowed, false);
    assert.equal(sixth.remaining, 0);

    const stored = await Model.findOne({ clientKey }).lean();
    assert.deepEqual(stored.symbols.sort(), ['AAPL', 'AMZN', 'GOOG', 'MSFT', 'NVDA']);

    // A different month is a fresh allowance — the whole point of a monthly cap.
    const nextMonth = { clientKey, monthKey: '2026-10', expiresAt: new Date('2026-12-01T00:00:00Z') };
    assert.equal((await usage.claim(Model, nextMonth, 'TSLA', 5)).allowed, true);

    // A different client (logged-in user vs anonymous IP hash) gets its own bucket.
    const otherClient = { clientKey: 'u:someUserId', monthKey: '2026-09', expiresAt: context.expiresAt };
    assert.equal((await usage.claim(Model, otherClient, 'TSLA', 5)).allowed, true);
});

test('Key Points route gates the free tier at KEYPOINTS_FREE_STOCKS, bypasses core/pro, and leaves internal consumers untouched', () => {
    const src = appSource();
    assert.match(src, /const KEYPOINTS_FREE_STOCKS = Number\.isFinite\(configuredKeypointsFreeStocks\)/);
    assert.match(src, /req\.tier === 'free' && KEYPOINTS_FREE_STOCKS > 0/);
    assert.match(src, /code: 'KEYPOINTS_QUOTA'/);
    assert.match(src, /keypointFreeUsage\.claim\(KeypointFreeUsage, keypointFreeContext\(req\), symbol, KEYPOINTS_FREE_STOCKS\)/);
    // Generation stays Pro-gated and independent of the free-tier quota.
    assert.match(src, /if \(generate && !isProUser\(req\)\) return res\.status\(402\)/);
    // dossier.js and insights.js call keypoints.extractKeyPoints directly, not
    // through this HTTP route — the quota must never reach them.
    const dossierJs = fs.readFileSync(path.join(__dirname, '..', 'dossier.js'), 'utf8');
    assert.match(dossierJs, /keypoints\.extractKeyPoints/);
    assert.doesNotMatch(dossierJs, /keypointFreeUsage/);
});

test('Key Points 429 renders the upgrade strip, not a dead-end notice', () => {
    const src = companyJsSource();
    assert.match(src, /r\.status === 429/);
    assert.match(src, /upgradeStrip\(\{/);
    assert.match(src, /free stocks with key points this month/);
});

test('insider-history route shapes the free tier server-side (teaser), not a 402', () => {
    const src = appSource();
    assert.match(src, /app\.get\('\/api\/company\/:symbol\/insider-history', optionalAuth/);
    assert.match(src, /function lockInsiderHistory\(result\)/);
    assert.match(src, /res\.json\(req\.tier === 'free' \? lockInsiderHistory\(result\) : result\)/);
    // The newest quarter and the transaction list are withheld, not blurred.
    assert.match(src, /quarters\.slice\(0, -1\)/);
    assert.match(src, /recent: \[\]/);
    // Internal consumers still call insiders.history() directly.
    const governanceJs = fs.readFileSync(path.join(__dirname, '..', 'governance.js'), 'utf8');
    const aiChatJs = fs.readFileSync(path.join(__dirname, '..', 'ai-chat.js'), 'utf8');
    assert.match(governanceJs, /insiders\.history\(/);
    assert.match(aiChatJs, /insiders\.history\(/);
});

test('ownership route strips insider fields for free tier, shaped after the cache read', () => {
    const src = appSource();
    assert.match(src, /app\.get\('\/api\/company\/:symbol\/ownership', optionalAuth/);
    // Both the cache-hit branch and the cache-miss branch strip insider fields —
    // the cache itself must never store the stripped version.
    const routeBody = src.match(/app\.get\('\/api\/company\/:symbol\/ownership', optionalAuth[\s\S]*?\n\}\);/)[0];
    const strips = (routeBody.match(/insiderTransactions, insiderNet, \.\.\.rest/g) || []).length;
    assert.ok(strips >= 2, 'expected the free-tier strip on both the cache-hit and cache-miss paths');
    assert.match(routeBody, /insiderLocked: true/);
});

test('guru holdings teaser slices to 5 rows and flags teaser:true for free', () => {
    const src = appSource();
    assert.match(src, /function lockGuruData\(data\) \{/);
    assert.match(src, /rows\.slice\(0, 5\)/);
    assert.match(src, /teaser: true/);
    // The public list and core/pro shaping stay untouched.
    assert.match(src, /app\.get\('\/api\/gurus', \(req, res\) => \{/);
    assert.match(src, /function stripGuruAnalysis\(data\) \{/);
    assert.match(src, /function proGuruData\(data\) \{/);
});

test('gurus.html renders the top-5 teaser footer and hides the locked-holdings overrun', () => {
    const src = gurusHtmlSource();
    assert.match(src, /data\.teaser/);
    assert.match(src, /unlock with Core/);
    assert.match(src, /paywall-strip/);
});

test('no plan carries a trial: no no-card trial code, no Stripe trial_period_days', () => {
    const src = appSource();
    assert.doesNotMatch(src, /startSignupTrial|startNoCardTrial|SIGNUP_TRIAL_DAYS|trial_period_days|skipTrial/);
    // Every plan config is trialDays: 0.
    const fn = src.slice(src.indexOf('function getPlanConfig('), src.indexOf('function getPlanConfigByPriceId') > 0 ? src.indexOf('function getPlanConfigByPriceId') : undefined);
    const days = fn.match(/trialDays: [^\s,}]+/g) || [];
    assert.ok(days.length >= 9, 'found the plan configs');
    assert.ok(days.every((d) => d === 'trialDays: 0'), `all trialDays are 0: ${days.join(' | ')}`);
    // The schema field stays so existing documents keep their value.
    assert.match(src, /signupTrialAt: \{ type: Date, default: null \}/);
    // The paid-first 402 fires for every free-plan signup except an AppSumo redemption.
    assert.match(src, /REQUIRE_INITIAL_STRIPE_PAYMENT && !appsumoActivationSignup && planConfig\.planId === FREE_PLAN_ID\)/);
});

test('upgrade strip helper is a pure function exported once on window.V2', () => {
    const appJs = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'app.js'), 'utf8');
    assert.match(appJs, /function upgradeStrip\(opts\) \{/);
    const exportLine = appJs.match(/window\.V2 = \{[^}]*\};/)[0];
    assert.match(exportLine, /upgradeStrip/);
    assert.equal((exportLine.match(/upgradeStrip/g) || []).length, 1, 'exported exactly once');
});

test('cache stamp is bumped and consistent across the touched frontend assets', () => {
    const companyHtml = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'company.html'), 'utf8');
    const gurusHtml = gurusHtmlSource();
    const stampOf = (html) => (html.match(/assets\/app\.js\?v=([\w.-]+)/) || [])[1];
    const companyStamp = stampOf(companyHtml);
    const gurusStamp = stampOf(gurusHtml);
    assert.ok(companyStamp, 'company.html must reference a stamped app.js');
    assert.equal(companyStamp, gurusStamp, 'company.html and gurus.html must carry the same stamp');
    assert.notEqual(companyStamp, '20260902-aiorder1', 'stamp must have moved past the pre-paywall value');
});

// Insights · Pro for signed-out visitors (owner decision 2026-10-26): 20
// distinct stocks a month per visitor, then sign-in and a plan.
test('the signed-out Insights allowance keeps its own count, apart from Key Points', { timeout: 120000 }, async (t) => {
    const server = await MongoMemoryServer.create();
    const db = new Mongoose();
    await db.connect(server.getUri());
    t.after(async () => { await db.disconnect().catch(() => {}); await server.stop(); });

    const Keypoints = usage.createModel(db);
    const Insights = usage.createModel(db, { modelName: 'InsightsAnonUsage', collection: 'insights_anon_usage' });
    assert.equal(Insights.collection.collectionName, 'insights_anon_usage');
    assert.equal(Keypoints.collection.collectionName, 'keypoint_free_usage');

    const context = { clientKey: 'ip:abc', monthKey: '2026-10', expiresAt: new Date('2026-12-01T00:00:00Z') };
    for (let i = 0; i < 20; i += 1) assert.equal((await usage.claim(Insights, context, `T${i}`, 20)).allowed, true);
    assert.equal((await usage.claim(Insights, context, 'T21', 20)).allowed, false, 'the 21st stock is refused');
    assert.equal((await usage.claim(Insights, context, 'T3', 20)).allowed, true, 'a stock already opened stays open');
    assert.equal((await usage.claim(Keypoints, context, 'T21', 5)).allowed, true, 'Key Points has its own count');

    // A stock with nothing to show gives its count back.
    const t0 = await usage.claim(Insights, context, 'T0', 20);
    await usage.release(Insights, t0.id, 'T0');
    assert.equal((await usage.claim(Insights, context, 'T21', 20)).allowed, true);
});

test('insights and segments let a signed-out visitor through the allowance and keep the Pro gate for accounts', () => {
    const src = appSource();
    assert.match(src, /process\.env\.INSIGHTS_ANON_STOCKS \|\| '20'/);
    assert.match(src, /app\.get\('\/api\/company\/:symbol\/insights', optionalAuth, insightsGate,/);
    assert.match(src, /app\.get\('\/api\/company\/:symbol\/segments', optionalAuth, insightsGate,/);
    const gate = src.slice(src.indexOf('async function insightsGate('), src.indexOf("app.get('/api/company/:symbol/insights'"));
    assert.match(gate, /if \(req\.user\) return proGate\(req, res, next\);/);
    assert.match(gate, /keypointFreeUsage\.claim\(InsightsAnonUsage, keypointFreeContext\(req\), symbol, INSIGHTS_ANON_STOCKS\)/);
    assert.match(gate, /code: 'INSIGHTS_ANON_QUOTA'/);
    assert.match(gate, /res\.statusCode >= 400\) keypointFreeUsage\.release\(InsightsAnonUsage, claim\.id, symbol\)/);
    // The require sits above its first use (a const used before it is declared throws at boot).
    assert.ok(src.indexOf("const keypointFreeUsage = require('./keypoint-free-usage');") < src.indexOf('keypointFreeUsage.createModel(mongoose, {'));
});

test('company.js opens Insights signed out and says when the free stocks are used up', () => {
    const src = companyJsSource();
    const fn = src.slice(src.indexOf('async function loadInsights()'), src.indexOf('// ---------- ', src.indexOf('async function loadInsights()')));
    assert.match(fn, /const anon = !token\(\);/);
    assert.match(fn, /if \(!anon\) renderDossier\(true\);/, 'a visitor never triggers key-point generation');
    assert.doesNotMatch(fn, /if \(!token\(\)\) \{\s*segBody/, 'no blanket signed-out teaser');
    assert.match(fn, /free stocks with Insights this month/);
    assert.match(src, /if \(!token\(\)\) tab\.textContent = 'Insights · free';/);
});
