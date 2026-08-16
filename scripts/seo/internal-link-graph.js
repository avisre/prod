#!/usr/bin/env node
/* Crawl the deterministic local render sample and describe semantic authority
 * flow. This is intentionally an audit, not a mass link writer. */
const fs = require('fs');
const path = require('path');
const { ROOT, SITE, routeFromUrl, renderPath, extractHtml, unique, writeText } = require('./lib');

const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, ...rest] = arg.replace(/^--/, '').split('='); return [key, rest.join('=') || true]; }));
const out = path.resolve(args.out || path.join(ROOT, 'docs/seo/internal-link-graph.csv'));
const mdOut = path.resolve(args.md || path.join(ROOT, 'docs/seo/internal-link-graph.md'));
const baselinePath = path.resolve(args.baseline || path.join(ROOT, 'docs/seo/production-baseline.json'));
let routes = [];
try { routes = JSON.parse(fs.readFileSync(baselinePath, 'utf8')).representatives.map((r) => r.route); } catch (_) { routes = ['/stocks/AAP/free-cash-flow', '/stocks/WAB/eps', '/stocks/WAB/shares-outstanding', '/stocks/WAB/dividend-history', '/stocks/AAP']; }
routes = unique(routes);
const pages = routes.map((route) => ({ route, meta: extractHtml(renderPath(route), route) }));
const sampled = new Set(routes);
const graph = [];
const semantic = {
  eps: /(?:earnings per share|\beps\b)/i,
  'shares-outstanding': /(?:shares outstanding|share count)/i,
  revenue: /\brevenue\b/i,
  'net-income': /\bnet income\b/i,
  'free-cash-flow': /(?:free cash flow|\bfcf\b)/i,
  'total-debt': /(?:total debt|net debt|\bdebt\b)/i,
  'dividend-history': /dividend/i,
  'pe-ratio': /(?:p\/e|valuation|price-to-earnings)/i,
};
function metricTarget(route) { const m = route.match(/^\/stocks\/[^/]+\/([^/]+)$/i); return m && Object.prototype.hasOwnProperty.call(semantic, m[1].toLowerCase()) ? m[1].toLowerCase() : ''; }
function csv(v) { return `"${String(v == null ? '' : v).replace(/"/g, '""')}"`; }
function family(route) { if (/^\/stocks\/[^/]+\/[^/]+$/.test(route)) return 'metric'; if (/^\/stocks\/[^/]+$/.test(route)) return 'company'; if (/^\/compare\//.test(route)) return 'comparison'; return 'other'; }
for (const page of pages) {
  const outbound = page.meta.internalOutboundLinks.map(routeFromUrl).filter((r) => /^\/stocks\//.test(r));
  const counts = new Map();
  for (const target of outbound) counts.set(target, (counts.get(target) || 0) + 1);
  for (const [target, count] of counts.entries()) {
    const anchorTexts = [];
    const source = renderPath(page.route) || '';
    const re = new RegExp(`<a[^>]+href=["'](?:${SITE.replace('.', '\\.')})?${target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["'][^>]*>([\\s\\S]*?)<\\/a>`, 'gi');
    for (const match of source.matchAll(re)) anchorTexts.push(String(match[1]).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    const targetMetric = metricTarget(target);
    const incorrect = targetMetric && anchorTexts.some((anchor) => {
      const labels = Object.entries(semantic).filter(([slug, pattern]) => pattern.test(anchor)).map(([slug]) => slug);
      return labels.length > 0 && !labels.includes(targetMetric);
    });
    graph.push({ url: target, source: page.route, incoming_in_sample: 0, outgoing_in_sample: 0, anchor_texts: unique(anchorTexts).join(' | '), page_family: family(target), orphan_status: sampled.has(target) ? 'sampled' : 'outside_sample', wrong_metric_anchor: incorrect ? 'yes' : 'no', duplicate_anchor_count: count });
  }
}
const inbound = new Map(); graph.forEach((e) => inbound.set(e.url, (inbound.get(e.url) || 0) + 1));
for (const e of graph) { e.incoming_in_sample = inbound.get(e.url) || 0; e.outgoing_in_sample = pages.find((p) => p.route === e.source)?.meta.internalOutboundLinks.filter((l) => /^https:\/\/www\.stockportfolio\.pro\/stocks\//.test(l)).length || 0; }
const fields = ['url', 'source', 'incoming_in_sample', 'outgoing_in_sample', 'anchor_texts', 'orphan_status', 'page_family', 'wrong_metric_anchor', 'duplicate_anchor_count'];
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${fields.join(',')}\n${graph.map((e) => fields.map((f) => csv(e[f])).join(',')).join('\n')}\n`);
const flagRows = graph.filter((e) => e.wrong_metric_anchor === 'yes' || e.incoming_in_sample <= 1 || e.duplicate_anchor_count > 3);
writeText(mdOut, [
  '# Internal metric link graph (local sample)', '',
  `Generated: **${new Date().toISOString()}**`, '',
  `- Source pages rendered: **${pages.length}**.`, `- Metric destinations observed: **${graph.length}**.`, '',
  '> This is an authority-flow audit over representative server-rendered pages. It does not rewrite links or claim sitewide orphan status without a complete crawl.', '',
  '## Flags', '',
  '| Source | Destination | Family | Anchors | Incoming in sample | Flag |', '|---|---|---|---|---:|---|',
  ...(flagRows.length ? flagRows.map((e) => `| \`${e.source}\` | \`${e.url}\` | ${e.page_family} | ${e.anchor_texts || '—'} | ${e.incoming_in_sample} | ${e.wrong_metric_anchor === 'yes' ? 'WRONG_METRIC_ANCHOR' : e.duplicate_anchor_count > 3 ? 'DUPLICATE_ANCHOR' : 'LOW_SAMPLE_AUTHORITY'} |`) : ['| — | — | — | — | — | No flags in the representative sample |']), '',
  '## Guardrails', '',
  '- Concise exact metric labels are preferred; ticker repetition is not required inside a company hub.',
  '- Correct only semantically wrong anchors. Do not create a broad internal-link network until the ownership evidence and Bing baseline pass their gates.',
  `Machine-readable graph: \`${out}\`.`, ''
].join('\n'));
console.log(JSON.stringify({ csv: out, markdown: mdOut, sourcePages: pages.length, destinations: graph.length, flags: flagRows.length }, null, 2));
