'use strict';

// Front-door rebuild (2026-09): the anonymous Ask preview becomes a funnel —
// spent preview → email rung (+2 verified questions on a signed cookie) →
// paid checkout. No "free account" copy survives (paid-first signup), the
// quota-wall ladder loses the unsellable Free card, and authenticated
// research shares become indexable while anonymous ones stay noindex.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const backendSource = () => fs.readFileSync(path.join(root, 'backend', 'app.js'), 'utf8');
const appSource = () => fs.readFileSync(path.join(root, 'frontend-v2', 'assets', 'app.js'), 'utf8');
const shareCopySource = () => fs.readFileSync(path.join(root, 'backend', 'share-copy.js'), 'utf8');
const indexHtml = () => fs.readFileSync(path.join(root, 'frontend-v2', 'index.html'), 'utf8');

test('Anon ask wall copy routes to the email rung and paid checkout — never a free account', () => {
    const src = backendSource();
    assert.ok(!src.includes('create a free account to keep asking'), 'stale free-account wall copy is gone');
    assert.match(src, /leave your email for/, 'the spent-preview wall offers the email rung');
    assert.match(src, /\$24\.99\/month/, 'the wall names the paid entry rung');
    assert.match(src, /anon_wall_shown/);
    assert.match(src, /anon_ask_started/);
    assert.match(src, /anon_ask_done/);
});

