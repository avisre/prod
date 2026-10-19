const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const companySource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'company.js'),
  'utf8'
);
const systemCss = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'system.css'),
  'utf8'
);
const companyHtml = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend-v2', 'company.html'),
  'utf8'
);
const appSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'app.js'),
  'utf8'
);

function incomeDefinitions() {
  const block = companySource.match(/income:\s*\[([\s\S]*?)\n\s*\],\n\s*\/\/ Macrotrends content/);
  assert.ok(block, 'income statement definitions should be present');

  return [...block[1].matchAll(/\{\s*label:\s*'([^']+)'([^\n]*)/g)].map((match) => ({
    label: match[1],
    sub: /\bsub:\s*true\b/.test(match[2]),
    solo: /\bsolo:\s*true\b/.test(match[2])
  }));
}

function groupDefinitions(definitions) {
  const grouped = definitions.map((definition) => ({ ...definition }));
  let parent = null;
  let groupId = -1;

  for (const definition of grouped) {
    if (definition.sub) {
      if (parent) {
        if (parent.parentOf === undefined) {
          groupId += 1;
          parent.parentOf = groupId;
        }
        definition.gid = parent.parentOf;
      }
    } else {
      parent = definition.solo ? null : definition;
    }
  }

  return grouped;
}

test('revenue, cost of revenue and gross profit are always-visible rows in statement order', () => {
  const grouped = groupDefinitions(incomeDefinitions());
  const byLabel = Object.fromEntries(grouped.map((definition) => [definition.label, definition]));

  assert.deepEqual(
    grouped.slice(0, 4).map((definition) => definition.label),
    ['Revenue', 'Cost of revenue', 'Gross profit', 'Gross margin']
  );
  for (const label of ['Revenue', 'Cost of revenue', 'Gross profit']) {
    assert.equal(byLabel[label].gid, undefined, `${label} is never hidden`);
  }
  assert.equal(byLabel.Revenue.parentOf, undefined);
  assert.equal(byLabel['Cost of revenue'].parentOf, undefined);
});

test('gross margin unfolds under gross profit', () => {
  const grouped = groupDefinitions(incomeDefinitions());
  const grossProfit = grouped.find((definition) => definition.label === 'Gross profit');
  const children = grouped.filter((definition) => definition.gid === grossProfit.parentOf);

  assert.deepEqual(children.map((definition) => definition.label), ['Gross margin']);
});

