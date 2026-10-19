'use strict';

// Bank and insurer metrics on the company page. The model is one pure file
// shared by the browser, the dossier and these tests. What is pinned here is
// the rule for it: a ratio is arithmetic on filed figures, a flow divided by a
// balance uses the average of the opening and closing balances, and a missing
// input is null with a reason — never an estimate.

const test = require('node:test');
const assert = require('node:assert/strict');
const model = require('../../frontend-v2/assets/industry-metrics.js');
const requirements = require('../financial-requirements');
const profile = require('../ask-industry-profile');

const round = (v, dp = 2) => Math.round(v * 10 ** dp) / 10 ** dp;

// JPMorgan's filed 10-K lines, FY2024 and FY2025 (companyfacts, 10-K).
const JPM = [
    { end: '2024-12-31', netInterestIncome: 92583e6, nonInterestIncome: 84973e6, nonInterestExpense: 91797e6, provisionForCreditLosses: 10678e6, netIncome: 58471e6, totalAssets: 4002814e6, totalShareholderEquity: 344758e6, loans: 1323643e6, deposits: 2406032e6, commonStockSharesOutstanding: 2797600e3 },
    { end: '2025-12-31', netInterestIncome: 95443e6, nonInterestIncome: 87004e6, nonInterestExpense: 95640e6, provisionForCreditLosses: 14212e6, netIncome: 57048e6, totalAssets: 4424900e6, totalShareholderEquity: 362438e6, loans: 1467664e6, deposits: 2559320e6, commonStockSharesOutstanding: 2696200e3 }
];

// Progressive's filed 10-K lines, FY2024 and FY2025.
const PGR = [
    { end: '2024-12-31', premiums: 70799e6, lossesAndLossAdjustmentExpense: 49060e6, policyAcquisitionExpense: 5383e6, otherUnderwritingExpense: 9462e6, netInvestmentIncome: 2803e6, netIncome: 8480e6, totalAssets: 105745e6, totalShareholderEquity: 25591e6, weightedAverageSharesDiluted: 586.6e6 },
    { end: '2025-12-31', premiums: 81661e6, lossesAndLossAdjustmentExpense: 53959e6, policyAcquisitionExpense: 6096e6, otherUnderwritingExpense: 11329e6, netInvestmentIncome: 3549e6, netIncome: 11308e6, totalAssets: 123039e6, totalShareholderEquity: 30323e6, weightedAverageSharesDiluted: 588.1e6 }
];

test('the bank panel is arithmetic on the filed lines, with averages where a flow meets a balance', () => {
    const m = model.buildBank(JPM, { sic: '6021' });
    assert.equal(m.kind, 'bank');
    assert.equal(m.rows.length, 2);
    const y = m.latest;
    assert.equal(y.fy, 'FY2025');
    assert.equal(y.values.netInterestIncome, 95443e6);
    assert.equal(round(y.values.netInterestIncomeGrowthPct), 3.09);
    // No interest-earning-assets tag is filed, so the flow is shown over average
    // total assets and labelled as that, never as NIM.
    assert.equal(y.values.nimBasis, 'average total assets');
    assert.equal(round(y.values.netInterestMarginPct), 2.26);
    assert.equal(round(y.values.efficiencyPct), 52.42);
    assert.equal(round(y.values.loansToDepositsPct), 57.35);
    assert.equal(round(y.values.provisionToLoansPct), 1.02);
    assert.equal(round(y.values.roaPct), 1.35);
    assert.equal(round(y.values.roePct), 16.13);
    assert.equal(round(y.values.equityToAssetsPct), 8.19);
    // Every figure names its source arithmetic.
    assert.equal(m.latest.why.efficiencyPct, undefined);
});

