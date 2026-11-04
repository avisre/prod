const assert = require('node:assert/strict');
const test = require('node:test');
const vf = require('../verified-fundamentals');

// A company that listed this year files a prospectus, not a 10-K, so SEC's XBRL has only the
// quarters. The statements extracted from that filing (supplemental-financials) fill the annual
// view; a provider figure never does, and a period the XBRL already has is never duplicated.
const company = { symbol: 'NEWC', cik: '0000000001', securityType: 'stock' };

function observation(overrides) {
    return {
        issuer: '0000000001', securitySymbol: 'NEWC', statement: 'cash', field: 'operatingCashflow',
        value: 1000000, scale: 1, unit: 'USD', currency: 'USD', periodStart: '2025-01-01', periodEnd: '2025-12-31',
        basis: 'annual', historyBasis: 'annual', periodDefinition: 'Year ended 2025-12-31',
        accountingBasis: 'US GAAP', scope: 'entity', sourceType: 'issuer_release',
        sourceName: 'SEC EDGAR filing (HTML statements, no XBRL)', sourceUrl: 'https://www.sec.gov/Archives/edgar/data/1/000000000026000001/newc-424b4.htm',
        publicationDate: '2026-05-14', sourceDataDate: '2026-05-14', sourceDateKind: 'publication',
        retrievedAt: '2026-10-25T07:55:15.516Z', sourceVersions: ['0000000000-26-000001'],
        verificationMethod: 'filing_html_table', extractionVersion: '20261017-html1', state: 'available',
        sourceIds: ['sec-html:0000000000-26-000001:c0ffee'], filingForm: '424B4',
        ...overrides
    };
}

test('a filed annual statement fills a year the XBRL does not have', () => {
    const supplements = [
        observation({ field: 'operatingCashflow', value: 1000000 }),
        observation({ field: 'capitalExpenditures', value: -250000 }),
        observation({ field: 'cashflowFromFinancing', value: 500000 })
    ];
    const { rows, sources } = vf.filedAnnualRows(company, 'cash', [], supplements);
    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.fiscalDateEnding, '2025-12-31');
    assert.equal(row.periodStart, '2025-01-01');
    assert.equal(row.reportedCurrency, 'USD');
    assert.equal(row.operatingCashflow, 1000000);
    assert.equal(row.capitalExpenditures, -250000);
    assert.deepEqual(row._sources.operatingCashflow, ['sec-html:0000000000-26-000001:c0ffee']);
    assert.equal(row._supplemental.form, '424B4');
    assert.equal(row._supplemental.filingDate, '2026-05-14');
    assert.equal(sources['sec-html:0000000000-26-000001:c0ffee'].filingUrl, supplements[0].sourceUrl);
    assert.equal(sources['sec-html:0000000000-26-000001:c0ffee'].form, '424B4');
    assert.equal(sources['sec-html:0000000000-26-000001:c0ffee'].supplemental, true);
});

test('a period the XBRL already reports is not repeated', () => {
    const { rows } = vf.filedAnnualRows(company, 'cash', [{ fiscalDateEnding: '2025-12-31' }], [observation({})]);
    assert.deepEqual(rows, []);
});

test('provider observations and non-annual bases are left out', () => {
    const provider = observation({ sourceType: 'provider', sourceName: 'Yahoo Finance', verificationMethod: 'structured_provider' });
    const quarterly = observation({ basis: 'quarterly', historyBasis: 'quarterly' });
    const { rows } = vf.filedAnnualRows(company, 'cash', [], [provider, quarterly]);
    assert.deepEqual(rows, []);
});

test('a balance sheet instant is an annual balance-sheet row', () => {
    const instant = observation({ statement: 'balance', field: 'totalAssets', value: 2326037000, basis: 'instant', periodStart: null });
    const { rows } = vf.filedAnnualRows(company, 'balance', [], [instant]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].periodType, 'instant');
    assert.equal(rows[0].totalAssets, 2326037000);
});

test('a conflicting currency inside one period is dropped, not mixed', () => {
    const usd = observation({ field: 'operatingCashflow', value: 1000000 });
    const eur = observation({ field: 'capitalExpenditures', value: -250000, currency: 'EUR', unit: 'EUR' });
    const { rows } = vf.filedAnnualRows(company, 'cash', [], [usd, eur]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].operatingCashflow, 1000000);
    assert.equal(rows[0].capitalExpenditures, undefined);
});
