'use strict';

// Banks and life insurers have no free cash flow (owner, 2026-10-19): the
// reverse and forward DCF are not run for them, the dossier carries no FCF
// line, and P&C and health insurers keep FCF because they file capex.

const test = require('node:test');
const assert = require('node:assert/strict');
const reverseDcf = require('../reverse-dcf');
const valuationDcf = require('../valuation-dcf');
const dossierAnalysis = require('../dossier-analysis');

const years = ['2025', '2024', '2023', '2022', '2021', '2020'];
const payload = (sic) => ({
    coverage: { sic },
    overview: { Symbol: 'ZZZQ', MarketCapitalization: 500e9, SharesOutstanding: 1e9 },
    income: { annualReports: years.map((y, i) => ({ fiscalDateEnding: `${y}-12-31`, totalRevenue: 100e9 - i * 5e9, netIncome: 20e9 - i * 1e9 })) },
    balance: { annualReports: years.map((y) => ({ fiscalDateEnding: `${y}-12-31`, totalAssets: 1000e9, totalShareholderEquity: 100e9 })) },
    cash: { annualReports: years.map((y, i) => ({ fiscalDateEnding: `${y}-12-31`, operatingCashflow: 30e9 - i * 1e9, capitalExpenditures: -5e9 })) }
});

test('the reverse and forward DCF are not run for a bank or a life insurer', async () => {
    for (const sic of ['6021', '6311']) {
        const r = reverseDcf.computeFromData('ZZZQ', payload(sic));
        assert.match(r.error, /^Not run: Banks and life insurers have no free cash flow/, sic);
        const v = await valuationDcf.buildValuation('ZZZQ', { data: payload(sic) });
        assert.match(v.error, /^Not run: Banks and life insurers have no free cash flow/, sic);
    }
});

test('a P&C or health insurer still gets the reverse DCF on its filed free cash flow', () => {
    for (const sic of ['6331', '6324']) {
        const r = reverseDcf.computeFromData('ZZZQ', payload(sic));
        assert.equal(r.error, undefined, sic);
        assert.equal(r.fcfBase, 25e9, sic);
    }
});

test('the dossier history carries no free cash flow for a bank, and keeps it for a P&C insurer', () => {
    const fcfOf = (sic) => dossierAnalysis.financialHistory(payload(sic)).map((r) => r.fcf);
    assert.ok(fcfOf('6021').every((v) => v == null));
    assert.ok(fcfOf('6331').some((v) => v === 25e9));
});
