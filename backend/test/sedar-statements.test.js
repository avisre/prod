const assert = require('node:assert/strict');
const test = require('node:test');

const sedar = require('../../scripts/extract-sedar-statements');

// The extractor reads the text `pdftotext -layout` prints, so these fixtures are
// that text: labels at the left, amounts right-aligned on fixed character
// columns, a note-reference column, a page footer.
const NOTE_END = 62;
const COL_ENDS = [68, 80];

// Append `text` so that it ends on character column `end`.
function place(line, end, text) {
    return line + ' '.repeat(Math.max(1, end - line.length - text.length)) + text;
}
function row(label, a, b, note = '') {
    let line = label.padEnd(NOTE_END - (note ? 6 : 0));
    if (note) line += note.padStart(6);
    if (a !== '' && a != null) line = place(line, COL_ENDS[0], a);
    if (b !== '' && b != null) line = place(line, COL_ENDS[1], b);
    return line;
}
function header(years = ['2025', '2024'], notes = 'Note') {
    let line = ' '.repeat(50) + notes.padStart(12);
    line = line.padEnd(COL_ENDS[0] - years[0].length) + years[0];
    line += years[1].padStart(COL_ENDS[1] - COL_ENDS[0]);
    return line;
}
const FOOT = 'ACME WIDGETS INC.   ANNUAL 2025 CONSOLIDATED FINANCIAL STATEMENTS            1';
const NOTES = 'The accompanying notes are an integral part of these consolidated financial statements.';

function balanceSheetPages(over = {}) {
    const scale = over.scale === undefined ? '(in thousands of Canadian dollars)' : over.scale;
    const lines = [
        'Acme Widgets Inc.',
        'Consolidated Statement of Financial Position',
        'As at December 31, 2025 and 2024',
        ...(scale ? [scale] : []),
        header(),
        'ASSETS',
        row('Cash and cash equivalents', '1,000', '900', '7'),
        row('Total current assets', '1,500', '1,400', '8'),
        row('Total assets', '1,500', over.assets || '1,400', '9'),
        'LIABILITIES',
        row('Total liabilities', '500', '400', '10'),
        "SHAREHOLDERS' EQUITY",
        row("Total shareholders' equity", '1,000', over.equity || '1,000', '11'),
        row("Total liabilities and shareholders' equity", '1,500', '1,400', '12'),
        '',
        NOTES,
        FOOT,
    ];
    return [lines];
}

function incomePages(over = {}) {
    const lines = [
        'Acme Widgets Inc.',
        'Consolidated Statement of Income',
        ...(over.subtitle ? [over.subtitle] : ['For the years ended December 31, 2025 and 2024']),
        '(in thousands of Canadian dollars, except per share amounts)',
        header(),
        row('Construction revenue', '1,000', '900', '10'),
        row('Costs of construction', '600', '500', '28'),
        row('Gross profit', '400', over.grossProfit || '400'),
        row('Income before income taxes', '400', '300'),
        row('Income tax expense', '100', '75'),
        row('Net income for the period', '300', over.netIncome || '225'),
        row('Basic and diluted earnings per share', '0.55', '0.37'),
        '',
        NOTES,
        FOOT,
    ];
    return [lines];
}

function cashFlowPages(over = {}) {
    const lines = [
        'Acme Widgets Inc.',
        'Consolidated Statement of Cash Flows',
        'For the years ended December 31, 2025 and 2024',
        '(in thousands of Canadian dollars)',
        header(),
        row('Cash flows from operating activities', '', ''),
        row('Net income for the period', '300', '225', '9'),
        row('Net cash from operating activities', '25', '10', '10'),
        row('Cash and cash equivalents, beginning of period', '100', '90', '11'),
        row('Net increase in cash and cash equivalents during period', '25', '10', '12'),
        ...(over.fx === false ? [] : [row('Effects of exchange on cash and cash equivalents', '5', '0', '13')]),
        row('Cash and cash equivalents, end of period', over.cashEnd || (over.fx === false ? '125' : '130'), '100', '14'),
        '',
        NOTES,
        FOOT,
    ];
    return [lines];
}

