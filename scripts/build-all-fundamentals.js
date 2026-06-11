#!/usr/bin/env node
/**
 * build-all-fundamentals.js
 *
 * Walks the full US-listed directory (us-companies.json) and builds the
 * fundamentals cache for every symbol not already cached, via the same
 * on-demand builder Ask uses (Yahoo + SEC extension, USD gate, persisted
 * to frontend/data/fundamentals/). Free sources only; resumable — rerun
 * skips whatever already exists.
 *
 * Env: CONCURRENCY=3  MAX=0 (0 = all)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const FUND_DIR = path.join(ROOT, 'frontend', 'data', 'fundamentals');
const fundFetch = require(path.join(ROOT, 'backend', 'fundamentals-fetch'));

const CONCURRENCY = Math.max(1, Math.min(6, Number(process.env.CONCURRENCY || 3)));
const MAX = Number(process.env.MAX || 0);

(async () => {
    const dir = JSON.parse(fs.readFileSync(path.join(ROOT, 'frontend', 'data', 'us-companies.json'), 'utf8'));
    const cached = new Set(fs.readdirSync(FUND_DIR).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));
    let todo = dir.companies
        .map((c) => c.symbol)
        .filter((s) => !cached.has(s.replace(/[^A-Z0-9]/g, '_')));
    if (MAX) todo = todo.slice(0, MAX);
    console.log(`${dir.companies.length} in directory, ${cached.size} cached, ${todo.length} to build, concurrency ${CONCURRENCY}`);

    let done = 0; let ok = 0; let skipped = 0; let failed = 0;
    const t0 = Date.now();
    const failures = [];
    async function worker() {
        for (;;) {
            const sym = todo.shift();
            if (!sym) return;
            try {
                await fundFetch.buildFundamentals(sym);
                ok++;
            } catch (e) {
                if (/reports in [A-Z]{3}/.test(e.message)) skipped++; // foreign — by design
                else { failed++; failures.push(`${sym}: ${e.message.slice(0, 80)}`); }
            }
            done++;
            if (done % 50 === 0) {
                const rate = done / ((Date.now() - t0) / 60000);
                console.log(`${done} done (${ok} ok, ${skipped} foreign-skipped, ${failed} failed) — ${rate.toFixed(0)}/min, ~${Math.round(todo.length / rate)}min left`);
            }
            await new Promise((r) => setTimeout(r, 250)); // be polite to SEC/Yahoo
        }
    }
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    console.log(`\nFINISHED in ${((Date.now() - t0) / 60000).toFixed(1)}min: ${ok} built, ${skipped} foreign-skipped, ${failed} failed`);
    if (failures.length) {
        fs.writeFileSync('/tmp/build-all-failures.txt', failures.join('\n'));
        console.log(`failures listed in /tmp/build-all-failures.txt (first 10):`);
        failures.slice(0, 10).forEach((f) => console.log('  ' + f));
    }
    process.exit(0);
})().catch((e) => { console.error('fatal:', e); process.exit(1); });
