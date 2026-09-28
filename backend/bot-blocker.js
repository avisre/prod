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
const marketingAttribution = require('./marketing-attribution');

const INTERNAL_UA_MARKER = 'stockportfolio-internal';

// The client's address, not the edge's. Behind Render's Cloudflare edge req.ip
// is an intermediate proxy hop, not the visitor (measured 2026-09-23; see
// app.js's visitorIp and marketing-attribution.js's requestIp). Every use of
// the address below is a question about the *caller*, so keying on req.ip asks
// it about the wrong machine in two ways:
//   - Layer 2 reverse-resolves the proxy. A real Googlebot's claim then fails
//     verification on someone else's PTR record, and the IP is cached
//     'impostor' for six hours — a deindexing bug, not a spam block.
//   - Layer 4's 100-navigation budget is spent by every visitor behind that
//     edge at once, so one crawler exhausts the allowance for real readers
//     (and for Googlebot) sharing the hop.
// Cloudflare overwrites CF-Connecting-IP and refuses a client-supplied value,
// so it is trustworthy in production; outside production nothing strips a
// forged header and requestIp falls back to req.ip.
function clientIp(req) {
    return marketingAttribution.requestIp(req) || String((req && req.ip) || '');
}

// A refusal is also the only channel a blocked crawler's operator reliably
// reads, so it carries the offer rather than just the denial.
const FORBIDDEN_BODY = 'Automated access is not permitted for this user agent. '
    + 'Licensed bulk data (SEC fundamentals + filing-change deltas) and MCP/API access '
    + 'are available: https://www.stockportfolio.pro/licensing or support@stockportfolio.pro.';

// Allowed straight through, subject to IP verification (Layer 2/2b) below.
//
// `oai-searchbot` and `perplexitybot` are here for a different reason than the
// rest. They populate ANSWER-ENGINE INDEXES rather than training corpora —
// OAI-SearchBot's own documentation states that an opted-out site "won't appear
// in ChatGPT search answers" — so refusing them closes a citation channel
// rather than saving bandwidth. They are admitted, verified against the IP
// ranges their vendors publish (Layer 2b), and are deliberately NOT exempted
// from the nav limiter: that limit is the "bounded rate" they are admitted
// under. The training-only crawlers (GPTBot, CCBot, Bytespider, ClaudeBot)
// stay denied, which is a separate and still-sound bandwidth call.
const ALLOWED_UAS = ['googlebot', 'googlebot-image', 'google-inspectiontool', 'storebot-google', 'oai-searchbot', 'bingbot', 'bingpreview', 'perplexitybot'];
const ALLOWED_UA_RE = new RegExp(ALLOWED_UAS.join('|'), 'i');

// Everything else that self-identifies as automated: named AI crawlers,
// non-Google/Bing search engines, backlink/SEO scrapers, headless browsers,
// and plain HTTP client libraries.
//
// `google-extended` and `applebot-extended` are robots.txt CONTROL TOKENS, not
// request user agents — neither company sends a fetch carrying them (Google:
// "Google-Extended doesn't have a separate HTTP request user agent string").
// They cannot match a legitimate request, so these two entries are defence
// against a spoofed UA, not a live block. The real control is the stanza in
// frontend/robots.txt; the real crawl gate for Google is Googlebot, above.
// Note what is NOT here: `oai-searchbot` and `perplexitybot` were removed from
// this list deliberately. They are answer-engine index crawlers, not training
// crawlers, so they now sit in ALLOWED_UAS and are verified by published IP
// range (Layer 2b) instead of refused. Their on-behalf-of-user siblings
// (`chatgpt-user`, `perplexity-user`) and every training crawler stay denied.
const DENY_PATTERNS = [
    /meta-externalagent/i, /facebookbot/i, /gptbot/i, /chatgpt-user/i,
    /anthropic-ai/i, /claudebot/i, /claude-web/i, /claude-user/i, /perplexity-user/i,
    /google-extended/i, /applebot-extended/i, /bytespider/i, /amazonbot/i, /cohere-ai/i, /ccbot/i, /diffbot/i,
    /duckduckbot/i, /yandexbot/i, /baiduspider/i, /applebot/i, /facebookexternalhit/i, /twitterbot/i, /linkedinbot/i, /slackbot/i,
    /semrushbot/i, /ahrefsbot/i, /mj12bot/i, /dotbot/i, /blexbot/i,
    /headlesschrome/i, /phantomjs/i, /puppeteer/i, /playwright/i, /selenium/i,
    /curl\//i, /wget\//i, /python-requests/i, /python-urllib/i, /scrapy/i, /go-http-client/i, /okhttp/i, /postmanruntime/i, /libwww-perl/i, /^java\//i
];

