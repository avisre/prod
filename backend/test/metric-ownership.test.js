'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const extra = require('../seo-extra');
const seo = require('../seo-pages');

const root = path.join(__dirname, '..', '..');

test('WAB metric pages have distinct answer-first content and no malformed history title', () => {
  const pages = ['eps', 'shares-outstanding', 'dividend-history'].map((slug) => extra.renderMetricPage('WAB', slug));
  assert.ok(pages.every(Boolean));
  const titles = pages.map((html) => html.match(/<title>([\s\S]*?)<\/title>/i)[1]);
  assert.equal(new Set(titles).size, 3);
  assert.ok(titles.every((title) => !/History History/i.test(title)));
  // Answer-first (the redesign's shape): the latest filed value leads, with its
  // period and SEC source, before the fiscal-year history table.
  for (const html of pages) {
    const opening = html.indexOf('Latest filed value');
    const table = html.indexOf('history by fiscal year');
    assert.ok(opening !== -1 && table !== -1 && opening < table, 'the filed value leads and the history table follows');
  }
  assert.match(pages[0], /period end \d{4}-\d{2}-\d{2}[\s\S]*SEC EDGAR/);
  // Each history row names its own basis; a derived figure can never hide
  // behind the same label as a filed one.
  for (const html of pages) assert.match(html, /<td>(Reported|Calculated)<\/td>/);
  assert.match(pages[0], /Wabtec: Earnings per share/);
  assert.match(pages[1], /Wabtec: Shares outstanding/);
  assert.match(pages[2], /Wabtec: Dividend payouts/);
  assert.match(pages[0], /history by fiscal year/);
  assert.doesNotMatch(pages[2], /Dividend History history/i);
});

test('metric navigation uses exact destination labels', () => {
  const html = seo.renderStockPage('WAB');
  assert.match(html, /href="\/stocks\/WAB\/eps">Earnings per share<\/a>/);
  assert.match(html, /href="\/stocks\/WAB\/shares-outstanding">Shares outstanding<\/a>/);
  assert.match(html, /href="\/stocks\/WAB\/dividend-history">Dividend payouts<\/a>/);
  assert.doesNotMatch(html, /href="\/stocks\/WAB\/eps">WAB .*eps<\/a>/i);
});

test('existing symbol resolver canonicalizes class shares to one stored symbol', () => {
  for (const input of ['BRK.B', 'BRK/B', 'BRK B', 'BRK-B']) assert.equal(seo.resolveCanonicalSymbol(input), 'BRK.B');
  assert.equal(seo.resolveCanonicalSymbol('BF.B'), 'BF.B');
  assert.equal(seo.resolveCanonicalSymbol('aapl'), 'AAPL');
  assert.equal(seo.resolveCanonicalSymbol('not-a-real-symbol'), null);
  const aliasHtml = seo.renderStockPage('BRK-B');
  assert.match(aliasHtml, /<link rel="canonical" href="https:\/\/www\.stockportfolio\.pro\/stocks\/BRK\.B"/);
});

test('ownership audit and similarity artifacts are present without adding sitemap URLs', () => {
  const data = path.join(root, 'seo-data');
  for (const name of ['metric-ownership-audit.csv', 'metric-ownership-audit.md', 'internal-metric-link-audit.md', 'metric-authority-flow-audit.md', 'metric-page-similarity.md', 'metric-ownership-measurement-plan.md']) {
    assert.ok(fs.existsSync(path.join(data, name)), `${name} exists`);
  }
  const sitemap = seo.buildSitemapShard('core');
  assert.equal((sitemap.match(/<loc>https:\/\/www\.stockportfolio\.pro\/stocks\/WAB\//g) || []).length, 0);
  assert.doesNotMatch(sitemap, /ask\?symbol=/);
});
