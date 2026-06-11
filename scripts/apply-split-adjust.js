'use strict';

/**
 * One-off: normalize share counts and per-share figures in every cached
 * fundamentals JSON to the current split basis (see backend/split-adjust.js).
 * Safe to re-run — already-normalized values resolve to factor 1.
 *
 * Usage: node scripts/apply-split-adjust.js [--dry] [--limit N]
 */

const fs = require('fs');
const path = require('path');
const YahooFinance = require('yahoo-finance2').default;
const { adjustPayloadForSplits } = require(path.join(__dirname, '..', 'backend', 'split-adjust'));

const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const DATA_DIR = path.join(__dirname, '..', 'frontend', 'data', 'fundamentals');
const DRY = process.argv.includes('--dry');
const limitIdx = process.argv.indexOf('--limit');
const LIMIT = limitIdx > -1 ? Number(process.argv[limitIdx + 1]) : Infinity;
const THROTTLE_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cache files use _ for . (BRK_B.json); Yahoo wants - (BRK-B).
function toYahooSymbol(fileBase) {
  return fileBase.replace(/_/g, '-');
}

async function fetchSplits(yahooSymbol) {
  const r = await yahooFinance.chart(yahooSymbol, {
    period1: '1980-01-01',
    interval: '1mo',
    events: 'split'
  });
  return r?.events?.splits || [];
}

async function main() {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.endsWith('.json')).sort().slice(0, LIMIT);
  let changed = 0, unchanged = 0, noSplits = 0, failed = 0;
  const failures = [];

  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    const base = file.replace(/\.json$/, '');
    const yahooSymbol = toYahooSymbol(base);
    try {
      const splits = await fetchSplits(yahooSymbol);
      if (!splits.length) {
        noSplits++;
        continue;
      }
      const full = path.join(DATA_DIR, file);
      const payload = JSON.parse(fs.readFileSync(full, 'utf8'));
      const res = adjustPayloadForSplits(payload, splits);
      if (res.changed) {
        if (!DRY) fs.writeFileSync(full, JSON.stringify(payload));
        changed++;
        console.log(`[${i + 1}/${files.length}] ${base.padEnd(7)} ADJUSTED shares:${res.shares} eps:${res.eps} (${splits.length} splits)`);
      } else {
        unchanged++;
      }
    } catch (err) {
      failed++;
      failures.push(`${base}: ${err.message}`);
    } finally {
      await sleep(THROTTLE_MS);
    }
  }

  console.log(`\nDone${DRY ? ' (dry run)' : ''}: ${changed} adjusted, ${unchanged} had splits but were clean, ${noSplits} no splits, ${failed} failed.`);
  failures.slice(0, 20).forEach((f) => console.log('  FAIL', f));
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