// /mcp is exempt because UA-blocking it is a category error. DENY_PATTERNS names
// `chatgpt-user` and `claude-user` — the agents ChatGPT and claude.ai send when
// fetching ON A USER'S BEHALF — so without this, a customer asking their chatbot
// to call a tool they are paying for is refused at the door, and the keyless
// free tier is unreachable from the two clients it exists to serve. The rule
// those patterns were written for is scraping /stocks/* for training data, which
// is a different act from invoking a metered tool. Nothing is given away by the
// exemption: /mcp serves no crawlable content, authenticates or meters every
// call (mcp-anon.js caps keyless use per IP and globally per day), and is rate
// limited on both paths.
//
// /oauth/* is exempt for the same reason /mcp is, and it is not optional: the
// registration and token-exchange legs of the OAuth flow are BACK-CHANNEL calls
// made by ChatGPT's and claude.ai's own servers, not by the user's browser, so
// they carry no browser headers and are refused by the forged-browser check
// below. /oauth/authorize is the one leg a human actually loads, and it would
// pass on its own — but the flow is worthless if the two machine legs 403.
// Bounded the same way: registration is rate limited, the token endpoint
// requires a valid single-use code plus its PKCE verifier, and the consent
// endpoint requires a signed-in session.
//
// /licensing is exempt for the same reason robots.txt is: an agent refused above
// is pointed at that page by FORBIDDEN_BODY, so it has to be fetchable to be read.
// /api (the developer landing page, NOT the /api/v1 endpoints already covered by
// the first pattern) joins it for the same reason: it is the page a refused
// crawler operator or an arriving developer is sent to, and it is where the
// pricing and the copy-paste key setup live. It carries no data — the exemption
// is a page, not the API itself.
//
// /appsumo/redeem is exempt for the /oauth/* reason, one partner over: it is
// the OAuth redirect_uri registered with AppSumo, and AppSumo's partner portal
// validates it server-side (expects 2xx/3xx) before a listing version can be
// submitted. That validator sends no browser headers, so the forged-browser
// check 403'd it and blocked submission (found 2026-09-23). It serves no
// crawlable content: without a ?code it renders a bare redeem form, and with
// one it needs a valid single-use AppSumo authorization code to do anything.
//
// /docs/api-mcp and /privacy join them for the connector-directory review. A
// listing submission declares a documentation URL and a privacy policy URL, and
// Anthropic's reviewers read both before deciding. DENY_PATTERNS refuses
// `anthropic-ai` and `claudebot`, and the forged-browser check refuses anything
// carrying no browser headers — so both pages answered 403 to the one reader
// whose opinion decides the listing. Same trap as /appsumo/redeem above, one
// partner over. Scoped to these two exact paths (trailing slash tolerated, since
// app.js canonicalises /privacy/ to /privacy) rather than all of /docs/*, so the
// exemption covers the two URLs actually declared and no crawlable data moves:
// both render static prose and neither reads a query parameter.
const EXEMPT_PATH_PATTERNS = [/^\/api\//, /^\/api$/, /^\/mcp$/, /^\/oauth\//, /^\/appsumo\/redeem$/, /^\/robots\.txt$/, /^\/sitemap\.xml$/, /^\/sitemaps\//, /^\/llms.*\.txt$/, /^\/\.well-known\//, /^\/licensing$/, /^\/docs\/api-mcp\/?$/, /^\/privacy\/?$/,
    // IndexNow key file: 32 hex chars at the site root. IndexNow's spec requires
    // this be publicly fetchable, and participants fetch it asynchronously AFTER
    // accepting the POST -- so it must not depend on browser headers. It was
    // missing here, which 403'd the file to every non-browser UA while
    // indexnow-ping.js saw HTTP 200 on the POST and reported success. The
    // failure was silent by construction. It is a public, content-free
    // verification file: no bandwidth or scraping risk in exempting it.
    /^\/[0-9a-f]{32}\.txt$/];

