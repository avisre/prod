'use strict';

// September launch rate (2026-09): the Monthly rung at $8.99 for anyone who
// starts it this month, and that rate stays theirs for as long as they keep the
// subscription; October signups return to the $24.99 list price.
//
// It is a Stripe coupon applied at checkout, so the plan/price matcher and every
// legacy subscriber are untouched — the discounted amount lives on the invoice,
// which is the only place it has to be right. These tests pin the parts that
// would fail quietly or expensively: the offer is inert unless BOTH env vars are
// set, it can never reach a plan other than Monthly, it can never collide with
// the referral code box, the window closes on its own without a deploy, and no
// page hardcodes the launch price — the display is driven by /stripe/config so
// the copy cannot outlive the offer.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = () => fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const pageSource = (name) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', name), 'utf8');

// The two pure date helpers, taken from app.js verbatim and evaluated in a
// sandbox so the boundary is measured instead of re-implemented here — a test
// that restates the logic agrees with itself and proves nothing.
function promoHelpers() {
    const source = appSource();
    const start = source.indexOf('function launchPromoUntilMs(');
    const anchor = source.indexOf('return until > 0 && now <= until;');
    assert.ok(start > -1 && anchor > start, 'the promo helpers exist in app.js');
    const body = source.slice(start, source.indexOf('\n}', anchor) + 2);
    // Plain concatenation, not a template literal: the body contains its own ${}.
    const factory = new Function('LAUNCH_PROMO_COUPON_ID', 'LAUNCH_PROMO_UNTIL',
        body + '\nreturn { launchPromoUntilMs: launchPromoUntilMs, launchPromoActive: launchPromoActive };');
    return (couponId, until) => factory(couponId, until);
}

// The checkout branch that decides whether a session carries the coupon.
function checkoutBranch() {
    const source = appSource();
    const start = source.indexOf('const launchPromoApplied');
    const end = source.indexOf('allow_promotion_codes', start);
    assert.ok(start > -1 && end > start, 'the promo checkout branch exists');
    return source.slice(start, source.indexOf('\n', end) + 1);
}

// Full-line comments stripped: the comments explaining which claims a promo
// branch drops have to name them, and this test asks what the code does, not
// what it says about it.
const stripComments = (source) => source.split('\n').map((line) => line.replace(/^\s*\/\/.*$/, '')).join('\n');

// applyMonthlyPromo() as written into one of the pricing pages.
function promoFn(page) {
    const source = pageSource(page);
    const start = source.indexOf('function applyMonthlyPromo(');
    assert.ok(start > -1, `${page} has applyMonthlyPromo`);
    const end = source.indexOf('\n    }', start);
    return stripComments(source.slice(start, end > -1 ? end : source.length));
}

test('the offer exists only when the server is configured with both env vars', () => {
    // Env-only: no coupon id in the repo, so nothing here can turn the promo on.
    assert.match(appSource(), /const LAUNCH_PROMO_COUPON_ID = process\.env\.LAUNCH_PROMO_COUPON_ID \|\| '';/);
    assert.match(appSource(), /const LAUNCH_PROMO_UNTIL = process\.env\.LAUNCH_PROMO_UNTIL \|\| '';/);
    // Kill switch: unset either var and the offer never existed.
    assert.match(appSource(), /if \(!LAUNCH_PROMO_COUPON_ID\) return false;/);
    assert.match(appSource(), /if \(!LAUNCH_PROMO_UNTIL\) return 0;/);
});

test('the launch window closes on its own, at the right second, and fails closed', () => {
    const helpers = (coupon, until) => promoHelpers()(coupon, until);

    // The launch configuration: a bare date means all of the last day, UTC.
    const live = helpers('sept-launch-899', '2026-09-30');
    assert.equal(live.launchPromoActive(Date.parse('2026-09-30T23:59:59.999Z')), true, 'still live on the last day');
    assert.equal(live.launchPromoActive(Date.parse('2026-10-01T00:00:00.000Z')), false, 'closed on Oct 1');
    assert.equal(live.launchPromoActive(Date.parse('2026-09-15T12:00:00.000Z')), true);

    // A full timestamp is taken as written (the kill switch for a mid-day stop).
    const noon = helpers('sept-launch-899', '2026-09-30T12:00:00Z');
    assert.equal(noon.launchPromoActive(Date.parse('2026-09-30T11:59:59Z')), true);
    assert.equal(noon.launchPromoActive(Date.parse('2026-09-30T12:00:01Z')), false);

    // Neither var alone is enough; junk fails CLOSED rather than open.
    assert.equal(helpers('', '2026-09-30').launchPromoActive(Date.parse('2026-09-15T00:00:00Z')), false);
    assert.equal(helpers('sept-launch-899', '').launchPromoActive(Date.parse('2026-09-15T00:00:00Z')), false);
    assert.equal(helpers('sept-launch-899', 'soon').launchPromoActive(Date.parse('2026-09-15T00:00:00Z')), false);
    assert.equal(helpers('sept-launch-899', '2026-13-45').launchPromoActive(Date.parse('2026-09-15T00:00:00Z')), false);
});

test('only a Monthly checkout can carry the launch rate, and an affiliate referral keeps the code box', () => {
    const branch = checkoutBranch();
    assert.match(branch, /launchPromoActive\(\)/);
    assert.match(branch, /planConfig\.planId === MONTHLY_PLAN_ID/, 'monthly only — annual is not discounted');
    assert.match(branch, /!affiliateAttached/, 'an attributed referral keeps its own promotion code');
});

