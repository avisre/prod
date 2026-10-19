'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'filed-costs-'));
process.env.SEC_COVERAGE_DATA_DIR = DATA;
const costs = require('../filed-costs');

// Texas Roadhouse's FY2025 income statement as SEC's data sets carry it (pre.txt,
// 0001104659-26-021292): no cost of revenue, four restaurant cost lines, no subtotal.
const TXRH = [
    [8, 'RevenueFromContractWithCustomerExcludingAssessedTax', 'Total revenue'],
    [11, 'CostOfGoodsAndServiceExcludingDirectLaborDepreciationDepletionAndAmortization', 'Food and Beverage'],
    [12, 'CostDirectLabor', 'Labor'],
    [13, 'RentAndLeaseExpenseIncludedInCostOfRevenue', 'Rent'],
    [14, 'OtherCostAndExpenseOperating', 'Other operating'],
    [15, 'PreOpeningCosts', 'Pre-opening'],
    [16, 'DepreciationDepletionAndAmortization', 'Depreciation and amortization'],
    [18, 'GeneralAndAdministrativeExpense', 'General and administrative'],
    [19, 'CostsAndExpenses', 'Total costs and expenses'],
    [20, 'OperatingIncomeLoss', 'Income from operations'],
    [24, 'IncomeTaxExpenseBenefit', 'Income tax expense']
].map(([line, tag, label]) => ({ line, tag, label }));

test('the cost section is every line after revenue and before operating income, in filed order', () => {
    const shuffled = [...TXRH].reverse();
    assert.deepStrictEqual(costs.costSection(shuffled).map((l) => l.label), ['Food and Beverage', 'Labor', 'Rent', 'Other operating', 'Pre-opening', 'Depreciation and amortization', 'General and administrative', 'Total costs and expenses']);
});

test('without operating income the section runs through the costs total; a bank has none', () => {
    const noOperating = TXRH.filter((l) => l.tag !== 'OperatingIncomeLoss');
    assert.strictEqual(costs.costSection(noOperating).at(-1).label, 'Total costs and expenses');
    const bank = [[1, 'InterestAndDividendIncomeOperating', 'Total interest income'], [2, 'InterestExpense', 'Total interest expense'], [3, 'NoninterestExpense', 'Total noninterest expense'], [4, 'NetIncomeLoss', 'Net income']]
        .map(([line, tag, label]) => ({ line, tag, label }));
    assert.strictEqual(costs.costSection(bank), null);
    // a gross profit line inside the section means there is a cost of revenue
    assert.strictEqual(costs.costSection([TXRH[0], { line: 9, tag: 'GrossProfit', label: 'Gross loss' }, ...TXRH.slice(1)]), null);
    // one cost line is no breakdown
    assert.strictEqual(costs.costSection([TXRH[0], TXRH[6], TXRH[9]]), null);
});

