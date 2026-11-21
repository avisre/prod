#!/usr/bin/env node
'use strict';
// Sweep every issuer through the same contract the company page renders
// (backend/revenue-breakdown.js) and report what a reader would see. Exits
// non-zero on any violation: a name not in plain words, duplicate rows, shares
// that do not account for revenue, or a withheld breakdown with no reason.
// Read-only; no network and no model. Runs in the deploy gate.
//
//   node scripts/audit-segment-display.js            summary
//   node scripts/audit-segment-display.js --sp500    plus S&P 500 coverage
//   node scripts/audit-segment-display.js --golden   rewrite the golden set
const fs = require('fs');
const path = require('path');
const breakdown = require('../backend/revenue-breakdown');
const { isMainThread, workerData } = require('worker_threads');
const { runChunks, serveChunks } = require('./lib/worker-pool');
const latestRevenue = data => { const r = (data.income?.annualReports || []).slice().sort((a, b) => String(b.fiscalDateEnding).localeCompare(String(a.fiscalDateEnding)))[0]; return !r ? null : r.totalRevenue === null || r.totalRevenue === undefined || r.totalRevenue === '' || !Number.isFinite(Number(r.totalRevenue)) ? 'missing' : Number(r.totalRevenue); };
const DATA = require('../backend/sec-coverage').DATA_DIR;
const GOLDEN = path.join(__dirname, '..', 'backend', 'test', 'fixtures', 'revenue-breakdown-golden.json');
const GOLDEN_SYMBOLS = ['AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META', 'NVDA', 'ORCL', 'AVGO', 'TSLA', 'NFLX', 'CRM', 'ADBE', 'AMD', 'INTC', 'IBM', 'CSCO', 'QCOM',
    'JPM', 'BAC', 'WFC', 'GS', 'MS', 'C', 'BRK-B', 'AIG', 'PGR', 'V', 'MA', 'AXP', 'WMT', 'TGT', 'COST', 'HD', 'MCD', 'SBUX', 'NKE', 'KO', 'PEP', 'PG',
    'JNJ', 'PFE', 'MRK', 'LLY', 'BMY', 'UNH', 'CVS', 'XOM', 'CVX', 'COP', 'BA', 'CAT', 'DE', 'GE', 'HON', 'UPS', 'DAL', 'DIS', 'CMCSA', 'T', 'VZ', 'INOD', 'CRWV', 'BMI'];

// The directory's own symbol → CIK mapping, the one the pages resolve through: reading symbols out of
// sec-reporting.json let a registration that no longer carries the listing decide the golden row.
function symbols() {
    const out = new Map();
    try { for (const c of JSON.parse(fs.readFileSync(path.join(DATA, 'us-companies.json'), 'utf8')).companies || []) if (c.symbol && c.cik) out.set(c.symbol, String(c.cik).padStart(10, '0')); } catch (_) { /* optional */ }
    return out;
}
const load = cik => { try { return JSON.parse(fs.readFileSync(path.join(DATA, 'sec-financials', cik + '.json'), 'utf8')); } catch (_) { return null; } };
const brief = c => ({ grade: c.grade, kind: c.kind, fiscalYear: c.fiscalYear, rows: c.rows.map(r => r.name), remainder: !!c.remainder });

// Files files[start..end): each issuer's contract depends on its own file only.
function auditChunk(files, start, end) {
    const out = { issuers: 0, complete: 0, partial: 0, none: 0, productLines: 0, operatingSegments: 0, regions: 0, failures: [] };
    for (const file of files.slice(start, end)) {
        const data = load(file.replace('.json', ''));
        if (!data) continue;
        out.issuers++;
        const contract = breakdown.fromGroups(data.segmentObservations || [], data.issuerName, { read: data.industryExtraction?.status === 'success', revenue: latestRevenue(data), cik: data.cik || file.replace('.json', '') });
        out[contract.grade]++;
        if (contract.kind === 'product and service lines') out.productLines++; else if (contract.kind === 'regions') out.regions++; else if (contract.kind) out.operatingSegments++;
        for (const v of breakdown.violations(contract)) out.failures.push(`${data.issuerName} [${file.replace('.json', '')}]: ${v}`);
    }
    return out;
}
function merge(parts) {
    const out = { issuers: 0, complete: 0, partial: 0, none: 0, productLines: 0, operatingSegments: 0, regions: 0, failures: [] };
    for (const part of parts) for (const [k, v] of Object.entries(part)) if (k === 'failures') out.failures.push(...v); else out[k] += v;
    return out;
}
const issuerFiles = () => fs.readdirSync(path.join(DATA, 'sec-financials'));
function audit() {
    const files = issuerFiles();
    return merge([auditChunk(files, 0, files.length)]);
}
// The same sweep with the files spread over every core, merged in directory order.
async function auditParallel({ workers } = {}) {
    const files = issuerFiles();
    return merge(await runChunks(__filename, { segmentAuditWorker: true, files }, files.length, { workers }));
}
function golden() {
    const map = symbols(), out = {};
    for (const s of GOLDEN_SYMBOLS) { const cik = map.get(s) || map.get(s.replace('-', '.')), data = cik && load(cik); if (data) out[s] = brief(breakdown.fromGroups(data.segmentObservations || [], s, { read: data.industryExtraction?.status === 'success', revenue: latestRevenue(data) })); }
    return out;
}
function sp500() {
    const map = symbols(), list = JSON.parse(fs.readFileSync(path.join(DATA, 'sp500-companies.json'), 'utf8')), tally = { complete: 0, partial: 0, none: 0, missing: 0 };
    for (const c of list) { const cik = map.get(c.symbol) || map.get(String(c.symbol).replace('.', '-')), data = cik && load(cik); if (!data) tally.missing++; else tally[breakdown.fromGroups(data.segmentObservations || []).grade]++; }
    return tally;
}

if (!isMainThread && workerData?.segmentAuditWorker) serveChunks((start, end) => auditChunk(workerData.files, start, end));
else if (require.main === module) {
    if (process.argv.includes('--golden')) { fs.mkdirSync(path.dirname(GOLDEN), { recursive: true }); fs.writeFileSync(GOLDEN, JSON.stringify(golden(), null, 1) + '\n'); console.log('wrote', GOLDEN); process.exit(0); }
    auditParallel().then(result => {
        console.log(JSON.stringify({ ...result, failures: result.failures.length, sample: result.failures.slice(0, 20), ...(process.argv.includes('--sp500') ? { sp500: sp500() } : {}) }, null, 2));
        process.exit(result.failures.length ? 1 : 0);
    }, e => { console.error(e.message); process.exit(1); });
}
module.exports = { audit, auditParallel, golden, sp500, GOLDEN };
