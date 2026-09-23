'use strict';

// Hosting/VPN wall (owner decision 2026-09-23, same day as the geo wall): a
// visitor arriving from a hosting, cloud or commercial-VPN address loses the
// free surface, the same way a visitor in SG/CN/HK does. This is the answer to
// the geo wall's one hole — a VPN exit in a country the wall does not name.
//
// Covers both halves: the offline table reader (hosting-ranges.js) and the
// policy wired into app.js. The shipped dataset's contents change on every
// refresh, so the reader is tested against a synthetic bundle and only
// spot-checked against the real one.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const hostingRanges = require('../hosting-ranges');
const marketingAttribution = require('../marketing-attribution');

const appSource = () => fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const refreshSource = () => fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'refresh-hosting-ranges.js'), 'utf8');

function buildBundle(ranges, generatedAt = 1758600000) {
    const header = Buffer.alloc(12);
    header.write('SPHR', 0, 'ascii');
    header.writeUInt32LE(ranges.length, 4);
    header.writeUInt32LE(generatedAt, 8);
    const body = Buffer.alloc(ranges.length * 8);
    ranges.forEach(([start, end], index) => {
        body.writeUInt32LE(start, index * 8);
        body.writeUInt32LE(end, index * 8 + 4);
    });
    return Buffer.concat([header, body]);
}

// --- The reader ------------------------------------------------------------

test('ipv4ToInt accepts dotted quads and mapped IPv4, and rejects everything else', () => {
    assert.equal(hostingRanges.ipv4ToInt('0.0.0.0'), 0);
    assert.equal(hostingRanges.ipv4ToInt('255.255.255.255'), 4294967295);
    assert.equal(hostingRanges.ipv4ToInt('3.5.0.1'), 3 * 2 ** 24 + 5 * 2 ** 16 + 1);
    assert.equal(hostingRanges.ipv4ToInt('::ffff:3.5.0.1'), 3 * 2 ** 24 + 5 * 2 ** 16 + 1);
    // Anything that is not IPv4 returns null — this is what makes IPv6 fail
    // open rather than being compared as a wrong number.
    for (const bad of ['', '  ', '3.5.0', '3.5.0.1.2', '3.5.0.256', 'a.b.c.d', '2001:db8::1', null, undefined]) {
        assert.equal(hostingRanges.ipv4ToInt(bad), null, `rejects ${JSON.stringify(bad)}`);
    }
});

test('the binary search finds a range and misses the gaps between them', () => {
    const starts = new Uint32Array([10, 100, 1000]);
    const ends = new Uint32Array([20, 110, 1000]);
    assert.equal(hostingRanges.lookupInTable(starts, ends, 9), false);
    assert.equal(hostingRanges.lookupInTable(starts, ends, 10), true);
    assert.equal(hostingRanges.lookupInTable(starts, ends, 15), true);
    assert.equal(hostingRanges.lookupInTable(starts, ends, 20), true);
    assert.equal(hostingRanges.lookupInTable(starts, ends, 21), false);
    assert.equal(hostingRanges.lookupInTable(starts, ends, 99), false);
    assert.equal(hostingRanges.lookupInTable(starts, ends, 105), true);
    assert.equal(hostingRanges.lookupInTable(starts, ends, 1000), true);
    assert.equal(hostingRanges.lookupInTable(starts, ends, 4294967295), false);
    assert.equal(hostingRanges.lastStartAtOrBefore(starts, 5), -1);
});

test('a malformed bundle is refused rather than half-loaded', () => {
    const good = buildBundle([[10, 20]]);
    assert.ok(hostingRanges.parseBuffer(good));
    // Wrong magic.
    const badMagic = Buffer.from(good);
    badMagic.write('XXXX', 0, 'ascii');
    assert.equal(hostingRanges.parseBuffer(badMagic), null);
    // Truncated body.
    assert.equal(hostingRanges.parseBuffer(good.slice(0, good.length - 1)), null);
    // Too short to hold a header.
    assert.equal(hostingRanges.parseBuffer(Buffer.alloc(4)), null);
    assert.equal(hostingRanges.parseBuffer(null), null);
    // Unsorted: binary search would silently return wrong answers, so the
    // whole table is rejected instead.
    assert.equal(hostingRanges.parseBuffer(buildBundle([[100, 110], [10, 20]])), null);
    // An inverted range is equally unusable.
    assert.equal(hostingRanges.parseBuffer(buildBundle([[20, 10]])), null);
});

