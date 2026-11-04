#!/usr/bin/env node
/**
 * Local preview of the company page with REAL filed data, no database.
 *
 * `scripts/dev-local.js` runs the full backend against an in-memory Mongo that has
 * no financial statements in it, so /company renders "—" everywhere — including
 * the Employees row, which lives inside the statement table. This serves
 * frontend-v2 statically and answers the two API calls the page makes from
 * files already in the repository:
 *
 *   frontend/data/sec-financials/<cik>.json   income / balance / cash, as filed
 *   frontend/data/employee-counts.json        headcount per fiscal year
 *
 *   node scripts/preview-local.js            → http://localhost:5060/company.html?symbol=ADUS
 *   PORT=5061 node scripts/preview-local.js
 *
 * Nothing is estimated: a year the filing does not state stays absent, exactly as
 * on the deployed page.
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'frontend', 'data');
const WEB = path.join(ROOT, 'frontend-v2');
const PORT = Number(process.env.PORT || 5080);

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } };

const EMPLOYEES = readJson(path.join(DATA, 'employee-counts.json')) || { symbols: {} };
const SCREEN = readJson(path.join(DATA, 'screen-index.json')) || { rows: [] };
const bySymbol = new Map((SCREEN.rows || []).map((r) => [String(r.symbol).toUpperCase(), r]));

function financialsFor(cik) {
    if (!cik) return null;
    return readJson(path.join(DATA, 'sec-financials', `${cik}.json`));
}

function buildPayload(symbol) {
    const sym = String(symbol).toUpperCase();
    const row = bySymbol.get(sym) || {};
    const emp = (EMPLOYEES.symbols || {})[sym] || null;
    const cik = (emp && emp.cik) || (row.cik ? String(row.cik).padStart(10, '0') : null);
    const fin = financialsFor(cik);
    if (!fin) return { missing: true, code: 'NO_FINANCIALS', symbol: sym, cik };
    const latest = (fin.income && fin.income.annualReports && fin.income.annualReports[0]) || {};
    const payload = {
        overview: {
            Symbol: sym,
            Name: (fin.issuerName || row.name || sym),
            Sector: row.sector || null,
            Industry: row.industry || null,
            Exchange: row.exchange || null,
            Currency: latest.reportedCurrency || 'USD',
            Description: row.description || null,
        },
        income: fin.income,
        balance: fin.balance,
        cash: fin.cash,
        coverage: {
            financialCoverage: 'ready',
            annualReportingStatus: 'recent_annual',
            securityType: 'stock',
            perShareAllowed: true,
            currency: latest.reportedCurrency || 'USD',
        },
        provenance: { source: 'SEC EDGAR annual reports (frontend/data/sec-financials)', fetchedAt: fin.fetchedAt || null },
        // the join the page reads: headcount per fiscal year, annual only
        employees: emp ? { latest: emp.latest, years: emp.counts, ratio: emp.ratio, builtOn: (EMPLOYEES.generatedAt || '').slice(0, 10) } : null,
    };
    return payload;
}

const json = (res, body, code = 200) => {
    const out = JSON.stringify(body);
    res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Encoding': 'identity' });
    res.end(out);
};

const MIME = { '.js': 'application/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.webp': 'image/webp', '.woff2': 'font/woff2' };

const UPSTREAM = process.env.DEV_LOCAL_URL || 'http://127.0.0.1:5055';

function proxy(req, res) {
    const target = new URL(req.url, UPSTREAM);
    const opts = { method: req.method, headers: { ...req.headers, host: target.host } };
    const up = http.request(target, opts, (upRes) => {
        res.writeHead(upRes.statusCode || 502, upRes.headers);
        upRes.pipe(res);
    });
    up.on('error', () => {
        res.writeHead(502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 'DEV_LOCAL_DOWN', message: `No dev-local server on ${UPSTREAM}. Start it with: node scripts/dev-local.js` }));
    });
    req.pipe(up);
}

let hits = 0;
const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    hits += 1;
    console.log(`[preview] ${hits} ${req.method} ${url.pathname}${url.search}`);
    const p = url.pathname;

    // ---- the only two API calls the company page needs -------------------------
    const fund = p.match(/^\/api\/demo\/alpha\/fundamentals\/([^/]+)$/);
    if (fund) {
        const payload = buildPayload(decodeURIComponent(fund[1]));
        if (payload.missing) return json(res, { code: payload.code, message: `No sec-financials file for ${payload.symbol} (cik ${payload.cik})` }, 404);
        return json(res, payload);
    }
    const profile = p.match(/^\/api\/assets\/([^/]+)\/profile/);
    if (profile) {
        const sym = decodeURIComponent(profile[1]).toUpperCase();
        const row = bySymbol.get(sym) || {};
        return json(res, { profile: { symbol: sym, name: row.name || sym, assetType: 'stock', assetTypeLabel: 'Stock', price: null, currency: 'USD' } });
    }
    if (p === '/api/session' || p === '/api/auth/session') return json(res, { user: null, tier: 'core' });
    // Preview only: endpoints the page pings but that need the backend (auth, watchlist,
    // credits, filings) answer with an empty, well-formed body instead of a 404 so the
    // UI does not flash error states over the rows being tested.
    // Everything else — session, auth, watchlist, filings, credits, screens — is
    // forwarded to the real dev-local backend (scripts/dev-local.js on 5055) so this
    // preview behaves exactly like it, including the seeded dev accounts.
    if (p.startsWith('/api/')) return proxy(req, res);

    // ---- static frontend ------------------------------------------------------
    let rel = p === '/' ? 'company.html' : p.replace(/^\//, '');
    const file = path.resolve(WEB, rel);
    if (!file.startsWith(WEB + path.sep)) { res.writeHead(403); return res.end(); }
    fs.readFile(file, (err, buf) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'text/html' });
        res.end(buf);
    });
});

server.listen(PORT, '127.0.0.1', () => {
    const covered = Object.values(EMPLOYEES.symbols || {}).filter((v) => v && v.latest).length;
    console.log(`[preview] http://localhost:${PORT}/company.html?symbol=ADUS`);
    console.log(`[preview] dataset: ${covered} of ${Object.keys(EMPLOYEES.symbols || {}).length} stocks with a headcount`);
    console.log('[preview] real sec-financials + employee-counts, no database, nothing estimated');
});
