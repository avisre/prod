#!/usr/bin/env node
'use strict';

/**
 * bench-model-latency.js — settle "is the new model faster?" properly.
 *
 * WHY THIS EXISTS. An earlier comparison ran every case on model A, then every
 * case on model B, and produced contradictory answers hours apart (one model
 * totalled 699s then 994s across the same 12 cases; the other 707s then 625s).
 * The models were not the variable — the shared GPU pool's load was, and it
 * drifted between the blocks. Totals from block-ordered runs are worthless.
 *
 * THE FIX, and the whole point of this script:
 *   for rep:
 *     for case:                       # serial
 *       for model in rotate(models):  # A,B,C then B,C,A then C,A,B
 *         run(case, model)            # seconds apart, same provider weather
 * Interleaving at the INNERMOST level means the models see the same conditions.
 * Rotation removes the residual advantage of always going first. The headline
 * statistic is the PAIRED per-case ratio t(model)/t(baseline), which is immune
 * to the drift that makes totals lie.
 *
 * It runs its own app instance against an in-process throwaway MongoDB, so the
 * HTTP surfaces (REST /api/v1/ask and MCP sp_ask) share one database with the
 * in-process ones and token accounting works uniformly. It can never reach
 * production: scripts/lib/dev-env.js refuses any non-local database, and only
 * the provider credentials are read out of backend/.env.
 *
 * Usage:
 *   node scripts/bench-model-latency.js --profile quick
 *   node scripts/bench-model-latency.js --profile full --yes
 *   node scripts/bench-model-latency.js --models glm-5.1:none,glm-5.3:low --reps 5
 */

const path = require('path');
const fs = require('fs');
const BACKEND = path.join(__dirname, '..', 'backend');
const BK = (m) => require(path.join(BACKEND, 'node_modules', m));
const { loadAiEnvOnly, assertLocalMongo, maskKey } = require('./lib/dev-env');

const arg = (flag, dflt) => {
    const i = process.argv.indexOf(flag);
    return i > -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : dflt;
};
const has = (flag) => process.argv.includes(flag);

// "name" or "name:effort". The right reasoning effort is a property of the
// model — glm-5.1 needs 'none', glm-5.3 needs 'low' (at 'none' it reasons in
// the visible channel and overruns max_tokens) — so a fair comparison runs
// each at its own best setting rather than forcing one global value.
const SPECS = arg('--models', 'glm-5.1:none,glm-5.3:low,glm-5.3-flash:low')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => { const [name, effort] = s.split(':'); return { name, effort: effort === undefined ? '' : effort }; });
const BASELINE = SPECS[0].name;
const PROFILE = arg('--profile', 'quick');
const REPS = Number(arg('--reps', PROFILE === 'full' ? 2 : 3));
const PORT = Number(arg('--port', 5077));

const PROFILES = {
    quick: { tickers: ['AAPL', 'MSFT', 'JPM'], surfaces: ['ask_nonstream', 'monitor', 'filing_diff', 'api_ask'], estUsd: 2 },
    // Every AI surface, but only 3 tickers. The binding constraint is wall
    // clock, not money: dossier alone runs ~100-190s per build, so 5 tickers x
    // 3 models x 3 reps would be a 3-hour job. 3 tickers x 2 reps still gives
    // 6 matched pairs per surface — enough for a sign test to reach p=0.03 if
    // the direction is consistent, which is all the paired comparison needs.
    // BRK-B is in the set deliberately: it is the largest filing and the case
    // where timeouts showed up before.
    full: {
        tickers: ['AAPL', 'MSFT', 'BRK-B'],
        surfaces: ['ask_nonstream', 'ask_stream', 'dossier', 'monitor', 'keypoints', 'filing_diff', 'segments', 'api_ask', 'mcp_ask'],
        estUsd: 12
    }
};
const PLAN = PROFILES[PROFILE] || PROFILES.quick;
const TICKERS = arg('--tickers', '') ? arg('--tickers', '').split(',').map((s) => s.trim().toUpperCase()) : PLAN.tickers;
const SURFACES = arg('--surfaces', '') ? arg('--surfaces', '').split(',').map((s) => s.trim()) : PLAN.surfaces;

