#!/usr/bin/env node
/* Build a local, reproducible SEO page baseline. No network and no writes to
 * application data; only the requested report files are created. */
const path = require('path');
const {
  ROOT, SITE, readCsv, num, unique, routeFromUrl, renderPath, extractHtml,
  sitemapEntries, writeJson, writeText
} = require('./lib');

const args = Object.fromEntries(process.argv.slice(2).map((arg) => {
  const [key, ...rest] = arg.replace(/^--/, '').split('=');
  return [key, rest.join('=') || true];
}));
const out = path.resolve(args.out || path.join(ROOT, 'docs/seo/production-baseline.json'));
const report = out.replace(/\.json$/i, '.md');
const gscFile = path.resolve(args.google || path.join(ROOT, 'seo-data/gsc/pages-3m.csv'));
const bingFile = args.bing && args.bing !== true ? path.resolve(args.bing) : path.join(ROOT, 'seo-data/bing/pages.csv');

const explicit = [
  '/stocks/AAP/free-cash-flow', '/stocks/WAB/eps', '/stocks/WAB/shares-outstanding',
  '/stocks/WAB/dividend-history', '/stocks/AAP/revenue', '/stocks/AAP/eps',
  '/stocks/AAP/shares-outstanding', '/stocks/AAP/total-debt', '/stocks/AAP/net-income',
  '/stocks/AAP/pe-ratio', '/compare/AMT-vs-DLR', '/stocks/AAP'
];
function topRoutes(file, limit) {
  return readCsv(file).sort((a, b) => num(b.impressions) - num(a.impressions))
    .slice(0, limit).map((row) => routeFromUrl(row.page || row.url || row.loc)).filter(Boolean);
}
const googleRows = readCsv(gscFile);
const bingRows = readCsv(bingFile);
const routes = unique([...explicit, ...topRoutes(gscFile, 10), ...topRoutes(bingFile, 10)]);
const localSitemap = sitemapEntries();
const rendered = routes.map((route) => {
  const html = renderPath(route);
  const metadata = extractHtml(html, route);
  const match = route.match(/^\/stocks\/([^/]+)(?:\/([^/]+))?/i);
  const fundFile = match ? path.join(ROOT, 'frontend/data/fundamentals', `${String(match[1]).toUpperCase().replace(/[^A-Z0-9]/g, '_')}.json`) : '';
  let lastModified = '';
  try { lastModified = require('fs').statSync(fundFile).mtime.toISOString(); } catch (_) { /* static/comparison route */ }
  const routeSitemap = localSitemap.find((entry) => routeFromUrl(entry.loc) === route);
  return {
    ...metadata,
    url: `${SITE}${route}`,
    ticker: match ? String(match[1]).toUpperCase() : '',
    metric: match && match[2] ? String(match[2]).toLowerCase() : '',
    lastModifiedValue: lastModified || null,
    sitemap: routeSitemap ? routeSitemap.shard : null,
    sitemapLastmod: routeSitemap ? routeSitemap.lastmod : null,
    sitemapListed: Boolean(routeSitemap),
    google: googleRows.find((row) => routeFromUrl(row.page) === route) || null,
    bing: bingRows.find((row) => routeFromUrl(row.page || row.url) === route) || null,
  };
});
const inbound = new Map(rendered.map((row) => [row.route, []]));
for (const source of rendered) {
  for (const link of source.internalOutboundLinks) {
    const route = routeFromUrl(link);
    if (inbound.has(route) && route !== source.route) inbound.get(route).push(source.route);
  }
}
for (const row of rendered) row.internalInboundLinks = unique(inbound.get(row.route) || []);

const result = {
  generatedAtUtc: new Date().toISOString(),
  mode: 'local-render-and-export-audit',
  productionVerification: 'NOT_PERFORMED — this report does not claim live status codes or live search coverage',
  input: {
    googlePagesCsv: gscFile,
    googleRows: googleRows.length,
    bingPagesCsv: fsSafeExists(bingFile) ? bingFile : null,
    bingRows: bingRows.length,
    bingDataStatus: fsSafeExists(bingFile) ? 'available' : 'missing — pass --bing=/path/to/export.csv to add the top-10 cohort'
  },
  representatives: rendered,
  sitemapSummary: {
    generatedLocally: true,
    count: localSitemap.length,
    trackingUrlsExcludedByRenderer: true,
    note: 'Sitemap membership is checked against the current local renderer; URL inspection and HTTP status require a separate production run.'
  }
};
writeJson(out, result);

function fsSafeExists(file) { try { return require('fs').existsSync(file); } catch (_) { return false; } }
function mdCell(value) { return String(value == null || value === '' ? '—' : value).replace(/\|/g, '\\|').replace(/\n/g, ' '); }
const rows = rendered.map((r) => [
  `\`${r.route}\``, r.status, r.canonical || '—', r.robots || '—', mdCell(r.title), r.titleLength,
  mdCell(r.h1), mdCell(r.opening.slice(0, 180)), r.structuredData.filter((x) => !x.invalid).length,
  r.internalInboundLinks.length, r.internalOutboundLinks.length, r.sitemapListed ? r.sitemap : 'NO', r.sitemapLastmod || '—',
  r.ticker || '—', r.metric || '—', r.indexable ? 'yes' : 'no', r.sourceVisible ? 'yes' : 'no', r.responseSizeBytes, r.criticalContentStatus ? 'yes' : 'no'
]);
const lines = [
  '# SEO production baseline (local control-plane audit)', '',
  `Generated: **${result.generatedAtUtc}**`, '',
  '> This is a local render/export baseline. It deliberately does not claim live production status, live indexability, Google/Bing rankings, or a deployment. Run the production verifier separately after an approved rollout.', '',
  '## Inputs', '',
  `- Google page export: \`${gscFile}\` (${googleRows.length} rows).`,
  `- Bing page export: ${result.input.bingPagesCsv ? `\`${result.input.bingPagesCsv}\` (${bingRows.length} rows)` : `**not available** — use \`--bing=/path/to/bing-page-export.csv\`.`}`,
  `- Local sitemap entries inspected: **${result.sitemapSummary.count.toLocaleString()}**.`, '',
  '## Representative pages', '',
  '| URL | status | canonical | robots | title | title chars | H1 | first visible answer (500 chars) | JSON-LD blocks | inbound | outbound | sitemap | lastmod | ticker | metric | indexable | source visible | bytes | critical SSR |',
  '|---|---:|---|---|---|---:|---|---|---:|---:|---:|---|---|---|---|---|---|---:|---|',
  ...rows.map((row) => `| ${row.join(' | ')} |`), '',
  '## Interpretation and gates', '',
  '- The representative set includes AAP free cash flow, the three WAB metric pages, metric-family samples, a comparison, the stock hub, and the top Google/Bing page rows when exports are present.',
  '- A missing Bing export is a **data gap**, not zero Bing traffic. No Bing opportunity is inferred from absent input.',
  '- “Indexable” here means the rendered robots directive allows indexing. Production robots, redirects and HTTP status still require a controlled smoke test.',
  '- Internal inbound counts are limited to this representative render set; they are not a sitewide crawl.',
  '- A page with missing title/H1/canonical, a non-200 production status, or unexpected sitemap membership is a release blocker.', ''
];
writeText(report, lines.join('\n'));
console.log(JSON.stringify({ json: out, markdown: report, pages: rendered.length, googleRows: googleRows.length, bingRows: bingRows.length }, null, 2));
