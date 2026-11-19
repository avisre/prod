const test = require('node:test');
const assert = require('node:assert/strict');

const askMdna = require('../ask-mdna');

const filler = (label, n) => `${label} ` + `${label} detail sentence. `.repeat(n);
function buildTenQHtml(driverSentence) {
    const toc = [
        'Item 1. Financial Statements',
        "Item 2. Management's Discussion and Analysis of Financial Condition and Results of Operations",
        'Item 3. Quantitative and Qualitative Disclosures About Market Risk',
        'Item 4. Controls and Procedures',
        'Item 1. Legal Proceedings', 'Item 1A. Risk Factors', 'Item 6. Exhibits'
    ].join(' ');
    return [
        '<html><body>', '<p>FORM 10-Q cover page.</p>', `<p>${toc}</p>`,
        '<h2>Item 1. Financial Statements</h2>', `<p>${filler('STMTBODY', 60)}</p>`,
        "<h2>Item 2. Management's Discussion and Analysis of Financial Condition and Results of Operations</h2>",
        `<p>${driverSentence} ${filler('MDABODY', 60)}</p>`,
        '<h2>Item 3. Quantitative and Qualitative Disclosures About Market Risk</h2>', `<p>${filler('QUANTBODY', 30)}</p>`,
        '<h2>Item 4. Controls and Procedures</h2>', `<p>${filler('CTRLBODY', 30)}</p>`,
        '<h2>Item 1. Legal Proceedings</h2>', `<p>${filler('LEGALBODY', 20)}</p>`,
        '<h2>Item 1A. Risk Factors</h2>', `<p>${filler('RISKBODY', 60)}</p>`,
        '<h2>Item 6. Exhibits</h2>', `<p>${filler('EXHBODY', 10)}</p>`,
        '</body></html>'
    ].join('\n');
}

const DRIVER = 'Net income increased primarily due to higher average selling prices for flash memory and increased demand from datacenter customers.';

test('mdnaFromHtml isolates Item 2 MD&A with the driver sentence', () => {
    const entry = askMdna.mdnaFromHtml(buildTenQHtml(DRIVER), { form: '10-Q', date: '2026-10-30', url: 'https://example.test/q3.htm' });
    assert.ok(entry, 'MD&A extracted');
    const mdna = entry.sections.find(s => s.heading === 'MD&A — Item 2');
    assert.ok(mdna, 'MD&A section present');
    assert.match(mdna.text, /higher average selling prices for flash memory/);
    assert.doesNotMatch(mdna.text, /RISKBODY/, 'Part II risk factors are a separate excerpt');
});

test('extractMdna reads the latest 10-Qs and attributes each excerpt to its filing', async () => {
    const filings = [
        { form: '10-Q', date: '2026-10-30', url: 'https://example.test/q4.htm', accession: 'a4' },
        { form: '10-Q', date: '2026-08-01', url: 'https://example.test/q3.htm', accession: 'a3' },
        { form: '10-K', date: '2026-06-30', url: 'https://example.test/k.htm', accession: 'k1' }
    ];
    const out = await askMdna.extractMdna('sndk', {
        quarters: 2,
        _deps: {
            fetchFilings: async () => filings.slice(0, 2),
            get: async (url) => ({ data: buildTenQHtml(`${url} ${DRIVER}`) })
        }
    });
    assert.equal(out.symbol, 'SNDK');
    assert.equal(out.sourceType, 'sec_mdna');
    assert.equal(out.filings.length, 2);
    assert.match(out.filings[0].sections[0].text, /q4\.htm/);
    assert.match(out.filings[1].sections[0].text, /q3\.htm/);
    assert.match(out.note, /Management’s Discussion and Analysis/);
});

test('extractMdna reports honest errors instead of inventing context', async () => {
    const none = await askMdna.extractMdna('ZZZZ', { _deps: { fetchFilings: async () => [] } });
    assert.match(none.error, /No quarterly report/);

    const unfetchable = await askMdna.extractMdna('SNDK', {
        _deps: {
            fetchFilings: async () => [{ form: '10-Q', date: '2026-10-30', url: 'https://example.test/q.htm' }],
            get: async () => { throw new Error('offline'); }
        }
    });
    assert.match(unfetchable.error, /Could not read MD&A/);
});

