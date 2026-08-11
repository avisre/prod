#!/usr/bin/env node
'use strict';

// Read-only AppSumo trust/conversion audit. It deliberately reports counts and
// anonymous funnel dimensions only; it never sends email, changes MongoDB or
// treats a list-price proxy as GMV.
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require(path.join(__dirname, '../backend/node_modules/mongoose'));
const dotenv = require(path.join(__dirname, '../backend/node_modules/dotenv'));
const growth = require(path.join(__dirname, '../backend/growth-measurement'));

dotenv.config({ path: path.join(__dirname, '../backend/prod.env') });
dotenv.config({ path: path.join(__dirname, '../backend/.env') });

const CAMPAIGN_START = new Date('2026-08-01T00:00:00.000Z');
const SOURCES = ['appsumo', 'website', 'x', 'linkedin', 'direct', 'google', 'bing', 'reddit', 'creator', 'newsletter', 'email', 'referral', 'unknown'];
const EVENT_NAMES = {
  listingView: new Set(['appsumo_landing_view']),
  landingView: new Set(['page_view']),
  outbound: new Set(['appsumo_outbound_clicked', 'appsumo_click']),
  signup: new Set(['signup_completed', 'signup']),
  trial: new Set(['trial_started', 'trial_start']),
  research: new Set(['first_research_completed', 'research_outcome_completed', 'meaningful_activation']),
  ask: new Set(['first_ask_succeeded']),
  activation: new Set(['activation_completed', 'activation']),
  paid: new Set(['appsumo_redemption_completed', 'appsumo_redemption', 'appsumo_activation', 'invoice_paid', 'paid']),
  return7: new Set(['seven_day_return']),
  refund: new Set(['payment_refunded']),
  cancellation: new Set(['subscription_canceled', 'cancel'])
};

