'use strict';

// Every allowance that belongs to a person must resolve the address the way the
// walls do — through marketingAttribution.requestIp — and never through req.ip.
//
// Measured 2026-09-23: behind Render's Cloudflare edge req.ip is an intermediate
// proxy hop (a request from India resolved to a German hop), so each of these
// allowances was one shared bucket for the whole site. The visible symptom was
// not "an abuser is unthrottled" but the reverse: a stranger's traffic spent
// every other visitor's free quota, and honest visitors got 429s they could not
// explain. CF-Connecting-IP is the visitor, and the edge refuses a client-supplied
// value outright (verified the same day: any value returned 403 "error code:
// 1000" without reaching the app), which is what makes it safe to key on without
// trusting a header a caller could forge.
//
// This file pins the wiring. The resolver's own production/dev behaviour is
// pinned in hosting-wall.test.js ('requestIp prefers Cloudflare in production').

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSource = () => fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const botBlockerSource = () => fs.readFileSync(path.join(__dirname, '..', 'bot-blocker.js'), 'utf8');

function codeLinesIn(source, needle) {
    return source.split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => line.includes(needle))
        .filter(({ line }) => {
            const trimmed = line.trim();
            return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
        });
}

// Lines carrying code rather than prose. app.js documents req.ip heavily on
// purpose and contains 'https://' strings, so neither a bare occurrence count
// nor a hand-rolled comment stripper works: a `//`-to-EOL regex eats the rest of
// every URL line, and that can swallow real code along with it.
function codeLinesWith(needle) {
    return appSource().split('\n')
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => line.includes(needle))
        .filter(({ line }) => {
            const trimmed = line.trim();
            return !trimmed.startsWith('//') && !trimmed.startsWith('*') && !trimmed.startsWith('/*');
        });
}

function limiterOptions(name) {
    const source = appSource();
    const start = source.indexOf(`const ${name} = rateLimit({`);
    assert.ok(start > -1, `${name} is defined`);
    const end = source.indexOf('});', start);
    assert.ok(end > start, `${name} options block closes`);
    return source.slice(start, end);
}

function bodyOf(name) {
    const source = appSource();
    const start = source.indexOf(`function ${name}(`);
    assert.ok(start > -1, `${name} is defined`);
    return source.slice(start, source.indexOf('\n}', start));
}

test('the resolver is the only place in app.js that reads req.ip', () => {
    // One occurrence is the non-production fallback inside visitorIp. Any second
    // one is an allowance keyed on a proxy hop, which is the bug this file
    // exists to prevent — so the count is asserted, not the absence.
    const uses = codeLinesWith('req.ip');
    assert.equal(uses.length, 1, `only visitorIp may read req.ip; found line(s) ${uses.map((u) => u.number).join(', ')}`);
    assert.match(uses[0].line, /String\(\(req && req\.ip\) \|\| ''\)/, 'the single use is the resolver fallback');
    assert.match(appSource(), /function visitorIp\(req\) \{\s*return marketingAttribution\.requestIp\(req\) \|\| String\(\(req && req\.ip\) \|\| ''\) \|\| '0';\s*\}/);
});

test('bot-blocker resolves the visitor too, not the proxy hop', () => {
    // The same bug class one file over. bot-blocker.js predates the resolver and
    // the guard above only ever scanned app.js, so its req.ip went unnoticed.
    // The two sites it fed are both questions about the caller: Layer 2
    // reverse-resolved the edge hop (a real Googlebot then failed verification on
    // a stranger's PTR record and was cached 'impostor' for six hours), and
    // Layer 4 handed one 100-navigation budget to every reader behind that hop.
    const source = botBlockerSource();
    const uses = codeLinesIn(source, 'req.ip');
    assert.equal(uses.length, 1, `only clientIp may read req.ip; found line(s) ${uses.map((u) => u.number).join(', ')}`);
    assert.match(uses[0].line, /String\(\(req && req\.ip\) \|\| ''\)/, 'the single use is the clientIp fallback');
    assert.match(source, /function clientIp\(req\) \{\s*return marketingAttribution\.requestIp\(req\) \|\| String\(\(req && req\.ip\) \|\| ''\);\s*\}/);
    // Every site that consumes an address goes through it, so a later edit
    // cannot reintroduce the hop at just one of them.
    assert.match(source, /checkCrawlerClaim\(clientIp\(req\), ua\)/);
    assert.match(source, /keyGenerator: \(req\) => clientIp\(req\)/);
    assert.match(source, /getCachedVerdict\(clientIp\(req\)\) === 'verified'/);
});