test('missing bank inputs are null with the reason, and never zero', () => {
    const rows = JPM.map((r) => ({ ...r }));
    delete rows[1].nonInterestExpense;
    delete rows[1].provisionForCreditLosses;
    delete rows[1].deposits;
    const m = model.buildBank(rows, { sic: '6021' });
    const y = m.latest;
    assert.equal(y.values.efficiencyPct, null);
    assert.match(y.why.efficiencyPct, /^Not available: noninterest expense for FY2025/);
    assert.equal(y.values.provisionToLoansPct, null);
    assert.match(y.why.provisionToLoansPct, /^Not available: provision for credit losses/);
    assert.equal(y.values.loansToDepositsPct, null);
    assert.match(y.why.loansToDepositsPct, /^Not available: deposits/);
    // A ratio that needs an opening balance is null when the year before is absent.
    const lonely = model.buildBank([JPM[1]], { sic: '6021' });
    assert.equal(lonely.latest.values.roaPct, null);
    assert.match(lonely.latest.why.roaPct, /^Not available: the opening total assets/);
    assert.equal(lonely.latest.values.netInterestIncomeGrowthPct, null);
    assert.match(lonely.latest.why.netInterestIncomeGrowthPct, /^Not available: FY2025 has no filed year before it/);
});

test('the insurance panel shows a combined ratio only for a P&C carrier', () => {
    const m = model.buildInsurance(PGR, { sic: '6331' });
    const y = m.latest;
    assert.equal(m.showCombinedRatio, true);
    assert.equal(y.values.premiumsEarned, 81661e6);
    assert.equal(round(y.values.premiumsGrowthPct), 15.34);
    assert.equal(round(y.values.lossRatioPct), 66.08);
    assert.equal(round(y.values.expenseRatioPct), 21.34);
    assert.equal(round(y.values.combinedRatioPct), 87.42);
    assert.equal(y.values.netInvestmentIncome, 3549e6);
    assert.equal(round(y.values.roePct), 40.45);
    assert.equal(y.values.bookValueBasis, 'diluted weighted-average shares');
    assert.equal(round(y.values.bookValuePerShare), 51.56);
});

test('life and health insurers have no combined ratio, and say so', () => {
    const life = model.buildInsurance(PGR, { sic: '6311' });
    assert.equal(life.showCombinedRatio, false);
    assert.equal(life.insurerType, 'life');
    for (const key of ['lossRatioPct', 'expenseRatioPct', 'combinedRatioPct']) {
        assert.equal(life.latest.values[key], null);
        assert.match(life.latest.why[key], /^Not shown: life insurers do not report a combined ratio/);
    }
    assert.equal(life.latest.values.premiumsEarned, 81661e6, 'premiums are still filed');
    const health = model.buildInsurance(PGR, { sic: '6324' });
    assert.equal(health.showCombinedRatio, false);
    assert.match(health.latest.why.combinedRatioPct, /^Not shown: health insurers/);
});

test('a missing underwriting line makes the expense and combined ratios null', () => {
    const rows = PGR.map((r) => ({ ...r }));
    delete rows[1].otherUnderwritingExpense;
    const m = model.buildInsurance(rows, { sic: '6331' });
    assert.equal(m.latest.values.lossRatioPct !== null, true);
    assert.equal(m.latest.values.expenseRatioPct, null);
    assert.match(m.latest.why.expenseRatioPct, /^Not available: other underwriting expense/);
    assert.equal(m.latest.values.combinedRatioPct, null);
    assert.match(m.latest.why.combinedRatioPct, /other underwriting expense/);
});

test('the SIC table is the one classification source and excludes brokers', () => {
    for (const sic of ['6021', '6022', '6029', '6035', '6036']) assert.equal(model.kindFromSic(sic), 'bank', sic);
    for (const sic of ['6311', '6321', '6324', '6331', '6351', '6361', '6399']) assert.equal(model.kindFromSic(sic), 'insurer', sic);
    assert.equal(model.kindFromSic('6411'), null, 'insurance agents and brokers are not carriers');
    assert.equal(model.kindFromSic(''), null);
    assert.equal(model.insurerType('6311'), 'life');
    assert.equal(model.insurerType('6324'), 'health');
    assert.equal(model.hasCombinedRatio('6331'), true);
    assert.equal(model.hasCombinedRatio('6311'), false);
    assert.equal(requirements.requirements({}, '6411').archetype === 'insurer', false, 'a broker is not an insurer');
    assert.equal(requirements.requirements({}, '6331').archetype, 'insurer');
    assert.equal(profile.sicArchetype('6411'), 'capital-markets');
    assert.equal(profile.sicArchetype('6021'), 'bank');
    assert.equal(profile.sicArchetype('6311'), 'insurer');
});

