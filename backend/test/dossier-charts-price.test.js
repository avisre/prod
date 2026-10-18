// Dossier charts, the share price and where past dossiers are listed.
// The chart helpers run out of the shipped frontend-v2/assets/dossier.js, lifted
// out by source markers as dossier-sankey.test.js does, so a fix cannot drift
// from what browsers run.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');
const SRC = fs.readFileSync(path.join(ROOT, 'frontend-v2', 'assets', 'dossier.js'), 'utf8');
const slice = (from, to) => {
    const start = SRC.indexOf(from);
    const end = SRC.indexOf(to);
    assert.ok(start > 0 && end > start, `source markers moved (${from}) — update this test`);
    return SRC.slice(start, end);
};

function load() {
    const ctx = {
        C: { ink: '#1c1b18', accent: '#1a4fd6', pos: '#1b7a4b', neg: '#b4422f', grey: '#8a877e', faint: '#e7e4dd' },
        esc: (v) => String(v == null ? '' : v)
    };
    vm.createContext(ctx);
    vm.runInContext(slice('  const fyOf = ', '  (function wireChartReadouts(') + slice('  function miniBars(', '  function decisionTrends(') +
        '\n;globalThis.__f = { chartBars, chartGroupedBars, miniBars, trendChangeLine };', ctx);
    return ctx.__f;
}
const { chartBars, chartGroupedBars, miniBars, trendChangeLine } = load();

// TXRH's shape: operating margin every year, ROIC only where total debt was filed.
const HISTORY = [
    { fy: '2018', opMarginPct: 7.6, roicPct: null },
    { fy: '2019', opMarginPct: 7.5, roicPct: null },
    { fy: '2020', opMarginPct: 1.0, roicPct: 2.1 },
    { fy: '2021', opMarginPct: 7.9, roicPct: null },
    { fy: '2022', opMarginPct: 8.0, roicPct: 24.3 },
    { fy: '2025', opMarginPct: 8.1, roicPct: null }
];

test('a year without a filed ROIC draws no bar, not a zero stub', () => {
    const svg = chartGroupedBars(HISTORY, [{ key: 'opMarginPct', color: 'grey' }, { key: 'roicPct', color: 'green' }]);
    assert.equal((svg.match(/<rect[^>]*fill="grey"/g) || []).length, 5, 'the last five years, 2018 drops off');
    assert.equal((svg.match(/<rect[^>]*fill="green"/g) || []).length, 2, 'only 2020 and 2022 filed a ROIC');
});

