'use strict';
// Price-trend indicators for the whole screen universe, rebuilt once per US
// trading day and kept in one Mongo document, so the screener and Ask can
// filter on RSI, the 200-day average, a recent golden cross or a volume surge
// without a Yahoo call per row. A single ticker uses technicals.forSymbol().
//
// The build is paced (two symbols at a time with a pause) because the same
// server IP fetches live quotes for every page; a burst of ~4,400 chart calls
// that got it rate-limited would break the site, not just this snapshot.

const mongoose = require('mongoose');
const technicals = require('./technicals');

const COLUMNS = ['symbol', 'close', 'rsi14', 'sma50', 'sma200', 'crossType', 'crossDate', 'volumeRatio20', 'pctFrom52wHigh', 'trend'];
const BUILD_HOUR_UTC = 22; // after the 4pm New York close in summer (20:00 UTC) and winter (21:00 UTC)
const REBUILD_AFTER_MS = 20 * 3600 * 1000;

const Snapshot = mongoose.models.TechnicalsSnapshot || mongoose.model('TechnicalsSnapshot', new mongoose.Schema({
    _id: String, asOf: String, builtAt: Date, symbols: Number, failed: Number, stale: Number, columns: [String], rows: mongoose.Schema.Types.Mixed
}, { collection: 'technicals_snapshot', versionKey: false }));

let current = null; // { asOf, builtAt, bySymbol: Map }
let loaded = false, building = false;

const round = (v, dp = 2) => (Number.isFinite(v) ? Math.round(v * 10 ** dp) / 10 ** dp : null);

function toRow(symbol, t) {
    return [symbol, t.close, t.rsi14, t.sma50, t.sma200, t.lastCross ? t.lastCross.type : null, t.lastCross ? t.lastCross.date : null, t.volumeRatio20, t.pctFrom52wHigh, t.trend];
}

function index(doc) {
    const cols = doc.columns || COLUMNS, bySymbol = new Map();
    for (const r of doc.rows || []) {
        const o = {};
        cols.forEach((c, i) => { o[c] = r[i] ?? null; });
        o.pctVsSma200 = o.close !== null && o.sma200 ? round((o.close / o.sma200 - 1) * 100) : null; // same formula as technicals.compute
        // calendar days from the cross to the snapshot's session, golden only
        o.goldenCrossDaysAgo = o.crossType === 'golden' && o.crossDate ? Math.round((Date.parse(doc.asOf) - Date.parse(o.crossDate)) / 86400000) : null;
        bySymbol.set(o.symbol, o);
    }
    return { asOf: doc.asOf, builtAt: new Date(doc.builtAt), bySymbol };
}

// Rows whose last session is not the snapshot's (halted, delisted) are dropped:
// a stale RSI under today's date would be a wrong number, not an old one.
async function build({ symbols, fetcher = technicals.fetchRows, concurrency = 2, gapMs = 250, now = new Date() } = {}) {
    const results = [];
    let failed = 0, next = 0;
    const worker = async () => {
        while (next < symbols.length) {
            const symbol = symbols[next++];
            try {
                const t = technicals.compute(await fetcher(symbol, { now }));
                if (t) results.push([symbol, t]); else failed++;
            } catch (_) { failed++; }
            if (gapMs) await new Promise((r) => setTimeout(r, gapMs));
        }
    };
    await Promise.all(Array.from({ length: concurrency }, worker));
    const counts = new Map();
    for (const [, t] of results) counts.set(t.asOf, (counts.get(t.asOf) || 0) + 1);
    const asOf = [...counts].sort((a, b) => b[1] - a[1])[0]?.[0] || null;
    const rows = results.filter(([, t]) => t.asOf === asOf).map(([s, t]) => toRow(s, t)).sort((a, b) => a[0].localeCompare(b[0]));
    return { asOf, builtAt: now, symbols: symbols.length, failed, stale: results.length - rows.length, columns: COLUMNS, rows };
}

async function load() {
    const doc = await Snapshot.findById('latest').lean();
    current = doc && doc.rows ? index(doc) : null;
    loaded = true;
    return current;
}

// A run where Yahoo refused most symbols keeps yesterday's snapshot instead.
async function save(doc) {
    if (!doc.rows.length || doc.failed > doc.symbols / 2) return false;
    await Snapshot.replaceOne({ _id: 'latest' }, { _id: 'latest', ...doc }, { upsert: true });
    current = index(doc);
    return true;
}

function due(now, snap) {
    if (!snap) return true;
    const day = now.getUTCDay();
    if (day === 0 || day === 6 || now.getUTCHours() < BUILD_HOUR_UTC) return false;
    return now - snap.builtAt > REBUILD_AFTER_MS;
}

function screenSymbols() {
    return require('./public-stock-index').view().securities.filter((s) => s.screenable).map((s) => s.symbol);
}

function start({ symbols = screenSymbols } = {}) {
    if (String(process.env.TECHNICALS_SNAPSHOT || '1') === '0') { console.log('[technicals] disabled via TECHNICALS_SNAPSHOT=0'); return; }
    const tick = async () => {
        if (building) return;
        try {
            if (!loaded) await load();
            if (!due(new Date(), current)) return;
            building = true;
            const t0 = Date.now(), doc = await build({ symbols: symbols() });
            const saved = await save(doc);
            console.log('[technicals] snapshot', JSON.stringify({ asOf: doc.asOf, rows: doc.rows.length, failed: doc.failed, stale: doc.stale, saved, minutes: Math.round((Date.now() - t0) / 60000) }));
        } catch (e) {
            console.error('[technicals] snapshot failed', e.message);
        } finally { building = false; }
    };
    load().catch((e) => console.error('[technicals] load failed', e.message)); // the first tick retries
    setTimeout(tick, 240 * 1000); // after the digest (120s) and scheduled-email (180s) boot runs
    setInterval(tick, 3600 * 1000);
    console.log('[technicals] snapshot scheduled after each US close');
}

module.exports = {
    COLUMNS, build, load, save, due, start, index,
    view: () => current,
    get: (symbol) => (current ? current.bySymbol.get(String(symbol || '').toUpperCase()) || null : null),
    __set(doc) { current = doc ? index(doc) : null; loaded = true; }
};
