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
    assert.equal(m.reversal, false);
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
    assert.deepEqual(m.trend[0], { fy: 'FY2020', tick: '2020', sbc: 6829e6, pctRevenue: (100 * 6829e6) / 274515e6 });
    assert.equal(m.fiveAgoEnd, '2020-09-26');
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
    const missing = APPLE.filter((_, i) => i !== 3);
    assert.equal(model.build(missing).check, null, 'a year absent from the data breaks it too: five rows are not five years');
    const heavy = APPLE.map((y) => ({ ...y, buy: -1e9 }));
    assert.deepEqual(model.build(heavy).check, { pass: false, buybacks: 5e9, sbc: 52328e6 });
});

test('when the newest year has no SBC line, the older figure is named and nothing is drawn from it', () => {
    // 275 companies were in this state on 2026-10-08, some with a last figure from 2010.
    const rows = APPLE.map((y) => ({ ...y }));
    rows.push({ end: '2026-09-26', sbc: null, rev: 430000e6, ocf: 115000e6, capex: -12000e6, dil: 14700000e3 });
    const m = model.build(rows);
    assert.equal(m.status, 'stale');
    assert.equal(m.fy, 'FY2026');
    assert.equal(m.lastFy, 'FY2025');
    assert.equal(m.lastSbc, 12863e6);
    assert.equal(m.why, 'Not available for FY2026: the most recent stock-based compensation line in our filings data is for FY2025.');
    for (const k of ['sbc', 'pctRevenue', 'fcfAfter', 'trend', 'check']) assert.equal(m[k], undefined, `${k} is not offered for a stale company`);
});

test('"five years ago" and "this year" are matched by date, never by position in the list', () => {
    // FY2021 and FY2022 are missing: the row five places back would be far older.
    const gappy = [
        { end: '2016-09-24', sbc: 4210e6, rev: 215639e6, dil: 22001124e3 },
        { end: '2017-09-30', sbc: 4840e6, rev: 229234e6, dil: 21006768e3 },
        { end: '2018-09-29', sbc: 5340e6, rev: 265595e6, dil: 20000435e3 },
        { end: '2019-09-28', sbc: 6068e6, rev: 260174e6, dil: 18595651e3 },
        { end: '2020-09-26', sbc: 6829e6, rev: 274515e6, dil: 17528214e3 },
        { end: '2023-09-30', sbc: 10833e6, rev: 383285e6, dil: 15812547e3 },
        { end: '2024-09-28', sbc: 11688e6, rev: 391035e6, dil: 15408095e3 },
        { end: '2025-09-27', sbc: 12863e6, rev: 416161e6, dil: 15004697e3 }
    ];
    const m = model.build(gappy);
    assert.equal(m.fiveAgoFy, 'FY2020', 'the year that ended five years earlier, not the fifth row back (FY2018)');
    assert.equal(round(m.pctRevenueFiveAgo), 2.49);
    assert.equal(round(m.dilutionYoY), -2.62);
    assert.equal(m.dilutionFive, null, 'two of the years in between are missing');
    assert.equal(m.check, null);
    // With no row a year earlier there is no "this year" change at all.
    const lonely = model.build([gappy[4], gappy[7]]);
    assert.equal(lonely.dilutionYoY, null);
    assert.equal(lonely.dilutionWhy, 'Not available: the year before is not in our filings data.');
});

test('a 52/53-week year ending in early January belongs to the year it closed', () => {
    assert.equal(model.fyOf('2021-01-02'), 'FY2020');
    assert.equal(model.fyOf('2021-12-31'), 'FY2021');
    assert.equal(model.fyOf('2026-01-25'), 'FY2026', 'a late-January retail year keeps its calendar label, as elsewhere on the page');
    const weeks = model.build([
        { end: '2019-12-28', sbc: 30, rev: 1000 }, { end: '2021-01-02', sbc: 32, rev: 1000 },
        { end: '2022-01-01', sbc: 34, rev: 1000 }, { end: '2022-12-31', sbc: 36, rev: 1000 }
    ]);
    assert.deepEqual(weeks.trend.map((x) => x.tick), ['2019', '2020', '2021', '2022']);
});

test('stub periods and refiled or overlapping years are not counted as extra years', () => {
    const base = [
        { end: '2023-06-30', start: '2022-07-01', sbc: 100, rev: 1000, dil: 500 },
        { end: '2024-06-30', start: '2023-07-01', sbc: 110, rev: 1100, dil: 505 }
    ];
    // A six-month transition period filed among the annual rows.
    const stub = model.build([...base, { end: '2024-12-31', start: '2024-07-01', sbc: 55, rev: 560, dil: 506 }]);
    assert.equal(stub.fy, 'FY2024');
    assert.equal(stub.sbc, 110, 'the half-year is left out, not shown as stock pay halving');
    assert.equal(stub.trend.length, 2);
    // The same year filed twice with end dates two days apart.
    const twice = model.build([...base, { end: '2024-06-28', start: '2023-07-01', sbc: 111, rev: 1100, dil: 505 }]);
    assert.deepEqual(twice.trend.map((x) => x.sbc), [100, 110]);
    // Old and new fiscal years around a change of year-end, nine months apart: both
    // are full years, both stay, and the chart tells them apart by month.
    const moved = model.build([
        { end: '2023-03-31', start: '2022-04-01', sbc: 100, rev: 1000 },
        { end: '2023-12-31', start: '2023-01-01', sbc: 108, rev: 1050 },
        { end: '2024-12-31', start: '2024-01-01', sbc: 115, rev: 1100 }
    ]);
    assert.deepEqual(moved.trend.map((x) => x.tick), ['Mar 23', 'Dec 23', '2024']);
    assert.equal(moved.dilutionYoY, null);
});

