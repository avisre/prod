#!/usr/bin/env node
/* Compare two local page baselines. A non-zero exit is reserved for a
 * regression in protected fields, so CI can use this as a gate. */
const fs = require('fs');
const path = require('path');
const { ROOT, writeText } = require('./lib');
const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [k, ...v] = arg.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
const beforeFile = path.resolve(args.before || path.join(ROOT, 'docs/seo/production-baseline.json'));
const afterFile = path.resolve(args.after || beforeFile);
const out = path.resolve(args.out || path.join(ROOT, 'docs/seo/baseline-comparison.md'));
function load(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { throw new Error(`Cannot read baseline ${file}: ${e.message}`); } }
const before = load(beforeFile); const after = load(afterFile);
const byRoute = (doc) => new Map((doc.representatives || []).map((row) => [row.route, row]));
const oldRows = byRoute(before); const newRows = byRoute(after); const routes = [...new Set([...oldRows.keys(), ...newRows.keys()])].sort();
const protectedFields = ['canonical', 'robots', 'h1', 'title', 'sitemapListed', 'indexable'];
const diffs = [];
for (const route of routes) {
  const oldRow = oldRows.get(route) || {}; const newRow = newRows.get(route) || {};
  for (const field of protectedFields) if (String(oldRow[field] ?? '') !== String(newRow[field] ?? '')) diffs.push({ route, field, before: oldRow[field] ?? '', after: newRow[field] ?? '' });
  if (oldRow.status === 200 && newRow.status !== 200) diffs.push({ route, field: 'status', before: 200, after: newRow.status });
  if (oldRow.title && !newRow.title) diffs.push({ route, field: 'title_missing', before: oldRow.title, after: '' });
  if (oldRow.h1 && !newRow.h1) diffs.push({ route, field: 'h1_missing', before: oldRow.h1, after: '' });
}
writeText(out, [
  '# SEO baseline comparison', '',
  `Generated: **${new Date().toISOString()}**`, `- Before: \`${beforeFile}\``, `- After: \`${afterFile}\``, '',
  `- Protected-field differences: **${diffs.length}**.`, '',
  '| Route | Field | Before | After |', '|---|---|---|---|',
  ...(diffs.length ? diffs.map((d) => `| \`${d.route}\` | ${d.field} | ${String(d.before).replace(/\|/g, '\\|')} | ${String(d.after).replace(/\|/g, '\\|')} |`) : ['| — | — | — | No differences |']), '',
  '## Release gate', '',
  '- Any unexpected canonical, robots, status, missing title/H1, indexability, or sitemap change is a blocker for a broad rollout.',
  '- Intentional AAP/WAB title/H1 changes must be recorded as a cohort change and reviewed separately from Bing protection.', ''
].join('\n'));
console.log(JSON.stringify({ report: out, differences: diffs.length, status: diffs.length ? 'REVIEW_REQUIRED' : 'PASS' }, null, 2));
process.exitCode = args.strict && diffs.length ? 1 : 0;
