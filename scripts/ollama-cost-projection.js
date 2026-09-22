#!/usr/bin/env node
'use strict';

/**
 * ollama-cost-projection.js — what the AI actually costs, and what it would
 * cost on a different model.
 *
 * READ-ONLY. Runs aggregations and prints; writes nothing, anywhere.
 *
 * Three things the repo could not answer before this existed:
 *   1. The real input/output token split. credits.js:64-71 ASSUMES 85/15 and
 *      says so; ollama-usage-tracker.js has persisted the actual split since
 *      2026-09-11, and nothing has ever read it. tmp-token-split-measure.js
 *      groups by purpose only and reads totalTokens only.
 *   2. Cost per model. Nothing groups ollama_usage_events by `model`, which is
 *      exactly what a model swap needs.
 *   3. Dollars. No code anywhere converts tokens to money, and nothing fetches
 *      the provider's invoice — the monthly bill is manual and owner-only
 *      (growth.md records this as an open risk). This script closes the gap
 *      with list prices; it is a projection, not an invoice.
 *
 * Usage:
 *   node scripts/ollama-cost-projection.js --db mongodb://127.0.0.1:PORT/bench
 *   node scripts/ollama-cost-projection.js --source prod        # read-only
 *   node scripts/ollama-cost-projection.js --source prod --actor all
 */

const path = require('path');
const fs = require('fs');
const BACKEND = path.join(__dirname, '..', 'backend');
const BK = (m) => require(path.join(BACKEND, 'node_modules', m));
const { assertLocalMongo } = require('./lib/dev-env');
const credits = require(path.join(BACKEND, 'credits'));

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };

// ---------------------------------------------------------------------------
// Provider list pricing, fetched from ollama.com/pricing on this date.
// Printed in every report so a stale table is visible rather than silent.
// ---------------------------------------------------------------------------
const PRICES_AS_OF = '2026-09-22';
const PRICES = {
    'glm-5.1': { input: 1.00, cachedInput: 0.20, output: 3.20 },
    'glm-5.2': { input: 1.40, cachedInput: 0.26, output: 4.40 },
    'glm-5.3': { input: 1.40, cachedInput: 0.26, output: 4.40 },
    'glm-5.3-flash': { input: 0.15, cachedInput: 0.03, output: 0.50 },
    'gemma4:31b': { input: 0.10, cachedInput: 0.02, output: 0.40 } // vision relay; approximate
};
const OLLAMA_PLAN = { pro: { usd: 20, included: 60 }, max: { usd: 200, included: 300 } };

// The frontier anchor credit prices are set against — Claude Fable 5.1 /
// GPT-6 Astra, per credits.js:52-53. NOT the provider's price.
const FRONTIER = { input: 10, output: 50 };
const CREDIT_USD = 14.99 / 150; // $0.09993, credits.js:69

// Minimum calls carrying BOTH promptTokens and completionTokens before this
// script will state a split. Those fields only exist since 2026-09-11, so a
// naive average would silently treat missing data as zero.
const MIN_SPLIT_COVERAGE = 200;

const usd = (n) => (n === null || n === undefined ? '-' : `$${n < 0.01 ? n.toFixed(5) : n.toFixed(n < 1 ? 4 : 2)}`);
const costOf = (model, pTok, cTok) => {
    const p = PRICES[model];
    if (!p) return null;
    return (pTok / 1e6) * p.input + (cTok / 1e6) * p.output;
};

