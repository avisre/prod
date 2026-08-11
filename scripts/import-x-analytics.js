#!/usr/bin/env node
'use strict';

// Import a downloaded X Content export without retaining post text or account
// identifiers. This is a local, reviewable join against content-registry.csv.
const fs = require('node:fs');
const path = require('node:path');

function arg(name, fallback = '') {
    const hit = process.argv.find((item) => item.startsWith(`--${name}=`));
    return hit ? hit.slice(name.length + 3) : fallback;
}
function parseCsv(input) {
    const rows = [];
    let row = [], field = '', quoted = false;
    for (const ch of String(input || '')) {
        if (ch === '"') { quoted = !quoted; continue; }
        if (ch === ',' && !quoted) { row.push(field); field = ''; continue; }
        if ((ch === '\n' || ch === '\r') && !quoted) {
            if (ch === '\r') continue;
            row.push(field); field = '';
            if (row.some((v) => v !== '')) rows.push(row);
            row = []; continue;
        }
        field += ch;
    }
    if (field || row.length) { row.push(field); rows.push(row); }
    return rows;
}
function number(value) { const n = Number(String(value || '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; }
function normalizeHeader(value) { return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''); }
function main() {
    const input = arg('input');
    if (!input) throw new Error('--input=/path/to/x-content.csv is required');
    const rows = parseCsv(fs.readFileSync(input, 'utf8'));
    if (!rows.length) throw new Error('X export is empty');
    const headers = rows.shift().map(normalizeHeader);
    const index = (names) => names.map((name) => headers.indexOf(name)).find((i) => i >= 0);
    const contentIndex = index(['content_id', 'tweet_id', 'post_id', 'id']);
    const dateIndex = index(['date', 'time', 'created_at']);
    const metrics = ['impressions', 'engagements', 'likes', 'replies', 'reposts', 'bookmarks', 'link_clicks', 'profile_visits'];
    const metricIndexes = Object.fromEntries(metrics.map((metric) => [metric, index([metric, `${metric}_count`])]));
    const output = rows.map((row) => {
        const contentId = contentIndex == null ? null : String(row[contentIndex] || '').trim().slice(0, 120);
        return {
            contentId: contentId && /^[A-Za-z0-9._:-]+$/.test(contentId) ? contentId : null,
            observedAt: dateIndex == null ? null : String(row[dateIndex] || '').slice(0, 40),
            ...Object.fromEntries(metrics.map((metric) => [metric, metricIndexes[metric] == null ? 0 : number(row[metricIndexes[metric]])]))
        };
    });
    const outputPath = arg('output', path.join(path.dirname(input), 'x-analytics-sanitized.json'));
    fs.writeFileSync(outputPath, JSON.stringify({ schemaVersion: 'growth-measurement-v1', source: 'x-content-export', rows: output }, null, 2) + '\n');
    console.log(`Wrote ${output.length} sanitized rows to ${outputPath}`);
}
try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; }
