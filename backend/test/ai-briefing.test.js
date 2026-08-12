const test = require('node:test');
const assert = require('node:assert/strict');
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
