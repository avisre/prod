'use strict';
// Public financial evidence only. A capped Mongo collection enforces the disk
// bound across processes; application checks enforce the memory and BSON bounds.
//
// BANDWIDTH: this cache was the largest attributable slice of the Render bill.
// Two things made it expensive, and both are fixed here.
//
//  1. Every check rewrote the whole ~2.9 MB document. `sec-reporting.js` stamps
//     `lastSuccessfulCheckAt`/`lastAttemptAt` with `new Date()` on every fetch,
//     so the stored value changed even when not one financial fact had. The
//     value is therefore split: the evidence (facts, filings, observations,
//     profile) is written only when it actually changes, and the handful of
//     volatile bookkeeping fields are written to a separate small document on
//     every check. `get()` merges them back, so readers see the same shape.
//  2. The document was stored as raw JSON. Financial grids are numeric and
//     compress extremely well, so the evidence is deflated before it is stored
//     and inflated on read. A document stored without `codec` is still read as
//     plain JSON, so this is backward compatible with what is already there.
//
// ATTRIBUTION: usage-context carries a per-request store, so the bytes a miss
// or a write moves land on the request that caused them (or on `system:*` for
// boot work) instead of being unattributable.
const zlib = require('node:zlib');
const usageContext = require('./usage-context');
const { digest } = require('./sec-coverage');

// 512 MB starter instance with a documented OOM history: 32 MB is a deliberate,
// env-overridable step rather than a guess. The full working set is ~62 MB.
const MAX_MEMORY_MB = Math.max(8, Math.min(128, Number(process.env.FINANCIAL_CACHE_MEMORY_MB) || 32));
const MAX_MEMORY = MAX_MEMORY_MB * 1024 * 1024;
const MAX_PERSISTENT = 64 * 1024 * 1024;

// Fields whose only purpose is to record *when* a check ran. They change on
// every successful check and carry no financial information, so they are kept
// out of the evidence digest.
const VOLATILE_TOP = ['attempts', 'lastAttemptAt', 'attemptedFields', 'attemptedPeriods', 'financialAttemptResult', 'lastAttemptResult', 'providerLastSuccessfulCheckAt', 'persistence'];
const VOLATILE_REPORTING = ['lastSuccessfulCheckAt', 'lastAttemptAt', 'lastAttemptResult', 'lastErrorCode', 'lastFinancialCheckAt', 'lastFinancialAttemptAt', 'lastFinancialResult'];

function split(value) {
    if (!value || typeof value !== 'object') return { heavy: value, meta: null };
    const heavy = { ...value };
    const meta = {};
    let any = false;
    for (const k of VOLATILE_TOP) if (heavy[k] !== undefined) { meta[k] = heavy[k]; delete heavy[k]; any = true; }
    if (heavy.reporting && typeof heavy.reporting === 'object') {
        const reporting = { ...heavy.reporting };
        const volatileReporting = {};
        for (const k of VOLATILE_REPORTING) if (reporting[k] !== undefined) { volatileReporting[k] = reporting[k]; delete reporting[k]; }
        heavy.reporting = reporting;
        if (Object.keys(volatileReporting).length) { meta.reporting = volatileReporting; any = true; }
    }
    return { heavy, meta: any ? meta : null };
}

function merge(heavy, meta) {
    if (!meta) return heavy;
    const out = { ...heavy, ...meta };
    if (meta.reporting && typeof meta.reporting === 'object') out.reporting = { ...(heavy && heavy.reporting), ...meta.reporting };
    return out;
}

// BSON-ish size of one stored row. JSON.stringify on a Buffer explodes into an
// array of byte numbers thousands of times larger than the wire form, so a
// Buffer is measured as itself.
function docBytes(row) {
    if (!row) return 0;
    let n = 5;
    for (const [k, v] of Object.entries(row)) {
        if (k === '_id') { n += 12; continue; }
        if (Buffer.isBuffer(v)) { n += v.length + 5; continue; }
        if (v && typeof v === 'object') { n += (k.length + 2) + Buffer.byteLength(JSON.stringify(v) || ''); continue; }
        n += (k.length + 2) + Buffer.byteLength(v == null ? '' : String(v));
    }
    return n;
}

function encode(heavy) {
    try {
        const compressed = zlib.deflateSync(Buffer.from(JSON.stringify(heavy), 'utf8'), { level: 6 });
        // Only worth it when it actually wins; a tiny object can grow.
        if (compressed.length < Buffer.byteLength(JSON.stringify(heavy))) return { codec: 'zlib', value: compressed };
    } catch (_) { /* fall through to plain JSON */ }
    return { codec: null, value: heavy };
}

// For readers that walk the collection directly (the weekly promotion) rather
// than through get(); those never see the merged bookkeeping, which is correct
// because they only consume the evidence.
function decodeRow(row) { return decode(row); }

function decode(row) {
    if (!row) return null;
    if (row.codec === 'zlib') {
        try {
            const raw = Buffer.isBuffer(row.value) ? row.value : Buffer.from(row.value && row.value.buffer ? row.value.buffer : row.value);
            return JSON.parse(zlib.inflateSync(raw).toString('utf8'));
        } catch (_) { return null; }
    }
    return row.value;
}

