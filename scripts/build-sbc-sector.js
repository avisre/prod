#!/usr/bin/env node
'use strict';

// Builds backend/sbc-sector.json: for each sector in the screener index, the
// sorted list of every company's latest filed stock-based compensation as a
// percentage of revenue. The Stocks & funds page ranks a company against this
// list ("higher than 36% of Information Technology companies").
//
// It reads only committed data (frontend/data/screen-index.json and
// frontend/data/sec-financials/*.json) and uses the same model the page draws
// from, so a company's own figure and its place in the list are computed one
// way. Re-run after the fundamentals are rebuilt:
//   node scripts/build-sbc-sector.js

const fs = require('fs');
const path = require('path');
const sbcModel = require('../frontend-v2/assets/sbc-model.js');

const ROOT = path.join(__dirname, '..');
const DATA = path.join(ROOT, 'frontend', 'data');
const OUT = path.join(ROOT, 'backend', 'sbc-sector.json');

function rowsFor(doc) {
    const cash = (doc.cash && doc.cash.annualReports) || [];
    const income = (doc.income && doc.income.annualReports) || [];
    const revByEnd = new Map(income.map((r) => [r.fiscalDateEnding, r.totalRevenue]));
    return cash.map((c) => ({ end: c.fiscalDateEnding, sbc: c.shareBasedCompensation, rev: revByEnd.get(c.fiscalDateEnding) }));
}

function main() {
    const index = JSON.parse(fs.readFileSync(path.join(DATA, 'screen-index.json'), 'utf8'));
    const sectors = {};
    let read = 0, counted = 0;
    for (const row of index.rows || []) {
        if (!row.sector || !row.cik) continue;
        const file = path.join(DATA, 'sec-financials', `${String(row.cik).padStart(10, '0')}.json`);
        let doc;
        try { doc = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { continue; }
        read += 1;
        const built = sbcModel.build(rowsFor(doc));
        if (built.status !== 'ok' || built.pctRevenue === null) continue;
        (sectors[row.sector] = sectors[row.sector] || []).push(Math.round(built.pctRevenue * 100) / 100);
        counted += 1;
    }
    for (const name of Object.keys(sectors)) sectors[name].sort((a, b) => a - b);
    const ordered = Object.fromEntries(Object.keys(sectors).sort().map((k) => [k, sectors[k]]));
    const out = { v: 1, measure: 'latest filed stock-based compensation as % of revenue', asOf: index.asOf || null, companies: counted, sectors: ordered };
    fs.writeFileSync(OUT, `${JSON.stringify(out)}\n`);
    console.log(`read ${read} companies, ranked ${counted} across ${Object.keys(ordered).length} sectors -> ${path.relative(ROOT, OUT)}`);
    for (const [name, list] of Object.entries(ordered)) console.log(`  ${name}: n=${list.length} median=${list[Math.floor((list.length - 1) / 2)]}%`);
}

main();
