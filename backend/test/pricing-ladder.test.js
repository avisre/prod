const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// Pins for the 2026-08-31 Jobs-cut four-rung ladder and the $14.99 credit
// refill — the two pricing surfaces a signed-in buyer can reach from inside
// the app (upgrade.html, recharge.html). Discovered by the 2026-09-01 ladder
// verification: the ladder content was right but (a) the "You're on …" sub
// line silently no-opped because the IIFE shadowed the DOM element named
// `sub`, and (b) neither page defined the price component classes, so the
// cards rendered flat.

const appSource = fs.readFileSync(require.resolve('../app'), 'utf8');
const upgradeSource = fs.readFileSync(require.resolve('../../frontend-v2/upgrade.html'), 'utf8');
const rechargeSource = fs.readFileSync(require.resolve('../../frontend-v2/recharge.html'), 'utf8');
const homepageSource = fs.readFileSync(require.resolve('../../frontend-v2/index.html'), 'utf8');

test('upgrade.html ladder sells exactly the four decided rungs', () => {
  assert.match(upgradeSource, /planId: 'monthly', label: 'Good', group: 'core', caption: 'The full research library, portfolio tracker and markets desk', fig: '\$24\.99', per: '\/month'/);
  assert.match(upgradeSource, /planId: 'annual', label: 'Good — annual', group: 'core', fig: '\$199\.99', per: '\/year'/);
  assert.match(upgradeSource, /planId: 'pro-annual', label: 'Pro', group: 'pro', featured: true, .*fig: '\$499\.99', per: '\/year'/);
  assert.match(upgradeSource, /planId: 'desk', label: 'Desk', group: 'desk', featured: true, .*fig: '\$1,999\.99', per: '\/year'/);
  // The Good card carries the annual cross-sell line verbatim.
  assert.match(upgradeSource, /Same plan yearly is <strong>\$199\.99 — \$16\.67\/month, save \$100<\/strong>/);
});

test('retired rungs rank for masking but never render or sell', () => {
  assert.match(upgradeSource, /planId: 'pro', label: 'Pro — retired', .*retired: true, fig: '\$79\.99'/);
  assert.match(upgradeSource, /planId: 'power-monthly', label: 'Best — retired', .*retired: true, fig: '\$149\.99'/);
  assert.match(upgradeSource, /planId: 'power', label: 'Best — annual \(retired\)', .*retired: true, fig: '\$1,499\.99'/);
  // The sell-order mask: strictly above the holder's rank, retired never renders.
  assert.match(upgradeSource, /LADDER\.filter\(\(p, i\) => \(myRank === -1 \? true : i > myRank\) && !p\.retired\)/);
  assert.match(upgradeSource, /planId === 'enterprise' \? LADDER\.length : rank\(planId\)/);
});

test('Enterprise is the contact-sales rung, on the ladder and the homepage grid', () => {
  // upgrade.html: enterprise renders as the last card for every rung below it
  // (Desk no longer dead-ends) with a contact handoff, never a Stripe button.
  assert.match(upgradeSource, /planId: 'enterprise', label: 'Enterprise', group: 'enterprise', contact: true,/);
  assert.match(upgradeSource, /Contact sales →<\/a>/);
  assert.doesNotMatch(upgradeSource, /data-plan="enterprise"/);
  // index.html: the Enterprise card lives in the subscription grid (visible,
  // not collapsed), with the approved copy.
  assert.match(homepageSource, /<span class="label">Enterprise<\/span>/);
  assert.match(homepageSource, /href="mailto:support@stockportfolio\.pro\?subject=StockPortfolio\.pro%20Enterprise%20enquiry">Contact sales →<\/a>/);
});

