'use strict';
// A quarter announced in an earnings release (8-K item 2.02) before its 10-Q is filed
// (scripts/fill-release-quarter.js). The release is read with the printed-statement extractor, and a line
// is kept only where the release's comparison figure matches what the issuer already filed. The page shows
// the quarter labelled as coming from the release until the 10-Q's XBRL replaces it.
const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const x = require('../../scripts/extract-html-statements');
const rq = require('../../scripts/fill-release-quarter');
const vf = require('../verified-fundamentals');

const td = (t, span) => `<td${span ? ` colspan="${span}"` : ''}>${t}</td>`;
const row = (label, ...cells) => `<tr>${td(label)}${cells.map((c) => td(c)).join('')}</tr>`;
// The shape NVIDIA prints: 52/53-week quarters, a share-count block under its own full-width heading, and the
// financing section in a second table laid out on a different column grid.
const RELEASE = `<p>ACME WIDGETS, INC. CONDENSED CONSOLIDATED STATEMENTS OF INCOME (In millions, except per share data) (Unaudited)</p>
<table>
<tr>${td('')}${td('Three Months Ended', 2)}</tr>
<tr>${td('')}${td('October 25, 2026')}${td('October 26, 2025')}</tr>
${row('Revenue', '$ 1,000', '$ 500')}
${row('Cost of revenue', '300', '200')}
${row('Gross profit', '700', '300')}
${row('Research and development', '100', '50')}
${row('Sales, general and administrative', '50', '25')}
${row('Total operating expenses', '150', '75')}
${row('Operating income', '550', '225')}
${row('Income before income tax', '550', '225')}
${row('Income tax expense', '50', '25')}
${row('Net income', '$ 500', '$ 200')}
<tr>${td('Net income per share:')}${td('')}${td('')}</tr>
${row('Basic', '$ 2.00', '$ 0.80')}
${row('Diluted', '$ 1.99', '$ 0.79')}
<tr>${td('Weighted average shares used in per share computation:', 3)}</tr>
${row('Basic', '250', '250')}
${row('Diluted', '251', '253')}
</table>
<p>ACME WIDGETS, INC. CONDENSED CONSOLIDATED STATEMENTS OF CASH FLOWS (In millions) (Unaudited)</p>
<table>
<tr>${td('')}${td('Three Months Ended', 2)}</tr>
<tr>${td('')}${td('October 25, 2026')}${td('October 26, 2025')}</tr>
${row('Cash flows from operating activities:', '', '')}
${row('Net income', '$ 500', '$ 200')}
${row('Stock-based compensation expense', '20', '10')}
${row('Net cash provided by operating activities', '600', '250')}
${row('Purchases related to property and equipment and intangible assets', '(40)', '(20)')}
${row('Net cash used in investing activities', '(100)', '(60)')}
</table>
<p>ACME WIDGETS, INC. CONDENSED CONSOLIDATED STATEMENTS OF CASH FLOWS (Continued)</p>
<table>
<tr>${td('Cash flows from financing activities:', 3)}</tr>
<tr>${td('Payments related to repurchases of common stock')}${td('')}${td('(200)')}${td('')}${td('(90)')}</tr>
<tr>${td('Net cash used in financing activities')}${td('')}${td('(250)')}${td('')}${td('(100)')}</tr>
</table>`;
const CTX = {
    cik: '0000000001', symbol: 'ACME', registrantName: 'Acme Widgets, Inc.', formerNames: [], form: '8-K',
    filingDate: '2026-11-17', accession: '0000000001-26-000088', document: 'q3pr.htm',
    documentUrl: 'https://www.sec.gov/Archives/edgar/data/1/000000000126000088/q3pr.htm',
    retrievedAt: '2026-11-17T22:00:00.000Z', fiscalYearEnd: '0125', domestic: true, accountingBasis: 'US GAAP',
    knownQuarterEnds: ['2025-07-27', '2025-10-26', '2026-04-26', '2026-07-26'],
};
const read = () => x.observationsFor(x.extractDocument(RELEASE, CTX), CTX).observations;
const value = (obs, field, end) => obs.find((f) => f.field === field && f.periodEnd === end)?.value;

