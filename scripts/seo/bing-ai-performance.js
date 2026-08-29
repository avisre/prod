#!/usr/bin/env node
/* Ingests a Bing Webmaster Tools "AI Performance" export and rolls it up by
 * page family.
 *
 * This data is UI-export only -- it is not on the Webmaster API -- so the CSV
 * must be downloaded by hand from Bing Webmaster Tools > AI Performance and
 * passed with --input. Nothing here infers citations from ordinary Bing clicks;
 * that rule is set in docs/seo/bing-ai-performance.md and is kept deliberately:
 * a click is not a citation, and treating one as the other would make the whole
 * table worthless.
 *
 *   node scripts/seo/bing-ai-performance.js --input=~/Downloads/ai-performance.csv
 */
const path = require('path');
const fs = require('fs');
const { ROOT, readCsv, num, writeText, routeFromUrl } = require('./lib');

const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [k, ...v] = arg.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
const input = args.input && args.input !== true ? path.resolve(String(args.input).replace(/^~/, process.env.HOME || '~')) : null;
const outCsv = path.resolve(args.out || path.join(ROOT, 'docs/seo/bing-ai-performance.csv'));
const outMd = path.resolve(args.md || path.join(ROOT, 'docs/seo/bing-ai-performance.md'));
const FIELDS = ['cited_url', 'citation_count', 'grounding_query', 'ticker', 'metric', 'page_family'];

// Bing has renamed these columns before; accept the known spellings rather than
// failing on a header change.
const URL_KEYS = ['cited_url', 'Cited URL', 'URL', 'Url', 'Page', 'Cited page'];
const COUNT_KEYS = ['citation_count', 'Citations', 'Citation count', 'Count', 'Clicks', 'Impressions'];
const QUERY_KEYS = ['grounding_query', 'Grounding query', 'Query', 'Search query'];

