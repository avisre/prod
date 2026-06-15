// Background dossier pre-warming. The dossier caches per (symbol, fiscal year),
// so the FIRST request for a ticker pays the full build (SEC fetches + model
// extraction); everyone after hits the warm cache. Pre-warming builds the
// most-viewed names ahead of demand so common requests are instant, while the
// long tail still builds lazily on first request — safely, because every SEC
// call is globally throttled by sec-throttle (≤8/sec, no 429).
//
// Cost note: the build cost is the model extraction, not SEC. So we warm the
// top ~300 by market cap (cheap, bounded), NOT the whole universe.

const aiChat = require('./ai-chat');
const dossier = require('./dossier');

// Top-N tickers by market cap from our covered universe.
function topTickers(n = 300) {
    try {
        const res = aiChat.screenRows({ sort_by: 'marketCapB', limit: n, maxLimit: n });
        return (res.rows || []).map((r) => r.symbol).filter(Boolean);
    } catch (_) { return []; }
}

let _running = false;
let _last = null;

// Warm the cache for the top-N. force=false means cached dossiers return
// instantly (cheap), so daily re-runs only rebuild what's missing or stale.
async function prewarm({ n = 300, concurrency = 2, force = false, onProgress = null } = {}) {
    if (_running) return { skipped: 'already running' };
    _running = true;
    const started = Date.now();
    const syms = topTickers(n);
    let built = 0, cached = 0, failed = 0, done = 0;
    const q = [...syms];
    async function worker() {
        while (q.length) {
            const sym = q.shift();
            try {
                const p = await dossier.buildDossier(sym, { force });
                if (!p || p.error) failed++; else if (p.cached) cached++; else built++;
            } catch (_) { failed++; }
            done++;
            if (onProgress && done % 25 === 0) onProgress({ done, total: syms.length, built, cached, failed });
        }
    }
    try { await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker)); }
    finally { _running = false; }
    _last = { at: new Date().toISOString(), universe: syms.length, built, cached, failed, seconds: Math.round((Date.now() - started) / 1000) };
    return _last;
}

// Scheduled warm: one run a few minutes after boot, then daily. Concurrency is
// low and SEC is throttled, so it never floods anything.
function start({ n = 300, intervalMs = 24 * 3600 * 1000, initialDelayMs = 5 * 60 * 1000, concurrency = 2 } = {}) {
    const run = () => prewarm({ n, concurrency })
        .then((r) => console.log('[prewarm]', JSON.stringify(r)))
        .catch((e) => console.log('[prewarm] error', e && e.message));
    setTimeout(run, initialDelayMs);
    setInterval(run, intervalMs);
    console.log(`[prewarm] scheduled: top ${n} tickers, every ${Math.round(intervalMs / 3600000)}h (first run in ${Math.round(initialDelayMs / 60000)}m)`);
}

function status() { return { running: _running, last: _last }; }

module.exports = { prewarm, topTickers, start, status };