test('a release quarter on 52/53-week dates starts the day after the last quarter the issuer filed', () => {
    const obs = read();
    const fresh = obs.filter((f) => f.periodEnd === '2026-10-25');
    assert.ok(fresh.length);
    for (const f of fresh) assert.equal(f.periodStart, '2026-07-27', f.field);
    assert.equal(value(obs, 'totalRevenue', '2026-10-25'), 1000e6);
    assert.equal(value(obs, 'sellingGeneralAndAdministrative', '2026-10-25'), 50e6, '"Sales, general and administrative" is SG&A');
});

test('share counts under a full-width "weighted average shares" heading are not read as EPS', () => {
    const obs = read();
    assert.equal(value(obs, 'eps', '2026-10-25'), 2);
    assert.equal(value(obs, 'dilutedEPS', '2026-10-25'), 1.99);
    assert.equal(obs.filter((f) => f.field === 'eps' && f.periodEnd === '2026-10-25').length, 1);
});

test('a continuation table that opens with a heading and sits on its own column grid is still read', () => {
    const obs = read();
    assert.equal(value(obs, 'capitalExpenditures', '2026-10-25'), -40e6);
    assert.equal(value(obs, 'paymentsForRepurchaseOfCommonStock', '2026-10-25'), -200e6);
    assert.equal(value(obs, 'paymentsForRepurchaseOfCommonStock', '2025-10-26'), -90e6);
    assert.equal(value(obs, 'cashflowFromFinancing', '2026-10-25'), -250e6);
});

// What the issuer filed in XBRL for the comparison quarter (2025-10-26) — financing filed as a YTD difference.
const FILED = {
    income: { annualReports: [], quarterlyReports: [{ fiscalDateEnding: '2025-10-26', periodStart: '2025-07-28', totalRevenue: 500e6, netIncome: 200e6, costOfRevenue: 201e6, eps: 0.8, dilutedEPS: 0.79, _sources: { totalRevenue: ['x1'] }, _derivations: {} }] },
    cash: { annualReports: [], quarterlyReports: [{ fiscalDateEnding: '2025-10-26', periodStart: '2025-07-28', operatingCashflow: 250e6, cashflowFromFinancing: -101.4e6, _sources: {}, _derivations: { cashflowFromFinancing: { formula: 'ytd_difference' } } }] },
    balance: { annualReports: [], quarterlyReports: [] },
    sources: { x1: { taxonomy: 'us-gaap' } },
};

test('a line is kept only when its printed comparison matches the filed figure', () => {
    const obs = read();
    const filed = rq.filedState(FILED);
    const fresh = obs.filter((f) => f.periodEnd === '2026-10-25'), prior = obs.filter((f) => f.periodEnd !== '2026-10-25');
    const v = Object.fromEntries(rq.check(fresh, prior, filed, () => 1e6).map((r) => [r.f.field, r]));
    assert.equal(v.totalRevenue.ok, true);
    assert.deepEqual([v.totalRevenue.comparison.printed, v.totalRevenue.comparison.filed], [500e6, 500e6]);
    assert.equal(v.costOfRevenue.ok, false, '200 printed against 201 filed is not a rounding difference');
    assert.equal(v.eps.ok, true);
    assert.equal(v.cashflowFromFinancing.ok, true, 'a derived filed figure gets one and a half printed units');
    assert.equal(v.researchAndDevelopment.ok, false, 'nothing filed to compare: not kept');
    assert.match(v.researchAndDevelopment.why, /nothing filed/);
});

test('a statement whose anchor total does not reconcile keeps none of its lines', () => {
    const obs = read();
    const off = JSON.parse(JSON.stringify(FILED));
    off.cash.quarterlyReports[0].operatingCashflow = 260e6;
    const fresh = obs.filter((f) => f.periodEnd === '2026-10-25'), prior = obs.filter((f) => f.periodEnd !== '2026-10-25');
    const cash = rq.check(fresh, prior, rq.filedState(off), () => 1e6).filter((r) => r.f.statement === 'cash');
    assert.ok(cash.length);
    assert.ok(cash.every((r) => !r.ok), 'financing matched on its own but operating cash flow did not');
});