test('SEC figures win over regulator observations for the same period', () => {
    const data = {
        income: { annualReports: [{ fiscalDateEnding: '2025-12-31', netInterestIncome: 100, reportedCurrency: 'USD' }] },
        balance: { annualReports: [{ fiscalDateEnding: '2025-12-31', totalAssets: 1000, reportedCurrency: 'USD' }] },
        supplementalObservations: [
            { field: 'netInterestIncome', value: 999, periodEnd: '2025-12-31', historyBasis: 'annual', sourceName: 'FDIC Call Report', currency: 'USD' },
            { field: 'totalAssets', value: 9999, periodEnd: '2025-12-31', historyBasis: 'annual', sourceName: 'FDIC Call Report', currency: 'USD' }
        ]
    };
    const rows = model.collect(data);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].netInterestIncome, 100);
    assert.equal(rows[0].totalAssets, 1000);
    assert.equal(rows[0].basis, 'SEC');
});

test('a regulator-only bank is classified from FDIC net interest income', () => {
    const data = {
        coverage: { sic: null, industry: { archetype: 'capital-markets' } },
        supplementalObservations: [{ field: 'netInterestIncome', value: 1, periodEnd: '2025-12-31', historyBasis: 'annual', sourceName: 'FDIC Call Report (FFIEC 031/041/051) via FDIC BankFind' }]
    };
    assert.equal(model.classify(data).kind, 'bank');
    assert.equal(model.classify({ coverage: { sic: '6411' } }).kind, null);
});

// Owner, 2026-10-19: banks, life insurers and insurers that file no capex carry
// no free cash flow (loans, deposits and policyholder balances run through
// operating cash flow). Insurers that file capex keep it, as S&P Global's
// statements do: PGR and UNH carry an FCF row; JPM, WFC, MET, TRV and CB do not.
test('free cash flow is left out for banks, life insurers and insurers that file no capex', () => {
    const capex = (sic, v) => ({ coverage: { sic }, cash: { annualReports: [{ capitalExpenditures: v }] } });
    assert.equal(model.hasNoFcf(capex('6021', -2e9)), true, 'a bank, even one that files capex (JPM)');
    assert.equal(model.hasNoFcf(capex('6311', -1e8)), true, 'life insurer (MET)');
    assert.equal(model.hasNoFcf(capex('6321', null)), true, 'accident and health (AFL)');
    assert.equal(model.hasNoFcf(capex('6331', '-348000000')), false, 'P&C insurer that files capex, as a numeric string (PGR)');
    assert.equal(model.hasNoFcf(capex('6331', null)), true, 'P&C insurer that files no capex (TRV, CB)');
    assert.equal(model.hasNoFcf(capex('6331', 'None')), true, 'a placeholder is not a filed figure');
    assert.equal(model.hasNoFcf(capex('6324', -3.6e9)), false, 'health insurer that files capex (UNH)');
    assert.equal(model.hasNoFcf(capex('3571', null)), false, 'non-financial (AAPL) is never hidden');
    assert.equal(model.hasNoFcf({ coverage: { industry: { archetype: 'insurer' } }, cash: { annualReports: [{ capitalExpenditures: -5 }] } }), false);
    assert.match(model.NO_FCF, /^Free cash flow is not shown for this company/);
});

test('a metric with no value in any year shown is named once, not drawn as a row of dashes', () => {
    // Travelers files no other underwriting expense, so no expense or combined ratio.
    const TRV = PGR.map((r) => ({ ...r, otherUnderwritingExpense: undefined }));
    const m = model.buildInsurance(TRV, { sic: '6331' });
    const empty = model.emptyKeys(m);
    assert.ok(empty.includes('expenseRatioPct'));
    assert.ok(empty.includes('combinedRatioPct'));
    assert.ok(!empty.includes('lossRatioPct'));
    assert.deepEqual(model.emptyKeys(model.buildInsurance(PGR, { sic: '6331' })).filter((k) => /Ratio/.test(k)), []);
    assert.deepEqual(model.emptyKeys(null), []);
});