test('the resolver and the walls share one address resolution', () => {
    // The hosting wall checks the visitor's address because a proxy hop would
    // classify the wrong machine; the counters do it because a shared hop would
    // count the wrong person. Both go through requestIp — if these ever diverge,
    // a visitor could be walled as one address and counted as another.
    const source = appSource();
    assert.match(source, /function visitorIp\(req\) \{\s*return marketingAttribution\.requestIp\(req\)/);
    assert.match(source, /if \(!hostingRanges\.isHostingIp\(marketingAttribution\.requestIp\(req\)\)\) return false;/);
});

test('the free-surface rate limiters are keyed per visitor', () => {
    // Each of these is a per-visitor budget by intent (see their comments); keyed
    // on the hop they were one budget for the whole site.
    for (const name of ['pageViewLimiter', 'freeToolLimiter', 'embedLimiter', 'apiLimiter', 'anonMcpRateLimit', 'assetSearchLimiter']) {
        assert.match(limiterOptions(name), /keyGenerator: visitorKeyGenerator/,
            `${name} is keyed per visitor`);
    }
    // Exactly this set, so widening the change to the auth/abuse limiters is a
    // deliberate edit that has to come past this assertion.
    assert.equal((appSource().match(/keyGenerator: visitorKeyGenerator/g) || []).length, 6);
});

test('the anti-abuse limiters keep their own keys, deliberately', () => {
    // Left as-is on purpose: a shared bucket is a real cost to honest users here
    // too (5 password resets per window for the whole site), but these guard
    // credential stuffing, enumeration and inbox flooding, where a per-attacker
    // bucket is a weaker control. Converting them is a separate decision.
    for (const name of ['loginLimiter', 'passwordResetLimiter', 'passwordResetConfirmLimiter',
        'checkEmailLimiter', 'supportLimiter', 'subscribeLimiter', 'checkoutClaimLimiter']) {
        assert.doesNotMatch(limiterOptions(name), /visitorKeyGenerator/, `${name} is out of this change's scope`);
    }
});

test('each free allowance counts the visitor rather than the proxy hop', () => {
    const source = appSource();
    // Deal-mirror code redemption: the anonymous leg.
    assert.match(source, /keyGenerator: \(req\) => `\$\{req\.userId \|\| 'anon'\}:\$\{crypto\.createHash\('sha256'\)\.update\(visitorIp\(req\)\)/);
    // The keyless API/MCP allowance, which is what a leaked-key-free caller
    // spends; the keyed leg still throttles per key.
    assert.match(source, /keyGenerator: \(req\) => req\.apiKeyId \|\| visitorIp\(req\)/);
    // Anonymous Ask's per-IP rung — and the same address is the keyless MCP
    // identity, so the two had to move together or the limit would guard a
    // different person than the quota it protects.
    assert.match(bodyOf('_anonAskIp'), /return visitorIp\(req\);/);
    assert.equal((source.match(/_anonAskIp\(req\)/g) || []).length >= 2, true, 'the MCP identity still reads it');
    // Free-stock allowances, stored as an HMAC — of the visitor's address, and
    // the raw address is still never persisted.
    assert.match(source, /MONITOR_FREE_IP_SALT \|\| JWT_SECRET\)\.update\(visitorIp\(req\)\)\.digest\('hex'\)/);
    assert.match(source, /const clientHash = crypto\.createHmac\('sha256', salt\)\.update\(visitorIp\(req\)\)\.digest\('hex'\)/);
    // Compare-AI verdict's free-per-day allowance.
    assert.match(source, /const key = visitorIp\(req\);/);
});

test('an allowance never hashes a value that can be empty', () => {
    // The fallback chain ends at '0', so a request with no address at all still
    // gets a stable key rather than hashing '' — which every such request would
    // share, recreating the shared bucket by accident.
    assert.match(appSource(), /\|\| String\(\(req && req\.ip\) \|\| ''\) \|\| '0'/);
    assert.equal(codeLinesWith('update(String(req.ip').length, 0, 'no allowance hashes a raw req.ip');
    assert.equal(codeLinesWith("const key = req.ip").length, 0, 'no allowance keys its map on req.ip');
});
