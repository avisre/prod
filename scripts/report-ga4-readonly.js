#!/usr/bin/env node
'use strict';

// Optional GA4 Data API read-only report. It requires an existing service
// account with Viewer access; it never writes to GA4 and never prints secrets.
const fs = require('node:fs');
const path = require('node:path');
const { GoogleAuth } = require(path.join(__dirname, '../backend/node_modules/google-auth-library'));
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/prod.env') });
require(path.join(__dirname, '../backend/node_modules/dotenv')).config({ path: path.join(__dirname, '../backend/.env') });

function arg(name, fallback = '') { const hit = process.argv.find((v) => v.startsWith(`--${name}=`)); return hit ? hit.slice(name.length + 3) : fallback; }
async function runReport(client, property, dimension, days) {
    const until = new Date(); const since = new Date(until.getTime() - days * 86400000);
    const body = { dateRanges: [{ startDate: since.toISOString().slice(0, 10), endDate: until.toISOString().slice(0, 10) }], dimensions: [{ name: dimension }], metrics: [{ name: 'activeUsers' }, { name: 'sessions' }, { name: 'eventCount' }], limit: 1000 };
    const response = await client.request({ url: `https://analyticsdata.googleapis.com/v1beta/properties/${property}:runReport`, method: 'POST', data: body });
    return (response.data.rows || []).map((row) => ({ dimension: row.dimensionValues?.[0]?.value || '(not set)', activeUsers: Number(row.metricValues?.[0]?.value || 0), sessions: Number(row.metricValues?.[1]?.value || 0), eventCount: Number(row.metricValues?.[2]?.value || 0) }));
}
async function main() {
    const property = String(process.env.GA4_PROPERTY_ID || arg('property')).replace(/^properties\//, '');
    const days = [7, 28, 90].includes(Number(arg('days'))) ? Number(arg('days')) : 28;
    if (!/^\d+$/.test(property)) throw new Error('Set GA4_PROPERTY_ID (numeric) or --property=123456789');
    const credentials = process.env.GA4_SERVICE_ACCOUNT_JSON || process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (!credentials) throw new Error('Set existing GA4_SERVICE_ACCOUNT_JSON or GOOGLE_APPLICATION_CREDENTIALS; no key is created by this command.');
    const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/analytics.readonly'] });
    const client = await auth.getClient();
    const [firstUser, session] = await Promise.all([
        runReport(client, property, 'firstUserSource', days),
        runReport(client, property, 'sessionSourceMedium', days)
    ]);
    const report = { schemaVersion: 'growth-measurement-v1', generatedAt: new Date().toISOString(), days, firstUserAcquisition: firstUser, sessionAcquisition: session, note: 'Read-only GA4 Data API output; direct and not-set values remain separate.' };
    const output = arg('output');
    if (output) fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n'); else console.log(JSON.stringify(report, null, 2));
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