async function main() {
    const source = arg('--source', 'local');
    const actor = arg('--actor', 'user');
    let uri = arg('--db', '');

    if (source === 'prod') {
        // Deliberate, explicit, and read-only. Never the default: defaulting to
        // backend/.env's MONGODB_URI is precisely the mistake that wrote to
        // production twice.
        const dotenv = BK('dotenv');
        const parsed = dotenv.parse(fs.readFileSync(path.join(BACKEND, '.env')));
        uri = parsed.MONGODB_URI;
        console.log('SOURCE: PRODUCTION (read-only aggregation, no writes)\n');
    } else {
        if (!uri) { console.error('Pass --db mongodb://127.0.0.1:PORT/<name>, or --source prod for live numbers.'); process.exit(1); }
        assertLocalMongo(uri, 'ollama-cost-projection.js');
        console.log('SOURCE: local database\n');
    }

    const mongoose = BK('mongoose');
    await mongoose.connect(uri);
    const col = mongoose.connection.collection('ollama_usage_events');

    const match = { totalTokens: { $ne: null } };
    if (actor === 'user') match.actorType = { $in: ['user', 'anonymous'] };
    else if (actor === 'background') match.actorType = 'background';

    const total = await col.countDocuments({});
    if (!total) { console.log('ollama_usage_events is empty — nothing to project from.'); await mongoose.disconnect(); return; }

    const bounds = await col.aggregate([{ $group: { _id: null, first: { $min: '$startedAt' }, last: { $max: '$startedAt' } } }]).toArray();
    const first = bounds[0] && bounds[0].first, last = bounds[0] && bounds[0].last;
    const windowDays = first && last ? Math.max(1 / 24, (last - first) / 86400000) : 1;

    console.log('='.repeat(78));
    console.log(`Prices as of ${PRICES_AS_OF} (ollama.com/pricing list rates — a projection, not an invoice)`);
    console.log(`Events: ${total} total, actor filter = ${actor}`);
    console.log(`Observed window: ${first ? first.toISOString().slice(0, 16) : '?'} -> ${last ? last.toISOString().slice(0, 16) : '?'}  (${windowDays.toFixed(2)} days)`);
    console.log('ollama_usage_events has a 30-DAY TTL on startedAt, so no history exists beyond that,');
    console.log('and a young collection is shorter still. The daily rate below uses the window above,');
    console.log('not an assumed 30 days.');
    console.log('='.repeat(78));

    // ---- 1. model x purpose, with the REAL split -------------------------
    const rows = await col.aggregate([
        { $match: match },
        {
            $group: {
                _id: { model: '$model', purpose: '$purpose' },
                calls: { $sum: 1 },
                totalTok: { $sum: '$totalTokens' },
                avgTok: { $avg: '$totalTokens' },
                splitCalls: { $sum: { $cond: [{ $and: [{ $isNumber: '$promptTokens' }, { $isNumber: '$completionTokens' }] }, 1, 0] } },
                pTok: { $sum: { $ifNull: ['$promptTokens', 0] } },
                cTok: { $sum: { $ifNull: ['$completionTokens', 0] } },
                avgMs: { $avg: '$durationMs' }
            }
        },
        { $sort: { calls: -1 } }
    ]).toArray();

    console.log('\n=== USAGE BY MODEL x PURPOSE ===');
    console.log(`${'model'.padEnd(15)}${'purpose'.padEnd(10)}${'calls'.padStart(7)}${'avg tok'.padStart(9)}${'total tok'.padStart(12)}${'split n'.padStart(9)}${'in/out'.padStart(9)}${'avg ms'.padStart(8)}${'cost'.padStart(10)}`);
    for (const r of rows) {
        const m = r._id.model, split = r.pTok + r.cTok;
        const inPct = split ? Math.round(100 * r.pTok / split) : null;
        // Cost uses totalTokens (recorded for nearly every call) apportioned by
        // the ratio measured on the subset that carries the split. Using the
        // raw pTok/cTok sums would price only the covered calls.
        const share = split ? r.pTok / split : 0.85;
        r.costUsd = costOf(m, r.totalTok * share, r.totalTok * (1 - share));
        console.log(
            String(m).padEnd(15) + String(r._id.purpose).padEnd(10) +
            String(r.calls).padStart(7) + String(Math.round(r.avgTok)).padStart(9) + String(r.totalTok).padStart(12) +
            String(r.splitCalls).padStart(9) +
            (inPct === null ? '-'.padStart(9) : `${inPct}/${100 - inPct}`.padStart(9)) +
            String(Math.round(r.avgMs || 0)).padStart(8) +
            usd(r.costUsd).padStart(10)
        );
    }

    // ---- 2. the measured chat split, or an honest refusal ----------------
    const chat = rows.filter((r) => r._id.purpose === 'chat');
    const chatSplitCalls = chat.reduce((a, r) => a + r.splitCalls, 0);
    const chatP = chat.reduce((a, r) => a + r.pTok, 0);
    const chatC = chat.reduce((a, r) => a + r.cTok, 0);
    const chatCalls = chat.reduce((a, r) => a + r.calls, 0);
    const chatAvgTok = chatCalls ? chat.reduce((a, r) => a + r.totalTok, 0) / chatCalls : 0;

    console.log('\n=== THE 85/15 ASSUMPTION IN credits.js:64-71 ===');
    if (chatSplitCalls < MIN_SPLIT_COVERAGE) {
        console.log(`  INSUFFICIENT COVERAGE: ${chatSplitCalls} chat calls carry both promptTokens and`);
        console.log(`  completionTokens; need ${MIN_SPLIT_COVERAGE} before stating a split. Reporting nothing rather`);
        console.log('  than a confident wrong number. (Those fields only exist since 2026-09-11.)');
    } else {
        const inShare = chatP / (chatP + chatC);
        console.log(`  MEASURED over ${chatSplitCalls} chat calls: ${Math.round(inShare * 100)}/${Math.round((1 - inShare) * 100)} in/out.`);
        console.log(`  credits.js assumes 85/15. Measured differs by ${Math.abs(Math.round(inShare * 100) - 85)} points.`);
        console.log('  Chat is input-heavy by construction: every tool round resends the whole');
        console.log('  conversation plus the system prompt and 28 tool schemas, while the answer');
        console.log('  stays short. An input-heavier split makes the frontier-anchored cost LOWER,');
        console.log('  because frontier output is 5x its input price.');
    }

    // ---- 3. counterfactual monthly cost per model ------------------------
    // Apportion each group's FULL token count by that group's own measured
    // split, then sum. This keeps a purpose with a different shape (summary is
    // 90/10, chat 95/5) from being flattened into one average.
    const grand = rows.reduce((a, r) => {
        const split = r.pTok + r.cTok;
        const share = split ? r.pTok / split : 0.85;
        return {
            p: a.p + r.totalTok * share,
            c: a.c + r.totalTok * (1 - share),
            tok: a.tok + r.totalTok,
            calls: a.calls + r.calls,
            covered: a.covered + r.splitCalls
        };
    }, { p: 0, c: 0, tok: 0, calls: 0, covered: 0 });
    console.log('\n=== MONTHLY PROJECTION AT THIS VOLUME ===');
    console.log(`  Observed: ${grand.calls} calls, ${grand.tok} tokens over ${windowDays.toFixed(2)} days`);
    console.log(`  Split coverage: ${grand.covered}/${grand.calls} calls carry promptTokens/completionTokens`);
    console.log('  (those fields exist only since 2026-09-11; every call\'s FULL token count is');
    console.log('  apportioned by the ratio measured on the covered subset).');
    if (!grand.p && !grand.c) {
        console.log('  No prompt/completion split recorded — cannot price. (Pre-2026-09-11 rows.)');
    } else {
        const scale = 30.4 / windowDays;
        console.log(`  Scaled to 30.4 days (x${scale.toFixed(2)}):\n`);
        console.log(`  ${'model'.padEnd(15)}${'$/month'.padStart(10)}${'vs 5.1'.padStart(9)}${'% of $60'.padStart(10)}  note`);
        const base = costOf('glm-5.1', grand.p, grand.c) * scale;
        for (const m of Object.keys(PRICES)) {
            if (m === 'gemma4:31b') continue;
            const c = costOf(m, grand.p, grand.c) * scale;
            const pctPlan = (c / OLLAMA_PLAN.pro.included) * 100;
            console.log(
                `  ${m.padEnd(15)}${usd(c).padStart(10)}${(c / base).toFixed(2) + 'x'} `.padEnd(36) +
                `${pctPlan.toFixed(0)}%`.padStart(8) + `  if ALL traffic ran on this model`
            );
        }
        console.log(`\n  Ollama Pro is $${OLLAMA_PLAN.pro.usd}/mo including $${OLLAMA_PLAN.pro.included} of usage; Max is $${OLLAMA_PLAN.max.included}.`);
        console.log('  NOTE: these apply TODAY\'s token volume to each price. They do not model the');
        console.log('  fact that a different model uses a different number of tokens for the same');
        console.log('  work — the benchmark measures that separately.');
    }

    // ---- 4. credit economics per action ----------------------------------
    console.log('\n=== CREDIT ECONOMICS (what a customer pays vs what it costs) ===');
    console.log('  Credit deduction is a FLAT per-action table (credits.js:78) with zero token or');
    console.log('  model awareness. Nothing below changes any customer\'s charge — a model swap');
    console.log('  moves only the provider bill.\n');
    const inShare = (chatP + chatC) ? chatP / (chatP + chatC) : 0.85;
    void 0;
    const shareLabel = chatSplitCalls >= MIN_SPLIT_COVERAGE ? `measured ${Math.round(inShare * 100)}/${Math.round((1 - inShare) * 100)}` : 'assumed 85/15';
    const tok = chatAvgTok || 13820;
    const pT = tok * inShare, cT = tok * (1 - inShare);
    const frontierCost = (pT / 1e6) * FRONTIER.input + (cT / 1e6) * FRONTIER.output;

    console.log(`  Basis: ${Math.round(tok)} tokens per AI-backed call (${shareLabel}), credit = ${usd(CREDIT_USD)}`);
    console.log(`  Frontier anchor ($${FRONTIER.input}/$${FRONTIER.output} per M) => ${usd(frontierCost)}/call; the 2x rule => ${usd(frontierCost * 2)} => ${(frontierCost * 2 / CREDIT_USD).toFixed(2)} credits\n`);
    console.log(`  ${'action'.padEnd(18)}${'credits'.padStart(8)}${'revenue'.padStart(10)}` + Object.keys(PRICES).filter((m) => m !== 'gemma4:31b').map((m) => `${m} cost/margin`.padStart(24)).join(''));
    for (const [action, n] of Object.entries(credits.COST)) {
        if (!/ask/.test(action)) continue; // only AI-backed actions have a real per-call cost
        const revenue = n * CREDIT_USD;
        let line = `  ${action.padEnd(18)}${String(n).padStart(8)}${usd(revenue).padStart(10)}`;
        for (const m of Object.keys(PRICES)) {
            if (m === 'gemma4:31b') continue;
            const c = costOf(m, pT, cT);
            line += `${usd(c)} / ${(revenue / c).toFixed(1)}x`.padStart(24);
        }
        console.log(line);
    }
    console.log('\n  Non-ask actions (dossier, monitor, ...) bundle several calls of mixed purpose;');
    console.log('  price them from the BY MODEL x PURPOSE table above rather than this row basis.');

    await mongoose.disconnect();
}

main().catch((e) => { console.error(e.message); process.exit(1); });
