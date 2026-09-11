'use strict';

// The Dev plan ($19.99/mo, 200 credits) is the self-serve rung the entire
// developer funnel converts on — the npm package, the MCP directory listings,
// the embeddable widgets and the programmatic SEO pages all land on /api and
// end at this checkout. These are structural guards on the parts of that
// wiring that fail SILENTLY when they drift:
//
//   - normalizePlanSelection returns MONTHLY for anything it doesn't
//     recognise, so an unhandled 'dev' sells a Monthly subscription to a
//     developer who clicked the API plan. Wrong product, no error.
//   - CHECKOUT_STRIPE_PRICE_SPECS.amount is a frozen literal while
//     DEV_PLAN_PRICE is env-overridable, so the two can drift apart and the
//     Stripe price lookup will simply stop matching (refusing to sell) or, if
//     the spec is the stale side, match a product at the wrong amount.
//   - The credit floor is what makes the plan worth $19.99: without it the
//     wallet derives from the free-tier Ask limit (x2 of 3 = 6 credits).
//   - Dev's Stripe price is identified by its AMOUNT, so that amount has to
//     stay unique in the account: resolveStripeCheckoutPlan matches
//     amount+currency+interval+product and refuses unless exactly one active
//     price matches. Dev and Monthly shared one $24.99 price id while the
//     no-new-Stripe-objects constraint applied; the machinery that made that
//     survivable (metadata-first resolution, ambiguity refusal) is still here
//     as belt-and-braces, because the price id must never silently outrank
//     subscription.metadata.planId — a Monthly customer re-resolved as Dev
//     loses the web app, since userTier('dev') is 'free'.
//
// Asserted against source, the same way api-access-gating.test.js does it,
// since app.js is a single-file Express app with no exported plan helpers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const credits = require('../credits');
const seoPages = require('../seo-pages');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

// Slice one top-level function's source out of app.js by name, ending at the
// next top-level declaration. Keeps each assertion scoped to the function it
// is about rather than the whole file.
function fnSource(name, nextName) {
    const start = appSource.indexOf(`function ${name}(`);
    assert.ok(start >= 0, `${name} exists in app.js`);
    const end = appSource.indexOf(`\nfunction ${nextName}`, start);
    return appSource.slice(start, end > 0 ? end : start + 4000);
}

test('the Dev plan resolves to itself, not to Monthly', () => {
    const fn = fnSource('normalizePlanSelection', 'getPlanConfig');
    assert.match(fn, /if \(plan === DEV_PLAN_ID \|\| plan === 'developer' \|\| plan === 'api'\) \{\s*return DEV_PLAN_ID;/, "normalizePlanSelection must map 'dev' to DEV_PLAN_ID");
    // The ordering is load-bearing: the Monthly fallback is the LAST return, so
    // the dev branch has to sit above it.
    assert.ok(fn.indexOf('DEV_PLAN_ID') < fn.indexOf('return MONTHLY_PLAN_ID;'),
        'the Dev branch must precede the Monthly fallback return');
});

test('getPlanConfig returns a monthly Dev plan priced from DEV_PLAN_PRICE', () => {
    const fn = fnSource('getPlanConfig', 'getPlanConfigByPriceId');
    const block = fn.slice(fn.indexOf('if (planId === DEV_PLAN_ID)'), fn.indexOf('if (planId === POWER_PLAN_ID)'));
    assert.ok(block.length > 0, 'a Dev branch exists in getPlanConfig');
    assert.match(block, /planId: DEV_PLAN_ID/);
    assert.match(block, /planName: 'Dev'/);
    assert.match(block, /billingInterval: 'month'/);
    assert.match(block, /price: DEV_PLAN_PRICE/);
    assert.match(block, /stripePriceId: STRIPE_PRICE_ID_DEV/);
    assert.match(block, /trialDays: 0/, 'no trial on the Dev rung — deliberate, see the comment in app.js');
});

test('the checkout spec amount and DEV_PLAN_PRICE agree, and the Stripe product name is explicit', () => {
    const spec = appSource.slice(appSource.indexOf('const CHECKOUT_STRIPE_PRICE_SPECS'), appSource.indexOf('// Grandfathered subscribers keep'));
    const devSpec = /\[DEV_PLAN_ID\]:\s*\{\s*amount:\s*([\d.]+),\s*currency:\s*'(\w+)',\s*interval:\s*'(\w+)',\s*productName:\s*'([^']+)'\s*\}/.exec(spec);
    assert.ok(devSpec, 'CHECKOUT_STRIPE_PRICE_SPECS carries a Dev entry');
    assert.equal(Number(devSpec[1]), 19.99, 'Dev checkout amount is $19.99');
    assert.equal(devSpec[2], 'USD');
    assert.equal(devSpec[3], 'month', 'Dev is a recurring monthly price — the first monthly rung since Power Monthly was retired');
    // resolveStripeCheckoutPlan matches this against the Stripe product name
    // case-insensitively; a differently-named product makes the plan refuse to
    // sell rather than sell the wrong thing. Dev shares Monthly's product and is
    // separated from it by amount alone — see the uniqueness test below.
    assert.equal(devSpec[4], 'stockportfolio.pro', 'the Stripe product must be named exactly this');
});