function arg(name, fallback = '') {
  const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
function eventDate(row) {
  for (const key of ['occurredAt', 'timestamp', 'at', 'createdAt']) {
    const value = row && row[key];
    if (!value) continue;
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) return date;
  }
  return null;
}
function eventName(row) {
  const raw = row && (row.eventName || row.event || row.eventType);
  return growth.normalizeEventName(raw, row) || (raw ? String(raw).trim().toLowerCase() : null);
}
function sourceOf(row) {
  const raw = row && ((row.firstTouch && row.firstTouch.source)
    || (row.lastNonDirectTouch && row.lastNonDirectTouch.source)
    || (row.utm && row.utm.source)
    || row.acquisitionSource || row.source || row.trafficSource || row.referrerSource || 'unknown');
  return growth.normalizeSource(raw) || 'unknown';
}
function channelBucket(row) {
  const source = sourceOf(row);
  const marker = [row && row.contentId, row && row.campaignId, row && row.utm && row.utm.content, row && row.utm && row.utm.campaign, row && row.ctaId]
    .filter(Boolean).join(' ').toLowerCase();
  if (source === 'appsumo') return 'appsumo';
  if (source === 'google' || source === 'bing' || source === 'duckduckgo') return 'organic_search';
  if (source === 'x' && /reply|replying/.test(marker)) return 'x_reply';
  if (source === 'x' && /founder|original/.test(marker)) return 'x_original_or_founder';
  if (source === 'x') return 'x_unclassified';
  if (source === 'direct' || source === 'unknown') return 'direct_unknown';
  return source;
}
function reportable(row) {
  const meta = row && row.meta && typeof row.meta === 'object' ? row.meta : {};
  const source = sourceOf(row);
  return row.reportable !== false
    && row.internalFlag !== true && row.testFlag !== true && row.botFlag !== true
    && row.trafficCategory !== 'internal' && source !== 'internal'
    && meta.reportable !== false && meta.isQa !== true && meta.isBot !== true
    && meta.internal !== true;
}
function identity(row) {
  if (row && row.userId) return `u:${row.userId}`;
  return row && (row.anonymousId || row.anonymousSessionId || row.sessionId) || null;
}
function count(rows, set) { return rows.filter((row) => set.has(eventName(row))).length; }
function unique(rows, set) {
  return new Set(rows.filter((row) => set.has(eventName(row))).map(identity).filter(Boolean)).size;
}
function uniqueSessions(rows) {
  return new Set(rows.map((row) => row.sessionId || row.anonymousSessionId || identity(row)).filter(Boolean)).size;
}
function monday(date) {
  const result = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = result.getUTCDay() || 7;
  result.setUTCDate(result.getUTCDate() - day + 1);
  return result;
}
function iso(date) { return date && date.toISOString(); }
function inRange(rows, since, until) {
  return rows.filter((row) => {
    const date = eventDate(row);
    return date && date >= since && date < until;
  });
}
function sourceBreakdown(rows) {
  const output = {};
  for (const source of SOURCES) {
    const sourceRows = rows.filter((row) => sourceOf(row) === source);
    if (!sourceRows.length) continue;
    output[source] = {
      landingViews: count(sourceRows, EVENT_NAMES.landingView) + count(sourceRows, EVENT_NAMES.listingView),
      listingViews: count(sourceRows, EVENT_NAMES.listingView),
      outboundClicks: count(sourceRows, EVENT_NAMES.outbound),
      signups: unique(sourceRows, EVENT_NAMES.signup),
      trials: unique(sourceRows, EVENT_NAMES.trial),
      research: unique(sourceRows, EVENT_NAMES.research),
      ask: unique(sourceRows, EVENT_NAMES.ask),
      activations: unique(sourceRows, EVENT_NAMES.activation),
      paid: unique(sourceRows, EVENT_NAMES.paid)
    };
  }
  return output;
}
function channelBreakdown(rows) {
  const output = {};
  for (const row of rows) {
    const bucket = channelBucket(row);
    if (!output[bucket]) output[bucket] = { events: 0, landingViews: 0, outboundClicks: 0, signups: 0, trials: 0, research: 0, ask: 0, activations: 0, paid: 0 };
    const item = output[bucket];
    const name = eventName(row);
    item.events++;
    if (EVENT_NAMES.landingView.has(name) || EVENT_NAMES.listingView.has(name)) item.landingViews++;
    if (EVENT_NAMES.outbound.has(name)) item.outboundClicks++;
    if (EVENT_NAMES.signup.has(name)) item.signups++;
    if (EVENT_NAMES.trial.has(name)) item.trials++;
    if (EVENT_NAMES.research.has(name)) item.research++;
    if (EVENT_NAMES.ask.has(name)) item.ask++;
    if (EVENT_NAMES.activation.has(name)) item.activations++;
    if (EVENT_NAMES.paid.has(name)) item.paid++;
  }
  return output;
}
function funnel(rows) {
  return {
    listingImpressions: count(rows, EVENT_NAMES.listingView),
    listingVisits: count(rows, EVENT_NAMES.listingView),
    websiteLandingViews: count(rows, EVENT_NAMES.landingView),
    outboundClicks: count(rows, EVENT_NAMES.outbound),
    purchases: unique(rows, EVENT_NAMES.paid),
    codeActivations: unique(rows, new Set(['appsumo_redemption_completed', 'appsumo_redemption', 'appsumo_activation'])),
    accountCreation: unique(rows, EVENT_NAMES.signup),
    firstResearch: unique(rows, EVENT_NAMES.research),
    firstAsk: unique(rows, EVENT_NAMES.ask),
    sevenDayReturn: unique(rows, EVENT_NAMES.return7),
    refunds: count(rows, EVENT_NAMES.refund),
    cancellations: count(rows, EVENT_NAMES.cancellation),
    reportableEvents: rows.length,
    sessions: uniqueSessions(rows)
  };
}
function weekly(rows) {
  const buckets = new Map();
  for (const row of rows) {
    const date = eventDate(row);
    if (!date) continue;
    const key = monday(date).toISOString().slice(0, 10);
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(row);
  }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([week, values]) => ({ week, ...funnel(values), sources: sourceBreakdown(values) }));
}
function missingEvents(rows) {
  const names = new Set(rows.map(eventName));
  return ['appsumo_landing_view', 'appsumo_cta_click', 'appsumo_activation', 'signup_completed', 'first_research_completed', 'first_ask_succeeded', 'seven_day_return']
    .filter((name) => !names.has(name));
}
function pct(numerator, denominator) { return denominator ? Number((numerator / denominator).toFixed(4)) : null; }
function diagnosis({ rows, licenses, users }) {
  const reportableRows = rows.filter(reportable);
  const all = funnel(reportableRows);
  const redeemed = users.filter((user) => user.appsumoRedeemedAt);
  const activated = redeemed.filter((user) => user.lastSuccessfulOutcomeAt || user.firstActivationAt);
  const activationEvents = unique(reportableRows, EVENT_NAMES.activation);
  const portal = 'AppSumo Partner Portal listing impressions, listing visits, order status, gross sales, partner proceeds and refunds were not present in the application database.';
  return [
    { confidence: 'VERIFIED', finding: `The public listing currently shows no reviews and three plans with 30/100/300 monthly Ask questions; it also states lifetime access, 60-day refunds and 60-day activation.`, evidence: 'AppSumo listing: https://appsumo.com/products/stockportfoliopro/' },
    { confidence: 'VERIFIED', finding: `The application has ${all.outboundClicks} reportable AppSumo outbound events in the audit range and ${all.purchases} distinct paid/redemption users in those events; the application event count is not a substitute for Partner Portal orders.`, evidence: 'funnel_events with internal, bot, test and non-reportable rows excluded' },
    { confidence: 'VERIFIED', finding: `${redeemed.length} current AppSumo redemptions are present in MongoDB; ${activationEvents} distinct users have a reportable product-activation event and ${activated.length} have a stored successful-outcome/activation timestamp.`, evidence: 'users.appsumoRedeemedAt plus reportable funnel activation events' },
    { confidence: 'LIKELY', finding: 'Conversion measurement is incomplete: listing impressions/visits, first research, first Ask success, seven-day return, and authoritative refund/GMV fields are not available in the first-party event set.', evidence: `${portal} Missing event names: ${missingEvents(rows).join(', ') || 'none'}` },
    { confidence: 'PLAUSIBLE', finding: 'Zero public reviews and unresolved uncertainty about lifetime-deal continuity can reduce buyer confidence, but the available data cannot prove that either caused the sales stall.', evidence: 'Zero reviews is verified; category-level trust is a hypothesis' },
    { confidence: 'UNKNOWN', finding: 'Whether the stall is driven by falling listing distribution, lower buy clicks, checkout friction, or deal-confidence cannot be determined until the Partner Portal export is joined to the click series.', evidence: 'Partner Portal export required' }
  ];
}
function markdown(report) {
  const lines = [
    '# StockPortfolio.pro AppSumo trust and conversion audit', '',
    `Generated: ${report.generatedAt}`, `Audit window: ${report.window.since} → ${report.window.until}`, '',
    '## Executive diagnosis', '',
    ...report.diagnosis.map((item) => `- **${item.confidence}** — ${item.finding} _Evidence:_ ${item.evidence}`), '',
    '## Reportable first-party funnel', '',
    '| Week (UTC Monday) | Listing views | Website views | AppSumo clicks | Purchases* | Activations* | Signups* | Research* | Ask* | 7-day return* | Refunds | Cancellations |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|',
    ...report.weekly.map((row) => `| ${row.week} | ${row.listingImpressions} | ${row.websiteLandingViews} | ${row.outboundClicks} | ${row.purchases} | ${row.codeActivations} | ${row.accountCreation} | ${row.firstResearch} | ${row.firstAsk} | ${row.sevenDayReturn} | ${row.refunds} | ${row.cancellations} |`),
    '', '*Distinct users where an identifier exists. Listing metrics are unavailable unless explicitly recorded; clicks and redemptions are application events, not Partner Portal truth.', '',
    '## Overall funnel', '',
    '```json', JSON.stringify(report.overall, null, 2), '```', '',
    '## Source segmentation', '',
    '```json', JSON.stringify(report.sources, null, 2), '```', '',
    'Direct is not treated as verified brand demand: it can include untagged social links, privacy browsers, apps and internal activity.', '',
    '## Explicit channel segmentation', '',
    'Only explicit source/content markers are used. Unmarked X traffic remains `x_unclassified`; Direct/unknown is not treated as brand demand.', '',
    '```json', JSON.stringify(report.channels, null, 2), '```', '',
    '## Missing instrumentation', '',
    ...report.missingInstrumentation.map((item) => `- **${item}**: not observed in first-party events for this audit.`), '',
    'Required event contract: `appsumo_landing_view`, `appsumo_cta_click`, `appsumo_activation`, `signup_completed`, `first_research_completed`, `first_ask_succeeded`, `seven_day_return`. Historical aliases (`signup_complete`, `first_research_complete`, `first_ask_success`) normalize to the canonical names for reporting and replay compatibility; they are not emitted by current code.', '',
    '## Plan mapping (observed, not a contract change)', '',
    '| AppSumo tier | Price | Monthly Ask cap | Stored entitlement |', '|---|---:|---:|---|',
    '| Starter / Tier 1 | $39 one-time | 30 | Pro — AppSumo (Starter) |',
    '| Investor / Tier 2 | $79 one-time | 100 | Pro — AppSumo (Investor) |',
    '| Pro / Tier 3 | $149 one-time | 300 | Pro — AppSumo (Pro) |', '',
    'The application grants the AppSumo tier a Pro feature ladder and applies the monthly Ask cap. Power and Desk are separate recurring website plans in code. The live AppSumo listing says “all future plan updates”; the exact interaction between that phrase and future Power/Desk features is a contractual question and is not changed by this audit.', '',
    '### Plan-mapping contradictions and unresolved wording', '',
    '- **VERIFIED difference:** AppSumo is a one-time lifetime offer with tier-specific monthly Ask allowances, while the website also presents recurring monthly/annual plans.',
    '- **UNRESOLVED wording:** “All future plan updates” does not say whether future Power or Desk features are included for AppSumo buyers; no entitlement change is made here.',
    '- **UNRESOLVED wording:** the listing and application both expose “Pro” terminology, but the stored `Pro — AppSumo` entitlement is not the same billing object as recurring website Pro.', '',
    '## Ask incident', '',
    '- **Beginning:** unknown from repository/health evidence available to this audit.',
    '- **Resolution:** the recovery implementation is present in commit `e20eb388`; exact production resolution time is not established here.',
    '- **Root cause / impacted requests / prevention:** unknown without Render request logs and incident records.',
    '- **Prepared closure (do not publish):** “Resolved on [verified date and time]. Ask is operating normally again. The cause was [verified factual explanation], and we added [verified monitoring or prevention]. I’m sorry I did not close the loop publicly sooner.”', '',
    '## Reviews and customer evidence', '',
    `- Current AppSumo license records: ${report.customerCounts.licenses}; redeemed users: ${report.customerCounts.redeemedUsers}; users with a reportable activation event: ${report.customerCounts.activatedUsers}; stored activation timestamps: ${report.customerCounts.storedActivationTimestamps}.`,
    `- Review-eligible users recorded: ${report.customerCounts.reviewEligible}; review requests recorded: ${report.customerCounts.reviewRequested}.`,
    '- No review request was sent by this audit. A short, honest draft is prepared below.', '',
    '> Hi [first name] — if you have used StockPortfolio.pro enough to form an opinion, would you leave an honest AppSumo review? Please mention what you researched, whether the source trail was useful, and what still needs work. No incentive and no request for a positive review. If anything is unclear or broken, reply and I’ll help first.', '',
    '## Partner Portal export required', '',
    'Export the following for `2026-08-01` through the audit end date (include the portal timezone and UTC timestamps if available):',
    '- listing impressions/views and listing visits;',
    '- buy/checkout/outbound clicks;',
    '- order ID, order timestamp, tier, gross sale, currency, partner proceeds, order status;',
    '- license/code ID and redemption timestamp;',
    '- refund, cancellation or dispute order ID, timestamp, amount, reason and status;',
    '- any source/campaign attribution dimensions supplied by AppSumo.', '',
    '## Exact safe changes made', '',
    '- Added privacy-safe `appsumo_landing_view` and `appsumo_cta_click` browser events behind existing analytics consent.',
    '- AppSumo campaign CTAs now carry signed-bridge-compatible `content_id`, `click_id`, `utm_source`, `utm_medium`, `utm_campaign`, and `utm_content` values.',
    '- Added campaign content IDs to the existing acquisition allowlist; no customer identity, prompt, cookie or secret is stored in event metadata.',
    '- Added `utm` capture to the server-side AppSumo outbound event.',
    '- Added idempotent server events for AppSumo activation, signup completion, first research completion, first Ask success, and seven-day return; historical rows remain unchanged.',
    '- No pricing, limits, entitlements, emails, public replies or external posts were changed or sent.', '',
    '## Founder post status', '',
    'A founder post remains a draft only. The approval-ready draft is `FOUNDER-POST-DRAFT-2026-08-11.md`. It must use the verified facts above, avoid naming competitors without approval, avoid forever/profitability/uptime claims, and must be approved before publication.', '',
    '## External changes awaiting approval', '',
    '- Publish the founder post.',
    '- Reply publicly to the Ask outage question.',
    '- Contact customers or send the honest-review request.',
    '- Change AppSumo terms, entitlements, tier limits or pricing.',
    '- Add or change contractual wording about Power, Desk or “all future plan updates”.',
    '- Request AppSumo amplification or modify the listing/Q&A.'
  ];
  return lines.join('\n') + '\n';
}
async function queryProduction() {
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, maxPoolSize: 2 });
  const db = mongoose.connection.db;
  const rows = await db.collection('funnel_events').find({}).project({
    event: 1, eventName: 1, eventType: 1, occurredAt: 1, timestamp: 1, at: 1, createdAt: 1,
    userId: 1, anonymousId: 1, anonymousSessionId: 1, sessionId: 1, firstTouch: 1, lastNonDirectTouch: 1,
    acquisitionSource: 1, source: 1, trafficSource: 1, referrerSource: 1, utm: 1, pagePath: 1, path: 1,
    trafficCategory: 1, internalFlag: 1, testFlag: 1, botFlag: 1, reportable: 1, meta: 1
  }).toArray();
  const users = await db.collection('users').find({}).project({
    appsumoRedeemedAt: 1, lastSuccessfulOutcomeAt: 1, firstActivationAt: 1,
    reviewEligibleAt: 1, reviewRequestSentAt: 1
  }).toArray();
  const licenses = await db.collection('appsumolicenses').find({}).project({ status: 1, tier: 1, redeemedAt: 1 }).toArray();
  await mongoose.disconnect();
  return { rows, users, licenses };
}
function buildAudit({ rows = [], users = [], licenses = [], now = new Date(), since = CAMPAIGN_START } = {}) {
  const dated = rows.map((row) => eventDate(row)).filter(Boolean);
  const until = now instanceof Date ? now : new Date(now);
  const start = since instanceof Date ? since : new Date(since);
  const range = inRange(rows.filter(reportable), start, until);
  return {
    generatedAt: new Date().toISOString(),
    window: { since: iso(start), until: iso(until) },
    sourceData: { totalEvents: rows.length, datedEvents: dated.length, earliestEvent: iso(dated.length ? new Date(Math.min(...dated.map((d) => d.getTime()))) : null), latestEvent: iso(dated.length ? new Date(Math.max(...dated.map((d) => d.getTime()))) : null), excludedEvents: rows.length - rows.filter(reportable).length },
    overall: funnel(range),
    sources: sourceBreakdown(range),
    channels: channelBreakdown(range),
    weekly: weekly(range),
    missingInstrumentation: missingEvents(range),
    customerCounts: {
      licenses: licenses.length,
      redeemedUsers: users.filter((user) => user.appsumoRedeemedAt).length,
      activatedUsers: unique(range, EVENT_NAMES.activation),
      storedActivationTimestamps: users.filter((user) => user.lastSuccessfulOutcomeAt || user.firstActivationAt).length,
      reviewEligible: users.filter((user) => user.reviewEligibleAt).length,
      reviewRequested: users.filter((user) => user.reviewRequestSentAt).length
    },
    diagnosis: diagnosis({ rows: range, licenses, users })
  };
}
async function main() {
  const output = arg('output');
  const format = arg('format', output && output.endsWith('.md') ? 'md' : 'json');
  const data = await queryProduction();
  const report = buildAudit(data);
  if (output) fs.writeFileSync(output, format === 'md' ? markdown(report) : `${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(format === 'md' ? markdown(report) : `${JSON.stringify(report, null, 2)}\n`);
}
if (require.main === module) main().catch(async (error) => { console.error(error.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });

module.exports = { buildAudit, diagnosis, eventDate, eventName, reportable, sourceOf, channelBucket, channelBreakdown, funnel, weekly };
