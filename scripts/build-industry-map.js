#!/usr/bin/env node
'use strict';
// Writes frontend/data/industry-map.json: one industry label per ticker, read by
// backend/company-peers.js to choose the peers on the Stocks & funds page.
//
// The label is the one each company's stored overview already carries, then the
// profile file for companies whose overview has none — the same order
// backend/stock-universe.js applies when it serves a company. The fundamentals
// files are ~2MB each and the overview sits at the top, so only the head of
// each file is read; a file whose head has no label is parsed whole.
const fs = require('node:fs');
const path = require('node:path');

const DATA = process.env.SEC_COVERAGE_DATA_DIR || path.join(__dirname, '../frontend/data');
const key = (s) => String(s || '').trim().toUpperCase().replace(/\./g, '-');
const LABEL = /"Industry"\s*:\s*("(?:[^"\\]|\\.)*")/;

function headLabel(file) {
    const fd = fs.openSync(file, 'r');
    try {
        const buf = Buffer.alloc(65536), n = fs.readSync(fd, buf, 0, buf.length, 0);
        const m = buf.toString('utf8', 0, n).match(LABEL);
        if (m) return JSON.parse(m[1]);
    } finally { fs.closeSync(fd); }
    try { return JSON.parse(fs.readFileSync(file, 'utf8')).overview?.Industry || ''; } catch (_) { return ''; }
}

function build() {
    const out = {};
    const dir = path.join(DATA, 'fundamentals');
    for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        const label = String(headLabel(path.join(dir, name)) || '').trim();
        if (label) out[key(name.slice(0, -5))] = label;
    }
    let profiles = {};
    try { profiles = JSON.parse(fs.readFileSync(path.join(DATA, 'company-profiles.json'), 'utf8')).profiles || {}; }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const [symbol, profile] of Object.entries(profiles)) {
        const label = String(profile?.industry || '').trim();
        if (label && !out[key(symbol)]) out[key(symbol)] = label;
    }
    const industries = Object.fromEntries(Object.keys(out).sort().map((k) => [k, out[k]]));
    return { schemaVersion: 1, count: Object.keys(industries).length, industries };
}

if (require.main === module) {
    const doc = build();
    // An empty map would silently send every company back to sector peers.
    if (doc.count < 1000) { console.error('industry map too small: ' + doc.count); process.exit(1); }
    fs.writeFileSync(path.join(DATA, 'industry-map.json'), JSON.stringify(doc) + '\n');
    console.log(JSON.stringify({ count: doc.count, labels: new Set(Object.values(doc.industries)).size }));
}
module.exports = { build };
