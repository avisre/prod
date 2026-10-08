'use strict';

// 2026-10-07: Monthly $49.99 -> $79.99, Annual $419.99 -> $649.99, Pro annual
// $499.99 -> $799.99; Desk ($1,999.99) did not move. The same day the direct
// lifetime deal stopped being sold. Dev stayed at $19.99 that day and went to
// $200 on 2026-10-08.
//
// What this pins is the three ways a reprice goes wrong quietly: a display
// price that disagrees with the amount checkout matches on, a derived figure
// ("save $X", "$Y/month effective") left over from the old ladder, and a
// subscriber on an old price being shown — or resolved as — the new one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (rel) => fs.readFileSync(path.join(__dirname, '../..', rel), 'utf8');
const APP = read('backend/app.js');
const HOME = read('frontend-v2/index.html');
const directLtd = require('../direct-ltd');

const MONTHLY = 79.99, ANNUAL = 649.99, PRO = 799.99;
const usd = (n) => n.toFixed(2);

const envDefault = (name) => {
    const m = APP.match(new RegExp(`const ${name} = parseFloat\\(process\\.env\\.${name} \\|\\| '([\\d.]+)'\\)`));
    assert.ok(m, `${name} default not found`);
    return Number(m[1]);
};
const specAmount = (planConst) => {
    const block = APP.slice(APP.indexOf('const CHECKOUT_STRIPE_PRICE_SPECS'));
    const m = block.match(new RegExp(`\\[${planConst}\\]: \\{ amount: ([\\d.]+),`));
    assert.ok(m, `${planConst} is not in CHECKOUT_STRIPE_PRICE_SPECS`);
    return Number(m[1]);
};

test('the display price and the amount checkout matches on are the same number', () => {
    for (const [name, planConst, want] of [
        ['CORE_PLAN_PRICE', 'MONTHLY_PLAN_ID', MONTHLY], ['ANNUAL_PLAN_PRICE', 'ANNUAL_PLAN_ID', ANNUAL],
        ['PRO_ANNUAL_PLAN_PRICE', 'PRO_ANNUAL_PLAN_ID', PRO], ['DEV_PLAN_PRICE', 'DEV_PLAN_ID', 200], ['DESK_PLAN_PRICE', 'DESK_PLAN_ID', 1999.99]
    ]) {
        assert.equal(envDefault(name), want, `${name} default`);
        assert.equal(specAmount(planConst), want, `${planConst} checkout spec`);
    }
});

test('Desk did not move, and Dev is at its 2026-10-08 price', () => {
    assert.equal(envDefault('DEV_PLAN_PRICE'), 200);
    assert.equal(envDefault('DESK_PLAN_PRICE'), 1999.99);
    assert.match(HOME, /\$1,999\.99<span>\/year<\/span>/);
});

test('the annual card’s derived figures are the arithmetic of the two prices', () => {
    const twelve = MONTHLY * 12;
    const save = usd(twelve - ANNUAL), effective = usd(ANNUAL / 12), pctOff = Math.round((1 - ANNUAL / twelve) * 100);
    assert.equal(save, '309.89');
    assert.equal(effective, '54.17');
    assert.equal(pctOff, 32);
    assert.ok(HOME.includes(`Save $${save} a year`), 'homepage saving');
    assert.ok(HOME.includes(`$${effective}/month effective`), 'homepage effective monthly');
    assert.ok(HOME.includes(`>$${usd(twelve)}</s>`), 'struck-through twelve-month figure');
    assert.ok(HOME.includes(`${pctOff}% off monthly`), 'discount label');
    assert.ok(HOME.includes(`about $${Math.round(PRO / 12)} per month`), 'Pro per-month framing');
    for (const page of ['frontend-v2/register.html', 'frontend-v2/upgrade.html']) {
        assert.ok(read(page).includes(`$${save}`), `${page} saving`);
    }
});

test('no customer-facing page still prints the old ladder', () => {
    const old = /(?<![\d,.])(49\.99|419\.99|499\.99|179\.89|599\.88)(?!\d)|\$35\.00/;
    for (const page of ['frontend-v2/index.html', 'frontend-v2/register.html', 'frontend-v2/upgrade.html', 'frontend-v2/terms.html',
        'frontend-v2/recharge.html', 'frontend-v2/assets/app.js', 'frontend-v2/assets/monitor.js', 'backend/comparison-pages.js',
        'backend/seo-pages.js', 'frontend/llms.txt', 'frontend/llms-full.txt']) {
        const hit = read(page).match(old);
        assert.equal(hit, null, `${page} still prints ${hit && hit[0]}`);
    }
});

