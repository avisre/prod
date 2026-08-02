const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

test('AppSumo activation collects bounded self-reported discovery attribution', () => {
  assert.match(appSource, /const APPSUMO_DISCOVERY_SOURCES = new Set\(\[/);
  assert.match(appSource, /discoverySource: \{ type: String, default: null/);
  assert.match(appSource, /normalizeAppSumoDiscoverySource\(req\.body && req\.body\.discoverySource\)/);
  assert.match(appSource, /<label for="discovery">Where did you first discover StockPortfolio\.pro/);
  assert.match(appSource, /discoverySource: discoverySource \|\| undefined/);
});

test('discovery attribution is persisted on AppSumo paid and lifecycle events', () => {
  assert.match(appSource, /discoverySource: normalizedDiscoverySource/);
  assert.match(appSource, /recordCustomerLifecycleEvent\(user, 'appsumo_redeemed', \{[\s\S]*discoverySource: normalizedDiscoverySource/);
});
