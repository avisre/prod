// Optional bulk-data path for SEC XBRL company facts. The per-ticker companyfacts
// API (data.sec.gov/api/xbrl/companyfacts/CIK….json) is what backfillStatements
// calls to extend history; under load those calls are the throttle-prone part.
// SEC publishes the SAME data as one nightly ~1GB zip — companyfacts.zip — with
// one CIK….json per company. With a persistent disk we download it once a night
// and read entries on demand (random-access via the zip's central directory — no
// 15GB unzip), so the backfill makes ZERO live SEC calls.
//
// Entirely OPT-IN: inert unless SEC_BULK_DIR points at a writable disk. When off
// (local dev, no disk), factsForCik() returns null and callers fall back to the
// live (now globally throttled) API — i.e. no behaviour change.
// URL verified Jun-2026: https://www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip

const fs = require('fs');
const path = require('path');
const axios = require('axios');
const yauzl = require('yauzl');

const SEC_HEADERS = { 'User-Agent': 'stockportfolio.pro contact@stockportfolio.pro', Accept: 'application/zip,application/json', 'Accept-Encoding': 'gzip, deflate' };
const BULK_DIR = process.env.SEC_BULK_DIR || null;
const ZIP_PATH = BULK_DIR ? path.join(BULK_DIR, 'companyfacts.zip') : null;
const BULK_URL = process.env.SEC_BULK_URL || 'https://www.sec.gov/Archives/edgar/daily-index/xbrl/companyfacts.zip';
const MAX_AGE_MS = 36 * 60 * 60 * 1000; // treat the zip as stale after 36h

function enabled() { return !!ZIP_PATH; }
function isFresh() { try { return enabled() && (Date.now() - fs.statSync(ZIP_PATH).mtimeMs) < MAX_AGE_MS; } catch (_) { return false; } }

// Open the zip once, index the central directory (name → entry), keep it open.
let _idx = null;
function openZip() { return new Promise((res, rej) => yauzl.open(ZIP_PATH, { lazyEntries: true, autoClose: false }, (e, zf) => (e ? rej(e) : res(zf)))); }
async function index() {
    if (_idx && _idx.path === ZIP_PATH) return _idx;
    const zf = await openZip();
    const entries = new Map();
    await new Promise((res, rej) => {
        zf.on('entry', (en) => { entries.set(en.fileName, en); zf.readEntry(); });
        zf.on('end', res); zf.on('error', rej); zf.readEntry();
    });
    _idx = { zf, entries, path: ZIP_PATH };
    return _idx;
}
function readJson(zf, entry) {
    return new Promise((res, rej) => {
        zf.openReadStream(entry, (e, rs) => {
            if (e) return rej(e);
            const cs = [];
            rs.on('data', (c) => cs.push(c));
            rs.on('end', () => { try { res(JSON.parse(Buffer.concat(cs).toString('utf8'))); } catch (err) { rej(err); } });
            rs.on('error', rej);
        });
    });
}

// facts['us-gaap'] for a 10-digit padded CIK, or null when bulk is unavailable.
async function factsForCik(cik) {
    if (!isFresh() || !cik) return null;
    try {
        const { zf, entries } = await index();
        const entry = entries.get(`CIK${cik}.json`) || entries.get(`CIK${String(cik).replace(/^0+/, '')}.json`);
        if (!entry) return null;
        const json = await readJson(zf, entry);
        return (json && json.facts && json.facts['us-gaap']) || null;
    } catch (_) { return null; }
}

// Download the nightly bulk zip to disk (streamed, atomic rename). One request —
// counts as a single SEC call against the global throttle.
async function refresh() {
    if (!enabled()) return { skipped: 'SEC_BULK_DIR not set' };
    try {
        fs.mkdirSync(BULK_DIR, { recursive: true });
        const tmp = ZIP_PATH + '.tmp';
        const resp = await axios.get(BULK_URL, { headers: SEC_HEADERS, responseType: 'stream', timeout: 900000, maxContentLength: Infinity, maxBodyLength: Infinity });
        await new Promise((res, rej) => { const w = fs.createWriteStream(tmp); resp.data.pipe(w); w.on('finish', res); w.on('error', rej); resp.data.on('error', rej); });
        if (_idx && _idx.zf) { try { _idx.zf.close(); } catch (_) {} _idx = null; }
        fs.renameSync(tmp, ZIP_PATH);
        return { ok: true, bytes: fs.statSync(ZIP_PATH).size };
    } catch (e) { return { error: (e && e.message) || 'download failed' }; }
}

function start({ intervalMs = 24 * 60 * 60 * 1000, initialDelayMs = 90 * 1000 } = {}) {
    if (!enabled()) { console.log('[companyfacts-bulk] disabled (SEC_BULK_DIR not set) — backfill uses the live throttled API'); return; }
    const run = () => { if (!isFresh()) refresh().then((r) => console.log('[companyfacts-bulk] refresh', JSON.stringify(r))).catch(() => {}); };
    setTimeout(run, initialDelayMs);
    setInterval(run, intervalMs);
    console.log('[companyfacts-bulk] enabled at', ZIP_PATH);
}

module.exports = { factsForCik, refresh, start, enabled, isFresh };
