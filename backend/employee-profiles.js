'use strict';
/**
 * Headcount per fiscal year, joined onto a company payload.
 *
 * The data is read from the annual reports (Reg S-K Item 101(c)(2) human
 * capital / Form 20-F Item 6.D) by scripts/build-employee-counts.js and stored
 * in frontend/data/employee-counts.json. It is NOT an XBRL fact: the `dei`
 * taxonomy carries only EntityCommonStockSharesOutstanding and
 * EntityPublicFloat, so there is no tag to read and no filing API to query.
 *
 * The file is ~3 MB, so it is loaded once per process rather than per request,
 * and only the requested symbol's slice travels to the browser. A missing or
 * unreadable file is not an error: the page simply has no headcount, exactly as
 * it has none for the ~26% of issuers that state no number in prose.
 */
const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', 'frontend', 'data', 'employee-counts.json');

let loaded = null;      // { at, symbols }
let loadedAt = 0;
const RELOAD_MS = 6 * 3600 * 1000; // a rebuilt data file is picked up without a restart

function store() {
    if (loaded && Date.now() - loadedAt < RELOAD_MS) return loaded;
    try {
        const raw = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
        loaded = { symbols: raw.symbols || {}, generatedAt: raw.generatedAt || null };
    } catch (_) {
        loaded = { symbols: {}, generatedAt: null };
    }
    loadedAt = Date.now();
    return loaded;
}

/**
 * The compact slice a company page needs: the count per fiscal year, the
 * per-employee ratios for the latest year, and which basis the count is on
 * ('headcount' or 'fte' — full-time equivalents are a different measure and the
 * page says so rather than blending them).
 */
function forSymbol(symbol) {
    const key = String(symbol || '').toUpperCase();
    if (!key) return null;
    const entry = store().symbols[key];
    if (!entry || !entry.latest) return null;
    const years = {};
    for (const [year, rec] of Object.entries(entry.counts || {})) {
        if (rec && Number.isFinite(rec.value)) years[year] = { value: rec.value, basis: rec.basis || 'headcount' };
    }
    if (!Object.keys(years).length) return null;
    const built = store().generatedAt;
    return {
        latest: entry.latest,
        years,
        ratio: entry.ratio || null,
        source: 'SEC annual reports — Reg S-K Item 101(c)(2) human capital / Form 20-F Item 6.D',
        generatedAt: built,
        // stated on the page so a reader can see how current the reading is
        builtOn: built ? String(built).slice(0, 10) : null
    };
}

// The date the headcount file was built, for sitemap lastmod and page provenance.
function builtOn() {
    const at = store().generatedAt;
    const day = at ? String(at).slice(0, 10) : null;
    return day && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null;
}

module.exports = { forSymbol, builtOn, DATA_PATH };
