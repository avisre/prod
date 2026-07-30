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
  assert.match(systemCss, /#stmt-table th:nth-child\(n \+ 3\)/);
  assert.match(systemCss, /#stmt-table \.col-now/);
  assert.match(systemCss, /content: "Latest"/);
});

test('company page cache-busts the approved statement assets together', () => {
  assert.match(companyHtml, /assets\/system\.css\?v=20260730-minibars1/);
  assert.match(companyHtml, /assets\/company\.js\?v=20260730-minibars1/);
});

test('financial statements use five-period mini bars instead of sparklines', () => {
  assert.match(companySource, /function statementMiniBars\(values, periods, fmt\)/);
  assert.match(companySource, /Five-year trend/);
  assert.match(companySource, /Five-quarter trend/);
  assert.match(companySource, /statementMiniBars\(vals, lastRender\.periods, fmt\)/);
  assert.doesNotMatch(companySource, /sparkline\(sparkVals/);
  assert.match(systemCss, /\.stmt-mini-bars/);
  assert.match(systemCss, /\.stmt-mini-bar\.is-latest \{ background: var\(--accent\); \}/);
  assert.match(systemCss, /#stmt-table th:nth-child\(2\),[\s\S]*position: sticky;[\s\S]*left: 228px;/);
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
