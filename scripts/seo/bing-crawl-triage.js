#!/usr/bin/env node
/* Triages the crawl issues Bing reported in the latest weekly snapshot.
 *
 * The point is the split: a URL we publish in our own sitemap and that Bing
 * cannot crawl is our bug and costs index coverage. A URL Bing found elsewhere
 * (an old link, a stale external reference) that is not in the sitemap is
 * usually not worth chasing. Counting them together, as the raw dashboard does,
 * hides which is which.
 *
 *   node scripts/seo/bing-crawl-triage.js
 */
const fs = require('fs');
const path = require('path');
const { ROOT, writeText, routeFromUrl } = require('./lib');

const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [k, ...v] = arg.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
const dir = path.join(ROOT, 'seo-data/bing');
const out = path.resolve(args.out || path.join(ROOT, 'docs/seo/bing-crawl-triage.md'));

function latestSnapshot() {
  if (args.snapshot && args.snapshot !== true) return path.resolve(args.snapshot);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => /^weekly-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
  return files.length ? path.join(dir, files[files.length - 1]) : null;
}

const snapPath = latestSnapshot();
if (!snapPath || !fs.existsSync(snapPath)) {
  writeText(out, [
    '# Bing crawl triage', '', `Generated: **${new Date().toISOString()}**`, '',
    'No Bing weekly snapshot exists yet, so there is nothing to triage.',
    'Run `python3 scripts/bing-webmaster-stats.py --week` first.', ''
  ].join('\n'));
  console.log(JSON.stringify({ snapshot: null, output: out, note: 'no snapshot' }, null, 2));
  return;
}

const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
const issues = Array.isArray(snap.issues) ? snap.issues : [];
const blocked = Array.isArray(snap.blocked) ? snap.blocked : [];

// The sitemap is built by the backend, which needs its deps installed. If that
// is not available, still report the issues -- just without the split.
let sitemapRoutes = null;
let sitemapNote = '';
try {
  const { sitemapEntries } = require('./lib');
  sitemapRoutes = new Set(sitemapEntries().map((e) => routeFromUrl(e.loc)));
} catch (err) {
  // First line only: a require stack would break the markdown blockquote.
  const why = String(err.message || 'could not build sitemap').split('\n')[0];
  sitemapNote = `Sitemap cross-reference unavailable (${why}), so issues are not split by sitemap membership.`;
}

const urlOf = (row) => row && (row.Url || row.url || row.Loc || '') || '';
const rows = issues.map((row) => {
  const url = urlOf(row);
  const route = routeFromUrl(url);
  return {
    url, route,
    inSitemap: sitemapRoutes ? sitemapRoutes.has(route) : null,
    // Passed through as Bing reports them; no label is invented for IssueType.
    issueType: row.IssueType !== undefined ? String(row.IssueType) : '',
    httpCode: row.HttpCode !== undefined ? String(row.HttpCode) : ''
  };
}).filter((r) => r.url);

const ours = rows.filter((r) => r.inSitemap === true);
const external = rows.filter((r) => r.inSitemap === false);
const unknown = rows.filter((r) => r.inSitemap === null);

function group(list, key) {
  return Object.entries(list.reduce((a, r) => { const k = r[key] || '(none)'; a[k] = (a[k] || 0) + 1; return a; }, {}))
    .sort((a, b) => b[1] - a[1]);
}
function table(list, limit = 30) {
  if (!list.length) return ['| — | — | — | none |'];
  return list.slice(0, limit).map((r) => `| \`${r.route}\` | ${r.issueType || '—'} | ${r.httpCode || '—'} | ${r.inSitemap === null ? 'unknown' : r.inSitemap ? 'yes' : 'no'} |`);
}

const crawl = snap.crawl_latest || {};
const sitemapUrls = (snap.sitemap || {}).urls;
const inIndex = crawl.InIndex;
const gap = (Number(sitemapUrls) && Number(inIndex)) ? Number(sitemapUrls) - Number(inIndex) : null;

const lines = [
  '# Bing crawl triage', '',
  `Generated: **${new Date().toISOString()}**`,
  `Snapshot: \`${path.relative(ROOT, snapPath)}\` (week ending ${snap.week_ending}).`, ''
];
if (sitemapNote) lines.push(`> ${sitemapNote}`, '');
lines.push(
  '## Index coverage', '',
  `- Sitemap URLs: **${sitemapUrls != null ? sitemapUrls : 'unknown'}**`,
  `- In Bing index: **${inIndex != null ? inIndex : 'unknown'}**`,
  gap !== null ? `- Gap: **${gap}** URLs published but not indexed` : '- Gap: not computable from this snapshot',
  `- Crawl errors reported: **${crawl.CrawlErrors != null ? crawl.CrawlErrors : 'unknown'}** (4xx ${crawl.Code4xx ?? '—'}, 5xx ${crawl.Code5xx ?? '—'}, robots-blocked ${crawl.BlockedByRobotsTxt ?? '—'})`,
  `- Blocked URLs configured in Bing: **${blocked.length}**`, '',
  '## Triage', '',
  '| Bucket | Count | Meaning |', '|---|---:|---|',
  `| In our sitemap | ${ours.length} | We publish these and Bing cannot crawl them — fix first |`,
  `| Not in sitemap | ${external.length} | Found elsewhere; usually stale links, low priority |`,
  `| Unknown | ${unknown.length} | Sitemap unavailable, membership not determined |`, '',
  '## Issues on pages we publish', '',
  '| Page | IssueType | HTTP | In sitemap |', '|---|---|---|---|',
  ...table(ours.length ? ours : unknown), ''
);
if (external.length) {
  lines.push('## Issues on pages we do not publish', '',
    '| Page | IssueType | HTTP | In sitemap |', '|---|---|---|---|', ...table(external, 15), '');
}
if (rows.length) {
  lines.push('## Distribution', '', '| IssueType (as Bing reports it) | Count |', '|---|---:|',
    ...group(rows, 'issueType').map(([k, n]) => `| ${k} | ${n} |`), '');
}
lines.push('Issue types are passed through exactly as the API returns them; no label is',
  'invented for a numeric code. Counts come from the snapshot, not from a live call.', '');

writeText(out, lines.join('\n'));
console.log(JSON.stringify({
  snapshot: path.relative(ROOT, snapPath), issues: rows.length,
  inSitemap: ours.length, notInSitemap: external.length, unknown: unknown.length,
  indexGap: gap, output: out
}, null, 2));
