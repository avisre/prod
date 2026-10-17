'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshotRatios, buildDigest, presentUsd, fingerprintOf } = require('../dossier');
const reverseDcf = require('../reverse-dcf');
const valuationDcf = require('../valuation-dcf');

const FY = '2025-12-31';
const data = (over = {}) => ({
    overview: { Symbol: 'ZZZQ', Name: 'Test Co', MarketCapitalization: '1000' },
    marketData: { currency: 'USD', asOf: '2026-10-15' },
    coverage: { latestAnnual: { form: '10-K', reportDate: FY } },
    income: { annualReports: [{ fiscalDateEnding: FY, netIncome: 20, totalRevenue: 200, ...over.income }] },
    balance: { annualReports: [{ fiscalDateEnding: FY, totalShareholderEquity: 80, ...over.balance }] },
    cash: { annualReports: [{ fiscalDateEnding: FY, reportedCurrency: 'USD', dividendPayout: -15, ...over.cash }] }
});

test('the snapshot ratios come from the latest 10-K, as decimals, each with its basis', () => {
    const r = snapshotRatios('ZZZQ', data());
    assert.equal(r.profitMargin, 0.1);
    assert.equal(r.roe, 0.25);
    assert.equal(r.dividendYield, 0.015);
    assert.match(r.basis.profitMargin, /latest 10-K \(fiscal year ended 2025-12-31\)/);
    assert.match(r.basis.dividendYield, /market value on 2026-10-15/);
});

test('a ratio the filings cannot give stays empty, never zero or a guess', () => {
    // No provider snapshot exists for this symbol, so nothing fills the gaps.
    const r = snapshotRatios('ZZZQ', data({ income: { totalRevenue: null }, balance: { totalShareholderEquity: -5 }, cash: { reportedCurrency: 'EUR' } }));
    assert.deepEqual([r.profitMargin, r.roe, r.dividendYield], [null, null, null]);
    // A balance sheet of another year is not this year's equity.
    assert.equal(snapshotRatios('ZZZQ', data({ balance: { fiscalDateEnding: '2024-12-31' } })).roe, null);
});

test('the digest names each ratio with its basis and prints n/a for a missing one', () => {
    const d = data({ income: { totalRevenue: null } });
    const text = buildDigest({ overview: d.overview, ratios: snapshotRatios('ZZZQ', d) });
    assert.match(text, /net margin n\/a, ROE 25\.0% \(latest 10-K/);
});

test('the forward DCF names the provider when it falls back to the stored beta', async () => {
    const provider = require('../provider-fundamentals');
    const sym = ['A', 'AAPL', 'MSFT'].find((s) => provider.valuation(s)?.fields?.beta !== undefined);
    if (!sym) return; // no provider snapshot shipped in this checkout
    const d = data({ balance: { shortLongTermDebtTotal: 0, cashAndCashEquivalentsAtCarryingValue: 10 } });
    d.overview.Symbol = sym;
    Object.assign(d.income.annualReports[0], { reportedCurrency: 'USD', interestExpense: 0 });
    Object.assign(d.cash.annualReports[0], { operatingCashflow: 50, capitalExpenditures: -10 });
    const v = await valuationDcf.buildValuation(sym, { data: d });
    assert.equal(v.error, undefined);
    assert.equal(v.waccBuildup.beta, Math.round(provider.valuation(sym).fields.beta * 100) / 100);
    assert.match(v.waccBuildup.betaSource, /^Yahoo Finance beta as of \d{4}-\d{2}-\d{2}, provider-reported\.$/);
});

// A 20-F filer: one EUR year, sourced, beside a USD quote.
const months = Array.from({ length: 12 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}`);
const EUR = months.map((month) => ({ month, rate: month === '2025-12' ? 1.2 : 1.1 }));
const foreign = () => {
    const src = { form: '20-F', filingDate: '2026-02-25', accessionNumber: 'a1', periodEnd: FY };
    const row = (fields) => ({ fiscalDateEnding: FY, periodStart: '2025-01-01', reportedCurrency: 'EUR', ...fields, _sources: Object.fromEntries(Object.keys(fields).map((k) => [k, ['s1']])) });
    return {
        overview: { Symbol: 'ZZZQ', Name: 'Test NV', Currency: 'EUR', MarketCapitalization: '1000' },
        marketData: { currency: 'USD', asOf: '2026-10-15', price: 10 },
        coverage: { latestAnnual: { form: '20-F', reportDate: FY } },
        provenance: { sources: { s1: src }, evidenceFingerprint: 'fp1' },
        income: { annualReports: [row({ totalRevenue: 120, netIncome: 12 })], quarterlyReports: [] },
        balance: { annualReports: [{ ...row({ totalAssets: 50, totalShareholderEquity: 40 }), periodStart: null }], quarterlyReports: [] },
        cash: { annualReports: [row({ operatingCashflow: 30, capitalExpenditures: -6, dividendPayout: -5 })], quarterlyReports: [] }
    };
};

test('a foreign filer is presented in USD: a balance at its month close, a flow at the average of its months', () => {
    const d = presentUsd(foreign(), { EUR });
    const inc = d.income.annualReports[0], bal = d.balance.annualReports[0];
    assert.equal(inc.reportedCurrency, 'USD');
    assert.equal(inc.originalReportedCurrency, 'EUR');
    assert.ok(Math.abs(inc.totalRevenue - 120 * (11 * 1.1 + 1.2) / 12) < 1e-9);
    assert.equal(inc._presentations.totalRevenue.originalValue, 120);
    assert.ok(Math.abs(bal.totalAssets - 60) < 1e-9);
    assert.equal(d.overview.Currency, 'USD');
    assert.deepEqual(d.currencyConversion, { from: 'EUR', to: 'USD', source: 'Yahoo Finance historical FX', approximate: true });
    // The dividend yield needs statements and quote in one currency; now they are.
    assert.ok(snapshotRatios('ZZZQ', d).dividendYield > 0);
    assert.match(snapshotRatios('ZZZQ', d).basis.profitMargin, /^latest 20-F \(fiscal year ended 2025-12-31\)$/);
    assert.doesNotMatch(String(reverseDcf.computeFromData('ZZZQ', d).error || ''), /compatible financial and quote currencies/);
});

test('a figure with no rate for its period is blank, never the filed amount labelled USD', () => {
    const d = presentUsd(foreign(), { EUR: EUR.filter((x) => x.month !== '2025-06') });
    assert.equal(d.income.annualReports[0].totalRevenue, null);
    assert.equal(d.income.annualReports[0].reportedCurrency, 'USD');
    assert.ok(d.balance.annualReports[0].totalAssets > 0); // the December close is still there
});

test('USD data is untouched, and data without a stored rate series stays as filed', () => {
    const usd = data();
    assert.equal(presentUsd(usd, { EUR }), usd);
    const raw = foreign();
    assert.equal(presentUsd(raw, {}), raw);
    assert.equal(raw.income.annualReports[0].reportedCurrency, 'EUR');
});

test('a dossier cached from the filed currency is not served once the data is in USD', () => {
    const raw = foreign();
    assert.equal(fingerprintOf(raw), 'fp1');
    assert.equal(fingerprintOf(presentUsd(raw, { EUR })), 'fp1:USD');
});
