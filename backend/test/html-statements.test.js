const assert = require('node:assert/strict');
const test = require('node:test');

const x = require('../../scripts/extract-html-statements');
const { validSupplement } = require('../company-observations');

const CIK = '0000000001';
function ctx(over = {}) {
  return {
    cik: CIK, symbol: 'ACME', registrantName: 'Acme Widgets, Inc.', formerNames: [], form: '10-K',
    filingDate: '2026-03-01', accession: '0000000001-26-000001', document: 'acme-10k.htm',
    documentUrl: 'https://www.sec.gov/Archives/edgar/data/1/000000000126000001/acme-10k.htm',
    retrievedAt: '2026-10-17T00:00:00.000Z', fiscalYearEnd: '1231', domestic: true, ...over,
  };
}
const td = (t, span) => `<td${span ? ` colspan="${span}"` : ''}>${t}</td>`;
const row = (label, ...cells) => `<tr>${td(label)}${cells.map(c => td(c)).join('')}</tr>`;
const BASIS = '<p>The financial statements are prepared in accordance with accounting principles generally accepted in the United States of America.</p>';

function balanceSheet({ tle = '1,500', name = 'ACME WIDGETS, INC.', years = ['2025', '2024'] } = {}) {
  // each period is a value cell plus a cell for the closing parenthesis, as filings print them
  const r2 = (label, a, b) => `<tr>${td(label)}${[a, b].map(v => { const m = /^(\(.*?)(\))$/.exec(v); return m ? td(m[1]) + td(')') : td(v) + td(''); }).join('')}</tr>`;
  return `<p>${name} CONSOLIDATED BALANCE SHEETS (in thousands)</p>
<table>
<tr>${td('')}${td(`December 31, ${years[0]}`, 2)}${td(`December 31, ${years[1]}`, 2)}</tr>
${r2('ASSETS', '', '')}
${r2('Cash and cash equivalents', '$ 400', '$ 350')}
${r2('Total current assets', '600', '550')}
${r2('Property and equipment, net', '900', '800')}
${r2('Total assets', '1,500', '1,350')}
${r2('Total current liabilities', '300', '250')}
${r2('Long-term debt', '200', '—')}
${r2('Total liabilities', '500', '250')}
${r2('Accumulated deficit', '(1,234)', '(1,000)')}
${r2('Total stockholders’ equity', '1,000', '1,100')}
${r2('Total liabilities and stockholders’ equity', tle, '1,350')}
</table>`;
}

function incomeStatement() {
  return `<p>ACME WIDGETS, INC. CONSOLIDATED STATEMENTS OF OPERATIONS (in millions, except per share data)</p>
<table>
<tr>${td('')}${td('Year Ended December 31,', 2)}</tr>
<tr>${td('')}${td('2025')}${td('2024')}</tr>
${row('Revenue', '2,000', '1,800')}
${row('Cost of revenue', '1,200', '1,100')}
${row('Gross profit', '800', '700')}
${row('Research and development<sup>(1)</sup>', '100', '—')}
${row('Net income (loss)', '50', '(25)')}
${row('Basic net income (loss) per share', '$ 0.50', '$ (0.25)')}
</table>`;
}

function trustFiling() {
  return `<html><body><p>The Trust's financial statements are prepared on a modified cash basis.</p>
<p>PERMIAN BASIN ROYALTY TRUST STATEMENTS OF ASSETS, LIABILITIES AND TRUST CORPUS</p>
<table>
<tr>${td('')}${td('December 31,', 2)}</tr>
<tr>${td('')}${td('2025')}${td('2024')}</tr>
${row('ASSETS', '', '')}
${row('Cash and short-term investments', '$ 1,877,733', '$ 2,400,000')}
${row('Total', '$ 1,877,733', '$ 2,400,000')}
${row('LIABILITIES AND TRUST CORPUS', '', '')}
${row('Distribution payable to unit holders', '$ 1,877,732', '$ 2,399,999')}
${row('Trust corpus — 46,608,796 units of beneficial interest authorized and outstanding', '1', '1')}
${row('Total', '$ 1,877,733', '$ 2,400,000')}
</table>
<p>PERMIAN BASIN ROYALTY TRUST STATEMENTS OF DISTRIBUTABLE INCOME</p>
<table>
<tr>${td('')}${td('Year Ended December 31,', 2)}</tr>
<tr>${td('')}${td('2025')}${td('2024')}</tr>
${row('Royalty income', '$ 16,055,300', '$ 30,000,000')}
${row('Interest income', '200,000', '250,000')}
${row('Total', '16,255,300', '30,250,000')}
${row('General and administrative expenditures', '1,955,138', '1,250,000')}
${row('Distributable income', '$ 14,300,162', '$ 29,000,000')}
${row('Distributable income per unit (46,608,796 units)', '$ .31', '$ .62')}
</table></body></html>`;
}

