'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pageRows, notApplicable, secMatcher } = require('../../scripts/audit-statement-rows');

const companyJs = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'company.js'), 'utf8');

test('audit rows are exactly the rows the company page renders', () => {
    const rows = pageRows();
    const block = companyJs.slice(companyJs.indexOf('const ROWS'), companyJs.indexOf('    let payload = null;'));
    const pageLabels = [...block.matchAll(/label: '([^']+)'/g)].map((m) => m[1]).sort();
    const auditLabels = ['income', 'balance', 'cash'].flatMap((st) => rows[st].map((r) => r.label)).sort();
    assert.deepEqual(auditLabels, pageLabels);
});

test('every audited row names the payload fields it reads', () => {
    const rows = pageRows();
    for (const st of ['income', 'balance', 'cash']) {
        for (const r of rows[st]) assert.ok(r.fields.length, `${st} "${r.label}" reads no fields`);
    }
    const rev = rows.income.find((r) => r.label === 'Revenue');
    assert.ok(rev.fields.includes('totalRevenue'));
    assert.equal(rev.role, 'row');
    assert.equal(rows.income.find((r) => r.label === 'Cost of revenue').role, 'row');
    assert.equal(rows.income.find((r) => r.label === 'Gross margin').role, 'in-dropdown');
});

test('industry rows are not applicable outside their industry', () => {
    assert.equal(notApplicable('Deposits', 'bank'), false);
    assert.equal(notApplicable('Deposits', 'software'), true);
    assert.equal(notApplicable('Inventory', 'bank'), true);
    assert.equal(notApplicable('Inventory', 'insurer'), true);
    assert.equal(notApplicable('Inventory', 'reit'), true);
    assert.equal(notApplicable('Inventory', 'industrial'), false);
    assert.equal(notApplicable('Gross profit', 'reit'), false);
    assert.equal(notApplicable('Revenue', 'bank'), false);
    assert.equal(notApplicable('EBITDA', 'bank'), true);
    assert.equal(notApplicable('EBIT', 'insurer'), true);
    assert.equal(notApplicable('EBITDA', 'software'), false);
});

test('SEC matcher only counts a filed fact for the same period and duration', () => {
    const fact = (end, start, form = '10-K') => ({ end, start, form, val: 1 });
    const has = secMatcher({
        'us-gaap': {
            AccountsPayableCurrent: { units: { USD: [fact('2024-09-28', undefined)] } },
            Revenues: { units: { USD: [fact('2024-09-28', '2023-10-01'), fact('2024-06-29', '2024-03-31', '10-Q')] } },
            NetCashProvidedByUsedInOperatingActivities: { units: { USD: [fact('2024-06-29', '2023-10-01', '10-Q')] } },
            PressRelease: { units: { USD: [fact('2024-09-28', '2023-10-01', '8-K')] } }
        }
    });
    assert.equal(has('AccountsPayableCurrent', 'balance', 'annual', '2024-09-28'), true);
    assert.equal(has('us-gaap:AccountsPayableCurrent', 'balance', 'annual', '2024-09-30'), true, 'within 4 days');
    assert.equal(has('AccountsPayableCurrent', 'balance', 'annual', '2023-09-30'), false, 'other year');
    assert.equal(has('Revenues', 'income', 'annual', '2024-09-28'), true);
    assert.equal(has('Revenues', 'income', 'quarterly', '2024-06-29'), true);
    assert.equal(has('Revenues', 'income', 'quarterly', '2024-09-28'), false, 'a 12-month fact is not a quarter');
    assert.equal(has('NetCashProvidedByUsedInOperatingActivities', 'cash', 'quarterly', '2024-06-29'), true, 'year-to-date cash flow');
    assert.equal(has('PressRelease', 'income', 'annual', '2024-09-28'), false, 'only periodic report forms');
    assert.equal(has('Missing', 'income', 'annual', '2024-09-28'), false);
});

test('search badge: full only when nothing SEC reports is missing', () => {
    const { flagFrom } = require('../statement-completeness');
    const e = (m, filled = 10) => ({ t: 1, i: [filled, 20], b: [0, 25], c: [0, 15], q: [0, 70], m });
    assert.deepEqual(flagFrom(e(0)), { status: 'full', rows: 60 });
    assert.deepEqual(flagFrom(e(7)), { status: 'partial', missing: 7, rows: 60 });
    assert.deepEqual(flagFrom(e(0, 0)), { status: 'none' });
    assert.equal(flagFrom({ t: 1, i: [1, 2], b: [1, 2], c: [1, 2] }), null, 'an index without m shows no badge');
    assert.equal(flagFrom(undefined), null);
});
