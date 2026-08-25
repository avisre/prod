'use strict';
const test = require('node:test'); const assert = require('node:assert/strict');
const fs = require('node:fs'); const os = require('node:os'); const path = require('node:path');
const exporter = require('../../scripts/export-corpus');
const delivery = require('../../scripts/generate-corpus-download');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'corpus-test-'));

test('the export writes CSV+JSON and every row cites a source filing', () => {
  const dir = tmp();
  const counts = exporter.exportFundamentals(dir, { symbols: ['AAPL'], limit: null });
  assert.ok(counts.companies >= 1);
  assert.ok(counts.fundamentals >= 1);
  for (const name of ['companies', 'fundamentals-panel']) {
    assert.ok(fs.existsSync(path.join(dir, `${name}.csv`)));
    const rows = JSON.parse(fs.readFileSync(path.join(dir, `${name}.json`), 'utf8'));
    for (const r of rows) assert.match(String(r.sourceUrl), /^https:\/\/www\.sec\.gov\//);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nothing that should stay in the building is in the field lists', () => {
  const all = [...exporter.COMPANY_FIELDS, ...Object.values(exporter.STATEMENT_FIELDS).flat()].join(' ');
  // vendor market data, model prose and anything user-shaped
  for (const banned of ['MarketCapitalization', 'PERatio', 'PEGRatio', 'AnalystTargetPrice', '52WeekHigh',
    'Beta', 'summary', 'narrative', 'user', 'email', 'unitEconomics']) {
    assert.equal(all.includes(banned), false, `${banned} must not be exported`);
  }
});

test('expiry parsing accepts the documented forms and refuses the rest', () => {
  assert.equal(delivery.parseExpiry('7d'), 604800);
  assert.equal(delivery.parseExpiry('36h'), 129600);
  assert.equal(delivery.parseExpiry('3600'), 3600);
  assert.throws(() => delivery.parseExpiry('8d'), /cannot exceed 7d/);
  assert.throws(() => delivery.parseExpiry('30'), /at least 60 seconds/);
  assert.throws(() => delivery.parseExpiry('forever'), /must look like/);
});

test('the object key never carries the buyer address in the clear', () => {
  const key = delivery.objectKey('Buyer@Example.COM', '2026-08-25');
  assert.equal(key.toLowerCase().includes('buyer'), false);
  assert.equal(key.includes('@'), false);
  // stable for the same buyer + day, so a re-run overwrites rather than litters
  assert.equal(key, delivery.objectKey('buyer@example.com', '2026-08-25'));
});

test('the signed URL is a real SigV4 GET with a bounded expiry', () => {
  const url = delivery.presignGet({
    bucket: 'corpus-test', region: 'eu-west-2', key: 'corpus/2026-08-25/abc/file.tar.gz',
    expiresIn: 604800, accessKeyId: 'AKIAEXAMPLE', secretAccessKey: 'secret',
    now: new Date('2026-08-25T00:00:00Z')
  });
  assert.match(url, /^https:\/\/corpus-test\.s3\.eu-west-2\.amazonaws\.com\//);
  assert.match(url, /X-Amz-Algorithm=AWS4-HMAC-SHA256/);
  assert.match(url, /X-Amz-Expires=604800/);
  assert.match(url, /X-Amz-Signature=[a-f0-9]{64}$/);
  assert.equal(url.includes('secret'), false);
});
