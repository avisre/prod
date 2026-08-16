#!/usr/bin/env node
/* Conservative query→metric ownership audit. Ambiguous wording is never used
 * to justify a redirect or template rewrite. */
const path = require('path');
const { ROOT, readCsv, num, writeText } = require('./lib');

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, '').split('='); return [key, rest.join('=') || true];
}));
const input = path.resolve(args.input || path.join(ROOT, 'seo-data/gsc/query-page-3m.csv'));
const bingInput = args.bing && args.bing !== true ? path.resolve(args.bing) : path.join(ROOT, 'seo-data/bing/query-page.csv');
const outCsv = path.resolve(args.csv || path.join(ROOT, 'docs/seo/query-page-ownership.csv'));
const outMd = path.resolve(args.md || path.join(ROOT, 'docs/seo/query-page-ownership.md'));
const sourceRows = readCsv(input).map((row) => ({ ...row, _source: 'google' }));
const bingRows = require('fs').existsSync(bingInput) ? readCsv(bingInput).map((row) => ({ ...row, _source: 'bing' })) : [];
const rows = [...sourceRows, ...bingRows];

const patterns = {
  EPS: [/\bearnings\s+per\s+share\b/i, /\b(?:diluted|basic)\s+EPS\b/i, /(?<![A-Za-z0-9])EPS(?![A-Za-z0-9])/i],
  SHARES: [/\bshares?\s+outstanding\b/i, /\boutstanding\s+shares?\b/i, /\bshare\s+count\b/i],
  REVENUE: [/\brevenue\b/i, /\brevenue\s+history\b/i, /\brevenue\s+growth\b/i],
  FCF: [/\bfree\s+cash\s+flow\b/i, /(?<![A-Za-z0-9])FCF(?![A-Za-z0-9])/i],
  OPERATING_CASH_FLOW: [/\boperating\s+cash\s+flow\b/i],
  CAPEX: [/\bcapital\s+expenditures?\b/i, /\bcapex\b/i],
  DEBT: [/\btotal\s+debt\b/i, /\bnet\s+debt\b/i, /\bdebt\s+history\b/i],
  CASH: [/\bcash\s+and\s+cash\s+equivalents\b/i, /\bcash\s+equivalents\b/i, /\bcash\s+balance\b/i, /(?<![A-Za-z0-9])cash(?!\s+flow\b)(?![A-Za-z0-9])/i],
  DIVIDEND: [/\bdividend\s+history\b/i, /\bdividend\s+per\s+share\b/i, /\bdividend(?:s)?\s+paid\b/i, /\bdividend\b/i],
  NET_INCOME: [/\bnet\s+income\b/i, /\bnet\s+profit\b/i],
  CASH: [/\bcash\s+and\s+equivalents\b/i, /\bcash\s+balance\b/i],
};
const slugs = { EPS: 'eps', SHARES: 'shares-outstanding', REVENUE: 'revenue', FCF: 'free-cash-flow', OPERATING_CASH_FLOW: 'operating-cash-flow', CAPEX: 'capital-expenditures', DEBT: 'total-debt', DIVIDEND: 'dividend-history', NET_INCOME: 'net-income', CASH: 'cash' };
const metricSlugs = new Set(['revenue', 'net-income', 'gross-profit', 'eps', 'ebitda', 'free-cash-flow', 'total-debt', 'shares-outstanding', 'dividend-history', 'pe-ratio']);

