#!/usr/bin/env node
'use strict';
// Builds the company page's segment history (backend/sec-segment-history.js) for the issuers named:
// every year and quarter of segment sales, profit and assets the filings tag, one file per issuer in
// backend/data/segment-history/. The compact facts read from each filing are kept in a local cache
// beside it (not committed), so a later run reads only the filings that are new since.
//
//   node scripts/refresh-segment-history.js --symbols JPM,HBAN,AFL [--jobs 4] [--rebuild] [--budget-minutes 90]
//   node scripts/refresh-segment-history.js --ciks-file list.json   (an array of CIKs or {cik} objects)
//
// --rebuild ignores the cache and reads every filing again.
const fs = require('fs');
const path = require('path');
const B = path.join(__dirname, '../backend/');
const p = require(B + 'sec-coverage');
const seg = require(B + 'sec-segment-observations');
const H = require(B + 'sec-segment-history');
const { getJson, parseFilings } = require(B + 'sec-reporting');
const stocks = require(B + 'stock-universe');

const CACHE = path.join(H.DIR, '.cache');
const financialFile = (cik) => path.join(B, '../frontend/data/sec-financials', p.cik(cik) + '.json');

// What the latest 10-K's table already settled: its axis, currency and measure, and how far back the
// statements' quarters go (the quarterly view stops where they do).
function lead(cik) {
  let d; try { d = JSON.parse(fs.readFileSync(financialFile(cik), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
  const pick = seg.preferred(d.segmentObservations || []), g = pick.usable || pick.partial;
  if (!g) return null;
  const sf = g.entries[0].sourceFact;
  const preferConcept = sf.concept.includes('+') ? sf.concept.split('+').map((c) => 'us-gaap:' + c).join('+') : sf.taxonomy + ':' + sf.concept;
  const quarterFrom = (d.income?.quarterlyReports || []).map((r) => r.fiscalDateEnding).filter(Boolean).sort()[0] || null;
  return { axis: g.axis, currency: g.currency, preferConcept, quarterFrom, sic: d.reportingSic, single: seg.shown(g).rows.length === 1 };
}

async function filingsOf(cik) {
  const raw = await getJson(`https://data.sec.gov/submissions/CIK${p.cik(cik)}.json`);
  let list = parseFilings(raw.filings.recent, cik);
  for (const file of raw.filings.files || []) list = list.concat(parseFilings(await getJson('https://data.sec.gov/submissions/' + file.name), cik));
  return list;
}

const PERIODIC = /^(10-K|10-Q|20-F|40-F)(\/A)?$/;
async function refresh(cik, { rebuild = false } = {}) {
  cik = p.cik(cik);
  const L = lead(cik);
  if (!L) return { cik, status: 'no_segment_table' };
  const cacheFile = path.join(CACHE, cik + '.json');
  let have = [];
  if (!rebuild) try { have = JSON.parse(fs.readFileSync(cacheFile, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  const t0 = Date.now(), filings = await filingsOf(cik);
  // A table built by this version, with no report filed since, is already current: one request, whether or not
  // this machine holds the filing cache (the weekly job's cache only covers the issuers it has built there).
  if (!rebuild) {
    let stored = null; try { stored = JSON.parse(fs.readFileSync(path.join(H.DIR, cik + '.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    if (stored?.version === H.VERSION && stored.builtAt && !filings.some((f) => PERIODIC.test(f.form) && f.filingDate >= stored.builtAt.slice(0, 10))) return { cik, status: 'unchanged' };
  }
  const records = await H.collect(cik, filings, { axis: L.axis, quarterFrom: L.quarterFrom, have });
  fs.mkdirSync(CACHE, { recursive: true });
  p.atomicWrite(cacheFile, records);
  const table = H.buildHistory(records, L);
  const read = records.length - have.length, seconds = Math.round((Date.now() - t0) / 1000);
  if (!table.rows.length || !table.years.length) return { cik, status: 'no_history', read, seconds };
  p.atomicWrite(path.join(H.DIR, cik + '.json'), { version: H.VERSION, cik, builtAt: new Date().toISOString(), filingsRead: records.length, table });
  return { cik, status: 'ok', read, seconds, years: table.years.length, first: table.years[0].periodEnd, quarters: table.quarterly.years.length, rows: table.rows.length, profit: table.profitMeasure };
}

function targets(argv) {
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const out = [];
  for (const s of (opt('--symbols') || '').split(',').filter(Boolean)) { const c = stocks.lookup(s); if (c?.cik) out.push(p.cik(c.cik)); else console.error('unknown symbol', s); }
  if (opt('--ciks-file')) for (const x of JSON.parse(fs.readFileSync(opt('--ciks-file'), 'utf8'))) out.push(p.cik(x.cik || x));
  return [...new Set(out)];
}

async function main(argv = process.argv.slice(2)) {
  const ciks = targets(argv), jobs = Math.max(1, Number(argv[argv.indexOf('--jobs') + 1]) || 1), rebuild = argv.includes('--rebuild');
  // --budget-minutes N: no issuer is started after N minutes, so a cold run (no filing cache: ~14 s an issuer)
  // ends inside the weekly job. Issuers with a cache go first; the rest keep their stored table until a later run.
  const budget = argv.includes('--budget-minutes') ? Number(argv[argv.indexOf('--budget-minutes') + 1]) * 60000 : Infinity, started = Date.now();
  const cached = (cik) => fs.existsSync(path.join(CACHE, cik + '.json'));
  ciks.sort((a, b) => cached(b) - cached(a));
  if (!ciks.length) { console.error('usage: --symbols A,B | --ciks-file list.json [--jobs N] [--rebuild]'); process.exit(2); }
  fs.mkdirSync(H.DIR, { recursive: true });
  let results = [];
  // Requests to SEC are paced in one place (sec-throttle), so workers here only overlap the waiting.
  const pass = async (list) => {
    const queue = list.slice(), out = [];
    await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      for (let cik; (cik = queue.shift());) {
        if (Date.now() - started > budget) { out.push({ cik, status: 'deferred' }); continue; }
        let r; try { r = await refresh(cik, { rebuild }); } catch (e) { r = { cik, status: 'failed', transient: e.response ? e.response.status >= 500 || e.response.status === 429 : !/maxContentLength/.test(e.message), error: String(e.message || e).slice(0, 200) }; }
        out.push(r); console.log(JSON.stringify(r));
      }
    }));
    return out;
  };
  results = await pass(ciks);
  // SEC answers 503 for minutes at a time (11-06: 38 issuers in a row); the per-request retries span
  // seconds, so issuers that failed that way are tried again after a pause.
  for (const waitS of [120, 600]) {
    const again = results.filter((r) => r.status === 'failed' && r.transient).map((r) => r.cik);
    if (!again.length) break;
    console.error(`retrying ${again.length} after ${waitS}s`);
    await new Promise((r) => setTimeout(r, waitS * 1000));
    const redo = new Map((await pass(again)).map((r) => [r.cik, r]));
    results = results.map((r) => redo.get(r.cik) || r);
  }
  const by = (s) => results.filter((r) => r.status === s).length;
  console.log(JSON.stringify({ issuers: results.length, ok: by('ok'), unchanged: by('unchanged'), deferred: by('deferred'), noTable: by('no_segment_table'), noHistory: by('no_history'), failed: by('failed') }));
  if (by('failed')) process.exitCode = 1;
}

if (require.main === module) main().catch((e) => { console.error(e.stack || e); process.exit(1); });
module.exports = { refresh, lead, main };
