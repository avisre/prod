'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const seo = require('../seo-pages');
const extra = require('../seo-extra');

const root = path.join(__dirname, '..', '..');

test('ordinary SEO render exposes answer, evidence and source without AI calls', () => {
  const pages = [
    seo.renderStockPage('AAP'),
    extra.renderMetricPage('AAP', 'free-cash-flow'),
    extra.renderMetricPage('WAB', 'eps'),
    extra.renderMetricPage('NVDA', 'revenue'),
    extra.renderMetricPage('AAPL', 'shares-outstanding'),
  ];
  assert.ok(pages.every(Boolean));
  for (const html of pages) {
    assert.match(html, /<h1\b/i);
    assert.match(html, /SEC (?:EDGAR|filings)/i);
    assert.match(html, /<table\b/i);
    assert.doesNotMatch(html, /ollama|openai\.com\/v1|\/api\/ai/i);
  }
});

test('stock page carries the claim-check widget pre-filled with the ticker', () => {
  const html = seo.renderStockPage('AAP');
  assert.match(html, /See a claim about/);
  assert.match(html, /Check it against the filing/);
  assert.match(html, /id="cc-ticker"[^>]*value="AAP"/);
  assert.match(html, /id="cc-go"/);
  assert.match(html, /\/api\/verify/);
  assert.match(html, /vf-bars/); // plain-language bar comparison, not a bare delta
});

test('AAP FCF opening answer identifies derived inputs before the history', () => {
  const html = extra.renderMetricPage('AAP', 'free-cash-flow');
  const h1 = html.indexOf('<h1');
  const history = html.indexOf('history by fiscal year');
  assert.ok(h1 >= 0 && history > h1);
  const firstScreen = html.slice(h1, history);
  assert.match(firstScreen, /free cash flow/i);
  assert.match(firstScreen, /operating cash flow/i);
  assert.match(firstScreen, /capital expenditures/i);
  assert.match(firstScreen, /OCF − capex/);
});

test('SEO control-plane outputs are present and no tracking URLs enter sitemap', () => {
  const docs = path.join(root, 'docs', 'seo');
  for (const name of ['architecture-audit.md', 'production-baseline.json', 'production-baseline.md', 'query-page-ownership.csv', 'query-page-ownership.md', 'google-opportunities.csv', 'bing-opportunities.csv', 'sitemap-audit.md', 'internal-metric-link-audit.md', 'bing-ai-performance.csv']) {
    assert.ok(fs.existsSync(path.join(docs, name)), name);
  }
  const xml = seo.buildSitemap();
  assert.doesNotMatch(xml, /[?&](?:source|content_id|click_id)=/i);
  assert.doesNotMatch(xml, /\/admin\/|\/dashboard\/|\/login\b/i);
});
