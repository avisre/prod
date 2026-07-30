const assert = require('node:assert/strict');
const test = require('node:test');

const fx = require('../fx-conversion');

function fixture(currency = 'CNY') {
  const annualIncome = {
    fiscalDateEnding: '2024-12-31', reportedCurrency: currency,
    totalRevenue: '1200', netIncome: '120', dilutedEPS: '12', weightedAverageSharesOutstanding: '10'
  };
  const quarterlyIncome = {
    fiscalDateEnding: '2024-12-31', reportedCurrency: currency,
    totalRevenue: '300', dilutedEPS: '3'
  };
  const balance = {
    fiscalDateEnding: '2024-12-31', reportedCurrency: currency,
    totalAssets: '1000', commonStockSharesOutstanding: '50'
  };
  const cash = {
    fiscalDateEnding: '2024-12-31', reportedCurrency: currency,
    operatingCashflow: '240'
  };
  return {
    overview: { Currency: 'USD' },
    income: { annualReports: [annualIncome], quarterlyReports: [quarterlyIncome] },
    balance: { annualReports: [balance], quarterlyReports: [] },
    cash: { annualReports: [cash], quarterlyReports: [] }
  };
}

const monthlyRates = Array.from({ length: 12 }, (_, index) => ({
  month: `2024-${String(index + 1).padStart(2, '0')}`,
  rate: index === 11 ? 0.2 : 0.1
}));

test('converts statements to USD using the correct period basis without mutating source data', () => {
  const original = fixture();
  const snapshot = structuredClone(original);
  const result = fx.convertPayloadWithSeries(original, monthlyRates);

  assert.deepEqual(original, snapshot);
  assert.notEqual(result, original);
  assert.equal(result.currencyConversion.from, 'CNY');
  assert.equal(result.currencyConversion.to, 'USD');
  assert.equal(result.currencyConversion.approximate, true);

  const annual = result.income.annualReports[0];
  const quarterly = result.income.quarterlyReports[0];
  const balance = result.balance.annualReports[0];
  const cash = result.cash.annualReports[0];
  const annualAverage = (11 * 0.1 + 0.2) / 12;

  assert.ok(Math.abs(annual.totalRevenue - 1200 * annualAverage) < 1e-9);
  assert.ok(Math.abs(annual.dilutedEPS - 12 * annualAverage) < 1e-9);
  assert.ok(Math.abs(quarterly.totalRevenue - 300 * ((0.1 + 0.1 + 0.2) / 3)) < 1e-9);
  assert.equal(balance.totalAssets, 200);
  assert.ok(Math.abs(cash.operatingCashflow - 240 * annualAverage) < 1e-9);

  assert.equal(annual.weightedAverageSharesOutstanding, '10');
  assert.equal(balance.commonStockSharesOutstanding, '50');
  assert.equal(annual.originalReportedCurrency, 'CNY');
  assert.equal(annual.reportedCurrency, 'USD');
  assert.equal(balance.fxRateBasis, 'fiscal-period closing rate');
  assert.equal(annual.fxRateBasis, '12-month average of month-end rates');
  assert.equal(quarterly.fxRateBasis, '3-month average of month-end rates');
});

test('normalizes Yahoo monthly history and uses the last available closing rate', () => {
  const points = fx.normalizeSeries({
    'Monthly Adjusted Time Series': {
      '2024-02-01': { '5. adjusted close': '0.14' },
      '2024-01-01': { '4. close': '0.12' }
    }
  });
  assert.deepEqual(points, [
    { month: '2024-01', rate: 0.12 },
    { month: '2024-02', rate: 0.14 }
  ]);
  assert.equal(fx.closingRate(points, '2024-03'), 0.14);
});

test('leaves already-USD payloads unchanged', () => {
  const original = fixture('USD');
  assert.equal(fx.convertPayloadWithSeries(original, monthlyRates), original);
});

test('rejects conversion when no valid FX history exists', () => {
  assert.throws(
    () => fx.convertPayloadWithSeries(fixture(), []),
    /No CNY\/USD exchange-rate history/
  );
});
