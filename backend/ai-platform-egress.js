'use strict';

// AI-platform egress matching — answers "did this request come out of an AI
// platform's own network?", for the shared keyless pool in mcp-anon.js.
//
// WHY: the keyless MCP identity is the visitor IP, but a Claude.ai connector
// call egresses from Anthropic's shared range and a ChatGPT connector call from
// OpenAI's published list — not from the user's home address. Counted per IP,
// a handful of users behind one egress address exhausted the 30-day keyless
// allowance for everyone on that platform within hours of listing. Callers
// from these networks are therefore metered against a shared per-platform
// pool that resets every UTC day instead (see mcp-anon.js).
//
// Sources:
//   - Anthropic publishes a single range, hard-coded below with its source:
//     https://platform.claude.com/docs/en/api/ip-addresses ("Outbound IP addresses")
//   - OpenAI publishes a JSON list for exactly this purpose, vendored verbatim
//     to backend/data/openai-connector-ranges.json (its creationTime is kept
//     so the snapshot's age stays checkable):
//     https://openai.com/chatgpt-connectors.json
//
// Parsed once at load; match() is a pure in-memory lookup on the request path.
// Set AI_PLATFORM_EGRESS_POOL=false to switch the pool off without a deploy:
// match() then answers null for everything and every caller is metered
// per-visitor again.

const fs = require('fs');
const path = require('path');

// Anthropic's documented outbound range, 160.79.104.0/21.
// Source: https://platform.claude.com/docs/en/api/ip-addresses ("Outbound IP addresses")
const ANTHROPIC_PREFIX = '160.79.104.0/21';

// ---------------------------------------------------------------------------
// CIDR arithmetic — BigInt, so an IPv6 address is one integer like an IPv4
// ---------------------------------------------------------------------------

function parseIpv4(ip) {
    const parts = String(ip).split('.');
    if (parts.length !== 4) return null;
    let value = 0n;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const n = Number(part);
        if (n > 255) return null;
        value = (value << 8n) | BigInt(n);
    }
    return { family: 4, bits: 32, value };
}

// Parses full IPv6 including `::` compression and an embedded dotted-quad
// tail (::ffff:1.2.3.4). Returns the 128-bit value, or null when malformed.
function parseIpv6(ip) {
    const text = String(ip).toLowerCase();
    if (!text.includes(':')) return null;
    const halves = text.split('::');
    if (halves.length > 2) return null;
    const parseHalf = (half) => {
        const groups = [];
        if (!half) return groups;
        const chunks = half.split(':');
        for (let i = 0; i < chunks.length; i++) {
            const chunk = chunks[i];
            if (i === chunks.length - 1 && chunk.includes('.')) {
                const v4 = parseIpv4(chunk);
                if (!v4) return null;
                groups.push((v4.value >> 16n) & 0xffffn, v4.value & 0xffffn);
                continue;
            }
            if (!/^[0-9a-f]{1,4}$/.test(chunk)) return null;
            groups.push(BigInt(parseInt(chunk, 16)));
        }
        return groups;
    };
    const left = parseHalf(halves.length === 1 ? text : halves[0]);
    if (left === null) return null;
    const right = halves.length === 2 ? parseHalf(halves[1]) : [];
    if (right === null) return null;
    if (halves.length === 1 && left.length !== 8) return null;
    if (halves.length === 2 && left.length + right.length > 8) return null;
    const groups = [...left];
    while (groups.length < 8 - right.length) groups.push(0n);
    groups.push(...right);
    let value = 0n;
    for (const group of groups) value = (value << 16n) | group;
    return { family: 6, bits: 128, value };
}

// ::ffff:0:0/96 is how a socket presents a mapped IPv4 address; matching it
// against the IPv4 lists is the whole point, so fold it before comparing.
function parseAddress(ip) {
    let parsed = parseIpv4(ip) || parseIpv6(ip);
    if (!parsed) return null;
    if (parsed.family === 6 && (parsed.value >> 32n) === 0xffffn) {
        parsed = { family: 4, bits: 32, value: parsed.value & 0xffffffffn };
    }
    return parsed;
}

function parsePrefix(prefix) {
    const [network, bitsRaw] = String(prefix).split('/');
    const parsed = parseAddress(network);
    if (!parsed) return null;
    const bits = Number(bitsRaw === undefined ? parsed.bits : bitsRaw);
    if (!Number.isInteger(bits) || bits < 0 || bits > parsed.bits) return null;
    const hostBits = BigInt(parsed.bits - bits);
    return { family: parsed.family, bits: parsed.bits, hostBits, network: parsed.value >> hostBits << hostBits };
}

function inRange(address, range) {
    if (!address || !range || address.family !== range.family) return false;
    return address.value >> range.hostBits << range.hostBits === range.network;
}

// ---------------------------------------------------------------------------
// The platform lists
// ---------------------------------------------------------------------------

function loadRanges() {
    const ranges = [];
    const anthropic = parsePrefix(ANTHROPIC_PREFIX);
    if (anthropic) ranges.push({ ...anthropic, platform: 'anthropic' });

    const openaiPath = path.join(__dirname, 'data', 'openai-connector-ranges.json');
    try {
        const doc = JSON.parse(fs.readFileSync(openaiPath, 'utf8'));
        for (const entry of Array.isArray(doc.prefixes) ? doc.prefixes : []) {
            // Both key spellings are accepted so a future ipv6Prefix in the
            // published file starts matching the day it is vendored.
            for (const key of ['ipv4Prefix', 'ipv6Prefix']) {
                if (!entry[key]) continue;
                const parsed = parsePrefix(entry[key]);
                if (parsed) ranges.push({ ...parsed, platform: 'openai' });
            }
        }
    } catch (_) {
        // A missing or malformed snapshot must not take the endpoint down;
        // Anthropic traffic still pools, OpenAI traffic meters per visitor.
    }
    return ranges;
}

const RANGES = loadRanges();

function match(ip) {
    if (String(process.env.AI_PLATFORM_EGRESS_POOL || '').toLowerCase() === 'false') return null;
    const address = parseAddress(ip);
    if (!address) return null;
    for (const range of RANGES) {
        if (inRange(address, range)) return range.platform;
    }
    return null;
}

module.exports = { match, ANTHROPIC_PREFIX };