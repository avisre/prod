const express = require('express');
const path = require('path');
const fs = require('fs');
const dns = require('dns').promises;
const net = require('net');
const mongoose = require('mongoose');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const argon2 = require('argon2');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const Stripe = require('stripe');
const { OAuth2Client } = require('google-auth-library');
const YahooFinance = require('yahoo-finance2').default;
const yahooFinance = new YahooFinance({ suppressNotices: ['yahooSurvey', 'ripHistorical'] });
const yahooSource = require('./yahoo-source');
const fxConversion = require('./fx-conversion');
const assetProfile = require('./asset-profile');
const secSource = require('./sec-source');
const aiBriefing = require('./ai-briefing');
const aiFeatures = require('./ai-features');
const aiChat = require('./ai-chat');
const shareCopy = require('./share-copy');
const freeTools = require('./free-tools');
const marketingAttribution = require('./marketing-attribution');
const growthMeasurement = require('./growth-measurement');
const ga4Server = require('./ga4-server');
const xray = require('./xray');
const watchdog = require('./watchdog');
const reverseDcf = require('./reverse-dcf');
const monitorFreeUsage = require('./monitor-free-usage');
const ollamaUsage = require('./ollama-usage-tracker');
const affiliateProgram = require('./affiliate-program');
const dealMirror = require('./dealmirror');
const augustCampaign = require('./august-campaign');
const { safeUpper, isValidTicker, normalizeTicker } = require('./symbol-resolver');
require('dotenv').config();

// Optional, first-party post-purchase attribution question. This is deliberately
// separate from the signed campaign cookie: a buyer may purchase on another
// device or discover the product inside AppSumo itself.
const APPSUMO_DISCOVERY_SOURCES = new Set([
    'appsumo', 'x', 'linkedin', 'youtube', 'google', 'newsletter',
    'friend', 'other'
]);
function normalizeAppSumoDiscoverySource(value) {
    const source = String(value || '').trim().toLowerCase();
    return APPSUMO_DISCOVERY_SOURCES.has(source) ? source : null;
}

// Tier ladder: free < core < pro.
//   free — public research surfaces and any explicitly grandfathered account.
//   core — any active paying plan (monthly/annual): portfolio, fundamentals, alerts, X-Ray.
//   pro  — pro / pro-annual: full Ask quota + AI intelligence features.
// AI_PRO_FOR_ALL=true lifts every active paying subscriber to pro (the legacy
// behavior, useful for grandfathering early subscribers); default is false now
// that the Pro tier has real teeth (Filing Diff, attribution, smart alerts,
// wash-sale guard, segments, insights, 300 Ask).
const AI_PRO_FOR_ALL = process.env.AI_PRO_FOR_ALL === 'true';
function userTier(user, subscription) {
    const sub = subscription || (user && user.subscription) || {};
    const planId = sub.planId || '';
    const active = ['active', 'trialing', 'cancel_at_period_end'].includes(sub.status);
    if (active && (planId === 'pro' || planId === 'pro-annual' || planId === 'power' || planId === 'power-monthly' || planId === 'desk')) return 'pro';
    if (active && planId !== 'free') return AI_PRO_FOR_ALL ? 'pro' : 'core';
    if (active && planId === 'free') return 'free';
    // pending / cancelled / expired: prod downgrades to the free tier instead
    // of a blanket 402; dev (REQUIRE_ACTIVE_SUBSCRIPTION unset) stays permissive.
    return REQUIRE_ACTIVE_SUBSCRIPTION ? 'free' : (AI_PRO_FOR_ALL ? 'pro' : 'core');
}
function isProUser(req) {
    return (req.tier || userTier(req.user, req.subscription)) === 'pro';
}
function coreGate(req, res, next) {
    const tier = req.tier || userTier(req.user, req.subscription);
    if (tier === 'core' || tier === 'pro') return next();
    return res.status(402).json({
        message: 'This feature needs a subscription. Choose a plan to unlock it.',
        code: 'SUBSCRIPTION_REQUIRED'
    });
}
function proGate(req, res, next) {
    if (isProUser(req)) return next();
    return res.status(402).json({ message: 'This is a Pro feature. Upgrade to Pro to use the AI assistant.', code: 'PRO_REQUIRED' });
}
// The Filing Change Monitor is the Power/Desk differentiator — NOT included in
// the $33 Pro tier (which keeps per-holding Filing Diff). Plan-based, so it
// doesn't disturb the free<core<pro ladder every other gate relies on.
function hasMonitor(req) {
    const sub = req.subscription || (req.user && req.user.subscription) || {};
    const active = ['active', 'trialing', 'cancel_at_period_end'].includes(sub.status);
    return active && ['power', 'power-monthly', 'desk', 'enterprise'].includes(sub.planId);
}
function monitorGate(req, res, next) {
    if (hasMonitor(req)) return next();
    return res.status(402).json({ message: 'The Filing Change Monitor is on the Power and Desk plans.', code: 'MONITOR_REQUIRED' });
}
require('dotenv').config({ path: path.join(__dirname, 'prod.env') });

async function presentFundamentalsCurrency(payload, requestedCurrency) {
    if (String(requestedCurrency || '').trim().toUpperCase() !== 'USD') return payload;
    try {
        return await fxConversion.convertPayloadToUsd(payload);
    } catch (error) {
        // A missing FX series must never make the underlying filing data
        // unavailable or, worse, cause it to be labelled as USD. Return the
        // untouched native-currency payload with a safe status for the UI.
        return {
            ...payload,
            currencyConversion: {
                status: 'unavailable',
                to: 'USD',
                message: 'USD conversion is temporarily unavailable; figures remain in the company reporting currency.'
            }
        };
    }
}

const mailer = require('./mailer');
const { sendNewUserEmails, escapeHtml } = mailer;

const app = express();
// Give every request a correlation id before authentication and route handlers
// run. The shared AI client uses this async context to attribute provider calls
// to the authenticated user without recording prompts or response contents.
app.use((req, res, next) => ollamaUsage.runRequest(req, next));
// Render's Hobby request-log metrics do not expose route-level breakdowns.
// Emit a bounded, query-free status sample so 4xx/5xx paths can be identified
// from application logs without recording query strings, cookies, IPs or PII.
const statusLogWindow = { startedAt: 0, count: 0 };
app.use((req, res, next) => {
    res.on('finish', () => {
        if (res.statusCode < 400) return;
        const now = Date.now();
        if (now - statusLogWindow.startedAt >= 60 * 1000) {
            statusLogWindow.startedAt = now;
            statusLogWindow.count = 0;
        }
        if (statusLogWindow.count >= 100) return;
        statusLogWindow.count++;
        console.warn('[http-status]', JSON.stringify({
            status: res.statusCode,
            method: req.method,
            path: req.path || '/'
        }));
    });
    next();
});
// Render terminates the public connection before forwarding it to Express.
// Trust that single platform hop in production so rate limits are keyed to
// the visitor address instead of grouping every visitor under Render's proxy.
// Local/test environments remain untrusted unless explicitly configured.
const DEFAULT_TRUST_PROXY_HOPS = process.env.NODE_ENV === 'production' ? '1' : '0';
const TRUST_PROXY_HOPS = Math.max(0, Number.parseInt(process.env.TRUST_PROXY_HOPS || DEFAULT_TRUST_PROXY_HOPS, 10) || 0);
app.set('trust proxy', TRUST_PROXY_HOPS || false);
app.disable('x-powered-by');

const AUTH_COOKIE_NAME = 'sp_auth';
const AUTH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;
function parseCookieHeader(header = '') {
  const out = {};
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    const key = part.slice(0, i).trim();
    try { out[key] = decodeURIComponent(part.slice(i + 1).trim()); } catch (_) { out[key] = part.slice(i + 1).trim(); }
  }
  return out;
}
function authTokenFromRequest(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (match && match[1] && !['null', 'undefined', 'cookie'].includes(match[1])) return match[1];
  return parseCookieHeader(req.headers.cookie || '')[AUTH_COOKIE_NAME] || '';
}
function authCookieDomain(req) {
  const host = String(req && req.headers && req.headers.host || '').split(':')[0].toLowerCase();
  return host === 'stockportfolio.pro' || host.endsWith('.stockportfolio.pro') ? '; Domain=.stockportfolio.pro' : '';
}
function setAuthCookie(res, token, req) {
  if (!token) return;
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const domain = authCookieDomain(req);
  const common = `Max-Age=${AUTH_COOKIE_MAX_AGE}; Path=/; SameSite=Lax${secure}`;
  // Clear legacy host-only cookies before setting the shared apex-domain
  // cookies, otherwise browsers can retain two values with the same name.
  res.append('Set-Cookie', `${AUTH_COOKIE_NAME}=; Max-Age=0; Path=/; SameSite=Lax${secure}`);
  res.append('Set-Cookie', `sp_logged_in=; Max-Age=0; Path=/; SameSite=Lax${secure}`);
  res.append('Set-Cookie', `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}; ${common}; HttpOnly${domain}`);
  res.append('Set-Cookie', `sp_logged_in=1; ${common}${domain}`);
}
function clearAuthCookie(res, req) {
  const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
  const domain = authCookieDomain(req);
  res.append('Set-Cookie', `${AUTH_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}`);
  res.append('Set-Cookie', `sp_logged_in=; Max-Age=0; Path=/; SameSite=Lax${secure}`);
  if (domain) {
    res.append('Set-Cookie', `${AUTH_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax${secure}${domain}`);
    res.append('Set-Cookie', `sp_logged_in=; Max-Age=0; Path=/; SameSite=Lax${secure}${domain}`);
  }
}
app.use((req, res, next) => {
  const json = res.json.bind(res);
  res.json = (body) => {
    if (body && typeof body.token === 'string' && body.token) setAuthCookie(res, body.token, req);
    return json(body);
  };
  next();
});
const jsonParser = express.json();
function isRawBodyWebhookPath(requestPath) {
  // Express routes accept a trailing slash by default. Keep the body-parser
  // bypass in sync with that behaviour or `/appsumo/webhook/` gets parsed as
  // JSON first, leaving no raw bytes for HMAC verification.
  const normalizedPath = String(requestPath || '').replace(/\/+$/, '') || '/';
  return normalizedPath === '/stripe/webhook' || normalizedPath === '/appsumo/webhook';
}
app.use((req, res, next) => {
  // Stripe and AppSumo webhooks need the raw, unparsed body for HMAC signature
  // verification — let them skip the JSON parser and read the buffer themselves.
  // Use req.path so a harmless query string or trailing slash cannot change how
  // the request body is parsed.
  if (isRawBodyWebhookPath(req.path)) {
    next();
  } else {
    jsonParser(req, res, (err) => {
      if (err) {
        return res.status(400).json({ message: 'Invalid JSON payload' });
      }
      next();
    });
  }
});
// The frontend is served same-origin by this app, so browser API calls need no
// CORS grant. Restrict cross-origin reads to the known site origins (override
// via CORS_ORIGINS); requests with no Origin header (curl, server-to-server,
// health checks) are allowed through.
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS
  || 'https://stockportfolio.pro,https://www.stockportfolio.pro,http://localhost:3000')
  .split(',').map((s) => s.trim()).filter(Boolean);
app.use(cors({
  origin(origin, cb) {
    if (!origin || ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
    return cb(null, false);
  }
}));
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      defaultSrc: ["'self'"],
      // Google Analytics/Clarity are loaded dynamically after the visitor
      // grants analytics consent. Keep the origins explicit so the CSP does
      // not silently block the measurement script on production pages.
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        'https://accounts.google.com',
        'https://www.googletagmanager.com',
        'https://www.clarity.ms',
        'https://scripts.clarity.ms'
      ],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://accounts.google.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'https:'],
      frameSrc: ["'self'", 'https://accounts.google.com', 'https://www.youtube.com', 'https://www.youtube-nocookie.com'],
      objectSrc: ["'none'"], baseUri: ["'self'"], formAction: ["'self'"], frameAncestors: ["'self'"]
    }
  },
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  // helmet's no-referrer default breaks YouTube embeds (error 153);
  // strict-origin-when-cross-origin is the modern browser default.
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));
// gzip public HTML/CSS/JS and JSON API responses (Core Web Vitals / crawl
// speed). Only streaming responses are excluded: compressing SSE can delay
// heartbeats and make a long-lived Ask/usage stream appear stalled.
app.use(compression({
  filter: (req, res) => {
    if (req.path === '/api/admin/ollama/usage/stream') return false;
    if (req.path === '/api/ai/chat' && req.body && req.body.stream === true) return false;
    return compression.filter(req, res);
  }
}));

// The public, unauthenticated page-view beacon gets its own tight per-IP cap
// so a flood can't spend the shared /api budget or pile unbounded writes into
// funnel_events. A real researcher fires ~1 beacon per page; 120/15min is far
// above honest use and hard below abuse. Beacons are dropped past the cap —
// fine for fire-and-forget analytics.
const pageViewLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/track/page_view', pageViewLimiter);

const freeToolLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false
});

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // v2 pages fan out ~9 API calls each — 300 allowed only ~33 page views
  // per window for a legitimate researcher. 900 still throttles abuse.
  max: 900,
  standardHeaders: true,
  legacyHeaders: false,
  // the beacon has its own limiter above — don't let it spend this budget too
  skip: (req) => req.path === '/track/page_view'
});
app.use('/api', apiLimiter);

// Forgot-password requests send an email, so throttle them hard per IP to
// prevent inbox flooding and slow down enumeration probing. 5 per 15 min is
// far above any legitimate need. Mounted after the general limiter so both apply.
const passwordResetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/password/forgot', passwordResetLimiter);

// /reset carries a token guess. Tokens are 256-bit random + single-use, so
// brute force isn't feasible, but throttle per IP anyway so the endpoint can't
// be hammered and to keep symmetry with /forgot. Slightly higher cap leaves
// room for a user fumbling the password-policy check a couple of times.
const passwordResetConfirmLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/password/reset', passwordResetConfirmLimiter);

// Auth + abuse-prone endpoints. Login and password-change are credential-
// guessing surfaces; support and check-email can be abused for inbox spam and
// account enumeration. All fall under the general 900/15min limiter, but these
// need far tighter per-IP caps than a normal read.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/login', loginLimiter);
app.use('/api/password/change', loginLimiter);

const supportLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/support', supportLimiter);

const shareCopyLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/ai/share-copy', shareCopyLimiter);

// Creating a durable public report is intentionally user-triggered and cheap,
// but it is also an unauthenticated write surface (sample research can be
// shared while logged out). Keep it well below normal read traffic so it cannot
// become a content-spam sink.
const researchShareCreateLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: shareCopy.PUBLIC_SHARE_CREATE_LIMIT_PER_HOUR,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/research-shares', researchShareCreateLimiter);

// Ambassador redirects are a public write surface (one durable click record
// per request). The feature flag is evaluated per request so leaving the
// feature disabled does not consume limiter budget.
const affiliateReferralLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  skip: (req) => !affiliateProgram.isEnabled() || !String(req.path || '').startsWith('/r/amb-')
});

const checkEmailLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/check-email', checkEmailLimiter);

// Signups create an account AND fire a welcome email to an unverified address,
// which makes /api/subscribe a spam relay if left open (observed Jul 2026: a
// form bot registered strangers' addresses — dotted-gmail victims and
// phone-number@SMS-gateway addresses — one every ~2h, so the welcome email
// became the spam payload). 5/hour per IP is far above honest use.
const subscribeLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/subscribe', subscribeLimiter);

// Code redemption is deliberately much tighter than the normal API limit.
// A valid code still cannot be enumerated because all invalid states use the
// same response and code material is hashed before database lookup.
const dealMirrorRedeemLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false,
  keyGenerator: (req) => `${req.userId || 'anon'}:${crypto.createHash('sha256').update(String(req.ip || '')).digest('hex').slice(0, 20)}`
});

// Alpha Vantage is no longer used — all market data is served from
// Yahoo Finance via backend/yahoo-source.js. The env var is kept here
// only so existing deployments don't reject unrecognised settings.
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV !== 'production' ? require('crypto').randomBytes(32).toString('hex') : '');
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is required when NODE_ENV=production');
}
const alphaResponseCache = new Map();
const EXPECTED_STRIPE_ACCOUNT_ID = process.env.STRIPE_ACCOUNT_ID || 'acct_1TDj4gAUeKapY1OP';
const MONTHLY_PLAN_ID = 'monthly';
const ANNUAL_PLAN_ID = 'annual';
const PRO_PLAN_ID = 'pro';
const PRO_ANNUAL_PLAN_ID = 'pro-annual';
const FREE_PLAN_ID = 'free';
const CORE_PLAN_PRICE = parseFloat(process.env.CORE_PLAN_PRICE || '12.00');
const CORE_PLAN_CURRENCY = process.env.CORE_PLAN_CURRENCY || 'USD';
const ANNUAL_PLAN_PRICE = parseFloat(process.env.ANNUAL_PLAN_PRICE || '118.00');
const ANNUAL_PLAN_CURRENCY = process.env.ANNUAL_PLAN_CURRENCY || CORE_PLAN_CURRENCY;
const PRO_PLAN_PRICE = parseFloat(process.env.PRO_PLAN_PRICE || '33.00');
const PRO_ANNUAL_PLAN_PRICE = parseFloat(process.env.PRO_ANNUAL_PLAN_PRICE || '250.00');
// Premium annual tiers for the Filing Monitor launch — both unlock the full
// Pro feature set; differ only by price/positioning/support. USD, billed yearly.
const POWER_PLAN_ID = 'power';
const DESK_PLAN_ID = 'desk';
const POWER_PLAN_PRICE = parseFloat(process.env.POWER_PLAN_PRICE || '579.00');
const POWER_PLAN_CURRENCY = process.env.POWER_PLAN_CURRENCY || 'USD';
// Power, billed monthly — same access as annual Power, lower activation friction
// for pros who won't commit $579 upfront. $64/mo ≈ $774/yr, so annual is a clear
// 25% saving. Same Monitor unlock as annual Power.
const POWER_MONTHLY_PLAN_ID = 'power-monthly';
const POWER_MONTHLY_PLAN_PRICE = parseFloat(process.env.POWER_MONTHLY_PLAN_PRICE || '64.00');
const POWER_MONTHLY_PLAN_CURRENCY = process.env.POWER_MONTHLY_PLAN_CURRENCY || 'USD';
const DESK_PLAN_PRICE = parseFloat(process.env.DESK_PLAN_PRICE || '1961.00');
const DESK_PLAN_CURRENCY = process.env.DESK_PLAN_CURRENCY || 'USD';
const TRIAL_DAYS = parseInt(process.env.TRIAL_DAYS || '7', 10);
const stripeSecretKey = process.env.STRIPE_SECRET_KEY;
const STRIPE_SUCCESS_URL = process.env.STRIPE_SUCCESS_URL || '';
const STRIPE_CANCEL_URL = process.env.STRIPE_CANCEL_URL || '';
// New self-serve registrations are paid at checkout. Keep this as an
// explicit escape hatch for a controlled rollback or local test environment;
// production defaults to the paid-first policy when the variable is absent.
const REQUIRE_INITIAL_STRIPE_PAYMENT = String(process.env.REQUIRE_INITIAL_STRIPE_PAYMENT ?? 'true').toLowerCase() !== 'false';
const INITIAL_REFUND_DAYS = Math.max(1, Math.min(30, Number.parseInt(process.env.INITIAL_REFUND_DAYS || '7', 10) || 7));
const INITIAL_REFUND_WINDOW_MS = INITIAL_REFUND_DAYS * 24 * 60 * 60 * 1000;
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const STRIPE_PUBLISHABLE_KEY = process.env.STRIPE_PUBLISHABLE_KEY || '';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const STRIPE_PRICE_ID_MONTHLY = process.env.STRIPE_PRICE_ID_MONTHLY || STRIPE_PRICE_ID || '';
const STRIPE_PRICE_ID_ANNUAL = process.env.STRIPE_PRICE_ID_ANNUAL || '';
const STRIPE_PRICE_ID_PRO = process.env.STRIPE_PRICE_ID_PRO || '';
const STRIPE_PRICE_ID_PRO_ANNUAL = process.env.STRIPE_PRICE_ID_PRO_ANNUAL || '';
const STRIPE_PRICE_ID_POWER = process.env.STRIPE_PRICE_ID_POWER || '';
const STRIPE_PRICE_ID_POWER_MONTHLY = process.env.STRIPE_PRICE_ID_POWER_MONTHLY || '';
const STRIPE_PRICE_ID_DESK = process.env.STRIPE_PRICE_ID_DESK || '';
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID || '';
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET || '';
// AppSumo Licensing API v2 (lifetime-deal redemption). Credentials come from the
// AppSumo Partner Portal once both URLs are validated: API key (webhook HMAC +
// Licensing API), and OAuth client_id/secret. REDIRECT_URI must match the portal
// exactly. When APPSUMO_API_KEY is unset, the webhook still returns 200 for
// AppSumo's URL-validation test events but skips HMAC enforcement.
const APPSUMO_API_KEY = process.env.APPSUMO_API_KEY || '';
const APPSUMO_CLIENT_ID = process.env.APPSUMO_CLIENT_ID || '';
const APPSUMO_CLIENT_SECRET = process.env.APPSUMO_CLIENT_SECRET || '';
const APPSUMO_REDIRECT_URI = process.env.APPSUMO_REDIRECT_URI || 'https://www.stockportfolio.pro/appsumo/redeem';
// Product slug on appsumo.com (set once the deal is live) — used to deep-link the
// review form. Until it's known, fall back to the buyer's AppSumo purchases page,
// which is always valid and lets them navigate to the product to review/upgrade.
const APPSUMO_PRODUCT_SLUG = process.env.APPSUMO_PRODUCT_SLUG || '';
const APPSUMO_ACCOUNT_URL = 'https://appsumo.com/account/products/';
const APPSUMO_OUTBOUND_URL = shareCopy.resolveAppSumoRedirect(process.env.APPSUMO_ATTRIBUTED_URL);
const PUBLIC_APP_URL = shareCopy.normalizePublicBaseUrl(process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro');
const MARKETING_QA_TOKEN = process.env.MARKETING_QA_TOKEN || '';
const missingAppSumoConfig = [
  !APPSUMO_API_KEY && 'APPSUMO_API_KEY',
  !APPSUMO_CLIENT_ID && 'APPSUMO_CLIENT_ID',
  !APPSUMO_CLIENT_SECRET && 'APPSUMO_CLIENT_SECRET'
].filter(Boolean);
if (missingAppSumoConfig.length) {
  console.warn(`[appsumo] integration incomplete; missing ${missingAppSumoConfig.join(', ')}`);
}
function appsumoReviewUrl() {
    return APPSUMO_PRODUCT_SLUG ? `https://appsumo.com/products/${APPSUMO_PRODUCT_SLUG}/#reviews` : APPSUMO_ACCOUNT_URL;
}
// Per-license upgrade URL comes from AppSumo (license_change_plan_url) when present;
// otherwise the buyer manages/upgrades tiers from their AppSumo purchases page.
function appsumoUpgradeUrl(lic) {
    return (lic && lic.changePlanUrl) || APPSUMO_ACCOUNT_URL;
}
const stripe = stripeSecretKey ? Stripe(stripeSecretKey, { apiVersion: '2022-11-15' }) : null;
const googleOauthClient = GOOGLE_CLIENT_ID ? new OAuth2Client(GOOGLE_CLIENT_ID) : null;
const REQUIRE_ACTIVE_SUBSCRIPTION = process.env.REQUIRE_ACTIVE_SUBSCRIPTION === 'true';
const stripeAccountPreflight = {
  checkedAt: 0,
  accountId: '',
  ok: false
};
const GOOGLE_ALLOWED_HOSTS = String(
  process.env.GOOGLE_ALLOWED_HOSTS || 'stockportfolio.pro,www.stockportfolio.pro'
)
  .split(',')
  .map((value) => value.trim().toLowerCase())
  .filter(Boolean);
const NEWS_IMAGE_PROXY_TIMEOUT_MS = 5000;
const NEWS_IMAGE_PROXY_MAX_BYTES = 5 * 1024 * 1024;
const NEWS_IMAGE_ALLOWED_HOSTS = String(process.env.NEWS_IMAGE_ALLOWED_HOSTS || '*.yimg.com,*.yahoo.com,*.yahooapis.com')
  .split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);

function getRequestHostname(req) {
  const forwardedHost = String(req?.headers?.['x-forwarded-host'] || '')
    .split(',')[0]
    .trim();
  const rawHost = forwardedHost || String(req?.headers?.host || req?.get?.('host') || '').trim();
  return rawHost.replace(/:\d+$/, '').toLowerCase();
}

function hostMatchesAllowedPattern(hostname, pattern) {
  const host = String(hostname || '').trim().toLowerCase();
  const rule = String(pattern || '').trim().toLowerCase();
  if (!host || !rule) return false;
  if (rule.startsWith('*.')) {
    const suffix = rule.slice(1);
    return host.endsWith(suffix);
  }
  return host === rule;
}

function isGoogleHostAllowed(req) {
  if (!GOOGLE_CLIENT_ID) return false;
  if (!GOOGLE_ALLOWED_HOSTS.length) return true;
  const host = getRequestHostname(req);
  return GOOGLE_ALLOWED_HOSTS.some((rule) => hostMatchesAllowedPattern(host, rule));
}

function scrubDnsRecord(value = '') {
  return String(value || '').trim().replace(/^"+|"+$/g, '').replace(/\.$/, '');
}

function isMongoSrvResolutionError(error) {
  const code = String(error?.code || '').toUpperCase();
  const message = String(error?.message || '').toLowerCase();
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEOUT' ||
    message.includes('querysrv') || message.includes('srv');
}

function redactMongoUri(uri = '') {
  return String(uri || '').replace(/\/\/([^:@/]+):([^@/]+)@/, '//***:***@');
}

function encodeMongoCredential(value = '') {
  return encodeURIComponent(decodeURIComponent(String(value || '')));
}

function isPrivateIpAddress(address = '') {
  const ip = String(address || '').trim().toLowerCase();
  const version = net.isIP(ip);
  if (!version) return true;
  if (version === 4) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 0 || b === 168)) ||
      (a === 198 && (b === 18 || b === 19));
  }
  const compact = ip.replace(/^\[|\]$/g, '');
  if (compact === '::' || compact === '::1' || compact.startsWith('ff') ||
      compact.startsWith('fe8') || compact.startsWith('fe9') || compact.startsWith('fea') || compact.startsWith('feb') ||
      compact.startsWith('fc') || compact.startsWith('fd')) return true;
  const mapped = compact.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  return Boolean(mapped && isPrivateIpAddress(mapped[1]));
}

function isNewsImageHostAllowed(hostname = '') {
  return NEWS_IMAGE_ALLOWED_HOSTS.some((pattern) => hostMatchesAllowedPattern(hostname, pattern));
}

async function isSafeNewsImageUrl(value = '') {
  try {
    const parsed = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (!isNewsImageHostAllowed(parsed.hostname) || isPrivateIpAddress(parsed.hostname)) return false;
    const records = await dns.lookup(parsed.hostname, { all: true, verbatim: true });
    if (!records.length || records.some((record) => isPrivateIpAddress(record.address))) return false;
    return true;
  } catch (_) {
    return false;
  }
}

async function resolveDnsOverHttps(name, type) {
  const response = await axios.get('https://dns.google/resolve', {
    params: { name, type },
    timeout: 5000,
    validateStatus: () => true
  });
  if (response.status !== 200 || response?.data?.Status !== 0) {
    throw new Error(`DNS lookup failed for ${name} (${type})`);
  }
  return response.data;
}

function parseSrvAnswers(payload = {}) {
  return (Array.isArray(payload.Answer) ? payload.Answer : [])
    .map((answer) => String(answer?.data || '').trim())
    .map((row) => row.split(/\s+/))
    .filter((parts) => parts.length >= 4)
    .map((parts) => scrubDnsRecord(parts[3]))
    .filter(Boolean);
}

function parseTxtAnswers(payload = {}) {
  const params = new URLSearchParams();
  (Array.isArray(payload.Answer) ? payload.Answer : [])
    .map((answer) => scrubDnsRecord(answer?.data))
    .filter(Boolean)
    .forEach((entry) => {
      const search = new URLSearchParams(entry);
      search.forEach((value, key) => {
        if (!params.has(key)) params.set(key, value);
      });
    });
  return params;
}

async function expandMongoSrvUri(uri) {
  const parsed = new URL(uri);
  const srvHost = parsed.hostname;
  const database = parsed.pathname.replace(/^\//, '') || 'admin';
  const [srvPayload, txtPayload] = await Promise.all([
    resolveDnsOverHttps(`_mongodb._tcp.${srvHost}`, 'SRV'),
    resolveDnsOverHttps(srvHost, 'TXT').catch(() => ({ Answer: [] }))
  ]);

  const hosts = parseSrvAnswers(srvPayload);
  if (!hosts.length) {
    throw new Error(`No SRV records returned for ${srvHost}`);
  }

  const params = new URLSearchParams(parsed.search.replace(/^\?/, ''));
  const txtParams = parseTxtAnswers(txtPayload);
  txtParams.forEach((value, key) => {
    if (!params.has(key)) params.set(key, value);
  });
  if (!params.has('tls') && !params.has('ssl')) params.set('tls', 'true');
  if (!params.has('retryWrites')) params.set('retryWrites', 'true');
  if (!params.has('w')) params.set('w', 'majority');

  const authSegment = parsed.username
    ? `${encodeMongoCredential(parsed.username)}:${encodeMongoCredential(parsed.password)}@`
    : '';
  const queryString = params.toString();
  return `mongodb://${authSegment}${hosts.join(',')}/${database}${queryString ? `?${queryString}` : ''}`;
}

async function connectMongoWithFallback(uri) {
  const options = {
    serverSelectionTimeoutMS: 10000,
    connectTimeoutMS: 10000
  };

  // A failed first connect must not strand the process without a database
  // (mongoose only auto-reconnects established connections): keep retrying
  // with capped backoff until the connection succeeds.
  for (let attempt = 1; ; attempt++) {
    try {
      await mongoose.connect(uri, options);
      console.log(`MongoDB connected (${redactMongoUri(uri)})`);
      // Keep activation beacons idempotent even when several tabs retry at once.
      await mongoose.connection.collection('funnel_events').createIndex(
        { event: 1, userId: 1, activationJob: 1 },
        { name: 'activation_once_per_job', unique: true, partialFilterExpression: { event: 'activation' } }
      ).catch((indexError) => console.warn('[funnel] activation index unavailable:', indexError && indexError.message));
      return;
    } catch (error) {
      if (String(uri || '').startsWith('mongodb+srv://') && isMongoSrvResolutionError(error)) {
        try {
          const directUri = await expandMongoSrvUri(uri);
          await mongoose.connect(directUri, options);
          console.log(`MongoDB connected via SRV fallback (${redactMongoUri(directUri)})`);
          await mongoose.connection.collection('funnel_events').createIndex(
            { event: 1, userId: 1, activationJob: 1 },
            { name: 'activation_once_per_job', unique: true, partialFilterExpression: { event: 'activation' } }
          ).catch((indexError) => console.warn('[funnel] activation index unavailable:', indexError && indexError.message));
          return;
        } catch (fallbackError) {
          console.error('MongoDB SRV fallback error:', fallbackError);
        }
      }
      const delayMs = Math.min(60000, 5000 * attempt);
      console.error(`MongoDB connection error (attempt ${attempt}, retrying in ${delayMs / 1000}s):`, error);
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

function normalizePlanSelection(value) {
  const plan = String(value || '').trim().toLowerCase();
  if (plan === FREE_PLAN_ID) {
    return FREE_PLAN_ID;
  }
  if (plan === PRO_ANNUAL_PLAN_ID || plan === 'proannual' || plan === 'pro-yearly' || plan === 'pro-year') {
    return PRO_ANNUAL_PLAN_ID;
  }
  if (plan === ANNUAL_PLAN_ID || plan === 'year' || plan === 'yearly') {
    return ANNUAL_PLAN_ID;
  }
  if (plan === PRO_PLAN_ID) {
    return PRO_PLAN_ID;
  }
  if (plan === DESK_PLAN_ID) {
    return DESK_PLAN_ID;
  }
  if (plan === POWER_PLAN_ID) {
    return POWER_PLAN_ID;
  }
  if (plan === POWER_MONTHLY_PLAN_ID || plan === 'powermonthly' || plan === 'power-month' || plan === 'power-mo') {
    return POWER_MONTHLY_PLAN_ID;
  }
  if (plan === MONTHLY_PLAN_ID || plan === 'month' || plan === 'monthly') {
    return MONTHLY_PLAN_ID;
  }
  return MONTHLY_PLAN_ID;
}

function getPlanConfig(value) {
  const planId = normalizePlanSelection(value);
  if (planId === FREE_PLAN_ID) {
    return {
      planId: FREE_PLAN_ID,
      planName: 'Free',
      billingInterval: 'month',
      price: 0,
      currency: CORE_PLAN_CURRENCY,
      stripePriceId: null,
      trialDays: 0
    };
  }
  if (planId === PRO_ANNUAL_PLAN_ID) {
    return {
      planId: PRO_ANNUAL_PLAN_ID,
      planName: 'Pro Annual',
      billingInterval: 'year',
      price: PRO_ANNUAL_PLAN_PRICE,
      currency: CORE_PLAN_CURRENCY,
      stripePriceId: STRIPE_PRICE_ID_PRO_ANNUAL,
      trialDays: 0
    };
  }
  if (planId === ANNUAL_PLAN_ID) {
    return {
      planId: ANNUAL_PLAN_ID,
      planName: 'Annual',
      billingInterval: 'year',
      price: ANNUAL_PLAN_PRICE,
      currency: ANNUAL_PLAN_CURRENCY,
      stripePriceId: STRIPE_PRICE_ID_ANNUAL,
      trialDays: 0
    };
  }
  if (planId === PRO_PLAN_ID) {
    return {
      planId: PRO_PLAN_ID,
      planName: 'Pro',
      billingInterval: 'month',
      price: PRO_PLAN_PRICE,
      currency: CORE_PLAN_CURRENCY,
      stripePriceId: STRIPE_PRICE_ID_PRO,
      trialDays: TRIAL_DAYS
    };
  }
  if (planId === DESK_PLAN_ID) {
    return {
      planId: DESK_PLAN_ID,
      planName: 'Desk',
      billingInterval: 'year',
      price: DESK_PLAN_PRICE,
      currency: DESK_PLAN_CURRENCY,
      stripePriceId: STRIPE_PRICE_ID_DESK,
      trialDays: 0
    };
  }
  if (planId === POWER_PLAN_ID) {
    return {
      planId: POWER_PLAN_ID,
      planName: 'Power',
      billingInterval: 'year',
      price: POWER_PLAN_PRICE,
      currency: POWER_PLAN_CURRENCY,
      stripePriceId: STRIPE_PRICE_ID_POWER,
      trialDays: 0
    };
  }
  if (planId === POWER_MONTHLY_PLAN_ID) {
    return {
      planId: POWER_MONTHLY_PLAN_ID,
      planName: 'Power',
      billingInterval: 'month',
      price: POWER_MONTHLY_PLAN_PRICE,
      currency: POWER_MONTHLY_PLAN_CURRENCY,
      stripePriceId: STRIPE_PRICE_ID_POWER_MONTHLY,
      trialDays: 0
    };
  }
  return {
    planId: MONTHLY_PLAN_ID,
    planName: 'Monthly',
    billingInterval: 'month',
    price: CORE_PLAN_PRICE,
    currency: CORE_PLAN_CURRENCY,
    stripePriceId: STRIPE_PRICE_ID_MONTHLY,
    trialDays: TRIAL_DAYS
  };
}

function getPlanConfigByPriceId(priceId) {
  if (priceId && priceId === STRIPE_PRICE_ID_DESK) {
    return getPlanConfig(DESK_PLAN_ID);
  }
  if (priceId && priceId === STRIPE_PRICE_ID_POWER) {
    return getPlanConfig(POWER_PLAN_ID);
  }
  if (priceId && priceId === STRIPE_PRICE_ID_POWER_MONTHLY) {
    return getPlanConfig(POWER_MONTHLY_PLAN_ID);
  }
  if (priceId && priceId === STRIPE_PRICE_ID_ANNUAL) {
    return getPlanConfig(ANNUAL_PLAN_ID);
  }
  if (priceId && priceId === STRIPE_PRICE_ID_PRO_ANNUAL) {
    return getPlanConfig(PRO_ANNUAL_PLAN_ID);
  }
  if (priceId && priceId === STRIPE_PRICE_ID_PRO) {
    return getPlanConfig(PRO_PLAN_ID);
  }
  if (priceId && (priceId === STRIPE_PRICE_ID_MONTHLY || priceId === STRIPE_PRICE_ID)) {
    return getPlanConfig(MONTHLY_PLAN_ID);
  }
  return null;
}

const ALPHA_CACHE_TTL_MS = Object.freeze({
  quote: 60 * 1000,
  daily: 15 * 60 * 1000,
  monthly: 30 * 60 * 1000,
  fundamentals: 12 * 60 * 60 * 1000,
  news: 2 * 60 * 1000
});

function cacheGet(map, key, ttlMs) {
  const hit = map.get(key);
  if (!hit) return null;
  if (Date.now() - hit.timestamp > ttlMs) {
    map.delete(key);
    return null;
  }
  return hit.value;
}

function cacheSet(map, key, value) {
  map.set(key, { value, timestamp: Date.now() });
  // Bound the map so a full-universe sweep can't grow it without limit.
  if (map.size > 2000) map.delete(map.keys().next().value);
}

function createHttpError(status, message, code, details = {}) {
  const error = new Error(message);
  error.status = status;
  if (code) error.code = code;
  if (details && typeof details === 'object') {
    Object.assign(error, details);
  }
  return error;
}

function sendApiError(res, error, fallbackMessage = 'Something went wrong.') {
  const status = Number(error?.status) || 500;
  const payload = {
    message: status >= 500 && process.env.NODE_ENV === 'production'
      ? fallbackMessage
      : String(error?.message || fallbackMessage)
  };
  if (error?.code) payload.code = String(error.code);
  if (error?.field) payload.field = String(error.field);
  if (typeof error?.retryable === 'boolean') payload.retryable = error.retryable;
  return res.status(status).json(payload);
}
function publicErrorMessage(error, fallbackMessage) {
  return process.env.NODE_ENV === 'production' ? fallbackMessage : String(error?.message || fallbackMessage);
}

async function ensureStripeAccountPreflight() {
  if (!stripe || !stripeSecretKey) {
    throw createHttpError(500, 'Stripe is not configured');
  }

  const now = Date.now();
  if (
    stripeAccountPreflight.ok &&
    stripeAccountPreflight.accountId === EXPECTED_STRIPE_ACCOUNT_ID &&
    now - stripeAccountPreflight.checkedAt < 5 * 60 * 1000
  ) {
    return stripeAccountPreflight.accountId;
  }

  const response = await axios.get('https://api.stripe.com/v1/account', {
    headers: {
      Authorization: `Bearer ${stripeSecretKey}`
    }
  });

  const accountId = String(response?.data?.id || '').trim();
  stripeAccountPreflight.checkedAt = now;
  stripeAccountPreflight.accountId = accountId;
  stripeAccountPreflight.ok = accountId === EXPECTED_STRIPE_ACCOUNT_ID;

  if (!stripeAccountPreflight.ok) {
    throw createHttpError(
      500,
      `Stripe account mismatch. Expected ${EXPECTED_STRIPE_ACCOUNT_ID}, got ${accountId || 'unknown'}.`
    );
  }

  return accountId;
}

function trimTrailingSlash(value = '') {
  return String(value || '').trim().replace(/\/+$/, '');
}

function sanitizeRelativeAppPath(value, fallback = 'news.html') {
  const raw = String(value || '').trim();
  if (!raw) return fallback;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.startsWith('//')) {
    return fallback;
  }
  return raw.replace(/^\/+/, '') || fallback;
}

function getRequestOrigin(req) {
  const configuredOrigin = trimTrailingSlash(process.env.PUBLIC_APP_URL || process.env.APP_BASE_URL || '');
  if (configuredOrigin) {
    return configuredOrigin;
  }

  const originHeader = trimTrailingSlash(req?.headers?.origin || '');
  if (/^https?:\/\//i.test(originHeader)) {
    return originHeader;
  }

  const forwardedProto = String(req?.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req?.headers?.['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || String(req?.get?.('host') || req?.headers?.host || '').trim();
  const protocol = forwardedProto || (req?.secure ? 'https' : 'http');

  if (host) {
    return `${protocol}://${host}`;
  }

  return 'https://stockportfolio.pro';
}

function buildStripeReturnUrl(req, options = {}) {
  const session = String(options.session || 'success').trim().toLowerCase() === 'cancel' ? 'cancel' : 'success';
  const explicitUrl = trimTrailingSlash(session === 'success' ? STRIPE_SUCCESS_URL : STRIPE_CANCEL_URL);
  if (explicitUrl) {
    return explicitUrl;
  }

  const flow = String(options.flow || 'register').trim().toLowerCase() === 'login' ? 'login' : 'register';
  const provider = String(options.provider || '').trim().toLowerCase();
  const planId = normalizePlanSelection(options.planId || options.plan);
  const next = sanitizeRelativeAppPath(options.next, 'news.html');
  const targetPage = flow === 'login' ? 'login.html' : 'register.html';
  const url = new URL(`/${targetPage}`, `${getRequestOrigin(req)}/`);

  url.searchParams.set('session', session);
  url.searchParams.set('checkout', provider ? 'social' : 'email');
  url.searchParams.set('next', next);
  url.searchParams.set('plan', planId);

  if (provider) {
    url.searchParams.set('provider', provider);
  }

  return url.toString();
}

const TOP_COMPANIES_PATHS = [
  path.join(__dirname, 'data', 'top-100-companies.json'),
  path.join(__dirname, '../frontend/data/top-100-companies.json')
];
let topCompanies = [];
try {
  for (const candidatePath of TOP_COMPANIES_PATHS) {
    if (!fs.existsSync(candidatePath)) continue;
    const raw = fs.readFileSync(candidatePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      topCompanies = parsed.map((item) => ({
        symbol: safeUpper(item.symbol),
        name: String(item.name || '').trim(),
        marketCap: Number(item.marketCap) || null,
        peRatio: Number(item.peRatio) || null,
        eps: Number(item.eps) || null,
        sector: String(item.sector || '').trim()
      })).filter((item) => item.symbol && item.name);
      break;
    }
  }
} catch (error) {
  console.warn('Unable to load top company dataset:', error.message);
  topCompanies = [];
}

const topCompaniesBySymbol = new Map(topCompanies.map((item) => [item.symbol, item]));

function searchTopCompanies(query, limit = 10) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const scored = [];
  for (const company of topCompanies) {
    const symbol = company.symbol.toLowerCase();
    const name = company.name.toLowerCase();
    let score = -1;
    if (symbol === q) score = 100;
    else if (name === q) score = 95;
    else if (symbol.startsWith(q)) score = 90;
    else if (name.startsWith(q)) score = 80;
    else if (name.includes(q)) score = 70;
    else if (symbol.includes(q)) score = 60;
    if (score >= 0) scored.push({ ...company, score });
  }
  return scored
    .sort((a, b) => b.score - a.score || (b.marketCap || 0) - (a.marketCap || 0))
    .slice(0, Math.max(1, Math.min(limit, 25)))
    .map(({ score, ...company }) => company);
}

function defaultTrialEndsAt() {
  const date = new Date();
  date.setDate(date.getDate() + TRIAL_DAYS);
  return date;
}

// Legacy direct plans that have always charged at checkout. When
// REQUIRE_INITIAL_STRIPE_PAYMENT is enabled, monthly and Pro join this set for
// new self-serve registrations without changing existing entitlements.
const NO_TRIAL_PLAN_IDS = ['annual', 'pro-annual', 'power', 'power-monthly', 'desk', 'enterprise'];

function isAppSumoActivationSignup(req) {
  const token = String(req && req.body && req.body.appsumoRedeemToken || '').trim();
  if (!token) return false;
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    return Boolean(payload && payload.asRedeem && payload.asLicenseKey);
  } catch (_) {
    return false;
  }
}

function initialPaymentRequiredForSignup(planId, appsumoActivation = false) {
  return Boolean(REQUIRE_INITIAL_STRIPE_PAYMENT
    && !appsumoActivation
    && normalizePlanSelection(planId) !== FREE_PLAN_ID);
}

// No-card 7-day trial: grant full Pro access immediately with NO Stripe
// subscription and NO card. ensureSubscriptionShape() self-expires it to
// 'cancelled' at trialEndsAt (the same path comped reviewers use, guarded on
// the absence of a stripeSubscriptionId), so day 7 drops cleanly to the free
// tier with nothing charged. Converting to paid is a deliberate click — the
// in-app Upgrade CTA → POST /api/checkout — and never automatic.
function startNoCardTrial(user) {
  const s = user.subscription || {};
  s.status = 'trialing';
  s.planId = 'pro';
  s.planName = 'Pro trial';
  s.stripePriceId = null;
  s.trialStartedAt = new Date();
  s.trialEndsAt = defaultTrialEndsAt();
  s.expiredAt = null;
  s.activatedAt = null;
  s.renewedAt = null;
  s.lastPaymentAt = null;
  user.subscription = s;
  user.markModified('subscription');
}

function createDefaultSubscription(plan = MONTHLY_PLAN_ID) {
  const planConfig = getPlanConfig(plan);
  return {
    planId: planConfig.planId,
    planName: planConfig.planName,
    price: planConfig.price,
    currency: planConfig.currency,
    billingInterval: planConfig.billingInterval,
    stripePriceId: planConfig.stripePriceId || null,
    status: 'pending',
    trialStartedAt: new Date(),
    trialEndsAt: planConfig.trialDays > 0 ? defaultTrialEndsAt() : null,
    activatedAt: null,
    renewedAt: null,
    lastPaymentAt: null,
  };
}

function normalizeSubscription(sub = {}) {
  const planConfig = getPlanConfig(sub.planId);
  return {
    planId: planConfig.planId,
    planName: sub.planName || planConfig.planName,
    price: typeof sub.price === 'number' ? sub.price : planConfig.price,
    currency: sub.currency || planConfig.currency,
    billingInterval: sub.billingInterval || planConfig.billingInterval,
    stripePriceId: sub.stripePriceId || planConfig.stripePriceId || null,
    status: sub.status || 'pending',
    trialStartedAt: sub.trialStartedAt || null,
    trialEndsAt: sub.trialEndsAt || null,
    activatedAt: sub.activatedAt || null,
    renewedAt: sub.renewedAt || null,
    lastPaymentAt: sub.lastPaymentAt || null,
    isActive: ['active', 'trialing', 'cancel_at_period_end'].includes(sub.status),
    isCancelAtPeriodEnd: sub.status === 'cancel_at_period_end',
  };
}

function ensureSubscriptionShape(user) {
  if (!user.subscription || !user.subscription.planId) {
    user.subscription = createDefaultSubscription();
  } else {
    const normalizedPlanId = normalizePlanSelection(user.subscription.planId);
    const planConfig = getPlanConfig(normalizedPlanId);
    if (user.subscription.planId !== normalizedPlanId) user.subscription.planId = normalizedPlanId;
    if (!user.subscription.planName || user.subscription.planName === 'Core') {
      user.subscription.planName = planConfig.planName;
    }
    if (!user.subscription.currency) user.subscription.currency = planConfig.currency;
    if (!user.subscription.billingInterval) user.subscription.billingInterval = planConfig.billingInterval;
    if (!user.subscription.stripePriceId && planConfig.stripePriceId) {
      user.subscription.stripePriceId = planConfig.stripePriceId;
    }
  }
  // Complimentary grants (manual, e.g. a comped reviewer) are modelled as a
  // 'trialing' sub with a trialEndsAt and NO stripeSubscriptionId. Stripe's own
  // trials always carry a stripeSubscriptionId and are expired by webhook, so
  // this guard only ever touches manual comps: once the window passes, drop to
  // free. Runs on every authed request, so the comp self-expires.
  const s = user.subscription;
  if (s && s.status === 'trialing' && s.trialEndsAt && !user.stripeSubscriptionId
    && new Date(s.trialEndsAt).getTime() < Date.now()) {
    s.status = 'cancelled';
    s.expiredAt = s.expiredAt || new Date();
  }
  return normalizeSubscription(user.subscription);
}

function subscriptionIsActive(sub) {
  return sub && ['active', 'trialing', 'cancel_at_period_end'].includes(sub.status);
}

function passwordMeetsPolicy(password) {
  if (typeof password !== 'string') return false;
  return password.length >= 8 && /[A-Z]/.test(password) && /[a-z]/.test(password) && /\d/.test(password);
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function emailLooksValid(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
}

// Provisional display name from an email local-part when no name is supplied
// at sign-up (e.g. "jane.doe@x.com" -> "Jane Doe"). Falls back to "Member".
function deriveNameFromEmail(email) {
  const local = String(email || '').split('@')[0] || '';
  const words = local
    .replace(/[._\-+]+/g, ' ')
    .replace(/[^a-zA-Z ]/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1));
  return words.join(' ') || 'Member';
}

function isDatabaseUnavailableError(error) {
  const msg = String(error?.message || '').toLowerCase();
  return (
    msg.includes('before initial connection') ||
    msg.includes('server selection') ||
    msg.includes('topology') ||
    msg.includes('econnrefused') ||
    msg.includes('connection')
  );
}

async function verifyPassword(password, storedHash) {
  if (typeof password !== 'string' || typeof storedHash !== 'string' || !storedHash) {
    return false;
  }

  // bcrypt hashes
  if (storedHash.startsWith('$2a$') || storedHash.startsWith('$2b$') || storedHash.startsWith('$2y$')) {
    return bcrypt.compare(password, storedHash);
  }

  // argon2 hashes from legacy deployments
  if (storedHash.startsWith('$argon2')) {
    try {
      return await argon2.verify(storedHash, password);
    } catch (_) {
      return false;
    }
  }

  // very old/plaintext fallback
  return password === storedHash;
}
// Stock-data client: Yahoo-backed, exposes the same interface
// (searchSymbols / intraday / globalQuote / overview) the rest of the
// app uses for portfolio price + profile lookups.
const alphaClient = {
    async searchSymbols(query) {
        const data = await yahooSource.fetchSymbolSearch(query);
        return (data?.bestMatches || []).map((m) => ({
            symbol: m['1. symbol'], name: m['2. name'], quoteType: m['3. type'] || '',
            assetType: assetProfile.normalizeAssetType(m['3. type'])
        }));
    },
    async intraday(symbol /*, interval='5min' */) {
        const data = await yahooSource.fetchIntraday(symbol, '5min');
        return data?.['Time Series (5min)'] || {};
    },
    async globalQuote(symbol) {
        const data = await yahooSource.fetchQuote(symbol);
        return data?.['Global Quote'] || {};
    },
    async overview(symbol) {
        return yahooSource.fetchOverview(symbol);
    }
};

// Process-wide gate keeping outbound Alpha calls under their 5-req/sec
// burst limit. We chain a 220ms wait after each acquired slot so calls
// start ~4.5/sec, in flight simultaneously. Cache hits skip this entirely
// because they don't go through fetchAlpha.
let _alphaGate = Promise.resolve();
const ALPHA_MIN_INTERVAL_MS = 400;
async function acquireAlphaSlot() {
    const ready = _alphaGate;
    _alphaGate = _alphaGate.then(() => new Promise((r) => setTimeout(r, ALPHA_MIN_INTERVAL_MS)));
    await ready;
}

// All historical Alpha Vantage call sites land here. We now serve them
// from Yahoo Finance (free, no API key) shaped into the same response
// objects the routes + frontend already consume. The slot gate is kept
// as a polite outbound throttle; Yahoo doesn't enforce a 5 req/sec cap
// like Alpha did, but the gate prevents accidental flood loops.
async function fetchAlpha(functionName, params = {}) {
    await acquireAlphaSlot();
    // Cold (uncached) first loads pull live from Yahoo; a transient hiccup or
    // timeout there used to surface as a blank "couldn't load". One quiet retry
    // with a short backoff catches the common transient case; a genuinely
    // missing symbol just fails again and bubbles up as before.
    let lastError;
    for (let attempt = 0; attempt < 2; attempt++) {
        try {
            return await yahooSource.fetchFromYahoo(functionName, params);
        } catch (error) {
            lastError = error;
            if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 400));
        }
    }
    const err = new Error(lastError?.message || 'Upstream data source failed');
    err.status = lastError?.status || 502;
    throw err;
}

// Alpha sometimes returns 200 OK with a top-level "Information" or "Note"
// rate-limit message and no real payload. Caching that pins an empty page
// for the full TTL — detect and pass through instead.
function isAlphaRateLimitPayload(data) {
    if (!data || typeof data !== 'object') return false;
    if (data['Information'] || data['Note']) return true;
    return false;
}

async function fetchAlphaCached(functionName, params = {}, ttlMs = 0) {
    // Normalize ticker spelling (BRK.B / BRK/B / "BRK B" → BRK-B) before the
    // upstream call AND the cache key, so every form hits the same full record.
    if (params && params.symbol) {
        params = { ...params, symbol: normalizeTicker(params.symbol) };
    }
    if (!ttlMs) {
        return fetchAlpha(functionName, params);
    }
    const cacheKey = `${functionName}:${JSON.stringify(params)}`;
    const cached = cacheGet(alphaResponseCache, cacheKey, ttlMs);
    if (cached) {
        return cached;
    }
    const data = await fetchAlpha(functionName, params);
    if (isAlphaRateLimitPayload(data)) {
        console.warn(`[alpha] rate-limit response for ${functionName} ${JSON.stringify(params)}: ${(data['Information']||data['Note']||'').slice(0,120)} — not cached`);
        return data;
    }
    cacheSet(alphaResponseCache, cacheKey, data);
    return data;
}

// MongoDB connection
mongoose.set('bufferCommands', false);
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/stockportfolio';
connectMongoWithFallback(MONGODB_URI);

// Canonical URL hygiene: 301 any non-root page URL that has a trailing slash
// to the slash-less version (e.g. /privacy/ -> /privacy). GET only; skips the
// API and the root. Prevents trailing-slash duplicate URLs from being indexed
// as separate pages.
app.use((req, res, next) => {
    if (req.method === 'GET') {
        const p = req.path;
        if (p !== '/' && p.endsWith('/') && !p.startsWith('/api')) {
            const qs = req.originalUrl.slice(p.length); // preserve querystring
            return res.redirect(301, p.replace(/\/+$/, '') + qs);
        }
    }
    next();
});

function marketingRequestFields(req, res) {
    return marketingAttribution.requestFields(req, res, {
        secret: JWT_SECRET,
        qaToken: MARKETING_QA_TOKEN,
        secure: process.env.NODE_ENV === 'production' || Boolean(req && req.secure)
    });
}

function trackingRequestFields(req, res) {
    const fields = { ...marketingRequestFields(req, res) };
    const clientReferrer = marketingAttribution.sanitizeReferrer(req && req.body && req.body.referrer);
    if (clientReferrer) {
        fields.referrer = clientReferrer;
        fields.referrerSource = marketingAttribution.referrerSource(clientReferrer);
    }
    return fields;
}

function ensureTrackingAcquisition(req, res, fields, contentId) {
    const existing = shareCopy.parseAcquisitionCookieHeader(req.headers.cookie, { secret: JWT_SECRET });
    if (existing) return existing;
    const inferredSource = shareCopy.normalizeAppSumoSource(fields && fields.referrerSource);
    if (!inferredSource || ['direct', 'website', 'bridge'].includes(inferredSource)) return null;
    return setCampaignAcquisition(req, res, {
        source: inferredSource,
        clickId: null,
        contentId: shareCopy.normalizeAcquisitionContentId(contentId)
    });
}

function campaignContentIdForPath(requestPath) {
    const normalizedPath = String(requestPath || '').replace(/\/+$/, '') || '/';
    const tool = Object.values(freeTools.TOOL_DEFINITIONS).find((definition) => definition.path === normalizedPath);
    if (tool) return tool.id;
    return ({
        '/research/shares-outstanding': 'research-shares-outstanding',
        '/research/pe-ratio-history': 'research-pe-ratio-history',
        '/research/dilution-scorecard': 'research-dilution-scorecard'
    })[normalizedPath] || null;
}

function campaignAcquisitionForRequest(req) {
    const requestedSource = shareCopy.normalizeAppSumoSource(req && req.query && req.query.source);
    const inferredSource = marketingAttribution.referrerSource(req && (req.headers.referer || req.headers.referrer));
    const source = requestedSource || shareCopy.normalizeAppSumoSource(inferredSource);
    if (!source || source === 'internal' || source === 'direct' || source === 'referral' || source === 'bridge') return null;
    const existing = shareCopy.parseAcquisitionCookieHeader(req.headers.cookie, { secret: JWT_SECRET });
    const requestedContentId = shareCopy.normalizeAcquisitionContentId(req.query && req.query.content_id)
        || campaignContentIdForPath(req.path);
    const requestedClickId = shareCopy.normalizeAcquisitionClickId(req.query && req.query.click_id);

    // A contextual CTA inside a tool is intentionally tagged `website`, but it
    // must not erase the social/search first touch that brought the visitor to
    // the tool. Keep the original channel/click while updating the content ID.
    if (requestedSource === 'website' && existing && existing.source !== 'website') {
        return {
            source: existing.source,
            clickId: existing.clickId,
            contentId: requestedContentId || existing.contentId
        };
    }
    return {
        source,
        clickId: requestedClickId || (existing && existing.source === source ? existing.clickId : null),
        contentId: requestedContentId || (existing && existing.source === source ? existing.contentId : null)
    };
}

function setCampaignAcquisition(req, res, acquisition) {
    if (!acquisition) return null;
    const value = shareCopy.createAcquisitionCookieValue(acquisition.source, {
        secret: JWT_SECRET,
        clickId: acquisition.clickId,
        contentId: acquisition.contentId
    });
    const cookie = shareCopy.serializeAcquisitionCookie(value, {
        secure: process.env.NODE_ENV === 'production' || Boolean(req.secure),
        domain: shareCopy.acquisitionCookieDomain(req.hostname)
    });
    if (cookie) res.append('Set-Cookie', cookie);
    const parsed = value
        ? shareCopy.parseAcquisitionCookieHeader(`${shareCopy.ACQUISITION_COOKIE_NAME}=${encodeURIComponent(value)}`, { secret: JWT_SECRET })
        : null;
    if (parsed) req.campaignAcquisition = parsed;
    return parsed;
}

// Capture a first-touch campaign on the initial public HTML request. This is
// what lets an X/LinkedIn/search visitor use a free tool before signing up or
// opening AppSumo without losing the original channel and unique click ID.
app.use((req, res, next) => {
    if (req.method !== 'GET' || /^(?:\/api|\/admin|\/assets|\/Media|\/data|\/sitemaps)(?:\/|$)/.test(req.path)) return next();
    if (/\.[A-Za-z0-9]{2,8}$/.test(req.path)) return next();
    const acquisition = campaignAcquisitionForRequest(req);
    if (acquisition) {
        setCampaignAcquisition(req, res, acquisition);
        marketingRequestFields(req, res);
    }
    return next();
});

// ---- Public SEO pages (organic-traffic engine) ----
// Registered before static so /stocks/:ticker, /stocks, /sitemap.xml,
// and /vs/:competitor are server-rendered. All public, no auth.
const seoPages = require('./seo-pages');
const comparisonPages = require('./comparison-pages');
const { pixelConfig } = require('./pixels');

// ---- In-process SSR HTML/XML cache (backend/ssr-cache.js) ----
// ONE pass-through middleware, mounted here so Express registration order puts
// it AFTER all global middleware (json 82, cors 94, helmet 95, compression
// 104, rate limiters 122/134) and the trailing-slash 301 (991), but BEFORE
// every SSR route below AND the seo-extra router (1033). It self-restricts via
// an anchored positive allowlist to ONLY: /sitemap.xml, /stocks, /stocks/:t,
// /stocks/:t/:metric, /compare, /compare/:pair, /screens/:slug, /vs/:c,
// /methodology, /editorial-policy. Pure pass-through (next()) for everything
// else, so it never fronts /api, /admin, /company, /screener, /dashboard,
// /login, /register, express.static, the 404 catch-all, OR the root-mounted
// Caches GET + status-200 + text/html|xml +
// no-Set-Cookie only. Deploy clears it; 6h TTL covers the out-of-process
// nightly fundamentals rewrites. Zero new npm deps.
const ssrCache = require('./ssr-cache');
const ssrCacheMw = ssrCache.middleware();
app.use(ssrCacheMw);

app.get('/sitemap.xml', (req, res) => {
    res.set('Content-Type', 'application/xml').send(seoPages.buildSitemap());
});
app.get('/sitemaps/:shard.xml', (req, res) => {
    const xml = seoPages.buildSitemapShard(req.params.shard);
    if (!xml) return res.status(404).type('text/plain').send('Unknown sitemap shard');
    res.set('Content-Type', 'application/xml').send(xml);
});
app.get('/stocks', (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8').send(seoPages.renderStockIndex());
});
// Pricing has no standalone page — the homepage #pricing section holds the tiers.
// Catch /pricing (a URL cold visitors guess; was a 404) and land them on it.
app.get('/pricing', (req, res) => res.redirect(302, '/#pricing'));
// E-E-A-T transparency pages (server-rendered, public, no auth).
app.get('/methodology', (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8').send(seoPages.renderMethodology());
});
app.get('/editorial-policy', (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8').send(seoPages.renderEditorialPolicy());
});
app.get('/stocks/:ticker', (req, res) => {
    const canonicalSymbol = seoPages.resolveCanonicalSymbol(req.params.ticker);
    if (canonicalSymbol && String(req.params.ticker) !== canonicalSymbol) {
        return res.redirect(301, `/stocks/${encodeURIComponent(canonicalSymbol)}`);
    }
    const html = seoPages.renderStockPage(req.params.ticker);
    if (!html) return res.status(404).set('Content-Type', 'text/html; charset=utf-8').send(seoPages.renderStockIndex());
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
});
app.get('/vs/:competitor', (req, res) => {
    const html = comparisonPages.renderComparison(req.params.competitor);
    if (!html) return res.redirect(302, '/');
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
});
// Metric histories (/stocks/SYM/revenue), X-vs-Y comparisons (/compare/A-vs-B),
// and screen landing pages (/screens/dividend-stocks) — see backend/seo-extra.js
app.use(require('./seo-extra').router);

// The Localyze model proxy is intentionally not mounted here. It must use a
// separate service, credential, authentication boundary, and quota.

// Interactive company page (/company?symbol=SYM): the data renders client-side,
// so crawlers and link unfurlers would otherwise see only the skeleton with a
// generic title. Inject the company's name into <title>/description/OG and
// point the canonical at the server-rendered /stocks/SYM page so ranking
// signals consolidate there. Registered before static so it wins the path.
const COMPANY_TPL_PATH = path.join(__dirname, '../frontend-v2/company.html');
let _companyTpl = null;
app.get(['/company.html', '/company'], (req, res) => {
    if (_companyTpl === null) {
        try { _companyTpl = fs.readFileSync(COMPANY_TPL_PATH, 'utf8'); } catch (_) { _companyTpl = ''; }
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    if (!_companyTpl) return res.sendFile(COMPANY_TPL_PATH);
    const sym = String(req.query.symbol || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '').slice(0, 10);
    const name = sym && seoPages.companyName(sym);
    if (!sym || !name) return res.send(_companyTpl);
    const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const title = `${name} (${sym}) financials, ratios & health checks — stockportfolio.pro`;
    const desc = `${name} (${sym}): up to 19 years of SEC-filed income statement, balance sheet and cash flow, valuation ratios, ownership and plain-English health checks.`;
    const canonical = seoPages.hasStockPage(sym)
        ? `https://www.stockportfolio.pro/stocks/${sym}`
        : `https://www.stockportfolio.pro/company?symbol=${sym}`;
    const html = _companyTpl
        .replace(/<title>[\s\S]*?<\/title>/, () => `<title>${escAttr(title)}</title>`)
        .replace(/(<meta name="description" content=")[^"]*/, (_, p1) => p1 + escAttr(desc))
        .replace(/(<link rel="canonical" href=")[^"]*/, (_, p1) => p1 + canonical)
        .replace(/(<meta property="og:title" content=")[^"]*/, (_, p1) => p1 + escAttr(title))
        .replace(/(<meta property="og:description" content=")[^"]*/, (_, p1) => p1 + escAttr(desc))
        .replace(/(<meta property="og:url" content=")[^"]*/, (_, p1) => p1 + canonical)
        .replace(/(<meta name="twitter:title" content=")[^"]*/, (_, p1) => p1 + escAttr(title))
        .replace(/(<meta name="twitter:description" content=")[^"]*/, (_, p1) => p1 + escAttr(desc));
    res.send(html);
});

// ---- Screener SSR (/screener, /screener.html): inject default top-50 rows so
// crawlers see a real HTML table instead of "Loading…". JS hydrates on load.
let _screenerTpl = null;
function screenerTpl() {
    if (_screenerTpl === null) {
        try { _screenerTpl = fs.readFileSync(path.join(__dirname, '../frontend-v2/screener.html'), 'utf8'); }
        catch (_) { _screenerTpl = ''; }
    }
    return _screenerTpl;
}
function renderScreenerRows() {
    const esc = (v) => String(v == null ? '' : v).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const fmt = (v, dp) => v == null ? '—' : Number(v).toFixed(dp);
    const { rows } = aiChat.screenRows({ limit: 50, maxLimit: 50 });
    // Mirrors frontend-v2/assets/screener.js render(), but with crawlable
    // /stocks/ links — JS hydrates over these rows on load.
    return rows.map((r) => `<tr data-sym="${esc(r.symbol)}">
<td class="row-head"><a href="/stocks/${esc(r.symbol)}"><strong>${esc(r.symbol)}</strong>&ensp;<span class="muted">${esc(r.name)}</span></a></td>
<td class="small muted" style="text-transform:capitalize;" data-label="Sector">${esc(String(r.sector || '').toLowerCase())}</td>
<td data-label="Mkt cap">${r.marketCapB == null ? '—' : '$' + fmt(r.marketCapB, 1) + 'B'}</td>
<td data-label="P/E">${fmt(r.pe, 1)}</td>
<td data-label="Rev CAGR 5y" class="${r.revCagr5Pct > 0 ? 'delta-pos' : r.revCagr5Pct < 0 ? 'delta-neg' : ''}">${r.revCagr5Pct == null ? '—' : fmt(r.revCagr5Pct, 1) + '%'}</td>
<td data-label="Net margin">${r.netMarginPct == null ? '—' : fmt(r.netMarginPct, 1) + '%'}</td>
<td data-label="ROE">${r.roePct == null ? '—' : fmt(r.roePct, 1) + '%'}</td>
<td data-label="Div yield">${r.divYieldPct == null ? '—' : fmt(r.divYieldPct, 2) + '%'}</td>
<td data-label="Qtr earn YoY" class="${r.qtrNetIncomeYoYPct > 0 ? 'delta-pos' : r.qtrNetIncomeYoYPct < 0 ? 'delta-neg' : ''}">${r.qtrNetIncomeYoYPct == null ? '—' : fmt(r.qtrNetIncomeYoYPct, 0) + '%'}</td>
<td data-label="Profit yrs">${r.profitableYears10 == null ? '—' : r.profitableYears10 + '/10'}</td>
</tr>`).join('\n');
}
app.get(['/screener', '/screener.html'], (req, res) => {
    const tpl = screenerTpl();
    if (!tpl) return res.sendFile(path.join(__dirname, '../frontend/screener.html'));
    const ssrRows = renderScreenerRows();
    const html = tpl.replace(
        '<tr><td colspan="10" style="text-align:center; padding:40px;" class="faint">Loading the universe…</td></tr>',
        ssrRows
    );
    res.set('Content-Type', 'text/html; charset=utf-8')
       .set('Cache-Control', 'public, max-age=3600')
       .send(html);
});

// CUTOVER (local): v2 is the product at / — it wins name collisions; anything
// it doesn't have (Media, legal pages, demo pages, data/) falls through to v1.
// Cache tiers, by how the asset changes:
//  - HTML: never cache — a deploy must show up immediately.
//  - css/js/fonts/video: 1yr immutable. All css/js are version-stamped (?v=…),
//    so a new build = a new URL; fonts/video are stable. This is the LCP win.
//  - images: 30d — not version-stamped, but they rarely change.
//  - everything else (data/*.json refreshed nightly, etc.): 1h for freshness.
const ONE_YEAR = 'public, max-age=31536000, immutable';
const staticCacheHeaders = (res, filePath) => {
    if (filePath.endsWith('.html')) { res.setHeader('Cache-Control', 'no-cache'); return; }
    if (/\.(css|js|mjs|woff2?|ttf|otf|mp4|webm)$/i.test(filePath)) { res.setHeader('Cache-Control', ONE_YEAR); return; }
    if (/\.(png|jpe?g|gif|svg|ico|webp|avif)$/i.test(filePath)) { res.setHeader('Cache-Control', 'public, max-age=2592000'); return; }
    res.setHeader('Cache-Control', 'public, max-age=3600');
};
// Explicit campaign route. Keep this ahead of extension-based static serving so
// /appsumo is stable even if the static middleware's resolution rules change.
app.get('/appsumo', async (req, res, next) => {
    const acquisition = req.campaignAcquisition || campaignAcquisitionForRequest(req);
    const landingPath = path.join(__dirname, '../frontend-v2/appsumo.html');
    res.setHeader('Cache-Control', 'no-cache');
    if (!acquisition) {
        return res.sendFile(landingPath, (error) => {
            if (error && !res.headersSent) next(error);
        });
    }
    try {
        const html = await fs.promises.readFile(landingPath, 'utf8');
        return res.type('html').send(shareCopy.attributeAppSumoLandingHtml(
            html,
            acquisition.source,
            acquisition.contentId,
            acquisition.clickId
        ));
    } catch (error) {
        return next(error);
    }
});

// Public campaign configuration contains only copy-safe, env-derived values.
// It deliberately never exposes SMTP, Stripe, AppSumo credentials, or user data.
app.get('/api/campaign/config', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(augustCampaign.config());
});
app.get('/api/campaign/august-2026', (req, res) => {
    res.set('Cache-Control', 'public, max-age=300').json(augustCampaign.config());
});

// Engineering-as-Marketing catalog: public deterministic utilities. Keep
// these routes ahead of static serving so their canonical HTML is stable.
app.get('/tools', (req, res) => {
    res.set('Cache-Control', 'no-cache').type('html').send(freeTools.renderToolIndex());
});
for (const definition of Object.values(freeTools.TOOL_DEFINITIONS)) {
    app.get(definition.path, (req, res) => {
        res.set('Cache-Control', 'no-cache').type('html').send(freeTools.renderToolPage(definition.slug));
    });
}
app.get('/api/free-tools/:tool', freeToolLimiter, async (req, res) => {
    const tool = String(req.params.tool || '').trim().toLowerCase();
    try {
        const result = await freeTools.getToolResult(tool, req.query.symbol);
        res.set('Cache-Control', 'public, max-age=300').status(result.status).json(result.body);
        if (result.status >= 200 && result.status < 300 && result.body && !result.body.error) {
            const definition = freeTools.TOOL_DEFINITIONS[tool];
            trackFunnel('free_tool_complete', null, null, {
                toolId: definition && definition.id,
                toolName: definition && definition.slug,
                symbol: freeTools.normalizeSymbol(result.body.symbol || req.query.symbol),
                path: `/api/free-tools/${tool}`,
                ...trackingRequestFields(req, res)
            });
        }
    } catch (error) {
        console.error('[free-tools] request failed:', error && error.message);
        res.status(502).json({ error: 'Free-tool data is temporarily unavailable. Try again shortly.' });
    }
});

app.use(express.static(path.join(__dirname, '../frontend-v2'), { extensions: ['html'], setHeaders: staticCacheHeaders }));
app.use(express.static(path.join(__dirname, '../frontend'), { setHeaders: staticCacheHeaders }));
// transition window: old surface stays reachable at /v1; /v2 links keep working
app.use('/v1', express.static(path.join(__dirname, '../frontend')));
app.use('/v2', express.static(path.join(__dirname, '../frontend-v2'), { extensions: ['html'], redirect: false }));
app.get('/v2', (req, res) => res.sendFile(path.join(__dirname, '../frontend-v2/index.html')));

// User Schema for MongoDB
const SubscriptionSchema = new mongoose.Schema({
    planId: { type: String, default: MONTHLY_PLAN_ID },
    planName: { type: String, default: 'Monthly' },
    price: { type: Number, default: CORE_PLAN_PRICE },
    currency: { type: String, default: CORE_PLAN_CURRENCY },
    billingInterval: { type: String, enum: ['month', 'year'], default: 'month' },
    stripePriceId: { type: String, default: STRIPE_PRICE_ID_MONTHLY || null },
    status: { type: String, enum: ['pending','trialing','active','cancel_at_period_end','cancelled'], default: 'pending' },
    trialStartedAt: { type: Date, default: () => new Date() },
    trialEndsAt: { type: Date, default: null },
    expiredAt: { type: Date, default: null },
    activatedAt: { type: Date, default: null },
    renewedAt: { type: Date, default: null },
    lastPaymentAt: { type: Date, default: null }
}, { _id: false });

const UserSchema = new mongoose.Schema({
    name: String,
    email: { type: String, unique: true },
    password: String,
    authVersion: { type: Number, default: 0 },
    googleId: { type: String, default: null },
    facebookId: { type: String, default: null },
    avatarUrl: { type: String, default: null },
    subscription: { type: SubscriptionSchema, default: createDefaultSubscription },
    stripeCustomerId: { type: String, default: null },
    stripeSubscriptionId: { type: String, default: null },
    // Weekly Filing Monitor digest (Power/Desk): opt-out + last-sent for cadence.
    digestOptOut: { type: Boolean, default: false },
    lastDigestAt: { type: Date, default: null },
    // AppSumo lifetime-deal redemption. appsumoLicenseKey links the account to a
    // single AppSumo license; appsumoTier (1/2/3) sets appsumoAiCap (30/100/300)
    // — the per-tier monthly Ask quota that protects margin on a one-time payment.
    appsumoLicenseKey: { type: String, default: null, index: true },
    appsumoTier: { type: Number, default: null },
    appsumoAiCap: { type: Number, default: null },
    appsumoRedeemedAt: { type: Date, default: null },
    // DealMirror is a separate, non-stackable LTD channel. These fields never
    // replace or modify AppSumo records; entitlement precedence is enforced at
    // redemption time and again during revocation.
    dealMirrorLicenceId: { type: mongoose.Schema.Types.ObjectId, ref: 'DealMirrorLicence', default: null, index: true },
    dealMirrorTier: { type: Number, default: null },
    dealMirrorAiCap: { type: Number, default: null },
    dealMirrorRedeemedAt: { type: Date, default: null },
    // Optional self-reported discovery source collected during AppSumo
    // activation. It complements (and never overwrites) signed attribution.
    discoverySource: { type: String, default: null, enum: [null, ...APPSUMO_DISCOVERY_SOURCES] },
    // Post-redemption honest-review drip (AppSumo-sanctioned: 24h / day-3 / day-10).
    // appsumoReviewStage = highest stage already emailed (0..3); opt-out is separate
    // from the digest opt-out so unsubscribing one never mutes the other.
    appsumoReviewStage: { type: Number, default: 0 },
    appsumoEmailsOptOut: { type: Boolean, default: false },
    // Trial lifecycle emails (no-card trial): drip at 2 days before expiry and on expiry.
    // trialEmailStage = highest stage already emailed (0=none, 1=2-days-left, 2=expired);
    // opt-out is separate from digest/appsumo so each drip has independent control.
    trialEmailStage: { type: Number, default: 0 },
    trialEmailsOptOut: { type: Boolean, default: false },
    trialInternalNotifiedAt: { type: Date, default: null },
    // Campaign success/review signals are explicit and never inferred from a
    // purchase alone. They are used for the August activation gate.
    customerSuccessStatus: { type: String, enum: [null, 'yes', 'somewhat', 'not_yet'], default: null },
    customerSuccessText: { type: String, default: null, maxlength: 1000 },
    customerSuccessAt: { type: Date, default: null },
    reviewEligibleAt: { type: Date, default: null },
    reviewPromptShownAt: { type: Date, default: null },
    reviewClickedAt: { type: Date, default: null },
    reviewDismissedAt: { type: Date, default: null },
    firstActivationAt: { type: Date, default: null },
    successfulOutcomeCount: { type: Number, default: 0 },
    lastSuccessfulOutcomeAt: { type: Date, default: null },
    reviewRequestSentAt: { type: Date, default: null },
    reviewReceivedAt: { type: Date, default: null },
    signupUtm: {
        source: { type: String, default: null },
        medium: { type: String, default: null },
        campaign: { type: String, default: null },
        content: { type: String, default: null },
        term: { type: String, default: null },
        capturedAt: { type: Date, default: null }
    },
    // Opaque, signed first-party journey join. These are attribution records,
    // not identities; email/name are never copied into analytics.
    analyticsAnonymousId: { type: String, default: null, index: true },
    analyticsFirstTouch: { type: mongoose.Schema.Types.Mixed, default: null },
    analyticsLastNonDirectTouch: { type: mongoose.Schema.Types.Mixed, default: null },
    // New paid-first registrations receive a seven-day, first-payment refund
    // window. These fields contain billing state only; no card data is stored.
    paymentRequiredAt: { type: Date, default: null },
    initialPaymentAt: { type: Date, default: null },
    initialRefundUntil: { type: Date, default: null },
    initialRefundStatus: { type: String, enum: ['not_eligible', 'eligible', 'requested', 'refunded'], default: 'not_eligible' },
    initialRefundRequestedAt: { type: Date, default: null },
    initialRefundedAt: { type: Date, default: null },
    initialInvoiceId: { type: String, default: null },
    initialPaymentIntentId: { type: String, default: null },
    initialChargeId: { type: String, default: null },
    // Password reset via email. Stores only a SHA-256 hash of the emailed token
    // (never the raw token) plus its expiry; both are cleared on a successful
    // reset so the link is single-use. See /api/password/forgot + /reset.
    resetPasswordToken: { type: String, default: null, index: true },
    resetPasswordExpires: { type: Date, default: null }
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);

// Append-only, MongoDB-backed customer registry. The unique event key makes
// Stripe/AppSumo webhook retries idempotent while keeping a durable audit trail
// of the email address and plan observed at signup or first paid activation.
const CustomerLifecycleEventSchema = new mongoose.Schema({
    eventKey: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    name: { type: String, default: null },
    type: { type: String, enum: ['signup', 'stripe_paid', 'appsumo_redeemed'], required: true, index: true },
    source: { type: String, enum: ['direct', 'social', 'stripe', 'appsumo'], required: true, index: true },
    planId: { type: String, default: null },
    planName: { type: String, default: null },
    subscriptionStatus: { type: String, default: null },
    appsumoTier: { type: Number, default: null },
    discoverySource: { type: String, default: null, enum: [null, ...APPSUMO_DISCOVERY_SOURCES] },
    customerEmailedAt: { type: Date, default: null },
    ownerNotifiedAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false, collection: 'customer_lifecycle_events' });
const CustomerLifecycleEvent = mongoose.model('CustomerLifecycleEvent', CustomerLifecycleEventSchema);

const FunnelEventSchema = new mongoose.Schema({
    eventType: { type: String, required: true, index: true },
    event: { type: String, required: true, index: true },
    timestamp: { type: Date, default: () => new Date(), index: true },
    at: { type: Date, default: () => new Date(), index: true },
    sessionId: { type: String, default: null, index: true },
    anonymousSessionId: { type: String, default: null, index: true },
    userId: { type: String, default: null, index: true },
    ticker: { type: String, default: null, index: true },
    symbol: { type: String, default: null, index: true },
    toolName: { type: String, default: null, index: true },
    toolId: { type: String, default: null, index: true },
    contentId: { type: String, default: null, index: true },
    campaignId: { type: String, default: null, index: true },
    workflow: { type: String, default: null, index: true },
    sourceOpened: { type: Boolean, default: false },
    resultValid: { type: Boolean, default: false },
    trafficCategory: { type: String, default: null, index: true },
    utm: {
        source: { type: String, default: null },
        medium: { type: String, default: null },
        campaign: { type: String, default: null },
        content: { type: String, default: null },
        term: { type: String, default: null }
    },
    referrer: { type: String, default: null },
    // Growth Measurement V1 canonical fields. Legacy event/eventType fields
    // remain intact so existing dashboards and exports continue to work.
    eventId: { type: String, default: null, index: true },
    eventName: { type: String, default: null, index: true },
    schemaVersion: { type: String, default: null },
    occurredAt: { type: Date, default: null, index: true },
    anonymousId: { type: String, default: null, index: true },
    opaqueUserId: { type: String, default: null, index: true },
    firstTouch: { type: mongoose.Schema.Types.Mixed, default: null },
    lastNonDirectTouch: { type: mongoose.Schema.Types.Mixed, default: null },
    currentSessionTouch: { type: mongoose.Schema.Types.Mixed, default: null },
    pageType: { type: String, default: null, index: true },
    pagePath: { type: String, default: null },
    ctaId: { type: String, default: null, index: true },
    billingPeriod: { type: String, default: null },
    entitlementSource: { type: String, default: null, index: true },
    appsumoTier: { type: Number, default: null },
    featureType: { type: String, default: null, index: true },
    environment: { type: String, default: null, index: true },
    internalFlag: { type: Boolean, default: false, index: true },
    testFlag: { type: Boolean, default: false, index: true },
    botFlag: { type: Boolean, default: false, index: true },
    // Undefined keeps legacy rows out of the unique index; only authoritative
    // events that supply a real key participate in retry deduplication.
    dedupeKey: { type: String, default: undefined },
    ga4EventName: { type: String, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { strict: false, versionKey: false, collection: 'funnel_events' });
// Only string keys participate. A partial unique index avoids the common
// MongoDB pitfall where a default null would occupy the one unique slot.
FunnelEventSchema.index({ dedupeKey: 1 }, {
    unique: true,
    partialFilterExpression: { dedupeKey: { $type: 'string' } },
    name: 'funnel_dedupe_key_unique'
});
const FunnelEvent = mongoose.model('FunnelEvent', FunnelEventSchema);

const ScheduledEmailSchema = new mongoose.Schema({
    emailKey: { type: String, required: true, unique: true, index: true },
    template: { type: String, required: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    to: { type: String, required: true, lowercase: true, trim: true },
    dueAt: { type: Date, required: true, index: true },
    status: { type: String, enum: ['scheduled', 'sent', 'skipped', 'failed'], default: 'scheduled', index: true },
    sentAt: { type: Date, default: null },
    skippedReason: { type: String, default: null },
    lastError: { type: String, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true, versionKey: false, collection: 'scheduled_emails' });
const ScheduledEmail = mongoose.model('ScheduledEmail', ScheduledEmailSchema);

// Explicitly-created, unlisted research pages. There is deliberately no TTL:
// social posts and newsletters need their cited report URL to remain durable.
// Only sanitized plain text is persisted; renderer-side escaping is a second
// layer of defence and createdBy is never exposed on the public page.
const PublicResearchShareSchema = new mongoose.Schema({
    publicId: { type: String, required: true, unique: true, index: true },
    title: { type: String, required: true, maxlength: shareCopy.PUBLIC_SHARE_LIMITS.title },
    content: { type: String, required: true, maxlength: shareCopy.PUBLIC_SHARE_LIMITS.content },
    sourceUrl: { type: String, default: null, maxlength: shareCopy.PUBLIC_SHARE_LIMITS.sourceUrl },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }
}, { timestamps: true, versionKey: false, collection: 'public_research_shares' });
const PublicResearchShare = mongoose.model('PublicResearchShare', PublicResearchShareSchema);

const ManualGmvSnapshotSchema = new mongoose.Schema({
    date: { type: Date, required: true, index: true },
    grossOrders: { type: Number, min: 0, default: 0 },
    grossSales: { type: Number, min: 0, default: 0 },
    refunds: { type: Number, min: 0, default: 0 },
    netOrders: { type: Number, min: 0, default: 0 },
    payoutEstimate: { type: Number, min: 0, default: 0 },
    notes: { type: String, maxlength: 1000, default: '' },
    provenance: { type: String, default: 'Partner Portal manual snapshot' },
    updatedBy: { type: String, default: null }
}, { timestamps: true, versionKey: false, collection: 'manual_gmv_snapshots' });
const ManualGmvSnapshot = mongoose.model('ManualGmvSnapshot', ManualGmvSnapshotSchema);

async function getUserByToken(token) {
    if (!token) {
        throw { status: 401, message: 'Authentication required' };
    }
    let decoded;
    try {
        decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
        throw { status: 401, message: 'Invalid token' };
    }
    const user = await User.findById(decoded.userId);
    if (!user) {
        throw { status: 401, message: 'User not found' };
    }
    if (Number(decoded.v || 0) !== Number(user.authVersion || 0)) {
        throw { status: 401, message: 'Session expired. Please sign in again.' };
    }
    return user;
}

function applyPlanToSubscription(user, planInput) {
    const planConfig = getPlanConfig(planInput || user?.subscription?.planId);
    user.subscription = ensureSubscriptionShape(user);
    user.subscription.planId = planConfig.planId;
    user.subscription.planName = planConfig.planName;
    user.subscription.price = planConfig.price;
    user.subscription.currency = planConfig.currency;
    user.subscription.billingInterval = planConfig.billingInterval;
    user.subscription.stripePriceId = planConfig.stripePriceId || null;
    return planConfig;
}

function cleanShort(value, max = 120) {
    const text = String(value || '').trim();
    return text ? text.slice(0, max) : null;
}

function sanitizeUtm(input = {}) {
    const raw = (input && typeof input === 'object') ? input : {};
    const utm = {
        source: cleanShort(raw.source || raw.utm_source, 80),
        medium: cleanShort(raw.medium || raw.utm_medium, 80),
        campaign: cleanShort(raw.campaign || raw.utm_campaign, 120),
        content: cleanShort(raw.content || raw.utm_content, 120),
        term: cleanShort(raw.term || raw.utm_term, 120)
    };
    return Object.values(utm).some(Boolean) ? utm : null;
}

function requestUtm(req) {
    return sanitizeUtm(req && req.body && req.body.utm);
}

function attachSignupAttribution(user, requestFields) {
    const attribution = requestFields && requestFields.attribution;
    if (!user || !attribution) return;
    user.analyticsAnonymousId = String(attribution.anonymousId || '').slice(0, 80) || null;
    user.analyticsFirstTouch = attribution.firstTouch || null;
    user.analyticsLastNonDirectTouch = attribution.lastNonDirectTouch || null;
}

function eventTypeFor(event, extra = {}) {
    const name = String(event || '');
    if (name === 'free_tool_view') return 'tool_view';
    if (name === 'free_tool_complete') return 'tool_complete';
    if (name === 'appsumo_outbound') return 'appsumo_click';
    if (name === 'paid') return String(extra.source || '') === 'appsumo' ? 'appsumo_redemption' : 'stripe_subscribe';
    return name;
}

function metaForFunnel(extra = {}) {
    const blocked = new Set([
        'event', 'eventType', 'timestamp', 'at', 'sessionId', 'anonymousSessionId',
        'userId', 'ticker', 'symbol', 'toolName', 'toolId', 'contentId', 'utm', 'referrer',
        'text', 'prompt', 'question', 'answer', 'response', 'holdings', 'portfolio', 'email',
        'name', 'license', 'licenseKey', 'password', 'cookie', 'query', 'url'
    ]);
    const meta = {};
    for (const [key, value] of Object.entries(extra || {})) {
        if (blocked.has(key)) continue;
        if (/licensekey|password|token|secret/i.test(key)) continue;
        if (value === undefined || typeof value === 'function') continue;
        meta[key] = value;
    }
    return meta;
}

// ---- Funnel event tracking (server-side, no third-party) ----
// Stored in the existing 'funnel_events' Mongo collection. The newer fields
// (eventType/timestamp/sessionId/utm/meta) sit beside the legacy dashboard
// fields (event/at/anonymousSessionId/acquisitionSource) so old reports keep
// working while the campaign trail becomes queryable.
async function logFunnelEvent(event, userId, plan, extra) {
    try {
        const now = new Date();
        const data = extra || {};
        const canonical = growthMeasurement.canonicalEvent({
            eventName: data.eventName || event,
            userId,
            plan,
            data: { ...data, anonymousId: data.anonymousId || data.anonymousSessionId, isBot: data.isBot, isQa: data.isQa },
            attribution: data.attribution || {},
            now,
            secret: JWT_SECRET
        });
        const requestedDedupeKey = (canonical && canonical.dedupeKey)
            || (data.dedupeKey && /^[A-Za-z0-9._:-]{8,220}$/.test(String(data.dedupeKey)) ? String(data.dedupeKey) : null);
        if (requestedDedupeKey) {
            const duplicate = await FunnelEvent.exists({ dedupeKey: requestedDedupeKey });
            if (duplicate) return false;
        }
        const safeData = { ...data };
        for (const key of Object.keys(safeData)) {
            if (/email|name|password|license|prompt|question|answer|response|holding|cookie|secret|token/i.test(key)) delete safeData[key];
        }
        // Store only pathnames and referrer origins; raw query strings and
        // arbitrary destinations are not measurement dimensions. Attribution
        // touches are re-sanitized even when an internal caller supplies them.
        if (Object.prototype.hasOwnProperty.call(safeData, 'path')) safeData.path = growthMeasurement.sanitizePath(safeData.path);
        if (Object.prototype.hasOwnProperty.call(safeData, 'pagePath')) safeData.pagePath = growthMeasurement.sanitizePath(safeData.pagePath);
        if (Object.prototype.hasOwnProperty.call(safeData, 'referrer')) safeData.referrer = marketingAttribution.sanitizeReferrer(safeData.referrer);
        if (Object.prototype.hasOwnProperty.call(safeData, 'target')) delete safeData.target;
        if (safeData.attribution && typeof safeData.attribution === 'object') {
            const anonymousId = String(safeData.attribution.anonymousId || '');
            safeData.attribution = {
                anonymousId: /^[A-Za-z0-9_-]{16,80}$/.test(anonymousId) ? anonymousId : null,
                firstTouch: growthMeasurement.sanitizeAttribution(safeData.attribution.firstTouch),
                lastNonDirectTouch: growthMeasurement.sanitizeAttribution(safeData.attribution.lastNonDirectTouch),
                currentSessionTouch: growthMeasurement.sanitizeAttribution(safeData.attribution.currentSessionTouch)
            };
        }
        const utm = sanitizeUtm(data.utm) || sanitizeUtm({
            source: data.utmSource || data.acquisitionSource || data.source,
            medium: data.utmMedium,
            campaign: data.utmCampaign,
            content: data.utmContent || data.contentId
        });
        await FunnelEvent.create({
            ...safeData,
            event: String(event),
            eventType: eventTypeFor(event, data),
            campaignId: data.campaignId || (data.contentId || data.acquisitionSource ? augustCampaign.config(now).campaignId : null),
            userId: userId ? String(userId) : null,
            plan: plan ? String(plan) : null,
            timestamp: now,
            at: now,
            sessionId: data.sessionId || data.anonymousSessionId || null,
            anonymousSessionId: data.anonymousSessionId || data.sessionId || null,
            ticker: data.ticker || data.symbol || null,
            symbol: data.symbol || data.ticker || null,
            toolName: data.toolName || data.toolId || null,
            toolId: data.toolId || data.toolName || null,
            utm: utm || undefined,
            referrer: data.referrer || null,
            ...(canonical || {}),
            campaignId: (canonical && canonical.campaignId) || data.campaignId || (data.contentId || data.acquisitionSource ? augustCampaign.config(now).campaignId : null),
            // Do not duplicate sensitive customer-success text in analytics.
            meta: metaForFunnel(safeData)
        });
        if (canonical && data.consent === true && !canonical.internalFlag && !canonical.testFlag && !canonical.botFlag) {
            ga4Server.sendServerEvent({
                event: canonical.ga4EventName || canonical.eventName,
                clientId: canonical.anonymousId,
                sessionId: canonical.sessionId,
                opaqueUserId: canonical.opaqueUserId,
                consent: true,
                params: {
                    page_type: canonical.pageType,
                    content_id: canonical.contentId,
                    cta_id: canonical.ctaId,
                    entitlement_source: canonical.entitlementSource,
                    feature_type: canonical.featureType
                }
            }).catch(() => {});
        }
    } catch (_) { /* non-blocking — funnel data loss is acceptable */ }
}

function trackFunnel(event, userId, plan, extra) {
    return logFunnelEvent(event, userId, plan, extra);
}

// Keep campaign attribution consistent across every funnel event. The signed
// acquisition cookie is the source of truth; never accept a caller-supplied
// URL or arbitrary source string here.
function acquisitionFunnelFields(acquisition) {
    return {
        acquisitionSource: acquisition ? acquisition.source : null,
        acquisitionClickId: acquisition ? acquisition.clickId : null,
        contentId: acquisition ? acquisition.contentId : null,
        acquisitionClickedAt: acquisition ? acquisition.clickedAt : null
    };
}

// Stripe metadata must be strings and should omit absent values (Stripe
// rejects null metadata). These values are copied to webhook events so a
// later paid conversion can still be tied to the original campaign click.
function acquisitionStripeMetadata(acquisition) {
    if (!acquisition) return {};
    const metadata = {};
    if (acquisition.source) metadata.acquisitionSource = String(acquisition.source);
    if (acquisition.clickId) metadata.acquisitionClickId = String(acquisition.clickId);
    if (acquisition.contentId) metadata.contentId = String(acquisition.contentId);
    if (acquisition.clickedAt) metadata.acquisitionClickedAt = new Date(acquisition.clickedAt).toISOString();
    return metadata;
}

const ACTIVATION_JOBS = new Set(['ask', 'comparison', 'screener_company', 'portfolio']);

// August's customer-success gate is intentionally narrower than the legacy
// activation jobs. It records a real, source-backed result and keeps internal
// QA/owner activity out of the customer funnel.
const MEANINGFUL_WORKFLOWS = new Set([
    'ask', 'earnings-quality', 'dilution', 'filing-timeline', 'comparison',
    'filing_monitor', 'screener_company', 'portfolio', 'research'
]);
function campaignInternalUser(user) {
    const email = normalizeEmail(user && user.email);
    if (!email) return true;
    const configured = String(process.env.MARKETING_INTERNAL_EMAILS || '')
        .split(',').map(normalizeEmail).filter(Boolean);
    const defaults = [normalizeEmail(process.env.OWNER_NOTIFICATION_EMAIL), 'support@stockportfolio.pro', 'rin@gmail.com'];
    return [...configured, ...defaults].includes(email);
}

async function meaningfulActivationFor(user, payload = {}) {
    if (!user || !user._id || campaignInternalUser(user) || mongoose.connection.readyState !== 1) return null;
    const workflow = String(payload.workflow || '').trim().toLowerCase();
    const ticker = normalizeTicker(payload.ticker || payload.symbol || '');
    if (!MEANINGFUL_WORKFLOWS.has(workflow) || !isValidTicker(ticker)) return null;
    if (payload.resultValid !== true || payload.sourceOpened !== true) return null;
    const acquisition = payload.acquisition || null;
    const requestFields = payload.requestFields || {};
    const now = new Date();
    const event = {
        event: 'meaningful_activation', userId: String(user._id), ticker, symbol: ticker,
        workflow, resultValid: true, sourceOpened: true, campaignId: augustCampaign.config(now).campaignId,
        contentId: cleanShort(payload.contentId || acquisition && acquisition.contentId || null, 120),
        acquisitionSource: acquisition && acquisition.source || null,
        acquisitionClickId: acquisition && acquisition.clickId || null,
        at: now, timestamp: now, eventType: 'meaningful_activation',
        trafficCategory: payload.trafficCategory || requestFields.referrerSource || requestFields.trafficClass || null,
        anonymousId: requestFields.attribution && requestFields.attribution.anonymousId || requestFields.anonymousSessionId || null,
        sessionId: requestFields.anonymousSessionId || null,
        firstTouch: requestFields.attribution && requestFields.attribution.firstTouch || null,
        lastNonDirectTouch: requestFields.attribution && requestFields.attribution.lastNonDirectTouch || null,
        currentSessionTouch: requestFields.attribution && requestFields.attribution.currentSessionTouch || null,
        opaqueUserId: growthMeasurement.opaqueUserId(String(user._id), JWT_SECRET),
        eventName: 'research_outcome_completed', schemaVersion: growthMeasurement.SCHEMA_VERSION,
        eventId: growthMeasurement.randomEventId(),
        dedupeKey: `research_outcome_completed:${String(user._id)}:${workflow}:${ticker}`,
        pageType: 'research', pagePath: '/',
        entitlementSource: user.appsumoRedeemedAt ? 'appsumo' : (user.stripeSubscriptionId ? 'stripe' : 'trial'),
        appsumoTier: Number(user.appsumoTier) || null,
        environment: process.env.NODE_ENV || 'development',
        internalFlag: false, testFlag: false, botFlag: false,
        featureType: workflow === 'screener_company' ? 'screener' : (workflow === 'filing-timeline' ? 'filing_monitor' : workflow),
        meta: metaForFunnel({ workflow, resultValid: true, sourceOpened: true })
    };
    const result = await mongoose.connection.collection('funnel_events').updateOne(
        { event: 'meaningful_activation', userId: String(user._id), workflow, ticker },
        { $set: { sourceOpened: true, resultValid: true }, $setOnInsert: event }, { upsert: true }
    );
    // One account-level activation is emitted on the first successful outcome;
    // the underlying research outcome remains available for cohort analysis.
    if (result.upsertedCount) {
        trackFunnel('first_research_completed', user._id, user.subscription && user.subscription.planName, {
            eventName: 'first_research_completed',
            dedupeKey: `first-research-complete:${String(user._id)}`,
            workflow, ticker, symbol: ticker, resultValid: true, sourceOpened: true,
            contentId: event.contentId, acquisitionSource: event.acquisitionSource,
            acquisitionClickId: event.acquisitionClickId,
            entitlementSource: event.entitlementSource, appsumoTier: event.appsumoTier,
            featureType: event.featureType
        });
        const activationNow = new Date();
        await mongoose.connection.collection('funnel_events').updateOne(
            { eventName: 'activation_completed', userId: String(user._id) },
            { $setOnInsert: {
                event: 'activation', eventType: 'activation', eventName: 'activation_completed',
                schemaVersion: growthMeasurement.SCHEMA_VERSION, eventId: growthMeasurement.randomEventId(),
                dedupeKey: `activation_completed:${String(user._id)}`, userId: String(user._id),
                anonymousId: event.anonymousId, sessionId: event.sessionId, opaqueUserId: event.opaqueUserId,
                firstTouch: event.firstTouch, lastNonDirectTouch: event.lastNonDirectTouch,
                currentSessionTouch: event.currentSessionTouch, pageType: event.pageType, pagePath: event.pagePath,
                contentId: event.contentId, entitlementSource: event.entitlementSource,
                appsumoTier: event.appsumoTier, environment: event.environment,
                trafficCategory: event.trafficCategory,
                featureType: event.featureType, workflow, ticker, symbol: ticker,
                resultValid: true, sourceOpened: true, at: activationNow, timestamp: activationNow,
                occurredAt: activationNow, internalFlag: false, testFlag: false, botFlag: false,
                meta: metaForFunnel({ workflow, activation: true })
            } }, { upsert: true }
        );
        await User.updateOne({ _id: user._id }, {
            $set: { lastSuccessfulOutcomeAt: activationNow },
            $inc: { successfulOutcomeCount: 1 }
        });
        await User.updateOne({ _id: user._id, firstActivationAt: null }, { $set: { firstActivationAt: activationNow } });
    }
    const count = await mongoose.connection.collection('funnel_events').countDocuments({
        event: 'meaningful_activation', userId: String(user._id), resultValid: true, sourceOpened: true
    });
    const sessionIds = await mongoose.connection.collection('funnel_events').distinct('sessionId', {
        userId: String(user._id), sessionId: { $ne: null }, event: { $in: ['meaningful_activation', 'activation', 'ai_answer', 'page_view'] }
    });
    let reviewEligible = Boolean(user.reviewEligibleAt);
    if (!reviewEligible && (count >= 2 || (count >= 1 && sessionIds.length >= 2) || sessionIds.length >= 3)) {
        await User.updateOne({ _id: user._id, reviewEligibleAt: null }, { $set: { reviewEligibleAt: now } });
        reviewEligible = true;
        trackFunnel('review_eligible', user._id, user.subscription && user.subscription.planName, {
            eventName: 'review_eligible', dedupeKey: `review-eligible:${String(user._id)}`,
            entitlementSource: user.appsumoRedeemedAt ? 'appsumo' : (user.stripeSubscriptionId ? 'stripe' : 'trial')
        });
        scheduleAppSumoReviewEligibility(user).catch(() => {});
    }
    if (result.upsertedCount || result.matchedCount) {
        scheduleAppSumoActivationNext(user).catch(() => {});
    }
    return { reviewEligible, count };
}

// Activation is deliberately idempotent per user/job. The upsert key keeps a
// retrying browser beacon from inflating the marketing funnel while preserving
// the first completion timestamp and campaign metadata.
async function trackActivation(userId, job, extra = {}) {
    if (!userId || !ACTIVATION_JOBS.has(String(job))) return false;
    if (mongoose.connection.readyState !== 1) return false;
    const activationJob = String(job);
    try {
        await mongoose.connection.collection('funnel_events').updateOne(
            { event: 'activation', userId: String(userId), activationJob },
            { $setOnInsert: {
                ...(extra || {}), event: 'activation', userId: String(userId),
                activationJob, eventName: 'activation_completed', schemaVersion: growthMeasurement.SCHEMA_VERSION,
                eventId: growthMeasurement.randomEventId(), dedupeKey: `activation-job:${String(userId)}:${activationJob}`,
                featureType: activationJob === 'screener_company' ? 'screener' : activationJob,
                occurredAt: new Date(), at: new Date()
            } },
            { upsert: true }
        );
        // A return is only counted after a prior activation has aged seven
        // days. The event is idempotent and contains no research text.
        const user = await User.findById(userId).select({ firstActivationAt: 1, subscription: 1 }).lean();
        const firstActivationAt = user && user.firstActivationAt ? new Date(user.firstActivationAt) : null;
        if (firstActivationAt && Number.isFinite(firstActivationAt.getTime())
            && Date.now() - firstActivationAt.getTime() >= 7 * 86400000) {
            trackFunnel('seven_day_return', userId, user.subscription && user.subscription.planName, {
                eventName: 'seven_day_return',
                dedupeKey: `seven-day-return:${String(userId)}:${firstActivationAt.toISOString().slice(0, 10)}`,
                featureType: 'other', ...extra
            });
        }
        return true;
    } catch (_) {
        return false;
    }
}

function trackFirstAskSuccess(req, user, result) {
    if (!req || !user || !user._id || !result || result.source !== 'ai' || !result.answer) return;
    const acquisition = shareCopy.parseAcquisitionCookieHeader(req.headers.cookie, { secret: JWT_SECRET });
    trackFunnel('first_ask_succeeded', user._id, user.subscription && user.subscription.planName, {
        eventName: 'first_ask_succeeded',
        dedupeKey: `first-ask-success:${String(user._id)}`,
        featureType: 'ask',
        entitlementSource: user.appsumoRedeemedAt ? 'appsumo' : (user.stripeSubscriptionId ? 'stripe' : 'trial'),
        appsumoTier: Number(user.appsumoTier) || null,
        acquisitionSource: acquisition && acquisition.source || null,
        acquisitionClickId: acquisition && acquisition.clickId || null,
        contentId: acquisition && acquisition.contentId || null
    });
}

function effectiveTrialStatus(user, now = Date.now()) {
    const sub = user && user.subscription ? user.subscription : {};
    if (sub.status === 'trialing' && sub.trialEndsAt
        && new Date(sub.trialEndsAt).getTime() <= now
        && !user.stripeSubscriptionId && !user.appsumoRedeemedAt) {
        return 'expired';
    }
    if (sub.expiredAt && new Date(sub.expiredAt).getTime() <= now
        && !user.stripeSubscriptionId && !user.appsumoRedeemedAt) return 'expired';
    return sub.status || 'pending';
}

// Expire only local/no-card trials. Stripe trials are owned by Stripe's
// subscription webhooks and AppSumo access is lifetime; neither may be changed
// by this sweep.
async function expireNoCardTrials() {
    if (mongoose.connection.readyState !== 1) return { matchedCount: 0, modifiedCount: 0 };
    const result = await User.updateMany({
        'subscription.status': 'trialing',
        'subscription.trialEndsAt': { $ne: null, $lte: new Date() },
        stripeSubscriptionId: null,
        appsumoRedeemedAt: null
    }, { $set: { 'subscription.status': 'cancelled', 'subscription.expiredAt': new Date() } });
    return {
        matchedCount: Number(result.matchedCount || result.n || 0),
        modifiedCount: Number(result.modifiedCount || result.nModified || 0)
    };
}

async function recordCustomerLifecycleEvent(user, type, { source, appsumoTier, discoverySource } = {}) {
    if (!user || !user._id || !user.email) return { created: false, reason: 'missing user email' };
    const normalizedType = String(type || '');
    const normalizedSource = source || (normalizedType === 'appsumo_redeemed' ? 'appsumo' : normalizedType === 'stripe_paid' ? 'stripe' : 'direct');
    let event;
    try {
        event = await CustomerLifecycleEvent.create({
            eventKey: `${String(user._id)}:${normalizedType}`,
            userId: user._id,
            email: String(user.email).trim().toLowerCase(),
            name: user.name || null,
            type: normalizedType,
            source: normalizedSource,
            planId: user.subscription && user.subscription.planId,
            planName: user.subscription && user.subscription.planName,
            subscriptionStatus: user.subscription && user.subscription.status,
            appsumoTier: Number(appsumoTier || user.appsumoTier) || null,
            discoverySource: normalizeAppSumoDiscoverySource(discoverySource || user.discoverySource)
        });
    } catch (error) {
        if (error && error.code === 11000) return { created: false, duplicate: true };
        throw error;
    }

    if (normalizedType === 'stripe_paid' || normalizedType === 'appsumo_redeemed') {
        const sent = await mailer.sendCustomerLifecycleEmails({
            name: user.name,
            email: user.email,
            type: normalizedType,
            plan: user.subscription && user.subscription.planName,
            tier: Number(appsumoTier || user.appsumoTier) || null,
            occurredAt: event.createdAt
        });
        const updates = {};
        if (sent.customerSent) updates.customerEmailedAt = new Date();
        if (sent.ownerSent) updates.ownerNotifiedAt = new Date();
        if (Object.keys(updates).length) await CustomerLifecycleEvent.updateOne({ _id: event._id }, { $set: updates });
    }
    return { created: true, eventId: event._id };
}

function trialSourceLabel(fields = {}) {
    return cleanShort(fields.utm?.source || fields.acquisitionSource || fields.source || fields.referrerSource || 'unknown', 80);
}

async function notifyTrialStartedInternal(user, fields = {}) {
    if (!user || !user._id || !user.email) return false;
    const updated = await User.updateOne(
        { _id: user._id, trialInternalNotifiedAt: null },
        { $set: { trialInternalNotifiedAt: new Date() } }
    );
    if (!Number(updated.modifiedCount || updated.nModified || 0)) return false;
    const source = trialSourceLabel(fields);
    const plan = user.subscription && (user.subscription.planName || user.subscription.planId) || 'Pro trial';
    const text = [
        'New trial started',
        `Email: ${user.email}`,
        `Name: ${user.name || '(not provided)'}`,
        `Plan: ${plan}`,
        `UTM/source: ${source}`,
        fields.utm?.campaign ? `UTM campaign: ${fields.utm.campaign}` : null,
        fields.utm?.medium ? `UTM medium: ${fields.utm.medium}` : null,
        fields.contentId ? `Content ID: ${fields.contentId}` : null,
        fields.acquisitionClickId ? `Click ID: ${fields.acquisitionClickId}` : null,
        `When: ${new Date().toISOString()}`
    ].filter(Boolean).join('\n');
    return mailer.sendMail({
        to: process.env.TRIAL_NOTIFY_EMAIL || process.env.SUPPORT_INBOX_EMAIL || 'support@stockportfolio.pro',
        subject: `New trial started: ${user.email}`,
        text,
        html: `<pre style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`
    });
}

async function scheduleAppSumoReviewRequest(user, { licenseKey, tier } = {}) {
    if (!user || !user._id || !user.email) return false;
    const redeemedAt = user.appsumoRedeemedAt ? new Date(user.appsumoRedeemedAt) : new Date();
    const dueAt = new Date(redeemedAt.getTime() + 5 * 86400000);
    try {
        await ScheduledEmail.updateOne(
            { emailKey: `appsumo-review-5d:${String(user._id)}` },
            { $setOnInsert: {
                emailKey: `appsumo-review-5d:${String(user._id)}`,
                template: 'appsumo_review_5d',
                userId: user._id,
                to: String(user.email).trim().toLowerCase(),
                dueAt,
                status: 'scheduled',
                meta: {
                    licenseKey: licenseKey ? '[redacted]' : null,
                    appsumoTier: Number(tier || user.appsumoTier) || null
                }
            } },
            { upsert: true }
        );
        return true;
    } catch (_) {
        return false;
    }
}

async function scheduleAppSumoOnboarding(user, { tier } = {}) {
    if (!user || !user._id || !user.email) return false;
    try {
        await ScheduledEmail.updateOne(
            { emailKey: `appsumo-onboarding:${String(user._id)}` },
            { $setOnInsert: {
                emailKey: `appsumo-onboarding:${String(user._id)}`,
                template: 'appsumo_onboarding', userId: user._id,
                to: normalizeEmail(user.email), dueAt: new Date(Date.now() + 5 * 60000), status: 'scheduled',
                meta: { appsumoTier: Number(tier || user.appsumoTier) || null, campaignId: augustCampaign.config().campaignId }
            } }, { upsert: true }
        );
        return true;
    } catch (_) { return false; }
}

async function scheduleAppSumoActivationNext(user) {
    if (!user || !user._id || !user.email || !user.appsumoRedeemedAt) return false;
    try {
        await ScheduledEmail.updateOne(
            { emailKey: `appsumo-activation-next:${String(user._id)}` },
            { $setOnInsert: {
                emailKey: `appsumo-activation-next:${String(user._id)}`,
                template: 'appsumo_activation_next', userId: user._id,
                to: normalizeEmail(user.email), dueAt: new Date(Date.now() + 24 * 3600000), status: 'scheduled',
                meta: { campaignId: augustCampaign.config().campaignId }
            } }, { upsert: true }
        );
        return true;
    } catch (_) { return false; }
}

async function scheduleAppSumoReviewEligibility(user) {
    if (!user || !user._id || !user.email || !user.appsumoRedeemedAt) return false;
    try {
        await ScheduledEmail.updateOne(
            { emailKey: `appsumo-review-eligible:${String(user._id)}` },
            { $setOnInsert: {
                emailKey: `appsumo-review-eligible:${String(user._id)}`,
                template: 'appsumo_review_eligible', userId: user._id,
                to: normalizeEmail(user.email), dueAt: new Date(), status: 'scheduled',
                meta: { campaignId: augustCampaign.config().campaignId }
            } }, { upsert: true }
        );
        return true;
    } catch (_) { return false; }
}

// Campaign-safe AppSumo redirect. Only named, allowlisted channels are accepted;
// the destination is a validated server-side URL, never request-controlled.
// The signed cookie contains only channel, time, allowlisted content ID and a
// random click ID (no PII).
app.get('/go/appsumo/:source', (req, res) => {
    const source = shareCopy.normalizeAppSumoSource(req.params.source);
    const contentId = shareCopy.normalizeAcquisitionContentId(req.query.content_id);
    const clickId = shareCopy.normalizeAcquisitionClickId(req.query.click_id);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    if (!source) return res.status(404).send('Unknown AppSumo campaign source.');

    const value = shareCopy.createAcquisitionCookieValue(source, { secret: JWT_SECRET, contentId, clickId });
    const cookie = shareCopy.serializeAcquisitionCookie(value, {
        secure: process.env.NODE_ENV === 'production' || Boolean(req.secure),
        domain: shareCopy.acquisitionCookieDomain(req.hostname)
    });
    if (cookie) res.setHeader('Set-Cookie', cookie);
    const acquisition = value
        ? shareCopy.parseAcquisitionCookieHeader(`${shareCopy.ACQUISITION_COOKIE_NAME}=${encodeURIComponent(value)}`, { secret: JWT_SECRET })
        : null;
    const reportId = shareCopy.isPublicShareId(req.query.rid) ? String(req.query.rid) : null;
    const utm = sanitizeUtm(req.query);
    trackFunnel('appsumo_outbound', null, null, {
        source,
        contentId,
        utm,
        acquisitionClickId: acquisition ? acquisition.clickId : null,
        reportId,
        ...marketingRequestFields(req, res)
    });
    return res.redirect(302, APPSUMO_OUTBOUND_URL);
});

async function activateSubscription(user, { subscriptionId, customerId, planId, stripeStatus, trialEndsAt, stripePriceId } = {}) {
    const now = new Date();
    const planConfig = applyPlanToSubscription(user, planId);
    user.subscription.status = stripeStatus === 'trialing' ? 'trialing' : 'active';
    user.subscription.activatedAt = user.subscription.activatedAt || now;
    user.subscription.renewedAt = now;
    user.subscription.trialStartedAt = user.subscription.trialStartedAt || now;
    user.subscription.trialEndsAt =
        user.subscription.status === 'trialing'
            ? (trialEndsAt || user.subscription.trialEndsAt || defaultTrialEndsAt())
            : null;
    user.subscription.lastPaymentAt = now;
    user.subscription.stripePriceId = stripePriceId || planConfig.stripePriceId || user.subscription.stripePriceId || null;
    if (subscriptionId) {
        user.stripeSubscriptionId = subscriptionId;
    }
    if (customerId) {
        user.stripeCustomerId = customerId;
    }
    user.markModified('subscription');
    await user.save().catch(() => {});
}

async function syncSubscriptionFromStripe(user, subscription, customerId) {
    const stripePriceId = subscription?.items?.data?.[0]?.price?.id || null;
    const planConfig = getPlanConfigByPriceId(stripePriceId) || getPlanConfig(subscription?.metadata?.planId || user?.subscription?.planId);
    const trialEndsAt = subscription?.trial_end ? new Date(subscription.trial_end * 1000) : null;
    const stripeStatus = subscription?.cancel_at_period_end
        ? 'cancel_at_period_end'
        : (subscription?.status === 'trialing' ? 'trialing' : 'active');

    await activateSubscription(user, {
        subscriptionId: subscription?.id,
        customerId: customerId || subscription?.customer || user?.stripeCustomerId || null,
        planId: planConfig.planId,
        stripeStatus,
        trialEndsAt,
        stripePriceId
    });
}

// A first paid invoice starts the explicit refund window. Only users marked by
// the new registration flow are eligible, so legacy subscribers and lifetime
// AppSumo/DealMirror entitlements are untouched.
async function recordInitialStripePayment(user, invoice, fallbackAt = new Date()) {
    if (!user || !invoice || !user.paymentRequiredAt || user.initialPaymentAt) return false;
    const paidAtSeconds = Number(invoice.status_transitions && invoice.status_transitions.paid_at);
    const paidAt = Number.isFinite(paidAtSeconds) && paidAtSeconds > 0
        ? new Date(paidAtSeconds * 1000)
        : new Date(fallbackAt);
    const paymentIntent = typeof invoice.payment_intent === 'string'
        ? invoice.payment_intent
        : invoice.payment_intent && invoice.payment_intent.id;
    const charge = typeof invoice.charge === 'string'
        ? invoice.charge
        : invoice.charge && invoice.charge.id;
    user.initialPaymentAt = paidAt;
    user.initialRefundUntil = new Date(paidAt.getTime() + INITIAL_REFUND_WINDOW_MS);
    user.initialRefundStatus = 'eligible';
    user.initialInvoiceId = invoice.id || user.initialInvoiceId || null;
    user.initialPaymentIntentId = paymentIntent || user.initialPaymentIntentId || null;
    user.initialChargeId = charge || user.initialChargeId || null;
    await user.save();
    return true;
}

function createUserToken(user) {
    return jwt.sign({ userId: user._id, v: Number(user.authVersion || 0) }, JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '7d' });
}

async function createCheckoutSessionForUser(user, extraMetadata = {}) {
    if (!stripe) {
        throw createHttpError(500, 'Stripe is not configured');
    }
    await ensureStripeAccountPreflight();
    const planConfig = getPlanConfig(extraMetadata.planId || user?.subscription?.planId);
    if (!planConfig.stripePriceId) {
        throw createHttpError(500, `${planConfig.planName} Stripe price is not configured`);
    }
    const metadata = { ...(extraMetadata.metadata || {}), ...(extraMetadata.affiliateMetadata || {}) };
    const returnContext = extraMetadata.returnContext || {};
    const successUrl = extraMetadata.successUrl || buildStripeReturnUrl(extraMetadata.req, {
        session: 'success',
        planId: planConfig.planId,
        ...returnContext
    });
    const cancelUrl = extraMetadata.cancelUrl || buildStripeReturnUrl(extraMetadata.req, {
        session: 'cancel',
        planId: planConfig.planId,
        ...returnContext
    });
    const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'subscription',
        customer_email: user.email,
        line_items: [{
            price: planConfig.stripePriceId,
            quantity: 1
        }],
        client_reference_id: user._id.toString(),
        success_url: successUrl,
        cancel_url: cancelUrl,
        custom_text: {
            submit: {
                message: extraMetadata.initialSignup === true
                    ? `Charged today. If the service is not right for you, request a full refund within ${INITIAL_REFUND_DAYS} days.`
                    : (planConfig.planId === ANNUAL_PLAN_ID
                        ? 'Annual plan for long-term investors. Cancel anytime.'
                        : 'Monthly plan, billed today. Cancel anytime before renewal.')
            }
        },
        subscription_data: {
            metadata: {
                userId: user._id.toString(),
                planId: planConfig.planId,
                billingInterval: planConfig.billingInterval,
                ...Object.fromEntries(Object.entries(extraMetadata.affiliateMetadata || {}).map(([key, value]) => [key, String(value)]))
            },
            ...((planConfig.trialDays > 0 && !extraMetadata.skipTrial) ? { trial_period_days: planConfig.trialDays } : {})
        },
        metadata: {
            userId: user._id.toString(),
            planId: planConfig.planId,
            billingInterval: planConfig.billingInterval,
            stripePriceId: planConfig.stripePriceId,
            ...metadata
        }
    });
    const requestFields = extraMetadata.req ? trackingRequestFields(extraMetadata.req, null) : {};
    trackFunnel('stripe_checkout_created', user._id, planConfig.planName, {
        eventName: 'stripe_checkout_created',
        dedupeKey: session && session.id ? `stripe_checkout_created:${session.id}` : null,
        pageType: 'pricing',
        billingPeriod: planConfig.billingInterval,
        entitlementSource: 'stripe',
        ...requestFields,
        ...((extraMetadata.metadata && {
            acquisitionSource: extraMetadata.metadata.acquisitionSource || null,
            acquisitionClickId: extraMetadata.metadata.acquisitionClickId || null,
            contentId: shareCopy.normalizeAcquisitionContentId(extraMetadata.metadata.contentId)
        }) || {})
    });
    return session;
}

const SupportTicketSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true },
    subject: { type: String, required: true },
    message: { type: String, required: true },
    status: { type: String, enum: ['open', 'closed'], default: 'open' }
}, { timestamps: true });
const SupportTicket = mongoose.model('SupportTicket', SupportTicketSchema);

// Per-user holdings used by the Dashboard portfolio tracker. The model name is
// retained for database compatibility; assetType distinguishes stocks/funds.
const StockSchema = new mongoose.Schema({
    symbol: { type: String, required: true },
    name: { type: String },
    sector: { type: String },
    assetType: { type: String, enum: ['stock', 'etf', 'mutual_fund', 'crypto', 'other'], default: 'stock' },
    quoteType: { type: String },
    category: { type: String },
    shares: { type: Number, required: true },
    purchasePrice: { type: Number },
    purchaseDate: { type: Date },
    currentPrice: { type: Number },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
});
const Stock = mongoose.model('Stock', StockSchema);

// One watchlist per user — a flat set of tickers to keep an eye on.
const WatchlistSchema = new mongoose.Schema({
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    symbols: { type: [String], default: [] }
});
const Watchlist = mongoose.model('Watchlist', WatchlistSchema);

const priceCache = new Map();
const profileCache = new Map();

// Common crypto tickers users might add as portfolio holdings. Anything
// in this set is routed to Yahoo's quote endpoint (with -USD suffix);
// anything already matching the -USD/-USDT pattern is treated as crypto
// regardless of base symbol.
const CRYPTO_BASE_TICKERS = new Set([
    'BTC','ETH','SOL','DOGE','XRP','ADA','BNB','LTC','BCH','MATIC',
    'DOT','AVAX','LINK','UNI','ATOM','FIL','XLM','TRX','ETC','ALGO',
    'SHIB','APE','NEAR','OP','ARB','AAVE','INJ','TIA','SUI','PEPE'
]);
function isCryptoSymbol(ticker) {
    const t = String(ticker || '').toUpperCase();
    if (/-(USD|USDT|EUR|GBP)$/.test(t)) return true;
    return CRYPTO_BASE_TICKERS.has(t);
}
function toCryptoYahooSymbol(ticker) {
    const t = String(ticker || '').toUpperCase();
    if (/-(USD|USDT|EUR|GBP)$/.test(t)) return t;
    return `${t}-USD`;
}
async function getCryptoPrice(ticker) {
    const yahooSymbol = toCryptoYahooSymbol(ticker);
    const cached = cacheGet(priceCache, yahooSymbol, ALPHA_CACHE_TTL_MS.quote);
    if (typeof cached === 'number' && Number.isFinite(cached)) return cached;
    try {
        const q = await yahooFinance.quote(yahooSymbol);
        const price = Number(q?.regularMarketPrice);
        if (Number.isFinite(price)) {
            cacheSet(priceCache, yahooSymbol, price);
            return price;
        }
        throw new Error('No price in Yahoo response');
    } catch (error) {
        throw new Error(`Error fetching crypto price for ${ticker}: ${error.message}`);
    }
}

async function getStockPrice(symbol, client = alphaClient) {
    const ticker = String(symbol || '').toUpperCase();
    if (!ticker) throw new Error('Symbol required');
    if (isCryptoSymbol(ticker)) return getCryptoPrice(ticker);
    const cachedPrice = cacheGet(priceCache, ticker, ALPHA_CACHE_TTL_MS.quote);
    if (typeof cachedPrice === 'number' && Number.isFinite(cachedPrice)) {
        return cachedPrice;
    }
    try {
        const quote = await client.globalQuote(ticker);
        const price = parseFloat(quote['05. price']);
        if (Number.isFinite(price)) {
            cacheSet(priceCache, ticker, price);
            return price;
        }
    } catch (_) { /* fall through to intraday */ }
    try {
        const timeSeries = await client.intraday(ticker, '5min');
        const latest = Object.keys(timeSeries)[0];
        if (latest) {
            const currentPrice = parseFloat(timeSeries[latest]['4. close']);
            if (Number.isFinite(currentPrice)) {
                cacheSet(priceCache, ticker, currentPrice);
                return currentPrice;
            }
        }
        throw new Error('Intraday data unavailable');
    } catch (error) {
        throw new Error(`Error fetching stock price for ${ticker}: ${error.response?.data || error.message}`);
    }
}

async function getCompanyProfile(symbol, client = alphaClient) {
    const ticker = String(symbol || '').toUpperCase();
    if (!ticker) return { name: '', sector: '', industry: '' };
    const cached = profileCache.get(ticker);
    const now = Date.now();
    if (cached && now - cached.timestamp < 1000 * 60 * 30) return cached.data;

    // Crypto: Yahoo carries shortName / longName / typeDisp on its quote.
    if (isCryptoSymbol(ticker)) {
        try {
            const q = await yahooFinance.quote(toCryptoYahooSymbol(ticker));
            const profile = {
                name: q?.longName || q?.shortName || ticker,
                sector: 'Cryptocurrency',
                industry: ''
            };
            profileCache.set(ticker, { data: profile, timestamp: now });
            return profile;
        } catch (_) {
            const fallback = { name: ticker, sector: 'Cryptocurrency', industry: '' };
            profileCache.set(ticker, { data: fallback, timestamp: now });
            return fallback;
        }
    }

    const local = topCompaniesBySymbol.get(ticker);
    if (local) {
        const profile = { name: local.name || ticker, sector: local.sector || '', industry: '' };
        profileCache.set(ticker, { data: profile, timestamp: now });
        return profile;
    }
    try {
        const data = await client.overview(ticker);
        const profile = {
            name: data.Name || ticker,
            sector: data.Sector || '',
            industry: data.Industry || ''
        };
        profileCache.set(ticker, { data: profile, timestamp: now });
        return profile;
    } catch (_) {
        const fallback = { name: ticker, sector: '', industry: '' };
        profileCache.set(ticker, { data: fallback, timestamp: now });
        return fallback;
    }
}

async function verifyGoogleSocialCredential(credential) {
    if (!GOOGLE_CLIENT_ID || !googleOauthClient) {
        throw createHttpError(503, 'Google sign-in is not configured');
    }
    if (!credential) {
        throw createHttpError(400, 'Google credential is required');
    }

    let ticket;
    try {
        ticket = await googleOauthClient.verifyIdToken({
            idToken: credential,
            audience: GOOGLE_CLIENT_ID
        });
    } catch (_) {
        throw createHttpError(401, 'Google sign-in could not be verified');
    }

    const payload = ticket.getPayload() || {};
    const email = normalizeEmail(payload.email);
    if (!payload.sub || !email || !payload.email_verified) {
        throw createHttpError(400, 'Google account must include a verified email address');
    }

    return {
        provider: 'google',
        providerUserId: String(payload.sub),
        email,
        name: String(payload.name || payload.given_name || email).trim(),
        avatarUrl: payload.picture || null
    };
}

async function verifyFacebookAccessToken(accessToken) {
    if (!FACEBOOK_APP_ID || !FACEBOOK_APP_SECRET) {
        throw createHttpError(503, 'Facebook login is not configured');
    }
    if (!accessToken) {
        throw createHttpError(400, 'Facebook access token is required');
    }

    let debugData;
    try {
        const appAccessToken = `${FACEBOOK_APP_ID}|${FACEBOOK_APP_SECRET}`;
        const debugResponse = await axios.get('https://graph.facebook.com/debug_token', {
            params: {
                input_token: accessToken,
                access_token: appAccessToken
            }
        });
        debugData = debugResponse?.data?.data || null;
    } catch (_) {
        throw createHttpError(401, 'Facebook login could not be verified');
    }

    if (!debugData?.is_valid) {
        throw createHttpError(401, 'Facebook access token is invalid');
    }
    if (String(debugData.app_id || '') !== String(FACEBOOK_APP_ID)) {
        throw createHttpError(401, 'Facebook access token does not belong to this app');
    }

    let profile;
    try {
        const profileResponse = await axios.get('https://graph.facebook.com/me', {
            params: {
                fields: 'id,name,email,picture.type(large)',
                access_token: accessToken
            }
        });
        profile = profileResponse?.data || null;
    } catch (_) {
        throw createHttpError(401, 'Facebook profile could not be loaded');
    }

    const email = normalizeEmail(profile?.email);
    if (!profile?.id || !email) {
        throw createHttpError(400, 'Facebook account must include an email address');
    }

    return {
        provider: 'facebook',
        providerUserId: String(profile.id),
        email,
        name: String(profile.name || email).trim(),
        avatarUrl: profile?.picture?.data?.url || null
    };
}

async function verifySocialIdentity(provider, payload = {}) {
    const normalizedProvider = String(provider || '').trim().toLowerCase();
    if (normalizedProvider === 'google') {
        return verifyGoogleSocialCredential(payload.credential);
    }
    if (normalizedProvider === 'facebook') {
        return verifyFacebookAccessToken(payload.accessToken);
    }
    throw createHttpError(400, 'Unsupported social login provider');
}

async function findOrCreateSocialUser(profile) {
    const providerField = profile.provider === 'google' ? 'googleId' : 'facebookId';
    const lookup = [{ [providerField]: profile.providerUserId }];
    if (profile.email) {
        lookup.push({ email: profile.email });
    }

    let user = await User.findOne({ $or: lookup });
    const created = !user;
    if (!user) {
        user = new User({
            name: profile.name,
            email: profile.email,
            password: null
        });
    }

    const conflict = await User.findOne({
        [providerField]: profile.providerUserId,
        _id: { $ne: user._id }
    });
    if (conflict) {
        throw createHttpError(409, 'This social account is already linked to another user');
    }

    if (!user.name && profile.name) {
        user.name = profile.name;
    }
    if (!user.email && profile.email) {
        user.email = profile.email;
    }
    if (profile.avatarUrl) {
        user.avatarUrl = profile.avatarUrl;
    }
    user[providerField] = profile.providerUserId;
    user.subscription = ensureSubscriptionShape(user);
    user.markModified('subscription');
    await user.save();

    if (created) {
        recordCustomerLifecycleEvent(user, 'signup', { source: 'social' })
            .catch((e) => console.error('[customers] social signup registry error:', e && e.message));
        // New social signup: onboarding email + owner notification (fire-and-forget).
        sendNewUserEmails({ name: user.name, email: user.email, plan: profile.provider ? `social (${profile.provider})` : 'social' })
            .catch((e) => console.error('[mailer] new-user email error:', e && e.message));
    }

    return { user, created };
}

// Middleware to authenticate user and enforce subscription
async function authMiddleware(req, res, next) {
    const token = authTokenFromRequest(req);
    if (!token) {
        return res.status(401).json({ message: 'Authentication required' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await User.findById(decoded.userId);
        if (!user) {
            return res.status(401).json({ message: 'User not found' });
        }
        if (Number(decoded.v || 0) !== Number(user.authVersion || 0)) {
            return res.status(401).json({ message: 'Session expired. Please sign in again.' });
        }

        const normalized = ensureSubscriptionShape(user);
        if (user.isModified('subscription')) {
            await user.save().catch(() => {});
        }

        req.userId = user._id;
        req.user = user;
        req.subscription = normalized;
        ollamaUsage.setActor({ userId: user._id, email: user.email, actorType: 'user' });
        // free / core / pro — an expired or never-started subscription now
        // downgrades to the free tier (coreGate/proGate 402 on gated routes)
        // instead of locking the whole API behind a blanket 402.
        req.tier = userTier(user, normalized);
        next();
    } catch (error) {
        if (isDatabaseUnavailableError(error)) {
            return res.status(503).json({ message: 'Database unavailable. Start MongoDB and configure MONGODB_URI.' });
        }
        if (error instanceof jwt.JsonWebTokenError) {
            return res.status(401).json({ message: 'Invalid token' });
        }
        console.error('authMiddleware error:', error);
        return res.status(500).json({ message: 'Authentication failed' });
    }
}

// Optional auth: like authMiddleware but NEVER rejects. Resolves req.tier from a
// valid token when present; logged-out or invalid token → 'free'. For public
// pages that reveal extra data to subscribers (e.g. guru performance + activity).
async function optionalAuth(req, res, next) {
    req.tier = 'free';
    const token = authTokenFromRequest(req);
    if (!token) return next();
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await User.findById(decoded.userId);
        if (user) {
            if (Number(decoded.v || 0) !== Number(user.authVersion || 0)) return next();
            const normalized = ensureSubscriptionShape(user);
            req.user = user;
            req.subscription = normalized;
            ollamaUsage.setActor({ userId: user._id, email: user.email, actorType: 'user' });
            req.tier = userTier(user, normalized);
        }
    } catch (_) { /* invalid / expired token → treat as logged-out (free) */ }
    next();
}

// Email-to-SMS gateways (phone-number@carrier). Signup bots use these to text
// strangers' phones via our welcome email — no human signs up with one.
const SMS_GATEWAY_DOMAINS = new Set([
    'vtext.com', 'vzwpix.com',                      // Verizon
    'txt.att.net', 'mms.att.net',                   // AT&T
    'tmomail.net',                                  // T-Mobile
    'messaging.sprintpcs.com', 'pm.sprint.com',     // Sprint
    'msg.fi.google.com',                            // Google Fi
    'sms.myboostmobile.com', 'myboostmobile.com',   // Boost
    'mymetropcs.com', 'email.uscc.net', 'text.republicwireless.com'
]);

// Subscription signup route
app.post('/api/subscribe', async (req, res) => {
    const { name, email, password } = req.body || {};
    const acquisition = shareCopy.parseAcquisitionCookieHeader(req.headers.cookie, { secret: JWT_SECRET });
    const requestFields = trackingRequestFields(req, res);
    const utm = requestUtm(req);
    const appsumoActivationSignup = isAppSumoActivationSignup(req);
    // Honeypot: the register form ships a visually hidden "website" field that
    // humans never see or fill. A non-empty value is a form bot — swallow the
    // submission (no account, no email, no funnel event) but answer 200 so the
    // bot doesn't learn it was detected and adapt.
    if (String(req.body?.website || '').trim()) {
        return res.status(200).json({ ok: true });
    }
    const selectedPlan = normalizePlanSelection(req.body?.plan);
    const planConfig = getPlanConfig(selectedPlan);
    const paymentRequired = initialPaymentRequiredForSignup(planConfig.planId, appsumoActivationSignup);
    if (REQUIRE_INITIAL_STRIPE_PAYMENT && !appsumoActivationSignup && planConfig.planId === FREE_PLAN_ID) {
        return sendApiError(
            res,
            createHttpError(402, 'Please choose a paid plan to create an account. You can request a refund within 7 days if the service is not right for you.', 'PAID_PLAN_REQUIRED')
        );
    }
    const trimmedName = String(name || '').trim();
    const rawEmail = String(email || '').trim();
    const normalizedEmail = normalizeEmail(email);
      // Name is optional at sign-up (minimal flow); we derive a provisional
      // display name from the email and let the user edit it later.
      if (!rawEmail) {
          return sendApiError(
              res,
              createHttpError(400, 'Please enter your email address.', 'EMAIL_REQUIRED', { field: 'email' })
          );
    }
    if (!emailLooksValid(rawEmail)) {
        return sendApiError(
            res,
            createHttpError(400, 'Please enter a valid email address.', 'EMAIL_INVALID', { field: 'email' })
        );
    }
    if (SMS_GATEWAY_DOMAINS.has(normalizedEmail.split('@')[1] || '')) {
        return sendApiError(
            res,
            createHttpError(400, 'Please sign up with a regular email address.', 'EMAIL_INVALID', { field: 'email' })
        );
    }
    if (typeof password !== 'string' || !password) {
        return sendApiError(
            res,
            createHttpError(400, 'Please create a password before continuing.', 'PASSWORD_REQUIRED', { field: 'password' })
        );
    }
    if (!passwordMeetsPolicy(password)) {
        return sendApiError(
            res,
            createHttpError(
                400,
                'Password must be at least 8 characters and include uppercase, lowercase, and a number.',
                'PASSWORD_POLICY_FAILED',
                { field: 'password' }
            )
        );
    }

    // New self-serve accounts cannot become active until Stripe confirms their
    // first payment. AppSumo activation is the only signed, non-Stripe bypass.
    if (!stripe && paymentRequired) {
        return sendApiError(
            res,
            createHttpError(
                503,
                'Checkout is temporarily unavailable. Please try again shortly.',
                'CHECKOUT_UNAVAILABLE',
                { retryable: true }
            )
        );
    }
  try {
      const existingUser = await User.findOne({ email: normalizedEmail }).select('_id');
        if (existingUser) {
            return sendApiError(
                res,
                createHttpError(
                    409,
                    'This email is already registered. Use a different email address or sign in with the existing account.',
                    'EMAIL_ALREADY_REGISTERED',
                    { field: 'email' }
                )
            );
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        const displayName = trimmedName.length >= 2
            ? trimmedName
            : deriveNameFromEmail(normalizedEmail);
        const user = new User({ name: displayName, email: normalizedEmail, password: hashedPassword });
        if (utm) user.signupUtm = { ...utm, capturedAt: new Date() };
        attachSignupAttribution(user, requestFields);

        user.subscription = ensureSubscriptionShape(user);
        user.subscription.status = 'pending';
        user.subscription.planId = planConfig.planId;
        user.subscription.planName = planConfig.planName;
        user.subscription.price = planConfig.price;
        user.subscription.currency = planConfig.currency;
        user.subscription.billingInterval = planConfig.billingInterval;
        user.subscription.stripePriceId = planConfig.stripePriceId || null;
        user.subscription.trialStartedAt = new Date();
        user.subscription.trialEndsAt = paymentRequired ? null : (planConfig.trialDays > 0 ? defaultTrialEndsAt() : null);
        user.subscription.activatedAt = null;
        user.subscription.renewedAt = null;
        user.subscription.lastPaymentAt = null;
        user.paymentRequiredAt = paymentRequired ? new Date() : null;
        user.initialRefundStatus = 'not_eligible';
        // Free accounts remain available only when the paid-first policy is
        // explicitly disabled. AppSumo account creation is handled by the
        // signed activation token and is granted after /api/appsumo/activate.
        if (planConfig.planId === FREE_PLAN_ID && !REQUIRE_INITIAL_STRIPE_PAYMENT) {
            user.subscription.status = 'active';
            user.subscription.activatedAt = new Date();
            user.subscription.trialEndsAt = null;
        }
        user.markModified('subscription');
        await user.save();

        recordCustomerLifecycleEvent(user, 'signup', { source: 'direct' })
            .catch((e) => console.error('[customers] signup registry error:', e && e.message));
        // New signup: send onboarding email + owner notification (fire-and-forget).
        sendNewUserEmails({ name: displayName, email: normalizedEmail, plan: planConfig.planName })
            .catch((e) => console.error('[mailer] new-user email error:', e && e.message));
        trackFunnel('signup', user._id, planConfig.planName, {
            authMethod: 'email',
            selectedPlan: planConfig.planId,
            consent: req.body && req.body.analyticsConsent === true,
            utm,
            ...acquisitionFunnelFields(acquisition),
            ...requestFields
        });
        trackFunnel('signup_completed', user._id, planConfig.planName, {
            eventName: 'signup_completed',
            dedupeKey: `signup-complete:${String(user._id)}`,
            authMethod: 'email', selectedPlan: planConfig.planId, utm,
            ...acquisitionFunnelFields(acquisition), ...requestFields
        });

        if (planConfig.planId === FREE_PLAN_ID) {
            return res.status(200).json({
                token: createUserToken(user),
                subscription: normalizeSubscription(user.subscription),
                plan: FREE_PLAN_ID
            });
        }

        if (appsumoActivationSignup) {
            return res.status(200).json({
                token: createUserToken(user),
                subscription: normalizeSubscription(user.subscription),
                plan: planConfig.planId,
                appsumoActivation: true
            });
        }

        // Legacy rollback mode retains the old no-card trial behavior. The
        // production default always follows the paid checkout path below.
        if (!REQUIRE_INITIAL_STRIPE_PAYMENT && !NO_TRIAL_PLAN_IDS.includes(planConfig.planId)) {
            startNoCardTrial(user);
            await user.save();
            trackFunnel('trial_start', user._id, 'Pro', {
                authMethod: 'email',
                selectedPlan: planConfig.planId,
                utm,
                ...acquisitionFunnelFields(acquisition),
                ...requestFields
            });
            notifyTrialStartedInternal(user, {
                authMethod: 'email',
                selectedPlan: planConfig.planId,
                utm,
                ...acquisitionFunnelFields(acquisition),
                ...requestFields
            }).catch((e) => console.error('[mailer] trial-start internal email error:', e && e.message));
            return res.status(200).json({
                token: createUserToken(user),
                subscription: normalizeSubscription(user.subscription),
                trial: true,
                plan: 'pro'
            });
        }

        const session = await createCheckoutSessionForUser(user, {
            req,
            planId: planConfig.planId,
            skipTrial: paymentRequired || NO_TRIAL_PLAN_IDS.includes(planConfig.planId),
            initialSignup: paymentRequired,
            affiliateMetadata: await affiliateProgram.buildCheckoutMetadata({ req, user }),
            returnContext: {
                flow: 'register',
                next: req.body?.next
            },
            metadata: {
                authFlow: 'register',
                checkoutType: 'email',
                next: sanitizeRelativeAppPath(req.body?.next, 'news.html'),
                billingInterval: planConfig.billingInterval,
                ...acquisitionStripeMetadata(acquisition)
            }
        });
        if (!session?.url) {
            throw createHttpError(
                502,
                'Checkout session could not be created. Please try again.',
                'CHECKOUT_URL_MISSING',
                { retryable: true }
            );
        }
        res.status(200).json({ url: session.url });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) {
            return sendApiError(
                res,
                createHttpError(
                    503,
                    'Database unavailable. Please try again shortly.',
                    'DATABASE_UNAVAILABLE',
                    { retryable: true }
                )
            );
        }
        if (error?.code === 11000) {
            return sendApiError(
                res,
                createHttpError(
                    409,
                    'This email is already registered. Use a different email address or sign in with the existing account.',
                    'EMAIL_ALREADY_REGISTERED',
                    { field: 'email' }
                )
            );
        }
        if (error?.status) {
            console.error('Subscription checkout error:', error);
            return sendApiError(res, error, 'Unable to start the subscription');
        }
        console.error('Subscription checkout error:', error);
        return sendApiError(
            res,
            createHttpError(
                500,
                'Unable to start the subscription right now. Please try again.',
                'SUBSCRIPTION_START_FAILED',
                { retryable: true }
            )
        );
    }
  });

// Build + send the support-inbox notification for a ticket. Independent of the
// DB so a ticket is never lost during an outage. Never throws; resolves to a
// boolean (true = email accepted for delivery).
function notifySupportInbox(t) {
    try {
        const { sendMail, escapeHtml } = require('./mailer');
        const to = process.env.SUPPORT_INBOX_EMAIL || 'support@stockportfolio.pro';
        const when = new Date().toISOString();
        const text = `New support ticket\n\nName: ${t.name}\nEmail: ${t.email}\nSubject: ${t.subject}\nWhen: ${when}\n\nMessage:\n${t.message}`;
        const html = `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;color:#0f172a">`
            + `<h2 style="margin:0 0 10px">New support ticket</h2>`
            + `<table style="font-size:14px;border-collapse:collapse">`
            + `<tr><td style="padding:4px 12px 4px 0;color:#64748b">Name</td><td>${escapeHtml(t.name)}</td></tr>`
            + `<tr><td style="padding:4px 12px 4px 0;color:#64748b">Email</td><td><a href="mailto:${escapeHtml(t.email)}">${escapeHtml(t.email)}</a></td></tr>`
            + `<tr><td style="padding:4px 12px 4px 0;color:#64748b">Subject</td><td>${escapeHtml(t.subject)}</td></tr>`
            + `<tr><td style="padding:4px 12px 4px 0;color:#64748b">When</td><td>${when}</td></tr></table>`
            + `<div style="margin-top:14px;white-space:pre-wrap;font-size:14px;line-height:1.6;border-left:3px solid #e2e8f0;padding-left:12px">${escapeHtml(t.message)}</div></div>`;
        return sendMail({ to, replyTo: t.email, subject: `[Support] ${t.subject}`, html, text });
    } catch (e) {
        console.error('[support] mailer wiring error:', e && e.message);
        return Promise.resolve(false);
    }
}

app.post('/api/support', async (req, res) => {
    const { name, email, subject, message } = req.body || {};
    if (!name || !email || !subject || !message) {
        return res.status(400).json({ message: 'All fields are required' });
    }
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
        return res.status(400).json({ message: 'Please provide a valid email address' });
    }
    const t = {
        name: String(name).trim(),
        email: String(email).toLowerCase(),
        subject: String(subject).trim(),
        message: String(message).trim()
    };

    // Persist to the DB, but the support inbox is the source of truth we never
    // want to lose — so the ticket is mirrored to email whether or not the save
    // succeeds. A DB outage must never drop a customer's message.
    let saved = false;
    try {
        await new SupportTicket(t).save();
        saved = true;
    } catch (error) {
        if (isDatabaseUnavailableError(error)) {
            console.warn('[support] DB unavailable — falling back to email only:', error && error.message);
        } else {
            console.error('[support] ticket save error:', error && error.message);
        }
    }

    if (saved) {
        // DB captured it: answer immediately, mirror to email in the background.
        res.status(201).json({ message: 'Support ticket submitted. We will reach out shortly.' });
        notifySupportInbox(t)
            .then((ok) => { if (!ok) console.warn('[support] email mirror not sent'); })
            .catch((e) => console.error('[support] email mirror error:', e && e.message));
        return;
    }

    // DB did NOT capture it — email is the only record, so await it and only
    // report failure if that also fails.
    let emailed = false;
    try { emailed = await notifySupportInbox(t); } catch (e) { console.error('[support] fallback email error:', e && e.message); }
    if (emailed) {
        return res.status(201).json({ message: 'Support ticket submitted. We will reach out shortly.' });
    }
    return res.status(503).json({ message: 'Unable to submit your ticket right now. Please email support@stockportfolio.pro directly.' });
});

app.post('/api/check-email', async (req, res) => {
    try {
        const rawEmail = String(req.body?.email || '').trim();
        const normalizedEmail = normalizeEmail(rawEmail);
        if (!rawEmail) {
            return sendApiError(
                res,
                createHttpError(400, 'Email is required.', 'EMAIL_REQUIRED', { field: 'email' })
            );
        }
        if (!emailLooksValid(rawEmail)) {
            return sendApiError(
                res,
                createHttpError(400, 'Please enter a valid email address.', 'EMAIL_INVALID', { field: 'email' })
            );
        }
        const user = await User.findOne({ email: normalizedEmail }).select('_id');
        const exists = Boolean(user);
        res.json({
            active: exists,
            exists,
            code: exists ? 'EMAIL_ALREADY_REGISTERED' : null,
            message: exists
                ? 'This email is already registered. Use a different email address or sign in with the existing account.'
                : ''
        });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) {
            return sendApiError(
                res,
                createHttpError(
                    503,
                    'Database unavailable. Please try again shortly.',
                    'DATABASE_UNAVAILABLE',
                    { retryable: true }
                )
            );
        }
        console.error('Check email error:', error);
        return sendApiError(
            res,
            createHttpError(
                500,
                'Unable to check email right now.',
                'EMAIL_CHECK_FAILED',
                { retryable: true }
            )
        );
    }
});

app.get('/stripe/config', (req, res) => {
    res.json({
        publishableKey: STRIPE_PUBLISHABLE_KEY,
        successUrl: buildStripeReturnUrl(req, { session: 'success', flow: 'register' }),
        cancelUrl: buildStripeReturnUrl(req, { session: 'cancel', flow: 'register' })
    });
});

// Retargeting-pixel IDs for the app-page loader (assets/app.js). All four read
// from the environment; absent → empty strings → the loader no-ops silently.
// SSR marketing pages inject the same config directly (see backend/pixels.js).
app.get('/api/analytics/config', (req, res) => {
    res.json(pixelConfig());
});

app.get('/api/auth/providers', (req, res) => {
    const googleHostAllowed = isGoogleHostAllowed(req);
    res.json({
        google: {
            enabled: Boolean(GOOGLE_CLIENT_ID && googleHostAllowed),
            clientId: googleHostAllowed ? GOOGLE_CLIENT_ID : '',
            reason: googleHostAllowed ? '' : 'Google sign-in is only enabled on configured production hosts.'
        },
        facebook: {
            enabled: Boolean(FACEBOOK_APP_ID && FACEBOOK_APP_SECRET),
            appId: FACEBOOK_APP_ID || ''
        }
    });
});

app.post('/api/auth/social', async (req, res) => {
    try {
        const provider = String(req.body?.provider || '').trim().toLowerCase();
        if (provider === 'google' && !isGoogleHostAllowed(req)) {
            throw createHttpError(400, 'Google sign-in is not enabled on this host.');
        }
        const flow = String(req.body?.flow || 'login').trim().toLowerCase();
        const selectedPlan = normalizePlanSelection(req.body?.plan);
        const planConfig = getPlanConfig(selectedPlan);
        const paymentRequired = initialPaymentRequiredForSignup(planConfig.planId, false);
        if (REQUIRE_INITIAL_STRIPE_PAYMENT && planConfig.planId === FREE_PLAN_ID) {
            return res.status(402).json({
                message: 'Please choose a paid plan to create an account. You can request a refund within 7 days if the service is not right for you.',
                code: 'PAID_PLAN_REQUIRED'
            });
        }
        const acquisition = shareCopy.parseAcquisitionCookieHeader(req.headers.cookie, { secret: JWT_SECRET });
        const requestFields = trackingRequestFields(req, res);
        const utm = requestUtm(req);
        const profile = await verifySocialIdentity(provider, req.body || {});
        const { user, created } = await findOrCreateSocialUser(profile);
        let normalized = ensureSubscriptionShape(user);

        if (created) {
            if (paymentRequired) {
                user.paymentRequiredAt = new Date();
                user.initialRefundStatus = 'not_eligible';
                user.subscription.planId = planConfig.planId;
                user.subscription.planName = planConfig.planName;
                user.subscription.price = planConfig.price;
                user.subscription.currency = planConfig.currency;
                user.subscription.billingInterval = planConfig.billingInterval;
                user.subscription.stripePriceId = planConfig.stripePriceId || null;
                user.subscription.status = 'pending';
                user.subscription.trialEndsAt = null;
            }
            attachSignupAttribution(user, requestFields);
            if (utm) {
                user.signupUtm = { ...utm, capturedAt: new Date() };
            }
            await user.save();
            trackFunnel('signup', user._id, planConfig.planName, {
                authMethod: provider,
                selectedPlan: planConfig.planId,
                consent: req.body && req.body.analyticsConsent === true,
                utm,
                ...acquisitionFunnelFields(acquisition),
                ...requestFields
            });
            trackFunnel('signup_completed', user._id, planConfig.planName, {
                eventName: 'signup_completed',
                dedupeKey: `signup-complete:${String(user._id)}`,
                authMethod: provider, selectedPlan: planConfig.planId, utm,
                ...acquisitionFunnelFields(acquisition), ...requestFields
            });
        }

        if (subscriptionIsActive(user.subscription)) {
            return res.status(200).json({
                token: createUserToken(user),
                subscription: normalized,
                created,
                provider
            });
        }

        // Free plan via social sign-in remains available only in rollback mode.
        if (planConfig.planId === FREE_PLAN_ID && !REQUIRE_INITIAL_STRIPE_PAYMENT) {
            applyPlanToSubscription(user, FREE_PLAN_ID);
            user.subscription.status = 'active';
            user.subscription.activatedAt = new Date();
            user.subscription.trialEndsAt = null;
            user.markModified('subscription');
            await user.save();
            return res.status(200).json({
                token: createUserToken(user),
                subscription: normalizeSubscription(user.subscription),
                created,
                provider
            });
        }

        // Legacy rollback mode retains the former no-card trial for new social
        // accounts. The production default takes the paid checkout path below.
        if (!REQUIRE_INITIAL_STRIPE_PAYMENT && created && !NO_TRIAL_PLAN_IDS.includes(planConfig.planId)) {
            startNoCardTrial(user);
            await user.save();
            trackFunnel('trial_start', user._id, 'Pro', {
                authMethod: provider,
                selectedPlan: planConfig.planId,
                utm,
                ...acquisitionFunnelFields(acquisition),
                ...requestFields
            });
            notifyTrialStartedInternal(user, {
                authMethod: provider,
                selectedPlan: planConfig.planId,
                utm,
                ...acquisitionFunnelFields(acquisition),
                ...requestFields
            }).catch((e) => console.error('[mailer] trial-start internal email error:', e && e.message));
            return res.status(200).json({
                token: createUserToken(user),
                subscription: normalizeSubscription(user.subscription),
                created,
                provider,
                trial: true
            });
        }

        if (!stripe) {
            return res.status(402).json({
                message: 'An active subscription is required to use the app.',
                code: 'SUBSCRIPTION_REQUIRED',
                subscription: normalized,
                created
            });
        }

        const resumeInitialPayment = Boolean(user.paymentRequiredAt && !subscriptionIsActive(user.subscription));
        const checkoutPlanId = resumeInitialPayment && user.subscription && user.subscription.planId
            ? user.subscription.planId
            : planConfig.planId;
        const checkoutPlanConfig = getPlanConfig(checkoutPlanId);
        const session = await createCheckoutSessionForUser(user, {
            req,
            planId: checkoutPlanId,
            skipTrial: (created && paymentRequired) || resumeInitialPayment || NO_TRIAL_PLAN_IDS.includes(checkoutPlanId),
            initialSignup: (created && paymentRequired) || resumeInitialPayment,
            affiliateMetadata: await affiliateProgram.buildCheckoutMetadata({ req, user }),
            returnContext: {
                flow,
                provider,
                next: req.body?.next
            },
            metadata: {
                authProvider: provider,
                authFlow: flow,
                checkoutType: 'social',
                next: sanitizeRelativeAppPath(req.body?.next, 'news.html'),
                billingInterval: checkoutPlanConfig.billingInterval,
                ...acquisitionStripeMetadata(acquisition)
            }
        });
        res.status(200).json({
            token: createUserToken(user),
            url: session.url,
            subscription: normalized,
            created,
            provider,
            checkoutRequired: true
        });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) {
            return res.status(503).json({ message: 'Database unavailable. Start MongoDB and configure MONGODB_URI.' });
        }
        if (error?.code === 11000) {
            return sendApiError(
                res,
                createHttpError(
                    409,
                    'This email is already registered. Use a different email address or sign in with the existing account.',
                    'EMAIL_ALREADY_REGISTERED',
                    { field: 'email' }
                )
            );
        }
        console.error('Social auth error:', error);
        return sendApiError(res, error, 'Unable to continue with social login');
    }
});

// Login API Route
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    const normalizedEmail = normalizeEmail(email);

    try {
        if (!normalizedEmail || typeof password !== 'string') {
            return res.status(400).json({ message: 'Email and password are required' });
        }

        const user = await User.findOne({ email: normalizedEmail });
        if (!user) {
            return res.status(400).json({ message: 'Invalid email or password' });
        }

        const isPasswordValid = await verifyPassword(password, user.password);
        if (!isPasswordValid) {
            return res.status(400).json({ message: 'Invalid email or password' });
        }

        // Upgrade legacy/plain hashes to bcrypt after a successful login.
        if (!(typeof user.password === 'string' && (user.password.startsWith('$2a$') || user.password.startsWith('$2b$') || user.password.startsWith('$2y$')))) {
            user.password = await bcrypt.hash(password, 10);
        }

        let normalized = ensureSubscriptionShape(user);

        // If subscription is not yet marked active, attempt to reconcile with Stripe
        if (!subscriptionIsActive(user.subscription) && stripe) {
            try {
                // Try to resolve customer ID from existing record or by email lookup
                let customerId = user.stripeCustomerId || null;
                if (!customerId) {
                    const customers = await stripe.customers.list({ email: user.email, limit: 1 });
                    const match = customers?.data?.[0];
                    if (match) {
                        customerId = match.id;
                    }
                }

                if (customerId) {
                    // Try to resolve subscription from existing ID or by customer search
                    let subscription = null;
                    if (user.stripeSubscriptionId) {
                        try {
                            subscription = await stripe.subscriptions.retrieve(user.stripeSubscriptionId);
                        } catch (_) {
                            subscription = null;
                        }
                    }
                    if (!subscription) {
                        const subs = await stripe.subscriptions.list({
                            customer: customerId,
                            status: 'all',
                            limit: 3
                        });
                        subscription = subs.data.find((s) => s.status === 'active' || s.status === 'trialing') || null;
                    }

                    if (subscription && (subscription.status === 'active' || subscription.status === 'trialing')) {
                        await syncSubscriptionFromStripe(user, subscription, customerId);
                        normalized = ensureSubscriptionShape(user);
                    }
                }
            } catch (reconcileError) {
                console.error('Stripe reconciliation on login failed:', reconcileError);
            }
        }

        // Expired/pending subscriptions still log in — they land on the free
        // tier and coreGate'd routes prompt the upgrade.
        if (user.isModified('subscription')) {
            await user.save().catch(() => {});
        }

        // A new paid-first account may return here after cancelling checkout
        // or before the webhook has activated it. Keep the account pending and
        // resume the same Stripe checkout instead of granting free access.
        if (REQUIRE_INITIAL_STRIPE_PAYMENT
            && user.paymentRequiredAt
            && !subscriptionIsActive(user.subscription)
            && !user.appsumoRedeemedAt) {
            if (!stripe) {
                return res.status(503).json({ message: 'Checkout is temporarily unavailable. Please try again shortly.', code: 'CHECKOUT_UNAVAILABLE' });
            }
            const session = await createCheckoutSessionForUser(user, {
                req,
                planId: user.subscription && user.subscription.planId,
                skipTrial: true,
                initialSignup: true,
                affiliateMetadata: await affiliateProgram.buildCheckoutMetadata({ req, user }),
                returnContext: { flow: 'login', next: req.body?.next },
                metadata: {
                    authFlow: 'login',
                    checkoutType: 'initial_signup_resume',
                    next: sanitizeRelativeAppPath(req.body?.next, 'dashboard.html'),
                    ...acquisitionStripeMetadata(shareCopy.parseAcquisitionCookieHeader(req.headers.cookie, { secret: JWT_SECRET }))
                }
            });
            if (!session?.url) return res.status(502).json({ message: 'Checkout session could not be created. Please try again.', code: 'CHECKOUT_URL_MISSING' });
            const token = createUserToken(user);
            return res.status(200).json({ token, url: session.url, subscription: normalized, checkoutRequired: true });
        }

        // Create JWT
        const token = createUserToken(user);
        res.status(200).json({ token, subscription: normalized });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) {
            return res.status(503).json({ message: 'Database unavailable. Start MongoDB and configure MONGODB_URI.' });
        }
        res.status(500).json({ message: 'Unable to log in right now.' });
    }
});

// Change password for existing users using current credentials
app.post('/api/password/change', async (req, res) => {
    try {
        const { email, currentPassword, newPassword } = req.body || {};
        const normalizedEmail = normalizeEmail(email);
        if (!normalizedEmail || !currentPassword || !newPassword) {
            return res.status(400).json({ message: 'Email, current password, and new password are required.' });
        }
        if (!passwordMeetsPolicy(newPassword)) {
            return res.status(400).json({
                message: 'New password must be at least 8 characters and include uppercase, lowercase, and a number.'
            });
        }

        const user = await User.findOne({ email: normalizedEmail });
        if (!user) {
            return res.status(400).json({ message: 'Invalid email or password.' });
        }

        const isCurrentValid = await verifyPassword(currentPassword, user.password);
        if (!isCurrentValid) {
            return res.status(400).json({ message: 'Invalid email or password.' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        user.password = hashedPassword;
        user.authVersion = Number(user.authVersion || 0) + 1;
        await user.save();

        res.status(200).json({ message: 'Password updated successfully. You can now log in with your new password.' });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) {
            return res.status(503).json({ message: 'Database unavailable. Start MongoDB and configure MONGODB_URI.' });
        }
        console.error('Change password error:', error);
        res.status(500).json({ message: 'Unable to change password right now.' });
    }
});

// Forgot password — email a one-time reset link. ALWAYS responds 200 with the
// same generic message whether or not the email exists, so the endpoint can't
// be used to enumerate accounts. Only a SHA-256 hash of the token is stored;
// the raw token lives solely in the emailed link and expires in 1 hour.
app.post('/api/password/forgot', async (req, res) => {
    const genericOk = {
        message: "If an account exists for that email, a password reset link is on its way. Check your inbox (and spam)."
    };
    try {
        const normalizedEmail = normalizeEmail(req.body?.email);
        if (!normalizedEmail) {
            return res.status(400).json({ message: 'Email is required.' });
        }

        const user = await User.findOne({ email: normalizedEmail });
        if (user) {
            const rawToken = crypto.randomBytes(32).toString('hex');
            user.resetPasswordToken = crypto.createHash('sha256').update(rawToken).digest('hex');
            user.resetPasswordExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour
            await user.save();

            const appUrl = String(mailer.config().appUrl || 'https://stockportfolio.pro').replace(/\/$/, '');
            const resetUrl = `${appUrl}/reset-password.html?token=${rawToken}`;
            // Fire-and-forget: a mail hiccup must not change the response (which
            // would leak whether the address exists).
            mailer.sendPasswordResetEmail({ to: user.email, name: user.name, resetUrl })
                .catch((e) => console.error('[mailer] password-reset email error:', e && e.message));
        }

        return res.status(200).json(genericOk);
    } catch (error) {
        if (isDatabaseUnavailableError(error)) {
            return res.status(503).json({ message: 'Database unavailable. Start MongoDB and configure MONGODB_URI.' });
        }
        console.error('Forgot password error:', error);
        return res.status(500).json({ message: 'Unable to process the request right now. Please try again shortly.' });
    }
});

// Reset password — complete the flow with the emailed token. Validates the
// token hash + expiry, applies the new password, and clears the token so the
// link can't be reused. On success the user is signed in immediately.
app.post('/api/password/reset', async (req, res) => {
    try {
        const { token, newPassword } = req.body || {};
        if (typeof token !== 'string' || !token.trim()) {
            return res.status(400).json({ message: 'Your reset link is missing its token. Open the link from your email again.' });
        }
        if (!passwordMeetsPolicy(newPassword)) {
            return res.status(400).json({
                message: 'New password must be at least 8 characters and include uppercase, lowercase, and a number.'
            });
        }

        const tokenHash = crypto.createHash('sha256').update(token.trim()).digest('hex');
        const user = await User.findOne({
            resetPasswordToken: tokenHash,
            resetPasswordExpires: { $gt: new Date() }
        });
        if (!user) {
            return res.status(400).json({ message: 'This reset link is invalid or has expired. Request a new one from the login page.' });
        }

        user.password = await bcrypt.hash(newPassword, 10);
        user.authVersion = Number(user.authVersion || 0) + 1;
        user.resetPasswordToken = null;
        user.resetPasswordExpires = null;
        await user.save();

        // Sign them straight in — no need to retype credentials on a fresh password.
        return res.status(200).json({
            message: 'Your password has been reset. You are now signed in.',
            token: createUserToken(user),
            subscription: normalizeSubscription(user.subscription)
        });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) {
            return res.status(503).json({ message: 'Database unavailable. Start MongoDB and configure MONGODB_URI.' });
        }
        console.error('Reset password error:', error);
        return res.status(500).json({ message: 'Unable to reset password right now. Please try again shortly.' });
    }
});

// Refund the first Stripe payment for a paid-first signup. This is an explicit
// customer action, limited to the recorded seven-day window and never
// available for AppSumo/DealMirror lifetime entitlements.
app.post('/api/billing/refund', authMiddleware, async (req, res) => {
    if (!stripe) return res.status(503).json({ message: 'Refunds are temporarily unavailable. Please contact support@stockportfolio.pro.', code: 'STRIPE_UNAVAILABLE' });
    const user = req.user;
    const now = Date.now();
    if (user.appsumoRedeemedAt || user.dealMirrorRedeemedAt) {
        return res.status(400).json({ message: 'Lifetime-deal access is not refunded through Stripe.', code: 'LIFETIME_ENTITLEMENT' });
    }
    if (!user.paymentRequiredAt || !user.initialPaymentAt || !user.initialRefundUntil) {
        return res.status(400).json({ message: 'This account has no eligible initial payment refund.', code: 'REFUND_NOT_ELIGIBLE' });
    }
    if (new Date(user.initialRefundUntil).getTime() < now) {
        return res.status(400).json({ message: `The ${INITIAL_REFUND_DAYS}-day refund window has ended. Please contact support@stockportfolio.pro if you need help.`, code: 'REFUND_WINDOW_CLOSED' });
    }
    if (user.initialRefundStatus === 'refunded') {
        return res.status(200).json({ ok: true, status: 'refunded', message: 'Your initial payment has already been refunded.' });
    }
    const claimed = await User.findOneAndUpdate(
        { _id: user._id, initialRefundStatus: 'eligible', initialRefundUntil: { $gte: new Date() } },
        { $set: { initialRefundStatus: 'requested', initialRefundRequestedAt: new Date() } },
        { new: true }
    );
    if (!claimed) {
        const latest = await User.findById(user._id).select('initialRefundStatus').lean();
        if (latest && latest.initialRefundStatus === 'refunded') return res.status(200).json({ ok: true, status: 'refunded' });
        return res.status(409).json({ message: 'A refund request is already being processed.', code: 'REFUND_IN_PROGRESS' });
    }
    try {
        let paymentIntentId = claimed.initialPaymentIntentId || null;
        let chargeId = claimed.initialChargeId || null;
        if ((!paymentIntentId || !chargeId) && claimed.initialInvoiceId) {
            const invoice = await stripe.invoices.retrieve(claimed.initialInvoiceId);
            paymentIntentId = paymentIntentId || (typeof invoice.payment_intent === 'string' ? invoice.payment_intent : invoice.payment_intent && invoice.payment_intent.id);
            chargeId = chargeId || (typeof invoice.charge === 'string' ? invoice.charge : invoice.charge && invoice.charge.id);
        }
        if (!paymentIntentId && !chargeId) throw new Error('The initial Stripe payment reference is not available yet.');
        const refund = await stripe.refunds.create({
            ...(paymentIntentId ? { payment_intent: paymentIntentId } : { charge: chargeId }),
            reason: 'requested_by_customer',
            metadata: { userId: String(claimed._id), type: 'initial_seven_day_refund' }
        });
        if (claimed.stripeSubscriptionId) {
            await stripe.subscriptions.cancel(claimed.stripeSubscriptionId).catch((cancelError) => {
                console.error('Stripe subscription cancellation after refund failed:', cancelError && cancelError.message);
            });
        }
        claimed.initialPaymentIntentId = paymentIntentId || claimed.initialPaymentIntentId || null;
        claimed.initialChargeId = chargeId || claimed.initialChargeId || null;
        claimed.initialRefundStatus = 'refunded';
        claimed.initialRefundedAt = new Date();
        claimed.subscription.status = 'cancelled';
        claimed.subscription.trialEndsAt = null;
        claimed.markModified('subscription');
        await claimed.save();
        return res.status(200).json({ ok: true, status: 'refunded', message: 'Your initial payment was refunded and the subscription was cancelled.' });
    } catch (error) {
        await User.updateOne({ _id: claimed._id, initialRefundStatus: 'requested' }, { $set: { initialRefundStatus: 'eligible' } }).catch(() => {});
        console.error('Initial Stripe refund failed:', error && error.message);
        return res.status(502).json({ message: 'We could not complete the refund automatically. Please contact support@stockportfolio.pro before the seven-day window ends.', code: 'REFUND_FAILED' });
    }
});

app.post('/api/subscription/cancel', authMiddleware, async (req, res) => {
    if (!stripe) {
        return res.status(500).json({ message: 'Stripe is not configured' });
    }
    const user = req.user;
    if (!user.stripeSubscriptionId) {
        return res.status(400).json({ message: 'No active subscription to cancel' });
    }
    try {
        await stripe.subscriptions.update(user.stripeSubscriptionId, { cancel_at_period_end: true });
        user.subscription.status = 'cancel_at_period_end';
        await user.save();
        res.json({ message: 'Subscription will be canceled at the end of the period' });
    } catch (error) {
        console.error('Cancel subscription error:', error);
        res.status(500).json({ message: 'Unable to cancel the subscription right now.' });
    }
});

// Session route for client-side gating
app.get('/api/session', authMiddleware, async (req, res) => {
    try {
        const user = req.user;
        const subscription = req.subscription || ensureSubscriptionShape(user);
        const profile = {
            id: user._id,
            name: user.name,
            email: user.email
        };
        res.json({
            ok: true,
            profile,
            subscription,
            initialRefund: {
                status: user.initialRefundStatus || 'not_eligible',
                eligibleUntil: user.initialRefundUntil || null,
                eligible: user.initialRefundStatus === 'eligible'
                    && user.initialRefundUntil
                    && new Date(user.initialRefundUntil).getTime() >= Date.now()
            },
            tier: req.tier
        });
    } catch (error) {
        console.error('/api/session error:', error);
        res.status(500).json({ message: 'Unable to load session' });
    }
});

app.post('/api/logout', (req, res) => {
    clearAuthCookie(res, req);
    res.status(204).end();
});

// Existing-user upgrade: turn a logged-in trial/free account into a paid
// subscription. The 7-day trial was the no-card demo, so this charges today
// (skipTrial) — we never stack a second Stripe trial on top of it.
app.post('/api/checkout', authMiddleware, async (req, res) => {
    try {
        if (!stripe) {
            return res.status(503).json({ message: 'Checkout is temporarily unavailable. Please try again shortly.', code: 'CHECKOUT_UNAVAILABLE' });
        }
        const planId = normalizePlanSelection(req.body?.plan || 'pro');
        const acquisition = shareCopy.parseAcquisitionCookieHeader(req.headers.cookie, { secret: JWT_SECRET });
        const session = await createCheckoutSessionForUser(req.user, {
            req,
            planId,
            skipTrial: true,
            affiliateMetadata: await affiliateProgram.buildCheckoutMetadata({ req, user: req.user }),
            returnContext: { flow: 'upgrade', next: req.body?.next },
            metadata: {
                authFlow: 'upgrade',
                checkoutType: 'upgrade',
                next: sanitizeRelativeAppPath(req.body?.next, 'dashboard.html'),
                ...acquisitionStripeMetadata(acquisition)
            }
        });
        if (!session?.url) {
            return res.status(502).json({ message: 'Checkout session could not be created. Please try again.', code: 'CHECKOUT_URL_MISSING' });
        }
        res.json({ url: session.url });
    } catch (error) {
        console.error('/api/checkout error:', error);
        res.status(500).json({ message: 'Unable to start checkout right now.' });
    }
});

app.get('/api/companies/top100', authMiddleware, (req, res) => {
    res.json({ companies: topCompanies });
});

app.get('/api/companies/search', authMiddleware, (req, res) => {
    const q = (req.query.q || req.query.query || '').toString().trim();
    const limit = Number(req.query.limit) || 10;
    if (!q) {
        return res.json([]);
    }
    const matches = searchTopCompanies(q, limit);
    res.json(matches.map((item) => ({
        symbol: item.symbol,
        name: item.name,
        marketCap: item.marketCap,
        peRatio: item.peRatio,
        eps: item.eps,
        sector: item.sector
    })));
});

// API to search for company symbols using Alpha Vantage's SYMBOL_SEARCH function
app.get('/api/search/:query', authMiddleware, async (req, res) => {
    const query = req.params.query;
    const localMatches = searchTopCompanies(query, 10).map((item) => ({
        symbol: item.symbol,
        name: item.name,
        marketCap: item.marketCap,
        peRatio: item.peRatio,
        eps: item.eps,
        sector: item.sector
    }));
    try {
        const matches = (await alphaClient.searchSymbols(query)).filter((row) => !/\.[A-Z]{2,4}$/.test(row.symbol));
        const seen = new Set();
        res.json(localMatches.map((row) => ({ ...row, assetType: 'stock', quoteType: 'EQUITY' }))
            .concat(matches)
            .filter((row) => row.symbol && !seen.has(row.symbol) && seen.add(row.symbol))
            .slice(0, 12));
    } catch (error) {
        res.json(localMatches.map((row) => ({ ...row, assetType: 'stock', quoteType: 'EQUITY' })));
    }
});

// Public asset directory for the navigation and add-holding autocomplete.
// Results are additive: the established stock directory stays first, while
// Yahoo supplies ETFs and mutual funds that are not SEC operating companies.
app.get('/api/assets/search', async (req, res) => {
    const query = String(req.query.q || req.query.query || '').trim();
    const limit = Math.min(Math.max(Number(req.query.limit) || 10, 1), 20);
    if (!query) return res.json([]);
    const local = searchTopCompanies(query, limit).map((row) => ({
        symbol: row.symbol, name: row.name, sector: row.sector || '',
        assetType: 'stock', assetTypeLabel: 'Stock', quoteType: 'EQUITY'
    }));
    try {
        const remote = (await alphaClient.searchSymbols(query)).filter((row) => !/\.[A-Z]{2,4}$/.test(row.symbol));
        const seen = new Set();
        const out = local.concat(remote.map((row) => ({
            ...row, assetTypeLabel: assetProfile.assetTypeLabel(row.assetType)
        }))).filter((row) => row.symbol && !seen.has(row.symbol) && seen.add(row.symbol));
        return res.json(out.slice(0, limit));
    } catch (_) {
        return res.json(local.slice(0, limit));
    }
});

// A normalized, non-company-specific research payload. Fund consumers use
// this route; legacy stock pages retain the existing SEC fundamentals route.
app.get('/api/assets/:symbol/profile', async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!symbol) return res.status(400).json({ message: 'symbol is required' });
    try {
        const profile = await assetProfile.fetchAssetProfile(symbol);
        let daily = null, monthly = null;
        if (req.query.history === '1') {
            [daily, monthly] = await Promise.all([
                fetchAlphaCached('TIME_SERIES_DAILY_ADJUSTED', { symbol, outputsize: 'compact' }, ALPHA_CACHE_TTL_MS.daily).catch(() => null),
                fetchAlphaCached('TIME_SERIES_MONTHLY_ADJUSTED', { symbol }, ALPHA_CACHE_TTL_MS.monthly).catch(() => null)
            ]);
        }
        return res.json({ profile, ...(daily ? { daily } : {}), ...(monthly ? { monthly } : {}) });
    } catch (error) {
        return res.status(error.status || 502).json({ message: error.message || 'Asset profile unavailable' });
    }
});

// Alpha Vantage proxy endpoints (server-side key)
app.get('/api/alpha/search', authMiddleware, async (req, res) => {
    const keywords = (req.query.keywords || req.query.query || '').toString().trim();
    if (!keywords) {
        return res.status(400).json({ message: 'keywords is required' });
    }
    const localMatches = searchTopCompanies(keywords, 10);
    if (localMatches.length) {
        return res.json({
            bestMatches: localMatches.map((item) => ({
                '1. symbol': item.symbol,
                '2. name': item.name,
                '6. marketCap': item.marketCap || ''
            }))
        });
    }
    try {
        const data = await fetchAlphaCached('SYMBOL_SEARCH', { keywords }, ALPHA_CACHE_TTL_MS.daily);
        res.json({ bestMatches: data.bestMatches || [] });
    } catch (error) {
        res.status(error.status || 500).json({ message: publicErrorMessage(error, 'Alpha search failed') });
    }
});

app.get('/api/alpha/time-series/daily', authMiddleware, coreGate, async (req, res) => {
    const symbol = safeUpper(req.query.symbol);
    const outputsize = (req.query.outputsize || 'compact').toString();
    if (!symbol) {
        return res.status(400).json({ message: 'symbol is required' });
    }
    try {
        const data = await fetchAlphaCached('TIME_SERIES_DAILY_ADJUSTED', { symbol, outputsize }, ALPHA_CACHE_TTL_MS.daily);
        res.json(data);
    } catch (error) {
        res.status(error.status || 500).json({ message: publicErrorMessage(error, 'Daily series failed') });
    }
});

// Slim market-strip endpoint: last close, change and 30-close sparkline per
// symbol in ONE response (~2KB) instead of the tape fetching 8 full daily
// series (~270KB). Shared 10-min cache across all users.
const _stripCache = new Map(); // symbols-key -> { at, payload }
const STRIP_TTL_MS = 10 * 60 * 1000;
app.get('/api/market/strip', async (req, res) => {
    const symbols = String(req.query.symbols || 'SPY,QQQ,DIA,IWM')
        .split(',').map((s) => safeUpper(s.trim())).filter(Boolean).slice(0, 12);
    const key = symbols.join(',');
    const cached = _stripCache.get(key);
    if (cached && Date.now() - cached.at < STRIP_TTL_MS) return res.json(cached.payload);
    try {
        const out = {};
        await Promise.all(symbols.map(async (symbol) => {
            try {
                const data = await fetchAlphaCached('TIME_SERIES_DAILY_ADJUSTED', { symbol, outputsize: 'compact' }, ALPHA_CACHE_TTL_MS.daily);
                const series = data && data['Time Series (Daily)'];
                if (!series) return;
                const dates = Object.keys(series).sort((a, b) => (a < b ? 1 : -1));
                if (dates.length < 2) return;
                const latest = parseFloat(series[dates[0]]['4. close']);
                const prior = parseFloat(series[dates[1]]['4. close']);
                if (!Number.isFinite(latest) || !Number.isFinite(prior) || prior === 0) return;
                const closes = dates.slice(0, 30).reverse()
                    .map((d) => Number(parseFloat(series[d]['4. close']).toFixed(2)))
                    .filter((v) => Number.isFinite(v));
                out[symbol] = {
                    value: latest,
                    change: Number((latest - prior).toFixed(4)),
                    pct: Number((((latest - prior) / prior) * 100).toFixed(4)),
                    closes
                };
            } catch (_) { /* symbol failed — leave out, tape shows dash */ }
        }));
        const payload = { quotes: out, at: new Date().toISOString() };
        _stripCache.set(key, { at: Date.now(), payload });
        if (_stripCache.size > 500) _stripCache.delete(_stripCache.keys().next().value);
        res.json(payload);
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Market strip failed') });
    }
});

app.get('/api/alpha/time-series/monthly', authMiddleware, coreGate, async (req, res) => {
    const symbol = safeUpper(req.query.symbol);
    if (!symbol) {
        return res.status(400).json({ message: 'symbol is required' });
    }
    try {
        const data = await fetchAlphaCached('TIME_SERIES_MONTHLY_ADJUSTED', { symbol }, ALPHA_CACHE_TTL_MS.monthly);
        res.json(data);
    } catch (error) {
        res.status(error.status || 500).json({ message: publicErrorMessage(error, 'Monthly series failed') });
    }
});

app.get('/api/alpha/fundamentals/:symbol', authMiddleware, coreGate, async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!symbol) {
        return res.status(400).json({ message: 'symbol is required' });
    }
    try {
        const local = topCompaniesBySymbol.get(safeUpper(symbol));
        // Default to compact (~100 trading days, ~50KB) instead of full
        // (~3MB). Monthly series in same response covers longer ranges.
        // Client can request ?historyDepth=full when user picks 3Y+ ranges.
        const historyDepth = String(req.query.historyDepth || '').toLowerCase() === 'full' ? 'full' : 'compact';
        const [quote, overview, daily, monthly, income, balance, cash] = await Promise.all([
            fetchAlphaCached('GLOBAL_QUOTE', { symbol }, ALPHA_CACHE_TTL_MS.quote),
            fetchAlphaCached('OVERVIEW', { symbol }, ALPHA_CACHE_TTL_MS.fundamentals),
            fetchAlphaCached('TIME_SERIES_DAILY_ADJUSTED', { symbol, outputsize: historyDepth }, ALPHA_CACHE_TTL_MS.daily),
            fetchAlphaCached('TIME_SERIES_MONTHLY_ADJUSTED', { symbol }, ALPHA_CACHE_TTL_MS.monthly),
            fetchAlphaCached('INCOME_STATEMENT', { symbol }, ALPHA_CACHE_TTL_MS.fundamentals),
            fetchAlphaCached('BALANCE_SHEET', { symbol }, ALPHA_CACHE_TTL_MS.fundamentals),
            fetchAlphaCached('CASH_FLOW', { symbol }, ALPHA_CACHE_TTL_MS.fundamentals)
        ]);
        if (local) {
            overview.Name = overview.Name || local.name;
            overview.MarketCapitalization = overview.MarketCapitalization || (local.marketCap ? String(local.marketCap) : '');
            overview.PERatio = overview.PERatio || (local.peRatio ? String(local.peRatio) : '');
            overview.EPS = overview.EPS || (local.eps ? String(local.eps) : '');
            overview.Sector = overview.Sector || local.sector || '';
        }
        // SEC EDGAR backfill: fill any cell Yahoo left blank from the
        // company's actual XBRL filings. US-only, but free + no API key.
        const payload = { quote, overview, daily, monthly, income, balance, cash };
        await secSource.backfillStatements(symbol, payload).catch(() => {});
        res.json(await presentFundamentalsCurrency(payload, req.query.presentationCurrency));
    } catch (error) {
        res.status(error.status || 500).json({ message: publicErrorMessage(error, 'Fundamentals load failed') });
    }
});

// Lightweight quote-only endpoint. Used by the frontend to overlay a
// fresh price on top of a locally-cached fundamentals payload (the static
// cache skips GLOBAL_QUOTE on purpose since it's live data).
app.get('/api/alpha/quote/:symbol', authMiddleware, coreGate, async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!symbol) return res.status(400).json({ message: 'symbol is required' });
    try {
        const data = await fetchAlphaCached('GLOBAL_QUOTE', { symbol }, ALPHA_CACHE_TTL_MS.quote);
        res.json(data);
    } catch (error) {
        res.status(error.status || 500).json({ message: publicErrorMessage(error, 'Quote load failed') });
    }
});

app.get('/api/alpha/movers', authMiddleware, coreGate, async (req, res) => {
    try {
        const data = await fetchAlphaCached('TOP_GAINERS_LOSERS', {}, ALPHA_CACHE_TTL_MS.quote);
        res.json(data);
    } catch (error) {
        res.status(error.status || 500).json({ message: publicErrorMessage(error, 'Movers load failed') });
    }
});

app.get('/api/alpha/news', authMiddleware, coreGate, async (req, res) => {
    const tickers = (req.query.tickers || '').toString().trim();
    const topics = (req.query.topics || '').toString().trim();
    const limit = (req.query.limit || '40').toString().trim();
    const sort = (req.query.sort || 'LATEST').toString().trim();
    try {
        const params = { sort, limit };
        if (tickers) params.tickers = tickers;
        if (topics && topics !== 'all') params.topics = topics;
        const data = await fetchAlphaCached('NEWS_SENTIMENT', params, ALPHA_CACHE_TTL_MS.news);
        res.json(data);
    } catch (error) {
        res.status(error.status || 500).json({ message: publicErrorMessage(error, 'News load failed') });
    }
});

app.get('/api/news-image', async (req, res) => {
    const targetUrl = String(req.query.url || '').trim();
    if (!(await isSafeNewsImageUrl(targetUrl))) {
        return res.status(400).send('Invalid image URL');
    }

    try {
        const response = await axios.get(targetUrl, {
            responseType: 'arraybuffer',
            timeout: NEWS_IMAGE_PROXY_TIMEOUT_MS,
            maxContentLength: NEWS_IMAGE_PROXY_MAX_BYTES,
            maxBodyLength: NEWS_IMAGE_PROXY_MAX_BYTES,
            maxRedirects: 0,
            headers: {
                'User-Agent': 'stockportfolio.pro image proxy'
            },
            validateStatus: () => true
        });

        const contentType = String(response.headers['content-type'] || '').toLowerCase();
        if (response.status !== 200 || !contentType.startsWith('image/')) {
            return res.status(404).send('Image unavailable');
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Cache-Control', 'public, max-age=900');
        res.send(Buffer.from(response.data));
    } catch (error) {
        res.status(502).send('Image unavailable');
    }
});

app.get('/api/health', (req, res) => {
    const readyState = mongoose.connection.readyState;
    const dbConnected = readyState === 1;
    res.status(dbConnected ? 200 : 503).json({ ok: dbConnected });
});

// ----- Portfolio routes (used by the Dashboard tracker) -----
function portfolioOwnerId(req) {
    return req.userId;
}

app.get('/api/portfolio', authMiddleware, coreGate, async (req, res) => {
    try {
        const ownerId = portfolioOwnerId(req);
        const storedOnly = String(req.query.prices || '').toLowerCase() === 'stored';
        const portfolio = await Stock.find({ user: ownerId });
        const enriched = await Promise.all(portfolio.map(async (stock) => {
            const ticker = safeUpper(stock.symbol);
            const payload = stock.toObject();
            payload.symbol = ticker;
            payload.assetType = payload.assetType || 'stock';
            if (!storedOnly) {
                try {
                    payload.currentPrice = await getStockPrice(ticker);
                } catch (priceError) {
                    console.warn(`Price update failed for ${ticker}: ${priceError.message}`);
                }
            }
            return payload;
        }));
        res.json(enriched);
    } catch (error) {
        if (isDatabaseUnavailableError(error)) {
            return res.status(503).json({ message: 'Database unavailable. Start MongoDB and configure MONGODB_URI.' });
        }
        res.status(500).json({ message: 'Unable to load the portfolio right now.' });
    }
});

// Deterministic weekly portfolio briefing. It performs no model call, so
// repeated or automated dashboard loads cannot consume provider usage.
const _briefingCache = new Map(); // userId -> { at, payload }
const BRIEFING_TTL_MS = 12 * 60 * 60 * 1000;
app.get('/api/portfolio/briefing', authMiddleware, coreGate, async (req, res) => {
    try {
        const ownerId = portfolioOwnerId(req);
        const cacheKey = String(ownerId);
        const force = String(req.query.refresh || '') === '1';
        const cached = _briefingCache.get(cacheKey);
        if (!force && cached && Date.now() - cached.at < BRIEFING_TTL_MS) {
            return res.json({ ...cached.payload, cached: true });
        }

        const portfolio = await Stock.find({ user: ownerId });
        const enriched = await Promise.all(portfolio.map(async (stock) => {
            const ticker = safeUpper(stock.symbol);
            const obj = stock.toObject();
            obj.symbol = ticker;
            try { obj.currentPrice = await getStockPrice(ticker); } catch (_) { /* keep stored price */ }
            return obj;
        }));

        const result = await aiBriefing.generateBriefing(enriched);
        const payload = {
            briefing: result.briefing,
            facts: result.facts,
            source: result.source,
            generatedAt: new Date().toISOString()
        };
        _briefingCache.set(cacheKey, { at: Date.now(), payload });
        if (_briefingCache.size > 500) _briefingCache.delete(_briefingCache.keys().next().value);
        res.json({ ...payload, cached: false });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) {
            return res.status(503).json({ message: 'Database unavailable.' });
        }
        res.status(500).json({ message: publicErrorMessage(error, 'Briefing failed') });
    }
});

// Sample briefing for free/logged-out users — demonstrates the feature pre-payment.
// Uses the demo portfolio with indicative prices; deterministic template (no LLM call).
let _sampleBriefingCache = null;
app.get('/api/portfolio/briefing/sample', async (req, res) => {
    try {
        if (!_sampleBriefingCache) {
            const demoHoldings = [
                { symbol: 'AAPL', name: 'Apple Inc.',     sector: 'Technology',        shares: 20, purchasePrice: 148, currentPrice: 185 },
                { symbol: 'MSFT', name: 'Microsoft Corp.',sector: 'Technology',        shares: 10, purchasePrice: 285, currentPrice: 420 },
                { symbol: 'JNJ',  name: 'Johnson & Johnson', sector: 'Healthcare',     shares: 15, purchasePrice: 160, currentPrice: 148 },
                { symbol: 'JPM',  name: 'JPMorgan Chase', sector: 'Financial Services',shares: 12, purchasePrice: 156, currentPrice: 210 },
                { symbol: 'XOM',  name: 'ExxonMobil',     sector: 'Energy',           shares: 25, purchasePrice: 90,  currentPrice: 108 }
            ];
            const facts = aiBriefing.computePortfolioFacts(demoHoldings);
            _sampleBriefingCache = {
                briefing: aiBriefing.buildTemplateBriefing(facts),
                facts,
                source: 'template',
                generatedAt: new Date().toISOString(),
                sample: true
            };
        }
        res.json(_sampleBriefingCache);
    } catch (err) {
        res.status(500).json({ message: err.message || 'Sample briefing failed' });
    }
});

// --- Pro AI features ---
// Plain-English summary of a company's latest financials. Cached per symbol
// (fundamentals only change nightly).
const _aiSummaryCache = new Map();
const AI_SUMMARY_TTL_MS = 12 * 60 * 60 * 1000;
app.get('/api/stocks/:symbol/ai-summary', authMiddleware, proGate, async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!symbol) return res.status(400).json({ message: 'symbol required' });
    try {
        const cached = _aiSummaryCache.get(symbol);
        if (cached && Date.now() - cached.at < AI_SUMMARY_TTL_MS) {
            return res.json({ ...cached.payload, cached: true });
        }
        const result = await aiFeatures.summarizeFinancials(symbol);
        if (!result.summary) return res.status(404).json({ message: 'No financial data available for this symbol.' });
        const payload = { symbol, assetType: result.assetType || 'stock', summary: result.summary, source: result.source, generatedAt: new Date().toISOString() };
        _aiSummaryCache.set(symbol, { at: Date.now(), payload });
        if (_aiSummaryCache.size > 500) _aiSummaryCache.delete(_aiSummaryCache.keys().next().value);
        res.json({ ...payload, cached: false });
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'AI summary failed') });
    }
});

// Rewrite an existing generated answer/article for a platform's practical
// character limit. This edits presentation only and never changes the research.
app.post('/api/ai/share-copy', optionalAuth, async (req, res) => {
    const platform = String((req.body && req.body.platform) || '').toLowerCase();
    const title = String((req.body && req.body.title) || '').trim().slice(0, 500);
    const content = String((req.body && req.body.content) || '').trim().slice(0, 20000);
    if (!content) return res.status(400).json({ message: 'Share content is required.' });
    try {
        return res.json(await shareCopy.rewriteForPlatform({ platform, title, content, allowAi: isProUser(req) }));
    } catch (error) {
        return res.status(error.status || 500).json({ message: error.message || 'Could not prepare share copy.' });
    }
});

async function persistPublicResearchShare(payload, createdBy) {
    // A 96-bit random ID makes collisions vanishingly unlikely. Retrying on the
    // unique index keeps correctness deterministic even under a mocked RNG/test.
    for (let attempt = 0; attempt < 4; attempt++) {
        try {
            return await PublicResearchShare.create({
                publicId: shareCopy.makePublicShareId(),
                title: payload.title,
                content: payload.content,
                sourceUrl: payload.sourceUrl || null,
                createdBy: createdBy || null
            });
        } catch (error) {
            if (error && error.code === 11000) continue;
            throw error;
        }
    }
    throw Object.assign(new Error('Could not allocate a public report ID.'), { status: 503 });
}

// Explicit-on-click creation of an immutable, unlisted public research page.
// Optional auth lets public samples be shared, while retaining a private owner
// reference for abuse response. The public document never exposes that owner.
app.post('/api/research-shares', optionalAuth, async (req, res) => {
    try {
        const payload = shareCopy.normalizePublicResearchShare(req.body || {}, { publicBase: PUBLIC_APP_URL });
        const report = await persistPublicResearchShare(payload, req.user && req.user._id);
        const publicUrl = `${PUBLIC_APP_URL}/r/${report.publicId}`;
        res.setHeader('Cache-Control', 'no-store');
        trackFunnel('research_share_created', req.user && req.user._id, null, {
            reportId: report.publicId,
            sourceUrl: payload.sourceUrl || null
        });
        return res.status(201).json({
            id: report.publicId,
            url: publicUrl,
            visibility: 'unlisted-public',
            createdAt: report.createdAt
        });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).json({ message: 'Public sharing is temporarily unavailable.' });
        return res.status(error.status || 500).json({ message: error.message || 'Could not create a public research link.' });
    }
});

// Social crawlers receive full Open Graph metadata; search crawlers are told not
// to index these capability URLs. Reports contain escaped plain text only.
app.get('/r/:id', affiliateReferralLimiter, async (req, res) => {
    const publicId = String(req.params.id || '');
    // `/r/:id` already serves unlisted research reports.  Ambassador slugs use
    // the reserved `amb-` prefix so both public capabilities can coexist
    // without changing the existing research-share URL contract.
    if (publicId.startsWith('amb-') && affiliateProgram.isEnabled()) {
        return handleAffiliateReferral(req, res);
    }
    if (!shareCopy.isPublicShareId(publicId)) return res.status(404).send('Research report not found.');
    try {
        const report = await PublicResearchShare.findOne({ publicId }).lean();
        if (!report) return res.status(404).send('Research report not found.');
        res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
        res.setHeader('Cache-Control', 'public, max-age=600, stale-while-revalidate=86400');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        return res.type('html').send(shareCopy.renderPublicResearchPage(report, { publicBase: PUBLIC_APP_URL }));
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).send('Research sharing is temporarily unavailable.');
        return res.status(500).send('Could not load this research report.');
    }
});

// Conversational portfolio Q&A (Pro).
app.post('/api/portfolio/ask', authMiddleware, proGate, async (req, res) => {
    const question = String((req.body && req.body.question) || '').trim();
    if (!question) return res.status(400).json({ message: 'Ask a question.' });
    try {
        const ownerId = portfolioOwnerId(req);
        const portfolio = await Stock.find({ user: ownerId });
        const enriched = await Promise.all(portfolio.map(async (stock) => {
            const ticker = safeUpper(stock.symbol);
            const obj = stock.toObject();
            obj.symbol = ticker;
            try { obj.currentPrice = await getStockPrice(ticker); } catch (_) { /* keep stored */ }
            return obj;
        }));
        const result = await aiFeatures.answerPortfolioQuestion(enriched, question);
        res.json({ answer: result.answer, source: result.source });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).json({ message: 'Database unavailable.' });
        res.status(500).json({ message: publicErrorMessage(error, 'Question failed') });
    }
});

// ----- Ask: the tool-grounded financial chatbot (metered, not Pro-gated) -----
// Free users get a monthly taste (AI_CHAT_FREE_LIMIT, default 5); Pro gets
// AI_CHAT_PRO_LIMIT (default 300). Quota is only consumed on a real answer.
// ----- Anonymous Ask teaser: a couple of free, abuse-bounded queries so a
// cold visitor can feel the filing-grounded answer before the signup wall.
// Everything off-switchable: ANON_ASK_LIMIT=0 restores signup-required Ask.
const ANON_ASK_LIMIT = process.env.NODE_ENV === 'production' && process.env.ALLOW_ANON_AI !== 'true'
    ? 0
    : Number(process.env.ANON_ASK_LIMIT ?? 0);                         // free queries per browser
const ANON_ASK_IP_DAY = Number(process.env.ANON_ASK_IP_DAY ?? 6);      // backstop: per IP / day
const ANON_ASK_GLOBAL_DAY = Number(process.env.ANON_ASK_GLOBAL_DAY ?? 400); // hard daily cost ceiling
const _anonAsk = { day: '', global: 0, ip: new Map() };
function _anonAskRoll() {
    const d = new Date().toISOString().slice(0, 10);
    if (_anonAsk.day !== d) { _anonAsk.day = d; _anonAsk.global = 0; _anonAsk.ip.clear(); }
}
function _anonAskIp(req) {
    // req.ip is proxy-aware (trust proxy = 1), so it reflects the client IP that
    // Render's proxy appended — not a client-supplied X-Forwarded-For value,
    // which is spoofable and would let anyone bypass or exhaust the free quota.
    return String(req.ip || '0');
}
function _anonAskReadCount(req) {
    const raw = (req.headers.cookie || '').split(';').map((s) => s.trim())
        .find((s) => s.startsWith('sp_ask_trial='));
    if (!raw) return 0;
    try { return Number(jwt.verify(decodeURIComponent(raw.slice('sp_ask_trial='.length)), JWT_SECRET).n) || 0; }
    catch (_) { return 0; }
}
function _anonAskCookie(n) {
    const v = jwt.sign({ n, k: 'ask_trial' }, JWT_SECRET, { expiresIn: '30d' });
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    return `sp_ask_trial=${encodeURIComponent(v)}; Max-Age=${30 * 24 * 3600}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}
// Auth shim for Ask: a real bearer token → full authed path; logged-out (or a
// junk "null"/"undefined" header) → anonymous teaser path, never a 401.
function askAuth(req, res, next) {
    const raw = authTokenFromRequest(req);
    if (raw && raw !== 'null' && raw !== 'undefined') return authMiddleware(req, res, next);
    req.anon = true;
    return next();
}
async function anonAskHandler(req, res) {
    const question = String((req.body && req.body.question) || '').trim();
    if (!question) return res.status(400).json({ message: 'Ask a question.' });
    if (ANON_ASK_LIMIT <= 0) {
        return res.status(401).json({ message: 'Ask needs an account', code: 'ASK_AUTH' });
    }
    _anonAskRoll();
    const ip = _anonAskIp(req);
    const visitorUsed = _anonAskReadCount(req);
    const ipUsed = _anonAsk.ip.get(ip) || 0;
    const wall = (msg) => ({ message: msg, code: 'ASK_TRIAL', trial: true,
        quota: { used: ANON_ASK_LIMIT, limit: ANON_ASK_LIMIT, remaining: 0 } });
    if (visitorUsed >= ANON_ASK_LIMIT) {
        return res.status(429).json(wall(`That's your ${ANON_ASK_LIMIT} free ${ANON_ASK_LIMIT === 1 ? 'question' : 'questions'}. Log in or create a free account to keep asking.`));
    }
    if (ipUsed >= ANON_ASK_IP_DAY || _anonAsk.global >= ANON_ASK_GLOBAL_DAY) {
        return res.status(429).json(wall('The free preview is busy right now. Log in or create a free account to keep asking.'));
    }
    // cost is incurred on the call → count the IP/global attempt now; the
    // per-browser counter only advances on a delivered answer (cookie below).
    _anonAsk.ip.set(ip, ipUsed + 1);
    _anonAsk.global += 1;
    const newVisitor = visitorUsed + 1;
    const remaining = Math.max(0, ANON_ASK_LIMIT - newVisitor);
    try {
        if ((req.body && req.body.stream) === true) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no',
                'Set-Cookie': _anonAskCookie(newVisitor)
            });
            let closed = false;
            req.on('close', () => { closed = true; });
            const send = (event, data) => {
                if (closed || res.writableEnded) return;
                res.write(`event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`);
            };
            const ping = setInterval(() => { if (!closed && !res.writableEnded) res.write(': ping\n\n'); }, 10000);
            try {
                const result = await aiChat.ask({ question, history: [], ctx: { holdings: [] }, onEvent: (e) => send(e.type, e) });
                send('done', { answer: result.answer, toolsUsed: result.toolsUsed, source: result.source,
                    trial: true, quota: { used: newVisitor, limit: ANON_ASK_LIMIT, remaining } });
            } catch (error) {
                send('error', { message: publicErrorMessage(error, 'Ask failed') });
            } finally {
                clearInterval(ping);
                if (!res.writableEnded) res.end();
            }
            return;
        }
        const result = await aiChat.ask({ question, history: [], ctx: { holdings: [] } });
        res.setHeader('Set-Cookie', _anonAskCookie(newVisitor));
        res.json({ answer: result.answer, toolsUsed: result.toolsUsed, source: result.source,
            trial: true, quota: { used: newVisitor, limit: ANON_ASK_LIMIT, remaining } });
    } catch (error) {
        if (!res.headersSent) res.status(500).json({ message: publicErrorMessage(error, 'Ask failed') });
    }
}

app.post('/api/ai/chat', askAuth, async (req, res) => {
    if (req.anon) return anonAskHandler(req, res);
    const question = String((req.body && req.body.question) || '').trim();
    if (!question) return res.status(400).json({ message: 'Ask a question.' });
    try {
        const userId = portfolioOwnerId(req);
        const limit = effectiveAskLimit(req);
        const used = await aiChat.getUsage(userId);
        if (used >= limit) {
            const resp = {
                message: isProUser(req)
                    ? `You've used all ${limit} Ask queries this month — the counter resets on the 1st.`
                    : `You've used your ${limit} Ask queries this month. Upgrade for ${aiChat.limits(req.tier === 'free' ? 'core' : 'pro')} a month.`,
                // tier lets the client render the right upgrade ladder even when
                // AI_CHAT_*_LIMIT env overrides make limit→tier inference ambiguous
                code: 'ASK_QUOTA', tier: req.tier === true ? 'pro' : req.tier, quota: { used, limit, remaining: 0 }
            };
            // AppSumo tier 1/2 buyers aren't stuck at the cap — they can raise their
            // monthly Ask limit by upgrading their license. Surface a real link so
            // the wall offers the upgrade instead of a dead "resets on the 1st".
            const asTier = Number(req.user && req.user.appsumoTier);
            if (req.user && req.user.appsumoLicenseKey && asTier > 0 && asTier < 3) {
                let upgradeUrl = APPSUMO_ACCOUNT_URL;
                try {
                    const lic = await AppSumoLicense.findOne({ licenseKey: req.user.appsumoLicenseKey }, { changePlanUrl: 1 }).lean();
                    upgradeUrl = appsumoUpgradeUrl(lic);
                } catch (_) { /* fall back to account page */ }
                resp.appsumo = { isAppSumo: true, tier: asTier, upgradeUrl };
                resp.message = `You've used all ${limit} Ask questions this month on your AppSumo plan. Upgrade your AppSumo license for a higher monthly limit — or wait for the reset on the 1st.`;
            }
            return res.status(429).json(resp);
        }
        // Holdings context for the get_portfolio tool (stored prices — no live
        // price fan-out per chat message).
        let holdings = [];
        try { holdings = (await Stock.find({ user: userId })).map((s) => s.toObject()); } catch (_) { holdings = []; }
        const clientHistory = Array.isArray(req.body && req.body.history) ? req.body.history : [];
        // a fresh page sends no history — pick the thread back up from the
        // user's last few stored exchanges (cross-session memory)
        const history = clientHistory.length ? clientHistory : await aiChat.recentHistory(userId);

        // Streaming mode (stream:true in the body): answer over SSE so the
        // user sees tool progress and the answer typing out instead of a
        // ~30s silent wait. Events: tool / delta / rollback / done / error.
        // Quota and auth errors above still return plain JSON — the widget
        // switches on the response content-type.
        if ((req.body && req.body.stream) === true) {
            res.writeHead(200, {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache, no-transform',
                Connection: 'keep-alive',
                'X-Accel-Buffering': 'no'
            });
            let closed = false;
            req.on('close', () => { closed = true; });
            const send = (event, data) => {
                if (closed || res.writableEnded) return;
                res.write(`event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`);
            };
            // Keep proxies from timing out the connection between LLM rounds.
            const ping = setInterval(() => { if (!closed && !res.writableEnded) res.write(': ping\n\n'); }, 10000);
            try {
                const result = await aiChat.ask({
                    question, history, ctx: { holdings },
                    onEvent: (e) => send(e.type, e)
                });
                const counted = result.source === 'ai' || result.source === 'blocked';
                if (counted) await aiChat.recordUse(userId);
                if (result.source === 'ai') aiChat.saveExchange(userId, question, result.answer);
                trackFirstAskSuccess(req, req.user, result);
                if (result.answer) trackActivation(userId, 'ask');
                const usedNow = counted ? used + 1 : used;
                send('done', {
                    answer: result.answer, toolsUsed: result.toolsUsed, source: result.source,
                    quota: { used: usedNow, limit, remaining: Math.max(0, limit - usedNow) }
                });
            } catch (error) {
                send('error', { message: publicErrorMessage(error, 'Ask failed') });
            } finally {
                clearInterval(ping);
                if (!res.writableEnded) res.end();
            }
            return;
        }

        const result = await aiChat.ask({ question, history, ctx: { holdings } });
        const counted = result.source === 'ai' || result.source === 'blocked';
        if (counted) await aiChat.recordUse(userId);
        if (result.source === 'ai') aiChat.saveExchange(userId, question, result.answer);
        trackFirstAskSuccess(req, req.user, result);
        if (result.answer) trackActivation(userId, 'ask');
        const usedNow = counted ? used + 1 : used;
        res.json({
            answer: result.answer, toolsUsed: result.toolsUsed, source: result.source,
            quota: { used: usedNow, limit, remaining: Math.max(0, limit - usedNow) }
        });
    } catch (error) {
        if (!res.headersSent) res.status(500).json({ message: publicErrorMessage(error, 'Ask failed') });
    }
});

// ----- Portfolio X-Ray: look-through fundamentals of the whole portfolio -----
const _xrayCache = new Map(); // userId -> { at, payload }
const XRAY_TTL_MS = 60 * 60 * 1000;
app.get('/api/portfolio/xray', authMiddleware, coreGate, async (req, res) => {
    try {
        const ownerId = portfolioOwnerId(req);
        const key = String(ownerId);
        const force = String(req.query.refresh || '') === '1';
        const cached = _xrayCache.get(key);
        if (!force && cached && Date.now() - cached.at < XRAY_TTL_MS) {
            return res.json({ ...cached.payload, cached: true });
        }
        const portfolio = await Stock.find({ user: ownerId });
        const enriched = await Promise.all(portfolio.map(async (stock) => {
            const obj = stock.toObject();
            obj.symbol = safeUpper(stock.symbol);
            try { obj.currentPrice = await getStockPrice(obj.symbol); } catch (_) { /* stored price */ }
            return obj;
        }));
        const payload = xray.computeXray(enriched);
        _xrayCache.set(key, { at: Date.now(), payload });
        if (_xrayCache.size > 500) _xrayCache.delete(_xrayCache.keys().next().value);
        res.json({ ...payload, cached: false });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).json({ message: 'Database unavailable.' });
        res.status(500).json({ message: publicErrorMessage(error, 'X-Ray failed') });
    }
});

// ----- Wash-sale guard: cross-account tax-lot intelligence (Pro) -----
const washSale = require('./wash-sale');
app.post('/api/tax/import', authMiddleware, monitorGate, async (req, res) => {
    try {
        const result = await washSale.importCsv(portfolioOwnerId(req), req.body || {});
        res.json(result);
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).json({ message: 'Database unavailable.' });
        res.status(Number(error.status) || 500).json({ message: publicErrorMessage(error, 'Import failed') });
    }
});

app.get('/api/tax/accounts', authMiddleware, monitorGate, async (req, res) => {
    try {
        res.json({ accounts: await washSale.listAccounts(portfolioOwnerId(req)) });
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Accounts load failed') });
    }
});

app.delete('/api/tax/accounts/:account', authMiddleware, monitorGate, async (req, res) => {
    try {
        await washSale.deleteAccount(portfolioOwnerId(req), decodeURIComponent(req.params.account));
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Delete failed') });
    }
});

app.get('/api/tax/wash-sales', authMiddleware, monitorGate, async (req, res) => {
    try {
        res.json(await washSale.washReport(portfolioOwnerId(req)));
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Wash-sale report failed') });
    }
});

app.get('/api/tax/wash-check', authMiddleware, monitorGate, async (req, res) => {
    try {
        res.json(await washSale.preTradeCheck(portfolioOwnerId(req), req.query.symbol));
    } catch (error) {
        res.status(Number(error.status) || 500).json({ message: publicErrorMessage(error, 'Check failed') });
    }
});

// ----- Movement attribution: why the portfolio moved today (Pro) -----
const attribution = require('./attribution');
const _attribCache = new Map(); // userId -> { at, payload }
const ATTRIB_TTL_MS = 20 * 60 * 1000;
app.get('/api/portfolio/attribution', authMiddleware, proGate, async (req, res) => {
    try {
        const userId = String(portfolioOwnerId(req));
        const hit = _attribCache.get(userId);
        if (hit && Date.now() - hit.at < ATTRIB_TTL_MS) return res.json(hit.payload);
        const holdings = (await Stock.find({ user: userId })).map((s) => s.toObject());
        const payload = await attribution.computeAttribution(holdings);
        _attribCache.set(userId, { at: Date.now(), payload });
        if (_attribCache.size > 500) _attribCache.delete(_attribCache.keys().next().value);
        res.json(payload);
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).json({ message: 'Database unavailable.' });
        res.status(500).json({ message: publicErrorMessage(error, 'Attribution failed') });
    }
});

// ----- Alerts (Filing Watchdog + health-check flips, see backend/watchdog.js) -----
app.get('/api/alerts', authMiddleware, async (req, res) => {
    try {
        const result = await watchdog.listAlerts(portfolioOwnerId(req));
        res.json(result);
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).json({ message: 'Database unavailable.' });
        res.status(500).json({ message: publicErrorMessage(error, 'Alerts load failed') });
    }
});

app.post('/api/alerts/seen', authMiddleware, async (req, res) => {
    try {
        await watchdog.markSeen(portfolioOwnerId(req));
        res.json({ ok: true });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).json({ message: 'Database unavailable.' });
        res.status(500).json({ message: publicErrorMessage(error, 'Alerts update failed') });
    }
});

// ----- Alert rules: user valuation thresholds (Pro, see backend/smart-alerts.js) -----
const smartAlerts = require('./smart-alerts');
app.get('/api/alert-rules', authMiddleware, proGate, async (req, res) => {
    try {
        res.json({ rules: await smartAlerts.listRules(portfolioOwnerId(req)) });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).json({ message: 'Database unavailable.' });
        res.status(500).json({ message: publicErrorMessage(error, 'Rules load failed') });
    }
});

app.post('/api/alert-rules', authMiddleware, proGate, async (req, res) => {
    try {
        const rule = await smartAlerts.createRule(portfolioOwnerId(req), req.body || {});
        res.status(201).json({ rule });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).json({ message: 'Database unavailable.' });
        res.status(Number(error.status) || 500).json({ message: publicErrorMessage(error, 'Rule create failed') });
    }
});

app.delete('/api/alert-rules/:id', authMiddleware, proGate, async (req, res) => {
    try {
        await smartAlerts.deleteRule(portfolioOwnerId(req), req.params.id);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Rule delete failed') });
    }
});

// ----- Screener (public, un-gated — rivals charge for this; SEC data is free) -----
app.get('/api/screener', (req, res) => {
    try {
        const q = req.query || {};
        const result = aiChat.screenRows({
            sector: q.sector,
            min_revenue_cagr_5y_pct: q.minRevCagr5y,
            min_net_margin_pct: q.minNetMargin,
            min_roe_pct: q.minRoe,
            min_dividend_yield_pct: q.minDivYield,
            min_market_cap_billions: q.minMarketCapB,
            min_profitable_years_of_last_10: q.minProfitableYears,
            min_latest_qtr_earnings_growth_yoy_pct: q.minQtrEarningsGrowth,
            max_pe: q.maxPe,
            require_positive_fcf: String(q.fcfPositive || '') === '1',
            sort_by: q.sortBy,
            limit: q.limit,
            maxLimit: 100
        });
        res.json({ ...result, sectors: aiChat.sectorList() });
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Screener failed') });
    }
});

// ----- Watchlist (one flat list per user) -----
app.get('/api/watchlist', authMiddleware, async (req, res) => {
    try {
        const doc = await Watchlist.findOne({ user: portfolioOwnerId(req) }).lean();
        const symbols = (doc && doc.symbols) || [];
        // enrich from the public screen index (no per-symbol fan-out)
        const rows = symbols.map((s) => {
            const m = aiChat.metricsFor(s);
            return m ? { symbol: s, name: m.name, sector: m.sector, marketCapB: m.marketCapB, pe: m.pe, netMarginPct: m.netMarginPct, revCagr5Pct: m.revCagr5Pct, qtrNetIncomeYoYPct: m.qtrNetIncomeYoYPct } : { symbol: s };
        });
        res.json({ symbols, rows });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).json({ message: 'Database unavailable.' });
        res.status(500).json({ message: publicErrorMessage(error, 'Watchlist load failed') });
    }
});

const FREE_WATCHLIST_CAP = parseInt(process.env.FREE_WATCHLIST_CAP || '10', 10);
app.post('/api/watchlist/:symbol', authMiddleware, async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!symbol || !/^[A-Z0-9.\-]{1,10}$/.test(symbol)) return res.status(400).json({ message: 'Invalid symbol' });
    try {
        if (req.tier === 'free') {
            const existing = await Watchlist.findOne({ user: portfolioOwnerId(req) }).lean();
            const symbols = (existing && existing.symbols) || [];
            if (!symbols.includes(symbol) && symbols.length >= FREE_WATCHLIST_CAP) {
                return res.status(402).json({
                    message: `The free plan tracks up to ${FREE_WATCHLIST_CAP} companies. Upgrade to keep adding.`,
                    code: 'SUBSCRIPTION_REQUIRED'
                });
            }
        }
        const doc = await Watchlist.findOneAndUpdate(
            { user: portfolioOwnerId(req) },
            { $addToSet: { symbols: symbol } },
            { upsert: true, new: true }
        );
        res.json({ symbols: doc.symbols });
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Watchlist update failed') });
    }
});

app.delete('/api/watchlist/:symbol', authMiddleware, async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    try {
        const doc = await Watchlist.findOneAndUpdate(
            { user: portfolioOwnerId(req) },
            { $pull: { symbols: symbol } },
            { new: true }
        );
        res.json({ symbols: (doc && doc.symbols) || [] });
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Watchlist update failed') });
    }
});

// ----- Company extras (v2 page): SEC filings + ownership, public + cached -----
const _filingsCache = new Map(); // SYM -> { at, payload }
const COMPANY_EXTRA_TTL_MS = 24 * 60 * 60 * 1000;
const DOC_FORMS = new Set(['10-K', '10-K/A', '10-Q', '10-Q/A', '8-K', '8-K/A', '4', '4/A', 'DEF 14A']);
const DOC_CATEGORY = (form) => {
    if (form.startsWith('10-K')) return 'annual';
    if (form.startsWith('10-Q')) return 'quarterly';
    if (form.startsWith('8-K')) return 'events';
    if (form === '4' || form === '4/A') return 'insider';
    if (form === 'DEF 14A') return 'proxy';
    return 'other';
};
app.get('/api/company/:symbol/filings', async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!isValidTicker(symbol)) return res.status(400).json({ message: 'Invalid symbol' });
    try {
        const cached = _filingsCache.get(symbol);
        if (cached && Date.now() - cached.at < COMPANY_EXTRA_TTL_MS) return res.json(cached.payload);
        const filings = await watchdog.fetchFilingsDeep(symbol, DOC_FORMS, {
            '10-K': 7, '10-K/A': 2, '10-Q': 8, '10-Q/A': 2, '8-K': 8, '8-K/A': 2, '4': 10, '4/A': 2, 'DEF 14A': 5
        });
        if (filings === null) return res.status(404).json({ message: 'No SEC filings found for this symbol.' });
        const categories = { annual: [], quarterly: [], events: [], insider: [], proxy: [] };
        const caps = { annual: 9, quarterly: 10, events: 10, insider: 10, proxy: 5 };
        for (const f of filings) {
            const cat = DOC_CATEGORY(f.form);
            if (!categories[cat] || categories[cat].length >= caps[cat]) continue;
            categories[cat].push({ form: f.form, label: watchdog.FORM_LABEL[f.form] || f.form, date: f.date, url: f.url });
        }
        const payload = {
            symbol,
            categories,
            // legacy flat list (kept for any cached frontend)
            filings: [].concat(categories.annual, categories.quarterly, categories.events).slice(0, 14),
            source: 'SEC EDGAR'
        };
        _filingsCache.set(symbol, { at: Date.now(), payload });
        if (_filingsCache.size > 500) _filingsCache.delete(_filingsCache.keys().next().value);
        res.json(payload);
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Filings load failed') });
    }
});

// Insider history — the real Form 4 trail (3 years), parsed from EDGAR.
// Public; first request per company kicks off a background build (~1-2 min)
// and the response says so.
const insiders = require('./insiders');
const gurus = require('./gurus');
const filingMonitor = require('./filing-monitor');
const monitorDigest = require('./monitor-digest');
app.get('/api/company/:symbol/insider-history', async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!isValidTicker(symbol)) return res.status(400).json({ message: 'Invalid symbol' });
    try {
        const result = await insiders.history(symbol);
        res.json(result);
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Insider history failed') });
    }
});

// ----- Reverse DCF: the growth rate today's price implies, vs the record -----
const _rdcfCache = new Map(); // SYM|r|tg|base -> { at, payload }
const RDCF_TTL_MS = 60 * 60 * 1000;
app.get('/api/company/:symbol/reverse-dcf', authMiddleware, coreGate, async (req, res) => {
    try {
        const symbol = safeUpper(req.params.symbol);
        if (!symbol || !/^[A-Z0-9.\-]{1,10}$/.test(symbol)) return res.status(400).json({ message: 'Invalid symbol' });
        const opts = {
            discountRatePct: req.query.r,
            terminalGrowthPct: req.query.tg,
            base: req.query.base
        };
        const key = `${symbol}|${opts.discountRatePct || ''}|${opts.terminalGrowthPct || ''}|${opts.base || ''}`;
        const hit = _rdcfCache.get(key);
        if (hit && Date.now() - hit.at < RDCF_TTL_MS) return res.json(hit.payload);
        const payload = await reverseDcf.computeReverseDcf(symbol, opts);
        if (payload.error) return res.status(404).json({ message: payload.error });
        _rdcfCache.set(key, { at: Date.now(), payload });
        if (_rdcfCache.size > 500) _rdcfCache.delete(_rdcfCache.keys().next().value);
        res.json(payload);
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Reverse DCF failed') });
    }
});

// Insights — connected, decision-relevant analysis from a deterministic
// fact pack (Pro: this is the synthesized intelligence tier).
const insights = require('./insights');
app.get('/api/company/:symbol/insights', authMiddleware, proGate, async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!symbol) return res.status(400).json({ message: 'symbol required' });
    try {
        const instrument = await assetProfile.fetchAssetProfile(symbol).catch(() => null);
        if (instrument && assetProfile.isFundAsset(instrument.assetType)) {
            return res.status(422).json({
                code: 'ASSET_FEATURE_UNAVAILABLE', assetType: instrument.assetType,
                message: `Company insights depend on operating-company financial statements. Use Ask for ${symbol}'s fees, allocation, holdings, performance and risk instead.`
            });
        }
        const result = await insights.generateInsights(symbol);
        if (result.error) return res.status(404).json({ message: result.error });
        res.json(result);
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Insights failed') });
    }
});

// Key Points — the AI-extracted company dossier from the latest 10-K.
// Public: one extraction per filing, cached forever in Mongo, so the spend
// is bounded the same way the segments cache is.
const keypoints = require('./keypoints');
app.get('/api/company/:symbol/keypoints', optionalAuth, async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!isValidTicker(symbol)) return res.status(400).json({ message: 'Invalid symbol' });
    try {
        const generate = String(req.query.generate || '') === '1';
        if (generate && !req.user) return res.status(401).json({ message: 'Authentication required' });
        if (generate && !isProUser(req)) return res.status(402).json({ message: 'Key-point generation is available on Pro.' });
        const instrument = await assetProfile.fetchAssetProfile(symbol).catch(() => null);
        if (instrument && assetProfile.isFundAsset(instrument.assetType)) {
            return res.status(422).json({
                code: 'ASSET_FEATURE_UNAVAILABLE', assetType: instrument.assetType,
                message: `${instrument.assetTypeLabel}s do not publish company 10-K business dossiers. Use the fund profile or Ask for holdings, costs, allocation, returns and risk.`
            });
        }
        // Ordinary page loads may read an existing cache but can never create
        // provider usage. Generation requires the explicit Insights Pro click,
        // which sends generate=1 from company.js.
        const result = await keypoints.extractKeyPoints(symbol, { allowAi: generate && isProUser(req) });
        if (result.error) return res.status(404).json({ message: result.error });
        res.json(result);
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Key points failed') });
    }
});

const _ownershipCache = new Map(); // SYM -> { at, payload }
app.get('/api/company/:symbol/ownership', async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!isValidTicker(symbol)) return res.status(400).json({ message: 'Invalid symbol' });
    try {
        const cached = _ownershipCache.get(symbol);
        if (cached && Date.now() - cached.at < COMPANY_EXTRA_TTL_MS) return res.json(cached.payload);
        const data = await yahooSource.fetchOwnership(symbol);
        const payload = { symbol, ...data, source: 'Yahoo Finance (13F-derived)' };
        _ownershipCache.set(symbol, { at: Date.now(), payload });
        if (_ownershipCache.size > 500) _ownershipCache.delete(_ownershipCache.keys().next().value);
        res.json(payload);
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Ownership load failed') });
    }
});

// Business segments, AI-extracted from the latest 10-K (Pro — the synthesized
// intelligence is metered; the raw numbers everywhere else stay open).
const segments = require('./segments');
app.get('/api/company/:symbol/segments', authMiddleware, proGate, async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!symbol) return res.status(400).json({ message: 'symbol required' });
    try {
        const instrument = await assetProfile.fetchAssetProfile(symbol).catch(() => null);
        if (instrument && assetProfile.isFundAsset(instrument.assetType)) {
            return res.status(422).json({
                code: 'ASSET_FEATURE_UNAVAILABLE', assetType: instrument.assetType,
                message: `${instrument.assetTypeLabel}s have portfolio allocations and holdings rather than company business segments. Use the fund profile or Ask instead.`
            });
        }
        const result = await segments.extractSegments(symbol);
        if (result.error) return res.status(404).json({ message: result.error });
        res.json(result);
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Segment extraction failed') });
    }
});

// Filing Diff — what changed in the newest 10-K/10-Q vs the prior one (Pro).
// First call per filing pair fetches both documents and runs the comparison
// (~30-60s); after that it's served from the Mongo cache.
const filingDiff = require('./filing-diff');
const _diffInflight = new Map(); // SYM -> Promise (collapse concurrent first hits)
app.get('/api/company/:symbol/filing-diff', authMiddleware, proGate, async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!symbol) return res.status(400).json({ message: 'symbol required' });
    try {
        const instrument = await assetProfile.fetchAssetProfile(symbol).catch(() => null);
        if (instrument && assetProfile.isFundAsset(instrument.assetType)) {
            return res.status(422).json({
                code: 'ASSET_FEATURE_UNAVAILABLE', assetType: instrument.assetType,
                message: `${instrument.assetTypeLabel}s do not have comparable company 10-K/10-Q filing changes. Use Ask for the fund's latest holdings, costs, performance and risk.`
            });
        }
        let p = _diffInflight.get(symbol);
        if (!p) {
            p = filingDiff.computeFilingDiff(symbol).finally(() => _diffInflight.delete(symbol));
            _diffInflight.set(symbol, p);
        }
        const result = await p;
        if (result.error) return res.status(404).json({ message: result.error });
        res.json(result);
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Filing comparison failed') });
    }
});

// Quota peek so the UI can show "2 of 3 free questions left" before asking.
// Thumbs on an Ask answer — stored for quality review, nothing else.
app.post('/api/ai/chat/feedback', authMiddleware, async (req, res) => {
    try {
        await mongoose.connection.collection('ai_chat_feedback').insertOne({
            userId: String(portfolioOwnerId(req)),
            verdict: (req.body && req.body.verdict) === 'up' ? 'up' : 'down',
            question: String((req.body && req.body.question) || '').slice(0, 8000),
            answer: String((req.body && req.body.answer) || '').slice(0, 4000),
            at: new Date()
        });
        res.json({ ok: true });
    } catch (_) {
        res.status(500).json({ message: 'Could not record feedback.' });
    }
});

app.get('/api/ai/chat/quota', authMiddleware, async (req, res) => {
    try {
        const limit = effectiveAskLimit(req);
        const used = await aiChat.getUsage(portfolioOwnerId(req));
        const out = { used, limit, remaining: Math.max(0, limit - used), pro: isProUser(req), tier: req.tier };
        // AppSumo lifetime buyers: expose tier + a real upgrade link so the UI can
        // offer "Upgrade your AppSumo license" at the cap instead of a dead end.
        if (req.user && req.user.appsumoLicenseKey) {
            let upgradeUrl = APPSUMO_ACCOUNT_URL;
            try {
                const lic = await AppSumoLicense.findOne({ licenseKey: req.user.appsumoLicenseKey }, { changePlanUrl: 1 }).lean();
                upgradeUrl = appsumoUpgradeUrl(lic);
            } catch (_) { /* fall back to account page */ }
            out.appsumo = { isAppSumo: true, tier: req.user.appsumoTier || null, cap: req.user.appsumoAiCap || null, upgradeUrl };
        }
        res.json(out);
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Quota check failed') });
    }
});

app.post('/api/portfolio', authMiddleware, coreGate, async (req, res) => {
    const { symbol, name, shares, purchaseDate, purchasePrice } = req.body;
    try {
        if (!symbol || !shares) {
            return res.status(400).json({ message: 'Symbol and shares are required' });
        }
        const ticker = String(symbol).toUpperCase();
        const qty = Number(shares);
        if (!Number.isFinite(qty) || qty <= 0) {
            return res.status(400).json({ message: 'Shares must be a positive number' });
        }
        // One lightweight quote supplies identity, asset type and price. The
        // old path made a price request and then a second profile request in
        // sequence (plus a large fund-summary request for ETFs/funds).
        let livePrice = 0;
        let profile;
        try {
            profile = await assetProfile.fetchAssetProfile(ticker, { fundDetails: false });
            const quotedPrice = Number(profile.price);
            if (Number.isFinite(quotedPrice) && quotedPrice > 0) {
                livePrice = quotedPrice;
                cacheSet(priceCache, ticker, livePrice);
            }
        } catch (_) {
            const fallback = await Promise.allSettled([getCompanyProfile(ticker), getStockPrice(ticker)]);
            profile = fallback[0].status === 'fulfilled' ? fallback[0].value : {};
            if (fallback[1].status === 'fulfilled') livePrice = fallback[1].value;
        }
        if (!livePrice) {
            try { livePrice = await getStockPrice(ticker); }
            catch (priceError) { console.warn(`Price lookup failed for ${ticker}: ${priceError.message}`); }
        }

        const buyPrice = Number.isFinite(Number(purchasePrice)) && Number(purchasePrice) > 0
            ? Number(purchasePrice)
            : livePrice;

        profile = profile || {};
        const resolvedName = name || profile.name || ticker;
        const sector = profile.sector || profile.category || '';
        let purchase = purchaseDate ? new Date(purchaseDate) : new Date();
        if (Number.isNaN(purchase.getTime())) purchase = new Date();

        const newStock = new Stock({
            symbol: ticker,
            name: resolvedName,
            sector,
            assetType: profile.assetType || (isCryptoSymbol(ticker) ? 'crypto' : 'stock'),
            quoteType: profile.quoteType || '',
            category: profile.category || '',
            shares: qty,
            purchasePrice: buyPrice,
            purchaseDate: purchase,
            currentPrice: livePrice,
            user: portfolioOwnerId(req)
        });
        await newStock.save();
        const cacheKey = String(portfolioOwnerId(req));
        _briefingCache.delete(cacheKey);
        _xrayCache.delete(cacheKey);
        _attribCache.delete(cacheKey);
        const portfolioCount = await Stock.countDocuments({ user: portfolioOwnerId(req) });
        if (portfolioCount >= 1) trackActivation(req.userId, 'portfolio', {
            resultValid: true, sourceOpened: false, featureType: 'portfolio',
            requestFields: trackingRequestFields(req, res)
        });
        res.json(newStock);
    } catch (error) {
        if (isDatabaseUnavailableError(error)) {
            return res.status(503).json({ message: 'Database unavailable. Start MongoDB and configure MONGODB_URI.' });
        }
        res.status(500).json({ message: 'Unable to complete that request right now.' });
    }
});

app.delete('/api/portfolio/:id', authMiddleware, coreGate, async (req, res) => {
    try {
        const ownerId = portfolioOwnerId(req);
        const stock = await Stock.findOneAndDelete({ _id: req.params.id, user: ownerId });
        if (!stock) return res.status(404).json({ message: 'Holding not found or unauthorized' });
        const cacheKey = String(ownerId);
        _briefingCache.delete(cacheKey);
        _xrayCache.delete(cacheKey);
        _attribCache.delete(cacheKey);
        res.status(200).json({ message: 'Holding removed successfully' });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) {
            return res.status(503).json({ message: 'Database unavailable. Start MongoDB and configure MONGODB_URI.' });
        }
        res.status(500).json({ message: 'Unable to delete that holding right now.' });
    }
});

app.post('/stripe/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    if (!stripe || !STRIPE_WEBHOOK_SECRET) {
        return res.status(400).send('Stripe webhook not configured');
    }
    const sig = req.headers['stripe-signature'];
    let event;
    try {
        event = stripe.webhooks.constructEvent(req.body, sig, STRIPE_WEBHOOK_SECRET);
    } catch (error) {
        console.error('Stripe webhook signature error:', error);
        return res.status(400).send('Webhook signature invalid');
    }

    const payload = event.data.object;
    if (event.type === 'checkout.session.completed') {
        try {
            const userId = payload.metadata?.userId || payload.client_reference_id;
            if (userId) {
                const user = await User.findById(userId);
                if (user) {
                    trackFunnel('stripe_checkout_completed', user._id, user.subscription && user.subscription.planName, {
                        eventName: 'stripe_checkout_completed',
                        dedupeKey: event.id ? `stripe_checkout_completed:${event.id}` : null,
                        entitlementSource: 'stripe',
                        testFlag: payload.livemode === false,
                        billingPeriod: payload.metadata?.billingInterval || null,
                        acquisitionSource: payload.metadata?.acquisitionSource || null,
                        acquisitionClickId: payload.metadata?.acquisitionClickId || null,
                        contentId: shareCopy.normalizeAcquisitionContentId(payload.metadata?.contentId)
                    });
                    await affiliateProgram.recordStripeCheckout({ payload, user })
                        .catch((error) => console.error('[affiliate] Stripe checkout attribution error:', error && error.message));
                    const subscription = payload.subscription
                        ? await stripe.subscriptions.retrieve(payload.subscription)
                        : null;
                    if (subscription) {
                        if (user.paymentRequiredAt && !user.initialPaymentAt && subscription.latest_invoice) {
                            try {
                                const initialInvoice = typeof subscription.latest_invoice === 'string'
                                    ? await stripe.invoices.retrieve(subscription.latest_invoice)
                                    : subscription.latest_invoice;
                                if (initialInvoice && initialInvoice.status === 'paid') {
                                    await recordInitialStripePayment(user, initialInvoice);
                                }
                            } catch (invoiceError) {
                                console.error('Stripe initial invoice lookup failed:', invoiceError && invoiceError.message);
                            }
                        }
                        const prevStatus = user.subscription && user.subscription.status;
                        await syncSubscriptionFromStripe(user, subscription, payload.customer);
                        const newStatus = user.subscription && user.subscription.status;
                        if (newStatus && newStatus !== 'pending' && prevStatus !== 'active' && prevStatus !== 'cancel_at_period_end') {
                            trackFunnel('subscription_started', user._id, user.subscription.planName, {
                                eventName: 'subscription_started',
                                dedupeKey: subscription.id ? `stripe:subscription-started:${subscription.id}` : null,
                                entitlementSource: 'stripe', testFlag: payload.livemode === false,
                                billingPeriod: user.subscription.billingInterval
                            });
                        }
                        // A Stripe-side trial (card-trial flow) lands as 'trialing'
                        // → trial_start; converting later fires 'paid' below. Any
                        // checkout that lands 'active' took money now (annual, the
                        // no-card→paid upgrade via /api/checkout, direct paid) → 'paid'.
                        // The prevStatus !== 'active' guard keeps it single-fire across
                        // the parallel customer.subscription.updated webhook.
                        const campaign = {
                            acquisitionSource: payload.metadata?.acquisitionSource || null,
                            acquisitionClickId: payload.metadata?.acquisitionClickId || null,
                            contentId: shareCopy.normalizeAcquisitionContentId(payload.metadata?.contentId),
                            acquisitionClickedAt: payload.metadata?.acquisitionClickedAt
                                ? new Date(payload.metadata.acquisitionClickedAt)
                                : null
                        };
                        if (newStatus === 'trialing') {
                            const trialFields = {
                                authMethod: user.googleId ? 'google' : user.facebookId ? 'facebook' : 'email',
                                selectedPlan: user.subscription.planId,
                                eventName: 'trial_started',
                                dedupeKey: subscription.id ? `stripe:trial-started:${subscription.id}` : null,
                                ...campaign
                            };
                            trackFunnel('trial_start', user._id, user.subscription.planName, trialFields);
                            notifyTrialStartedInternal(user, trialFields)
                                .catch((e) => console.error('[mailer] trial-start internal email error:', e && e.message));
                        }
                        else if (newStatus === 'active' && prevStatus !== 'active') {
                            // Keep the legacy `paid` row for existing dashboards,
                            // but leave revenue truth to invoice.paid. The
                            // explicit legacy event name prevents checkout from
                            // being counted as a second invoice.
                            trackFunnel('paid', user._id, user.subscription.planName, {
                                ...campaign,
                                eventName: 'legacy_paid',
                                dedupeKey: subscription.id ? `stripe:legacy-paid:${subscription.id}` : null
                            });
                            await recordCustomerLifecycleEvent(user, 'stripe_paid', { source: 'stripe' });
                        }
                    } else {
                        await activateSubscription(user, {
                            subscriptionId: payload.subscription,
                            customerId: payload.customer,
                            planId: payload.metadata?.planId,
                            stripeStatus: 'active',
                            stripePriceId: payload.metadata?.stripePriceId || null
                        });
                        trackFunnel('subscription_started', user._id, user.subscription.planName, {
                            eventName: 'subscription_started',
                            dedupeKey: payload.subscription ? `stripe:subscription-started:${payload.subscription}` : null,
                            entitlementSource: 'stripe', testFlag: payload.livemode === false,
                            billingPeriod: user.subscription.billingInterval
                        });
                        trackFunnel('paid', user._id, user.subscription.planName, {
                            eventName: 'legacy_paid',
                            dedupeKey: event.id ? `stripe:legacy-paid-checkout:${event.id}` : null,
                            acquisitionSource: payload.metadata?.acquisitionSource || null,
                            acquisitionClickId: payload.metadata?.acquisitionClickId || null,
                            contentId: shareCopy.normalizeAcquisitionContentId(payload.metadata?.contentId),
                            acquisitionClickedAt: payload.metadata?.acquisitionClickedAt
                                ? new Date(payload.metadata.acquisitionClickedAt)
                                : null
                        });
                        await recordCustomerLifecycleEvent(user, 'stripe_paid', { source: 'stripe' });
                    }
                }
            }
        } catch (err) {
            console.error('Stripe webhook processing error:', err);
        }
    } else if (event.type === 'invoice.paid') {
        try {
            const invoiceUser = payload.subscription
                ? await User.findOne({ stripeSubscriptionId: payload.subscription })
                : (payload.customer ? await User.findOne({ stripeCustomerId: payload.customer }) : null);
            if (invoiceUser && payload.billing_reason === 'subscription_create') {
                await recordInitialStripePayment(invoiceUser, payload);
            }
            if (invoiceUser) trackFunnel('invoice_paid', invoiceUser._id, invoiceUser.subscription && invoiceUser.subscription.planName, {
                eventName: 'invoice_paid', dedupeKey: event.id ? `stripe:invoice:${event.id}` : null,
                entitlementSource: 'stripe', testFlag: payload.livemode === false,
                billingPeriod: invoiceUser.subscription && invoiceUser.subscription.billingInterval,
                amountMinor: Number.isFinite(Number(payload.amount_paid)) ? Number(payload.amount_paid) : null,
                currency: typeof payload.currency === 'string' ? payload.currency.toLowerCase().slice(0, 8) : null
            });
            // Stripe does not guarantee ordering between invoice.paid and
            // checkout.session.completed. If the invoice arrives first, the
            // checkout webhook creates the referral order shortly afterwards.
            // Retry only that attributed-but-not-yet-created case; ordinary
            // non-referral invoices must remain a single pass.
            const recordWithRetry = async (attempt = 0) => {
                const result = await affiliateProgram.recordStripeInvoicePaid({
                    payload,
                    eventId: event.id,
                    userLookup: (id) => User.findById(id).lean()
                });
                if (result && result.recorded) {
                    trackFunnel('commission_created', null, 'Stripe', {
                        affiliateCommissionId: String(result.commissionId || ''),
                        amountMinor: result.amountMinor,
                        sequence: result.sequence
                    });
                    return;
                }
                if (result?.reason === 'no_attributed_order' && attempt < 4) {
                    const delayMs = [250, 750, 2000, 5000][attempt];
                    setTimeout(() => recordWithRetry(attempt + 1).catch((error) => {
                        console.error('[affiliate] deferred Stripe invoice attribution error:', error && error.message);
                    }), delayMs);
                }
            };
            await recordWithRetry();
        } catch (err) {
            console.error('[affiliate] Stripe invoice attribution error:', err && err.message);
        }
    } else if (event.type === 'charge.refunded' || event.type === 'refund.created') {
        try {
            const refundUser = payload.customer ? await User.findOne({ stripeCustomerId: payload.customer }) : null;
            if (refundUser) trackFunnel('payment_refunded', refundUser._id, refundUser.subscription && refundUser.subscription.planName, {
                eventName: 'payment_refunded', dedupeKey: event.id ? `stripe:refund:${event.id}` : null,
                entitlementSource: 'stripe', testFlag: payload.livemode === false,
                amountMinor: Number.isFinite(Number(payload.amount_refunded)) ? Number(payload.amount_refunded)
                    : Number.isFinite(Number(payload.amount)) ? Number(payload.amount) : null,
                currency: typeof payload.currency === 'string' ? payload.currency.toLowerCase().slice(0, 8) : null
            });
            const result = await affiliateProgram.reverseStripeCommission({ payload, reason: 'refund' });
            if (result && result.reversed) trackFunnel('commission_reversed', null, 'Stripe', { reason: 'refund' });
        } catch (err) {
            console.error('[affiliate] Stripe refund attribution error:', err && err.message);
        }
    } else if (event.type === 'charge.dispute.created') {
        try {
            const result = await affiliateProgram.reverseStripeCommission({ payload, reason: 'dispute' });
            if (result && result.reversed) trackFunnel('commission_reversed', null, 'Stripe', { reason: 'dispute' });
        } catch (err) {
            console.error('[affiliate] Stripe dispute attribution error:', err && err.message);
        }
    } else if (event.type === 'customer.subscription.updated') {
        try {
            const subscription = payload;
            const user = await User.findOne({ stripeSubscriptionId: subscription.id });
            if (user) {
                const prevStatus = user.subscription && user.subscription.status;
                await syncSubscriptionFromStripe(user, subscription, subscription.customer);
                const newStatus = user.subscription && user.subscription.status;
                if (subscription.cancel_at_period_end) trackFunnel('subscription_cancel_scheduled', user._id, user.subscription.planName, {
                    eventName: 'subscription_cancel_scheduled', dedupeKey: event.id ? `stripe:cancel-scheduled:${event.id}` : null,
                    entitlementSource: 'stripe', testFlag: subscription.livemode === false
                });
                // trialing → active = first real payment
                if (prevStatus === 'trialing' && newStatus === 'active') {
                    trackFunnel('paid', user._id, user.subscription.planName, {
                        eventName: 'legacy_paid',
                        dedupeKey: event.id ? `stripe:legacy-paid-update:${event.id}` : null,
                        acquisitionSource: subscription.metadata?.acquisitionSource || null,
                        acquisitionClickId: subscription.metadata?.acquisitionClickId || null,
                        contentId: shareCopy.normalizeAcquisitionContentId(subscription.metadata?.contentId),
                        acquisitionClickedAt: subscription.metadata?.acquisitionClickedAt
                            ? new Date(subscription.metadata.acquisitionClickedAt)
                            : null
                    });
                    await recordCustomerLifecycleEvent(user, 'stripe_paid', { source: 'stripe' });
                }
            }
        } catch (err) {
            console.error('Stripe webhook update error:', err);
        }
    } else if (event.type === 'customer.subscription.deleted') {
        try {
            const subscription = payload;
            const user = await User.findOne({ stripeSubscriptionId: subscription.id });
            if (user) {
                const plan = user.subscription && user.subscription.planName;
                user.subscription.status = 'cancelled';
                user.subscription.trialEndsAt = null;
                user.stripeSubscriptionId = null;
                await user.save();
                trackFunnel('cancel', user._id, plan);
            }
        } catch (err) {
            console.error('Stripe webhook delete error:', err);
        }
    }

    res.status(200).send({ received: true });
});

// ============================================================
// AppSumo Licensing API v2 — lifetime-deal redemption.
//   POST /appsumo/webhook       — license lifecycle events (HMAC-signed)
//   GET  /appsumo/redeem        — OAuth redirect: code -> license, then the
//                                 account-link / activation page
//   POST /api/appsumo/activate  — link a verified license to the signed-in user
// Grants the existing 'pro' tier with no Stripe sub and no expiry; the per-tier
// AI cap (30/100/300) bounds the Ask quota so a one-time payment can't run away.
// Docs: https://docs.licensing.appsumo.com/
// ============================================================
const crypto = require('crypto');

// Constant-time string compare for secrets (admin token, signatures) so an
// attacker can't recover the value byte-by-byte via response-timing analysis.
function timingSafeStrEqual(a, b) {
    const bufA = Buffer.from(String(a ?? ''));
    const bufB = Buffer.from(String(b ?? ''));
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

const AppSumoLicenseSchema = new mongoose.Schema({
    licenseKey: { type: String, unique: true, index: true },
    prevLicenseKey: { type: String, default: null },
    parentLicenseKey: { type: String, default: null },
    status: { type: String, default: 'inactive' }, // inactive | active | deactivated
    tier: { type: Number, default: 1 },
    partnerPlanName: { type: String, default: null },
    changePlanUrl: { type: String, default: null }, // AppSumo per-license upgrade/downgrade link
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    redeemedAt: { type: Date, default: null },
    lastEvent: { type: String, default: null },
    lastEventAt: { type: Date, default: null },
    raw: { type: Object, default: null }
}, { timestamps: true });
const AppSumoLicense = mongoose.model('AppSumoLicense', AppSumoLicenseSchema);

// AppSumo tier -> Pro grant + monthly Ask cap. Mirrors the listing pricing
// ($39/$79/$149 = Tier 1/2/3). Unknown tiers default to the top tier so a paying
// customer is never under-served; the cap still bounds cost.
const APPSUMO_TIER_CONFIG = {
    1: { planName: 'Pro — AppSumo (Starter)',  askCap: 30 },
    2: { planName: 'Pro — AppSumo (Investor)', askCap: 100 },
    3: { planName: 'Pro — AppSumo (Pro)',      askCap: 300 }
};
function appsumoTierConfig(tier) {
    return APPSUMO_TIER_CONFIG[Number(tier)] || APPSUMO_TIER_CONFIG[3];
}

// Effective monthly Ask limit: AppSumo redeemers are capped at their tier's quota
// (never above the Pro quota); everyone else uses the normal tier limit. Guarded
// on appsumoAiCap, so it is a no-op for every non-AppSumo user.
function effectiveAskLimit(req) {
    const base = aiChat.limits(req.tier);
    const cap = req.user && (req.user.appsumoAiCap || req.user.dealMirrorAiCap);
    return (Number.isFinite(cap) && cap > 0) ? Math.min(cap, base) : base;
}

function isActiveStripeSubscriber(user) {
    const sub = user && user.subscription || {};
    const active = ['active', 'trialing', 'cancel_at_period_end'].includes(String(sub.status || ''));
    const professionalPlan = ['firm', 'enterprise', 'power', 'power-monthly', 'desk'].includes(String(sub.planId || '').toLowerCase());
    return Boolean(active && (user && (user.stripeCustomerId || user.stripeSubscriptionId) || professionalPlan));
}

async function grantDealMirrorAccess(user, licence) {
    const details = dealMirror.TIERS[licence.tier];
    if (!details) throw new Error('Unknown DealMirror tier');
    // This guard makes the central grant fail closed as well as the route.
    if (user.appsumoRedeemedAt || isActiveStripeSubscriber(user)) throw new Error('Existing entitlement cannot be replaced');
    const now = new Date();
    applyPlanToSubscription(user, PRO_PLAN_ID);
    user.subscription.planName = `Pro — DealMirror (${licence.tier[0].toUpperCase()}${licence.tier.slice(1)})`;
    user.subscription.price = 0; user.subscription.stripePriceId = null; user.subscription.status = 'active';
    user.subscription.activatedAt = user.subscription.activatedAt || now; user.subscription.renewedAt = now;
    user.subscription.lastPaymentAt = now; user.subscription.trialEndsAt = null;
    user.dealMirrorLicenceId = licence._id; user.dealMirrorTier = details.tier; user.dealMirrorAiCap = details.askCap;
    user.dealMirrorRedeemedAt = user.dealMirrorRedeemedAt || now; user.markModified('subscription');
    await user.save();
    trackFunnel('dealmirror_redemption', user._id, user.subscription.planName, { eventName: 'dealmirror_redemption', entitlementSource: 'dealmirror', dealMirrorTier: details.tier, dedupeKey: `dealmirror:redemption:${String(licence._id)}` });
}

async function revokeDealMirrorAccess(user) {
    // Never downgrade a legitimate AppSumo or Stripe/professional entitlement.
    if (user.appsumoRedeemedAt || isActiveStripeSubscriber(user)) return;
    user.dealMirrorLicenceId = null; user.dealMirrorTier = null; user.dealMirrorAiCap = null; user.dealMirrorRedeemedAt = null;
    user.subscription.status = 'cancelled'; user.subscription.trialEndsAt = null; user.markModified('subscription');
    await user.save();
}

async function grantAppSumoProAccess(user, { licenseKey, tier, acquisition, requestFields, discoverySource } = {}) {
    const cfg = appsumoTierConfig(tier);
    const now = new Date();
    const firstRedemption = !user.appsumoRedeemedAt;
    const licenseFingerprint = licenseKey
        ? crypto.createHash('sha256').update(String(licenseKey)).digest('hex').slice(0, 20)
        : 'unknown';
    if (firstRedemption) trackFunnel('appsumo_redemption_started', user._id, cfg.planName, {
        eventName: 'appsumo_redemption_started',
        dedupeKey: `appsumo:redemption-started:${String(user._id)}:${licenseFingerprint}`,
        entitlementSource: 'appsumo', appsumoTier: Number(tier) || null,
        ...(requestFields || {})
    });
    applyPlanToSubscription(user, PRO_PLAN_ID); // reuse the Pro plan ladder
    user.subscription.planName = cfg.planName;
    user.subscription.price = 0;                 // already paid on AppSumo
    user.subscription.stripePriceId = null;
    user.subscription.status = 'active';         // active + planId 'pro' => 'pro' tier
    user.subscription.activatedAt = user.subscription.activatedAt || now;
    user.subscription.renewedAt = now;
    user.subscription.lastPaymentAt = now;
    user.subscription.trialStartedAt = user.subscription.trialStartedAt || now;
    user.subscription.trialEndsAt = null;        // lifetime — never expires
    user.stripeSubscriptionId = null;            // not a Stripe subscription
    user.appsumoLicenseKey = licenseKey || user.appsumoLicenseKey || null;
    user.appsumoTier = Number(tier) || user.appsumoTier || null;
    user.appsumoAiCap = cfg.askCap;
    const normalizedDiscoverySource = normalizeAppSumoDiscoverySource(discoverySource || user.discoverySource);
    if (normalizedDiscoverySource) user.discoverySource = normalizedDiscoverySource;
    user.appsumoRedeemedAt = user.appsumoRedeemedAt || now;
    user.markModified('subscription');
    await user.save();
    if (firstRedemption) {
        await recordCustomerLifecycleEvent(user, 'appsumo_redeemed', {
            source: 'appsumo',
            appsumoTier: Number(tier) || null,
            discoverySource: normalizedDiscoverySource
        });
        scheduleAppSumoReviewRequest(user, { licenseKey, tier })
            .catch((e) => console.error('[appsumo] review schedule error:', e && e.message));
        scheduleAppSumoOnboarding(user, { tier })
            .catch((e) => console.error('[appsumo] onboarding schedule error:', e && e.message));
    }
    trackFunnel('paid', user._id, cfg.planName, {
        // The legacy `paid` event remains for existing dashboards. Its
        // canonical name is explicit so an AppSumo redemption cannot be
        // mistaken for a Stripe invoice, and the key makes webhook retries
        // idempotent.
        eventName: firstRedemption ? 'appsumo_redemption_completed' : 'legacy_paid',
        dedupeKey: `appsumo:redemption-completed:${String(user._id)}:${licenseFingerprint}`,
        source: 'appsumo',
        appsumoLicenseKey: licenseKey || null,
        appsumoTier: Number(tier) || null,
        acquisitionSource: acquisition ? acquisition.source : null,
        acquisitionClickId: acquisition ? acquisition.clickId : null,
        contentId: acquisition ? acquisition.contentId : null,
        acquisitionClickedAt: acquisition ? acquisition.clickedAt : null,
        discoverySource: normalizedDiscoverySource,
        ...(requestFields || {})
    });
    if (firstRedemption) trackFunnel('appsumo_activation', user._id, cfg.planName, {
        eventName: 'appsumo_activation',
        dedupeKey: `appsumo:activation:${String(user._id)}:${licenseFingerprint}`,
        entitlementSource: 'appsumo', source: 'appsumo',
        appsumoTier: Number(tier) || null,
        acquisitionSource: acquisition ? acquisition.source : null,
        acquisitionClickId: acquisition ? acquisition.clickId : null,
        contentId: acquisition ? acquisition.contentId : null,
        ...(requestFields || {})
    });
}

async function revokeAppSumoAccess(user) {
    user.subscription.status = 'cancelled';
    user.subscription.trialEndsAt = null;
    user.appsumoAiCap = null;
    user.markModified('subscription');
    await user.save().catch(() => {});
    trackFunnel('cancel', user._id, 'Pro — AppSumo', {
        eventName: 'subscription_canceled', entitlementSource: 'appsumo', source: 'appsumo'
    });
}

// HMAC-SHA256 of (timestamp + raw body) keyed by the AppSumo API key. Fails
// closed: without APPSUMO_API_KEY configured we cannot verify, so real events
// are rejected. Portal URL validation uses unsigned `test` events, which the
// webhook short-circuits before this check (see the isTest branch below), so
// the portal can still validate the endpoint without the key present.
function appsumoVerifySignature(rawBody, signature, timestamp) {
    if (!APPSUMO_API_KEY) return false;
    if (!signature || !timestamp) return false;
    try {
        const expected = crypto.createHmac('sha256', APPSUMO_API_KEY)
            .update(String(timestamp) + rawBody.toString('utf8')).digest('hex');
        const a = Buffer.from(expected);
        const b = Buffer.from(String(signature));
        return a.length === b.length && crypto.timingSafeEqual(a, b);
    } catch (_) { return false; }
}

async function appsumoHandleEvent(body) {
    const event = body.event;
    const licenseKey = body.license_key;
    const prevKey = body.prev_license_key;
    const tier = Number(body.tier) || 1;
    if (!licenseKey) return;
    const now = new Date();
    const changePlanUrl = body.license_change_plan_url || body.change_plan_url || null;

    if (event === 'purchase' || event === 'activate') {
        const lic = await AppSumoLicense.findOneAndUpdate(
            { licenseKey },
            { $set: {
                licenseKey,
                status: event === 'activate' ? 'active' : 'inactive',
                tier,
                parentLicenseKey: body.parent_license_key || null,
                partnerPlanName: body.partner_plan_name || null,
                ...(changePlanUrl ? { changePlanUrl } : {}),
                lastEvent: event, lastEventAt: now, raw: body
            } },
            { upsert: true, new: true }
        );
        if (lic && lic.userId) {
            const user = await User.findById(lic.userId);
            if (user) await grantAppSumoProAccess(user, { licenseKey, tier: lic.tier });
        }
        if (event === 'purchase') {
            trackFunnel('appsumo_purchase', null, 'Pro — AppSumo', {
                source: 'appsumo',
                appsumoTier: tier,
                appsumoStatus: 'inactive'
            });
        }
    } else if (event === 'upgrade' || event === 'downgrade') {
        let lic = await AppSumoLicense.findOne({ licenseKey: prevKey });
        if (lic) {
            lic.prevLicenseKey = prevKey;
            lic.licenseKey = licenseKey;
            lic.tier = tier;
            lic.status = 'active';
            if (changePlanUrl) lic.changePlanUrl = changePlanUrl;
            lic.lastEvent = event; lic.lastEventAt = now; lic.raw = body;
            await lic.save().catch(() => {});
        } else {
            lic = await AppSumoLicense.findOneAndUpdate(
                { licenseKey },
                { $set: { licenseKey, prevLicenseKey: prevKey || null, tier, status: 'active', ...(changePlanUrl ? { changePlanUrl } : {}), lastEvent: event, lastEventAt: now, raw: body } },
                { upsert: true, new: true }
            );
        }
        if (lic && lic.userId) {
            const user = await User.findById(lic.userId);
            if (user) {
                user.appsumoLicenseKey = licenseKey;
                await grantAppSumoProAccess(user, { licenseKey, tier });
            }
        }
    } else if (event === 'deactivate') {
        const lic = await AppSumoLicense.findOne({ licenseKey });
        if (lic) {
            lic.status = 'deactivated'; lic.lastEvent = event; lic.lastEventAt = now;
            await lic.save().catch(() => {});
            affiliateProgram.reverseAppSumoCommission({ licenseKey, reason: 'AppSumo deactivated/refunded' })
                .catch((error) => console.error('[affiliate] AppSumo reversal error:', error && error.message));
            // Only revoke if this is the user's CURRENT key — an upgrade fires a
            // simultaneous deactivate on the OLD key, which must not revoke access.
            if (lic.userId) {
                const user = await User.findById(lic.userId);
                if (user && user.appsumoLicenseKey === licenseKey) await revokeAppSumoAccess(user);
            }
        }
    } else if (event === 'migrate') {
        await AppSumoLicense.findOneAndUpdate(
            { licenseKey },
            { $set: { parentLicenseKey: body.parent_license_key || null, tier, lastEvent: 'migrate', lastEventAt: now } },
            { upsert: true }
        );
    }
}

// Webhook — raw body for HMAC. Always 200 + { event, success } per the spec; on
// 'activate'/'deactivate' AppSumo applies the status change only after success.
app.post('/appsumo/webhook', express.raw({ type: '*/*' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.from('');
    let body = {};
    try {
        const text = raw.toString('utf8');
        body = text.trim().startsWith('{') ? JSON.parse(text) : Object.fromEntries(new URLSearchParams(text));
    } catch (_) { body = {}; }
    const event = body.event || 'unknown';
    const isTest = body.test === true || body.test === 'true' || event === 'test';
    // Test/validation events: confirm 200 + success, never touch real data.
    if (isTest) return res.status(200).json({ event, success: true });
    if (!appsumoVerifySignature(raw, req.headers['x-appsumo-signature'], req.headers['x-appsumo-timestamp'])) {
        return res.status(401).json({ event, success: false, message: 'signature verification failed' });
    }
    try {
        await appsumoHandleEvent(body);
        return res.status(200).json({ event, success: true });
    } catch (err) {
        console.error('AppSumo webhook error:', err);
        return res.status(200).json({ event, success: false });
    }
});

// OAuth redirect: AppSumo sends the buyer here with ?code=. Exchange it for the
// license, then render the account-link page. No code (e.g. portal URL check) =>
// just 200 with the page so validation passes.
app.get('/appsumo/redeem', async (req, res) => {
    const code = String(req.query.code || '').trim();
    if (!code) return res.status(200).send(appsumoRedeemPage({ error: '', rt: '', status: '' }));
    if (!APPSUMO_CLIENT_ID || !APPSUMO_CLIENT_SECRET) {
        return res.status(200).send(appsumoRedeemPage({ error: 'AppSumo redemption is not finished setting up yet. Please contact support@stockportfolio.pro.', rt: '', status: '' }));
    }
    try {
        const tokenResp = await axios.post('https://appsumo.com/openid/token/',
            new URLSearchParams({
                client_id: APPSUMO_CLIENT_ID,
                client_secret: APPSUMO_CLIENT_SECRET,
                redirect_uri: APPSUMO_REDIRECT_URI,
                code,
                grant_type: 'authorization_code'
            }).toString(),
            { headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 15000, validateStatus: () => true }
        );
        const accessToken = tokenResp.data && tokenResp.data.access_token;
        if (!accessToken) {
            return res.status(200).send(appsumoRedeemPage({ error: 'We could not verify your AppSumo purchase — the activation link may have expired. Restart activation from AppSumo.', rt: '', status: '' }));
        }
        const licResp = await axios.get('https://appsumo.com/openid/license_key/', {
            params: { access_token: accessToken }, timeout: 15000, validateStatus: () => true
        });
        const licenseKey = licResp.data && licResp.data.license_key;
        const status = (licResp.data && licResp.data.status) || '';
        if (!licenseKey) {
            return res.status(200).send(appsumoRedeemPage({ error: 'No AppSumo license was found for this account.', rt: '', status: '' }));
        }
        if (status === 'deactivated') {
            return res.status(200).send(appsumoRedeemPage({ error: 'This AppSumo license has been deactivated (refunded or cancelled).', rt: '', status }));
        }
        const known = await AppSumoLicense.findOne({ licenseKey });
        const tier = known ? known.tier : 1;
        const rt = jwt.sign({ asLicenseKey: licenseKey, asTier: tier, asRedeem: true }, JWT_SECRET, { expiresIn: '30m' });
        return res.status(200).send(appsumoRedeemPage({ error: '', rt, status }));
    } catch (err) {
        console.error('AppSumo redeem error:', err && err.message);
        return res.status(200).send(appsumoRedeemPage({ error: 'Something went wrong verifying your purchase. Please try again, or contact support@stockportfolio.pro.', rt: '', status: '' }));
    }
});

// Link a verified license to the signed-in user and grant lifetime Pro.
app.post('/api/appsumo/activate', authMiddleware, async (req, res) => {
    try {
        const rt = String((req.body && req.body.rt) || '');
        const discoverySource = normalizeAppSumoDiscoverySource(req.body && req.body.discoverySource);
        let payload;
        try { payload = jwt.verify(rt, JWT_SECRET); }
        catch (_) { return res.status(400).json({ message: 'Your activation link expired. Restart activation from AppSumo to get a fresh one.' }); }
        if (!payload || !payload.asRedeem || !payload.asLicenseKey) {
            return res.status(400).json({ message: 'Invalid activation token.' });
        }
        const licenseKey = payload.asLicenseKey;
        const tier = Number(payload.asTier) || 1;
        let lic = await AppSumoLicense.findOne({ licenseKey });
        if (!lic) lic = await AppSumoLicense.create({ licenseKey, tier, status: 'active' });
        if (lic.status === 'deactivated') {
            return res.status(400).json({ message: 'This AppSumo license has been deactivated.' });
        }
        if (lic.userId && String(lic.userId) !== String(req.user._id)) {
            return res.status(409).json({ message: 'This AppSumo license is already linked to a different account.' });
        }
        lic.userId = req.user._id;
        lic.status = 'active';
        lic.redeemedAt = lic.redeemedAt || new Date();
        await lic.save();
        const existingCustomerBeforeActivation = Boolean(
            req.user.appsumoRedeemedAt || req.user.stripeCustomerId || req.user.stripeSubscriptionId
        );
        const acquisition = shareCopy.parseAcquisitionCookieHeader(req.headers.cookie, { secret: JWT_SECRET });
        await grantAppSumoProAccess(req.user, {
            licenseKey,
            tier: lic.tier || tier,
            acquisition,
            requestFields: trackingRequestFields(req, res),
            discoverySource
        });
        await affiliateProgram.recordAppSumoActivation({
            user: req.user,
            referral: affiliateProgram.referralFromRequest(req),
            licenseKey,
            tier: lic.tier || tier,
            track: trackFunnel,
            existingCustomer: existingCustomerBeforeActivation
        });
        return res.json({ ok: true, message: 'Your AppSumo lifetime Pro is active.', subscription: normalizeSubscription(req.user.subscription) });
    } catch (err) {
        console.error('AppSumo activate error:', err);
        return res.status(500).json({ message: 'Activation failed. Please try again.' });
    }
});

// DealMirror LTD pilot -------------------------------------------------------
// Public copy is available for review, but redemption stays fail-closed until
// the explicit production flag and commercial approval gates are satisfied.
app.get('/dealmirror/redeem', (req, res) => res.sendFile(path.join(__dirname, '../frontend-v2/dealmirror-redeem.html')));
app.post('/api/dealmirror/redeem', authMiddleware, dealMirrorRedeemLimiter, async (req, res) => {
    const code = String(req.body && req.body.code || '');
    if (code.length < 12 || code.length > 160) return res.status(400).json({ message: 'This code cannot be redeemed. Please check the code and contact support if you need help.' });
    try {
        const result = await dealMirror.redeem({
            code, user: req.user, hasAppSumo: Boolean(req.user.appsumoRedeemedAt), hasStripe: isActiveStripeSubscriber(req.user),
            actor: String(req.user._id), grant: (licence) => grantDealMirrorAccess(req.user, licence)
        });
        return res.status(result.status || 200).json(result.ok ? { ok: true, message: 'Your DealMirror lifetime access is active.' } : { message: result.message });
    } catch (error) {
        console.error('[dealmirror] redemption failed:', error && error.message);
        return res.status(500).json({ message: 'Redemption could not be completed. Please contact support if the problem continues.' });
    }
});

function dealMirrorAdminAuth(req, res, next) {
    const token = process.env.ADMIN_TOKEN;
    if (!token || !timingSafeStrEqual(req.headers['x-admin-token'], token)) return res.status(403).json({ message: 'Forbidden' });
    return next();
}
app.get('/api/admin/dealmirror', dealMirrorAdminAuth, async (req, res) => {
    try {
        const { DealMirrorBatch, DealMirrorLicence } = dealMirror.models();
        const [batches, totals] = await Promise.all([DealMirrorBatch.find({}).sort({ batchNumber: 1 }).lean(), DealMirrorLicence.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }])]);
        const counts = Object.fromEntries(totals.map((r) => [r._id, r.count]));
        res.set('Cache-Control', 'no-store').json({ config: { ...dealMirror.config(), pepperPresent: undefined }, batches, counts, issued: Object.values(counts).reduce((n, v) => n + v, 0), remainingAbsoluteInventory: Math.max(0, dealMirror.ABSOLUTE_CAP - Object.values(counts).reduce((n, v) => n + v, 0)) });
    } catch (error) { res.status(503).json({ message: 'DealMirror administration is unavailable.' }); }
});
app.post('/api/admin/dealmirror/expire', dealMirrorAdminAuth, async (req, res) => {
    try { const expired = await dealMirror.expireAvailable({ actor: String(req.headers['x-admin-actor'] || 'admin') }); res.json({ ok: true, expired }); }
    catch (_) { res.status(503).json({ message: 'DealMirror expiry sweep is unavailable.' }); }
});
app.post('/api/admin/dealmirror/reconcile', dealMirrorAdminAuth, async (req, res) => {
    try {
        const dryRun = req.body && req.body.dryRun !== false;
        const result = await dealMirror.reconcileCsv({ csv: req.body && req.body.csv, mapping: req.body && req.body.mapping, dryRun, actor: String(req.headers['x-admin-actor'] || 'admin') });
        if (!dryRun && result.refundedLicenceIds && result.refundedLicenceIds.length) {
            const { DealMirrorLicence } = dealMirror.models();
            const licences = await DealMirrorLicence.find({ _id: { $in: result.refundedLicenceIds } });
            for (const licence of licences) { const user = licence.userId && await User.findById(licence.userId); if (user) await revokeDealMirrorAccess(user); }
        }
        return res.json(result);
    } catch (error) { return res.status(400).json({ message: error.message || 'DealMirror reconciliation failed.' }); }
});
app.post('/api/admin/dealmirror/:id/revoke', dealMirrorAdminAuth, async (req, res) => {
    const reason = String(req.body && req.body.reason || '').trim().slice(0, 500);
    if (!reason) return res.status(400).json({ message: 'A revocation reason is required.' });
    try {
        const { DealMirrorLicence } = dealMirror.models(); const licence = await DealMirrorLicence.findOneAndUpdate({ _id: req.params.id, status: 'redeemed' }, { $set: { status: 'revoked', revokedAt: new Date(), revocationReason: reason } }, { new: true });
        if (!licence) return res.status(404).json({ message: 'Active DealMirror licence not found.' });
        const user = licence.userId && await User.findById(licence.userId); if (user) await revokeDealMirrorAccess(user);
        await dealMirror.audit('revoked', String(req.headers['x-admin-actor'] || 'admin'), { batchId: licence.batchId, licenceId: licence._id, reason });
        return res.json({ ok: true });
    } catch (_) { return res.status(503).json({ message: 'DealMirror revocation is unavailable.' }); }
});

// Self-contained activation page (no build step). Authenticates against
// /api/login or /api/subscribe, then POSTs the signed redemption token to
// /api/appsumo/activate. rt/error/status are injected as JSON to avoid any
// markup injection.
function appsumoRedeemPage({ error, rt, status }) {
    const data = JSON.stringify({ rt: rt || '', error: error || '', status: status || '' }).replace(/</g, '\\u003c');
    return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Activate your AppSumo Pro - StockPortfolio.pro</title>
<style>
:root{--red:#E8412E}
*{box-sizing:border-box}body{margin:0;font:16px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#f6f7f8;color:#15181c}
.wrap{max-width:440px;margin:6vh auto;padding:0 18px}
.card{background:#fff;border:1px solid #e6e8eb;border-radius:16px;padding:28px}
h1{font-size:22px;margin:14px 0 4px}p.sub{color:#5b6470;margin:0 0 18px}
label{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}
input,select{width:100%;padding:11px 12px;border:1px solid #cfd4da;border-radius:10px;font-size:15px;background:#fff}
button{width:100%;margin-top:18px;padding:12px;border:0;border-radius:10px;background:var(--red);color:#fff;font-size:15px;font-weight:700;cursor:pointer}
button.alt{background:#fff;color:#15181c;border:1px solid #cfd4da;margin-top:10px}
button[disabled]{opacity:.6;cursor:default}
.msg{margin-top:14px;padding:11px 12px;border-radius:10px;font-size:14px}
.msg.err{background:#fdecea;color:#b3261e}.msg.ok{background:#e8f5ed;color:#1a7f43}
.bull{font-size:34px}
</style></head><body><div class="wrap"><div class="card">
<div class="bull">&#128002;</div>
<h1>Activate your lifetime Pro</h1>
<p class="sub">Log in or create your StockPortfolio.pro account to attach your AppSumo purchase. It's yours for life.</p>
<div id="form">
<label for="email">Email</label><input id="email" type="email" autocomplete="email" placeholder="you@email.com">
<label for="password">Password</label><input id="password" type="password" autocomplete="current-password" placeholder="Your password">
<label for="discovery">Where did you first discover StockPortfolio.pro? <span style="font-weight:400;color:#5b6470">(optional)</span></label>
<select id="discovery"><option value="">Choose one</option><option value="appsumo">AppSumo marketplace</option><option value="x">X / Twitter</option><option value="linkedin">LinkedIn</option><option value="youtube">YouTube</option><option value="google">Google</option><option value="newsletter">Newsletter</option><option value="friend">Friend or colleague</option><option value="other">Other</option></select>
<button id="go">Log in &amp; activate</button>
<button id="alt" class="alt">Create a new account instead</button>
</div>
<div id="out"></div>
</div></div>
<script>
var DATA = ${data};
var mode = 'login';
var out = document.getElementById('out');
var go = document.getElementById('go');
var alt = document.getElementById('alt');
function show(cls, html){ out.innerHTML = '<div class="msg '+cls+'">'+html+'</div>'; }
if (DATA.error) { show('err', DATA.error); go.disabled = true; alt.disabled = true; }
else if (!DATA.rt) { show('err', 'Open this page from your AppSumo "Redeem" button to activate.'); go.disabled = true; alt.disabled = true; }
alt.onclick = function(){
  mode = (mode === 'login') ? 'signup' : 'login';
  go.textContent = (mode === 'login') ? 'Log in & activate' : 'Create account & activate';
  alt.textContent = (mode === 'login') ? 'Create a new account instead' : 'I already have an account';
};
go.onclick = async function(){
  var email = document.getElementById('email').value.trim();
  var password = document.getElementById('password').value;
  var discoverySource = document.getElementById('discovery').value;
  if (!email || !password) { show('err', 'Enter your email and password.'); return; }
  go.disabled = true; alt.disabled = true; show('', 'Working...');
  try {
    var authUrl = (mode === 'login') ? '/api/login' : '/api/subscribe';
    var authBody = (mode === 'login') ? { email: email, password: password } : { email: email, password: password, plan: 'pro', appsumoRedeemToken: DATA.rt };
    var ar = await fetch(authUrl, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(authBody) });
    var aj = await ar.json();
    if (!ar.ok || !aj.token) { show('err', (aj && aj.message) || 'Could not sign you in.'); go.disabled=false; alt.disabled=false; return; }
    var rr = await fetch('/api/appsumo/activate', { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+aj.token}, body: JSON.stringify({ rt: DATA.rt, discoverySource: discoverySource || undefined }) });
    var rj = await rr.json();
    if (!rr.ok) { show('err', (rj && rj.message) || 'Activation failed.'); go.disabled=false; alt.disabled=false; return; }
    try { localStorage.setItem('token', aj.token); } catch(e){}
    document.getElementById('form').style.display = 'none';
    show('ok', '\\u2705 ' + ((rj && rj.message) || 'Pro unlocked.') + ' <a href="/onboarding">Run your first cited result &rarr;</a>');
  } catch (e) {
    show('err', 'Network error - please try again.'); go.disabled=false; alt.disabled=false;
  }
};
</script></body></html>`;
}

// ============================================================
// DEMO MODE — read-only, no-auth public preview portfolio.
// Additive-only: serves clone HTML pages and a JSON snapshot
// from in-memory constants. Real /api/* routes are untouched.
// ============================================================
const DEMO_PORTFOLIO = [
    { _id: 'demo-aapl', symbol: 'AAPL', name: 'Apple Inc.',           sector: 'Technology',         shares: 120, purchasePrice: 148.32, purchaseDate: '2023-03-15T00:00:00.000Z' },
    { _id: 'demo-msft', symbol: 'MSFT', name: 'Microsoft Corp.',      sector: 'Technology',         shares: 65,  purchasePrice: 285.10, purchaseDate: '2023-05-22T00:00:00.000Z' },
    { _id: 'demo-tsla', symbol: 'TSLA', name: 'Tesla, Inc.',          sector: 'Consumer Cyclical',  shares: 45,  purchasePrice: 192.84, purchaseDate: '2024-01-09T00:00:00.000Z' },
    { _id: 'demo-nvda', symbol: 'NVDA', name: 'NVIDIA Corporation',   sector: 'Technology',         shares: 80,  purchasePrice: 412.55, purchaseDate: '2024-04-18T00:00:00.000Z' },
    { _id: 'demo-jpm',  symbol: 'JPM',  name: 'JPMorgan Chase & Co.', sector: 'Financial Services', shares: 50,  purchasePrice: 156.40, purchaseDate: '2023-09-04T00:00:00.000Z' }
];

// Block any state-changing verb anywhere under /api/demo
app.use('/api/demo', (req, res, next) => {
    const method = String(req.method || '').toUpperCase();
    if (method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
        return res.status(403).json({
            message: 'Editing is disabled in demo mode — sign up to manage your own portfolio.',
            code: 'DEMO_READ_ONLY'
        });
    }
    next();
});

// Demo portfolio: in-memory holdings, prices enriched live (best-effort).
app.get('/api/demo/portfolio', async (req, res) => {
    const enriched = await Promise.all(DEMO_PORTFOLIO.map(async (row) => {
        const payload = { ...row };
        try {
            payload.currentPrice = await getStockPrice(payload.symbol);
        } catch (priceError) {
            // Fall back to the seeded purchase price so the demo never looks broken.
            payload.currentPrice = payload.purchasePrice;
        }
        return payload;
    }));
    res.json(enriched);
});

// Demo passthroughs for market data — same internals as real routes,
// just no auth required. Read-only by definition.
app.get('/api/demo/alpha/time-series/daily', async (req, res) => {
    const symbol = safeUpper(req.query.symbol);
    const outputsize = (req.query.outputsize || 'compact').toString();
    if (!symbol) return res.status(400).json({ message: 'symbol is required' });
    try {
        const data = await fetchAlphaCached('TIME_SERIES_DAILY_ADJUSTED', { symbol, outputsize }, ALPHA_CACHE_TTL_MS.daily);
        res.json(data);
    } catch (error) {
        res.status(error.status || 500).json({ message: publicErrorMessage(error, 'Daily series failed') });
    }
});

app.get('/api/demo/alpha/fundamentals/:symbol', async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!symbol) return res.status(400).json({ message: 'symbol is required' });
    try {
        const historyDepth = String(req.query.historyDepth || '').toLowerCase() === 'full' ? 'full' : 'compact';
        const [quote, overview, daily, monthly, income, balance, cash] = await Promise.all([
            fetchAlphaCached('GLOBAL_QUOTE', { symbol }, ALPHA_CACHE_TTL_MS.quote),
            fetchAlphaCached('OVERVIEW', { symbol }, ALPHA_CACHE_TTL_MS.fundamentals),
            fetchAlphaCached('TIME_SERIES_DAILY_ADJUSTED', { symbol, outputsize: historyDepth }, ALPHA_CACHE_TTL_MS.daily),
            fetchAlphaCached('TIME_SERIES_MONTHLY_ADJUSTED', { symbol }, ALPHA_CACHE_TTL_MS.monthly),
            fetchAlphaCached('INCOME_STATEMENT', { symbol }, ALPHA_CACHE_TTL_MS.fundamentals),
            fetchAlphaCached('BALANCE_SHEET', { symbol }, ALPHA_CACHE_TTL_MS.fundamentals),
            fetchAlphaCached('CASH_FLOW', { symbol }, ALPHA_CACHE_TTL_MS.fundamentals)
        ]);
        const local = topCompaniesBySymbol.get(symbol);
        if (local) {
            overview.Name = overview.Name || local.name;
            overview.MarketCapitalization = overview.MarketCapitalization || (local.marketCap ? String(local.marketCap) : '');
            overview.PERatio = overview.PERatio || (local.peRatio ? String(local.peRatio) : '');
            overview.EPS = overview.EPS || (local.eps ? String(local.eps) : '');
            overview.Sector = overview.Sector || local.sector || '';
        }
        const payload = { quote, overview, daily, monthly, income, balance, cash };
        await secSource.backfillStatements(symbol, payload).catch(() => {});
        res.json(await presentFundamentalsCurrency(payload, req.query.presentationCurrency));
    } catch (error) {
        res.status(error.status || 500).json({ message: publicErrorMessage(error, 'Fundamentals load failed') });
    }
});

app.get('/api/demo/alpha/quote/:symbol', async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!symbol) return res.status(400).json({ message: 'symbol is required' });
    try {
        const data = await fetchAlphaCached('GLOBAL_QUOTE', { symbol }, ALPHA_CACHE_TTL_MS.quote);
        res.json(data);
    } catch (error) {
        res.status(error.status || 500).json({ message: publicErrorMessage(error, 'Quote load failed') });
    }
});

// Demo HTML pages — clones of dashboard/fundamentals with a banner +
// __DEMO_MODE flag set inline before the page scripts load.
app.get(/^\/demo\/?$/, (req, res) => {
    res.redirect('/dashboard.html?demo=1'); // v2 read-only demo portfolio
});

app.get(/^\/demo\/fundamentals\/?$/, (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/demo-fundamentals.html'));
});

// Pretty filenames too, in case anyone links them directly.
app.get(/^\/demo-dashboard\.html$/, (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/demo-dashboard.html'));
});
app.get(/^\/demo-fundamentals\.html$/, (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/demo-fundamentals.html'));
});

// Landing page variants
app.get(/^\/(landing-v2|v2)\/?$/, (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/landing-v2.html'));
});

// Dashboard URL is preserved for backwards compatibility but redirects
// users to the Fundamentals workspace.
app.get(/^\/dashboard\/?$/, (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend-v2/dashboard.html'));
});

// Pretty routes for static auth pages
app.get(/^\/login\/?$/, (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend-v2/login.html'));
});

app.get(/^\/register\/?$/, (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend-v2/register.html'));
});

app.get(/^\/founding\/?$/, (req, res) => {
    // Legacy founding page showed stale $118/$12 pricing — canonical funnel is v2 at /.
    res.redirect(301, '/');
});

app.get(/^\/privacy\/?$/, (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/privacy.html'));
});

app.get(/^\/terms\/?$/, (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/terms.html'));
});

// Pretty routes for the remaining static pages. These were referenced in the
// sitemap/canonicals but had no route, so they fell through to the SPA
// catch-all and served the homepage (soft 404). Serve the real page instead.
app.get(/^\/support\/?$/, (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/support.html'));
});

app.get(/^\/news\/?$/, (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/news.html'));
});

app.get(/^\/sitemap\/?$/, (req, res) => {
    res.sendFile(path.join(__dirname, '../frontend/sitemap.html'));
});

// SEO + LLM-agent discovery files.
// express.static defaults to dotfiles:'ignore', so /.well-known/* would
// otherwise fall through to the SPA catch-all below and return index.html.
// Define these explicitly so crawlers get the real file with the right MIME.
app.get('/.well-known/security.txt', (req, res) => {
    res.type('text/plain; charset=utf-8');
    res.sendFile(path.join(__dirname, '../frontend/.well-known/security.txt'));
});
app.get('/security.txt', (req, res) => {
    res.redirect(301, '/.well-known/security.txt');
});
app.get('/llms.txt', (req, res) => {
    res.type('text/plain; charset=utf-8');
    res.sendFile(path.join(__dirname, '../frontend/llms.txt'));
});
app.get('/llms-full.txt', (req, res) => {
    res.type('text/plain; charset=utf-8');
    res.sendFile(path.join(__dirname, '../frontend/llms-full.txt'));
});
app.get('/humans.txt', (req, res) => {
    res.type('text/plain; charset=utf-8');
    res.sendFile(path.join(__dirname, '../frontend/humans.txt'));
});
app.get('/robots.txt', (req, res) => {
    res.type('text/plain; charset=utf-8');
    res.sendFile(path.join(__dirname, '../frontend/robots.txt'));
});
app.get('/sitemap.xml', (req, res) => {
    res.type('application/xml; charset=utf-8');
    res.sendFile(path.join(__dirname, '../frontend/sitemap.xml'));
});

// ---- page-view beacon (first-party, anonymous session) — funnel top step ----
function trackingPageType(requestPath) {
    const pathname = String(requestPath || '').split('?')[0];
    if (/^\/compare(?:\/|$)/.test(pathname)) return 'comparison';
    if (/^\/stocks\//.test(pathname)) return 'stock';
    if (/^\/tools\//.test(pathname)) return 'tool';
    if (/^\/research\//.test(pathname)) return 'research';
    if (/^\/pricing/.test(pathname)) return 'pricing';
    return 'other';
}

function safeTrackingContext(body = {}, requestFields = {}) {
    const pagePath = growthMeasurement.sanitizePath(body.path || body.pagePath || '/');
    const pageType = String(body.pageType || trackingPageType(pagePath)).toLowerCase();
    const contentId = shareCopy.normalizeAcquisitionContentId(body.contentId);
    const ctaId = String(body.ctaId || body.cta || '').trim().slice(0, 100);
    const featureType = String(body.featureType || '').trim().toLowerCase();
    return {
        pagePath,
        pageType,
        contentId,
        campaignId: /^[A-Za-z0-9._:-]{1,120}$/.test(String(body.campaignId || '')) ? String(body.campaignId) : null,
        ctaId: /^[A-Za-z0-9._:-]+$/.test(ctaId) ? ctaId : null,
        featureType: /^[A-Za-z0-9_:-]{1,40}$/.test(featureType) ? featureType : null,
        attribution: requestFields.attribution || null
    };
}

// Canonical browser intent endpoint. Consent is explicit, context is an
// allowlist, and server-side events remain the source of truth for business
// outcomes. The older /cta_click endpoint below remains as a compatibility
// route and emits the same canonical event name.
app.post('/api/track/event', optionalAuth, (req, res) => {
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const eventName = growthMeasurement.normalizeEventName(body.event);
    if (!eventName || !growthMeasurement.BROWSER_EVENTS.has(eventName)) return res.status(204).end();
    if (body.consent !== true) return res.status(204).end();
    const requestFields = trackingRequestFields(req, res);
    if (requestFields.isBot || requestFields.isQa) return res.status(204).end();
    const context = safeTrackingContext(body, requestFields);
    const clientEventId = String(body.eventId || '').trim();
    const dedupeKey = /^[A-Za-z0-9._:-]{8,120}$/.test(clientEventId) ? `browser:${clientEventId}` : null;
    const legacyEvent = eventName === 'appsumo_outbound_clicked' ? 'appsumo_outbound' : (eventName === 'cta_clicked' ? 'cta_click' : eventName);
    trackFunnel(legacyEvent, req.user ? req.user._id : null, req.user && req.user.subscription && req.user.subscription.planName, {
        ...context,
        eventName,
        eventId: clientEventId || null,
        dedupeKey,
        ctaId: context.ctaId,
        trafficSource: requestFields.referrerSource,
        ...requestFields
    });
    return res.status(204).end();
});

app.post('/api/track/page_view', (req, res) => {
    const viewPath = String((req.body && req.body.path) || '').slice(0, 200);
    const pageContentId = shareCopy.normalizeAcquisitionContentId(req.body && req.body.contentId);
    const requestFields = trackingRequestFields(req, res);
    const utm = requestUtm(req);
    const acquisition = ensureTrackingAcquisition(req, res, requestFields, pageContentId);
    trackFunnel('page_view', null, null, {
        path: viewPath,
        utm,
        ...acquisitionFunnelFields(acquisition),
        contentId: acquisition ? (acquisition.contentId || pageContentId) : pageContentId,
        trafficSource: acquisition ? acquisition.source : requestFields.referrerSource,
        ...requestFields
    });
    res.status(204).end();
});

function freeToolId(value) {
    const id = String(value || '').trim().toLowerCase();
    return Object.values(freeTools.TOOL_DEFINITIONS).some((tool) => tool.id === id) ? id : null;
}

app.post('/api/track/free_tool_view', (req, res) => {
    const toolId = freeToolId(req.body && req.body.toolId);
    const requestFields = trackingRequestFields(req, res);
    const utm = requestUtm(req);
    const acquisition = ensureTrackingAcquisition(req, res, requestFields, toolId);
    if (toolId) trackFunnel('free_tool_view', null, null, {
        toolId, path: String(req.body.path || '').slice(0, 120),
        utm,
        ...acquisitionFunnelFields(acquisition),
        contentId: toolId,
        trafficSource: acquisition ? acquisition.source : requestFields.referrerSource,
        ...requestFields
    });
    res.status(204).end();
});

app.post('/api/track/free_tool_complete', (req, res) => {
    const toolId = freeToolId(req.body && req.body.toolId);
    const symbol = freeTools.normalizeSymbol(req.body && req.body.symbol);
    const requestFields = trackingRequestFields(req, res);
    const utm = requestUtm(req);
    const acquisition = ensureTrackingAcquisition(req, res, requestFields, toolId);
    if (toolId && symbol) trackFunnel('free_tool_complete', null, null, {
        toolId, symbol,
        utm,
        ...acquisitionFunnelFields(acquisition),
        contentId: toolId,
        trafficSource: acquisition ? acquisition.source : requestFields.referrerSource,
        ...requestFields
    });
    res.status(204).end();
});

app.post('/api/track/cta_click', (req, res) => {
    const contentId = shareCopy.normalizeAcquisitionContentId(req.body && (req.body.contentId || req.body.toolId));
    const requestFields = trackingRequestFields(req, res);
    const utm = requestUtm(req);
    const acquisition = ensureTrackingAcquisition(req, res, requestFields, contentId);
    trackFunnel('cta_click', null, null, {
        eventName: (String(req.body && req.body.target || '').toLowerCase().includes('appsumo') || String(req.body && req.body.target || '').startsWith('/go/appsumo'))
            ? 'appsumo_outbound_clicked' : 'cta_clicked',
        ctaId: String(req.body && (req.body.ctaId || req.body.cta) || '').slice(0, 100) || null,
        contentId,
        toolId: contentId && contentId.startsWith('tool-') ? contentId : null,
        path: String(req.body && req.body.path || '').slice(0, 160),
        target: String(req.body && req.body.target || '').slice(0, 160),
        utm,
        ...acquisitionFunnelFields(acquisition),
        trafficSource: acquisition ? acquisition.source : requestFields.referrerSource,
        ...requestFields
    });
    res.status(204).end();
});

// SEO activation pilot events deliberately accept page context only. The
// server derives the organic channel from the signed acquisition cookie or
// referrer; a caller cannot promote `?source=organic` into attribution.
const SEO_EVENT_NAMES = new Set(['seo_next_action_click', 'ask_landing', 'ask_first_query_submitted', 'ask_response_completed', 'source_opened']);
const SEO_PAGE_TYPES = new Set(['metric', 'comparison', 'stock', 'screen', 'research', 'tool']);
const SEO_METRICS = new Set(['eps', 'net-income', 'revenue']);
const SEO_DESTINATIONS = new Set(['ask', 'comparison', 'stock', 'screen', 'filing', 'tool']);
const SEO_CONTENT_IDS = new Set(['seo-eps-next-action', 'seo-revenue-next-action']);
function seoEventContext(body = {}) {
    const raw = body && typeof body === 'object' ? body : {};
    const contentId = shareCopy.normalizeAcquisitionContentId(raw.contentId);
    if (!SEO_CONTENT_IDS.has(contentId)) return null;
    const tickerRaw = safeUpper(raw.seoTicker || raw.ticker || raw.symbol);
    const seoTicker = isValidTicker(tickerRaw) ? tickerRaw : null;
    const metricRaw = String(raw.seoMetric || raw.metric || '').trim().toLowerCase();
    const seoMetric = SEO_METRICS.has(metricRaw) ? metricRaw : null;
    const pairRaw = String(raw.seoPair || raw.pair || '').trim().toUpperCase();
    const seoPair = /^[A-Z0-9.]{1,10}-VS-[A-Z0-9.]{1,10}$/.test(pairRaw) ? pairRaw : null;
    const pageType = String(raw.seoPageType || '').trim().toLowerCase();
    const destinationKind = String(raw.destinationKind || '').trim().toLowerCase();
    if (!SEO_PAGE_TYPES.has(pageType) || !SEO_DESTINATIONS.has(destinationKind)) return null;
    return {
        contentId, seoPageType: pageType, seoTicker, seoMetric, seoPair,
        seoQueryCluster: ['earnings/profit', 'comparison', 'revenue'].includes(String(raw.seoQueryCluster || '')) ? String(raw.seoQueryCluster) : null,
        seoExperiment: String(raw.seoExperiment || '') === 'seo-activation-pilot-v1' ? 'seo-activation-pilot-v1' : null,
        seoVariant: String(raw.seoVariant || '') === 'treatment' ? 'treatment' : null,
        destinationKind
    };
}
function trackSeoEvent(req, res, eventName) {
    const context = seoEventContext(req.body || {});
    if (!context || !SEO_EVENT_NAMES.has(eventName)) return res.status(204).end();
    const requestFields = trackingRequestFields(req, res);
    const existing = shareCopy.parseAcquisitionCookieHeader(req.headers.cookie, { secret: JWT_SECRET });
    const headerReferrer = marketingAttribution.sanitizeReferrer(req.headers.referer || req.headers.referrer);
    const headerSource = marketingAttribution.referrerSource(headerReferrer);
    // Do not let a client-provided document.referrer or URL source claim make a
    // non-organic event organic. A signed cookie may carry a prior verified
    // search touch; otherwise only the actual request header qualifies.
    const acquisition = existing || (['google', 'bing', 'duckduckgo'].includes(headerSource)
        ? ensureTrackingAcquisition(req, res, { ...requestFields, referrerSource: headerSource }, context.contentId)
        : null);
    const source = acquisition ? acquisition.source : headerSource;
    if (!['google', 'bing', 'duckduckgo'].includes(source)) return res.status(204).end();
    const eventFields = {
        ...context,
        acquisitionSource: acquisition ? acquisition.source : source,
        acquisitionClickId: acquisition ? acquisition.clickId : null,
        acquisitionClickedAt: acquisition ? acquisition.clickedAt : null,
        trafficSource: source,
        path: String(req.body && req.body.path || '').slice(0, 200),
        target: String(req.body && req.body.target || '').slice(0, 200),
        ...requestFields,
        ...(headerReferrer ? { referrer: headerReferrer, referrerSource: headerSource } : {})
    };
    trackFunnel(eventName, null, null, eventFields);
    return res.status(204).end();
}
app.post('/api/track/seo_next_action_click', (req, res) => trackSeoEvent(req, res, 'seo_next_action_click'));
app.post('/api/track/seo_event', (req, res) => {
    const eventName = String(req.body && req.body.event || '').trim();
    return trackSeoEvent(req, res, eventName);
});

// First-party activation beacon. It is authenticated, allowlisted, and
// idempotent per user/job so client retries cannot inflate conversion rates.
app.post('/api/track/activation', authMiddleware, async (req, res) => {
    const job = String(req.body && req.body.job || '').trim().toLowerCase();
    if (!ACTIVATION_JOBS.has(job)) return res.status(400).json({ message: 'Unknown activation job.' });
    const acquisition = shareCopy.parseAcquisitionCookieHeader(req.headers.cookie, { secret: JWT_SECRET });
    await trackActivation(req.userId, job, {
        plan: req.user && req.user.subscription && req.user.subscription.planName,
        acquisitionSource: acquisition ? acquisition.source : null,
        acquisitionClickId: acquisition ? acquisition.clickId : null,
        contentId: acquisition ? acquisition.contentId : null,
        ...trackingRequestFields(req, res)
    });
    return res.status(204).end();
});

// A meaningful activation requires an authenticated customer to finish a
// valid result and open its source. This endpoint is deliberately idempotent
// per user/workflow/ticker and rejects synthetic/incomplete client events.
app.post('/api/track/meaningful-activation', authMiddleware, async (req, res) => {
    const body = req.body || {};
    const workflow = String(body.workflow || '').trim().toLowerCase();
    const ticker = normalizeTicker(body.ticker || body.symbol || '');
    if (!MEANINGFUL_WORKFLOWS.has(workflow) || !isValidTicker(ticker)) {
        return res.status(400).json({ message: 'A supported workflow and ticker are required.' });
    }
    const resultValid = body.resultValid === true;
    const sourceOpened = body.sourceOpened === true;
    if (!resultValid || !sourceOpened) return res.status(400).json({ message: 'A valid result and opened source are required.' });
    const acquisition = shareCopy.parseAcquisitionCookieHeader(req.headers.cookie, { secret: JWT_SECRET });
    const requestFields = trackingRequestFields(req, res);
    const outcome = await meaningfulActivationFor(req.user, {
        workflow, ticker, resultValid, sourceOpened,
        contentId: shareCopy.normalizeAcquisitionContentId(body.contentId), acquisition,
        trafficCategory: requestFields.referrerSource || requestFields.trafficClass,
        requestFields
    });
    if (!outcome) return res.status(403).json({ message: 'This activation is not eligible for campaign reporting.' });
    return res.json({ ok: true, meaningfulActivation: true, reviewEligible: outcome.reviewEligible, count: outcome.count });
});

app.get('/api/customer-success/status', authMiddleware, async (req, res) => {
    res.set('Cache-Control', 'no-store').json({
        status: req.user.customerSuccessStatus || null,
        recordedAt: req.user.customerSuccessAt || null,
        reviewEligible: Boolean(req.user.reviewEligibleAt)
    });
});

app.post('/api/track/customer-success', authMiddleware, async (req, res) => {
    const status = String(req.body && req.body.status || '').trim().toLowerCase();
    if (!['yes', 'somewhat', 'not_yet'].includes(status)) return res.status(400).json({ message: 'Choose yes, somewhat, or not_yet.' });
    const text = cleanShort(req.body && req.body.text, 1000);
    const now = new Date();
    await User.updateOne({ _id: req.userId }, { $set: { customerSuccessStatus: status, customerSuccessText: text, customerSuccessAt: now } });
    trackFunnel('customer_success', req.userId, req.user.subscription && req.user.subscription.planName, {
        eventName: 'support_outcome_confirmed', campaignId: augustCampaign.config().campaignId,
        successStatus: status, outcomeRecorded: true,
        dedupeKey: `support-outcome:${String(req.userId)}:${now.toISOString().slice(0, 10)}`
    });
    return res.json({ ok: true, status, recordedAt: now.toISOString() });
});

app.post('/api/review/prompt', authMiddleware, async (req, res) => {
    const action = String(req.body && req.body.action || '').trim().toLowerCase();
    if (!['shown', 'clicked', 'dismissed'].includes(action)) return res.status(400).json({ message: 'Unknown review action.' });
    const field = { shown: 'reviewPromptShownAt', clicked: 'reviewClickedAt', dismissed: 'reviewDismissedAt' }[action];
    await User.updateOne({ _id: req.userId }, { $set: { [field]: new Date() } });
    trackFunnel(`review_${action}`, req.userId, req.user.subscription && req.user.subscription.planName, { campaignId: augustCampaign.config().campaignId });
    return res.json({ ok: true });
});

// ---- /api/admin/comp — grant complimentary access to a reviewer ----
// Token-gated (ADMIN_TOKEN, same as /admin/funnel). The user must already have
// an account (so they set their own password). Modelled as a manual 'trialing'
// sub that AUTO-EXPIRES via the guard in ensureSubscriptionShape — no Stripe,
// no cron. Re-POST to extend. Example:
//   curl -X POST https://www.stockportfolio.pro/api/admin/comp \
//     -H "x-admin-token: $ADMIN_TOKEN" -H 'content-type: application/json' \
//     -d '{"email":"mav@example.com","days":7,"plan":"desk"}'
app.post('/api/admin/comp', async (req, res) => {
    const token = process.env.ADMIN_TOKEN;
    const provided = req.headers['x-admin-token'];
    if (!token || !timingSafeStrEqual(provided, token)) return res.status(403).json({ message: 'Forbidden' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const days = Math.min(90, Math.max(1, parseInt(req.body?.days, 10) || 7));
    const plan = ['desk', 'power'].includes(String(req.body?.plan || '').toLowerCase())
        ? String(req.body.plan).toLowerCase() : 'desk';
    if (!email) return res.status(400).json({ message: 'email is required' });
    try {
        const user = await User.findOne({ email });
        if (!user) return res.status(404).json({ message: `No account for ${email}. Ask them to register first, then retry.` });
        const now = new Date();
        const endsAt = new Date(now.getTime() + days * 86400000);
        const pc = getPlanConfig(plan);
        user.subscription.planId = pc.planId;
        user.subscription.planName = pc.planName;
        user.subscription.price = pc.price;
        user.subscription.currency = pc.currency;
        user.subscription.billingInterval = pc.billingInterval;
        user.subscription.stripePriceId = null; // a comp, not a Stripe price
        user.subscription.status = 'trialing';
        user.subscription.trialStartedAt = now;
        user.subscription.trialEndsAt = endsAt;
        user.subscription.activatedAt = now;
        user.markModified('subscription');
        await user.save();
        res.json({ ok: true, email, plan, status: 'trialing', expiresAt: endsAt.toISOString() });
    } catch (err) {
        console.error('[admin/comp] error:', err.message);
        res.status(500).json({ message: 'Failed to grant complimentary access' });
    }
});

// ---- /admin/funnel — private funnel dashboard (token-gated) ----
// Protect with ADMIN_TOKEN env var; if not set the route returns 403.
app.get('/admin/funnel', async (req, res) => {
    const token = process.env.ADMIN_TOKEN;
    const provided = req.headers['x-admin-token'];
    if (!token || !timingSafeStrEqual(provided, token)) return res.status(403).send('Forbidden');
    try {
        const expiry = await expireNoCardTrials();
        const col = mongoose.connection.collection('funnel_events');
        // aggregate in Mongo — page_view volume makes a full toArray() untenable
        const groups = await col.aggregate([
            { $group: { _id: { event: '$event', plan: '$plan' }, n: { $sum: 1 } } }
        ]).toArray();
        const count = (ev) => groups.filter((g) => g._id.event === ev).reduce((s, g) => s + g.n, 0);
        const pct = (n, d) => d ? `${((n / d) * 100).toFixed(1)}%` : '—';
        const pageViews = count('page_view');
        const signups = count('signup');
        const freeSignups = groups.filter((g) => g._id.event === 'signup' && g._id.plan === 'Free').reduce((s, g) => s + g.n, 0);
        const trials = count('trial_start');
        const paid = count('paid');
        const cancels = count('cancel');
        // Per-plan breakdown (page views carry no plan — excluded)
        const byPlan = {};
        groups.forEach((g) => {
            if (g._id.event === 'page_view') return;
            const p = g._id.plan || 'unknown';
            if (!byPlan[p]) byPlan[p] = { signup:0, trial_start:0, paid:0, cancel:0 };
            // accumulate dynamically so a future event type isn't silently dropped
            byPlan[p][g._id.event] = (byPlan[p][g._id.event] || 0) + g.n;
        });
        const planRows = Object.entries(byPlan).sort((a,b) => b[1].signup - a[1].signup)
            .map(([p, v]) => `<tr><td>${p}</td><td>${v.signup}</td><td>${v.trial_start}</td><td>${v.paid}</td><td>${v.cancel}</td></tr>`).join('');
        const recentTrialEvents = await col.find({ event: 'trial_start', userId: { $ne: null } })
            .sort({ at: -1 }).limit(100).toArray();
        const recentTrialIds = [...new Set(recentTrialEvents.map((event) => String(event.userId)).filter((id) => mongoose.Types.ObjectId.isValid(id)))];
        const trialUsers = await User.find({ _id: { $in: recentTrialIds.map((id) => new mongoose.Types.ObjectId(id)) } }, {
            email: 1, subscription: 1, stripeCustomerId: 1, stripeSubscriptionId: 1,
            googleId: 1, facebookId: 1, appsumoRedeemedAt: 1, createdAt: 1
        }).sort({ 'subscription.trialStartedAt': -1 }).limit(100).lean();
        const trialDates = (value) => value
            ? new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
            : '—';
        const trialRows = trialUsers.map((u) => {
            const channel = u.appsumoRedeemedAt ? 'AppSumo' : u.stripeCustomerId || u.stripeSubscriptionId ? 'Stripe' : 'No-card';
            const authMethod = u.googleId ? 'Google' : u.facebookId ? 'Facebook' : 'Email';
            const event = recentTrialEvents.find((item) => String(item.userId) === String(u._id));
            return `<tr><td>${escapeHtml(u.email || '')}</td><td>${authMethod}</td><td>${channel}</td><td>${escapeHtml(event && event.acquisitionSource || '—')}</td><td>${escapeHtml(effectiveTrialStatus(u))}</td><td>${trialDates(u.subscription && u.subscription.trialStartedAt)}</td><td>${trialDates(u.subscription && u.subscription.trialEndsAt)}</td><td>${u.appsumoRedeemedAt ? 'AppSumo' : '—'}</td><td>${trialDates(u.appsumoRedeemedAt)}</td></tr>`;
        }).join('');
        const total = groups.reduce((s, g) => s + g.n, 0);
        const html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>Funnel — stockportfolio.pro</title>
<style>body{font:14px/1.6 system-ui,sans-serif;margin:2rem;color:#111}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:8px 12px;text-align:left}th{background:#f5f5f5}h2{margin-top:2rem}.metric{display:inline-block;background:#f9f9f9;border:1px solid #ddd;border-radius:6px;padding:1rem 1.5rem;margin:.5rem;min-width:160px}.metric b{display:block;font-size:2rem}</style>
</head><body>
<h1>Funnel — stockportfolio.pro</h1>
<div>
  <div class="metric"><b>${pageViews}</b> Page views</div>
  <div class="metric"><b>${signups}</b> Signups (${freeSignups} free)</div>
  <div class="metric"><b>${trials}</b> Trial starts</div>
  <div class="metric"><b>${paid}</b> Paid conversions</div>
  <div class="metric"><b>${cancels}</b> Cancellations</div>
</div>
<h2>Conversion rates</h2>
<table><thead><tr><th>Step</th><th>Rate</th></tr></thead><tbody>
<tr><td>Page view → Free signup</td><td>${pct(freeSignups, pageViews)}</td></tr>
<tr><td>Signup → Trial start</td><td>${pct(trials, signups)}</td></tr>
<tr><td>Trial start → Paid</td><td>${pct(paid, trials)}</td></tr>
<tr><td>Paid → Cancelled</td><td>${pct(cancels, paid)}</td></tr>
</tbody></table>
<h2>By plan</h2>
<table><thead><tr><th>Plan</th><th>Signups</th><th>Trial starts</th><th>Paid</th><th>Cancels</th></tr></thead><tbody>${planRows}</tbody></table>
<h2>Recent trials</h2>
<p>${trialUsers.length} trial records shown (up to 100). Expired local trials corrected this request: ${expiry.modifiedCount}.</p>
<table><thead><tr><th>Email</th><th>Auth</th><th>Channel</th><th>Source</th><th>Effective status</th><th>Started (IST)</th><th>Ends (IST)</th><th>Converted via</th><th>Converted (IST)</th></tr></thead><tbody>${trialRows || '<tr><td colspan="9">No trials found</td></tr>'}</tbody></table>
<p style="color:#888;margin-top:2rem">Events total: ${total} — as of ${new Date().toISOString()}</p>
</body></html>`;
        res.set('Content-Type', 'text/html; charset=utf-8').set('Cache-Control', 'no-store').send(html);
    } catch (err) {
        res.status(500).send(`Error: ${err.message}`);
    }
});

// ----- Guru portfolio routes (13F-HR from SEC EDGAR) -----
// Tiering ladder:
//   free  — holdings table only (PUBLIC: SEO + acquisition magnet).
//   core  — + 3M-15Y performance strip, sold-out list, per-holding activity diff.
//   pro   — + AI analysis of the portfolio.
// Paid fields are stripped server-side for lower tiers and flagged so the page
// renders an upgrade teaser in their place.
function lockGuruData(data) {
    const holdings = Array.isArray(data.holdings)
        ? data.holdings.map(({ activity, shareChangePct, prevShares, ...keep }) => keep)
        : data.holdings;
    return { ...data, holdings, sells: [], performance: null, hasActivity: false, analysis: null, locked: true, analysisLocked: true };
}
// Core: keep perf + activity, no analysis (analysis is Pro). free uses lockGuruData.
function stripGuruAnalysis(data) {
    const { analysis, ...rest } = data;
    return { ...rest, analysisLocked: true };
}
// Pro: full data, but the analysis is fetched on demand (a click), never auto-sent.
function proGuruData(data) {
    const { analysis, ...rest } = data;
    return { ...rest, analysisAvailable: true };
}

app.get('/api/gurus', (req, res) => {
    res.json({ gurus: gurus.list() });
});

app.get('/api/gurus/:id', optionalAuth, async (req, res) => {
    try {
        const data = await gurus.holdings(req.params.id);
        if (!data) return res.status(404).json({ error: 'Guru not found' });
        if (req.tier === 'pro') return res.json(proGuruData(data));     // perf + activity; analysis on demand
        if (req.tier === 'core') return res.json(stripGuruAnalysis(data)); // perf + activity, no analysis
        return res.json(lockGuruData(data));                            // holdings only
    } catch (err) {
        console.error('[gurus] route error:', err.message);
        res.status(500).json({ error: 'Failed to fetch guru portfolio' });
    }
});

// On-demand AI analysis for one guru (Pro only) — generated on first request per
// filing, then cached. Pro users trigger this by clicking "Generate AI analysis".
app.get('/api/gurus/:id/analysis', authMiddleware, proGate, async (req, res) => {
    try {
        const analysis = await gurus.analysisFor(req.params.id);
        if (!analysis) return res.status(404).json({ error: 'Analysis unavailable' });
        res.json({ analysis });
    } catch (err) {
        console.error('[gurus] analysis route error:', err.message);
        res.status(500).json({ error: 'Failed to generate analysis' });
    }
});

// ---- Filing Change Monitor (Pro) — "research analyst on autopilot" ----
// What materially changed in a company's latest SEC report: verbatim narrative
// changes fused with hard year-over-year financial deltas, ranked by a
// deterministic materiality score. On-demand for any ticker; a feed across the
// user's holdings + watchlist.
app.get('/api/filings/feed', authMiddleware, monitorGate, async (req, res) => {
    try {
        const [holdings, wl] = await Promise.all([
            Stock.find({ user: req.userId, assetType: { $nin: ['etf', 'mutual_fund', 'crypto'] } }, { symbol: 1 }).lean(),
            Watchlist.findOne({ user: req.userId }, { symbols: 1 }).lean()
        ]);
        const symbols = [...holdings.map((h) => h.symbol), ...((wl && wl.symbols) || [])];
        res.json(await filingMonitor.feedFor(symbols));
    } catch (err) {
        console.error('[filings] feed error:', err.message);
        res.status(500).json({ error: 'Failed to load filing feed' });
    }
});

// Filing Monitor free trial. The "/monitor" landing is pitched as "free for 3
// stocks, no login" — so free use is capped at MONITOR_FREE_STOCKS DISTINCT
// stocks per IP per day, NOT per request. Counting by stock is what the page
// promises and means a slow first read you retry, or the client's status
// polling, never burns a credit — only a brand-new ticker does, and only once it
// returns a real report (a typo costs nothing). Power/Desk skip the cap; the
// materiality feed across a watchlist stays Power/Desk-only. A raw request flood
// is still caught by the global abuse limiter; the expensive build is de-duped
// and cached, so the 3-stock cap also bounds cost to ≤3 model passes per IP/day.
const configuredMonitorFreeStocks = Number.parseInt(process.env.MONITOR_FREE_STOCKS || '3', 10);
const MONITOR_FREE_STOCKS = Number.isFinite(configuredMonitorFreeStocks) ? Math.max(0, Math.min(10, configuredMonitorFreeStocks)) : 3;
const MonitorFreeUsage = monitorFreeUsage.createModel(mongoose);

// UTC calendar days make the allowance predictable and let MongoDB retain the
// record across deploys/restarts. Only an HMAC of the client address is stored.
function monitorFreeContext(req, now = new Date()) {
    const dayKey = now.toISOString().slice(0, 10);
    const expiresAt = new Date(`${dayKey}T00:00:00.000Z`);
    expiresAt.setUTCDate(expiresAt.getUTCDate() + 3);
    const salt = process.env.MONITOR_FREE_IP_SALT || JWT_SECRET;
    const clientHash = crypto.createHmac('sha256', salt).update(String(req.ip || 'unknown')).digest('hex');
    return { clientHash, dayKey, expiresAt };
}

function setMonitorRateHeaders(res, remaining) {
    res.setHeader('RateLimit-Limit', String(MONITOR_FREE_STOCKS));
    res.setHeader('RateLimit-Remaining', String(Math.max(0, remaining)));
}

async function monitorFreePollAccess(req, normSym) {
    const record = await monitorFreeUsage.findUsage(MonitorFreeUsage, monitorFreeContext(req));
    const symbols = Array.isArray(record && record.symbols) ? record.symbols : [];
    return { allowed: symbols.includes(normSym), remaining: Math.max(0, MONITOR_FREE_STOCKS - symbols.length) };
}

// In-flight report builds, de-duped per symbol. A cold read of a giant filing
// (e.g. Berkshire's 10-K) can take minutes — far past any proxy/browser timeout.
// So instead of holding one long request (which the client gives up on, leaving
// the user staring at a spinner), we kick the build, return fast with
// {status:'building'} if it isn't done within MONITOR_FAST_MS, and let the
// client poll (?poll=1, free) until the cached report lands. Concurrent visitors
// and the poller all share ONE build via this map — no duplicate SEC+LLM passes.
const _monitorInflight = new Map();
const _monitorProgress = new Map(); // symbol -> current build stage, for "what's happening" feedback
const MONITOR_FAST_MS = 9000;

app.get('/api/filings/:symbol/report', optionalAuth, async (req, res) => {
    try {
        const sym = String(req.params.symbol || '').toUpperCase().trim();
        if (!isValidTicker(sym)) {
            return res.status(400).json({ code: 'INVALID_TICKER', error: 'Enter a valid ticker symbol.' });
        }
        const normSym = normalizeTicker(sym); // BRK.B and BRK-B are one stock

        // Polling may only observe a build that this paid user or free client
        // is entitled to. It never starts work or consumes another stock.
        if (req.query.poll === '1') {
            if (!hasMonitor(req)) {
                if (MONITOR_FREE_STOCKS <= 0) {
                    return res.status(402).json({ code: 'MONITOR_REQUIRED', message: 'The Filing Change Monitor is available on Power and Desk plans.' });
                }
                const access = await monitorFreePollAccess(req, normSym);
                setMonitorRateHeaders(res, access.remaining);
                if (!access.allowed) {
                    return res.status(403).json({ code: 'MONITOR_POLL_NOT_AUTHORIZED', message: 'Start this report from the Monitor page before polling for it.' });
                }
            }
            if (_monitorInflight.has(sym)) return res.status(202).json({ status: 'building', symbol: sym, stage: _monitorProgress.get(sym) || null });
            const cached = await filingMonitor.peekReport(sym).catch(() => null);
            if (cached) return res.json({ report: cached });
            return res.status(202).json({ status: 'building', symbol: sym, stage: _monitorProgress.get(sym) || null });
        }

        const instrument = await assetProfile.fetchAssetProfile(sym).catch(() => null);
        if (instrument && assetProfile.isFundAsset(instrument.assetType)) {
            if (!hasMonitor(req)) {
                return res.status(402).json({
                    code: 'MONITOR_REQUIRED',
                    message: 'The Filing Change Monitor is available on Power and Desk plans.'
                });
            }
            const summary = await aiFeatures.summarizeFinancials(sym);
            return res.json({ report: {
                symbol: sym,
                name: instrument.name || sym,
                assetType: instrument.assetType,
                assetTypeLabel: instrument.assetTypeLabel,
                isFund: true,
                latestFiling: { label: `${instrument.assetTypeLabel || 'Fund'} research snapshot`, date: new Date().toISOString().slice(0, 10) },
                summary: summary.summary,
                profile: {
                    category: instrument.category || null,
                    fundFamily: instrument.fundFamily || null,
                    expenseRatio: instrument.expenseRatio,
                    yield: instrument.yield,
                    ytdReturn: instrument.ytdReturn,
                    returns: instrument.returns || {},
                    totalAssets: instrument.totalAssets,
                    topHoldings: (instrument.topHoldings || []).slice(0, 10),
                    allocations: instrument.allocations || {}
                },
                note: `This is an AI-written fund snapshot from ${instrument.source || 'fund market data'}, not a company filing-change report. Fund characteristics may be reported on different dates.`
            } });
        }
        // Free allowance: MONITOR_FREE_STOCKS DISTINCT stocks / IP / day. A stock
        // already on the visitor's list re-runs free; only a brand-new ticker
        // spends a credit. The atomic MongoDB claim bounds concurrent builds;
        // failed/invalid reports release the claim again.
        const paid = hasMonitor(req);
        let freeClaim = null;
        if (!paid) {
            if (MONITOR_FREE_STOCKS <= 0) {
                return res.status(402).json({
                    code: 'MONITOR_REQUIRED',
                    message: 'The Filing Change Monitor is available on Power and Desk plans.'
                });
            }
            try {
                freeClaim = await monitorFreeUsage.claim(MonitorFreeUsage, monitorFreeContext(req), normSym, MONITOR_FREE_STOCKS);
            } catch (error) {
                console.error('[filings] free allowance error:', error && error.message);
                return res.status(503).json({ code: 'MONITOR_FREE_UNAVAILABLE', message: 'The free Monitor allowance is temporarily unavailable. Please try again shortly.' });
            }
            setMonitorRateHeaders(res, freeClaim.remaining);
            if (!freeClaim.allowed) {
                return res.status(429).json({
                    code: 'TRIAL_EXHAUSTED',
                    message: `That's your ${MONITOR_FREE_STOCKS} free stocks for today. Sign up free to keep exploring, or upgrade to Power for unlimited filing intelligence across your whole watchlist.`
                });
            }
        }

        // Only Power/Desk may force a fresh (uncached) rebuild — otherwise a
        // trial visitor could spam ?refresh=1 to force the AI path every call.
        const force = req.query.refresh === '1' && hasMonitor(req);
        let build = (!force && _monitorInflight.get(sym)) || null;
        if (!build) {
            build = filingMonitor.buildReport(sym, { force, onStage: (stage) => _monitorProgress.set(sym, stage) })
                .catch((err) => { console.error('[filings] build error:', err && err.message); return { error: 'Couldn’t analyse that filing right now — please try again in a moment.' }; })
                .finally(() => { _monitorInflight.delete(sym); _monitorProgress.delete(sym); });
            _monitorInflight.set(sym, build);
        }
        if (freeClaim && freeClaim.claimed) {
            build.then((result) => {
                if (result && result.error) return monitorFreeUsage.release(MonitorFreeUsage, freeClaim.id, normSym);
                return null;
            }).catch(() => monitorFreeUsage.release(MonitorFreeUsage, freeClaim.id, normSym)).catch(() => {});
        }
        const winner = await Promise.race([build, new Promise((r) => setTimeout(() => r('PENDING'), MONITOR_FAST_MS))]);
        if (winner && winner.error) return res.status(404).json(winner); // typo/invalid → no credit spent
        if (winner === 'PENDING') return res.status(202).json({ status: 'building', symbol: sym, stage: _monitorProgress.get(sym) || null });
        if (req.user && winner && !winner.error) trackActivation(req.user._id, 'filing_monitor', {
            resultValid: true, sourceOpened: false, featureType: 'filing_monitor',
            requestFields: trackingRequestFields(req, res)
        });
        return res.json({ report: winner });
    } catch (err) {
        console.error('[filings] report error:', err.message);
        res.status(500).json({ error: 'Failed to build filing report' });
    }
});

// ---- Compare AI Verdict — the /compare conversion feature ----
// A grounded head-to-head: numbers computed in code, the model writes the synthesis
// (compare-verdict.js). Free trial: VERDICT_FREE_PER_DAY per IP/day for logged-out
// visitors (the aha); any signed-in user gets it unlimited. Cached reads are free.
const compareVerdict = require('./compare-verdict');
const VERDICT_FREE_PER_DAY = parseInt(process.env.VERDICT_FREE_PER_DAY || '4', 10);
const _verdictFreeSeen = new Map(); // ipKey -> { at:number, n:number }
function verdictFreeRecord(req) {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let rec = _verdictFreeSeen.get(key);
    if (!rec || now - rec.at > 24 * 60 * 60 * 1000) { rec = { at: now, n: 0 }; _verdictFreeSeen.set(key, rec); }
    if (_verdictFreeSeen.size > 50000) { const k = _verdictFreeSeen.keys().next().value; if (k !== key) _verdictFreeSeen.delete(k); }
    return rec;
}
app.get('/api/compare/:pair/verdict', optionalAuth, async (req, res) => {
    try {
        const m = String(req.params.pair || '').toUpperCase().match(/^([A-Z0-9.]+)-VS-([A-Z0-9.]+)$/);
        if (!m) return res.status(400).json({ error: 'Bad comparison.' });
        let a = m[1], b = m[2];
        if (a === b) return res.status(400).json({ error: 'Pick two different companies.' });
        if (a > b) { const t = a; a = b; b = t; } // canonical order
        const instruments = await Promise.all([a, b].map((symbol) => assetProfile.fetchAssetProfile(symbol).catch(() => null)));
        const fund = instruments.find((instrument) => instrument && assetProfile.isFundAsset(instrument.assetType));
        if (fund) {
            return res.status(422).json({
                code: 'ASSET_FEATURE_UNAVAILABLE', assetType: fund.assetType,
                message: 'This verdict compares operating-company filings. Ask can compare ETFs and mutual funds by fees, allocation, holdings, returns and risk.'
            });
        }
        const signedIn = !!req.user;
        let rec = null;
        if (!signedIn) {
            rec = verdictFreeRecord(req);
            res.setHeader('RateLimit-Limit', String(VERDICT_FREE_PER_DAY));
            if (rec.n >= VERDICT_FREE_PER_DAY) {
                res.setHeader('RateLimit-Remaining', '0');
                return res.status(429).json({
                    code: 'TRIAL_EXHAUSTED',
                    message: `That's your ${VERDICT_FREE_PER_DAY} free AI verdicts for today. Create a free account to keep comparing.`
                });
            }
        }
        const out = await compareVerdict.verdictFor(a, b, { allowAi: isProUser(req) });
        if (!out) return res.status(404).json({ error: 'We could not find filings for both companies.' });
        if (rec && !out.cached) rec.n++; // only a real generation spends a credit; cached reads are free
        if (rec) res.setHeader('RateLimit-Remaining', String(Math.max(0, VERDICT_FREE_PER_DAY - rec.n)));
        if (req.user) trackActivation(req.user._id, 'comparison');
        return res.json({ a, b, verdict: out.text, source: out.source, cached: out.cached });
    } catch (err) {
        console.error('[verdict] error:', err.message);
        return res.status(500).json({ error: 'Could not generate the verdict right now.' });
    }
});

// ---- Research Dossier (Power/Desk) — the on-demand initiation report ----
// The Monitor says "what changed in a name I follow"; the dossier answers
// "should I own this at all" — a from-scratch, source-linked write-up on ANY
// ticker. It composes several slow grounded surfaces, so (like the Monitor) we
// decouple the build and let the client poll, sharing one build across callers.
const dossier = require('./dossier');
const thesisModel = require('./thesis');
const _dossierInflight = new Map();
const _dossierProgress = new Map();
const DOSSIER_FAST_MS = 9000;

app.get('/api/dossier/:symbol', authMiddleware, monitorGate, async (req, res) => {
    try {
        const sym = String(req.params.symbol || '').toUpperCase().trim();
        if (!/^[A-Z0-9.\-]{1,10}$/.test(sym)) return res.status(400).json({ message: 'Invalid ticker.' });
        const force = req.query.refresh === '1';
        if (force) {
            const adminToken = process.env.ADMIN_TOKEN;
            const provided = req.headers['x-admin-token'];
            if (!adminToken || !timingSafeStrEqual(provided, adminToken)) {
                return res.status(403).json({ message: 'Forced dossier refresh is restricted to administrators.' });
            }
        }
        const instrument = await assetProfile.fetchAssetProfile(sym).catch(() => null);
        if (instrument && assetProfile.isFundAsset(instrument.assetType)) {
            const summary = await aiFeatures.summarizeFinancials(sym);
            return res.json({ dossier: {
                symbol: sym,
                name: instrument.name || sym,
                assetType: instrument.assetType,
                assetTypeLabel: instrument.assetTypeLabel,
                isFund: true,
                executiveSummary: summary.summary,
                profile: {
                    category: instrument.category || null,
                    fundFamily: instrument.fundFamily || null,
                    expenseRatio: instrument.expenseRatio,
                    yield: instrument.yield,
                    ytdReturn: instrument.ytdReturn,
                    turnover: instrument.turnover,
                    beta3Year: instrument.beta3Year,
                    returns: instrument.returns || {},
                    totalAssets: instrument.totalAssets,
                    topHoldings: (instrument.topHoldings || []).slice(0, 10),
                    allocations: instrument.allocations || {},
                    source: instrument.source || 'fund market data'
                },
                generatedAt: new Date().toISOString()
            } });
        }

        // Poll path: build-free, returns the dossier once cached else {building}.
        if (req.query.poll === '1') {
            if (_dossierInflight.has(sym)) return res.status(202).json({ status: 'building', symbol: sym, stage: _dossierProgress.get(sym) || null });
            const cached = await dossier.peekDossier(sym).catch(() => null);
            if (cached) return res.json({ dossier: cached });
            return res.status(202).json({ status: 'building', symbol: sym, stage: _dossierProgress.get(sym) || null });
        }

        let build = (!force && _dossierInflight.get(sym)) || null;
        if (!build) {
            build = dossier.buildDossier(sym, { force, onStage: (stage) => _dossierProgress.set(sym, stage) })
                .catch((err) => { console.error('[dossier] build error:', err && err.message); return { error: 'Couldn’t build the dossier right now — please try again in a moment.' }; })
                .finally(() => { _dossierInflight.delete(sym); _dossierProgress.delete(sym); });
            _dossierInflight.set(sym, build);
        }
        const winner = await Promise.race([build, new Promise((r) => setTimeout(() => r('PENDING'), DOSSIER_FAST_MS))]);
        if (winner && winner.error) return res.status(404).json(winner);
        if (winner === 'PENDING') return res.status(202).json({ status: 'building', symbol: sym, stage: _dossierProgress.get(sym) || null });
        if (winner && winner.status === 'building') return res.status(202).json(winner);
        return res.json({ dossier: winner });
    } catch (err) {
        console.error('[dossier] route error:', err.message);
        res.status(500).json({ message: 'Failed to build the dossier.' });
    }
});

// ---- Thesis Tracker (Power/Desk) — your stated reasons, graded each filing ----
app.get('/api/thesis', authMiddleware, monitorGate, async (req, res) => {
    try {
        res.json({ theses: await thesisModel.listTheses(req.userId) });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).json({ message: 'Database unavailable.' });
        res.status(500).json({ message: publicErrorMessage(error, 'Failed to load theses.') });
    }
});

app.post('/api/thesis', authMiddleware, monitorGate, async (req, res) => {
    try {
        const symbol = safeUpper(req.body && req.body.symbol);
        const instrument = symbol ? await assetProfile.fetchAssetProfile(symbol).catch(() => null) : null;
        if (instrument && assetProfile.isFundAsset(instrument.assetType)) {
            return res.status(422).json({
                code: 'ASSET_FEATURE_UNAVAILABLE', assetType: instrument.assetType,
                message: 'Automated thesis grading uses company 10-K/10-Q evidence and is not applicable to funds. Use Ask to analyse the fund against its costs, holdings, allocation, returns and risk.'
            });
        }
        const doc = await thesisModel.saveThesis(req.userId, req.body && req.body.symbol, req.body && req.body.text);
        res.status(201).json({ thesis: { symbol: doc.symbol, text: doc.text, claims: doc.claims } });
    } catch (error) {
        res.status(Number(error.status) || 500).json({ message: publicErrorMessage(error, 'Failed to save thesis.') });
    }
});

app.delete('/api/thesis/:symbol', authMiddleware, monitorGate, async (req, res) => {
    try {
        await thesisModel.deleteThesis(req.userId, req.params.symbol);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Failed to delete thesis.') });
    }
});

app.get('/api/thesis/:symbol/grade', authMiddleware, monitorGate, async (req, res) => {
    try {
        const symbol = safeUpper(req.params.symbol);
        const instrument = symbol ? await assetProfile.fetchAssetProfile(symbol).catch(() => null) : null;
        if (instrument && assetProfile.isFundAsset(instrument.assetType)) {
            return res.status(422).json({
                code: 'ASSET_FEATURE_UNAVAILABLE', assetType: instrument.assetType,
                message: 'Fund theses cannot be graded against company 10-K/10-Q filings. Use Ask for a grounded fund analysis instead.'
            });
        }
        const result = await thesisModel.gradeThesis(req.userId, req.params.symbol, { force: req.query.refresh === '1' });
        if (result.error) return res.status(404).json(result);
        res.json(result);
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Failed to grade thesis.') });
    }
});

// ---- Weekly Filing Monitor digest (Power/Desk) — the retention engine ----
function digestUnsubToken(userId) { return jwt.sign({ userId: String(userId), p: 'digest' }, JWT_SECRET, { expiresIn: '180d' }); }

app.get('/api/digest/unsubscribe', async (req, res) => {
    const page = (msg) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:48px auto;padding:0 20px;color:#0f172a;line-height:1.6">${msg}</div>`;
    try {
        const decoded = jwt.verify(String(req.query.token || ''), JWT_SECRET);
        if (decoded.p !== 'digest') throw new Error('wrong token purpose');
        await User.updateOne({ _id: decoded.userId }, { $set: { digestOptOut: true } });
        res.set('Content-Type', 'text/html').send(page('<h2>Unsubscribed</h2><p>You won\'t get the weekly Filing Monitor digest anymore. You can turn it back on from your dashboard, and the Monitor itself is always available at <a href="/monitor">/monitor</a>.</p>'));
    } catch (_) {
        res.status(400).set('Content-Type', 'text/html').send(page('<h2>Invalid link</h2><p>This unsubscribe link is invalid. Please use the link from a recent digest email.</p>'));
    }
});

async function runDigestSweep() {
    if (mongoose.connection.readyState !== 1) return { skipped: 'no db' };
    if (!mailer.isMailerConfigured()) return { skipped: 'no smtp' };
    const appUrl = (process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro').replace(/\/$/, '');
    const ACTIVE = ['active', 'trialing', 'cancel_at_period_end'];
    const dueBefore = new Date(Date.now() - 6.5 * 86400000); // per-user ~weekly cadence
    const users = await User.find({
        'subscription.planId': { $in: ['power', 'power-monthly', 'desk', 'enterprise'] },
        'subscription.status': { $in: ACTIVE },
        digestOptOut: { $ne: true },
        $or: [{ lastDigestAt: null }, { lastDigestAt: { $lt: dueBefore } }]
    }).limit(200);
    let sent = 0;
    for (const u of users) {
        try {
            const [holdings, wl] = await Promise.all([
                Stock.find({ user: u._id, assetType: { $nin: ['etf', 'mutual_fund', 'crypto'] } }, { symbol: 1 }).lean(),
                Watchlist.findOne({ user: u._id }, { symbols: 1 }).lean()
            ]);
            const symbols = [...holdings.map((h) => h.symbol), ...((wl && wl.symbols) || [])];
            if (symbols.length) {
                const unsubUrl = `${appUrl}/api/digest/unsubscribe?token=${digestUnsubToken(u._id)}`;
                const digest = await monitorDigest.buildUserDigest(u, { appUrl, unsubUrl, symbols });
                if (digest && await mailer.sendMail({ to: u.email, subject: digest.subject, html: digest.html, text: digest.text })) sent++;
            }
            u.lastDigestAt = new Date();
            await u.save().catch(() => {});
        } catch (_) { /* per-user fail-open */ }
    }
    return { eligible: users.length, sent };
}

function startDigest() {
    if (String(process.env.MONITOR_DIGEST || '1') === '0') { console.log('[digest] disabled via MONITOR_DIGEST=0'); return; }
    // Daily tick; lastDigestAt enforces a per-user ~weekly cadence and survives restarts.
    setTimeout(() => { runDigestSweep().then((r) => console.log('[digest] initial sweep', JSON.stringify(r))).catch(() => {}); }, 120 * 1000);
    setInterval(() => { runDigestSweep().then((r) => console.log('[digest] sweep', JSON.stringify(r))).catch(() => {}); }, 24 * 3600 * 1000);
    console.log('[digest] scheduled daily (per-user weekly cadence)');
}

// ---- AppSumo post-redemption honest-review drip + refund reconciliation ----
function appsumoUnsubToken(userId) { return jwt.sign({ userId: String(userId), p: 'as-review' }, JWT_SECRET, { expiresIn: '180d' }); }

app.get('/api/appsumo/unsubscribe', async (req, res) => {
    const page = (msg) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:48px auto;padding:0 20px;color:#0f172a;line-height:1.6">${msg}</div>`;
    try {
        const decoded = jwt.verify(String(req.query.token || ''), JWT_SECRET);
        if (decoded.p !== 'as-review') throw new Error('wrong token purpose');
        await User.updateOne({ _id: decoded.userId }, { $set: { appsumoEmailsOptOut: true } });
        res.set('Content-Type', 'text/html').send(page("<h2>Unsubscribed</h2><p>You won't get any more onboarding or review emails about your AppSumo purchase. Your lifetime access is unaffected — sign in any time at <a href=\"/\">StockPortfolio.pro</a>.</p>"));
    } catch (_) {
        res.status(400).set('Content-Type', 'text/html').send(page('<h2>Invalid link</h2><p>This unsubscribe link is invalid. Please use the link from a recent email.</p>'));
    }
});

// ---- Trial lifecycle email unsubscribe ----
function trialUnsubToken(userId) { return jwt.sign({ userId: String(userId), p: 'trial-emails' }, JWT_SECRET, { expiresIn: '180d' }); }

app.get('/api/trial/unsubscribe', async (req, res) => {
    const page = (msg) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:480px;margin:48px auto;padding:0 20px;color:#0f172a;line-height:1.6">${msg}</div>`;
    try {
        const decoded = jwt.verify(String(req.query.token || ''), JWT_SECRET);
        if (decoded.p !== 'trial-emails') throw new Error('wrong token purpose');
        await User.updateOne({ _id: decoded.userId }, { $set: { trialEmailsOptOut: true } });
        res.set('Content-Type', 'text/html').send(page("<h2>Unsubscribed</h2><p>You won't get any more trial lifecycle emails. Your portfolio and data are unaffected — sign in any time at <a href=\"/\">StockPortfolio.pro</a>.</p>"));
    } catch (_) {
        res.status(400).set('Content-Type', 'text/html').send(page('<h2>Invalid link</h2><p>This unsubscribe link is invalid. Please use the link from a recent email.</p>'));
    }
});

// Cumulative delays from redemption; array index == review stage being sent.
const APPSUMO_REVIEW_STAGES = [null, 24 * 3600 * 1000, 3 * 86400000, 10 * 86400000];

async function runAppSumoReviewSweep() {
    if (mongoose.connection.readyState !== 1) return { skipped: 'no db' };
    if (!mailer.isMailerConfigured()) return { skipped: 'no smtp' };
    if (String(process.env.APPSUMO_REVIEW_EMAILS || '1') === '0') return { skipped: 'disabled' };
    const appUrl = (process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro').replace(/\/$/, '');
    const reviewUrl = appsumoReviewUrl();
    const now = Date.now();
    // Only email still-active buyers (never ask a refunded/deactivated user for a review).
    const users = await User.find({
        appsumoRedeemedAt: { $ne: null },
        appsumoEmailsOptOut: { $ne: true },
        appsumoReviewStage: { $lt: 3 },
        'subscription.status': 'active'
    }).limit(200);
    let sent = 0;
    for (const u of users) {
        try {
            const nextStage = (u.appsumoReviewStage || 0) + 1;
            const threshold = APPSUMO_REVIEW_STAGES[nextStage];
            if (!threshold) continue;
            if (now - new Date(u.appsumoRedeemedAt).getTime() < threshold) continue; // not due yet
            // The campaign onboarding job is the first-touch message. Avoid
            // sending the older 24-hour welcome a second time when both the
            // in-process sweep and the scheduled-email worker are enabled.
            if (nextStage === 1) {
                const onboardingJob = await ScheduledEmail.findOne({ emailKey: `appsumo-onboarding:${String(u._id)}` }).lean();
                if (onboardingJob && onboardingJob.status !== 'skipped') continue;
            }
            // Stage 1 is onboarding. Stages 2/3 ask for a neutral, honest review,
            // so require actual product use first. This is usage-based only: no
            // rating, feedback verdict, or sentiment ever affects eligibility.
            const hasAskUse = nextStage >= 2 ? await aiChat.hasEverUsed(u._id) : false;
            if (!shareCopy.shouldSendAppSumoReviewStage(nextStage, hasAskUse ? 1 : 0)) continue;
            const unsubUrl = `${appUrl}/api/appsumo/unsubscribe?token=${appsumoUnsubToken(u._id)}`;
            const mail = mailer.appsumoReviewEmail(u.name, appUrl, nextStage, reviewUrl, unsubUrl);
            if (await mailer.sendMail({ to: u.email, subject: mail.subject, html: mail.html, text: mail.text })) {
                u.appsumoReviewStage = nextStage; // bump only on successful send; retries next sweep otherwise
                if (nextStage >= 2) {
                    u.reviewRequestSentAt = new Date();
                    trackFunnel('review_request_sent', u._id, u.subscription && u.subscription.planName, {
                        eventName: 'review_request_sent',
                        dedupeKey: `review-request-sent:${String(u._id)}:stage-${nextStage}`,
                        entitlementSource: 'appsumo', appsumoTier: Number(u.appsumoTier) || null
                    });
                }
                await u.save().catch(() => {});
                sent++;
            }
        } catch (_) { /* per-user fail-open */ }
    }
    return { eligible: users.length, sent };
}

async function runAppSumoReconcile() {
    if (mongoose.connection.readyState !== 1) return { skipped: 'no db' };
    // Safety net on top of the real-time deactivate webhook: any license marked
    // deactivated (refund/cancel) whose linked user STILL holds the AppSumo grant
    // gets access revoked. Only touches users whose current key is this deactivated
    // one — so an upgrade (which deactivates the old key) is never clobbered.
    const stale = await AppSumoLicense.find({ status: 'deactivated', userId: { $ne: null } }).limit(500);
    let revoked = 0;
    for (const lic of stale) {
        try {
            const user = await User.findById(lic.userId);
            if (user && user.appsumoLicenseKey === lic.licenseKey && user.appsumoAiCap != null) {
                await revokeAppSumoAccess(user);
                revoked++;
            }
        } catch (_) { /* per-license fail-open */ }
    }
    return { checked: stale.length, revoked };
}

function customerCsvCell(value) {
    let text = value == null ? '' : String(value);
    // Prevent spreadsheet formula execution if a name/email is attacker-chosen.
    if (/^[=+\-@]/.test(text)) text = `'${text}`;
    return `"${text.replace(/"/g, '""')}"`;
}

// Compact, secret-free dataset for the private marketing dashboard. Funnel
// events are append-only; customer records are joined only to derive aggregate
// conversion counts, never returned to the browser.
async function collectMarketingDashboard() {
    if (mongoose.connection.readyState !== 1) throw new Error('database unavailable');
    const col = mongoose.connection.collection('funnel_events');
    const now = new Date();
    const since30 = new Date(now.getTime() - 30 * 86400000);
    const since14 = new Date(now.getTime() - 14 * 86400000);
    const conversionEvents = ['signup', 'trial_start', 'activation', 'paid', 'cancel'];
    const anonymousEvents = ['page_view', 'free_tool_view', 'free_tool_complete', 'appsumo_outbound'];
    // New browser events must be explicitly reportable. Historic conversion
    // events predate classification, so keep them for the customer baseline;
    // historic anonymous traffic is intentionally excluded because it contains
    // the known QA/bot bursts that prompted this repair.
    const reportableMatch = { $or: [
        { reportable: true },
        { reportable: { $exists: false }, event: { $in: conversionEvents } }
    ] };
    const withMatch = (match) => ({ $and: [match, reportableMatch] });
    const countEvents = async (match) => col.aggregate([
        { $match: match },
        { $group: { _id: '$event', count: { $sum: 1 } } }
    ]).toArray();
    const [allRows, windowRows, rawWindowRows, dailyRows, trialEvents, activationEvents, toolEvents, trafficEvents, excludedRows] = await Promise.all([
        countEvents(reportableMatch),
        countEvents(withMatch({ at: { $gte: since30 } })),
        countEvents({ at: { $gte: since30 } }),
        col.aggregate([
            { $match: withMatch({ at: { $gte: since14 } }) },
            { $project: { event: 1, day: { $dateToString: { format: '%Y-%m-%d', date: '$at', timezone: 'Asia/Kolkata' } } } },
            { $group: { _id: { day: '$day', event: '$event' }, count: { $sum: 1 } } },
            { $sort: { '_id.day': 1 } }
        ]).toArray(),
        col.find(withMatch({ event: 'trial_start', userId: { $ne: null } }), { projection: { userId: 1, acquisitionSource: 1, acquisitionClickId: 1, contentId: 1 } }).toArray(),
        col.find(withMatch({ event: 'activation', userId: { $ne: null } }), { projection: { userId: 1, activationJob: 1, contentId: 1 } }).toArray(),
        col.find({ event: { $in: anonymousEvents }, reportable: true }, {
            projection: { event: 1, toolId: 1, contentId: 1, userId: 1, path: 1, anonymousSessionId: 1, acquisitionSource: 1, trafficSource: 1 }
        }).toArray(),
        col.find({ event: { $in: anonymousEvents }, reportable: true, at: { $gte: since30 } }, {
            projection: { event: 1, anonymousSessionId: 1, acquisitionSource: 1, trafficSource: 1 }
        }).toArray(),
        col.aggregate([
            { $match: { event: { $in: anonymousEvents }, at: { $gte: since30 }, reportable: { $ne: true } } },
            { $group: { _id: { $cond: ['$isQa', 'qa', { $cond: ['$isBot', 'bot', 'unclassified'] }] }, count: { $sum: 1 } } }
        ]).toArray()
    ]);
    const counts = (rows) => Object.fromEntries(rows.map((row) => [row._id || 'unknown', Number(row.count || 0)]));
    const all = counts(allRows);
    const last30 = counts(windowRows);
    const rawLast30 = counts(rawWindowRows);
    const excluded30 = Object.fromEntries(excludedRows.map((row) => [row._id || 'unclassified', Number(row.count || 0)]));
    const trialUserIds = [...new Set(trialEvents.map((event) => String(event.userId)).filter((id) => mongoose.Types.ObjectId.isValid(id)))];
    const users = trialUserIds.length ? await User.find({ _id: { $in: trialUserIds.map((id) => new mongoose.Types.ObjectId(id)) } }, {
        appsumoRedeemedAt: 1, stripeCustomerId: 1, stripeSubscriptionId: 1
    }).lean() : [];
    const userById = new Map(users.map((user) => [String(user._id), user]));
    const activatedIds = new Set(activationEvents.map((event) => String(event.userId)));
    const sourceMap = new Map();
    trialEvents.forEach((event) => {
        const source = String(event.acquisitionSource || 'unattributed');
        if (!sourceMap.has(source)) sourceMap.set(source, { trials: 0, converted: 0, activated: 0 });
        const row = sourceMap.get(source);
        const user = userById.get(String(event.userId));
        row.trials++;
        if (user && (user.appsumoRedeemedAt || user.stripeCustomerId || user.stripeSubscriptionId)) row.converted++;
        if (activatedIds.has(String(event.userId))) row.activated++;
    });
    const sourceRows = [...sourceMap.entries()].map(([source, row]) => ({ source, ...row }))
        .sort((a, b) => b.trials - a.trials || a.source.localeCompare(b.source));
    const activationJobs = {};
    activationEvents.forEach((event) => {
        const job = String(event.activationJob || 'unknown');
        activationJobs[job] = (activationJobs[job] || 0) + 1;
    });
    const toolRows = Object.values(freeTools.TOOL_DEFINITIONS).map((definition) => ({
        toolId: definition.id,
        slug: definition.slug,
        views: 0,
        completions: 0,
        ctaClicks: 0,
        trials: 0,
        activated: 0,
        converted: 0
    }));
    const toolById = new Map(toolRows.map((row) => [row.toolId, row]));
    const seenToolEvents = new Set();
    toolEvents.forEach((event) => {
        const id = String(event.toolId || event.contentId || '');
        const row = toolById.get(id);
        if (!row) return;
        const identity = event.anonymousSessionId || String(event._id);
        const dedupeKey = `${event.event}:${id}:${identity}`;
        if (seenToolEvents.has(dedupeKey)) return;
        seenToolEvents.add(dedupeKey);
        if (event.event === 'free_tool_view') row.views++;
        if (event.event === 'free_tool_complete') row.completions++;
        if (event.event === 'appsumo_outbound') row.ctaClicks++;
    });
    trialEvents.forEach((event) => {
        const row = toolById.get(String(event.contentId || ''));
        if (!row) return;
        const userId = String(event.userId);
        row.trials++;
        if (activatedIds.has(userId)) row.activated++;
        const user = userById.get(userId);
        if (user && (user.appsumoRedeemedAt || user.stripeCustomerId || user.stripeSubscriptionId)) row.converted++;
    });
    const researchRows = [
        { contentId: 'research-shares-outstanding', slug: 'shares-outstanding' },
        { contentId: 'research-pe-ratio-history', slug: 'pe-ratio-history' },
        { contentId: 'research-dilution-scorecard', slug: 'dilution-scorecard' }
    ].map((row) => ({ ...row, views: 0, ctaClicks: 0, trials: 0, activated: 0, converted: 0 }));
    const researchById = new Map(researchRows.map((row) => [row.contentId, row]));
    const seenResearchEvents = new Set();
    toolEvents.forEach((event) => {
        const row = researchById.get(String(event.contentId || ''));
        if (!row) return;
        const identity = event.anonymousSessionId || String(event._id);
        const dedupeKey = `${event.event}:${row.contentId}:${identity}`;
        if (seenResearchEvents.has(dedupeKey)) return;
        seenResearchEvents.add(dedupeKey);
        if (event.event === 'page_view') row.views++;
        if (event.event === 'appsumo_outbound') row.ctaClicks++;
    });
    trialEvents.forEach((event) => {
        const row = researchById.get(String(event.contentId || ''));
        if (!row) return;
        const userId = String(event.userId);
        row.trials++;
        if (activatedIds.has(userId)) row.activated++;
        const user = userById.get(userId);
        if (user && (user.appsumoRedeemedAt || user.stripeCustomerId || user.stripeSubscriptionId)) row.converted++;
    });
    const dayMap = new Map();
    for (let i = 13; i >= 0; i--) {
        const day = new Date(now.getTime() - i * 86400000).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
        dayMap.set(day, { day, page_view: 0, signup: 0, trial_start: 0, paid: 0, activation: 0 });
    }
    dailyRows.forEach((row) => {
        const day = dayMap.get(row._id.day);
        if (day && Object.prototype.hasOwnProperty.call(day, row._id.event)) day[row._id.event] = Number(row.count || 0);
    });
    const trafficMap = new Map();
    const trafficSeen = new Set();
    const uniqueReportableSessions = new Set();
    trafficEvents.forEach((event) => {
        const source = String(event.acquisitionSource || event.trafficSource || 'direct');
        if (!trafficMap.has(source)) trafficMap.set(source, { source, sessions: 0, pageViews: 0, toolCompletions: 0, appsumoClicks: 0 });
        const row = trafficMap.get(source);
        if (event.event === 'page_view') row.pageViews++;
        if (event.event === 'free_tool_complete') row.toolCompletions++;
        if (event.event === 'appsumo_outbound') row.appsumoClicks++;
        const sessionKey = `${source}:${event.anonymousSessionId || ''}`;
        if (event.anonymousSessionId && !trafficSeen.has(sessionKey)) {
            trafficSeen.add(sessionKey);
            row.sessions++;
        }
        if (event.anonymousSessionId) uniqueReportableSessions.add(event.anonymousSessionId);
    });
    const appsumoLicenses = await AppSumoLicense.countDocuments({ status: { $ne: 'deactivated' } });
    const appsumoLastEvent = await AppSumoLicense.findOne({}, { updatedAt: 1, lastEventAt: 1 }).sort({ updatedAt: -1 }).lean();
    return {
        generatedAt: now.toISOString(),
        // The current commercial objective is 50 net active AppSumo customers;
        // AppSumo's partner portal remains authoritative for gross orders and
        // refunds that have not reached our webhook yet.
        targetCustomers: 50,
        allTime: {
            ...all,
            appsumoLicenses,
            appsumoRedemptions: await User.countDocuments({ appsumoRedeemedAt: { $ne: null } })
        },
        last30: {
            ...last30,
            estimatedHumanSessions: uniqueReportableSessions.size,
            appsumoRedemptions: await User.countDocuments({ appsumoRedeemedAt: { $gte: since30 } })
        },
        rawLast30,
        excluded30,
        trafficRows: [...trafficMap.values()].sort((a, b) => b.sessions - a.sessions || a.source.localeCompare(b.source)),
        appsumoSync: { lastEventAt: appsumoLastEvent ? (appsumoLastEvent.lastEventAt || appsumoLastEvent.updatedAt || null) : null },
        sourceRows,
        toolRows,
        researchRows,
        activationJobs,
        trend: [...dayMap.values()]
    };
}

function marketingDashboardOnly(req, res, next) {
    const email = String(req.user && req.user.email || '').trim().toLowerCase();
    if (email !== 'rin@gmail.com') return res.status(403).json({ message: 'Dashboard access denied' });
    return next();
}

async function collectAugustGrowthReport() {
    const base = await collectMarketingDashboard();
    const now = new Date();
    const meaningful = await FunnelEvent.countDocuments({ event: 'meaningful_activation', resultValid: true, sourceOpened: true, reportable: { $ne: false } });
    const successYes = await User.countDocuments({ customerSuccessStatus: 'yes' });
    const reviewEligible = await User.countDocuments({ reviewEligibleAt: { $ne: null } });
    const reviewClicks = await FunnelEvent.countDocuments({ event: 'review_clicked', reportable: { $ne: false } });
    // Aggregate lifecycle-mail state only; recipient addresses and message
    // bodies never leave the server. These counts reflect application state,
    // not inbox delivery or opens.
    const [scheduledEmails, attemptedEmails, sentEmails, failedEmails, suppressedEmails, duplicatePreventedEmails] = await Promise.all([
        ScheduledEmail.countDocuments({ status: 'scheduled' }),
        ScheduledEmail.countDocuments({ status: { $in: ['sent', 'failed'] } }),
        ScheduledEmail.countDocuments({ status: 'sent' }),
        ScheduledEmail.countDocuments({ status: 'failed' }),
        ScheduledEmail.countDocuments({ status: 'skipped' }),
        ScheduledEmail.countDocuments({ status: 'skipped', skippedReason: /already|duplicate/i })
    ]);
    const gmvSnapshots = await ManualGmvSnapshot.find({}).sort({ date: -1 }).limit(90).lean();
    const grossSales = gmvSnapshots.reduce((sum, row) => sum + Number(row.grossSales || 0), 0);
    const refunds = gmvSnapshots.reduce((sum, row) => sum + Number(row.refunds || 0), 0);
    const target = augustCampaign.config(now).revenueTarget;
    return {
        campaign: augustCampaign.config(now), targetRevenue: target,
        gmv: { grossSales, refunds, netSales: Math.max(0, grossSales - refunds), snapshots: gmvSnapshots },
        pacing: { daysElapsed: Math.max(0, Math.floor((now - new Date(augustCampaign.config(now).campaignStart)) / 86400000)), target, percent: target ? ((grossSales - refunds) / target) * 100 : 0 },
        funnel: base,
        customerSuccess: { meaningfulActivations: meaningful, yes: successYes, reviewEligible, reviewClicks },
        emailObservability: {
            scheduled: scheduledEmails,
            attempted: attemptedEmails,
            sent: sentEmails,
            failed: failedEmails,
            suppressed: suppressedEmails,
            duplicatePrevented: duplicatePreventedEmails,
            deliveryConfirmed: false
        },
        warnings: [
            !augustCampaign.config(now).configured ? 'APPSUMO_DEAL_END_AT is not configured; deadline urgency is intentionally disabled.' : null,
            grossSales === 0 ? 'No manual GMV snapshot has been entered; Partner Portal remains the commercial source of truth.' : null,
            successYes < 3 ? 'Affiliate gate remains closed until three real customers confirm a successful research outcome.' : null
        ].filter(Boolean)
    };
}

app.get('/api/admin/growth/august-2026', authMiddleware, marketingDashboardOnly, async (req, res) => {
    try { res.set('Cache-Control', 'no-store').json(await collectAugustGrowthReport()); }
    catch (error) { console.error('[growth] report failed:', error && error.message); res.status(500).json({ message: 'Growth report unavailable' }); }
});

app.post('/api/admin/growth/gmv', authMiddleware, marketingDashboardOnly, async (req, res) => {
    const b = req.body || {};
    const date = new Date(String(b.date || ''));
    if (!Number.isFinite(date.getTime())) return res.status(400).json({ message: 'date is required' });
    const n = (value) => Math.max(0, Number(value || 0));
    try {
        const row = await ManualGmvSnapshot.findOneAndUpdate(
            { date },
            { $set: { date, grossOrders: n(b.grossOrders), grossSales: n(b.grossSales), refunds: n(b.refunds), netOrders: n(b.netOrders), payoutEstimate: n(b.payoutEstimate), notes: cleanShort(b.notes, 1000), updatedBy: normalizeEmail(req.user.email) } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        ).lean();
        res.status(201).json({ ok: true, snapshot: row });
    } catch (_) { res.status(500).json({ message: 'Could not save GMV snapshot' }); }
});

app.get('/api/admin/growth/gmv', authMiddleware, marketingDashboardOnly, async (req, res) => {
    try { res.set('Cache-Control', 'no-store').json({ snapshots: await ManualGmvSnapshot.find({}).sort({ date: -1 }).limit(90).lean() }); }
    catch (_) { res.status(500).json({ message: 'Could not load GMV snapshots' }); }
});

app.get('/admin/growth/august-2026', authMiddleware, marketingDashboardOnly, async (req, res) => {
    try {
        const data = await collectAugustGrowthReport();
        const esc = escapeHtml;
        const money = (v) => `$${Number(v || 0).toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
        const c = data.customerSuccess;
        const e = data.emailObservability;
        res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>August AppSumo sprint — StockPortfolio.pro</title><style>body{font:15px/1.5 system-ui;margin:0;background:#f6f8fb;color:#172033}main{max-width:1100px;margin:auto;padding:28px 18px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.card,section{background:white;border:1px solid #e2e8f0;border-radius:12px;padding:16px;margin:14px 0}.card strong{display:block;font-size:28px}.muted{color:#64748b}.warning{background:#fffbeb;border-color:#fde68a;color:#92400e}.row{display:flex;gap:8px;flex-wrap:wrap}input,button{padding:9px;border:1px solid #cbd5e1;border-radius:8px;font:inherit}button{background:#172033;color:#fff;cursor:pointer}</style><main><p class="muted"><a href="/admin/marketing">Marketing dashboard</a></p><h1>August AppSumo sprint</h1><p>Goal: ${money(data.targetRevenue)} net revenue · <span class="muted">${esc(data.campaign.deadlineLabel)}</span></p><div class="grid"><div class="card"><span class="muted">Net manual GMV</span><strong>${money(data.gmv.netSales)}</strong></div><div class="card"><span class="muted">Meaningful activations</span><strong>${c.meaningfulActivations}</strong></div><div class="card"><span class="muted">Customers saying “yes”</span><strong>${c.yes}</strong></div><div class="card"><span class="muted">Review eligible</span><strong>${c.reviewEligible}</strong></div></div><section><h2>Lifecycle email observability</h2><div class="grid"><div class="card"><span class="muted">Scheduled</span><strong>${e.scheduled}</strong></div><div class="card"><span class="muted">Attempted</span><strong>${e.attempted}</strong></div><div class="card"><span class="muted">Sent</span><strong>${e.sent}</strong></div><div class="card"><span class="muted">Failed</span><strong>${e.failed}</strong></div><div class="card"><span class="muted">Suppressed</span><strong>${e.suppressed}</strong></div><div class="card"><span class="muted">Duplicate prevented</span><strong>${e.duplicatePrevented}</strong></div></div><p class="muted">Application delivery states only; inbox delivery and opens are not confirmed.</p></section><section><h2>Warnings</h2>${data.warnings.length ? data.warnings.map((w) => `<p class="warning">${esc(w)}</p>`).join('') : '<p>No current warnings.</p>'}</section><section><h2>Enter a Partner Portal snapshot</h2><p class="muted">Manual only; no checkout or payout action is performed.</p><form id="gmv"><div class="row"><input name="date" type="date" required><input name="grossOrders" type="number" min="0" placeholder="Gross orders"><input name="grossSales" type="number" min="0" step="0.01" placeholder="Gross sales USD"><input name="refunds" type="number" min="0" step="0.01" placeholder="Refunds USD"><button>Save snapshot</button></div></form><p id="status" class="muted"></p></section><section><h2>Customer-success gate</h2><p>Three real customers selecting “Yes, clearly” are required before the affiliate program can be enabled. Current count: <strong>${c.yes}</strong>.</p></section><script>document.getElementById('gmv').addEventListener('submit',async function(e){e.preventDefault();const b=Object.fromEntries(new FormData(e.target));const r=await fetch('/api/admin/growth/gmv',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(b)});document.getElementById('status').textContent=r.ok?'Saved. Reload to refresh totals.':'Could not save snapshot.';});</script></main>`);
    } catch (_) { res.status(500).send('Growth dashboard unavailable'); }
});

app.get('/api/admin/growth/content', authMiddleware, marketingDashboardOnly, async (req, res) => {
    const ticker = normalizeTicker(req.query.ticker || '');
    const tool = freeToolId(req.query.tool || 'earnings-quality') || 'earnings-quality';
    const channel = shareCopy.normalizeAppSumoSource(req.query.channel || 'website') || 'website';
    const contentId = shareCopy.normalizeAcquisitionContentId(req.query.contentId || `tool-${tool}`) || `tool-${tool}`;
    if (!isValidTicker(ticker)) return res.status(400).json({ message: 'A valid ticker is required.' });
    try {
        const result = await freeTools.getToolResult(tool, ticker);
        const pathName = `/tools/${tool}`;
        const trackedUrl = `${PUBLIC_APP_URL}${augustCampaign.appsumoPath({ source: channel, contentId })}`;
        res.set('Cache-Control', 'no-store').json({ campaignId: augustCampaign.config().campaignId, tool, ticker, contentId, channel, researchUrl: `${PUBLIC_APP_URL}${pathName}?symbol=${encodeURIComponent(ticker)}`, appsumoUrl: `${PUBLIC_APP_URL}${augustCampaign.appsumoPath({ source: channel, contentId })}`, result: result.body && !result.body.error ? result.body : null, status: result.status });
    } catch (_) { res.status(502).json({ message: 'Could not generate a deterministic preview.' }); }
});

app.get('/admin/growth/content', authMiddleware, marketingDashboardOnly, (req, res) => {
    res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Content generator — StockPortfolio.pro</title><style>body{font:15px/1.5 system-ui;margin:0;background:#f6f8fb;color:#172033}main{max-width:840px;margin:auto;padding:28px 18px}.card{background:#fff;border:1px solid #e2e8f0;border-radius:12px;padding:18px;margin:14px 0}.row{display:flex;gap:8px;flex-wrap:wrap}input,select,button{padding:10px;border:1px solid #cbd5e1;border-radius:8px;font:inherit}button{background:#172033;color:#fff}.out{white-space:pre-wrap;word-break:break-word}</style><main><p><a href="/admin/growth/august-2026">← August dashboard</a></p><h1>Private content generator</h1><p>Generate a current deterministic result and tracked URLs. Nothing is published automatically.</p><div class="card"><form id="f"><div class="row"><input name="ticker" placeholder="AAPL" maxlength="10" required><select name="tool"><option value="earnings-quality">Earnings quality</option><option value="dilution">Dilution</option><option value="filing-timeline">Filing timeline</option></select><select name="channel"><option>website</option><option>x</option><option>linkedin</option><option>reddit</option><option>creator</option><option>newsletter</option></select><input name="contentId" placeholder="tool-earnings-quality"><button>Generate preview</button></div></form></div><div id="out" class="card out"></div><script>document.getElementById('f').addEventListener('submit',async function(e){e.preventDefault();const b=Object.fromEntries(new FormData(e.target));const q=new URLSearchParams(b);const r=await fetch('/api/admin/growth/content?'+q);document.getElementById('out').textContent=JSON.stringify(await r.json(),null,2);});</script></main>`);
});

// Owner-only, real-time Ollama attribution. This is deliberately separate from
// the marketing funnel: it exposes authenticated customer identity only to the
// existing rin@gmail.com owner account, never to customers or public visitors.
app.get('/api/admin/ollama/usage', authMiddleware, marketingDashboardOnly, async (req, res) => {
    try {
        const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 168);
        const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
        const data = await ollamaUsage.snapshot({ sinceMs: hours * 3600 * 1000, limit });
        res.set('Cache-Control', 'no-store').json(data);
    } catch (error) {
        console.error('[ollama] usage snapshot failed:', error && error.message);
        res.status(500).json({ message: 'Ollama usage tracker unavailable' });
    }
});

app.get('/api/admin/ollama/usage/stream', authMiddleware, marketingDashboardOnly, async (req, res) => {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    let closed = false;
    const send = (event, data) => {
        if (closed || res.writableEnded) return;
        res.write(`event: ${event}\ndata: ${JSON.stringify(data || {})}\n\n`);
    };
    const unsubscribe = ollamaUsage.subscribe((message) => {
        if (message && message.event && message.event.provider === 'ollama') send(message.type, message.event);
    });
    const ping = setInterval(() => { if (!closed && !res.writableEnded) res.write(': ping\n\n'); }, 15000);
    req.on('close', () => {
        closed = true;
        clearInterval(ping);
        unsubscribe();
    });
    try {
        const hours = Math.min(Math.max(Number(req.query.hours) || 24, 1), 168);
        const limit = Math.min(Math.max(Number(req.query.limit) || 200, 1), 500);
        send('snapshot', await ollamaUsage.snapshot({ sinceMs: hours * 3600 * 1000, limit }));
    } catch (_) {
        send('error', { message: 'Ollama usage tracker unavailable' });
    }
});

app.get('/admin/ollama', authMiddleware, marketingDashboardOnly, (req, res) => {
    res.set('Cache-Control', 'no-store').sendFile(path.join(__dirname, 'admin-ollama.html'));
});

app.post('/api/admin/marketing/qa-session', authMiddleware, marketingDashboardOnly, (req, res) => {
    const enabled = req.body && req.body.enabled !== false;
    marketingAttribution.setQaModeCookie(res, enabled, {
        secret: JWT_SECRET,
        secure: process.env.NODE_ENV === 'production' || Boolean(req.secure),
        domain: marketingAttribution.cookieDomain(req.hostname)
    });
    res.set('Cache-Control', 'no-store').json({ ok: true, qaMode: enabled });
});

app.get('/api/admin/marketing', authMiddleware, marketingDashboardOnly, async (req, res) => {
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ message: 'Database is still starting' });
    try {
        const data = await collectMarketingDashboard();
        if (String(req.query.format || '').toLowerCase() === 'csv') {
            const columns = ['kind', 'source', 'contentId', 'slug', 'sessions', 'views', 'completions', 'ctaClicks', 'trials', 'activated', 'converted'];
            const lines = [columns.map(customerCsvCell).join(',')];
            data.toolRows.forEach((row) => { const out = { ...row, kind: 'tool', contentId: row.toolId }; lines.push(columns.map((column) => customerCsvCell(out[column])).join(',')); });
            data.researchRows.forEach((row) => { const out = { ...row, kind: 'research', completions: '' }; lines.push(columns.map((column) => customerCsvCell(out[column])).join(',')); });
            data.trafficRows.forEach((row) => { const out = { ...row, kind: 'traffic', views: row.pageViews, completions: row.toolCompletions, ctaClicks: row.appsumoClicks }; lines.push(columns.map((column) => customerCsvCell(out[column])).join(',')); });
            res.set('Cache-Control', 'no-store').type('text/csv').set('Content-Disposition', 'attachment; filename="stockportfolio-marketing-tools.csv"').send(`${lines.join('\n')}\n`);
            return;
        }
        res.set('Cache-Control', 'no-store').json(data);
    } catch (error) {
        console.error('[marketing] dashboard failed:', error && error.message);
        res.status(500).json({ message: 'Marketing dashboard unavailable' });
    }
});

app.get('/admin/marketing', authMiddleware, marketingDashboardOnly, async (req, res) => {
    if (mongoose.connection.readyState !== 1) return res.status(503).send('Database is still starting');
    try {
        const data = await collectMarketingDashboard();
        const n = (value) => Number(value || 0).toLocaleString('en-IN');
        const pct = (num, den) => den ? `${((num / den) * 100).toFixed(1)}%` : '—';
        const e = escapeHtml;
        const w = data.last30;
        const cards = [
            ['Human sessions · 30d', w.estimatedHumanSessions, 'estimated browsers'],
            ['Human page views · 30d', w.page_view, 'QA/bots excluded'],
            ['30-day signups', w.signup, 'accounts'],
            ['30-day trials', w.trial_start, 'started'],
            ['AppSumo purchases', data.allTime.appsumoLicenses, `of ${data.targetCustomers} target`],
            ['AppSumo activated', data.allTime.appsumoRedemptions, 'redeemed licenses'],
            ['30-day activations', w.activation, 'meaningful jobs']
        ].map(([label, value, note]) => `<div class="card"><div class="label">${label}</div><strong>${n(value)}</strong><small>${note}</small></div>`).join('');
        const sourceRows = data.sourceRows.length ? data.sourceRows.map((row) => `<tr><td>${e(row.source)}</td><td>${n(row.trials)}</td><td>${n(row.activated)}</td><td>${n(row.converted)}</td><td>${pct(row.converted, row.trials)}</td></tr>`).join('') : '<tr><td colspan="5">No attributed trials yet</td></tr>';
        const jobNames = { ask: 'Cited Ask answer', comparison: 'Comparison', screener_company: 'Screener → company', portfolio: 'Three-position portfolio' };
        const jobRows = Object.entries(data.activationJobs).sort((a, b) => b[1] - a[1]).map(([job, value]) => `<tr><td>${e(jobNames[job] || job)}</td><td>${n(value)}</td></tr>`).join('') || '<tr><td colspan="2">No activations yet</td></tr>';
        const toolRows = data.toolRows.map((row) => `<tr><td>${e(row.slug)}</td><td>${n(row.views)}</td><td>${n(row.completions)}</td><td>${n(row.ctaClicks)}</td><td>${n(row.trials)}</td><td>${n(row.activated)}</td><td>${n(row.converted)}</td></tr>`).join('');
        const researchRows = data.researchRows.map((row) => `<tr><td>${e(row.slug)}</td><td>${n(row.views)}</td><td>${n(row.ctaClicks)}</td><td>${n(row.trials)}</td><td>${n(row.activated)}</td><td>${n(row.converted)}</td></tr>`).join('');
        const trafficRows = data.trafficRows.length ? data.trafficRows.map((row) => `<tr><td>${e(row.source)}</td><td>${n(row.sessions)}</td><td>${n(row.pageViews)}</td><td>${n(row.toolCompletions)}</td><td>${n(row.appsumoClicks)}</td></tr>`).join('') : '<tr><td colspan="5">No reportable campaign/search sessions yet</td></tr>';
        const maxTrend = Math.max(1, ...data.trend.map((row) => Math.max(row.signup, row.trial_start, row.paid, row.activation)));
        const trendRows = data.trend.map((row) => {
            const bar = (value, color) => `<span class="bar" style="width:${Math.round((value / maxTrend) * 100)}%;background:${color}"></span>`;
            return `<tr><td>${e(row.day)}</td><td>${n(row.page_view)}</td><td>${bar(row.signup, '#2563eb')}${n(row.signup)}</td><td>${bar(row.trial_start, '#7c3aed')}${n(row.trial_start)}</td><td>${bar(row.paid, '#059669')}${n(row.paid)}</td><td>${bar(row.activation, '#d97706')}${n(row.activation)}</td></tr>`;
        }).join('');
        const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Marketing dashboard — StockPortfolio.pro</title><style>
body{margin:0;background:#f6f8fb;color:#172033;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif}main{max-width:1180px;margin:0 auto;padding:28px 20px 60px}h1{margin:0 0 4px;font-size:28px}h2{margin:28px 0 10px;font-size:18px}.muted{color:#64748b}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:12px;margin:22px 0}.card,.panel{background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 2px 8px #0f172a0a}.card{padding:16px}.label{color:#64748b;font-size:12px;text-transform:uppercase;letter-spacing:.04em}.card strong{display:block;font-size:30px;margin:4px 0}.card small{color:#64748b}.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px}@media(max-width:760px){.grid{grid-template-columns:1fr}}.panel{padding:16px;overflow:auto}table{border-collapse:collapse;width:100%;min-width:460px}th,td{border-bottom:1px solid #edf2f7;padding:9px 8px;text-align:left;white-space:nowrap}th{color:#64748b;font-size:12px;text-transform:uppercase}.rate{font-size:24px;font-weight:700}.barcell{min-width:150px}.bar{display:inline-block;height:9px;border-radius:6px;margin-right:7px;vertical-align:middle;max-width:90%;min-width:0}.legend{color:#64748b;font-size:12px;margin-top:8px}.nav{float:right}.nav a,.nav button{color:#2563eb;text-decoration:none;margin-left:10px;background:none;border:0;padding:0;font:inherit;cursor:pointer}</style></head><body><main><div class="nav"><a href="/admin/funnel">Funnel detail</a><a href="/admin/ollama">Ollama usage</a><a href="/api/admin/marketing">JSON</a><button id="qa-on" type="button">Exclude my QA</button><button id="qa-off" type="button">End QA</button></div><h1>Marketing progress</h1><div class="muted">Reportable browser activity only · generated ${e(data.generatedAt)}</div><div class="cards">${cards}</div><div class="grid"><section class="panel"><h2>Conversion funnel · 30 days</h2><table><tr><th>Step</th><th>Count</th><th>Rate</th></tr><tr><td>Page views → signups</td><td>${n(w.page_view)} → ${n(w.signup)}</td><td class="rate">${pct(w.signup, w.page_view)}</td></tr><tr><td>Signups → trials</td><td>${n(w.signup)} → ${n(w.trial_start)}</td><td class="rate">${pct(w.trial_start, w.signup)}</td></tr><tr><td>Trials → paid/redeemed</td><td>${n(w.trial_start)} → ${n(w.appsumoRedemptions)}</td><td class="rate">${pct(w.appsumoRedemptions, w.trial_start)}</td></tr><tr><td>Trials → activation</td><td>${n(w.trial_start)} → ${n(w.activation)}</td><td class="rate">${pct(w.activation, w.trial_start)}</td></tr></table></section><section class="panel"><h2>Source performance</h2><table><tr><th>Source</th><th>Trials</th><th>Activated</th><th>Converted</th><th>Trial → converted</th></tr>${sourceRows}</table><div class="legend">Unattributed means the trial predates signed campaign-source tracking.</div></section></div><section class="panel" style="margin-top:16px"><h2>Activation jobs</h2><table><tr><th>Meaningful job</th><th>Completions</th></tr>${jobRows}</table></section><section class="panel" style="margin-top:16px"><h2>14-day trend</h2><table><tr><th>Date (IST)</th><th>Visits</th><th>Signups</th><th>Trials</th><th>Paid events</th><th>Activations</th></tr>${trendRows}</table><div class="legend">Bars are scaled to the largest daily value in the signups/trials/paid/activation series.</div></section><script>for(const [id,enabled] of [['qa-on',true],['qa-off',false]])document.getElementById(id).addEventListener('click',async()=>{const r=await fetch('/api/admin/marketing/qa-session',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({enabled})});if(r.ok)alert(enabled?'QA exclusion is on for this browser.':'QA exclusion is off.');});</script></main></body></html>`;
        const toolPanel = `<section class="panel" style="margin-top:16px"><h2>Engineering-as-marketing tools</h2><table><tr><th>Tool</th><th>Views</th><th>Completed</th><th>CTA clicks</th><th>Trials</th><th>Activated</th><th>Converted</th></tr>${toolRows}</table><div class="legend">Tool events are first-party and attributed by signed content ID when a user continues to AppSumo.</div></section>`;
        const researchPanel = `<section class="panel" style="margin-top:16px"><h2>Organic research hubs</h2><table><tr><th>Research page</th><th>Views</th><th>CTA clicks</th><th>Trials</th><th>Activated</th><th>Converted</th></tr>${researchRows}</table><div class="legend">Research views and downstream AppSumo conversion use allowlisted content IDs and first-party attribution.</div></section>`;
        const trafficPanel = `<section class="panel" style="margin-top:16px"><h2>Acquisition traffic · 30 days</h2><table><tr><th>Source</th><th>Human sessions</th><th>Page views</th><th>Tool completions</th><th>AppSumo clicks</th></tr>${trafficRows}</table><div class="legend">Social is judged by AppSumo progress; search is judged by genuine tool/product usage. Sessions are anonymous browser estimates, not identity verification.</div></section>`;
        const auditPanel = `<section class="panel" style="margin-top:16px"><h2>Measurement audit · 30 days</h2><table><tr><th>Raw page views</th><th>Reportable page views</th><th>QA events excluded</th><th>Bot/automation events excluded</th><th>Unclassified events excluded</th></tr><tr><td>${n(data.rawLast30.page_view)}</td><td>${n(w.page_view)}</td><td>${n(data.excluded30.qa)}</td><td>${n(data.excluded30.bot)}</td><td>${n(data.excluded30.unclassified)}</td></tr></table><div class="legend">AppSumo webhook/license collection last changed: ${e(data.appsumoSync.lastEventAt ? new Date(data.appsumoSync.lastEventAt).toISOString() : 'no event recorded')}. The AppSumo Partner Portal remains definitive for purchases that have not reached the webhook.</div></section>`;
        const renderedHtml = html.replace('<section class="panel" style="margin-top:16px"><h2>Activation jobs</h2>', `${trafficPanel}${toolPanel}${researchPanel}${auditPanel}<section class="panel" style="margin-top:16px"><h2>Activation jobs</h2>`);
        res.set('Cache-Control', 'no-store').type('html').send(renderedHtml);
    } catch (error) {
        console.error('[marketing] dashboard render failed:', error && error.message);
        res.status(500).send('Marketing dashboard unavailable');
    }
});

// Admin-only customer registry/export. Emails come from MongoDB User records;
// no password hashes, license keys, reset tokens, or auth-provider IDs leave the
// server. Use x-admin-token rather than a query token to keep credentials out of
// access logs. `source` may be all, appsumo, stripe, subscriber, signup, or trial.
app.get('/api/admin/customers', async (req, res) => {
    const token = process.env.ADMIN_TOKEN;
    const provided = req.headers['x-admin-token'];
    if (!token || !timingSafeStrEqual(provided, token)) return res.status(403).json({ message: 'Forbidden' });
    try {
        const source = String(req.query.source || 'all').trim().toLowerCase();
        if (!['all', 'appsumo', 'stripe', 'subscriber', 'signup', 'trial'].includes(source)) {
            return res.status(400).json({ message: 'source must be all, appsumo, stripe, subscriber, signup, or trial' });
        }
        const limit = Math.min(Math.max(Number(req.query.limit) || 500, 1), 2000);
        const filter = {};
        if (source === 'appsumo') filter.appsumoRedeemedAt = { $ne: null };
        if (source === 'stripe') filter.$or = [{ stripeCustomerId: { $ne: null } }, { stripeSubscriptionId: { $ne: null } }];
        if (source === 'subscriber') {
            filter.appsumoRedeemedAt = null;
            filter['subscription.planId'] = { $ne: FREE_PLAN_ID };
            filter['subscription.status'] = { $in: ['trialing', 'active', 'cancel_at_period_end'] };
        }
        if (source === 'signup') {
            filter.appsumoRedeemedAt = null;
            filter.stripeCustomerId = null;
            filter.stripeSubscriptionId = null;
        }
        if (source === 'trial') {
            // Trial origin is the durable funnel event, not a mutable current
            // subscription shape; this keeps AppSumo conversions in the report.
            const trialEventsForFilter = await mongoose.connection.collection('funnel_events').find(
                { event: 'trial_start', userId: { $ne: null } }, { projection: { userId: 1 } }
            ).toArray();
            const trialUserIds = [...new Set(trialEventsForFilter.map((event) => String(event.userId)).filter((id) => mongoose.Types.ObjectId.isValid(id)))];
            filter._id = { $in: trialUserIds.map((id) => new mongoose.Types.ObjectId(id)) };
        }
        const users = await User.find(filter, {
            email: 1, name: 1, subscription: 1,
            stripeCustomerId: 1, stripeSubscriptionId: 1,
            googleId: 1, facebookId: 1,
            appsumoTier: 1, appsumoAiCap: 1, appsumoRedeemedAt: 1,
            discoverySource: 1,
            createdAt: 1, updatedAt: 1
        }).sort({ updatedAt: -1, appsumoRedeemedAt: -1 }).limit(limit).lean();

        const userIds = users.map((user) => user._id);
        const lifecycleEvents = userIds.length
            ? await CustomerLifecycleEvent.find({ userId: { $in: userIds } }, {
                userId: 1, type: 1, source: 1, createdAt: 1,
                discoverySource: 1,
                customerEmailedAt: 1, ownerNotifiedAt: 1
            }).sort({ createdAt: -1 }).lean()
            : [];
        const latestEventByUser = new Map();
        lifecycleEvents.forEach((event) => {
            const key = String(event.userId);
            if (!latestEventByUser.has(key)) latestEventByUser.set(key, event);
        });
        const trialEvents = userIds.length
            ? await mongoose.connection.collection('funnel_events').find({
                event: 'trial_start', userId: { $in: userIds.map((id) => String(id)) }
            }).sort({ at: -1 }).toArray()
            : [];
        const trialEventByUser = new Map();
        trialEvents.forEach((event) => {
            if (!trialEventByUser.has(String(event.userId))) trialEventByUser.set(String(event.userId), event);
        });
        const customers = users.map((user) => {
            const event = latestEventByUser.get(String(user._id));
            const trialEvent = trialEventByUser.get(String(user._id));
            const channel = user.appsumoRedeemedAt
                ? 'appsumo'
                : (user.stripeCustomerId || user.stripeSubscriptionId ? 'stripe' : 'no_card');
            const convertedVia = user.appsumoRedeemedAt
                ? 'appsumo'
                : (user.stripeCustomerId || user.stripeSubscriptionId ? 'stripe' : null);
            return {
                email: user.email,
                name: user.name || '',
                channel,
                authMethod: user.googleId ? 'google' : user.facebookId ? 'facebook' : 'email',
                planId: user.subscription && user.subscription.planId,
                planName: user.subscription && user.subscription.planName,
                subscriptionStatus: user.subscription && user.subscription.status,
                effectiveStatus: effectiveTrialStatus(user),
                appsumoTier: user.appsumoTier || null,
                appsumoAiCap: user.appsumoAiCap || null,
                createdAt: user.createdAt || null,
                updatedAt: user.updatedAt || null,
                trialStartedAt: user.subscription && user.subscription.trialStartedAt,
                trialEndsAt: user.subscription && user.subscription.trialEndsAt,
                trialEventAt: trialEvent && trialEvent.at,
                acquisitionSource: trialEvent && trialEvent.acquisitionSource || null,
                acquisitionClickId: trialEvent && trialEvent.acquisitionClickId || null,
                discoverySource: user.discoverySource || event && event.discoverySource || null,
                convertedVia,
                convertedAt: user.appsumoRedeemedAt || (user.subscription && user.subscription.lastPaymentAt) || null,
                appsumoRedeemedAt: user.appsumoRedeemedAt || null,
                lastPaymentAt: user.subscription && user.subscription.lastPaymentAt,
                lastLifecycleEvent: event ? event.type : null,
                customerEmailedAt: event && event.customerEmailedAt,
                ownerNotifiedAt: event && event.ownerNotifiedAt
            };
        });
        res.setHeader('Cache-Control', 'no-store');
        if (String(req.query.format || '').toLowerCase() === 'csv') {
            const columns = ['email', 'name', 'channel', 'authMethod', 'planId', 'planName', 'subscriptionStatus', 'effectiveStatus', 'trialStartedAt', 'trialEndsAt', 'trialEventAt', 'acquisitionSource', 'acquisitionClickId', 'discoverySource', 'convertedVia', 'convertedAt', 'appsumoTier', 'appsumoAiCap', 'createdAt', 'updatedAt', 'appsumoRedeemedAt', 'lastPaymentAt', 'lastLifecycleEvent', 'customerEmailedAt', 'ownerNotifiedAt'];
            const lines = [columns.map(customerCsvCell).join(',')];
            customers.forEach((customer) => lines.push(columns.map((column) => customerCsvCell(customer[column])).join(',')));
            res.setHeader('Content-Type', 'text/csv; charset=utf-8');
            res.setHeader('Content-Disposition', `attachment; filename="stockportfolio-customers-${source}.csv"`);
            return res.send(`${lines.join('\n')}\n`);
        }
        return res.json({ source, count: customers.length, limit, customers });
    } catch (error) {
        console.error('[customers] admin export failed:', error && error.message);
        return res.status(500).json({ message: 'Customer export failed' });
    }
});

// Support tool: look up an AppSumo license by key, or a buyer by email (AppSumo
// never hands us buyer emails, so key lookup is the only way to answer "my key
// won't redeem"). Token-gated with ADMIN_TOKEN, same as /api/admin/comp.
app.get('/api/admin/appsumo/lookup', async (req, res) => {
    const token = process.env.ADMIN_TOKEN;
    const provided = req.headers['x-admin-token'];
    if (!token || !timingSafeStrEqual(provided, token)) return res.status(403).json({ message: 'Forbidden' });
    try {
        const key = String(req.query.key || '').trim();
        const email = String(req.query.email || '').trim().toLowerCase();
        let lic = null, user = null;
        if (key) {
            lic = await AppSumoLicense.findOne({ licenseKey: key }).lean();
            if (lic && lic.userId) user = await User.findById(lic.userId).lean();
        } else if (email) {
            user = await User.findOne({ email }).lean();
            if (user && user.appsumoLicenseKey) lic = await AppSumoLicense.findOne({ licenseKey: user.appsumoLicenseKey }).lean();
        } else {
            return res.status(400).json({ message: 'Provide ?key=<licenseKey> or ?email=<buyer email>' });
        }
        const license = lic ? {
            licenseKey: lic.licenseKey, status: lic.status, tier: lic.tier,
            prevLicenseKey: lic.prevLicenseKey, partnerPlanName: lic.partnerPlanName,
            redeemedAt: lic.redeemedAt, lastEvent: lic.lastEvent, lastEventAt: lic.lastEventAt,
            linkedUserId: lic.userId || null
        } : null;
        const buyer = user ? {
            _id: user._id, email: user.email, name: user.name,
            appsumoTier: user.appsumoTier, appsumoAiCap: user.appsumoAiCap,
            appsumoRedeemedAt: user.appsumoRedeemedAt, appsumoReviewStage: user.appsumoReviewStage,
            subStatus: user.subscription && user.subscription.status,
            planName: user.subscription && user.subscription.planName
        } : null;
        res.json({ found: !!(lic || user), license, buyer });
    } catch (err) {
        res.status(500).json({ message: 'Lookup failed' });
    }
});

// ---- Trial lifecycle email drip (no-card trial users) ----
async function runTrialLifecycleSweep() {
    if (mongoose.connection.readyState !== 1) return { skipped: 'no db' };
    // Expiry is a data-integrity operation, not an email side effect. Always
    // run it so admin reports and access gates do not depend on SMTP.
    const expiry = await expireNoCardTrials();
    if (!mailer.isMailerConfigured()) return { expired: expiry.modifiedCount, skipped: 'no smtp' };
    if (String(process.env.TRIAL_LIFECYCLE_EMAILS || '1') === '0') return { expired: expiry.modifiedCount, skipped: 'disabled' };
    const appUrl = (process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro').replace(/\/$/, '');
    const dashUrl = `${appUrl}/dashboard.html`;
    const ownerEmail = mailer.config().owner || 'avinashsreekumar007@gmail.com';
    const excludedEmails = new Set([ownerEmail.toLowerCase(), 'avinashsreekumar007@gmail.com', 'avinashsreekumar0007@gmail.com']);
    const now = Date.now();
    // Find all users with active trials (trialing status, trialEndsAt set, not opted out).
    const users = await User.find({
        'subscription.status': { $in: ['trialing', 'cancelled'] },
        'subscription.trialEndsAt': { $ne: null },
        stripeSubscriptionId: null,
        appsumoRedeemedAt: null,
        trialEmailsOptOut: { $ne: true },
        // $lt alone skips docs missing the field — trials predating this field have
        // no trialEmailStage, so match "missing OR < 2" or they'd be silently skipped.
        $or: [{ trialEmailStage: { $exists: false } }, { trialEmailStage: { $lt: 2 } }]
    }).limit(200);
    let sent = 0;
    for (const u of users) {
        try {
            // Skip owner and test accounts.
            if (excludedEmails.has((u.email || '').toLowerCase())) continue;
            const trialEndsAt = new Date(u.subscription.trialEndsAt).getTime();
            const msLeft = trialEndsAt - now;
            const daysLeft = Math.ceil(msLeft / (24 * 3600 * 1000));
            // Email 1: 2 days before expiry (0 < msLeft <= 2*24h).
            if (msLeft > 0 && u.subscription.status === 'trialing' && daysLeft <= 2 && (u.trialEmailStage || 0) < 1) {
                const unsubUrl = `${appUrl}/api/trial/unsubscribe?token=${trialUnsubToken(u._id)}`;
                const mail = mailer.trialEndingEmail(u.name, appUrl, daysLeft, dashUrl, unsubUrl);
                if (await mailer.sendMail({ to: u.email, subject: mail.subject, html: mail.html, text: mail.text })) {
                    u.trialEmailStage = 1;
                    await u.save().catch(() => {});
                    sent++;
                }
            }
            // Email 2: after expiry (msLeft <= 0)
            else if (msLeft <= 0 && (u.trialEmailStage || 0) < 2) {
                const unsubUrl = `${appUrl}/api/trial/unsubscribe?token=${trialUnsubToken(u._id)}`;
                const mail = mailer.trialExpiredEmail(u.name, appUrl, dashUrl, unsubUrl);
                if (await mailer.sendMail({ to: u.email, subject: mail.subject, html: mail.html, text: mail.text })) {
                    u.trialEmailStage = 2;
                    await u.save().catch(() => {});
                    sent++;
                }
            }
        } catch (_) { /* per-user fail-open */ }
    }
    return { eligible: users.length, sent, expired: expiry.modifiedCount };
}

function startAppSumoJobs() {
    // Daily tick; appsumoReviewStage enforces the drip cadence and survives restarts.
    // Reconcile runs alongside as a belt-and-suspenders on the deactivate webhook.
    const tick = () => {
        runAppSumoReviewSweep().then((r) => console.log('[appsumo] review sweep', JSON.stringify(r))).catch(() => {});
        runAppSumoReconcile().then((r) => console.log('[appsumo] reconcile', JSON.stringify(r))).catch(() => {});
    };
    setTimeout(tick, 150 * 1000);
    setInterval(tick, 24 * 3600 * 1000);
    console.log('[appsumo] review drip + reconcile scheduled daily');
}

function startTrialLifecycleJobs() {
    // Daily tick; trialEmailStage enforces the drip cadence and survives restarts.
    const tick = () => {
        runTrialLifecycleSweep().then((r) => console.log('[trial] lifecycle sweep', JSON.stringify(r))).catch(() => {});
    };
    setTimeout(tick, 160 * 1000);
    setInterval(tick, 24 * 3600 * 1000);
    console.log('[trial] lifecycle emails scheduled daily');
}

// ---- Release-1 customer ambassador referrals --------------------------------
// Feature-gated and intentionally manual: no invitation email, payout, price,
// coupon or entitlement is changed by these routes.  An operator turns the
// flag on only after setting AFFILIATE_COOKIE_SECRET and reviewing the
// reconciliation report.
const affiliateMutationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000,
    max: 30,
    standardHeaders: true,
    legacyHeaders: false,
    skip: () => !affiliateProgram.isEnabled()
});

function affiliateFeatureEnabled(res) {
    if (!affiliateProgram.isEnabled()) {
        res.status(404).json({ message: 'Referral program is not enabled.' });
        return false;
    }
    if (!affiliateProgram.cookieSecret()) {
        res.status(503).json({ message: 'Referral program is not configured.' });
        return false;
    }
    return true;
}

function affiliateCookieDomain(req) {
    const host = String(req?.hostname || '').toLowerCase();
    return host === 'stockportfolio.pro' || host.endsWith('.stockportfolio.pro') ? 'stockportfolio.pro' : null;
}

async function uniqueAffiliateSlug() {
    const { AffiliateProfile } = affiliateProgram.models();
    for (let i = 0; i < 8; i++) {
        const candidate = `amb-${affiliateProgram.randomId(8).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 12)}`;
        if (!(await AffiliateProfile.exists({ slug: candidate }))) return candidate;
    }
    throw new Error('Unable to allocate a referral slug');
}

function affiliateAdminAuth(req, res, next) {
    if (!affiliateProgram.isEnabled()) return res.status(404).json({ message: 'Referral program is not enabled.' });
    const token = process.env.ADMIN_TOKEN;
    const provided = req.headers['x-admin-token'];
    if (!token || !timingSafeStrEqual(provided, token)) return res.status(403).json({ message: 'Forbidden' });
    return next();
}

async function affiliateCandidateReport({ limit = 500 } = {}) {
    const paidStatus = ['active', 'trialing', 'cancel_at_period_end'];
    const users = await User.find({
        $or: [
            { appsumoRedeemedAt: { $ne: null } },
            { stripeCustomerId: { $ne: null }, 'subscription.status': { $in: paidStatus } },
            { stripeSubscriptionId: { $ne: null }, 'subscription.status': { $in: paidStatus } }
        ]
    }, {
        name: 1, email: 1, createdAt: 1, updatedAt: 1, appsumoLicenseKey: 1, appsumoTier: 1,
        appsumoRedeemedAt: 1, stripeCustomerId: 1, stripeSubscriptionId: 1, subscription: 1
    }).sort({ createdAt: 1 }).limit(Math.min(Math.max(Number(limit) || 500, 1), 2000)).lean();
    const { AffiliateProfile } = affiliateProgram.models();
    const profiles = await AffiliateProfile.find({ userId: { $in: users.map((u) => u._id) } }).lean();
    const byUser = new Map(profiles.map((p) => [String(p.userId), p]));
    const meaningfulByUser = new Map();
    if (users.length && mongoose.connection.readyState === 1) {
        const meaningful = await mongoose.connection.collection('funnel_events').aggregate([
            { $match: { userId: { $in: users.map((u) => String(u._id)) }, event: { $in: ['activation', 'free_tool_complete', 'paid', 'appsumo_redemption', 'tool_complete'] } } },
            { $group: { _id: '$userId', lastAt: { $max: { $ifNull: ['$at', '$timestamp'] } } } }
        ]).toArray().catch(() => []);
        meaningful.forEach((row) => meaningfulByUser.set(String(row._id), row.lastAt || null));
    }
    return users.map((u) => {
        const profile = byUser.get(String(u._id));
        const appsumo = Boolean(u.appsumoRedeemedAt);
        const stripeLinked = Boolean(u.stripeCustomerId || u.stripeSubscriptionId);
        const stripeActive = stripeLinked && paidStatus.includes(String(u.subscription?.status || ''));
        const warning = stripeLinked && !stripeActive ? 'stripe_linked_but_not_active' : null;
        const verifiedPurchase = appsumo || stripeActive;
        const customerStatus = profile?.customerStatus || 'needs_support';
        return {
            userId: String(u._id), name: u.name || null, email: u.email || null,
            purchaseSource: appsumo ? 'appsumo' : stripeActive ? 'stripe' : stripeLinked ? 'stripe_unverified' : 'unknown',
            planId: u.subscription?.planId || null, planName: u.subscription?.planName || null,
            appsumoTier: u.appsumoTier || null, appsumoRedeemedAt: u.appsumoRedeemedAt || null,
            stripeLinked, stripeActive, warning, verifiedPurchase,
            supportStatus: customerStatus, ambassadorEligibility: verifiedPurchase && !warning && customerStatus === 'successful_user' ? 'eligible' : 'not_ready',
            lastLoginOrUpdateAt: u.updatedAt || u.createdAt || null,
            lastMeaningfulUseAt: meaningfulByUser.get(String(u._id)) || null,
            profile: affiliateProgram.publicProfile(profile, process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro')
        };
    });
}

async function handleAffiliateReferral(req, res) {
    if (!affiliateProgram.isEnabled()) return res.status(404).send('Referral program is not enabled.');
    if (!affiliateProgram.cookieSecret()) return res.status(503).send('Referral program is temporarily unavailable.');
    const slug = String(req.params.slug || req.params.id || '').trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(slug)) return res.status(404).send('Referral link not found.');
    try {
        const { AffiliateProfile } = affiliateProgram.models();
        const profile = await AffiliateProfile.findOne({ slug, status: 'active' }).lean();
        if (!profile) return res.status(404).send('Referral link not found.');
        const clickId = affiliateProgram.randomId(16);
        const destination = affiliateProgram.safeDestination(req.query.destination);
        await affiliateProgram.recordReferralClick({ profile, clickId, destination, landingPath: req.query.landing, req });
        const value = affiliateProgram.createReferralCookieValue({ slug, clickId, secret: affiliateProgram.cookieSecret() });
        const cookie = affiliateProgram.serializeReferralCookie(value, {
            secure: process.env.NODE_ENV === 'production' || Boolean(req.secure),
            domain: affiliateCookieDomain(req)
        });
        if (cookie) res.setHeader('Set-Cookie', cookie);
        trackFunnel('affiliate_click', null, null, { affiliateSlug: slug, referralClickId: clickId, destination, ...marketingRequestFields(req, res) });
        const target = destination === 'appsumo' ? affiliateProgram.appSumoUrl() : destination === 'pricing' ? '/#pricing' : '/';
        return res.redirect(302, target);
    } catch (error) {
        console.error('[affiliate] redirect failed:', error && error.message);
        return res.status(503).send('Referral link is temporarily unavailable.');
    }
}

app.get('/api/affiliate/me', authMiddleware, async (req, res) => {
    if (!affiliateFeatureEnabled(res)) return;
    const { AffiliateProfile, ReferralOrder, Commission } = affiliateProgram.models();
    const profile = await AffiliateProfile.findOne({ userId: req.userId }).lean();
    if (!profile) return res.status(404).json({ eligible: false, message: 'No ambassador invitation is available for this account.' });
    const [orders, commissions] = await Promise.all([
        ReferralOrder.find({ affiliateProfileId: profile._id }).sort({ purchasedAt: -1 }).limit(100).lean(),
        Commission.find({ affiliateProfileId: profile._id }).sort({ createdAt: -1 }).limit(100).lean()
    ]);
    const totals = commissions.reduce((out, c) => {
        const key = c.status === 'paid' ? 'paidMinor' : c.status === 'approved' ? 'approvedMinor' : c.status === 'pending' ? 'pendingMinor' : 'reversedMinor';
        out[key] += Math.max(0, Number(c.amountMinor || 0) - Number(c.reversalMinor || 0)); return out;
    }, { pendingMinor: 0, approvedMinor: 0, paidMinor: 0, reversedMinor: 0 });
    res.set('Cache-Control', 'no-store').json({ eligible: true, profile: affiliateProgram.publicProfile(profile, process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro'), clicks: await affiliateProgram.models().ReferralClick.countDocuments({ affiliateProfileId: profile._id }), purchases: orders.filter((o) => ['paid', 'pending_reconciliation'].includes(o.status)).length, totals, orders: orders.map((o) => ({ provider: o.provider, status: o.status, planId: o.planId, currency: o.currency, purchasedAt: o.purchasedAt })), disclosure: profile.disclosure });
});

app.post('/api/affiliate/accept', authMiddleware, affiliateMutationLimiter, async (req, res) => {
    if (!affiliateFeatureEnabled(res)) return;
    if (req.body?.acceptTerms !== true) return res.status(400).json({ message: 'You must accept the ambassador terms before activating the link.' });
    const { AffiliateProfile } = affiliateProgram.models();
    const profile = await AffiliateProfile.findOne({ userId: req.userId });
    if (!profile) return res.status(404).json({ message: 'No ambassador invitation is available for this account.' });
    if (profile.status === 'suspended' || profile.status === 'declined') return res.status(409).json({ message: 'This invitation is not active.' });
    profile.status = 'active'; profile.customerStatus = 'ambassador_active'; profile.termsAcceptedAt = new Date(); profile.activatedAt = profile.activatedAt || new Date(); await profile.save();
    await affiliateProgram.writeAudit('ambassador_activated', String(req.user?.email || req.userId), { affiliateProfileId: profile._id });
    trackFunnel('ambassador_activated', req.userId, req.user?.subscription?.planName, { affiliateProfileId: String(profile._id) });
    return res.json({ ok: true, profile: affiliateProgram.publicProfile(profile, process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro') });
});

app.get('/affiliate', authMiddleware, async (req, res) => {
    if (!affiliateProgram.isEnabled()) return res.status(404).send('Referral program is not enabled.');
    if (!affiliateProgram.cookieSecret()) return res.status(503).send('Referral program is temporarily unavailable.');
    const { AffiliateProfile } = affiliateProgram.models();
    const profile = await AffiliateProfile.findOne({ userId: req.userId }).lean();
    if (!profile) return res.status(404).send('No ambassador invitation is available for this account.');
    const safe = JSON.stringify(affiliateProgram.publicProfile(profile, process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro')).replace(/</g, '\\u003c');
    res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Customer ambassador — StockPortfolio.pro</title><style>body{margin:0;background:#f7f8fa;color:#18202a;font:16px/1.55 system-ui,-apple-system,Segoe UI,sans-serif}.wrap{max-width:720px;margin:40px auto;padding:0 20px}.card{background:#fff;border:1px solid #e1e5e9;border-radius:16px;padding:24px;margin:16px 0}h1{margin:0 0 8px}.muted{color:#66717d}.url{display:block;padding:12px;background:#f1f3f5;border-radius:10px;word-break:break-all}.btn{background:#e8412e;color:#fff;border:0;border-radius:9px;padding:11px 15px;font-weight:700;cursor:pointer}.btn[disabled]{opacity:.5;cursor:not-allowed}.fine{font-size:13px;color:#66717d}.error{color:#b3261e}</style></head><body><main class="wrap"><p class="muted">StockPortfolio.pro · Founding customer program</p><h1>Your referral link</h1><section class="card"><p>Share StockPortfolio.pro only with people who genuinely want source-backed investment research.</p><p class="url" id="url"></p><button class="btn" id="copy">Copy link</button><button class="btn" id="accept" style="margin-left:8px;display:none">Accept terms &amp; activate</button><p class="fine">Disclosure: I may earn a commission if you purchase through this link. No investment returns are promised, and this is not personal financial advice.</p><p id="terms" class="fine"></p><p id="error" class="error"></p></section><section class="card"><h2>Forwardable message</h2><p id="message"></p><p class="fine">Commissions are held until refunds/chargebacks clear and are approved manually. There are no automatic payouts.</p></section><script>const P=${safe};const terms=document.getElementById('terms');const accept=document.getElementById('accept');const copy=document.getElementById('copy');document.getElementById('url').textContent=P.referralUrl;document.getElementById('message').textContent='I use StockPortfolio.pro to research stocks, ETFs and portfolios against original sources. Try it here: '+P.referralUrl+' Disclosure: I may earn a commission if you purchase through this link.';if(P.status==='active'){terms.textContent='Your link is active.';}else{terms.textContent='Read the disclosure above, then activate your invitation when you are ready.';copy.disabled=true;accept.style.display='inline-block';accept.onclick=async()=>{accept.disabled=true;const r=await fetch('/api/affiliate/accept',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({acceptTerms:true})});if(r.ok)location.reload();else{document.getElementById('error').textContent='We could not activate the link yet. Please try again shortly.';accept.disabled=false;}};}copy.onclick=()=>{if(!copy.disabled&&navigator.clipboard)navigator.clipboard.writeText(P.referralUrl);};</script></main></body></html>`);
});

app.get('/api/admin/affiliates/reconciliation', affiliateAdminAuth, async (req, res) => {
    try { res.set('Cache-Control', 'no-store').json({ generatedAt: new Date().toISOString(), candidates: await affiliateCandidateReport({ limit: req.query.limit }) }); }
    catch (error) { console.error('[affiliate] reconciliation failed:', error && error.message); res.status(500).json({ message: 'Referral reconciliation failed' }); }
});

app.get('/api/admin/affiliates', affiliateAdminAuth, async (req, res) => {
    try {
        const { AffiliateProfile, ReferralClick, ReferralOrder, Commission } = affiliateProgram.models();
        const profiles = await AffiliateProfile.find({}).sort({ createdAt: -1 }).limit(1000).lean();
        const rows = await Promise.all(profiles.map(async (profile) => {
            const [clicks, orders, commissions] = await Promise.all([
                ReferralClick.countDocuments({ affiliateProfileId: profile._id }),
                ReferralOrder.find({ affiliateProfileId: profile._id }).lean(),
                Commission.find({ affiliateProfileId: profile._id }).lean()
            ]);
            const totals = commissions.reduce((out, c) => { const key = c.status === 'paid' ? 'paidMinor' : c.status === 'approved' ? 'approvedMinor' : c.status === 'pending' ? 'pendingMinor' : 'reversedMinor'; out[key] += Math.max(0, Number(c.amountMinor || 0) - Number(c.reversalMinor || 0)); return out; }, { pendingMinor: 0, approvedMinor: 0, paidMinor: 0, reversedMinor: 0 });
            return { ...affiliateProgram.publicProfile(profile, process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro'), userId: String(profile.userId), clicks, purchases: orders.filter((o) => ['paid', 'pending_reconciliation'].includes(o.status)).length, grossReferredRevenueMinor: orders.reduce((n, o) => n + Math.max(0, Number(o.grossCollectedMinor || 0)), 0), refundsMinor: orders.reduce((n, o) => n + Math.max(0, Number(o.refundedMinor || 0)), 0), ...totals };
        }));
        res.set('Cache-Control', 'no-store').json({ generatedAt: new Date().toISOString(), ambassadors: rows });
    } catch (error) { console.error('[affiliate] admin list failed:', error && error.message); res.status(500).json({ message: 'Referral admin data unavailable' }); }
});

app.post('/api/admin/affiliates/status', affiliateAdminAuth, affiliateMutationLimiter, async (req, res) => {
    const status = String(req.body?.status || '').trim().toLowerCase();
    if (!affiliateProgram.STATUS_VALUES.includes(status)) return res.status(400).json({ message: 'Invalid customer status.' });
    const email = String(req.body?.email || '').trim().toLowerCase();
    const user = req.body?.userId ? await User.findById(req.body.userId) : await User.findOne({ email });
    if (!user) return res.status(404).json({ message: 'Customer account not found.' });
    const { AffiliateProfile } = affiliateProgram.models();
    let profile = await AffiliateProfile.findOne({ userId: user._id });
    if (!profile) profile = await AffiliateProfile.create({ userId: user._id, slug: await uniqueAffiliateSlug(), customerStatus: status, status: 'invited' });
    else { profile.customerStatus = status; await profile.save(); }
    await affiliateProgram.writeAudit('customer_status_changed', String(req.headers['x-admin-actor'] || 'admin'), { affiliateProfileId: profile._id, targetId: String(user._id), status });
    return res.json({ ok: true, profile: affiliateProgram.publicProfile(profile, process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro') });
});

app.post('/api/admin/affiliates/invite', affiliateAdminAuth, affiliateMutationLimiter, async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const user = req.body?.userId ? await User.findById(req.body.userId) : await User.findOne({ email });
    if (!user) return res.status(404).json({ message: 'Customer account not found.' });
    const paid = Boolean(user.appsumoRedeemedAt) || (Boolean(user.stripeCustomerId || user.stripeSubscriptionId) && ['active', 'trialing', 'cancel_at_period_end'].includes(String(user.subscription?.status || '')));
    if (!paid) return res.status(409).json({ message: 'Only verified paying customers can be invited.' });
    const { AffiliateProfile } = affiliateProgram.models();
    let profile = await AffiliateProfile.findOne({ userId: user._id });
    if (profile && profile.customerStatus !== 'successful_user') return res.status(409).json({ message: 'Mark this customer as successful_user after onboarding before inviting them.' });
    if (!profile) profile = await AffiliateProfile.create({ userId: user._id, slug: await uniqueAffiliateSlug(), customerStatus: 'successful_user' });
    profile.status = 'invited'; profile.customerStatus = 'ambassador_invited'; profile.invitedAt = new Date(); await profile.save();
    await affiliateProgram.writeAudit('ambassador_invited', String(req.headers['x-admin-actor'] || 'admin'), { affiliateProfileId: profile._id, targetId: String(user._id) });
    trackFunnel('ambassador_invited', user._id, user.subscription?.planName, { affiliateProfileId: String(profile._id) });
    return res.json({ ok: true, sentEmail: false, profile: affiliateProgram.publicProfile(profile, process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro') });
});

app.post('/api/admin/affiliates/:id/suspend', affiliateAdminAuth, affiliateMutationLimiter, async (req, res) => {
    const { AffiliateProfile } = affiliateProgram.models();
    const profile = await AffiliateProfile.findById(req.params.id);
    if (!profile) return res.status(404).json({ message: 'Ambassador not found.' });
    const suspended = req.body?.suspended !== false;
    profile.status = suspended ? 'suspended' : 'active';
    profile.suspendedAt = suspended ? new Date() : null;
    if (!suspended && !profile.termsAcceptedAt) return res.status(409).json({ message: 'The ambassador must accept the terms before reactivation.' });
    await profile.save();
    await affiliateProgram.writeAudit(suspended ? 'ambassador_suspended' : 'ambassador_reactivated', String(req.headers['x-admin-actor'] || 'admin'), { affiliateProfileId: profile._id });
    res.json({ ok: true, status: profile.status });
});

app.get('/api/admin/affiliates/commissions', affiliateAdminAuth, async (req, res) => {
    const { Commission } = affiliateProgram.models();
    const commissions = await Commission.find({}).sort({ createdAt: -1 }).limit(2000).lean();
    res.set('Cache-Control', 'no-store').json({ commissions: commissions.map((c) => ({ ...c, _id: String(c._id), affiliateProfileId: String(c.affiliateProfileId), referralOrderId: String(c.referralOrderId) })) });
});

app.get('/api/admin/affiliates/webhooks/health', affiliateAdminAuth, async (req, res) => {
    const { ProcessedWebhookEvent } = affiliateProgram.models();
    const [count, latest] = await Promise.all([
        ProcessedWebhookEvent.countDocuments({}),
        ProcessedWebhookEvent.findOne({}).sort({ processedAt: -1 }).lean()
    ]);
    res.set('Cache-Control', 'no-store').json({ processedEvents: count, latest: latest ? { provider: latest.provider, eventType: latest.eventType, processedAt: latest.processedAt } : null });
});

app.post('/api/admin/affiliates/commissions/:id/approve', affiliateAdminAuth, affiliateMutationLimiter, async (req, res) => {
    const { Commission } = affiliateProgram.models();
    const commission = await Commission.findById(req.params.id);
    if (!commission) return res.status(404).json({ message: 'Commission not found.' });
    if (commission.status !== 'pending') return res.status(409).json({ message: 'Only pending commissions can be approved.' });
    if (new Date(commission.holdUntil).getTime() > Date.now()) return res.status(409).json({ message: 'The refund/chargeback hold has not elapsed.' });
    commission.status = 'approved'; await commission.save();
    await affiliateProgram.writeAudit('commission_approved', String(req.headers['x-admin-actor'] || 'admin'), { targetId: String(commission._id), affiliateProfileId: commission.affiliateProfileId });
    trackFunnel('commission_approved', null, commission.provider, { affiliateCommissionId: String(commission._id) });
    res.json({ ok: true, status: commission.status });
});

app.post('/api/admin/affiliates/payout-batches', affiliateAdminAuth, affiliateMutationLimiter, async (req, res) => {
    const { Commission, PayoutBatch } = affiliateProgram.models();
    const currency = String(req.body?.currency || 'usd').toLowerCase();
    const min = Math.max(10000, Number(req.body?.minAmountMinor) || 10000);
    const commissions = await Commission.find({ currency, status: 'approved', holdUntil: { $lte: new Date() }, payoutBatchId: null }).sort({ createdAt: 1 }).lean();
    const total = commissions.reduce((n, c) => n + Math.max(0, Number(c.amountMinor || 0) - Number(c.reversalMinor || 0)), 0);
    if (total < min) return res.status(409).json({ message: 'No eligible commissions meet the minimum payout threshold.', totalMinor: total, minimumMinor: min });
    const batch = await PayoutBatch.create({ currency, minAmountMinor: min, totalMinor: total, commissionIds: commissions.map((c) => c._id), status: 'draft' });
    await Commission.updateMany({ _id: { $in: commissions.map((c) => c._id) } }, { $set: { payoutBatchId: batch._id } });
    await affiliateProgram.writeAudit('payout_batch_created', String(req.headers['x-admin-actor'] || 'admin'), { targetId: String(batch._id), totalMinor: total });
    res.status(201).json({ ok: true, batch: { id: String(batch._id), totalMinor: total, currency, status: batch.status, automaticPayout: false } });
});

app.post('/api/admin/affiliates/payout-batches/:id/paid', affiliateAdminAuth, affiliateMutationLimiter, async (req, res) => {
    const { PayoutBatch, Commission } = affiliateProgram.models();
    const batch = await PayoutBatch.findById(req.params.id);
    if (!batch) return res.status(404).json({ message: 'Payout batch not found.' });
    if (batch.status === 'paid') return res.json({ ok: true, alreadyPaid: true });
    batch.status = 'paid'; batch.reference = String(req.body?.reference || '').slice(0, 160) || null; batch.paidAt = new Date(); await batch.save();
    await Commission.updateMany({ _id: { $in: batch.commissionIds }, status: 'approved' }, { $set: { status: 'paid', paidAt: batch.paidAt } });
    await affiliateProgram.writeAudit('payout_marked_paid', String(req.headers['x-admin-actor'] || 'admin'), { targetId: String(batch._id), reference: batch.reference });
    trackFunnel('payout_completed', null, 'affiliate', { payoutBatchId: String(batch._id) });
    res.json({ ok: true, status: batch.status, automaticPayout: false });
});

app.get('/api/admin/affiliates/payout-batches/:id.csv', affiliateAdminAuth, async (req, res) => {
    const { PayoutBatch, Commission, AffiliateProfile } = affiliateProgram.models();
    const batch = await PayoutBatch.findById(req.params.id).lean();
    if (!batch) return res.status(404).json({ message: 'Payout batch not found.' });
    const commissions = await Commission.find({ _id: { $in: batch.commissionIds || [] } }).lean();
    const profiles = await AffiliateProfile.find({ _id: { $in: commissions.map((c) => c.affiliateProfileId) } }, { slug: 1, userId: 1 }).lean();
    const byProfile = new Map(profiles.map((p) => [String(p._id), p]));
    const users = await User.find({ _id: { $in: profiles.map((p) => p.userId) } }, { email: 1 }).lean();
    const byUser = new Map(users.map((u) => [String(u._id), u]));
    const cell = (value) => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
    const lines = [
        ['batch_id', 'affiliate_slug', 'affiliate_email', 'profile_id', 'commission_id', 'provider', 'currency', 'amount_minor', 'status'].map(cell).join(',')
    ];
    commissions.forEach((c) => { const p = byProfile.get(String(c.affiliateProfileId)); const u = p && byUser.get(String(p.userId)); lines.push([String(batch._id), p?.slug || '', u?.email || '', String(c.affiliateProfileId), String(c._id), c.provider, c.currency, Math.max(0, Number(c.amountMinor || 0) - Number(c.reversalMinor || 0)), c.status].map(cell).join(',')); });
    res.set('Cache-Control', 'no-store').type('text/csv').set('Content-Disposition', `attachment; filename="affiliate-payout-${String(batch._id)}.csv"`).send(`${lines.join('\n')}\n`);
});

app.post('/api/admin/affiliates/appsumo/reconcile', affiliateAdminAuth, affiliateMutationLimiter, async (req, res) => {
    const csv = String(req.body?.csv || '');
    if (!csv || Buffer.byteLength(csv, 'utf8') > 2 * 1024 * 1024) return res.status(400).json({ message: 'Provide a CSV up to 2MB.' });
    try {
        const result = await affiliateProgram.reconcileAppSumoCsv({ csv, dryRun: req.body?.dryRun !== false, mapping: req.body?.mapping || {}, actor: String(req.headers['x-admin-actor'] || 'admin'), track: trackFunnel });
        res.set('Cache-Control', 'no-store').json(result);
    } catch (error) { console.error('[affiliate] AppSumo reconciliation failed:', error && error.message); res.status(500).json({ message: 'AppSumo reconciliation failed' }); }
});

app.get('/admin/affiliates', affiliateAdminAuth, async (req, res) => {
    try {
        const rows = await affiliateCandidateReport({ limit: 100 });
        const escape = (value) => escapeHtml(value == null ? '' : String(value));
        const body = rows.map((row) => `<tr><td>${escape(row.email)}</td><td>${escape(row.purchaseSource)}</td><td>${escape(row.planName)}</td><td>${escape(row.supportStatus)}</td><td>${escape(row.ambassadorEligibility)}</td><td>${row.profile ? `<a href="${escape(row.profile.referralUrl)}">link</a>` : '—'}</td></tr>`).join('');
        res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><title>Affiliate operations — StockPortfolio.pro</title><style>body{font:14px/1.5 system-ui;margin:24px;color:#172033}table{border-collapse:collapse;width:100%;overflow:auto}th,td{padding:8px;border-bottom:1px solid #ddd;text-align:left;white-space:nowrap}th{font-size:12px;color:#66717d;text-transform:uppercase}.note{color:#66717d}</style><h1>Customer ambassador operations</h1><p class="note">Read-only candidate reconciliation. Invitations, commission approvals and payouts are manual API actions; no emails or automatic payouts are sent.</p><table><tr><th>Email</th><th>Source</th><th>Plan</th><th>Support status</th><th>Eligibility</th><th>Referral</th></tr>${body || '<tr><td colspan="6">No verified paying candidates</td></tr>'}</table>`);
    } catch (error) { console.error('[affiliate] admin page failed:', error && error.message); res.status(500).send('Affiliate operations unavailable'); }
});

// Anything that reached this point matches no page, file, or route. Serving
// the homepage here (the old behavior) made every bad URL a 200 "soft 404"
// that wastes crawl budget and pollutes the index — return a real 404.
app.get('*', (req, res) => {
    res.status(404).sendFile(path.join(__dirname, '../frontend-v2/404.html'));
});

// Start the server
const PORT = process.env.PORT || 5000;
const server = app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
server.requestTimeout = Number(process.env.HTTP_REQUEST_TIMEOUT_MS || 130000);
server.headersTimeout = Number(process.env.HTTP_HEADERS_TIMEOUT_MS || 15000);
server.keepAliveTimeout = Number(process.env.HTTP_KEEPALIVE_TIMEOUT_MS || 5000);
// Warm the SSR cache's dedicated /sitemap.xml slot ONCE, deferred via
// setImmediate (inside warmSitemap) so the multi-second cold buildSitemap()
// parse runs off the health-check critical path instead of blocking the
// 0.5-CPU loop on Googlebot's first post-deploy hit.
try { ssrCache.warmSitemap(ssrCacheMw, () => seoPages.buildSitemap()); } catch (e) { console.log('[ssr-cache] sitemap warm skipped:', e && e.message); }
watchdog.start();
gurus.start();
startDigest();
startAppSumoJobs();
startTrialLifecycleJobs();
// Dossier pre-warming is expensive because each dossier composes several AI
// sections. Keep it off in every environment unless an operator explicitly
// opts in; customer-requested dossiers continue to build on demand and persist
// in Mongo.
try {
    const dossierPrewarm = require('./prewarm');
    if (dossierPrewarm.shouldStart()) {
        dossierPrewarm.start({ n: Number(process.env.PREWARM_TICKERS) || 300 });
    } else {
        console.log('[prewarm] disabled (set PREWARM=on to enable explicitly)');
    }
} catch (e) { console.log('[prewarm] not started:', e && e.message); }
// Optional: nightly SEC bulk companyfacts (inert unless SEC_BULK_DIR is set).
try { require('./companyfacts-bulk').start(); } catch (e) { console.log('[companyfacts-bulk] not started:', e && e.message); }