const API_KEY = 'sp_live_' + 'bec4'.repeat(12);
const ADMIN_EMAIL = 'rin@gmail.com';
const PASSWORD = 'benchlocal';

// ---------------------------------------------------------------------------
// statistics
// ---------------------------------------------------------------------------
const pct = (sorted, p) => {
    if (!sorted.length) return null;
    const i = (sorted.length - 1) * p;
    const lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (i - lo);
};
function stats(values) {
    const v = values.filter((x) => Number.isFinite(x)).slice().sort((a, b) => a - b);
    if (!v.length) return null;
    return {
        n: v.length,
        mean: v.reduce((a, b) => a + b, 0) / v.length,
        p50: pct(v, 0.5), p90: pct(v, 0.9), p95: pct(v, 0.95),
        p25: pct(v, 0.25), p75: pct(v, 0.75),
        min: v[0], max: v[v.length - 1]
    };
}
// Two-sided sign test. With matched pairs, "how many of n went the same way"
// is a real signal even at small n, where a difference of means is not.
function signTest(k, n) {
    if (!n) return null;
    const C = (a, b) => { let r = 1; for (let i = 0; i < b; i++) r = (r * (a - i)) / (i + 1); return r; };
    let tail = 0;
    const lo = Math.min(k, n - k);
    for (let i = 0; i <= lo; i++) tail += C(n, i);
    const p = Math.min(1, 2 * tail / Math.pow(2, n));
    return p;
}

// ---------------------------------------------------------------------------
// local app bootstrap — its own memory Mongo, its own app instance
// ---------------------------------------------------------------------------
async function startApp() {
    const { MongoMemoryServer } = BK('mongodb-memory-server');
    const bcrypt = BK('bcryptjs');
    const { MongoClient, ObjectId } = BK('mongodb');
    const { hashKey, KEY_PREFIX } = require(path.join(BACKEND, 'api-keys'));

    const mongo = await MongoMemoryServer.create();
    const uri = `${mongo.getUri()}bench`;
    assertLocalMongo(uri, 'bench-model-latency.js');

    process.env.MONGODB_URI = uri;
    process.env.PORT = String(PORT);
    process.env.AI_PRO_FOR_ALL = 'true';
    process.env.JWT_SECRET = 'bench-local-fixed-secret';
    const ai = loadAiEnvOnly(BACKEND);
    assertLocalMongo(process.env.MONGODB_URI, 'bench (post-env-load)');
    if (!process.env.OLLAMA_API_KEY && !process.env.AI_BRIEFING_API_KEY) {
        throw new Error('No provider key in backend/.env — every surface would serve templates and the benchmark would measure nothing.');
    }
    const set = (k, v) => { if (process.env[k] === undefined) process.env[k] = v; };
    set('REQUIRE_ACTIVE_SUBSCRIPTION', 'false');
    set('REQUIRE_INITIAL_STRIPE_PAYMENT', 'false');
    set('DISABLE_BACKGROUND_JOBS', '1');
    set('WATCHDOG', '0');          // calls PAID inference; would pollute the token join
    set('GURU_PREWARM', '0');
    set('PREWARM', 'off');
    set('BOT_BLOCK_DRY_RUN', 'true');
    set('PUBLIC_API_RATE_LIMIT', '100000');
    set('ANON_MCP_ASK_LIMIT', '100000');
    set('ANON_MCP_LOOKUP_LIMIT', '100000');
    set('ANON_MCP_GLOBAL_ASK_DAY', '100000');

    const userId = new ObjectId('000000000000000000000001');
    const client = new MongoClient(uri);
    await client.connect();
    await client.db().collection('users').insertOne({
        _id: userId, name: 'Bench', email: ADMIN_EMAIL,
        password: await bcrypt.hash(PASSWORD, 10), authVersion: 0,
        subscription: { planId: 'desk', status: 'active', currentPeriodEnd: new Date(Date.now() + 3.15e10) },
        createdAt: new Date()
    });
    await client.db().collection('api_keys').insertOne({
        userId: String(userId), keyHash: hashKey(API_KEY),
        keyPrefix: API_KEY.slice(0, KEY_PREFIX.length + 6), label: 'bench',
        createdAt: new Date(), revokedAt: null, lastUsedAt: null
    });
    await client.close();

    const app = require(path.join(BACKEND, 'app.js'));
    // Dev-only model switch so the HTTP surfaces interleave like the rest.
    app.post('/__dev/model', BK('express').json(), (req, res) => {
        const { model, effort } = req.body || {};
        if (model) { process.env.AI_MODEL_CHAT = model; process.env.AI_MODEL_SUMMARY = model; process.env.AI_MODEL_BRIEFING = model; }
        if (effort) { process.env.AI_CHAT_REASONING_EFFORT = effort; process.env.AI_SUMMARY_REASONING_EFFORT = effort; }
        else { delete process.env.AI_CHAT_REASONING_EFFORT; process.env.AI_SUMMARY_REASONING_EFFORT = ''; }
        res.json({ ok: true });
    });
    await new Promise((r) => setTimeout(r, 1500)); // let mongoose connect + routes settle
    return { mongo, uri, aiLoaded: ai };
}

