#!/usr/bin/env node
'use strict';
// Is the daily price refresh and the weekly SEC reconciliation actually
// arriving? Exit 0 when fresh (or only warned), 1 when stale, 2 when the
// check itself could not run.
//
//   node scripts/check-data-freshness.js                 production (what customers get)
//   node scripts/check-data-freshness.js --ref origin/main   what is committed, deployed or not
//   node scripts/check-data-freshness.js --dir <data dir>    a local data folder
//   add --json for the raw verdict
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const freshness = require('../backend/data-freshness');
const args = process.argv.slice(2);
const option = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null; };
const SITE = (option('--url') || process.env.FRESHNESS_URL || 'https://www.stockportfolio.pro').replace(/\/$/, '');

function fromRef(ref) {
    const show = (file) => { try { return JSON.parse(execFileSync('git', ['show', `${ref}:frontend/data/${file}`], { cwd: path.join(__dirname, '..'), maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8')); } catch (_) { return null; } };
    const summary = show('financial-coverage-summary.json');
    const quotes = show('quotes.json');
    return freshness.assess({ quotes, summary, listed: Number(quotes?._meta?.requested) || null,
        extractionVersion: require('../backend/sec-facts').EXTRACTION_VERSION });
}

async function fromSite() {
    const response = await fetch(SITE + '/api/health/data', { signal: AbortSignal.timeout(20000), headers: { accept: 'application/json' } });
    if (response.status === 404) throw Object.assign(new Error(`${SITE} does not serve /api/health/data yet (not deployed)`), { code: 'NOT_DEPLOYED' });
    const body = await response.json().catch(() => null);
    if (!body || !body.prices || !body.fundamentals) throw new Error(`${SITE}/api/health/data answered HTTP ${response.status} without a verdict`);
    return body;
}

function print(source, v) {
    const mark = { ok: 'OK   ', warn: 'WARN ', stale: 'STALE' };
    const p = v.prices, f = v.fundamentals;
    console.log(`Data freshness — ${source}`);
    console.log(`${mark[p.status]} prices (daily)        ${p.tradingDate || 'no date'}, ${p.weekdaysOld ?? '?'} trading day(s) old; ${p.priced} priced${p.listed ? ' of ' + p.listed + ' requested' : ''}, ${(p.shareOnTradingDate * 100).toFixed(1)}% on that date`);
    for (const reason of p.reasons) console.log(`        - ${reason}`);
    console.log(`${mark[f.status]} fundamentals (weekly) ${f.asOf || 'no date'}, ${f.daysOld ?? '?'} day(s) old; rules ${f.extractionVersion || '?'}${f.issuers ? ', ' + f.issuers + ' issuers' : ''}`);
    for (const reason of f.reasons) console.log(`        - ${reason}`);
    console.log(v.status === 'ok' ? 'Result: fresh' : v.status === 'warn' ? 'Result: fresh, with a warning' : 'Result: STALE');
}

(async () => {
    const ref = option('--ref'), dir = option('--dir');
    const source = dir ? `local folder ${dir}` : ref ? `committed at ${ref}` : `production (${SITE})`;
    const verdict = dir ? freshness.assess(freshness.read(path.resolve(dir))) : ref ? fromRef(ref) : await fromSite();
    if (args.includes('--json')) console.log(JSON.stringify(verdict, null, 1)); else print(source, verdict);
    process.exitCode = verdict.status === 'stale' ? 1 : 0;
})().catch((error) => { console.error('Freshness check could not run: ' + error.message); process.exitCode = 2; });