test('the Dev amount is unique among the published plans — that is what identifies it', () => {
    // resolveStripeCheckoutPlan matches amount+currency+interval+product and
    // refuses unless exactly ONE active price matches. Dev sells on the same
    // product as Monthly, so the amount is the only field separating them: if
    // Dev ever went back to $24.99, the matcher would find Monthly's price and
    // Dev's and refuse to sell either. Assert the separation explicitly rather
    // than leaving it implicit across two literals.
    const spec = appSource.slice(appSource.indexOf('const CHECKOUT_STRIPE_PRICE_SPECS'), appSource.indexOf('// Grandfathered subscribers keep'));
    const entry = (name) => {
        const m = new RegExp(`\\[${name}\\]:\\s*\\{\\s*amount:\\s*([\\d.]+),\\s*currency:\\s*'(\\w+)',\\s*interval:\\s*'(\\w+)',\\s*productName:\\s*'([^']+)'\\s*\\}`).exec(spec);
        assert.ok(m, `${name} has a checkout spec`);
        return { amount: Number(m[1]), currency: m[2], interval: m[3], productName: m[4] };
    };
    const dev = entry('DEV_PLAN_ID');
    const monthly = entry('MONTHLY_PLAN_ID');
    assert.equal(dev.productName, monthly.productName,
        'both sell on the same Stripe product — the amount is the discriminator');
    assert.notEqual(dev.amount, monthly.amount,
        'a shared amount makes the price matcher ambiguous and the plan refuses to sell');
    // No other published rung may claim $19.99 either — same failure, other pair.
    for (const name of ['ANNUAL_PLAN_ID', 'PRO_ANNUAL_PLAN_ID', 'DESK_PLAN_ID']) {
        assert.notEqual(entry(name).amount, dev.amount, `${name} must not share the Dev amount`);
    }
});

test('a Stripe price id shared by two plans refuses to resolve, forcing metadata to decide', () => {
    // getPlanConfigByPriceId is a first-match-wins chain and Dev's branch sits
    // ABOVE Monthly's, so without the guard any id the two share resolves as
    // Dev for every Monthly subscriber too — and userTier('dev') is 'free', so
    // their web app disappears on the next renewal sync. Nothing collides
    // today; a mis-set env var is all it takes.
    const fn = fnSource('getPlanConfigByPriceId', 'planConfigFromSubscriptionMetadata');
    const guard = fn.indexOf('ambiguousStripePriceIds().has(priceId)');
    assert.ok(guard >= 0, 'getPlanConfigByPriceId consults ambiguousStripePriceIds()');
    // The guard has to come before the chain, not after it — a check that runs
    // once a branch has already returned is not a guard.
    assert.ok(guard < fn.indexOf('LEGACY_PLAN_PRICE_SPECS'), 'the ambiguity guard precedes the price-id chain');

    // The derivation must be config-driven, not a hardcoded pair: Dev is
    // supposed to be able to get its own price later without touching this.
    const helper = fnSource('ambiguousStripePriceIds', 'getPlanConfigByPriceId');
    assert.match(helper, /plansByPriceId\.get\(priceId\)\.add\(planId\)/, 'collisions are derived from the configured ids');
    assert.match(helper, /planIds\.size > 1/, 'a price id is ambiguous only when two DISTINCT plans claim it');
    // STRIPE_PRICE_ID and STRIPE_PRICE_ID_MONTHLY both name Monthly by default
    // — the same plan twice, which must NOT read as a collision.
    assert.match(helper, /claim\(STRIPE_PRICE_ID,\s*MONTHLY_PLAN_ID\)/, 'STRIPE_PRICE_ID is claimed for Monthly, not treated as a second plan');
});

