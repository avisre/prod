#!/usr/bin/env node
'use strict';

// Read-only daily funnel report. It joins first-party aggregate telemetry with
// an optional sanitized AppSumo Partner Portal CSV. It never prints identities,
// raw order/license values, prompts, cookies or secrets, and never writes to
// MongoDB.
const fs = require('node:fs');
const path = require('node:path');
const audit = require('./audit-appsumo-trust');
const importer = require('./import-appsumo-portal');

const DEFAULT_CSV = path.join(__dirname, '../marketing/campaign-2026-08-appsumo-sprint/incoming/appsumo-sales-analytics-YYYY-MM-DD.csv');
const DEFAULT_SINCE = '2026-08-01T00:00:00.000Z';
const REQUIRED_SEGMENTS = ['x_original_post', 'x_reply', 'founder_post', 'organic_search', 'appsumo', 'direct_unknown'];
const EVENT = Object.freeze({
  landing: new Set(['appsumo_landing_view']),
  cta: new Set(['appsumo_cta_click', 'appsumo_outbound_clicked', 'appsumo_click']),
  orderProxy: new Set(['appsumo_redemption_completed', 'appsumo_redemption', 'appsumo_activation', 'invoice_paid', 'paid']),
  redemption: new Set(['appsumo_redemption_completed', 'appsumo_redemption', 'appsumo_activation']),
  activation: new Set(['activation_completed', 'activation']),
  signup: new Set(['signup_completed', 'signup']),
  research: new Set(['first_research_completed', 'research_outcome_completed', 'meaningful_activation']),
  ask: new Set(['first_ask_succeeded']),
  return7: new Set(['seven_day_return']),
  refund: new Set(['payment_refunded'])
});

