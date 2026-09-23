#!/usr/bin/env node
'use strict';

// Regenerates backend/data/hosting-ranges.bin — the offline table behind the
// hosting/VPN wall (see backend/hosting-ranges.js for the runtime reader and
// backend/app.js for the policy).
//
// Why a generated, committed file instead of a runtime lookup: the wall must
// answer "is this visitor on a hosting or VPN network?" on every request,
// including when a third-party API is slow or down, and it must not leak the
// visitor's IP to a third party. So the ranges are resolved HERE, offline, and
// only the result ships. Nothing else fetches at runtime.
//
// Run manually, roughly monthly:
//
//     node scripts/refresh-hosting-ranges.js
//
// It prints a per-source count and the final file size, then you commit the
// .bin. Re-run it if the wall starts missing a provider, or if a legitimate
// residential range is being refused.
//
// Sources (all public; the URLs were verified reachable 2026-09-23):
//
//   iptoasn.com ip2asn-v4  — every IPv4 range with its owning ASN and org
//     description. This is what makes the list systematic rather than a
//     hand-written blocklist, and it is how Azure (AS8075) is covered without
//     depending on Microsoft's download id, which changes.
//   X4BNet/lists_vpn (MIT) — ranges of known commercial VPN providers,
//     compiled from their own ASNs. This is the part that catches a VPN from
//     any exit country, including countries the geo wall does not name.
//   AWS + Google Cloud + Cloudflare — the providers publish their own
//     authoritative ranges; prefer them over the ASN description where both
//     exist, since they update the day a range is allocated.
//
// IPv4 only. backend/hosting-ranges.js documents why, and why an IPv6 visitor
// fails open rather than closed.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const OUT_PATH = path.join(__dirname, '..', 'backend', 'data', 'hosting-ranges.bin');
const MAGIC = 'SPHR';

// ASNs that exist to rent compute or to run a VPN. Deliberately EXCLUDES the
// transit carriers (AS174 Cogent, AS3356 Lumen, AS2914 NTT, AS1299 Telia,
// AS3491 PCCW, AS6453 Tata): they also carry residential traffic, so listing
// them would refuse the free tier to ordinary home users on those networks.
const HOSTING_ASNS = new Set([
    16509, 14618, 8987, 38895,             // Amazon / AWS
    15169, 396982, 139070,                 // Google / Google Cloud
    8075, 8068, 12076, 8069,               // Microsoft / Azure
    14061,                                 // DigitalOcean
    24940, 213230,                         // Hetzner
    16276, 35540,                          // OVH
    63949, 20940,                          // Linode (Akamai) / Akamai
    20473,                                 // Vultr / Choopa
    9009,                                  // M247 (carries many VPN providers)
    60068, 212238,                         // Datacamp / CDN77
    51167,                                 // Contabo
    12876,                                 // Scaleway / Online SAS
    197540,                                // netcup
    49505,                                 // Selectel
    16265, 60781,                          // LeaseWeb
    36352,                                 // ColoCrossing
    29802,                                 // Hivelocity
    23352,                                 // ServerCentral
    40676,                                 // Psychz
    136787, 206092,                        // PacketHub / TEFINCOM (NordVPN)
    13335,                                 // Cloudflare (also covers WARP egress)
    31898, 14519,                          // Oracle Cloud
    45102, 37963,                          // Alibaba Cloud
    132203, 45090,                         // Tencent Cloud
    46562,                                 // Performive
    46844,                                 // Sharktech
    53755,                                 // IOFlood
    22612,                                 // Namecheap hosting
    3223,                                  // Voxility
    62240, 49981,                          // Clouvider / WorldStream
    49505, 58061, 202425,                  // Selectel / Scalaxy / IP Volume
    209103, 62371,                         // Proton VPN / Mullvad-adjacent
    39351,                                 // 31173 Services
    29854, 394256, 401120, 53667,          // WestHost / FranTech / BuyVM
    6939,                                  // Hurricane Electric (colocation)
    63023,                                 // GTHost
    40021, 398324                          // Nocix / Catalyst
]);

// ASNs that look like hosting but are consumer ISPs. Google Fiber (AS19527)
// sells home internet; refusing its customers the free tier would be a false
// positive in the ordinary case.
const NEVER_HOSTING_ASNS = new Set([19527]);

