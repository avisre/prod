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

// Measured 2026-10-17: Yahoo's monthly KRWUSD=X close for February 2015 was 9.07 (every day of the
// month near 0.00091), and the daily series had strays of its own: TWD 0.272 on 31 Dec 2014, IDR at
// 0.000104 for three days running against 0.000085.
test('the month rate is the last daily close, past stray ticks, and a real devaluation stays', () => {
    const { monthEndSeries } = require('../fx-conversion');
    const daily = (pairs) => ({ 'Time Series (Daily)': Object.fromEntries(pairs.map(([d, r]) => [d, { '4. close': String(r) }])) });
    const days = (month, from, n, rate) => Array.from({ length: n }, (_, i) => [`${month}-${String(from + i).padStart(2, '0')}`, rate]);
    // a single stray on the last day of the month, and a three-day run
    const twd = monthEndSeries(daily([...days('2014-12', 18, 13, 0.0323), ['2014-12-31', 0.272], ...days('2015-01', 1, 8, 0.0316)]));
    assert.equal(twd.find((x) => x.month === '2014-12').rate, 0.0323);
    const idr = monthEndSeries(daily([...days('2013-11', 14, 14, 0.0000851), ['2013-11-28', 0.000104], ['2013-11-29', 0.000104], ...days('2013-12', 2, 1, 0.000104), ...days('2013-12', 3, 10, 0.0000841)]));
    assert.equal(idr.find((x) => x.month === '2013-11').rate, 0.0000851);
    // ARS, December 2015: the peso fell about 30% on the 17th and stayed there
    const ars = monthEndSeries(daily([...days('2015-12', 1, 16, 0.104), ...days('2015-12', 17, 15, 0.0773), ...days('2016-01', 4, 5, 0.0770)]));
    assert.deepEqual(ars, [{ month: '2015-12', rate: 0.0773 }, { month: '2016-01', rate: 0.0770 }]);
});