// .json deliberately excluded: it used to let bulk data (the fundamentals
// corpus) skip the nav rate limiter entirely. It's now gated at the app.js
// layer too, but keeping json off this list means any other JSON endpoint
// stays subject to the same per-IP navigation cap as an HTML page.
const STATIC_ASSET_RE = /\.(js|css|png|jpe?g|gif|svg|webp|woff2?|ttf|ico|mp4|xml|txt)$/i;

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
const verdictCache = new Map(); // ip -> { verdict, vendor, expiresAt }
const verifiedIpSet = new Set();
const impostorIpSet = new Set();

function readCachedVerdict(ip) {
    const cached = verdictCache.get(ip);
    return (cached && cached.expiresAt > Date.now()) ? cached : null;
}

function getCachedVerdict(ip) {
    const cached = readCachedVerdict(ip);
    return cached ? cached.verdict : null;
}

// Only Google and Bing are released from the nav limit once verified: their
// crawl is already bounded by their own politeness and by the sitemap, and
// throttling them would cost the indexing this whole file exists to protect.
// The AI answer-engine crawlers admitted in ALLOWED_UAS are verified for a
// different reason — so an impostor cannot take their name and slip past the
// UA deny — and they stay subject to the limit. Keeping those two jobs
// distinct is the point: verification stops impersonation, the limiter bounds
// the bandwidth budget, and neither substitutes for the other.
function isLimiterExempt(ip) {
    const cached = readCachedVerdict(ip);
    return Boolean(cached && cached.verdict === 'verified'
        && (cached.vendor === 'google' || cached.vendor === 'bing'));
}

function cacheVerdict(ip, verdict, vendor) {
    // Never cache 'unknown' — a DNS hiccup should be retried, not remembered
    // as a standing verdict for six hours.
    if (verdict === 'unknown') return;
    verdictCache.set(ip, { verdict, vendor, expiresAt: Date.now() + VERIFY_TTL_MS });
    if (verdict === 'verified') verifiedIpSet.add(ip);
    if (verdict === 'impostor') impostorIpSet.add(ip);
}

const VENDOR_SUFFIXES = {
    google: ['.googlebot.com', '.google.com', '.googleusercontent.com'],
    bing: ['.search.msn.com']
};

// Vendors verified by published IP RANGE instead of reverse DNS (Layer 2b).
// Their own documentation prescribes this method and names no PTR suffix:
// OpenAI serves https://openai.com/searchbot.json, Perplexity serves
// https://perplexity.com/perplexitybot.json. Because they publish no
// reverse-DNS hostname at all, sending them down the PTR+forward-confirm path
// would find no matching suffix and mark a GENUINE crawler an impostor — so
// the range branch in checkCrawlerClaim must be taken first. That failure mode
// was the reason this could not be a two-line change.
const RANGE_VENDORS = {
    openai: { url: 'https://openai.com/searchbot.json', ua: /oai-searchbot/i },
    perplexity: { url: 'https://perplexity.com/perplexitybot.json', ua: /perplexitybot/i }
};

function vendorForUa(ua) {
    const value = String(ua || '').toLowerCase();
    if (value.includes('oai-searchbot')) return 'openai';
    if (value.includes('perplexitybot')) return 'perplexity';
    return (value.includes('bingbot') || value.includes('bingpreview')) ? 'bing' : 'google';
}

function hostnameMatchesVendor(hostname, vendor) {
    const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
    return (VENDOR_SUFFIXES[vendor] || []).some((suffix) => h === suffix.slice(1) || h.endsWith(suffix));
}

// --- Layer 2b: published-range verification for the AI search crawlers ---
// Both vendors ship a flat list of IPv4 prefixes. A prefix list ages, so it is
// re-read on a TTL; a fetch failure keeps the previous list and, on a cold
// start, falls through to 'unseen' — i.e. served but still rate limited. The
// same split Layer 2 makes: an infrastructure failure is never evidence of
// impersonation, only a successful fetch that positively excludes the IP is.
const RANGE_TTL_MS = 6 * 60 * 60 * 1000;
const RANGE_RETRY_MS = 60 * 1000;
const rangeCache = new Map(); // vendor -> { nets, expiresAt, loading }

