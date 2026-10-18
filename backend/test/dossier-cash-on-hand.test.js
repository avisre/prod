// "Earnings and cash" plots net income against cash on hand at year end, not
// free cash flow (owner, 2026-10-19). Dossiers cached before then get the cash
// figure on read, from the filed balance sheet.
const test = require('node:test');
const assert = require('node:assert');
const { financialHistory } = require('../dossier-analysis');
const { withCashOnHand } = require('../dossier');

const row = (fy, extra) => ({ fiscalDateEnding: fy + '-12-31', reportedCurrency: 'USD', ...extra });
const DATA = {
    income: { annualReports: [row('2025', { totalRevenue: '389130000', netIncome: '204831000' }), row('2024', { totalRevenue: '290515000', netIncome: '89159000' })] },
    balance: { annualReports: [row('2025', { cashAndCashEquivalentsAtCarryingValue: '496304000', totalAssets: '1' }), row('2024', { totalAssets: '1' })] },
    cash: { annualReports: [row('2025', { operatingCashflow: '200865000', capitalExpenditures: '-11951000' })] }
};

test('the history carries cash on hand from the balance sheet, null where none was filed', () => {
    const h = financialHistory(DATA);
    assert.equal(h.find((r) => r.fy === '2025').cashOnHand, 496304000);
    assert.equal(h.find((r) => r.fy === '2024').cashOnHand, null, 'no cash line filed is no figure, never 0');
    assert.equal(h.find((r) => r.fy === '2025').fcf, 188914000, 'free cash flow is still there for the rest of the dossier');
});

test('a dossier cached before cash on hand existed gets it on read, by period', () => {
    const cached = [{ fy: '2024', periodEnd: '2024-12-31', netIncome: 1 }, { fy: '2025', periodEnd: '2025-12-31', netIncome: 2 }];
    const out = withCashOnHand(cached, DATA);
    assert.deepEqual(out.map((r) => r.cashOnHand), [null, 496304000]);
    assert.equal(out[1].netIncome, 2, 'every cached figure is kept as it was');
    const current = [{ fy: '2025', cashOnHand: 5 }];
    assert.strictEqual(withCashOnHand(current, DATA), current, 'a current dossier is left alone');
    assert.equal(withCashOnHand(null, DATA), null);
});
