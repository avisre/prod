'use strict';

// Pins "Since you bought" — the panel that reflects the user's own purchase
// history back at them.
//
// Why this file exists: the product stores a purchase date the user can enter
// and never once showed it back. The whole value of the feature rests on one
// property — the duration shown is the user's own date and nothing else. The
// saved-at timestamp is our clock; a duration derived from it would be the
// product claiming a memory the user never gave it. For years the backend
// also wrote the add day into purchaseDate when no date was given, which is
// the same lie one layer down, so the rules pinned here are: a duration only
// ever comes from a purchase date that is provably the user's, and a holding
// without one is counted and disclosed rather than estimated.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FRONTEND = path.join(__dirname, '../../frontend-v2');
const dashboardJs = fs.readFileSync(path.join(FRONTEND, 'assets/dashboard.js'), 'utf8');
const dashboardHtml = fs.readFileSync(path.join(FRONTEND, 'dashboard.html'), 'utf8');
const appJs = fs.readFileSync(path.join(FRONTEND, 'assets/app.js'), 'utf8');

function sliceFn(source, signature, indent = '    ') {
    const start = source.indexOf(signature);
    assert.ok(start !== -1, `could not find ${signature}`);
    const end = source.indexOf(`\n${indent}}\n`, start);
    assert.ok(end !== -1, `could not find the end of ${signature}`);
    return source.slice(start, end + indent.length + 2);
}

// Real `heldLabel`, lifted out of app.js — the unit of the product's memory.
const heldLabel = new Function(`${sliceFn(appJs, 'function heldLabel(days) {', '    ')}
    return heldLabel;`)();

// Real `renderSinceBought`, lifted out of dashboard.js and run against stubs, so
// this asserts what the panel actually draws rather than the shape of the text.
function render(rows) {
    const nodes = { 'since-section': { hidden: true }, 'since-body': { innerHTML: '' } };
    const fn = sliceFn(dashboardJs, 'function renderSinceBought(rows) {');
    const call = new Function('$', 'esc', 'fixed', 'heldLabel', 'DEMO', `${fn}
        return renderSinceBought;`)(
        (id) => nodes[id] || null,
        (s) => String(s == null ? '' : s),
        (n, d) => Number(n).toFixed(d),
        heldLabel,
        false
    );
    call(rows);
    return { hidden: nodes['since-section'].hidden, html: nodes['since-body'].innerHTML };
}

const daysAgo = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

test('a duration is only ever read from the purchase date the user gave', () => {
    // A holding saved today but bought three years ago must read "3 years".
    // If the panel fell back to a saved-at timestamp this would say "under a
    // month", and the one thing the feature exists to show would be wrong.
    const { html } = render([
        { symbol: 'KO', name: 'Coca-Cola', purchaseDate: daysAgo(365 * 3 + 60), gain: 4.9, paid: 58.2, price: 61.05 }
    ]);
    assert.match(html, /3 years, 2 months/);
});

