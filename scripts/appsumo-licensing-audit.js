#!/usr/bin/env node
'use strict';

// Read-only cross-check of AppSumo's Licensing API against our own Mongo
// mirror (AppSumoLicense, populated by webhook events at backend/app.js).
// Purpose: our webhook-derived counts can silently drift from AppSumo's
// source of truth (a missed/failed webhook, a retry that never lands) —
// this catches that without waiting to notice a customer complaint.
//
// Auth: X-AppSumo-Licensing-Key header. Key lives in
//   ~/.local/share/secrets/appsumo_licensing.txt (chmod 600)
// or set APPSUMO_LICENSING_KEY_FILE / APPSUMO_LICENSING_KEY directly.
// Docs: https://docs.licensing.appsumo.com/  Rate limit: 20 req/min.
//
// Usage: node scripts/appsumo-licensing-audit.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');
const mongoose = require(path.join(__dirname, '../backend/node_modules/mongoose'));
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/.env') });

const DEFAULT_KEY_FILE = path.join(os.homedir(), '.local/share/secrets/appsumo_licensing.txt');

function loadKey() {
    if (process.env.APPSUMO_LICENSING_KEY) return process.env.APPSUMO_LICENSING_KEY.trim();
    const file = process.env.APPSUMO_LICENSING_KEY_FILE || DEFAULT_KEY_FILE;
    if (!fs.existsSync(file)) {
        throw new Error(`No AppSumo Licensing API key found. Put it in ${DEFAULT_KEY_FILE} or set APPSUMO_LICENSING_KEY.`);
    }
    return fs.readFileSync(file, 'utf8').trim();
}

function apiGet(pathname, key) {
    return new Promise((resolve, reject) => {
        https.get({
            hostname: 'api.licensing.appsumo.com',
            path: pathname,
            headers: { 'X-AppSumo-Licensing-Key': key }
        }, (res) => {
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => {
                if (res.statusCode !== 200) return reject(new Error(`${pathname} -> HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
                try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
            });
        }).on('error', reject);
    });
}

async function main() {
    const key = loadKey();
    const [licensesResp, eventsResp] = await Promise.all([
        apiGet('/v2/licenses', key),
        apiGet('/v2/licenses/events', key)
    ]);
    const licenses = licensesResp.items || [];
    const events = eventsResp.items || [];

    const byStatus = {};
    for (const l of licenses) byStatus[l.status] = (byStatus[l.status] || 0) + 1;

    const deactivateEvents = events.filter((e) =>
        (e.responses?.items || []).some((r) => {
            try { return JSON.parse(r.request_body).event === 'deactivate'; } catch (_) { return false; }
        })
    );
    const refunds = [];
    const nonRefundDeactivations = [];
    for (const e of deactivateEvents) {
        const last = (e.responses?.items || []).slice().sort((a, b) => a.created_at.localeCompare(b.created_at)).pop();
        let body = {};
        try { body = JSON.parse(last.request_body); } catch (_) { /* ignore */ }
        const row = { licenseKey: e.license_key, tier: body.tier, reason: body.extra?.reason, at: last.created_at };
        if (/refund/i.test(body.extra?.reason || '')) refunds.push(row);
        else nonRefundDeactivations.push(row);
    }

    const failedFinal = events.filter((e) => {
        const resp = (e.responses?.items || []).slice().sort((a, b) => a.created_at.localeCompare(b.created_at));
        return resp.length && !resp[resp.length - 1].success;
    });

    console.log('=== AppSumo Licensing API — live counts ===');
    console.log('Total license keys:', licenses.length, JSON.stringify(byStatus));
    console.log('Genuine refunds (reason contains "refund"):', refunds.length);
    for (const r of refunds) console.log('  -', r.licenseKey, 'tier', r.tier, r.at.slice(0, 10), '-', r.reason);
    console.log('Non-refund deactivations (e.g. tier-upgrade key retirement):', nonRefundDeactivations.length);
    for (const r of nonRefundDeactivations) console.log('  -', r.licenseKey, 'tier', r.tier, r.at.slice(0, 10), '-', r.reason);
    console.log('Webhook deliveries still failing on their final attempt:', failedFinal.length);
    for (const e of failedFinal) console.log('  -', e.event_id, e.event, e.license_key);

    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
    const AppSumoLicense = mongoose.connection.collection('appsumolicenses');
    const mongoKeys = new Set((await AppSumoLicense.find({}, { projection: { licenseKey: 1 } }).toArray()).map((d) => d.licenseKey));
    const apiKeys = new Set(licenses.map((l) => l.license_key));
    const inApiNotMongo = [...apiKeys].filter((k) => !mongoKeys.has(k));
    const inMongoNotApi = [...mongoKeys].filter((k) => !apiKeys.has(k));
    console.log();
    console.log('=== Cross-check vs local Mongo (appsumolicenses) ===');
    console.log('In AppSumo but missing from our DB:', inApiNotMongo.length, inApiNotMongo);
    console.log('In our DB but not returned by AppSumo:', inMongoNotApi.length, inMongoNotApi);
    await mongoose.disconnect();
}

main().catch((err) => { console.error(err.message); process.exit(1); });
