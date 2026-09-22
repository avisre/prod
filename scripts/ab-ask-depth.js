'use strict';
/**
 * Does glm-5.3 actually research LESS than glm-5.1, or just sequence its tool
 * calls differently?
 *
 * probe-llm-capability.js P13 compares the ROUND-1 tool set, and 5.3 scores 60%
 * — which reads as a regression and was the last thing blocking the chat slot.
 * But the Ask loop runs up to 12 rounds. A model that fetches financials first
 * and ratios second is not researching less; P13 cannot tell those two apart,
 * and P13 is the only evidence anyone has looked at.
 *
 * This runs the FULL ask() loop on both models and compares what actually
 * matters: the union of tools used across all rounds, how many rounds it took,
 * and whether the answer carries real figures. Round-1 divergence only counts
 * against 5.3 if the finished answer is worse.
 *
 * REQUIRES a local --db, and refuses to start without one. The two tools this
 * experiment is actually about, get_key_points and get_filing_diff, read and
 * WRITE their caches through mongoose.connection.collection() with no
 * readyState guard. With no connection those calls do not fail fast: mongoose
 * buffers them and rejects after bufferTimeoutMS, so both tools return an
 * error string and the run silently measures nothing. Pointing --db at
 * production instead is the 2026-09-22 incident: a fresh extraction would
 * write candidate-model content straight into the live cache.
 *
 *   node scripts/ab-ask-depth.js --db mongodb://127.0.0.1:27017/abdepth
 *   node scripts/ab-ask-depth.js --db mongodb://127.0.0.1:27017/abdepth --models glm-5.1,glm-5.3 --reps 2
 */
const path = require('path');
const BK = (m) => require(path.join(__dirname, '..', 'backend', 'node_modules', m));
const { loadAiEnvOnly, assertLocalMongo } = require('./lib/dev-env');
loadAiEnvOnly(path.join(__dirname, '..', 'backend'));
const mongoose = BK('mongoose');

const aiChat = require('../backend/ai-chat');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const MODELS = arg('--models', 'glm-5.1,glm-5.3').split(',').map((s) => s.trim());
const REPS = Number(arg('--reps', '1'));

// The questions where round-1 diverged, narrowed cases first — those are the
// only ones that could represent a real loss.
const QUESTIONS = [
    { q: 'Compare MSFT, GOOGL, AMZN, META and AAPL on revenue growth and free cash flow.', tag: 'NARROWED r1' },
    { q: "How does Shopify's growth compare with Block's?", tag: 'NARROWED r1' },
    { q: "What is Pfizer's dividend yield and is it covered by free cash flow?", tag: 'SWAPPED r1' },
    { q: "Summarise Berkshire's latest quarterly results.", tag: 'broadened r1' },
    { q: "What are the biggest risks in Boeing's latest 10-K?", tag: 'broadened r1' }
];

const DIGITS = /\d[\d,.]*\s*(%|bn|billion|million|m\b|b\b|\$)/i;

async function run(model, question) {
    process.env.AI_MODEL_CHAT = model;
    const t0 = Date.now();
    let r;
    try { r = await aiChat.ask({ question, history: [], ctx: {}, mode: 'normal' }); }
    catch (e) { return { model, error: e.message, ms: Date.now() - t0 }; }
    const ms = Date.now() - t0;
    const names = (r.toolsUsed || []).map((t) => t.tool);
    const failed = (r.toolsUsed || []).filter((t) => !t.ok).length;
    return {
        model, ms, source: r.source,
        calls: names.length,
        unique: [...new Set(names)].sort(),
        failed,
        answerChars: (r.answer || '').length,
        hasFigures: DIGITS.test(r.answer || ''),
        answer: r.answer || ''
    };
}

(async () => {
    const dbUri = arg('--db', process.env.BENCH_MONGODB_URI || '');
    assertLocalMongo(dbUri, 'ab-ask-depth.js');
    await mongoose.connect(dbUri);
    console.log(`Ask depth A/B — full loop, not round 1. models=${MODELS.join(', ')} reps=${REPS}`);
    console.log(`db=${dbUri}\n`);
    const agg = new Map(MODELS.map((m) => [m, { calls: 0, ms: 0, figures: 0, n: 0, failed: 0, chars: 0 }]));
    for (const { q, tag } of QUESTIONS) {
        console.log(`\n=== [${tag}] ${q}`);
        for (let rep = 0; rep < REPS; rep++) {
            // Interleave models per question so provider load drift hits both.
            for (const model of (rep % 2 ? [...MODELS].reverse() : MODELS)) {
                const r = await run(model, q);
                if (r.error) { console.log(`  ${model.padEnd(14)} ERROR ${r.error}`); continue; }
                const a = agg.get(model);
                a.calls += r.calls; a.ms += r.ms; a.n++; a.failed += r.failed; a.chars += r.answerChars;
                if (r.hasFigures) a.figures++;
                console.log(`  ${model.padEnd(14)} ${String(r.calls).padStart(2)} calls  ${String(Math.round(r.ms / 1000)).padStart(3)}s  figures=${r.hasFigures ? 'y' : 'N'}  ${r.answerChars}ch  src=${r.source}`);
                console.log(`                 tools: ${r.unique.join(', ') || '(none)'}`);
            }
        }
    }
    console.log('\n\n=== AGGREGATE (full loop) ===');
    console.log('model           runs  tool calls/run  answers with figures  failed calls  mean s  mean chars');
    for (const [m, a] of agg) {
        if (!a.n) continue;
        console.log(`${m.padEnd(15)} ${String(a.n).padStart(4)}  ${(a.calls / a.n).toFixed(1).padStart(14)}  ${String(a.figures + '/' + a.n).padStart(20)}  ${String(a.failed).padStart(12)}  ${(a.ms / a.n / 1000).toFixed(0).padStart(6)}  ${Math.round(a.chars / a.n).toString().padStart(10)}`);
    }
    console.log('\nA lower round-1 tool count is only a regression if these columns are worse.');
    await mongoose.disconnect().catch(() => {});
    process.exit(0);
})();
