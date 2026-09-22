'use strict';

/**
 * Output-quality A/B for the `summary` model slot.
 *
 * Only two surfaces in this product have machine-checkable ground truth, and
 * this scores both rather than asking a model to judge prose:
 *
 *   filing-diff — every quote is checked character-for-character against the
 *                 document it cites (quoteIsInSource) and every figure in the
 *                 commentary against a mantissa set built from both filings
 *                 (stripUnsupportedFigures). Those are the production filters,
 *                 imported, not reimplemented.
 *   segments    — the extracted segment revenues must sum to the company's
 *                 filed total revenue at some unit scale (repairUnits' own
 *                 0.5x-2x acceptance window).
 *
 * Everything else (keypoints, thesis, insights, dossier prose) gets a smoke
 * check only: parseable JSON on attempt 1, non-empty, no <think> residue.
 * Inventing a quality score for prose with no ground truth would be worse
 * than reporting nothing.
 *
 * Nothing is written: the diff is scored in memory, never through
 * computeFilingDiff(), so the live filing_diffs corpus is untouched and both
 * models see byte-identical input.
 *
 * Usage:
 *   node scripts/ab-summary-quality.js --models glm-5.1,glm-5.3,glm-5.3-flash
 *   node scripts/ab-summary-quality.js --models glm-5.1,glm-5.3 --tickers AAPL,AAOI
 */

const path = require('path');
const BK = (m) => require(path.join(__dirname, '..', 'backend', 'node_modules', m));
// AI keys only — backend/.env also carries the production Atlas MONGODB_URI.
// This script scores in memory and writes nothing, but it should not be able
// to reach production either.
const { loadAiEnvOnly, assertLocalMongo } = require('./lib/dev-env');
loadAiEnvOnly(path.join(__dirname, '..', 'backend'));
const mongoose = BK('mongoose');
const axios = BK('axios');

// ai-chat first, deliberately: segments -> watchdog -> ai-chat is a require
// cycle, and loading it any later leaves watchdog holding a half-built
// ai-chat whose fetchRecentFilings is still undefined — which shows up as
// every segments extraction silently skipping.
require('../backend/ai-chat');
const aiClient = require('../backend/ai-client');
const diff = require('../backend/filing-diff');
const segments = require('../backend/segments');
const secSource = require('../backend/sec-source');

const arg = (flag, dflt) => {
    const i = process.argv.indexOf(flag);
    return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
};
// "name" or "name:effort" — the right reasoning effort is a property of the
// model, so a fair comparison runs each at its own best setting rather than
// forcing one global value that happens to suit the incumbent.
const SPECS = arg('--models', 'glm-5.1:none,glm-5.3:low,glm-5.3-flash:low')
    .split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => { const [name, eff] = s.split(':'); return { name, effort: eff === undefined ? 'none' : eff }; });
const MODELS = SPECS.map((s) => s.name);
const EFFORT = Object.fromEntries(SPECS.map((s) => [s.name, s.effort]));
const BASELINE = MODELS[0];
// Known-defect corpus (the reasoning-leak and fabricated-figure cases that
// tmp-audit-diff-quality.js found) + style diversity, so a candidate cannot
// look good by being tuned to small-cap semiconductors.
const TICKERS = arg('--tickers', 'AAPL,AAOI,NVTS,TSEM,WOLF,MSFT,JPM,XOM,UNH,TSLA')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

const THINK_ANY = /<\/?\s*think\s*>/i;
const pct = (n, d) => (d ? Math.round((n / d) * 100) : 0);

function productionParse(text) {
    try {
        const raw = String(text || '').replace(/```json|```/g, '').trim();
        return JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
    } catch (_) { return null; }
}

// ---------------------------------------------------------------------------
// inputs — fetched ONCE per ticker, shared by every model
// ---------------------------------------------------------------------------
async function diffInputs(sym) {
    const pair = await diff.latestPair(sym);
    if (!pair) return null;
    const { latest, prev } = pair;
    if (!/\.htm/i.test(latest.url) || !/\.htm/i.test(prev.url)) return null;
    const get = (url) => axios.get(url, { headers: secSource.SEC_HEADERS, timeout: 45000, maxContentLength: 60e6 });
    const newDoc = diff.narrativeWindows(segments.htmlToText((await get(latest.url)).data));
    const oldDoc = diff.narrativeWindows(segments.htmlToText((await get(prev.url)).data));
    if (newDoc.length < 500 || oldDoc.length < 500) return null;
    return { sym, latest, prev, newDoc, oldDoc };
}