function classify(query) {
  const text = String(query || '').trim();
  if (!text || /\b(?:net\s+)?profit\s+margin\b|\bdividend\s+yield\b/i.test(text)) return 'AMBIGUOUS_QUERY';
  const matches = Object.entries(patterns).filter(([, list]) => list.some((re) => re.test(text))).map(([key]) => key);
  // Generic terms intentionally match nothing. Conflicting high-confidence
  // phrases (e.g. “diluted EPS shares outstanding”) are ambiguous.
  return matches.length === 1 ? matches[0] : 'AMBIGUOUS_QUERY';
}
function route(page) {
  const m = String(page || '').match(/\/stocks\/([^/?#]+)\/([^/?#]+)/i);
  if (!m || !metricSlugs.has(m[2].toLowerCase())) return null;
  return { ticker: m[1].toUpperCase(), slug: m[2].toLowerCase(), url: `/stocks/${m[1].toUpperCase()}/${m[2].toLowerCase()}` };
}
function csvQuote(v) { return `"${String(v == null ? '' : v).replace(/"/g, '""')}"`; }
function pct(v) { return `${(num(v) * 100).toFixed(2)}%`; }

const groups = new Map();
for (const row of rows) {
  const query = String(row.query || '').trim();
  const r = route(row.page);
  const key = `${row._source}:${query.toLowerCase()}`;
  if (!groups.has(key)) groups.set(key, { query, rows: [] });
  groups.get(key).rows.push({ ...row, route: r });
}
const result = [];
for (const group of groups.values()) {
  const intent = classify(group.query);
  const metricRows = group.rows.filter((r) => r.route);
  const tickers = [...new Set(metricRows.map((r) => r.route.ticker))];
  const expectedSlug = slugs[intent] || '';
  const relevant = metricRows.filter((r) => !tickers.length || r.route.ticker === tickers[0]);
  const totals = relevant.reduce((acc, r) => { acc.impressions += num(r.impressions); acc.clicks += num(r.clicks); acc.weighted += num(r.position) * num(r.impressions); return acc; }, { impressions: 0, clicks: 0, weighted: 0 });
  const byRoute = new Map();
  relevant.forEach((r) => { const item = byRoute.get(r.route.url) || { impressions: 0, clicks: 0, weighted: 0 }; item.impressions += num(r.impressions); item.clicks += num(r.clicks); item.weighted += num(r.position) * num(r.impressions); byRoute.set(r.route.url, item); });
  const ordered = [...byRoute.entries()].sort((a, b) => b[1].impressions - a[1].impressions || a[0].localeCompare(b[0]));
  const dominant = ordered[0] || ['', { impressions: 0, clicks: 0, weighted: 0 }];
  const expectedUrl = tickers.length === 1 && expectedSlug ? `/stocks/${tickers[0]}/${expectedSlug}` : '';
  const intended = expectedUrl ? (byRoute.get(expectedUrl)?.impressions || 0) : 0;
  const wrong = Math.max(0, totals.impressions - intended);
  let status = 'UNKNOWN';
  if (intent === 'AMBIGUOUS_QUERY') status = 'AMBIGUOUS';
  else if (!metricRows.length || !expectedUrl) status = 'UNKNOWN';
  else status = dominant[0] === expectedUrl ? 'CORRECT' : 'WRONG_METRIC';
  result.push({ source: [...new Set(group.rows.map((r) => r._source))].join('|'), query: group.query, ticker: tickers.length === 1 ? tickers[0] : tickers.join('|'), intent, expected_url: expectedUrl, ranking_url: dominant[0], impressions: totals.impressions, clicks: totals.clicks, ctr: totals.impressions ? totals.clicks / totals.impressions : 0, position: totals.impressions ? totals.weighted / totals.impressions : 0, status, intended_route_impressions: intended, wrong_route_impressions: wrong, total_metric_route_impressions: totals.impressions, intended_ownership_rate: totals.impressions ? intended / totals.impressions : 0, competing_route_count: Math.max(0, byRoute.size - 1), dominant_route: dominant[0], dominant_route_impressions: dominant[1].impressions, dominant_route_is_correct: expectedUrl && dominant[0] === expectedUrl ? 'yes' : 'no', route_breakdown: ordered.map(([url, v]) => `${url}=${v.impressions}`).join('; ') });
}
result.sort((a, b) => (a.status === 'WRONG_METRIC' ? -1 : 0) - (b.status === 'WRONG_METRIC' ? -1 : 0) || b.impressions - a.impressions);
result.forEach((row) => { row.query_class = row.intent; row.expected_page_family = row.intent === 'AMBIGUOUS_QUERY' ? 'AMBIGUOUS' : (row.intent || 'UNKNOWN'); row.ownership_status = row.status; });
const fields = ['source', 'ticker', 'query', 'query_class', 'expected_page_family', 'expected_url', 'ranking_url', 'impressions', 'clicks', 'ctr', 'position', 'ownership_status', 'status', 'intended_route_impressions', 'wrong_route_impressions', 'total_metric_route_impressions', 'intended_ownership_rate', 'competing_route_count', 'dominant_route', 'dominant_route_impressions', 'dominant_route_is_correct', 'route_breakdown'];
require('fs').mkdirSync(path.dirname(outCsv), { recursive: true });
require('fs').writeFileSync(outCsv, `${fields.join(',')}\n${result.map((r) => fields.map((f) => csvQuote(r[f])).join(',')).join('\n')}\n`);
// Keep the earlier control-plane filename as a compatibility alias; both
// files contain the same evidence and neither is a source of redirects.
if (!args.csv) {
  const aliasCsv = path.join(ROOT, 'docs/seo/query-ownership.csv');
  require('fs').writeFileSync(aliasCsv, require('fs').readFileSync(outCsv));
}

const counts = result.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {});
const md = [
  '# Conservative query ownership audit', '',
  `Generated: **${new Date().toISOString()}**`,
  `Inputs: Google \`${input}\` (${sourceRows.length} rows); Bing ${require('fs').existsSync(bingInput) ? `\`${bingInput}\` (${bingRows.length} rows)` : '**not available**'}; ${rows.length} combined query/page rows; ${result.length} unique query groups.`, '',
  '> Statuses are diagnostic only: `CORRECT` means the observed dominant metric route matches a single high-confidence phrase; `WRONG_METRIC` means it does not; `AMBIGUOUS` never justifies a rewrite; `UNKNOWN` has no reliable metric route. Generic terms such as earnings, profit, sales, dilution, buyback and valuation remain ambiguous.', '',
  '## Status counts', '',
  ...Object.entries(counts).map(([key, value]) => `- **${key}:** ${value}`), '',
  '## Explicit ownership rows', '',
  '| Query | Ticker | Intent | Expected | Dominant | Status | Intended / total | Rate | Wrong-route imp. | Competing routes | Position | CTR |',
  '|---|---|---|---|---|---|---:|---:|---:|---:|---:|---:|',
  ...result.filter((r) => r.status !== 'AMBIGUOUS' && r.status !== 'UNKNOWN').slice(0, 500).map((r) => `| ${r.query.replace(/\|/g, '\\|')} | ${r.ticker || '—'} | ${r.intent} | \`${r.expected_url || '—'}\` | \`${r.dominant_route || '—'}\` | **${r.status}** | ${r.intended_route_impressions.toFixed(0)} / ${r.total_metric_route_impressions.toFixed(0)} | ${pct(r.intended_ownership_rate)} | ${r.wrong_route_impressions.toFixed(0)} | ${r.competing_route_count} | ${r.position.toFixed(2)} | ${pct(r.ctr)} |`), '',
  '## Interpretation guardrails', '',
  '- Ownership rate is intended-route impressions divided by impressions across relevant metric routes for the same query; it is not a site-wide CTR or ranking metric.',
  '- A trivial secondary URL is reported but is not material cannibalization by itself. Use the existing evidence-floor/material rule in `scripts/analyze-gsc-seo.py` before changing templates.',
  '- Query and page dimensions are non-additive. Do not sum this report into a Search Console property total.', '',
  `Full machine-readable output: \`${outCsv}\`.`, ''
];
writeText(outMd, md.join('\n'));
if (!args.md) writeText(path.join(ROOT, 'docs/seo/query-ownership.md'), md.join('\n'));
console.log(JSON.stringify({ csv: outCsv, markdown: outMd, rows: result.length, counts }, null, 2));
