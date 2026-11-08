#!/usr/bin/env node
'use strict';
// Triage for the SEDAR+ pilot: run after the owner drops filed PDFs into
// .cache/sedar/downloads/. Local-only; never touches the network.
//
//   node scripts/sedar-pickup.cjs
//
// For each PDF: page count, per-page text via pdftotext -layout, and the pages
// whose text looks like a primary statement (consolidated balance sheet /
// statement of operations / income / cash flows). This is the development
// harness for the real extractor; nothing is stored outside .cache/sedar/.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DIR = path.join(__dirname, '..', '.cache', 'sedar');
const DL = path.join(DIR, 'downloads');
const TXT = path.join(DIR, 'text');

const STATEMENT_HINT = /consolidated (?:balance sheets?|statements? of (?:financial position|operations|income|earnings|loss|cash flows|changes in (?:shareholders'? |equity)))/i;

const pdfs = fs.readdirSync(DL).filter(f => f.toLowerCase().endsWith('.pdf')).sort();
if (!pdfs.length) {
    console.log('No PDFs in', DL);
    process.exit(0);
}
for (const file of pdfs) {
    const full = path.join(DL, file);
    const bytes = fs.statSync(full).size;
    let pages = '?';
    try {
        const info = execFileSync('pdfinfo', [full], { encoding: 'utf8' });
        const m = info.match(/^Pages:\s+(\d+)/m);
        if (m) pages = m[1];
    } catch { /* pdfinfo optional */ }
    const out = path.join(TXT, file.replace(/\.pdf$/i, '.txt'));
    try {
        execFileSync('pdftotext', ['-layout', full, out], { stdio: 'pipe' });
    } catch (e) {
        console.log(`${file}\t${(bytes / 1e6).toFixed(1)} MB\tpdftotext FAILED: ${e.message.split('\n')[0]}`);
        continue;
    }
    const text = fs.readFileSync(out, 'utf8');
    const pageText = text.split('\f').filter(s => s.trim());
    const hits = [];
    pageText.forEach((pt, i) => { if (STATEMENT_HINT.test(pt)) hits.push(i + 1); });
    const scanned = pageText.length < (+pages || 0) * 0.5;
    console.log(`${file}\t${(bytes / 1e6).toFixed(1)} MB\t${pages} pages\tstatement pages: ${hits.join(',') || 'none found'}${scanned ? '\tWARNING: mostly image/scanned pages' : ''}`);
}