function createCache({ connection = () => require('mongoose').connection, maxMemory = MAX_MEMORY } = {}) {
    const entries = new Map();
    let bytes = 0, setup = null, written = 0, skipped = 0, compressed = 0;
    const persistOnce = require('./single-flight')();

    function remember(key, value) {
        const old = entries.get(key); if (old) bytes -= old.bytes; entries.delete(key);
        const size = Buffer.byteLength(JSON.stringify(value)); if (size > maxMemory) return value;
        entries.set(key, { value, bytes: size }); bytes += size;
        while (bytes > maxMemory) { const oldest = entries.keys().next().value; bytes -= entries.get(oldest).bytes; entries.delete(oldest); }
        return value;
    }

    async function collection() {
        const conn = connection(); if (conn?.readyState !== 1) return null;
        if (!setup) setup = (async () => {
            try { await conn.db.createCollection('public_financial_requests', { capped: true, size: MAX_PERSISTENT }); }
            catch (e) { if (e.code !== 48 && e.codeName !== 'NamespaceExists') throw e; }
            const info = await conn.db.listCollections({ name: 'public_financial_requests' }).next();
            if (!info?.options?.capped || info.options.size > MAX_PERSISTENT) throw new Error('FINANCIAL_CACHE_BOUND_NOT_CONFIGURED');
            const col = conn.collection('public_financial_requests');
            await col.createIndex({ issuer: 1, createdAt: -1 });
            await col.createIndex({ issuer: 1, kind: 1, createdAt: -1 });
            return col;
        })().catch((e) => { setup = null; throw e; });
        return setup;
    }

    async function get(key) {
        const hit = entries.get(key);
        if (hit) { entries.delete(key); entries.set(key, hit); usageContext.noteCacheHit(); return hit.value; }
        try {
            const col = await collection();
            if (!col) return null;
            // Documents written before the split have no `kind`; they are evidence.
            const evidence = await col.findOne({ issuer: key, kind: { $in: ['evidence', null] } }, { sort: { createdAt: -1 }, maxTimeMS: 2000 });
            if (!evidence) { usageContext.noteCacheMiss(0); return null; }
            const metaRow = await col.findOne({ issuer: key, kind: 'meta' }, { sort: { createdAt: -1 }, maxTimeMS: 2000 });
            const heavy = decode(evidence);
            if (!heavy) { usageContext.noteCacheMiss(0); return null; }
            usageContext.noteCacheMiss(docBytes(evidence) + docBytes(metaRow));
            return remember(key, merge(heavy, metaRow && metaRow.meta));
        } catch (_) { return null; }
    }

    async function set(key, value) {
        const { heavy, meta } = split(value);
        remember(key, value);
        const size = Buffer.byteLength(JSON.stringify(value));
        if (size > MAX_MEMORY) return { persisted: false, reason: 'Evidence exceeds request-cache document bound' };
        const id = digest({ key, heavy });
        return persistOnce(id, async () => {
            try {
                const col = await collection();
                if (!col) return { persisted: false, reason: 'Public financial cache is temporarily disconnected' };
                // Only the evidence is uploaded, and only when its digest is new.
                // The check below transfers a 12-byte _id, not the payload.
                let evidenceWritten = false;
                if (!(await col.findOne({ _id: id }, { projection: { _id: 1 }, maxTimeMS: 2000 }))) {
                    const stored = encode(heavy);
                    const row = { _id: id, issuer: key, kind: 'evidence', createdAt: new Date() };
                    if (stored.codec) { row.codec = stored.codec; row.value = stored.value; compressed += 1; }
                    else row.value = stored.value;
                    await col.insertOne(row);
                    evidenceWritten = true;
                    written += 1;
                    usageContext.noteCacheWrite(docBytes(row));
                } else {
                    skipped += 1;
                }
                // Bookkeeping moves every check and is a few hundred bytes, so it
                // is always refreshed — that keeps the freshness gate honest across
                // a restart without ever re-uploading the statements.
                if (meta) {
                    // One bookkeeping document per issuer, overwritten in place. It is
                    // written on every check, so inserting a new row each time would
                    // fill the capped collection and evict the evidence it annotates.
                    const metaRow = { issuer: key, kind: 'meta', meta, evidenceId: id, createdAt: new Date() };
                    await col.updateOne({ issuer: key, kind: 'meta' }, { $set: metaRow }, { upsert: true });
                    if (!evidenceWritten) usageContext.noteCacheWrite(docBytes(metaRow));
                }
                return { persisted: true };
            } catch (e) {
                if (e.code === 11000) return { persisted: true };
                return { persisted: false, reason: 'Public financial evidence persistence failed' };
            }
        });
    }

    return {
        get, set,
        stats: () => ({ entries: entries.size, bytes, maxMemory, maxPersistent: MAX_PERSISTENT, evidenceWrites: written, evidenceSkipped: skipped, compressed }),
        clear: () => { entries.clear(); bytes = 0; }
    };
}

module.exports = { createCache, MAX_MEMORY, MAX_MEMORY_MB, MAX_PERSISTENT, split, merge, docBytes, decodeRow, ...createCache() };
