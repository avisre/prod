'use strict';
// Software issuers (SIC 737x) that file no capital-spending line: AppLovin since FY2025 folds it into
// "other investing activities". Yahoo subtracts the filed intangible purchase (FY2025 FCF $3,942.8m);
// StockAnalysis leaves capex blank and takes FCF = OCF (Q2 2026 $869.0m). verified-fundamentals does both.
const test = require('node:test');
const assert = require('node:assert/strict');
const { softwareCapex } = require('../verified-fundamentals');
const mcp = require('../mcp-financials');

const row = (end, ocf, capex, sw) => ({
    fiscalDateEnding: end, operatingCashflow: ocf, capitalExpenditures: capex,
    ...(sw != null ? { softwarePurchases: sw } : {}),
    _sources: { operatingCashflow: ['a'], ...(capex != null ? { capitalExpenditures: ['c'] } : {}), ...(sw != null ? { softwarePurchases: ['s'] } : {}) },
    _derivations: {}, _scopes: {}
});
const fcf = (r) => r.operatingCashflow - Math.abs(r._noCapexLine ? 0 : r.capitalExpenditures);

test('AppLovin FY2025: the filed intangible purchase stands in as capex (Yahoo)', () => {
    const { annual } = softwareCapex([row('2025-12-31', 3971094000, null, -28300000), row('2024-12-31', 2099011000, -4776000)], []);
    assert.equal(annual[0].capitalExpenditures, -28300000);
    assert.equal(annual[0]._softwareCapex, true);
    assert.equal(annual[0]._derivations.capitalExpenditures.formula, 'software_capitalisation');
    assert.equal(Math.round(fcf(annual[0]) / 1e5) / 10, 3942.8);
    assert.equal(annual[1]._softwareCapex, undefined);
});

test('AppLovin 2026 quarters: no capex line filed all year, FCF = OCF and capex stays blank (StockAnalysis)', () => {
    const quarters = [row('2026-06-30', 869040000, null), row('2026-03-31', 1291393000, null), row('2025-12-31', 1313734000, null)];
    const { annual, quarters: q } = softwareCapex([row('2025-12-31', 3971094000, null)], quarters);
    assert.equal(q[0].capitalExpenditures, null);
    assert.equal(q[0]._noCapexLine, true);
    assert.equal(fcf(q[0]), 869040000);
    assert.equal(annual[0]._noCapexLine, true);
    // the reader's rows are not mutated
    assert.equal(quarters[0]._noCapexLine, undefined);
});

test('a quarter whose fiscal year files capex is a derivation gap and gets no FCF', () => {
    const { annual, quarters } = softwareCapex(
        [row('2025-12-31', 900, -80)],
        [row('2025-09-30', 300, null), row('2025-06-30', 200, -20)]
    );
    assert.equal(quarters[0]._noCapexLine, undefined);
    assert.equal(annual[0]._noCapexLine, undefined);
    // current-year quarter with a sibling that files capex
    const cur = softwareCapex([], [row('2026-09-30', 300, null), row('2026-06-30', 200, -20)]);
    assert.equal(cur.quarters[0]._noCapexLine, undefined);
});

test('an annual row is not marked when one of its quarters files capex', () => {
    const { annual } = softwareCapex([row('2025-12-31', 900, null)], [row('2025-06-30', 200, -20)]);
    assert.equal(annual[0]._noCapexLine, undefined);
});

test('the connector free_cash_flow honours the flag and stays null without it', () => {
    const exportsHas = typeof mcp.DERIVED === 'object' && mcp.DERIVED.free_cash_flow;
    const src = require('node:fs').readFileSync(require.resolve('../mcp-financials'), 'utf8');
    assert.match(src, /_noCapexLine \? 0 : num\(\(r\.cash \|\| \{\}\)\.capitalExpenditures\)/);
    if (exportsHas) {
        assert.equal(mcp.DERIVED.free_cash_flow.compute({ cash: { operatingCashflow: 869, capitalExpenditures: null, _noCapexLine: true } }), 869);
        assert.equal(mcp.DERIVED.free_cash_flow.compute({ cash: { operatingCashflow: 869, capitalExpenditures: null } }), null);
    }
});

test('a non-software issuer keeps no FCF when capex is missing', () => {
    const vf = require('node:fs').readFileSync(require.resolve('../verified-fundamentals'), 'utf8');
    assert.match(vf, /const softwareSic=\/\^737\\d\$\/\.test/);
    assert.match(vf, /type==='stock' && softwareSic\)\{/);
});
