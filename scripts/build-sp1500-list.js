#!/usr/bin/env node
/**
 * build-sp1500-list.js
 *
 * Builds the S&P 1500 universe (S&P 500 + MidCap 400 + SmallCap 600) from the
 * Wikipedia constituent tables and writes frontend/data/sp1500-companies.json
 * in the same {symbol,name,sector} shape as sp500-companies.json so
 * refresh-fundamentals.js can consume it unchanged.
 *
 * Usage: node scripts/build-sp1500-list.js
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'frontend', 'data', 'sp1500-companies.json');

const SOURCES = [
  { index: 'sp500', url: 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies' },
  { index: 'sp400', url: 'https://en.wikipedia.org/wiki/List_of_S%26P_400_companies' },
  { index: 'sp600', url: 'https://en.wikipedia.org/wiki/List_of_S%26P_600_companies' }
];

function stripTags(html) {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, ' ')
    .trim();
}

// All three pages carry their constituent table as id="constituents" with
// Symbol | Security | GICS Sector as the first three columns.
function parseConstituents(html) {
  const tableMatch = html.match(/<table[^>]*id="constituents"[\s\S]*?<\/table>/);
  if (!tableMatch) throw new Error('constituents table not found');
  const rows = tableMatch[0].match(/<tr[\s\S]*?<\/tr>/g) || [];
  const out = [];
  for (const row of rows) {
    const cells = (row.match(/<td[\s\S]*?<\/td>/g) || []).map(stripTags);
    if (cells.length < 3) continue; // header row
    const symbol = cells[0].toUpperCase();
    if (!/^[A-Z][A-Z0-9.\-]{0,6}$/.test(symbol)) continue;
    out.push({ symbol, name: cells[1], sector: cells[2] });
  }
  return out;
}

async function main() {
  const bySymbol = new Map();
  for (const src of SOURCES) {
    const res = await fetch(src.url, { headers: { 'user-agent': 'stockportfolio.pro data builder (contact: support@stockportfolio.pro)' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${src.url}`);
    const companies = parseConstituents(await res.text());
    if (companies.length < 300) throw new Error(`${src.index}: only ${companies.length} rows parsed — page layout changed?`);
    companies.forEach((c) => {
      if (!bySymbol.has(c.symbol)) bySymbol.set(c.symbol, { ...c, index: src.index });
    });
    console.log(`${src.index}: ${companies.length} constituents`);
  }
  const companies = [...bySymbol.values()].sort((a, b) => a.symbol.localeCompare(b.symbol));
  fs.writeFileSync(OUT_FILE, JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'wikipedia constituent tables (S&P 500/400/600)',
    count: companies.length,
    companies
  }, null, 2));
  console.log(`Wrote ${companies.length} companies to ${OUT_FILE}`);
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });
