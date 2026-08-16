#!/usr/bin/env node
/* Focused semantic-anchor audit. It never edits templates. */
const fs = require('fs');
const path = require('path');
const { ROOT, SITE, routeFromUrl, renderPath, extractHtml, unique, writeText } = require('./lib');

const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [key, ...rest] = arg.replace(/^--/, '').split('='); return [key, rest.join('=') || true]; }));
const out = path.resolve(args.out || path.join(ROOT, 'docs/seo/internal-metric-link-audit.md'));
const routes = ['/stocks/AAP', '/stocks/AAP/free-cash-flow', '/stocks/WAB', '/stocks/WAB/eps', '/stocks/WAB/shares-outstanding', '/stocks/WAB/dividend-history'];
const labels = {
  eps: /(?:earnings per share|\beps\b)/i,
  'shares-outstanding': /(?:shares outstanding|share count)/i,
  revenue: /\brevenue\b/i,
  'net-income': /\bnet income\b/i,
  'free-cash-flow': /(?:free cash flow|\bfcf\b)/i,
  'dividend-history': /dividend/i,
  'total-debt': /(?:total debt|net debt|\bdebt\b)/i,
  'pe-ratio': /(?:p\/e|valuation|price-to-earnings)/i,
};
function target(link) { const m = routeFromUrl(link).match(/^\/stocks\/[^/]+\/([^/]+)$/i); return m && labels[m[1].toLowerCase()] ? m[1].toLowerCase() : ''; }
const findings = [];
for (const source of routes) {
  const html = renderPath(source) || '';
  const meta = extractHtml(html, source);
  const anchors = [...html.matchAll(/<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ href: routeFromUrl(m[1]), anchor: m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() })).filter((a) => a.href.startsWith('/stocks/'));
  for (const link of anchors) {
    const metric = target(link.href); if (!metric) continue;
    const mentioned = Object.entries(labels).filter(([slug, pattern]) => pattern.test(link.anchor)).map(([slug]) => slug);
    let issue = '';
    if (mentioned.length && !mentioned.includes(metric)) issue = 'WRONG_METRIC_ANCHOR';
    if (!link.anchor) issue = 'EMPTY_ANCHOR';
    findings.push({ source, href: link.href, anchor: link.anchor, targetMetric: metric, issue: issue || 'OK' });
  }
  if (!meta.h1 || !meta.canonical) findings.push({ source, href: '', anchor: '', targetMetric: '', issue: 'MISSING_PAGE_SEMANTICS' });
}
const flags = findings.filter((f) => f.issue !== 'OK');
writeText(out, [
  '# Internal metric-link semantic audit', '',
  `Generated: **${new Date().toISOString()}**`, '',
  '> Rendered anchors are checked against their destination metric. This report is a read-only audit; no links were rewritten.', '',
  '## Findings', '',
  '| Source | Destination | Anchor | Destination metric | Status |', '|---|---|---|---|---|',
  ...findings.map((f) => `| \`${f.source}\` | \`${f.href || '—'}\` | ${f.anchor || '—'} | ${f.targetMetric || '—'} | ${f.issue} |`), '',
  `- Total rendered metric links: **${findings.filter((f) => f.href).length}**.`, `- Semantic flags: **${flags.length}**.`, '',
  '## Correction rules', '',
  '- EPS anchors must describe earnings per share/EPS.',
  '- Shares anchors must describe shares outstanding/share count.',
  '- Revenue anchors must describe revenue.',
  '- Dividend anchors must describe dividend history/dividends.',
  '- Generic “view metric”/“learn more” anchors are not used as semantic ownership evidence.',
  '- A company hub may use concise labels without repeating the ticker.', ''
].join('\n'));
console.log(JSON.stringify({ report: out, links: findings.filter((f) => f.href).length, flags: flags.length }, null, 2));
