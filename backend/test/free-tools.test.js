'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const freeTools = require('../free-tools');

function fixture(overrides = {}) {
    return {
        overview: { reportedCurrency: 'USD' },
        income: { annualReports: [
            { fiscalDateEnding: '2025-12-31', reportedCurrency: 'USD', totalRevenue: '1000', netIncome: '100' },
            { fiscalDateEnding: '2024-12-31', reportedCurrency: 'USD', totalRevenue: '900', netIncome: '80' }
        ] },
        cash: { annualReports: [
            { fiscalDateEnding: '2025-12-31', reportedCurrency: 'USD', operatingCashflow: '120', capitalExpenditures: '-20' },
            { fiscalDateEnding: '2024-12-31', reportedCurrency: 'USD', operatingCashflow: '90', capitalExpenditures: '-15' }
        ] },
        balance: { annualReports: [
            { fiscalDateEnding: '2025-12-31', reportedCurrency: 'USD', commonStockSharesOutstanding: '110' },
            { fiscalDateEnding: '2024-12-31', reportedCurrency: 'USD', commonStockSharesOutstanding: '100' }
        ] },
        ...overrides
    };
}

test('free tools normalize ticker symbols and reject unsafe input', () => {
    assert.equal(freeTools.normalizeSymbol(' aapl '), 'AAPL');
    assert.equal(freeTools.normalizeSymbol('BRK.B'), 'BRK.B');
    assert.equal(freeTools.normalizeSymbol('AAPL?x=1'), null);
    assert.equal(freeTools.normalizeSymbol(''), null);
});

test('earnings quality computes matching-period cash conversion and free cash flow', () => {
    const result = freeTools.computeEarningsQuality('TEST', fixture(), '2026-07-28T00:00:00.000Z');
    assert.equal(result.comparablePeriods, true);
    assert.equal(result.revenue, 1000);
    assert.equal(result.netIncome, 100);
    assert.equal(result.operatingCashFlow, 120);
    assert.equal(result.freeCashFlow, 100);
    assert.equal(result.cashConversionRatio, 1.2);
    assert.equal(result.warnings.length, 0);
    assert.match(result.sourceUrl, /sec\.gov\/edgar\/search/);
});

test('earnings quality warns for missing and zero values without throwing', () => {
    const data = fixture({
        income: { annualReports: [{ fiscalDateEnding: '2025-12-31', totalRevenue: '0', netIncome: '0' }] },
        cash: { annualReports: [] }
    });
    const result = freeTools.computeEarningsQuality('TEST', data);
    assert.equal(result.comparablePeriods, false);
    assert.equal(result.cashConversionRatio, null);
    assert.ok(result.warnings.length >= 3);
});

test('dilution computes normal change and labels split-sized changes not comparable', () => {
    const normal = freeTools.computeDilution('TEST', fixture());
    assert.equal(normal.comparablePeriods, true);
    assert.equal(normal.change, 10);
    assert.equal(normal.percentageChange, 10);

    const split = freeTools.computeDilution('TEST', fixture({ balance: { annualReports: [
        { fiscalDateEnding: '2025-12-31', commonStockSharesOutstanding: '200' },
        { fiscalDateEnding: '2024-12-31', commonStockSharesOutstanding: '100' }
    ] } }));
    assert.equal(split.splitSuspected, true);
    assert.equal(split.comparablePeriods, false);
    assert.equal(split.change, null);
    assert.equal(split.percentageChange, null);
    assert.match(split.warnings[0], /not directly comparable/);
});

test('tool pages expose canonical metadata, source CTA and no authentication requirement', () => {
    assert.equal(Object.keys(freeTools.TOOL_DEFINITIONS).length, 30);
    for (const slug of Object.keys(freeTools.TOOL_DEFINITIONS)) {
        const html = freeTools.renderToolPage(slug);
        assert.match(html, new RegExp(`canonical" href="https://www\\.stockportfolio\\.pro/tools/${slug}`));
        assert.match(html, /application\/ld\+json/);
        assert.match(html, /rel="icon" type="image\/png" sizes="48x48" href="\/Media\/icon\.png\?v=20260729-favicon1"/);
        assert.match(html, /rel="apple-touch-icon" href="\/Media\/icon\.png\?v=20260729-favicon1"/);
        assert.match(html, /content_id=tool-/);
        assert.match(html, /api\/free-tools/);
    }
});

test('all fundamentals-backed calculators return implemented deterministic results', async () => {
    const tools = [
        'earnings-quality', 'dilution', 'filing-change', 'revenue-consistency',
        'profitability-trend', 'cash-flow-quality', 'free-cash-flow-trend',
        'working-capital', 'debt-snapshot', 'buybacks-vs-dilution',
        'stock-compensation', 'dividend-safety', 'interest-coverage',
        'balance-sheet-signals', 'goodwill-concentration', 'receivables-warning',
        'inventory-warning', 'ask-question-builder'
    ];
    for (const tool of tools) {
        const result = await freeTools.getToolResult(tool, 'AAPL');
        assert.equal(result.status, 200, `${tool}: ${JSON.stringify(result.body)}`);
        assert.equal(result.body.tool, tool);
        assert.equal(result.body.error, undefined);
    }
});

test('cached multi-company tools return rows without invoking AI', async () => {
    for (const tool of ['portfolio-revenue', 'portfolio-dilution', 'company-comparison', 'peer-cash-conversion']) {
        const result = await freeTools.getToolResult(tool, 'AAPL,MSFT');
        assert.equal(result.status, 200, `${tool}: ${JSON.stringify(result.body)}`);
        assert.ok(result.body.rows.length > 0);
    }
});

test('expanded catalog renderer has 30 unique routes and parseable browser JavaScript', () => {
    const definitions = Object.values(freeTools.TOOL_DEFINITIONS);
    assert.equal(new Set(definitions.map((tool) => tool.id)).size, 30);
    assert.equal(new Set(definitions.map((tool) => tool.path)).size, 30);
    const html = freeTools.renderToolPage('filing-change');
    const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gi)].map((match) => match[1]);
    assert.equal(scripts.length, 1);
    assert.doesNotThrow(() => new Function(scripts[0]));
    assert.match(html, /assets\/system\.css/);
    assert.match(html, /V2\.nav\('tools'\);V2\.footer\(\)/);
    assert.match(html, /id="tool-suggestions"/);
    assert.match(html, /V2\.searchAssets/);
    assert.match(html, /ArrowDown/);
    assert.match(html, /@media\(max-width:650px\)[\s\S]*\.tool-input-wrap,.form button\{width:100%/);
    assert.match(html, /return compact\(n,'\$'\)/);
    assert.match(html, /1e9[\s\S]*'B'/);
    assert.match(html, /1e6[\s\S]*'M'/);
    const index = freeTools.renderToolIndex();
    assert.equal((index.match(/Open tool/g) || []).length, 30);
    assert.match(index, /V2\.nav\('tools'\)/);
    assert.match(index, /rel="icon" type="image\/png" sizes="48x48" href="\/Media\/icon\.png\?v=20260729-favicon1"/);
});

test('shared tools navbar renders the StockPortfolio emblem', () => {
    const app = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'app.js'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', 'system.css'), 'utf8');
    assert.match(app, /class="wordmark-emblem" src="\/Media\/icon\.png"/);
    assert.match(app, /aria-label="StockPortfolio\.pro home"/);
    assert.match(css, /\.wordmark-emblem\s*\{/);
    assert.match(freeTools.renderToolIndex(), /app\.js\?v=20260830-askui1/);
});