const BS_TITLE = { kind: 'balance_sheet', title: 'Consolidated Statement of Financial Position' };
const IS_TITLE = { kind: 'income_statement', title: 'Consolidated Statement of Income' };
const CF_TITLE = { kind: 'cash_flow', title: 'Consolidated Statement of Cash Flows' };

function extract(pages, titleInfo, page = 0) {
    return sedar.extractStatement(pages, page, titleInfo);
}

test('a filed CAD balance sheet is verified with dates, currency, scale and receipts', () => {
    const st = extract(balanceSheetPages(), BS_TITLE);
    assert.deepEqual(st.rejections, []);
    assert.equal(st.verified, true);
    assert.equal(st.currency, 'CAD');
    assert.equal(st.scale, 1000);
    assert.deepEqual(st.columns.map(c => c.endDate), ['2025-12-31', '2024-12-31']);
    assert.deepEqual(st.columns.map(c => c.durationMonths), [null, null]);
    const assets = st.rows.find(r => r.label === 'Total assets');
    assert.deepEqual(assets.scaled, [1500000, 1400000]);
    assert.equal(assets.values[0].text, '1,500');
    const checks = Object.fromEntries(st.checks.map(c => [c.name, c.status]));
    assert.equal(checks['assets = liabilities + equity'], 'passed');
    assert.equal(checks['assets = total liabilities and equity'], 'passed');
});

test('the note-reference column is dropped and does not appear in row labels', () => {
    const st = extract(balanceSheetPages(), BS_TITLE);
    assert.equal(st.columns.length, 2);
    assert.equal(st.droppedColumns.length, 1);
    const dropped = st.droppedColumns[0];
    assert.ok(/note/i.test(dropped.header || '') || dropped.values.every(v => /^\d{1,2}$/.test(v)));
    assert.deepEqual(dropped.values, ['7', '8', '9', '10', '11', '12']);
    assert.ok(st.rows.every(r => !/\b\d{1,2}$/.test(r.label)), 'row labels carry no note number');
});

test('a broken printed identity rejects the whole statement with the reason', () => {
    const st = extract(balanceSheetPages({ equity: '999' }), BS_TITLE);
    assert.equal(st.verified, false);
    assert.ok(st.rejections.some(r => /assets = liabilities \+ equity failed/.test(r)), st.rejections.join('; '));
});

test('a statement whose currency is not stated is rejected', () => {
    const st = extract(balanceSheetPages({ scale: '(in thousands)' }), BS_TITLE);
    assert.equal(st.verified, false);
    assert.ok(st.rejections.some(r => /currency not stated/.test(r)), st.rejections.join('; '));
});

test('a flow column without a printed duration is rejected, not guessed', () => {
    const st = extract(incomePages({ subtitle: 'For the period ended December 31, 2025' }), IS_TITLE);
    assert.equal(st.verified, false);
    assert.ok(st.rejections.some(r => /no printed duration/.test(r)), st.rejections.join('; '));
});

test('a printed year header is resolved through the subtitle, with the printed duration', () => {
    const st = extract(incomePages(), IS_TITLE);
    assert.equal(st.verified, true);
    assert.deepEqual(st.columns.map(c => [c.endDate, c.durationMonths]), [['2025-12-31', 12], ['2024-12-31', 12]]);
    assert.deepEqual(st.columns.map(c => c.resolvedFrom), ['subtitle', 'subtitle']);
    assert.equal(st.rows.find(r => r.label === 'Net income for the period').scaled[0], 300000);
});

test('income identities: revenue - cost = gross profit, pre-tax - tax = net income', () => {
    const ok = extract(incomePages(), IS_TITLE);
    assert.equal(ok.verified, true);
    const bad = extract(incomePages({ netIncome: '250' }), IS_TITLE);
    assert.equal(bad.verified, false);
    assert.ok(bad.rejections.some(r => /pre-tax - tax = net income failed/.test(r)));
});

