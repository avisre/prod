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
