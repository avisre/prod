'use strict';

// Shared EDGAR plumbing for fund lookups: ticker → filer/series/class, the
// latest filing of a given type, and that filing's XML instance. Used by
// fund-holdings.js (Form N-PORT) and fund-fees.js (prospectus fee tables),
// which would otherwise each carry their own copy of the SEC ticker map.

const axios = require('axios');
const mongoose = require('mongoose');
const secSource = require('./sec-source');
require('./sec-throttle'); // global ≤8/sec limiter for every *.sec.gov call

const SEC_HEADERS = secSource.SEC_HEADERS;
const SERIES_MAP_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_DOC_BYTES = 60e6;
const MAX_INSTANCE_BYTES = 30e6;

// readyState is checked, not just try/catch: an unconnected mongoose buffers
// the operation and rejects ~10s later, which would add that delay to every
// request in a worker that has no database.
function collection(name) {
    try {
        if (mongoose.connection.readyState !== 1) return null;
        return mongoose.connection.collection(name);
    } catch (_) { return null; }
}

function tickerKey(symbol) {
    return String(symbol || '').toUpperCase().trim().replace(/[^A-Z0-9.\-]/g, '');
}

// ---------------------------------------------------------------------------
// Ticker → filer resolution
//
// The two SEC ticker files are complementary, and neither alone is enough:
// company_tickers_mf.json indexes registered investment-company *series and
// classes* (IVV, VOO, VTSAX — but not SPY or QQQ), while company_tickers.json
// indexes filers by CIK (SPY, QQQ, DIA, MDY, GLD — but not IVV or VOO, which
// have no CIK of their own). Verified 2026-09-07.
// ---------------------------------------------------------------------------
let _seriesMap = null;

async function loadSeriesMap() {
    if (_seriesMap && Object.keys(_seriesMap).length) return _seriesMap;

    let staleFallback = null;
    try {
        const col = collection('sec_fund_series_map');
        if (col) {
            const doc = await col.findOne({ _id: 'company_tickers_mf' });
            if (doc && doc.map && Object.keys(doc.map).length) {
                if (Date.now() - new Date(doc.at || 0).getTime() < SERIES_MAP_TTL_MS) { _seriesMap = doc.map; return _seriesMap; }
                staleFallback = doc.map;
            }
        }
    } catch (_) { /* best-effort */ }

    for (let i = 0; i < 3; i++) {
        try {
            const r = await axios.get('https://www.sec.gov/files/company_tickers_mf.json', { headers: SEC_HEADERS, timeout: 20000 });
            const rows = (r.data && r.data.data) || [];
            const out = {};
            for (const row of rows) {
                // fields: ["cik","seriesId","classId","symbol"]
                const symbol = tickerKey(row && row[3]);
                if (!symbol || out[symbol]) continue;
                out[symbol] = { cik: String(row[0]).padStart(10, '0'), seriesId: String(row[1] || ''), classId: String(row[2] || '') };
            }
            // Never cache an empty map: a single SEC 429 would otherwise poison
            // the lookup for the life of the process (the failure mode that hit
            // sec-source's equity map).
            if (Object.keys(out).length) {
                _seriesMap = out;
                try {
                    const col = collection('sec_fund_series_map');
                    if (col) await col.updateOne({ _id: 'company_tickers_mf' }, { $set: { map: out, at: new Date() } }, { upsert: true });
                } catch (_) { /* cache best-effort */ }
                return _seriesMap;
            }
        } catch (_) { /* transient — retry */ }
        await new Promise((res) => setTimeout(res, 800 * (i + 1)));
    }

    if (staleFallback) { _seriesMap = staleFallback; return _seriesMap; }
    return {};
}

async function resolveFund(symbol) {
    const key = tickerKey(symbol);
    if (!key) return null;
    const series = (await loadSeriesMap())[key];
    if (series && series.seriesId) return { cik: series.cik, seriesId: series.seriesId, classId: series.classId || '' };
    // UITs and grantor trusts (SPY, QQQ, DIA) file under their own CIK with no
    // series, so they resolve through the plain filer index instead.
    const cik = await secSource.cikFor(key).catch(() => null);
    if (cik) return { cik: String(cik).padStart(10, '0'), seriesId: '', classId: '' };
    return null;
}