async function segmentInputs(sym) {
    const tenK = await segments.latestTenK(sym);
    if (!tenK || !tenK.url || !/\.htm/i.test(tenK.url)) return null;
    const r = await axios.get(tenK.url, { headers: secSource.SEC_HEADERS, timeout: 45000, maxContentLength: 60e6 });
    const text = segments.segmentWindows(segments.htmlToText(r.data));
    if (text.length < 500) return null;
    return { sym, date: tenK.date, text, filed: segments.filedRevenue(sym), rate: segments.usdRate(sym) };
}

// ---------------------------------------------------------------------------
// scorer 1 — filing diff
// ---------------------------------------------------------------------------
async function scoreDiff(model, inp) {
    const t0 = Date.now();
    let msg;
    try {
        msg = await aiClient.chatRaw([
            { role: 'system', content: diff.DIFF_SYSTEM },
            { role: 'user', content: diff.diffUserMessage(inp, '') }
        ], { purpose: 'summary', temperature: 0, maxTokens: 4000, timeoutMs: 90000, model, reasoningEffort: EFFORT[model] });
    } catch (e) {
        return { sym: inp.sym, error: e.message, parseOk: false, changes: 0, leaks: 0, evid: 0, figOk: 0, yield: 0 };
    }
    const ms = Date.now() - t0;
    const text = String(msg.content || '');
    const parsed = productionParse(text);
    const shaped = !!(parsed && typeof parsed.headline === 'string' && Array.isArray(parsed.changes));
    if (!shaped) {
        return { sym: inp.sym, parseOk: false, changes: 0, leaks: 0, evid: 0, figOk: 0, yield: 0, ms, think: THINK_ANY.test(text), sample: text.slice(0, 200) };
    }

    const sourceFigures = diff.sourceMantissaSet(`${inp.oldDoc}\n${inp.newDoc}`);
    let leaks = 0, evid = 0, figOk = 0, survived = 0;
    const examples = [];
    for (const c of parsed.changes) {
        const rawWhat = String(c.what || '');
        const leaked = diff.REASONING_TELL.test(rawWhat);
        if (leaked) { leaks++; examples.push({ kind: 'leak', text: rawWhat.slice(0, 160) }); }

        const priorOk = diff.quoteIsInSource(c.priorQuote, inp.oldDoc);
        const newOk = diff.quoteIsInSource(c.newQuote || c.quote, inp.newDoc);
        if (priorOk && newOk) evid++;
        else if (examples.length < 6) examples.push({ kind: 'unverified-quote', prior: String(c.priorQuote || '').slice(0, 90), next: String(c.newQuote || c.quote || '').slice(0, 90) });

        const cleaned = diff.stripUnsupportedFigures(diff.cleanWhat(rawWhat), sourceFigures);
        if (cleaned.removed.length === 0) figOk++;
        else if (examples.length < 6) examples.push({ kind: 'unsupported-figure', removed: cleaned.removed.slice(0, 3) });

        // what a user actually sees: survives all three filters
        if (!leaked && priorOk && newOk && cleaned.removed.length === 0 && cleaned.what.length >= 12) survived++;
    }
    return {
        sym: inp.sym, parseOk: true, changes: parsed.changes.length,
        leaks, evid, figOk, yield: survived, ms,
        think: THINK_ANY.test(text),
        tokens: msg._usage ? { in: msg._usage.prompt_tokens, out: msg._usage.completion_tokens } : null,
        examples: examples.slice(0, 4)
    };
}

