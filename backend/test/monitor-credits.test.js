'use strict';

// app.js is a single ~8800-line Express monolith that connects to Mongo,
// Stripe, etc. on require — this repo's own convention for verifying route
// logic that isn't worth booting the whole server for is a structural check
// against the source text (see test/paid-first-signup.test.js). That's what
// this file does for the Monitor credit charge: it can't exercise the live
// route, but it can pin down the exact source shape the charge-correctness
// reasoning in the implementation plan depends on, so a future edit that
// silently breaks one of these properties fails loudly here instead of
// showing up as a billing bug in production.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const appSource = fs.readFileSync(require.resolve('../app'), 'utf8');
const dossierSource = fs.readFileSync(require.resolve('../dossier'), 'utf8');
const filingMonitorSource = fs.readFileSync(require.resolve('../filing-monitor'), 'utf8');

// Isolate just the /api/filings/:symbol/report route body so assertions
// about ordering can't accidentally match unrelated code elsewhere in the
// 8800-line file.
function monitorRouteBody() {
    const start = appSource.indexOf("app.get('/api/filings/:symbol/report'");
    assert.ok(start !== -1, 'the Monitor report route must still exist at this path');
    // Next top-level route registration after it marks the end of this one.
    const end = appSource.indexOf("\napp.", start + 10);
    assert.ok(end !== -1 && end > start, 'could not find the end of the route');
    return appSource.slice(start, end);
}

test('Monitor charge appears exactly once, only in the non-poll build path', () => {
    const route = monitorRouteBody();
    const spendCalls = route.match(/credits\.spend\(req\.userId, 'monitor'/g) || [];
    assert.equal(spendCalls.length, 1, 'the charge must not be duplicated');

    // The poll branch (`?poll=1`) must return before any credit spend — it
    // is documented as free (a pure cache read via peekReport) and must stay
    // that way. Confirm the poll branch's own text contains no spend call.
    const pollStart = route.indexOf("req.query.poll === '1'");
    const pollEnd = route.indexOf('}\n\n', pollStart); // end of that if-block
    const pollBranch = route.slice(pollStart, pollEnd);
    assert.ok(!/credits\.spend/.test(pollBranch), 'polling for a report must never charge');
});

test('the Monitor charge is gated on paid + real work, not a cache hit or an error', () => {
    const route = monitorRouteBody();
    const spendIdx = route.indexOf("credits.spend(req.userId, 'monitor'");
    assert.ok(spendIdx !== -1);
    const guardWindow = route.slice(Math.max(0, spendIdx - 300), spendIdx);

    assert.match(guardWindow, /\bpaid\b/, 'must check the Power/Desk paid flag — free-allowance visitors must not be charged');
    assert.match(guardWindow, /req\.userId/, 'must check a real user id — never charge an anonymous/free request');
    assert.match(guardWindow, /!result\.error/, 'a failed build (typo/invalid ticker, SEC unreachable) must not charge');
    assert.match(guardWindow, /result\.cached !== true/, 'a cache hit — including one served by a slow build the caller already timed out past — must not charge');
});

test('the charge sits inside the atomic build-registration wrapper, not after the fast-path race', () => {
    const route = monitorRouteBody();
    // filingMonitor.buildReport can run for minutes; MONITOR_FAST_MS (9s) is
    // how long the route waits before returning {status:'building'} and
    // leaving the rest to polling. If the charge lived after that race
    // (`Promise.race([build, ...])`) instead of inside the build promise
    // itself, any build slower than 9s would return PENDING to its
    // originating request and then only ever be observed again via
    // ?poll=1 — which the test above confirms never charges. That combination
    // would mean slow builds are never billed at all. Pin the charge to
    // appear BEFORE the Promise.race, i.e. inside the async wrapper that
    // becomes `build`.
    const spendIdx = route.indexOf("credits.spend(req.userId, 'monitor'");
    const raceIdx = route.indexOf('Promise.race([build');
    assert.ok(spendIdx !== -1 && raceIdx !== -1);
    assert.ok(spendIdx < raceIdx, 'the charge must resolve as part of `build` itself, before the fast-path race against it');

    // And it must sit inside the same closure that registers `build` in
    // _monitorInflight synchronously (no `await` in between claiming the
    // slot and starting it) — otherwise two concurrent requests for the same
    // brand-new symbol could both slip past the dedup and double-charge, the
    // same race already fixed once for the Dossier credit gate.
    const inflightSetIdx = route.indexOf('_monitorInflight.set(sym, build)');
    assert.ok(inflightSetIdx !== -1 && spendIdx < inflightSetIdx);
});

test("a Dossier build's embedded Monitor report does not go through the charged route", () => {
    // dossier.js calls filingMonitor.buildReport() directly as one of its
    // parallel fetches — bypassing app.js's /api/filings/:symbol/report
    // route (and its credit charge) entirely. Confirm both sides of that:
    // dossier.js calls the module function, not the HTTP route, and
    // filing-monitor.js itself never touches the credits module (metering
    // for Monitor belongs solely at the route that serves a direct user
    // request, not in the shared builder background sweeps also call).
    assert.match(dossierSource, /filingMonitor\.buildReport\(sym\)/, 'dossier.js should still call the builder directly');
    assert.ok(!/require\(.\.\/credits.\)/.test(filingMonitorSource), 'filing-monitor.js must stay unaware of credits — charging happens once, at the route');
});