// browse-edgar accepts a series id in the CIK parameter, which is the only way
// to get filings for one series of a multi-series trust (Vanguard files dozens
// of funds under a single CIK).
async function recentFilings(filer, type, count = 4) {
    const cik = filer.seriesId || filer.cik;
    const url = 'https://www.sec.gov/cgi-bin/browse-edgar' +
        `?action=getcompany&CIK=${encodeURIComponent(cik)}&type=${encodeURIComponent(type)}&dateb=&owner=include&count=${count}&output=atom`;
    const r = await axios.get(url, { headers: SEC_HEADERS, timeout: 20000, responseType: 'text', transformResponse: [(d) => d] });
    const xml = String(r.data || '');
    const out = [];
    const seen = new Set();
    for (const entry of xml.split('<entry>').slice(1)) {
        const href = (/<filing-href>([^<]+)</.exec(entry) || [])[1];
        const filedAt = (/<filing-date>([^<]+)</.exec(entry) || [])[1] || null;
        if (!href) continue;
        // .../Archives/edgar/data/1100663/000207169126019760/0002071691-26-019760-index.htm
        const m = /\/edgar\/data\/(\d+)\/(\d{18})\//.exec(href);
        // The atom feed lists each filing twice (once per index format), so
        // dedupe on the accession or a caller retrying "the next filing" gets
        // the same one back.
        if (!m || seen.has(m[2])) continue;
        seen.add(m[2]);
        out.push({ cik: m[1], accession: m[2], filedAt, indexUrl: href, base: `https://www.sec.gov/Archives/edgar/data/${m[1]}/${m[2]}` });
    }
    return out;
}

async function latestFiling(filer, type, count = 4) {
    const filings = await recentFilings(filer, type, count);
    return filings[0] || null;
}

function fetchText(url, timeout = 45000) {
    return axios.get(url, { headers: SEC_HEADERS, timeout, responseType: 'text', maxContentLength: MAX_DOC_BYTES, transformResponse: [(d) => d] });
}

// The XBRL instance in a filing directory, skipping the linkbases (_cal, _def,
// _lab, _pre), the rendered R-files and the summaries — none of which carry
// facts.
async function filingInstance(filing, { prefer = null } = {}) {
    if (prefer) {
        try {
            const r = await fetchText(`${filing.base}/${prefer}`);
            const body = String(r.data || '');
            if (body.includes('<')) return { xml: body, url: `${filing.base}/${prefer}` };
        } catch (_) { /* fall through to the index */ }
    }
    const idx = await axios.get(`${filing.base}/index.json`, { headers: SEC_HEADERS, timeout: 20000 });
    const items = ((idx.data || {}).directory || {}).item || [];
    const candidates = items
        .filter((it) => /\.xml$/i.test(it.name) && !/^R\d|_cal\.|_def\.|_lab\.|_pre\.|FilingSummary|MetaLinks/i.test(it.name))
        // A trust-wide prospectus instance runs to ~10MB; anything far past
        // that is not worth pulling over the wire on a page request.
        .filter((it) => (Number(it.size) || 0) <= MAX_INSTANCE_BYTES);
    if (!candidates.length) return null;
    // Largest instance first: a filing directory can hold small side documents
    // alongside the real one.
    candidates.sort((a, b) => (Number(b.size) || 0) - (Number(a.size) || 0));
    const r = await fetchText(`${filing.base}/${candidates[0].name}`, 90000);
    return { xml: String(r.data || ''), url: `${filing.base}/${candidates[0].name}` };
}