test('every chart shows the last five fiscal years only', () => {
    const rows = ['2018', '2019', '2020', '2021', '2022', '2023', '2024', '2025'].map((fy, i) => ({ fy, revenue: 100 + i, ni: 10 + i, cash: 5 + i }));
    const bars = chartBars(rows, 'revenue', (v) => '$' + v);
    assert.equal((bars.match(/data-read="FY/g) || []).length, 5);
    assert.doesNotMatch(bars, /FY2020|FY201/, 'nothing before FY2021');
    const grouped = chartGroupedBars(rows, [{ key: 'ni', label: 'Net income', color: 'grey' }, { key: 'cash', label: 'Cash on hand', color: 'green' }]);
    assert.equal((grouped.match(/data-read="FY/g) || []).length, 5);
    assert.match(grouped, /data-read="FY2021:/);
    assert.doesNotMatch(grouped, /data-read="FY2020:/);
    assert.match(slice('  function decisionTrends(', '  function deterministicBrief('), /fin = lastYears\(fin\);/, 'the trajectory strip and its span cover the same five years');
});

test('every year chart reads out its numbers, latest year by default, any year on hover or tap', () => {
    const bars = chartBars([{ fy: '2024', revenue: 100 }, { fy: '2025', revenue: 111 }], 'revenue', (v) => '$' + v);
    assert.match(bars, /data-readout data-default="FY2025: \$111 · \+11\.0% vs FY2024"/);
    assert.match(bars, /data-read="FY2024: \$100"/, 'each year is a hit column carrying its own figure');
    assert.equal((bars.match(/class="dos-bar-val"/g) || []).length, 2, 'the value is printed over every bar');
    const grouped = chartGroupedBars(HISTORY, [{ key: 'opMarginPct', label: 'Operating margin', fmt: (v) => v + '%', color: 'grey' }, { key: 'roicPct', label: 'ROIC', fmt: (v) => v + '%', color: 'green' }]);
    assert.match(grouped, /data-read="FY2022: Operating margin 8% · ROIC 24\.3%"/);
    assert.match(miniBars(HISTORY, 'roicPct', 'ink', (v) => v + '%'), /data-read="FY2022: 24\.3%"/);
});

test('a two-series chart reads its figures out in the line above, as Revenue does, never on the bars', () => {
    const rows = [{ fy: '2022', ni: -140, fcf: -154 }, { fy: '2023', ni: 11, fcf: -101 }, { fy: '2025', ni: 205, fcf: null }];
    const svg = chartGroupedBars(rows, [{ key: 'ni', label: 'Net income', fmt: (v) => '$' + v, color: 'grey' }, { key: 'fcf', label: 'Free cash flow', fmt: (v) => '$' + v, color: 'green' }]);
    assert.doesNotMatch(svg, /dos-bar-val/, 'no figures on the bars');
    assert.match(svg, /<rect[^>]*fill="#b4422f"/, 'a loss bar is red');
    assert.match(svg, /data-readout data-default="FY2025: Net income \$205 · Free cash flow not filed"/, 'the latest year shows by default');
    assert.match(svg, /data-read="FY2022: Net income \$-140 · Free cash flow \$-154"/, 'hovering a year shows its figures');
    assert.doesNotMatch(svg, /dos-side/, 'no readout column beside the bars squeezing them');
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, 'frontend-v2', 'dossier.html'), 'utf8'), /dos-side/);
});

test('one figure on a near-zero base is drawn broken instead of flattening every other year', () => {
    // FRGT's operating margin: -668,808.7% in 2020 on almost no revenue.
    const rows = [{ fy: '2019', m: -45.9 }, { fy: '2020', m: -668808.7 }, { fy: '2021', m: -22.4 }, { fy: '2024', m: -47.3 }, { fy: '2025', m: -45.1 }];
    const svg = chartGroupedBars(rows, [{ key: 'm', label: 'Operating margin', fmt: (v) => v + '%', color: 'grey' }]);
    const h = [...svg.matchAll(/<rect class="dos-bar"[^>]* height="([\d.]+)"/g)].map((m) => Number(m[1]));
    assert.ok(Math.min(...h) > 20, `the ordinary years keep a readable height (${h})`);
    assert.equal((svg.match(/dos-bar-break/g) || []).length, 1, 'only the outlier is broken');
    assert.match(svg, /data-read="FY2020: Operating margin -668808\.7%"/, 'the readout still gives the filed figure');
    const plain = chartGroupedBars(rows.filter((r) => r.fy !== '2020'), [{ key: 'm', label: 'Operating margin', color: 'grey' }]);
    assert.doesNotMatch(plain, /dos-bar-break/, 'an ordinary spread is never broken');
});

test('Earnings and cash and Margins and returns are combined charts again', () => {
    assert.match(SRC, /<h3>Earnings and cash<\/h3>.*chartGroupedBars\(fin, \[\{ key: 'netIncome'.*\{ key: 'cashOnHand', label: 'Cash on hand'/);
    assert.match(SRC, /<h3>Margins and returns<\/h3>.*chartGroupedBars\(fin, \[\{ key: 'opMarginPct'.*\{ key: 'roicPct'/);
    assert.doesNotMatch(SRC, /fmt: \(v\) => v \+ '%'/, 'a negative margin reads "-45.1%" beside "−$8M"; use the same minus sign');
});

test('the charts scale with their width instead of a fixed height that letterboxes them', () => {
    const svg = chartGroupedBars(HISTORY, [{ key: 'opMarginPct', color: 'grey' }]);
    assert.match(svg, /height:auto/);
    assert.doesNotMatch(slice('  function chartBars(', '  function chartGroupedBars('), /height:160px/);
});

test('the trajectory mini bars skip a missing year', () => {
    assert.equal((miniBars(HISTORY, 'roicPct', 'ink').match(/<i /g) || []).length, 2);
    assert.equal(miniBars([{ x: null }, { x: 5 }], 'x', 'ink'), '', 'one real point is not a trend');
});

test('the first-to-latest change needs both endpoints, so a missing one is not read as 0%', () => {
    assert.equal(trendChangeLine(HISTORY, 'roicPct', true), '');
    assert.equal(trendChangeLine(HISTORY, 'opMarginPct', true), '+0.5 pts');
});

test('the dossier shows the share price, and values each scenario per share', () => {
    assert.match(SRC, /\['Share price', price \? px\(price\) : '—'\]/);
    assert.match(SRC, /const perShare = price && num\(sc\.currentMarketCap\) > 0/);
    assert.match(SRC, /price \* num\(x\.value\) \/ num\(sc\.currentMarketCap\)/);
    // A fresh build carries the price too, not only a cache hit's valuation refresh.
    const dossierBackend = fs.readFileSync(path.join(ROOT, 'backend', 'dossier.js'), 'utf8');
    assert.match(dossierBackend, /marketCap: mc,\n\s+price: num\(data\.marketData\?\.price\),/);
});

test('past dossiers are listed on the dossier page, not the portfolio page', () => {
    const dashHtml = fs.readFileSync(path.join(ROOT, 'frontend-v2', 'dashboard.html'), 'utf8');
    const dashJs = fs.readFileSync(path.join(ROOT, 'frontend-v2', 'assets', 'dashboard.js'), 'utf8');
    const dosHtml = fs.readFileSync(path.join(ROOT, 'frontend-v2', 'dossier.html'), 'utf8');
    assert.doesNotMatch(dashHtml, /recent-research/);
    assert.doesNotMatch(dashJs, /dossier-history\/recent/);
    assert.match(dosHtml, /id="dos-recent"/);
    assert.match(SRC, /dossier-history\/recent/);
});
