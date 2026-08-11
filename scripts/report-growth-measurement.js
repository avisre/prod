#!/usr/bin/env node
'use strict';

// Read-only Growth Measurement V1 report. Mongo is queried for first-party
// events only; GA4, Clarity, Stripe and AppSumo snapshots are optional,
// explicitly attached files. This command never writes to Mongo or an external
// analytics property.
const fs = require('node:fs');
const path = require('node:path');
const growth = require(path.join(__dirname, '../backend/growth-measurement'));
const mongoose = require(path.join(__dirname, '../backend/node_modules/mongoose'));
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/prod.env') });
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/.env') });

const STEP_EVENTS = Object.freeze({
    visitor: null,
    cta: new Set(['cta_clicked', 'appsumo_outbound_clicked']),
    signup: new Set(['signup_completed']),
    activation: new Set(['activation_completed']),
    paid: new Set(['invoice_paid', 'appsumo_redemption_completed'])
});
const FUNNEL_NAMES = [
    'pricing_viewed', 'cta_clicked', 'appsumo_outbound_clicked', 'signup_started',
    'checkout_started', 'signup_completed', 'research_outcome_completed',
    'activation_completed', 'appsumo_redemption_started', 'appsumo_redemption_completed',
    'stripe_checkout_created', 'stripe_checkout_completed', 'subscription_started',
    'invoice_paid', 'payment_refunded', 'subscription_canceled', 'review_eligible',
    'review_request_sent', 'review_received', 'support_outcome_confirmed'
];
const SAFE_SNAPSHOT_KEYS = new Set([
    'activeUsers', 'users', 'sessions', 'pageViews', 'events', 'signups', 'activations',
    'purchases', 'refunds', 'firstUserSource', 'sessionSourceMedium', 'source', 'medium',
    'channel', 'count', 'value', 'date', 'days', 'window', 'rows', 'sales', 'grossSales',
    'partnerPayout', 'refundAmount', 'activeMrr', 'recurringRevenue', 'paidConversions',
    'scheduledToCancelMrr', 'churn', 'gmvAvailable'
]);

function arg(name, fallback = '') {
    const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
}
function parseDate(value) {
    const date = value instanceof Date ? value : new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}
function eventDate(row) { return parseDate(row.occurredAt || row.timestamp || row.at || row.createdAt); }
function eventName(row) {
    const raw = row && (row.eventName || row.event || row.eventType);
    return growth.normalizeEventName(raw, row) || (raw ? String(raw).trim().toLowerCase() : null);
}
function sourceFor(row, touch = 'firstTouch') {
    const touchValue = row && row[touch] && row[touch].source;
    const raw = touchValue || row.referrerSource || row.acquisitionSource || row.source || 'unknown';
    return growth.normalizeSource(raw) || 'unknown';
}
function reportable(row) {
    return row.reportable !== false && row.internalFlag !== true && row.testFlag !== true && row.botFlag !== true;
}
function identity(row, { user = false } = {}) {
    if (user) return row.userId ? `u:${row.userId}` : null;
    return row.anonymousId || row.anonymousSessionId || row.sessionId || (row.userId ? `u:${row.userId}` : null);
}
function uniqueCount(rows, predicate = () => true, options = {}) {
    const values = new Set();
    for (const row of rows) {
        if (!predicate(row)) continue;
        const value = identity(row, options);
        if (value) values.add(value);
    }
    return values.size;
}
function countEvents(rows, names) {
    const set = names instanceof Set ? names : new Set(names);
    return rows.filter((row) => set.has(eventName(row))).length;
}
function uniqueEventUsers(rows, names) {
    const set = names instanceof Set ? names : new Set(names);
    return uniqueCount(rows, (row) => set.has(eventName(row)), { user: true });
}
function eventRows(rows, names) {
    const set = names instanceof Set ? names : new Set(names);
    return rows.filter((row) => set.has(eventName(row)));
}
function inWindow(rows, since, until) {
    return rows.filter((row) => { const date = eventDate(row); return date && date >= since && date < until; });
}
function mapCount(rows, keyFn) {
    const result = {};
    for (const row of rows) {
        const key = String(keyFn(row) || 'unknown');
        result[key] = (result[key] || 0) + 1;
    }
    return result;
}
function sum(rows, key) { return rows.reduce((total, row) => total + (Number(row[key]) || 0), 0); }

