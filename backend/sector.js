'use strict';

// Yahoo Finance and GICS name the same eleven sectors differently, and Ask reads
// both stores: `fundamentals/*.json` carry Yahoo names while the screen index and
// us-companies carry GICS. Peer sets, sector medians and percentiles are keyed on
// the index's GICS values, so a company labelled only the Yahoo way finds no peers.
//
// Canonical vocabulary is GICS (two of the three stores, and the key every
// consumer groups on). Yahoo values are mapped at the boundary. `canonical()`
// returns an unrecognised value unchanged rather than discarding it.
const YAHOO_TO_GICS = {
    'financial services': 'Financials',
    'health care': 'Health Care',
    'healthcare': 'Health Care',
    'technology': 'Information Technology',
    'information technology': 'Information Technology',
    'consumer cyclical': 'Consumer Discretionary',
    'consumer discretionary': 'Consumer Discretionary',
    'basic materials': 'Materials',
    'materials': 'Materials',
    'consumer defensive': 'Consumer Staples',
    'consumer staples': 'Consumer Staples',
    'industrials': 'Industrials',
    'real estate': 'Real Estate',
    'energy': 'Energy',
    'communication services': 'Communication Services',
    'utilities': 'Utilities'
};

// The eleven GICS sectors, in GICS order.
const CANONICAL = [
    'Communication Services', 'Consumer Discretionary', 'Consumer Staples', 'Energy',
    'Financials', 'Health Care', 'Industrials', 'Information Technology', 'Materials',
    'Real Estate', 'Utilities'
];

function canonical(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    const mapped = YAHOO_TO_GICS[raw.toLowerCase()];
    if (mapped) return mapped;
    const hit = CANONICAL.find((c) => c.toLowerCase() === raw.toLowerCase().replace(/\s+/g, ' '));
    return hit || raw;
}

// True when `query` names the same sector as `value` (either vocabulary), so a
// filter written as "Technology" or "Healthcare" still matches the GICS index.
function matches(value, query) {
    const q = canonical(query).toLowerCase();
    if (!q) return false;
    return canonical(value).toLowerCase().includes(q);
}

module.exports = { canonical, matches, CANONICAL, YAHOO_TO_GICS };