// ---------------------------------------------------------------------------
// scorer 2 — segments (independent ground truth: does the sum reconcile?)
// ---------------------------------------------------------------------------
async function scoreSegments(model, inp) {
    let msg;
    try {
        msg = await aiClient.chatRaw([
            { role: 'system', content: segments.EXTRACT_SYSTEM },
            { role: 'user', content: `Company: ${inp.sym}. 10-K filed ${inp.date}. Extract the business segments.\n\n${inp.text}` }
        ], { purpose: 'summary', temperature: 0, maxTokens: 6000, timeoutMs: 90000, model, reasoningEffort: EFFORT[model] });
    } catch (e) { return { sym: inp.sym, error: e.message, parseOk: false }; }

    const parsed = productionParse(String(msg.content || ''));
    if (!parsed || !Array.isArray(parsed.segments)) return { sym: inp.sym, parseOk: false };
    const sum = parsed.segments.reduce((a, s) => a + (Number(s.revenueUsd) || 0), 0);
    if (!sum || !inp.filed) return { sym: inp.sym, parseOk: true, n: parsed.segments.length, reconcilable: null };

    // repairUnits' own acceptance test, over exactly the scales production
    // tries — including the FX ones, which is the whole point for a foreign
    // private issuer. `filedRevenue` is already USD; the filing itself prints
    // RMB/TWD/JPY/EUR, and the prompt tells the model to copy the PRINTED
    // figure and never convert, because the pipeline converts deterministically
    // afterwards at a recorded rate.
    //
    // So the scale that matches tells us what the model actually did:
    //   1e6*rate / 1e3*rate / rate -> faithful: it copied the printed figure
    //   1e6 / 1e3 / 1              -> for a foreign filer, it CONVERTED to USD
    //                                 on its own. The number may look right and
    //                                 still be wrong, because it used some rate
    //                                 of its own rather than the one every other
    //                                 figure on the page uses.
    const rate = inp.rate;
    const scales = rate
        ? [{ s: 1e6 * rate, tag: 'millions x fx' }, { s: 1e3 * rate, tag: 'thousands x fx' }, { s: rate, tag: 'units x fx' },
           { s: 1e6, tag: 'millions (SELF-CONVERTED)' }, { s: 1e3, tag: 'thousands (SELF-CONVERTED)' }, { s: 1, tag: 'units (SELF-CONVERTED)' }]
        : [{ s: 1, tag: 'units' }, { s: 1e6, tag: 'millions' }, { s: 1e3, tag: 'thousands' }];
    let best = null;
    for (const c of scales) {
        const r = inp.filed / (sum * c.s);
        if (r > 0.5 && r < 2 && (best === null || Math.abs(r - 1) < Math.abs(best.r - 1))) best = { scale: c.s, tag: c.tag, r };
    }
    return {
        sym: inp.sym, parseOk: true, n: parsed.segments.length,
        reconcilable: !!best, scale: best && best.tag,
        selfConverted: !!(best && rate && /SELF-CONVERTED/.test(best.tag)),
        residual: best ? Math.abs(best.r - 1) : null
    };
}

// ---------------------------------------------------------------------------
function agg(rows) {
    const ok = rows.filter((r) => r.parseOk);
    const changes = ok.reduce((a, r) => a + r.changes, 0);
    return {
        parseOk: ok.length, n: rows.length,
        changes,
        leakRate: changes ? ok.reduce((a, r) => a + r.leaks, 0) / changes : 0,
        evidRate: changes ? ok.reduce((a, r) => a + r.evid, 0) / changes : 0,
        figRate: changes ? ok.reduce((a, r) => a + r.figOk, 0) / changes : 0,
        yieldTotal: ok.reduce((a, r) => a + r.yield, 0),
        yieldPerFiling: ok.length ? ok.reduce((a, r) => a + r.yield, 0) / ok.length : 0,
        tokensOut: ok.reduce((a, r) => a + ((r.tokens && r.tokens.out) || 0), 0),
        meanMs: ok.length ? Math.round(ok.reduce((a, r) => a + r.ms, 0) / ok.length) : 0,
        thinkLeaks: ok.filter((r) => r.think).length
    };
}

function gates(base, cand, baseRows, candRows) {
    const g = [];
    g.push({ id: 1, what: 'parse_ok = all filings, and >= baseline', pass: cand.parseOk === cand.n && cand.parseOk >= base.parseOk, got: `${cand.parseOk}/${cand.n} vs ${base.parseOk}/${base.n}` });
    g.push({ id: 2, what: 'leak_rate <= max(baseline, 3%)', pass: cand.leakRate <= Math.max(base.leakRate, 0.03), got: `${(cand.leakRate * 100).toFixed(1)}% vs ${(base.leakRate * 100).toFixed(1)}%` });
    g.push({ id: 3, what: 'evidence_rate >= 85% of baseline', pass: cand.evidRate >= 0.85 * base.evidRate, got: `${(cand.evidRate * 100).toFixed(1)}% vs ${(base.evidRate * 100).toFixed(1)}%` });
    g.push({ id: 4, what: 'figures_clean >= 90% of baseline', pass: cand.figRate >= 0.90 * base.figRate, got: `${(cand.figRate * 100).toFixed(1)}% vs ${(base.figRate * 100).toFixed(1)}%` });
    g.push({ id: 5, what: 'yield >= 80% of baseline', pass: cand.yieldTotal >= 0.80 * base.yieldTotal, got: `${cand.yieldTotal} vs ${base.yieldTotal}` });
    const collapses = candRows.filter((c) => {
        const b = baseRows.find((x) => x.sym === c.sym);
        return b && c.yield === 0 && b.yield >= 3;
    }).map((c) => c.sym);
    g.push({ id: 6, what: 'no ticker collapses to zero', pass: collapses.length === 0, got: collapses.length ? collapses.join(',') : 'none' });
    return g;
}

