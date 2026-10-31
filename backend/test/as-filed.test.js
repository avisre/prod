'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'as-filed-'));
process.env.SEC_COVERAGE_DATA_DIR = DATA;
const asFiled = require('../as-filed');

// Two annual reports as scripts/build-as-filed.js records them: st holds each statement's lines
// ([tag, custom, label, negating]) in filed order, n the values ([end, qtrs, uom, value]).
const FY = (y) => `${y}-09-30`;
const flow = (pairs) => pairs.map(([y, v]) => [FY(y), 4, 'USD', v]);
const NEWER = {
    a: '0000000001-25-000001', m: '10-K', d: '2025-11-01', p: FY(2025),
    st: {
        IS: [['Revenues', 0, 'Net sales', 0], ['CostOfRevenue', 0, 'Cost of sales', 0], ['NetIncomeLoss', 0, 'Net income', 0], ['IncomeTaxExpenseBenefit', 0, 'Income taxes', 1]],
        // the closing balance comes first, as Yum! Brands files it
        CF: [['Cash', 0, 'Cash, Ending Balance', 0], ['CashPeriodIncreaseDecrease', 0, 'Net change in cash', 0], ['Cash', 0, 'Cash, Beginning Balance', 0]]
    },
    n: {
        Revenues: flow([[2025, 100], [2024, 90]]), CostOfRevenue: flow([[2025, 60], [2024, 55]]),
        NetIncomeLoss: flow([[2025, 40], [2024, 35]]), IncomeTaxExpenseBenefit: flow([[2025, 5], [2024, 4]]),
        Cash: [[FY(2025), 0, 'USD', 30], [FY(2024), 0, 'USD', 20], [FY(2023), 0, 'USD', 12]],
        CashPeriodIncreaseDecrease: flow([[2025, 10], [2024, 8]])
    }
};
const OLDER = {
    a: '0000000001-24-000001', m: '10-K', d: '2024-11-01', p: FY(2024),
    st: { IS: [['Revenues', 0, 'Net sales', 0], ['CostOfGoodsSold', 0, 'Cost of products sold', 0], ['ImpairmentCharge', 1, 'Impairment', 0], ['NetIncomeLoss', 0, 'Net income', 0]] },
    // FY2024 revenue was later restated from 88 to 90
    n: { Revenues: flow([[2024, 88], [2023, 80]]), CostOfGoodsSold: flow([[2024, 55], [2023, 50]]), ImpairmentCharge: flow([[2024, 5], [2023, 7]]), NetIncomeLoss: flow([[2024, 35], [2023, 30]]) }
};

test('years are stitched newest report first: the newest labels, restated figures, older lines kept in place', () => {
    const doc = asFiled.assemble([OLDER, NEWER]);
    const is = doc.statements.income;
    assert.deepStrictEqual(is.ends, [FY(2023), FY(2024), FY(2025)]);
    assert.deepStrictEqual(is.src, [OLDER.a, NEWER.a, NEWER.a]);
    assert.deepStrictEqual(is.lines.map((l) => [l.l, l.v]), [
        ['Net sales', [80, 90, 100]],
        // a renamed tag is matched by the same figure for a year both reports present
        ['Cost of sales', [50, 55, 60]],
        // a line only the older report has is its own row, after the line before it there
        ['Impairment', [7, null, null]],
        ['Net income', [30, 35, 40]],
        // negating labels are applied
        ['Income taxes', [null, -4, -5]]
    ]);
    // a blank is told apart: the line is not in that year's report, or the report has no amount
    assert.deepStrictEqual(is.lines[2].x, [1, 2]);
    assert.deepStrictEqual(is.lines[4].x, [0]);
    assert.strictEqual(is.lines[2].c, 1);
    assert.strictEqual(doc.currency, 'USD');
    assert.deepStrictEqual(Object.keys(doc.filings).sort(), [OLDER.a, NEWER.a].sort());
});

test('cash at the beginning and end of the year are instants, told apart by their labels', () => {
    const cf = asFiled.assemble([NEWER]).statements.cash;
    assert.deepStrictEqual(cf.ends, [FY(2024), FY(2025)]);
    assert.deepStrictEqual(cf.lines.map((l) => [l.l, l.v]), [
        ['Cash, Ending Balance', [20, 30]],
        ['Net change in cash', [8, 10]],
        ['Cash, Beginning Balance', [12, 20]]
    ]);
});

test('with labels that do not say, the first of the two balance lines is the opening one', () => {
    const plain = { ...NEWER, st: { CF: [['Cash', 0, 'Cash and cash equivalents', 0], ['CashPeriodIncreaseDecrease', 0, 'Net change', 0], ['Cash', 0, 'Cash and cash equivalents', 0]] } };
    assert.deepStrictEqual(asFiled.assemble([plain]).statements.cash.lines.map((l) => l.v), [[12, 20], [8, 10], [20, 30]]);
});

test('the opening and closing rows stay apart when an older report lists them the other way round', () => {
    const older = {
        a: '0000000001-24-000001', m: '10-K', d: '2024-11-01', p: FY(2024),
        st: { CF: [['Cash', 0, 'Cash, beginning of year', 0], ['CashPeriodIncreaseDecrease', 0, 'Net change in cash', 0], ['Cash', 0, 'Cash, end of year', 0]] },
        n: { Cash: [[FY(2024), 0, 'USD', 20], [FY(2023), 0, 'USD', 12], [FY(2022), 0, 'USD', 9]], CashPeriodIncreaseDecrease: flow([[2024, 8], [2023, 3]]) }
    };
    const cf = asFiled.assemble([older, NEWER]).statements.cash;
    assert.deepStrictEqual(cf.ends, [FY(2023), FY(2024), FY(2025)]);
    assert.deepStrictEqual(cf.lines.map((l) => [l.l, l.v]), [
        ['Cash, Ending Balance', [12, 20, 30]],
        ['Net change in cash', [3, 8, 10]],
        ['Cash, Beginning Balance', [9, 12, 20]]
    ]);
});

test('forCik reads the built file by any form of the CIK; an unknown one is null', () => {
    fs.mkdirSync(asFiled.DIR(), { recursive: true });
    fs.writeFileSync(path.join(asFiled.DIR(), '0000000001.json'), JSON.stringify({ schemaVersion: 1, cik: '0000000001', ...asFiled.assemble([NEWER]) }));
    assert.strictEqual(asFiled.forCik(1).statements.income.lines[0].l, 'Net sales');
    assert.strictEqual(asFiled.forCik('0000000002'), null);
    assert.strictEqual(asFiled.forCik(''), null);
});