function pick(row, keys) {
  for (const key of keys) if (row[key] !== undefined && row[key] !== '') return row[key];
  return '';
}
function family(route) {
  const p = routeFromUrl(route);
  const m = p.match(/^\/stocks\/[^/]+\/([^/]+)/i);
  if (m) return m[1].toLowerCase();
  if (/^\/compare\//.test(p)) return 'comparison';
  if (/^\/vs\//.test(p)) return 'vendor-comparison';
  if (/^\/screens\//.test(p)) return 'screen';
  if (/^\/research\//.test(p)) return 'research';
  if (/^\/stocks\/[^/]+$/i.test(p)) return 'company';
  return 'other';
}
function tickerOf(route) {
  const m = routeFromUrl(route).match(/^\/stocks\/([^/]+)/i);
  return m ? m[1].toUpperCase() : '';
}
function metricOf(route) {
  const m = routeFromUrl(route).match(/^\/stocks\/[^/]+\/([^/]+)/i);
  return m ? m[1].toLowerCase() : '';
}
const quote = (v) => `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;

function writeEmpty(reason) {
  fs.mkdirSync(path.dirname(outCsv), { recursive: true });
  fs.writeFileSync(outCsv, `${FIELDS.join(',')}\n`);
  writeText(outMd, [
    '# Bing/Copilot citation performance', '',
    `Generated: **${new Date().toISOString()}**`, '',
    reason, '',
    'The CSV is intentionally header-only. No citation, query, ticker or metric is',
    'inferred from ordinary Bing clicks. Populate it only from an authenticated',
    'export, then rerun:', '',
    '```', 'node scripts/seo/bing-ai-performance.js --input=<export.csv>', '```', ''
  ].join('\n'));
  console.log(JSON.stringify({ rows: 0, output: outCsv, note: reason }, null, 2));
}

if (!input) {
  writeEmpty('No `--input` export was supplied, so there is nothing to report. Download it from Bing Webmaster Tools > AI Performance (it is not available on the API).');
  return;
}
if (!fs.existsSync(input)) {
  writeEmpty(`The export \`${input}\` does not exist, so there is nothing to report.`);
  return;
}

const raw = readCsv(input);

/* Bing exports two different AI Performance shapes. The overview is a daily
 * time series (Date, Citations, Cited Pages) with no URLs in it; the detail
 * export is per-URL. Detect which one we were handed rather than failing. */
const isOverview = raw.length && raw[0].Citations !== undefined
  && URL_KEYS.every((k) => raw[0][k] === undefined);
if (isOverview) {
  // Build the date in UTC. `new Date('6/13/2026')` is parsed as LOCAL midnight,
  // which toISOString() then rolls back a day for anyone east of UTC.
  const parseDate = (value) => {
    const m = String(value || '').split(' ')[0].match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (m) return new Date(Date.UTC(+m[3], +m[1] - 1, +m[2]));
    const iso = String(value || '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(iso) ? new Date(`${iso}T00:00:00Z`) : new Date(NaN);
  };
  const series = raw.map((r) => ({
    date: parseDate(r.Date),
    citations: num(r.Citations),
    pages: num(r['Cited Pages'] || r.CitedPages)
  })).filter((r) => !Number.isNaN(r.date.getTime())).sort((a, b) => a.date - b.date);
  const iso = (d) => d.toISOString().slice(0, 10);
  const total = series.reduce((n, r) => n + r.citations, 0);
  // Monday-start weeks; the trailing week is usually partial.
  const weeks = new Map();
  for (const r of series) {
    const k = new Date(r.date); k.setUTCDate(k.getUTCDate() - ((k.getUTCDay() + 6) % 7));
    const e = weeks.get(iso(k)) || { citations: 0, peakPages: 0, days: 0 };
    e.citations += r.citations; e.peakPages = Math.max(e.peakPages, r.pages); e.days += 1;
    weeks.set(iso(k), e);
  }
  // Contiguous zero-citation runs: a multi-day gap is a signal, not noise.
  const gaps = []; let start = null, prev = null;
  for (const r of series) {
    if (r.citations === 0) { if (!start) start = r.date; prev = r.date; }
    else if (start) { gaps.push([start, prev]); start = null; }
  }
  if (start) gaps.push([start, prev]);
  const longGaps = gaps.filter(([a, b]) => (b - a) / 86400000 + 1 >= 3);
  const weekRows = [...weeks.entries()].sort();

  writeText(outMd, [
    '# Bing/Copilot citation performance', '',
    `Generated: **${new Date().toISOString()}**`,
    `Source export: \`${path.basename(input)}\` (overview series, ${series.length} days).`,
    `Range: **${iso(series[0].date)}** to **${iso(series[series.length - 1].date)}**.`, '',
    `**${total} citations** over the period.`, '',
    '> This is the overview export: daily totals with no URLs in it. Which pages',
    '> were cited needs the per-URL AI Performance export; rerun this script with',
    '> that file to get the page-family breakdown and populate the CSV.', '',
    '## By week', '', '| Week of | Citations | Peak cited pages | Days |', '|---|---:|---:|---:|',
    ...weekRows.map(([k, e]) => `| ${k} | ${e.citations} | ${e.peakPages} | ${e.days}${e.days < 7 ? ' (partial)' : ''} |`),
    '', ...(longGaps.length ? [
      '## Zero-citation gaps (3+ days)', '', '| From | To | Days |', '|---|---|---:|',
      ...longGaps.map(([a, b]) => `| ${iso(a)} | ${iso(b)} | ${(b - a) / 86400000 + 1} |`), ''
    ] : []),
    'Figures come straight from the supplied export. Nothing is inferred from',
    'ordinary Bing clicks.', ''
  ].join('\n'));

  console.log(JSON.stringify({
    shape: 'overview', input, days: series.length, citations: total,
    weeks: weekRows.length, gaps: longGaps.length, summary: outMd,
    note: 'per-URL export still needed to populate bing-ai-performance.csv'
  }, null, 2));
  return;
}

const rows = raw.map((row) => {
  const url = pick(row, URL_KEYS);
  if (!url) return null;
  const route = routeFromUrl(url);
  return {
    cited_url: route,
    citation_count: num(pick(row, COUNT_KEYS)),
    grounding_query: pick(row, QUERY_KEYS),
    ticker: tickerOf(route),
    metric: metricOf(route),
    page_family: family(route)
  };
}).filter(Boolean).sort((a, b) => b.citation_count - a.citation_count);

if (!rows.length) {
  writeEmpty(`The export \`${path.basename(input)}\` had ${raw.length} rows but no recognisable URL column. Expected one of: ${URL_KEYS.join(', ')}.`);
  return;
}

fs.mkdirSync(path.dirname(outCsv), { recursive: true });
fs.writeFileSync(outCsv, `${FIELDS.join(',')}\n${rows.map((r) => FIELDS.map((f) => quote(r[f])).join(',')).join('\n')}\n`);

const byFamily = rows.reduce((acc, r) => {
  const e = acc[r.page_family] = acc[r.page_family] || { pages: new Set(), citations: 0, queries: new Set() };
  e.pages.add(r.cited_url); e.citations += r.citation_count;
  if (r.grounding_query) e.queries.add(r.grounding_query);
  return acc;
}, {});
const families = Object.entries(byFamily).sort((a, b) => b[1].citations - a[1].citations);
const totalCitations = rows.reduce((n, r) => n + r.citation_count, 0);

writeText(outMd, [
  '# Bing/Copilot citation performance', '',
  `Generated: **${new Date().toISOString()}**`,
  `Source export: \`${path.basename(input)}\` (${raw.length} rows in, ${rows.length} usable).`, '',
  `**${totalCitations} citations** across **${new Set(rows.map((r) => r.cited_url)).size} pages** and`,
  `**${new Set(rows.map((r) => r.grounding_query).filter(Boolean)).size} grounding queries**.`, '',
  '## By page family', '',
  '| Family | Pages cited | Citations | Grounding queries |', '|---|---:|---:|---:|',
  ...families.map(([name, e]) => `| ${name} | ${e.pages.size} | ${e.citations} | ${e.queries.size} |`),
  '', '## Most cited pages', '',
  '| Page | Family | Citations | Example grounding query |', '|---|---|---:|---|',
  ...rows.slice(0, 25).map((r) => `| \`${r.cited_url}\` | ${r.page_family} | ${r.citation_count} | ${r.grounding_query || '—'} |`),
  '', 'Every row comes from the supplied authenticated export. Nothing is inferred',
  'from ordinary Bing clicks.', ''
].join('\n'));

console.log(JSON.stringify({
  input, rowsIn: raw.length, rows: rows.length, citations: totalCitations,
  families: families.length, output: outCsv, summary: outMd
}, null, 2));
