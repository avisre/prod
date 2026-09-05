const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PAGE_PATH = path.join(__dirname, '..', '..', 'frontend-v2', 'appsumo.html');
const html = fs.readFileSync(PAGE_PATH, 'utf8');

test('AppSumo landing page keeps every purchase CTA on the tracked bridge', () => {
  const ctas = [...html.matchAll(/<a\b[^>]*data-appsumo-cta="[^"]+"[^>]*>/g)];
  assert.ok(ctas.length >= 4, 'expected purchase CTAs across the landing page');
  for (const [tag] of ctas) assert.match(tag, /href="\/go\/appsumo\/bridge(?:\?[^"]*)?"/);
});

test('AppSumo landing page states the verified tier prices, Monitor caps and Ask limits', () => {
  for (const price of ['$39', '$79', '$149']) assert.ok(html.includes(price), `missing ${price}`);
  // Listing v4 leads with the Monitor cap, now 1/4/8 — LTD_MONITOR_CAP_V2 in
  // lib/tier-limits.js. The page may legitimately differ from what the product
  // currently grants: buyers who redeemed before MONITOR_CAP_V2_EFFECTIVE_FROM
  // are grandfathered at 12/40/unlimited, and while that cutover is unset the
  // code over-delivers against this copy. Over-delivery is the safe direction;
  // the reverse (promising more than the tier gives) is what must never ship.
  for (const cap of ['1 company', '4 companies', '8 companies']) {
    assert.match(html, new RegExp(`<strong>${cap}</strong>\\s*watched by the Filing Monitor`));
  }
  // The meter is AI credits, not Ask counts (listing v5 — customers could not tell
  // what an Ask-count tier actually bought them). These allowances are
  // LTD_CREDIT_ALLOWANCE in backend/credits.js; credit-meter-truth.test.js is what
  // keeps them in step with the published listing and with what Ask will serve.
  for (const allowance of ['100', '300', '800']) {
    assert.match(html, new RegExp(`${allowance} AI credits / month`));
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
