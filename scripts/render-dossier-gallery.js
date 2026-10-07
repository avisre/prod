#!/usr/bin/env node
'use strict';
// A contact sheet of the company page's revenue section for real tickers, built
// with the shipped renderer and the same contract production serves. Nothing
// else shows what a reader sees for many companies at once; run it and look at
// it before pushing a change to the breakdown, its names or its chart.
//
//   node scripts/render-dossier-gallery.js [--random 40] [--out docs/qa/dossier-gallery]
//
// Read-only: no network, no model. Writes one HTML file (and a PNG when a
// Chromium-family browser is installed).
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { execFileSync } = require('child_process');
const root = path.join(__dirname, '..');
const breakdown = require('../backend/revenue-breakdown');
const latestRevenue = data => { const r = (data.income?.annualReports || []).slice().sort((a, b) => String(b.fiscalDateEnding).localeCompare(String(a.fiscalDateEnding)))[0]; return r ? Number(r.totalRevenue) || 0 : null; };
const audit = require('./audit-segment-display');
const DATA = require('../backend/sec-coverage').DATA_DIR;

const arg = (name, fallback) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : fallback; };
const outDir = path.resolve(root, arg('--out', 'docs/qa/dossier-gallery'));
const SRC = fs.readFileSync(path.join(root, 'frontend-v2/assets/dossier.js'), 'utf8');
const slice = (from, to) => { const a = SRC.indexOf(from), b = SRC.indexOf(to, a); if (a < 0 || b < a) throw new Error('page source marker moved: ' + from); return SRC.slice(a, b); };
const ctx = { C: { ink: '#1c1b18', accent: '#8a5f00', pos: '#1b7a4b', neg: '#b4422f', grey: '#8a877e', faint: '#e7e4dd' },
    esc: v => String(v == null ? '' : v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])),
    bn: v => { if (v == null) return '—'; const a = Math.abs(v); return (v < 0 ? '−' : '') + (a >= 1e12 ? '$' + (a / 1e12).toFixed(2) + 'T' : a >= 1e9 ? '$' + (a / 1e9).toFixed(1) + 'B' : '$' + (a / 1e6).toFixed(0) + 'M'); } };
vm.createContext(ctx);
vm.runInContext(slice('const SEG_RAMP', '  function miniBars(') + slice('  function breakdownTable(', '  // Commitments outside the balance sheet.') +
    ';globalThis.section = (inc, sg) => (sankey(inc, sg) || "") + breakdownTable(sg, inc) + (sg && sg.note ? `<p class="small faint" style="margin-top:8px;">${esc(sg.note)}</p>` : "");', ctx);

const reporting = JSON.parse(fs.readFileSync(path.join(DATA, 'sec-reporting.json'), 'utf8')).issuers || {};
const bySymbol = new Map();
for (const e of Object.values(reporting)) for (const s of e.symbols || []) bySymbol.set(s, String(e.cik).padStart(10, '0'));
const golden = Object.keys(JSON.parse(fs.readFileSync(audit.GOLDEN, 'utf8')));
const all = [...bySymbol.keys()].sort(), extra = [], want = Number(arg('--random', 40));
// A fixed stride, not Math.random: the same sheet every run, so two runs can be compared.
for (let i = 7; extra.length < want && i < all.length; i += Math.max(1, Math.floor(all.length / (want + 1)))) if (!golden.includes(all[i])) extra.push(all[i]);

const { repairIncome } = require('../backend/income-statement');
const cards = [], tally = { complete: 0, partial: 0, none: 0, skipped: 0 };
for (const symbol of [...golden, ...extra]) {
    const cik = bySymbol.get(symbol) || bySymbol.get(symbol.replace('-', '.'));
    let data = null;
    try { data = JSON.parse(fs.readFileSync(path.join(DATA, 'sec-financials', cik + '.json'), 'utf8')); } catch (_) { /* no file */ }
    const latest = data && (data.income?.annualReports || []).slice().sort((a, b) => String(b.fiscalDateEnding).localeCompare(String(a.fiscalDateEnding)))[0];
    if (!latest) { tally.skipped++; continue; }
    const contract = breakdown.fromGroups(data.segmentObservations || [], symbol, { read: data.industryExtraction?.status === 'success', revenue: latestRevenue(data) }), bad = breakdown.violations(contract);
    tally[contract.grade]++;
    let html = '';
    try { html = ctx.section(repairIncome(latest), breakdown.forPage(contract)); } catch (error) { html = `<p style="color:#b4422f">render failed: ${ctx.esc(error.message)}</p>`; }
    cards.push(`<section class="card"><h2>${ctx.esc(symbol)} <span class="small faint">${ctx.esc(data.issuerName || '')} · ${contract.grade}${contract.kind ? ' · ' + contract.kind : ''}${contract.fiscalYear ? ' · ' + contract.fiscalYear : ''}</span></h2>${bad.length ? `<p style="color:#b4422f">${ctx.esc(bad.join('; '))}</p>` : ''}${html || '<p class="small faint">No chart: the income statement cannot be drawn.</p>'}</section>`);
}
const page = fs.readFileSync(path.join(root, 'frontend-v2/dossier.html'), 'utf8');
const style = (page.match(/<style>[\s\S]*?<\/style>/g) || []).join('\n');
fs.mkdirSync(outDir, { recursive: true });
const file = path.join(outDir, 'index.html');
fs.writeFileSync(file, `<!doctype html><meta charset="utf-8"><title>Dossier revenue gallery</title><style>${fs.readFileSync(path.join(root, 'frontend-v2/assets/system.css'), 'utf8')}</style>${style}
<style>body{background:var(--bg,#faf9f5)}main{max-width:1100px;margin:0 auto;padding:24px}.card{margin:0 0 40px;padding-bottom:24px;border-bottom:1px solid var(--line,#e8e6e0)}.card h2{font-size:18px}</style>
<body><main><h1 style="font-size:22px">Revenue section, ${cards.length} companies</h1><p class="small faint">complete ${tally.complete} · partial ${tally.partial} · none ${tally.none}</p>${cards.join('\n')}</main></body>`);
console.log(JSON.stringify({ file, companies: cards.length, ...tally }));
for (const browser of ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser', 'chromium', 'google-chrome']) {
    try { execFileSync(browser, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--window-size=1200,${Math.min(16000, 300 + cards.length * 620)}`, `--screenshot=${path.join(outDir, 'gallery.png')}`, 'file://' + file], { stdio: 'ignore', timeout: 90000 }); console.log('screenshot', path.join(outDir, 'gallery.png')); break; } catch (_) { /* try the next */ }
}