function arg(name, fallback = '') {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function dateArg(name, fallback) {
  const raw = arg(name, fallback);
  const date = new Date(raw);
  if (!Number.isFinite(date.getTime())) throw new Error(`Invalid --${name}; use an ISO-8601 timestamp`);
  return date;
}

function identity(row) {
  if (row && row.userId) return `u:${row.userId}`;
  return row && (row.anonymousId || row.anonymousSessionId || row.sessionId) || null;
}

function eventCount(rows, set) {
  return rows.filter((row) => set.has(audit.eventName(row))).length;
}

function uniqueCount(rows, set) {
  return new Set(rows.filter((row) => set.has(audit.eventName(row))).map(identity).filter(Boolean)).size;
}

function marker(row) {
  return [row && row.contentId, row && row.campaignId, row && row.utm && row.utm.content,
    row && row.utm && row.utm.campaign, row && row.ctaId].filter(Boolean).join(' ').toLowerCase();
}

function segment(row) {
  const source = audit.sourceOf(row);
  const tag = marker(row);
  if (source === 'appsumo') return 'appsumo';
  if (source === 'google' || source === 'bing' || source === 'duckduckgo') return 'organic_search';
  if (source === 'x' && /founder/.test(tag)) return 'founder_post';
  if (source === 'x' && /reply|replying/.test(tag)) return 'x_reply';
  if (source === 'x' && /original/.test(tag)) return 'x_original_post';
  if (source === 'x') return 'x_unclassified';
  if (source === 'direct' || source === 'unknown') return 'direct_unknown';
  return source || 'direct_unknown';
}

function segmentReport(rows) {
  const output = {};
  for (const key of REQUIRED_SEGMENTS) output[key] = { eventTotals: {}, uniqueUsers: {} };
  for (const row of rows.filter(audit.reportable)) {
    const key = segment(row);
    if (!output[key]) output[key] = { eventTotals: {}, uniqueUsers: {} };
    const item = output[key];
    const name = audit.eventName(row);
    item.eventTotals[name] = (item.eventTotals[name] || 0) + 1;
  }
  const names = Object.values(EVENT);
  for (const [key, item] of Object.entries(output)) {
    for (const set of names) {
      for (const name of set) {
        const rowsForName = rows.filter((row) => audit.reportable(row) && segment(row) === key && audit.eventName(row) === name);
        if (rowsForName.length) item.uniqueUsers[name] = new Set(rowsForName.map(identity).filter(Boolean)).size;
      }
    }
  }
  return output;
}

function loadPortalSummary(csvPath, { since = null, until = null } = {}) {
  if (!csvPath || !fs.existsSync(csvPath)) return { status: 'missing', path: csvPath || DEFAULT_CSV };
  const parsed = importer.parseColumns(fs.readFileSync(csvPath, 'utf8'));
  const allRecords = importer.normalizeRecords(parsed.headers, parsed.rows);
  const sinceDate = since instanceof Date ? since : (since ? new Date(since) : null);
  const untilDate = until instanceof Date ? until : (until ? new Date(until) : null);
  const canFilter = sinceDate && Number.isFinite(sinceDate.getTime()) && untilDate && Number.isFinite(untilDate.getTime());
  const records = canFilter
    ? allRecords.filter((row) => {
      const date = row.saleDate ? new Date(row.saleDate) : null;
      return date && Number.isFinite(date.getTime()) && date >= sinceDate && date < untilDate;
    })
    : allRecords;
  const summary = importer.summarize(records);
  return {
    status: 'loaded',
    path: csvPath,
    rawRows: allRecords.length,
    rowsInWindow: records.length,
    rowsOutsideWindow: Math.max(0, allRecords.length - records.length),
    orders: summary.orders,
    grossGmv: summary.grossGmv,
    partnerProceeds: summary.partnerProceeds,
    refunds: summary.refunds,
    refundAmount: summary.refundAmount,
    refundReasons: summary.refundReasons,
    netActivePurchases: summary.netActivePurchases,
    redeemed: summary.redeemed,
    activation: summary.activation,
    firstResearch: summary.firstResearch,
    firstAskSuccess: summary.firstAskSuccess,
    sevenDayReturn: summary.sevenDayReturn,
    sourceAttribution: summary.sourceAttribution,
    unknownSourceOrders: summary.unknownSourceOrders,
    incompleteFields: summary.incompleteFields
  };
}

function funnelRows(rows, portal) {
  const reportable = rows.filter(audit.reportable);
  const portalLoaded = portal.status === 'loaded';
  return [
    { stage: 'qualified landing', internalEventTotals: eventCount(reportable, EVENT.landing), portalTotal: null, uniqueUsers: uniqueCount(reportable, EVENT.landing), source: 'first-party appsumo_landing_view; denominator is not listing impressions' },
    { stage: 'AppSumo CTA click', internalEventTotals: eventCount(reportable, EVENT.cta), portalTotal: null, uniqueUsers: uniqueCount(reportable, EVENT.cta), source: 'first-party CTA/outbound events' },
    { stage: 'AppSumo order', internalEventTotals: null, portalTotal: portalLoaded ? portal.orders : null, uniqueUsers: null, source: portalLoaded ? 'Partner Portal CSV; unique buyer denominator not supplied' : 'Partner Portal CSV missing' },
    { stage: 'redemption', internalEventTotals: eventCount(reportable, EVENT.redemption), portalTotal: portalLoaded ? portal.redeemed : null, uniqueUsers: uniqueCount(reportable, EVENT.redemption), source: portalLoaded ? 'Portal and internal redemption totals are shown separately' : 'internal redemption events only' },
    { stage: 'activation', internalEventTotals: eventCount(reportable, EVENT.activation), portalTotal: portalLoaded ? portal.activation : null, uniqueUsers: uniqueCount(reportable, EVENT.activation), source: portalLoaded ? 'Portal and internal activation totals are shown separately' : 'internal activation events' },
    { stage: 'first research', internalEventTotals: eventCount(reportable, EVENT.research), portalTotal: portalLoaded ? portal.firstResearch : null, uniqueUsers: uniqueCount(reportable, EVENT.research), source: portalLoaded ? 'Portal and internal first-research totals are shown separately' : 'internal first-research events' },
    { stage: 'first Ask success', internalEventTotals: eventCount(reportable, EVENT.ask), portalTotal: portalLoaded ? portal.firstAskSuccess : null, uniqueUsers: uniqueCount(reportable, EVENT.ask), source: portalLoaded ? 'Portal and internal first-Ask totals are shown separately' : 'internal first-Ask events' },
    { stage: 'seven-day return', internalEventTotals: eventCount(reportable, EVENT.return7), portalTotal: portalLoaded ? portal.sevenDayReturn : null, uniqueUsers: uniqueCount(reportable, EVENT.return7), source: 'cohort maturity is required; portal and internal values are not merged' },
    { stage: 'refund', internalEventTotals: eventCount(reportable, EVENT.refund), portalTotal: portalLoaded ? portal.refunds : null, uniqueUsers: null, source: portalLoaded ? 'Portal refunds are authoritative; internal refunds remain separate' : 'internal refund events; not authoritative order refunds' }
  ];
}

function markdown(report) {
  const lines = [
    '# StockPortfolio.pro daily AppSumo funnel report', '',
    `Generated: ${report.generatedAt}`, `Window: ${report.window.since} → ${report.window.until}`, '',
    '## Data quality', '',
    `- AppSumo CSV: **${report.portal.status}** (${report.portal.path})`,
    '- Direct/unknown is treated as unknown, not verified brand demand.',
    '- Internal redemptions and paid events are never substituted for AppSumo orders.',
    '- Null unique-user values mean the source did not provide a safe identity denominator.',
    '- Small samples are descriptive only, not proof of conversion performance.', '',
    '## Funnel', '',
    '| Stage | Internal event total | Partner Portal total | Unique identities | Evidence / missing denominator |', '|---|---:|---:|---:|---|',
    ...report.funnel.map((row) => `| ${row.stage} | ${row.internalEventTotals === null ? '—' : row.internalEventTotals} | ${row.portalTotal === null ? 'UNKNOWN' : row.portalTotal} | ${row.uniqueUsers === null ? 'UNKNOWN' : row.uniqueUsers} | ${row.source} |`), '',
    '## Channel segmentation', '',
    '| Segment | Event totals (JSON) | Unique users (JSON) |', '|---|---|---|',
    ...Object.entries(report.segments).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `| ${key} | \`${JSON.stringify(value.eventTotals)}\` | \`${JSON.stringify(value.uniqueUsers)}\` |`), '',
    'Requested segments are separated where the source/content marker makes that possible: X original post, X reply, founder post, organic search, AppSumo and Direct/unknown. Unmarked X remains `x_unclassified`.', '',
    '## Decision rules', '',
    '- Clicks without orders → listing, offer or trust issue.',
    '- Orders without activation → redemption/onboarding issue.',
    '- Activation without research → value-discovery issue.',
    '- Research without successful Ask → product/reliability issue.',
    '- Successful Ask without return → retention issue.',
    '- Meaningful usage followed by refunds → expectation/deal-fit issue.', '',
    '## Portal summary (aggregate only)', '',
    '```json', JSON.stringify(report.portal, null, 2), '```', ''
  ];
  return `${lines.join('\n')}\n`;
}

async function main() {
  const since = dateArg('since', DEFAULT_SINCE);
  const until = dateArg('until', new Date().toISOString());
  if (until <= since) throw new Error('--until must be after --since');
  const csvPath = arg('csv', DEFAULT_CSV);
  const data = await audit.queryProduction();
  const report = audit.buildAudit({ ...data, since, now: until });
  const rangeRows = data.rows.filter((row) => {
    const date = audit.eventDate(row);
    return date && date >= since && date < until;
  });
  const portal = loadPortalSummary(csvPath, { since, until });
  const output = {
    generatedAt: new Date().toISOString(),
    window: report.window,
    funnel: funnelRows(rangeRows, portal),
    segments: segmentReport(rangeRows),
    portal,
    internalAudit: report.overall
  };
  const format = arg('format', 'md');
  const target = arg('output');
  const body = format === 'json' ? `${JSON.stringify(output, null, 2)}\n` : markdown(output);
  if (target) fs.writeFileSync(target, body);
  else process.stdout.write(body);
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exit(1); });

module.exports = { segment, segmentReport, loadPortalSummary, funnelRows, markdown };
