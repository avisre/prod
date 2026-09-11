'use strict';

// Server-side crawler policy. robots.txt is only a request — some crawlers
// ignore it — so the policy that actually controls egress cost is enforced
// here, ahead of SSR rendering and static serving. This reinstates the
// design built and reverted (same day, before being committed) on
// 2026-09-05, now that a Render bandwidth alert supplies the cost data that
// revert said was missing. Full rationale:
// docs/growth/bot-crawler-situation-2026-09-05.md.
//
// frontend/robots.txt must name the exact same allowed agents as ALLOWED_UAS
// below — backend/test/robots-policy.test.js asserts the two never drift.

const dns = require('dns').promises;
const rateLimit = require('express-rate-limit');

const INTERNAL_UA_MARKER = 'stockportfolio-internal';

// A refusal is also the only channel a blocked crawler's operator reliably
// reads, so it carries the offer rather than just the denial.
const FORBIDDEN_BODY = 'Automated access is not permitted for this user agent. '
    + 'Licensed bulk data (SEC fundamentals + filing-change deltas) and MCP/API access '
    + 'are available: https://www.stockportfolio.pro/licensing or support@stockportfolio.pro.';

// Allowed straight through, subject to IP verification (Layer 2) below.
const ALLOWED_UAS = ['googlebot', 'googlebot-image', 'google-inspectiontool', 'storebot-google', 'bingbot', 'bingpreview'];
const ALLOWED_UA_RE = new RegExp(ALLOWED_UAS.join('|'), 'i');

// Everything else that self-identifies as automated: named AI crawlers,
// non-Google/Bing search engines, backlink/SEO scrapers, headless browsers,
// and plain HTTP client libraries.
const DENY_PATTERNS = [
    /meta-externalagent/i, /facebookbot/i, /gptbot/i, /chatgpt-user/i, /oai-searchbot/i,
    /anthropic-ai/i, /claudebot/i, /claude-web/i, /claude-user/i, /perplexitybot/i, /perplexity-user/i,
    /google-extended/i, /applebot-extended/i, /bytespider/i, /amazonbot/i, /cohere-ai/i, /ccbot/i, /diffbot/i,
    /duckduckbot/i, /yandexbot/i, /baiduspider/i, /applebot/i, /facebookexternalhit/i, /twitterbot/i, /linkedinbot/i, /slackbot/i,
    /semrushbot/i, /ahrefsbot/i, /mj12bot/i, /dotbot/i, /blexbot/i,
    /headlesschrome/i, /phantomjs/i, /puppeteer/i, /playwright/i, /selenium/i,
    /curl\//i, /wget\//i, /python-requests/i, /python-urllib/i, /scrapy/i, /go-http-client/i, /okhttp/i, /postmanruntime/i, /libwww-perl/i, /^java\//i
];