test('Email rung endpoints exist, are abuse-bounded, and mint the bonus cookie', () => {
    const src = backendSource();
    assert.match(src, /app\.post\('\/api\/ask-trial\/email', askTrialEmailLimiter/);
    assert.match(src, /app\.get\('\/api\/ask-trial\/verify'/);
    assert.match(src, /ASK_TRIAL_DISPOSABLE_DOMAINS\.has/, 'disposable domains are blocked');
    assert.match(src, /sp_ask_bonus=/, 'the bonus cookie is set on a signed value');
    assert.match(src, /k: 'ask_bonus'/);
    assert.match(src, /k: 'ask_email_verify'/);
    assert.match(src, /const ASK_TRIAL_BONUS = Number\(process\.env\.ASK_TRIAL_BONUS \?\? 2\)/);
    assert.match(src, /anon_email_captured/);
    assert.match(src, /anon_email_verified/);
});

test('Effective anon limit is base + email bonus, and the quota echoes it', () => {
    const src = backendSource();
    assert.match(src, /const limit = Math\.max\(0, ANON_ASK_LIMIT\) \+ \(bonusUsed \? ASK_TRIAL_BONUS : 0\)/);
    assert.match(src, /quota: \{ used: limit, limit, remaining/);
    assert.match(src, /visitorUsed >= limit/);
});

test('Frontend trial wall renders the inline email capture, not a dead-end notice', () => {
    const src = appSource();
    assert.match(src, /function askTrialWall\(data\)/);
    assert.match(src, /wireAskTrialEmail/);
    assert.doesNotMatch(src, /register\.html\?plan=free/, 'no /register.html?plan=free links remain');
    assert.match(src, /api\/ask-trial\/email/);
    assert.match(src, /refundable within 7 days/);
    assert.match(src, /Start secure checkout — \$24\.99\/month/);
    const quotaWall = src.match(/const ASK_PLANS = \{[\s\S]*?\};/)[0];
    assert.ok(!quotaWall.includes('\$0'), 'the unsellable Free — $0/forever card is gone from the ladder');
    assert.match(quotaWall, /'Monthly', price: '\$24\.99'/);
    assert.match(quotaWall, /'Pro', price: '\$499\.99'/);
});

test('Homepage leads with Dossier + Monitor — Ask is NOT the primary marketing', () => {
    const html = indexHtml();
    // the live ask box was removed from the hero (replaced by a dossier specimen)
    assert.ok(!html.includes('id="home-ask"'), 'no home-ask mount point');
    assert.ok(!html.includes('V2.mountAsk(host'), 'no inline ask mount');
    assert.ok(!html.includes('id="ask-feature"'), 'no Ask feature section');
    assert.ok(!/hero-actions[\s\S]{0,600}?href="\/ask\.html/.test(html), 'no Ask CTA in the hero');
    // the hero leads with the dossier CTA and the monitor CTA
    const hero = html.match(/<section class="hero">[\s\S]*?<\/section>/)[0];
    assert.match(hero, /<h1 class="display">The report, not a chat\.<\/h1>/);
    assert.match(hero, /href="\/dossier\.html"/);
    assert.match(hero, /href="\/monitor"/);
    // the email-rung verify link still lands here and is still handled
    assert.match(html, /\?ask=verified/);
    assert.match(html, /q\.get\('ask'\) === 'verified'/);
    assert.ok(!html.includes('data-appsumo-deadline'), 'the AppSumo ghost button and deadline span are gone from the hero');
});

test('Homepage hero carries the live 3-free demo card', () => {
    // The try-first hero (2026-09-01): a working ask box whose answers stream
    // into the same capped, inner-scrolling stack that holds the specimen —
    // the page below the hero never reflows while a visitor uses it.
    const html = indexHtml();
    assert.match(html, /id="home-try"/, 'the demo card exists (and is NOT id=home-ask)');
    assert.match(html, /id="try-exchange"/, 'answers land inside the demo stack');
    assert.match(html, /V2\.askEngine\(exchange\)/, 'the demo wires the real ask engine');
    assert.match(html, /try-chip/, 'sample-question chips guide the first ask');
    assert.match(html, /3 questions free/, 'the 3-free framing sits on the card');
    assert.match(html, /try-stack/, 'the proof stack is the capped, inner-scrolling region');
});

test('Ask floor auto-mounts on opted-in server-rendered surfaces', () => {
    const runtime = appSource();
    assert.match(runtime, /dataset\.askFloor === '1'/);
    assert.match(runtime, /dataset\.askPlaceholder/);
    const seoPages = fs.readFileSync(path.join(root, 'backend', 'seo-pages.js'), 'utf8');
    assert.match(seoPages, /data-ask-floor="1"/);
    assert.match(seoPages, /answered from its SEC filings/);
    const freeTools = fs.readFileSync(path.join(root, 'backend', 'free-tools.js'), 'utf8');
    assert.ok((freeTools.match(/data-ask-floor="1"/g) || []).length >= 3, 'all free-tool shells opt in');
    const screener = fs.readFileSync(path.join(root, 'frontend-v2', 'screener.html'), 'utf8');
    assert.match(screener, /data-ask-floor="1"/);
});

test('Authenticated shares are indexable; anonymous shares stay noindex', () => {
    const route = backendSource();
    assert.match(route, /const indexable = Boolean\(report\.createdBy\)/);
    assert.match(route, /if \(!indexable\) res\.setHeader\('X-Robots-Tag', 'noindex, nofollow, noarchive'\)/);
    assert.match(route, /\{ publicBase: PUBLIC_APP_URL, indexable \}/);
    assert.match(route, /function noteIndexableShare/);
    assert.match(route, /if \(report\.createdBy\) noteIndexableShare\(report\.publicId\)/);
    const scraper = shareCopySource();
    assert.match(scraper, /indexable = false/);
    assert.match(scraper, /<meta name="robots" content="index, follow, max-image-preview:large">/);
    assert.match(scraper, /'@type': 'Article'/);
    const seoPages = fs.readFileSync(path.join(root, 'backend', 'seo-pages.js'), 'utf8');
    assert.match(seoPages, /indexable-shares\.json/, 'the sitemap builder reads the share ledger');
    // Indexability is opt-in only for authenticated creators: the noindex
    // header and meta both survive when no user is attached.
    assert.match(scraper, /: '<meta name="robots" content="noindex,nofollow,noarchive">'/);
});