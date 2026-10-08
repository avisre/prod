'use strict';

// Stock-based compensation on the Stocks & funds page (owner decision
// 2026-10-08). The model is one pure file shared by the page, the sector table
// build and these tests. What is pinned here is the owner's rule for it: every
// figure is filed or arithmetic on filed figures, and a figure whose inputs are
// missing is null with a reason, never an estimate.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const model = require('../../frontend-v2/assets/sbc-model.js');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', '..', ...p), 'utf8');

// Apple's filed figures, FY2020 to FY2025 (10-K cash flow and income statements).
const APPLE = [
    { end: '2020-09-26', sbc: 6829e6, rev: 274515e6, ocf: 80674e6, capex: -7309e6, buy: -72358e6, dil: 17528214e3 },
    { end: '2021-09-25', sbc: 7906e6, rev: 365817e6, ocf: 104038e6, capex: -11085e6, buy: -85971e6, dil: 16864919e3 },
    { end: '2022-09-24', sbc: 9038e6, rev: 394328e6, ocf: 122151e6, capex: -10708e6, buy: -89402e6, dil: 16325819e3 },
    { end: '2023-09-30', sbc: 10833e6, rev: 383285e6, ocf: 110543e6, capex: -10959e6, buy: -77550e6, dil: 15812547e3 },
    { end: '2024-09-28', sbc: 11688e6, rev: 391035e6, ocf: 118254e6, capex: -9447e6, buy: -94949e6, dil: 15408095e3 },
    { end: '2025-09-27', sbc: 12863e6, rev: 416161e6, ocf: 111482e6, capex: -12715e6, buy: -90711e6, dil: 15004697e3, sourceId: 'abc' }
];
const round = (v, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp;

test('the five measures are the filed numbers and plain arithmetic on them', () => {
    // Order must not matter: the page hands rows in whatever order it joined them.
    const m = model.build(APPLE.slice().reverse());
    assert.equal(m.status, 'ok');
    assert.equal(m.fy, 'FY2025');
    assert.equal(m.sourceId, 'abc');
    assert.equal(m.stale, null);
    assert.equal(m.sbc, 12863e6);
    assert.equal(round(m.pctRevenue), 3.09);
    assert.equal(round(m.pctRevenueFiveAgo), 2.49);
    assert.equal(m.fiveAgoFy, 'FY2020');
    // Free cash flow reads capex as an amount whether it was filed negative or positive.
    assert.equal(m.fcf, 98767e6);
    assert.equal(m.fcfAfter, 85904e6);
    assert.equal(round(m.pctOfFcf, 1), 13);
    assert.equal(m.buybacks, 90711e6);
    assert.equal(round(m.buybackOffsetPct, 1), 14.2);
    assert.equal(round(m.dilutionYoY), -2.62);
    assert.equal(round(m.dilutionFive), -14.4);
    assert.deepEqual(m.check, { pass: true, buybacks: 438583e6, sbc: 52328e6 });
    assert.equal(m.trend.length, 6);
    assert.deepEqual(m.trend[0], { fy: 'FY2020', sbc: 6829e6, pctRevenue: (100 * 6829e6) / 274515e6 });
    // Capex filed as a positive amount gives the same free cash flow.
    const positive = model.build(APPLE.map((y) => ({ ...y, capex: Math.abs(y.capex), buy: Math.abs(y.buy) })));
    assert.equal(positive.fcf, m.fcf);
    assert.equal(positive.buybacks, m.buybacks);
});

test('no SBC line in any year is said plainly, not drawn as zero', () => {
    const m = model.build(APPLE.map((y) => ({ ...y, sbc: null })));
    assert.equal(m.status, 'not_reported');
    assert.match(m.why, /^Not available: no separate stock-based compensation line/);
    assert.equal(model.build([]).status, 'not_reported');
    assert.equal(model.build(null).status, 'not_reported');
    // A filed zero is a figure, not a gap.
    assert.equal(model.build([{ end: '2025-12-31', sbc: 0, rev: 100 }]).sbc, 0);
});

test('a missing input makes that one measure null with a reason and leaves the rest', () => {
    const rows = APPLE.map((y) => ({ ...y }));
    rows[5].capex = null; // free cash flow cannot be formed
    rows[5].rev = null;   // nor the share of revenue
    const m = model.build(rows);
    assert.equal(m.status, 'ok');
    assert.equal(m.sbc, 12863e6);
    assert.equal(m.fcf, null);
    assert.equal(m.fcfAfter, null);
    assert.equal(m.pctOfFcf, null);
    assert.match(m.fcfWhy, /^Not available: operating cash flow or capital expenditure for FY2025/);
    assert.equal(m.pctRevenue, null);
    assert.match(m.pctRevenueWhy, /^Not available: revenue for FY2025/);
    // Untouched measures are still there.
    assert.equal(round(m.dilutionYoY), -2.62);
    assert.equal(round(m.buybackOffsetPct, 1), 14.2);
});

test('negative free cash flow is not turned into a percentage', () => {
    const m = model.build([
        { end: '2024-12-31', sbc: 600e6, rev: 4000e6, ocf: -1700e6, capex: -1100e6, dil: 1000e6 },
        { end: '2025-12-31', sbc: 741e6, rev: 5387e6, ocf: -780e6, capex: -1710e6, dil: 1171e6 }
    ]);
    assert.equal(m.fcf, -2490e6);
    assert.equal(m.fcfAfter, -3231e6);
    assert.equal(m.pctOfFcf, null);
    assert.equal(m.buybacks, null);
    assert.equal(m.buybackOffsetPct, null);
    assert.equal(m.check, null, 'no buyback was ever filed: the check is not applied');
    assert.equal(round(m.dilutionYoY, 1), 17.1);
});

test('a split or merger in the share count withholds the change that crosses it', () => {
    const rows = APPLE.map((y) => ({ ...y }));
    rows[2].dil = rows[2].dil / 4; // FY2022 un-restated for a 4-for-1 split
    const five = model.build(rows);
    assert.equal(round(five.dilutionYoY), -2.62, 'this year is clean, so it is shown');
    assert.equal(five.dilutionFive, null, 'the five-year change crosses the break, so it is withheld');
    rows[4].dil = rows[4].dil / 4; // and now the latest year crosses one too
    const yoy = model.build(rows);
    assert.equal(yoy.dilutionYoY, null);
    assert.match(yoy.dilutionWhy, /^Not shown: the diluted share count changed by more than 40% in a year/);
    assert.equal(yoy.dilutionFive, null);
});

test('the buyback check needs five filed years of SBC and at least one filed buyback', () => {
    assert.equal(model.build(APPLE.slice(2)).check, null, 'four years is not five');
    const gap = APPLE.map((y) => ({ ...y })); gap[3].sbc = null;
    assert.equal(model.build(gap).check, null, 'a year with no SBC line breaks the window');
    const heavy = APPLE.map((y) => ({ ...y, buy: -1e9 }));
    assert.deepEqual(model.build(heavy).check, { pass: false, buybacks: 5e9, sbc: 52328e6 });
});

test('when the newest year has no SBC line the latest filed one is used and named', () => {
    const rows = APPLE.map((y) => ({ ...y }));
    rows.push({ end: '2026-09-26', sbc: null, rev: 430000e6, ocf: 115000e6, capex: -12000e6, dil: 14700000e3 });
    const m = model.build(rows);
    assert.equal(m.fy, 'FY2025');
    assert.equal(m.sbc, 12863e6);
    assert.equal(m.stale, 'Not reported for FY2026; latest filed figure is FY2025.');
});

test('the sector rank is a position among the others, and needs a sector worth ranking in', () => {
    const list = Array.from({ length: 101 }, (_, i) => i / 10); // 0.0 … 10.0
    assert.deepEqual(model.rank(list, 3.05), { n: 101, median: 5, higherThanPct: 31 });
    assert.equal(model.rank(list, 0).higherThanPct, 0);
    assert.equal(model.rank(list, 99).higherThanPct, 101, 'above every company, itself not in the list');
    assert.equal(model.rank([1, 2, 3], 2), null, 'three companies are not a sector');
    assert.equal(model.rank(list, null), null);
    assert.equal(model.rank(null, 1), null);
});

test('the committed sector table was built by this model from the committed data', () => {
    const table = JSON.parse(read('backend', 'sbc-sector.json'));
    assert.equal(table.v, 1);
    assert.ok(table.companies > 3000, `ranked ${table.companies} companies`);
    const names = Object.keys(table.sectors);
    assert.ok(names.includes('Information Technology') && names.includes('Financials'));
    let total = 0;
    for (const [name, list] of Object.entries(table.sectors)) {
        total += list.length;
        // A few companies file a negative figure (a reversal of earlier expense); it is
        // their filed number, so it stays in the list.
        assert.ok(list.every((v, i) => typeof v === 'number' && Number.isFinite(v) && (i === 0 || list[i - 1] <= v)), `${name} is sorted numbers`);
    }
    assert.equal(total, table.companies);
});

test('the page draws from the model, and the server ranks with it and never returns the list', () => {
    const page = read('frontend-v2', 'company.html');
    assert.match(page, /<section id="sbc-section" hidden>/);
    assert.match(page, /<script src="assets\/sbc-model\.js\?v=[\w-]+"><\/script>\s*<script src="assets\/company\.js\?v=[\w-]+"><\/script>/, 'the model loads before the page script');

    const js = read('frontend-v2', 'assets', 'company.js');
    assert.match(js, /window\.SBCModel\.build\(rows\)/);
    assert.match(js, /renderChecks\(\);\s*renderSbc\(\);/);
    assert.match(js, /\{ label: 'Stock-based compensation', get: \(r\) => num\(r\.shareBasedCompensation\)/);
    assert.match(js, /\{ label: 'SBC % of revenue',/);
    assert.match(js, /\{ label: 'FCF after SBC, % of revenue',/);
    assert.match(js, /add\('Buybacks exceed stock paid to staff, five years', sbcCheck\.pass,/);
    // The reason strings come from the model and are escaped on the way out.
    assert.match(js, /row\('Free cash flow', '—', esc\(m\.fcfWhy\)\)/);
    assert.match(js, /row\('Diluted shares', '—', esc\(m\.dilutionWhy\)\)/);

    const app = read('backend', 'app.js');
    const route = app.slice(app.indexOf("app.get('/api/sbc/sector-rank'"));
    const fn = route.slice(0, route.indexOf('\n});'));
    assert.match(fn, /sbcModel\.rank\(list, pct\)/);
    assert.match(fn, /Object\.prototype\.hasOwnProperty\.call\(sbcSectorTable\.sectors, sector\)/, 'an inherited property is not a sector');
    assert.match(fn, /\.json\(\{ sector, asOf: [^}]*, rank \}\)/, 'a position, never the sector list');
});
