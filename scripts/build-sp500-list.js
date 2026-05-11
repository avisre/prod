#!/usr/bin/env node
/**
 * build-sp500-list.js
 *
 * Fetches the current S&P 500 component list from a publicly maintained
 * CSV and writes it to frontend/data/sp500-companies.json in the same
 * shape as top-100-companies.json so refresh-fundamentals.js can consume
 * it without changes.
 *
 * Default source: github.com/datasets/s-and-p-500-companies (public-domain
 * dataset, regularly updated). Override with SP500_LIST_URL env var if you
 * prefer a different source.
 *
 * Usage:
 *   node scripts/build-sp500-list.js
 *   SP500_LIST_URL=https://example.com/list.csv node scripts/build-sp500-list.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'frontend', 'data', 'sp500-companies.json');
const DEFAULT_URL = 'https://raw.githubusercontent.com/datasets/s-and-p-500-companies/master/data/constituents.csv';
const SOURCE_URL = process.env.SP500_LIST_URL || DEFAULT_URL;

function parseCsv(text) {
  // Light-weight CSV parser; tolerates quoted fields with commas inside.
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else { field += c; }
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (field.length || row.length) { row.push(field); rows.push(row); }
        row = []; field = '';
        if (c === '\r' && text[i + 1] === '\n') i++;
      } else { field += c; }
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

async function main() {
  console.log(`Fetching list from ${SOURCE_URL}`);
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    console.error(`HTTP ${res.status} from ${SOURCE_URL}`);
    process.exit(1);
  }
  const text = await res.text();
  const rows = parseCsv(text);
  if (rows.length < 2) {
    console.error('CSV had no data rows');
    process.exit(1);
  }

  // Detect header columns. The dataset typically has columns:
  //   Symbol, Name (or Security), Sector / GICS Sector
  const header = rows[0].map((h) => h.toLowerCase().trim());
  const symbolIdx = header.findIndex((h) => h === 'symbol' || h === 'ticker');
  const nameIdx = header.findIndex((h) => h === 'name' || h === 'security');
  const sectorIdx = header.findIndex((h) => h === 'sector' || h === 'gics sector' || h === 'gics_sector');
  if (symbolIdx < 0 || nameIdx < 0) {
    console.error('Expected "Symbol" and "Name"/"Security" columns. Got:', header);
    process.exit(1);
  }

  const items = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r[symbolIdx]) continue;
    const symbol = r[symbolIdx].trim().toUpperCase();
    if (!/^[A-Z][A-Z0-9.\-]*$/.test(symbol)) continue;
    items.push({
      symbol,
      name: (r[nameIdx] || '').trim(),
      sector: sectorIdx >= 0 ? (r[sectorIdx] || '').trim() : ''
    });
  }

  // De-dupe by symbol (keep first occurrence)
  const seen = new Set();
  const deduped = items.filter((it) => {
    if (seen.has(it.symbol)) return false;
    seen.add(it.symbol);
    return true;
  });

  fs.writeFileSync(OUT_FILE, JSON.stringify(deduped, null, 2));
  console.log(`Wrote ${deduped.length} symbols to ${path.relative(ROOT, OUT_FILE)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
