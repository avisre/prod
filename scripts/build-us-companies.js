#!/usr/bin/env node
/**
 * build-us-companies.js
 *
 * Builds frontend/data/us-companies.json — the full universe of US-listed
 * SEC registrants (~10,400) — from the SEC's free company_tickers.json.
 * The file is ordered by market cap (the SEC keeps it that way), which
 * makes prefix search ranking sensible for free.
 *
 * Where a company is in our S&P 1500 list we keep that curated name and
 * sector; otherwise the SEC title is lightly title-cased.
 *
 * Usage: node scripts/build-us-companies.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'frontend', 'data', 'us-companies.json');
const SP1500 = path.join(ROOT, 'frontend', 'data', 'sp1500-companies.json');

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'stockportfolio.pro admin@stockportfolio.pro' } }, (res) => {
            if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode}`)); return; }
            let body = '';
            res.on('data', (c) => { body += c; });
            res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        }).on('error', reject);
    });
}

// "NVIDIA CORP" → "Nvidia Corp"; keeps known all-caps tickers/initialisms intact
function prettyName(title) {
    return String(title || '').replace(/\w[\w'’.&-]*/g, (w) => {
        if (/^[A-Z]{1,3}$/.test(w) || /\d/.test(w)) return w; // "AT", "3M", "II"
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
    });
}

(async () => {
    // exchange-listed only: OTC/unlisted rows are mostly foreign ordinaries
    // and shells — out of scope (we focus on US exchange-traded stocks)
    const sec = await fetchJson('https://www.sec.gov/files/company_tickers_exchange.json');
    const KEEP = new Set(['Nasdaq', 'NYSE', 'CBOE']);
    let curated = new Map();
    try {
        const sp = JSON.parse(fs.readFileSync(SP1500, 'utf8'));
        curated = new Map((sp.companies || []).map((c) => [c.symbol, c]));
    } catch (_) { /* sp1500 list optional */ }

    const seen = new Set();
    const companies = [];
    for (const [cik, title, ticker, exchange] of sec.data || []) {
        if (!KEEP.has(exchange)) continue;
        const symbol = String(ticker || '').toUpperCase().trim();
        if (!symbol || seen.has(symbol) || !/^[A-Z0-9.\-]{1,10}$/.test(symbol)) continue;
        seen.add(symbol);
        const cur = curated.get(symbol);
        companies.push({
            symbol,
            name: cur ? cur.name : prettyName(title),
            cik,
            ...(cur && cur.sector ? { sector: cur.sector } : {})
        });
    }

    const payload = {
        generatedAt: new Date().toISOString(),
        source: 'SEC company_tickers_exchange.json, Nasdaq/NYSE/CBOE only (+ curated S&P 1500 names/sectors)',
        count: companies.length,
        companies
    };
    fs.writeFileSync(OUT, JSON.stringify(payload));
    console.log(`wrote ${OUT}: ${companies.length} exchange-listed companies (${[...curated.keys()].filter((s) => seen.has(s)).length} with curated names)`);
})().catch((e) => { console.error('fatal:', e.message); process.exit(1); });
