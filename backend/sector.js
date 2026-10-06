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

// Two thirds of the covered companies (3,130 of 4,593 on 2026-10-06 — everything
// added when coverage grew past the S&P 1500) had no sector at all, so they had
// no peers and never appeared in a sector screen. Every SEC registrant has a
// SIC code; this maps it to the same eleven sectors. Ordered: first match wins.
const SIC_SECTORS = [
    [/^6798$|^65/, 'Real Estate'],
    [/^6/, 'Financials'],
    [/^283|^384|^3826$|^5122$|^80|^8731$|^8734$/, 'Health Care'],
    [/^737|^357|^36[67]|^38[1-3]|^3861$|^3695$/, 'Information Technology'],
    [/^1[23]|^29|^46|^517/, 'Energy'],
    [/^49(?!5)/, 'Utilities'],
    [/^48|^27|^78|^731/, 'Communication Services'],
    [/^0|^2[01]|^284|^54|^514|^518|^5912$|^5331$|^5399$/, 'Consumer Staples'],
    [/^1[04]|^2[468]|^3[023]/, 'Materials'],
    [/^1531$|^2[235]|^31|^39|^3651$|^371|^5[2-9]|^7[0256]|^79|^82/, 'Consumer Discretionary'],
    [/^1[5-7]|^3[4-7]|^4|^5[01]|^7|^8/, 'Industrials']
];
function fromSic(sic) {
    const code = String(sic || '').trim();
    if (!/^\d{3,4}$/.test(code) || /^0+$/.test(code)) return '';
    const padded = code.padStart(4, '0');
    for (const [re, sector] of SIC_SECTORS) if (re.test(padded)) return sector;
    return '';
}

module.exports = { canonical, matches, fromSic, CANONICAL, YAHOO_TO_GICS };
