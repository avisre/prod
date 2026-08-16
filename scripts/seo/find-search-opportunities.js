#!/usr/bin/env node
/* Position/CTR opportunity scoring for Google and Bing exports. This is an
 * observational prioritiser, not a ranking forecast. */
const fs = require('fs');
const path = require('path');
const { ROOT, readCsv, num, routeFromUrl, writeText } = require('./lib');
const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [k, ...v] = arg.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
const googleInput = path.resolve(args.google || path.join(ROOT, 'seo-data/gsc/pages-3m.csv'));
const bingInput = args.bing && args.bing !== true ? path.resolve(args.bing) : path.join(ROOT, 'seo-data/bing/pages.csv');
const googleOut = path.resolve(args.googleOut || path.join(ROOT, 'docs/seo/google-opportunities.csv'));
const bingOut = path.resolve(args.bingOut || path.join(ROOT, 'docs/seo/bing-opportunities.csv'));
const buckets = (position) => { const p = num(position), e = 1e-9; if (p <= 3 + e) return '1-3'; if (p <= 5 + e) return '4-5'; if (p <= 10 + e) return '6-10'; if (p <= 15 + e) return '11-15'; if (p <= 20 + e) return '16-20'; if (p <= 50 + e) return '21-50'; return '51+'; };
const expectedCtr = (position) => { const p = num(position), e = 1e-9; if (p <= 1.5 + e) return .28; if (p <= 3 + e) return .12; if (p <= 5 + e) return .07; if (p <= 10 + e) return .035; if (p <= 20 + e) return .012; return .003; };
function family(route) { const p = routeFromUrl(route); const m = p.match(/^\/stocks\/[^/]+\/([^/]+)/i); if (m) return m[1].toLowerCase(); if (/^\/compare\//.test(p)) return 'comparison'; if (/^\/screens\//.test(p)) return 'screen'; return 'other'; }
function score(row) {
  const p = num(row.position); const imp = num(row.impressions); const ctr = num(row.ctr); const gap = Math.max(expectedCtr(p) - ctr, 0);
  const weight = p >= 4 && p <= 10 ? 1 : p <= 20 ? .6 : p <= 50 ? .25 : .05;
  const confidence = family(row.page) !== 'other' ? 1 : .75;
  return imp * weight * gap * confidence;
}
function transform(rows, engine) { return rows.map((row) => { const page = row.page || row.url || row.loc || ''; const out = { engine, page: routeFromUrl(page), page_family: family(page), impressions: num(row.impressions), clicks: num(row.clicks), ctr: num(row.ctr), position: num(row.position), position_bucket: buckets(row.position), expected_ctr: expectedCtr(row.position), ctr_gap: Math.max(expectedCtr(row.position) - num(row.ctr), 0), ownership_confidence: family(page) !== 'other' ? 'high' : 'medium' }; out.opportunity_score = score({ ...row, page }); out.priority = out.position >= 4 && out.position <= 10 && out.impressions > 0 && out.ctr_gap > 0 ? 'P0_POSITION_4_10_LOW_CTR' : out.impressions > 0 && out.ctr_gap > 0 ? 'P1_REVIEW' : 'MONITOR'; return out; }).sort((a, b) => b.opportunity_score - a.opportunity_score); }
const fields = ['engine', 'page', 'page_family', 'impressions', 'clicks', 'ctr', 'position', 'position_bucket', 'expected_ctr', 'ctr_gap', 'ownership_confidence', 'opportunity_score', 'priority'];
const quote = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
function writeCsv(file, rows) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, `${fields.join(',')}\n${rows.map((r) => fields.map((f) => quote(r[f])).join(',')).join('\n')}\n`); }
const google = transform(readCsv(googleInput), 'google'); const bing = transform(readCsv(bingInput), 'bing'); writeCsv(googleOut, google); writeCsv(bingOut, bing);
const summary = path.join(ROOT, 'docs/seo/search-opportunities.md');
function table(rows) { return rows.slice(0, 20).map((r) => `| \`${r.page}\` | ${r.page_family} | ${r.impressions.toFixed(0)} | ${r.clicks.toFixed(0)} | ${(r.ctr * 100).toFixed(2)}% | ${r.position.toFixed(2)} | ${r.position_bucket} | ${r.priority} |`).join('\n') || '| — | — | — | — | — | — | — | No export rows |'; }
writeText(summary, [
  '# Search opportunity report', '', `Generated: **${new Date().toISOString()}**`, '',
  `- Google input: \`${googleInput}\` (${google.length} rows).`, `- Bing input: ${fs.existsSync(bingInput) ? `\`${bingInput}\` (${bing.length} rows)` : '**not available**; no Bing opportunity is inferred.'}`, '',
  '> Score = impressions × position weight × expected CTR gap × conservative page-family confidence. It prioritises positions 4–10 with high impressions and low CTR; it is not a forecast.', '',
  '## Google top opportunities', '', '| Page | Family | Imp. | Clicks | CTR | Position | Bucket | Priority |', '|---|---|---:|---:|---:|---:|---|---|', table(google), '',
  '## Bing top opportunities', '', '| Page | Family | Imp. | Clicks | CTR | Position | Bucket | Priority |', '|---|---|---:|---:|---:|---:|---|---|', table(bing), '',
  'Machine-readable files:', `- \`${googleOut}\``, `- \`${bingOut}\``, '',
  'Missing exports are data gaps. AAP free-cash-flow is expected to rank highly only when the supplied Bing page export contains its observed 425-impression row; no row is fabricated here.', ''
].join('\n'));
console.log(JSON.stringify({ google: { input: googleInput, rows: google.length, output: googleOut }, bing: { input: bingInput, available: fs.existsSync(bingInput), rows: bing.length, output: bingOut }, summary }, null, 2));