test('financial statement columns have year lanes and whole-column sizing', () => {
  assert.match(companySource, /function alignStatementYearColumns\(/);
  assert.match(companySource, /availableForYears \/ completeYears/);
  assert.match(companySource, /wrap\.clientWidth - rowHeadWidth - trendWidth/);
  assert.match(companySource, /alignStatementYearColumns\(\);/);
  assert.match(companySource, /alignStatementYearColumns\(\{ preservePosition: true \}\)/);
  assert.match(systemCss, /#stmt-table tbody tr:nth-child\(even\)/);
  assert.match(systemCss, /#stmt-table:not\(\.trend-hidden\) th:nth-child\(n \+ 3\)/);
  assert.match(systemCss, /#stmt-table\.trend-hidden th:nth-child\(n \+ 2\)/);
  assert.match(systemCss, /\.table-data \.row-head[\s\S]*position: sticky[\s\S]*left: 0/);
  assert.doesNotMatch(systemCss, /#stmt-table \.col-now\s*\{[\s\S]*background:/);
  assert.doesNotMatch(systemCss, /#stmt-table thead \.col-now::after/);
  assert.doesNotMatch(systemCss, /#stmt-table tbody tr:hover \.col-now/);
  assert.match(systemCss, /#stmt-table:not\(\.trend-hidden\)[\s\S]*left: 248px/);
  assert.match(systemCss, /font-variant-numeric:\s*tabular-nums lining-nums/);
});

test('company page cache-busts the approved statement assets together', () => {
  // system.css and company.js are approved as a pair — the statement table's
  // markup and its styles have to ship together or the page renders broken.
  // Stamp bumped 2026-08-29 with the nav/account-dropdown change, which edits
  // system.css site-wide; company.js follows so the pair stays in lockstep.
  // Re-synced 2026-09-28 (both files changed again, for the compare-box and
  // nav-search empty states) — the two literals below must always match.
  assert.match(companyHtml, /assets\/system\.css\?v=20261019-ui28/);
  assert.match(companyHtml, /assets\/company\.js\?v=20261019-ui28/);
});

test('financial statements use five-period mini bars instead of sparklines', () => {
  assert.match(companySource, /function statementMiniBars\(values, periods, fmt\)/);
  assert.match(companySource, /Five-year trend/);
  assert.match(companySource, /Five-quarter trend/);
  assert.match(companySource, /statementMiniBars\(vals, lastRender\.periods, fmt\)/);
  assert.doesNotMatch(companySource, /sparkline\(sparkVals/);
  assert.match(systemCss, /\.stmt-mini-bars/);
  assert.match(systemCss, /\.stmt-mini-bar\.is-latest:not\(\.is-negative\) \{ background: var\(--accent\); \}/);
  assert.match(systemCss, /#stmt-table:not\(\.trend-hidden\) th:nth-child\(2\),[\s\S]*border-right: 2px solid/);
  assert.match(systemCss, /#stmt-table:not\(\.trend-hidden\) th:nth-child\(2\),[\s\S]*position: sticky;[\s\S]*left: 248px/);
});

test('latest statement period keeps its neutral label without special color styling', () => {
  assert.match(companySource, /periodLabel\(r, basisState\)\}<\/th>/);
  assert.doesNotMatch(companySource, /latest \? ' · Latest' : ''/);
  assert.match(systemCss, /#stmt-table:not\(\.trend-hidden\) th\.col-now,[\s\S]*width: 140px/);
  assert.doesNotMatch(systemCss, /#stmt-table \.col-now\s*\{[\s\S]*background:/);
});

test('statement striping alternates complete visible rows rather than individual cells', () => {
  assert.match(systemCss, /tr:nth-child\(odd of :not\(\[hidden\]\)\) td \{ background: #fff; \}/);
  assert.match(systemCss, /tr:nth-child\(even of :not\(\[hidden\]\)\) td \{ background: #f8f7f3; \}/);
  assert.doesNotMatch(systemCss, /td:not\(\.row-head\):nth-child\(2n/);
  assert.doesNotMatch(systemCss, /td:nth-child\(2\)[\s\S]{0,240}background: #faf9f6/);
});

test('statement units remain single-line and compact screens can hide and restore trends', () => {
  // Owner rule (10/17, replacing the 10/05 off-by-default rule): the table opens
  // with the 5Y-trend column shown; × hides it and "Show 5Y trend" brings it back.
  assert.match(companySource, /let showStatementTrend = true;/);
  assert.match(companyHtml, /id="stmt-trend-toggle"/);
  assert.match(companyHtml, /id="stmt-trend-toggle"[^>]*aria-expanded="true"[^>]*aria-controls="stmt-table"[^>]*\shidden>Show 5Y trend</);
  assert.match(companySource, /function setStatementTrendVisible\(visible\)/);
  assert.match(companySource, /class="stmt-trend-close"[^>]*aria-expanded="true"[^>]*aria-controls="stmt-table"/);
  assert.match(companySource, /table\.classList\.toggle\('trend-hidden'/);
  assert.match(companySource, /setAttribute\('aria-expanded', String\(showStatementTrend\)\)/);
  assert.match(systemCss, /#seg-view[\s\S]*grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/);
  assert.match(systemCss, /#seg-view button[\s\S]*white-space: nowrap/);
  assert.match(systemCss, /\.stmt-trend-close \{[\s\S]*display: inline-grid/);
  assert.doesNotMatch(systemCss, /\.stmt-trend-control/);
  assert.doesNotMatch(companySource, /compactTrendQuery/);
  assert.doesNotMatch(companySource, /matchMedia\('\(max-width: 1024px\)'\)/);
  assert.match(companySource, /function revealStatementTrendAtLatest\(\)/);
  assert.match(companySource, /toggle\.hidden = showStatementTrend/);
  assert.match(companySource, /wrap\.scrollLeft = latest/);
  assert.match(companySource, /requestAnimationFrame\(\(\) => requestAnimationFrame\(apply\)\)/);
  assert.match(companySource, /window\.addEventListener\('pageshow'/);
});

test('the masthead notice never prints a raw quote timestamp or market state', () => {
  // The retired line read "Quote as of 2026-10-02T20:00:01.000Z · Market
  // closed" — a raw ISO timestamp plus a market-state suffix, and a
  // different sentence on every stock. One notice, one shape now.
  assert.doesNotMatch(companySource, /Quote as of/);
  assert.doesNotMatch(companySource, /Market closed/);
  assert.doesNotMatch(companySource, /Provider quote may be delayed/);
  assert.match(companySource, /Data as of \$\{formatAsOf\(staleAsOf\)\}/);
});

test('growth mini bars distinguish negative values below a zero baseline', () => {
  assert.match(companySource, /viewState === 'yoy' \|\| min < 0/);
  assert.match(companySource, /is-negative/);
  assert.match(systemCss, /\.stmt-mini-bars\.is-signed::after/);
  assert.match(systemCss, /\.stmt-mini-bar\.is-negative/);
});

test('financial statements expose synchronized top and bottom horizontal scrollbars', () => {
  assert.match(companyHtml, /id="stmt-scroll-top"/);
  assert.match(companyHtml, /id="stmt-scroll-bottom"/);
  assert.match(companyHtml, /id="stmt-wrap" data-hbar="off"/);
  assert.match(companySource, /function wireStatementScrollbars/);
  assert.match(companySource, /bottom\.addEventListener\('scroll'/);
  assert.match(companySource, /wrap\.addEventListener\('scroll'/);
  assert.match(systemCss, /\.stmt-scroll-proxy/);
  assert.match(appSource, /wrap\.dataset\.hbar === 'off'/);
});

test('company page separates quote currency from financial-reporting currency', () => {
  assert.match(companySource, /function quoteCurrency\(data = payload\)/);
  assert.match(companySource, /function reportingCurrency\(data = payload\)/);
  assert.match(companySource, /function sourceReportingCurrency\(data = payload\)/);
  assert.match(companySource, /function hasCurrencyMismatch\(data = payload\)/);
  assert.match(companySource, /currencyAmount\(price, quoteCurrency\(\)/);
  assert.match(companySource, /Financial statements are shown in \$\{reportCur\}/);
  assert.match(companySource, /Financial statements are shown in USD, converted from \$\{sourceReportingCurrency\(\)\}/);
  assert.doesNotMatch(companyHtml, /All figures in USD from SEC filings/);
  assert.match(companyHtml, /data-view="usd">Reported</);
});

test('cross-currency listings do not run mixed-currency valuation visuals', () => {
  assert.match(companySource, /peButton\.hidden = mixedCurrencies/);
  assert.match(companySource, /if \(mixedCurrencies\) showCap = false/);
  assert.match(companySource, /Historical P\/E and price × filed-share-count overlays are disabled/);
  assert.match(companySource, /USD presentation conversion does not supply the listing’s depositary-share ratio/);
});

// 2026-10-10: two bank-only solo rows sat between Pre-tax income and its three
// components, so they rendered as orphans — always open, with no caret — and
// "Total long-term assets" had no component the SEC extraction could fill.
function statementDefinitions(name) {
  const start = companySource.indexOf(`        ${name}: [`);
  assert.ok(start > 0, `${name} statement definitions should be present`);
  const block = companySource.slice(start, companySource.indexOf('\n        ]', start));
  return [...block.matchAll(/\{\s*label:\s*'([^']+)'([^\n]*)/g)].map((match) => ({
    label: match[1],
    sub: /\bsub:\s*true\b/.test(match[2]),
    solo: /\bsolo:\s*true\b/.test(match[2]),
    source: match[2]
  }));
}

test('every indented statement row folds under a total, in all three statements', () => {
  for (const name of ['income', 'balance', 'cash']) {
    const grouped = groupDefinitions(statementDefinitions(name));
    assert.ok(grouped.length > 5, name);
    const orphans = grouped.filter((definition) => definition.sub && definition.gid === undefined);
    assert.deepEqual(orphans.map((definition) => definition.label), [], `${name} has rows that can never be collapsed`);
  }
});

test('pre-tax income unfolds into its interest and non-operating lines', () => {
  const grouped = groupDefinitions(statementDefinitions('income'));
  const pretax = grouped.find((definition) => definition.label === 'Pre-tax income');
  assert.deepEqual(
    grouped.filter((definition) => definition.gid === pretax.parentOf).map((definition) => definition.label),
    ['Interest income', 'Interest expense', 'Other non-operating income']
  );
});

test('total long-term assets unfolds into lines the SEC extraction supplies', () => {
  const { MAPS } = require('../sec-facts');
  const grouped = groupDefinitions(statementDefinitions('balance'));
  const total = grouped.find((definition) => definition.label === 'Total long-term assets');
  const children = grouped.filter((definition) => definition.gid === total.parentOf);
  assert.deepEqual(children.map((definition) => definition.label), [
    'Property, plant & equipment', 'Operating lease assets', 'Long-term investments', 'Goodwill',
    'Intangible assets', 'Deferred tax assets', 'Other long-term assets'
  ]);
  for (const field of ['propertyPlantEquipment', 'operatingLeaseRightOfUseAsset', 'longTermInvestments', 'goodwill',
    'intangibleAssetsExcludingGoodwill', 'deferredTaxAssets', 'otherNonCurrentAssets']) {
    assert.ok(MAPS.balance[field], `${field} is extracted`);
    assert.ok(children.some((definition) => definition.source.includes(`r.${field})`)), `${field} is shown`);
  }
});

// The page's own functions, cut from company.js and run against stub state.
function pageFunction(from, to, names, body) {
  const start = companySource.indexOf(from);
  const end = companySource.indexOf(to, start);
  assert.ok(start > 0 && end > start, `${from} is in company.js`);
  return new Function(...names, companySource.slice(start, end) + body);
}

test('the per-share view divides by the share count filed for that same period end', () => {
  const make = pageFunction('    function viewVals(', '    // statement-convention grouping', ['viewState', 'sharesByPeriod', 'sharesBasis', 'fixed', 'signedPct'], '\nreturn viewVals;');
  const shares = new Map([['2025-09-27', 15e9], ['2024-09-28', 15.5e9]]);
  const rows = [{ fiscalDateEnding: '2024-09-28' }, { fiscalDateEnding: '2025-09-27' }];
  const fixed = (v, d) => v.toFixed(d);
  const ps = make('ps', shares, 'period-end', fixed, null)({ kind: 'money', fmt: String }, [31e9, 30e9], rows);
  assert.deepEqual(ps.vals, [2, 2]);
  assert.equal(ps.fmt(2), '$2.00');
  // the cover page's count is today's, not any past year's
  assert.deepEqual(make('ps', new Map([['9999-12-31', 15e9]]), 'current', fixed, null)({ kind: 'money', fmt: String }, [31e9, 30e9], rows).vals, [null, null]);
});

test('a company that files no cost of revenue shows its filed cost lines under its own headings, annual only', () => {
  const build = pageFunction('    const FILED_GROUP = 900;', '    function groupDefs(', ['payload', 'stState', 'basisState', 'reportingCurrency', 'money', 'ROWS', 'noFcf'], '\nreturn { filedCostDefs, statementDefs, FILED_GROUP };');
  const make = (p, st, basis, cur, money, rows, noFcf = () => false) => build(p, st, basis, cur, money, rows, noFcf);
  const ROWS = { income: [{ label: 'Revenue', solo: true }, { label: 'Cost of revenue', solo: true }, { label: 'Gross profit' }] };
  const payload = { filedCosts: { currency: 'USD', heading: 'Costs and expenses', filing: { form: '10-K', accession: '0001104659-26-021292' }, lines: [
    { heading: true, label: 'Restaurant operating costs', depth: 0 },
    { label: 'Labor', depth: 1, values: { '2025-12-30': 1944416000 } },
    { label: 'Rent', depth: 1, values: { '2025-12-30': 92321000 } },
    { label: 'Total costs and expenses', total: true, depth: 0, values: { '2025-12-30': 5403335000 } }
  ] } };
  const page = make(payload, 'income', 'annual', () => 'USD', String, ROWS);
  const defs = page.statementDefs(false);
  assert.deepEqual(defs.map((d) => d.label), ['Revenue', 'Cost of revenue', 'Costs and expenses', 'Restaurant operating costs', 'Labor', 'Rent', 'Gross profit']);
  const parent = defs[2];
  assert.equal(parent.filed, true);
  assert.equal(parent.get({ fiscalDateEnding: '2025-12-30' }), 5403335000);
  assert.equal(defs[3].heading, true);
  assert.equal(defs[4].get({ fiscalDateEnding: '2025-12-30' }), 1944416000);
  assert.equal(defs[4].get({ fiscalDateEnding: '2019-12-31' }), null);
  assert.equal(defs[4].depth, 1);
  // filed cost lines fold under their heading row like every other group
  const grouped = groupDefinitions(defs);
  assert.deepEqual(grouped.filter((d) => d.gid === grouped[2].parentOf).map((d) => d.label), ['Restaurant operating costs', 'Labor', 'Rent']);
  // not in the quarterly view, not converted to another currency, not in a different currency
  assert.equal(make(payload, 'income', 'quarterly', () => 'USD', String, ROWS).statementDefs(false), ROWS.income);
  assert.equal(page.statementDefs(true), ROWS.income);
  assert.equal(make(payload, 'income', 'annual', () => 'EUR', String, ROWS).statementDefs(false), ROWS.income);
  assert.equal(make({}, 'income', 'annual', () => 'USD', String, ROWS).statementDefs(false), ROWS.income);
  // a bank or life insurer has no free cash flow row (owner, 2026-10-19)
  const CASH = { cash: [{ label: 'Operating cash flow' }, { label: 'Free cash flow', fcf: true }] };
  assert.deepEqual(make({}, 'cash', 'annual', () => 'USD', String, CASH, () => true).statementDefs(false).map((d) => d.label), ['Operating cash flow']);
  assert.equal(make({}, 'cash', 'annual', () => 'USD', String, CASH).statementDefs(false), CASH.cash);
});
