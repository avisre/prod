#!/usr/bin/env node
'use strict';

// Redacted, idempotent Partner Portal CSV importer. Dry-run is the default;
// --apply writes only aggregate sale/reconciliation fields and a one-way row
// fingerprint. Licence codes and buyer details are never persisted or printed.
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const mongoose = require(path.join(__dirname, '../backend/node_modules/mongoose'));
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/prod.env') });

function arg(name, fallback = '') { const hit = process.argv.find((v) => v.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : fallback; }
function csv(input) {
    const rows = []; let row = [], value = '', quoted = false;
    const text = String(input || '');
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') {
            if (quoted && text[i + 1] === '"') { value += '"'; i++; }
            else quoted = !quoted;
            continue;
        }
        if (ch === ',' && !quoted) { row.push(value); value = ''; continue; }
        if ((ch === '\n' || ch === '\r') && !quoted) {
            if (ch === '\r' && text[i + 1] === '\n') i++;
            row.push(value); value = '';
            if (row.some((cell) => String(cell).trim() !== '')) rows.push(row);
            row = []; continue;
        }
        value += ch;
    }
    if (value || row.length) { row.push(value); if (row.some((cell) => String(cell).trim() !== '')) rows.push(row); }
    return rows;
}
function key(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }
function num(value) { const parsed = Number(String(value || '').replace(/[^0-9.-]/g, '')); return Number.isFinite(parsed) ? parsed : null; }
function indexOf(headers, names) { return names.map((name) => headers.indexOf(name)).find((index) => index >= 0); }
function text(value, max = 120) { const result = String(value == null ? '' : value).trim(); return result ? result.slice(0, max) : null; }
function bool(value) {
    const normalized = String(value == null ? '' : value).trim().toLowerCase();
    if (['true', 'yes', 'y', '1', 'active', 'activated', 'complete', 'completed', 'success', 'succeeded', 'returned'].includes(normalized)) return true;
    if (['false', 'no', 'n', '0', 'inactive', 'not activated', 'pending', 'failed', 'not returned'].includes(normalized)) return false;
    return null;
}
function source(value) {
    const normalized = String(value || '').trim().toLowerCase();
    return ['appsumo', 'website', 'x', 'linkedin', 'reddit', 'hackernews', 'google', 'bing', 'creator', 'newsletter', 'email', 'referral', 'direct', 'unknown'].includes(normalized) ? normalized : (normalized ? 'unknown' : null);
}
function status(value) { return text(value, 40) && text(value, 40).toLowerCase().replace(/[^a-z0-9]+/g, '_'); }
function parseColumns(input) {
    const rows = csv(input); if (!rows.length) return { headers: [], records: [] };
    const headers = rows.shift().map(key);
    return { headers, rows };
}
function normalizeRecords(headers, rows) {
    const find = (names) => indexOf(headers, names);
    const orderIndex = find(['order_id', 'order', 'transaction_id', 'license_id', 'id']);
    const dateIndex = find(['sale_date', 'created_at', 'date', 'order_date', 'order_timestamp']);
    const grossIndex = find(['gross_sales', 'gross', 'gmv', 'sale_amount', 'amount', 'gross_proceeds']);
    const payoutIndex = find(['partner_payout', 'partner_proceeds', 'payout', 'commission', 'net_payout', 'net_proceeds']);
    const refundIndex = find(['refund', 'refunded', 'refund_amount', 'refund_proceeds']);
    const refundReasonIndex = find(['refund_reason', 'reason', 'refund_notes']);
    const orderStatusIndex = find(['order_status', 'status', 'sale_status']);
    const redemptionStatusIndex = find(['redemption_status', 'license_status', 'redeemed']);
    const redemptionDateIndex = find(['redemption_date', 'redeemed_at', 'activation_date']);
    const activationIndex = find(['activation_status', 'activated', 'activation_complete']);
    const researchIndex = find(['first_research', 'first_research_completed', 'research_completed']);
    const askIndex = find(['first_ask_success', 'first_ask_succeeded', 'ask_success']);
    const returnIndex = find(['seven_day_return', 'returned_day_7', 'd7_return']);
    const sourceIndex = find(['source', 'utm_source', 'acquisition_source', 'channel']);
    const campaignIndex = find(['campaign', 'utm_campaign', 'campaign_id']);
    const contentIndex = find(['content_id', 'utm_content']);
    return rows.map((row) => {
        const stable = row.map((value) => String(value || '').trim()).join('|');
        const record = {
            portalRowHash: crypto.createHash('sha256').update(stable).digest('hex'),
            saleDate: dateIndex == null ? null : text(row[dateIndex], 40),
            grossSales: grossIndex == null ? null : num(row[grossIndex]),
            partnerPayout: payoutIndex == null ? null : num(row[payoutIndex]),
            refundAmount: refundIndex == null ? null : num(row[refundIndex]),
            refundReason: refundReasonIndex == null ? null : text(row[refundReasonIndex], 160),
            orderStatus: orderStatusIndex == null ? null : status(row[orderStatusIndex]),
            redemptionStatus: redemptionStatusIndex == null ? null : status(row[redemptionStatusIndex]),
            redemptionAt: redemptionDateIndex == null ? null : text(row[redemptionDateIndex], 40),
            activationStatus: activationIndex == null ? null : bool(row[activationIndex]),
            firstResearch: researchIndex == null ? null : bool(row[researchIndex]),
            firstAskSuccess: askIndex == null ? null : bool(row[askIndex]),
            sevenDayReturn: returnIndex == null ? null : bool(row[returnIndex]),
            source: source(sourceIndex == null ? null : row[sourceIndex]),
            campaignId: campaignIndex == null ? null : text(row[campaignIndex], 120),
            contentId: contentIndex == null ? null : (/^[A-Za-z0-9._:-]{1,120}$/.test(String(row[contentIndex] || '').trim()) ? String(row[contentIndex]).trim() : null)
        };
        const normalizedStatus = record.orderStatus || '';
        record.refunded = Boolean((record.refundAmount != null && record.refundAmount > 0) || /refund|chargeback|dispute|cancel/.test(normalizedStatus));
        record.netActivePurchase = !record.refunded && !/pending|failed|test/.test(normalizedStatus);
        return record;
    });
}
function summarize(records) {
    const sum = (field) => {
        const values = records.map((row) => row[field]).filter((value) => Number.isFinite(value));
        return values.length ? Number(values.reduce((total, value) => total + value, 0).toFixed(2)) : null;
    };
    const countTrue = (field) => records.filter((row) => row[field] === true).length;
    const refunds = records.filter((row) => row.refunded);
    const refundReasons = {};
    for (const row of refunds) { const reason = row.refundReason || 'unknown'; refundReasons[reason] = (refundReasons[reason] || 0) + 1; }
    const bySource = {};
    for (const row of records) { const channel = row.source || 'unknown'; bySource[channel] = (bySource[channel] || 0) + 1; }
    return {
        orders: records.length,
        grossGmv: sum('grossSales'),
        partnerProceeds: sum('partnerPayout'),
        refunds: refunds.length,
        refundAmount: sum('refundAmount'),
        refundReasons,
        netActivePurchases: records.filter((row) => row.netActivePurchase).length,
        redeemed: records.filter((row) => /redeem|active|complete/.test(row.redemptionStatus || '') || Boolean(row.redemptionAt)).length,
        activation: countTrue('activationStatus'),
        firstResearch: countTrue('firstResearch'),
        firstAskSuccess: countTrue('firstAskSuccess'),
        sevenDayReturn: countTrue('sevenDayReturn'),
        sourceAttribution: bySource,
        unknownSourceOrders: records.filter((row) => !row.source || row.source === 'unknown').length,
        incompleteFields: ['grossSales', 'partnerPayout', 'refundAmount', 'redemptionStatus', 'activationStatus', 'firstResearch', 'firstAskSuccess', 'sevenDayReturn'].filter((field) => records.every((row) => row[field] == null))
    };
}
async function main() {
    const input = arg('input'); if (!input) throw new Error('--input=/path/to/partner-portal.csv is required');
    const parsed = parseColumns(fs.readFileSync(input, 'utf8')); if (!parsed.headers.length) throw new Error('CSV is empty');
    const records = normalizeRecords(parsed.headers, parsed.rows);
    const output = arg('output');
    const summary = summarize(records);
    if (output) fs.writeFileSync(output, JSON.stringify({ schemaVersion: 'growth-measurement-v1', generatedAt: new Date().toISOString(), summary, rows: records }, null, 2) + '\n');
    if (String(arg('apply')).toLowerCase() !== 'true') { console.log(JSON.stringify({ dryRun: true, rows: records.length, summary, output: output || null })); return; }
    const uri = process.env.MONGODB_URI; if (!uri) throw new Error('MONGODB_URI is required for --apply=true');
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    const collection = mongoose.connection.db.collection('appsumo_portal_sales');
    await collection.createIndex({ portalRowHash: 1 }, { unique: true });
    let inserted = 0, existing = 0;
    for (const record of records) {
        const result = await collection.updateOne({ portalRowHash: record.portalRowHash }, { $setOnInsert: { ...record, importedAt: new Date() } }, { upsert: true });
        if (result.upsertedCount) inserted++; else existing++;
    }
    console.log(JSON.stringify({ dryRun: false, rows: records.length, inserted, existing, summary }));
    await mongoose.disconnect();
}
if (require.main === module) {
    main().catch(async (error) => { console.error(error.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
}

module.exports = { csv, key, num, parseColumns, normalizeRecords, summarize };