test('a filed negative figure is a reversal: shown as filed, measured against nothing', () => {
    const rows = APPLE.map((y) => ({ ...y }));
    rows[5].sbc = -849e3;
    const m = model.build(rows);
    assert.equal(m.status, 'ok');
    assert.equal(m.sbc, -849e3);
    assert.equal(m.reversal, true);
    for (const k of ['pctRevenue', 'fcfAfter', 'pctOfFcf', 'buybackOffsetPct', 'check']) assert.equal(m[k], null, `${k} is not computed from a reversal`);
    assert.equal(m.pctRevenueWhy, 'Not shown: the filed figure for FY2025 is a net reversal, not a cost.');
    assert.equal(m.fcf, 98767e6, 'the company\'s own free cash flow is still its own');
    assert.equal(m.trend[5].pctRevenue, null);
});

test('the sector rank is a position among the others, and needs a sector worth ranking in', () => {
    const list = Array.from({ length: 101 }, (_, i) => i / 10); // 0.0 … 10.0
    assert.deepEqual(model.rank(list, 3.05), { n: 101, median: 5, higherThanPct: 31 });
    assert.equal(model.rank(list, 0).higherThanPct, 0);
    assert.equal(model.rank(list, 99).higherThanPct, 100, 'above every company: capped, never "higher than 101%"');
    assert.equal(model.rank(list, NaN), null);
    assert.equal(model.rank([1, 2, 3], 2), null, 'three companies are not a sector');
    assert.equal(model.rank(list, null), null);
    assert.equal(model.rank(null, 1), null);
});

test('the five-year flow table carries one verdict per filed year', () => {
    const m = model.build(APPLE);
    assert.equal(m.years.length, 5, 'the last five fiscal years');
    assert.equal(m.verdictFy, 'FY2025');
    const y = m.years[m.years.length - 1];
    assert.equal(y.fy, 'FY2025');
    assert.equal(y.fcf, 98767e6);
    assert.equal(y.sbc, 12863e6);
    assert.equal(y.fcfAfter, 85904e6);
    assert.equal(round(y.pctOfFcf, 1), 13);
    assert.equal(y.buybacks, 90711e6);
    assert.equal(round(y.dilutionPct), -2.62);
    assert.equal(y.verdict, 'FCF covered SBC 7.7 times and buybacks reduced the share count');
    assert.equal(m.verdict, y.verdict);
});

test('a positive FCF that still leaves more shares gets the rising-share verdict', () => {
    const rows = APPLE.map((y) => ({ ...y }));
    rows[5].dil = rows[4].dil * 1.05; // 5% more diluted shares than the year before
    const y = model.build(rows).years.at(-1);
    assert.equal(round(y.dilutionPct), 5);
    assert.equal(y.verdict, 'FCF covered SBC but the share count still rose 5.0%');
});

test('stock pay above free cash flow is named as unfunded dilution', () => {
    const rows = APPLE.map((y) => ({ ...y }));
    rows[5].sbc = 100e9; // stock pay above the $98.8bn free cash flow
    const m = model.build(rows);
    assert.equal(m.years.at(-1).verdict, 'SBC exceeded FCF: dilution was not funded by cash generation');
});

test('negative FCF and a missing capex line each name the missing input per year', () => {
    const negative = model.build([
        { end: '2024-12-31', sbc: 600e6, rev: 4000e6, ocf: -1700e6, capex: -1100e6, dil: 1000e6 },
        { end: '2025-12-31', sbc: 741e6, rev: 5387e6, ocf: -780e6, capex: -1710e6, dil: 1171e6 }
    ]);
    assert.equal(negative.years.at(-1).verdict, 'FCF was negative');
    assert.equal(negative.years.at(-1).pctOfFcf, null);
    assert.equal(negative.years.at(-1).pctOfFcfWhy, 'Not shown: FCF was negative.');
    const rows = APPLE.map((y) => ({ ...y }));
    rows[5].capex = null;
    const missing = model.build(rows);
    assert.equal(missing.years.at(-1).fcf, null);
    assert.equal(missing.years.at(-1).fcfAfter, null);
    assert.match(missing.years.at(-1).verdict, /^Not available: operating cash flow or capital expenditure for FY2025/);
});

test('the flow table withholds a year that crosses a split instead of reading it as dilution', () => {
    const rows = APPLE.map((y) => ({ ...y }));
    rows[4].dil = rows[4].dil / 4; // FY2024 un-restated for a 4-for-1 split
    const m = model.build(rows);
    const y = m.years.at(-1);
    assert.equal(y.dilutionPct, null);
    assert.match(y.verdict, /^FCF covered SBC .* times\. Not shown: the diluted share count changed by more than 40%/);
});

test('the committed sector table was built by this model from the committed data', () => {
    const table = JSON.parse(read('backend', 'sbc-sector.json'));
    assert.equal(table.v, 1);
    assert.ok(table.companies > 3000, `ranked ${table.companies} companies`);
    // Only companies with a current, positive-revenue, non-reversal figure are ranked.
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
    assert.match(page, /<script src="assets\/sbc-model\.js\?v=[\w-]+"><\/script>\s*<script src="assets\/industry-metrics\.js\?v=[\w-]+"><\/script>\s*<script src="assets\/company\.js\?v=[\w-]+"><\/script>/, 'the models load before the page script');

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
