const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ask = fs.readFileSync(path.join(__dirname, '../../frontend-v2/ask.html'), 'utf8');

test('zero-use AppSumo buyers receive a support-first activation prompt', () => {
  assert.match(ask, /q2\.appsumo && q2\.appsumo\.isAppSumo && Number\(q2\.used\) === 0/);
  assert.match(ask, /Your AppSumo access is active\./);
  assert.match(ask, /support@stockportfolio\.pro/);
  assert.match(ask, /reported inputs, calculation, periods, and sources/);
});