test('subscribers on the replaced prices resolve to their plan at the amount Stripe charges', () => {
    const block = APP.slice(APP.indexOf('const LEGACY_REPRICED_20261007'), APP.indexOf('const SELF_SERVE_PRICE_LOOKUP_TTL_MS'));
    for (const [planConst, price] of [['MONTHLY_PLAN_ID', '49.99'], ['ANNUAL_PLAN_ID', '419.99'], ['PRO_ANNUAL_PLAN_ID', '499.99']]) {
        assert.match(block, new RegExp(`planId: ${planConst}, price: ${price.replace('.', '\\.')}, priceId: process\\.env\\.\\w+ \\|\\| 'price_\\w+'`),
            `${planConst} has no grandfather entry at $${price}`);
    }
    const ids = [...block.matchAll(/'(price_\w+)'/g)].map((m) => m[1]);
    assert.equal(ids.length, 6);
    assert.equal(new Set(ids).size, 6, 'a price id is listed for two entries');
    const resolver = APP.slice(APP.indexOf('function getPlanConfigByPriceId'), APP.indexOf('function planConfigFromSubscriptionMetadata'));
    assert.match(resolver, /LEGACY_REPRICED_20261007\.find/);
    assert.match(resolver, /price: legacy\.price/);
    assert.ok(resolver.indexOf('LEGACY_REPRICED_20261007.find') < resolver.indexOf('priceId === STRIPE_PRICE_ID_ANNUAL'),
        'the grandfather lookup must run before the env-id branches, or an env var naming the old id shows the new price');
    assert.match(APP, /for \(const entry of \[\.\.\.LEGACY_REPRICED_20261007, \.\.\.CURRENT_REPRICED_20261007\]\) claim\(entry\.priceId, entry\.planId\);/);
});

test('the top-up copy no longer claims a plan is cheaper per credit than it is', () => {
    const recharge = read('frontend-v2/recharge.html');
    assert.doesNotMatch(recharge, /4× less/);
    assert.match(recharge, /600 credits a month and the Filing Change Monitor for \$799\.99\/yr/);
});

test('direct lifetime sales are closed without touching what existing buyers rely on', () => {
    const on = { DIRECT_LTD_ENABLED: 'true' };
    assert.equal(directLtd.salesOpen(on), false);
    assert.equal(directLtd.enabled(on), true, 'enabled() also gates webhooks and refunds for existing buyers');
    assert.match(APP, /enabled: directLtd\.salesOpen\(\) && directLtd\.priceFloorsOk\(\)/);
    assert.match(APP, /tiers: directLtd\.salesOpen\(\) \? directLtd\.publicTiers\(\) : \[\]/);
    for (const route of ["app.post('/api/checkout/lifetime'", "app.post('/api/lifetime/signup'"]) {
        const at = APP.indexOf(route);
        assert.ok(at > 0);
        assert.match(APP.slice(at, at + 420), /if \(!directLtd\.salesOpen\(\)\) return res\.status\(410\)/, `${route} still sells`);
    }
    assert.match(APP, /const mode = directLtd\.salesOpen\(\) \? pricingExperiment\.mode\(\) : 'off';/);
    const route = APP.match(/app\.get\((\/\^\\\/lifetime[^,]+), \(req, res, next\) => \{[\s\S]{0,700}?res\.redirect\(301, '\/#pricing'\)/);
    assert.ok(route, 'the lifetime pages are not redirected');
    const re = new RegExp(route[1].slice(1, -1));
    for (const p of ['/lifetime', '/lifetime.html', '/lifetime-checkout', '/lifetime-checkout.html']) assert.ok(re.test(p), `${p} is not covered`);
    assert.equal(re.test('/lifetime-terms'), false);
    assert.doesNotMatch(APP, /'\/lifetime\.html': '\/lifetime'/, 'a noindex page must not sit in the redirect table');
});

test('the site no longer points anyone at the lifetime deal, and AppSumo is left alone', () => {
    assert.doesNotMatch(HOME, /pricing-experiment|lifetime-checkout|\/api\/lifetime/);
    const seo = read('backend/seo-pages.js');
    assert.doesNotMatch(seo, /'\/lifetime'/, '/lifetime is still in the sitemap');
    assert.match(HOME, /href="\/appsumo">lifetime option/, 'the AppSumo link was meant to stay');
    assert.ok(fs.existsSync(path.join(__dirname, '../../frontend-v2/appsumo.html')));
});