test('isHostingIp answers from the loaded table, and fails open without one', () => {
    const previous = hostingRanges.stats().loaded;
    try {
        assert.equal(hostingRanges._loadFromBufferForTest(buildBundle([[167772160, 167772415]])), true);
        assert.equal(hostingRanges.isHostingIp('10.0.0.5'), true);   // inside
        assert.equal(hostingRanges.isHostingIp('11.0.0.5'), false);  // outside
        assert.equal(hostingRanges.isHostingIp('::ffff:10.0.0.5'), true);
        assert.equal(hostingRanges.isHostingIp('2001:db8::1'), false, 'IPv6 fails open');
        assert.equal(hostingRanges.isHostingIp(''), false);
        assert.equal(hostingRanges.isHostingIp(null), false);
        // No table at all: nobody is walled, so a missing bundle cannot take
        // the free tier away from every visitor at once.
        hostingRanges._loadFromBufferForTest(null);
        assert.equal(hostingRanges.hasData(), false);
        assert.equal(hostingRanges.isHostingIp('10.0.0.5'), false);
        assert.match(String(hostingRanges.stats().error), /malformed|missing/);
    } finally {
        assert.equal(previous, true, 'the shipped bundle was loaded at require time');
        hostingRanges._loadFromBufferForTest(fs.readFileSync(hostingRanges.DATA_PATH));
    }
});

// --- The shipped dataset ---------------------------------------------------

