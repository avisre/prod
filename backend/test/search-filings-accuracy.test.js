// Regression guard for the "Ask cited a stale 10-K as the latest" bug
// (root cause of a confirmed AppSumo refund — see .claude/HANDOFF.md, 9/4).
// EDGAR's full-text search ranks by relevance, not recency, so it can put an
// older annual report ahead of the current one. toolSearchFilings now
// cross-checks ticker+periodic-form queries against watchdog.fetchRecentFilings
// (SEC's own chronological feed) and always returns results newest-first.
// These tests pin that behavior so a future edit to the merge/sort logic
// cannot silently reintroduce the stale-filing bug.

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');

const aiChat = require('../ai-chat');
const secSource = require('../sec-source');
const watchdog = require('../watchdog');

// A relevance-ranked EDGAR response, deliberately NOT in date order — this is
// the exact shape of the real bug: the true latest filing (2026-02-25) is
// buried behind older ones because it matched the query text less well.
function edgarHit({ form, filed, accession, file }) {
    return {
        _id: `${accession}:${file}`,
        _source: { display_names: ['NVIDIA CORP'], form, file_date: filed, period_ending: null, ciks: ['1045810'] }
    };
}
const SCRAMBLED_NVDA_HITS = [
    edgarHit({ form: '10-K', filed: '2024-02-21', accession: '0000000000-24-000002', file: 'nvda-10k-2024.htm' }),
    edgarHit({ form: '10-K', filed: '2023-02-24', accession: '0000000000-23-000002', file: 'nvda-10k-2023.htm' }),
    edgarHit({ form: '10-K', filed: '2025-02-26', accession: '0000000000-25-000002', file: 'nvda-10k-2025.htm' }),
];
const TRUE_LATEST = {
    accession: '0000000000-26-000002', form: '10-K', date: '2026-02-25',
    url: 'https://www.sec.gov/Archives/edgar/data/1045810/000000000026000002/nvda-10k-2026.htm'
};

function mockEdgarSearch(t, hits) {
    return t.mock.method(axios, 'get', async () => ({
        data: { hits: { hits, total: { value: hits.length } } }
    }));
}

test('a periodic-form ticker query surfaces the confirmed-latest filing first, even when EDGAR ranks it lower', async (t) => {
    mockEdgarSearch(t, SCRAMBLED_NVDA_HITS);
    t.mock.method(secSource, 'cikFor', async () => '1045810');
    const fetchRecent = t.mock.method(watchdog, 'fetchRecentFilings', async () => [TRUE_LATEST]);

    const out = await aiChat.toolSearchFilings({ query: 'risk factors', ticker: 'NVDA', forms: '10-K' });

    assert.equal(fetchRecent.mock.callCount(), 1, 'should cross-check against the chronological feed');
    assert.ok(out.results.length >= 4, 'confirmed-latest is merged in, not swapped for the relevance results');
    assert.equal(out.results[0].url, TRUE_LATEST.url, 'the true latest filing must be first');
    assert.equal(out.results[0].confirmedLatest, true);

    const filedDates = out.results.map((r) => r.filed);
    const sorted = [...filedDates].sort().reverse();
    assert.deepEqual(filedDates, sorted, 'results must be strictly newest-first');
});

test('a date-range query is left to relevance search — no cross-check, no confirmedLatest tag', async (t) => {
    mockEdgarSearch(t, SCRAMBLED_NVDA_HITS);
    t.mock.method(secSource, 'cikFor', async () => '1045810');
    const fetchRecent = t.mock.method(watchdog, 'fetchRecentFilings', async () => [TRUE_LATEST]);

    const out = await aiChat.toolSearchFilings({
        query: 'risk factors', ticker: 'NVDA', forms: '10-K', start_date: '2023-01-01', end_date: '2024-12-31'
    });

    assert.equal(fetchRecent.mock.callCount(), 0, 'a bounded date range means the caller does not want "the latest"');
    assert.ok(out.results.every((r) => !r.confirmedLatest));
});

test('a non-periodic form (e.g. 8-K) does not trigger the latest-filing cross-check', async (t) => {
    mockEdgarSearch(t, SCRAMBLED_NVDA_HITS);
    t.mock.method(secSource, 'cikFor', async () => '1045810');
    const fetchRecent = t.mock.method(watchdog, 'fetchRecentFilings', async () => [TRUE_LATEST]);

    const out = await aiChat.toolSearchFilings({ query: 'material event', ticker: 'NVDA', forms: '8-K' });

    assert.equal(fetchRecent.mock.callCount(), 0, '8-K is not "the latest annual/quarterly report" shape');
    assert.ok(out.results.every((r) => !r.confirmedLatest));
});

test('results are always returned newest-first, even for a broad no-ticker query', async (t) => {
    mockEdgarSearch(t, [
        edgarHit({ form: '10-K', filed: '2022-06-01', accession: '0000000000-22-000001', file: 'a.htm' }),
        edgarHit({ form: '10-K', filed: '2025-06-01', accession: '0000000000-25-000001', file: 'b.htm' }),
        edgarHit({ form: '10-K', filed: '2023-06-01', accession: '0000000000-23-000001', file: 'c.htm' }),
    ]);
    const fetchRecent = t.mock.method(watchdog, 'fetchRecentFilings', async () => [TRUE_LATEST]);

    const out = await aiChat.toolSearchFilings({ query: 'gross margin', forms: '10-K' });

    assert.equal(fetchRecent.mock.callCount(), 0, 'no ticker means there is no single "latest filing" to confirm');
    assert.deepEqual(out.results.map((r) => r.filed), ['2025-06-01', '2023-06-01', '2022-06-01']);
});

test('a failing chronological-feed lookup degrades to the plain relevance results, not an error', async (t) => {
    mockEdgarSearch(t, SCRAMBLED_NVDA_HITS);
    t.mock.method(secSource, 'cikFor', async () => '1045810');
    t.mock.method(watchdog, 'fetchRecentFilings', async () => { throw new Error('EDGAR submissions feed timed out'); });

    const out = await aiChat.toolSearchFilings({ query: 'risk factors', ticker: 'NVDA', forms: '10-K' });

    assert.equal(out.error, undefined, 'a best-effort cross-check failure must not fail the whole tool call');
    assert.equal(out.results.length, SCRAMBLED_NVDA_HITS.length);
    assert.ok(out.results.every((r) => !r.confirmedLatest));
});
