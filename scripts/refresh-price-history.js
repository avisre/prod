#!/usr/bin/env node
/**
 * refresh-price-history.js
 *
 * Rewrites only the chart series (`daily` and `monthly`) inside each stored
 * frontend/data/fundamentals/<SYMBOL>.json. Statements, overview and every
 * other key are left exactly as they are: those come from the SEC
 * reconciliation now, and this job must not disturb them.
 *
 * See backend/price-history.js for why it exists.
 *
 * Usage:
 *   node scripts/refresh-price-history.js [symbol-list.json]
 *
 * Env vars:
 *   MAX_SYMBOLS=50     Cap symbols processed (0 = no cap)
 *   SYMBOLS=AAPL,FIGR  Only these symbols
 *   CONCURRENCY=6      Parallel symbols (two Yahoo chart calls each)
 *   DRY_RUN=1          Report without writing
 *   SKIP_FRESH_DAYS=3  Leave alone any series whose last close is within this many
 *                      days (resumes an interrupted run without re-fetching)
 */
'use strict';

const fs = require('fs');
const path = require('path');
const priceHistory = require(path.join(__dirname, '..', 'backend', 'price-history'));

const DATA = path.join(__dirname, '..', 'frontend', 'data');
const DIR = path.join(DATA, 'fundamentals');
const MAX_SYMBOLS = Number(process.env.MAX_SYMBOLS || 0);
const CONCURRENCY = Math.max(1, Math.min(10, Number(process.env.CONCURRENCY || 6)));
const DRY_RUN = process.env.DRY_RUN === '1';
const SKIP_FRESH_DAYS = Number(process.env.SKIP_FRESH_DAYS || 0);

function symbols(listPath) {
    if (process.env.SYMBOLS) return process.env.SYMBOLS.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
    const list = JSON.parse(fs.readFileSync(listPath || path.join(DATA, 'us-companies.json'), 'utf8'));
    const out = (list.companies || list).filter((c) => !c.securityType || c.securityType === 'stock').map((c) => c.symbol);
    return MAX_SYMBOLS > 0 ? out.slice(0, MAX_SYMBOLS) : out;
}

async function one(symbol) {
    const file = path.join(DIR, symbol + '.json');
    let payload;
    try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { symbol, result: e.code === 'ENOENT' ? 'no_file' : 'unreadable' }; }
    const before = priceHistory.latest(priceHistory.dailyOf(payload)) || priceHistory.latest(priceHistory.monthlyOf(payload));
    if (SKIP_FRESH_DAYS > 0 && before && Date.now() - Date.parse(before + 'T00:00:00Z') <= SKIP_FRESH_DAYS * 86400000) return { symbol, result: 'fresh' };
    let fetched;
    for (let attempt = 0; attempt < 3; attempt++) {
        fetched = await priceHistory.fetchSeries(symbol).catch((e) => ({ daily: {}, monthly: {}, reason: String(e.message || e) }));
        if (Object.keys(fetched.daily).length || Object.keys(fetched.monthly).length) break;
        if (/not found|no data|delisted/i.test(fetched.reason || '')) break; // a dead ticker does not come back on a retry
        await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
    if (!Object.keys(fetched.daily).length && !Object.keys(fetched.monthly).length) return { symbol, result: 'no_prices', reason: fetched.reason || '' };
    const changed = priceHistory.apply(payload, fetched);
    if (!changed) return { symbol, result: 'unchanged' };
    payload.pricesFetchedAt = new Date().toISOString();
    if (!DRY_RUN) fs.writeFileSync(file, JSON.stringify(payload));
    return { symbol, result: before ? 'updated' : 'filled', before, after: priceHistory.latest(priceHistory.dailyOf(payload)) };
}

async function main() {
    const list = symbols(process.argv[2]);
    const counts = {}; const noPrices = [];
    let next = 0; let done = 0;
    const worker = async () => {
        while (next < list.length) {
            const symbol = list[next++];
            const r = await one(symbol);
            counts[r.result] = (counts[r.result] || 0) + 1;
            if (r.result === 'no_prices') noPrices.push(symbol);
            if (++done % 250 === 0) console.log(`[price-history] ${done}/${list.length} ${JSON.stringify(counts)}`);
        }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    console.log(`[price-history] finished ${list.length} symbols ${JSON.stringify(counts)}${DRY_RUN ? ' (dry run, nothing written)' : ''}`);
    if (noPrices.length) console.log(`[price-history] no prices from the source for ${noPrices.length}: ${noPrices.slice(0, 60).join(' ')}${noPrices.length > 60 ? ' …' : ''}`);
    // A run in which the source answered for almost nobody is an outage, not data.
    const got = (counts.updated || 0) + (counts.filled || 0) + (counts.unchanged || 0) + (counts.fresh || 0) + (counts.no_file || 0);
    if (list.length >= 50 && got < list.length * 0.3) { console.error('[price-history] the price source answered for under 30% of symbols; treating the run as failed'); process.exit(1); }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { one, symbols };
