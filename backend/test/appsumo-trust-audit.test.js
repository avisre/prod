'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const audit = require('../../scripts/audit-appsumo-trust');
const growth = require('../growth-measurement');
const importer = require('../../scripts/import-appsumo-portal');
const fs = require('node:fs');
const path = require('node:path');

function row(event, at, extra = {}) {
  return {
    event,
    eventType: event,
    eventName: event,
    timestamp: at,
    at,
    reportable: true,
    internalFlag: false,
    testFlag: false,
    botFlag: false,
    anonymousId: extra.anonymousId || 'anon-12345678901234',
    sessionId: extra.sessionId || 'session-12345678901234',
    ...extra
  };
}

test('trust audit separates reportable campaign funnel steps and missing events', () => {
  const report = audit.buildAudit({
    rows: [
      row('appsumo_landing_view', '2026-08-03T01:00:00Z'),
      row('appsumo_cta_click', '2026-08-03T01:01:00Z'),
      row('appsumo_outbound', '2026-08-03T01:02:00Z'),
      row('signup', '2026-08-03T01:03:00Z', { userId: 'u1' }),
      row('trial_start', '2026-08-03T01:03:01Z', { userId: 'u1' }),
      row('paid', '2026-08-03T01:04:00Z', { userId: 'u1', source: 'appsumo' }),
      row('page_view', '2026-08-03T01:05:00Z', { internalFlag: true })
    ],
    users: [{ appsumoRedeemedAt: new Date('2026-08-03T01:04:00Z') }],
    licenses: [{}],
    now: new Date('2026-08-11T00:00:00Z'),
    since: new Date('2026-08-01T00:00:00Z')
  });
  assert.equal(report.overall.listingImpressions, 1);
  assert.equal(report.overall.outboundClicks, 1);
  assert.equal(report.overall.accountCreation, 1);
  assert.equal(report.overall.purchases, 1);
  assert.equal(report.sourceData.excludedEvents, 1);
  assert.ok(report.missingInstrumentation.includes('first_ask_succeeded'));
  assert.equal(report.customerCounts.redeemedUsers, 1);
});

test('AppSumo campaign events are consent-gated browser events', () => {
  assert.equal(growth.validateBrowserEvent('appsumo_landing_view'), true);
  assert.equal(growth.validateBrowserEvent('appsumo_cta_click'), true);
  assert.equal(growth.validateBrowserEvent('first_ask_succeeded'), false);
});

test('historical funnel aliases normalize to the canonical contract', () => {
  assert.equal(growth.normalizeEventName('signup_complete'), 'signup_completed');
  assert.equal(growth.normalizeEventName('first_research_complete'), 'first_research_completed');
  assert.equal(growth.normalizeEventName('first_ask_success'), 'first_ask_succeeded');
  assert.equal(growth.EVENT_NAMES.has('signup_complete'), false);
  assert.equal(growth.EVENT_NAMES.has('first_research_complete'), false);
  assert.equal(growth.EVENT_NAMES.has('first_ask_success'), false);
});

test('sanitized AppSumo portal fixture summarizes orders without buyer or licence data', () => {
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/appsumo-portal-sales.synthetic.csv'), 'utf8');
  const parsed = importer.parseColumns(fixture);
  const records = importer.normalizeRecords(parsed.headers, parsed.rows);
  const summary = importer.summarize(records);
  assert.equal(summary.orders, 3);
  assert.equal(summary.grossGmv, 267);
  assert.equal(summary.partnerProceeds, 106.8);
  assert.equal(summary.refunds, 1);
  assert.equal(summary.refundReasons['duplicate purchase'], 1);
  assert.equal(summary.netActivePurchases, 2);
  assert.equal(summary.redeemed, 2);
  assert.equal(summary.activation, 1);
  assert.equal(summary.firstResearch, 1);
  assert.equal(summary.firstAskSuccess, 1);
  assert.equal(summary.sevenDayReturn, 0);
  assert.deepEqual(summary.sourceAttribution, { x: 1, creator: 1, unknown: 1 });
  for (const record of records) {
    assert.equal(Object.prototype.hasOwnProperty.call(record, 'orderId'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(record, 'license'), false);
  }
});

test('channel segmentation uses explicit markers and keeps direct traffic unproven', () => {
  const report = audit.buildAudit({
    rows: [
      row('page_view', '2026-08-03T01:00:00Z', { source: 'x', contentId: 'x-reply-1' }),
      row('appsumo_outbound_clicked', '2026-08-03T01:01:00Z', { source: 'x', contentId: 'x-original-1' }),
      row('page_view', '2026-08-03T01:02:00Z', { source: 'direct' })
    ],
    now: new Date('2026-08-04T00:00:00Z'),
    since: new Date('2026-08-01T00:00:00Z')
  });
  assert.equal(report.channels.x_reply.landingViews, 1);
  assert.equal(report.channels.x_original_or_founder.outboundClicks, 1);
  assert.equal(report.channels.direct_unknown.events, 1);
});
