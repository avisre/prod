'use strict';

// SEO, AI, and MCP all read the same large JSON files. Keep one small shared
// cache instead of retaining a separate parsed copy in each surface.
const fs = require('fs');
const path = require('path');
const stockUniverse = require('./stock-universe');

const FUND_DIR = path.join(__dirname, '..', 'frontend', 'data', 'fundamentals');
const MAX_SOURCE_BYTES = 8 * 1024 * 1024;
const MAX_ENTRIES = 96;
const TTL_MS = 30 * 60 * 1000;
const entries = new Map();
let sourceBytes = 0;

function remove(key) {
    const entry = entries.get(key);
    if (!entry) return;
    sourceBytes -= entry.bytes;
    entries.delete(key);
}

function keyFor(symbol) {
    return String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '_');
}

function loadRawFundamentals(symbol) {
    const key = keyFor(symbol);
    if (!key) return null;
    const hit = entries.get(key);
    if (hit) {
        if (Date.now() - hit.at < TTL_MS) {
            entries.delete(key);
            entries.set(key, hit);
            return hit.data;
        }
        remove(key);
    }

    let data;
    let bytes;
    try {
        const raw = fs.readFileSync(path.join(FUND_DIR, `${key}.json`), 'utf8');
        bytes = Buffer.byteLength(raw);
        data = stockUniverse.withIdentity(JSON.parse(raw), stockUniverse.lookup(symbol));
    } catch (_) { return null; }

    // Source bytes are a conservative accounting unit for cache eviction;
    // parsed objects consume more heap, so keep the byte budget small.
    if (bytes <= MAX_SOURCE_BYTES) {
        entries.set(key, { data, bytes, at: Date.now() });
        sourceBytes += bytes;
        while (sourceBytes > MAX_SOURCE_BYTES || entries.size > MAX_ENTRIES) {
            remove(entries.keys().next().value);
        }
    }
    return data;
}

function invalidate(symbol) { remove(keyFor(symbol)); }

function loadFundamentals(symbol) { return require('./verified-fundamentals').load(symbol, loadRawFundamentals(symbol)); }
// The SEC statements in USD, as the dossier shows them. The stored files hold
// only the overview and price history; their statements are the SEC data.
function loadPresentedFundamentals(symbol) { return require('./sec-presentation').presentUsd(loadFundamentals(symbol)); }
module.exports = { loadFundamentals, loadPresentedFundamentals, loadRawFundamentals, invalidate };
