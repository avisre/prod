// The income-statement repair feeds the dossier's revenue-flow chart, where a
// wrong number is not a wrong number on a page — it is a wrong number drawn to
// scale, which reads as authoritative. These tests pin the two failure modes
// that were live in real data on the day this was written.
const test = require('node:test');
const assert = require('node:assert');

const { repairIncome } = require('../income-statement');

// Zoetis FY2025 exactly as the fundamentals cache holds it: R&D absent, opex a
// literal "0", operatingIncome absent. Summing the filed components gives opex
// 2,378M -> operating income 4,423M, against an actual ~3,582M. That is the
// regression this file exists for.
const ZTS_2025 = {
    fiscalDateEnding: '2025-12-31', reportedCurrency: 'USD',
    totalRevenue: '9467000000', costOfRevenue: '2666000000', grossProfit: '6801000000',
    researchAndDevelopment: '', sellingGeneralAndAdministrative: '2378000000',
    operatingExpenses: '0', operatingIncome: '', ebit: '0',
    incomeBeforeTax: '3360000000', interestExpense: '222000000',
    incomeTaxExpense: '687000000', netIncome: '2673000000'
};

test('operating income is never invented by summing an incomplete expense list', () => {
    const o = repairIncome(ZTS_2025);
    assert.equal(o.operatingIncome, null, 'no filed operating income and no filed opex — must stay null');
    assert.equal(o.operatingExpenses, null, 'opex must not be reconstructed from R&D + SG&A');
    assert.ok(!o.derived.includes('operatingIncome'));
    // The honest substitute, exact by construction.
    assert.equal(o.operatingAndOtherCosts, 6801000000 - 3360000000);
    // SG&A survives as a known COMPONENT, so the chart can still label part of it.
    assert.equal(o.sellingGeneralAndAdministrative, 2378000000);
    assert.equal(o.researchAndDevelopment, null);
});

test('the whole chain ties, so a flow chart cannot draw a gap', () => {
    const o = repairIncome(ZTS_2025);
    assert.equal(o.revenue - o.costOfRevenue, o.grossProfit);
    assert.equal(o.grossProfit - o.operatingAndOtherCosts, o.incomeBeforeTax);
    assert.equal(o.incomeBeforeTax - o.tax, o.netIncome);
});

test('a filed zero means "not disclosed", not a 100% gross margin', () => {
    // XOM's shape: zero strings across the board.
    const o = repairIncome({
        fiscalDateEnding: '2025-12-31', totalRevenue: '332238000000',
        costOfRevenue: '0', grossProfit: '0', operatingExpenses: '0',
        incomeTaxExpense: '0', netIncome: '28844000000'
    });
    assert.equal(o.costOfRevenue, null);
    assert.equal(o.grossProfit, null, 'a zero COGS would imply a 100% gross margin');
    assert.equal(o.operatingExpenses, null);
});

test('gross profit and cost of revenue each recover the other', () => {
    const fromCogs = repairIncome({ totalRevenue: '1000', costOfRevenue: '400', grossProfit: '' });
    assert.equal(fromCogs.grossProfit, 600);
    assert.ok(fromCogs.derived.includes('grossProfit'));

    const fromGp = repairIncome({ totalRevenue: '1000', costOfRevenue: '', grossProfit: '600' });
    assert.equal(fromGp.costOfRevenue, 400);
    assert.ok(fromGp.derived.includes('costOfRevenue'));
});

test('operating income and opex recover each other, because gross profit ties them', () => {
    const o = repairIncome({ totalRevenue: '1000', costOfRevenue: '400', operatingIncome: '250' });
    assert.equal(o.operatingExpenses, 350, '600 gross profit less 250 operating income');
    assert.ok(o.derived.includes('operatingExpenses'));
});

test('tax is recovered from the pre-tax to net step', () => {
    const o = repairIncome({ totalRevenue: '1000', incomeBeforeTax: '300', incomeTaxExpense: '0', netIncome: '240' });
    assert.equal(o.tax, 60);
    assert.ok(o.derived.includes('tax'));
});

test('a negative pre-tax to net step does not invent a tax credit', () => {
    // Net above pre-tax (a benefit, or an equity-method pickup) must not be
    // reported as a positive tax charge.
    const o = repairIncome({ totalRevenue: '1000', incomeBeforeTax: '100', incomeTaxExpense: '0', netIncome: '150' });
    assert.equal(o.tax, null);
});

test('a bank files three lines and that is not an error', () => {
    // JPM: revenue, tax, net income. No COGS, gross profit, opex or operating
    // income anywhere. The caller renders a shorter flow rather than a broken one.
    const o = repairIncome({
        fiscalDateEnding: '2025-12-31', totalRevenue: '182447000000',
        incomeBeforeTax: '72595000000', incomeTaxExpense: '15547000000', netIncome: '57048000000'
    });
    assert.equal(o.revenue, 182447000000);
    assert.equal(o.netIncome, 57048000000);
    assert.equal(o.grossProfit, null);
    assert.equal(o.operatingIncome, null);
    assert.equal(o.operatingAndOtherCosts, null, 'no gross profit means no honest middle band');
    assert.deepEqual(o.derived, []);
});

test('a genuinely break-even year is not erased', () => {
    // present() must not be applied to revenue or net income: zero is real there.
    const o = repairIncome({ totalRevenue: '0', netIncome: '0' });
    assert.equal(o.revenue, 0);
    assert.equal(o.netIncome, 0);
});

test('no report at all returns null rather than throwing', () => {
    assert.equal(repairIncome(null), null);
    assert.equal(repairIncome(undefined), null);
});
