#!/usr/bin/env node
'use strict';
// Checks the per-company official history files and converts them to USD.
//
//   node scripts/global-companies-history.js            (run from backend/ or the repo root)
//
// Input: docs/global-companies/history/<SYMBOL>.json, figures read from each company's own
// annual reports (see BRIEF.md there), in the reporting currency.
// Output: docs/global-companies/history-usd.json and .csv, plus a check report on stdout:
// year coverage, missing fields, sources, and the latest years against the Yahoo snapshot.
// USD: balance-sheet items at the period-end month's rate, flows and per-share items at the
// average of the 12 month-end rates of the fiscal year (Yahoo historical FX, via fx-conversion).

const fs = require('fs');
const path = require('path');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const DIR = path.join(ROOT, 'docs/global-companies');
const req = Module.createRequire(path.join(ROOT, 'backend/package.json'));
const fx = req('./fx-conversion');

const FLOW = ['revenue', 'operatingIncome', 'netIncome', 'operatingCashFlow', 'capex', 'dilutedEPS', 'dividendPerShare'];
const STOCK = ['totalAssets', 'totalEquity', 'cashAndEquivalents', 'totalDebt'];
const PLAIN = ['sharesOutstanding', 'employees'];
const FIELDS = [...FLOW, ...STOCK, ...PLAIN];
const FIRST_YEAR = 2007, YEARS = 19;

const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const pct = (a, b) => (a !== null && b ? Math.abs(a / b - 1) : null);

