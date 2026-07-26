const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PAGE_PATH = path.join(__dirname, '..', '..', 'frontend-v2', 'appsumo.html');
const html = fs.readFileSync(PAGE_PATH, 'utf8');

test('AppSumo landing page keeps every purchase CTA on the tracked bridge', () => {
  const ctas = [...html.matchAll(/<a\b[^>]*data-appsumo-cta="[^"]+"[^>]*>/g)];
  assert.ok(ctas.length >= 4, 'expected purchase CTAs across the landing page');
  for (const [tag] of ctas) assert.match(tag, /href="\/go\/appsumo\/bridge"/);
});

test('AppSumo landing page states the verified tier prices and monthly Ask limits', () => {
  for (const price of ['$39', '$79', '$149']) assert.ok(html.includes(price), `missing ${price}`);
  for (const limit of ['30', '100', '300']) {
    assert.match(html, new RegExp(`<strong>${limit}</strong>\\s*Ask questions / month`));
  }
  assert.match(html, /AppSumo[^<]{0,80}live listing[^<]{0,120}final (authority|deal terms)/i);
});

test('AppSumo landing page avoids absolute AI and coverage promises', () => {
  assert.doesNotMatch(html, /never hallucinates|cannot hallucinate|guaranteed accurate/i);
  assert.doesNotMatch(html, /every US-listed company (?:has|gets|includes)/i);
  assert.match(html, /No AI (?:or extraction pipeline )?is infallible/i);
});

test('AppSumo structured-data blocks contain valid JSON', () => {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  assert.ok(blocks.length >= 2);
  for (const [, json] of blocks) assert.doesNotThrow(() => JSON.parse(json));
});

test('embedded demo assets exist', () => {
  for (const relative of ['assets/appsumo-verification.png', 'assets/tour-1080p.mp4', 'assets/tour-720p.mp4']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', '..', 'frontend-v2', relative)), `${relative} is missing`);
  }
});