// Org-description keywords, matched case-insensitively against the ASN's
// description in the iptoasn table. These catch hosting ASNs that rotate or
// that were never in the hand-written list above.
const HOSTING_ORG_KEYWORDS = [
    'AMAZON', 'AMAZON.COM', 'AWS', 'AMAZON TECHNOLOGIES',
    'MICROSOFT', 'AZURE',
    'GOOGLE CLOUD', 'GOOGLE LLC', 'GOOGLE INC',
    'DIGITALOCEAN', 'HETZNER', 'OVH', 'ONLINE SAS', 'LINODE', 'AKAMAI',
    'VULTR', 'CHOOPA', 'M247', 'DATACAMP', 'CDN77', 'CONTABO', 'SCALEWAY',
    'NETCUP', 'SELECTEL', 'LEASEWEB', 'COLOCROSSING', 'HIVELOCITY', 'PSYCHZ',
    'SERVERCENTRAL', 'WORLDSTREAM', 'CLOUVIDER', 'IP VOLUME', 'GTHOST',
    'INTERSERVER', 'NAMECHEAP', 'HOSTINGER', 'ORACLE', 'ALIBABA', 'TENCENT',
    'NORDVPN', 'EXPRESSVPN', 'SURFSHARK', 'MULLVAD', 'PROTON', 'PACKETHUB',
    'TEFINCOM', 'PERFORMIVE', 'SHARKTECH', 'IOFLOOD', 'SERVERIUS', 'VULTURE',
    'FRANTECH', 'BUYVM', 'NOCIX', 'CATALYST', 'VIRTUALPRIVATE'
];

const SOURCES = {
    iptoasn: 'https://iptoasn.com/data/ip2asn-v4.tsv.gz',
    vpnList: 'https://raw.githubusercontent.com/X4BNet/lists_vpn/main/ipv4.txt',
    aws: 'https://ip-ranges.amazonaws.com/ip-ranges.json',
    gcp: 'https://www.gstatic.com/ipranges/cloud.json',
    cloudflare: 'https://www.cloudflare.com/ips-v4'
};

