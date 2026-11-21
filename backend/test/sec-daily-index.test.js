'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const client = require('../sec-reporting');
const refresh = require('../../scripts/refresh-sec-coverage');
const { EXTRACTION_VERSION, VALIDATION_VERSION } = require('../sec-facts');

const HEAD = 'Description:           Daily Index of EDGAR Dissemination Feed\nLast Data Received:    Nov 20, 2026\n \nCIK|Company Name|Form Type|Date Filed|File Name\n--------------------------------------------------------------------------------\n';
const index = rows => HEAD + rows.map(r => r.join('|')).join('\n') + '\n';

test('the daily index keeps registrants whose filings can move their reporting, and drops ownership and offering noise', () => {
  const ciks = client.parseDailyIndex(index([
    ['320193', 'APPLE INC', '10-Q', '20261120', 'edgar/data/320193/a.txt'],
    ['1000177', 'NORDIC AMERICAN TANKERS', '6-K', '20261120', 'x'],
    ['789019', 'MICROSOFT', '8-K/A', '20261120', 'x'],
    ['1045810', 'NVIDIA', '4', '20261120', 'x'],
    ['1000275', 'ROYAL BANK OF CANADA', '424B2', '20261120', 'x'],
    ['1318605', 'TESLA', 'SCHEDULE 13D/A', '20261120', 'x'],
  ]));
  assert.deepEqual([...ciks].sort(), ['0000320193', '0000789019', '0001000177']);
});

test('index days skip weekends, treat a missing day as unpublished, and fail on anything else', async () => {
  const asked = [];
  const get = async url => {
    asked.push(url.slice(-12, -4));
    if (url.endsWith('20261120.idx')) throw Object.assign(new Error('forbidden'), { response: { status: 403 } });
    return { data: index([['320193', 'APPLE INC', '10-Q', '20261119', 'x']]) };
  };
  const out = await client.fetchFilersSince('2026-11-13', '2026-11-21', { get });
  assert.deepEqual(asked, ['20261116', '20261117', '20261118', '20261119', '20261120']);
  assert.deepEqual(out.read, ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19']);
  assert.equal(out.lastRead, '2026-11-19');
  assert.ok(out.ciks.has('0000320193'));
  await assert.rejects(client.fetchFilersSince('2026-11-15', '2026-11-16', { get: async () => { throw Object.assign(new Error('x'), { response: { status: 500 } }); } }));
  await assert.rejects(client.fetchFilersSince('2026-11-15', '2026-11-16', { get: async () => ({ data: '<html>maintenance</html>' }) }), /INVALID_SEC_DAILY_INDEX/);
});

test('a daily or weekly run asks SEC only about filers and issuers that have not settled', async () => {
  const settled = { lastAttemptResult: 'success', extractionVersion: EXTRACTION_VERSION, validationVersion: VALIDATION_VERSION, lastFinancialResult: 'no_facts' };
  const report = { lastIndexDay: '2026-11-13', issuers: {
    '0000000001': settled,
    '0000000002': settled,
    '0000000003': { ...settled, lastAttemptResult: 'transient_failure' },
    '0000000004': { ...settled, extractionVersion: 'old' },
  } };
  const todo = ['0000000001', '0000000002', '0000000003', '0000000004', '0000000005'].map(cik => ({ cik, symbols: ['S' + cik.slice(-1)] }));
  const fetchFilers = async () => ({ ciks: new Set(['0000000002']), read: ['2026-11-16'], lastRead: '2026-11-16' });
  const plan = await refresh.indexPlan(todo, report, '2026-11-21', { fetchFilers, today: '2026-11-21' });
  assert.equal(plan.mode, 'index');
  assert.deepEqual(plan.check.map(i => i.cik), ['0000000002', '0000000003', '0000000004', '0000000005']);
  assert.deepEqual(plan.quiet.map(i => i.cik), ['0000000001']);
  assert.equal(plan.lastRead, '2026-11-16');
});

test('without a recent index day, or when the index cannot be read, the run asks every issuer', async () => {
  const todo = [{ cik: '0000000001', symbols: ['A'] }];
  const never = async () => { throw new Error('not called'); };
  assert.equal((await refresh.indexPlan(todo, { issuers: {} }, '2026-11-21', { fetchFilers: never })).mode, 'full');
  assert.equal((await refresh.indexPlan(todo, { lastIndexDay: '2026-10-01', issuers: {} }, '2026-11-21', { fetchFilers: never })).mode, 'full');
  const down = async () => { throw Object.assign(new Error('x'), { response: { status: 503 } }); };
  const plan = await refresh.indexPlan(todo, { lastIndexDay: '2026-11-19', issuers: {} }, '2026-11-21', { fetchFilers: down });
  assert.equal(plan.mode, 'full');
  assert.match(plan.reason, /503/);
});
