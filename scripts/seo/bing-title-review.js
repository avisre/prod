#!/usr/bin/env node
/* Turns docs/seo/bing-opportunities.csv into a prioritised title/meta worklist.
 *
 * It deliberately does NOT invent replacement titles. Bing weights exact-match
 * title and on-page terms more literally than Google, so a rewrite is only
 * worth making against the query that actually earned the impressions -- which
 * means reading seo-data/bing/queries.csv, not guessing from the route. What
 * this produces is the ranked list plus the exact source location that builds
 * each title, so the edit is made once, in the right generator.
 */
const path = require('path');
const { ROOT, readCsv, num, writeText, routeFromUrl } = require('./lib');

const args = Object.fromEntries(process.argv.slice(2).map((arg) => { const [k, ...v] = arg.replace(/^--/, '').split('='); return [k, v.join('=') || true]; }));
const input = path.resolve(args.input || path.join(ROOT, 'docs/seo/bing-opportunities.csv'));
// query->page attribution comes from the GetQueryPageStats drill-down;
// GetQueryStats alone carries no landing page.
const queriesInput = path.resolve(args.queries || path.join(ROOT, 'seo-data/bing/query-pages.csv'));
const out = path.resolve(args.out || path.join(ROOT, 'docs/seo/bing-title-review.md'));
const limit = Number(args.limit || 40);

// Where each page family's <title> and meta description are actually built.
const GENERATORS = {
  comparison: '`backend/seo-extra.js` renderComparePage — title/description',
  screen: '`backend/seo-extra.js` SCREENS',
  other: '`backend/seo-pages.js` — company and index pages',
  _metric: '`backend/seo-extra.js` renderMetricPage — title/description'
};
function generatorFor(family) {
  if (GENERATORS[family]) return GENERATORS[family];
  return GENERATORS._metric;
}

const rows = readCsv(input);
if (!rows.length) {
  writeText(out, [
    '# Bing title & meta review', '',
    `Generated: **${new Date().toISOString()}**`, '',
    `Input \`${path.relative(ROOT, input)}\` is empty or missing, so there is no worklist.`,
    'Run `python3 scripts/bing-webmaster-stats.py --week` then',
    '`node scripts/seo/find-search-opportunities.js` to populate it.',
    '', 'No page is listed here without a Bing row behind it.', ''
  ].join('\n'));
  console.log(JSON.stringify({ input, rows: 0, output: out, note: 'no Bing opportunity rows yet' }, null, 2));
  return;
}

// Top queries per landing page, so a rewrite can target real wording.
const queriesByPage = new Map();
for (const q of readCsv(queriesInput)) {
  const raw = q.page || q.url || '';
  if (!raw) continue;
  // bing-opportunities.csv stores routes; the export stores absolute URLs.
  const page = routeFromUrl(raw);
  const list = queriesByPage.get(page) || [];
  list.push({ query: q.query, impressions: num(q.impressions), position: num(q.position) });
  queriesByPage.set(page, list);
}

const ranked = rows
  .filter((r) => num(r.impressions) > 0 && num(r.ctr_gap) > 0)
  .sort((a, b) => num(b.opportunity_score) - num(a.opportunity_score))
  .slice(0, limit);

const byFamily = ranked.reduce((acc, r) => { (acc[r.page_family] = acc[r.page_family] || []).push(r); return acc; }, {});

const lines = [
  '# Bing title & meta review', '',
  `Generated: **${new Date().toISOString()}**`,
  `Source: \`${path.relative(ROOT, input)}\` (${rows.length} rows, showing top ${ranked.length}).`, '',
  '> Ranked by the existing opportunity score: impressions x position weight x CTR gap.',
  '> Positions 4-10 with real impressions and no clicks come first. No replacement',
  '> title is suggested here -- write it against the query column, in the generator named.',
  '',
  '## Worklist', '',
  '| # | Page | Family | Imp. | Pos. | CTR gap | Priority |',
  '|---:|---|---|---:|---:|---:|---|'
];
ranked.forEach((r, i) => {
  lines.push(`| ${i + 1} | \`${r.page}\` | ${r.page_family} | ${num(r.impressions).toFixed(0)} | ${num(r.position).toFixed(2)} | ${(num(r.ctr_gap) * 100).toFixed(2)}% | ${r.priority} |`);
});

lines.push('', '## Queries behind these pages', '');
const withQueries = ranked.filter((r) => queriesByPage.has(r.page));
if (!withQueries.length) {
  lines.push('No query→page attribution is present, so no query wording is shown.',
    'Run `python3 scripts/bing-webmaster-stats.py --week --drill=50` to write',
    '`seo-data/bing/query-pages.csv`; rewriting a title without the query it must',
    'match is guesswork.');
} else {
  lines.push('| Page | Top Bing queries |', '|---|---|');
  for (const r of withQueries) {
    const top = queriesByPage.get(r.page).sort((x, y) => y.impressions - x.impressions).slice(0, 3)
      .map((q) => `${q.query} (${q.impressions})`).join('; ');
    lines.push(`| \`${r.page}\` | ${top} |`);
  }
}

lines.push('', '## Where to make each edit', '', '| Family | Pages in worklist | Generator |', '|---|---:|---|');
for (const [family, list] of Object.entries(byFamily).sort((a, b) => b[1].length - a[1].length)) {
  lines.push(`| ${family} | ${list.length} | ${generatorFor(family)} |`);
}

lines.push('', '## Bing-specific checks', '',
  '1. Bing matches title terms more literally than Google — the exact query wording should appear in the title, not a synonym.',
  '2. Keep the ticker *and* the company name present; Bing comparison queries often use one or the other.',
  '3. Front-load the distinguishing term; Bing truncates around 60 characters.',
  '4. The meta description is used more directly by Bing than by Google — make it answer the query, not describe the site.',
  '5. Do not copy the Google-tuned title across; these are different ranking surfaces and the pages already rank differently on each.',
  '', 'Every row here comes from a Bing export. Nothing is inferred.', '');

writeText(out, lines.join('\n'));
console.log(JSON.stringify({ input, rows: rows.length, ranked: ranked.length, families: Object.keys(byFamily).length, output: out }, null, 2));