test('headings come from the filing\'s own presentation tree, only above the section\'s lines', () => {
    const loc = (n) => `<link:loc xlink:type="locator" xlink:href="x.xsd#${n}" xlink:label="${n}"/>`;
    const arc = (from, to, order) => `<link:presentationArc xlink:type="arc" xlink:from="${from}" xlink:to="${to}" order="${order}"/>`;
    const nodes = ['us-gaap_IncomeStatementAbstract', 'us-gaap_RevenuesAbstract', 'us-gaap_Revenues', 'us-gaap_CostsAndExpensesAbstract', 'txrh_RestaurantOperatingCostsAbstract', 'us-gaap_CostDirectLabor', 'us-gaap_OtherCostAndExpenseOperating', 'txrh_UnusedAbstract', 'us-gaap_PreOpeningCosts', 'us-gaap_OperatingIncomeLoss'];
    const arcs = [
        arc('us-gaap_IncomeStatementAbstract', 'us-gaap_RevenuesAbstract', 1), arc('us-gaap_RevenuesAbstract', 'us-gaap_Revenues', 1),
        arc('us-gaap_IncomeStatementAbstract', 'us-gaap_CostsAndExpensesAbstract', 2),
        arc('us-gaap_CostsAndExpensesAbstract', 'txrh_RestaurantOperatingCostsAbstract', 1),
        arc('txrh_RestaurantOperatingCostsAbstract', 'us-gaap_OtherCostAndExpenseOperating', 2), arc('txrh_RestaurantOperatingCostsAbstract', 'us-gaap_CostDirectLabor', 1),
        arc('us-gaap_CostsAndExpensesAbstract', 'txrh_UnusedAbstract', 2), arc('us-gaap_CostsAndExpensesAbstract', 'us-gaap_PreOpeningCosts', 3),
        arc('us-gaap_IncomeStatementAbstract', 'us-gaap_OperatingIncomeLoss', 3)
    ];
    const pre = `<link:linkbase><link:presentationLink xlink:role="http://x/role/Other">${loc('us-gaap_CostDirectLabor')}</link:presentationLink><link:presentationLink xlink:role="http://x/role/StatementOfIncome">${nodes.map(loc).join('')}${arcs.join('')}</link:presentationLink></link:linkbase>`;
    const labels = new Map([['us-gaap:CostsAndExpensesAbstract', 'Costs and expenses:'], ['txrh:RestaurantOperatingCostsAbstract', 'Restaurant operating costs'], ['txrh:UnusedAbstract', 'Unused']]);
    assert.deepStrictEqual(costs.withHeadings(pre, labels, ['CostDirectLabor', 'OtherCostAndExpenseOperating', 'PreOpeningCosts']), [
        { heading: 'Costs and expenses:', depth: 0 },
        { heading: 'Restaurant operating costs', depth: 1 },
        { tag: 'CostDirectLabor', depth: 2 },
        { tag: 'OtherCostAndExpenseOperating', depth: 2 },
        { tag: 'PreOpeningCosts', depth: 1 }
    ]);
    assert.strictEqual(costs.withHeadings(pre, labels, ['CostDirectLabor', 'NotInAnyTree']), null);
});

test('a value is matched to the statement row whose period end rounds to the same month', () => {
    assert.strictEqual(costs.month('2025-12-30'), '2025-12');
    assert.strictEqual(costs.month('2025-01-02'), '2024-12');
    assert.strictEqual(costs.month('2026-01-13'), '2025-12');
    fs.mkdirSync(path.join(DATA, 'filed-costs'), { recursive: true });
    fs.writeFileSync(path.join(DATA, 'filed-costs', '0001289460.json'), JSON.stringify({
        schemaVersion: 1, cik: '0001289460', currency: 'USD', filing: { accession: '0001104659-26-021292', form: '10-K', filed: '2026-02-27' }, heading: 'Costs and expenses',
        lines: [
            { h: 1, l: 'Restaurant operating costs', d: 0 },
            { c: 'CostDirectLabor', l: 'Labor', d: 1, v: { '2025-12-31': 1944416000, '2024-12-31': 1764740000, '2018-12-31': 1 } },
            { c: 'OtherCostAndExpenseOperating', l: 'Other operating', d: 1, v: { '2025-12-31': 855092000 } },
            { c: 'PreOpeningCosts', l: 'Pre-opening', d: 0, v: { '2018-12-31': 5 } },
            { c: 'CostsAndExpenses', l: 'Total costs and expenses', d: 0, t: 1, v: { '2025-12-31': 5403335000 } }
        ],
        sources: { '2025-12-31': '0001104659-26-021292' }
    }));
    const rows = [{ fiscalDateEnding: '2025-12-30', reportedCurrency: 'USD' }, { fiscalDateEnding: '2024-12-31', reportedCurrency: 'USD' }];
    const view = costs.forIssuer('1289460', rows);
    assert.deepStrictEqual(view.lines.map((l) => l.label), ['Restaurant operating costs', 'Labor', 'Other operating', 'Total costs and expenses']);
    assert.deepStrictEqual(view.lines[1].values, { '2025-12-30': 1944416000, '2024-12-31': 1764740000 });
    assert.strictEqual(view.lines[3].total, true);
    assert.strictEqual(view.sources['2025-12-30'].url, 'https://www.sec.gov/Archives/edgar/data/1289460/000110465926021292/0001104659-26-021292-index.htm');
    // statements in another currency take none of the filed values
    assert.strictEqual(costs.forIssuer('1289460', rows.map((r) => ({ ...r, reportedCurrency: 'EUR' }))), null);
    assert.strictEqual(costs.forIssuer('320193', rows), null);
});