test('Stripe is never sent discounts and allow_promotion_codes in the same session', () => {
    // Stripe rejects the pair outright, so the two are one either/or.
    const branch = checkoutBranch();
    assert.match(branch,
        /\.\.\.\(launchPromoApplied \? \{ discounts: \[\{ coupon: LAUNCH_PROMO_COUPON_ID \}\] \} : \{ allow_promotion_codes: true \}\),/);
    // And nothing else in the branch adds a second, unconditional discount.
    assert.equal(branch.split('discounts').length - 1, 1, 'exactly one discounts param');
    assert.equal(branch.split('allow_promotion_codes').length - 1, 1, 'exactly one code-box param');
});

test('/stripe/config reports the promo only while it is active, and only as display data', () => {
    const source = appSource();
    const at = source.indexOf('monthlyPromo:');
    assert.ok(at > -1, 'the config endpoint reports the promo');
    const block = source.slice(at, source.indexOf('} : null', at) + '} : null'.length);
    assert.match(block, /^monthlyPromo: launchPromoActive\(\) \? \{/, 'gated by the same per-request check');
    assert.ok(block.endsWith('} : null'), 'absent (null) when the offer is over');
    for (const field of ['planId: MONTHLY_PLAN_ID', 'price: LAUNCH_PROMO_PRICE',
        'listPrice: LAUNCH_PROMO_LIST_PRICE', 'until: LAUNCH_PROMO_UNTIL']) {
        assert.ok(block.includes(field), `config exposes ${field}`);
    }
    // The note is the one line of promo copy the pages quote verbatim.
    assert.match(block, /locked in for as long as you stay subscribed/);
});

test('the struck-through "was" price is the live monthly list price, not a second number to maintain', () => {
    const source = appSource();
    const spec = source.match(/\[MONTHLY_PLAN_ID\]: \{ amount: ([\d.]+),/);
    assert.ok(spec, 'the monthly checkout spec has an amount');
    const listDefault = source.match(/const LAUNCH_PROMO_LIST_PRICE = process\.env\.LAUNCH_PROMO_LIST_PRICE \|\| '([\d.]+)';/);
    assert.ok(listDefault, 'the promo list price has a default');
    assert.equal(Number(listDefault[1]), Number(spec[1]),
        'the promo "was" price and the monthly plan price must be the same number');
    // And the promo price is below it — a "discount" that is not a discount is
    // the one failure nobody would notice from the outside.
    const promo = source.match(/const LAUNCH_PROMO_PRICE = process\.env\.LAUNCH_PROMO_PRICE \|\| '([\d.]+)';/);
    assert.ok(Number(promo[1]) < Number(listDefault[1]), 'the launch rate is below the list price');
});

test('no pricing page hardcodes the launch rate — the copy is runtime-only', () => {
    // Each page ships the LIST price in its markup and swaps it from
    // /stripe/config. That is what makes the offer self-expiring: when the
    // window closes the endpoint stops reporting it and the shipped $24.99 copy
    // is simply what renders. A hardcoded $8.99 would keep advertising a rate
    // the checkout no longer honours, with no deploy to fix it.
    const surfaces = [
        ['register.html', /amount: '\$24\.99', cadence: 'per month'/],
        ['upgrade.html', /fig: '\$24\.99', per: '\/month'/],
        ['index.html', /\$24\.99<span>\/month<\/span>/]
    ];
    for (const [page, listPrice] of surfaces) {
        const source = pageSource(page);
        assert.match(source, listPrice, `${page} ships the list price as its fallback`);
        assert.doesNotMatch(source, /(amount|fig|price-fig)[^\n]{0,12}\$8\.99/,
            `${page} must not hardcode the launch rate`);
    }
    // Each one reads the promo back from the same endpoint that gates it.
    assert.match(pageSource('register.html'), /applyMonthlyPromo\(cfg\.monthlyPromo\)/);
    assert.match(pageSource('upgrade.html'), /c && c\.monthlyPromo/);
    assert.match(pageSource('index.html'), /var promo = cfg && cfg\.monthlyPromo;/);
    // A page whose fetch fails keeps the list price: no promo call, no discount
    // claim — the register page's applyMonthlyPromo handles the empty case, and
    // nothing runs at all when the request never completes.
    assert.match(pageSource('register.html'), /if \(!promo \|\| !promo\.price\) \{/);
    assert.match(pageSource('upgrade.html'), /if \(!promo \|\| !promo\.price\) return;/);
});

test('the promo copy drops the annual claims it would falsify', () => {
    // Twelve months at the launch rate costs less than the annual plan, so
    // "save $100 a year vs monthly" and "two months free versus monthly" are
    // both false for as long as the promo runs. The annual card stays on sale —
    // one payment for the year is still a real choice — it just stops claiming
    // to be the cheaper one.
    for (const page of ['register.html', 'upgrade.html']) {
        const fn = promoFn(page);
        assert.doesNotMatch(fn, /save \$100|two months free/i, `${page} drops the savings claim while promoted`);
        assert.match(fn, /16\.67\/month effective/, `${page} keeps the effective-rate framing`);
    }
    // The homepage keeps "save $100" in its shipped markup — the same rule as
    // the price: it is only ever removed at runtime, by the promo branch.
    const home = pageSource('index.html');
    assert.match(home, /Save \$100 a year<\/strong> — \$16\.67\/month effective, two months free versus \$24\.99 monthly/);
    const homePromo = stripComments(home.slice(home.indexOf("var promo = cfg && cfg.monthlyPromo;"),
        home.indexOf("config unreachable: keep the list prices above")));
    assert.doesNotMatch(homePromo, /save \$100/i);
    assert.match(homePromo, /annualWas\.hidden = true/, 'the $299.88 monthly comparison goes too');
    assert.match(homePromo, /set\('annual-save', 'One payment covers the year — \$16\.67\/month effective'\)/);
});
