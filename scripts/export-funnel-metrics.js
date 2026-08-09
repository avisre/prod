#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/prod.env') });
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/.env') });

const mongoose = require(path.join(__dirname, '../backend/node_modules/mongoose'));

const OUT = path.join(__dirname, '../marketing/appsumo-30-day/metrics.csv');
const HEADER = 'date,asset_id,channel,post_url,impressions,meaningful_replies,bridge_visits,signups,trial_started_at,trial_ends_at,auth_method,acquisition_source,activation_job,redemptions,customers,converted_via,converted_at,reviews,objection,notes';

function arg(name, fallback) {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}

function day(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function sourceFor(event) {
  return String(
    event?.utm?.source || event.acquisitionSource || event.source ||
    event.trafficSource || event.referrerSource || 'direct'
  ).trim().toLowerCase() || 'direct';
}

function eventTypeFor(event) {
  const raw = String(event?.eventType || event?.event || '');
  if (raw === 'free_tool_view') return 'tool_view';
  if (raw === 'free_tool_complete') return 'tool_complete';
  if (raw === 'appsumo_outbound') return 'appsumo_click';
  // Older funnel rows predate eventType and store only event=paid plus
  // source=appsumo/stripe. Keep those rows reportable instead of silently
  // dropping their customer conversion.
  if (raw === 'paid') return sourceFor(event) === 'appsumo' ? 'appsumo_redemption' : 'stripe_subscribe';
  return raw;
}

function csv(value) {
  const text = String(value == null ? '' : value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

async function main() {
  const since = new Date(arg('since', new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10)));
  const until = new Date(arg('until', new Date().toISOString().slice(0, 10)));
  until.setUTCDate(until.getUTCDate() + 1);
  if (!Number.isFinite(+since) || !Number.isFinite(+until)) throw new Error('Use --since=YYYY-MM-DD and optional --until=YYYY-MM-DD');
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI is required');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  const events = await mongoose.connection.db.collection('funnel_events').find({
    $or: [{ timestamp: { $gte: since, $lt: until } }, { at: { $gte: since, $lt: until } }]
  }).sort({ timestamp: 1, at: 1 }).toArray();

  const rows = new Map();
  const countedConversions = new Set();
  for (const event of events) {
    const eventDate = day(event.timestamp || event.at);
    const channel = sourceFor(event);
    const key = `${eventDate}:${channel}`;
    if (!rows.has(key)) {
      rows.set(key, {
        date: eventDate, asset_id: '', channel, post_url: '', impressions: 0,
        meaningful_replies: '', bridge_visits: 0, signups: 0, trial_started_at: '',
        trial_ends_at: '', auth_method: '', acquisition_source: channel,
        activation_job: '', redemptions: 0, customers: 0, converted_via: '',
        converted_at: '', reviews: 0, objection: '', notes: ''
      });
    }
    const row = rows.get(key);
    const eventType = eventTypeFor(event);
    if (eventType === 'page_view' || event.event === 'page_view') row.impressions++;
    if (eventType === 'tool_view') row.impressions++;
    if (eventType === 'appsumo_click' || event.event === 'appsumo_outbound') row.bridge_visits++;
    if (eventType === 'signup' || event.event === 'signup') row.signups++;
    if (eventType === 'trial_start' || event.event === 'trial_start') {
      row.trial_started_at = row.trial_started_at || new Date(event.timestamp || event.at).toISOString();
      row.auth_method = row.auth_method || event.authMethod || '';
    }
    if (eventType === 'stripe_subscribe') {
      const key = event.userId ? `stripe:${event.userId}` : `stripe:${event._id || eventDate}:${channel}`;
      if (!countedConversions.has(key)) {
        countedConversions.add(key);
        row.customers++;
        row.converted_via = row.converted_via || 'stripe';
        row.converted_at = row.converted_at || new Date(event.timestamp || event.at).toISOString();
      }
    }
    if (eventType === 'appsumo_redemption') {
      const key = event.userId ? `appsumo:${event.userId}` : `appsumo:${event._id || eventDate}:${channel}`;
      if (!countedConversions.has(key)) {
        countedConversions.add(key);
        row.redemptions++;
        row.customers++;
        row.converted_via = row.converted_via || 'appsumo';
        row.converted_at = row.converted_at || new Date(event.timestamp || event.at).toISOString();
      }
    }
    if (eventType === 'review_submitted') row.reviews++;
    if (event.activationJob) row.activation_job = row.activation_job || event.activationJob;
  }

  const columns = HEADER.split(',');
  const lines = [HEADER, ...[...rows.values()]
    .sort((a, b) => `${a.date}:${a.channel}`.localeCompare(`${b.date}:${b.channel}`))
    .map((row) => columns.map((column) => csv(row[column])).join(','))];
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, lines.join('\n') + '\n');
  console.log(`Wrote ${rows.size} rows to ${OUT}`);
  await mongoose.disconnect();
}

main().catch(async (error) => {
  console.error(error && error.message || error);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
