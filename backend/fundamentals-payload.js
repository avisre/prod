'use strict';

// What the browser is sent for a company page.
//
// `provenance.sources` is the per-fact bookkeeping behind every statement cell:
// each row's `_sources` field lists ids, and this map resolves them to the
// filing, accession, period and raw value they came from. It is what makes the
// data auditable, and it is 70% of the answer — 2.0 MB of a 2.9 MB payload on
// 2026-11-05, sent to every reader and read by nobody.
//
// Exactly one id is read on the client: company.js links the stock-based
// compensation panel to the filing the figure came from
// (`_sources.shareBasedCompensation[0]` → `provenance.sources[id].filingUrl`).
// So the browser gets that subset and the rest stays server-side, where
// verified-fundamentals' sourcesFor() and the Ask tools resolve ids from the
// full object without needing it on the wire.
//
// Everything else in the payload is passed through untouched: the statements,
// overview, market data, employees, coverage and freshness are all rendered.

const SBC_FIELD = 'shareBasedCompensation';
const STATEMENTS = ['income', 'balance', 'cash'];
const BASES = ['annualReports', 'quarterlyReports'];

function referencedSourceIds(body) {
    const ids = new Set();
    for (const statement of STATEMENTS) {
        for (const basis of BASES) {
            const rows = (body && body[statement] && body[statement][basis]) || [];
            for (const row of rows) {
                const list = row && row._sources && row._sources[SBC_FIELD];
                if (list && list[0]) ids.add(list[0]);
            }
        }
    }
    return ids;
}

function browserFundamentals(body) {
    if (!body || typeof body !== 'object') return body;
    const sources = body.provenance && body.provenance.sources;
    if (!sources || typeof sources !== 'object') return body;
    const kept = {};
    for (const id of referencedSourceIds(body)) if (sources[id]) kept[id] = sources[id];
    return { ...body, provenance: { ...body.provenance, sources: kept } };
}

module.exports = { browserFundamentals, referencedSourceIds };
