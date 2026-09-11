'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const credits = require('../credits');

const ROOT = path.join(__dirname, '..', '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// The AppSumo listing publishes numbers. Production has to be able to honour them,
// and nothing in the deploy pipeline reads the marketplace page — so these are the
// checks that stand between a copy edit and a false claim on a storefront.
//
// This exists because listing v4 was drafted saying "100 credits, an Ask costs 2"
// (= 50 Asks on Starter) while backend/app.js still hard-stopped Ask at 30. Credits
// were debited for Ask but never gated it: the wallet was advertised, the counter
// was enforced, and the two never agreed.

// The per-tier Ask floor. Mirrors the appsumoTier -> appsumoAiCap mapping documented
// at backend/app.js (User schema) and applied by effectiveAskLimit().
const ASK_FLOOR = { 1: 30, 2: 100, 3: 300 };

test('every tier keeps its Ask floor, whichever wallet it holds', () => {
    // Under the OR-gate, reachable Asks = max(per-tier floor, wallet / cost).
    // V1 wallets exceed the floor; V2 wallets are deliberately smaller than it,
    // which is exactly why the floor has to stay: halving the wallet must not
    // quietly halve the questions a buyer was sold.
    for (const tier of [1, 2, 3]) {
        for (const [label, table] of [['V1', credits.LTD_CREDIT_ALLOWANCE], ['V2', credits.LTD_CREDIT_ALLOWANCE_V2]]) {
            const reachable = Math.max(ASK_FLOOR[tier], Math.floor(table[tier] / credits.COST.ask));
            assert.ok(
                reachable >= ASK_FLOOR[tier],
                `${label} tier ${tier}: only ${reachable} Asks reachable, floor is ${ASK_FLOOR[tier]}`
            );
        }
    }
});

test('halving the wallet reaches new buyers only', () => {
    const CUTOVER = '2026-09-10T00:00:00Z';
    const before = { appsumoTier: 3, appsumoRedeemedAt: '2026-08-20T00:00:00Z' };
    const after = { appsumoTier: 3, appsumoRedeemedAt: '2026-09-20T00:00:00Z' };
    const envOn = { CREDIT_ALLOWANCE_V2_EFFECTIVE_FROM: CUTOVER };

    // Cutover unset: nobody is on V2, however recently they redeemed.
    assert.equal(credits.ltdAllowance(after, {}), credits.LTD_CREDIT_ALLOWANCE[3]);

    // Cutover set: the grandfather line holds in both directions.
    assert.equal(credits.ltdAllowance(before, envOn), credits.LTD_CREDIT_ALLOWANCE[3], 'pre-cutover buyer keeps V1');
    assert.equal(credits.ltdAllowance(after, envOn), credits.LTD_CREDIT_ALLOWANCE_V2[3], 'post-cutover buyer gets V2');

    // A bare tier carries no redemption date, so it can never be classified into
    // the smaller wallet — an unclassifiable account keeps the larger one.
    assert.equal(credits.ltdAllowance(3, envOn), credits.LTD_CREDIT_ALLOWANCE[3], 'bare tier fails closed to V1');

    // An unparseable cutover meters nobody.
    assert.equal(credits.ltdAllowance(after, { CREDIT_ALLOWANCE_V2_EFFECTIVE_FROM: 'soon' }), credits.LTD_CREDIT_ALLOWANCE[3]);

    // And V2 really is half of V1, which is the whole point of the round.
    for (const tier of [1, 2, 3]) {
        assert.equal(credits.LTD_CREDIT_ALLOWANCE_V2[tier] * 2, credits.LTD_CREDIT_ALLOWANCE[tier], `tier ${tier} is half`);
    }
});

test('the Ask route gates on the wallet OR the floor, never the floor alone', () => {
    const src = read('backend/app.js');

    // The OR-gate itself. `used >= limit` on its own is the pre-relist behaviour that
    // made the credit table a lie; if someone restores it, this fails.
    // assert.ok, not assert.match: a failing match on a 700KB source file dumps
    // the whole thing into the test output.
    assert.ok(
        /if \(!gate\.ok && used >= limit\) \{/.test(src),
        'Ask must refuse only when the wallet cannot pay AND the per-tier floor is spent'
    );
    assert.ok(
        /credits\.check\(userId, 'ask', limit, planId, req\.user\)/.test(src),
        'the Ask gate must consult the credit wallet, passing the user so the cohort is readable'
    );

    // The floor must survive. Deleting effectiveAskLimit would narrow a lifetime
    // entitlement: a buyer who spends the wallet on Dossiers keeps their Asks.
    assert.ok(/const limit = effectiveAskLimit\(req\);/.test(src));

    // The AppSumo upgrade link on the 429 is load-bearing revenue surface — it is the
    // path a Tier 1 buyer took to Tier 2 on 4 Sep. It must not be refactored away.
    assert.ok(/resp\.appsumo = \{ isAppSumo: true, tier: asTier, upgradeUrl \};/.test(src));
});

test('the published listing matches credits.js exactly', () => {
    const listing = read('docs/growth/appsumo-listing-v6.md');
    const { COST, LTD_CREDIT_ALLOWANCE_V2: WALLET } = credits;

    // The wallet row.
    const walletRow = `| **AI credits per month** | **${WALLET[1]}** | **${WALLET[2]}** | **${WALLET[3]}** |`;
    assert.ok(listing.includes(walletRow), `listing must publish the real wallet: ${walletRow}`);

    // The two "what that buys" rows are derived, so they cannot be edited by hand
    // into something the meter does not deliver.
    const dossiers = [1, 2, 3].map((t) => Math.floor(WALLET[t] / COST.dossier_standard));
    const monitors = [1, 2, 3].map((t) => Math.floor(WALLET[t] / COST.monitor));
    assert.ok(
        listing.includes(`| Research Dossiers, if you spent it all there | ${dossiers.join(' | ')} |`),
        `dossier row must read ${dossiers.join(' / ')}`
    );
    assert.ok(
        listing.includes(`| or Filing Monitor reports | ${monitors.join(' | ')} |`),
        `monitor row must read ${monitors.join(' / ')}`
    );

    // The per-action cost table.
    for (const [label, key] of [
        ['Research Dossier', 'dossier_standard'],
        ['Filing Monitor report', 'monitor'],
        ['Compare two dossiers', 'dossier_compare'],
        ['Ask a follow-up question', 'ask'],
        // The programmatic surfaces. Listed here for the same reason as the four above:
        // the listing publishes a price, so production has to charge that price.
        ['MCP lookup', 'mcp_lookup'],
        ['MCP ask', 'mcp_ask'],
        ['REST API lookup', 'api_lookup'],
        ['REST API ask', 'api_ask']
    ]) {
        assert.ok(
            listing.includes(`| ${label} | ${COST[key]} |`),
            `cost table must price ${label} at ${COST[key]}`
        );
    }

    // The worked example has to add up, or it teaches the buyer the wrong arithmetic.
    const worked = 8 * COST.dossier_standard + 10 * COST.monitor + 10 * COST.ask;
    assert.equal(worked, WALLET[2], 'the "typical Investor month" must total the Investor wallet');
});

test('the listing never prices something the UI cannot invoke', () => {
    const listing = read('docs/growth/appsumo-listing-v6.md');
    const dossierJs = read('frontend-v2/assets/dossier.js');

    // Deep Dossier is priced in credits.js but has no control in the UI — ?depth=deep
    // is URL-only. Sell it only once a buyer can click it.
    const uiCanRunDeep = /depth=deep|depth: *'deep'|depth', *'deep'/.test(dossierJs);
    const listingSellsDeep = /\| Deep Dossier \| \d+ \|/.test(listing);
    assert.ok(
        !listingSellsDeep || uiCanRunDeep,
        'the listing prices Deep Dossier, but frontend-v2/assets/dossier.js never requests it'
    );
});

test('the listing publishes the Monitor caps the landing page already advertises', () => {
    // Only the copy is policed, not the "what changed vs v4" table below it, which
    // quotes the old line on purpose.
    const listing = read('docs/growth/appsumo-listing-v6.md').split('## Before this is submitted')[0];

    // "Unlimited companies" was v4's most dangerous line: no tier grants unlimited
    // monitoring, and a published lifetime promise cannot be narrowed afterwards.
    assert.ok(
        !/[Uu]nlimited companies/.test(listing),
        'the Monitor caps companies — do not publish "unlimited companies"'
    );
    assert.ok(
        listing.includes('| Companies watched by the Monitor | 1 | 4 | 8 |'),
        'the listing must publish the 1 / 4 / 8 Monitor ladder'
    );
});

test('the paste-ready .txt is in sync with the listing markdown', () => {
    // The .txt is what actually gets pasted into the portal, but only the .md is
    // guarded by the price checks above. If it is allowed to go stale, the copy
    // that reaches a buyer can quote prices production no longer charges — the
    // whole failure this file exists to prevent, one file further downstream.
    const { execFileSync } = require('child_process');
    const script = path.join(ROOT, 'scripts/render-appsumo-listing.js');
    const fresh = execFileSync(process.execPath, [script, '--stdout'], { encoding: 'utf8' });
    const onDisk = read('docs/growth/appsumo-listing-v6.txt');

    // The generated header carries today's date; everything else must match.
    const undated = (s) => s.replace(/^Generated from .* on \d{4}-\d{2}-\d{2}\.$/m, 'Generated.');
    assert.equal(
        undated(onDisk),
        undated(fresh),
        'docs/growth/appsumo-listing-v6.txt is stale — re-run: node scripts/render-appsumo-listing.js'
    );
});

test('the listing never advertises a fund endpoint', () => {
    // Only the copy is policed. The rationale below the marker names these routes on
    // purpose, to explain why they are withheld.
    const listing = read('docs/growth/appsumo-listing-v6.md').split('## Before this is submitted')[0];

    // backend/public-api.md labels the fund profile route "Yahoo-derived, not
    // redistributable", and corpus-license-terms.md says the same of quote-derived data
    // generally. An AppSumo licence is permanent and cannot be narrowed afterwards — v4's
    // "unlimited companies" is the standing precedent — so the advertised surface is the
    // SEC-derived one only. The endpoint itself stays available to signed-in web users.
    for (const route of ['sp_fund', '/api/v1/fund']) {
        assert.ok(
            !listing.includes(route),
            `the listing must not advertise ${route} — we hold no redistribution rights to it`
        );
    }
});