test('the homepage grid reads as the ladder table: Good, Good — annual, Pro (featured), Desk (featured)', () => {
  // 2026-09-01: the owner re-pinned the ladder table with "this and lets
  // talk" — the grid must carry the table's names, order and featured flags,
  // with Desk promoted out of the collapsed details and enterprise last.
  const grid = homepageSource.slice(
    homepageSource.indexOf('id="pricing-subscription-grid"'),
    homepageSource.indexOf('id="pricing-experiment-block"'),
  );
  const labels = [...grid.matchAll(/<span class="label">([^<]+)<\/span>/g)].map((m) => m[1]);
  assert.deepEqual(labels, ['Good', 'Pro', 'Good — annual', 'Desk', 'Enterprise']);
  // Pro and Desk carry the featured ink border; the others don't.
  assert.equal((grid.match(/card price-card" style="border-color: var\(--ink\);"/g) || []).length, 2);
  // The annual card shows the actual monthly-billed price with a cross
  // through it next to the discounted annual figure.
  assert.match(grid, /\$199\.99<span>\/year<\/span><s class="price-was">\$299\.88<\/s>/);
  // Line 1 is a 3-card row; Desk and Enterprise flow onto the next line.
  assert.match(homepageSource, /#pricing-subscription-grid \{ grid-template-columns: repeat\(3, minmax\(0, 1fr\)\); \}/);
  // Pro is annual-only: no CTA anywhere on the page buys the retired
  // planId 'pro' directly (a stale link falls back to Monthly on register).
  assert.doesNotMatch(homepageSource, /plan=pro"/);
  // Desk's collapsed card is gone — one Desk card, in the grid.
  assert.doesNotMatch(homepageSource, /<details class="card card-pad"[^>]*>\s*<summary[^>]*><span>Desk/);
});

test('the sub-line element is never shadowed again (silent no-op regression)', () => {
  // The DOM element and the owned subscription must not share one name:
  // when both were `sub`, "You're on <plan>" wrote textContent onto a plain
  // object and users always saw the static prorate copy.
  assert.match(upgradeSource, /const owned = session && session\.subscription \|\| \{\};/);
  // The exact shadow that caused the bug (planName's local `sub` is fine —
  // it never reaches the DOM element).
  assert.doesNotMatch(upgradeSource, /const sub = session && session\.subscription \|\| \{\}/);
  assert.match(upgradeSource, /sub\.textContent = `You're on \$\{esc\(planName\(session\)\)\}\./);
});

test('the pricing pages carry the same price components as the homepage', () => {
  for (const [name, src] of [['upgrade', upgradeSource], ['recharge', rechargeSource]]) {
    assert.match(src, /\.price-fig \{ font-size: 34px;/, `${name}.html styles .price-fig`);
    assert.match(src, /\.price-list \{ margin: 6px 0 14px;/, `${name}.html styles .price-list`);
  }
  assert.match(rechargeSource, /<div class="price-fig">\$14\.99<span> one-time<\/span><\/div>/);
  assert.match(rechargeSource, /Recharge 150 credits — \$14\.99/);
  assert.match(rechargeSource, /\/credits\/topup/);
});

test('the topup route sells a verified one-time price and nothing else', () => {
  assert.match(appSource, /const STRIPE_PRICE_ID_CREDITS_TOPUP = process\.env\.STRIPE_PRICE_ID_CREDITS_TOPUP \|\| '';/);
  assert.match(appSource, /const expectedAmount = Math\.round\(CREDIT_TOPUP_PRICE \* 100\);/);
  // Mispriced/inactive price refuses to sell rather than charging wrong.
  assert.match(appSource, /refusing to sell/);
  assert.match(appSource, /checkoutType: 'credit_topup'/);
  // Grant happens only on the webhook, only when paid, idempotently.
  assert.match(appSource, /payload\.metadata\?\.checkoutType === 'credit_topup'/);
  assert.match(appSource, /credits\.grant\(\s*\n\s*userId,\s*\n\s*Number\(payload\.metadata\?\.credits\) \|\| CREDIT_TOPUP_CREDITS,\s*\n\s*'topup',/);
});