test('the committed bundle loads and is big enough to be a real table', () => {
    const stats = hostingRanges.stats();
    assert.equal(stats.loaded, true, `bundle must load: ${stats.error}`);
    assert.ok(stats.ranges > 20000, `expected a substantial table, got ${stats.ranges}`);
    assert.ok(stats.bytes > 100000, `expected a substantial file, got ${stats.bytes} bytes`);
    assert.match(stats.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
});

test('known hosting addresses are refused and known residential ones are not', () => {
    // One from each source family, so a source dropping out of the refresh
    // shows up here rather than as free access in production.
    for (const [ip, label] of [
        ['3.5.0.1', 'AWS'],
        ['20.0.0.1', 'Azure'],
        ['34.64.0.1', 'Google Cloud'],
        ['104.18.0.1', 'Cloudflare'],
        ['165.227.0.1', 'DigitalOcean'],
        ['5.9.0.1', 'Hetzner']
    ]) {
        assert.equal(hostingRanges.isHostingIp(ip), true, `${label} (${ip}) is a hosting address`);
    }
    // Consumer ISP ranges. A false positive here refuses the free tier to an
    // ordinary reader, which is the cost this whole change was weighed against
    // — so each of these is asserted, not assumed.
    for (const [ip, label] of [
        ['73.158.0.1', 'Comcast'],
        ['99.240.0.1', 'AT&T'],
        ['49.36.0.1', 'Airtel India'],
        ['101.127.0.1', 'Singapore residential'],
        ['175.45.0.1', 'Hong Kong residential'],
        ['127.0.0.1', 'localhost']
    ]) {
        assert.equal(hostingRanges.isHostingIp(ip), false, `${label} (${ip}) must keep the free tier`);
    }
});

test('the refresh script writes the file the reader loads, and excludes consumer ISPs', () => {
    const script = refreshSource();
    assert.match(script, /hosting-ranges\.bin/);
    assert.match(script, /ip2asn-v4\.tsv\.gz/);
    assert.match(script, /X4BNet\/lists_vpn/);
    assert.match(script, /ip-ranges\.amazonaws\.com/);
    // Google Fiber is a consumer ISP on a Google ASN: listing it would refuse
    // home users, which is the one false positive the keyword filter could
    // easily reintroduce.
    assert.match(script, /NEVER_HOSTING_ASNS = new Set\(\[19527\]\)/);
    assert.match(script, /NEVER_HOSTING_ASNS\.has\(asn\)/);
    // The transit carriers must stay out of the list for the same reason.
    assert.doesNotMatch(script, /HOSTING_ASNS = new Set\(\[[\s\S]*?\b174\b[\s\S]*?\]\)/);
    assert.match(script, /if \(merged\.length < floor\)/);
});

// --- The policy wired into app.js ------------------------------------------

test('the wall is on by default and can be turned off or observed without a deploy', () => {
    const source = appSource();
    assert.match(source, /const HOSTING_WALL_ENABLED = process\.env\.HOSTING_WALL_ENABLED !== 'false';/);
    assert.match(source, /const HOSTING_WALL_DRY_RUN = process\.env\.HOSTING_WALL_DRY_RUN === 'true';/);
    assert.match(source, /const HOSTING_WALL_BYPASS_TOKEN = process\.env\.HOSTING_WALL_BYPASS_TOKEN \|\| '';/);
    assert.match(source, /const hostingWallCounters = \{ blocked: 0, dryRunWouldBlock: 0, bypassed: 0 \};/);
    const section = source.slice(source.indexOf('function hostingWalled'), source.indexOf('function freeTierWallResponse'));
    assert.match(section, /if \(!HOSTING_WALL_ENABLED\) return false;/);
    assert.match(section, /if \(!hostingRanges\.hasData\(\)\) return false;/);
    assert.match(section, /hostingWallCounters\.dryRunWouldBlock \+= 1;/);
    assert.match(section, /hostingWallCounters\.blocked \+= 1;/);
});

test('crawlers are exempt (or the site deindexes) but unknown callers are not', () => {
    const section = appSource().slice(appSource().indexOf('function hostingWalled'), appSource().indexOf('function freeTierWallResponse'));
    // Googlebot and Bingbot crawl from Google/Microsoft cloud ranges; without
    // this the wall answers them with a redirect to /upgrade.html.
    assert.match(section, /const claim = botBlocker\.classifyUa\(ua\);/);
    assert.match(section, /if \(claim === 'allowed-claim' \|\| claim === 'internal'\) return false;/);
    // Only positively identified callers are exempt: /api/* skips bot-blocker,
    // so a UA-less request would otherwise pass both checks.
    assert.doesNotMatch(section, /claim !== 'unknown'/);
});

test('the wall classifies the visitor address, never the proxy hop', () => {
    const section = appSource().slice(appSource().indexOf('function hostingWalled'), appSource().indexOf('function freeTierWallResponse'));
    assert.match(section, /if \(!hostingRanges\.isHostingIp\(marketingAttribution\.requestIp\(req\)\)\) return false;/);
    assert.doesNotMatch(section, /isHostingIp\(req\.ip\)/);
});

test('requestIp prefers Cloudflare in production and never trusts a non-address header', () => {
    const prod = { NODE_ENV: 'production' };
    const dev = { NODE_ENV: 'development' };
    assert.equal(marketingAttribution.requestIp({ ip: '5.9.0.1', headers: { 'cf-connecting-ip': '3.5.0.1' } }, prod), '3.5.0.1');
    // A forged header is ignored outside production.
    assert.equal(marketingAttribution.requestIp({ ip: '5.9.0.1', headers: { 'cf-connecting-ip': '3.5.0.1' } }, dev), '5.9.0.1');
    // A hostname or other junk in the header must not become the address.
    assert.equal(marketingAttribution.requestIp({ ip: '5.9.0.1', headers: { 'cf-connecting-ip': 'evil.example.com' } }, prod), '5.9.0.1');
    assert.equal(marketingAttribution.requestIp({ ip: '5.9.0.1', headers: { 'cf-connecting-ip': 'not an ip' } }, prod), '5.9.0.1');
    assert.equal(marketingAttribution.requestIp({ ip: '5.9.0.1', headers: {} }, prod), '5.9.0.1');
    assert.equal(marketingAttribution.requestIp(null, prod), null);
});

test('the admin stats route exposes the counters and the bundle in use', () => {
    const source = appSource();
    assert.match(source, /app\.get\('\/api\/admin\/hosting-wall\/stats', authMiddleware, marketingDashboardOnly, \(req, res\) => \{[\s\S]{0,400}?table: hostingRanges\.stats\(\)/);
});
