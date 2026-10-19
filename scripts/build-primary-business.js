#!/usr/bin/env node
'use strict';
// Writes frontend/data/primary-business.json: for each company whose annual
// report breaks revenue into business lines, its largest line and the industry
// label (one of industry-map.json's own) that describes that line. Read by
// backend/company-peers.js, so peers are the companies whose biggest business is
// the same as this one's (owner, 2026-10-19).
//
// The industry label alone groups a company by everything it does. Honeywell's
// label is "Conglomerates", which put it beside 3M and Icahn; its largest line,
// Aerospace Technologies, puts it beside GE Aerospace and RTX.
//
// The line comes from the filing: the same segment table the page shows
// (sec-segment-observations preferred().usable), operating segments or product
// lines, never regions. A company with no such table is single-segment or
// discloses none; its one business is what its industry label already says, so
// it gets no entry and keeps that label. Matching a line's name to a label is
// the one judgement here, made once per filing by the summary model from a
// closed list, and checked against that list. No figure comes from the model.
//
// Usage: node scripts/build-primary-business.js [--dry] [--limit N]
//   --dry    print what would be classified; no model calls, no write
// Answers are cached in scripts/.cache/primary-business-answers.json by
// filing, so a rerun pays only for companies whose segment table changed.
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const BACKEND = path.join(ROOT, 'backend');
const DATA = process.env.SEC_COVERAGE_DATA_DIR || path.join(ROOT, 'frontend/data');
const OUT = path.join(DATA, 'primary-business.json');
const CACHE = path.join(__dirname, '.cache', 'primary-business-answers.json');
const BATCH = 25;
// A line below this share is not the business the company is in: Schwab's
// largest revenue type is 27% (asset-management fees), Endava's largest client
// industry 20%. Honeywell's Aerospace line is 47%, 3M's Safety and Industrial 46%.
const MIN_SHARE = 40;
// Part of the answer cache key: a changed prompt asks every company again.
const PROMPT_VERSION = 3;
const key = (s) => String(s || '').trim().toUpperCase().replace(/\./g, '-');

const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const LIMIT = args.includes('--limit') ? Number(args[args.indexOf('--limit') + 1]) : Infinity;

// The largest business line in a company's filed segment table, or null.
function largestLine(financial, store) {
    const groups = financial?.segmentObservations;
    if (!groups?.length) return null;
    const g = store.preferred(groups).usable;
    if (!g || /Geograph/.test(g.axis)) return null;
    const view = store.shown(g);
    if (view.rows.length < 2) return null;
    const total = view.gross ? view.rows.reduce((n, r) => n + r.value, 0) : g.totalRevenue;
    if (!(total > 0)) return null;
    const lines = view.rows.map((r) => ({ name: store.displayName(g.entries.find((e) => e.member === r.member)), sharePct: Math.round(r.value / total * 1000) / 10 }))
        .sort((a, b) => b.sharePct - a.sharePct);
    if (lines[0].sharePct < MIN_SHARE) return null;
    return { line: lines[0].name, sharePct: lines[0].sharePct, others: lines.slice(1, 4), periodEnd: g.periodEnd, sourceVersion: g.sourceVersion, sourceUrl: g.sourceUrl, breakdown: store.kind(g) };
}