test('cash flow: the printed FX line is either inside or outside the printed net change', () => {
    const withFx = extract(cashFlowPages(), CF_TITLE);
    assert.equal(withFx.verified, true);
    const fx = withFx.checks.find(c => c.name === 'beginning + net change = end');
    assert.equal(fx.columns[0].used, 'with FX effect');
    const withoutFx = extract(cashFlowPages({ fx: false }), CF_TITLE);
    assert.equal(withoutFx.verified, true);
    const noFx = withoutFx.checks.find(c => c.name === 'beginning + net change = end');
    assert.match(noFx.columns[0].used, /without FX effect/);
    const broken = extract(cashFlowPages({ cashEnd: '999' }), CF_TITLE);
    assert.equal(broken.verified, false);
    assert.ok(broken.rejections.some(r => /beginning \+ net change = end failed/.test(r)));
});

test('printed subtotals without a label are kept and flagged, never invented', () => {
    const pages = cashFlowPages();
    pages[0].splice(9, 0, row('', '30', '20'));
    const st = extract(pages, CF_TITLE);
    const unlabelled = st.rows.filter(r => r.unlabelled);
    assert.equal(unlabelled.length, 1);
    assert.equal(unlabelled[0].label, '(unlabelled)');
});

test('period words map to months; a bare year does not pretend to know the duration', () => {
    assert.deepEqual(sedar.parsePeriod('Three months ended June 30, 2026'), { endDate: '2026-06-30', durationMonths: 3, print: 'Three months ended June 30, 2026' });
    assert.equal(sedar.parsePeriod('Six months ended September 30, 2026').durationMonths, 6);
    assert.equal(sedar.parsePeriod('Nine months ended September 30, 2026').durationMonths, 9);
    assert.equal(sedar.parsePeriod('For the years ended December 31, 2025').durationMonths, 12);
    assert.equal(sedar.parsePeriod('As at March 31, 2026').durationMonths, null);
    const bare = sedar.parsePeriod('2025');
    assert.equal(bare.endDate, null);
    assert.equal(bare.year, 2025);
});

test('scale and currency must each be stated once, unambiguously', () => {
    assert.deepEqual(
        [sedar.parseScaleCurrency('(expressed in thousands of US dollars)').currency, sedar.parseScaleCurrency('(expressed in thousands of US dollars)').scale],
        ['USD', 1000]);
    assert.equal(sedar.parseScaleCurrency('(in thousands of Canadian dollars)').currency, 'CAD');
    assert.equal(sedar.parseScaleCurrency('(in thousands of Canadian dollars)').scale, 1000);
    const ambiguous = sedar.parseScaleCurrency('(in thousands of US dollars, except per share amounts in Canadian dollars)');
    assert.equal(ambiguous.currency, null);
    assert.equal(ambiguous.currencyAmbiguous, true);
    assert.equal(sedar.parseScaleCurrency('(unaudited)').scale, null);
});

test('titles are recognised for all three statements and equity is not one of them', () => {
    assert.equal(sedar.classifyTitle('Consolidated Statement of Financial Position').kind, 'balance_sheet');
    assert.equal(sedar.classifyTitle('Condensed Interim Consolidated Statements of Financial Position').kind, 'balance_sheet');
    assert.equal(sedar.classifyTitle('Consolidated Statements of Loss and Comprehensive Loss').kind, 'income_statement');
    assert.equal(sedar.classifyTitle('Consolidated Statement of Operations').kind, 'income_statement');
    assert.equal(sedar.classifyTitle('Consolidated Statements of Cash Flows').kind, 'cash_flow');
    assert.equal(sedar.classifyTitle('Consolidated Statements of Changes in Equity'), null);
    assert.equal(sedar.classifyTitle('Consolidated Statement of Comprehensive Income'), null);
    assert.equal(sedar.classifyTitle('Notice to Reader'), null);
});