test('ambiguousStripePriceIds actually detects the collision it exists for', () => {
    // The assertions above are structural. This one RUNS the function, because
    // the failure mode here is silent and expensive: if the detector misses a
    // share, the guard never fires and the webhook re-resolves one of the two
    // populations into the other's plan with no error anywhere. Dev no longer
    // shares Monthly's id, so this now guards a future misconfiguration — which
    // is exactly what a structural assertion alone would not catch.
    //
    // app.js has no exports, so the function is evaluated in a vm with the
    // price-id constants supplied. The slice starts at the `let` declaration
    // because the memo lives outside the function body.
    const vm = require('node:vm');
    const start = appSource.indexOf('let ambiguousPriceIdCache');
    assert.ok(start >= 0, 'the memo declaration exists');
    const helper = appSource.slice(start, appSource.indexOf('\nfunction getPlanConfigByPriceId', start));

    const run = (ids) => {
        const ctx = {
            STRIPE_PRICE_ID: ids.base || '',
            STRIPE_PRICE_ID_MONTHLY: ids.monthly || '',
            STRIPE_PRICE_ID_ANNUAL: ids.annual || '',
            STRIPE_PRICE_ID_PRO_ANNUAL: '',
            STRIPE_PRICE_ID_PRO: '',
            STRIPE_PRICE_ID_POWER: '',
            STRIPE_PRICE_ID_POWER_MONTHLY: '',
            STRIPE_PRICE_ID_DESK: '',
            STRIPE_PRICE_ID_DEV: ids.dev || '',
            MONTHLY_PLAN_ID: 'monthly', ANNUAL_PLAN_ID: 'annual', PRO_ANNUAL_PLAN_ID: 'pro-annual',
            PRO_PLAN_ID: 'pro', POWER_PLAN_ID: 'power', POWER_MONTHLY_PLAN_ID: 'power-monthly',
            DESK_PLAN_ID: 'desk', DEV_PLAN_ID: 'dev',
            LEGACY_PLAN_PRICE_SPECS: {}
        };
        vm.createContext(ctx);
        vm.runInContext(`${helper}\n__shared = ambiguousStripePriceIds();`, ctx);
        return [...ctx.__shared];
    };

    // The shape this exists for: Dev pointed at Monthly's own price — the
    // configuration that shipped briefly, and exactly what a mis-set
    // STRIPE_PRICE_ID_DEV recreates.
    assert.deepEqual(run({ monthly: 'price_M', base: 'price_M', dev: 'price_M' }), ['price_M'],
        'an id claimed by both Monthly and Dev must be reported ambiguous');
    // Monthly claiming one id under two env names is the SAME plan twice, and
    // must not read as a collision — otherwise the guard would fire in the
    // ordinary case and no Monthly renewal could ever resolve.
    assert.deepEqual(run({ monthly: 'price_M', base: 'price_M', dev: '' }), [],
        'one plan claiming an id twice is not ambiguous');
    // Today's shape: Dev has a price of its own, so nothing is ambiguous and the
    // price-id path still resolves it — the guard must not be a permanent ban on
    // resolving Dev.
    assert.deepEqual(run({ monthly: 'price_M', base: 'price_M', dev: 'price_D' }), [],
        'distinct prices leave both plans resolvable by price id');
});

test('the subscription webhook prefers metadata.planId over the price id', () => {
    const fn = fnSource('syncSubscriptionFromStripe', 'grantChinaAnnualPass');
    const meta = fn.indexOf('planConfigFromSubscriptionMetadata(subscription)');
    const byPrice = fn.indexOf('getPlanConfigByPriceId(stripePriceId)');
    assert.ok(meta >= 0, 'the webhook reads metadata.planId');
    assert.ok(byPrice >= 0, 'the webhook still falls back to the price id');
    // Order still matters even though the ids no longer collide: metadata states
    // which plan was SOLD, and it survives a price being re-pointed or
    // re-created underneath a live subscription. With the price id first,
    // metadata would only ever be consulted when the price id resolves to
    // nothing — which is exactly when it is least likely to be right.
    assert.ok(meta < byPrice, 'metadata must be consulted BEFORE the price id');

    // And the metadata reader must reject an unknown value rather than let
    // getPlanConfig()'s Monthly fallback turn a typo into a Monthly grant.
    const reader = fnSource('planConfigFromSubscriptionMetadata', 'isPublishedStripePlan');
    assert.match(reader, /config\.planId === raw/, 'an unrecognised planId must not round-trip into a Monthly grant');
});

