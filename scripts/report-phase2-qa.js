#!/usr/bin/env node
'use strict';

// Read-only, aggregate-only verification for the tagged Phase 2 browser run.
// It never prints user IDs, email addresses, prompts, cookies or event payloads.
const path = require('node:path');
const mongoose = require(path.join(__dirname, '../backend/node_modules/mongoose'));
const dotenv = require(path.join(__dirname, '../backend/node_modules/dotenv'));
const growth = require(path.join(__dirname, '../backend/growth-measurement'));
dotenv.config({ path: path.join(__dirname, '../backend/prod.env') });
dotenv.config({ path: path.join(__dirname, '../backend/.env') });

function arg(name, fallback = '') {
    const hit = process.argv.find((value) => value.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
}
function safeClickId(value) {
    const result = String(value || '').trim();
    if (!/^[A-Za-z0-9._:-]{8,80}$/.test(result)) throw new Error('--click-id must be a bounded allowlisted value');
    return result;
}
function eventName(row) {
    return growth.normalizeEventName(row && (row.eventName || row.event || row.eventType)) || 'unknown';
}
async function main() {
    const clickId = safeClickId(arg('click-id', 'qa-phase2-20260811'));
    const since = arg('since', '2026-08-11T00:00:00.000Z');
    const date = new Date(since);
    if (!Number.isFinite(date.getTime())) throw new Error('--since must be an ISO timestamp');
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, maxPoolSize: 2 });
    const rows = await mongoose.connection.db.collection('funnel_events').find({
        $and: [
            { $or: [
                { acquisitionClickId: clickId },
                { 'firstTouch.clickId': clickId },
                { 'lastNonDirectTouch.clickId': clickId },
                { 'currentSessionTouch.clickId': clickId }
            ] },
            { $or: [
                { occurredAt: { $gte: date } },
                { timestamp: { $gte: date } },
                { at: { $gte: date } }
            ] }
        ]
    }).project({ event: 1, eventName: 1, eventType: 1, email: 1, name: 1, prompt: 1, question: 1, answer: 1 }).toArray();
    const counts = {};
    for (const row of rows) { const name = eventName(row); counts[name] = (counts[name] || 0) + 1; }
    const sensitiveFieldsObserved = rows.some((row) => ['email', 'name', 'prompt', 'question', 'answer'].some((field) => Object.prototype.hasOwnProperty.call(row, field)));
    console.log(JSON.stringify({
        clickId,
        since: date.toISOString(),
        matchedEvents: rows.length,
        eventCounts: counts,
        sensitiveFieldsObserved,
        expected: ['appsumo_landing_view', 'appsumo_cta_click', 'appsumo_activation', 'signup_completed', 'first_research_completed', 'first_ask_succeeded', 'seven_day_return']
    }, null, 2));
    await mongoose.disconnect();
}
if (require.main === module) main().catch(async (error) => { console.error(error.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
module.exports = { safeClickId, eventName };