// /licensing is exempt for the same reason robots.txt is: an agent refused above
// is pointed at that page by FORBIDDEN_BODY, so it has to be fetchable to be read.
const EXEMPT_PATH_PATTERNS = [/^\/api\//, /^\/robots\.txt$/, /^\/sitemap\.xml$/, /^\/sitemaps\//, /^\/llms.*\.txt$/, /^\/\.well-known\//, /^\/licensing$/];

const STATIC_ASSET_RE = /\.(js|css|png|jpe?g|gif|svg|webp|woff2?|ttf|ico|mp4|json|xml|txt)$/i;

function isEnabled() {
    return process.env.BOT_BLOCK_ENABLED !== 'false';
}

function isDryRun() {
    return process.env.BOT_BLOCK_DRY_RUN === 'true';
}

function bypassToken() {
    return process.env.BOT_BLOCK_BYPASS_TOKEN || '';
}

function navMax() {
    const n = Number(process.env.BOT_BLOCK_NAV_MAX || 100);
    return Number.isFinite(n) && n > 0 ? n : 100;
}

function isExemptPath(path, isRawBodyWebhookPath) {
    const p = String(path || '');
    if (typeof isRawBodyWebhookPath === 'function' && isRawBodyWebhookPath(p)) return true;
    return EXEMPT_PATH_PATTERNS.some((re) => re.test(p));
}

function isStaticAssetPath(path) {
    return STATIC_ASSET_RE.test(String(path || ''));
}

// 'allowed-claim' — UA claims Googlebot/Bingbot; verify the IP (Layer 2).
// 'denied' — matches a known bad/bot pattern, or is empty.
// 'internal' — our own tooling; always let through.
// 'unknown' — doesn't match either list; fall through to header check (Layer 3).
function classifyUa(ua) {
    const value = String(ua || '').trim();
    if (!value) return 'denied';
    if (value.includes(INTERNAL_UA_MARKER)) return 'internal';
    if (ALLOWED_UA_RE.test(value)) return 'allowed-claim';
    if (DENY_PATTERNS.some((re) => re.test(value))) return 'denied';
    return 'unknown';
}

function hasBrowserHeaders(headers) {
    const h = headers || {};
    return Boolean(h['sec-ch-ua'] || h['sec-fetch-mode'] || h['sec-fetch-site'] || h['sec-fetch-dest'] || h['sec-fetch-user'] || h['accept-language']);
}

// --- Layer 2: IP verification for anything claiming to be Google/Bing ---
// Google's own documented method: reverse-DNS the client IP, require the
// hostname to belong to the vendor's domain, then forward-resolve that
// hostname and require it to return the original IP. Anyone can point a PTR
// record at googlebot.com; nobody else can change what googlebot.com itself
// resolves to.

const VERIFY_TTL_MS = 6 * 60 * 60 * 1000;
const verdictCache = new Map(); // ip -> { verdict, expiresAt }
const verifiedIpSet = new Set();
const impostorIpSet = new Set();

const VENDOR_SUFFIXES = {
    google: ['.googlebot.com', '.google.com', '.googleusercontent.com'],
    bing: ['.search.msn.com']
};

function vendorForUa(ua) {
    const value = String(ua || '').toLowerCase();
    return (value.includes('bingbot') || value.includes('bingpreview')) ? 'bing' : 'google';
}

function hostnameMatchesVendor(hostname, vendor) {
    const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
    return (VENDOR_SUFFIXES[vendor] || []).some((suffix) => h === suffix.slice(1) || h.endsWith(suffix));
}

function getCachedVerdict(ip) {
    const cached = verdictCache.get(ip);
    return (cached && cached.expiresAt > Date.now()) ? cached.verdict : null;
}

function cacheVerdict(ip, verdict) {
    // Never cache 'unknown' — a DNS hiccup should be retried, not remembered
    // as a standing verdict for six hours.
    if (verdict === 'unknown') return;
    verdictCache.set(ip, { verdict, expiresAt: Date.now() + VERIFY_TTL_MS });
    if (verdict === 'verified') verifiedIpSet.add(ip);
    if (verdict === 'impostor') impostorIpSet.add(ip);
}

// Resolves the true verdict for one IP. A DNS failure (reverse or forward)
// always resolves to 'unknown', never 'impostor' — a DNS outage must not
// deindex the site. A clean reverse lookup whose hostname doesn't belong to
// the claimed vendor, or whose forward-confirm doesn't return the original
// IP, is 'impostor'.
async function resolveCrawlerIp(ip, ua) {
    const vendor = vendorForUa(ua);
    let verdict = 'unknown';
    try {
        const hostnames = await dns.reverse(ip);
        const match = (hostnames || []).find((h) => hostnameMatchesVendor(h, vendor));
        if (!match) {
            verdict = 'impostor';
        } else {
            const [v4, v6] = await Promise.all([
                dns.resolve4(match).catch(() => null),
                dns.resolve6(match).catch(() => null)
            ]);
            if (v4 === null && v6 === null) {
                verdict = 'unknown'; // forward lookup itself failed — infra issue, not evidence
            } else {
                const addresses = [...(v4 || []), ...(v6 || [])];
                verdict = addresses.includes(ip) ? 'verified' : 'impostor';
            }
        }
    } catch (_) {
        verdict = 'unknown';
    }
    cacheVerdict(ip, verdict);
    return verdict;
}

// Fails open on an unseen IP: the first request from it is served while
// resolution happens in the background, because blocking real Googlebot
// over a slow DNS response costs far more than the handful of requests an
// impostor gets in the meantime.
function checkCrawlerClaim(ip, ua) {
    const cached = getCachedVerdict(ip);
    if (cached) return cached;
    resolveCrawlerIp(ip, ua).catch(() => {});
    return 'unseen';
}

// --- Layer 4: per-IP page-navigation rate limit ---
// A scraper running real headless Chrome with real headers and a rotating
// UA is indistinguishable from a human at the application layer — the only
// tell left is behaviour. A reader never reaches 100 navigations/5min;
// a crawler enumerating thousands of paths does nothing else.
const counters = { blocked: 0, forgedBrowser: 0, rateLimit: 0, dryRunWouldBlock: 0 };

const navLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: navMax(),
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.ip,
    skip: (req) => isStaticAssetPath(req.path) || getCachedVerdict(req.ip) === 'verified',
    handler: (req, res, next) => {
        counters.rateLimit++;
        if (isDryRun()) { counters.dryRunWouldBlock++; return next(); }
        return sendBlocked(res);
    }
});

