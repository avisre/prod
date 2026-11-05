'use strict';
// Income-statement cells calculated from other filed figures (verified-fundamentals.js
// incomeIdentities, owner 2026-11-05): fourth-quarter EPS, pre-tax/tax from net income,
// depreciation from the cash-flow statement. Each is cited and marked as calculated.
const test = require('node:test');
const assert = require('node:assert/strict');
const { incomeIdentities } = require('../verified-fundamentals');

const q = (start, end, eps, netIncome) => ({ fiscalDateEnding: end, periodStart: start, reportedCurrency: 'USD', dilutedEPS: eps, eps, netIncome,
    _sources: { dilutedEPS: ['s-' + end], eps: ['s-' + end], netIncome: ['n-' + end] }, _derivations: {}, _scopes: {} });
// Apple FY2025 as filed: the 10-K's year and the three 10-Q quarters; Q4 has no EPS of its own.
const appleYear = () => ({
    annualReports: [q('2024-09-29', '2025-09-27', 7.46, 112010e6)],
    quarterlyReports: [
        q('2025-06-29', '2025-09-27', null, 27466e6),
        q('2025-03-30', '2025-06-28', 1.57, 23434e6),
        q('2024-12-29', '2025-03-29', 1.65, 24780e6),
        q('2024-09-29', '2024-12-28', 2.40, 36330e6)
    ]
});

test('Q4 EPS is the year less the three filed quarters (Apple FY2025 = 1.84, as StockAnalysis shows)', () => {
    const out = incomeIdentities(appleYear(), {});
    const q4 = out.quarterlyReports[0];
    assert.equal(q4.dilutedEPS, 1.84);
    assert.equal(q4._derivations.dilutedEPS.formula, 'fy_less_three_quarters');
    assert.deepEqual(q4._derivations.dilutedEPS.inputValues, [7.46, 2.40, 1.65, 1.57]); // year, then Q1..Q3
    assert.deepEqual(q4._sources.dilutedEPS.sort(), ['s-2024-12-28', 's-2025-03-29', 's-2025-06-28', 's-2025-09-27'].sort());
});

test('a quarter on another share basis (split or mis-scaled filing) leaves Q4 EPS empty', () => {
    const data = appleYear();
    data.quarterlyReports[2].dilutedEPS = 6.60; // pre-split basis: 4x the year's
    assert.equal(incomeIdentities(data, {}).quarterlyReports[0].dilutedEPS, null);
    const bad = appleYear(); bad.quarterlyReports[1].dilutedEPS = -100; // Bloom Energy's Q3 2025 as stored
    assert.equal(incomeIdentities(bad, {}).quarterlyReports[0].dilutedEPS, null);
});

test('a missing quarter or a year whose quarters do not tile it fills nothing', () => {
    const data = appleYear(); data.quarterlyReports.splice(2, 1);
    assert.equal(incomeIdentities(data, {}).quarterlyReports[0].dilutedEPS, null);
    const shifted = appleYear(); shifted.quarterlyReports[3].periodStart = '2024-07-01';
    assert.equal(incomeIdentities(shifted, {}).quarterlyReports[0].dilutedEPS, null);
});

test('the input rows are not mutated (they are shared cache entries)', () => {
    const data = appleYear();
    incomeIdentities(data, {});
    assert.equal(data.quarterlyReports[0].dilutedEPS, null);
});

const taxRow = (end, pretax, tax, ni) => ({ fiscalDateEnding: end, periodStart: null, incomeBeforeTax: pretax, incomeTaxExpense: tax, netIncome: ni,
    _sources: { ...(pretax !== null && { incomeBeforeTax: ['p' + end] }), ...(tax !== null && { incomeTaxExpense: ['t' + end] }), netIncome: ['n' + end] }, _derivations: {}, _scopes: {} });

test('pre-tax income = net income + tax only where every filed period satisfies the identity', () => {
    const rows = [taxRow('2025-12-31', null, 20e6, 80e6), taxRow('2024-12-31', 100e6, 20e6, 80e6), taxRow('2023-12-31', 90e6, 10e6, 80e6), taxRow('2022-12-31', 50e6, 5e6, 45e6)];
    const out = incomeIdentities({ annualReports: rows, quarterlyReports: [] }, {});
    assert.equal(out.annualReports[0].incomeBeforeTax, 100e6);
    assert.equal(out.annualReports[0]._derivations.incomeBeforeTax.formula, 'net_income_plus_tax');
    // an issuer with an equity-method or minority line between pre-tax and net income: no fill
    const broken = [taxRow('2025-12-31', null, 20e6, 80e6), taxRow('2024-12-31', 100e6, 20e6, 70e6), taxRow('2023-12-31', 90e6, 10e6, 80e6), taxRow('2022-12-31', 50e6, 5e6, 45e6)];
    assert.equal(incomeIdentities({ annualReports: broken, quarterlyReports: [] }, {}).annualReports[0].incomeBeforeTax, null);
});

