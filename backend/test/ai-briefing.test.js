const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { computePortfolioFacts, buildTemplateBriefing } = require('../ai-briefing');

test('weekly briefing explicitly includes ETF positions in mixed portfolios', () => {
  const facts = computePortfolioFacts([
    { symbol: 'AAPL', assetType: 'stock', shares: 2, purchasePrice: 100, currentPrice: 110, sector: 'Technology' },
    { symbol: 'QQQ', assetType: 'etf', shares: 3, purchasePrice: 200, currentPrice: 220, category: 'Large Blend' }
  ]);

  assert.equal(facts.fundPositions.length, 1);
  assert.equal(facts.fundPositions[0].symbol, 'QQQ');
  assert.match(buildTemplateBriefing(facts), /ETF and mutual-fund positions are included/);
  assert.match(buildTemplateBriefing(facts), /QQQ \(ETF,/);
  assert.match(buildTemplateBriefing(facts), /Company-only filing metrics are not applied/);
});

test('weekly briefing keeps fund positions out of company-only filing claims', () => {
  const facts = computePortfolioFacts([
    { symbol: 'VTSAX', assetType: 'mutual_fund', shares: 1, purchasePrice: 100, currentPrice: 95, category: 'Total Market' }
  ]);
  const text = buildTemplateBriefing(facts);
  assert.match(text, /mutual fund/);
  assert.doesNotMatch(text, /10-K|10-Q|filed/);
});

test('dashboard renders briefing facts as a structured mixed-portfolio readout', () => {
  const root = path.resolve(__dirname, '..', '..');
  const dashboard = fs.readFileSync(path.join(root, 'frontend-v2/assets/dashboard.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'frontend-v2/dashboard.html'), 'utf8');
  assert.match(dashboard, /function renderBriefing\(data\)/);
  assert.match(dashboard, /Funds in this portfolio/);
  assert.match(dashboard, /Sector and fund-category labels are unavailable/);
  assert.match(html, /Company filing alerts/);
  assert.match(html, /This is not a price-move feed/);
});