function funnelSummary(rows) {
    const reportableRows = rows.filter(reportable);
    const activated = eventRows(reportableRows, STEP_EVENTS.activation);
    const paid = eventRows(reportableRows, STEP_EVENTS.paid);
    const invoiceRows = eventRows(reportableRows, ['invoice_paid']);
    const refundRows = eventRows(reportableRows, ['payment_refunded']);
    return {
        uniqueVisitors: uniqueCount(reportableRows),
        uniqueSessions: new Set(reportableRows.map((row) => row.sessionId || row.anonymousSessionId).filter(Boolean)).size,
        registeredUsers: uniqueEventUsers(reportableRows, STEP_EVENTS.signup),
        ctaVisitors: uniqueCount(reportableRows, (row) => STEP_EVENTS.cta.has(eventName(row))),
        signups: uniqueEventUsers(reportableRows, STEP_EVENTS.signup),
        activatedAccounts: new Set(activated.map((row) => row.userId).filter(Boolean)).size,
        paidCustomers: new Set(paid.map((row) => row.userId).filter(Boolean)).size,
        stripe: {
            paidConversions: new Set(invoiceRows.map((row) => row.userId).filter(Boolean)).size,
            recurringRevenue: invoiceRows.reduce((total, row) => total + (Number(row.amountMinor) || 0), 0) / 100,
            refunds: refundRows.reduce((total, row) => total + (Number(row.amountMinor) || 0), 0) / 100,
            activeMrr: null,
            note: 'Active MRR requires the current verified Stripe subscription snapshot; it is never inferred from a Stripe Customer object.'
        },
        eventCounts: Object.fromEntries(FUNNEL_NAMES.map((name) => [name, countEvents(reportableRows, [name])])),
        excludedEvents: rows.length - reportableRows.length
    };
}

function funnelByTouch(rows, touch) {
    const reportableRows = rows.filter(reportable);
    const sources = new Set(reportableRows.map((row) => sourceFor(row, touch)));
    const output = {};
    for (const source of sources) {
        const sourceRows = reportableRows.filter((row) => sourceFor(row, touch) === source);
        output[source] = {
            visitors: uniqueCount(sourceRows),
            ctaVisitors: uniqueCount(sourceRows, (row) => STEP_EVENTS.cta.has(eventName(row))),
            signups: uniqueEventUsers(sourceRows, STEP_EVENTS.signup),
            activatedAccounts: uniqueEventUsers(sourceRows, STEP_EVENTS.activation),
            paidCustomers: uniqueEventUsers(sourceRows, STEP_EVENTS.paid)
        };
    }
    return output;
}

function landingPerformance(rows) {
    const pages = new Map();
    for (const row of rows.filter(reportable)) {
        const pagePath = row.pagePath || row.path || '/';
        if (!pages.has(pagePath)) pages.set(pagePath, { pageViews: 0, ctaClicks: 0, signups: 0, activations: 0 });
        const item = pages.get(pagePath);
        const name = eventName(row);
        if (name === 'page_view') item.pageViews++;
        if (STEP_EVENTS.cta.has(name)) item.ctaClicks++;
        if (name === 'signup_completed') item.signups++;
        if (name === 'activation_completed') item.activations++;
    }
    return Object.fromEntries([...pages.entries()].sort((a, b) => (b[1].pageViews + b[1].ctaClicks) - (a[1].pageViews + a[1].ctaClicks)));
}

function ctaPerformance(rows) {
    const output = {};
    for (const row of rows.filter(reportable)) {
        const name = eventName(row);
        if (!STEP_EVENTS.cta.has(name)) continue;
        const ctaId = row.ctaId || 'unlabelled';
        if (!output[ctaId]) output[ctaId] = { clicks: 0, uniqueVisitors: 0, sources: {} };
        output[ctaId].clicks++;
        output[ctaId].sources[sourceFor(row)] = (output[ctaId].sources[sourceFor(row)] || 0) + 1;
    }
    for (const [ctaId, item] of Object.entries(output)) {
        item.uniqueVisitors = uniqueCount(rows.filter((row) => (row.ctaId || 'unlabelled') === ctaId && STEP_EVENTS.cta.has(eventName(row))));
    }
    return output;
}

function contentPerformance(rows) {
    const output = {};
    for (const row of rows.filter(reportable)) {
        const contentId = row.contentId || row.firstTouch?.contentId || row.lastNonDirectTouch?.contentId;
        if (!contentId) continue;
        const key = `${sourceFor(row)}:${contentId}`;
        if (!output[key]) output[key] = { source: sourceFor(row), contentId, events: 0, clicks: 0, signups: 0, activations: 0, paid: 0 };
        const item = output[key]; item.events++;
        const name = eventName(row);
        if (STEP_EVENTS.cta.has(name)) item.clicks++;
        if (name === 'signup_completed') item.signups++;
        if (name === 'activation_completed') item.activations++;
        if (STEP_EVENTS.paid.has(name)) item.paid++;
    }
    return output;
}

