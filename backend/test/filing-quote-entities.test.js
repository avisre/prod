// HTML entities must never reach a reader inside a filing quotation.
// INOD's 10-Q (2026-10-18) showed users "Revenues &#8203; $ 92,142 &#8203; $ 58,393":
// Workiva puts a zero-width space entity between table cells and every htmlToText
// copy decoded only a handful of entities. Quotes already cached for every other
// stock carry the same junk, so they are tidied on read and on render too.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { decodeEntities, tidyQuote } = require('../html-text');

const ROOT = path.join(__dirname, '..', '..');
const INOD = [
    ['Revenues &#8203; $ 92,142 &#8203; $ 58,393', 'Revenues $92,142 $58,393'],
    ['Cash and cash equivalents &#8203; $ 117,366 &#8203; $ 82,230', 'Cash and cash equivalents $117,366 $82,230'],
    ['Income before provision for income taxes &#8203; &#8203; 17,342 &#8203; 8,399', 'Income before provision for income taxes 17,342 8,399'],
    ['Balance at end of period &#8203; $ 1,349 &#8203; $ 1,205', 'Balance at end of period $1,349 $1,205'],
    ['margin rose 12 % to ( 3.4 ) million &ldquo;AI&rdquo; &amp; data &#82', 'margin rose 12% to (3.4) million “AI” & data'],
    ['AT&#x26;T&rsquo;s &#160;cash​ flow', 'AT&T’s cash flow']
];
const JUNK = /&#?[a-z0-9]+;|[​-‍⁠﻿ ]/i;

test('tidyQuote turns the INOD quotes into plain text', () => {
    for (const [raw, want] of INOD) assert.equal(tidyQuote(raw), want);
    assert.equal(tidyQuote(null), null);
});

test('decodeEntities decodes numeric, hex and named entities and keeps unknown names', () => {
    assert.equal(decodeEntities('&#8220;x&#8221; &#x2014; &mdash; &frac12;'), '“x” — — ½');
    assert.equal(decodeEntities('a&#0;b'), 'a b', 'an invalid code point becomes a space');
    assert.equal(decodeEntities('&bogus;'), '&bogus;');
});

test('all three htmlToText copies decode the entities a filing table carries', () => {
    const html = '<p>Revenues</p><table><tr><td>&#8203;</td><td>$ 92,142&#160;</td><td>&#8203;</td><td>$ 58,393</td></tr></table><p>&ldquo;AI&rdquo; AT&amp;T&#8217;s &#x2014; data</p>';
    for (const mod of ['../filing-sections', '../filing-fetcher', '../segments']) {
        const { htmlToText } = require(mod);
        assert.equal(typeof htmlToText, 'function', `${mod} no longer exports htmlToText`);
        const out = htmlToText(html);
        assert.doesNotMatch(out, JUNK, `${mod} left an entity in: ${out}`);
        assert.match(out, /92,142/);
        assert.match(out, /“AI”/);
    }
});

test('filing text cached before the decoder existed is decoded as it is read', () => {
    const { decodeCachedText } = require('../filing-fetcher');
    assert.equal(decodeCachedText('Revenues &#8203; $ 92,142 &#8203; $ 58,393'), 'Revenues $ 92,142 $ 58,393');
    const clean = 'Revenues $ 92,142';
    assert.equal(decodeCachedText(clean), clean, 'clean text is returned untouched');
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'mcp-financials.js'), 'utf8'), /decodeCachedText\(hit\.text\)/);
});

test('a filing diff cached with raw quotes is tidied on the way out', () => {
    const { tidyDiffQuotes } = require('../filing-diff');
    const out = tidyDiffQuotes({ v: 1, changes: [{ area: 'Revenue', priorQuote: INOD[0][0], newQuote: INOD[3][0] }, { area: 'Risk', quote: INOD[1][0] }] });
    assert.equal(out.changes[0].priorQuote, INOD[0][1]);
    assert.equal(out.changes[0].newQuote, INOD[3][1]);
    assert.equal(out.changes[1].quote, INOD[1][1]);
    assert.equal(out.v, 1);
});

test('every page that prints a filing quote tidies it first', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
    assert.match(app, /esc\(tidyQuote\(c\.priorQuote\)\)/, '/filing-changes page');
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'filing-monitor.js'), 'utf8'), /tidyQuote\(/);
    for (const f of ['dossier', 'compare-dossiers', 'monitor']) {
        const src = fs.readFileSync(path.join(ROOT, 'frontend-v2', 'assets', f + '.js'), 'utf8');
        assert.doesNotMatch(src, /esc\(c\.(priorQuote|newQuote|quote)\)/, `${f}.js prints a raw quote`);
    }
});

test('the browser copies of tidyQuote match the server one', () => {
    for (const f of ['dossier', 'compare-dossiers', 'monitor']) {
        const src = fs.readFileSync(path.join(ROOT, 'frontend-v2', 'assets', f + '.js'), 'utf8');
        const start = src.indexOf('const tidyQuote =');
        const end = src.indexOf('.trim();', start);
        assert.ok(start > 0 && end > start, `${f}.js tidyQuote markers moved — update this test`);
        const ctx = {};
        vm.createContext(ctx);
        vm.runInContext(src.slice(start, end + 8) + '\nglobalThis.__t = tidyQuote;', ctx);
        for (const [raw, want] of INOD) assert.equal(ctx.__t(raw), want, `${f}.js: ${raw}`);
    }
});
