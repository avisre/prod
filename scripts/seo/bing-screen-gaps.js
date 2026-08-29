#!/usr/bin/env node
/* Turns the Copilot citation data into a screen build/prune list.
 *
 * Why screens specifically: in the 2026-08 pull, 14 screen pages produced 680 of
 * 831 citations (82%), against 12k+ metric pages supplying the tail. Per page a
 * screen is orders of magnitude more citation-efficient, so "which screen next"
 * is the highest-leverage question this data can answer.
 *
 * It proposes no screen definitions. It reports which existing screens earn
 * citations, which earn none, and which grounding queries no screen matches --
 * the last group is where a new screen might belong, for a human to judge.
 */
const path = require('path');
const { ROOT, readCsv, num, writeText } = require('./lib');

const args = Object.fromEntries(process.argv.slice(2).map((a) => { const [k, ...v] = a.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
const pagesInput = path.resolve(args.pages || path.join(ROOT, 'docs/seo/bing-ai-performance.csv'));
const queriesInput = path.resolve(args.queries || path.join(ROOT, 'seo-data/bing/ai-grounding-queries.csv'));
const out = path.resolve(args.out || path.join(ROOT, 'docs/seo/bing-screen-gaps.md'));

// Prefer the live definitions; fall back to the slugs seen in the data when the
// backend's deps are not installed (this script is often run from a bare tree).
function definedScreens() {
  try {
    const extra = require('../../backend/seo-extra.js');
    return { slugs: Object.keys(extra.SCREENS), source: 'backend/seo-extra.js' };
  } catch (_) {
    return { slugs: null, source: 'unavailable (backend deps not installed)' };
  }
}

const cited = new Map();
for (const row of readCsv(pagesInput)) {
  const m = String(row.cited_url || '').match(/^\/screens\/([a-z0-9-]+)$/i);
  if (m) cited.set(m[1].toLowerCase(), num(row.citation_count));
}
const queries = readCsv(queriesInput)
  .map((r) => ({ query: r.grounding_query || '', intent: r.intent || '', topic: r.topic || '', citations: num(r.citations), share: r.citation_share || '' }))
  .filter((r) => r.query)
  .sort((a, b) => b.citations - a.citations);

const { slugs, source } = definedScreens();
const known = slugs || [...cited.keys()];
const uncited = slugs ? slugs.filter((s) => !cited.has(s)) : [];

/* A query is "covered" when a screen slug shares enough distinctive words with
 * it. Deliberately crude -- it is a shortlist for a human, not a classifier. */
const STOP = new Set(['the', 'a', 'an', 'of', 'for', 'with', 'and', 'or', 'in', 'to', 'is', 'are', 'what', 'right', 'now', 'best', 'top', 'stock', 'stocks', 'meaning', 'sources', 'trends', 'current']);
const words = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/[\s-]+/).filter((w) => w && !STOP.has(w));
function coveredBy(query) {
  const qw = new Set(words(query));
  let best = null, bestHits = 0;
  for (const slug of known) {
    const sw = words(slug);
    const hits = sw.filter((w) => qw.has(w)).length;
    if (hits > bestHits) { bestHits = hits; best = slug; }
  }
  return bestHits >= 2 ? { slug: best, hits: bestHits } : null;
}
const uncovered = queries.map((q) => ({ ...q, match: coveredBy(q.query) })).filter((q) => !q.match);
const covered = queries.filter((q) => coveredBy(q.query));

const citedTotal = [...cited.values()].reduce((n, v) => n + v, 0);
const lines = [
  '# Bing/Copilot screen gaps', '',
  `Generated: **${new Date().toISOString()}**`,
  `Screen definitions: ${source}.`,
  `Sources: \`${path.relative(ROOT, pagesInput)}\`, \`${path.relative(ROOT, queriesInput)}\`.`, '',
  `**${cited.size} screens cited · ${citedTotal} citations.**`, '',
  '## Cited screens', '', '| Screen | Citations |', '|---|---:|',
  ...[...cited.entries()].sort((a, b) => b[1] - a[1]).map(([s, n]) => `| \`/screens/${s}\` | ${n} |`), ''
];
if (slugs) {
  lines.push('## Defined but never cited', '');
  lines.push(uncited.length
    ? ['| Screen |', '|---|', ...uncited.map((s) => `| \`/screens/${s}\` |`)].join('\n')
    : 'Every defined screen has at least one citation.');
  lines.push('', 'Not automatically a problem — a screen can be new, or serve search rather', 'than Copilot. Check it against the search data before pruning.', '');
}
lines.push('## Grounding queries no screen matches', '',
  'Citations these earned went to metric or company pages instead. Where the',
  'query names a repeatable filter, a screen may capture it more durably.', '',
  '| Query | Intent | Topic | Citations | Share |', '|---|---|---|---:|---:|',
  ...(uncovered.length
    ? uncovered.map((q) => `| ${q.query} | ${q.intent || '—'} | ${q.topic || '—'} | ${q.citations} | ${q.share || '—'} |`)
    : ['| — | — | — | — | Every query maps to an existing screen |']),
  '', `Covered by an existing screen: **${covered.length}** of ${queries.length} queries.`, '',
  'Screen slugs and query wording are compared word-wise; treat this as a',
  'shortlist to judge, not a decision. No screen definition is proposed here.', '');

writeText(out, lines.join('\n'));
console.log(JSON.stringify({
  citedScreens: cited.size, citations: citedTotal,
  definedScreens: slugs ? slugs.length : null, uncited: uncited.length,
  queries: queries.length, uncovered: uncovered.length, output: out
}, null, 2));
