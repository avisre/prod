'use strict';
// Build frontend/data/sec-shares.json: the latest cover-page share count for
// each covered ticker, straight from SEC XBRL (dei:EntityCommonStockSharesOutstanding).
//
// Why: a quote's market cap is only as good as its share count, and Yahoo's
// share count (and sometimes its marketCap, which contradicts its own share
// count) goes stale. Price is reliable; the share count needs the filing.
//
// Multi-class filers report one fact per class. This script takes the value(s)
// at the latest period end and only records a symbol when it can resolve a
// single unambiguous total; otherwise it omits the symbol, and callers fall
// back to the quote's own figures.
//
// Usage: node scripts/refresh-shares.js [--limit N]

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const LIST_FILE = path.join(ROOT, 'frontend', 'data', 'sp1500-companies.json');
const OUT_FILE = path.join(ROOT, 'frontend', 'data', 'sec-shares.json');
const SEC_UA = process.env.SEC_UA || 'stockportfolio.pro/1.0 (contact: support@stockportfolio.pro)';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchJson(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url, { headers: { 'User-Agent': SEC_UA, Accept: 'application/json' } });
      if (r.status === 200) return await r.json();
      if (r.status === 404) return null;
      await sleep(800 * (i + 1));
    } catch (_) { await sleep(800 * (i + 1)); }
  }
  return null;
}

async function cikMap() {
  const j = await fetchJson('https://www.sec.gov/files/company_tickers.json');
  const map = {};
  for (const v of Object.values(j || {})) map[String(v.ticker).toUpperCase().replace(/[.\-]/g, '')] = v.cik_str;
  return map;
}

// Latest cover-page count for a symbol, or null if absent / multi-class.
async function sharesFor(cik) {
  const url = `https://data.sec.gov/api/xbrl/companyconcept/CIK${String(cik).padStart(10, '0')}/dei/EntityCommonStockSharesOutstanding.json`;
  const j = await fetchJson(url);
  if (!j || !j.units) return null;
  const arr = j.units.shares || j.units.USD || Object.values(j.units)[0] || [];
  if (!arr.length) return null;
  const latestEnd = arr.reduce((a, b) => (!a || b.end > a) ? b.end : a, null);
  const atEnd = arr.filter((x) => x.end === latestEnd).map((x) => Number(x.val)).filter((v) => v > 0);
  const distinct = [...new Set(atEnd)];
  // More than one distinct value at the same period end = multiple share classes.
  if (distinct.length !== 1) return null;
  return { shares: distinct[0], asOf: latestEnd };
}

async function main() {
  const limitArg = process.argv.indexOf('--limit');
  const limit = limitArg > -1 ? Number(process.argv[limitArg + 1]) : 0;
  const list = JSON.parse(fs.readFileSync(LIST_FILE, 'utf8')).companies.map((c) => c.symbol);
  const symbols = limit ? list.slice(0, limit) : list;
  const ciks = await cikMap();
  console.log(`symbols: ${symbols.length} | ciks: ${Object.keys(ciks).length}`);

  const out = {};
  let done = 0, resolved = 0, omitted = 0;
  const CONC = 4;
  let idx = 0;
  async function worker() {
    while (idx < symbols.length) {
      const sym = symbols[idx++];
      const cik = ciks[String(sym).toUpperCase().replace(/[.\-]/g, '')];
      if (cik) {
        const s = await sharesFor(cik);
        if (s) { out[sym] = s; resolved++; } else omitted++;
      } else omitted++;
      done++;
      if (done % 100 === 0) console.log(`  ${done}/${symbols.length} resolved=${resolved}`);
      await sleep(120);
    }
  }
  await Promise.all(Array.from({ length: CONC }, worker));

  const payload = { generatedAt: new Date().toISOString(), source: 'SEC XBRL dei:EntityCommonStockSharesOutstanding', count: Object.keys(out).length, shares: out };
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload));
  console.log(`wrote ${OUT_FILE}: ${Object.keys(out).length} resolved, ${omitted} omitted`);
}

main().catch((e) => { console.error(e); process.exit(1); });