test('income tax = pre-tax less net income under the same rule', () => {
    const rows = [taxRow('2025-12-31', 100e6, null, 79e6), taxRow('2024-12-31', 100e6, 20e6, 80e6), taxRow('2023-12-31', 90e6, 10e6, 80e6), taxRow('2022-12-31', 50e6, 5e6, 45e6)];
    const out = incomeIdentities({ annualReports: rows, quarterlyReports: [] }, {});
    assert.equal(out.annualReports[0].incomeTaxExpense, 21e6);
    assert.equal(out.annualReports[0]._derivations.incomeTaxExpense.formula, 'pretax_less_net_income');
});

test('depreciation comes from the same period\'s cash-flow statement, cited to it', () => {
    const inc = { fiscalDateEnding: '2025-12-31', periodStart: '2025-01-01', depreciationAndAmortization: null, _sources: {}, _derivations: {}, _scopes: {} };
    const cash = { fiscalDateEnding: '2025-12-31', periodStart: '2025-01-01', depreciationDepletionAndAmortization: 42, _sources: { depreciationDepletionAndAmortization: ['c1'] } };
    const out = incomeIdentities({ annualReports: [inc], quarterlyReports: [] }, { annualReports: [cash], quarterlyReports: [] });
    assert.equal(out.annualReports[0].depreciationAndAmortization, 42);
    assert.deepEqual(out.annualReports[0]._sources.depreciationAndAmortization, ['c1']);
    assert.equal(out.annualReports[0]._derivations.depreciationAndAmortization.formula, 'cash_flow_statement');
});

// Apple FY2025 revenue as filed ($m): the year 416,161; Q1 124,300, Q2 95,359, Q3 94,036. Q4 is 102,466.
const withRevenue = (q4Revenue = null) => {
    const data = appleYear();
    const rev = { '2025-09-27': [416161e6, q4Revenue], '2025-06-28': 94036e6, '2025-03-29': 95359e6, '2024-12-28': 124300e6 };
    data.annualReports[0].totalRevenue = rev['2025-09-27'][0]; data.annualReports[0]._sources.totalRevenue = ['r-fy'];
    for (const r of data.quarterlyReports) {
        r.totalRevenue = r.fiscalDateEnding === '2025-09-27' ? q4Revenue : rev[r.fiscalDateEnding];
        if (r.totalRevenue !== null) r._sources.totalRevenue = ['r-' + r.fiscalDateEnding];
    }
    return data;
};

test('Q4 revenue is the year less the three filed quarters (Apple Q4 FY2025 = $102,466m)', () => {
    const q4 = incomeIdentities(withRevenue(), {}).quarterlyReports[0];
    assert.equal(q4.totalRevenue, 102466e6);
    assert.equal(q4._derivations.totalRevenue.formula, 'fy_less_three_quarters');
    assert.equal(q4._sources.totalRevenue.length, 4);
});

test('Q4 flows stay empty for a year whose filed quarters do not add up to it (a recast year)', () => {
    const data = withRevenue();
    // net income filed for all four quarters, but the 10-K recast the year: 112,010 vs quarters' 112,010 + 900
    data.annualReports[0].netIncome = 111110e6;
    const q4 = incomeIdentities(data, {}).quarterlyReports[0];
    assert.equal(q4.totalRevenue, null);
});

test('Q4 flows stay empty where discontinued operations are filed, and a cost line is never negative', () => {
    const disc = withRevenue(); disc.quarterlyReports[1].discontinuedOperations = -5e6;
    assert.equal(incomeIdentities(disc, {}).quarterlyReports[0].totalRevenue, null);
    const neg = withRevenue(); neg.annualReports[0].totalRevenue = 300000e6;
    assert.equal(incomeIdentities(neg, {}).quarterlyReports[0].totalRevenue, null);
});

test('a Q4 net income the extractor took as year less YTD is no evidence the quarters add up (a de-SPAC year)', () => {
    const data = withRevenue();
    data.quarterlyReports[0]._derivations.netIncome = { formula: 'ytd_difference', inputValues: [] };
    assert.equal(incomeIdentities(data, {}).quarterlyReports[0].totalRevenue, null);
});
