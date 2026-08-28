'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { cachedDossier } = require('../dossier');

// A tiny query-matcher covering exactly what cachedDossier's filters use:
// equality and $ne on top-level fields. Real Mongo semantics for these two
// operators, nothing more — enough to prove the filter SHAPE is correct
// without needing a live database.
function matches(doc, query) {
    return Object.entries(query).every(([k, v]) => {
        if (v && typeof v === 'object' && '$ne' in v) return doc[k] !== v.$ne;
        return doc[k] === v;
    });
}

function fakeCollection(docs) {
    return {
        findOne: async (query) => docs.find((d) => matches(d, query)) || null,
        lastQuery: null
    };
}

const SCHEMA_VERSION = 5; // must track DOSSIER_SCHEMA_VERSION in dossier.js

test('a legacy dossier (no depth field) is served for a Standard request', async () => {
    const col = fakeCollection([
        { symbol: 'AAPL', fyEnd: '2025-09-27', payload: { schemaVersion: SCHEMA_VERSION, symbol: 'AAPL', name: 'legacy' } }
    ]);
    const hit = await cachedDossier(col, 'AAPL', '2025-09-27', 'standard');
    assert.ok(hit, 'legacy doc matches a Standard request');
    assert.equal(hit.name, 'legacy');
});

test('a legacy dossier (no depth field) is NOT served for a Deep request', async () => {
    const col = fakeCollection([
        { symbol: 'AAPL', fyEnd: '2025-09-27', payload: { schemaVersion: SCHEMA_VERSION, symbol: 'AAPL', name: 'legacy' } }
    ]);
    const hit = await cachedDossier(col, 'AAPL', '2025-09-27', 'deep');
    assert.equal(hit, null, 'a pre-existing Standard-shaped doc must never be served as Deep');
});

test('Standard and Deep documents for the same symbol+fyEnd are independently addressable', async () => {
    const col = fakeCollection([
        { symbol: 'AAPL', fyEnd: '2025-09-27', depth: 'standard', payload: { schemaVersion: SCHEMA_VERSION, symbol: 'AAPL', depth: 'standard', name: 'std' } },
        { symbol: 'AAPL', fyEnd: '2025-09-27', depth: 'deep', payload: { schemaVersion: SCHEMA_VERSION, symbol: 'AAPL', depth: 'deep', name: 'deep' } }
    ]);
    const std = await cachedDossier(col, 'AAPL', '2025-09-27', 'standard');
    const deep = await cachedDossier(col, 'AAPL', '2025-09-27', 'deep');
    assert.equal(std.name, 'std', 'Standard request resolves the Standard document, not Deep');
    assert.equal(deep.name, 'deep', 'Deep request resolves the Deep document, not Standard');
});

test('depth defaults to standard when omitted', async () => {
    const col = fakeCollection([
        { symbol: 'AAPL', fyEnd: '2025-09-27', depth: 'deep', payload: { schemaVersion: SCHEMA_VERSION, symbol: 'AAPL', depth: 'deep', name: 'deep' } }
    ]);
    const hit = await cachedDossier(col, 'AAPL', '2025-09-27');
    assert.equal(hit, null, 'omitting depth must not accidentally serve a Deep dossier as the default');
});

test('a stale schemaVersion is treated as a miss regardless of depth', async () => {
    const col = fakeCollection([
        { symbol: 'AAPL', fyEnd: '2025-09-27', depth: 'standard', payload: { schemaVersion: SCHEMA_VERSION - 1, symbol: 'AAPL', name: 'old shape' } }
    ]);
    assert.equal(await cachedDossier(col, 'AAPL', '2025-09-27', 'standard'), null);
});
