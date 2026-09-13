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
const fxConversion = require('./fx-conversion');

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

// Yahoo's financialCurrency sometimes disagrees with the denomination of the
// statement VALUES it returns alongside it. VALE is stamped BRL while its
// figures are the USD ones from its USD-denominated 20-F — converting those
// understated revenue 5.6x ($6.9B against a real $38.4B). So decide by
// measurement rather than trusting the stamp.
//
// The quote is the independent anchor: it is always in the listing currency
// (USD here) and is never touched by conversion, so price / PERatio is the
// trailing EPS per ADS in dollars. Whichever of the as-filed or the converted
// EPS lands closer to it tells us what the values really were.
function quoteAnchorEps(payload) {
    const ov = payload.overview || {};
    const shares = Number(ov.SharesOutstanding);
    const marketCap = Number(ov.MarketCapitalization);
    const pe = Number(ov.PERatio);
    if (!(shares > 0) || !(marketCap > 0) || !(pe > 0)) return null;
    return (marketCap / shares) / pe;
}

function latestDilutedEps(payload) {
    const v = Number((((payload.income || {}).annualReports || [])[0] || {}).dilutedEPS);
    return Number.isFinite(v) && v !== 0 ? v : null;
}

// Log distance, so overshooting and undershooting the anchor are penalised alike.
const anchorFit = (value, anchor) => Math.abs(Math.log(Math.abs(value / anchor)));

// Values were already USD despite a foreign stamp: keep the numbers untouched
// and correct the label, rather than leaving rows claiming a currency they are
// not in.
// Never drop data this build does not produce. The nightly batch
// (scripts/refresh-fundamentals.js) writes a richer payload than the on-demand
// path — dividend history, for one — so overwriting the file wholesale silently
// destroyed it for any symbol rebuilt here. Carry forward every top-level key
// the new payload has no opinion about.
function mergeWithCached(sym, next) {
    try {
        const file = path.join(FUND_DIR, `${sym.replace(/[^A-Z0-9]/g, '_')}.json`);
        if (!fs.existsSync(file)) return next;
        const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
        const merged = { ...next };
        for (const [key, value] of Object.entries(prev)) {
            if (merged[key] === undefined) merged[key] = value;
        }
        return merged;
    } catch (_) { return next; }
}

