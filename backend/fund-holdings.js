'use strict';

// Complete fund holdings, from SEC Form N-PORT.
//
// Why this module exists: Yahoo's quoteSummary `topHoldings` module returns a
// maximum of TEN rows for every fund — measured 2026-09-07 across SPY, VOO,
// QQQ, VTI, ARKK, VFIAX, JEPI, SCHD, IWM and VXUS, all exactly 10. So the fund
// page showed 10 of VOO's ~500 names, and the ETF-overlap tool compared two
// top-ten lists and reported the result as portfolio overlap.
//
// Why not the issuer's own file: measured the same day, iShares
// (…/1467271812596.ajax?fileType=csv&fileName=IVV_holdings) and Vanguard
// (investor.vanguard.com/…/portfolio-holding/stock) both answer HTTP 200 with
// an Akamai HTML shell instead of data. Issuer scraping is not a dependable
// source, so it is not used here.
//
// N-PORT is: every registered fund files its complete portfolio, Part C lists
// every position with a `pctVal`, and it covers mutual funds as well as ETFs.
// The cost is lag — the public copy trails ~60 days (IVV's 2026-06-30 portfolio
// was filed 2026-08-25). So this is the complete-but-dated view while Yahoo's
// ten names are the current-but-partial one, and callers label both as such.

const secFunds = require('./sec-fund-index');

const HOLDINGS_TTL_MS = 24 * 60 * 60 * 1000; // N-PORT changes monthly at most
// A fund with no filing is a fact about the fund, but not a permanent one — a
// newly launched ETF files its first N-PORT eventually. Re-check hourly.
const NO_FILING_TTL_MS = 60 * 60 * 1000;
// Bytes, not entries. BND's portfolio retains 15.4MB of heap (measured after a
// forced GC), so the old 40-entry cap allowed ~614MB — an OOM on a small dyno.
// The budget below is counted in SERIALISED bytes, and live objects cost about
// 4.3x that (BND: 3.6MB of JSON, 15.4MB retained), so 12MB here is roughly 50MB
// of heap. Big funds are rare and small ones are tiny — SCHD's 102 rows are
// ~20KB — so this still holds hundreds of ordinary funds.
const MEM_MAX_BYTES = 12 * 1024 * 1024;

const cache = secFunds.createCache({
    maxBytes: MEM_MAX_BYTES, ttlMs: HOLDINGS_TTL_MS, missTtlMs: NO_FILING_TTL_MS
});

// ---------------------------------------------------------------------------
// Part C parsing
// ---------------------------------------------------------------------------
function tag(block, name) {
    const m = new RegExp(`<${name}>([^<]*)</${name}>`).exec(block);
    return m ? m[1].trim() : '';
}
function numberOrNull(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}
function decodeEntities(value) {
    return String(value || '')
        .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
        .replace(/&amp;/g, '&');
}

