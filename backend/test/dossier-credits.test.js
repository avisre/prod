'use strict';

// Structural checks against app.js's source text, the same convention
// test/monitor-credits.test.js uses and for the same reason: app.js is a single
// ~11K-line Express monolith that connects to Mongo and Stripe on require, so
// the live route can't be exercised here — but the exact source shape the
// charge-correctness reasoning depends on can be pinned, so a future edit that
// silently breaks one of these properties fails loudly here instead of showing
// up as a billing bug in production.
//
// The bug these exist to prevent: a customer built a Dossier for NTES, the build
// failed, and 10 credits were taken anyway because the spend ran BEFORE
// buildDossier rather than after it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const appSource = fs.readFileSync(require.resolve('../app'), 'utf8');

function dossierRouteBody() {
    const start = appSource.indexOf("app.get('/api/dossier/:symbol'");
    assert.ok(start !== -1, 'the Dossier route must still exist at this path');
    const end = appSource.indexOf('\napp.', start + 10);
    assert.ok(end !== -1 && end > start, 'could not find the end of the route');
    return appSource.slice(start, end);
}

test('the Dossier charge happens AFTER the build, never before it', () => {
    const route = dossierRouteBody();
    const spendCalls = route.match(/credits\.spend\(req\.userId, costKey/g) || [];
    assert.equal(spendCalls.length, 1, 'the charge must not be duplicated');

    const buildIdx = route.indexOf('dossier.buildDossier(sym');
    const spendIdx = route.indexOf('credits.spend(req.userId, costKey');
    assert.ok(buildIdx !== -1 && spendIdx !== -1);
    assert.ok(
        spendIdx > buildIdx,
        'the spend must follow buildDossier — charging first bills every failed build, which is the NTES bug'
    );

    // The credit CHECK, by contrast, must still run first: it refuses an
    // unaffordable request before any expensive work happens.
    const checkIdx = route.indexOf('credits.check(req.userId, costKey');
    assert.ok(checkIdx !== -1 && checkIdx < buildIdx, 'the affordability check must still precede the build');
});

test('the charge is gated on a dossier this build actually delivered', () => {
    const route = dossierRouteBody();
    const spendIdx = route.indexOf('credits.spend(req.userId, costKey');
    const guardWindow = route.slice(Math.max(0, spendIdx - 400), spendIdx);

    assert.match(guardWindow, /!result\.error/, 'an unsupported ticker, timeout or thrown error must not charge');
    assert.match(guardWindow, /result\.cached !== true/, 'a cache hit was already paid for once and must not charge again');
    assert.match(
        guardWindow,
        /result\.status !== 'building'/,
        "'building' means another worker holds the cross-process lease and will pay; this caller gets a 202 and polls for free"
    );
});

test('costKey is in scope at the spend site', () => {
    // Regression guard for a specific, silent failure mode. costKey used to be
    // declared inside `if (!force) { … }`. Moving the spend after the build
    // while leaving it there throws a ReferenceError, which the route's own
    // .catch converts into { error: "Couldn't build…" } → HTTP 404 — making
    // EVERY dossier appear to fail while nobody is ever charged, after the
    // payload was already cached.
    const route = dossierRouteBody();
    const declIdx = route.indexOf('const costKey =');
    const wrapperIdx = route.indexOf('build = (async () =>');
    const spendIdx = route.indexOf('credits.spend(req.userId, costKey');

    assert.ok(declIdx !== -1, 'costKey must still be declared in this route');
    assert.ok(
        declIdx < wrapperIdx,
        'costKey must be hoisted ABOVE the async build wrapper so it is in scope at the post-build spend'
    );
    assert.ok(declIdx < spendIdx);
});

test('the charge rides the build promise, not the fast-path race', () => {
    // A cold build routinely outlives DOSSIER_FAST_MS (9s). The route then
    // returns 202 and the result is only ever observed again via ?poll=1,
    // which never charges. If the spend lived after Promise.race instead of
    // inside the build promise, every slow build would go unbilled.
    const route = dossierRouteBody();
    const spendIdx = route.indexOf('credits.spend(req.userId, costKey');
    const raceIdx = route.indexOf('Promise.race([build');
    const inflightSetIdx = route.indexOf('_dossierInflight.set(inflightKey, build)');

    assert.ok(spendIdx !== -1 && raceIdx !== -1 && inflightSetIdx !== -1);
    assert.ok(spendIdx < raceIdx, 'the charge must resolve as part of `build` itself');
    assert.ok(
        spendIdx < inflightSetIdx,
        'and inside the same closure that claims the in-flight slot synchronously, so two concurrent requests cannot both charge'
    );
});

test('polling never charges', () => {
    const route = dossierRouteBody();
    const pollStart = route.indexOf("req.query.poll === '1'");
    assert.ok(pollStart !== -1);
    const pollEnd = route.indexOf('}\n\n', pollStart);
    const pollBranch = route.slice(pollStart, pollEnd);
    assert.ok(!/credits\.spend/.test(pollBranch), 'polling for a dossier must stay free — it cannot trigger new work');
});

test('concurrent builds reserve credits, and release only after the spend', () => {
    // Moving the spend after the build stretches the check→spend gap from one
    // Mongo round trip to the length of a whole build. credits.spend is an
    // unconditional insert that never re-reads the balance, and only
    // same-symbol requests coalesce — so without a reservation a user with 10
    // credits could open N tabs on N different tickers, pass every check
    // against the same stale balance, and overdraft by (N-1) x cost.
    const route = dossierRouteBody();
    const reserveIdx = route.indexOf('reserveCredits(req.userId');
    const buildIdx = route.indexOf('dossier.buildDossier(sym');
    const spendIdx = route.indexOf('credits.spend(req.userId, costKey');
    const releaseIdx = route.indexOf('releaseCredits(req.userId');

    assert.ok(reserveIdx !== -1, 'a passing check must reserve the cost for the duration of the build');
    assert.ok(reserveIdx < buildIdx, 'the reservation must be taken before the build starts');
    assert.match(route, /reservedCredits\(req\.userId\)/, 'the check must subtract credits already committed to in-flight builds');

    assert.ok(releaseIdx !== -1, 'the reservation must always be released');
    assert.ok(
        releaseIdx > spendIdx,
        'release must follow the spend: the other order lets a concurrent request see the reservation gone while the ledger row does not yet exist'
    );
    assert.match(route, /finally\s*\{[\s\S]{0,400}releaseCredits/, 'release must sit in a finally so a failed build cannot leak a reservation');
});
