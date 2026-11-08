'use strict';

// What the connector tools (/mcp and /mcp/apps) hand to an AI client.
//
// A value keeps everything needed to cite it: the form, filing and report
// dates, accession number, SEC URL and period. It loses how it was read: the
// XBRL concept and taxonomy, the raw fact, the verification method, linkage,
// scope, extraction version and retrieval time, and the coverage diagnostics
// (which sources were tried, the industry rules and definitions). That detail
// is the extraction method, and an assistant that is shown it on every call can
// rebuild the pipeline. The website and /api/v1 read the engine directly and
// are unaffected.

const SOURCE_TYPE = /^(sec_|calculated$|supplemental$)/;

// output key <- keys it may arrive under
const SOURCE_FIELDS = [
    ['type', ['type']],
    ['form', ['form']],
    ['filing_date', ['filing_date', 'filingDate']],
    ['report_date', ['report_date']],
    ['accession_number', ['accession_number', 'accessionNumber']],
    ['url', ['url', 'filingUrl']],
    ['period_start', ['period_start', 'periodStart']],
    ['period_end', ['period_end', 'periodEnd']],
    // a supplemental (non-SEC) figure must stay attributed to its provider
    ['source_name', ['source_name']],
    ['source_date', ['source_date']]
];

const COVERAGE_DROP = ['sourceAttempts', 'industry'];

function isSource(node) {
    return typeof node.type === 'string' && SOURCE_TYPE.test(node.type);
}

function citationOnly(src) {
    const out = {};
    for (const [key, from] of SOURCE_FIELDS) {
        const k = from.find((f) => src[f] != null);
        if (k) out[key] = src[k];
    }
    if (Array.isArray(src.inputs)) out.inputs = src.inputs.map((i) => (i && typeof i === 'object' ? redact(i) : i));
    return out;
}

function redact(node, depth = 0) {
    if (!node || typeof node !== 'object' || depth > 12) return node;
    if (Array.isArray(node)) return node.map((n) => redact(n, depth + 1));
    if (isSource(node)) return citationOnly(node);
    const out = {};
    for (const [key, value] of Object.entries(node)) {
        if (key === 'coverage' && value && typeof value === 'object' && !Array.isArray(value)) {
            const cov = { ...value };
            for (const k of COVERAGE_DROP) delete cov[k];
            out[key] = redact(cov, depth + 1);
        } else {
            out[key] = redact(value, depth + 1);
        }
    }
    return out;
}

module.exports = { redact };