function parseHoldings(xml) {
    const rows = [];
    // Non-greedy block scan rather than a real XML parse: N-PORT Part C is a
    // flat, schema-fixed repetition of <invstOrSec>, and the largest filings run
    // to tens of MB where a DOM parse would be the expensive part.
    const re = /<invstOrSec>([\s\S]*?)<\/invstOrSec>/g;
    let m;
    while ((m = re.exec(xml)) !== null) {
        const block = m[1];
        // pctVal is a percentage of net assets (IVV's 508 rows sum to 100.1);
        // every weight in this codebase is a fraction, so divide.
        const pct = numberOrNull(tag(block, 'pctVal'));
        const name = decodeEntities(tag(block, 'title') || tag(block, 'name'));
        if (!name) continue;
        const isin = (/<isin\s+value="([^"]+)"/.exec(block) || [])[1] || '';
        rows.push({
            symbol: '',
            name,
            issuer: decodeEntities(tag(block, 'name')),
            weight: pct === null ? null : pct / 100,
            valueUsd: numberOrNull(tag(block, 'valUSD')),
            units: numberOrNull(tag(block, 'balance')),
            cusip: tag(block, 'cusip').replace(/^0{9}$|^N\/A$/i, ''),
            isin,
            assetCategory: tag(block, 'assetCat'),
            currency: tag(block, 'curCd') || 'USD'
        });
    }
    // Shorts and derivatives carry negative weights; ordering by signed weight
    // puts the real long book first, which is what the page is for.
    rows.sort((a, b) => (b.weight ?? -Infinity) - (a.weight ?? -Infinity));
    return rows;
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------
// Resolves to null (never throws) when the fund has no N-PORT: commodity and
// currency grantor trusts (GLD, SLV) file 10-Ks and hold bullion, not
// securities, and newly launched funds have not filed yet. Callers fall back to
// Yahoo's ten rows.
async function fetchFundHoldings(symbol) {
    const key = secFunds.tickerKey(symbol);
    if (!key) return null;

    // remember() serves the cache, joins a fetch already in flight, and caches
    // a genuine "this fund files nothing" — but never a transient failure.
    return cache.remember(key, async () => {
        try {
            const col = secFunds.collection('fund_holdings');
            if (col) {
                secFunds.ensureTtl('fund_holdings', 7 * 24 * 3600);
                const doc = await col.findOne({ _id: key });
                if (doc && doc.value && Date.now() - new Date(doc.at || 0).getTime() < HOLDINGS_TTL_MS) return doc.value;
            }
        } catch (_) { /* best-effort */ }

        let value = null;
        try {
            const filer = await secFunds.resolveFund(key);
            if (filer) {
                const filing = await secFunds.latestFiling(filer, 'NPORT-P');
                if (filing) {
                    const doc = await secFunds.filingInstance(filing, { prefer: 'primary_doc.xml' });
                    if (doc && doc.xml) {
                        const holdings = parseHoldings(doc.xml);
                        if (holdings.length) {
                            value = {
                                symbol: key,
                                holdings,
                                count: holdings.length,
                                complete: true,
                                asOf: tag(doc.xml, 'repPdDate') || null,
                                filedAt: filing.filedAt,
                                source: 'SEC Form N-PORT',
                                sourceUrl: filing.indexUrl
                            };
                        }
                    }
                }
            }
        } catch (error) {
            // Rethrow so the cache does not record a network blip as "no filing".
            // The route catches it and falls back to the provider's top ten.
            console.error(`[nport] ${key} failed: ${(error && error.name) || 'Error'} ${String((error && error.message) || '').slice(0, 160)}`);
            throw error;
        }

        if (value) await secFunds.cacheToMongo('fund_holdings', key, value);
        return value; // null here means "filed nothing", and is cached briefly
    }).catch(() => null);
}

// N-PORT identifies positions by CUSIP/ISIN, never by ticker, so the exchange
// symbols shown in the table come from whatever rows Yahoo did return. Matching
// on a normalized name fills the top of the list and leaves the tail blank
// rather than inventing tickers.
function normalizeName(value) {
    return String(value || '').toLowerCase()
        .replace(/[.,]/g, ' ')
        .replace(/\b(inc|corp|corporation|company|co|plc|ltd|limited|the|class|cl|a|b|c|sa|nv|ag)\b/g, ' ')
        .replace(/\s+/g, ' ').trim();
}

function mergeSymbols(rows, reference) {
    const byName = new Map();
    for (const ref of reference || []) {
        if (!ref || !ref.symbol) continue;
        const norm = normalizeName(ref.name);
        if (norm) byName.set(norm, ref.symbol);
    }
    if (!byName.size) return rows;
    const match = (row) => byName.get(normalizeName(row.name)) || byName.get(normalizeName(row.issuer)) || null;

    // Share classes collapse to the same normalized name — "ALPHABET INC-A" and
    // "ALPHABET INC-C" both reduce to "alphabet", and Yahoo lists only one of
    // them — so a naive match labelled BOTH rows GOOG and got the A shares
    // wrong. A symbol is applied only where it matches exactly one row; an
    // ambiguous one is dropped, leaving the cell blank rather than misnaming a
    // holding.
    const counts = new Map();
    for (const row of rows) {
        if (row.symbol) continue;
        const hit = match(row);
        if (hit) counts.set(hit, (counts.get(hit) || 0) + 1);
    }
    return rows.map((row) => {
        if (row.symbol) return row;
        const hit = match(row);
        return hit && counts.get(hit) === 1 ? { ...row, symbol: hit } : row;
    });
}

module.exports = { fetchFundHoldings, mergeSymbols, parseHoldings, normalizeName, tickerKey: secFunds.tickerKey };