const obsRow = (over) => ({ issuer: '0000000001', field: 'totalRevenue', value: 1000e6, unit: 'USD', currency: 'USD', periodStart: '2026-07-27', periodEnd: '2026-10-25', basis: 'quarterly', historyBasis: 'quarterly', statement: 'income', scope: 'entity', state: 'available', sourceType: 'issuer_release', verificationMethod: 'release_table_checked', sourceIds: ['sec-html:a'], sourceUrl: 'https://www.sec.gov/x.htm', publicationDate: '2026-11-17', filingForm: '8-K', ...over });

test('release rows are added only after every filed period, and per-share lines only where allowed', () => {
    const company = { cik: '0000000001', symbol: 'ACME' };
    const supplements = [
        obsRow({}),
        obsRow({ field: 'dilutedEPS', value: 1.99, unit: 'USD/shares', sourceIds: ['sec-html:b'] }),
        obsRow({ field: 'netIncome', value: 1, periodEnd: '2026-07-26', periodStart: '2026-04-27', sourceIds: ['sec-html:c'] }),
        obsRow({ field: 'netIncome', value: 500e6, verificationMethod: 'filing_html_table', sourceIds: ['sec-html:d'] }),
    ];
    const existing = [{ fiscalDateEnding: '2026-07-26' }];
    const { rows, sources } = vf.releaseQuarterRows(company, 'income', existing, true, supplements);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].fiscalDateEnding, '2026-10-25');
    assert.equal(rows[0].periodType, 'quarterly');
    assert.equal(rows[0].totalRevenue, 1000e6);
    assert.equal(rows[0].dilutedEPS, 1.99);
    assert.equal(rows[0].netIncome, undefined, 'an issuer_release line not checked against the filing is not used');
    assert.equal(rows[0]._supplemental.verificationMethod, 'release_table_checked');
    assert.equal(sources['sec-html:a'].form, '8-K');
    assert.equal(vf.releaseQuarterRows(company, 'income', existing, false, supplements).rows[0].dilutedEPS, undefined);
    assert.equal(vf.releaseQuarterRows(company, 'income', [{ fiscalDateEnding: '2026-10-25' }], true, supplements).rows.length, 0, 'the 10-Q supersedes it');
});

test('NVIDIA Q3 FY2027 (quarter ended 2026-10-25) is on the company page, from the release or the 10-Q', () => {
    const d = vf.load('NVDA');
    const q = (st) => d[st].quarterlyReports.find((r) => r.fiscalDateEnding === '2026-10-25');
    assert.equal(q('income').totalRevenue, 115844e6);
    assert.equal(q('income').netIncome, 65287e6);
    assert.equal(q('income').dilutedEPS, 2.7);
    assert.equal(q('balance').totalAssets, 372188e6);
    assert.equal(q('cash').operatingCashflow, 48253e6);
    assert.equal(d.income.quarterlyReports[0].fiscalDateEnding >= '2026-10-25', true);
    const src = vf.sourcesFor(d, q('income'), 'totalRevenue')[0];
    assert.match(src.filingUrl, /^https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/1045810\//);
});

test('the page labels a release quarter and says the 10-Q will replace it', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'company.js'), 'utf8');
    assert.match(js, /function fromRelease\(r\) \{ return r\?\._supplemental\?\.verificationMethod === 'release_table_checked'; \}/);
    assert.match(js, /From the earnings release \(\$\{r\._supplemental\.form\} filed \$\{r\._supplemental\.filingDate\}\); the 10-Q for this quarter is not filed yet/);
    assert.match(js, /the 10-Q’s figures replace it once filed/);
    const html = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'company.html'), 'utf8');
    assert.match(html, /assets\/company\.js\?v=20261118-release1/);
});
