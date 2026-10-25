'use strict';

// Banks, life insurers and insurers that file no capex have no free cash flow
// (owner, 2026-10-19): the
// reverse and forward DCF are not run for them, the dossier carries no FCF
// line. P&C and health insurers that file capex keep FCF.

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
        assert.match(r.error, /^Not run: Free cash flow is not shown for this company/, sic);
        const v = await valuationDcf.buildValuation('ZZZQ', { data: payload(sic) });
        assert.match(v.error, /^Not run: Free cash flow is not shown for this company/, sic);
    }
});

test('a P&C insurer that files no capex (TRV, CB) is not run either', () => {
    const noCapex = payload('6331');
    for (const r of noCapex.cash.annualReports) delete r.capitalExpenditures;
    assert.match(reverseDcf.computeFromData('ZZZQ', noCapex).error, /^Not run: Free cash flow is not shown/);
    assert.ok(dossierAnalysis.financialHistory(noCapex).every((r) => r.fcf == null));
});

test('a P&C or health insurer that files capex still gets the reverse DCF on its filed free cash flow', () => {
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

test('the health checks, filing deltas and insight fact pack carry no free cash flow for a bank or a no-capex insurer', () => {
    const aiChat = require('../ai-chat');
    const filingMonitor = require('../filing-monitor');
    const insights = require('../insights');
    // The health check counts only sourced filed values in one currency.
    const sourced = (sic) => {
        const d = payload(sic);
        for (const r of d.cash.annualReports) Object.assign(r, { reportedCurrency: 'USD', _sources: { operatingCashflow: ['s1'], capitalExpenditures: ['s2'] } });
        return d;
    };
    const noCapex = sourced('6331');
    for (const r of noCapex.cash.annualReports) delete r.capitalExpenditures;
    const fcfCheck = (d) => (aiChat.healthChecksFromData(d, 'ZZZQ').checks || []).some((c) => /free cash flow/i.test(c.label));
    const fcfDelta = (d) => filingMonitor.computeDeltas(d, '10-K').deltas.some((x) => x.label === 'Free cash flow');
    const cashLine = (d) => insights.buildFactPack('ZZZQ', d).lines.split('\n').find((l) => l.startsWith('CASH:'));
    for (const d of [sourced('6021'), sourced('6311'), noCapex]) {
        assert.equal(fcfCheck(d), false);
        assert.equal(fcfDelta(d), false);
        assert.doesNotMatch(cashLine(d), /FCF latest/);
        assert.equal(insights.buildFactPack('ZZZQ', d).noFcf, true);
    }
    assert.equal(fcfCheck(sourced('6331')), true);
    assert.equal(fcfDelta(sourced('6331')), true);
    assert.match(cashLine(sourced('6331')), /^CASH: FCF latest USD 25(\.0)?B/);
});
