const assert = require('node:assert/strict');
const test = require('node:test');
const { rebuildDebtTotal } = require('../../scripts/refresh-sec-coverage');

// Eaton's case: the Q3 2026 comparative balance sheet presents the year's debt without the separate
// short-term borrowings line the annual face showed, so the presented-lines total cannot be rebuilt.
// The row's own current and non-current debt still add up to the filed total, and that pair is the one
// derivation verifiedField accepts for shortLongTermDebtTotal.
const cik = '0000155150';
const accession = '0000155150-26-000123';
function source(concept, value, id) {
    return [id, {
        type: 'sec_xbrl_fact', cik, taxonomy: 'us-gaap', concept, unit: 'USD', rawValue: value,
        periodStart: null, periodEnd: '2025-12-31', form: '10-Q', filingDate: '2026-10-30',
        accessionNumber: accession, filingUrl: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/${accession}-index.htm`, linkage: 'xbrl_fact',
        verificationMethod: 'company_facts', accountingBasis: 'US GAAP', scope: 'entity',
        retrievedAt: '2026-11-04T00:00:00.000Z', extractionVersion: 'v'
    }];
}
function build({ total = null, longTerm = 8758000000, shortTerm = 1137000000 } = {}) {
    const sources = Object.fromEntries([source('LongTermDebtAndCapitalLeaseObligations', longTerm, 'aa'), source('LongTermDebtAndCapitalLeaseObligationsCurrent', shortTerm, 'bb')]);
    const row = {
        fiscalDateEnding: '2025-12-31', periodType: 'instant', reportedCurrency: 'USD',
        longTermDebt: longTerm, shortTermDebt: shortTerm, shortLongTermDebtTotal: total,
        _sources: { longTermDebt: ['aa'], shortTermDebt: ['bb'] }, _scopes: { longTermDebt: 'entity', shortTermDebt: 'entity' }
    };
    if (total !== null) { row._sources.shortLongTermDebtTotal = ['aa', 'bb']; row._scopes.shortLongTermDebtTotal = 'entity'; }
    const data = { cik, sources, balance: { annualReports: [row], quarterlyReports: [] }, income: { annualReports: [], quarterlyReports: [] }, cash: { annualReports: [], quarterlyReports: [] }, issues: [] };
    const previous = { balance: { annualReports: [{ fiscalDateEnding: '2025-12-31', shortLongTermDebtTotal: 9895000000 }] } };
    return { data, previous };
}

test('a total the new filing set cannot present is rebuilt when the filed parts still add up', () => {
    const { data, previous } = build();
    assert.equal(rebuildDebtTotal(data, previous, '2025-12-31'), true);
    const row = data.balance.annualReports[0];
    assert.equal(row.shortLongTermDebtTotal, 9895000000);
    assert.deepEqual(row._sources.shortLongTermDebtTotal, ['bb', 'aa']);
    assert.equal(row._derivations.shortLongTermDebtTotal.formula, 'sum_fields');
    assert.equal(require('../sec-coverage').verifiedField(data, row, 'shortLongTermDebtTotal'), true);
    assert.equal(data.issues[0].code, 'TOTAL_REBUILT_FROM_FILED_PARTS');
});

test('a total the row carries as one long-term line is restored from that line', () => {
    const { data, previous } = build({ longTerm: 2136360000, shortTerm: null });
    data.balance.annualReports[0]._sources.shortTermDebt = undefined;
    data.balance.annualReports[0]._scopes.shortTermDebt = undefined;
    previous.balance.annualReports[0].shortLongTermDebtTotal = 2136360000;
    assert.equal(rebuildDebtTotal(data, previous, '2025-12-31'), true);
    const row = data.balance.annualReports[0];
    assert.equal(row.shortLongTermDebtTotal, 2136360000);
    assert.equal(row._derivations.shortLongTermDebtTotal.formula, 'sum_presented_lines');
    assert.deepEqual(row._derivations.shortLongTermDebtTotal.inputs, ['longTermDebt']);
});

test('a different total is not rebuilt', () => {
    const { data, previous } = build({ longTerm: 8758000000, shortTerm: 1000000000 });
    assert.equal(rebuildDebtTotal(data, previous, '2025-12-31'), false);
    assert.equal(data.balance.annualReports[0].shortLongTermDebtTotal, null);
});

test('a row that already holds its total is left alone', () => {
    const { data, previous } = build({ total: 9895000000 });
    assert.equal(rebuildDebtTotal(data, previous, '2025-12-31'), false);
});

test('debt lines cited from different filings are not combined', () => {
    const { data, previous } = build();
    data.sources.bb.accessionNumber = '0000155150-26-000999';
    assert.equal(rebuildDebtTotal(data, previous, '2025-12-31'), false);
});
