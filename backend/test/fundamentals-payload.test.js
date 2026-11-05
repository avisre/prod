'use strict';

// The browser payload must stay small enough to serve on every company-page
// view. On 2026-11-05 the full answer was 2.9 MB decoded / 250 KB on the wire,
// and 2.0 MB of it was `provenance.sources` — a map no client code reads,
// except the one stock-based-compensation id behind the SBC panel's filing
// link. These cases hold both halves of that contract: the map is gone, and
// the id the page does need still resolves.

const test = require('node:test');
const assert = require('node:assert/strict');
const { browserFundamentals, referencedSourceIds } = require('../fundamentals-payload');

function row(sbcId, otherIds = ['src-other']) {
    return { fiscalDateEnding: '2025-09-27', operatingCashflow: 1, _sources: { operatingCashflow: otherIds, shareBasedCompensation: sbcId ? [sbcId] : [] } };
}

function payload() {
    return {
        overview: { Name: 'Apple Inc.' },
        income: { annualReports: [row('sbc-2025')], quarterlyReports: [row('sbc-q')] },
        balance: { annualReports: [row(null)], quarterlyReports: [] },
        cash: { annualReports: [row('sbc-2025')], quarterlyReports: [row(null)] },
        employees: { 2025: 166000 },
        provenance: {
            sources: {
                'sbc-2025': { filingUrl: 'https://www.sec.gov/a.htm', form: '10-K' },
                'sbc-q': { filingUrl: 'https://www.sec.gov/q.htm', form: '10-Q' },
                'src-other': { filingUrl: 'https://www.sec.gov/other.htm' },
                'unreferenced-1': { filingUrl: 'https://www.sec.gov/x.htm' },
                'unreferenced-2': { filingUrl: 'https://www.sec.gov/y.htm' }
            }
        }
    };
}

test('the per-fact source map is reduced to the ids the page actually reads', () => {
    const out = browserFundamentals(payload());
    assert.deepEqual(Object.keys(out.provenance.sources).sort(), ['sbc-2025', 'sbc-q']);
    // the row ids the page never looks up are gone with the map
    assert.equal(out.provenance.sources['src-other'], undefined);
    assert.equal(out.provenance.sources['unreferenced-1'], undefined);
});

test('the stock-based-compensation id still resolves to its filing', () => {
    const out = browserFundamentals(payload());
    const rowId = out.cash.annualReports[0]._sources.shareBasedCompensation[0];
    assert.equal(out.provenance.sources[rowId].filingUrl, 'https://www.sec.gov/a.htm');
    assert.equal(out.provenance.sources[rowId].form, '10-K');
});

test('statements, employees and coverage are passed through untouched', () => {
    const input = payload();
    const out = browserFundamentals(input);
    assert.equal(out.overview.Name, 'Apple Inc.');
    assert.equal(out.employees[2025], 166000);
    assert.deepEqual(out.income.annualReports, input.income.annualReports);
    assert.deepEqual(out.cash.quarterlyReports, input.cash.quarterlyReports);
    assert.equal(out.freshness, input.freshness);
});

test('a payload with no provenance, or no rows, is returned as-is', () => {
    const bare = { overview: { Name: 'X' } };
    assert.equal(browserFundamentals(bare), bare);
    assert.equal(browserFundamentals(null), null);
    const empty = { income: {}, provenance: { sources: { a: { filingUrl: 'u' } } } };
    assert.deepEqual(browserFundamentals(empty).provenance.sources, {});
});

test('referencedSourceIds tolerates rows without a source map', () => {
    const body = { income: { annualReports: [{}, { _sources: null }, { _sources: { shareBasedCompensation: [] } }] } };
    assert.equal(referencedSourceIds(body).size, 0);
});

test('the reduction is large: a 400-source map collapses to the referenced handful', () => {
    const body = payload();
    for (let i = 0; i < 400; i += 1) body.provenance.sources[`filler-${i}`] = { filingUrl: `https://www.sec.gov/f${i}.htm`, rawValue: i };
    const before = JSON.stringify(body).length;
    const after = JSON.stringify(browserFundamentals(body)).length;
    assert.ok(after < before / 5, `expected a >80% cut, got ${before} -> ${after}`);
});
