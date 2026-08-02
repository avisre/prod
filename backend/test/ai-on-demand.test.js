const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const backend = (name) => fs.readFileSync(path.join(__dirname, '..', name), 'utf8');
const frontend = (name) => fs.readFileSync(path.join(__dirname, '..', '..', 'frontend-v2', 'assets', name), 'utf8');

test('passive stock and portfolio surfaces contain no provider client', () => {
  for (const file of ['analyst-take.js', 'ai-briefing.js', 'attribution.js']) {
    const source = backend(file);
    assert.doesNotMatch(source, /require\(['"]\.\/ai-client['"]\)/, `${file} must remain deterministic`);
    assert.doesNotMatch(source, /aiClient\.(chat|chatRaw|chatRawStream)\(/, `${file} must not call a model`);
  }
});

test('public analyst take returns deterministic prose without background generation', () => {
  const analystTake = require('../analyst-take');
  const result = analystTake.getTake('ZZZZ', {
    sym: 'ZZZZ', name: 'Example Corp', latestFY: '2025', revLatest: '$1.0B',
    healthTotal: 5, healthPassed: 4, redFlagsCount: 0
  });
  assert.equal(result.source, 'template');
  assert.match(result.take, /Example Corp/);
});

test('key-point AI generation requires the explicit authenticated Insights Pro request', () => {
  const app = backend('app.js');
  const company = frontend('company.js');
  assert.match(app, /const generate = String\(req\.query\.generate \|\| ''\) === '1'/);
  assert.match(app, /generate && !req\.user/);
  assert.match(app, /generate && !isProUser\(req\)/);
  assert.match(app, /allowAi: generate && isProUser\(req\)/);
  assert.match(company, /renderDossier\(true\)/);
  assert.match(company, /\?generate=1/);
  assert.match(company, /const open = \(\) => \{ drawer\.classList\.add\('open'\); dim\.hidden = false; loadInsights\(\); \}/);
});

test('portfolio briefing remains useful while deterministic', async () => {
  const briefing = require('../ai-briefing');
  const result = await briefing.generateBriefing([
    { symbol: 'AAPL', name: 'Apple', shares: 2, purchasePrice: 100, currentPrice: 120, sector: 'Technology' }
  ]);
  assert.equal(result.source, 'template');
  assert.match(result.briefing, /AAPL/);
  assert.equal(briefing.AI_CONFIGURED, false);
});