function ipv4ToInt(ip) {
    const parts = String(ip || '').split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const octet = Number(part);
        if (octet > 255) return null;
        n = (n * 256) + octet;
    }
    return n >>> 0;
}

function parseCidr(cidr) {
    const [addr, lenStr] = String(cidr || '').split('/');
    const base = ipv4ToInt(addr);
    if (base === null) return null;
    const len = Number(lenStr);
    if (!Number.isInteger(len) || len < 0 || len > 32) return null;
    // A /0 shift by 32 is a no-op in JS, so the all-addresses case is explicit.
    const mask = len === 0 ? 0 : (0xFFFFFFFF << (32 - len)) >>> 0;
    return { base: (base & mask) >>> 0, mask };
}

function ipInNets(ip, nets) {
    const n = ipv4ToInt(ip);
    if (n === null || !nets) return false;
    return nets.some(({ base, mask }) => ((n & mask) >>> 0) === base);
}

function loadRanges(vendor) {
    const entry = rangeCache.get(vendor);
    if (entry && (entry.loading || entry.expiresAt > Date.now())) return entry;

    const previous = entry ? entry.nets : null;
    const pending = { nets: previous, expiresAt: 0, loading: true };
    rangeCache.set(vendor, pending);

    fetch(RANGE_VENDORS[vendor].url, { signal: AbortSignal.timeout(10000) })
        .then((res) => (res.ok ? res.json() : null))
        .then((json) => {
            const nets = ((json && json.prefixes) || [])
                .map((p) => parseCidr(p.ipv4Prefix)).filter(Boolean);
            // An empty or unparseable list is treated as a failed fetch, never
            // as "this vendor owns no addresses" — the latter would 403 every
            // genuine request.
            rangeCache.set(vendor, {
                nets: nets.length ? nets : previous,
                expiresAt: Date.now() + (nets.length ? RANGE_TTL_MS : RANGE_RETRY_MS),
                loading: false
            });
        })
        .catch(() => {
            rangeCache.set(vendor, {
                nets: previous,
                expiresAt: Date.now() + RANGE_RETRY_MS,
                loading: false
            });
        });

    return pending;
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
    cacheVerdict(ip, verdict, vendor);
    return verdict;
}

// Fails open on an unseen IP: the first request from it is served while
// verification happens in the background, because blocking real Googlebot
// over a slow DNS response costs far more than the handful of requests an
// impostor gets in the meantime. It stays rate limited either way, so the
// window is bounded.
function checkCrawlerClaim(ip, ua) {
    const cached = getCachedVerdict(ip);
    if (cached) return cached;

    const vendor = vendorForUa(ua);

    // Range-verified vendors never touch DNS — they publish no PTR suffix, so
    // the reverse lookup could only ever produce a false 'impostor'.
    if (RANGE_VENDORS[vendor]) {
        const entry = loadRanges(vendor);
        // Cold start, or a fetch in flight with nothing cached: serve the
        // request and let the limiter bound it, exactly as Layer 2 does.
        if (!entry || !entry.nets) return 'unseen';
        const verdict = ipInNets(ip, entry.nets) ? 'verified' : 'impostor';
        cacheVerdict(ip, verdict, vendor);
        return verdict;
    }

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
    keyGenerator: (req) => clientIp(req),
    skip: (req) => isStaticAssetPath(req.path) || isLimiterExempt(clientIp(req)),
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
            const verdict = checkCrawlerClaim(clientIp(req), ua);
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

// Seam for the limiter-asymmetry test. Verification is otherwise only reachable
// through DNS or an HTTP fetch; seeding the cache lets the test assert which
// vendors the limiter releases without standing up either.
function _seedVerdictForTest(ip, verdict, vendor) {
    cacheVerdict(ip, verdict, vendor);
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
    isLimiterExempt,
    vendorForUa,
    parseCidr,
    ipInNets,
    RANGE_VENDORS,
    _resetForTest,
    _seedVerdictForTest
};
