'use strict';

// Read-only feasibility probe: can this server fetch a whole-universe price
// snapshot from Yahoo in one pass? It writes nothing — no file, no database —
// and keeps only the last summary in memory. One run at a time.
const fs = require('fs');
const path = require('path');

const yahooSymbol = (symbol) => String(symbol || '').trim().toUpperCase().replace(/\./g, '-').replace(/[^A-Z0-9-]/g, '');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const mb = (bytes) => Number((bytes / 1048576).toFixed(1));

function listedSymbols(file = path.join(__dirname, '..', 'frontend', 'data', 'us-companies.json')) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return [...new Set((parsed.companies || []).map((row) => yahooSymbol(row.symbol)).filter(Boolean))];
}

function defaultQuote() {
    const YahooFinance = require('yahoo-finance2').default;
    const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });
    return (symbols) => yf.quote(symbols);
}

async function run({ symbols = listedSymbols(), quote = defaultQuote(), batch = 50, delayMs = 250, now = () => Date.now() } = {}) {
    const startedAt = new Date(now()).toISOString();
    const rssBefore = process.memoryUsage().rss;
    let rssPeak = rssBefore;
    const started = now();
    const latencies = [];
    const errors = {};
    const dates = {};
    let priced = 0, noPrice = 0, noMarketCap = 0, batchFailures = 0, bytes = 0;
    for (let i = 0; i < symbols.length; i += batch) {
        const chunk = symbols.slice(i, i + batch);
        const at = now();
        try {
            const result = await quote(chunk);
            const byKey = new Map();
            for (const row of (Array.isArray(result) ? result : [result])) if (row) byKey.set(yahooSymbol(row.symbol), row);
            for (const symbol of chunk) {
                const row = byKey.get(symbol);
                const price = Number(row && row.regularMarketPrice);
                if (!(price > 0) || !row.regularMarketTime) { noPrice += 1; continue; }
                priced += 1;
                if (!(Number(row.marketCap) > 0)) noMarketCap += 1;
                const day = new Date(row.regularMarketTime).toISOString().slice(0, 10);
                dates[day] = (dates[day] || 0) + 1;
                bytes += 160;
            }
        } catch (error) {
            // No per-symbol retry here: the question is whether Yahoo serves this
            // address, and a retry loop would hide a throttle behind a slow pass.
            batchFailures += 1;
            noPrice += chunk.length;
            const key = String(error && (error.code || error.name || error.message) || 'error').slice(0, 80);
            errors[key] = (errors[key] || 0) + 1;
        }
        latencies.push(now() - at);
        rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
        if (delayMs && i + batch < symbols.length) await sleep(delayMs);
    }
    latencies.sort((a, b) => a - b);
    const newest = Object.keys(dates).sort().pop() || null;
    return {
        startedAt,
        seconds: Number(((now() - started) / 1000).toFixed(1)),
        symbols: symbols.length,
        priced,
        noPrice,
        noMarketCap,
        pricedPercent: symbols.length ? Number((priced / symbols.length * 100).toFixed(2)) : 0,
        batches: latencies.length,
        batchFailures,
        errors,
        batchLatencyMs: { median: latencies[latencies.length >> 1] || 0, p95: latencies[Math.floor(latencies.length * 0.95)] || 0, max: latencies[latencies.length - 1] || 0 },
        newestTradingDate: newest,
        onNewestTradingDate: newest ? dates[newest] : 0,
        approxSnapshotKB: Math.round(bytes / 1024),
        rssMB: { before: mb(rssBefore), peak: mb(rssPeak), after: mb(process.memoryUsage().rss) },
        liveLookupsDisabled: process.env.SEC_COVERAGE_DISABLE_ON_DEMAND === '1' || process.env.SEC_COVERAGE_READ_ONLY === '1'
    };
}

let running = null;
let last = null;
function start(options) {
    if (!running) {
        running = run(options).then((summary) => { last = summary; }, (error) => { last = { failed: String(error && error.message || error).slice(0, 200) }; })
            .finally(() => { running = null; });
    }
    return status();
}
function status() { return { running: !!running, last }; }

module.exports = { run, start, status, listedSymbols, yahooSymbol };
