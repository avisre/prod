'use strict';

/**
 * End-to-end feature parity across models — the surfaces a user actually
 * touches, not just the extractors.
 *
 * ab-summary-quality.js scores the two extractors that have machine-checkable
 * ground truth. This runs the composed features on top of them — Key Points,
 * Dossier, Filing Monitor and Ask — and asks a blunter question: does the
 * feature still come back, with its AI sections filled, in a sane time, in
 * dollars?
 *
 * Two edge cases it exists for:
 *   - HUGE filings (BRK-B): the Key Points risk pass alone ships ~100k chars.
 *   - FOREIGN filers (BABA/TSM/SONY/ASML/NVO): the filing prints RMB/TWD/JPY/
 *     EUR/DKK, every figure the user sees is USD, and the conversion is
 *     deterministic downstream. A model that "helpfully" converts, or that
 *     writes the filing's own currency into prose, breaks that silently.
 *
 * Usage:
 *   node scripts/ab-feature-parity.js --models glm-5.1:none,glm-5.3:low
 *   node scripts/ab-feature-parity.js --tickers BRK-B,BABA --features dossier,monitor
 *
 * NOTE: Key Points has no force flag, so its cache rows for the test tickers
 * are deleted before each run. They are a cache and rebuild on next request.
 */

const path = require('path');
const BK = (m) => require(path.join(__dirname, '..', 'backend', 'node_modules', m));
// NOT dotenv.config on backend/.env — that file carries the production Atlas
// MONGODB_URI alongside the provider keys, and this script deletes cache rows
// and force-rebuilds dossiers. Pulling in the whole file is how it wrote to
// production on 2026-09-22. Take the AI keys only.
const { loadAiEnvOnly, assertLocalMongo } = require('./lib/dev-env');
loadAiEnvOnly(path.join(__dirname, '..', 'backend'));
const mongoose = BK('mongoose');

const aiChat = require('../backend/ai-chat');   // first: breaks the watchdog require cycle
const keypoints = require('../backend/keypoints');
const dossier = require('../backend/dossier');
const monitor = require('../backend/filing-monitor');