function candidates() {
    const store = require(path.join(BACKEND, 'sec-segment-observations'));
    const index = JSON.parse(fs.readFileSync(path.join(DATA, 'screen-index.json'), 'utf8'));
    const industries = JSON.parse(fs.readFileSync(path.join(DATA, 'industry-map.json'), 'utf8')).industries;
    const out = [], byCik = new Map();
    for (const row of index.rows || []) {
        if (!row.cik) continue;
        if (!byCik.has(row.cik)) {
            let financial = null;
            try { financial = JSON.parse(fs.readFileSync(path.join(DATA, 'sec-financials', row.cik + '.json'), 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
            byCik.set(row.cik, largestLine(financial, store));
        }
        const line = byCik.get(row.cik);
        if (line) out.push({ symbol: key(row.symbol), name: row.name || '', industry: industries[key(row.symbol)] || '', ...line });
    }
    // One business line is never a conglomerate; that label only ever names the whole.
    return { list: out, labels: [...new Set(Object.values(industries))].filter((l) => l !== 'Conglomerates').sort() };
}

const prompt = (labels, batch) => [
    { role: 'system', content: [
        'You classify a company\'s largest business line into an industry.',
        'For each company you get its name, its current industry label, and its largest revenue line as named in its annual report, with that line\'s share of revenue and the next lines.',
        'Judge the LARGEST line on its own, as if it were a standalone company, and choose the ONE label from the list below that best describes that business. The current label describes the company as a whole and may be wrong for the line.',
        'If the largest line is not a business — a region (e.g. "United States", "North America"), a customer group or sales channel (e.g. "Revenues from advertising agencies"), or a kind of revenue (e.g. "Product", "Service", "fees", "interest") — return the current label unchanged, even when it is not in the list.',
        'A "... Distribution" label fits only a line that resells goods other companies make; a line that makes its own products is never distribution.',
        'Reply with only a JSON object mapping each symbol to a label copied exactly from the list.',
        'LABELS:', labels.join('\n')
    ].join('\n') },
    { role: 'user', content: batch.map((c) => `${c.symbol} | ${c.name} | current: ${c.industry || 'none'} | largest line: ${c.line} (${c.sharePct}%) | next: ${c.others.map((o) => `${o.name} (${o.sharePct}%)`).join('; ') || 'none'}`).join('\n') }
];

async function classify(labels, list) {
    // Scripts never reach the production database. The model client records usage
    // through mongoose; with no connection it has nowhere to write.
    require(path.join(__dirname, 'lib/dev-env')).loadAiEnvOnly(BACKEND);
    for (const k of ['MONGODB_URI', 'JWT_SECRET', 'ADMIN_TOKEN']) delete process.env[k];
    const mongoose = require(path.join(BACKEND, 'node_modules', 'mongoose'));
    mongoose.connect = () => { throw new Error('build-primary-business never connects to a database'); };
    const ai = require(path.join(BACKEND, 'ai-client'));
    if (!ai.isConfigured()) throw new Error('AI is not configured (backend/.env AI keys)');
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(CACHE, 'utf8')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const cacheKey = (c) => `${PROMPT_VERSION}|${c.symbol}|${c.sourceVersion}|${c.line}|${c.industry}`;
    const allowed = new Set(labels);
    // A line that is not a business keeps the company's own label (see the prompt).
    const ok = (c, a) => allowed.has(a) || (a && a === c.industry);
    const todo = list.filter((c) => !ok(c, cache[cacheKey(c)]));
    console.error(`classifying ${todo.length} of ${list.length} (${list.length - todo.length} cached)`);
    for (let i = 0; i < todo.length; i += BATCH) {
        const batch = todo.slice(i, i + BATCH);
        for (let attempt = 0; attempt < 2; attempt++) {
            let answer = null;
            try {
                const msg = await ai.chatRaw(prompt(labels, batch), { purpose: 'summary', temperature: 0, maxTokens: 4000 });
                const raw = String(msg.content || '');
                answer = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
            } catch (e) { console.error(`batch ${i / BATCH}: ${e.message}`); }
            if (!answer) continue;
            for (const c of batch) if (ok(c, answer[c.symbol])) cache[cacheKey(c)] = answer[c.symbol];
            if (batch.every((c) => ok(c, cache[cacheKey(c)]))) break;
        }
        fs.mkdirSync(path.dirname(CACHE), { recursive: true });
        fs.writeFileSync(CACHE, JSON.stringify(cache));
        console.error(`  ${Math.min(i + BATCH, todo.length)}/${todo.length}`);
    }
    return (c) => cache[cacheKey(c)] || null;
}

async function main() {
    const { list: all, labels } = candidates();
    const list = all.slice(0, LIMIT);
    if (DRY) {
        for (const c of list.slice(0, 40)) console.log(`${c.symbol.padEnd(6)} ${c.industry.padEnd(34)} ${c.line} (${c.sharePct}%)`);
        console.log(JSON.stringify({ candidates: all.length, labels: labels.length }));
        return;
    }
    const labelFor = await classify(labels, list);
    const businesses = {};
    for (const c of list) {
        const industry = labelFor(c);
        if (industry) businesses[c.symbol] = { industry, line: c.line, sharePct: c.sharePct, breakdown: c.breakdown, periodEnd: c.periodEnd, sourceVersion: c.sourceVersion, sourceUrl: c.sourceUrl };
    }
    const count = Object.keys(businesses).length;
    // A run that lost most answers would quietly put peers back on the old labels.
    if (count < list.length * 0.9) { console.error(`only ${count} of ${list.length} classified; not writing`); process.exit(1); }
    const sorted = Object.fromEntries(Object.keys(businesses).sort().map((k) => [k, businesses[k]]));
    fs.writeFileSync(OUT, JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), count, businesses: sorted }) + '\n');
    const changed = list.filter((c) => businesses[c.symbol] && businesses[c.symbol].industry !== c.industry).length;
    console.log(JSON.stringify({ candidates: list.length, classified: count, labelChanged: changed }));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { largestLine, candidates };