test.after(() => fs.rmSync(DATA, { recursive: true, force: true }));

test('printed labels lose element suffixes, footnote markers and shouting', () => {
    assert.strictEqual(costs.label('Costs and Expenses [Abstract]'), 'Costs and Expenses');
    assert.strictEqual(costs.label('Net gain on sale of loans [1]'), 'Net gain on sale of loans');
    assert.strictEqual(costs.label('COSTS AND EXPENSES:'), 'Costs and expenses');
    assert.strictEqual(costs.label('Restaurant operating costs (excluding D&A):'), 'Restaurant operating costs (excluding D&A)');
    // a line tagged OperatingExpenses can be a part; only the section's last total is the total
    const section = costs.costSection([[1, 'Revenues', 'Total revenues'], [2, 'OperatingExpenses', 'Operating'], [3, 'GeneralAndAdministrativeExpense', 'General and administrative'], [4, 'CostsAndExpenses', 'Total expenses'], [5, 'OperatingIncomeLoss', 'Operating income']]
        .map(([line, tag, label]) => ({ line, tag, label })));
    assert.deepStrictEqual(section.map((l) => costs.isTotal(l.tag, l.label)), [true, false, true]);
    assert.strictEqual(section.map((l) => costs.isTotal(l.tag, l.label)).lastIndexOf(true), 2);
});

test('a period shows its lines only when they add up to the filed total', () => {
    // Aflac prints subtotals inside the section; they are not counted twice
    const aflac = [
        { l: 'Benefits and claims, excluding reserve remeasurement', d: 0, v: { e: 7987 } },
        { l: 'Reserve remeasurement (gains) losses', d: 0, v: { e: -694 } },
        { l: 'Total benefits and claims, net', d: 0, v: { e: 7293 } },
        { h: 1, l: 'Acquisition and operating expenses', d: 0 },
        { l: 'Insurance and other expenses', d: 1, v: { e: 5338 } },
        { l: 'Total benefits and expenses', d: 0, t: 1, v: { e: 12631 } }
    ];
    assert.strictEqual(costs.reconciles(aflac, 'e', 12631), true);
    // Halliburton's cost of services and of sales carry no value of their own: a partial breakdown
    const partial = [{ l: 'Impairments and other charges', d: 0, v: { e: 831 } }, { l: 'General and administrative', d: 0, v: { e: 239 } }];
    assert.strictEqual(costs.reconciles(partial, 'e', 19924), false);
    assert.strictEqual(costs.reconciles(partial, 'e', undefined), false);
    // a parent line with lines indented beneath it is a subtotal
    // a total printed indented under the last line does not make that line a subtotal
    assert.strictEqual(costs.reconciles([{ l: 'Rent', d: 0, v: { e: 4 } }, { l: 'Labor', d: 0, v: { e: 6 } }, { l: 'Total', d: 1, t: 1, v: { e: 10 } }], 'e', 10), true);
    assert.strictEqual(costs.reconciles([{ l: 'Operating', d: 0, v: { e: 10 } }, { l: 'Labor', d: 1, v: { e: 6 } }, { l: 'Rent', d: 1, v: { e: 4 } }], 'e', 10), true);
});