function trafficSummary(rows) {
    return mapCount(rows, (row) => row.botFlag ? 'bot' : row.internalFlag ? 'internal' : row.testFlag ? 'test' : sourceFor(row));
}

function dataQuality(rows) {
    const canonicalRows = rows.filter((row) => row.eventName || row.schemaVersion);
    const eventIds = mapCount(canonicalRows.filter((row) => row.eventId), (row) => row.eventId);
    const dedupeKeys = mapCount(rows.filter((row) => row.dedupeKey), (row) => row.dedupeKey);
    const duplicateValues = (map) => Object.values(map).filter((value) => value > 1).reduce((a, b) => a + b - 1, 0);
    const missing = {
        anonymous: rows.filter((row) => !row.anonymousId && !row.anonymousSessionId).length,
        session: rows.filter((row) => !row.sessionId && !row.anonymousSessionId).length,
        user: rows.filter((row) => !row.userId).length
    };
    const invalid = canonicalRows.filter((row) => row.schemaVersion !== growth.SCHEMA_VERSION || !growth.normalizeEventName(row.eventName, row)).length;
    const browser = rows.filter((row) => ['pricing_viewed', 'cta_clicked', 'appsumo_outbound_clicked', 'signup_started', 'checkout_started'].includes(eventName(row)));
    const server = rows.filter((row) => ['signup_completed', 'activation_completed', 'invoice_paid', 'appsumo_redemption_completed'].includes(eventName(row)));
    return {
        totalEvents: rows.length,
        eventsWithSource: rows.filter((row) => row.referrerSource || row.acquisitionSource || row.firstTouch?.source || row.lastNonDirectTouch?.source).length,
        eventsWithoutSource: rows.filter((row) => !row.referrerSource && !row.acquisitionSource && !row.firstTouch?.source && !row.lastNonDirectTouch?.source).length,
        missingIdentifiers: missing,
        duplicateEventIds: duplicateValues(eventIds),
        duplicateDedupeKeys: duplicateValues(dedupeKeys),
        invalidCanonicalPayloads: invalid,
        excludedEvents: rows.filter((row) => !reportable(row)).length,
        clientServerCounts: { browserIntentEvents: browser.length, serverTruthEvents: server.length }
    };
}

function retention(rows, since, until) {
    const activations = new Map();
    for (const row of rows.filter((item) => reportable(item) && eventName(item) === 'activation_completed' && item.userId)) {
        const date = eventDate(row); if (!date) continue;
        const key = String(row.userId);
        if (!activations.has(key) || date < activations.get(key)) activations.set(key, date);
    }
    const output = {};
    for (const days of [1, 7, 30]) {
        let eligible = 0; let returned = 0;
        for (const [userId, activatedAt] of activations) {
            if (activatedAt < since || activatedAt >= until) continue;
            const target = new Date(activatedAt.getTime() + days * 86400000);
            if (target >= until) continue;
            eligible++;
            const cameBack = rows.some((row) => row.userId && String(row.userId) === userId && reportable(row)
                && eventDate(row) >= target && eventDate(row) < new Date(target.getTime() + 86400000)
                && eventName(row) !== 'activation_completed');
            if (cameBack) returned++;
        }
        output[`D${days}`] = { eligible, returned, rate: eligible ? returned / eligible : null };
    }
    return output;
}

