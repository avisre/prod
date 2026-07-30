'use strict';

// First-party, privacy-conscious marketing traffic classification.
//
// The anonymous session cookie is signed so callers cannot manufacture large
// numbers of "unique" sessions by supplying arbitrary cookie values. It holds
// no PII. The QA cookie is also signed and can only be enabled by the protected
// admin route in app.js (or by the optional secret header used by smoke tests).

const crypto = require('crypto');

const SESSION_COOKIE_NAME = 'sp_mkt_sid';
const QA_COOKIE_NAME = 'sp_mkt_qa';
const SESSION_MAX_AGE_SECONDS = 30 * 60;
const QA_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const SESSION_ID_RE = /^[A-Za-z0-9_-]{16}$/;

function safeEqual(left, right) {
    const a = Buffer.from(String(left || ''));
    const b = Buffer.from(String(right || ''));
    return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signature(payload, secret) {
    return crypto.createHmac('sha256', String(secret || ''))
        .update(payload)
        .digest('base64url')
        .slice(0, 22);
}

function parseCookies(header) {
    const cookies = new Map();
    for (const part of String(header || '').split(';')) {
        const index = part.indexOf('=');
        if (index <= 0) continue;
        const name = part.slice(0, index).trim();
        let value = part.slice(index + 1).trim();
        try { value = decodeURIComponent(value); } catch (_) { /* keep raw */ }
        if (name) cookies.set(name, value);
    }
    return cookies;
}

function cookieDomain(hostname) {
    const host = String(hostname || '').trim().toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
    return host === 'stockportfolio.pro' || host.endsWith('.stockportfolio.pro')
        ? 'stockportfolio.pro'
        : null;
}

function serializeCookie(name, value, {
    maxAgeSeconds,
    secure = true,
    domain = null,
    httpOnly = true
} = {}) {
    const parts = [
        `${name}=${encodeURIComponent(String(value || ''))}`,
        `Max-Age=${Math.max(0, Math.floor(Number(maxAgeSeconds) || 0))}`,
        'Path=/',
        'SameSite=Lax'
    ];
    if (httpOnly) parts.push('HttpOnly');
    if (domain) parts.push(`Domain=${domain}`);
    if (secure) parts.push('Secure');
    return parts.join('; ');
}

function appendSetCookie(res, value) {
    if (!res || !value || res.headersSent) return;
    const existing = res.getHeader('Set-Cookie');
    const values = existing == null ? [] : (Array.isArray(existing) ? existing : [existing]);
    res.setHeader('Set-Cookie', [...values, value]);
}

function createSessionValue({ secret, now = Date.now(), sessionId } = {}) {
    if (!secret) return null;
    const id = String(sessionId || crypto.randomBytes(12).toString('base64url'));
    if (!SESSION_ID_RE.test(id)) return null;
    const timestamp = Math.floor(Number(now) / 1000);
    if (!Number.isInteger(timestamp) || timestamp <= 0) return null;
    const payload = `v1.${timestamp}.${id}`;
    return `${payload}.${signature(payload, secret)}`;
}

function parseSessionValue(value, {
    secret,
    now = Date.now(),
    maxAgeSeconds = SESSION_MAX_AGE_SECONDS
} = {}) {
    if (!secret) return null;
    const parts = String(value || '').split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const timestamp = Number(parts[1]);
    const id = parts[2];
    if (!Number.isInteger(timestamp) || !SESSION_ID_RE.test(id)) return null;
    const nowSeconds = Math.floor(Number(now) / 1000);
    if (timestamp > nowSeconds + 300 || nowSeconds - timestamp > maxAgeSeconds) return null;
    const payload = parts.slice(0, 3).join('.');
    if (!safeEqual(parts[3], signature(payload, secret))) return null;
    return { sessionId: id, startedAt: new Date(timestamp * 1000) };
}

function createQaValue({ secret, now = Date.now() } = {}) {
    if (!secret) return null;
    const timestamp = Math.floor(Number(now) / 1000);
    const payload = `v1.${timestamp}`;
    return `${payload}.${signature(`qa.${payload}`, secret)}`;
}

function parseQaValue(value, { secret, now = Date.now() } = {}) {
    if (!secret) return false;
    const parts = String(value || '').split('.');
    if (parts.length !== 3 || parts[0] !== 'v1') return false;
    const timestamp = Number(parts[1]);
    const nowSeconds = Math.floor(Number(now) / 1000);
    if (!Number.isInteger(timestamp) || timestamp > nowSeconds + 300 || nowSeconds - timestamp > QA_MAX_AGE_SECONDS) return false;
    const payload = parts.slice(0, 2).join('.');
    return safeEqual(parts[2], signature(`qa.${payload}`, secret));
}

function classifyUserAgent(value) {
    const userAgent = String(value || '').slice(0, 320);
    if (!userAgent) return { userAgent, trafficClass: 'unknown', isBot: true, estimatedHuman: false };
    if (/headless|lighthouse|selenium|playwright|puppeteer|phantomjs|pagespeed|curl\b|wget\b|postmanruntime/i.test(userAgent)) {
        return { userAgent, trafficClass: 'automation', isBot: true, estimatedHuman: false };
    }
    if (/bot\b|crawl|spider|slurp|facebookexternalhit|preview|googlebot|bingbot|duckduckbot|baiduspider|yandexbot|twitterbot|linkedinbot|discordbot|whatsapp/i.test(userAgent)) {
        return { userAgent, trafficClass: 'crawler', isBot: true, estimatedHuman: false };
    }
    const browser = /mozilla\/5\.0/i.test(userAgent)
        && /chrome|crios|firefox|fxios|safari|edg|opr|samsungbrowser/i.test(userAgent);
    return {
        userAgent,
        trafficClass: browser ? 'browser' : 'unknown',
        isBot: !browser,
        estimatedHuman: browser
    };
}

function sanitizeReferrer(value) {
    try {
        const url = new URL(String(value || ''));
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return null;
        return `${url.origin}${url.pathname}`.slice(0, 400);
    } catch (_) {
        return null;
    }
}

function referrerSource(value) {
    try {
        const host = new URL(String(value || '')).hostname.toLowerCase().replace(/^www\./, '');
        if (host === 'google.com' || host.endsWith('.google.com')) return 'google';
        if (host === 'bing.com' || host.endsWith('.bing.com')) return 'bing';
        if (host === 'duckduckgo.com' || host.endsWith('.duckduckgo.com')) return 'duckduckgo';
        if (host === 'x.com' || host === 'twitter.com' || host.endsWith('.x.com') || host.endsWith('.twitter.com')) return 'x';
        if (host === 'linkedin.com' || host.endsWith('.linkedin.com')) return 'linkedin';
        if (host === 'reddit.com' || host.endsWith('.reddit.com')) return 'reddit';
        if (host === 'stockportfolio.pro' || host.endsWith('.stockportfolio.pro')) return 'internal';
        return host ? 'referral' : 'direct';
    } catch (_) {
        return 'direct';
    }
}

function qaHeaderMatches(req, expectedToken) {
    if (!expectedToken) return false;
    return safeEqual(req && req.headers && req.headers['x-marketing-qa-token'], expectedToken);
}

function qaModeFromRequest(req, { secret, qaToken, now = Date.now() } = {}) {
    if (qaHeaderMatches(req, qaToken)) return true;
    const value = parseCookies(req && req.headers && req.headers.cookie).get(QA_COOKIE_NAME);
    return parseQaValue(value, { secret, now });
}

function requestFields(req, res, {
    secret,
    qaToken,
    now = Date.now(),
    secure = process.env.NODE_ENV === 'production'
} = {}) {
    if (req && req._marketingRequestFields) return req._marketingRequestFields;
    const cookies = parseCookies(req && req.headers && req.headers.cookie);
    let session = parseSessionValue(cookies.get(SESSION_COOKIE_NAME), { secret, now });
    if (!session) {
        const value = createSessionValue({ secret, now });
        session = parseSessionValue(value, { secret, now });
        if (value) appendSetCookie(res, serializeCookie(SESSION_COOKIE_NAME, value, {
            maxAgeSeconds: SESSION_MAX_AGE_SECONDS,
            secure,
            domain: cookieDomain(req && req.hostname)
        }));
    }
    const ua = classifyUserAgent(req && req.headers && req.headers['user-agent']);
    const referrer = sanitizeReferrer(req && (req.headers.referer || req.headers.referrer));
    const isQa = qaModeFromRequest(req, { secret, qaToken, now });
    const fields = {
        anonymousSessionId: session ? session.sessionId : null,
        sessionStartedAt: session ? session.startedAt : null,
        referrer,
        referrerSource: referrerSource(referrer),
        userAgent: ua.userAgent,
        trafficClass: ua.trafficClass,
        isBot: ua.isBot,
        estimatedHuman: ua.estimatedHuman,
        isQa,
        reportable: ua.estimatedHuman && !isQa
    };
    if (req) req._marketingRequestFields = fields;
    return fields;
}

function setQaModeCookie(res, enabled, {
    secret,
    secure = process.env.NODE_ENV === 'production',
    domain = null,
    now = Date.now()
} = {}) {
    const value = enabled ? createQaValue({ secret, now }) : '';
    appendSetCookie(res, serializeCookie(QA_COOKIE_NAME, value, {
        maxAgeSeconds: enabled ? QA_MAX_AGE_SECONDS : 0,
        secure,
        domain
    }));
}

module.exports = {
    SESSION_COOKIE_NAME,
    QA_COOKIE_NAME,
    SESSION_MAX_AGE_SECONDS,
    QA_MAX_AGE_SECONDS,
    classifyUserAgent,
    sanitizeReferrer,
    referrerSource,
    createSessionValue,
    parseSessionValue,
    createQaValue,
    parseQaValue,
    qaModeFromRequest,
    requestFields,
    setQaModeCookie,
    cookieDomain
};
