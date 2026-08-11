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
    for (const ch of String(input || '')) {
        if (ch === '"') { quoted = !quoted; continue; }
        if (ch === ',' && !quoted) { row.push(value); value = ''; continue; }
        if ((ch === '\n' || ch === '\r') && !quoted) { if (ch === '\r') continue; row.push(value); value = ''; if (row.some(Boolean)) rows.push(row); row = []; continue; }
        value += ch;
    }
    if (value || row.length) { row.push(value); rows.push(row); }
    return rows;
}
function key(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }
function num(value) { const parsed = Number(String(value || '').replace(/[^0-9.-]/g, '')); return Number.isFinite(parsed) ? parsed : null; }
async function main() {
    const input = arg('input'); if (!input) throw new Error('--input=/path/to/partner-portal.csv is required');
    const rows = csv(fs.readFileSync(input, 'utf8')); if (!rows.length) throw new Error('CSV is empty');
    const headers = rows.shift().map(key);
    const find = (names) => names.map((name) => headers.indexOf(name)).find((index) => index >= 0);
    const orderIndex = find(['order_id', 'order', 'transaction_id', 'license_id', 'id']);
    const dateIndex = find(['sale_date', 'created_at', 'date', 'order_date']);
    const grossIndex = find(['gross_sales', 'gross', 'gmv', 'sale_amount', 'amount']);
    const payoutIndex = find(['partner_payout', 'payout', 'commission', 'net_payout']);
    const refundIndex = find(['refund', 'refunded', 'refund_amount']);
    const records = rows.map((row) => {
        const stable = row.map((value) => String(value || '').trim()).join('|');
        const fingerprint = crypto.createHash('sha256').update(stable).digest('hex');
        return { portalRowHash: fingerprint, saleDate: dateIndex == null ? null : String(row[dateIndex] || '').slice(0, 40), grossSales: grossIndex == null ? null : num(row[grossIndex]), partnerPayout: payoutIndex == null ? null : num(row[payoutIndex]), refundAmount: refundIndex == null ? null : num(row[refundIndex]) };
    });
    const output = arg('output');
    if (output) fs.writeFileSync(output, JSON.stringify({ schemaVersion: 'growth-measurement-v1', rows: records }, null, 2) + '\n');
    if (String(arg('apply')).toLowerCase() !== 'true') { console.log(JSON.stringify({ dryRun: true, rows: records.length, output: output || null })); return; }
    const uri = process.env.MONGODB_URI; if (!uri) throw new Error('MONGODB_URI is required for --apply=true');
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
    const collection = mongoose.connection.db.collection('appsumo_portal_sales');
    await collection.createIndex({ portalRowHash: 1 }, { unique: true });
    let inserted = 0, existing = 0;
    for (const record of records) {
        const result = await collection.updateOne({ portalRowHash: record.portalRowHash }, { $setOnInsert: { ...record, importedAt: new Date() } }, { upsert: true });
        if (result.upsertedCount) inserted++; else existing++;
    }
    console.log(JSON.stringify({ dryRun: false, rows: records.length, inserted, existing }));
    await mongoose.disconnect();
}
main().catch(async (error) => { console.error(error.message); try { await mongoose.disconnect(); } catch (_) {} process.exit(1); });
