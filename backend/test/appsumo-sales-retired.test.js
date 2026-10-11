'use strict';

// AppSumo sales were retired on 2026-10-11: the site no longer sends a new
// buyer to the AppSumo deal. These guards hold both halves of that decision —
// nothing public points at the deal any more, and nothing an existing AppSumo
// buyer depends on (redeem, webhook, activation, upgrade link) was taken away.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (...parts) => fs.readFileSync(path.join(__dirname, '..', '..', ...parts), 'utf8');
const APP = read('backend', 'app.js');
const HOME = read('frontend-v2', 'index.html');

const augustCampaign = require('../august-campaign');
const affiliate = require('../affiliate-program');
const freeTools = require('../free-tools');
const shareCopy = require('../share-copy');

function routeBody(startMarker) {
    const start = APP.indexOf(startMarker);
    assert.ok(start > -1, `${startMarker} not found`);
    return APP.slice(start, APP.indexOf('\n});', start));
}

test('sales are retired by a code constant, and new buyers go to our own plans', () => {
    assert.equal(augustCampaign.SALES_RETIRED, true);
    assert.equal(augustCampaign.salesOpen(), false);
    assert.equal(augustCampaign.NEW_BUYER_PATH, '/#pricing');
});

test('the landing page and the tracked redirect both stop before reaching AppSumo', () => {
    const landing = routeBody("app.get(/^\\/appsumo(?:\\.html)?$/, async (req, res, next) => {");
    assert.match(landing, /if \(!augustCampaign\.salesOpen\(\)\) return res\.redirect\(302, augustCampaign\.NEW_BUYER_PATH\);/);
    assert.ok(landing.indexOf('salesOpen()') < landing.indexOf('landingPath'), 'the page is read before the retirement check');
    assert.doesNotMatch(APP, /'\/appsumo\.html': '\/appsumo'/, 'a noindex page must not sit in the redirect table');
    assert.match(read('frontend-v2', 'appsumo.html'), /<meta name="robots" content="noindex,follow" \/>/);

    const go = routeBody("app.get('/go/appsumo/:source', (req, res) => {");
    assert.match(go, /if \(!augustCampaign\.salesOpen\(\)\) return res\.redirect\(302, augustCampaign\.NEW_BUYER_PATH\);/);
    assert.ok(go.indexOf('salesOpen()') < go.indexOf("trackFunnel('appsumo_outbound'"), 'a click that never reaches AppSumo is still counted as one');
    assert.ok(go.indexOf('salesOpen()') < go.indexOf('APPSUMO_OUTBOUND_URL'), 'the AppSumo redirect is reachable before the retirement check');
});

test('an affiliate link set to the AppSumo destination lands on our plans, even with a configured AppSumo URL', () => {
    assert.equal(affiliate.appSumoUrl({ APPSUMO_NEW_BUYER_URL: 'https://appsumo.com/products/stockportfoliopro/' }), '/#pricing');
    assert.equal(affiliate.appSumoUrl({}), '/#pricing');
});

test('the homepage keeps the AppSumo rating but links nobody to AppSumo', () => {
    assert.doesNotMatch(HOME, /appsumo\.com/i);
    assert.doesNotMatch(HOME, /href="\/appsumo|\/go\/appsumo|lifetime option|lifetime deal/i);
    assert.match(HOME, /5\.0 on AppSumo/);
});

test('free tools, research pages and shared reports offer our plans, not the deal', () => {
    for (const slug of Object.keys(freeTools.TOOL_DEFINITIONS)) {
        const html = freeTools.renderToolPage(slug);
        assert.doesNotMatch(html, /href="\/appsumo|\/go\/appsumo|appsumo\.com|data-appsumo-campaign-link|on AppSumo/i, `${slug} still sells the AppSumo deal`);
        assert.doesNotMatch(html, /href='\/appsumo|cta\.href='\/appsumo/, `${slug} still rewrites its button to AppSumo`);
    }
    assert.doesNotMatch(read('backend', 'seo-extra.js'), /href="\/appsumo|AppSumo offer/);
    const report = shareCopy.renderPublicResearchPage({
        id: 'a'.repeat(32), title: 'Alpha', summary: 'Cash covers debt.',
        sourceUrl: 'https://www.stockportfolio.pro/company.html?symbol=msft', createdAt: '2026-07-26T12:00:00.000Z'
    }, { publicBase: 'https://www.stockportfolio.pro' });
    assert.match(report, /#pricing"/);
    assert.doesNotMatch(report, /appsumo|lifetime deal/i);
});

test('the sitemap no longer lists the AppSumo landing page', () => {
    assert.doesNotMatch(read('backend', 'seo-pages.js'), /'\/appsumo'/);
});

test('everything an existing AppSumo buyer depends on is still there', () => {
    for (const route of [
        "app.post('/appsumo/webhook'", "app.get('/appsumo/webhook'", "app.get('/appsumo/redeem'",
        "app.post('/api/appsumo/activate'", "app.get('/api/appsumo/unsubscribe'"
    ]) assert.ok(APP.includes(route), `${route} was removed`);
    for (const marker of ["app.get('/appsumo/redeem'", "app.post('/api/appsumo/activate'", "app.post('/appsumo/webhook'"]) {
        assert.doesNotMatch(routeBody(marker), /salesOpen/, `${marker} must not depend on the sales switch`);
    }
    assert.match(APP, /function appsumoUpgradeUrl\(lic\)/);
    assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'frontend-v2', 'appsumo.html')), 'the page file stays so the switch can be flipped back');
});
