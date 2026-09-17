// Regression for the `what`-field figure check. Both fixtures are real rows
// that were served to a prospect on 2026-09-17: verified quotes sitting beside
// numbers that appear in neither filing. Quotes were already checked
// character-for-character; the prose around them was not, which is the gap
// this closes.
const test = require('node:test');
const assert = require('node:assert');
const {
    extractFigures, figureMantissa, sourceMantissaSet, stripUnsupportedFigures
} = require('../filing-diff');

test('mantissa is scale-invariant so thousands tables match billions prose', () => {
    // "$49.8 billion" in the narrative and "49,836" in a table reported in
    // thousands are the same fact; both must reduce to the same mantissa.
    assert.strictEqual(figureMantissa('49.8'), figureMantissa('49,836'));
    assert.strictEqual(figureMantissa('$107,662'), figureMantissa('107.7'));
    assert.notStrictEqual(figureMantissa('9.0'), figureMantissa('15,976'));
});

test('years and bare small integers are not treated as claims', () => {
    const toks = extractFigures('In 2026 the company moved to two segments and filed an 8-K.').map((f) => f.token.trim());
    assert.deepStrictEqual(toks, []);
});

test('AAOI: the fabricated prior operating loss is removed, the true one kept', () => {
    const source = 'Loss from operations (24,727 ) (15,976 ) Data Center $ 107,662 56.1 % $ 44,791 43.5 %';
    const figures = sourceMantissaSet(source);
    const what = 'The operating loss widened to $24.7 million in the current quarter from $9.0 million in the prior year quarter.';
    const out = stripUnsupportedFigures(what, figures);
    assert.ok(out.removed.some((t) => t.includes('9.0')), 'unsupported $9.0M should be flagged');
    assert.strictEqual(out.what, '', 'the sentence carrying it does not survive');
});

test('AAOI: a sentence whose figures are all in the filing survives intact', () => {
    const source = 'Data Center $ 107,662 56.1 % $ 44,791 43.5 % Total revenue 191,900 99,900';
    const figures = sourceMantissaSet(source);
    const what = 'Data Center revenue grew to $107.7 million from $44.8 million.';
    const out = stripUnsupportedFigures(what, figures);
    assert.deepStrictEqual(out.removed, []);
    assert.strictEqual(out.what, what);
});

test('NVTS: share count contradicting its own quote is dropped', () => {
    const source = '261,080,388 and 230,525,464 shares issued and outstanding at June 30, 2026';
    const figures = sourceMantissaSet(source);
    const out = stripUnsupportedFigures(
        'Outstanding Class A common stock shares increased from 232.0 million to 261.1 million.',
        figures
    );
    assert.ok(out.removed.some((t) => t.includes('232')), '232.0M is in neither filing');
});

test('only the offending sentence is lost, not the whole change', () => {
    const source = 'Revenue 407,012 Customer A 48 % Customer B 39 %';
    const figures = sourceMantissaSet(source);
    const out = stripUnsupportedFigures(
        'Revenue rose to $407.0 million. Customer A fell to 48% while Customer B rose to 39%. Margins reached 88.8%.',
        figures
    );
    assert.ok(out.what.includes('Customer A'), 'supported sentences are preserved');
    assert.ok(out.what.includes('407.0'), 'supported sentences are preserved');
    assert.ok(!out.what.includes('88.8'), 'the unsupported sentence is gone');
});

test('prose with no figures at all is passed through untouched', () => {
    const what = 'The company realigned its reporting structure into two named segments.';
    const out = stripUnsupportedFigures(what, sourceMantissaSet('unrelated filing text'));
    assert.strictEqual(out.what, what);
    assert.deepStrictEqual(out.removed, []);
});
