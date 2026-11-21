'use strict';

// Per-user / per-surface usage rollups.
//
// WHAT IT ANSWERS: who is using the product, on which surface (website, REST
// API, MCP connector), which routes and tools they call, which companies and
// metrics they ask for, and how many bytes their requests cost — both the
// response they received and the cache read/write their request caused. That
// last part is the reason this exists: it was ~40% of the bandwidth bill and
// completely unattributed.
//
// SHAPE: counters are accumulated in memory and flushed every minute into two
// collections.
//   usage_daily  — one row per (userKey, surface, day): scalars only, updated
//                  with $inc/$min/$max, so concurrent flushes and a restart
//                  cannot corrupt them.
//   usage_counts — one row per (userKey, surface, day, kind, key) for the
//                  dimensions (route, tool, symbol, metric), also $inc.
// Keeping the dimensions out of usage_daily is deliberate: a route name such
// as `/api/company/*` contains a dot, and Mongo forbids dots in field names,
// so a nested object of route counts cannot be $inc'd safely.
//
// PER-REQUEST ROWS: `usage_events` gets one small row per `/api/*` request and
// per MCP tool call (never for pages, assets or crawler traffic), TTL 90 days,
// for drill-down. Writes are fire-and-forget and buffered, so a DB blip can
// never slow or fail a request.
//
// BOUNDS: at most MAX_BUCKETS (userKey|surface|day) live at once and at most
// MAX_DIM per dimension per bucket; overflow is counted in `dropped`, never
// allowed to grow the heap. A single-process deployment is assumed for the
// in-memory buffer (Render runs one), and the persisted rows stay correct
// across restarts because they are incremented, not overwritten.

const usageContext = require('./usage-context');

const MAX_BUCKETS = 4000;
const MAX_DIM = 400;
const MAX_EVENTS = 500;
const FLUSH_MS = 60 * 1000;
const EVENT_TTL_SECONDS = 90 * 86400;
const COUNT_TTL_SECONDS = 400 * 86400;
const IST_OFFSET_MS = 330 * 60 * 1000;

let buckets = new Map();
let events = [];
let dropped = 0, droppedEvents = 0;
let timer = null, flushing = null;
let db = null;
let indexesReady = false;

function enabled(env = process.env) {
    return String(env.USAGE_METRICS ?? 'true').toLowerCase() !== 'false';
}

