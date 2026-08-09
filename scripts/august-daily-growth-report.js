#!/usr/bin/env node
'use strict';

// Read-only daily report for the August AppSumo sprint. It deliberately keeps
// partner-portal GMV separate from the list-price proxy and never prints
// customer addresses, license keys or other identifying fields.
const fs = require('node:fs');
const path = require('node:path');
const mongoose = require(path.join(__dirname, '../backend/node_modules/mongoose'));
const dotenv = require(path.join(__dirname, '../backend/node_modules/dotenv'));
dotenv.config({ path: path.join(__dirname, '../backend/prod.env') });
dotenv.config({ path: path.join(__dirname, '../backend/.env') });

const OUT = path.join(__dirname, '../marketing/campaign-2026-08-appsumo-sprint/daily/2026-08-09.md');
const CAMPAIGN = 'appsumo_aug_2026';
const prices = { 1: 39, 2: 79, 3: 149 };

function arg(name, fallback) {
  const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : fallback;
}
function isoDay(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : new Date().toISOString().slice(0, 10);
}
function sourceOf(row) {
  return String(row?.utm?.source || row?.acquisitionSource || row?.source || row?.trafficSource || 'direct').trim().toLowerCase() || 'direct';
}
function eventType(row) {
  const raw = String(row?.eventType || row?.event || '').toLowerCase();
  if (raw === 'free_tool_view') return 'tool_view';
  if (raw === 'free_tool_complete') return 'tool_complete';
  if (raw === 'appsumo_outbound') return 'appsumo_click';
  if (raw === 'paid') return sourceOf(row) === 'appsumo' ? 'redemption' : 'paid';
  return raw;
}
function external(row) {
  if (row?.reportable === false) return false;
  const source = sourceOf(row);
  const text = JSON.stringify({ source, meta: row?.meta || {}, workflow: row?.workflow || '' }).toLowerCase();
  return !/(^|["':,])(?:internal|qa|owner|bot)(?:["':,]|$)/.test(text);
}
function parseCsvLine(line) {
  const fields = []; let field = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { field += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) { fields.push(field); field = ''; }
    else field += ch;
  }
  fields.push(field);
  return fields;
}
function readCsv(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).slice(1).map(parseCsvLine);
}
function countStatuses(file, columnIndex) {
  const rows = readCsv(file);
  return rows.reduce((acc, row) => { const value = String(row[columnIndex] || '').trim(); if (value) acc[value] = (acc[value] || 0) + 1; return acc; }, {});
}
function money(value) { return `$${Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: 2 })}`; }

