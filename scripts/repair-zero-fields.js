'use strict';

/**
 * One-off: re-run the SEC backfill over every cached fundamentals JSON now
 * that backfillSection treats a literal 0 as "not populated" (Yahoo wrote 0
 * for fields it didn't have — e.g. AAPL gross profit FY2022-25). SEC values
 * win where EDGAR discloses them; rows SEC can't resolve are left alone.
 * Safe to re-run: extend skips existing periods, split-adjust is idempotent.
 *
 * Usage: node scripts/repair-zero-fields.js [--dry] [--limit N]
 */

const fs = require('fs');
const path = require('path');
const secSource = require(path.join(__dirname, '..', 'backend', 'sec-source'));

const DATA_DIR = path.join(__dirname, '..', 'frontend', 'data', 'fundamentals');
const DRY = process.argv.includes('--dry');
const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx > -1 ? Number(process.argv[limitIdx + 1]) : Infinity;
const THROTTLE_MS = 400; // SEC fair-use is 10 req/s; stay well under

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Count populated (non-empty, non-zero) statement cells so we can report how
// many the backfill actually filled.
function countFilled(payload) {
  let n = 0;
  for (const st of ['income', 'balance', 'cash']) {
    for (const kind of ['annualReports', 'quarterlyReports']) {
      for (const r of (payload[st] || {})[kind] || []) {
        for (const v of Object.values(r)) {
          if (v !== '' && v !== null && v !== undefined && Number(v) !== 0) n++;
        }
      }
    }
  }
  return n;
}

async function main() {
  const files = fs.readdirSync(DATA_DIR)
    .filter((f) => f.endsWith('.json') && f !== 'index.json')
    .sort()
    .slice(0, LIMIT);
  let changed = 0, unchanged = 0, failed = 0;
  const failures = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const base = file.replace(/\.json$/, '');
    const symbol = base.replace(/_/g, '.'); // BRK_B.json -> BRK.B
    const full = path.join(DATA_DIR, file);
    try {
      const payload = JSON.parse(fs.readFileSync(full, 'utf8'));
      const before = countFilled(payload);
      await secSource.backfillStatements(symbol, payload);
      const filled = countFilled(payload) - before;
      if (filled > 0) {
        if (!DRY) fs.writeFileSync(full, JSON.stringify(payload));
        changed++;
        console.log(`[${i + 1}/${files.length}] ${base.padEnd(7)} +${filled} values filled`);
      } else {
        unchanged++;
      }
    } catch (err) {
      failed++;
      failures.push(`${base}: ${err.message}`);
      console.log(`[${i + 1}/${files.length}] ${base.padEnd(7)} FAILED ${err.message}`);
    } finally {
      await sleep(THROTTLE_MS);
    }
  }

  console.log(`\nDone${DRY ? ' (dry run)' : ''}: ${changed} repaired, ${unchanged} unchanged, ${failed} failed.`);
  failures.slice(0, 30).forEach((f) => console.log('  FAIL', f));
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
