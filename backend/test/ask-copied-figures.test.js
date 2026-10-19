'use strict';
const test = require('node:test');
const assert = require('node:assert');
const q = require('../ask-answer-quality');

// Figures an answer copies unchanged from a fetched SEC filing, from the red-flags
// scanner, or from an earlier checked answer in the same thread (2026-10-19).
const flagged = (text, results, options) => q.numericClaims(text, results, options?.question || '', options?.prior || []).map((s) => s.replace(/ is not .*/, ''));
// The issuer's own filed XBRL facts fix "$" as USD for a page that declares no currency.
const financials = (cik) => ({ tool: 'get_financials', result: { symbol: 'X', observations: [], provenance: { sources: { a: { type: 'sec_xbrl_fact', cik, unit: 'USD', linkage: 'xbrl_fact' } } } } });

test('a table cell on a fetched filing is supported only when restated exactly at the page scale', () => {
    // ARM's FY2026 10-K revenue table, as fetch_page returns it
    const url = 'https://www.sec.gov/Archives/edgar/data/1973239/000197323926000097/arm-20260331.htm';
    const results = [financials('0001973239'), { tool: 'fetch_page', result: { url, note: 'Text excerpt extracted directly from the linked SEC filing.',
        text: '(in millions, except percentages) 2026 2025 % Change License and Other Revenue $ 1,298 $ 1,421 (9) % $ 1,009 $ 418 141 % $ 2,307 $ 1,839 25 % Royalty Revenue 2,123 1,763 20 % 490 405 21 % 2,613 2,168 21 %' } }];
    assert.deepStrictEqual(flagged('Royalty revenue was $2,613m and licence revenue $2,307m; related-party licence revenue rose 141%, while external licence revenue fell 9%.', results), []);
    // a rounded cell, or one that is not on the page, is not the filed figure
    assert.deepStrictEqual(flagged('Royalty revenue was $2.6bn.', results), ['Monetary claim $2.6bn']);
    assert.deepStrictEqual(flagged('Royalty revenue was $2,614m.', results), ['Monetary claim $2,614m']);
    // a year is not an amount
    assert.deepStrictEqual(flagged('It earned $2,026m.', results), ['Monetary claim $2,026m']);
    // a page outside SEC's archive supplies nothing
    const elsewhere = [results[0], { tool: 'fetch_page', result: { ...results[1].result, url: 'https://example.com/arm.htm' } }];
    assert.deepStrictEqual(flagged('Royalty revenue was $2,613m, up 141%.', elsewhere), ['Monetary claim $2,613m', 'Percentage claim 141%']);
});

test('narrative amounts count even when the fetch keyword was not found; the answer\'s own arithmetic does not', () => {
    // AerCap's Q4 2025 earnings release (6-K), which declares no currency
    const url = 'https://www.sec.gov/Archives/edgar/data/1378789/000162828026005942/aercap2025fourthquarterear.htm';
    const results = [financials('0001378789'), { tool: 'fetch_page', result: { url, note: 'Keyword "insurance settlement" not found in this document. Start of the document shown.',
        text: 'Sold $3.9 billion of assets for record gains on sale of $819 million. Net income of $3.8 billion, or $21.30 per share. Adjusted net income of $2.7 billion, or $15.37 per share. Quarterly dividend increased to $0.40 per share. Gain-on-sale margin of 27%.' } }];
    assert.deepStrictEqual(flagged('AerCap sold $3.9bn of aircraft for gains of $819 million (a 27% margin); net income was $3.8bn ($21.30 per share) and the dividend rises to $0.40.', results), []);
    assert.deepStrictEqual(flagged('Net income exceeded adjusted net income by $1.1bn.', results), ['Monetary claim $1.1bn']);
});

test('a copied filing figure does not support a claim that names an obligation', () => {
    const url = 'https://www.sec.gov/Archives/edgar/data/1/000000000000000001/report.htm';
    const results = [financials('0000000001'), { tool: 'fetch_page', result: { url, text: 'All amounts are in USD. (in millions) Revenue 4,920 Operating cash flow 5,400' } }];
    assert.deepStrictEqual(flagged('Operating cash flow was $5,400m, and the lease book was stable.', results), []);
    assert.deepStrictEqual(flagged('The company carries $5,400m of debt.', results), ['Monetary claim $5,400m']);
});

test('red-flag findings are claimable as the scanner states them', () => {
    const results = [financials('0000000001'), { tool: 'get_red_flags', result: { symbol: 'MGNI', flags: [{ severity: 'warn', title: 'Share count rising (dilution)',
        detail: 'Shares outstanding grew 8.1% over 4 years (132.2M → 143M) — existing holders\' stakes are being diluted.' }, { severity: 'warn', title: 'Heavy debt load',
        detail: 'Total debt of USD 1,234.5M is 6.1× last year\'s operating cash flow — it would take years of cash flow to clear.' }], flagCount: 2 } }];
    assert.deepStrictEqual(flagged('The share count grew 8.1% over four years, and debt stands at USD 1,234.5M.', results), []);
    assert.deepStrictEqual(flagged('The share count grew 9.1%.', results), ['Percentage claim 9.1%']);
});

test('a follow-up may restate the figures an earlier answer in its thread passed the check with', () => {
    const results = [financials('0000000001')];
    const history = [
        { role: 'user', content: 'How did MGNI do?' },
        { role: 'assistant', content: 'Net income rose +287% to $2.6bn.', figures: [{ v: 287, u: '%' }, { v: 2.6e9, u: 'USD' }, { v: 'x', u: '%' }, { v: 5, u: 'bogus' }] },
        // a user turn never carries figures
        { role: 'user', content: 'ok', figures: [{ v: 13, u: '%' }] }
    ];
    const prior = q.priorFigures(history);
    assert.deepStrictEqual(prior, [{ v: 287, u: '%' }, { v: 2.6e9, u: 'USD' }]);
    assert.deepStrictEqual(flagged('As noted, net income rose +287% to $2.6bn.', results, { prior }), []);
    assert.deepStrictEqual(flagged('As noted, net income rose +287% and Square grew +13%.', results), ['Percentage claim +287%', 'Percentage claim +13%']);
    assert.deepStrictEqual(flagged('Square grew +13%.', results, { prior }), ['Percentage claim +13%']);
    assert.deepStrictEqual(q.priorFigures([{ role: 'assistant', content: 'x' }]), []);
});

test('only the figures that passed are recorded for the thread, and none when the check did not run', () => {
    const url = 'https://www.sec.gov/Archives/edgar/data/1/000000000000000001/report.htm';
    const results = [financials('0000000001'), { tool: 'fetch_page', result: { url, text: 'All amounts are in USD. Revenue was $4.9 billion, up 23%.' } }];
    assert.deepStrictEqual(q.checkedFigures('Revenue was $4.9bn, up 23%; profit was $1.1bn, up 40%.', results), [{ v: 4.9e9, u: 'USD' }, { v: 23, u: '%' }]);
    // no financial research: nothing was checked, so nothing is carried forward
    assert.deepStrictEqual(q.checkedFigures('Revenue was $4.9bn, up 23%.', [{ tool: 'search_web', result: { results: [] } }]), []);
    assert.deepStrictEqual(q.checkedFigures('Suppose revenue were $4.9bn.', results, 'suppose revenue doubled'), []);
});