async function main() {
  const day = isoDay(arg('date', new Date().toISOString().slice(0, 10)));
  const since = new Date(`${day}T00:00:00.000Z`);
  const until = new Date(since.getTime() + 86400000);
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is required');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, maxPoolSize: 2 });
  const db = mongoose.connection.db;
  const eventRows = await db.collection('funnel_events').find({ $or: [{ timestamp: { $gte: since, $lt: until } }, { at: { $gte: since, $lt: until } }] }).limit(100000).toArray();
  const events = eventRows.filter(external);
  const counts = {};
  for (const row of events) counts[eventType(row)] = (counts[eventType(row)] || 0) + 1;
  const sourceOpens = events.filter((row) => eventType(row) === 'appsumo_click' || row.sourceOpened === true).length;
  const licenses = await db.collection('appsumo_licenses').find({}).project({ tier: 1, redeemedAt: 1, status: 1 }).toArray();
  const redeemed = licenses.filter((row) => row.redeemedAt || String(row.status || '').toLowerCase() === 'redeemed');
  const redeemedUsers = await db.collection('users').find({ appsumoLicenseKey: { $ne: null }, appsumoRedeemedAt: { $ne: null } }).project({ appsumoTier: 1 }).toArray();
  const redeemedRows = redeemedUsers.length ? redeemedUsers.map((row) => ({ tier: row.appsumoTier })) : redeemed;
  const tiers = redeemedRows.reduce((acc, row) => { const tier = Number(row.tier || 0); if (tier) acc[tier] = (acc[tier] || 0) + 1; return acc; }, {});
  const listProxy = redeemedRows.reduce((sum, row) => sum + (prices[Number(row.tier)] || 0), 0);
  const reviewEligible = await db.collection('users').countDocuments({ reviewEligibleAt: { $ne: null } });
  const reviews = await db.collection('funnel_events').countDocuments({ event: 'review_submitted', reportable: { $ne: false }, timestamp: { $gte: since, $lt: until } });
  const emailRows = await db.collection('scheduled_emails').find({}).project({ status: 1, skippedReason: 1 }).toArray();
  const email = emailRows.reduce((acc, row) => { const status = String(row.status || 'scheduled'); acc[status] = (acc[status] || 0) + 1; if (status === 'skipped' && /already|duplicate/i.test(String(row.skippedReason || ''))) acc.duplicatePrevented++; return acc; }, { scheduled: 0, sent: 0, failed: 0, skipped: 0, duplicatePrevented: 0 });
  email.attempted = email.sent + email.failed;
  const outreachRows = await db.collection('campaign_outreach').find({
    $or: [
      { sentAt: { $gte: since, $lt: until } },
      { failedAt: { $gte: since, $lt: until } },
      { createdAt: { $gte: since, $lt: until } },
    ],
  }).project({ campaign: 1, status: 1, outreachKey: 1, to: 1 }).toArray();
  const outreach = outreachRows.reduce((acc, row) => {
    const campaign = String(row.campaign || 'unknown');
    const status = String(row.status || 'unknown');
    acc[campaign] ||= {};
    acc[campaign][status] = (acc[campaign][status] || 0) + 1;
    return acc;
  }, {});
  const activationSent = outreach['activation-help-2026-08-09']?.sent || 0;
  const activationFailed = outreach['activation-help-2026-08-09']?.failed || 0;
  const supportSent = outreach['support-conversations-2026-08-09']?.sent || 0;
  const supportFailed = outreach['support-conversations-2026-08-09']?.failed || 0;
  const creatorSent = outreach['creator-outreach-2026-08-09']?.sent || 0;
  const creatorFailed = outreach['creator-outreach-2026-08-09']?.failed || 0;
  const activationRecipients = new Set(outreachRows
    .filter((row) => row.campaign === 'activation-help-2026-08-09' && row.status === 'sent')
    .map((row) => String(row.to || '').trim().toLowerCase()).filter(Boolean));
  const supportRecipients = new Set(outreachRows
    .filter((row) => row.campaign === 'support-conversations-2026-08-09' && row.status === 'sent')
    .map((row) => String(row.to || '').trim().toLowerCase()).filter(Boolean));
  const crossCampaignOverlap = [...activationRecipients].filter((recipient) => supportRecipients.has(recipient)).length;
  const appsumoRequestSent = outreachRows.some((row) => (
    row.status === 'sent' && String(row.outreachKey || '').startsWith('appsumo-amplification-2026-08-09:')
  ));
  const gmvSnapshot = await db.collection('manual_gmv_snapshots').findOne(
    { date: day },
    { projection: { _id: 0, grossOrders: 1, grossSales: 1, refunds: 1, netOrders: 1, payoutEstimate: 1, notes: 1 } },
  );
  const sprintDir = path.join(__dirname, '../marketing/campaign-2026-08-appsumo-sprint');
  const xRows = readCsv(path.join(sprintDir, 'x-opportunities-2026-08-09.csv'));
  const xPublished = xRows.filter((row) => String(row[10] || '').trim() === 'published_confirmed').length;
  const xPrepared = xRows.length - xPublished;
  const originalPath = path.join(sprintDir, 'x-original-posts-2026-08-09.md');
  const originalText = fs.existsSync(originalPath) ? fs.readFileSync(originalPath, 'utf8') : '';
  const originalPublished = (originalText.match(/Status: `published_confirmed`/g) || []).length;
  const creators = countStatuses(path.join(sprintDir, 'creators.csv'), 9);
  const communityText = fs.existsSync(path.join(sprintDir, 'COMMUNITY-QUEUE.md')) ? fs.readFileSync(path.join(sprintDir, 'COMMUNITY-QUEUE.md'), 'utf8') : '';
  const communityBlocked = (communityText.match(/\| auth_blocked \|/g) || []).length;
  const portalSummary = gmvSnapshot
    ? `- Authoritative Partner Portal payout: **${money(gmvSnapshot.payoutEstimate)}** across **${gmvSnapshot.netOrders || gmvSnapshot.grossOrders || 0} payable codes**, with **${gmvSnapshot.refunds || 0} refunds**.\n- Gross customer GMV: **${Number(gmvSnapshot.grossSales || 0) > 0 ? money(gmvSnapshot.grossSales) : 'unavailable in the Partner Portal CSV'}**. Payout is not mislabeled as GMV.`
    : '- Authoritative Partner Portal payout and GMV: **unavailable** (no manual Partner Portal snapshot for this date).';
  const text = `# August AppSumo campaign — daily report (${day})\n\nGenerated read-only from MongoDB and campaign artifacts.\n\n## Revenue\n\n${portalSummary}\n- Redeemed AppSumo accounts: **${redeemedRows.length}**. Tier mix: ${Object.entries(tiers).map(([tier, count]) => `Tier ${tier}: ${count}`).join(', ') || 'not available'}.\n- Redeemed list-price proxy: **${money(listProxy)}**. This is not GMV and must not be used as revenue.\n- Exact AppSumo end date: **no scheduled deadline was present in the listing data checked on 2026-08-09**; urgency is intentionally not inferred.\n\n## Distribution today\n\n- X intent replies: **${xPublished} published and confirmed**, **${xPrepared} remaining prepared**.\n- Original X posts: **${originalPublished} published and confirmed**.\n- Creator prospects: **${Object.values(creators).reduce((a, b) => a + b, 0)}**; statuses: ${Object.entries(creators).map(([key, value]) => `${key} ${value}`).join(', ') || 'none'}. Production outbox: **${creatorSent} sent / ${creatorFailed} failed**.\n- AppSumo amplification request: **${appsumoRequestSent ? 'sent from support@stockportfolio.pro' : 'not verified sent'}**.\n- Community drafts still authentication-blocked: **${communityBlocked}**.\n\n## External funnel events today\n\n- Page views: **${counts.page_view || 0}**\n- Free-tool views/completions: **${counts.tool_view || 0} / ${counts.tool_complete || 0}**\n- AppSumo outbound events: **${counts.appsumo_click || 0}**\n- Signups/trials: **${counts.signup || 0} / ${counts.trial_start || 0}**\n- Meaningful activations: **${counts.meaningful_activation || 0}**\n- Paid/redemption events: **${counts.paid || 0} / ${counts.redemption || 0}**\n- Source-opened events: **${sourceOpens}**\n\n## Advocacy and lifecycle mail\n\n- Review-eligible accounts (aggregate): **${reviewEligible}**\n- Review submissions today: **${reviews}**\n- Scheduled lifecycle records — scheduled: **${email.scheduled || 0}**, attempted: **${email.attempted}**, sent: **${email.sent || 0}**, failed: **${email.failed || 0}**, suppressed: **${email.skipped || 0}**, duplicate prevented: **${email.duplicatePrevented}**.\n- Personal support conversations — **${supportSent} sent / ${supportFailed} failed**.\n- Activation outreach — **${activationSent} sent / ${activationFailed} failed**.\n- Same-day recipient overlap between those two campaigns: **${crossCampaignOverlap}**. A four-day cross-campaign cooldown now prevents another overlap.\n\n## Warnings\n\n- Gross customer GMV is not available unless AppSumo supplies buyer sale prices; partner payout must remain separate.\n- Reddit and Hacker News remain authentication-blocked; no community publication is claimed.\n- Review and customer outcomes need direct evidence before changing customer-success status.\n`;
  if (!process.argv.includes('--no-write')) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, text);
  }
  if (process.argv.includes('--json')) console.log(JSON.stringify({ day, events: counts, redeemed: redeemedRows.length, listPriceProxy: listProxy, email, outreach, gmvSnapshot, xPublished, xPrepared, originalPublished, creatorStatuses: creators, communityBlocked, crossCampaignOverlap }, null, 2));
  else console.log(text);
  await mongoose.disconnect();
}
main().catch(async (error) => { console.error(error.message || error); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