function applyModel(spec) {
    process.env.AI_MODEL_CHAT = spec.name;
    process.env.AI_MODEL_SUMMARY = spec.name;
    process.env.AI_MODEL_BRIEFING = spec.name;
    if (spec.effort) { process.env.AI_CHAT_REASONING_EFFORT = spec.effort; process.env.AI_SUMMARY_REASONING_EFFORT = spec.effort; }
    else { delete process.env.AI_CHAT_REASONING_EFFORT; process.env.AI_SUMMARY_REASONING_EFFORT = ''; }
}

// ---------------------------------------------------------------------------
// surfaces
// ---------------------------------------------------------------------------
const BASE = () => `http://localhost:${PORT}`;
const ASK_Q = (sym) => `How did ${sym} perform in its latest fiscal year, and what is its biggest risk?`;

function surfaces(mods) {
    const { aiChat, dossier, monitor, keypoints, filingDiff, segments, mongoose } = mods;
    return {
        ask_nonstream: async (sym) => {
            const r = await aiChat.ask({ question: ASK_Q(sym), history: [], ctx: {} });
            return { ok: r.source === 'ai', note: `source=${r.source}, ${r.toolsUsed.length} tools` };
        },
        ask_stream: async (sym) => {
            let deltas = 0;
            const r = await aiChat.ask({ question: ASK_Q(sym), history: [], ctx: {}, onEvent: (e) => { if (e.type === 'delta') deltas++; } });
            return { ok: r.source === 'ai', note: `source=${r.source}, ${deltas} deltas` };
        },
        dossier: async (sym) => {
            const d = await dossier.buildDossier(sym, { force: true, depth: 'standard' });
            const filled = [!!d.executiveSummary, (d.bull || []).length, (d.bear || []).length, (d.risks || []).length, (d.edge || []).length].filter(Boolean).length;
            return { ok: filled >= 4, note: `${filled}/5 sections` };
        },
        monitor: async (sym) => {
            const r = await monitor.buildReport(sym, { force: true });
            return { ok: !!r && !r.error, note: `source=${r && r.source}` };
        },
        keypoints: async (sym) => {
            // no force flag — clear this symbol's rows so a real extraction runs
            await mongoose.connection.collection('company_keypoints').deleteMany({ symbol: sym }).catch(() => {});
            const r = await keypoints.extractKeyPoints(sym, { allowAi: true, depth: 'standard' });
            const pts = (r.sections || []).reduce((a, s) => a + (s.points || []).length, 0);
            return { ok: pts > 0, note: `${pts} points` };
        },
        filing_diff: async (sym) => {
            await mongoose.connection.collection('filing_diffs').deleteMany({ symbol: sym }).catch(() => {});
            const r = await filingDiff.computeFilingDiff(sym);
            return { ok: !r.error, note: r.error ? r.error.slice(0, 40) : `${(r.changes || []).length} changes` };
        },
        segments: async (sym) => {
            await mongoose.connection.collection('company_segments').deleteMany({ symbol: sym }).catch(() => {});
            const r = await segments.extractSegments(sym);
            return { ok: !r.error, note: r.error ? r.error.slice(0, 40) : `${(r.segments || []).length} segments` };
        },
        api_ask: async (sym) => {
            const res = await fetch(`${BASE()}/api/v1/ask`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'X-Api-Key': API_KEY },
                body: JSON.stringify({ question: ASK_Q(sym) })
            });
            const j = await res.json().catch(() => ({}));
            return { ok: res.ok && !!j.answer, note: `http ${res.status}` };
        },
        mcp_ask: async (sym) => {
            const { Client } = require(path.join(BACKEND, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'client', 'index.js'));
            const { StreamableHTTPClientTransport } = require(path.join(BACKEND, 'node_modules', '@modelcontextprotocol', 'sdk', 'dist', 'cjs', 'client', 'streamableHttp.js'));
            const transport = new StreamableHTTPClientTransport(new URL(`${BASE()}/mcp`), { requestInit: { headers: { 'X-Api-Key': API_KEY } } });
            const client = new Client({ name: 'bench', version: '1.0.0' }, { capabilities: {} });
            await client.connect(transport);
            const r = await client.callTool({ name: 'sp_ask', arguments: { question: ASK_Q(sym) } });
            await client.close();
            const text = String(r.content?.[0]?.text || '');
            return { ok: text.length > 50, note: `${text.length}c` };
        }
    };
}
const HTTP_SURFACES = new Set(['api_ask', 'mcp_ask']);

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------
async function main() {
    console.log(`Profile ${PROFILE}: ${SURFACES.length} surfaces x ${TICKERS.length} tickers x ${SPECS.length} models x ${REPS} reps`);
    console.log(`Models: ${SPECS.map((s) => `${s.name}(${s.effort || 'default'})`).join(', ')}  baseline=${BASELINE}`);
    console.log(`Estimated provider spend: ~$${PLAN.estUsd}. This is real money on the owner's Ollama account.`);
    if (PROFILE === 'full' && !has('--yes')) {
        console.log('\nRefusing to start the full profile without --yes.');
        process.exit(1);
    }

    const { mongo, uri, aiLoaded } = await startApp();
    const mongoose = BK('mongoose');
    const mods = {
        mongoose,
        aiChat: require(path.join(BACKEND, 'ai-chat')),
        dossier: require(path.join(BACKEND, 'dossier')),
        monitor: require(path.join(BACKEND, 'filing-monitor')),
        keypoints: require(path.join(BACKEND, 'keypoints')),
        filingDiff: require(path.join(BACKEND, 'filing-diff')),
        segments: require(path.join(BACKEND, 'segments'))
    };
    const RUN = surfaces(mods);
    console.log(`Local app on ${BASE()}, throwaway DB, provider key ${maskKey(process.env.OLLAMA_API_KEY)}\n`);

    const cases = [];
    for (const surface of SURFACES) for (const sym of TICKERS) cases.push({ surface, sym });

    // Warm-up: populate the deterministic caches (SEC filings are 40MB
    // downloads) so the timed reps measure inference, not the network. Results
    // discarded. Without this the first rep of every case is dominated by SEC
    // and whichever model happened to go first wears the cost.
    console.log(`Warm-up pass (${cases.length} cases, untimed, results discarded)…`);
    applyModel(SPECS[0]);
    for (const c of cases) {
        if (HTTP_SURFACES.has(c.surface)) continue; // same code path as ask_nonstream
        process.stdout.write(`  ${c.surface}:${c.sym} `);
        const t = Date.now();
        try { await RUN[c.surface](c.sym); console.log(`${Math.round((Date.now() - t) / 1000)}s`); }
        catch (e) { console.log(`skip (${e.message.slice(0, 40)})`); }
    }

    const rows = [];
    const usage = mongoose.connection.collection('ollama_usage_events');
    console.log(`\nTimed reps (interleaved, rotating order)…`);
    for (let rep = 0; rep < REPS; rep++) {
        for (const c of cases) {
            // rotate so no model is always first
            const order = SPECS.map((_, i) => SPECS[(i + rep) % SPECS.length]);
            for (const spec of order) {
                applyModel(spec);
                if (HTTP_SURFACES.has(c.surface)) {
                    await fetch(`${BASE()}/__dev/model`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ model: spec.name, effort: spec.effort })
                    }).catch(() => {});
                }
                const t0 = new Date();
                let ok = false, note = '', err = null;
                try { const r = await RUN[c.surface](c.sym); ok = r.ok; note = r.note; }
                catch (e) { err = e.message.slice(0, 60); }
                const t1 = new Date();
                // Token join: serial execution means every provider call in this
                // window belongs to this case. Latency and cost therefore come
                // from one run, with no second measurement pass.
                let tok = { calls: 0, prompt: 0, completion: 0, errors: 0 };
                try {
                    const evs = await usage.find({ startedAt: { $gte: t0, $lte: t1 } }).toArray();
                    tok = evs.reduce((a, e) => ({
                        calls: a.calls + 1,
                        prompt: a.prompt + (e.promptTokens || 0),
                        completion: a.completion + (e.completionTokens || 0),
                        errors: a.errors + (e.status === 'error' ? 1 : 0)
                    }), tok);
                } catch (_) { /* best effort */ }
                rows.push({
                    rep, surface: c.surface, sym: c.sym, model: spec.name, effort: spec.effort,
                    ms: t1 - t0, ok, note, err,
                    providerCalls: tok.calls, promptTokens: tok.prompt, completionTokens: tok.completion,
                    retried: tok.errors > 0
                });
                const last = rows[rows.length - 1];
                console.log(`  r${rep + 1} ${c.surface.padEnd(13)} ${c.sym.padEnd(6)} ${spec.name.padEnd(14)} ${String(Math.round(last.ms / 100) / 10 + 's').padStart(7)} ${ok ? 'ok ' : 'FAIL'} ${tok.calls} calls ${tok.prompt + tok.completion} tok ${last.err || note}`);
            }
        }
    }

    report(rows);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = path.join(__dirname, '..', 'docs', 'benchmarks');
    fs.mkdirSync(outDir, { recursive: true });
    const jsonPath = path.join(outDir, `model-latency-${stamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify({ at: new Date().toISOString(), profile: PROFILE, specs: SPECS, tickers: TICKERS, surfaces: SURFACES, reps: REPS, rows }, null, 2));
    console.log(`\nRaw rows: ${jsonPath}`);

    await mongoose.disconnect().catch(() => {});
    await mongo.stop().catch(() => {});
    process.exit(0);
}

// Ollama list pricing, fetched 2026-09-22 from ollama.com/pricing.
const PRICES = {
    'glm-5.1': { input: 1.00, output: 3.20 },
    'glm-5.2': { input: 1.40, output: 4.40 },
    'glm-5.3': { input: 1.40, output: 4.40 },
    'glm-5.3-flash': { input: 0.15, output: 0.50 }
};
const costOf = (model, pTok, cTok) => {
    const p = PRICES[model];
    return p ? (pTok / 1e6) * p.input + (cTok / 1e6) * p.output : null;
};

function report(rows) {
    const models = [...new Set(rows.map((r) => r.model))];
    const surfaces = [...new Set(rows.map((r) => r.surface))];

    console.log('\n=== PER SURFACE x MODEL (all runs) ===');
    console.log(`${'surface'.padEnd(14)}${'model'.padEnd(15)}${'n'.padStart(3)}${'p50'.padStart(9)}${'p90'.padStart(9)}${'p95'.padStart(9)}${'IQR'.padStart(11)}${'retry'.padStart(7)}${'tok'.padStart(9)}${'$/call'.padStart(10)}`);
    for (const s of surfaces) {
        for (const m of models) {
            const rs = rows.filter((r) => r.surface === s && r.model === m);
            if (!rs.length) continue;
            const st = stats(rs.map((r) => r.ms / 1000));
            const tok = rs.reduce((a, r) => a + r.promptTokens + r.completionTokens, 0) / rs.length;
            const usd = rs.map((r) => costOf(m, r.promptTokens, r.completionTokens)).filter((x) => x !== null);
            const avgUsd = usd.length ? usd.reduce((a, b) => a + b, 0) / usd.length : null;
            const retry = rs.filter((r) => r.retried).length / rs.length;
            console.log(
                s.padEnd(14) + m.padEnd(15) + String(st.n).padStart(3) +
                `${st.p50.toFixed(1)}s`.padStart(9) + `${st.p90.toFixed(1)}s`.padStart(9) + `${st.p95.toFixed(1)}s`.padStart(9) +
                `${st.p25.toFixed(1)}-${st.p75.toFixed(1)}s`.padStart(11) +
                `${Math.round(retry * 100)}%`.padStart(7) + String(Math.round(tok)).padStart(9) +
                (avgUsd === null ? '-'.padStart(10) : `$${avgUsd.toFixed(4)}`.padStart(10))
            );
        }
    }

    console.log('\n=== PAIRED RATIOS vs ' + BASELINE + ' (the headline — immune to provider drift) ===');
    console.log(`${'surface'.padEnd(14)}${'model'.padEnd(15)}${'pairs'.padStart(6)}${'median'.padStart(9)}${'IQR of ratios'.padStart(16)}${'faster'.padStart(9)}${'sign p'.padStart(9)}`);
    for (const s of surfaces) {
        for (const m of models) {
            if (m === BASELINE) continue;
            const ratios = [];
            for (const rep of [...new Set(rows.map((r) => r.rep))]) {
                for (const sym of [...new Set(rows.map((r) => r.sym))]) {
                    const a = rows.find((r) => r.rep === rep && r.sym === sym && r.surface === s && r.model === BASELINE);
                    const b = rows.find((r) => r.rep === rep && r.sym === sym && r.surface === s && r.model === m);
                    if (a && b && a.ok && b.ok && a.ms > 0) ratios.push(b.ms / a.ms);
                }
            }
            if (!ratios.length) continue;
            const st = stats(ratios);
            const faster = ratios.filter((x) => x < 1).length;
            const p = signTest(faster, ratios.length);
            console.log(
                s.padEnd(14) + m.padEnd(15) + String(ratios.length).padStart(6) +
                `${st.p50.toFixed(2)}x`.padStart(9) +
                `${st.p25.toFixed(2)}-${st.p75.toFixed(2)}x`.padStart(16) +
                `${faster}/${ratios.length}`.padStart(9) +
                (p === null ? '-'.padStart(9) : p.toFixed(3).padStart(9))
            );
        }
    }
    console.log('\nmedian < 1.00x = candidate is FASTER. "sign p" is a two-sided sign test on the');
    console.log('matched pairs; below ~0.05 the direction is unlikely to be chance at this n.');

    console.log('\n=== TOTALS (footnote only — block-ordered totals are what misled before) ===');
    for (const m of models) {
        const rs = rows.filter((r) => r.model === m);
        const tot = rs.reduce((a, r) => a + r.ms, 0) / 1000;
        const pTok = rs.reduce((a, r) => a + r.promptTokens, 0);
        const cTok = rs.reduce((a, r) => a + r.completionTokens, 0);
        const usd = costOf(m, pTok, cTok);
        console.log(`  ${m.padEnd(15)} ${tot.toFixed(0)}s over ${rs.length} runs, ${pTok} in / ${cTok} out tok, ${usd === null ? '?' : '$' + usd.toFixed(3)}  (measured in/out split ${pTok + cTok ? Math.round(100 * pTok / (pTok + cTok)) : '?'}/${pTok + cTok ? Math.round(100 * cTok / (pTok + cTok)) : '?'})`);
    }
}

main().catch((e) => { console.error(e); process.exit(1); });
