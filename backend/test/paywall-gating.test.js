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

test('3-day signup trial is flag-gated, defaults off, and never bypasses the AppSumo/paid paths', () => {
    const src = appSource();
    assert.match(src, /const SIGNUP_TRIAL_DAYS = parseInt\(process\.env\.SIGNUP_TRIAL_DAYS \|\| '0', 10\)/);
    assert.match(src, /function startSignupTrial\(user\) \{/);
    assert.match(src, /s\.status = 'trialing';\s*\n\s*s\.planId = MONTHLY_PLAN_ID;/);
    assert.match(src, /s\.price = 0;/);
    // Repeat-trial guard.
    assert.match(src, /!user\.signupTrialAt/);
    assert.match(src, /signupTrialAt: \{ type: Date, default: null \}/);
    // The paid-first 402 still fires whenever the flag is off (default).
    assert.match(src, /REQUIRE_INITIAL_STRIPE_PAYMENT && !appsumoActivationSignup && planConfig\.planId === FREE_PLAN_ID && SIGNUP_TRIAL_DAYS <= 0/);
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