test('a filing with no extractable MD&A does not sink the whole read', async () => {
    const filings = [
        { form: '10-Q', date: '2026-10-30', url: 'https://example.test/empty.htm' },
        { form: '10-Q', date: '2026-08-01', url: 'https://example.test/good.htm' }
    ];
    const out = await askMdna.extractMdna('SNDK', {
        _deps: {
            fetchFilings: async () => filings,
            get: async (url) => ({ data: url.includes('empty') ? '<html><body>no item numbering at all</body></html>' : buildTenQHtml(DRIVER) })
        }
    });
    assert.equal(out.filings.length, 1);
    assert.match(out.filings[0].url, /good\.htm/);
});

test('a long overview does not cut off management’s reasons', () => {
    // Overview past any excerpt budget, with the period-comparison sentences
    // deeper in the document. The transport trim keeps only the FIRST bytes of
    // each excerpt, so a head-only slice lost every reason and the answer fell
    // back to the receipt with the tool installed (measured on SNDK).
    const longOverview = filler('OVERVIEW', 700); // ~28k chars
    const resultsBlock = 'Results of Operations Three Months Ended October 2, 2026 versus October 3, 2025. Net revenues increased $3.2 billion, or 41%, primarily due to higher NAND pricing and datacenter demand. ' + filler('RESULTSBODY', 200);
    const html = buildTenQHtml(`${longOverview} ${resultsBlock}`);
    const entry = askMdna.mdnaFromHtml(html, { form: '10-Q', date: '2026-10-30', url: 'https://example.test/q.htm' });
    const mdna = entry.sections.find(s => s.heading === 'MD&A — Item 2');
    assert.ok(mdna.trimmed, 'long MD&A is excerpted');
    assert.match(mdna.text, /primarily due to higher NAND pricing and datacenter demand/, 'the reason sentence is kept verbatim');
    assert.ok(mdna.text.length <= askMdna.SECTION_CAPS['MD&A — Item 2'] + 400, 'excerpt stays within the per-filing cap');
});

test('the reasons survive the transport trim the model actually receives', () => {
    // The contract that was missing: mdnaFromHtml output is not what the model
    // reads. ask-report-evidence.boundNarrative trims each text slot to its
    // first allocation of an 8192-byte pool, so a long excerpt's tail vanishes.
    // SNDK's real 10-Q put every "primarily due to" sentence after the cut.
    const { forModel } = require('../ask-report-evidence');
    const ev = require('../ask-evidence');
    const longOverview = filler('OVERVIEW', 700);
    const drivers = [
        'Datacenter revenue increased 1,685%, primarily due to higher demand from cloud customers.',
        'Net revenue increased 251%, primarily due to a 248% increase in average selling prices per gigabyte.',
        'Consumer revenue decreased 39%, primarily due to lower sales.'
    ].join(' ');
    const html = buildTenQHtml(`${longOverview} Results of Operations Three Months Ended October 2, 2026. ${drivers} ${filler('TAIL', 200)}`);
    const result = askMdna.mdnaFromHtml(html, { form: '10-Q', date: '2026-10-30', url: 'https://www.sec.gov/Archives/edgar/data/1/0001/tenq.htm' });
    const out = forModel('get_mdna', { symbol: 'SNDK', sourceType: 'sec_mdna', filings: [result] }, ev.METERED_CONTEXT_BYTES - require('../ask-report-evidence').CONTEXT_RESERVE_BYTES);
    assert.doesNotMatch(out.content, /shortened to fit/, 'nothing should need trimming');
    assert.match(out.content, /1,685%, primarily due to higher demand/, 'the reason sentence reaches the model verbatim');
    assert.match(out.content, /251%, primarily due to a 248% increase/, 'the second reason survives too');
    assert.ok((out.content.match(/primarily due to/g) || []).length >= 3, 'all three reasons reach the model');
});

test('driverExcerpt keeps cause sentences and drops filler', () => {
    const text = `${filler('FILLER', 400)} Segment revenue rose 12% primarily due to pricing. ${filler('MORE', 400)} Margins contracted due to higher input costs of $40 million.`;
    const out = askMdna.driverExcerpt(text, 900);
    assert.match(out, /primarily due to pricing/);
    assert.match(out, /due to higher input costs of \$40 million/);
    assert.ok(out.length <= 900 + 340, 'bounded by the budget plus its lead');
});
