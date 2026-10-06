#!/usr/bin/env node
/**
 * refresh-profiles.js
 *
 * Business description, sector and industry for every listed stock that has
 * none. The per-symbol fundamentals files carry these for the original ~1,500
 * companies only; when coverage grew to every US listing the rest were left
 * with no description at all (2,022 of 4,593 covered companies on 2026-10-06).
 *
 * One small profile request per symbol, no statements and no price history,
 * written to a single compact file. A profile is refreshed after 120 days.
 *
 *   node scripts/refresh-profiles.js [symbol-list.json]
 *   MAX_SYMBOLS=1500   cap symbols fetched per run (0 = no cap)
 *   CONCURRENCY=4      parallel requests
 *   DRY_RUN=1          fetch but do not write
 */
'use strict';
const fs = require('fs');
const path = require('path');
const YahooFinance = require('yahoo-finance2').default;
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

const DATA = path.resolve(__dirname, '..', 'frontend', 'data');
const OUT_FILE = path.join(DATA, 'company-profiles.json');
const MAX_SYMBOLS = Math.max(0, Number(process.env.MAX_SYMBOLS ?? 1500));
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.CONCURRENCY || 4)));
const DRY_RUN = String(process.env.DRY_RUN || '') === '1';
const MAX_AGE_DAYS = 120;
const yahooSymbol = (s) => String(s || '').trim().toUpperCase().replace(/\./g, '-').replace(/[^A-Z0-9-]/g, '');

function hasStoredDescription(symbol) {
    try { return String(JSON.parse(fs.readFileSync(path.join(DATA, 'fundamentals', symbol + '.json'), 'utf8')).overview?.Description || '').trim().length > 40; }
    catch (_) { return false; }
}
async function main() {
    const list = JSON.parse(fs.readFileSync(path.resolve(process.argv[2] || path.join(DATA, 'us-companies.json')), 'utf8'));
    const rows = (Array.isArray(list) ? list : list.companies || []).map((r) => (typeof r === 'string' ? { symbol: r } : r)).filter((r) => r && r.symbol && (!r.securityType || r.securityType === 'stock'));
    let store = { profiles: {} };
    try { const prior = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')); if (prior && prior.profiles) store = prior; } catch (_) { /* first run */ }
    const today = new Date().toISOString().slice(0, 10);
    const stale = (p) => !p || !p.asOf || (Date.parse(today) - Date.parse(p.asOf)) / 86400000 > MAX_AGE_DAYS;
    const wanted = rows.map((r) => r.symbol).filter((s) => stale(store.profiles[s]) && !hasStoredDescription(s));
    const todo = MAX_SYMBOLS ? wanted.slice(0, MAX_SYMBOLS) : wanted;
    let done = 0, filled = 0, failed = 0, next = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
        while (next < todo.length) {
            const symbol = todo[next++];
            try {
                const ap = (await yf.quoteSummary(yahooSymbol(symbol), { modules: ['assetProfile'] }))?.assetProfile || {};
                const description = String(ap.longBusinessSummary || '').trim();
                // An empty answer is recorded too, so a symbol the provider does not know is not retried daily.
                store.profiles[symbol] = { description, sector: ap.sector || '', industry: ap.industry || '', website: ap.website || '', employees: Number(ap.fullTimeEmployees) || null, asOf: today };
                if (description) filled += 1;
            } catch (_) { failed += 1; }
            if (++done % 100 === 0) process.stderr.write(`\r[profiles] ${done}/${todo.length} filled=${filled} failed=${failed}`);
        }
    }));
    store.generatedAt = new Date().toISOString();
    store.source = 'Yahoo Finance asset profile';
    store.count = Object.keys(store.profiles).length;
    console.log(`\n[profiles] wanted=${wanted.length} fetched=${todo.length} filled=${filled} failed=${failed} stored=${store.count}`);
    if (DRY_RUN) return;
    fs.writeFileSync(OUT_FILE + '.tmp', JSON.stringify(store));
    fs.renameSync(OUT_FILE + '.tmp', OUT_FILE);
}
main().catch((error) => { console.error('[profiles] failed:', error.message); process.exit(1); });
