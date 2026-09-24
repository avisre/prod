'use strict';

// Pins the quiet state of the filing monitor.
//
// Why this file exists: the alerts section used to hide itself entirely when
// there was nothing to report, which made a working monitor indistinguishable
// from a broken one. The fix is to say what the sweep is actually doing — but
// that only holds up if every fact printed is measured. So the rules pinned
// here are: the watch count comes from the user's own non-fund holdings, the
// forms named are the forms actually watched, and "read recently" uses the
// OLDEST read across the set, which is the weakest claim and therefore the only
// one the whole set supports.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require('mongoose');

const HOLDINGS = [
    { symbol: 'AAPL' }, { symbol: 'aapl' }, { symbol: 'KO' }, { symbol: 'VTSAX', assetType: 'mutual_fund' }
];

let holdings = HOLDINGS;
let stateRows = [];
let lastAlert = null;
let lastQuery = null;

// The models watchdog reaches for at call time, stubbed so this is a unit test
// of the facts rather than a database test. The stub applies the same
// assetType exclusion the real query does — a stub that returned funds would
// make the test pass or fail on the stub's rules rather than the code's.
const FUND_TYPES = ['etf', 'mutual_fund', 'crypto'];
mongoose.models.Stock = {
    find: (query) => {
        lastQuery = query;
        return { lean: async () => holdings.filter((h) => !FUND_TYPES.includes(h.assetType)) };
    }
};
const watchdog = require('../watchdog');
watchdog.WatchState.find = () => ({ lean: async () => stateRows });
watchdog.Alert.findOne = () => ({ sort: () => ({ select: () => ({ lean: async () => lastAlert }) }) });

const HOURS = 3600 * 1000;

test('the watch count is the user\'s own companies, counted once each', async () => {
    stateRows = [{ symbol: 'AAPL', filingsCheckedAt: new Date() }, { symbol: 'KO', filingsCheckedAt: new Date() }];
    const q = await watchdog.quietFacts('u1');
    // AAPL, aapl and KO are three rows and two distinct symbols; VTSAX is a
    // fund and is not a company the sweep watches for filings.
    assert.equal(q.watched, 2, 'duplicate holdings of one ticker are one company');
    assert.equal(lastQuery.user, 'u1', 'the count must be scoped to this user\'s portfolio');
});

test('the quiet count watches exactly what the sweep watches', () => {
    // The reassurance is only true if the number shown is the number scanned.
    // If one list gains a type and the other doesn't, this fails.
    const src = fs.readFileSync(path.join(__dirname, '..', 'watchdog.js'), 'utf8');
    const exclusions = [...src.matchAll(/assetType: \{ \$nin: \[([^\]]+)\] \}/g)].map((m) => m[1].replace(/\s/g, ''));
    assert.ok(exclusions.length >= 2, 'expected the sweep and the quiet facts to each state an exclusion');
    assert.equal(new Set(exclusions).size, 1, `the sweep and the quiet count disagree: ${exclusions.join(' vs ')}`);
});

test('it names only the forms the sweep actually watches', async () => {
    const q = await watchdog.quietFacts('u1');
    for (const form of q.forms) {
        assert.ok(['10-K', '10-Q', '8-K', '10-K/A', '10-Q/A', '20-F', '20-F/A', '40-F', '6-K'].includes(form),
            `${form} is named in the UI but is not in WATCH_FORMS`);
    }
    assert.ok(q.forms.includes('20-F'), 'foreign filers must not be promised a 10-Q');
    assert.ok(q.forms.includes('10-K'));
});

test('"read recently" uses the oldest read, not the newest', async () => {
    const old = new Date(Date.now() - 30 * HOURS);
    const recent = new Date(Date.now() - 1 * HOURS);
    stateRows = [{ symbol: 'AAPL', filingsCheckedAt: recent }, { symbol: 'KO', filingsCheckedAt: old }];
    const q = await watchdog.quietFacts('u1');
    assert.equal(new Date(q.checkedAt).getTime(), old.getTime(), 'the claim must hold for every symbol');
    assert.equal(new Date(q.checkedThrough).getTime(), recent.getTime());
});

test('a symbol that has never been read makes no freshness claim at all', async () => {
    // A symbol seeded but not yet checked has filingsCheckedAt null. Saying
    // "read in the last N hours" then would be a claim about nothing.
    stateRows = [{ symbol: 'AAPL', filingsCheckedAt: null }];
    const q = await watchdog.quietFacts('u1');
    assert.equal(q.checkedAt, null);
    assert.equal(q.checkedThrough, null);
});

test('a portfolio of funds only has nothing to report', async () => {
    const before = holdings;
    holdings = [{ symbol: 'VTSAX', assetType: 'mutual_fund' }];
    const q = await watchdog.quietFacts('u1');
    holdings = before;
    assert.equal(q.watched, 0, 'funds are not watched for company filings');
    assert.equal(q.checkedAt, null, 'and no read is claimed for a set that is empty');
});

test('the last alert time is the real one, and absent when there is none', async () => {
    const when = new Date(Date.now() - 5 * 24 * HOURS);
    lastAlert = { createdAt: when };
    stateRows = [{ symbol: 'AAPL', filingsCheckedAt: new Date() }];
    let q = await watchdog.quietFacts('u1');
    assert.equal(new Date(q.lastAlertAt).getTime(), when.getTime());
    lastAlert = null;
    q = await watchdog.quietFacts('u1');
    assert.equal(q.lastAlertAt, null, 'no alert must be null, not a fabricated date');
});

test('listAlerts carries the quiet facts alongside the alerts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'watchdog.js'), 'utf8');
    assert.match(src, /return \{ alerts, unseen, quiet: await quietFacts\(userId\) \};/);
});

test('the dashboard states the quiet case instead of hiding the section', () => {
    const js = fs.readFileSync(path.join(__dirname, '../../frontend-v2/assets/dashboard.js'), 'utf8');
    const html = fs.readFileSync(path.join(__dirname, '../../frontend-v2/dashboard.html'), 'utf8');
    assert.match(js, /function renderQuiet\(q\)/, 'the quiet renderer must exist');
    // The old early-exit is what made silence indistinguishable from a fault.
    assert.doesNotMatch(js, /const alerts = \(data\.alerts \|\| \[\]\)\.slice\(0, 8\);\n\s*if \(!alerts\.length\) return;/,
        'an empty alert list must no longer hide the section outright');
    assert.match(js, /if \(!renderQuiet\(data\.quiet\)\) return;/);
    assert.match(js, /This is the normal case\. It is also the good case\./);
    assert.match(html, /\.quiet-card/);
    // Nothing in the quiet copy promises a future outcome.
    assert.doesNotMatch(js, /quiet-close[\s\S]{0,200}(recover|will rise|going to)/i);
});

test('the quiet copy makes no claim about a portfolio with nothing watched', () => {
    const js = fs.readFileSync(path.join(__dirname, '../../frontend-v2/assets/dashboard.js'), 'utf8');
    const fn = js.slice(js.indexOf('function renderQuiet(q)'), js.indexOf('async function loadAlerts()'));
    assert.match(fn, /if \(!q \|\| !q\.watched\) return false;/, 'no watch list, no reassuring copy');
});