// ---------------------------------------------------------------------------
// Shared cache for the EDGAR-backed modules.
//
// Three production problems this exists to solve, all measured 2026-09-07:
//
//  1. MEMORY. A count-bounded LRU is the wrong shape here because entries are
//     wildly different sizes: BND's portfolio is 17,409 rows and 9.1MB of heap,
//     so a 40-entry cap allowed 362MB — an OOM on a small instance. This bounds
//     by BYTES.
//  2. THUNDERING HERD. A cold fund takes 2-8s and several EDGAR requests. With
//     no in-flight tracking, N concurrent viewers each started their own fetch
//     chain, multiplying load against the ≤8/sec throttle the whole app shares.
//     Callers now join the request already running.
//  3. NEGATIVE RESULTS. A fund that legitimately has no filing (GLD, IBIT —
//     grantor trusts) returned null and cached nothing, so EVERY page view spent
//     another EDGAR round trip re-learning the same "no". Misses are cached too,
//     for a shorter time, since a fund can start filing.
//
// A failure is not a miss: transient errors are never cached, or one SEC 429
// would pin a fund to "unavailable" for the whole TTL.
function createCache({ maxBytes, ttlMs, missTtlMs }) {
    const mem = new Map();       // key -> { at, value, bytes }
    const inflight = new Map();  // key -> Promise
    let bytes = 0;

    const drop = (key) => {
        const hit = mem.get(key);
        if (hit) { bytes -= hit.bytes; mem.delete(key); }
    };
    const fresh = (hit) => Date.now() - hit.at < (hit.value === null ? missTtlMs : ttlMs);

    function get(key) {
        const hit = mem.get(key);
        if (!hit) return undefined;
        if (!fresh(hit)) { drop(key); return undefined; }
        mem.delete(key); mem.set(key, hit); // LRU re-insert
        return hit.value;
    }

    function set(key, value) {
        drop(key);
        // A null costs nothing to hold; sizing it is what the miss TTL is for.
        const size = value === null ? 64 : Buffer.byteLength(JSON.stringify(value));
        mem.set(key, { at: Date.now(), value, bytes: size });
        bytes += size;
        while (bytes > maxBytes && mem.size > 1) drop(mem.keys().next().value);
        return value;
    }

    // Single-flight: concurrent callers for the same key share one loader run.
    async function remember(key, loader) {
        const cached = get(key);
        if (cached !== undefined) return cached;
        const running = inflight.get(key);
        if (running) return running;
        const task = (async () => {
            try {
                return set(key, await loader());
            } catch (error) {
                throw error;                    // never cache a transient failure
            } finally {
                inflight.delete(key);
            }
        })();
        inflight.set(key, task);
        return task;
    }

    return { get, set, remember, stats: () => ({ entries: mem.size, bytes }) };
}

// Mongo rejects any document over 16MB. BND serialises to 3.6MB, so the ceiling
// is around 77,000 holdings — reachable by a big bond index. The write was
// inside a best-effort try/catch, so crossing it would have failed silently and
// quietly disabled caching for that fund forever.
const MAX_DOC_BYTES_MONGO = 15 * 1024 * 1024;

async function cacheToMongo(name, id, value) {
    const col = collection(name);
    if (!col) return;
    const size = Buffer.byteLength(JSON.stringify(value));
    if (size > MAX_DOC_BYTES_MONGO) {
        console.warn(`[sec-fund] ${name}/${id} is ${(size / 1048576).toFixed(1)}MB — over the 16MB document limit, serving from memory only`);
        return;
    }
    try {
        await col.updateOne({ _id: id }, { $set: { value, at: new Date() } }, { upsert: true });
    } catch (error) {
        console.warn(`[sec-fund] ${name}/${id} cache write failed: ${String(error && error.message).slice(0, 120)}`);
    }
}

// Without this the collections grow one document per fund ever viewed and never
// shrink. Created once per process, best-effort.
const _ttlDone = new Set();
async function ensureTtl(name, seconds) {
    if (_ttlDone.has(name)) return;
    _ttlDone.add(name);
    const col = collection(name);
    if (!col) { _ttlDone.delete(name); return; }
    try { await col.createIndex({ at: 1 }, { expireAfterSeconds: seconds, name: `${name}_ttl` }); }
    catch (_) { /* an existing index with different options is fine */ }
}

module.exports = { SEC_HEADERS, collection, tickerKey, loadSeriesMap, resolveFund, recentFilings, latestFiling, filingInstance, fetchText, createCache, cacheToMongo, ensureTtl };
