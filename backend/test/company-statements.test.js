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

test('revenue expands cost of revenue and gross margin, not gross profit', () => {
  const grouped = groupDefinitions(incomeDefinitions());
  const byLabel = Object.fromEntries(grouped.map((definition) => [definition.label, definition]));

  assert.deepEqual(
    grouped.slice(0, 4).map((definition) => definition.label),
    ['Revenue', 'Cost of revenue', 'Gross margin', 'Gross profit']
  );
  assert.equal(byLabel.Revenue.parentOf, byLabel['Cost of revenue'].gid);
  assert.equal(byLabel.Revenue.parentOf, byLabel['Gross margin'].gid);
  assert.equal(byLabel['Gross profit'].gid, undefined);
  assert.equal(byLabel['Gross profit'].parentOf, undefined);
});

test('revenue components are hidden when collapsed and visible when expanded', () => {
  const grouped = groupDefinitions(incomeDefinitions());
  const revenue = grouped.find((definition) => definition.label === 'Revenue');
  const children = grouped.filter((definition) => definition.gid === revenue.parentOf);

  assert.deepEqual(children.map((definition) => definition.label), ['Cost of revenue', 'Gross margin']);
  assert.ok(children.every((definition) => !new Set().has(definition.gid)));
  assert.ok(children.every((definition) => new Set([revenue.parentOf]).has(definition.gid)));
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
  assert.match(systemCss, /#stmt-table:not\(\.trend-hidden\)[\s\S]*left: 228px/);
  assert.match(systemCss, /font-variant-numeric:\s*tabular-nums lining-nums/);
});

test('company page cache-busts the approved statement assets together', () => {
  // system.css and company.js are approved as a pair — the statement table's
  // markup and its styles have to ship together or the page renders broken.
  // Stamp bumped 2026-08-29 with the nav/account-dropdown change, which edits
  // system.css site-wide; company.js follows so the pair stays in lockstep.
  assert.match(companyHtml, /assets\/system\.css\?v=20260907-aipaper3/);
  assert.match(companyHtml, /assets\/company\.js\?v=20260907-creditmeter1/);
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
  assert.match(systemCss, /#stmt-table:not\(\.trend-hidden\) th:nth-child\(2\),[\s\S]*position: sticky;[\s\S]*left: 228px/);
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
  assert.match(companySource, /let showStatementTrend = true;/);
  assert.match(companyHtml, /id="stmt-trend-toggle"/);
  assert.match(companyHtml, /id="stmt-trend-toggle"[^>]*aria-expanded="true"[^>]*aria-controls="stmt-table"[^>]*hidden/);
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
