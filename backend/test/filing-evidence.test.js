'use strict';

// The monitor's "BEFORE → AFTER · SEC TEXT" column was blank for every row of
// every company, permanently: `evidenceVerified` was read by the renderer but
// set nowhere in the codebase, and the diff schema only ever asked for ONE
// quote, from the new filing. These tests pin the producing half so the panel
// cannot silently go back to being decorative.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const diffSource = fs.readFileSync(path.join(root, 'backend', 'filing-diff.js'), 'utf8');
const monitorSource = fs.readFileSync(path.join(root, 'frontend-v2', 'assets', 'monitor.js'), 'utf8');
const { normalizeQuote, quoteIsInSource, DIFF_SCHEMA_V } = require('../filing-diff');

test('the model is asked for a matched pair, one quote per document', () => {
    assert.match(diffSource, /"priorQuote": str\|null, "newQuote": str\|null/);
    assert.match(diffSource, /copied WORD FOR WORD from the PRIOR FILING excerpt/);
    // the old single-quote schema must not come back
    assert.doesNotMatch(diffSource, /"what": str, "quote": str\|null/);
});

test('a quote counts as evidence only if it is really in the document it cites', () => {
    const prior = 'Gross margin was 53% for the quarter ended March 29, 2026.';
    const now = 'Gross margin was 54% for the quarter ended June 27, 2026.';
    assert.equal(quoteIsInSource('Gross margin was 53%', prior), true);
    // the same claim against the WRONG document must fail — this is the check
    // that makes a "before → after" pair mean anything
    assert.equal(quoteIsInSource('Gross margin was 53%', now), false);
    assert.equal(quoteIsInSource('Gross margin was 54%', now), true);
});

test('paraphrase and invention are rejected; honest punctuation drift is not', () => {
    const doc = 'We expect the Helios rack–scale platform to ship in 2027, and revenue increased 50%.';
    assert.equal(quoteIsInSource('the Helios rack-scale platform to ship in 2027', doc), true, 'en-dash folds');
    assert.equal(quoteIsInSource('revenue increased 50%', doc), true, 'nbsp folds');
    assert.equal(quoteIsInSource('Revenue  INCREASED  50%', doc), true, 'case and spacing fold');
    assert.equal(quoteIsInSource('revenue grew by half', doc), false, 'paraphrase rejected');
    assert.equal(quoteIsInSource('revenue increased 62%', doc), false, 'invented figure rejected');
    assert.equal(quoteIsInSource('revenue', doc), false, 'too short to be evidence');
    assert.equal(quoteIsInSource(null, doc), false);
    assert.equal(normalizeQuote('  A’s  B“C” '), "a's b\"c\"");
});

test('evidenceVerified is derived from the check, never taken from the model', () => {
    // it must be computed from the two verified quotes, not read off the JSON
    assert.match(diffSource, /evidenceVerified: !!\(priorQuote && newQuote\)/);
    assert.doesNotMatch(diffSource, /evidenceVerified: !!\(c && c\.evidenceVerified\)/);
    // `quote` is still emitted: the company page and alerts read it
    assert.match(diffSource, /quote: newQuote/);
});

test('cached rows from before paired quotes existed re-extract', () => {
    // without this the panel stays blank until the company files again, because
    // the cache key is {symbol, accession, prevAccession} with no version
    assert.equal(DIFF_SCHEMA_V >= 2, true);
    assert.match(diffSource, /hit\.payload\.v === DIFF_SCHEMA_V/);
    assert.match(diffSource, /v: DIFF_SCHEMA_V/);
});

test('the panel renders three states and never a column of apologies', () => {
    assert.match(monitorSource, /const newOnly = !paired && !!c\.newQuote/);
    assert.match(monitorSource, /mon-quote-single/);
    // when nothing is quotable the meaning column takes the full width
    assert.match(monitorSource, /const withEvidence = changes\.filter/);
    assert.match(monitorSource, /mon-evidence-grid is-single/);
    // the old blanket message is gone
    assert.doesNotMatch(monitorSource, /No verified before-and-after passage is available/);
    // and the footnote no longer over-claims
    assert.doesNotMatch(monitorSource, /Only source-verified quotation pairs are displayed/);
});

