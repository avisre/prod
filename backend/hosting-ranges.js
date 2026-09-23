'use strict';

// Offline test: is this IPv4 address on a hosting, cloud or VPN network?
//
// The wall in app.js uses this to refuse the free tier to visitors arriving
// over a VPN or a rented cloud box, which is how a visitor in a blocked
// country circumvents the geo wall without spoofing anything — the connection
// really does come from, say, Australia, but it comes from a rented address in
// Australia rather than a home line.
//
// Two design decisions worth knowing before changing anything here:
//
//   1. The table is generated offline and committed, by
//      scripts/refresh-hosting-ranges.js. Nothing is fetched at runtime, so a
//      slow or hostile third party cannot delay a request and the visitor's IP
//      is never sent anywhere. Re-run that script to refresh; the file it
//      writes carries the date it was built.
//
//   2. IPv6 fails OPEN. The table is IPv4-only: the providers' published lists
//      are IPv4-first, and an IPv6 miss would otherwise refuse the free tier to
//      every IPv6 visitor. A determined user on an IPv6-only VPN therefore
//      still gets the free tier, which is the accepted ceiling on this check —
//      see the trade-off discussion in .claude/HANDOFF.md.
//
// A missing or corrupt bundle also fails open (hasData() false), matching the
// geo wall's posture on a GeoIP miss: a data problem must not take the site
// down for everyone.
//
// File format, written by the refresh script:
//   0..3   magic "SPHR"
//   4..7   uint32 LE range count
//   8..11  uint32 LE generatedAt (unix seconds)
//   12..   count x (uint32 LE start, uint32 LE end), sorted by start, merged

const fs = require('node:fs');
const path = require('node:path');

const DATA_PATH = path.join(__dirname, 'data', 'hosting-ranges.bin');
const MAGIC = 'SPHR';
const HEADER_BYTES = 12;
const RANGE_BYTES = 8;

// Dotted-quad to an unsigned 32-bit integer, or null for anything else —
// including every IPv6 address, which is what makes IPv6 fail open.
function ipv4ToInt(ip) {
    const text = String(ip == null ? '' : ip).trim().replace(/^::ffff:/i, '');
    const parts = text.split('.');
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const octet = Number(part);
        if (octet > 255) return null;
        value = value * 256 + octet;
    }
    return value;
}

// Last index whose start is <= value, or -1. Binary search, so a request costs
// ~15 integer comparisons against 30k ranges rather than a scan.
function lastStartAtOrBefore(startTable, value) {
    let low = 0;
    let high = startTable.length - 1;
    let found = -1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (startTable[mid] <= value) {
            found = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return found;
}

function lookupInTable(startTable, endTable, value) {
    const index = lastStartAtOrBefore(startTable, value);
    return index >= 0 && value <= endTable[index];
}

// Parses a bundle into typed arrays. Returns null on anything malformed — the
// caller treats that as "no data", never as "nothing is hosting".
function parseBuffer(buffer) {
    if (!Buffer.isBuffer(buffer) || buffer.length < HEADER_BYTES) return null;
    if (buffer.toString('ascii', 0, 4) !== MAGIC) return null;
    const count = buffer.readUInt32LE(4);
    const generatedAt = buffer.readUInt32LE(8);
    if (buffer.length !== HEADER_BYTES + count * RANGE_BYTES) return null;
    const startTable = new Uint32Array(count);
    const endTable = new Uint32Array(count);
    for (let i = 0; i < count; i += 1) {
        const at = HEADER_BYTES + i * RANGE_BYTES;
        const start = buffer.readUInt32LE(at);
        const end = buffer.readUInt32LE(at + 4);
        // A table that is not sorted cannot be binary-searched; refuse it
        // rather than return wrong answers for every request.
        if (end < start || (i > 0 && start < startTable[i - 1])) return null;
        startTable[i] = start;
        endTable[i] = end;
    }
    return { startTable, endTable, generatedAt, bytes: buffer.length };
}

let table = null;
let loadError = null;
try {
    const parsed = parseBuffer(fs.readFileSync(DATA_PATH));
    if (parsed) {
        table = parsed;
    } else {
        loadError = 'bundle present but malformed';
    }
} catch (error) {
    loadError = error && error.code === 'ENOENT'
        ? 'bundle missing (run scripts/refresh-hosting-ranges.js)'
        : `bundle unreadable: ${error && error.message}`;
}
if (!table) console.warn(`[hosting-ranges] ${loadError}; the hosting wall will not block anyone.`);

function isHostingIp(ip) {
    if (!table) return false;
    const value = ipv4ToInt(ip);
    if (value === null) return false;
    return lookupInTable(table.startTable, table.endTable, value);
}

function hasData() {
    return Boolean(table);
}

function stats() {
    return {
        loaded: Boolean(table),
        ranges: table ? table.startTable.length : 0,
        bytes: table ? table.bytes : 0,
        generatedAt: table ? new Date(table.generatedAt * 1000).toISOString() : null,
        error: table ? null : loadError
    };
}

// Test seam: lets a test drive a synthetic bundle through the same parser the
// real file goes through, so the tests do not depend on the shipped dataset's
// contents (which change on every refresh).
function _loadFromBufferForTest(buffer) {
    const parsed = parseBuffer(buffer);
    table = parsed;
    loadError = parsed ? null : 'test bundle malformed';
    return Boolean(parsed);
}

module.exports = {
    DATA_PATH,
    isHostingIp,
    hasData,
    stats,
    ipv4ToInt,
    lastStartAtOrBefore,
    lookupInTable,
    parseBuffer,
    _loadFromBufferForTest
};
