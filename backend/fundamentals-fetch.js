// On-demand fundamentals for ANY US-listed SEC registrant.
//
// The nightly batch covers the S&P 1500; everything else is built here the
// first time someone asks: Yahoo statements/overview/price series + the SEC
// EDGAR extension (which also split-normalizes), persisted into the same
// static cache the nightly writes — so the first ask costs seconds and every
// later one is instant. Same payload shape as refresh-fundamentals.js.
const fs = require('fs');
const path = require('path');
const yahooSource = require('./yahoo-source');
const secSource = require('./sec-source');

const DATA_DIR = path.join(__dirname, '..', 'frontend', 'data');
const FUND_DIR = path.join(DATA_DIR, 'fundamentals');
const DIR_FILE = path.join(DATA_DIR, 'us-companies.json');

// ---- the universe: every SEC registrant with a listed ticker (~10.4k) ----
let _universe = null;
function universe() {
    if (_universe) return _universe;
    try {
        const d = JSON.parse(fs.readFileSync(DIR_FILE, 'utf8'));
        _universe = new Map((d.companies || []).map((c) => [c.symbol, c]));
    } catch (_) { _universe = new Map(); }
    return _universe;
}
function lookup(symbol) {
    return universe().get(String(symbol || '').toUpperCase().trim()) || null;
}

// ---- build + persist ----
const _inflight = new Map(); // symbol -> promise (dedup concurrent asks)
const BUILD_TIMEOUT_MS = 30000;

async function buildFundamentals(symbol) {
    const sym = String(symbol || '').toUpperCase().trim();
    if (!/^[A-Z0-9.\-]{1,10}$/.test(sym)) throw new Error('Invalid symbol.');
    if (_inflight.has(sym)) return _inflight.get(sym);
    const p = (async () => {
        const fetchY = (fn, params = {}) =>
            yahooSource.fetchFromYahoo(fn, { symbol: sym, ...params }).catch(() => ({}));
        const [overview, daily, monthly, income, balance, cash] = await Promise.all([
            fetchY('OVERVIEW'),
            fetchY('TIME_SERIES_DAILY_ADJUSTED', { outputsize: 'compact' }),
            fetchY('TIME_SERIES_MONTHLY_ADJUSTED'),
            fetchY('INCOME_STATEMENT'),
            fetchY('BALANCE_SHEET'),
            fetchY('CASH_FLOW')
        ]);
        const payload = { overview, daily, monthly, income, balance, cash };
        // SEC extension: grows annual history to 15+, synthesizes quarters,
        // and normalizes shares/per-share to the current split basis.
        await secSource.backfillStatements(sym, payload).catch(() => {});
        const filed = ((payload.income || {}).annualReports || []).length
            + ((payload.balance || {}).annualReports || []).length;
        if (!filed) throw new Error(`No filed statements found for ${sym}.`);
        // US stocks only: foreign issuers report in their home currency —
        // out of scope, refuse cleanly rather than half-support ADRs
        const cur = String((((payload.income || {}).annualReports || [])[0] || {}).reportedCurrency || 'USD').toUpperCase();
        if (cur !== 'USD') throw new Error(`${sym} reports in ${cur} — we cover US companies reporting in USD, not foreign ADRs.`);
        try {
            fs.writeFileSync(path.join(FUND_DIR, `${sym.replace(/[^A-Z0-9]/g, '_')}.json`), JSON.stringify(payload));
        } catch (_) { /* cache write is best-effort — the payload still serves */ }
        return payload;
    })();
    const timed = Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`Fetching ${sym} took too long — try again in a minute.`)), BUILD_TIMEOUT_MS))
    ]).finally(() => _inflight.delete(sym));
    _inflight.set(sym, timed);
    return timed;
}

module.exports = { buildFundamentals, lookup };