const doc = (...parts) => `<html><body>${BASIS}${parts.join('')}</body></html>`;
const fieldOf = (r, type, field) => r.statements.find(s => s.type === type)?.fields.find(f => f.field === field);

test('parseScale reads the printed multiplier and refuses two of them', () => {
  assert.equal(x.parseScale('(in thousands, except per share data)').scale, 1e3);
  assert.equal(x.parseScale('(In millions of Korean won)').scale, 1e6);
  assert.equal(x.parseScale('Thousands, except per-share amounts').scale, 1e3);
  assert.equal(x.parseScale('Note $000 $000').scale, 1e3);
  assert.equal(x.parseScale('RMB’000').scale, 1e3);
  assert.equal(x.parseScale('(Rs. in lakhs)').scale, 1e5);
  assert.equal(x.parseScale('Revenue 3,000'), null);
  assert.ok(x.parseScale('(in thousands) ... (in millions)').ambiguous);
});

test('parseAmount handles negatives, dashes, currency symbols and Indian grouping', () => {
  assert.deepEqual(x.parseAmount('(1,234)'), { kind: 'number', value: -1234, decimals: 0 });
  assert.equal(x.parseAmount('$ (0.25)').value, -0.25);
  assert.equal(x.parseAmount('−5').value, -5);
  assert.equal(x.parseAmount('W97,146,675').value, 97146675);
  assert.equal(x.parseAmount('1,95,21,84,591').value, 1952184591);
  assert.equal(x.parseAmount('—').kind, 'zero');
  assert.equal(x.parseAmount('-').kind, 'zero');
  assert.equal(x.parseAmount('').kind, 'blank');
  assert.equal(x.parseAmount('n/m').kind, 'invalid');
});

test('fullDates and durationOf read column headers', () => {
  assert.deepEqual(x.fullDates('December 31, 2025').map(d => [d.y, d.m, d.d]), [[2025, 12, 31]]);
  assert.deepEqual(x.fullDates('31 March 2026').map(d => [d.y, d.m, d.d]), [[2026, 3, 31]]);
  assert.deepEqual([...x.durationOf('Three months ended June 30,')], [3]);
  assert.deepEqual([...x.durationOf('Year ended December 31,')], [12]);
});

test('balance sheet: dates from each column, scale applied, split ")" read as a negative, receipts kept', () => {
  const c = ctx();
  const r = x.extractDocument(doc(balanceSheet()), c);
  const bs = r.statements.find(s => s.type === 'balance');
  assert.ok(bs, r.log.join('\n'));
  assert.deepEqual(bs.periods.map(p => p.periodEnd), ['2025-12-31', '2024-12-31']);
  assert.equal(bs.scale, 1000);
  assert.equal(bs.currency, 'USD');
  assert.equal(fieldOf(r, 'balance', 'retainedEarnings').values[0].value, -1234);
  const { observations } = x.observationsFor(r, c);
  const ta = observations.find(o => o.field === 'totalAssets' && o.periodEnd === '2025-12-31');
  assert.equal(ta.value, 1500000);
  assert.equal(ta.unit, 'USD');
  assert.equal(ta.scale, 1);
  assert.equal(ta.sourceType, 'issuer_release');
  assert.equal(ta.sourceName, x.SOURCE_NAME);
  assert.equal(ta.sourceUrl, c.documentUrl);
  assert.equal(ta.publicationDate, '2026-03-01');
  assert.equal(ta.verificationMethod, 'filing_html_table');
  assert.equal(ta.accountingBasis, 'US GAAP');
  assert.match(ta.sourceIds[0], /^sec-html:0000000001-26-000001:[0-9a-f]{16}$/);
  assert.deepEqual([ta.receipt.label, ta.receipt.cellText, ta.receipt.document], ['Total assets', '1,500', c.documentUrl]);
  const debt2024 = observations.find(o => o.field === 'longTermDebt' && o.periodEnd === '2024-12-31');
  if (debt2024) assert.equal(debt2024.value, 0);
  for (const o of observations) assert.ok(validSupplement(o, CIK), `${o.field} ${o.periodEnd} fails validSupplement`);
});

test('balance sheet that does not balance is rejected whole, with the reason logged', () => {
  const r = x.extractDocument(doc(balanceSheet({ tle: '1,400' })), ctx());
  assert.equal(r.statements.filter(s => s.type === 'balance').length, 0);
  assert.ok(r.log.some(l => /rejected — identity check failed/.test(l)), r.log.join('\n'));
});