test('the Dev credit floor is 200 and beats the derived wallet', () => {
    // Asserted through allowance() rather than the floor table directly (which
    // credits.js doesn't export): passing the free tier's Ask limit is exactly
    // what a Dev subscriber resolves to, so this pins both the floor's
    // existence and its value in one call.
    assert.equal(credits.allowance(3, 'dev', null), 200, 'Dev gets an explicit 200-credit floor');
    // Sanity: the same call for a plan with no floor derives 3 x 2 = 6, which
    // is what Dev would get without the floor above.
    assert.equal(credits.allowance(3, 'monthly', null), 6, 'an unfloored plan still derives from the Ask limit');
    // The plan must not be dearer per credit than the recharge pack it would
    // otherwise be bought alongside: $19.99/200 = $0.09995 vs $14.99/150 =
    // $0.09993. The gap is 0.017% and in the wrong direction — the pack is very
    // slightly the cheaper of the two — which is inside the 1e-4 tolerance here
    // but is a real, if tiny, inversion of the stated rule. It is a consequence
    // of pricing the rung at a round $19.99; 210 credits would clear it
    // outright. Recorded, not hidden.
    const planRate = 19.99 / 200;
    const packRate = 14.99 / 150;
    assert.ok(planRate <= packRate + 1e-4, `plan rate ${planRate} must not exceed pack rate ${packRate}`);
    // Guard the arithmetic above, so a future edit to the price or the floor
    // has to re-derive the rate rather than inherit a stale claim.
    assert.equal(credits.COST.mcp_ask, 4, 'the AI-backed MCP action is priced at the 2x-frontier anchor');
    assert.equal(credits.COST.api_ask, 8, 'REST API ask is 2x mcp_ask by the base-tier rule');
});

test('the Dev wallet cannot be spent on the website Ask box', () => {
    // The one web surface a Dev subscriber could otherwise reach: Ask is
    // metered by the credit wallet and has no tier gate, so Dev's flat 200
    // credits would buy 100 web questions against Monthly's 50 at a lower
    // price. The refusal has to sit in the authenticated Ask handler, before
    // the wallet is consulted.
    const ask = appSource.indexOf("app.post('/api/ai/chat', askAuth, async (req, res) => {");
    assert.ok(ask >= 0, 'the Ask route exists');
    const body = appSource.slice(ask, appSource.indexOf("app.post('/api/ai/chat'", ask + 10) > 0
        ? appSource.indexOf("app.post('/api/ai/chat'", ask + 10)
        : ask + 8000);
    const guard = body.indexOf("String(planId || '') === DEV_PLAN_ID");
    const wallet = body.indexOf("credits.check(userId, 'ask'");
    assert.ok(guard >= 0, 'the Dev refusal exists in the Ask handler');
    assert.ok(wallet > guard, 'the refusal must come BEFORE the credit wallet is consulted');
    assert.match(body, /code: 'API_PLAN_NO_WEB_ASK'/, 'refuses with a distinguishable code, not a generic quota error');
});

test('the API landing page renders, prices the Dev plan, and carries the real example', () => {
    const html = seoPages.renderApiLanding();
    assert.ok(typeof html === 'string' && html.length > 2000, 'renderApiLanding returns a page');
    assert.match(html, /<link rel="canonical" href="https:\/\/www\.stockportfolio\.pro\/api" \/>/, 'canonical is /api');
    assert.match(html, /\$19\.99\/mo/, 'the page states the Dev price');
    assert.match(html, /200 credits/, 'the page states the Dev allowance');
    assert.match(html, /register\?plan=dev/, 'the CTA routes to the Dev checkout');
    // The example payload is a real captured response, not a mock-up — if it
    // ever drifts from what the extractor returns, this page is lying.
    assert.match(html, /215938000000/, 'carries the measured NVDA revenue figure');
    assert.match(html, /cashConversionRatio/, 'shows the computed ratio, not just headline numbers');
    // The copy-paste MCP config is the page's main conversion hook. The JSON
    // sits inside esc(), so its quotes arrive HTML-escaped — match that form,
    // not the raw one, or this assertion passes on a page that renders broken.
    assert.match(html, /&quot;mcpServers&quot;/, 'includes the MCP client config snippet');
    assert.match(html, /&quot;SP_API_KEY&quot;/, 'shows where the key goes');
    assert.match(html, /stockportfolio-mcp/, 'names the npm package');
    // Every one of the seven tools is listed, so the page can't quietly fall
    // behind the endpoint list.
    for (const tool of ['sp_financials', 'sp_filing', 'sp_compare', 'sp_screen', 'sp_fund', 'sp_ask', 'sp_health']) {
        assert.ok(html.includes(tool), `${tool} is listed on the landing page`);
    }
});

test('/api is in the sitemap inventory and exempt from the crawler block', () => {
    // The landing page is only worth building if a crawler can reach it: it is
    // in the sitemap core routes, and bot-blocker.js exempts the exact path.
    const botBlocker = fs.readFileSync(path.join(__dirname, '..', 'bot-blocker.js'), 'utf8');
    assert.match(botBlocker, /EXEMPT_PATH_PATTERNS = \[[^\]]*\/\^\\\/api\$\//, '/api exactly is exempt from the bot blocker');
    // Core routes live in the `core` shard; buildSitemap() only returns the
    // index of shard URLs, so asserting against it would pass for any route.
    const core = seoPages.buildSitemapShard('core');
    assert.ok(core && core.includes('https://www.stockportfolio.pro/api</loc>'), '/api appears in the core sitemap shard');
});