function restampAsUsd(payload, stampedCurrency) {
    const out = JSON.parse(JSON.stringify(payload));
    for (const statement of ['income', 'balance', 'cash']) {
        for (const period of ['annualReports', 'quarterlyReports']) {
            for (const row of ((out[statement] || {})[period] || [])) row.reportedCurrency = 'USD';
        }
    }
    out.sourceReportingCurrency = 'USD';
    out.currencyConversion = {
        status: 'not-needed',
        from: 'USD',
        to: 'USD',
        message: `Source metadata reported ${stampedCurrency}, but the filed values match USD when checked against the quote — left unconverted.`
    };
    return out;
}

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
        // Read the reporting currency from Yahoo's own stamp BEFORE the SEC
        // extension runs. backfillStatements synthesizes whole rows, so reading
        // it afterwards can read a row EDGAR supplied rather than the filer's
        // actual statements — which is how foreign issuers used to slip through
        // this gate stamped 'USD'.
        const cur = String(
            (((payload.income || {}).annualReports || [])[0] || {}).reportedCurrency
            || (((payload.balance || {}).annualReports || [])[0] || {}).reportedCurrency
            || 'USD'
        ).toUpperCase();
        payload.sourceReportingCurrency = cur;
        // SEC extension: grows annual history to 15+, synthesizes quarters,
        // and normalizes shares/per-share to the current split basis.
        await secSource.backfillStatements(sym, payload).catch(() => {});
        const filed = ((payload.income || {}).annualReports || []).length
            + ((payload.balance || {}).annualReports || []).length;
        if (!filed) throw new Error(`No filed statements found for ${sym}.`);

        // Store every filer in USD. A foreign private issuer reports in its home
        // currency (NTES in CNY, SAP in EUR) while its ADR trades in USD, so
        // leaving statements native puts the two on different scales in every
        // price-derived metric downstream — market cap ÷ FCF, P/E, DCF per share.
        // Converting here rather than at each reader is deliberate: ten modules
        // load this cache synchronously and fetching an FX series is async, so
        // the only point that can serve all of them is the write.
        //
        // convertPayloadToUsd is a no-op for USD filers, preserves
        // originalReportedCurrency/fxRateToUSD/fxRateBasis on every row, and runs
        // after the SEC backfill so Yahoo's and EDGAR's rows convert alike.
        //
        // Fails open: an FX outage must leave the filing data usable in its own
        // currency, never fail the build and never relabel native figures as USD.
        let presented = payload;
        try {
            const converted = await fxConversion.convertPayloadToUsd(payload);
            presented = converted;
            // Trust the stamp only when the numbers agree with the quote. No
            // anchor (a loss-making filer has no P/E) means no evidence either
            // way, so keep the converted payload — the stamp is right far more
            // often than not.
            const anchor = quoteAnchorEps(payload);
            const filedEps = latestDilutedEps(payload);
            const convertedEps = latestDilutedEps(converted);
            if (anchor && filedEps && convertedEps
                && anchorFit(filedEps, anchor) < anchorFit(convertedEps, anchor)) {
                presented = restampAsUsd(payload, cur);
            }
        } catch (error) {
            presented = {
                ...payload,
                currencyConversion: {
                    status: 'unavailable', from: cur, to: 'USD',
                    message: 'USD conversion is temporarily unavailable; figures remain in the company reporting currency.'
                }
            };
        }

        presented = mergeWithCached(sym, presented);
        try {
            fs.writeFileSync(path.join(FUND_DIR, `${sym.replace(/[^A-Z0-9]/g, '_')}.json`), JSON.stringify(presented));
        } catch (_) { /* cache write is best-effort — the payload still serves */ }
        return presented;
    })();
    const timed = Promise.race([
        p,
        new Promise((_, rej) => setTimeout(() => rej(new Error(`Fetching ${sym} took too long — try again in a minute.`)), BUILD_TIMEOUT_MS))
    ]).finally(() => _inflight.delete(sym));
    _inflight.set(sym, timed);
    return timed;
}

// On-demand tickers never get touched again after their first fetch, unlike
// the index names below which the nightly/weekly CI job keeps warm on its own
// schedule — this is what let fundamentals go a year+ stale for anything
// outside the S&P 1500 and surfaced as AppSumo refunds citing "old data, not
// fresh". Refresh on request past this age instead of serving it forever.
const STALE_AFTER_MS = 90 * 24 * 60 * 60 * 1000;
let _indexSymbols = null;
function indexCoveredSymbols() {
    // Only sp500-companies.json is what .github/workflows/refresh-fundamentals.yml
    // actually passes to the nightly/weekly job. sp1500-companies.json exists on
    // disk but nothing schedules against it — treating it as "covered" here would
    // silently reintroduce the same staleness bug for ~1,000 more tickers.
    if (_indexSymbols) return _indexSymbols;
    _indexSymbols = new Set();
    try {
        const d = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'sp500-companies.json'), 'utf8'));
        const list = Array.isArray(d) ? d : (d.companies || []);
        for (const c of list) _indexSymbols.add(String((c || {}).symbol || '').toUpperCase());
    } catch (_) { /* file may not exist in this checkout */ }
    return _indexSymbols;
}

function isStaleOnDemand(symbol) {
    const sym = String(symbol || '').toUpperCase().trim();
    if (indexCoveredSymbols().has(sym)) return false; // already kept warm by scripts/refresh-fundamentals.js
    try {
        const file = path.join(FUND_DIR, `${sym.replace(/[^A-Z0-9]/g, '_')}.json`);
        return (Date.now() - fs.statSync(file).mtimeMs) > STALE_AFTER_MS;
    } catch (_) { return false; } // no file yet — that's "missing", not "stale"
}

module.exports = { buildFundamentals, lookup, isStaleOnDemand };