test('income statement: year row under a duration row, footnote markers dropped, expenses positive', () => {
  const c = ctx();
  const r = x.extractDocument(doc(incomeStatement()), c);
  const is = r.statements.find(s => s.type === 'income');
  assert.ok(is, r.log.join('\n'));
  assert.deepEqual(is.periods.map(p => [p.periodStart, p.periodEnd, p.months]), [['2025-01-01', '2025-12-31', 12], ['2024-01-01', '2024-12-31', 12]]);
  const { observations } = x.observationsFor(r, c);
  const get = (f, end) => observations.find(o => o.field === f && o.periodEnd === end)?.value;
  assert.equal(get('totalRevenue', '2025-12-31'), 2000e6);
  assert.equal(get('costOfRevenue', '2025-12-31'), 1200e6);
  assert.equal(get('netIncome', '2024-12-31'), -25e6);
  assert.equal(get('eps', '2024-12-31'), -0.25);
  assert.equal(get('researchAndDevelopment', '2024-12-31'), 0);
  for (const o of observations) assert.ok(validSupplement(o, CIK), `${o.field} ${o.periodEnd} fails validSupplement`);
});

test('a column with no printed month and day is not given one', () => {
  const html = doc(`<p>ACME WIDGETS, INC. CONSOLIDATED STATEMENTS OF OPERATIONS</p><table>
<tr>${td('')}${td('2025')}${td('2024')}</tr>${row('Revenue', '2,000', '1,800')}${row('Net income', '50', '40')}</table>`);
  const r = x.extractDocument(html, ctx({ form: '424B4' }));
  assert.equal(r.statements.length, 0);
  assert.ok(r.log.some(l => /no printed month and day|no column with a clear period/.test(l)), r.log.join('\n'));
});

test('royalty trust: royalty income, distributable income, per-unit amount, trust corpus, total assets', () => {
  const c = ctx({ registrantName: 'PERMIAN BASIN ROYALTY TRUST', symbol: 'PBT' });
  const r = x.extractDocument(trustFiling(), c);
  assert.ok(r.trust);
  assert.equal(r.basis, 'Modified cash basis');
  const { observations } = x.observationsFor(r, c);
  const get = (f) => observations.find(o => o.field === f && o.periodEnd === '2025-12-31');
  assert.equal(get('totalRevenue').value, 16055300);
  assert.equal(get('totalRevenue').receipt.label, 'Royalty income');
  assert.equal(get('netIncome').value, 14300162);
  assert.match(get('netIncome').definition, /Distributable income/);
  assert.equal(get('eps').value, 0.31);
  assert.equal(get('eps').unit, 'USD/shares');
  assert.equal(get('totalAssets').value, 1877733);
  assert.equal(get('totalShareholderEquity').value, 1);
  for (const o of observations) assert.ok(validSupplement(o, CIK), `${o.field} fails validSupplement`);
});

test('statements headed by another company are dropped', () => {
  const other = balanceSheet({ name: 'TARGET OPERATING HOLDINGS LLC AND SUBSIDIARIES', years: ['2023', '2022'] });
  const r = x.extractDocument(doc('<p>F-2</p>', balanceSheet(), '<p>F-20</p>', other), ctx());
  assert.equal(r.statements.filter(s => s.type === 'balance').length, 1);
  assert.ok(r.log.some(l => /headed by another company dropped: target operating/.test(l)), r.log.join('\n'));
});

test('combine keeps the later filing and drops in-filing conflicts', () => {
  const base = { issuer: CIK, field: 'totalAssets', periodStart: null, periodEnd: '2025-12-31', unit: 'USD', accountingBasis: 'US GAAP', scope: 'entity', basis: 'instant' };
  const log = [];
  const out = x.combine([
    { ...base, value: 100, publicationDate: '2026-03-01', sourceIds: ['sec-html:a:1'] },
    { ...base, value: 101, publicationDate: '2026-08-01', sourceIds: ['sec-html:b:1'] },
  ], log);
  assert.equal(out.length, 1);
  assert.equal(out[0].value, 101);
});

test('a convenience-translation column in another currency is dropped, not stored as a second value', () => {
  const html = `<html><body><p>The consolidated financial statements are prepared in accordance with accounting principles generally accepted in the United States of America. The reporting currency of the Company is the Renminbi.</p>
<p>LONDIAN WASON NEW ENERGY TECH INC. CONSOLIDATED BALANCE SHEETS (Amounts in thousands of Renminbi ("RMB") and U.S. dollars ("US$"))</p>
<table>
<tr>${td('')}${td('As of December 31,', 3)}</tr>
<tr>${td('')}${td('2024')}${td('2025')}${td('2025')}</tr>
<tr>${td('')}${td('RMB')}${td('RMB')}${td('US$')}</tr>
${row('Total assets', '17,730,501', '18,244,813', '2,608,971')}
${row('Total liabilities', '12,195,921', '12,677,866', '1,812,909')}
${row('Total equity', '5,534,580', '5,566,947', '796,062')}
${row('Total liabilities and equity', '17,730,501', '18,244,813', '2,608,971')}
</table></body></html>`;
  const c = ctx({ registrantName: 'Londian Wason New Energy Tech Inc.', domestic: false, form: '424B4' });
  const r = x.extractDocument(html, c);
  const bs = r.statements.find(s => s.type === 'balance');
  assert.ok(bs, r.log.join('\n'));
  assert.equal(bs.currency, 'CNY');
  assert.deepEqual(bs.periods.map(p => p.periodEnd), ['2024-12-31', '2025-12-31']);
  const ta = x.observationsFor(r, c).observations.filter(o => o.field === 'totalAssets' && o.periodEnd === '2025-12-31');
  assert.deepEqual(ta.map(o => [o.value, o.unit]), [[18244813000, 'CNY']]);
});

