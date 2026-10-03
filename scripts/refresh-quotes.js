#!/usr/bin/env node
/**
 * refresh-quotes.js
 *
 * Writes frontend/data/quotes.json — a small, price-only snapshot that is the
 * fallback layer behind backend/quote-store.js. Live quotes still come from
 * Yahoo per request; this file exists so crawlers, cold renders and Yahoo
 * outages see a price that is at most a session old instead of whatever the
 * weekly fundamentals bundle last happened to contain (mid/small caps were
 * three months stale when this split landed).
 *
 * Deliberately separate from refresh-fundamentals.js:
 *   - one batched quote call per ~50 symbols, no SEC pulls, no statements;
 *   - cheap enough to run daily over the whole S&P 1500 (the fundamentals job
 *     stays weekly and S&P 500 only);
 *   - merges into the previous file, so a failed symbol keeps its last good
 *     price instead of disappearing.
 *
 * Usage:
 *   node scripts/refresh-quotes.js [symbol-list.json ...]
 *
 * Env vars:
 *   MAX_SYMBOLS=100   Cap symbols processed (0 = no cap)
 *   BATCH=50          Symbols per Yahoo quote call (max 100)
 *   DRY_RUN=1         Print the summary without writing the file
 */

'use strict';

const fs = require('fs');
const path = require('path');
const YahooFinance = require('yahoo-finance2').default;
const yf = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });

const ROOT = path.resolve(__dirname, '..');
const OUT_FILE = path.join(ROOT, 'frontend', 'data', 'quotes.json');
const DEFAULT_LIST = path.join(ROOT, 'frontend', 'data', 'us-companies.json');
const BATCH = Math.max(1, Math.min(100, Number(process.env.BATCH || 50)));
const MAX_SYMBOLS = Math.max(0, Number(process.env.MAX_SYMBOLS || 0));
const DRY_RUN = String(process.env.DRY_RUN || '') === '1';
const DELAY_MS = Math.max(0, Number(process.env.BATCH_DELAY_MS || 250));

function yahooSymbol(symbol) {
    return String(symbol || '').trim().toUpperCase().replace(/\./g, '-').replace(/[^A-Z0-9-]/g, '');
}

function symbolsFromFile(file) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const rows = Array.isArray(parsed) ? parsed
        : Array.isArray(parsed && parsed.companies) ? parsed.companies
            : [];
    return rows.map((row) => (typeof row === 'string' ? row : row && row.symbol)).filter(Boolean);
}

function toRow(quote) {
    const price = Number(quote && quote.regularMarketPrice);
    if (!Number.isFinite(price) || price <= 0) return null;
    const prev = Number(quote.regularMarketPreviousClose);
    const change = Number(quote.regularMarketChangePercent);
    const time = quote.regularMarketTime;
    const asOf = time ? new Date(time).toISOString().slice(0, 10) : new Date().toISOString().slice(0, 10);
    return {
        price,
        previousClose: Number.isFinite(prev) ? prev : null,
        changePercent: Number.isFinite(change) ? change : null,
        // Price-derived fields ride along so pages do not fill these from the
        // weekly fundamentals blob, which is what made mid-cap market caps and
        // P/Es 25-44% off until 2026-09-28.
        marketCap: Number.isFinite(Number(quote.marketCap)) ? Number(quote.marketCap) : null,
        trailingPE: Number.isFinite(Number(quote.trailingPE)) ? Number(quote.trailingPE) : null,
        fiftyTwoWeekHigh: Number.isFinite(Number(quote.fiftyTwoWeekHigh)) ? Number(quote.fiftyTwoWeekHigh) : null,
        fiftyTwoWeekLow: Number.isFinite(Number(quote.fiftyTwoWeekLow)) ? Number(quote.fiftyTwoWeekLow) : null,
        sharesOutstanding: Number.isFinite(Number(quote.sharesOutstanding)) ? Number(quote.sharesOutstanding) : null,
        asOf,
        fetchedAt: new Date().toISOString(),
        currency: quote.currency || 'USD'
    };
}

async function fetchBatch(symbols) {
    const out = new Map();
    try {
        const result = await yf.quote(symbols.map(yahooSymbol));
        for (const quote of (Array.isArray(result) ? result : [result])) {
            const key = yahooSymbol(quote && quote.symbol);
            if (key) out.set(key, quote);
        }
    } catch (error) {
        // One poisoned symbol can fail the whole batch on strict validation.
        // Fall back to single lookups so the rest of the batch still lands.
        console.error(`[quotes] batch of ${symbols.length} failed (${error.message}); retrying individually`);
        for (const symbol of symbols) {
            try {
                const result = await yf.quote(yahooSymbol(symbol));
                const quote = Array.isArray(result) ? result[0] : result;
                const key = yahooSymbol(quote && quote.symbol);
                if (key) out.set(key, quote);
            } catch (_) { /* symbol stays on its previous price */ }
            if (DELAY_MS) await new Promise((r) => setTimeout(r, DELAY_MS));
        }
    }
    return out;
}

async function main() {
    const listPaths = process.argv.slice(2).length ? process.argv.slice(2) : [DEFAULT_LIST];
    const symbols = [];
    for (const listPath of listPaths) {
        for (const symbol of symbolsFromFile(path.resolve(listPath))) {
            const key = yahooSymbol(symbol);
            if (key && !symbols.includes(key)) symbols.push(key);
        }
    }
    const limited = MAX_SYMBOLS ? symbols.slice(0, MAX_SYMBOLS) : symbols;
    if (!limited.length) throw new Error('no symbols to refresh');

    let next = {};
    try {
        const prior = JSON.parse(fs.readFileSync(OUT_FILE, 'utf8'));
        if (prior && typeof prior === 'object' && !Array.isArray(prior)) next = prior;
    } catch (_) { /* first run */ }
    const priorCount = Object.keys(next).filter((k) => k !== '_meta').length;

    let updated = 0;
    let failed = 0;
    for (let i = 0; i < limited.length; i += BATCH) {
        const chunk = limited.slice(i, i + BATCH);
        const quotes = await fetchBatch(chunk);
        for (const symbol of chunk) {
            const row = toRow(quotes.get(symbol));
            if (row) { next[symbol] = row; updated += 1; } else { failed += 1; }
        }
        process.stderr.write(`\r[quotes] ${Math.min(i + BATCH, limited.length)}/${limited.length} updated=${updated} failed=${failed}`);
        if (DELAY_MS && i + BATCH < limited.length) await new Promise((r) => setTimeout(r, DELAY_MS));
    }

    next._meta = {
        generatedAt: new Date().toISOString(),
        updated,
        requested: limited.length,
        failed,
        total: Object.keys(next).filter((k) => k !== '_meta').length,
        source: 'yahoo-finance2 quote'
    };

    if (DRY_RUN) {
        console.log(`\n[quotes] dry run: ${JSON.stringify(next._meta)}`);
        return;
    }

    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    const tmp = `${OUT_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next));
    fs.renameSync(tmp, OUT_FILE);
    console.log(`\n[quotes] wrote ${OUT_FILE} (${priorCount} prior → ${next._meta.total} rows): ${JSON.stringify(next._meta)}`);
}

main().catch((error) => {
    console.error('[quotes] failed:', error.message);
    process.exit(1);
});