(async () => {
    const snap = JSON.parse(fs.readFileSync(path.join(DIR, fs.readdirSync(DIR).filter((f) => /^snapshot-.*\.json$/.test(f)).sort().pop()), 'utf8'));
    const yahoo = new Map(snap.companies.map((c) => [c.symbol, c]));
    const files = fs.readdirSync(path.join(DIR, 'history')).filter((f) => f.endsWith('.json')).sort();
    const series = new Map();
    const rates = async (cur) => {
        if (cur === 'USD') return null;
        if (!series.has(cur)) series.set(cur, await fx.rateSeries(cur));
        return series.get(cur);
    };
    const out = [], report = [];
    for (const f of files) {
        const h = JSON.parse(fs.readFileSync(path.join(DIR, 'history', f), 'utf8'));
        const issues = [];
        const years = (h.years || []).slice().sort((a, b) => b.fiscalYear - a.fiscalYear);
        const latest = years.length ? years[0].fiscalYear : null;
        const want = latest ? Array.from({ length: YEARS }, (_, i) => latest - i).filter((y) => y >= FIRST_YEAR) : [];
        const have = new Set(years.map((y) => y.fiscalYear));
        const missingYears = want.filter((y) => !have.has(y));
        const usdYears = [];
        for (const y of years) {
            if (!y.source || !/^https?:\/\//.test(y.source.url || '')) issues.push(`${y.fiscalYear}: no source url`);
            if (num(y.capex) > 0) issues.push(`${y.fiscalYear}: capex positive`);
            if (num(y.revenue) !== null && num(y.netIncome) !== null && Math.abs(y.netIncome) > Math.abs(y.revenue)) issues.push(`${y.fiscalYear}: net income larger than revenue`);
            const cur = y.currency || h.reportingCurrency;
            const end = String(y.periodEnd || '').slice(0, 7);
            const pts = await rates(cur);
            const close = pts ? fx.closingRate(pts, end) : 1, avg = pts ? fx.averageRate(pts, end, 12) : 1;
            if (!close || !avg) issues.push(`${y.fiscalYear}: no ${cur}/USD rate for ${end}`);
            const u = { fiscalYear: y.fiscalYear, periodEnd: y.periodEnd, standard: y.standard, currency: cur, restated: !!y.restated, source: y.source, fxClose: close, fxAverage: avg };
            for (const k of FLOW) u[k] = num(y[k]) !== null && avg ? num(y[k]) * avg : null;
            for (const k of STOCK) u[k] = num(y[k]) !== null && close ? num(y[k]) * close : null;
            for (const k of PLAIN) u[k] = num(y[k]);
            u.freeCashFlow = u.operatingCashFlow !== null && u.capex !== null ? u.operatingCashFlow + u.capex : null;
            usdYears.push(u);
        }
        // the latest years against the Yahoo snapshot (both USD at period average rates)
        const y = yahoo.get(h.symbol), cmp = [];
        if (y) for (const r of y.annual.income) {
            const mine = usdYears.find((u) => String(u.periodEnd).slice(0, 7) === String(r.fiscalDateEnding).slice(0, 7));
            if (!mine) continue;
            const dr = pct(mine.revenue, r.revenue), dn = pct(mine.netIncome, r.netIncome);
            cmp.push(`${mine.fiscalYear} rev ${dr === null ? '—' : (dr * 100).toFixed(1) + '%'} ni ${dn === null ? '—' : (dn * 100).toFixed(1) + '%'}`);
            // Yahoo's revenue line sometimes includes other income the company does not count in sales
            // (Roche runs about 3% high), so only a wider gap is a real error, not a definition.
            if (dr !== null && dr > 0.06) issues.push(`${mine.fiscalYear}: revenue ${(dr * 100).toFixed(1)}% off Yahoo`);
            if (dn !== null && dn > 0.05) issues.push(`${mine.fiscalYear}: net income ${(dn * 100).toFixed(1)}% off Yahoo`);
        }
        const nulls = FIELDS.filter((k) => years.length && years.every((yy) => num(yy[k]) === null));
        const fill = years.length ? FIELDS.reduce((s, k) => s + years.filter((yy) => num(yy[k]) !== null).length, 0) / (FIELDS.length * years.length) : 0;
        report.push({ symbol: h.symbol, years: years.length, span: years.length ? `${years[years.length - 1].fiscalYear}-${latest}` : '—', missingYears, fill, nulls, cmp, issues });
        out.push({ symbol: h.symbol, name: h.name, reportingCurrency: h.reportingCurrency, fiscalYearEnd: h.fiscalYearEnd, irUrl: h.irUrl, gaps: h.gaps || [], notes: h.notes || [], years: usdYears });
    }
    fs.writeFileSync(path.join(DIR, 'history-usd.json'), JSON.stringify({ generatedAt: new Date().toISOString(), basis: 'Company annual reports, converted to USD at Yahoo historical FX (balance sheet: period-end rate; flows and per-share: 12-month average)', companies: out }, null, 1));
    const cols = ['symbol', 'name', 'fiscalYear', 'periodEnd', 'standard', 'currency', ...FIELDS, 'freeCashFlow', 'fxAverage', 'fxClose', 'sourceUrl', 'sourcePage'];
    const cell = (v) => (v === null || v === undefined ? '' : /[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    const rows = out.flatMap((c) => c.years.map((y) => cols.map((k) => cell(k === 'symbol' || k === 'name' ? c[k] : k === 'sourceUrl' ? y.source && y.source.url : k === 'sourcePage' ? y.source && y.source.page : y[k])).join(',')));
    fs.writeFileSync(path.join(DIR, 'history-usd.csv'), [cols.join(','), ...rows].join('\n') + '\n');
    for (const r of report) {
        console.log(`${r.symbol.padEnd(12)} ${String(r.years).padStart(2)} yrs ${r.span.padEnd(10)} fill ${(r.fill * 100).toFixed(0).padStart(3)}%` +
            `${r.missingYears.length ? ' missing ' + r.missingYears.join(',') : ''}${r.nulls.length ? ' | never: ' + r.nulls.join(',') : ''}`);
        if (r.cmp.length) console.log(`             vs Yahoo: ${r.cmp.join('; ')}`);
        for (const i of r.issues) console.log(`             ! ${i}`);
    }
    console.log(`${out.length} companies, ${out.reduce((s, c) => s + c.years.length, 0)} company-years`);
})();
