'use strict';

// "What's new" across the covered universe — the data layer behind the
// get_recent_filings connector tool on both MCP surfaces.
//
// Source: frontend/data/sec-reporting.json, the same reporting watch file the
// coverage pipeline writes. Each issuer carries its MOST RECENT periodic
// report (10-K/10-Q/20-F/40-F), annual report and 8-K earnings release, so this
// answers "what has each company filed lately" without touching SEC EDGAR —
// which is why the tool declares openWorldHint: false.
//
// The file is loaded once per process and re-read only when its mtime moves,
// never per call: it holds ~5,900 issuers. The per-company statements file
// (financialFile, for in_statements) is read lazily and only for the rows a
// call actually returns. The reporting-file path is injectable so tests run
// against a small fixture instead of the real file.

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_REPORTING_FILE = path.join(__dirname, '..', 'frontend', 'data', 'sec-reporting.json');
const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'frontend', 'data');

const KINDS = ['annual', 'quarterly', 'earnings_release'];
const ANNUAL_FORMS = new Set(['10-K', '20-F', '40-F']);
const MAX_SINCE_DAYS = 92;
const DAY_MS = 24 * 60 * 60 * 1000;

// Reporting-watch cache: { file, mtimeMs, issuers }. Re-read when the mtime
// changes so a data refresh ships on the next call without a restart.
let cache = null;

function loadIssuers(filePath) {
    const stat = fs.statSync(filePath);
    if (cache && cache.file === filePath && cache.mtimeMs === stat.mtimeMs) return cache.issuers;
    const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    cache = { file: filePath, mtimeMs: stat.mtimeMs, issuers: (data && data.issuers) || {} };
    return cache.issuers;
}

function _resetCache() { cache = null; }

const dateOnly = (d) => d.toISOString().slice(0, 10);
const clampDate = (value, earliest) => (value < earliest ? earliest : value);

// Is this period end present in the company's statements file? Same check as
// the financial pages: income.quarterlyReports / annualReports[]
// .fiscalDateEnding. Read lazily per returned row; unreadable → null (unknown),
// never false.
function periodInStatements(dataDir, financialFile, periodEnd, kind) {
    try {
        const fin = JSON.parse(fs.readFileSync(path.join(dataDir, financialFile), 'utf8'));
        const reports = kind === 'annual'
            ? (fin.income && fin.income.annualReports)
            : (fin.income && fin.income.quarterlyReports);
        return Array.isArray(reports)
            ? reports.some((r) => String(r && r.fiscalDateEnding) === String(periodEnd))
            : null;
    } catch (_) {
        return null;
    }
}

// One row per issuer per kind: each company's MOST RECENT report and release,
// never a list of all its filings.
function recentFilings(args = {}, opts = {}) {
    const now = opts.now instanceof Date ? opts.now : new Date();
    const reportingFile = opts.reportingFile || DEFAULT_REPORTING_FILE;
    const dataDir = opts.dataDir || DEFAULT_DATA_DIR;

    // `since` bounds the window on FILING date. Default 7 days back; a caller
    // may not reach further back than 92 days — this is "what's new", not a
    // filing archive.
    const earliest = dateOnly(new Date(now.getTime() - MAX_SINCE_DAYS * DAY_MS));
    let since;
    if (typeof args.since === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(args.since)) {
        since = clampDate(args.since, earliest);
    } else {
        since = dateOnly(new Date(now.getTime() - 7 * DAY_MS));
    }

    const kinds = [...new Set((Array.isArray(args.kinds) ? args.kinds : [args.kinds])
        .map((k) => String(k || '').trim().toLowerCase())
        .filter((k) => KINDS.includes(k)))];
    const wantedKinds = kinds.length ? kinds : KINDS.slice();

    const tickerFilter = [...new Set((Array.isArray(args.tickers) ? args.tickers : [args.tickers])
        .map((t) => String(t || '').trim().toUpperCase()).filter(Boolean))].slice(0, 25);
    const wantTicker = tickerFilter.length ? new Set(tickerFilter) : null;

    const limit = Math.min(Math.max(Number(args.limit) || 25, 1), 100);

    const issuers = loadIssuers(reportingFile);
    const rows = [];
    const seenAccessions = new Set();
    for (const issuer of Object.values(issuers)) {
        if (!issuer || typeof issuer !== 'object') continue;
        const ticker = Array.isArray(issuer.symbols) && issuer.symbols[0] ? String(issuer.symbols[0]).toUpperCase() : null;
        if (!ticker) continue;
        if (wantTicker && !wantTicker.has(ticker)) continue;

        const candidates = [];
        const push = (entry, kind) => {
            if (!entry || !entry.filingDate || !entry.form) return;
            if (seenAccessions.has(entry.accessionNumber)) return;
            candidates.push({ entry, kind });
        };
        // latestPeriodic may be the annual report itself when nothing newer
        // has been filed; kind follows the form so the kinds filter stays honest.
        if (issuer.latestPeriodic) {
            const form = String(issuer.latestPeriodic.form || '').toUpperCase();
            push(issuer.latestPeriodic, ANNUAL_FORMS.has(form) ? 'annual' : 'quarterly');
        }
        if (issuer.latestAnnual) push(issuer.latestAnnual, 'annual');
        if (issuer.latestEarningsRelease) push(issuer.latestEarningsRelease, 'earnings_release');

        for (const { entry, kind } of candidates) {
            if (!wantedKinds.includes(kind)) continue;
            if (String(entry.filingDate) < since) continue;
            if (entry.accessionNumber) seenAccessions.add(entry.accessionNumber);
            const row = {
                ticker,
                name: issuer.issuerName || null,
                kind,
                form: String(entry.form),
                filing_date: String(entry.filingDate),
                period_end: entry.reportDate ? String(entry.reportDate) : null,
                filing_url: entry.filingUrl ? String(entry.filingUrl) : null
            };
            rows.push({ row, financialFile: issuer.financialFile || null });
        }
    }

    rows.sort((a, b) => (a.row.filing_date < b.row.filing_date ? 1 : a.row.filing_date > b.row.filing_date ? -1 : String(a.row.ticker).localeCompare(String(b.row.ticker))));
    // Statements files are read only for the rows returned, never for every
    // match: a 92-day window matches ~9,000 rows.
    const filings = rows.slice(0, limit).map(({ row, financialFile }) => {
        if (row.kind !== 'earnings_release' && row.period_end && financialFile) {
            const inStatements = periodInStatements(dataDir, financialFile, row.period_end, row.kind);
            if (inStatements !== null) row.in_statements = inStatements;
        }
        return row;
    });
    return { since, kinds: wantedKinds, match_count: filings.length, filings };
}

module.exports = { recentFilings, periodInStatements, KINDS, MAX_SINCE_DAYS, DEFAULT_REPORTING_FILE, _resetCache };