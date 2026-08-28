const test = require('node:test');
const assert = require('node:assert/strict');

const fsec = require('../filing-sections');

// Minimal filing skeleton: a table of contents naming every Item, then the
// real body further down. This is the shape that defeated the old first-match
// anchoring — re.exec() returned the TOC hit and windows were cut from there.
function buildFiling({ businessHeading = 'Item 1. Business', mdaHeading = "Item 7. Management's Discussion and Analysis" } = {}) {
    const toc = [
        'Item 1. Business', 'Item 1A. Risk Factors', 'Item 3. Legal Proceedings',
        "Item 7. Management's Discussion and Analysis",
        'Item 7A. Quantitative and Qualitative Disclosures', 'Item 8. Financial Statements'
    ].join(' ');
    const filler = (label, n) => `${label} ` + `${label} detail sentence. `.repeat(n);
    return [
        '<html><body>', '<p>Cover page. Commission File Number 000-0000.</p>',
        `<p>${toc}</p>`,
        `<h2>${businessHeading}</h2>`, `<p>${filler('BUSINESSBODY', 60)}</p>`,
        '<h2>Item 1A. Risk Factors</h2>', `<p>${filler('RISKBODY', 60)}</p>`,
        '<h2>Item 3. Legal Proceedings</h2>', `<p>${filler('LEGALBODY', 30)}</p>`,
        `<h2>${mdaHeading}</h2>`, `<p>${filler('MDABODY', 60)}</p>`,
        '<h2>Item 7A. Quantitative and Qualitative Disclosures</h2>', `<p>${filler('QUANTBODY', 30)}</p>`,
        '<h2>Item 8. Financial Statements</h2>', `<p>${filler('FINBODY', 60)}</p>`,
        '</body></html>'
    ].join('\n');
}

test('inline tags are stripped without fusing words apart', () => {
    // SEC filings split words across styling/inline-XBRL tags. Replacing every
    // tag with a space turns "Business" into "Busines s" and breaks anchoring.
    const html = '<p><span>Busines</span><span>s</span> and <ix:nonNumeric>Ris</ix:nonNumeric>k</p>';
    const text = fsec.htmlToText(html);
    assert.match(text, /Business/);
    assert.match(text, /Risk/);
});

test('sections anchor on the body, not the table of contents', () => {
    const { sections } = fsec.extractSections(buildFiling());
    assert.ok(sections['1'], 'Item 1 located');
    // The TOC lists every item within a few hundred chars; a TOC-anchored
    // window would carry the neighbouring headings instead of the body text.
    assert.match(sections['1'].text, /BUSINESSBODY/);
    assert.doesNotMatch(sections['1'].text, /RISKBODY/);
});

test('every core section is located and none starves the others', () => {
    const { sections } = fsec.extractSections(buildFiling());
    for (const key of ['1', '1A', '3', '7', '7A']) {
        assert.ok(sections[key], `Item ${key} located`);
        assert.ok(sections[key].chars > 0, `Item ${key} is non-empty`);
    }
    // The old code filled one buffer front-to-back and broke at a global cap,
    // so later sections got zero bytes. Each section now has its own budget.
    assert.match(sections['1A'].text, /RISKBODY/);
    assert.match(sections['7'].text, /MDABODY/);
    assert.match(sections['7A'].text, /QUANTBODY/);
});

test('a registrant name between item number and title still anchors', () => {
    // e.g. "Item 7. Bank of America Corporation and Subsidiaries Management's
    // Discussion and Analysis" — observed on real bank filings.
    const html = buildFiling({ mdaHeading: "Item 7. Bank of America Corporation and Subsidiaries Management's Discussion and Analysis" });
    const { sections } = fsec.extractSections(html);
    assert.ok(sections['7'], 'MD&A located despite interposed registrant name');
    assert.match(sections['7'].text, /MDABODY/);
});

test('combined "Item 1 and 2" headings anchor', () => {
    const html = buildFiling({ businessHeading: 'Item 1 and 2. Business and Properties' });
    const { sections } = fsec.extractSections(html);
    assert.ok(sections['1'], 'combined Business/Properties heading located');
    assert.match(sections['1'].text, /BUSINESSBODY/);
});

test('financial statements are excluded from the narrative core', () => {
    // Item 8 and its notes dwarf the narrative; pulling them in would crowd out
    // the sections the dossier is actually written from.
    const { sections } = fsec.extractSections(buildFiling());
    for (const key of Object.keys(sections)) assert.notEqual(key, '8');
    assert.doesNotMatch(fsec.sectionsAsText(sections), /FINBODY/);
});

test('oversized sections are trimmed within their own budget, keeping head and tail', () => {
    const big = 'HEADMARK ' + 'filler text here. '.repeat(20000) + ' TAILMARK';
    const html = `<html><body><h2>Item 1. Business</h2><p>${big}</p>` +
        '<h2>Item 1A. Risk Factors</h2><p>' + 'risk. '.repeat(200) + '</p></body></html>';
    const { sections } = fsec.extractSections(html);
    assert.ok(sections['1'].trimmed, 'oversized section is marked trimmed');
    assert.ok(sections['1'].chars <= fsec.SECTION_BUDGETS['1'] + 200, 'stays within budget');
    assert.match(sections['1'].text, /HEADMARK/, 'head retained');
    assert.match(sections['1'].text, /TAILMARK/, 'tail sampled');
    assert.ok(sections['1A'], 'a huge Item 1 does not starve Item 1A');
});

test('bare cross-reference sections are dropped, not reported as content', () => {
    // Banks answer Item 3 with "See Litigation in Note 30" — a pointer, not a
    // section. It should not surface as if it were substance.
    const html = '<html><body><p>Item 1. Business Item 3. Legal Proceedings</p>' +
        '<h2>Item 1. Business</h2><p>' + 'business detail. '.repeat(200) + '</p>' +
        '<h2>Item 3. Legal Proceedings</h2><p>See Litigation in Note 30.</p>' +
        '<h2>Item 8. Financial Statements</h2><p>' + 'notes. '.repeat(200) + '</p></body></html>';
    const { sections } = fsec.extractSections(html);
    assert.ok(sections['1'], 'real section kept');
    assert.ok(!sections['3'], 'pointer-only section dropped');
});

test('plain text input is accepted as well as HTML', () => {
    const text = 'Item 1. Business ' + 'plain body. '.repeat(100) +
        ' Item 1A. Risk Factors ' + 'risk body. '.repeat(100);
    const { sections } = fsec.extractSections(text);
    assert.ok(sections['1'] && sections['1A'], 'sections located in plain text');
});
