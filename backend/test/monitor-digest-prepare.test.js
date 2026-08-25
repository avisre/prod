'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const digest = require('../../jobs/monitor-digest');
const outputDelivery = require('../../lib/output-delivery');

const SECRET = 'test-secret-for-unsubscribe-tokens';
const user = { _id: '507f1f77bcf86cd799439011', name: 'Ada Lovelace', email: 'ada@example.com' };

const section = (symbol, accession) => ({
  symbol, kind: 'filing-diff', accession,
  headline: `${symbol} guided revenue lower for the coming quarter.`,
  materiality: 62, bucket: 'high',
  filing: { form: '10-Q', label: 'Quarterly report', date: '2026-08-01', url: `https://www.sec.gov/Archives/${symbol}.htm` },
  deltas: [{ label: 'Revenue', latest: '$1.2B', prior: '$1.4B', change: '-14.3%', direction: 'down' }],
  changes: [{ area: 'Guidance', what: 'Full-year outlook cut.', quote: 'we now expect' }],
  note: ''
});

test('the digest renders the sections it was given, with sources', () => {
  const block = outputDelivery.renderSections([section('AAPL', '0000320193-26-000001'), section('MSFT', '0000789019-26-000002')], {});
  const unsub = digest.unsubscribe(user._id, SECRET);
  const mail = digest.renderDigest(user, block, unsub);
  assert.match(mail.subject, /^2 of the companies you track filed/);
  assert.ok(mail.html.includes('Ada'));
  for (const sym of ['AAPL', 'MSFT']) {
    assert.ok(mail.html.includes(sym));
    assert.ok(mail.html.includes(`https://www.sec.gov/Archives/${sym}.htm`), 'every item keeps its source filing link');
    assert.ok(mail.text.includes(sym));
  }
  assert.ok(mail.html.includes('-14.3%'));
});

test('a single-company digest gets a single-company subject', () => {
  const block = outputDelivery.renderSections([section('NVDA', '0001045810-26-000003')], {});
  const mail = digest.renderDigest(user, block, digest.unsubscribe(user._id, SECRET));
  assert.equal(mail.subject, 'NVDA just filed — what changed');
});

test('unsubscribe is one click, needs no login, and the token identifies the user', () => {
  const unsub = digest.unsubscribe(user._id, SECRET);
  const token = new URL(unsub.url).searchParams.get('token');
  const decoded = jwt.verify(token, SECRET);
  assert.equal(decoded.userId, String(user._id));
  assert.equal(decoded.p, 'digest');           // same purpose claim the live route checks
  assert.match(unsub.headers['List-Unsubscribe'], /^<https:\/\/[^>]+\/api\/digest\/unsubscribe\?token=/);
  assert.equal(unsub.headers['List-Unsubscribe-Post'], 'List-Unsubscribe=One-Click');
  // and the link is in the body too, for clients that don't honour the header
  const mail = digest.renderDigest(user, outputDelivery.renderSections([section('AAPL', 'x')], {}), unsub);
  assert.ok(mail.html.includes(unsub.url));
  assert.ok(mail.text.includes(unsub.url));
});

test('an unsubscribe token signed with another secret does not verify', () => {
  const token = new URL(digest.unsubscribe(user._id, SECRET).url).searchParams.get('token');
  assert.throws(() => jwt.verify(token, 'a-different-secret'));
});

test('rendering nothing produces nothing to send', () => {
  const block = outputDelivery.renderSections([], {});
  assert.equal(block.count, 0);
  assert.equal(block.html, '');
});