test('two statements in one document that disagree for the same line and date are both dropped', () => {
  const a = balanceSheet();
  const b = balanceSheet().replace('(in thousands)', '');
  const r = x.extractDocument(doc(a, '<p>Some discussion of results follows here.</p>'.repeat(3), b), ctx());
  assert.equal(r.statements.filter(s => s.type === 'balance').length, 0);
  assert.ok(r.log.some(l => /disagree on totalAssets at 2025-12-31/.test(l)), r.log.join('\n'));
});

test('a line labelled only as a loss is stored negative when printed as a positive number', () => {
  const html = doc(`<p>ACME WIDGETS, INC. STATEMENTS OF COMPREHENSIVE LOSS (U.S. dollars in thousands, except per share data)</p><table>
<tr>${td('')}${td('Year ended December 31,', 2)}</tr><tr>${td('')}${td('2025')}${td('2024')}</tr>
${row('Research and development expenses, net', '946', '1,192')}
${row('Loss from operations', '9,105', '2,831')}
${row('Loss before income taxes', '19,485', '2,998')}
${row('Net loss and comprehensive loss', '19,485', '2,998')}
${row('Basic loss per share', '(1.09)', '(0.21)')}
</table>`);
  const c = ctx();
  const r = x.extractDocument(html, c);
  const { observations } = x.observationsFor(r, c);
  const get = (f) => observations.find(o => o.field === f && o.periodEnd === '2025-12-31')?.value;
  assert.equal(get('netIncome'), -19485000);
  assert.equal(get('operatingIncome'), -9105000);
  assert.equal(get('incomeBeforeTax'), -19485000);
  assert.equal(get('eps'), -1.09);
});

test('a note table titled only in its own rows is not read as a statement', () => {
  const html = doc(`<p>ACME WIDGETS, INC. The following is summarized financial information relating to Polar Charge AB, an associate.</p><table>
<tr>${td('(in thousands)')}${td('2025')}${td('2024')}</tr><tr>${td('For the year ended December 31,')}</tr>
<tr>${td('Income statement')}</tr>${row('Revenue', '6,969', '4,750')}${row('Net profit for the year', '15,592', '3,136')}</table>`);
  const r = x.extractDocument(html, ctx());
  assert.equal(r.statements.length, 0);
});

function subsOf(filings) {
  return { filings: { recent: {
    form: filings.map(f => f.form), filingDate: filings.map(f => f.filingDate), accessionNumber: filings.map(f => f.accession),
    primaryDocument: filings.map(() => 'doc.htm'), isXBRL: filings.map(f => f.isXBRL), reportDate: filings.map(f => f.filingDate),
  } } };
}
const filing = (form, isXBRL = true, filingDate = '2026-05-01') => ({ form, isXBRL, filingDate, accession: `${CIK}-26-000001` });
const target = (coverage) => ({ symbol: 'ACME', cik: CIK, coverage, name: 'Acme Widgets, Inc.' });

test('an issuer with no annual filing but a prospectus qualifies', () => {
  assert.equal(x.qualifies(target('partial'), subsOf([filing('10-Q'), filing('424B4'), filing('S-1', false)])), true);
});

test('an issuer with no annual filing and no prospectus does not qualify', () => {
  assert.equal(x.qualifies(target('partial'), subsOf([filing('10-Q')])), false);
});

test('an XBRL annual filing still disqualifies despite a prospectus', () => {
  assert.equal(x.qualifies(target('partial'), subsOf([filing('10-K'), filing('S-1')])), false);
});

test('non-XBRL annual, unavailable coverage and missing subs keep their rules', () => {
  assert.equal(x.qualifies(target('partial'), subsOf([filing('10-K', false)])), true);
  assert.equal(x.qualifies(target('unavailable'), subsOf([])), true);
  assert.equal(x.qualifies(target('unavailable'), { missing: true }), false);
  assert.equal(x.qualifies(target('partial'), null), false);
});
