#!/usr/bin/env node
'use strict';
// Resumable full-universe backfill. An incomplete file is not a cache hit.
// --audit performs no network work. --refresh also rebuilds existing records.
const fs = require('fs');
const path = require('path');
const stocks = require('../backend/stock-universe');
const ROOT = path.resolve(__dirname, '..');
const FUND_DIR = path.join(ROOT, 'frontend/data/fundamentals');
const REPORT = path.join(ROOT, 'frontend/data/stock-coverage.json');
function inspect(company) {
    try {
        const d = JSON.parse(fs.readFileSync(path.join(FUND_DIR, company.symbol.replace(/[^A-Z0-9]/g, '_') + '.json'), 'utf8'));
        return stocks.usable(stocks.withIdentity(d, company));
    } catch (_) { return false; }
}
function audit(list, failures = []) {
    const missing = list.filter((c) => !inspect(c)).map((c) => c.symbol);
    return { generatedAt: new Date().toISOString(), listed: list.length, fundamentalsReady: list.length - missing.length,
        missing, failures, note: 'Listing coverage and available fundamentals are counted separately. Readiness does not guarantee every metric or a recent filing.' };
}
function writeReport(report) {
    fs.writeFileSync(REPORT + '.tmp', JSON.stringify(report));
    fs.renameSync(REPORT + '.tmp', REPORT);
}
async function main() {
    const list = stocks.companies();
    if (process.argv.includes('--audit')) { const report = audit(list); console.log(JSON.stringify({ listed: report.listed, ready: report.fundamentalsReady, missing: report.missing.length })); return; }
    const max = Number(process.env.MAX || 0);
    const refresh = process.argv.includes('--refresh');
    const shards = Number(process.env.UNIVERSE_SHARD_COUNT || 1);
    const shard = Number(process.env.UNIVERSE_SHARD_INDEX ?? ((new Date().getUTCDate() - 1) % shards));
    if (!Number.isInteger(shards) || shards < 1 || !Number.isInteger(shard) || shard < 0 || shard >= shards) throw new Error('Invalid universe shard');
    const bucket = (symbol) => [...symbol].reduce((h, ch) => ((h * 31 + ch.charCodeAt(0)) >>> 0), 0) % shards;
    const todo = list.filter((c) => bucket(c.symbol) === shard && (refresh || !inspect(c)));
    console.log(`Refresh shard ${shard + 1}/${shards}`);
    if (max > 0) todo.splice(max);
    const total = todo.length;
    const concurrency = Math.max(1, Math.min(4, Number(process.env.CONCURRENCY || 2)));
    const fundFetch = require('../backend/fundamentals-fetch');
    const failures = [];
    let done = 0, ok = 0;
    console.log(`${list.length} listed stocks; ${total} to ${refresh ? 'refresh' : 'backfill'}; concurrency ${concurrency}`);
    async function worker() {
        for (;;) {
            const entry = todo.shift();
            if (!entry) return;
            try {
                const data = await fundFetch.buildFundamentals(entry.symbol, { waitForCompletion: true });
                if (!stocks.usable(data) || !inspect(entry)) throw new Error('Build did not persist usable statements');
                ok++;
            } catch (e) { failures.push({ symbol: entry.symbol, reason: String(e.message).slice(0, 180) }); }
            done++;
            if (done % 25 === 0 || done === total) console.log(`${done}/${total}: ${ok} ready, ${failures.length} unavailable`);
        }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    const report = audit(list, failures);
    writeReport(report);
    console.log(JSON.stringify({ listed: report.listed, ready: report.fundamentalsReady, missing: report.missing.length, failures: failures.length }));
    if (total > 0 && ok === 0) process.exitCode = 1;
}
if (require.main === module) main().catch((e) => { console.error(e.message); process.exitCode = 1; });
module.exports = { inspect, audit };