test('a holding with no purchase date is disclosed, never given a duration', () => {
    const { html } = render([
        { symbol: 'AAPL', name: 'Apple', purchaseDate: daysAgo(400), gain: 53.7, paid: 142.1, price: 218.4 },
        { symbol: 'MSFT', name: 'Microsoft', purchaseDate: null, gain: 12.0, paid: 300, price: 336 },
        { symbol: 'KO', name: 'Coca-Cola', purchaseDate: 'not a date', gain: 4.9, paid: 58.2, price: 61.05 }
    ]);
    assert.match(html, /2 of 3 have no purchase date of yours to show/, 'undated holdings must be counted out loud');
    assert.doesNotMatch(html, /MSFT/, 'an undated holding must not be given a row with an invented duration');
    assert.doesNotMatch(html, /under a month\s*<\/span>\s*<span class="since-delta[^>]*>—?12/, 'no MSFT row');
});

test('with no dated holding at all the section is hidden, not emptied', () => {
    const { hidden, html } = render([{ symbol: 'MSFT', purchaseDate: null, gain: 1, paid: 1, price: 1 }]);
    assert.equal(hidden, true);
    assert.equal(html, '');
});

test('an empty portfolio hides it too', () => {
    const { hidden } = render([]);
    assert.equal(hidden, true);
});

test('a holding added today reads "under a month", not "0 years, 0 months"', () => {
    const { html } = render([{ symbol: 'AAPL', name: 'Apple', purchaseDate: daysAgo(0), gain: 0, paid: 100, price: 100 }]);
    assert.match(html, /under a month/);
    assert.doesNotMatch(html, /0 years|0 months|, ,/);
});

test('a future date is dropped rather than shown as a negative duration', () => {
    const { hidden } = render([{ symbol: 'AAPL', purchaseDate: daysAgo(-30), gain: 1, paid: 1, price: 1 }]);
    assert.equal(hidden, true);
});

test('the total counts only the holdings it can actually count', () => {
    // Two dated holdings of 1 year each = 2 years in total. The undated one adds
    // nothing to the total and is named as excluded.
    const { html } = render([
        { symbol: 'A', purchaseDate: daysAgo(365), gain: 1, paid: 1, price: 1 },
        { symbol: 'B', purchaseDate: daysAgo(365), gain: 1, paid: 1, price: 1 },
        { symbol: 'C', purchaseDate: null, gain: 1, paid: 1, price: 1 }
    ]);
    assert.match(html, /held these positions for <strong>2 years<\/strong> in total/);
});

test('heldLabel is empty below a month and reads in years and months above it', () => {
    assert.equal(heldLabel(0), '', 'a holding added today is not "held for 0"');
    assert.equal(heldLabel(29), '');
    assert.equal(heldLabel(30), '1 month');
    assert.equal(heldLabel(365), '1 year');
    assert.equal(heldLabel(365 * 3 + 60), '3 years, 2 months');
    assert.equal(heldLabel(365 * 2 + 30), '2 years, 1 month');
});

test('holdingToRow carries purchaseDate off the stored holding, not a saved-at stamp', () => {
    const row = sliceFn(dashboardJs, 'function holdingToRow(h) {');
    assert.match(row, /purchaseDate: userDatedPurchase\(h\)/);
    for (const forbidden of ['createdAt', 'updatedAt', 'savedAt', 'Date.now()']) {
        assert.ok(!row.includes(forbidden), `holdingToRow must not derive a duration from ${forbidden}`);
    }
});

test('a date that only falls on the holding\'s add day is not treated as the user\'s', () => {
    // The backend used to write the add day into purchaseDate when no date was
    // given. Those stamps always land on the same day the row was created
    // (its _id embeds that moment), so same-day dates are ours, not the
    // user's — and a duration built on one would be a memory we invented.
    const guard = `${sliceFn(dashboardJs, 'function userDatedPurchase(h) {')}\n${sliceFn(dashboardJs, 'function holdingToRow(h) {')}\n return holdingToRow;`;
    const holdingToRow = new Function('num', guard)((v) => {
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    });
    const oid = (when) => Math.floor(when.getTime() / 1000).toString(16).padStart(8, '0') + '0'.repeat(16);
    const added = new Date(Date.now() - 400 * 86400000); // holding row created 400 days ago

    // A "purchase date" on the add day itself: the old default, not a memory.
    const stamped = holdingToRow({ _id: oid(added), symbol: 'KO', shares: 5, purchasePrice: 48, currentPrice: 61, purchaseDate: added.toISOString() });
    assert.equal(stamped.purchaseDate, null, 'the add-day default must read as absent');

    // A real purchase date from before the row existed is the user's own.
    const genuine = holdingToRow({ _id: oid(added), symbol: 'KO', shares: 5, purchasePrice: 48, currentPrice: 61, purchaseDate: new Date(added.getTime() - 100 * 86400000).toISOString() });
    assert.ok(genuine.purchaseDate, 'a date the user gave before adding the row is kept');

    // Demo rows carry string ids with no creation day to compare — their
    // authored sample dates stay.
    const demo = holdingToRow({ _id: 'demo-aapl', symbol: 'AAPL', shares: 120, purchasePrice: 148.32, currentPrice: 218, purchaseDate: '2023-03-15T00:00:00.000Z' });
    assert.ok(demo.purchaseDate, 'demo sample dates are kept');
});

test('the backend no longer writes an add-day default into purchaseDate', () => {
    // Both fabrication sites are pinned by their replacement, because a
    // regression here is silent: the field fills in, the data looks complete,
    // and three years later the panel claims a memory the user never gave.
    const appJs = fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8');
    assert.match(appJs, /let purchase = purchaseDate \? new Date\(purchaseDate\) : null;/,
        'POST /api/portfolio must store null when no date was given');
    assert.match(appJs, /purchaseDate: row\.purchaseDate \? new Date\(`\$\{row\.purchaseDate\}T00:00:00Z`\) : null,/,
        'CSV import must store null when the row carries no date');
    assert.ok(!/: new Date\(\),\s*\n\s*currentPrice: livePrice/.test(appJs), 'no write path may default the date');
});

test('the add form no longer sends today as the purchase date', () => {
    assert.doesNotMatch(dashboardJs, /purchaseDate = .*\|\| new Date\(\)\.toISOString/,
        'an empty date field must not be filled in with today client-side');
    assert.match(dashboardJs, /if \(enteredDate\) shared\.purchaseDate = enteredDate;/);
});

test('the panel is drawn even when the portfolio is empty, so it can hide itself', () => {
    // renderSinceBought clears and hides the section; skipping the call on an
    // empty portfolio would leave the previous portfolio's history on screen.
    const call = dashboardJs.indexOf('renderSinceBought(rows);');
    const emptyReturn = dashboardJs.indexOf('if (!rows.length) {', call - 2000);
    assert.ok(call !== -1, 'renderSinceBought is never called');
    assert.ok(call < emptyReturn, 'it must run before the empty-portfolio return');
});

test('the section markup and its styles exist, and the stamp is fresh', () => {
    assert.match(dashboardHtml, /<section class="section" id="since-section" hidden>/);
    assert.match(dashboardHtml, /id="since-body"/);
    for (const cls of ['since-row', 'since-sym', 'since-held', 'since-delta', 'since-paid', 'since-total', 'since-foot']) {
        assert.ok(dashboardHtml.includes(`.${cls}`), `dashboard.html is missing .${cls}`);
    }
    assert.doesNotMatch(dashboardHtml, /20260925-arrival/, 'the stamp must move when the assets change');
    assert.match(dashboardHtml, /assets\/dashboard\.js\?v=20260925-since1/);
});
