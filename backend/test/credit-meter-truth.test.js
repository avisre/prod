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

test('an LTD buyer can actually spend their whole advertised wallet on Asks', () => {
    for (const tier of [1, 2, 3]) {
        const wallet = credits.LTD_CREDIT_ALLOWANCE[tier];
        const advertised = Math.floor(wallet / credits.COST.ask);
        assert.ok(
            advertised >= ASK_FLOOR[tier],
            `tier ${tier}: the listing implies ${advertised} Asks but the floor is ${ASK_FLOOR[tier]}`
        );
    }
});

test('the Ask route gates on the wallet OR the floor, never the floor alone', () => {
    const src = read('backend/app.js');

    // The OR-gate itself. `used >= limit` on its own is the pre-relist behaviour that
    // made the credit table a lie; if someone restores it, this fails.
    assert.match(
        src,
        /if \(!gate\.ok && used >= limit\) \{/,
        'Ask must refuse only when the wallet cannot pay AND the per-tier floor is spent'
    );
    assert.match(
        src,
        /credits\.check\(userId, 'ask', limit, planId, req\.user && req\.user\.appsumoTier\)/,
        'the Ask gate must consult the credit wallet'
    );

    // The floor must survive. Deleting effectiveAskLimit would narrow a lifetime
    // entitlement: a buyer who spends the wallet on Dossiers keeps their Asks.
    assert.match(src, /const limit = effectiveAskLimit\(req\);/);

    // The AppSumo upgrade link on the 429 is load-bearing revenue surface — it is the
    // path a Tier 1 buyer took to Tier 2 on 4 Sep. It must not be refactored away.
    assert.match(src, /resp\.appsumo = \{ isAppSumo: true, tier: asTier, upgradeUrl \};/);
});

test('the published listing matches credits.js exactly', () => {
    const listing = read('docs/growth/appsumo-listing-v5.md');
    const { COST, LTD_CREDIT_ALLOWANCE: WALLET } = credits;

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
        ['Ask a follow-up question', 'ask']
    ]) {
        assert.ok(
            listing.includes(`| ${label} | ${COST[key]} |`),
            `cost table must price ${label} at ${COST[key]}`
        );
    }

    // The worked example has to add up, or it teaches the buyer the wrong arithmetic.
    const worked = 15 * COST.dossier_standard + 20 * COST.monitor + 25 * COST.ask;
    assert.equal(worked, WALLET[2], 'the "typical Investor month" must total the Investor wallet');
});

test('the listing never prices something the UI cannot invoke', () => {
    const listing = read('docs/growth/appsumo-listing-v5.md');
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
    const listing = read('docs/growth/appsumo-listing-v5.md').split('## Before this is submitted')[0];

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
