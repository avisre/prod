#!/usr/bin/env node
/* Validate the existing sitemap generator without changing its URL contract. */
const path = require('path');
const { ROOT, SITE, sitemapEntries, routeFromUrl, renderPath, extractHtml, writeText } = require('./lib');

const out = path.resolve((Object.fromEntries(process.argv.slice(2).map((arg) => { const [k, ...v] = arg.replace(/^--/, '').split('='); return [k, v.join('=') || true]; })).out) || path.join(ROOT, 'docs/seo/sitemap-audit.md'));
const entries = sitemapEntries();
const seen = new Set(); const issues = []; const shards = {};
for (const entry of entries) {
  const route = routeFromUrl(entry.loc);
  if (seen.has(entry.loc)) issues.push({ route, issue: 'DUPLICATE_URL' });
  seen.add(entry.loc); shards[entry.shard] = (shards[entry.shard] || 0) + 1;
  if (!entry.loc.startsWith(`${SITE}/`)) issues.push({ route, issue: 'NON_CANONICAL_HOST' });
  if (/[?&#]/.test(entry.loc)) issues.push({ route, issue: 'TRACKING_OR_PARAMETER_URL' });
  if (/\/(?:login|register|dashboard|admin|account|private|settings)(?:\/|$)/i.test(route)) issues.push({ route, issue: 'PRIVATE_ROUTE' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.lastmod)) issues.push({ route, issue: 'INVALID_LASTMOD' });
}
const sampleRoutes = ['/stocks/AAP/free-cash-flow', '/stocks/WAB/eps', '/stocks/WAB/shares-outstanding', '/stocks/WAB/dividend-history', '/stocks/AAP'];
const samples = sampleRoutes.map((route) => {
  const entry = entries.find((e) => routeFromUrl(e.loc) === route);
  const meta = extractHtml(renderPath(route), route);
  const issue = !entry ? 'MISSING_REPRESENTATIVE' : meta.status !== 200 ? 'LOCAL_RENDER_NOT_200' : !meta.indexable ? 'LOCAL_RENDER_NOT_INDEXABLE' : '';
  if (issue) issues.push({ route, issue });
  return { route, listed: Boolean(entry), lastmod: entry?.lastmod || '', status: meta.status, indexable: meta.indexable, issue: issue || 'OK' };
});
const counts = entries.reduce((acc, e) => { const route = routeFromUrl(e.loc); const type = /^\/stocks\/[^/]+\//.test(route) ? 'metrics' : /^\/stocks\//.test(route) ? 'stocks' : /^\/compare\//.test(route) ? 'comparisons' : 'core'; acc[type] = (acc[type] || 0) + 1; return acc; }, {});
writeText(out, [
  '# Sitemap audit', '',
  `Generated: **${new Date().toISOString()}**`, '',
  '> This audit exercises the existing sitemap generator locally. It does not submit sitemaps or change Search Console/Bing state. Production HTTP status and URL Inspection still require a controlled deployment check.', '',
  '## Summary', '',
  `- Entries: **${entries.length.toLocaleString()}**.`,
  `- Duplicate/contract issues found: **${issues.length}**.`,
  `- Shards: ${Object.entries(shards).map(([k, v]) => `\`${k}\` ${v}`).join(', ')}.`,
  `- Page families: ${Object.entries(counts).map(([k, v]) => `\`${k}\` ${v}`).join(', ')}.`, '',
  '## Representative URL checks', '',
  '| Route | Listed | Lastmod | Local status | Local indexable | Result |', '|---|---|---|---:|---|---|',
  ...samples.map((s) => `| \`${s.route}\` | ${s.listed ? 'yes' : 'no'} | ${s.lastmod || '—'} | ${s.status} | ${s.indexable ? 'yes' : 'no'} | ${s.issue} |`), '',
  '## Issue list', '',
  ...(issues.length ? issues.slice(0, 200).map((i) => `- **${i.issue}**: \`${i.route}\``) : ['No local sitemap contract issues found.']), '',
  '## Lastmod guardrail', '',
  '- `lastmod` is read from the existing data/page mtime logic. It must represent a meaningful data or page change, not every deploy.',
  '- No redirect, canonical, robots, URL, or sitemap membership changes were made by this audit.', ''
].join('\n'));
console.log(JSON.stringify({ report: out, entries: entries.length, issues: issues.length, shards, counts }, null, 2));