function sendBlocked(res) {
    res.status(403).type('text/plain').send(FORBIDDEN_BODY);
}

function stats() {
    return {
        blocked: counters.blocked,
        forgedBrowser: counters.forgedBrowser,
        rateLimit: counters.rateLimit,
        dryRunWouldBlock: counters.dryRunWouldBlock,
        verifiedCrawlerIps: verifiedIpSet.size,
        impostorCrawlerIps: impostorIpSet.size,
        cacheSize: verdictCache.size
    };
}

function middleware({ isRawBodyWebhookPath } = {}) {
    return function botBlocker(req, res, next) {
        if (!isEnabled()) return next();
        if (isExemptPath(req.path, isRawBodyWebhookPath)) return next();

        const bypass = bypassToken();
        if (bypass && req.headers['x-bot-bypass'] === bypass) return next();

        const ua = req.headers['user-agent'];
        const claim = classifyUa(ua);

        if (claim === 'internal') return next();

        if (claim === 'denied') {
            counters.blocked++;
            if (isDryRun()) { counters.dryRunWouldBlock++; return next(); }
            return sendBlocked(res);
        }

        if (claim === 'allowed-claim') {
            const verdict = checkCrawlerClaim(req.ip, ua);
            if (verdict === 'impostor') {
                counters.blocked++;
                if (isDryRun()) { counters.dryRunWouldBlock++; return next(); }
                return sendBlocked(res);
            }
            return navLimiter(req, res, next);
        }

        // 'unknown': doesn't match either list. A real browser clears here via
        // its own headers; a forged UA on a non-browser client does not.
        if (!hasBrowserHeaders(req.headers)) {
            counters.blocked++;
            counters.forgedBrowser++;
            if (isDryRun()) { counters.dryRunWouldBlock++; return next(); }
            return sendBlocked(res);
        }
        return navLimiter(req, res, next);
    };
}

function _resetForTest() {
    verdictCache.clear();
    verifiedIpSet.clear();
    impostorIpSet.clear();
    counters.blocked = 0;
    counters.forgedBrowser = 0;
    counters.rateLimit = 0;
    counters.dryRunWouldBlock = 0;
}

module.exports = {
    ALLOWED_UAS,
    INTERNAL_UA_MARKER,
    middleware,
    stats,
    classifyUa,
    hasBrowserHeaders,
    isExemptPath,
    isStaticAssetPath,
    resolveCrawlerIp,
    checkCrawlerClaim,
    _resetForTest
};