function ipv4ToInt(ip) {
    const parts = String(ip || '').trim().split('.');
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

// "10.0.0.0/8" -> [167772160, 167772415]. Returns null on anything that is not
// an IPv4 CIDR with a sane prefix length.
function cidrToRange(cidr) {
    const text = String(cidr || '').trim();
    const slash = text.indexOf('/');
    if (slash <= 0) return null;
    const start = ipv4ToInt(text.slice(0, slash));
    const bits = Number(text.slice(slash + 1));
    if (start === null || !Number.isInteger(bits) || bits < 0 || bits > 32) return null;
    const size = 2 ** (32 - bits);
    return [start, start + size - 1];
}

async function fetchBuffer(url) {
    const response = await fetch(url, { redirect: 'follow' });
    if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
}

// --- Source 1: iptoasn, filtered to hosting/VPN ASNs and org keywords -------
async function collectIptoasn() {
    const gz = await fetchBuffer(SOURCES.iptoasn);
    const text = zlib.gunzipSync(gz).toString('utf8');
    const ranges = [];
    let matchedAsn = 0;
    let matchedKeyword = 0;
    let skippedNeverHosting = 0;
    for (const line of text.split('\n')) {
        if (!line) continue;
        const [startText, endText, asnText, , ...rest] = line.split('\t');
        const asn = Number(asnText);
        if (!Number.isFinite(asn)) continue;
        if (NEVER_HOSTING_ASNS.has(asn)) { skippedNeverHosting++; continue; }
        const org = rest.join(' ').toUpperCase();
        const byAsn = HOSTING_ASNS.has(asn);
        const byKeyword = !byAsn && HOSTING_ORG_KEYWORDS.some((k) => org.includes(k));
        if (!byAsn && !byKeyword) continue;
        const start = ipv4ToInt(startText);
        const end = ipv4ToInt(endText);
        if (start === null || end === null || end < start) continue;
        if (byAsn) matchedAsn++; else matchedKeyword++;
        ranges.push([start, end]);
    }
    return { ranges, detail: { matchedAsn, matchedKeyword, skippedNeverHosting } };
}

// --- Sources 2-5: CIDR and prefix lists ------------------------------------
async function collectVpnList() {
    const text = (await fetchBuffer(SOURCES.vpnList)).toString('utf8');
    const ranges = [];
    for (const line of text.split('\n')) {
        const range = cidrToRange(line.replace(/#.*$/, ''));
        if (range) ranges.push(range);
    }
    return { ranges, detail: { cidrs: ranges.length } };
}

async function collectAws() {
    const body = JSON.parse((await fetchBuffer(SOURCES.aws)).toString('utf8'));
    const ranges = [];
    for (const prefix of (body && body.prefixes) || []) {
        const range = cidrToRange(prefix && prefix.ip_prefix);
        if (range) ranges.push(range);
    }
    return { ranges, detail: { cidrs: ranges.length } };
}

async function collectGcp() {
    const body = JSON.parse((await fetchBuffer(SOURCES.gcp)).toString('utf8'));
    const ranges = [];
    for (const prefix of (body && body.prefixes) || []) {
        const range = cidrToRange(prefix && prefix.ipv4Prefix);
        if (range) ranges.push(range);
    }
    return { ranges, detail: { cidrs: ranges.length } };
}

async function collectCloudflare() {
    const text = (await fetchBuffer(SOURCES.cloudflare)).toString('utf8');
    const ranges = [];
    for (const line of text.split('\n')) {
        const range = cidrToRange(line.trim());
        if (range) ranges.push(range);
    }
    return { ranges, detail: { cidrs: ranges.length } };
}

// Sort by start, then fold every overlap and adjacency into one interval. The
// table is only correct if it is sorted: the runtime reader binary-searches it.
function mergeRanges(ranges) {
    const sorted = ranges.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const merged = [];
    for (const [start, end] of sorted) {
        const last = merged[merged.length - 1];
        if (last && start <= last[1] + 1) {
            if (end > last[1]) last[1] = end;
        } else {
            merged.push([start, end]);
        }
    }
    return merged;
}

function buildBuffer(merged, generatedAt) {
    const header = Buffer.alloc(12);
    header.write(MAGIC, 0, 'ascii');
    header.writeUInt32LE(merged.length, 4);
    header.writeUInt32LE(generatedAt, 8);
    const body = Buffer.alloc(merged.length * 8);
    merged.forEach(([start, end], index) => {
        body.writeUInt32LE(start, index * 8);
        body.writeUInt32LE(end, index * 8 + 4);
    });
    return Buffer.concat([header, body]);
}

async function main() {
    const collected = [];
    const failures = [];
    for (const [name, collect] of [
        ['iptoasn', collectIptoasn],
        ['vpn-list', collectVpnList],
        ['aws', collectAws],
        ['gcp', collectGcp],
        ['cloudflare', collectCloudflare]
    ]) {
        try {
            const { ranges, detail } = await collect();
            collected.push(...ranges);
            console.log(`${name.padEnd(11)} ${String(ranges.length).padStart(8)} ranges  ${JSON.stringify(detail)}`);
        } catch (error) {
            failures.push(`${name}: ${error.message}`);
            console.error(`${name.padEnd(11)} FAILED: ${error.message}`);
        }
    }

    const merged = mergeRanges(collected);
    const generatedAt = Math.floor(Date.now() / 1000);
    const buffer = buildBuffer(merged, generatedAt);
    fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
    fs.writeFileSync(OUT_PATH, buffer);

    // A guard, not a check: if the big sources failed we would otherwise commit
    // a table that silently refuses nobody (the wall fails open on a miss, so a
    // thin table looks like "no VPN users anywhere").
    const floor = 20000;
    if (merged.length < floor) {
        console.error(`\nREFUSING TO SHIP: only ${merged.length} merged ranges (floor ${floor}). Failures: ${failures.join('; ') || 'none'}`);
        process.exitCode = 1;
    }
    console.log(`\nmerged      ${merged.length} ranges  ->  ${OUT_PATH}`);
    console.log(`written     ${(buffer.length / 1024).toFixed(0)} KB  generated ${new Date(generatedAt * 1000).toISOString()}`);
    if (failures.length) console.log(`failures    ${failures.join('; ')}`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
