const test = require('node:test');
const assert = require('node:assert/strict');

const fsec = require('../filing-sections');

// Minimal 10-Q skeleton: cover, a table of contents naming every Part I and
// Part II item, then the real bodies in document order. The 10-Q item scheme
// puts MD&A at Item 2 (financial statements at Item 1, market risk at Item 3,
// controls at Item 4) — the 10-K table located nothing here, which is what
// left "why did profit change" questions with no retrievable explanation.
function buildTenQ({ mdaHeading = "Item 2. Management's Discussion and Analysis of Financial Condition and Results of Operations" } = {}) {
    const toc = [
        'Item 1. Financial Statements',
        "Item 2. Management's Discussion and Analysis of Financial Condition and Results of Operations",
        'Item 3. Quantitative and Qualitative Disclosures About Market Risk',
        'Item 4. Controls and Procedures',
        'Item 1. Legal Proceedings', 'Item 1A. Risk Factors',
        'Item 2. Unregistered Sales of Equity Securities', 'Item 5. Other Information', 'Item 6. Exhibits'
    ].join(' ');
    const filler = (label, n) => `${label} ` + `${label} detail sentence. `.repeat(n);
    return [
        '<html><body>', '<p>Cover page. Commission File Number 000-0000. FORM 10-Q.</p>',
        `<p>${toc}</p>`,
        '<h2>PART I — FINANCIAL INFORMATION</h2>',
        '<h2>Item 1. Financial Statements</h2>', `<p>${filler('STMTBODY', 80)}</p>`,
        `<h2>${mdaHeading}</h2>`, `<p>${filler('MDABODY', 90)}</p>`,
        '<h2>Item 3. Quantitative and Qualitative Disclosures About Market Risk</h2>', `<p>${filler('QUANTBODY', 30)}</p>`,
        '<h2>Item 4. Controls and Procedures</h2>', `<p>${filler('CTRLBODY', 30)}</p>`,
        '<h2>PART II — OTHER INFORMATION</h2>',
        '<h2>Item 1. Legal Proceedings</h2>', `<p>${filler('LEGALBODY', 20)}</p>`,
        '<h2>Item 1A. Risk Factors</h2>', `<p>${filler('RISKBODY', 80)}</p>`,
        '<h2>Item 6. Exhibits</h2>', `<p>${filler('EXHBODY', 10)}</p>`,
        '</body></html>'
    ].join('\n');
}

test('the 10-Q profile is selected for 10-Q and 10-Q/A forms', () => {
    for (const form of ['10-Q', '10-Q/A']) {
        const profile = fsec.profileFor(form);
        assert.deepEqual(profile.keys, fsec.CORE_KEYS_10Q);
        assert.ok(profile.sections.some(s => s.label === 'MD&A' && s.key === '2'), '10-Q MD&A is Item 2');
    }
    // The 10-K and 20-F profiles are untouched.
    assert.ok(fsec.profileFor('10-K').sections.some(s => s.label === 'MD&A' && s.key === '7'));
    assert.ok(fsec.profileFor('20-F').sections.some(s => s.label === 'Operating and Financial Review'));
});

test('10-Q MD&A anchors on the Part I body, not the table of contents', () => {
    const { sections } = fsec.extractSections(buildTenQ(), { form: '10-Q' });
    assert.ok(sections['2'], 'Item 2 MD&A located');
    assert.match(sections['2'].text, /MDABODY/);
    // Neighbouring sections must not bleed into the MD&A window.
    assert.doesNotMatch(sections['2'].text, /STMTBODY/);
    assert.doesNotMatch(sections['2'].text, /QUANTBODY/);
    assert.doesNotMatch(sections['2'].text, /RISKBODY/);
});

test('Part II Item 1A risk factors are located in a 10-Q', () => {
    const { sections } = fsec.extractSections(buildTenQ(), { form: '10-Q' });
    assert.ok(sections['P2-1A'], 'Part II risk factors located');
    assert.match(sections['P2-1A'].text, /RISKBODY/);
    assert.doesNotMatch(sections['P2-1A'].text, /EXHBODY/);
});

test('a mid-MD&A cross-reference with a short span is repaired past the citation', () => {
    // "See Item 3. Quantitative …" inside MD&A: the anchor lands on the
    // citation, its span to the real Item 3 heading plus Item 3's short body
    // is under minChars, and repairShortPicks walks it onto the real heading.
    const base = buildTenQ();
    const withCite = base.replace('</h2>\n<p>QUANTBODY', '</h2>\n<p>See Item 3. Quantitative and Qualitative Disclosures About Market Risk for instruments. </p><p>QUANTBODY');
    // Put the citation INSIDE MD&A instead: insert before the Item 3 heading.
    const html = withCite.replace('<h2>Item 3. Quantitative', '<p>See Item 3. Quantitative and Qualitative Disclosures About Market Risk for instruments. Cross reference only, the body continues below this line.</p>\n<h2>Item 3. Quantitative');
    const { sections } = fsec.extractSections(html, { form: '10-Q' });
    assert.ok(sections['2'], 'MD&A located despite the citation');
    // The whole MD&A body is present: the tail sentence after the citation survives.
    assert.match(sections['2'].text, /MDABODY/);
    assert.match(sections['2'].text, /Cross reference only, the body continues below this line/);
});