const arg = (f, d) => { const i = process.argv.indexOf(f); return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const SPECS = arg('--models', 'glm-5.1:none,glm-5.3:low').split(',').map((s) => s.trim()).filter(Boolean)
    .map((s) => { const [name, eff] = s.split(':'); return { name, effort: eff === undefined ? 'none' : eff }; });
const TICKERS = arg('--tickers', 'BRK-B,BABA,TSM,SONY,AAPL').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const FEATURES = arg('--features', 'keypoints,dossier,monitor,chat').split(',').map((s) => s.trim());

// Currencies that must never reach the user: everything on the site is USD,
// converted deterministically from the filing at a recorded rate. Prose that
// quotes the filing's own currency is a real defect, not a style nit.
// Word-boundaried on purpose: an unanchored /euros?/ matches "Europe", which
// turned every Apple filing into a false positive. A bare currency mention is
// not automatically a defect either — a 20-F legitimately quotes itself as
// "RMB344.6 billion (US$50.0 billion)", and repeating that is faithful. This
// flags text to READ, not text that is wrong.
// Leading \b only on the ISO-style codes: filings write "RMB344.6 billion"
// with no space, so a trailing \b would miss exactly the case we care about.
// The spelled-out words DO need a trailing \b — an unanchored /euros?/ matches
// "Europe", which turned every Apple filing into a false positive.
const FOREIGN_CURRENCY = /(?:\bRMB|\bCNY|\bJPY|\bTWD|\bHKD|\bEUR(?!ope|opean)|\bKRW|\bINR|\bDKK|\bSEK|\bNOK|\bCHF|\bGBP|NT\$|HK\$|¥|€|₩|₹|£|\byuan\b|\brenminbi\b|\byen\b|\beuros?\b|\brupees?\b)/i;
const scanCurrency = (...texts) => {
    const hits = [];
    for (const t of texts) {
        const m = String(t || '').match(new RegExp(FOREIGN_CURRENCY.source, 'gi'));
        if (m) hits.push(...m);
    }
    return [...new Set(hits.map((h) => h.toLowerCase()))];
};

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

async function runKeypoints(sym) {
    // no force flag — clear this ticker's rows so we measure a real extraction
    try { await mongoose.connection.collection('company_keypoints').deleteMany({ symbol: sym }); } catch (_) { /* best effort */ }
    const t0 = Date.now();
    const r = await keypoints.extractKeyPoints(sym, { allowAi: true, depth: 'standard' });
    const ms = Date.now() - t0;
    if (r.error) return { ok: false, ms, note: r.error };
    const sections = r.sections || [];
    const points = sections.reduce((a, s) => a + (s.points || []).length, 0);
    const currency = scanCurrency(...sections.flatMap((s) => [s.heading, ...(s.points || [])]));
    return { ok: points > 0, ms, detail: `${sections.length} sections, ${points} points`, currency };
}

async function runDossier(sym) {
    const t0 = Date.now();
    const d = await dossier.buildDossier(sym, { force: true, depth: 'standard' });
    const ms = Date.now() - t0;
    if (!d || d.error) return { ok: false, ms, note: (d && d.error) || 'no dossier' };
    // the four AI writing calls, each independently allowed to fail
    // field names per dossier.js:475-486 — all top level, each written by its
    // own independent AI call so a partial dossier is a normal outcome
    const ai = {
        summary: !!d.executiveSummary,
        bull: !!(d.bull || []).length,
        bear: !!(d.bear || []).length,
        risks: !!(d.risks || []).length,
        edge: !!(d.edge || []).length
    };
    const filled = Object.values(ai).filter(Boolean).length;
    const currency = scanCurrency(
        d.executiveSummary,
        ...[...(d.bull || []), ...(d.bear || [])].map((x) => `${x.point} ${x.basis}`),
        ...(d.risks || []).map((x) => `${x.risk} ${x.trigger} ${x.impact} ${x.mitigant}`),
        ...(d.edge || []).map((x) => `${x.insight} ${x.evidence} ${x.soWhat}`)
    );
    return { ok: filled >= 4, ms, detail: `${filled}/5 AI sections (${Object.entries(ai).filter(([, v]) => !v).map(([k]) => 'no ' + k).join(', ') || 'all'})`, currency };
}

async function runMonitor(sym) {
    const t0 = Date.now();
    const r = await monitor.buildReport(sym, { force: true });
    const ms = Date.now() - t0;
    if (!r || r.error) return { ok: false, ms, note: (r && r.error) || 'no report' };
    const src = r.source || (r.summarySource) || 'unknown';
    const text = r.summary || r.brief || '';
    return {
        ok: !!text && src !== 'template-fallback',
        ms,
        detail: `source=${src}, ${String(text).length}c`,
        currency: scanCurrency(text)
    };
}

async function runChat(sym) {
    const t0 = Date.now();
    const r = await aiChat.ask({
        question: `How did ${sym} perform in its latest fiscal year, and what is the single biggest risk?`,
        history: [], ctx: {}
    });
    const ms = Date.now() - t0;
    const a = String(r.answer || '');
    return {
        ok: r.source === 'ai',
        ms,
        detail: `source=${r.source}, ${a.length}c, ${r.toolsUsed.length} tools, ${r.totalTokens || '?'} tok`,
        currency: scanCurrency(a)
    };
}

const RUNNERS = { keypoints: runKeypoints, dossier: runDossier, monitor: runMonitor, chat: runChat };

async function main() {
    // Hard stop. This script is destructive (deleteMany on company_keypoints,
    // force-rebuilds of dossiers and monitor reports) and only ever belongs
    // against a throwaway database. Pass --db mongodb://127.0.0.1:27017/<name>
    // or run it under scripts/dev-local.js.
    const dbUri = arg('--db', process.env.BENCH_MONGODB_URI || '');
    assertLocalMongo(dbUri, 'ab-feature-parity.js');
    await mongoose.connect(dbUri);
    console.log(`Feature parity: ${SPECS.map((s) => `${s.name}(effort ${s.effort || 'default'})`).join(' vs ')}`);
    console.log(`Tickers:  ${TICKERS.join(', ')}`);
    console.log(`Features: ${FEATURES.join(', ')}\n`);

    const results = {};
    for (const spec of SPECS) {
        // cfg() resolves per request, so setting env here is enough.
        process.env.AI_MODEL_SUMMARY = spec.name;
        process.env.AI_MODEL_CHAT = spec.name;
        process.env.AI_MODEL_BRIEFING = spec.name;
        if (spec.effort) { process.env.AI_SUMMARY_REASONING_EFFORT = spec.effort; process.env.AI_CHAT_REASONING_EFFORT = spec.effort; }
        else { process.env.AI_SUMMARY_REASONING_EFFORT = ''; delete process.env.AI_CHAT_REASONING_EFFORT; }

        console.log(`=== ${spec.name} (effort ${spec.effort || 'provider default'}) ===`);
        results[spec.name] = {};
        for (const feat of FEATURES) {
            for (const sym of TICKERS) {
                let r;
                try { r = await RUNNERS[feat](sym); }
                catch (e) { r = { ok: false, ms: 0, note: e.message.slice(0, 90) }; }
                results[spec.name][`${feat}:${sym}`] = r;
                const cur = (r.currency && r.currency.length) ? `  <-- NON-USD: ${r.currency.join(',')}` : '';
                console.log(`  ${feat.padEnd(9)} ${sym.padEnd(6)} ${r.ok ? 'ok  ' : 'FAIL'} ${secs(r.ms).padStart(7)}  ${r.detail || r.note || ''}${cur}`);
            }
        }
        console.log('');
    }

    console.log('=== SIDE BY SIDE ===');
    const base = SPECS[0].name;
    const keys = Object.keys(results[base]);
    console.log(`${'case'.padEnd(22)}${SPECS.map((s) => (s.name + ' ok/time').padEnd(26)).join('')}`);
    for (const k of keys) {
        const cells = SPECS.map((s) => {
            const r = results[s.name][k];
            return `${r.ok ? 'ok' : 'FAIL'} ${secs(r.ms)}`.padEnd(26);
        });
        console.log(`${k.padEnd(22)}${cells.join('')}`);
    }

    console.log('\n=== SUMMARY ===');
    for (const s of SPECS) {
        const rs = Object.values(results[s.name]);
        const ok = rs.filter((r) => r.ok).length;
        const cur = rs.filter((r) => r.currency && r.currency.length).length;
        const total = rs.reduce((a, r) => a + r.ms, 0);
        console.log(`${s.name.padEnd(14)} ${ok}/${rs.length} ok, ${cur} with non-USD currency in user-visible text, ${secs(total)} total`);
    }

    console.log('\n--- JSON ---');
    console.log(JSON.stringify({ at: new Date().toISOString(), specs: SPECS, tickers: TICKERS, results }, null, 2));
    await mongoose.disconnect().catch(() => {});
}

main().catch((e) => { console.error(e); process.exit(1); });