// ---- palette: blue removed, and the two jobs it was doing split apart ----

const cssPalette = fs.readFileSync(path.join(root, 'frontend-v2', 'assets', 'system.css'), 'utf8');
const bundle = fs.readFileSync(path.join(root, 'frontend-v2', 'assets', 'app.js'), 'utf8');
const dash = fs.readFileSync(path.join(root, 'frontend-v2', 'assets', 'dashboard.js'), 'utf8');

const relLum = (hex) => {
    const v = hex.replace('#', '').match(/../g).map((h) => parseInt(h, 16) / 255)
        .map((x) => (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)));
    return 0.2126 * v[0] + 0.7152 * v[1] + 0.0722 * v[2];
};
const contrast = (a, b) => {
    const [hi, lo] = [relLum(a), relLum(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
};
const token = (name) => cssPalette.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, 'i'))[1];

test('no blue survives in the shared stylesheet', () => {
    // strip comments first: the token block documents the colour it replaced,
    // and that note is worth keeping
    const declarations = cssPalette.replace(/\/\*[\s\S]*?\*\//g, '');
    const blues = (declarations.match(/#[0-9a-fA-F]{6}/g) || []).filter((h) => {
        const [r, g, b] = h.slice(1).match(/../g).map((x) => parseInt(x, 16));
        return b > r + 30 && b > g + 20;
    });
    assert.deepEqual(blues, [], `blue literals left in system.css: ${blues.join(', ')}`);
});

test('the accent stays legible and the series stays separable', () => {
    const paper = token('paper'), ink = token('ink');
    const accent = token('accent'), series = token('series-2');
    // body-text contrast for the interactive tone
    assert.ok(contrast(accent, paper) >= 4.5, `accent vs paper ${contrast(accent, paper).toFixed(2)}:1`);
    // a chart series only needs the 3:1 non-text floor, but it must clear it
    // against the OTHER series (--ink), which is the whole reason it exists
    assert.ok(contrast(series, ink) >= 3, `series-2 vs ink ${contrast(series, ink).toFixed(2)}:1`);
    assert.ok(contrast(series, paper) >= 3, `series-2 vs paper ${contrast(series, paper).toFixed(2)}:1`);
});

test('data series read from --series-2, never the interactive tone', () => {
    for (const rule of ['.ask-viz-legend .lg-accent', '.fund-bar-fill', '.vf-bar.filed', '.pv-pair-fill.b']) {
        const line = cssPalette.split('\n').find((l) => l.includes(rule));
        assert.ok(line && line.includes('--series-2'), `${rule} should use --series-2, got: ${line}`);
    }
    assert.match(bundle, /accent: 'var\(--series-2\)'/);
});

test('prose links are underlined; nav and chips are not', () => {
    assert.match(cssPalette, /\.ask-a a[\s\S]{0,120}text-decoration: underline/);
    assert.match(cssPalette, /\.nav-links a[\s\S]{0,140}text-decoration: none/);
});

test('the allocation palette separates by lightness, not hue', () => {
    const pal = dash.match(/const ALLOC_COLORS = \[([^\]]+)\]/)[1]
        .match(/#[0-9a-f]{6}/gi);
    assert.equal(pal.length, 10);
    const ls = pal.map(relLum).sort((a, b) => a - b);
    const gaps = ls.slice(1).map((v, i) => v - ls[i]);
    // the two blues it replaced were exact lightness twins of greys already in
    // the palette (0.107/0.107 and 0.243/0.242) — only hue told them apart, so
    // in greyscale they collided outright
    assert.ok(Math.min(...gaps) > 0.02, `slices too close in lightness: min gap ${Math.min(...gaps).toFixed(3)}`);
});