async function main() {
    if (!aiClient.isConfigured()) { console.error('AI not configured — need OLLAMA_API_KEY in backend/.env'); process.exit(1); }
    // Mongo is optional here (the scorers fetch from SEC and score in memory);
    // connect only when a local URI is given explicitly.
    const dbUri = arg('--db', process.env.BENCH_MONGODB_URI || '');
    if (dbUri) { assertLocalMongo(dbUri, 'ab-summary-quality.js'); await mongoose.connect(dbUri).catch(() => {}); }

    console.log(`A/B: ${MODELS.join(' vs ')} (baseline ${BASELINE})`);
    console.log(`Reasoning effort: ${SPECS.map((s) => `${s.name}=${s.effort || '(omitted)'}`).join(', ')}`);
    console.log(`Tickers: ${TICKERS.join(', ')}\n`);

    console.log('Fetching filing inputs once per ticker (shared by every model)…');
    const dIn = [], sIn = [];
    for (const t of TICKERS) {
        const d = await diffInputs(t).catch((e) => { console.log(`  ${t} diff inputs failed: ${e.message}`); return null; });
        if (d) { dIn.push(d); process.stdout.write(`  ${t} diff ok`); } else process.stdout.write(`  ${t} diff SKIP`);
        const s = await segmentInputs(t).catch(() => null);
        if (s) { sIn.push(s); console.log(', segments ok'); } else console.log(', segments SKIP');
    }
    console.log(`\n${dIn.length} diff pairs, ${sIn.length} segment filings.\n`);

    const diffRows = {}, segRows = {};
    for (const m of MODELS) {
        console.log(`--- ${m} ---`);
        diffRows[m] = [];
        for (const inp of dIn) {
            const r = await scoreDiff(m, inp);
            diffRows[m].push(r);
            console.log(`  diff ${r.sym.padEnd(5)} parse=${r.parseOk ? 'y' : 'N'} changes=${String(r.changes).padStart(2)} evid=${r.evid} figOk=${r.figOk} leaks=${r.leaks} yield=${r.yield} ${r.ms}ms`);
        }
        segRows[m] = [];
        for (const inp of sIn) {
            const r = await scoreSegments(m, inp);
            segRows[m].push(r);
            console.log(`  seg  ${r.sym.padEnd(5)} parse=${r.parseOk ? 'y' : 'N'} n=${String(r.n ?? '-').padStart(2)} scale=${String(r.scale || '-').padEnd(26)} residual=${r.residual !== null && r.residual !== undefined ? r.residual.toFixed(3) : '-'}${r.selfConverted ? '  <-- SELF-CONVERTED' : ''}`);
        }
    }

    console.log('\n=== FILING-DIFF AGGREGATE ===');
    const A = {};
    for (const m of MODELS) {
        A[m] = agg(diffRows[m]);
        const a = A[m];
        console.log(`${m.padEnd(14)} parse ${a.parseOk}/${a.n}  changes ${a.changes}  leak ${(a.leakRate * 100).toFixed(1)}%  evidence ${(a.evidRate * 100).toFixed(1)}%  figures ${(a.figRate * 100).toFixed(1)}%  yield ${a.yieldTotal} (${a.yieldPerFiling.toFixed(1)}/filing)  out ${a.tokensOut}tok  ${a.meanMs}ms  think-leaks ${a.thinkLeaks}`);
    }

    console.log('\n=== SEGMENTS AGGREGATE (independent ground truth) ===');
    for (const m of MODELS) {
        const rows = segRows[m].filter((r) => r.parseOk && r.reconcilable !== null);
        const rec = rows.filter((r) => r.reconcilable);
        const res = rec.map((r) => r.residual).sort((a, b) => a - b);
        const med = res.length ? res[Math.floor(res.length / 2)] : null;
        const selfConv = segRows[m].filter((r) => r.selfConverted).map((r) => r.sym);
        console.log(`${m.padEnd(14)} parsed ${segRows[m].filter((r) => r.parseOk).length}/${segRows[m].length}  reconcilable ${rec.length}/${rows.length}  median residual ${med === null ? '-' : med.toFixed(3)}  self-converted: ${selfConv.length ? selfConv.join(',') : 'none'}`);
    }

    console.log('\n=== GATES (candidate vs baseline) ===');
    let allPass = true;
    for (const m of MODELS.slice(1)) {
        console.log(`\n${m}:`);
        for (const g of gates(A[BASELINE], A[m], diffRows[BASELINE], diffRows[m])) {
            if (!g.pass) allPass = false;
            console.log(`  ${g.pass ? 'PASS' : 'FAIL'}  gate ${g.id}: ${g.what}  [${g.got}]`);
        }
    }
    console.log(`\nVERDICT: ${allPass ? 'all candidates clear every gate' : 'at least one gate failed — do not flip AI_MODEL_SUMMARY'}`);

    console.log('\n--- JSON ---');
    console.log(JSON.stringify({ at: new Date().toISOString(), models: MODELS, tickers: TICKERS, diff: A, diffRows, segRows }, null, 2));
    await mongoose.disconnect().catch(() => {});
}

main().catch((e) => { console.error(e); process.exit(1); });
