'use strict';

/**
 * Pre-warm the business-segment cache for the ~500 largest companies in the
 * universe (user-approved spend, 2026-06-12). Each extraction fetches the
 * company's latest 10-K from EDGAR and runs one AI extraction; results are
 * cached in Mongo per (symbol, accession), so re-runs and page loads are free.
 *
 * Usage: node scripts/preextract-segments.js [--limit N]
 */

const path = require('path');
require(path.join(__dirname, '..', 'backend', 'node_modules', 'dotenv')).config({ path: path.join(__dirname, '..', 'backend', '.env') });
const mongoose = require(path.join(__dirname, '..', 'backend', 'node_modules', 'mongoose'));
const aiChat = require('../backend/ai-chat');
const segments = require('../backend/segments');

const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx > -1 ? Number(process.argv[limitIdx + 1]) : 500;
const PAUSE_MS = 1200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    await mongoose.connect(process.env.MONGODB_URI);
    const { rows } = aiChat.screenRows({ sort_by: 'marketCapB', limit: LIMIT, maxLimit: LIMIT });
    console.log(`Pre-extracting segments for ${rows.length} companies (largest by market cap)…`);
    let ok = 0, empty = 0, cachedN = 0, failed = 0;
    const failures = [];
    for (let i = 0; i < rows.length; i++) {
        const sym = rows[i].symbol;
        try {
            const r = await segments.extractSegments(sym);
            if (r.error) { failed++; failures.push(`${sym}: ${r.error}`); console.log(`[${i + 1}/${rows.length}] ${sym.padEnd(6)} ERROR ${r.error}`); }
            else if (!r.segments.length) { empty++; console.log(`[${i + 1}/${rows.length}] ${sym.padEnd(6)} no segments (${r.cached ? 'cached' : 'fresh'})`); }
            else {
                if (r.cached) cachedN++; else ok++;
                console.log(`[${i + 1}/${rows.length}] ${sym.padEnd(6)} ${r.segments.length} segments (${r.cached ? 'cached' : 'fresh'})`);
            }
        } catch (e) {
            failed++;
            failures.push(`${sym}: ${e.message}`);
            console.log(`[${i + 1}/${rows.length}] ${sym.padEnd(6)} THREW ${e.message}`);
        }
        await sleep(PAUSE_MS);
    }
    console.log(`\nDone: ${ok} extracted, ${cachedN} already cached, ${empty} no-segments, ${failed} failed.`);
    failures.slice(0, 30).forEach((f) => console.log('  FAIL', f));
    await mongoose.disconnect();
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