function sanitizeSnapshot(input) {
    if (!input || typeof input !== 'object') return null;
    const clean = (value, depth = 0) => {
        if (depth > 2 || value == null || typeof value === 'boolean' || typeof value === 'number') return value;
        if (typeof value === 'string') return value.slice(0, 160);
        if (Array.isArray(value)) return value.slice(0, 100).map((item) => clean(item, depth + 1));
        if (typeof value !== 'object') return null;
        const object = {};
        for (const [key, val] of Object.entries(value)) {
            if (!SAFE_SNAPSHOT_KEYS.has(key) || /email|token|secret|license|prompt|answer|holding|password|id/i.test(key)) continue;
            object[key] = clean(val, depth + 1);
        }
        return object;
    };
    return clean(input);
}
function loadJson(file) { if (!file) return null; try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; } }
function appsumoSummary(raw) {
    if (!raw) return { attached: false };
    const rows = Array.isArray(raw.rows) ? raw.rows : [];
    const hasNumber = (field) => rows.some((row) => Number.isFinite(Number(row[field])));
    return {
        attached: true,
        portalSales: Number(raw.sales || rows.length) || 0,
        grossSales: rows.length ? (hasNumber('grossSales') ? sum(rows, 'grossSales') : null) : Number.isFinite(Number(raw.grossSales)) ? Number(raw.grossSales) : null,
        partnerPayout: rows.length ? (hasNumber('partnerPayout') ? sum(rows, 'partnerPayout') : null) : Number.isFinite(Number(raw.partnerPayout)) ? Number(raw.partnerPayout) : null,
        refunds: rows.length ? (hasNumber('refundAmount') ? sum(rows, 'refundAmount') : null) : Number.isFinite(Number(raw.refunds)) ? Number(raw.refunds) : null,
        gmvAvailable: rows.length ? hasNumber('grossSales') : raw.gmvAvailable === true
    };
}
function stripeSummary(raw) {
    if (!raw) return { attached: false };
    return {
        attached: true,
        paidConversions: Number(raw.paidConversions) || 0,
        activeMrr: Number(raw.activeMrr) || 0,
        recurringRevenue: Number(raw.recurringRevenue) || 0,
        scheduledToCancelMrr: Number(raw.scheduledToCancelMrr) || 0,
        churn: Number(raw.churn) || 0,
        refunds: Number(raw.refunds) || 0,
        testModeExcluded: Number(raw.testModeExcluded) || 0
    };
}

function summaryForPeriod(rows, since, until, options = {}) {
    const periodRows = inWindow(rows, since, until);
    const current = funnelSummary(periodRows);
    current.period = { since: since.toISOString(), until: until.toISOString() };
    current.conversionRates = {
        visitorToCta: current.uniqueVisitors ? current.ctaVisitors / current.uniqueVisitors : null,
        ctaToSignup: current.ctaVisitors ? current.signups / current.ctaVisitors : null,
        signupToActivation: current.signups ? current.activatedAccounts / current.signups : null,
        activationToPaid: current.activatedAccounts ? current.paidCustomers / current.activatedAccounts : null
    };
    current.funnelByFirstTouch = funnelByTouch(periodRows, 'firstTouch');
    current.funnelByLastNonDirectTouch = funnelByTouch(periodRows, 'lastNonDirectTouch');
    current.landingPages = landingPerformance(periodRows);
    current.ctas = ctaPerformance(periodRows);
    current.content = contentPerformance(periodRows);
    current.traffic = trafficSummary(periodRows);
    current.quality = dataQuality(periodRows);
    current.retention = retention(options.retentionRows || periodRows, since, until);
    return current;
}

function buildReport(rows, { days = 28, since, until, external = {} } = {}) {
    const end = until || new Date();
    const start = since || new Date(end.getTime() - days * 86400000);
    const previousStart = new Date(start.getTime() - days * 86400000);
    const current = summaryForPeriod(rows, start, end, { retentionRows: rows });
    const previous = summaryForPeriod(rows, previousStart, start, { retentionRows: rows });
    return {
        schemaVersion: growth.SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        window: { days, since: start.toISOString(), until: end.toISOString() },
        current,
        previous,
        comparison: {
            uniqueVisitorsDelta: current.uniqueVisitors - previous.uniqueVisitors,
            signupsDelta: current.signups - previous.signups,
            activationsDelta: current.activatedAccounts - previous.activatedAccounts,
            paidCustomersDelta: current.paidCustomers - previous.paidCustomers
        },
        external: {
            ga4: sanitizeSnapshot(external.ga4),
            clarity: sanitizeSnapshot(external.clarity),
            appsumo: appsumoSummary(external.appsumo),
            stripe: stripeSummary(external.stripe)
        },
        note: 'GA4 users, Clarity sessions, first-party events, AppSumo payout/GMV and Stripe MRR are separate measures. Historical missing attribution remains unknown; no sale is inferred from a click or redemption.'
    };
}