// The owner reads reports in IST; a UTC day boundary would split a working
// evening across two rows.
function istDay(date = new Date()) {
    return new Date(date.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

function istMinuteKey(date = new Date()) {
    return Math.floor((date.getTime() + IST_OFFSET_MS) / 60000);
}

function surfaceOf(value) {
    const s = String(value || '');
    return ['web', 'rest', 'mcp', 'mcp-apps', 'system'].includes(s) ? s : 'web';
}

// Signed-in accounts are keyed by id. A keyless connector caller has no
// account, so it is keyed by the same salted monthly pseudonym mcp_calls uses.
// Work the server does on its own behalf (boot warmup, watchdog) is keyed
// `system:*` so it can never be mistaken for a customer.
function userKeyOf(evt) {
    if (evt.system) return 'system:' + String(evt.system).slice(0, 40);
    if (evt.userId) return 'u:' + String(evt.userId);
    if (evt.callerHash) return 'a:' + String(evt.callerHash).slice(0, 32);
    return null;
}

function emptyBucket(userKey, surface, day) {
    return {
        userKey, surface, day,
        requests: 0, ok: 0, err: 0,
        resBytes: 0, cacheReadBytes: 0, cacheWriteBytes: 0,
        cacheHits: 0, cacheMisses: 0,
        plan: null, client: null,
        firstAt: null, lastAt: null,
        minutes: new Set(),
        route: new Map(), tool: new Map(), symbol: new Map(), metric: new Map()
    };
}

function bumpDim(map, key, by = 1) {
    if (!key) return;
    const k = String(key).slice(0, 160);
    const next = (map.get(k) || 0) + by;
    if (!map.has(k) && map.size >= MAX_DIM) return; // bounded: drop new keys
    map.set(k, next);
}

function bucketFor(userKey, surface, day) {
    const key = userKey + '|' + surface + '|' + day;
    let b = buckets.get(key);
    if (b) return b;
    if (buckets.size >= MAX_BUCKETS) {
        dropped += 1;
        return null;
    }
    b = emptyBucket(userKey, surface, day);
    buckets.set(key, b);
    return b;
}

// evt = { at, userId, callerHash, system, surface, plan, client, route, tool,
//         symbols[], metrics[], resBytes, ok, code, cache:{hits,misses,
//         readBytes,writeBytes} }
function record(evt) {
    if (!enabled() || !evt) return false;
    const userKey = userKeyOf(evt);
    if (!userKey) return false;
    const at = evt.at instanceof Date ? evt.at : new Date(evt.at || Date.now());
    const surface = surfaceOf(evt.surface);
    const b = bucketFor(userKey, surface, istDay(at));
    if (!b) return false;

    b.requests += 1;
    if (evt.ok === false) b.err += 1; else b.ok += 1;
    b.resBytes += Math.max(0, Math.round(Number(evt.resBytes) || 0));
    const cache = evt.cache || null;
    if (cache) {
        b.cacheHits += Math.max(0, Number(cache.hits) || 0);
        b.cacheMisses += Math.max(0, Number(cache.misses) || 0);
        b.cacheReadBytes += Math.max(0, Number(cache.readBytes) || 0);
        b.cacheWriteBytes += Math.max(0, Number(cache.writeBytes) || 0);
    }
    if (!b.plan && evt.plan) b.plan = String(evt.plan).slice(0, 40);
    if (!b.client && evt.client) b.client = String(evt.client).slice(0, 40);
    if (!b.firstAt || at < b.firstAt) b.firstAt = at;
    if (!b.lastAt || at > b.lastAt) b.lastAt = at;
    b.minutes.add(istMinuteKey(at));

    bumpDim(b.route, evt.route);
    bumpDim(b.tool, evt.tool);
    for (const s of (Array.isArray(evt.symbols) ? evt.symbols : [])) bumpDim(b.symbol, String(s).toUpperCase());
    for (const m of (Array.isArray(evt.metrics) ? evt.metrics : [])) bumpDim(b.metric, m);

    return true;
}

// Per-request drill-down rows. Buffered; never written for pages or assets.
function recordEvent(evt) {
    if (!enabled() || !evt) return;
    const userKey = userKeyOf(evt);
    if (!userKey) return;
    if (events.length >= MAX_EVENTS) { droppedEvents += 1; return; }
    events.push({
        at: evt.at instanceof Date ? evt.at : new Date(evt.at || Date.now()),
        userKey,
        surface: surfaceOf(evt.surface),
        route: evt.route ? String(evt.route).slice(0, 160) : null,
        tool: evt.tool ? String(evt.tool).slice(0, 80) : null,
        symbols: (Array.isArray(evt.symbols) ? evt.symbols : []).slice(0, 12).map((s) => String(s).toUpperCase().slice(0, 24)),
        metrics: (Array.isArray(evt.metrics) ? evt.metrics : []).slice(0, 12).map((m) => String(m).slice(0, 40)),
        resBytes: Math.max(0, Math.round(Number(evt.resBytes) || 0)),
        cacheReadBytes: Math.max(0, Math.round(Number(evt.cache && evt.cache.readBytes) || 0)),
        cacheWriteBytes: Math.max(0, Math.round(Number(evt.cache && evt.cache.writeBytes) || 0)),
        ok: evt.ok !== false,
        code: evt.code ? String(evt.code).slice(0, 60) : null
    });
}

function collections() {
    const conn = db || (require('mongoose').connection);
    if (!conn || conn.readyState !== 1) return null;
    return {
        daily: conn.collection('usage_daily'),
        counts: conn.collection('usage_counts'),
        events: conn.collection('usage_events')
    };
}

async function ensureIndexes(cols) {
    if (indexesReady) return;
    indexesReady = true;
    try { await cols.events.createIndex({ at: 1 }, { expireAfterSeconds: EVENT_TTL_SECONDS }); } catch (_) { indexesReady = false; }
    try { await cols.events.createIndex({ userKey: 1, at: -1 }); } catch (_) {}
    try { await cols.daily.createIndex({ day: 1 }); } catch (_) {}
    try { await cols.daily.createIndex({ userKey: 1, day: -1 }); } catch (_) {}
    try { await cols.counts.createIndex({ day: 1, kind: 1 }); } catch (_) {}
    try { await cols.counts.createIndex({ userKey: 1, day: -1 }); } catch (_) {}
    try { await cols.counts.createIndex({ kind: 1, key: 1, day: 1 }); } catch (_) {}
    try { await cols.counts.createIndex({ at: 1 }, { expireAfterSeconds: COUNT_TTL_SECONDS }); } catch (_) {}
}

function flushOperations(snapshot) {
    const dailyOps = [], countOps = [];
    for (const b of snapshot) {
        const minuteCount = b.minutes.size;
        dailyOps.push({
            updateOne: {
                filter: { userKey: b.userKey, surface: b.surface, day: b.day },
                update: {
                    $inc: {
                        requests: b.requests, ok: b.ok, err: b.err,
                        resBytes: b.resBytes,
                        cacheReadBytes: b.cacheReadBytes,
                        cacheWriteBytes: b.cacheWriteBytes,
                        cacheHits: b.cacheHits, cacheMisses: b.cacheMisses,
                        activeMinutes: minuteCount
                    },
                    $min: { firstAt: b.firstAt },
                    $max: { lastAt: b.lastAt },
                    $set: { updatedAt: new Date() },
                    $setOnInsert: { plan: b.plan || null, client: b.client || null }
                },
                upsert: true
            }
        });
        for (const [kind, map] of [['route', b.route], ['tool', b.tool], ['symbol', b.symbol], ['metric', b.metric]]) {
            for (const [key, n] of map) {
                countOps.push({
                    updateOne: {
                        filter: { userKey: b.userKey, surface: b.surface, day: b.day, kind, key },
                        update: { $inc: { n }, $setOnInsert: { at: new Date() } },
                        upsert: true
                    }
                });
            }
        }
    }
    return { dailyOps, countOps };
}

async function flush() {
    if (flushing) return flushing;
    const snapshot = [...buckets.values()];
    const pendingEvents = events;
    buckets = new Map();
    events = [];
    flushing = (async () => {
        try {
            const cols = collections();
            if (!cols) {
                // No database: put the counters back rather than losing them.
                for (const b of snapshot) buckets.set(b.userKey + '|' + b.surface + '|' + b.day, b);
                return { flushed: 0, reason: 'no-database' };
            }
            await ensureIndexes(cols);
            const { dailyOps, countOps } = flushOperations(snapshot);
            let daily = 0, counts = 0, evts = 0;
            if (dailyOps.length) { const r = await cols.daily.bulkWrite(dailyOps, { ordered: false }); daily = dailyOps.length; void r; }
            if (countOps.length) { await cols.counts.bulkWrite(countOps, { ordered: false }); counts = countOps.length; }
            if (pendingEvents.length) { await cols.events.insertMany(pendingEvents, { ordered: false }); evts = pendingEvents.length; }
            return { flushed: daily, counts, events: evts };
        } catch (error) {
            // Re-queue so a transient outage defers the counters rather than
            // losing them. Bounded: MAX_BUCKETS still applies.
            for (const b of snapshot) {
                const key = b.userKey + '|' + b.surface + '|' + b.day;
                if (!buckets.has(key)) buckets.set(key, b);
            }
            for (const e of pendingEvents) if (events.length < MAX_EVENTS) events.push(e);
            return { flushed: 0, error: String((error && error.message) || error).slice(0, 160) };
        } finally {
            flushing = null;
        }
    })();
    return flushing;
}

function start({ connection = null, intervalMs = FLUSH_MS } = {}) {
    if (connection) db = connection;
    if (timer) return false;
    timer = setInterval(() => { flush().catch(() => {}); }, intervalMs);
    if (timer.unref) timer.unref();
    return true;
}

function stop() {
    if (timer) clearInterval(timer);
    timer = null;
    return flush();
}

function stats() {
    return { buckets: buckets.size, events: events.length, dropped, droppedEvents, flushing: !!flushing, enabled: enabled() };
}

function __reset() {
    buckets = new Map(); events = []; dropped = 0; droppedEvents = 0; indexesReady = false;
}

module.exports = { record, recordEvent, flush, start, stop, stats, enabled, istDay, istMinuteKey, userKeyOf, surfaceOf, flushOperations, __reset, __snapshot: () => [...buckets.values()], MAX_BUCKETS, MAX_DIM, MAX_EVENTS };
