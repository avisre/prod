const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const pricing = fs.readFileSync(path.join(root, 'frontend-v2', 'index.html'), 'utf8');
const terms = fs.readFileSync(path.join(root, 'frontend-v2', 'terms.html'), 'utf8');
const legacyTerms = fs.readFileSync(path.join(root, 'frontend', 'terms.html'), 'utf8');

test('Desk pricing describes the same narrow one-user permission as the terms', () => {
  assert.match(pricing, /One professional seat/);
  assert.match(pricing, /permission to incorporate verified outputs into your own commercial research and client communications/);
  assert.match(terms, /active Desk plan gives one named user a limited, non-exclusive, non-transferable permission/);
  assert.match(legacyTerms, /active Desk plan gives one named user a limited, non-exclusive, non-transferable permission/);
});

test('Desk permission does not grant redistribution, shared access, or upstream data rights', () => {
  for (const document of [pricing, terms, legacyTerms]) {
    assert.match(document, /account sharing/i);
    assert.match(document, /raw(?: or underlying)? data|raw-data/i);
  }
  for (const document of [terms, legacyTerms]) {
    assert.match(document, /standalone database, data feed, or API/);
    assert.match(document, /third-party data beyond the rights provided by its source/);
    assert.match(document, /resale or sublicensing of access/);
  }
});

test('Desk permission does not turn the product into advice or regulatory authorization', () => {
  for (const document of [pricing, terms, legacyTerms]) {
    assert.match(document, /Not investment advice|do not constitute financial,\s*investment/i);
  }
  assert.match(pricing, /does not include[^.]*authorisation to provide regulated advice/);
  for (const document of [terms, legacyTerms]) {
    assert.match(document, /does not itself authori[sz]e investment advice or any other regulated activity/);
    assert.match(document, /not provided, approved, or endorsed by stockportfolio\.pro/);
  }
});

test('professional plan enquiries use the customer support mailbox', () => {
  assert.match(pricing, /mailto:support@stockportfolio\.pro\?subject=StockPortfolio\.pro%20Enterprise%20enquiry/);
  assert.doesNotMatch(pricing, /mailto:avinashsreekumar007@gmail\.com/i);
});
