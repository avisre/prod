'use strict';

// SEC-verified overrides for individual line items the upstream provider gets
// wrong. The provider (Yahoo) supplies the statement rows, and occasionally a
// figure contradicts both the filing and the provider's own data. OLN's FY2025
// "net income" arrived as -$42.8M while the 10-K reports $(101.1)M attributable
// to Olin and the provider's own diluted EPS (-0.88, same row) implies the same
// ~$101M. Every entry here is checked against SEC XBRL before it is added, and
// applied on write so a refresh cannot silently reintroduce the bad value.
//
// Shape: { SYMBOL: { income: { 'YYYY-MM-DD': { field: value } } } }
// Sections are the payload keys: income / balance / cash.

const CORRECTIONS = {
    OLN: { income: { '2025-12-31': { netIncome: -101100000 } } }
};

// Mutates the payload's matching rows in place and returns it. Unknown symbols
// and sections are a no-op, so this is safe on every write path.
function apply(symbol, payload) {
    const fix = CORRECTIONS[String(symbol || '').trim().toUpperCase()];
    if (!fix || !payload || typeof payload !== 'object') return payload;
    for (const section of Object.keys(fix)) {
        const node = payload[section];
        if (!node || !Array.isArray(node.annualReports)) continue;
        for (const row of node.annualReports) {
            const fields = fix[section][row && row.fiscalDateEnding];
            if (fields) Object.assign(row, fields);
        }
    }
    return payload;
}

module.exports = { apply, CORRECTIONS };