function markdown(report) {
    const current = report.current;
    const table = (object) => Object.entries(object || {}).map(([key, value]) => `| ${key} | ${typeof value === 'object' ? JSON.stringify(value) : value} |`).join('\n');
    const lines = [
        `# Growth Measurement V1 (${report.window.days} days)`, '',
        `Window: ${report.window.since} → ${report.window.until}`, '',
        '## First-party funnel', '',
        '| Metric | Value |', '|---|---:|',
        `| Unique visitors | ${current.uniqueVisitors} |`, `| Unique sessions | ${current.uniqueSessions} |`,
        `| Registered users | ${current.registeredUsers} |`, `| CTA visitors | ${current.ctaVisitors} |`,
        `| Signups | ${current.signups} |`, `| Activated accounts | ${current.activatedAccounts} |`,
        `| Paid customers (AppSumo redemption or Stripe invoice) | ${current.paidCustomers} |`, '',
        '| Event | Count |', '|---|---:|', table(current.eventCounts), '',
        '## Conversion rates', '', '| Step | Rate |', '|---|---:|',
        `| Visitor → CTA | ${formatRate(current.conversionRates.visitorToCta)} |`,
        `| CTA → signup | ${formatRate(current.conversionRates.ctaToSignup)} |`,
        `| Signup → activation | ${formatRate(current.conversionRates.signupToActivation)} |`,
        `| Activation → paid | ${formatRate(current.conversionRates.activationToPaid)} |`, '',
        '## Stripe event revenue truth', '',
        '```json', JSON.stringify(current.stripe, null, 2), '```', '',
        '## Traffic and attribution', '', '| Category | Events |', '|---|---:|', table(current.traffic), '',
        '### Funnel by first touch', '', '```json', JSON.stringify(current.funnelByFirstTouch, null, 2), '```',
        '### Funnel by last non-direct touch', '', '```json', JSON.stringify(current.funnelByLastNonDirectTouch, null, 2), '```', '',
        '## Landing pages and CTAs', '', '```json', JSON.stringify({ landingPages: current.landingPages, ctas: current.ctas }, null, 2), '```', '',
        '## Content performance', '', '```json', JSON.stringify(current.content, null, 2), '```', '',
        '## Retention', '', '```json', JSON.stringify(current.retention, null, 2), '```', '',
        '## Data quality', '', '```json', JSON.stringify(current.quality, null, 2), '```', '',
        '## Current versus previous comparable period', '', '```json', JSON.stringify(report.comparison, null, 2), '```', '',
        '## External system snapshots', '', '```json', JSON.stringify(report.external, null, 2), '```', '',
        'GA4, Clarity, AppSumo Partner Portal and Stripe values are shown separately and only when a sanitized snapshot is explicitly attached.'
    ];
    return lines.join('\n') + '\n';
}
function formatRate(value) { return value == null ? '—' : `${(value * 100).toFixed(2)}%`; }

async function queryEvents(since, until) {
    const collection = mongoose.connection.db.collection('funnel_events');
    return collection.find({ $or: [
        { occurredAt: { $gte: since, $lt: until } },
        { timestamp: { $gte: since, $lt: until } },
        { at: { $gte: since, $lt: until } }
    ] }, { projection: {
        event: 1, eventType: 1, eventName: 1, schemaVersion: 1, eventId: 1, dedupeKey: 1,
        occurredAt: 1, timestamp: 1, at: 1, userId: 1, anonymousId: 1, anonymousSessionId: 1,
        sessionId: 1, firstTouch: 1, lastNonDirectTouch: 1, currentSessionTouch: 1,
        pagePath: 1, path: 1, contentId: 1, ctaId: 1, referrerSource: 1, acquisitionSource: 1,
        source: 1, internalFlag: 1, testFlag: 1, botFlag: 1, reportable: 1
    } }).toArray();
}

async function main() {
    const days = [7, 28, 90].includes(Number(arg('days'))) ? Number(arg('days')) : 28;
    const fixture = arg('fixture');
    const external = {
        ga4: loadJson(arg('ga4')),
        clarity: loadJson(arg('clarity')),
        appsumo: loadJson(arg('appsumo')),
        stripe: loadJson(arg('stripe'))
    };
    let rows;
    let until = new Date();
    if (fixture) {
        const input = loadJson(fixture);
        rows = Array.isArray(input?.events) ? input.events : [];
        if (input?.window?.until) until = parseDate(input.window.until) || until;
    } else {
        const uri = process.env.MONGODB_URI;
        if (!uri) throw new Error('MONGODB_URI is required (or use --fixture=/path/to/sanitized.json)');
        const since = new Date(until.getTime() - (days * 2 + 31) * 86400000);
        await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
        rows = await queryEvents(since, new Date(until.getTime() + 31 * 86400000));
    }
    const report = buildReport(rows, { days, until, external });
    const output = arg('output');
    if (output && output.endsWith('.md')) fs.writeFileSync(output, markdown(report));
    else if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
    else console.log(JSON.stringify(report, null, 2));
    if (!fixture) await mongoose.disconnect();
}

if (require.main === module) {
    main().catch(async (error) => {
        console.error(error.message);
        try { await mongoose.disconnect(); } catch (_) {}
        process.exit(1);
    });
}

module.exports = { buildReport, dataQuality, funnelSummary, retention, sanitizeSnapshot };
