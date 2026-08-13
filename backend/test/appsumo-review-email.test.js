const test = require('node:test');
const assert = require('node:assert/strict');

const { appsumoReviewEmail } = require('../mailer');
const fs = require('node:fs');
const path = require('node:path');

const APP_URL = 'https://stockportfolio.pro';
const REVIEW_URL = 'https://appsumo.com/products/stockportfoliopro/#reviews';

test('review asks welcome positive, mixed, and critical feedback', () => {
  for (const stage of [2, 3]) {
    const email = appsumoReviewEmail('Taylor', APP_URL, stage, REVIEW_URL, '');
    const message = `${email.subject}\n${email.html}\n${email.text}`.toLowerCase();

    assert.match(message, /honest/);
    assert.match(message, /positive, mixed, (or|and) critical/);
    assert.match(message, /appsumo\.com\/products\/stockportfoliopro/);
  }
});

test('review asks do not gate feedback behind satisfaction or support', () => {
  for (const stage of [2, 3]) {
    const email = appsumoReviewEmail('Taylor', APP_URL, stage, REVIEW_URL, '');
    const message = `${email.subject}\n${email.html}\n${email.text}`.toLowerCase();

    assert.doesNotMatch(message, /great review/);
    assert.doesNotMatch(message, /if (it('|’)s|stockportfolio\.pro has been) useful/);
    assert.doesNotMatch(message, /reply first/);
    assert.doesNotMatch(message, /in exchange|in return|reward|bonus|discount|free month/);
  }
});

test('review requests have one persisted, cross-worker guard', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
  const runner = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'run-scheduled-emails.js'), 'utf8');
  for (const source of [appSource, runner]) {
    assert.match(source, /reviewRequestSentAt: null/);
    assert.match(source, /reviewRequestClaimedAt: null/);
    assert.match(source, /findOneAndUpdate/);
    assert.match(source, /review-request-sent:\$\{String\([^)]*\)\}/);
  }
  assert.match(appSource, /reviewRequestSentAt: \{ type: Date, default: null \}/);
  assert.match(appSource, /reviewRequestClaimedAt: \{ type: Date, default: null \}/);
});
