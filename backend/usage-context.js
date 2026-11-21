'use strict';

// Request-scoped usage attribution.
//
// WHY: the only per-customer byte measure that existed was `mcp_calls.bytes`
// (connector tool results). Website, REST-API and — most importantly — the
// ~2.9 MB company-evidence cache read/write that a request *triggers* were
// unattributed, so the bandwidth audit could only estimate them. This module
// carries a tiny mutable store for the life of one request so that the cache
// (public-financial-cache.js) can add its bytes to whoever caused them, and
// the response hook can roll the request up per user.
//
// PRIVACY: nothing here stores a payload, a question, an IP or an email. The
// store holds counters and the opaque identifiers the request already carries.
//
// The store is deliberately a plain mutable object rather than one
// AsyncLocalStorage per field: `run()` is called once at the top of the
// middleware stack and every async continuation inside the request keeps the
// same reference, so a later `noteCacheRead()` lands on the right request even
// though auth resolves the user after the store is created.

const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

function createStore(seed = {}) {
    return {
        route: seed.route || null,
        surface: seed.surface || null,
        // Counters the cache and the MCP callback add to.
        resBytes: 0,
        cacheHits: 0,
        cacheMisses: 0,
        cacheReadBytes: 0,
        cacheWriteBytes: 0,
        // Filled in by the MCP callback when a tool call completes.
        tool: null,
        symbols: null,
        metrics: null
    };
}

function run(store, fn) {
    return als.run(store, fn);
}

function current() {
    return als.getStore() || null;
}

// Called by the cache. `bytes` is the on-the-wire document size; a hit is
// served from the in-process map and costs nothing, a miss paid for a Mongo
// read.
function noteCacheHit() {
    const s = current();
    if (s) s.cacheHits += 1;
}

function noteCacheMiss(readBytes) {
    const s = current();
    if (!s) return;
    s.cacheMisses += 1;
    s.cacheReadBytes += Math.max(0, Math.round(Number(readBytes) || 0));
}

// Called by the cache after a real insert. A duplicate-key insert is NOT a
// write: it never crossed the network with a payload.
function noteCacheWrite(bytes) {
    const s = current();
    if (!s) return;
    s.cacheWriteBytes += Math.max(0, Math.round(Number(bytes) || 0));
}

module.exports = { createStore, run, current, noteCacheHit, noteCacheMiss, noteCacheWrite };
