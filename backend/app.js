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
const fundHoldings = require('./fund-holdings');
const fundFees = require('./fund-fees');
const storedFundamentals = require('./stored-fundamentals');
const secSource = require('./sec-source');
const aiBriefing = require('./ai-briefing');
const aiFeatures = require('./ai-features');
const aiChat = require('./ai-chat');
const credits = require('./credits');
const aiPaper = require('./ai-paper-portfolio');
const shareCopy = require('./share-copy');
const freeTools = require('./free-tools');
const verifyHeadline = require('./verify');
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
const directLtd = require('./direct-ltd');
const briefingSubscription = require('./briefing-subscription');
const pricingExperiment = require('./pricing-experiment');
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
// Pre-grant: give first, invoice second. An admin can hand an account a
// time-boxed feature grant with no billing attached (scripts/grant-trial.js);
// it opens the gate until expiresAt and not one minute longer — expiry is read
// straight off the record here, so a missed cron run can never silently extend
// access.
const { hasActiveTrialGrant } = require('../lib/trial-grant');
// Needed by hasMonitor() below — declared here rather than further down the
// file so the reference is unambiguously initialised before any call.
const tierLimits = require('../lib/tier-limits');
const trialExpiryCheck = require('../jobs/trial-expiry-check');

// The Filing Change Monitor. Power/Desk get it uncapped; lifetime buyers get
// it capped to their tier's company count (lib/tier-limits.js). It stopped
// being the Power/Desk differentiator once the numbers were in: reports are
// cached per (symbol, accession) and shared by every reader, so an additional
// Monitor user costs nothing on a company already built, and the paid tier it
// was protecting was one account that had never opened it. Plan-based, so it
// still doesn't disturb the free<core<pro ladder every other gate relies on.
function hasMonitor(req) {
    const sub = req.subscription || (req.user && req.user.subscription) || {};
    const active = ['active', 'trialing', 'cancel_at_period_end'].includes(sub.status);
    if (active && ['power', 'power-monthly', 'desk', 'enterprise', 'pro-annual'].includes(sub.planId)) return true;
    if (tierLimits.isLifetimeBuyer(req.user)) return true;
    return hasActiveTrialGrant(req.user, 'monitor');
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
// Ask carries attachments (pics up to ~1.3MB base64 + doc extracts) in the
// chat POST body — far past the 100kb default. That route parses itself with a
// dedicated limit; the two must stay in sync or the global parser 413s first.
const ASK_CHAT_PATH = '/api/ai/chat';
const askChatParser = express.json({ limit: '16mb' });
// Broker CSV exports run to a few hundred KB — past the 100kb default.
const CSV_IMPORT_PATHS = new Set(['/api/portfolio/import/preview', '/api/portfolio/import/commit']);
const csvImportParser = express.json({ limit: '5mb' });
const ASK_ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024; // per attachment
const ASK_ATTACHMENT_MAX_COUNT = 3;
const ASK_ATTACHMENT_TEXT_CAP = 8000; // extracted chars kept per document
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
  } else if (CSV_IMPORT_PATHS.has(req.path)) {
    csvImportParser(req, res, (err) => {
      if (err) return res.status(413).json({ message: 'That CSV is too large — split it into smaller files.' });
      next();
    });
  } else if (req.path === ASK_CHAT_PATH) {
    askChatParser(req, res, (err) => {
      if (err) return res.status(413).json({ message: 'That request is too large — try smaller attachments.' });
      next();
    });
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
        'https://scripts.clarity.ms',
        'https://js.stripe.com'
      ],
      styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com', 'https://accounts.google.com'],
      fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
      imgSrc: ["'self'", 'data:', 'blob:', 'https:'],
      connectSrc: ["'self'", 'https:'],
      frameSrc: ["'self'", 'https://accounts.google.com', 'https://www.youtube.com', 'https://www.youtube-nocookie.com', 'https://js.stripe.com', 'https://checkout.stripe.com'],
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

// Post-checkout claim. Looser than signup because a paying customer may retry
// the return (refresh, flaky network, a second tab) and must not be locked out
// of the account they just paid for; still bounded, because the endpoint mints
// a session from a checkout session id.
const checkoutClaimLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false
});

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
// These defaults mirror the active self-serve Stripe prices. Environment
// variables remain the source of truth when prices are intentionally changed.
// 2026-08-31 Jobs cut: four prices a visitor can buy —
// $24.99/mo · $199.99/yr · Pro $499.99/yr · Desk $1,999.99/yr. The Pro and
// Power rungs are retired from the menus (legacy subscribers keep their
// legacy price ids at the old amounts via LEGACY_PLAN_PRICE_SPECS below).
// DEPLOY GATE: the matching active Stripe prices (same product, amount and
// interval) must exist and STRIPE_PRICE_ID_* must point at them before this
// ships — resolveStripeCheckoutPlan refuses to sell a plan whose Stripe price
// doesn't match, so an early deploy fails safe but sells nothing.
const CORE_PLAN_PRICE = parseFloat(process.env.CORE_PLAN_PRICE || '24.99');
const CORE_PLAN_CURRENCY = process.env.CORE_PLAN_CURRENCY || 'USD';
const ANNUAL_PLAN_PRICE = parseFloat(process.env.ANNUAL_PLAN_PRICE || '199.99');
const ANNUAL_PLAN_CURRENCY = process.env.ANNUAL_PLAN_CURRENCY || CORE_PLAN_CURRENCY;
const PRO_PLAN_PRICE = parseFloat(process.env.PRO_PLAN_PRICE || '79.99'); // retired rung — legacy only
const PRO_ANNUAL_PLAN_PRICE = parseFloat(process.env.PRO_ANNUAL_PLAN_PRICE || '499.99');
// Premium Filing Monitor tiers — both unlock the full Pro feature set; differ
// only by price, positioning and support. USD, billed yearly.
const POWER_PLAN_ID = 'power';
const DESK_PLAN_ID = 'desk';
const POWER_PLAN_PRICE = parseFloat(process.env.POWER_PLAN_PRICE || '1499.99');
const POWER_PLAN_CURRENCY = process.env.POWER_PLAN_CURRENCY || 'USD';
// Power, billed monthly — same access as annual Power, lower activation friction.
const POWER_MONTHLY_PLAN_ID = 'power-monthly';
const POWER_MONTHLY_PLAN_PRICE = parseFloat(process.env.POWER_MONTHLY_PLAN_PRICE || '149.99');
const POWER_MONTHLY_PLAN_CURRENCY = process.env.POWER_MONTHLY_PLAN_CURRENCY || 'USD';
const DESK_PLAN_PRICE = parseFloat(process.env.DESK_PLAN_PRICE || '1999.99');
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
// Credit top-up: a one-time payment that adds CREDIT_TOPUP_CREDITS to the
// buyer's current-month wallet (credits.grant()). Priced above the Pro plan's
// bundled per-credit rate on purpose so packs can't under undercut plans; the
// /recharge page states the maths. STRIPE_PRICE_ID_CREDITS_TOPUP must point at
// an ACTIVE one-time price charging exactly CREDIT_TOPUP_PRICE — a stale or
// mispriced price refuses to sell rather than charging the wrong amount.
const CREDIT_TOPUP_PRICE = parseFloat(process.env.CREDIT_TOPUP_PRICE || '14.99');
const CREDIT_TOPUP_CREDITS = parseInt(process.env.CREDIT_TOPUP_CREDITS || '150', 10);
const STRIPE_PRICE_ID_CREDITS_TOPUP = process.env.STRIPE_PRICE_ID_CREDITS_TOPUP || '';
// A missing or stale Price ID must not turn a configured Stripe account into a
// broken checkout. This is deliberately narrow: it resolves only the published
// direct-purchase plans by their exact product, amount and recurring interval.
// It also neutralizes legacy display variables that no longer match Stripe.
// New-sale checkout specs: the four surviving rungs only. Pro (monthly) and
// both Power variants are intentionally ABSENT — a plan absent here cannot be
// freshly purchased (resolveStripeCheckoutPlan refuses), while grand-fathered
// subscribers never hit this map (their price ids resolve through
// LEGACY_PLAN_PRICE_SPECS first).
const CHECKOUT_STRIPE_PRICE_SPECS = Object.freeze({
  [MONTHLY_PLAN_ID]: { amount: 24.99, currency: 'USD', interval: 'month', productName: 'stockportfolio.pro' },
  [ANNUAL_PLAN_ID]: { amount: 199.99, currency: 'USD', interval: 'year', productName: 'stockportfolio.pro' },
  [PRO_ANNUAL_PLAN_ID]: { amount: 499.99, currency: 'USD', interval: 'year', productName: 'stockportfolio.pro' },
  [DESK_PLAN_ID]: { amount: 1999.99, currency: 'USD', interval: 'year', productName: 'desk — stockportfolio.pro' }
});
// Grandfathered subscribers keep their pre-reprice Stripe price until they
// move to a new one. Webhook re-syncs resolve a renewal by the price id the
// subscription actually carries; these optional env vars keep that lookup
// (and the stored price display) pointing at the OLD amount instead of
// silently rewriting legacy subscribers to the new price. The owner sets
// each to the previous Stripe Price ID when the new ones go live; a plan
// without a legacy id simply resolves from the subscriber's stored planId.
const LEGACY_PLAN_PRICE_SPECS = Object.freeze({
  [MONTHLY_PLAN_ID]: { priceId: process.env.LEGACY_STRIPE_PRICE_ID_MONTHLY || process.env.STRIPE_PRICE_ID || '', price: 12.00, currency: 'USD', interval: 'month' },
  [ANNUAL_PLAN_ID]: { priceId: process.env.LEGACY_STRIPE_PRICE_ID_ANNUAL || '', price: 118.00, currency: 'USD', interval: 'year' },
  [PRO_PLAN_ID]: { priceId: process.env.LEGACY_STRIPE_PRICE_ID_PRO || '', price: 33.00, currency: 'USD', interval: 'month' },
  [PRO_ANNUAL_PLAN_ID]: { priceId: process.env.LEGACY_STRIPE_PRICE_ID_PRO_ANNUAL || '', price: 250.00, currency: 'USD', interval: 'year' },
  [POWER_PLAN_ID]: { priceId: process.env.LEGACY_STRIPE_PRICE_ID_POWER || '', price: 579.00, currency: 'USD', interval: 'year' },
  [POWER_MONTHLY_PLAN_ID]: { priceId: process.env.LEGACY_STRIPE_PRICE_ID_POWER_MONTHLY || '', price: 64.00, currency: 'USD', interval: 'month' },
  [DESK_PLAN_ID]: { priceId: process.env.LEGACY_STRIPE_PRICE_ID_DESK || '', price: 1961.00, currency: 'USD', interval: 'year' }
});
const SELF_SERVE_PRICE_LOOKUP_TTL_MS = 5 * 60 * 1000;

// China wallet checkout (Alipay / WeChat Pay). Both are structurally
// incompatible with Stripe Checkout's `mode: 'subscription'` (Stripe: "Not
// supported when using Checkout in subscription mode or setup mode" for
// both), and true Stripe-managed recurring billing for either is a Stripe
// private-preview feature this account has not been granted (confirmed via
// a live, read-only `stripe.accounts.retrieve()` capability check — neither
// `alipay_payments` nor `wechat_pay_payments` appears in `capabilities` at
// all, meaning the payment method isn't even Dashboard-enabled yet, let
// alone recurring-beta-approved). So this is a one-time `mode: 'payment'`
// annual pass, not a Stripe Subscription — `chinaAnnualExpiresAt` below is
// what actually enforces the year, since `activateSubscription`'s 'active'
// status alone never expires on its own.
// UnionPay needs no equivalent: internationally-issued UnionPay cards are
// just `card` payment method type once UnionPay is toggled on in the
// Stripe Dashboard (Settings → Payment methods) — no code path here.
const CHINA_ANNUAL_PASS_PLAN_ID = PRO_ANNUAL_PLAN_ID;
const CHINA_ANNUAL_PASS_CNY_AMOUNT = parseFloat(process.env.CHINA_ANNUAL_PASS_CNY_AMOUNT || '1788.00');
const CHINA_ANNUAL_PASS_DAYS = 365;
// Off by default: this account's Stripe capabilities don't include these
// payment methods yet (verified above), so a live checkout attempt would
// fail at Stripe. Flip on only after enabling the method in the Stripe
// Dashboard for this account.
const STRIPE_ENABLE_ALIPAY = String(process.env.STRIPE_ENABLE_ALIPAY || '').toLowerCase() === 'true';
const STRIPE_ENABLE_WECHAT_PAY = String(process.env.STRIPE_ENABLE_WECHAT_PAY || '').toLowerCase() === 'true';
function chinaCheckoutPaymentMethods() {
  const methods = [];
  if (STRIPE_ENABLE_ALIPAY) methods.push('alipay');
  if (STRIPE_ENABLE_WECHAT_PAY) methods.push('wechat_pay');
  return methods;
}
const selfServePriceLookupCache = new Map();
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
// In-app review prompt target. Unlike the email review URL above, this one goes
// through the validated attributed deal URL (APPSUMO_ATTRIBUTED_URL, falling
// back to share-copy's DEFAULT_APPSUMO_DEAL_URL) so an in-app click keeps
// partner attribution, then anchors to the reviews section on arrival.
function appsumoReviewPromptUrl() {
    return `${APPSUMO_OUTBOUND_URL}#reviews`;
}
// Per-license upgrade URL comes from AppSumo (license_change_plan_url) when present;
// otherwise the buyer manages/upgrades tiers from their AppSumo purchases page.
function appsumoUpgradeUrl(lic) {
    return (lic && lic.changePlanUrl) || APPSUMO_ACCOUNT_URL;
}
const stripe = stripeSecretKey ? Stripe(stripeSecretKey, { apiVersion: '2022-11-15' }) : null;
// Direct-LTD test mode (DIRECT_LTD_TEST_MODE=true / NODE_ENV=test) routes ONLY
// the direct-LTD checkout+webhook path at a separate Stripe TEST account/keys,
// so a real end-to-end test-card purchase can be exercised before
// DIRECT_LTD_ENABLED ever goes live. `stripe` above (used by every other
// checkout/webhook path) is never touched by this.
const stripeTestSecretKey = process.env.STRIPE_TEST_SECRET_KEY;
const directLtdStripe = directLtd.testModeEnabled()
    ? (stripeTestSecretKey ? Stripe(stripeTestSecretKey, { apiVersion: '2022-11-15' }) : null)
    : stripe;
const STRIPE_TEST_WEBHOOK_SECRET = process.env.STRIPE_TEST_WEBHOOK_SECRET || '';
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

// Hot-path metering collections are raw mongoose.connection.collection() access
// with no schema, so nothing ever builds indexes for them — every /api/credits
// call COLLSCANs credit_ledger three times, /api/ai/chat/quota COLLSCANs
// ai_chat_usage, and /api/ask/memory COLLSCANs personal_memory. All grow
// linearly with total usage, so these indexes are boot-critical. Idempotent:
// Mongo returns the existing index when the spec matches.
async function ensureMeteringIndexes() {
  const col = mongoose.connection.collection.bind(mongoose.connection);
  await Promise.all([
    col('credit_ledger').createIndex({ userId: 1, month: 1, at: -1 }, { name: 'credit_ledger_user_month' }),
    col('ai_chat_usage').createIndex({ userId: 1, month: 1 }, { name: 'ai_chat_usage_user_month' }),
    col('personal_memory').createIndex({ userId: 1 }, { name: 'personal_memory_user' })
  ]).catch((indexError) => console.warn('[metering] index creation unavailable:', indexError && indexError.message));
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
      // One-shot: carry legacy ask_memories rows into personal_memory and flip
      // pre-default opt-outs back ON (marker-guarded — user opt-outs made after
      // this boot are permanent). Best-effort; failure retries next boot.
      pm.bootMigrate();
      // Keep activation beacons idempotent even when several tabs retry at once.
      await mongoose.connection.collection('funnel_events').createIndex(
        { event: 1, userId: 1, activationJob: 1 },
        { name: 'activation_once_per_job', unique: true, partialFilterExpression: { event: 'activation' } }
      ).catch((indexError) => console.warn('[funnel] activation index unavailable:', indexError && indexError.message));
      await ensureMeteringIndexes();
      // 🧪 AI Paper Portfolio beta collections — only when the beta env is
      // armed (unset = feature fully off, no collections touched).
      if (aiPaper.betaEnabled()) aiPaper.ensureIndexes();
      return;
    } catch (error) {
      if (String(uri || '').startsWith('mongodb+srv://') && isMongoSrvResolutionError(error)) {
        try {
          const directUri = await expandMongoSrvUri(uri);
          await mongoose.connect(directUri, options);
          console.log(`MongoDB connected via SRV fallback (${redactMongoUri(directUri)})`);
          pm.bootMigrate();
          await mongoose.connection.collection('funnel_events').createIndex(
            { event: 1, userId: 1, activationJob: 1 },
            { name: 'activation_once_per_job', unique: true, partialFilterExpression: { event: 'activation' } }
          ).catch((indexError) => console.warn('[funnel] activation index unavailable:', indexError && indexError.message));
          await ensureMeteringIndexes();
          if (aiPaper.betaEnabled()) aiPaper.ensureIndexes();
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
  // Grandfathered price ids resolve to their plan at the OLD price, so a
  // legacy subscriber's stored amount keeps matching what Stripe charges.
  if (priceId) {
    for (const [planId, legacy] of Object.entries(LEGACY_PLAN_PRICE_SPECS)) {
      if (legacy.priceId && priceId === legacy.priceId) {
        const planConfig = getPlanConfig(planId);
        return { ...planConfig, stripePriceId: legacy.priceId, price: legacy.price, currency: legacy.currency, billingInterval: legacy.interval };
      }
    }
  }
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

function isPublishedStripePlan(planConfig) {
  return Boolean(CHECKOUT_STRIPE_PRICE_SPECS[planConfig?.planId]);
}

async function resolveStripeCheckoutPlan(planConfig) {
  if (!isPublishedStripePlan(planConfig) || !stripe?.prices?.list) {
    return planConfig;
  }

  const spec = CHECKOUT_STRIPE_PRICE_SPECS[planConfig.planId];
  const cacheKey = `${planConfig.planId}:${spec.currency}:${spec.amount}:${spec.interval}`;
  const cached = selfServePriceLookupCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < SELF_SERVE_PRICE_LOOKUP_TTL_MS) {
    return { ...planConfig, stripePriceId: cached.priceId, price: spec.amount, currency: spec.currency, billingInterval: spec.interval };
  }

  const expectedAmount = Math.round(spec.amount * 100);
  const isMatch = (price) => {
    const product = price?.product;
    const productName = typeof product === 'object' ? String(product.name || '').trim().toLowerCase() : '';
    return price?.active === true
      && Number(price?.unit_amount) === expectedAmount
      && String(price?.currency || '').toLowerCase() === spec.currency.toLowerCase()
      && price?.recurring?.interval === spec.interval
      && productName === spec.productName;
  };
  // Validate an explicitly configured ID rather than trusting a stale/inactive
  // value left in Render. The validated result is cached for five minutes.
  if (planConfig.stripePriceId && stripe?.prices?.retrieve) {
    try {
      const configured = await stripe.prices.retrieve(planConfig.stripePriceId, { expand: ['product'] });
      if (isMatch(configured)) {
        selfServePriceLookupCache.set(cacheKey, { priceId: configured.id, cachedAt: Date.now() });
        return { ...planConfig, stripePriceId: configured.id, price: spec.amount, currency: spec.currency, billingInterval: spec.interval };
      }
    } catch (_) { /* fall through to the exact active-price lookup */ }
  }
  const result = await stripe.prices.list({
    active: true,
    currency: spec.currency.toLowerCase(),
    type: 'recurring',
    limit: 100,
    expand: ['data.product']
  });
  const matches = (result?.data || []).filter(isMatch);
  if (matches.length !== 1) {
    return planConfig;
  }

  const priceId = matches[0].id;
  selfServePriceLookupCache.set(cacheKey, { priceId, cachedAt: Date.now() });
  console.warn(`[stripe] Resolved a missing or stale ${planConfig.planName} Price ID from its active Stripe product.`);
  return { ...planConfig, stripePriceId: priceId, price: spec.amount, currency: spec.currency, billingInterval: spec.interval };
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

// Local ETF and index-fund directory (scripts/build-fund-directory.js).
// Yahoo's symbol search returns no funds at all for a one- or two-letter query
// — measured 2026-09-07, "v" answers V/HWGV/TRUM and "s" answers S/SI=F/SOL-USD
// — so without a local list there is nothing to rank and VOO cannot be reached
// by typing "vo". Yahoo still covers the long tail from three characters on.
const FUND_DIRECTORY_PATHS = [
  path.join(__dirname, 'data', 'top-funds.json'),
  path.join(__dirname, '../frontend/data/top-funds.json')
];
let topFunds = [];
try {
  for (const candidatePath of FUND_DIRECTORY_PATHS) {
    if (!fs.existsSync(candidatePath)) continue;
    const parsed = JSON.parse(fs.readFileSync(candidatePath, 'utf8'));
    const list = Array.isArray(parsed) ? parsed : (parsed.funds || []);
    topFunds = list.map((item) => ({
      symbol: safeUpper(item.symbol),
      name: String(item.name || '').trim(),
      assetType: item.assetType === 'mutual_fund' ? 'mutual_fund' : 'etf',
      netAssets: Number(item.netAssets) || null
    })).filter((item) => item.symbol && item.name);
    if (topFunds.length) break;
  }
} catch (error) {
  console.warn('Unable to load fund directory:', error.message);
  topFunds = [];
}

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

// The same relevance ladder searchTopCompanies uses internally, exposed so the
// asset search can rank local-directory rows and Yahoo rows on one scale
// instead of trusting whichever list happened to be concatenated first.
function assetMatchScore(query, symbol, name) {
    const q = String(query || '').trim().toLowerCase();
    if (!q) return -1;
    const sym = String(symbol || '').toLowerCase();
    const nm = String(name || '').toLowerCase();
    if (sym === q) return 100;
    if (nm === q) return 95;
    if (sym.startsWith(q)) return 90;
    if (nm.startsWith(q)) return 80;
    if (nm.includes(q)) return 70;
    if (sym.includes(q)) return 60;
    return -1;
}

function searchFundDirectory(query, limit = 10) {
    const scored = [];
    for (const fund of topFunds) {
        const score = assetMatchScore(query, fund.symbol, fund.name);
        if (score >= 0) scored.push({ fund, score });
    }
    return scored
        .sort((a, b) => b.score - a.score || (b.fund.netAssets || 0) - (a.fund.netAssets || 0))
        .slice(0, Math.max(1, Math.min(limit, 25)))
        .map(({ fund }) => ({
            symbol: fund.symbol, name: fund.name, sector: '',
            assetType: fund.assetType, assetTypeLabel: assetProfile.assetTypeLabel(fund.assetType),
            quoteType: fund.assetType === 'etf' ? 'ETF' : 'MUTUALFUND'
        }));
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

// 3-day signup trial: a Core-tier no-card trial offered on the free plan card
// at registration, gated behind SIGNUP_TRIAL_DAYS (default 0 = off, preserving
// today's paid-first behaviour). Unlike startNoCardTrial (Pro, 7 days, legacy
// rollback), this always grants Core and is short by design. Same self-expiry
// mechanism: no stripeSubscriptionId means ensureSubscriptionShape() drops it
// to 'cancelled' at trialEndsAt with nothing charged.
const SIGNUP_TRIAL_DAYS = parseInt(process.env.SIGNUP_TRIAL_DAYS || '0', 10);
function startSignupTrial(user) {
    const s = user.subscription || {};
    s.status = 'trialing';
    s.planId = MONTHLY_PLAN_ID;
    s.planName = 'Core trial';
    s.price = 0;
    s.currency = 'USD';
    s.billingInterval = 'month';
    s.stripePriceId = null;
    s.trialStartedAt = new Date();
    s.trialEndsAt = new Date(Date.now() + SIGNUP_TRIAL_DAYS * 24 * 60 * 60 * 1000);
    s.expiredAt = null;
    s.activatedAt = null;
    s.renewedAt = null;
    s.lastPaymentAt = null;
    user.subscription = s;
    user.signupTrialAt = new Date();
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
// Maps a dispatcher function name onto the equivalent blob in the nightly
// store. Equities only — funds have no stored copy and fall through to the
// existing error.
function storedAlphaFallback(functionName, symbol) {
    const data = storedFundamentals.load(symbol);
    if (!storedFundamentals.usable(data)) return null;
    switch (functionName) {
        case 'GLOBAL_QUOTE': return storedFundamentals.globalQuote(symbol, data);
        case 'OVERVIEW': return data.overview || null;
        case 'INCOME_STATEMENT': return data.income || null;
        case 'BALANCE_SHEET': return data.balance || null;
        case 'CASH_FLOW': return data.cash || null;
        case 'TIME_SERIES_DAILY_ADJUSTED': return data.daily || null;
        case 'TIME_SERIES_MONTHLY_ADJUSTED': return data.monthly || null;
        default: return null;
    }
}

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
    // Both retries are gone. Surface why — this path produced 74 silent 502s
    // during the 2026-09-05 outage with no upstream reason recorded anywhere.
    const status = lastError?.response?.status ?? lastError?.status ?? 'n/a';
    console.error(`[yahoo] ${functionName}(${params.symbol || ''}) failed after 2 attempts: ${lastError?.name || 'Error'} status=${status} ${String(lastError?.message || '').slice(0, 200)}`);
    // The nightly store holds these same blobs in this same shape, so a Yahoo
    // outage should cost freshness, not the whole page.
    const fallback = storedAlphaFallback(functionName, params.symbol);
    if (fallback) {
        console.warn(`[yahoo] serving cached ${functionName}(${params.symbol || ''})`);
        return fallback;
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
// optionalAuth + isProUser are app.js internals; the compare router needs them
// for the paid variant of /compare/:pair (?sp=2).
const seoExtra = require('./seo-extra');
seoExtra.setCompareAuth({ optionalAuth });
app.use(seoExtra.router);

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
// /lifetime — the same lifetime deal sold direct. Explicit route (like
// /appsumo below) so the path is stable regardless of static-middleware
// resolution rules. Prices are rendered client-side from /api/lifetime/config
// so the page can never drift from the tier definitions in direct-ltd.js.
app.get('/lifetime', (req, res, next) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, '../frontend-v2/lifetime.html'), (error) => {
        if (error && !res.headersSent) next(error);
    });
});

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

// Credit refill — a paid account's own purchase surface, never useful logged
// out. optionalAuth + a redirect (rather than authMiddleware's JSON 401): a
// visitor without a session is walked to login with a return path, which is
// what a browser follows; a stale token still 401s from the API surface.
// These routes MUST sit ahead of express.static — its `extensions: ['html']`
// rule would serve upgrade.html/recharge.html to everyone, and the login
// walk would never fire (that's why /lifetime and /appsumo are explicit too).
app.get(/^\/recharge\/?$/, optionalAuth, (req, res) => {
    if (!req.user) return res.redirect('/login.html?next=' + encodeURIComponent('/recharge.html'));
    res.set('Cache-Control', 'no-store').sendFile(path.join(__dirname, '../frontend-v2/recharge.html'));
});

// In-app tier upgrade — same reasoning: /register.html is the new-account
// funnel; existing users must never land on it to change plans.
app.get(/^\/upgrade\/?$/, optionalAuth, (req, res) => {
    if (!req.user) return res.redirect('/login.html?next=' + encodeURIComponent('/upgrade.html'));
    res.set('Cache-Control', 'no-store').sendFile(path.join(__dirname, '../frontend-v2/upgrade.html'));
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

async function handleVerify(req, res) {
    try {
        const { prText, ticker, metric } = req.body || {};
        const result = await verifyHeadline.detectLie({ prText, ticker, metric });
        trackFunnel('verify_headline', null, null, { ticker: result.ticker, period: result.period, ...trackingRequestFields(req, res) });
        // Public claim ledger: persist a sanitized row for every check that
        // produced a filed figure + source. Fire-and-forget — never block the
        // response on the write.
        if (result && result.filed && result.filed.value != null && result.filed.sourceUrl && mongoose.connection.readyState === 1) {
            const claim = String(prText || '').replace(/\s+/g, ' ').trim().slice(0, 200);
            VerifyCheck.create({
                ticker: String(result.ticker || '').toUpperCase().slice(0, 10),
                claim,
                filedValue: result.filed.value,
                period: String(result.period || '').slice(0, 40),
                sourceUrl: String(result.filed.sourceUrl).slice(0, 500),
                verdict: String(result.verdict || '').slice(0, 120),
                diffPct: Number.isFinite(result.diffPct) ? result.diffPct : null,
                flagged: /numbers differ|different periods/i.test(String(result.verdict || ''))
            }).catch((err) => { console.error('[verify-ledger] save failed:', err && err.message); });
        }
        res.json(result);
    } catch (error) {
        res.status(Number(error.status) || 500).json({ error: error.message || 'Verify failed' });
    }
}
app.post('/api/verify', freeToolLimiter, handleVerify);
app.post('/api/lie', freeToolLimiter, handleVerify); // alias for older links

// Public claim ledger: the last checks run through /api/verify, newest first.
// A live proof artifact — real headlines checked against real filings, with
// the filed figure and SEC source on every row. Registered before static so it
// wins the path.
app.get(['/verify-ledger', '/verify-ledger.html'], async (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    let rows = [];
    if (mongoose.connection.readyState === 1) {
        try { rows = await VerifyCheck.find({}).sort({ createdAt: -1 }).limit(50).lean(); } catch (_) { rows = []; }
    }
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const money = (n) => {
        if (n == null) return '—';
        const abs = Math.abs(n);
        const one = (v) => { const x = v.toFixed(abs >= 100 ? 0 : 1); return x.replace(/\.0$/, ''); };
        if (abs >= 1e9) return '$' + one(n / 1e9) + ' billion';
        if (abs >= 1e6) return '$' + one(n / 1e6) + ' million';
        if (abs >= 1e3) return '$' + one(n / 1e3) + ' thousand';
        return '$' + one(n);
    };
    const rowHtml = rows.map((r) => {
        const flagged = Boolean(r.flagged);
        const verdict = flagged ? '<span style="color:#b3261e;font-weight:700">' + esc(r.verdict) + '</span>' : '<span style="color:#1c6b2f;font-weight:700">' + esc(r.verdict) + '</span>';
        const source = r.sourceUrl ? `<a href="${esc(r.sourceUrl)}" target="_blank" rel="noopener nofollow">sec.gov</a>` : '—';
        return `<tr${flagged ? ' class="ledger-flag"' : ''}><td><strong>${esc(r.ticker)}</strong></td><td>${esc(r.claim) || '—'}</td><td>${money(r.filedValue)}</td><td>${esc(r.period)}</td><td>${verdict}</td><td>${source}</td></tr>`;
    }).join('');
    const empty = rows.length ? '' : '<tr><td colspan="6" style="text-align:center;color:var(--ink-3)">No checks yet — be the first.</td></tr>';
    const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Claim Ledger — real headlines checked against SEC filings | stockportfolio.pro</title>
<meta name="description" content="Every row is a headline someone pasted into the free lie-checker, checked against the company's own SEC filing. The filed figure wins." />
<link rel="canonical" href="https://www.stockportfolio.pro/verify-ledger" />
<link rel="icon" href="/Media/icon.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..750&display=swap" />
<link rel="stylesheet" href="/assets/system.css?v=20260907-aipaper3" />
<style>
  .ledger-wrap { max-width: 980px; }
  .ledger-head { padding: 56px 0 8px; }
  .ledger-intro { color: var(--ink-2); max-width: 62ch; margin: 14px 0 0; }
  .ledger-table { width: 100%; border-collapse: collapse; margin-top: 24px; font-size: 14px; }
  .ledger-table th, .ledger-table td { padding: 11px 12px; border: 1px solid var(--line); text-align: left; vertical-align: top; }
  .ledger-table th { background: var(--paper); color: var(--ink-3); font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
  .ledger-table tr.ledger-flag td { background: #fef1f1; }
  .ledger-cta { margin-top: 24px; padding: 16px 18px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--accent-tint); }
  .ledger-cta a { font-weight: 700; }
  .ledger-foot { margin-top: 18px; font-size: 13px; }
</style>
</head><body>
<main class="container ledger-wrap">
  <div class="ledger-head">
    <p class="label">Free · no account</p>
    <h1 class="title-1" style="margin-top:10px;">Claim Ledger</h1>
    <p class="ledger-intro">Every row is a headline someone pasted into the free lie-checker, checked against the company&rsquo;s own SEC filing. No estimates, no opinion &mdash; the filed figure wins. Red rows are headlines that did not match the filing.</p>
  </div>
  <div class="card card-pad" style="margin-top:24px;overflow-x:auto">
    <table class="ledger-table">
      <thead><tr><th>Ticker</th><th>Headline claim</th><th>Filed figure</th><th>Period</th><th>Verdict</th><th>Source</th></tr></thead>
      <tbody>${rowHtml}${empty}</tbody>
    </table>
  </div>
  <div class="ledger-cta"><strong>See a headline about a stock?</strong> <a href="/verify.html">Check it against the filing — free, no account &rarr;</a></div>
  <p class="ledger-foot muted">Source: Company SEC filings (10-K), stockportfolio.pro fundamentals cache. Figures as filed &mdash; verify in the filing before acting. Not investment advice.</p>
</main>
<script src="/assets/app.js?v=20260907-aipaper3"></script>
<script>window.V2.nav(''); window.V2.footer();</script>
</body></html>`;
    res.send(html);
});

app.get('/api/verify-ledger', async (req, res) => {
    if (mongoose.connection.readyState !== 1) return res.json({ checks: [] });
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    try {
        const rows = await VerifyCheck.find({}).sort({ createdAt: -1 }).limit(limit).lean();
        res.json({ checks: rows.map((r) => ({
            ticker: r.ticker, claim: r.claim, filedValue: r.filedValue, period: r.period,
            sourceUrl: r.sourceUrl, verdict: r.verdict, diffPct: r.diffPct, flagged: r.flagged, createdAt: r.createdAt
        })) });
    } catch (_) { res.json({ checks: [] }); }
});

// Public filing-change artifact: the latest Filing Change Monitor reports,
// surfaced from the cached filing_reports collection. Zero incremental cost —
// these are reports the monitor already built. Each row shows the filing, the
// deterministic materiality score and the top year-over-year deltas, with the
// SEC source. The AI narrative stays behind the Power/Desk paywall; the
// numbers are the public proof.
app.get(['/filing-changes', '/filing-changes.html'], async (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8');
    let reports = [];
    if (mongoose.connection.readyState === 1) {
        try {
            reports = await mongoose.connection.collection('filing_reports')
                .find({}, { projection: { symbol: 1, filedDate: 1, materiality: 1, payload: 1 } })
                .sort({ at: -1 }).limit(80).toArray();
        } catch (_) { reports = []; }
    }
    // Dedupe by symbol — keep the newest report per company.
    const seen = new Set();
    const rows = [];
    for (const r of reports) {
        const sym = String(r.symbol || '').toUpperCase();
        if (!sym || seen.has(sym)) continue;
        seen.add(sym);
        rows.push(r);
        if (rows.length >= 30) break;
    }
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const bucketLabel = (b) => b === 'high' ? 'High' : b === 'medium' ? 'Medium' : 'Low';
    const bucketColor = (b) => b === 'high' ? '#b3261e' : b === 'medium' ? '#8a5a13' : '#1c6b2f';
    // This index reads `filing_reports`; the per-company pages read
    // `filing_diffs`. They are different collections with different coverage,
    // so only link a symbol that actually has a diff page — a row pointing at
    // a redirect is a dead internal link.
    let diffSymbols = new Set();
    if (mongoose.connection.readyState === 1 && rows.length) {
        try {
            diffSymbols = new Set(await mongoose.connection.collection('filing_diffs')
                .distinct('symbol', { symbol: { $in: rows.map((r) => String(r.symbol || '').toUpperCase()) } }));
        } catch (_) { diffSymbols = new Set(); }
    }
    const rowHtml = rows.map((r) => {
        const p = r.payload || {};
        const filing = p.latestFiling || {};
        const deltas = (p.deltas || []).slice(0, 4).map((d) => {
            const dir = d.direction === 'up' ? '▲' : d.direction === 'down' ? '▼' : '—';
            const color = d.direction === 'up' ? '#1c6b2f' : d.direction === 'down' ? '#b3261e' : 'var(--ink-3)';
            return `<span style="color:${color}">${dir} ${esc(d.label)}: ${esc(d.latest)} (${esc(d.change)})</span>`;
        }).join('<br>');
        const bucket = p.materialityBucket || (r.materiality >= 60 ? 'high' : r.materiality >= 30 ? 'medium' : 'low');
        const source = filing.url ? `<a href="${esc(filing.url)}" target="_blank" rel="noopener nofollow">${esc(filing.label || filing.form || 'filing')} · ${esc(filing.date || '')}</a>` : '—';
        const sym = String(r.symbol || '').toUpperCase();
        const href = diffSymbols.has(sym) ? `/filing-changes/${esc(sym)}` : `/stocks/${esc(r.symbol)}`;
        const quoted = diffSymbols.has(sym) ? '<br><span style="font-size:12px;color:var(--ink-3)">quoted passages &rarr;</span>' : '';
        return `<tr><td><strong><a href="${href}">${esc(r.symbol)}</a></strong>${quoted}</td><td>${source}</td><td><span style="color:${bucketColor(bucket)};font-weight:700">${bucketLabel(bucket)} ${esc(r.materiality)}</span></td><td>${deltas || '—'}</td></tr>`;
    }).join('');
    const empty = rows.length ? '' : '<tr><td colspan="4" style="text-align:center;color:var(--ink-3)">No filing-change reports yet — run the free monitor trial to build the first ones.</td></tr>';
    const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Filing Changes — what materially changed in recent SEC filings | stockportfolio.pro</title>
<meta name="description" content="The latest material changes in recent SEC filings, computed from the filings themselves: year-over-year deltas, materiality scores and the primary source for every figure." />
<link rel="canonical" href="https://www.stockportfolio.pro/filing-changes" />
<link rel="icon" href="/Media/icon.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..750&display=swap" />
<link rel="stylesheet" href="/assets/system.css?v=20260907-aipaper3" />
<style>
  .fc-wrap { max-width: 980px; }
  .fc-head { padding: 56px 0 8px; }
  .fc-intro { color: var(--ink-2); max-width: 62ch; margin: 14px 0 0; }
  .fc-table { width: 100%; border-collapse: collapse; margin-top: 24px; font-size: 14px; }
  .fc-table th, .fc-table td { padding: 11px 12px; border: 1px solid var(--line); text-align: left; vertical-align: top; }
  .fc-table th { background: var(--paper); color: var(--ink-3); font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; }
  .fc-cta { margin-top: 24px; padding: 16px 18px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--accent-tint); }
  .fc-cta a { font-weight: 700; }
  .fc-foot { margin-top: 18px; font-size: 13px; }
</style>
</head><body>
<main class="container fc-wrap">
  <div class="fc-head">
    <p class="label">Free · no account</p>
    <h1 class="title-1" style="margin-top:10px;">Filing Changes</h1>
    <p class="fc-intro">What materially changed in recent SEC filings &mdash; computed from the filings themselves. Every row is a real 10-K / 10-Q / 8-K read by the Filing Change Monitor: the year-over-year deltas, a deterministic materiality score, and the primary source. The AI-written narrative stays behind the Power/Desk paywall; the numbers are public.</p>
  </div>
  <div class="card card-pad" style="margin-top:24px;overflow-x:auto">
    <table class="fc-table">
      <thead><tr><th>Company</th><th>Latest filing</th><th>Materiality</th><th>Top deltas</th></tr></thead>
      <tbody>${rowHtml}${empty}</tbody>
    </table>
  </div>
  <div class="fc-cta"><strong>Want this for your whole watchlist, with the what-changed narrative?</strong> <a href="/monitor.html">Try the Filing Change Monitor — free for 3 stocks, no account &rarr;</a></div>
  <p class="fc-foot muted">Source: Company SEC filings (10-K / 10-Q / 8-K), stockportfolio.pro Filing Change Monitor. Numeric differences are computed from comparable filed periods. Educational, not investment advice.</p>
</main>
<script src="/assets/app.js?v=20260907-aipaper3"></script>
<script>window.V2.nav(''); window.V2.footer();</script>
</body></html>`;
    res.send(html);
});

// ---- per-company filing-change pages -------------------------------------
// Public surface over the cached `filing_diffs` corpus. The split is
// deliberate and matches what /filing-changes already promises: the FILING'S
// OWN WORDS are public (verbatim `quote`/`priorQuote`/`newQuote` plus the
// EDGAR source), while the AI-written reading (`headline`, `tone`, and each
// change's `what`) stays behind the Power/Desk paywall. We publish what the
// company said; we sell what we make of it.
const FILING_DIFF_SYMBOLS_FILE = path.join(__dirname, 'filing-diff-symbols.json');

async function refreshFilingDiffSitemapSnapshot() {
    // Written to disk so the sitemap builder stays synchronous (same contract
    // as indexable-shares.json). Never throws: the pages work without it, they
    // just would not be listed in the sitemap.
    try {
        if (mongoose.connection.readyState !== 1) return 0;
        const rows = await mongoose.connection.collection('filing_diffs').aggregate([
            { $sort: { at: -1 } },
            { $group: { _id: '$symbol', at: { $first: '$at' } } }
        ]).toArray();
        const list = rows
            .filter((r) => r && r._id && /^[A-Z][A-Z0-9.\-]{0,9}$/.test(String(r._id).toUpperCase()))
            .map((r) => ({ s: String(r._id).toUpperCase(), at: new Date(r.at || Date.now()).toISOString().slice(0, 10) }));
        fs.writeFileSync(FILING_DIFF_SYMBOLS_FILE, JSON.stringify(list));
        // Drop the 30-minute sitemap cache so the diffs shard appears on the
        // next build rather than after the TTL expires.
        try { require('./seo-pages').invalidateSitemapInventory(); } catch (_) {}
        return list.length;
    } catch (error) {
        console.error('[filing-changes] sitemap snapshot failed:', error && error.message);
        return 0;
    }
}

app.get('/filing-changes/:symbol', async (req, res) => {
    // Must look like a real ticker (leading letter). A permissive strip would
    // turn "..%2Fetc" into "..ETC" and redirect to a junk path.
    const symbol = String(req.params.symbol || '').toUpperCase();
    if (!/^[A-Z][A-Z0-9.\-]{0,9}$/.test(symbol)) return res.redirect(302, '/filing-changes');
    res.set('Content-Type', 'text/html; charset=utf-8');
    let doc = null;
    if (mongoose.connection.readyState === 1) {
        try {
            doc = await mongoose.connection.collection('filing_diffs')
                .find({ symbol }).sort({ at: -1 }).limit(1).next();
        } catch (_) { doc = null; }
    }
    // No diff for this ticker yet: go to the hub, not /stocks/:symbol — that
    // page 404s for any uncovered ticker, and a 302 into a 404 is exactly the
    // soft-404 chain that costs indexing on the pages we do want crawled.
    if (!doc || !doc.payload) return res.redirect(302, '/filing-changes');

    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const p = doc.payload || {};
    const latest = p.latest || {};
    const prev = p.prev || {};
    const form = esc(latest.form || 'filing');
    const filedDate = esc(latest.date || String(doc.at || '').slice(0, 10));
    // Only changes carrying verbatim filing text are public. A change whose
    // only content is our prose stays behind the wall entirely.
    const quoted = (p.changes || []).filter((c) => c && (c.quote || c.newQuote || c.priorQuote));
    const gatedCount = Math.max(0, (p.changes || []).length - quoted.length);

    const blocks = quoted.map((c) => {
        const verified = c.evidenceVerified ? '<span class="fd-ok" title="Quote matched character-for-character against the filing">verified</span>' : '';
        const pq = c.priorQuote ? `<div class="fd-side"><span class="fd-lab">Prior filing</span><blockquote class="fd-q fd-prev">${esc(c.priorQuote)}</blockquote></div>` : '';
        const nq = (c.newQuote || c.quote) ? `<div class="fd-side"><span class="fd-lab">This filing</span><blockquote class="fd-q">${esc(c.newQuote || c.quote)}</blockquote></div>` : '';
        return `<section class="fd-change"><h2 class="fd-area">${esc(c.area || 'Change')} ${verified}</h2><div class="fd-pair">${pq}${nq}</div></section>`;
    }).join('');

    const srcLatest = latest.url ? `<a href="${esc(latest.url)}" target="_blank" rel="noopener nofollow">${form} filed ${filedDate}</a>` : `${form} filed ${filedDate}`;
    const srcPrev = prev.url ? ` &middot; compared against <a href="${esc(prev.url)}" target="_blank" rel="noopener nofollow">${esc(prev.form || 'prior filing')} ${esc(prev.date || '')}</a>` : '';
    const desc = `Verbatim passages that changed in ${symbol}'s ${latest.form || 'latest SEC filing'}${latest.date ? ` filed ${latest.date}` : ''} — quoted directly from the filing, with the primary source for every passage.`;
    const canonical = `https://www.stockportfolio.pro/filing-changes/${encodeURIComponent(symbol)}`;
    // Machine-legible for the AI-assistant citation channel, which already
    // refers traffic unbidden. Only public (verbatim) content is described.
    const jsonLd = JSON.stringify({
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: `What changed in ${symbol}'s ${latest.form || 'latest SEC filing'}`,
        description: desc,
        datePublished: latest.date || undefined,
        isAccessibleForFree: true,
        citation: latest.url || undefined,
        about: { '@type': 'Corporation', tickerSymbol: symbol },
        publisher: { '@type': 'Organization', name: 'stockportfolio.pro' },
        mainEntityOfPage: canonical
    });

    const html = `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>What changed in ${esc(symbol)}'s ${form} (${filedDate}) | stockportfolio.pro</title>
<meta name="description" content="${esc(desc)}" />
<link rel="canonical" href="${esc(canonical)}" />
<link rel="icon" href="/Media/icon.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..750&display=swap" />
<link rel="stylesheet" href="/assets/system.css?v=20260907-aipaper3" />
<script type="application/ld+json">${jsonLd}</script>
<style>
  .fd-wrap { max-width: 820px; }
  .fd-head { padding: 56px 0 8px; }
  .fd-src { color: var(--ink-2); font-size: 14px; margin: 12px 0 0; }
  .fd-change { margin-top: 28px; padding-top: 20px; border-top: 1px solid var(--line); }
  .fd-area { font-size: 15px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-3); margin: 0 0 12px; }
  .fd-ok { font-size: 11px; text-transform: none; letter-spacing: 0; color: #1c6b2f; border: 1px solid #1c6b2f; border-radius: 999px; padding: 1px 7px; margin-left: 6px; }
  .fd-pair { display: grid; gap: 12px; }
  @media (min-width: 720px) { .fd-pair { grid-template-columns: 1fr 1fr; } }
  .fd-lab { display: block; font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--ink-3); margin-bottom: 5px; }
  .fd-q { margin: 0; padding: 12px 14px; border-left: 3px solid var(--accent, #1a4fd6); background: var(--paper); font-size: 14px; line-height: 1.55; white-space: pre-wrap; }
  .fd-prev { border-left-color: var(--line); color: var(--ink-2); }
  .fd-lock { margin-top: 32px; padding: 18px 20px; border: 1px solid var(--line); border-radius: var(--radius); background: var(--accent-tint); }
  .fd-foot { margin-top: 26px; font-size: 13px; }
</style>
</head><body data-ask-floor="1" data-ask-placeholder="Ask what this change means — answered from the filing…">
<main class="container fd-wrap">
  <div class="fd-head">
    <div class="crumb"><a href="/">Home</a> / <a href="/filing-changes">Filing changes</a> / ${esc(symbol)}</div>
    <p class="label">Free &middot; no account &middot; quoted from the filing</p>
    <h1 class="title-1" style="margin-top:10px;">What changed in ${esc(symbol)}'s ${form}</h1>
    <p class="fd-src">Source: ${srcLatest}${srcPrev}. Every passage below is quoted verbatim from the filing itself.</p>
  </div>
  ${blocks || '<p class="muted" style="margin-top:24px">No verbatim passages are published for this filing yet.</p>'}
  <div class="fd-lock">
    <strong>What it means &mdash; the analyst reading</strong>
    <p style="margin:8px 0 12px">The passages above are the company's own words. The plain-English reading of them&nbsp;&mdash;&nbsp;what changed, why it matters, and the direction of travel${gatedCount ? `, plus ${gatedCount} further change${gatedCount === 1 ? '' : 's'} without a quotable passage` : ''}&nbsp;&mdash;&nbsp;is part of the Filing Change Monitor.</p>
    <a class="btn btn-primary" href="/monitor.html">See the Filing Change Monitor &rarr;</a>
  </div>
  <p class="fd-foot muted">${esc(p.note || 'Quotes are verbatim from the filing named above.')} Source: company SEC filings via stockportfolio.pro. Educational, not investment advice.</p>
</main>
<script src="/assets/app.js?v=20260907-aipaper3"></script>
<script>window.V2.nav(''); window.V2.footer();</script>
</body></html>`;
    res.send(html);
});

// Messages moved onto the consolidated Profile page (nav's person icon now
// points at /profile.html, which embeds the same message thread). This MUST
// be registered before express.static below: inbox.html still exists as a
// physical file, and static-serving would otherwise send it directly for any
// request matching that literal path, before a route registered after it
// ever got a chance to run. customerMessageMailFor() builds a "reply in your
// private inbox" link to /inbox.html into the email a customer gets when
// support replies, so this stays a redirect rather than a 404.
app.get(/^\/inbox(\.html)?\/?$/, (req, res) => res.redirect(301, '/profile.html'));

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
    lastPaymentAt: { type: Date, default: null },
    // One-time China wallet (Alipay/WeChat Pay) annual pass only — see
    // chinaCheckoutPaymentMethods(). Never set for real Stripe subscriptions
    // (those are governed by Stripe's own webhooks instead); the expiry
    // sweep only ever touches rows where this is set and stripeSubscriptionId
    // is null, so it can never mistakenly downgrade a genuine subscriber.
    chinaAnnualExpiresAt: { type: Date, default: null }
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
    // Pre-granted feature trials — access handed over before any invoice, with
    // a hard expiry. Carries no billing state of its own: a grant never creates,
    // changes or cancels a subscription, so revoking one can only ever remove
    // the grant. See hasActiveTrialGrant(), scripts/grant-trial.js and
    // jobs/trial-expiry-check.js.
    trialGrant: {
        type: [new mongoose.Schema({
            feature: { type: String, required: true },
            grantedAt: { type: Date, default: () => new Date() },
            expiresAt: { type: Date, required: true },
            source: { type: String, default: 'admin' },
            // Set by the expiry job once the "your trial ends tomorrow" mail is
            // queued, so a daily sweep can't queue it twice.
            expiryEmailQueuedAt: { type: Date, default: null },
            revokedAt: { type: Date, default: null }
        }, { _id: false })],
        default: []
    },
    // AppSumo lifetime-deal redemption. appsumoLicenseKey links the account to a
    // single AppSumo license; appsumoTier (1/2/3) sets appsumoAiCap (30/100/300)
    // — the per-tier monthly Ask quota that protects margin on a one-time payment.
    appsumoLicenseKey: { type: String, default: null, index: true },
    appsumoTier: { type: Number, default: null },
    appsumoAiCap: { type: Number, default: null },
    appsumoRedeemedAt: { type: Date, default: null },
    // Which channel that lifetime entitlement was actually bought through:
    // 'appsumo' (marketplace) or 'direct-ltd' (bought here, #9). The grant
    // itself is deliberately shared — same tier ladder, same Ask cap, same
    // AppSumoLicense row — so this field is the ONLY thing that separates the
    // two for revenue reporting, and it is indexed for exactly that query.
    // Null on pre-existing AppSumo accounts; entitlementSourceFor() treats a
    // null as 'appsumo', which is correct because direct LTD did not exist
    // when those rows were written.
    ltdChannel: { type: String, default: null, enum: [null, 'appsumo', 'direct-ltd'], index: true },
    directLtdStripeSessionId: { type: String, default: null, index: true },
    directLtdPaidUsd: { type: Number, default: null },
    // Set only by /api/lifetime/signup, cleared once the lifetime entitlement
    // is granted. Lets /api/login's pending-checkout resume tell a one-time
    // LTD purchase apart from a subscription plan, so it resumes the correct
    // Stripe session type instead of defaulting to the subscription ladder.
    pendingDirectLtdTier: { type: Number, default: null },
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
    // Post-redemption onboarding and a single, usage-gated honest-review request.
    // appsumoReviewStage is retained for legacy scheduled jobs, but a review may
    // be sent only once. The claim field makes that invariant safe across the
    // in-process sweep and the standalone scheduled-email worker.
    appsumoReviewStage: { type: Number, default: 0 },
    appsumoEmailsOptOut: { type: Boolean, default: false },
    // Trial lifecycle emails (no-card trial): drip at 2 days before expiry and on expiry.
    // trialEmailStage = highest stage already emailed (0=none, 1=2-days-left, 2=expired);
    // opt-out is separate from digest/appsumo so each drip has independent control.
    trialEmailStage: { type: Number, default: 0 },
    trialEmailsOptOut: { type: Boolean, default: false },
    trialInternalNotifiedAt: { type: Date, default: null },
    // Set once a free (no-card) signup trial has been granted, so an expired
    // trial account cannot re-trial by re-registering. Distinct from the Pro
    // no-card trial's own trialGrant machinery above.
    signupTrialAt: { type: Date, default: null },
    // Campaign success/review signals are explicit and never inferred from a
    // purchase alone. They are used for the August activation gate.
    customerSuccessStatus: { type: String, enum: [null, 'yes', 'somewhat', 'not_yet'], default: null },
    customerSuccessText: { type: String, default: null, maxlength: 1000 },
    customerSuccessAt: { type: Date, default: null },
    reviewEligibleAt: { type: Date, default: null },
    // Distinct UTC days (YYYY-MM-DD) on which this user completed a successful
    // Ask. Days rather than a count, so ten questions in one sitting is still
    // one day — the review prompt is meant to follow a returning user, not a
    // busy one. Capped, because only the first two entries are ever read.
    askSuccessDays: { type: [String], default: [] },
    reviewPromptShownAt: { type: Date, default: null },
    reviewClickedAt: { type: Date, default: null },
    reviewDismissedAt: { type: Date, default: null },
    firstActivationAt: { type: Date, default: null },
    successfulOutcomeCount: { type: Number, default: 0 },
    lastSuccessfulOutcomeAt: { type: Date, default: null },
    reviewRequestSentAt: { type: Date, default: null },
    reviewRequestClaimedAt: { type: Date, default: null },
    reviewReceivedAt: { type: Date, default: null },
    // First-run onboarding. onboardingPath is the customer's self-declared
    // intent (chosen once, in the welcome dialog); onboardingSteps records the
    // three first-run actions and is written ONLY from the server handlers that
    // observe the real action, never from the browser claiming a step is done.
    onboardingPath: { type: String, enum: [null, 'research', 'portfolio', 'ideas'], default: null },
    onboardingSteps: { type: [String], default: [] },
    onboardingStartedAt: { type: Date, default: null },
    onboardingCompletedAt: { type: Date, default: null },
    onboardingDismissedAt: { type: Date, default: null },
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
    resetPasswordExpires: { type: Date, default: null },
    // Applies only to administrator-initiated customer-message emails. It
    // never hides in-app messages or essential account/security email.
    customerMessageEmailsOptOut: { type: Boolean, default: false },
    // Ask memory — ChatGPT-style: the assistant saves short durable facts
    // unprompted (surfaced to the user inline) and reads them back for context.
    // ON by default, like ChatGPT; the Profile → Settings toggle stops both
    // writes and reads without deleting anything (the user can Clear all there).
    askMemoryEnabled: { type: Boolean, default: true }
}, { timestamps: true });

const User = mongoose.model('User', UserSchema);

// Paid-first signup holding pen. A self-serve registration creates NO User
// document: the submitted identity waits here, keyed to its Stripe Checkout
// Session, and only becomes a real account once Stripe confirms the money
// (checkout.session.completed, or the /api/checkout/claim return, which
// re-reads the same session from Stripe). An abandoned checkout therefore
// leaves nothing behind at all — no account, no welcome email, no "new
// signup" notification, and no squatted email address blocking a retry —
// because the TTL index deletes the row once the Stripe session is dead.
// AppSumo/DealMirror activation and the rollback no-card trial never come
// through here; they create accounts by their own signed, non-Stripe paths.
const PENDING_SIGNUP_TTL_MS = 24 * 60 * 60 * 1000;
const PendingSignupSchema = new mongoose.Schema({
    email: { type: String, required: true, index: true },
    name: { type: String, default: null },
    // bcrypt hash of the password typed at registration (email flow only).
    // Social signups have no password and authenticate by provider id.
    passwordHash: { type: String, default: null },
    provider: { type: String, default: null, enum: [null, 'google', 'facebook'] },
    providerUserId: { type: String, default: null, index: true },
    avatarUrl: { type: String, default: null },
    planId: { type: String, required: true },
    stripeSessionId: { type: String, default: null, index: true },
    signupUtm: { type: mongoose.Schema.Types.Mixed, default: null },
    attribution: { type: mongoose.Schema.Types.Mixed, default: null },
    // Set once the payment lands and the account is created. Also the
    // idempotency marker: a redelivered webhook finds the user here instead
    // of creating a second one.
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    consumedAt: { type: Date, default: null },
    // Single-use guard for /api/checkout/claim, so a leaked checkout URL
    // cannot be replayed into a session after the buyer has used it.
    claimedAt: { type: Date, default: null },
    expiresAt: { type: Date, default: () => new Date(Date.now() + PENDING_SIGNUP_TTL_MS), expires: 0 }
}, { timestamps: true });
const PendingSignup = mongoose.model('PendingSignup', PendingSignupSchema);

// One private conversation per customer. Keeping the participant ID on the
// thread (rather than trusting a client-provided recipient) makes it impossible
// for a signed-in customer to read or write another customer's messages.
const CustomerMessageThreadSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    lastMessageAt: { type: Date, default: () => new Date(), index: true },
    userUnread: { type: Number, default: 0, min: 0 },
    adminUnread: { type: Number, default: 0, min: 0 }
}, { timestamps: true, versionKey: false, collection: 'customer_message_threads' });
const CustomerMessageThread = mongoose.model('CustomerMessageThread', CustomerMessageThreadSchema);

const CustomerMessageSchema = new mongoose.Schema({
    threadId: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerMessageThread', required: true, index: true },
    sender: { type: String, enum: ['admin', 'customer'], required: true, index: true },
    body: { type: String, required: true, maxlength: 4000 },
    editedAt: { type: Date, default: null },
    broadcastId: { type: mongoose.Schema.Types.ObjectId, ref: 'CustomerMessageBroadcast', default: null, index: true }
}, { timestamps: true, versionKey: false, collection: 'customer_messages' });
CustomerMessageSchema.index({ threadId: 1, createdAt: 1 });
const CustomerMessage = mongoose.model('CustomerMessage', CustomerMessageSchema);

// A broadcast is intentionally capped by the route to a modest batch size.
// Persisting the recipient-level state lets the operator audit sends and makes
// a retried browser request resume rather than create a second campaign.
const CustomerMessageBroadcastSchema = new mongoose.Schema({
    idempotencyKey: { type: String, required: true, unique: true, index: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    subject: { type: String, default: '', maxlength: 180 },
    body: { type: String, required: true, maxlength: 4000 },
    sendInApp: { type: Boolean, default: true },
    sendEmail: { type: Boolean, default: false },
    recipients: [{
        userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
        email: { type: String, required: true },
        inAppSentAt: { type: Date, default: null },
        emailStatus: { type: String, enum: ['not_requested', 'pending', 'sent', 'suppressed', 'failed'], default: 'not_requested' },
        emailSentAt: { type: Date, default: null },
        emailError: { type: String, default: null }
    }],
    status: { type: String, enum: ['sending', 'completed', 'completed_with_errors'], default: 'sending', index: true },
    completedAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false, collection: 'customer_message_broadcasts' });
const CustomerMessageBroadcast = mongoose.model('CustomerMessageBroadcast', CustomerMessageBroadcastSchema);

// One row per (user, symbol) the user has opened a Dossier for — lets the
// dashboard show "recent research" without the user needing to remember
// which tickers they've already run. Upserted, not appended: repeat views
// just bump lastViewedAt.
const DossierViewSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    symbol: { type: String, required: true },
    name: { type: String, default: null },
    views: { type: Number, default: 0 },
    lastViewedAt: { type: Date, default: () => new Date() }
}, { versionKey: false, collection: 'dossier_views' });
DossierViewSchema.index({ userId: 1, symbol: 1 }, { unique: true });
DossierViewSchema.index({ userId: 1, lastViewedAt: -1 });
const DossierView = mongoose.model('DossierView', DossierViewSchema);
function recordDossierView(userId, symbol, name) {
    if (!userId) return;
    DossierView.updateOne(
        { userId, symbol },
        { $set: { lastViewedAt: new Date(), ...(name ? { name } : {}) }, $inc: { views: 1 } },
        { upsert: true }
    ).catch((error) => console.error('[dossier] view tracking failed:', error && error.message));
}

// Same shape as DossierView, for the Filing Monitor. Until this existed there
// was NO per-user record of Monitor use anywhere: filing_reports is keyed by
// (symbol, accession) with no userId, credit_ledger only sees uncached reads by
// a paying user, and trackActivation records a first touch once and never again.
// So "who actually uses Monitor" was unanswerable — the one question a decision
// about which plan Monitor belongs to turns on. `views` counts every serve,
// cached ones included, because a cached read is still someone reading a report.
const MonitorViewSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    symbol: { type: String, required: true },
    name: { type: String, default: null },
    views: { type: Number, default: 0 },
    lastViewedAt: { type: Date, default: () => new Date() }
}, { versionKey: false, collection: 'monitor_views' });
MonitorViewSchema.index({ userId: 1, symbol: 1 }, { unique: true });
MonitorViewSchema.index({ userId: 1, lastViewedAt: -1 });
const MonitorView = mongoose.model('MonitorView', MonitorViewSchema);
function recordMonitorView(userId, symbol, name) {
    if (!userId || !symbol) return;   // logged-out free-tier reads have no user
    MonitorView.updateOne(
        { userId, symbol },
        { $set: { lastViewedAt: new Date(), ...(name ? { name } : {}) }, $inc: { views: 1 } },
        { upsert: true }
    ).catch((error) => console.error('[monitor] view tracking failed:', error && error.message));
}

// One row per successful Ask exchange. Same "your research is saved and
// reopening it is free" promise Dossiers make: the full answer is stored
// (ai_chat_log truncates at 8000 chars, which is not enough for long
// reports) and re-reading it never touches credits.
const AskReportSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    question: { type: String, required: true },
    answer: { type: String, required: true },
    mode: { type: String, enum: ['normal', 'analyst'], default: 'normal' },
    toolsUsed: { type: [String], default: [] },
    createdAt: { type: Date, default: () => new Date() }
}, { versionKey: false, collection: 'ask_reports' });
AskReportSchema.index({ userId: 1, createdAt: -1 });
const AskReport = mongoose.model('AskReport', AskReportSchema);
const ASK_REPORT_KEEP = 30;
const ASK_REPORT_LIST_BLURB = 160;
function saveAskReport(userId, question, answer, mode, toolsUsed) {
    if (!userId || !question || !answer) return;
    // toolsUsed arrives as [{tool, args, ok}] objects from ai-chat — the
    // schema stores plain tool names (same normalization as saveThreadExchange)
    const tools = Array.isArray(toolsUsed)
        ? toolsUsed.map((t) => (typeof t === 'string' ? t : t && t.tool)).filter(Boolean).slice(0, 20)
        : [];
    AskReport.create({ userId, question: question.slice(0, 8000), answer, mode: mode === 'analyst' ? 'analyst' : 'normal', toolsUsed: tools })
        // keep only the most recent ASK_REPORT_KEEP per user
        .then((doc) => AskReport.find({ userId: doc.userId }, { _id: 1 }).sort({ createdAt: -1 }).skip(ASK_REPORT_KEEP).lean())
        .then((stale) => {
            if (stale.length) return AskReport.deleteMany({ _id: { $in: stale.map((d) => d._id) } });
            return null;
        })
        .catch((error) => console.error('[ask] report save failed:', error && error.message));
}

// Ask conversation threads — ChatGPT-style saved chats, Ask only. A thread
// owns its own message transcript: when the frontend passes a threadId the
// server rebuilds context from THAT thread's messages, so a follow-up never
// has to re-explain and topics from other chats never bleed in (the old
// one-global ai_chat_log feed stays as the non-thread fallback). Reading a
// thread is free — credits are only ever spent on generating a new answer.
const THREAD_ID_RE = /^[0-9a-fA-F]{24}$/;
const ASK_THREAD_KEEP = 50; // threads per user (ChatGPT-parity cap; oldest pruned)
const ASK_THREAD_MSG_KEEP = 80; // messages per thread
const AskThreadSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, default: '', maxlength: 160 },
    pinned: { type: Boolean, default: false },
    mode: { type: String, enum: ['normal', 'analyst'], default: 'normal' },
    messages: [new mongoose.Schema({
        role: { type: String, enum: ['user', 'assistant'], required: true },
        content: { type: String, default: '' },
        toolsUsed: { type: [String], default: [] },
        at: { type: Date, default: () => new Date() }
    }, { _id: false })],
    createdAt: { type: Date, default: () => new Date() },
    updatedAt: { type: Date, default: () => new Date() }
}, { versionKey: false, collection: 'ask_threads' });
AskThreadSchema.index({ userId: 1, updatedAt: -1 });
// sidebar 🔍 searches titles AND chat text (pinned still sort ahead in memory)
AskThreadSchema.index({ title: 'text', 'messages.content': 'text' }, { default_language: 'none', name: 'ask_thread_text' });
const AskThread = mongoose.model('AskThread', AskThreadSchema);

async function saveThreadExchange(userId, threadId, question, answer, mode, toolsUsed) {
    try {
        if (!userId || !question || !answer) return null;
        const tools = Array.isArray(toolsUsed)
            ? toolsUsed.map((t) => t && t.tool).filter(Boolean).slice(0, 20)
            : [];
        const cap = (s) => String(s).slice(0, 8000);
        const turn = () => [
            { role: 'user', content: cap(question) },
            { role: 'assistant', content: cap(answer), toolsUsed: tools }
        ];
        let doc;
        if (typeof threadId === 'string' && THREAD_ID_RE.test(threadId)) {
            // Append to an existing thread — owner-checked, so a foreign or
            // deleted id simply starts a fresh one rather than erroring.
            doc = await AskThread.findOneAndUpdate(
                { _id: threadId, userId },
                {
                    $push: { messages: { $each: turn(), $slice: -ASK_THREAD_MSG_KEEP } },
                    $set: { updatedAt: new Date(), mode: mode === 'analyst' ? 'analyst' : 'normal' }
                },
                { new: true, projection: { _id: 1 } }
            );
        }
        if (!doc) {
            doc = await AskThread.create({
                userId,
                title: String(question).slice(0, 80),
                mode: mode === 'analyst' ? 'analyst' : 'normal',
                messages: turn(),
                updatedAt: new Date()
            });
        }
        // keep only the most recent ASK_THREAD_KEEP threads per user
        const stale = await AskThread.find({ userId: doc.userId }, { _id: 1 }).sort({ updatedAt: -1 }).skip(ASK_THREAD_KEEP).lean();
        if (stale.length) await AskThread.deleteMany({ _id: { $in: stale.map((d) => d._id) } });
        return String(doc._id);
    } catch (error) {
        console.error('[ask] thread save failed:', error && error.message);
        return null;
    }
}

// Ask memory — ChatGPT-style saved memories. Per-user doc in `personal_memory`
// (one doc, ≤50 embedded facts), shared with the remember tool through
// backend/personal-memory.js (raw collections — no app.js require cycle).
// Legacy `ask_memories` rows and pre-default opt-outs are migrated once at
// boot (pm.bootMigrate()). The toggle gates the assistant's writes/reads;
// Profile → Settings always manages the list.
const pm = require('./personal-memory');
const ASK_MEMORY_MAX = pm.PM_MAX;
const ASK_MEMORY_KEEP = pm.PM_KEEP;

// Append-only, MongoDB-backed customer registry. The unique event key makes
// Stripe/AppSumo webhook retries idempotent while keeping a durable audit trail
// of the email address and plan observed at signup or first paid activation.
const CustomerLifecycleEventSchema = new mongoose.Schema({
    eventKey: { type: String, required: true, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    email: { type: String, required: true, lowercase: true, trim: true, index: true },
    name: { type: String, default: null },
    // 'direct_ltd_redeemed' / 'direct-ltd' are the same lifetime deal sold from
    // our own site rather than through AppSumo. They are separate enum values,
    // not a reuse of 'appsumo', specifically so revenue reporting can never sum
    // the two channels into one figure.
    type: { type: String, enum: ['signup', 'stripe_paid', 'appsumo_redeemed', 'direct_ltd_redeemed'], required: true, index: true },
    source: { type: String, enum: ['direct', 'social', 'stripe', 'appsumo', 'direct-ltd'], required: true, index: true },
    planId: { type: String, default: null },
    planName: { type: String, default: null },
    subscriptionStatus: { type: String, default: null },
    appsumoTier: { type: Number, default: null },
    discoverySource: { type: String, default: null, enum: [null, ...APPSUMO_DISCOVERY_SOURCES] },
    customerEmailedAt: { type: Date, default: null },
    ownerNotifiedAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false, collection: 'customer_lifecycle_events' });
const CustomerLifecycleEvent = mongoose.model('CustomerLifecycleEvent', CustomerLifecycleEventSchema);

// Single definition of "where did this account's entitlement come from?".
// Previously this ternary was inlined in four analytics call sites. Direct LTD
// makes that unsafe: a direct buyer has appsumoRedeemedAt set (it reuses the
// AppSumo grant), so every one of those sites would have reported them as
// AppSumo revenue. Channel is read from ltdChannel, with the license-key prefix
// as a fallback for any row written before the field existed.
function entitlementSourceFor(user) {
    if (!user) return 'trial';
    if (user.appsumoRedeemedAt) {
        if (user.ltdChannel === directLtd.CHANNEL) return directLtd.CHANNEL;
        if (!user.ltdChannel && directLtd.isDirectLicenseKey(user.appsumoLicenseKey)) return directLtd.CHANNEL;
        return 'appsumo';
    }
    if (user.dealMirrorRedeemedAt) return 'dealmirror';
    return user.stripeSubscriptionId ? 'stripe' : 'trial';
}

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

// Ask email rung: a cold visitor who spent their free preview trades an
// address for +2 verified questions (30-day signed cookie, no account).
// One row per email; verification is datestamped so capture→verify→paid is
// measurable in the funnel.
const AskTrialLeadSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true, maxlength: 254 },
    verifiedAt: { type: Date, default: null },
    visitorClaim: { type: String, default: null },
    ip: { type: String, default: null },
    source: { type: String, default: 'ask-wall' }
}, { timestamps: true, versionKey: false, collection: 'ask_trial_leads' });
const AskTrialLead = mongoose.model('AskTrialLead', AskTrialLeadSchema);

// Public claim ledger: one row per successful /api/verify check. The claim is
// the user's own pasted headline (truncated); the filed figure and source are
// the proof. Rows render on the public /verify-ledger page as a live proof
// artifact — real checks against real filings, no estimates.
const VerifyCheckSchema = new mongoose.Schema({
    ticker: { type: String, required: true, index: true },
    claim: { type: String, maxlength: 200, default: '' },
    filedValue: { type: Number, default: null },
    period: { type: String, default: null },
    sourceUrl: { type: String, default: null },
    verdict: { type: String, default: null },
    diffPct: { type: Number, default: null },
    flagged: { type: Boolean, default: false }
}, { timestamps: true, versionKey: false, collection: 'verify_checks' });
VerifyCheckSchema.index({ createdAt: -1 });
const VerifyCheck = mongoose.model('VerifyCheck', VerifyCheckSchema);

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

function applyPlanToSubscription(user, planInput, resolvedPlanConfig = null) {
    // A webhook may hand us an already-resolved config (e.g. a grandfathered
    // legacy Stripe price mapping to the plan at its OLD price). Trust it only
    // when it names the same plan; otherwise fall back to the lookup.
    const planConfig = resolvedPlanConfig && resolvedPlanConfig.planId === normalizePlanSelection(planInput || user?.subscription?.planId)
        ? resolvedPlanConfig
        : getPlanConfig(planInput || user?.subscription?.planId);
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

// 'filing_monitor' and 'dossier' were being passed to trackActivation() by their
// routes but were absent here, so the guard in trackActivation() rejected them
// and neither ever recorded a single row. Adding them makes those calls live.
const ACTIVATION_JOBS = new Set(['ask', 'comparison', 'screener_company', 'portfolio', 'filing_monitor', 'dossier']);

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
        entitlementSource: entitlementSourceFor(user),
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
            entitlementSource: entitlementSourceFor(user)
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

// P0 proof-funnel: a returning buyer starts another research session after
// activation. The Ask flow is the hook point: an already-activated user
// (firstActivationAt set) completing another successful Ask counts as a second
// session. No dedupe key so each returning Ask is counted; first ask success
// keeps its own idempotent record.
function trackSecondSession(req, user) {
    if (!req || !user || !user._id || !user.firstActivationAt) return;
    const acquisition = shareCopy.parseAcquisitionCookieHeader(req.headers.cookie, { secret: JWT_SECRET });
    trackFunnel('second_session', user._id, user.subscription && user.subscription.planName, {
        eventName: 'second_session',
        featureType: 'ask',
        entitlementSource: entitlementSourceFor(user),
        appsumoTier: Number(user.appsumoTier) || null,
        acquisitionSource: acquisition && acquisition.source || null,
        acquisitionClickId: acquisition && acquisition.clickId || null,
        contentId: acquisition && acquisition.contentId || null
    });
}

// ---- first-run onboarding progress -------------------------------------------
// Only accounts created on or after the ship date see the flow, so existing
// customers are never handed a "getting started" card for work they finished
// months ago. Kept as a Date so the cutoff is auditable rather than a migration.
const ONBOARDING_SINCE = new Date('2026-08-26T00:00:00.000Z');
// 'dossier' leads because a blank Ask box asks the customer to already know
// what to ask, and the usage data says most never come back after one try. A
// Dossier needs only a ticker, and the two most engaged accounts on the product
// both reached for it first.
const ONBOARDING_STEPS = ['dossier', 'ask', 'hold', 'watch'];

function onboardingEligible(user) {
    if (!user) return false;
    // Lifetime buyers are always eligible. The ship-date cutoff below had
    // excluded every AppSumo account that redeemed before 26 Aug — which was
    // most of them — so the guided path never ran for the cohort that needed it.
    if (tierLimits.isLifetimeBuyer(user)) return true;
    return !!(user.createdAt && new Date(user.createdAt).getTime() >= ONBOARDING_SINCE.getTime());
}

function onboardingState(user) {
    const steps = Array.isArray(user && user.onboardingSteps)
        ? user.onboardingSteps.filter((s) => ONBOARDING_STEPS.includes(s)) : [];
    return {
        eligible: onboardingEligible(user),
        path: (user && user.onboardingPath) || null,
        steps,
        total: ONBOARDING_STEPS.length,
        dismissed: !!(user && user.onboardingDismissedAt),
        completed: !!(user && user.onboardingCompletedAt)
    };
}

// Called from the handlers that observe the real action (a successful Ask, a
// first holding, a first alert rule). $addToSet keeps it idempotent, and the
// updated document tells us whether THIS call completed the set, so the
// completion event fires exactly once without a second read.
async function markOnboardingStep(user, step) {
    try {
        if (!user || !user._id || !ONBOARDING_STEPS.includes(step)) return;
        if (!onboardingEligible(user) || user.onboardingCompletedAt) return;
        const updated = await User.findOneAndUpdate(
            { _id: user._id, onboardingSteps: { $ne: step } },
            { $addToSet: { onboardingSteps: step } },
            { new: true, projection: { onboardingSteps: 1, onboardingCompletedAt: 1, subscription: 1 } }
        );
        if (!updated) return;
        const plan = updated.subscription && updated.subscription.planName;
        trackFunnel('onboarding_step_completed', user._id, plan, {
            eventName: 'onboarding_step_completed',
            dedupeKey: `onboarding-step:${String(user._id)}:${step}`,
            featureType: step === 'ask' ? 'ask' : null,
            entitlementSource: entitlementSourceFor(user),
            onboardingStep: step
        });
        const done = new Set(updated.onboardingSteps || []);
        if (!updated.onboardingCompletedAt && ONBOARDING_STEPS.every((s) => done.has(s))) {
            await User.updateOne(
                { _id: user._id, onboardingCompletedAt: null },
                { $set: { onboardingCompletedAt: new Date() } }
            );
            trackFunnel('onboarding_completed', user._id, plan, {
                eventName: 'onboarding_completed',
                dedupeKey: `onboarding-completed:${String(user._id)}`,
                entitlementSource: entitlementSourceFor(user)
            });
        }
    } catch (error) {
        // Onboarding progress is a convenience, never a reason to fail the
        // request that actually did the work.
        console.error('markOnboardingStep error:', error.message);
    }
}

// ---- one-time AppSumo review prompt after the second distinct Ask day ----
// Deliberately not a count of answers: someone who asks eight questions in one
// session has not yet come back, and the prompt is asking a returning user for
// a review. `reviewPromptShownAt` is the already-existing "already shown" flag
// (set by POST /api/review/prompt with action 'shown'), so once the client has
// displayed the modal once it can never fire again for that user.
async function askReviewPrompt(user, result) {
    if (!user || !user._id) return null;
    if (!result || result.source !== 'ai' || !result.answer) return null;
    if (user.reviewPromptShownAt) return null;
    const today = new Date().toISOString().slice(0, 10);
    const days = Array.isArray(user.askSuccessDays) ? user.askSuccessDays : [];
    if (!days.includes(today)) {
        // The $ne in the filter makes this atomic: two concurrent asks on the
        // same day cannot both push, which matters because $slice would then
        // evict the genuine earlier day. $slice caps the array at the two
        // entries this check ever reads.
        await User.updateOne(
            { _id: user._id, askSuccessDays: { $ne: today } },
            { $push: { askSuccessDays: { $each: [today], $slice: -2 } } }
        );
        days.push(today);
    }
    if (new Set(days).size < 2) return null;
    return {
        reason: 'second_ask_day',
        headline: 'Two days of filing-grounded answers — worth a review?',
        body: 'If StockPortfolio.pro has been useful, a short review on AppSumo genuinely helps other buyers decide. It takes a minute, and an honest one is more use to us than a kind one.',
        cta: 'Leave a review on AppSumo',
        url: appsumoReviewPromptUrl()
    };
}

function trackFirstAskSuccess(req, user, result) {
    if (!req || !user || !user._id || !result || result.source !== 'ai' || !result.answer) return;
    const acquisition = shareCopy.parseAcquisitionCookieHeader(req.headers.cookie, { secret: JWT_SECRET });
    trackFunnel('first_ask_succeeded', user._id, user.subscription && user.subscription.planName, {
        eventName: 'first_ask_succeeded',
        dedupeKey: `first-ask-success:${String(user._id)}`,
        featureType: 'ask',
        entitlementSource: entitlementSourceFor(user),
        appsumoTier: Number(user.appsumoTier) || null,
        acquisitionSource: acquisition && acquisition.source || null,
        acquisitionClickId: acquisition && acquisition.clickId || null,
        contentId: acquisition && acquisition.contentId || null
    });
    markOnboardingStep(user, 'ask');
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
            occurredAt: event.createdAt,
            // Selects the Monitor cap cohort for the email copy. A grandfathered
            // buyer must read their original number, not the current ladder.
            redeemedAt: user.appsumoRedeemedAt || null
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

async function activateSubscription(user, { subscriptionId, customerId, planId, stripeStatus, trialEndsAt, stripePriceId, resolvedPlanConfig = null } = {}) {
    const now = new Date();
    const planConfig = applyPlanToSubscription(user, planId, resolvedPlanConfig);
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
        stripePriceId,
        resolvedPlanConfig: planConfig
    });
}

// Grants Pro access for CHINA_ANNUAL_PASS_DAYS from a one-time Alipay/WeChat
// Pay payment. Deliberately does not call activateSubscription()/set
// stripeSubscriptionId — there is no Stripe Subscription object behind this,
// and setting a fake one would make expireChinaAnnualPasses() (which
// requires stripeSubscriptionId to be null, precisely to never touch a real
// subscriber) unable to ever expire it.
async function grantChinaAnnualPass(user, { customerId, amount, currency } = {}) {
    const now = new Date();
    const planConfig = applyPlanToSubscription(user, CHINA_ANNUAL_PASS_PLAN_ID);
    user.subscription.status = 'active';
    user.subscription.billingInterval = 'year';
    user.subscription.activatedAt = user.subscription.activatedAt || now;
    user.subscription.renewedAt = now;
    user.subscription.trialStartedAt = user.subscription.trialStartedAt || now;
    user.subscription.trialEndsAt = null;
    user.subscription.lastPaymentAt = now;
    user.subscription.chinaAnnualExpiresAt = new Date(now.getTime() + CHINA_ANNUAL_PASS_DAYS * 24 * 3600 * 1000);
    // Record what was actually charged (CNY), not the USD reference price
    // applyPlanToSubscription() just set from the pro-annual plan config.
    if (Number.isFinite(amount)) user.subscription.price = amount;
    if (currency) user.subscription.currency = String(currency).toUpperCase();
    if (customerId) user.stripeCustomerId = customerId;
    user.markModified('subscription');
    await user.save().catch(() => {});
    return planConfig;
}

// Expires China annual passes whose year is up. Scoped tightly —
// stripeSubscriptionId: null is the same invariant expireNoCardTrials()
// relies on, so this can never touch a real Stripe-managed subscription.
async function expireChinaAnnualPasses() {
    if (mongoose.connection.readyState !== 1) return { matchedCount: 0, modifiedCount: 0 };
    const result = await User.updateMany({
        'subscription.chinaAnnualExpiresAt': { $ne: null, $lte: new Date() },
        stripeSubscriptionId: null
    }, { $set: { 'subscription.status': 'cancelled', 'subscription.expiredAt': new Date() } });
    return {
        matchedCount: Number(result.matchedCount || result.n || 0),
        modifiedCount: Number(result.modifiedCount || result.nModified || 0)
    };
}

async function createChinaAnnualCheckoutSession(user, extraMetadata = {}) {
    if (!stripe) {
        throw createHttpError(500, 'Stripe is not configured');
    }
    const methods = chinaCheckoutPaymentMethods();
    if (!methods.length) {
        throw createHttpError(503, 'Alipay/WeChat Pay checkout is not yet enabled on this account.');
    }
    await ensureStripeAccountPreflight();
    const returnContext = extraMetadata.returnContext || {};
    const amount = CHINA_ANNUAL_PASS_CNY_AMOUNT;
    const session = await stripe.checkout.sessions.create({
        payment_method_types: methods,
        mode: 'payment',
        customer_email: user.email,
        line_items: [{
            price_data: {
                currency: 'cny',
                unit_amount: Math.round(amount * 100),
                product_data: {
                    name: 'stockportfolio.pro — Pro, 1 year'
                }
            },
            quantity: 1
        }],
        client_reference_id: user._id.toString(),
        success_url: extraMetadata.successUrl || buildStripeReturnUrl(extraMetadata.req, {
            session: 'success',
            planId: CHINA_ANNUAL_PASS_PLAN_ID,
            ...returnContext
        }),
        cancel_url: extraMetadata.cancelUrl || buildStripeReturnUrl(extraMetadata.req, {
            session: 'cancel',
            planId: CHINA_ANNUAL_PASS_PLAN_ID,
            ...returnContext
        }),
        // wechat_pay requires an explicit client even when it's the only or
        // one of several payment_method_types on a hosted Checkout page.
        ...(methods.includes('wechat_pay') ? { payment_method_options: { wechat_pay: { client: 'web' } } } : {}),
        metadata: {
            userId: user._id.toString(),
            planId: CHINA_ANNUAL_PASS_PLAN_ID,
            checkoutType: 'china_annual_pass',
            amountCny: String(amount)
        }
    });
    const requestFields = extraMetadata.req ? trackingRequestFields(extraMetadata.req, null) : {};
    trackFunnel('stripe_checkout_created', user._id, 'China annual pass', {
        eventName: 'stripe_checkout_created',
        dedupeKey: session && session.id ? `stripe_checkout_created:${session.id}` : null,
        pageType: 'pricing',
        billingPeriod: 'year',
        entitlementSource: 'stripe_china_annual',
        ...requestFields
    });
    return session;
}

// Shared by the checkout.session.completed (synchronous methods) and
// checkout.session.async_payment_succeeded (Alipay/WeChat Pay's normal path)
// webhook handlers — either can be the one that actually confirms payment.
async function handleChinaAnnualPassPaid(user, payload, event) {
    const wasActive = user.subscription && user.subscription.status === 'active';
    await grantChinaAnnualPass(user, {
        customerId: payload.customer,
        amount: Number(payload.amount_total) / 100,
        currency: payload.currency
    });
    trackFunnel('subscription_started', user._id, 'China annual pass', {
        eventName: 'subscription_started',
        dedupeKey: event.id ? `stripe:china-annual-started:${event.id}` : null,
        entitlementSource: 'stripe_china_annual', testFlag: payload.livemode === false,
        billingPeriod: 'year'
    });
    if (!wasActive) {
        trackFunnel('paid', user._id, 'China annual pass', {
            eventName: 'legacy_paid',
            dedupeKey: event.id ? `stripe:china-annual-paid:${event.id}` : null
        });
        await recordCustomerLifecycleEvent(user, 'stripe_paid', { source: 'stripe_china_annual' });
    }
}

// ============================================================
// Direct lifetime deal (#9) — the AppSumo LTD sold from our own site.
// One-time Stripe payment -> we mint a license key -> the EXISTING AppSumo
// grant + onboarding email path runs. See backend/direct-ltd.js for the tier
// ladder and the exclusivity price-floor guard.
// ============================================================

// Boot-path check. Never throws: a misconfigured price must disable direct
// lifetime sales, not refuse to start a server that also serves everything else.
const directLtdBootReport = directLtd.assertAllPriceFloors(process.env, { context: 'boot' });
if (directLtd.enabled() && !directLtdBootReport.ok) {
    console.error('[direct-ltd] Direct lifetime checkout will refuse every request until the AppSumo price floor is satisfied.');
}

// Auto-revert timer for the pricing-swap experiment. See pricing-experiment.js
// for the full safety model; this just starts the interval that checks
// PRICING_EXPERIMENT_MODE against its activation timestamp every 60s.
pricingExperiment.install();

/**
 * Resolve the configured Stripe Price for a tier and re-run the exclusivity
 * guard against the amount STRIPE actually holds — not the constant in our
 * code. This is the case the guard exists for: someone edits the Price in the
 * Stripe dashboard, or swaps the Price ID, and nothing in this repo changes.
 * Fails closed; the caller turns a violation into a 503, never a sale.
 */
async function resolveDirectLtdPrice(tier) {
    const cfg = directLtd.tierConfig(tier);
    if (!cfg) throw createHttpError(400, 'Unknown lifetime tier');
    const priceId = directLtd.priceIdFor(tier);
    if (!priceId) throw createHttpError(503, 'This lifetime tier is not available for purchase yet.');
    if (!directLtdStripe) throw createHttpError(503, 'Direct lifetime checkout is not configured.');

    const price = await directLtdStripe.prices.retrieve(priceId);
    try {
        // All structural + exclusivity checks live in direct-ltd.js so they are
        // testable without a Stripe key. A PriceFloorViolation propagates (the
        // route turns it into a 503 and logs it); the structural failures are
        // translated here.
        const { amountUsd } = directLtd.validateStripePrice(price, tier);
        return { priceId, amountUsd };
    } catch (error) {
        if (error instanceof directLtd.PriceFloorViolation) throw error;
        throw createHttpError(503, 'This lifetime tier is misconfigured and cannot be sold right now.');
    }
}

async function createDirectLtdCheckoutSession(user, tier, extraMetadata = {}) {
    if (!directLtdStripe) throw createHttpError(500, 'Stripe is not configured');
    if (!directLtd.enabled()) throw createHttpError(503, 'Direct lifetime purchase is not enabled.');
    const cfg = directLtd.tierConfig(tier);
    if (!cfg) throw createHttpError(400, 'Unknown lifetime tier');

    // Non-stackable, exactly like the AppSumo and DealMirror channels: someone
    // who already holds a lifetime entitlement must not be able to buy a second.
    if (user.appsumoRedeemedAt || user.dealMirrorRedeemedAt) {
        throw createHttpError(409, 'This account already has a lifetime plan.');
    }

    await ensureStripeAccountPreflight();
    const { priceId, amountUsd } = await resolveDirectLtdPrice(tier);

    const returnContext = extraMetadata.returnContext || {};
    // Embedded mirrors the subscription checkout's ui_mode so the LTD buy
    // flow can mount inline on our own page instead of redirecting to
    // checkout.stripe.com — same mechanism createCheckoutSessionForUser uses.
    const embedded = extraMetadata.uiMode === 'embedded';
    const urlParams = embedded
        ? {
            ui_mode: 'embedded',
            return_url: extraMetadata.returnUrl || buildStripeReturnUrl(extraMetadata.req, {
                session: 'success', planId: PRO_PLAN_ID, lifetime: cfg.slug, ...returnContext
            })
        }
        : {
            success_url: extraMetadata.successUrl || buildStripeReturnUrl(extraMetadata.req, {
                session: 'success', planId: PRO_PLAN_ID, lifetime: cfg.slug, ...returnContext
            }),
            cancel_url: extraMetadata.cancelUrl || buildStripeReturnUrl(extraMetadata.req, {
                session: 'cancel', planId: PRO_PLAN_ID, lifetime: cfg.slug, ...returnContext
            })
        };
    const session = await directLtdStripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',                       // one-time; never a subscription
        customer_email: user.email,
        line_items: [{ price: priceId, quantity: 1 }],
        client_reference_id: user._id.toString(),
        ...urlParams,
        custom_text: {
            submit: { message: `One payment. Lifetime access to the ${cfg.label} tier — no renewal. ${directLtd.refundDays()}-day refund window, direct from us.` }
        },
        metadata: {
            userId: user._id.toString(),
            planId: PRO_PLAN_ID,
            checkoutType: directLtd.CHECKOUT_TYPE,
            ltdChannel: directLtd.CHANNEL,
            ltdTier: String(cfg.tier),
            stripePriceId: priceId,
            amountUsd: String(amountUsd),
            ...(extraMetadata.experimentTag ? { experimentTag: extraMetadata.experimentTag } : {}),
            // Referral attribution, same shape every other checkout builder
            // attaches. Empty object when the program is off or the buyer is
            // not referral-attributable, so the session is unchanged.
            ...(extraMetadata.affiliateMetadata || {})
        }
    });

    const requestFields = extraMetadata.req ? trackingRequestFields(extraMetadata.req, null) : {};
    trackFunnel('stripe_checkout_created', user._id, cfg.planName, {
        eventName: 'stripe_checkout_created',
        dedupeKey: session && session.id ? `stripe_checkout_created:${session.id}` : null,
        pageType: 'lifetime',
        billingPeriod: 'lifetime',
        entitlementSource: directLtd.CHANNEL,
        appsumoTier: cfg.tier,
        experimentTag: extraMetadata.experimentTag || null,
        ...requestFields
    });
    return session;
}

/**
 * Payment confirmed. Mint a license key, record it in the SAME AppSumoLicense
 * collection the marketplace uses, then run the existing grant — which also
 * sends the existing redemption/onboarding email. Nothing here is a duplicate
 * of the AppSumo flow; it is the same flow entered with a key we issued.
 */
async function handleDirectLtdPaid(user, payload, event) {
    const tier = directLtd.normalizeTier(payload.metadata?.ltdTier)
        || directLtd.tierFromPriceId(payload.metadata?.stripePriceId);
    if (!tier) {
        console.error(`[direct-ltd] Paid session ${payload.id} has no resolvable tier; entitlement NOT granted. Manual review required.`);
        return;
    }
    // Idempotency: Stripe retries webhooks, and the buyer may also land on the
    // success URL. One paid session must produce exactly one license.
    const existing = await AppSumoLicense.findOne({ 'raw.stripeSessionId': payload.id }).lean();
    if (existing) return;
    if (user.appsumoRedeemedAt) {
        console.warn(`[direct-ltd] User ${user._id} already holds a lifetime entitlement; session ${payload.id} needs a manual refund decision.`);
        return;
    }

    const amountUsd = Number.isFinite(Number(payload.amount_total))
        ? Number(payload.amount_total) / 100
        : directLtd.tierConfig(tier).directUsd;

    const licenseKey = directLtd.mintLicenseKey(tier);
    await AppSumoLicense.create({
        licenseKey,
        status: 'active',
        tier,
        partnerPlanName: directLtd.tierConfig(tier).planName,
        userId: user._id,
        redeemedAt: new Date(),
        lastEvent: 'direct_purchase',
        lastEventAt: new Date(),
        // Channel and payment provenance live in `raw` so the shared schema is
        // not forked for one channel; stripeSessionId is the idempotency key.
        raw: {
            channel: directLtd.CHANNEL,
            stripeSessionId: payload.id,
            stripeEventId: event && event.id,
            amountUsd,
            currency: payload.currency || directLtd.USD,
            livemode: payload.livemode === true
        }
    });

    // Auto-redeem: reuse of the existing grant + confirmation email path.
    await grantAppSumoProAccess(user, {
        licenseKey,
        tier,
        channel: directLtd.CHANNEL,
        paidUsd: amountUsd,
        stripeSessionId: payload.id
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

// Records a self-serve registration that has not been paid for yet. Re-using
// the row for the same identity keeps a visitor who abandons checkout and
// comes back from accumulating rows, and keeps the latest password/plan.
async function createPendingSignup({ email, name, passwordHash, provider, providerUserId, avatarUrl, planId, utm, requestFields }) {
    const normalizedEmail = normalizeEmail(email);
    const query = provider && providerUserId
        ? { provider, providerUserId }
        : { email: normalizedEmail, provider: null };
    const attribution = (requestFields && requestFields.attribution) || null;
    return PendingSignup.findOneAndUpdate(
        query,
        {
            $set: {
                email: normalizedEmail,
                name: name || null,
                passwordHash: passwordHash || null,
                provider: provider || null,
                providerUserId: providerUserId || null,
                avatarUrl: avatarUrl || null,
                planId: getPlanConfig(planId).planId,
                signupUtm: utm ? { ...utm, capturedAt: new Date() } : null,
                attribution,
                expiresAt: new Date(Date.now() + PENDING_SIGNUP_TTL_MS)
            }
        },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
}

// The only place a paid-first account is born. Refuses outright unless Stripe
// says the session was actually paid, so "signed in" can never run ahead of
// "paid". Idempotent: a webhook redelivery, or the browser's /api/checkout/claim
// racing the webhook, both land on the same single user.
async function materializePendingSignup(pendingSignupId, session = {}) {
    if (!pendingSignupId) return null;
    let pending = null;
    try {
        pending = await PendingSignup.findById(pendingSignupId);
    } catch (_) {
        return null;
    }
    if (!pending) {
        console.warn(`[signup] pending signup ${pendingSignupId} is gone (expired before the payment landed)`);
        return null;
    }
    if (pending.userId) {
        const already = await User.findById(pending.userId);
        if (already) return already;
    }
    if (String(session.payment_status || '') !== 'paid') {
        console.warn(`[signup] pending signup ${pendingSignupId} not materialised: payment_status=${session.payment_status || 'unknown'}`);
        return null;
    }

    const planConfig = getPlanConfig(pending.planId);
    let user = await User.findOne({ email: pending.email });
    let created = false;
    if (!user) {
        user = new User({
            name: pending.name || deriveNameFromEmail(pending.email),
            email: pending.email,
            password: pending.passwordHash || null
        });
        created = true;
    }
    if (pending.provider === 'google' && !user.googleId) user.googleId = pending.providerUserId;
    if (pending.provider === 'facebook' && !user.facebookId) user.facebookId = pending.providerUserId;
    if (pending.avatarUrl && !user.avatarUrl) user.avatarUrl = pending.avatarUrl;
    if (created) {
        user.subscription = ensureSubscriptionShape(user);
        user.subscription.planId = planConfig.planId;
        user.subscription.planName = planConfig.planName;
        user.subscription.price = planConfig.price;
        user.subscription.currency = planConfig.currency;
        user.subscription.billingInterval = planConfig.billingInterval;
        user.subscription.stripePriceId = planConfig.stripePriceId || null;
        user.subscription.status = 'pending';
        user.subscription.trialStartedAt = new Date();
        user.subscription.trialEndsAt = null;
        user.subscription.activatedAt = null;
        user.subscription.renewedAt = null;
        user.subscription.lastPaymentAt = null;
        // The refund window opens on the first paid invoice; this only marks
        // the account as one that paid to exist. See recordInitialStripePayment().
        user.paymentRequiredAt = new Date();
        user.initialRefundStatus = 'not_eligible';
        if (pending.signupUtm) user.signupUtm = pending.signupUtm;
        if (pending.attribution) attachSignupAttribution(user, { attribution: pending.attribution });
        user.markModified('subscription');
    }
    if (typeof session.customer === 'string' && session.customer) user.stripeCustomerId = session.customer;
    try {
        await user.save();
    } catch (error) {
        // Two deliveries raced us to the same email. The unique index is the
        // real guard; take whichever document won.
        if (error && error.code === 11000) {
            const winner = await User.findOne({ email: pending.email });
            if (!winner) throw error;
            user = winner;
            created = false;
        } else {
            throw error;
        }
    }

    pending.userId = user._id;
    pending.consumedAt = pending.consumedAt || new Date();
    if (session.id) pending.stripeSessionId = session.id;
    await pending.save().catch((error) => console.error('[signup] pending signup close-out failed:', error && error.message));

    if (created) {
        // Everything that used to fire at form-submit time now fires here, on
        // the far side of the payment: the owner notification and the welcome
        // email describe a customer who actually paid.
        const source = pending.provider ? 'social' : 'direct';
        recordCustomerLifecycleEvent(user, 'signup', { source })
            .catch((e) => console.error('[customers] paid signup registry error:', e && e.message));
        sendNewUserEmails({
            name: user.name,
            email: user.email,
            plan: pending.provider ? `social (${pending.provider})` : planConfig.planName
        }).catch((e) => console.error('[mailer] new-user email error:', e && e.message));
        trackFunnel('signup', user._id, planConfig.planName, {
            authMethod: pending.provider || 'email',
            selectedPlan: planConfig.planId,
            utm: pending.signupUtm || null,
            entitlementSource: 'stripe'
        });
        trackFunnel('signup_completed', user._id, planConfig.planName, {
            eventName: 'signup_completed',
            dedupeKey: `signup-complete:${String(user._id)}`,
            authMethod: pending.provider || 'email',
            selectedPlan: planConfig.planId,
            utm: pending.signupUtm || null,
            entitlementSource: 'stripe'
        });
    }
    return user;
}

// Stripe replaces this template with the real session id on the success /
// return URL, which is what lets /api/checkout/claim finish a paid-first
// signup without waiting for webhook delivery.
function withCheckoutSessionIdParam(url) {
    const raw = String(url || '');
    if (!raw || raw.includes('{CHECKOUT_SESSION_ID}')) return raw;
    return `${raw}${raw.includes('?') ? '&' : '?'}session_id={CHECKOUT_SESSION_ID}`;
}

async function createCheckoutSessionForUser(user, extraMetadata = {}) {
    if (!stripe) {
        throw createHttpError(500, 'Stripe is not configured');
    }
    await ensureStripeAccountPreflight();
    // Paid-first signups have no account yet, so the checkout is keyed to a
    // PendingSignup row instead of a userId. Every other caller still passes
    // a real user and is unaffected.
    const pendingSignup = extraMetadata.pendingSignup || null;
    if (!user && !pendingSignup) {
        throw createHttpError(500, 'Checkout requires either a user or a pending signup');
    }
    const subjectEmail = user ? user.email : pendingSignup.email;
    const subjectRef = user ? user._id.toString() : `pending:${pendingSignup._id.toString()}`;
    const identityMetadata = user
        ? { userId: user._id.toString() }
        : { pendingSignupId: pendingSignup._id.toString() };
    const configuredPlan = getPlanConfig(extraMetadata.planId || user?.subscription?.planId);
    const planConfig = await resolveStripeCheckoutPlan(configuredPlan);
    if (!planConfig.stripePriceId) {
        throw createHttpError(500, `${planConfig.planName} Stripe price is not configured`);
    }
    const metadata = { ...(extraMetadata.metadata || {}), ...(extraMetadata.affiliateMetadata || {}) };
    const returnContext = extraMetadata.returnContext || {};
    const embedded = extraMetadata.uiMode === 'embedded';
    const urlParams = embedded
        ? {
            ui_mode: 'embedded',
            return_url: withCheckoutSessionIdParam(extraMetadata.returnUrl || buildStripeReturnUrl(extraMetadata.req, {
                session: 'success',
                planId: planConfig.planId,
                ...returnContext
            }))
        }
        : {
            success_url: withCheckoutSessionIdParam(extraMetadata.successUrl || buildStripeReturnUrl(extraMetadata.req, {
                session: 'success',
                planId: planConfig.planId,
                ...returnContext
            })),
            cancel_url: extraMetadata.cancelUrl || buildStripeReturnUrl(extraMetadata.req, {
                session: 'cancel',
                planId: planConfig.planId,
                ...returnContext
            })
        };
    const session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'subscription',
        customer_email: subjectEmail,
        line_items: [{
            price: planConfig.stripePriceId,
            quantity: 1
        }],
        client_reference_id: subjectRef,
        // Referral codes (GATTOMORTO et al.) are entered on this screen — the
        // coupon takes $24.99 off the first invoice, once. The one-off CNY and
        // credit-recharge sessions deliberately don't allow codes.
        allow_promotion_codes: true,
        ...urlParams,
        custom_text: {
            submit: {
                message: extraMetadata.initialSignup === true
                    ? `Charged today. If the service is not right for you, request a full refund within ${INITIAL_REFUND_DAYS} days.`
                    : 'Charged today for this upgrade. Cancel anytime before renewal.'
            }
        },
        subscription_data: {
            metadata: {
                ...identityMetadata,
                planId: planConfig.planId,
                billingInterval: planConfig.billingInterval,
                ...Object.fromEntries(Object.entries(extraMetadata.affiliateMetadata || {}).map(([key, value]) => [key, String(value)]))
            },
            ...((planConfig.trialDays > 0 && !extraMetadata.skipTrial) ? { trial_period_days: planConfig.trialDays } : {})
        },
        metadata: {
            ...identityMetadata,
            planId: planConfig.planId,
            billingInterval: planConfig.billingInterval,
            stripePriceId: planConfig.stripePriceId,
            ...metadata
        }
    });
    if (pendingSignup && session && session.id) {
        pendingSignup.stripeSessionId = session.id;
        await pendingSignup.save().catch((error) => console.error('[signup] pending session id save failed:', error && error.message));
    }
    const requestFields = extraMetadata.req ? trackingRequestFields(extraMetadata.req, null) : {};
    trackFunnel('stripe_checkout_created', user ? user._id : null, planConfig.planName, {
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
    // Which portfolio this holding belongs to. null/absent = the implicit
    // "Main" portfolio, so existing documents need no migration.
    portfolioId: { type: mongoose.Schema.Types.ObjectId, ref: 'Portfolio', default: null },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
});
const Stock = mongoose.model('Stock', StockSchema);

// User-created portfolios. "Main" is implicit (Stock.portfolioId null) and
// never gets a document here. Names are unique per user, case-insensitive;
// the routes enforce it and this index is defense-in-depth.
const PortfolioSchema = new mongoose.Schema({
    name: { type: String, required: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true }
}, { timestamps: true });
PortfolioSchema.index({ user: 1, name: 1 }, { unique: true });
const Portfolio = mongoose.model('Portfolio', PortfolioSchema);

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

// createIfMissing:false is the paid-first path — an unrecognised social
// identity must not become an account until Stripe has taken the money, so the
// caller gets { user: null } and routes the visitor to checkout instead.
async function findOrCreateSocialUser(profile, { createIfMissing = true } = {}) {
    const providerField = profile.provider === 'google' ? 'googleId' : 'facebookId';
    const lookup = [{ [providerField]: profile.providerUserId }];
    if (profile.email) {
        lookup.push({ email: profile.email });
    }

    let user = await User.findOne({ $or: lookup });
    const created = !user;
    if (!user) {
        if (!createIfMissing) return { user: null, created: false };
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
    if (REQUIRE_INITIAL_STRIPE_PAYMENT && !appsumoActivationSignup && planConfig.planId === FREE_PLAN_ID && SIGNUP_TRIAL_DAYS <= 0) {
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

        // Paid-first: create no account. The identity waits in PendingSignup
        // until Stripe confirms the payment (webhook, or the claim call the
        // browser makes on return), which is what materialises the User.
        // Walking away from this checkout leaves no account, no welcome mail,
        // no owner notification, and no email address held hostage.
        if (paymentRequired) {
            const pending = await createPendingSignup({
                email: normalizedEmail,
                name: displayName,
                passwordHash: hashedPassword,
                planId: planConfig.planId,
                utm,
                requestFields
            });
            const session = await createCheckoutSessionForUser(null, {
                req,
                pendingSignup: pending,
                planId: planConfig.planId,
                skipTrial: true,
                initialSignup: true,
                uiMode: 'embedded',
                returnUrl: buildStripeReturnUrl(req, {
                    session: 'success',
                    planId: planConfig.planId,
                    flow: 'register',
                    next: req.body?.next
                }),
                affiliateMetadata: await affiliateProgram.buildCheckoutMetadata({ req, newAccount: true }),
                metadata: {
                    authFlow: 'register',
                    checkoutType: 'email',
                    next: sanitizeRelativeAppPath(req.body?.next, 'news.html'),
                    billingInterval: planConfig.billingInterval,
                    ...acquisitionStripeMetadata(acquisition)
                }
            });
            if (!session?.client_secret) {
                throw createHttpError(
                    502,
                    'Checkout session could not be created. Please try again.',
                    'CHECKOUT_URL_MISSING',
                    { retryable: true }
                );
            }
            trackFunnel('signup_started', null, planConfig.planName, {
                eventName: 'signup_started',
                authMethod: 'email',
                selectedPlan: planConfig.planId,
                consent: req.body && req.body.analyticsConsent === true,
                utm,
                ...acquisitionFunnelFields(acquisition),
                ...requestFields
            });
            return res.status(200).json({ clientSecret: session.client_secret });
        }

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
        // Signup trial: a brand-new account choosing the free plan card gets a
        // short no-card Core trial instead of a bare free account, when enabled.
        let grantedSignupTrial = false;
        if (planConfig.planId === FREE_PLAN_ID && REQUIRE_INITIAL_STRIPE_PAYMENT && SIGNUP_TRIAL_DAYS > 0 && !user.signupTrialAt) {
            startSignupTrial(user);
            grantedSignupTrial = true;
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
                plan: FREE_PLAN_ID,
                trial: grantedSignupTrial
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
            uiMode: 'embedded',
            returnUrl: buildStripeReturnUrl(req, {
                session: 'success',
                planId: planConfig.planId,
                flow: 'register',
                next: req.body?.next
            }),
            affiliateMetadata: await affiliateProgram.buildCheckoutMetadata({ req, user }),
            metadata: {
                authFlow: 'register',
                checkoutType: 'email',
                next: sanitizeRelativeAppPath(req.body?.next, 'news.html'),
                billingInterval: planConfig.billingInterval,
                ...acquisitionStripeMetadata(acquisition)
            }
        });
        if (!session?.client_secret) {
            throw createHttpError(
                502,
                'Checkout session could not be created. Please try again.',
                'CHECKOUT_URL_MISSING',
                { retryable: true }
            );
        }
        res.status(200).json({ clientSecret: session.client_secret });
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

// Paid-first return path. Stripe sends the buyer back with the checkout
// session id; we re-read that session from Stripe (never trusting the
// browser's claim), create the account if the webhook has not landed yet, and
// hand back a token. This is what makes "account only after payment" invisible
// to the customer — they are signed in the moment they return, without the
// site ever having created an account for an unpaid visitor.
//
// Single-use and pending-signup-only: it can never mint a session for a
// pre-existing account, and a leaked return URL cannot be replayed once the
// buyer's own browser has used it.
app.post('/api/checkout/claim', checkoutClaimLimiter, async (req, res) => {
    const sessionId = String((req.body && (req.body.sessionId || req.body.session_id)) || '').trim();
    if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId)) {
        return res.status(400).json({ message: 'A Stripe checkout session id is required.', code: 'SESSION_ID_REQUIRED' });
    }
    if (!stripe) {
        return res.status(503).json({ message: 'Checkout is temporarily unavailable.', code: 'CHECKOUT_UNAVAILABLE' });
    }
    try {
        const session = await stripe.checkout.sessions.retrieve(sessionId);
        const pendingSignupId = session && session.metadata && session.metadata.pendingSignupId;
        if (!pendingSignupId) {
            return res.status(404).json({ message: 'This checkout cannot be claimed.', code: 'NOT_CLAIMABLE' });
        }
        if (session.payment_status !== 'paid') {
            return res.status(402).json({
                message: 'This checkout has not been paid yet.',
                code: 'PAYMENT_NOT_COMPLETED'
            });
        }
        const pending = await PendingSignup.findById(pendingSignupId).catch(() => null);
        if (pending && pending.claimedAt) {
            return res.status(409).json({ message: 'This checkout was already used. Please sign in.', code: 'ALREADY_CLAIMED' });
        }
        const user = await materializePendingSignup(pendingSignupId, session);
        if (!user) {
            return res.status(404).json({ message: 'This checkout is no longer claimable. Please sign in.', code: 'SIGNUP_NOT_FOUND' });
        }
        await PendingSignup.updateOne({ _id: pendingSignupId }, { $set: { claimedAt: new Date() } }).catch(() => {});
        // Activate from Stripe directly so access does not wait on webhook
        // delivery. Both paths are idempotent, so whichever runs second is a
        // no-op rather than a double grant.
        if (session.subscription) {
            try {
                const subscription = await stripe.subscriptions.retrieve(session.subscription);
                if (user.paymentRequiredAt && !user.initialPaymentAt && subscription.latest_invoice) {
                    const initialInvoice = typeof subscription.latest_invoice === 'string'
                        ? await stripe.invoices.retrieve(subscription.latest_invoice)
                        : subscription.latest_invoice;
                    if (initialInvoice && initialInvoice.status === 'paid') {
                        await recordInitialStripePayment(user, initialInvoice);
                    }
                }
                await syncSubscriptionFromStripe(user, subscription, session.customer);
            } catch (error) {
                // The webhook is still the authority; a failure here only
                // means the customer waits for it.
                console.error('[stripe] claim-time activation failed:', error && error.message);
            }
        }
        return res.status(200).json({
            token: createUserToken(user),
            subscription: normalizeSubscription(user.subscription)
        });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) {
            return res.status(503).json({ message: 'Database unavailable. Please try again shortly.', code: 'DATABASE_UNAVAILABLE' });
        }
        console.error('Checkout claim error:', error);
        return res.status(500).json({ message: 'Could not finish signing you in. Please try logging in.', code: 'CLAIM_FAILED' });
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
        cancelUrl: buildStripeReturnUrl(req, { session: 'cancel', flow: 'register' }),
        signupTrialDays: SIGNUP_TRIAL_DAYS
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
        // An AppSumo buyer redeeming with Google has already paid AppSumo.
        // Without this the paid-first policy would send them to Stripe and
        // charge them a second time for what they own for life. Same signed,
        // non-Stripe bypass /api/subscribe uses.
        const appsumoActivationSignup = isAppSumoActivationSignup(req);
        const paymentRequired = initialPaymentRequiredForSignup(planConfig.planId, appsumoActivationSignup);
        if (REQUIRE_INITIAL_STRIPE_PAYMENT && !appsumoActivationSignup && planConfig.planId === FREE_PLAN_ID && SIGNUP_TRIAL_DAYS <= 0) {
            return res.status(402).json({
                message: 'Please choose a paid plan to create an account. You can request a refund within 7 days if the service is not right for you.',
                code: 'PAID_PLAN_REQUIRED'
            });
        }
        const acquisition = shareCopy.parseAcquisitionCookieHeader(req.headers.cookie, { secret: JWT_SECRET });
        const requestFields = trackingRequestFields(req, res);
        const utm = requestUtm(req);
        const profile = await verifySocialIdentity(provider, req.body || {});
        const { user, created } = await findOrCreateSocialUser(profile, { createIfMissing: !paymentRequired });

        // Paid-first: a Google/Facebook identity we have never seen gets a
        // checkout, not an account and not a session cookie. The account is
        // created by the Stripe payment, not by the social login.
        if (!user) {
            if (!stripe) {
                return res.status(503).json({
                    message: 'Checkout is temporarily unavailable. Please try again shortly.',
                    code: 'CHECKOUT_UNAVAILABLE'
                });
            }
            const pending = await createPendingSignup({
                email: profile.email,
                name: profile.name,
                provider,
                providerUserId: profile.providerUserId,
                avatarUrl: profile.avatarUrl,
                planId: planConfig.planId,
                utm,
                requestFields
            });
            const session = await createCheckoutSessionForUser(null, {
                req,
                pendingSignup: pending,
                planId: planConfig.planId,
                skipTrial: true,
                initialSignup: true,
                affiliateMetadata: await affiliateProgram.buildCheckoutMetadata({ req, newAccount: true }),
                returnContext: { flow, provider, next: req.body?.next },
                metadata: {
                    authProvider: provider,
                    authFlow: flow,
                    checkoutType: 'social',
                    next: sanitizeRelativeAppPath(req.body?.next, 'news.html'),
                    billingInterval: planConfig.billingInterval,
                    ...acquisitionStripeMetadata(acquisition)
                }
            });
            trackFunnel('signup_started', null, planConfig.planName, {
                eventName: 'signup_started',
                authMethod: provider,
                selectedPlan: planConfig.planId,
                consent: req.body && req.body.analyticsConsent === true,
                utm,
                ...acquisitionFunnelFields(acquisition),
                ...requestFields
            });
            return res.status(200).json({
                url: session.url,
                created: false,
                provider,
                checkoutRequired: true,
                pendingSignup: true
            });
        }

        let normalized = ensureSubscriptionShape(user);

        if (created && appsumoActivationSignup) {
            attachSignupAttribution(user, requestFields);
            if (utm) user.signupUtm = { ...utm, capturedAt: new Date() };
            await user.save();
            recordCustomerLifecycleEvent(user, 'signup', { source: 'social' })
                .catch((e) => console.error('[customers] appsumo social signup registry error:', e && e.message));
            trackFunnel('signup', user._id, planConfig.planName, {
                authMethod: provider, selectedPlan: planConfig.planId, entitlementSource: 'appsumo',
                utm, ...acquisitionFunnelFields(acquisition), ...requestFields
            });
            trackFunnel('signup_completed', user._id, planConfig.planName, {
                eventName: 'signup_completed',
                dedupeKey: `signup-complete:${String(user._id)}`,
                authMethod: provider, selectedPlan: planConfig.planId, entitlementSource: 'appsumo',
                utm, ...acquisitionFunnelFields(acquisition), ...requestFields
            });
        }

        // The lifetime grant itself is applied by /api/appsumo/activate, which
        // the redeem page calls next with this token. Returning here keeps the
        // buyer away from every Stripe branch below.
        if (appsumoActivationSignup) {
            return res.status(200).json({
                token: createUserToken(user),
                subscription: normalizeSubscription(user.subscription),
                created,
                provider,
                appsumoActivation: true
            });
        }

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
            } else if (planConfig.planId === FREE_PLAN_ID && REQUIRE_INITIAL_STRIPE_PAYMENT && SIGNUP_TRIAL_DAYS > 0 && !user.signupTrialAt) {
                startSignupTrial(user);
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
            // A pending LTD signup (via /api/lifetime/signup) is a one-time
            // purchase, not a subscription plan — resuming it through
            // createCheckoutSessionForUser would start (or mis-price) a
            // subscription instead of the lifetime tier the buyer chose.
            if (user.pendingDirectLtdTier) {
                if (!directLtdStripe) {
                    return res.status(503).json({ message: 'Checkout is temporarily unavailable. Please try again shortly.', code: 'CHECKOUT_UNAVAILABLE' });
                }
                try {
                    const session = await createDirectLtdCheckoutSession(user, user.pendingDirectLtdTier, {
                        req,
                        affiliateMetadata: await affiliateProgram.buildCheckoutMetadata({ req, user }),
                        returnContext: { flow: 'login_resume_lifetime', next: req.body?.next }
                    });
                    if (!session?.url) return res.status(502).json({ message: 'Checkout session could not be created. Please try again.', code: 'CHECKOUT_URL_MISSING' });
                    const token = createUserToken(user);
                    return res.status(200).json({ token, url: session.url, subscription: normalized, checkoutRequired: true });
                } catch (ltdError) {
                    if (ltdError instanceof directLtd.PriceFloorViolation) {
                        return res.status(503).json({ message: 'Lifetime purchase is temporarily unavailable.', code: 'LIFETIME_UNAVAILABLE' });
                    }
                    if (ltdError && ltdError.status) {
                        return res.status(ltdError.status).json({ message: ltdError.message, code: 'LIFETIME_UNAVAILABLE' });
                    }
                    throw ltdError;
                }
            }
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
        // Lifetime-deal buyers (AppSumo + direct LTD share appsumoLicenseKey):
        // mirror the quota endpoint's appsumo payload so the nav tray and
        // /upgrade.html can route them correctly — tier 3 is the top tier and
        // only the AI-credit recharge applies to it.
        let appsumoPayload = null;
        if (user.appsumoLicenseKey) {
            let upgradeUrl = APPSUMO_ACCOUNT_URL;
            try {
                const lic = await AppSumoLicense.findOne({ licenseKey: user.appsumoLicenseKey }, { changePlanUrl: 1 }).lean();
                upgradeUrl = appsumoUpgradeUrl(lic);
            } catch (_) { /* fall back to account page */ }
            appsumoPayload = { isAppSumo: true, tier: Number(user.appsumoTier) || null, upgradeUrl };
        }
        res.json({
            ok: true,
            profile,
            subscription,
            ...(appsumoPayload ? { appsumo: appsumoPayload } : {}),
            initialRefund: {
                status: user.initialRefundStatus || 'not_eligible',
                eligibleUntil: user.initialRefundUntil || null,
                eligible: user.initialRefundStatus === 'eligible'
                    && user.initialRefundUntil
                    && new Date(user.initialRefundUntil).getTime() >= Date.now()
            },
            onboarding: onboardingState(user),
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

// ---- Private customer messaging ------------------------------------------------
// rin@gmail.com is deliberately checked from the authenticated account, never
// from a browser-supplied role or email field.
const CUSTOMER_MESSAGES_ADMIN_EMAIL = 'rin@gmail.com';
const customerMessageLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 80, standardHeaders: true, legacyHeaders: false, message: { message: 'Too many messages sent. Please try again shortly.' } });
function customerMessagesAdminOnly(req, res, next) {
    if (String(req.user && req.user.email || '').trim().toLowerCase() !== CUSTOMER_MESSAGES_ADMIN_EMAIL) {
        return res.status(403).json({ message: 'Administrator access required.' });
    }
    return next();
}
function cleanCustomerMessage(value) {
    const body = String(value || '').trim();
    return body && body.length <= 4000 ? body : null;
}
function cleanCustomerMessageSubject(value) {
    const subject = String(value || '').trim().replace(/\s+/g, ' ');
    return subject && subject.length <= 180 ? subject : null;
}
function customerMessageEmailUnsubToken(userId) {
    return jwt.sign({ userId: String(userId), p: 'customer-message-email' }, JWT_SECRET, { expiresIn: '365d' });
}
function customerMessageMailFor(user, subject, body) {
    const appUrl = String(process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro').replace(/\/$/, '');
    const inboxUrl = `${appUrl}/inbox.html`;
    const unsubscribeUrl = `${appUrl}/api/messages/unsubscribe?token=${encodeURIComponent(customerMessageEmailUnsubToken(user._id))}`;
    const first = String(user.name || '').trim().split(/\s+/)[0] || 'there';
    const safeBody = escapeHtml(body).replace(/\n/g, '<br>');
    return {
        subject,
        text: `Hi ${first},\n\n${body}\n\nReply in your private StockPortfolio.pro inbox: ${inboxUrl}\n\nTo stop these customer-message emails: ${unsubscribeUrl}\n\n— StockPortfolio.pro Support`,
        html: `<div style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:560px;margin:0 auto;color:#172033"><p>Hi ${escapeHtml(first)},</p><div style="white-space:normal;line-height:1.6">${safeBody}</div><p style="margin:22px 0"><a href="${escapeHtml(inboxUrl)}" style="background:#201f1d;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:700;display:inline-block">Reply in your private inbox</a></p><p style="font-size:12px;color:#64748b;line-height:1.55">This is a customer message from StockPortfolio.pro. <a href="${escapeHtml(unsubscribeUrl)}" style="color:#64748b">Stop customer-message emails</a>. In-app messages remain available in your account.</p></div>`
    };
}
async function sendCustomerMessageEmail(user, subject, body) {
    if (user.customerMessageEmailsOptOut) return { status: 'suppressed' };
    const email = customerMessageMailFor(user, subject, body);
    const sent = await mailer.sendMail({ to: user.email, subject: email.subject, html: email.html, text: email.text });
    return { status: sent ? 'sent' : 'failed' };
}
// Every inbound customer message pings the support inbox so a new thread
// never sits unread in admin-messages.html until someone happens to check it.
async function notifyAdminOfNewCustomerMessage(user, body) {
    const to = process.env.SUPPORT_INBOX_EMAIL || 'support@stockportfolio.pro';
    const text = [`From: ${user.email}`, user.name ? `Name: ${user.name}` : null, `When: ${new Date().toISOString()}`, '', body]
        .filter(Boolean).join('\n');
    await mailer.sendMail({
        to,
        subject: `New customer message — ${user.email}`,
        text,
        html: `<pre style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap">${escapeHtml(text)}</pre>`,
        replyTo: user.email
    });
}
async function getCustomerThread(userId) {
    let thread = await CustomerMessageThread.findOne({ userId });
    if (!thread) {
        try { thread = await CustomerMessageThread.create({ userId }); }
        catch (error) {
            if (error && error.code === 11000) thread = await CustomerMessageThread.findOne({ userId });
            else throw error;
        }
    }
    return thread;
}
function messageDto(message) {
    return { id: String(message._id), sender: message.sender, body: message.body, createdAt: message.createdAt, editedAt: message.editedAt || null };
}

app.get('/api/messages/unsubscribe', async (req, res) => {
    const page = (title, copy) => `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><main style="font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;max-width:520px;margin:54px auto;padding:0 20px;color:#172033;line-height:1.6"><h1>${title}</h1><p>${copy}</p></main>`;
    try {
        const decoded = jwt.verify(String(req.query.token || ''), JWT_SECRET);
        if (decoded.p !== 'customer-message-email') throw new Error('Wrong token purpose');
        await User.updateOne({ _id: decoded.userId }, { $set: { customerMessageEmailsOptOut: true } });
        res.type('html').send(page('Email messages turned off', 'You will no longer receive administrator customer-message emails. Your private in-app messages remain available whenever you sign in.'));
    } catch (_) {
        res.status(400).type('html').send(page('Invalid link', 'Please use the unsubscribe link from a recent StockPortfolio.pro email.'));
    }
});

app.get('/api/messages/unread-count', authMiddleware, async (req, res) => {
    try {
        const thread = await CustomerMessageThread.findOne({ userId: req.userId }).lean();
        res.set('Cache-Control', 'no-store').json({ unread: thread ? Number(thread.userUnread || 0) : 0 });
    } catch (error) {
        console.error('[messages] unread count failed:', error && error.message);
        res.status(500).json({ message: 'Unable to check messages.' });
    }
});

app.get('/api/messages/thread', authMiddleware, async (req, res) => {
    try {
        const thread = await getCustomerThread(req.userId);
        const messages = await CustomerMessage.find({ threadId: thread._id }).sort({ createdAt: 1 }).limit(500).lean();
        await CustomerMessageThread.updateOne({ _id: thread._id }, { $set: { userUnread: 0 } });
        res.set('Cache-Control', 'no-store').json({ messages: messages.map(messageDto) });
    } catch (error) {
        console.error('[messages] customer thread failed:', error && error.message);
        res.status(500).json({ message: 'Unable to load messages.' });
    }
});

app.post('/api/messages/thread', authMiddleware, customerMessageLimiter, async (req, res) => {
    const body = cleanCustomerMessage(req.body && req.body.body);
    if (!body) return res.status(400).json({ message: 'Write a message of up to 4,000 characters.' });
    try {
        const thread = await getCustomerThread(req.userId);
        const message = await CustomerMessage.create({ threadId: thread._id, sender: 'customer', body });
        await CustomerMessageThread.updateOne({ _id: thread._id }, { $set: { lastMessageAt: message.createdAt }, $inc: { adminUnread: 1 } });
        res.status(201).json({ message: messageDto(message) });
        notifyAdminOfNewCustomerMessage(req.user, body)
            .catch((error) => console.error('[messages] admin notify failed:', error && error.message));
    } catch (error) {
        console.error('[messages] customer send failed:', error && error.message);
        res.status(500).json({ message: 'Unable to send your message.' });
    }
});

// Edit/delete rules (both roles): sender of the message owns it; verify the thread
// belongs to the participant making the request. Only 'own' messages can be touched.
async function loadOwnedMessage(req, res, participantId, sender) {
    const id = String(req.params.messageId || '');
    if (!mongoose.Types.ObjectId.isValid(id)) { res.status(400).json({ message: 'Invalid message.' }); return null; }
    const message = await CustomerMessage.findById(id);
    if (!message || message.sender !== sender) { res.status(404).json({ message: 'Message not found.' }); return null; }
    const thread = await CustomerMessageThread.findById(message.threadId).lean();
    if (!thread || String(thread.userId) !== String(participantId)) { res.status(404).json({ message: 'Message not found.' }); return null; }
    return message;
}
app.patch('/api/messages/thread/:messageId', authMiddleware, customerMessageLimiter, async (req, res) => {
    const body = cleanCustomerMessage(req.body && req.body.body);
    if (!body) return res.status(400).json({ message: 'Write a message of up to 4,000 characters.' });
    try {
        const message = await loadOwnedMessage(req, res, req.userId, 'customer');
        if (!message) return;
        message.body = body; message.editedAt = new Date();
        await message.save();
        res.json({ message: messageDto(message) });
    } catch (error) {
        console.error('[messages] customer edit failed:', error && error.message);
        res.status(500).json({ message: 'Unable to edit your message.' });
    }
});
app.delete('/api/messages/thread/:messageId', authMiddleware, customerMessageLimiter, async (req, res) => {
    try {
        const message = await loadOwnedMessage(req, res, req.userId, 'customer');
        if (!message) return;
        await CustomerMessage.deleteOne({ _id: message._id });
        // Keep the directory's lastMessageAt honest if the deleted message was the newest.
        const last = await CustomerMessage.findOne({ threadId: message.threadId }).sort({ createdAt: -1 }).lean();
        if (last) await CustomerMessageThread.updateOne({ _id: message.threadId }, { $set: { lastMessageAt: last.createdAt } });
        res.json({ deleted: true });
    } catch (error) {
        console.error('[messages] customer delete failed:', error && error.message);
        res.status(500).json({ message: 'Unable to delete your message.' });
    }
});

// Customer directory for the message console. This is intentionally separate
// from the conversation list: a founder must be able to contact a customer who
// has never written first. Results are paginated and exclude the admin account.
app.get('/api/admin/messages/customers', authMiddleware, customerMessagesAdminOnly, async (req, res) => {
    try {
        const query = String(req.query.q || '').trim().slice(0, 120);
        const audience = String(req.query.audience || 'all').trim().toLowerCase();
        const page = Math.max(0, Math.min(Number.parseInt(req.query.page, 10) || 0, 10000));
        const limit = Math.max(1, Math.min(Number.parseInt(req.query.limit, 10) || 50, 100));
        if (!['all', 'paid', 'appsumo', 'free'].includes(audience)) return res.status(400).json({ message: 'Invalid audience.' });
        const filter = { email: { $ne: CUSTOMER_MESSAGES_ADMIN_EMAIL } };
        if (query) {
            const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            filter.$and = [{ $or: [{ email: new RegExp(escaped, 'i') }, { name: new RegExp(escaped, 'i') }] }];
        }
        if (audience === 'appsumo') filter.appsumoRedeemedAt = { $ne: null };
        if (audience === 'paid') {
            filter.appsumoRedeemedAt = null;
            filter['subscription.status'] = { $in: ['active', 'trialing', 'cancel_at_period_end'] };
            filter['subscription.planId'] = { $ne: 'free' };
        }
        if (audience === 'free') {
            filter.$and = [...(filter.$and || []), { $or: [{ 'subscription.planId': 'free' }, { 'subscription.status': { $in: ['pending', 'cancelled'] } }] }];
        }
        const [total, users] = await Promise.all([
            User.countDocuments(filter),
            User.find(filter, { name: 1, email: 1, subscription: 1, appsumoRedeemedAt: 1, customerMessageEmailsOptOut: 1, createdAt: 1 })
                .sort({ createdAt: -1, _id: -1 }).skip(page * limit).limit(limit).lean()
        ]);
        const ids = users.map((user) => user._id);
        const threads = ids.length ? await CustomerMessageThread.find({ userId: { $in: ids } }, { userId: 1, lastMessageAt: 1, adminUnread: 1 }).lean() : [];
        const threadByUser = new Map(threads.map((thread) => [String(thread.userId), thread]));
        res.set('Cache-Control', 'no-store').json({
            customers: users.map((user) => {
                const thread = threadByUser.get(String(user._id));
                return {
                    userId: String(user._id), name: user.name || '', email: user.email,
                    audience: user.appsumoRedeemedAt ? 'appsumo' : (user.subscription && user.subscription.planId !== 'free' ? 'paid' : 'free'),
                    plan: user.subscription && user.subscription.planName || 'Free',
                    emailOptedOut: !!user.customerMessageEmailsOptOut,
                    lastMessageAt: thread && thread.lastMessageAt || null, unread: thread ? Number(thread.adminUnread || 0) : 0
                };
            }),
            page, limit, total, hasMore: (page + 1) * limit < total
        });
    } catch (error) {
        console.error('[messages] customer directory failed:', error && error.message);
        res.status(500).json({ message: 'Unable to load customers.' });
    }
});

app.get('/api/admin/messages/threads', authMiddleware, customerMessagesAdminOnly, async (req, res) => {
    try {
        const query = String(req.query.q || '').trim().slice(0, 120);
        const userFilter = query ? { $or: [{ email: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }, { name: new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }] } : {};
        const users = await User.find(userFilter, { name: 1, email: 1 }).limit(100).lean();
        const ids = users.map((user) => user._id);
        const threads = ids.length ? await CustomerMessageThread.find({ userId: { $in: ids } }).lean() : [];
        const byUser = new Map(threads.map((thread) => [String(thread.userId), thread]));
        const rows = users.map((user) => {
            const thread = byUser.get(String(user._id));
            return { userId: String(user._id), name: user.name || '', email: user.email, lastMessageAt: thread && thread.lastMessageAt || null, unread: thread ? Number(thread.adminUnread || 0) : 0, hasConversation: !!thread };
        }).filter((row) => query || row.hasConversation).sort((a, b) => Number(b.unread) - Number(a.unread) || new Date(b.lastMessageAt || 0) - new Date(a.lastMessageAt || 0));
        res.set('Cache-Control', 'no-store').json({ threads: rows });
    } catch (error) {
        console.error('[messages] admin list failed:', error && error.message);
        res.status(500).json({ message: 'Unable to load customer conversations.' });
    }
});

app.get('/api/admin/messages/threads/:userId', authMiddleware, customerMessagesAdminOnly, async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.userId)) return res.status(400).json({ message: 'Invalid customer.' });
    try {
        const user = await User.findById(req.params.userId, { name: 1, email: 1 }).lean();
        if (!user) return res.status(404).json({ message: 'Customer not found.' });
        const thread = await getCustomerThread(user._id);
        const messages = await CustomerMessage.find({ threadId: thread._id }).sort({ createdAt: 1 }).limit(500).lean();
        await CustomerMessageThread.updateOne({ _id: thread._id }, { $set: { adminUnread: 0 } });
        res.set('Cache-Control', 'no-store').json({ customer: { id: String(user._id), name: user.name || '', email: user.email }, messages: messages.map(messageDto) });
    } catch (error) {
        console.error('[messages] admin thread failed:', error && error.message);
        res.status(500).json({ message: 'Unable to load this conversation.' });
    }
});

app.post('/api/admin/messages/threads/:userId', authMiddleware, customerMessagesAdminOnly, customerMessageLimiter, async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.userId)) return res.status(400).json({ message: 'Invalid customer.' });
    const body = cleanCustomerMessage(req.body && req.body.body);
    if (!body) return res.status(400).json({ message: 'Write a message of up to 4,000 characters.' });
    try {
        const user = await User.findById(req.params.userId, { _id: 1, name: 1, email: 1, customerMessageEmailsOptOut: 1 }).lean();
        if (!user) return res.status(404).json({ message: 'Customer not found.' });
        const thread = await getCustomerThread(user._id);
        const message = await CustomerMessage.create({ threadId: thread._id, sender: 'admin', body });
        await CustomerMessageThread.updateOne({ _id: thread._id }, { $set: { lastMessageAt: message.createdAt }, $inc: { userUnread: 1 } });
        let emailStatus = 'not_requested';
        if (req.body && req.body.sendEmail === true) {
            const subject = cleanCustomerMessageSubject(req.body.subject) || 'New message from StockPortfolio.pro';
            emailStatus = (await sendCustomerMessageEmail(user, subject, body)).status;
        }
        res.status(201).json({ message: messageDto(message), emailStatus });
    } catch (error) {
        console.error('[messages] admin send failed:', error && error.message);
        res.status(500).json({ message: 'Unable to send the message.' });
    }
});
app.patch('/api/admin/messages/threads/:userId/:messageId', authMiddleware, customerMessagesAdminOnly, customerMessageLimiter, async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.userId)) return res.status(400).json({ message: 'Invalid customer.' });
    const body = cleanCustomerMessage(req.body && req.body.body);
    if (!body) return res.status(400).json({ message: 'Write a message of up to 4,000 characters.' });
    try {
        const message = await loadOwnedMessage(req, res, req.params.userId, 'admin');
        if (!message) return;
        message.body = body; message.editedAt = new Date();
        await message.save();
        res.json({ message: messageDto(message) });
    } catch (error) {
        console.error('[messages] admin edit failed:', error && error.message);
        res.status(500).json({ message: 'Unable to edit the message.' });
    }
});
app.delete('/api/admin/messages/threads/:userId/:messageId', authMiddleware, customerMessagesAdminOnly, customerMessageLimiter, async (req, res) => {
    if (!mongoose.Types.ObjectId.isValid(req.params.userId)) return res.status(400).json({ message: 'Invalid customer.' });
    try {
        const message = await loadOwnedMessage(req, res, req.params.userId, 'admin');
        if (!message) return;
        await CustomerMessage.deleteOne({ _id: message._id });
        const last = await CustomerMessage.findOne({ threadId: message.threadId }).sort({ createdAt: -1 }).lean();
        if (last) await CustomerMessageThread.updateOne({ _id: message.threadId }, { $set: { lastMessageAt: last.createdAt } });
        res.json({ deleted: true });
    } catch (error) {
        console.error('[messages] admin delete failed:', error && error.message);
        res.status(500).json({ message: 'Unable to delete the message.' });
    }
});

app.post('/api/admin/messages/broadcasts', authMiddleware, customerMessagesAdminOnly, customerMessageLimiter, async (req, res) => {
    const body = cleanCustomerMessage(req.body && req.body.body);
    const sendInApp = req.body && req.body.sendInApp !== false;
    const sendEmail = !!(req.body && req.body.sendEmail);
    const subject = sendEmail ? cleanCustomerMessageSubject(req.body && req.body.subject) : (cleanCustomerMessageSubject(req.body && req.body.subject) || 'New message from StockPortfolio.pro');
    const idempotencyKey = String(req.body && req.body.idempotencyKey || '').trim();
    const rawIds = Array.isArray(req.body && req.body.userIds) ? req.body.userIds : [];
    const userIds = [...new Set(rawIds.map(String))];
    if (!body) return res.status(400).json({ message: 'Write a message of up to 4,000 characters.' });
    if (!sendInApp && !sendEmail) return res.status(400).json({ message: 'Choose in-app delivery, email delivery, or both.' });
    if (sendEmail && !subject) return res.status(400).json({ message: 'An email subject of up to 180 characters is required.' });
    if (!userIds.length || userIds.length > 100 || userIds.some((id) => !mongoose.Types.ObjectId.isValid(id))) return res.status(400).json({ message: 'Select between 1 and 100 valid customers.' });
    if (!/^[A-Za-z0-9_-]{16,160}$/.test(idempotencyKey)) return res.status(400).json({ message: 'Invalid send request. Refresh the page and try again.' });
    try {
        let broadcast = await CustomerMessageBroadcast.findOne({ idempotencyKey });
        if (!broadcast) {
            const users = await User.find({ _id: { $in: userIds }, email: { $ne: CUSTOMER_MESSAGES_ADMIN_EMAIL } }, { _id: 1, email: 1, customerMessageEmailsOptOut: 1 }).lean();
            if (!users.length) return res.status(404).json({ message: 'No selected customers were found.' });
            // Typed confirmation is only worth the friction for a real batch.
            if (users.length > 1 && String(req.body && req.body.confirmation || '') !== `SEND ${users.length}`) {
                return res.status(400).json({ message: `Type SEND ${users.length} to confirm this delivery.` });
            }
            try {
                broadcast = await CustomerMessageBroadcast.create({
                    idempotencyKey, createdBy: req.userId, subject, body, sendInApp, sendEmail,
                    recipients: users.map((user) => ({ userId: user._id, email: user.email, emailStatus: sendEmail ? (user.customerMessageEmailsOptOut ? 'suppressed' : 'pending') : 'not_requested' }))
                });
            } catch (error) {
                if (error && error.code === 11000) broadcast = await CustomerMessageBroadcast.findOne({ idempotencyKey });
                else throw error;
            }
        }
        for (const recipient of broadcast.recipients) {
            if (broadcast.sendInApp && !recipient.inAppSentAt) {
                const thread = await getCustomerThread(recipient.userId);
                const prior = await CustomerMessage.findOne({ threadId: thread._id, broadcastId: broadcast._id }).lean();
                if (!prior) {
                    const message = await CustomerMessage.create({ threadId: thread._id, sender: 'admin', body: broadcast.body, broadcastId: broadcast._id });
                    await CustomerMessageThread.updateOne({ _id: thread._id }, { $set: { lastMessageAt: message.createdAt }, $inc: { userUnread: 1 } });
                }
                recipient.inAppSentAt = new Date();
            }
            if (broadcast.sendEmail && recipient.emailStatus === 'pending') {
                const user = await User.findById(recipient.userId, { _id: 1, name: 1, email: 1, customerMessageEmailsOptOut: 1 }).lean();
                const result = user ? await sendCustomerMessageEmail(user, broadcast.subject, broadcast.body) : { status: 'failed' };
                recipient.emailStatus = result.status;
                recipient.emailSentAt = result.status === 'sent' ? new Date() : null;
                recipient.emailError = result.status === 'failed' ? 'SMTP delivery was not accepted.' : null;
            }
            await broadcast.save();
        }
        const counts = broadcast.recipients.reduce((out, recipient) => {
            out.total++; if (recipient.inAppSentAt) out.inApp++; out[recipient.emailStatus] = (out[recipient.emailStatus] || 0) + 1; return out;
        }, { total: 0, inApp: 0 });
        broadcast.status = counts.failed ? 'completed_with_errors' : 'completed';
        broadcast.completedAt = new Date();
        await broadcast.save();
        res.status(201).json({ broadcastId: String(broadcast._id), status: broadcast.status, counts });
    } catch (error) {
        console.error('[messages] broadcast failed:', error && error.message);
        res.status(500).json({ message: 'Unable to complete this customer delivery. It is safe to retry from the same page.' });
    }
});

// Keep the operator URL protected as well as the underlying API. The static
// file is intentionally still harmless if guessed: it cannot fetch data unless
// the authenticated account is rin@gmail.com.
app.get('/admin/messages', authMiddleware, customerMessagesAdminOnly, (req, res) => {
    res.set('Cache-Control', 'no-store').sendFile(path.join(__dirname, '../frontend-v2/admin-messages.html'));
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

// One-time credit refill. Unlike the subscription checkout this charges a
// fixed USD amount today and grants nothing until the webhook's
// checkout.session.completed sees payment_status 'paid' — the same shape as
// the china pass / direct-LTD one-time paths, for the same reasons.
app.post('/api/credits/topup', authMiddleware, async (req, res) => {
    try {
        if (!stripe || !stripeSecretKey) {
            return res.status(503).json({ message: 'Checkout is temporarily unavailable. Please try again shortly.', code: 'CHECKOUT_UNAVAILABLE' });
        }
        if (!STRIPE_PRICE_ID_CREDITS_TOPUP) {
            return res.status(503).json({ message: 'Credit refills are not available yet.', code: 'TOPUP_UNAVAILABLE' });
        }
        const price = await stripe.prices.retrieve(STRIPE_PRICE_ID_CREDITS_TOPUP, { expand: ['product'] });
        const expectedAmount = Math.round(CREDIT_TOPUP_PRICE * 100);
        const product = price?.product;
        const isActive = price?.active === true
            && Number(price?.unit_amount) === expectedAmount
            && String(price?.currency || '').toLowerCase() === 'usd';
        if (!isActive) {
            console.error(`[credits] topup price ${STRIPE_PRICE_ID_CREDITS_TOPUP} is misconfigured (active=${price?.active}, amount=${price?.unit_amount}, currency=${price?.currency}); refusing to sell.`);
            return res.status(503).json({ message: 'Credit refills are not available right now. Please try again shortly.', code: 'TOPUP_UNAVAILABLE' });
        }
        const productName = typeof product === 'object' ? (product?.name || 'Credit refill') : 'Credit refill';
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'payment',
            customer_email: req.user.email,
            line_items: [{ price: price.id, quantity: 1 }],
            client_reference_id: req.userId.toString(),
            success_url: `${getRequestOrigin(req)}/profile.html?recharge=success#usage-details`,
            cancel_url: `${getRequestOrigin(req)}/recharge.html?recharge=cancelled`,
            custom_text: { submit: { message: `Adds ${CREDIT_TOPUP_CREDITS} credits to this month's wallet. Final-month credits don't roll over.` } },
            metadata: {
                userId: String(req.userId),
                checkoutType: 'credit_topup',
                credits: String(CREDIT_TOPUP_CREDITS),
                product: productName
            }
        });
        if (!session?.url) {
            return res.status(502).json({ message: 'Checkout session could not be created. Please try again.', code: 'CHECKOUT_URL_MISSING' });
        }
        res.json({ url: session.url });
    } catch (error) {
        console.error('/api/credits/topup error:', error && error.message);
        res.status(500).json({ message: 'Unable to start checkout right now.' });
    }
});

// Whether the Alipay/WeChat Pay one-time annual pass can actually be started
// right now — gates the CN payment button in the /zh pricing UI so it never
// offers a checkout Stripe will reject (see chinaCheckoutPaymentMethods()).
app.get('/api/checkout/china/availability', (req, res) => {
    const methods = chinaCheckoutPaymentMethods();
    res.json({ available: methods.length > 0, methods, amountCny: CHINA_ANNUAL_PASS_CNY_AMOUNT });
});

app.post('/api/checkout/china', authMiddleware, async (req, res) => {
    try {
        const session = await createChinaAnnualCheckoutSession(req.user, {
            req,
            returnContext: { flow: 'china_annual', next: req.body?.next }
        });
        if (!session?.url) {
            return res.status(502).json({ message: 'Checkout session could not be created. Please try again.', code: 'CHECKOUT_URL_MISSING' });
        }
        res.json({ url: session.url });
    } catch (error) {
        if (error && error.status === 503) {
            return res.status(503).json({ message: error.message, code: 'CHINA_CHECKOUT_UNAVAILABLE' });
        }
        console.error('/api/checkout/china error:', error);
        res.status(500).json({ message: 'Unable to start checkout right now.' });
    }
});

// Public tier/price list for the /lifetime page. Copy-safe only: prices and
// Ask caps, never Price IDs or Stripe state.
app.get('/api/lifetime/config', (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({
        enabled: directLtd.enabled() && directLtd.priceFloorsOk(),
        currency: directLtd.USD,
        tiers: directLtd.publicTiers(),
        refundDays: directLtd.refundDays()
    });
});

// Pricing-experiment config for /pricing. Purely read-only: this endpoint
// never mutates the mode, only reports it (and pricing-experiment.js
// re-validates the activation timestamp on every call, so a stale/expired
// mode can never be reported as 'ltd_only').
app.get('/api/pricing/experiment', (req, res) => {
    res.set('Cache-Control', 'no-store');
    const mode = pricingExperiment.mode();
    res.json({
        mode,
        revertsAt: pricingExperiment.revertsAt(),
        tiers: mode === 'ltd_only' ? directLtd.publicTiers() : [],
        refundDays: directLtd.refundDays()
    });
});

app.post('/api/checkout/lifetime', authMiddleware, async (req, res) => {
    const tier = directLtd.normalizeTier(req.body?.tier);
    if (!tier) {
        return res.status(400).json({ message: 'Choose a lifetime tier.', code: 'LIFETIME_TIER_INVALID' });
    }
    try {
        const experimentTag = req.body?.experiment === pricingExperiment.CHANNEL_TAG ? pricingExperiment.CHANNEL_TAG : null;
        const uiMode = req.body?.uiMode === 'embedded' ? 'embedded' : undefined;
        const session = await createDirectLtdCheckoutSession(req.user, tier, {
            req,
            uiMode,
            affiliateMetadata: await affiliateProgram.buildCheckoutMetadata({ req, user: req.user }),
            returnContext: { flow: 'direct_ltd', next: req.body?.next },
            experimentTag
        });
        if (uiMode === 'embedded') {
            if (!session?.client_secret) {
                return res.status(502).json({ message: 'Checkout session could not be created. Please try again.', code: 'CHECKOUT_URL_MISSING' });
            }
            return res.json({ clientSecret: session.client_secret });
        }
        if (!session?.url) {
            return res.status(502).json({ message: 'Checkout session could not be created. Please try again.', code: 'CHECKOUT_URL_MISSING' });
        }
        res.json({ url: session.url });
    } catch (error) {
        // An exclusivity-floor violation must never degrade into a sale. It
        // surfaces as "unavailable" to the buyer and as a loud error in logs.
        if (error instanceof directLtd.PriceFloorViolation) {
            console.error('[direct-ltd] Refusing checkout:', error.message);
            return res.status(503).json({ message: 'Lifetime purchase is temporarily unavailable.', code: 'LIFETIME_UNAVAILABLE' });
        }
        if (error && error.status === 409) {
            return res.status(409).json({ message: error.message, code: 'LIFETIME_ALREADY_OWNED' });
        }
        if (error && (error.status === 503 || error.status === 400)) {
            return res.status(error.status).json({ message: error.message, code: 'LIFETIME_UNAVAILABLE' });
        }
        console.error('/api/checkout/lifetime error:', error);
        res.status(500).json({ message: 'Unable to start checkout right now.' });
    }
});

// Account creation for a logged-out LTD buyer, mirroring /api/subscribe's
// signup step (same validation, same embedded-checkout handoff) but kept as
// its own route so the shared subscription-signup path is never touched by
// LTD-specific logic. Returns a clientSecret for Stripe's embedded checkout,
// exactly like /api/subscribe does for card-required subscription plans.
app.post('/api/lifetime/signup', subscribeLimiter, async (req, res) => {
    const { email, password } = req.body || {};
    if (String(req.body?.website || '').trim()) {
        return res.status(200).json({ ok: true });
    }
    const tier = directLtd.normalizeTier(req.body?.tier);
    if (!tier) {
        return sendApiError(res, createHttpError(400, 'Choose a lifetime tier.', 'LIFETIME_TIER_INVALID'));
    }
    const rawEmail = String(email || '').trim();
    const normalizedEmail = normalizeEmail(email);
    if (!rawEmail) {
        return sendApiError(res, createHttpError(400, 'Please enter your email address.', 'EMAIL_REQUIRED', { field: 'email' }));
    }
    if (!emailLooksValid(rawEmail)) {
        return sendApiError(res, createHttpError(400, 'Please enter a valid email address.', 'EMAIL_INVALID', { field: 'email' }));
    }
    if (SMS_GATEWAY_DOMAINS.has(normalizedEmail.split('@')[1] || '')) {
        return sendApiError(res, createHttpError(400, 'Please sign up with a regular email address.', 'EMAIL_INVALID', { field: 'email' }));
    }
    if (typeof password !== 'string' || !password) {
        return sendApiError(res, createHttpError(400, 'Please create a password before continuing.', 'PASSWORD_REQUIRED', { field: 'password' }));
    }
    if (!passwordMeetsPolicy(password)) {
        return sendApiError(res, createHttpError(400, 'Password must be at least 8 characters and include uppercase, lowercase, and a number.', 'PASSWORD_POLICY_FAILED', { field: 'password' }));
    }
    if (!directLtdStripe) {
        return sendApiError(res, createHttpError(503, 'Checkout is temporarily unavailable. Please try again shortly.', 'CHECKOUT_UNAVAILABLE', { retryable: true }));
    }
    try {
        const existingUser = await User.findOne({ email: normalizedEmail }).select('_id');
        if (existingUser) {
            return sendApiError(res, createHttpError(409, 'This email is already registered. Use a different email address or sign in with the existing account.', 'EMAIL_ALREADY_REGISTERED', { field: 'email' }));
        }

        const requestFields = trackingRequestFields(req, res);
        const utm = requestUtm(req);
        const hashedPassword = await bcrypt.hash(password, 10);
        const displayName = deriveNameFromEmail(normalizedEmail);
        const user = new User({ name: displayName, email: normalizedEmail, password: hashedPassword });
        if (utm) user.signupUtm = { ...utm, capturedAt: new Date() };
        attachSignupAttribution(user, requestFields);

        user.subscription = ensureSubscriptionShape(user);
        user.subscription.status = 'pending';
        user.subscription.planId = PRO_PLAN_ID;
        user.subscription.planName = 'Pro';
        user.paymentRequiredAt = new Date();
        user.initialRefundStatus = 'not_eligible';
        user.pendingDirectLtdTier = tier;
        user.markModified('subscription');
        await user.save();

        recordCustomerLifecycleEvent(user, 'signup', { source: 'direct' })
            .catch((e) => console.error('[customers] signup registry error:', e && e.message));
        sendNewUserEmails({ name: displayName, email: normalizedEmail, plan: 'Pro (lifetime)' })
            .catch((e) => console.error('[mailer] new-user email error:', e && e.message));
        trackFunnel('signup', user._id, 'Pro', {
            authMethod: 'email', selectedPlan: 'lifetime', pageType: 'lifetime', utm, ...requestFields
        });

        const experimentTag = req.body?.experiment === pricingExperiment.CHANNEL_TAG ? pricingExperiment.CHANNEL_TAG : null;
        const session = await createDirectLtdCheckoutSession(user, tier, {
            req,
            uiMode: 'embedded',
            affiliateMetadata: await affiliateProgram.buildCheckoutMetadata({ req, user }),
            returnContext: { flow: 'lifetime_signup', next: req.body?.next },
            experimentTag
        });
        if (!session?.client_secret) {
            throw createHttpError(502, 'Checkout session could not be created. Please try again.', 'CHECKOUT_URL_MISSING', { retryable: true });
        }
        res.status(200).json({ clientSecret: session.client_secret });
    } catch (error) {
        if (error instanceof directLtd.PriceFloorViolation) {
            console.error('[direct-ltd] Refusing checkout:', error.message);
            return sendApiError(res, createHttpError(503, 'Lifetime purchase is temporarily unavailable.', 'LIFETIME_UNAVAILABLE'));
        }
        if (error && error.status) {
            return sendApiError(res, error);
        }
        console.error('/api/lifetime/signup error:', error);
        sendApiError(res, createHttpError(500, 'Unable to start checkout right now.'));
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
    const directory = searchFundDirectory(query, limit);
    try {
        const remote = (await alphaClient.searchSymbols(query))
            .filter((row) => {
                const sym = row.symbol || '';
                // Filter out country-suffixed symbols (.TO, .L, etc.). {1,4},
                // not {2,4}: London's one-letter suffix slipped the old bound,
                // so SPYY.L was offered for "SPY" and would 404 on the profile
                // route, which normalizes dots to dashes for US class shares.
                if (/\.[A-Z]{1,4}$/.test(sym)) return false;
                // Filter out ISIN codes: 8+ chars starting with digit
                if (sym.length >= 8 && /^[0-9]/.test(sym)) return false;
                // Filter out very long symbols with digits (likely ISINs or foreign codes)
                if (sym.length > 7 && /[0-9]/.test(sym)) return false;
                return true;
            });
        const seen = new Set();
        const take = (row) => row.symbol && !seen.has(row.symbol) && seen.add(row.symbol);
        // Local first in the dedupe only: its rows carry sector data the Yahoo
        // rows lack, so a symbol in both keeps the richer copy.
        const localRows = local.filter(take);
        const directoryRows = directory.filter(take);
        const remoteRows = remote.map((row) => ({
            ...row, assetTypeLabel: assetProfile.assetTypeLabel(row.assetType)
        })).filter(take);

        // Ranking, not concatenation. The old code put all of `local` ahead of
        // every Yahoo row and truncated to `limit`, so any query that prefix-
        // matched several of the 99 directory companies filled the page with
        // equities and no fund could appear at all: measured 2026-09-07, "v",
        // "s", "i" and "a" each returned 8 local stocks and zero ETFs, which is
        // why VOO and VTI were unreachable by typing "v".
        const rank = (rows) => rows
            .map((row, i) => ({ row, i, score: assetMatchScore(query, row.symbol, row.name) }))
            .sort((a, b) => b.score - a.score || a.i - b.i)
            .map((entry) => entry.row);

        let out = rank(localRows.concat(directoryRows, remoteRows)).slice(0, limit);
        // ...and a floor for funds, so a directory full of near-ties can never
        // shut them out again. Reserving rather than sorting alone keeps an
        // exact ticker match first: the quota is zero when nothing matches.
        // Funds only. Anything-but-stock would also reserve slots for futures
        // (SI=F), indices (^VIX) and coins (SHIB-USD), which is how the quota
        // first behaved — it promoted those over real matches.
        const funds = directoryRows.concat(remoteRows).filter((row) => row.assetType === 'etf' || row.assetType === 'mutual_fund');
        const quota = Math.min(funds.length, Math.floor(limit / 2));
        const shown = out.filter((row) => row.assetType === 'etf' || row.assetType === 'mutual_fund').length;
        if (shown < quota) {
            const missing = funds.filter((row) => !out.includes(row)).slice(0, quota - shown);
            out = rank(out.slice(0, Math.max(0, limit - missing.length)).concat(missing));
        }
        return res.json(out.slice(0, limit));
    } catch (_) {
        // Yahoo unreachable: the two local directories are still a useful answer.
        const seen = new Set();
        return res.json(local.concat(directory)
            .filter((row) => row.symbol && !seen.has(row.symbol) && seen.add(row.symbol))
            .sort((a, b) => assetMatchScore(query, b.symbol, b.name) - assetMatchScore(query, a.symbol, a.name))
            .slice(0, limit));
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

// Every position a fund holds, from its latest SEC Form N-PORT. Yahoo's
// topHoldings module is capped at ten rows for every fund on earth, so it can
// only ever answer "the top ten"; N-PORT answers "all 508". Paged, because the
// long tail is real — VTSAX files 3,546 positions and BND files 17,409.
app.get('/api/assets/:symbol/holdings', async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!symbol) return res.status(400).json({ message: 'symbol is required' });
    const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 1000);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    try {
        const profile = await assetProfile.fetchAssetProfile(symbol);
        if (!assetProfile.isFundAsset(profile.assetType)) {
            return res.status(400).json({ message: `${symbol} is not an ETF or mutual fund.` });
        }
        const full = await fundHoldings.fetchFundHoldings(symbol);
        if (!full) {
            // Commodity and crypto grantor trusts (GLD, IBIT) hold bullion or
            // coin rather than securities and file no N-PORT, and a fund that
            // has just launched has not filed one yet. Yahoo's short list is
            // then all there is, and `complete: false` says so.
            const rows = profile.topHoldings || [];
            return res.json({
                symbol, complete: false, source: profile.source, sourceUrl: null,
                asOf: null, filedAt: null, count: rows.length, offset: 0,
                holdings: rows.slice(offset, offset + limit)
            });
        }
        const page = fundHoldings.mergeSymbols(full.holdings.slice(offset, offset + limit), profile.topHoldings);
        return res.json({
            symbol, complete: true, source: full.source, sourceUrl: full.sourceUrl,
            asOf: full.asOf, filedAt: full.filedAt, count: full.count, offset,
            holdings: page
        });
    } catch (error) {
        return res.status(error.status || 502).json({ message: error.message || 'Fund holdings are unavailable' });
    }
});

// The fee table as filed in the fund's prospectus. Separate from the profile
// route because a cold lookup runs to several seconds and the profile races it
// against a 2.5s budget: the page calls this afterwards so a fund whose filing
// had not been fetched yet still shows the filed figure on this visit rather
// than waiting out the 30-minute profile cache.
app.get('/api/assets/:symbol/fees', async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!symbol) return res.status(400).json({ message: 'symbol is required' });
    try {
        const fees = await fundFees.fetchFundFees(symbol);
        if (!fees) return res.status(404).json({ message: `No filed fee table for ${symbol}.` });
        return res.json(fees);
    } catch (error) {
        return res.status(error.status || 502).json({ message: error.message || 'Fund fees are unavailable' });
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
        // Tier meter v2 — history depth. Inert unless ENABLE_TIER_V2_LIMITS=true
        // and this account redeemed on/after TIER_V2_EFFECTIVE_FROM; every
        // existing redeemer always comes back unlimited. See lib/tier-limits.js.
        if (tierLimits.enabled()) {
            const years = tierLimits.limitsFor(req.user).historyYearsLimit;
            if (Number.isFinite(years)) {
                for (const st of ['income', 'balance', 'cash']) {
                    const s = payload[st];
                    if (s && Array.isArray(s.annualReports)) s.annualReports = s.annualReports.slice(0, years);
                    if (s && Array.isArray(s.quarterlyReports)) s.quarterlyReports = s.quarterlyReports.slice(0, years * 4);
                }
                payload.historyYearsLimit = years;
            }
        }
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

// Cache-key half of the scope: 'all' | 'main' | the portfolio id verbatim.
function portfolioScopeKey(rawScope) {
    const scope = String(rawScope || '').trim();
    return scope === '' ? 'all' : scope;
}

// Resolves the switcher's ?portfolioId= param ('all' | 'main' | ObjectId)
// into a Mongo filter on Stock. Returns null for the whole account and
// false when the value is neither (caller should 400).
function portfolioScopeFilter(rawScope) {
    const scope = String(rawScope || '').trim();
    if (scope === '' || scope === 'all') return null;
    if (scope === 'main') return { portfolioId: null };
    if (!/^[0-9a-f]{24}$/i.test(scope)) return false;
    return { portfolioId: scope };
}

// The analysis caches are keyed `${userId}|${scope}`. Any holding mutation
// can affect every scope, so invalidation sweeps all of a user's variants.
function invalidatePortfolioCaches(userId) {
    const id = String(userId);
    const prefix = `${id}|`;
    for (const cache of [_briefingCache, _xrayCache, _attribCache]) {
        for (const key of [...cache.keys()]) {
            if (key === id || key.startsWith(prefix)) cache.delete(key);
        }
    }
}

app.get('/api/portfolio', authMiddleware, coreGate, async (req, res) => {
    try {
        const ownerId = portfolioOwnerId(req);
        const storedOnly = String(req.query.prices || '').toLowerCase() === 'stored';
        const scopeFilter = portfolioScopeFilter(req.query.portfolioId);
        if (scopeFilter === false) return res.status(400).json({ message: 'Unknown portfolio.' });
        const portfolio = await Stock.find({ user: ownerId, ...(scopeFilter || {}) });
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

// ----- Multiple portfolios -----
// "Main" is implicit (holdings with portfolioId null) and is synthesized
// here with the sentinel id 'main'; user-created portfolios follow.
app.get('/api/portfolios', authMiddleware, coreGate, async (req, res) => {
    try {
        const ownerId = portfolioOwnerId(req);
        const [mainCount, list] = await Promise.all([
            Stock.countDocuments({ user: ownerId, portfolioId: null }),
            Portfolio.find({ user: ownerId }).sort({ name: 1 }).lean()
        ]);
        const counts = await Promise.all(list.map((p) =>
            Stock.countDocuments({ user: ownerId, portfolioId: p._id })));
        const portfolios = [
            { id: 'main', name: 'Main', holdingsCount: mainCount },
            ...list.map((p, i) => ({ id: String(p._id), name: p.name, holdingsCount: counts[i] }))
        ];
        res.json({ portfolios });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).json({ message: 'Database unavailable.' });
        res.status(500).json({ message: 'Unable to load portfolios right now.' });
    }
});

app.post('/api/portfolios', authMiddleware, coreGate, async (req, res) => {
    try {
        const ownerId = portfolioOwnerId(req);
        const name = String((req.body || {}).name || '').trim();
        if (name.length < 1 || name.length > 40) {
            return res.status(400).json({ message: 'Portfolio name must be 1-40 characters.' });
        }
        const existing = await Portfolio.find({ user: ownerId }).select('name').lean();
        const lower = name.toLowerCase();
        if (lower === 'main' || existing.some((p) => String(p.name).toLowerCase() === lower)) {
            return res.status(409).json({ message: `You already have a portfolio named "${name}".` });
        }
        // Tier cap counts the implicit "Main" too, so tier 1 (=1) is exactly the
        // single-portfolio product that shipped before this feature. No-ops
        // entirely while ENABLE_TIER_V2_LIMITS is off, and never applies to an
        // account that redeemed before TIER_V2_EFFECTIVE_FROM.
        if (tierLimits.wouldExceedPortfolios(req.user, existing.length + 1)) {
            const { maxPortfolios } = tierLimits.limitsFor(req.user);
            return res.status(402).json({
                message: maxPortfolios === 1
                    ? 'Your plan includes a single portfolio. Upgrade to keep separate portfolios.'
                    : `Your plan includes ${maxPortfolios} portfolios. Upgrade to add more.`,
                code: 'PORTFOLIO_LIMIT'
            });
        }
        // Abuse guard, independent of tier: unbounded portfolio creation is a
        // cheap way to fill the collection.
        if (existing.length >= 25) {
            return res.status(400).json({ message: 'Portfolio limit reached (25).' });
        }
        const created = await Portfolio.create({ name, user: ownerId });
        res.status(201).json({ portfolio: { id: String(created._id), name: created.name } });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).json({ message: 'Database unavailable.' });
        res.status(500).json({ message: 'Unable to create that portfolio right now.' });
    }
});

// Deterministic weekly portfolio briefing. It performs no model call, so
// repeated or automated dashboard loads cannot consume provider usage.
const _briefingCache = new Map(); // userId -> { at, payload }
const BRIEFING_TTL_MS = 12 * 60 * 60 * 1000;
app.get('/api/portfolio/briefing', authMiddleware, coreGate, async (req, res) => {
    try {
        const ownerId = portfolioOwnerId(req);
        const scope = portfolioScopeKey(req.query.portfolioId);
        const scopeFilter = portfolioScopeFilter(scope);
        if (scopeFilter === false) return res.status(400).json({ message: 'Unknown portfolio.' });
        const cacheKey = `${ownerId}|${scope}`;
        const force = String(req.query.refresh || '') === '1';
        const cached = _briefingCache.get(cacheKey);
        if (!force && cached && Date.now() - cached.at < BRIEFING_TTL_MS) {
            return res.json({ ...cached.payload, cached: true });
        }

        const portfolio = await Stock.find({ user: ownerId, ...(scopeFilter || {}) });
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
        // Funds also return their facts: the page charts them rather than making
        // the reader parse the same numbers out of prose.
        const payload = { symbol, assetType: result.assetType || 'stock', summary: result.summary, source: result.source, generatedAt: new Date().toISOString(), ...(result.assetType && result.assetType !== 'stock' ? { facts: result.facts } : {}) };
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

// Indexable share ledger: reports a signed-in user publishes are appended to
// a small JSON snapshot (newest 500) that the sitemap builder reads
// synchronously — the sitemap stays sync with no DB in the hot build, and
// nothing breaks if this file is missing or unwritable.
const INDEXABLE_SHARES_FILE = path.join(__dirname, 'indexable-shares.json');
const INDEXABLE_SHARES_MAX = 500;
function noteIndexableShare(publicId) {
    try {
        let list = [];
        try { list = JSON.parse(fs.readFileSync(INDEXABLE_SHARES_FILE, 'utf8')); } catch (_) { /* first entry */ }
        const entry = { id: String(publicId), at: new Date().toISOString().slice(0, 10) };
        const next = list.filter((e) => e && e.id !== entry.id).concat([entry]).slice(-INDEXABLE_SHARES_MAX);
        fs.writeFileSync(INDEXABLE_SHARES_FILE, JSON.stringify(next));
    } catch (_) { /* sharing works without sitemap inclusion */ }
}

// Explicit-on-click creation of an immutable, unlisted public research page.
// Optional auth lets public samples be shared, while retaining a private owner
// reference for abuse response. The public document never exposes that owner.
app.post('/api/research-shares', optionalAuth, async (req, res) => {
    try {
        const payload = shareCopy.normalizePublicResearchShare(req.body || {}, { publicBase: PUBLIC_APP_URL });
        const report = await persistPublicResearchShare(payload, req.user && req.user._id);
        if (report.createdBy) noteIndexableShare(report.publicId);
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
        // Reports a signed-in user deliberately published are the public
        // research library: indexable, canonical, with JSON-LD (distribution
        // nodes, not dead ends). Anonymous-created reports and amb- affiliate
        // slugs stay noindex — spam control, unauthenticated free faucet.
        const indexable = Boolean(report.createdBy);
        if (!indexable) res.setHeader('X-Robots-Tag', 'noindex, nofollow, noarchive');
        res.setHeader('Cache-Control', 'public, max-age=600, stale-while-revalidate=86400');
        res.setHeader('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'");
        return res.type('html').send(shareCopy.renderPublicResearchPage(report, { publicBase: PUBLIC_APP_URL, indexable }));
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
    : Number(process.env.ANON_ASK_LIMIT ?? 3);                         // free queries per browser (matches ask.html copy)
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
// Email rung: verification mints a signed, cookie-only +2 bonus for 30 days.
// Same pattern as sp_ask_trial — no DB reads in the hot ask path, HttpOnly,
// and the +2 is enforced server-side from the cookie on every request.
const ASK_TRIAL_BONUS = Number(process.env.ASK_TRIAL_BONUS ?? 2);   // questions the verified email adds
const _askBonusRead = (req) => {
    const raw = (req.headers.cookie || '').split(';').map((s) => s.trim())
        .find((s) => s.startsWith('sp_ask_bonus='));
    if (!raw) return false;
    try { return jwt.verify(decodeURIComponent(raw.slice('sp_ask_bonus='.length)), JWT_SECRET).k === 'ask_bonus'; }
    catch (_) { return false; }
};
function _askBonusCookie() {
    const v = jwt.sign({ k: 'ask_bonus' }, JWT_SECRET, { expiresIn: '30d' });
    const secure = process.env.NODE_ENV === 'production' ? '; Secure' : '';
    return `sp_ask_bonus=${encodeURIComponent(v)}; Max-Age=${30 * 24 * 3600}; Path=/; HttpOnly; SameSite=Lax${secure}`;
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
    const mode = (req.body && req.body.mode) === 'analyst' ? 'analyst' : 'normal';
    if (!question) return res.status(400).json({ message: 'Ask a question.' });
    if (ANON_ASK_LIMIT <= 0) {
        return res.status(401).json({ message: 'Ask needs an account', code: 'ASK_AUTH' });
    }
    _anonAskRoll();
    const ip = _anonAskIp(req);
    const bonusUsed = _askBonusRead(req);
    const limit = Math.max(0, ANON_ASK_LIMIT) + (bonusUsed ? ASK_TRIAL_BONUS : 0);
    const visitorUsed = _anonAskReadCount(req);
    const ipUsed = _anonAsk.ip.get(ip) || 0;
    const wall = (msg) => {
        trackFunnel('anon_wall_shown', null, null, { bonus: bonusUsed, reason: 'limit', limit });
        return { message: msg, code: 'ASK_TRIAL', trial: true, next: { kind: bonusUsed ? 'paid' : 'email', bonus: ASK_TRIAL_BONUS },
            quota: { used: limit, limit, remaining: 0 } };
    };
    if (visitorUsed >= limit) {
        return res.status(429).json(wall(bonusUsed
            ? `That was all ${ANON_ASK_LIMIT + ASK_TRIAL_BONUS} free questions — the full analyst is 50 a month from $24.99, or $199.99 a year with two months free.`
            : `That's your ${ANON_ASK_LIMIT} free ${ANON_ASK_LIMIT === 1 ? 'question' : 'questions'} — leave your email for ${ASK_TRIAL_BONUS} more, or start the full plan: 50 questions a month from $24.99, or $199.99 a year with two months free.`));
    }
    if (ipUsed >= ANON_ASK_IP_DAY || _anonAsk.global >= ANON_ASK_GLOBAL_DAY) {
        trackFunnel('anon_wall_shown', null, null, { bonus: bonusUsed, reason: 'busy', limit });
        return res.status(429).json({ message: 'The free preview is busy right now — try again later, or start the full plan from $24.99/month.', code: 'ASK_TRIAL', trial: true,
            quota: { used: limit, limit, remaining: 0 } });
    }
    // cost is incurred on the call → count the IP/global attempt now; the
    // per-browser counter only advances on a delivered answer (cookie below).
    _anonAsk.ip.set(ip, ipUsed + 1);
    _anonAsk.global += 1;
    const newVisitor = visitorUsed + 1;
    const remaining = Math.max(0, limit - newVisitor);
    trackFunnel('anon_ask_started', null, null, { mode, bonus: bonusUsed, perBrowserLimit: limit });
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
                const result = await aiChat.ask({ question, history: [], ctx: { holdings: [] }, mode, onEvent: (e) => send(e.type, e) });
                send('done', { answer: result.answer, toolsUsed: result.toolsUsed, source: result.source,
                    trial: true, quota: { used: newVisitor, limit, remaining } });
                trackFunnel('anon_ask_done', null, null, { mode, bonus: bonusUsed, streamed: true });
            } catch (error) {
                send('error', { message: publicErrorMessage(error, 'Ask failed') });
            } finally {
                clearInterval(ping);
                if (!res.writableEnded) res.end();
            }
            return;
        }
        const result = await aiChat.ask({ question, history: [], ctx: { holdings: [] }, mode });
        res.setHeader('Set-Cookie', _anonAskCookie(newVisitor));
        res.json({ answer: result.answer, toolsUsed: result.toolsUsed, source: result.source,
            trial: true, quota: { used: newVisitor, limit, remaining } });
        trackFunnel('anon_ask_done', null, null, { mode, bonus: bonusUsed, streamed: false });
    } catch (error) {
        if (!res.headersSent) res.status(500).json({ message: publicErrorMessage(error, 'Ask failed') });
    }
}

// ----- Ask email rung: capture → verify → +2 bonus questions (30d cookie).
// A spent free preview trades an email address for ASK_TRIAL_BONUS more
// questions. Rate-limited and disposable-domain-blocked: this is a free
// faucet, so every input is a cost surface. No account is created.
const askTrialEmailLimiter = rateLimit({ windowMs: 60 * 60 * 1000, max: 8, standardHeaders: true, legacyHeaders: false });
const ASK_TRIAL_EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const ASK_TRIAL_DISPOSABLE_DOMAINS = new Set(['mailinator.com', 'guerrillamail.com', '10minutemail.com', 'throwawaymail.com', 'dispostable.com', 'temp-mail.org', 'yopmail.com', 'trashmail.com', 'sharklasers.com', 'getnada.com', 'maildrop.cc', '1secmail.com', 'emailondeck.com', 'fakeinbox.com', 'spamgourmet.com', 'tempmail.plus', 'tempr.email']);
function askTrialVerifyToken(email) {
    return jwt.sign({ k: 'ask_email_verify', e: email }, JWT_SECRET, { expiresIn: '3d' });
}
app.post('/api/ask-trial/email', askTrialEmailLimiter, async (req, res) => {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase().slice(0, 254);
    if (!ASK_TRIAL_EMAIL_RE.test(email)) return res.status(400).json({ message: 'Enter a valid email address.' });
    if (ASK_TRIAL_DISPOSABLE_DOMAINS.has(email.split('@')[1] || '')) {
        return res.status(400).json({ message: 'Disposable email addresses cannot receive the bonus questions.' });
    }
    if (_askBonusRead(req)) {
        return res.json({ ok: true, alreadyVerified: true, message: `Bonus already active — ${ASK_TRIAL_BONUS} more questions are unlocked on this browser.` });
    }
    try {
        const visitorUsed = _anonAskReadCount(req);
        let lead;
        try {
            lead = await AskTrialLead.findOneAndUpdate(
                { email },
                { $setOnInsert: { email }, $set: { visitorClaim: visitorUsed ? `used-${visitorUsed}-of-${ANON_ASK_LIMIT}` : null, ip: _anonAskIp(req), source: 'ask-wall' } },
                { new: true, upsert: true, runValidators: true }
            );
        } catch (error) {
            if (error && error.code === 11000) lead = await AskTrialLead.findOne({ email });
            else throw error;
        }
        if (lead && lead.verifiedAt) {
            return res.json({ ok: true, alreadyVerified: true, message: 'Email already verified — the bonus applies to the browser that clicked it. Log in for your full plan quota.' });
        }
        const { sendMail, escapeHtml, isMailerConfigured } = require('./mailer');
        if (isMailerConfigured()) {
            const verifyUrl = `${PUBLIC_APP_URL}/api/ask-trial/verify?token=${encodeURIComponent(askTrialVerifyToken(email))}`;
            await sendMail({
                to: email,
                subject: 'Your 2 more Ask questions — verify in one click',
                text: `Confirm this address and ${ASK_TRIAL_BONUS} more free Ask questions unlock in your browser, grounded in the actual SEC filings:\n\n${verifyUrl}\n\nThis link works for 3 days. No account is created; you can start the full paid plan anytime at ${PUBLIC_APP_URL}/register.html.\n\nStockPortfolio.pro — support@stockportfolio.pro`,
                html: `<p>Confirm this address and <strong>${ASK_TRIAL_BONUS} more free Ask questions</strong> unlock in your browser — every answer grounded in the actual SEC filings, with the source attached.</p><p><a href="${verifyUrl}">Unlock ${ASK_TRIAL_BONUS} more questions →</a></p><p style="color:#66717d;font-size:13px">This link works for 3 days. No account is created. Paid plans start at $24.99/month with 50 questions a month and a 7-day refund on the initial payment. — StockPortfolio.pro</p>`
            });
        }
        trackFunnel('anon_email_captured', null, null, { leadId: lead ? String(lead._id) : null, hadClaim: Boolean(visitorUsed), mailer: isMailerConfigured() ? 'smtp' : 'skipped' });
        return res.json({ ok: true, message: `Sent — open the link in ${email} to unlock ${ASK_TRIAL_BONUS} more questions.` });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).json({ message: 'Signup is temporarily unavailable.' });
        res.status(500).json({ message: 'Could not send the verification email.' });
    }
});

app.get('/api/ask-trial/verify', async (req, res) => {
    let email = '';
    try { email = String(jwt.verify(String((req.query && req.query.token) || ''), JWT_SECRET).e || ''); } catch (_) { email = ''; }
    if (!ASK_TRIAL_EMAIL_RE.test(email)) {
        return res.status(400).send('That verification link is invalid or expired. Reload the site and enter your email again.');
    }
    try {
        const lead = await AskTrialLead.findOne({ email });
        if (!lead) return res.status(404).send('No signup found for that link — reload the site and enter your email again.');
        if (!lead.verifiedAt) {
            lead.verifiedAt = new Date();
            await lead.save();
            trackFunnel('anon_email_verified', null, null, { leadId: String(lead._id) });
        }
        res.setHeader('Set-Cookie', _askBonusCookie());
        res.setHeader('Cache-Control', 'no-store');
        return res.redirect(`${PUBLIC_APP_URL}/?ask=verified`);
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).send('Signup is temporarily unavailable.');
        return res.status(500).send('Verification failed — reload the site and try again.');
    }
});

app.post('/api/ai/chat', askAuth, async (req, res) => {
    if (req.anon) return anonAskHandler(req, res);
    const question = String((req.body && req.body.question) || '').trim();
    const mode = (req.body && req.body.mode) === 'analyst' ? 'analyst' : 'normal';
    if (!question) return res.status(400).json({ message: 'Ask a question.' });
    // 📎 attachments survive the request only — images for the vision relay,
    // documents as client-extracted text. Never written to disk or the DB.
    const attachments = normalizeAskAttachments(req.body && req.body.attachments);
    try {
        const userId = portfolioOwnerId(req);
        const limit = effectiveAskLimit(req);
        const planId = req.subscription && req.subscription.planId;
        // 🧪 AI Portfolio mode — honored ONLY for beta users (server-side gate
        // on the account email). Anyone else sending the flag gets plain chat:
        // no ai-paper tools in the loop, no experiment data in the prompt.
        let aiPaperCtx = null;
        if ((req.body && req.body.aiPaperMode) === true && aiPaper.isBetaUser(req.user)) {
            aiPaperCtx = await buildAiPaperChatCtx(userId);
        }
        // Two meters, one door. The AppSumo listing sells AI credits, so the wallet has to
        // be able to buy an Ask; the per-tier Ask counter stays underneath as a floor, so a
        // buyer who spends their credits on Dossiers never loses questions they already
        // own. For every non-LTD plan the wallet is exactly 2x the Ask limit (see
        // credits.allowance), so this is a no-op for them — it only unlocks the lifetime
        // wallets the listing advertises.
        //
        // Both reads fail open (0 on a DB blip). That is deliberate and symmetric: an
        // outage widens this gate, it never locks a paying user out.
        const [used, gate] = await Promise.all([
            aiChat.getUsage(userId),
            credits.check(userId, 'ask', limit, planId, req.user)
        ]);
        if (!gate.ok && used >= limit) {
            const resp = {
                message: isProUser(req)
                    ? `You've used all ${gate.allowance} AI credits this month — they reset on the 1st.`
                    : `You've used your ${limit} Ask queries this month. Upgrade for ${aiChat.limits(req.tier === 'free' ? 'core' : 'pro')} a month.`,
                // tier lets the client render the right upgrade ladder even when
                // AI_CHAT_*_LIMIT env overrides make limit→tier inference ambiguous
                code: 'ASK_QUOTA', tier: req.tier === true ? 'pro' : req.tier, quota: { used, limit, remaining: 0 },
                // The wallet is what actually ran out here — give the client the numbers
                // it needs to say so without a second round-trip to /api/credits.
                credits: { used: gate.used, allowance: gate.allowance, remaining: gate.remaining, needed: gate.cost, resetsAt: gate.resetsAt }
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
                resp.message = `You've used all ${gate.allowance} AI credits this month on your AppSumo plan. Upgrade your AppSumo license for more credits each month — or wait for the reset on the 1st.`;
            }
            return res.status(429).json(resp);
        }
        // Holdings context for the get_portfolio tool (stored prices — no live
        // price fan-out per chat message).
        let holdings = [];
        try { holdings = (await Stock.find({ user: userId })).map((s) => s.toObject()); } catch (_) { holdings = []; }
        const clientHistory = Array.isArray(req.body && req.body.history) ? req.body.history : [];
        // A threadId makes the SERVER the context authority: history is rebuilt
        // from that thread's own stored messages, so follow-ups carry the
        // conversation and other topics never bleed in. Without one (⌘K floor,
        // dashboard widget, anon) the old fallbacks apply unchanged.
        const threadIdRaw = typeof (req.body && req.body.threadId) === 'string' ? req.body.threadId.trim() : '';
        const hasThread = typeof threadIdRaw === 'string' && THREAD_ID_RE.test(threadIdRaw);
        const memoryConsent = !!(req.user && req.user.askMemoryEnabled);
        // a fresh page sends no history — pick the thread back up from the
        // user's last few stored exchanges (cross-session memory)
        const history = hasThread
            ? await aiChat.threadHistory(userId, threadIdRaw)
            : (clientHistory.length ? clientHistory : await aiChat.recentHistory(userId));
        // Set on whichever success branch runs; returned to the client so the
        // frontend can adopt the (possibly newly created) thread id.
        let threadIdSaved = null;

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
                    question, history,
                    ctx: {
                        holdings, userId, memoryConsent, attachments,
                        // ai_paper events stream the background build's
                        // progress lines while this connection lives.
                        ...(aiPaperCtx ? { ...aiPaperCtx, aiPaperProgress: (e) => send('ai_paper', e) } : {})
                    },
                    mode,
                    onEvent: (e) => send(e.type, e)
                });
                const counted = result.source === 'ai' || result.source === 'blocked';
                if (counted) await aiChat.recordUse(userId);
                // Additive only: still gated by the Ask-specific limit above,
                // unchanged. This makes the shared pool accurate for Dossier
                // (which draws from it for real) without touching Ask's own
                // gate, response shape, or upgrade-prompt logic that the
                // frontend already depends on.
                if (result.source === 'ai') await credits.spend(userId, 'ask', 'ask');
                if (result.source === 'ai') aiChat.saveExchange(userId, question, result.answer);
                if (result.source === 'ai') saveAskReport(userId, question, result.answer, mode, result.toolsUsed);
                if (result.source === 'ai') threadIdSaved = await saveThreadExchange(userId, threadIdRaw, question, result.answer, mode, result.toolsUsed);
                trackSecondSession(req, req.user);
                trackFirstAskSuccess(req, req.user, result);
                if (result.answer) trackActivation(userId, 'ask');
                const usedNow = counted ? used + 1 : used;
                const reviewPrompt = await askReviewPrompt(req.user, result).catch(() => null);
                send('done', {
                    answer: result.answer, toolsUsed: result.toolsUsed, source: result.source,
                    quota: { used: usedNow, limit, remaining: Math.max(0, limit - usedNow) },
                    threadId: threadIdSaved,
                    ...(reviewPrompt ? { reviewPrompt } : {})
                });
            } catch (error) {
                send('error', { message: publicErrorMessage(error, 'Ask failed') });
            } finally {
                clearInterval(ping);
                if (!res.writableEnded) res.end();
            }
            return;
        }

        const result = await aiChat.ask({
            question, history,
            ctx: { holdings, userId, memoryConsent, attachments, ...(aiPaperCtx || {}) },
            mode
        });
        const counted = result.source === 'ai' || result.source === 'blocked';
        if (counted) await aiChat.recordUse(userId);
        if (result.source === 'ai') await credits.spend(userId, 'ask', 'ask');
        if (result.source === 'ai') aiChat.saveExchange(userId, question, result.answer);
        if (result.source === 'ai') saveAskReport(userId, question, result.answer, mode, result.toolsUsed);
        threadIdSaved = result.source === 'ai'
            ? await saveThreadExchange(userId, threadIdRaw, question, result.answer, mode, result.toolsUsed)
            : null;
        trackSecondSession(req, req.user);
        trackFirstAskSuccess(req, req.user, result);
        if (result.answer) trackActivation(userId, 'ask');
        const usedNow = counted ? used + 1 : used;
        const reviewPrompt = await askReviewPrompt(req.user, result).catch(() => null);
        res.json({
            answer: result.answer, toolsUsed: result.toolsUsed, source: result.source,
            quota: { used: usedNow, limit, remaining: Math.max(0, limit - usedNow) },
            threadId: threadIdSaved,
            ...(reviewPrompt ? { reviewPrompt } : {})
        });
    } catch (error) {
        if (!res.headersSent) res.status(500).json({ message: publicErrorMessage(error, 'Ask failed') });
    }
});

// Attachments for Ask — validated server-side and NEVER persisted: the image
// data-URI lives only in the request body and the current chat turn's ctx (the
// vision relay needs the pixels; documents' extracted text is all that matters).
// Shape from the client: { id, name, kind: 'image'|'doc', mime, text?, dataUri? }
function normalizeAskAttachments(raw) {
    if (!Array.isArray(raw)) return [];
    return raw
        .filter((a) => a && typeof a === 'object')
        .slice(0, ASK_ATTACHMENT_MAX_COUNT)
        .map((a) => {
            const name = String(a.name || 'attachment').slice(0, 120);
            const kind = a.kind === 'image' ? 'image' : (a.kind === 'doc' ? 'doc' : null);
            if (!kind) return null;
            const text = kind === 'doc' ? String(a.text || '').slice(0, ASK_ATTACHMENT_TEXT_CAP) : '';
            const dataUri = kind === 'image' ? String(a.dataUri || '') : '';
            if (kind === 'image' && !/^data:image\//.test(dataUri.slice(0, 15))) return null;
            if (kind === 'image' && dataUri.length > Math.ceil(ASK_ATTACHMENT_MAX_BYTES * 1.4)) return null;
            if (kind === 'doc' && !text) return { id: String(a.id || ''), name, kind, mime: String(a.mime || '').slice(0, 60), text: '', note: 'no text found' };
            return { id: String(a.id || ''), name, kind, mime: String(a.mime || '').slice(0, 60), text, dataUri };
        })
        .filter(Boolean);
}

// ----- 🧪 AI Paper Portfolio (beta) -----
// AI_PORTFOLIO_BETA_EMAILS is the entire gate: unset env = 403 everywhere and
// the feature is invisible. Zero AI on the read paths — detail/status are
// Mongo reads + cached quotes; the only build path is POST /create, and no
// route anywhere trades (positions are immutable after construction).

// Chat-mode context + tool handlers, built per request ONLY for beta users
// with aiPaperMode on. The 3 ai-paper tools ride in ctx (aiChat.concat's
// them into that request's tool list), so they never appear for anyone else
// or in normal mode.
async function buildAiPaperChatCtx(userId) {
    let state = null;
    try { state = await aiPaper.statusFor(userId); } catch (_) { state = null; }
    const context = [
        'AI PAPER PORTFOLIO MODE — the user is running the AI Paper Portfolio experiment (two AI minds, each picking ONE stock; ONE buying decision at creation). The owner of the experiment can steer it; the AI can never trade on its own.',
        'Hard rules: positions change ONLY through an explicit ai_portfolio_steer command the owner just gave (allocation change, a pick swap, or standing rules) — everything else you say is advisory and never executed. Nightly reviews are advisory-only notes in the log.',
        state && state.exists
            ? `Current experiment state (authoritative — never invent numbers): ${JSON.stringify(state)}`
                + (state.status === 'failed'
                    ? '\nThe failed run is fully discarded. When the user wants to try again, call ai_portfolio_setup — with NO arguments (the pure-data default) unless they explicitly name an investor in their own words. Never carry the failed run\'s guru over to a retry, and never claim a build is running unless you just called the tool.'
                    : state.status === 'building'
                        ? '\nA build is already in progress. Do not call ai_portfolio_setup again; report progress from the state (the buildLog lines are the live research feed — narrate the latest steps). The owner can pause the run from the dashboard; once paused, ai_portfolio_setup (with the edited guru/constraints) re-runs the research.'
                        : state.status === 'paused'
                            ? '\nThe build was PAUSED by the owner and the research stopped cleanly — nothing was bought. The setup that was running is in state.setup (guru + constraints). Ask what they want to change (a different guru, extra constraints like "avoid financials"), then call ai_portfolio_setup once with the FULL edited setup to re-run the research from scratch. Nothing carries over except what they confirm.'
                            : '')
                + (Array.isArray(state.steeringRules) && state.steeringRules.length
                    ? `\nOwner's standing rules for reviews: ${state.steeringRules.join(' | ')}`
                    : '')
            : 'No portfolio exists yet. If the user wants to start the experiment, call ai_portfolio_setup — by default with NO arguments (both minds are independent pure-data analysts). If they name an investor — living or deceased (e.g. Buffett, Charlie Munger, Peter Lynch) — pass that name as guru. If they state hard requirements for the research (e.g. "avoid financials"), pass each as a constraints entry.'
    ].join('\n');
    return {
        aiPaperTools: aiPaper.CHAT_TOOLS,
        aiPaperContext: context,
        aiPaperRunTool: (name, args, ctx) => runAiPaperChatTool(name, args, userId, ctx)
    };
}

async function runAiPaperChatTool(name, args, userId, ctx) {
    try {
        if (name === 'ai_portfolio_status') return await aiPaper.statusFor(userId);
        if (name === 'ai_portfolio_setup') {
            // Guru is OPTIONAL: no arguments = pure-AI default (two data
            // minds). A free-text investor name resolves against the living
            // managers + deceased legends; ambiguous names come back as
            // candidates so the assistant can ask instead of guessing.
            // Constraints are the owner's hard requirements, passed through
            // verbatim (the module clamps count/length).
            const wanted = String((args && (args.guru || args.guruId)) || '').trim();
            const constraints = Array.isArray(args && args.constraints)
                ? args.constraints.map((c) => String(c || '').trim()).filter(Boolean).slice(0, 5)
                : [];
            let guruId = '';
            if (wanted) {
                const { matched } = aiPaper.resolveGuru(wanted);
                if (matched.length === 0) {
                    return { error: `No investor matching "${wanted}". Ask the user to name a famous investor (living or deceased — e.g. Buffett, Charlie Munger, Peter Lynch), or go with the pure-data default (no guru).` };
                }
                if (matched.length > 1) {
                    return { error: `"${wanted}" is ambiguous — ask which one they mean: ${matched.map((g) => g.name).join(', ')}.` };
                }
                guruId = matched[0].id;
            }
            const existing = await aiPaper.statusFor(userId);
            if (existing.exists && existing.status === 'building') return { error: 'A build is already in progress — give it about two to three minutes (or they can pause it from the dashboard).' };
            if (existing.exists && (existing.status === 'committed' || existing.status === 'tracking')) {
                return { error: 'An AI Paper Portfolio already exists for this account (one per account, buy-once-never-change). Only ai_portfolio_reset — with the user\'s explicit confirmation — clears it for a fresh run.' };
            }
            const resuming = existing.exists && existing.status === 'paused';
            if (!require('./ai-client').isConfigured()) return { error: 'The AI research service is not configured right now — try again shortly.' };
            // Fire-and-forget: the build runs in the background, disconnect-
            // tolerant; progress streams as ai_paper SSE events while this
            // connection lives AND persists into the doc's buildLog, which the
            // dashboard polls — so the feed survives a closed connection. A
            // failure lands as buildError in the next status call — never a
            // silent skip. A paused run's doc is deleted by create() and the
            // research starts over with the edited setup.
            aiPaper.create({
                user: { id: userId }, guruId, constraints,
                onEvent: (e) => { const p = ctx && ctx.aiPaperProgress; if (p) { try { p(e); } catch (_) { /* client gone — keep building */ } } }
            }).catch((e) => console.error('[ai-paper] background build failed:', e && e.message));
            return {
                started: true,
                message: (resuming ? 'Resuming with the edited setup — ' : 'Setup is underway in the background — ')
                    + 'about two to three minutes. The live research feed streams into this conversation and onto their dashboard; the owner can pause the run at any time.'
            };
        }
        if (name === 'ai_portfolio_steer') {
            // Explicit owner commands only — the model must never invent an
            // allocation or ticker on its own. applySteering guardrails
            // (10-70% per slot, cash cap, verified symbols, official closes)
            // are enforced in the module.
            const out = await aiPaper.applySteering(userId, args && args.action, args || {});
            if (!out.ok) return { error: out.reason };
            return {
                steered: args.action,
                message: 'Applied the owner\'s change exactly as instructed (guardrails verified in code) and logged it in the decision log as an owner action. Report the new state; positions may take a moment to refresh.'
            };
        }
        if (name === 'ai_portfolio_reset') {
            const out = await aiPaper.resetRun(userId);
            return out.ok
                ? { reset: true, message: 'Old run deleted (its decision log stays as history; nothing was traded). Call ai_portfolio_setup when the user is ready — a guru is optional; the default is two pure-data minds.' }
                : { error: out.reason };
        }
        return { error: `Unknown tool ${name}` };
    } catch (error) {
        console.error('[ai-paper] chat tool failed:', error && error.message);
        return { error: 'That AI Paper Portfolio action failed — try again.' };
    }
}

// Probe + state: the dashboard's sole gate signal (403 when the env is unset
// or the account isn't on the beta list — the frontend renders nothing).
app.get('/api/ai-paper-portfolio', authMiddleware, aiPaper.betaGate, async (req, res) => {
    try {
        const state = await aiPaper.statusFor(portfolioOwnerId(req));
        res.json({
            enabled: true, state,
            // Living 13F managers + deceased legends: the chips and the
            // natural-language path draw from the same list.
            gurus: [...gurus.list(), ...aiPaper.LEGACY_GURUS.map(({ id, name, fund }) => ({ id, name, fund }))]
        });
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Unavailable right now.') });
    }
});

// The ONE build path. SSE: status/persona/done/error frames + 10s pings;
// disconnect-tolerant (the build continues server-side, the dashboard polls
// detail for the outcome).
app.post('/api/ai-paper-portfolio/create', authMiddleware, aiPaper.betaGate, async (req, res) => {
    const guruId = String((req.body && req.body.guruId) || '').trim();
    // Raw pass-through only — create() cleans (stripThink, trim, ≤5 × ≤140).
    const rawConstraints = (req.body && Array.isArray(req.body.constraints)) ? req.body.constraints : [];
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
    const ping = setInterval(() => { if (!closed && !res.writableEnded) res.write(': ping\n\n'); }, 10000);
    try {
        const result = await aiPaper.create({
            user: { id: portfolioOwnerId(req) }, guruId, constraints: rawConstraints,
            onEvent: (e) => send(e.type || 'status', e)
        });
        // create() emits done/error itself via onEvent; this covers a throw.
        // A paused build is not an error — the SSE 'paused' frame tells the
        // frontend to show the paused card instead of a failure.
        if (result && result.paused) send('paused', {});
        else if (!result.ok) send('error', { message: result.error || 'The build failed.' });
    } catch (error) {
        send('error', { message: publicErrorMessage(error, 'The build failed.') });
    } finally {
        clearInterval(ping);
        if (!res.writableEnded) res.end();
    }
});

// Owner pause: stops the running research within one LLM round / tool call
// and keeps the setup (guru + constraints) on the paused doc so it can be
// edited in chat and re-run. Not a delete, not a failure — a controlled stop.
app.post('/api/ai-paper-portfolio/stop', authMiddleware, aiPaper.betaGate, async (req, res) => {
    try {
        const out = await aiPaper.stopBuild(portfolioOwnerId(req));
        res.json(out);
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Could not stop the build.') });
    }
});

// Full read model for the dashboard section: personas + picks + weights +
// P&L, live prices, snapshot series, last decisions, totals incl. vs-SPY.
// No AI calls on this path.
app.get('/api/ai-paper-portfolio/detail', authMiddleware, aiPaper.betaGate, async (req, res) => {
    try {
        res.json(await aiPaper.detailFor(portfolioOwnerId(req)));
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Unavailable right now.') });
    }
});

// ----- Portfolio X-Ray: look-through fundamentals of the whole portfolio -----
const _xrayCache = new Map(); // userId -> { at, payload }
const XRAY_TTL_MS = 60 * 60 * 1000;
app.get('/api/portfolio/xray', authMiddleware, coreGate, async (req, res) => {
    try {
        const ownerId = portfolioOwnerId(req);
        const scope = portfolioScopeKey(req.query.portfolioId);
        const scopeFilter = portfolioScopeFilter(scope);
        if (scopeFilter === false) return res.status(400).json({ message: 'Unknown portfolio.' });
        const key = `${ownerId}|${scope}`;
        const force = String(req.query.refresh || '') === '1';
        const cached = _xrayCache.get(key);
        if (!force && cached && Date.now() - cached.at < XRAY_TTL_MS) {
            return res.json({ ...cached.payload, cached: true });
        }
        const portfolio = await Stock.find({ user: ownerId, ...(scopeFilter || {}) });
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
const portfolioCsv = require('./portfolio-csv');
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
        const scope = portfolioScopeKey(req.query.portfolioId);
        const scopeFilter = portfolioScopeFilter(scope);
        if (scopeFilter === false) return res.status(400).json({ message: 'Unknown portfolio.' });
        const cacheKey = `${userId}|${scope}`;
        const hit = _attribCache.get(cacheKey);
        if (hit && Date.now() - hit.at < ATTRIB_TTL_MS) return res.json(hit.payload);
        const holdings = (await Stock.find({ user: userId, ...(scopeFilter || {}) })).map((s) => s.toObject());
        const payload = await attribution.computeAttribution(holdings);
        _attribCache.set(cacheKey, { at: Date.now(), payload });
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
        markOnboardingStep(req.user, 'watch');
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
            max_market_cap_billions: q.maxMarketCapB,
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
        // Monitor cap v2 (1/4/8) — gates the watchlist for lifetime buyers who
        // redeemed on/after MONITOR_CAP_V2_EFFECTIVE_FROM. Grandfathered buyers
        // and every other plan pass through untouched: their watchlist is not a
        // Monitor entitlement and must not retroactively become one. Guarded on
        // the pure cohort test so nobody else pays for the extra read. Kept
        // outside tierLimits.enabled() on purpose — that flag also meters
        // history depth, which this must not switch on as a side effect.
        if (tierLimits.isMonitorCapV2Cohort(req.user)) {
            const existing = await Watchlist.findOne({ user: portfolioOwnerId(req) }).lean();
            const symbols = (existing && existing.symbols) || [];
            if (!symbols.includes(symbol) && tierLimits.wouldExceedMonitorCap(req.user, symbols.length)) {
                const cap = tierLimits.monitorCapFor(req.user);
                return res.status(402).json({
                    message: `Your plan monitors up to ${cap} ${cap === 1 ? 'company' : 'companies'}. Upgrade your tier to add more.`,
                    code: 'MONITORED_COMPANY_LIMIT',
                    limit: cap
                });
            }
        }
        // Tier meter v2 — inert unless ENABLE_TIER_V2_LIMITS=true and this
        // account redeemed on/after TIER_V2_EFFECTIVE_FROM. See lib/tier-limits.
        if (tierLimits.enabled()) {
            const existing = await Watchlist.findOne({ user: portfolioOwnerId(req) }).lean();
            const symbols = (existing && existing.symbols) || [];
            if (!symbols.includes(symbol) && tierLimits.wouldExceedMonitored(req.user, symbols.length)) {
                const { maxMonitoredCompanies } = tierLimits.limitsFor(req.user);
                return res.status(402).json({
                    message: `Your plan monitors up to ${maxMonitoredCompanies} companies. Upgrade your tier to add more.`,
                    code: 'MONITORED_COMPANY_LIMIT',
                    limit: maxMonitoredCompanies
                });
            }
        }
        const doc = await Watchlist.findOneAndUpdate(
            { user: portfolioOwnerId(req) },
            { $addToSet: { symbols: symbol } },
            { upsert: true, new: true }
        );
        // The 'watch' step used to be ticked only by creating an alert rule, so
        // watching a company the obvious way never counted — and the Monitor
        // digest reads the watchlist, so an empty one means nothing to send.
        markOnboardingStep(req.user, 'watch');
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
// Free tier: teaser (withholds the newest quarter + transaction list server-side).
// Core/pro: full data. First request per company kicks off a background build (~1-2 min).
const insiders = require('./insiders');
const gurus = require('./gurus');
const filingMonitor = require('./filing-monitor');
const monitorDigest = require('./monitor-digest');
app.get('/api/company/:symbol/insider-history', optionalAuth, async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!isValidTicker(symbol)) return res.status(400).json({ message: 'Invalid symbol' });
    try {
        const result = await insiders.history(symbol);
        res.json(req.tier === 'free' ? lockInsiderHistory(result) : result);
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
// Extraction itself is Pro-gated and cached forever per filing, so cost is
// already bounded; the free-tier cap below is a pure conversion lever: 5
// DISTINCT stocks per calendar month, then Core is required for more. Viewing
// a stock already counted this month, or one nobody has generated yet, is free.
const keypoints = require('./keypoints');
const keypointFreeUsage = require('./keypoint-free-usage');
const configuredKeypointsFreeStocks = Number.parseInt(process.env.KEYPOINTS_FREE_STOCKS || '5', 10);
const KEYPOINTS_FREE_STOCKS = Number.isFinite(configuredKeypointsFreeStocks) ? Math.max(0, Math.min(50, configuredKeypointsFreeStocks)) : 5;
const KeypointFreeUsage = keypointFreeUsage.createModel(mongoose);

function keypointFreeContext(req, now = new Date()) {
    const monthKey = now.toISOString().slice(0, 7);
    const expiresAt = new Date(now.getFullYear(), now.getMonth() + 2, 1); // clears ~35 days after month start
    const clientKey = req.user ? `u:${req.user._id}` : `ip:${crypto.createHmac('sha256', process.env.MONITOR_FREE_IP_SALT || JWT_SECRET).update(String(req.ip || 'unknown')).digest('hex')}`;
    return { clientKey, monthKey, expiresAt };
}

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
        // Free-tier monthly cap on distinct stocks. core/pro/trialing bypass.
        if (req.tier === 'free' && KEYPOINTS_FREE_STOCKS > 0) {
            const claim = await keypointFreeUsage.claim(KeypointFreeUsage, keypointFreeContext(req), symbol, KEYPOINTS_FREE_STOCKS);
            res.setHeader('RateLimit-Limit', String(KEYPOINTS_FREE_STOCKS));
            res.setHeader('RateLimit-Remaining', String(claim.remaining));
            if (!claim.allowed) {
                return res.status(429).json({
                    code: 'KEYPOINTS_QUOTA',
                    message: `That's your ${KEYPOINTS_FREE_STOCKS} free stocks with key points this month. Upgrade to Core for unlimited stocks.`,
                    quota: { used: KEYPOINTS_FREE_STOCKS, limit: KEYPOINTS_FREE_STOCKS, remaining: 0 }
                });
            }
        }
        // Ordinary page loads may read an existing cache but can never create
        // provider usage. Generation requires the explicit Insights Pro click,
        // which sends generate=1 from company.js.
        // Deep reads three years of 10-Ks and compares them; it costs roughly
        // three times a standard build, so it is opt-in per request.
        const depth = String(req.query.depth || '') === 'deep' ? 'deep' : 'standard';
        const result = await keypoints.extractKeyPoints(symbol, {
            allowAi: generate && isProUser(req),
            depth
        });
        if (result.error) return res.status(404).json({ message: result.error });
        res.json(result);
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Key points failed') });
    }
});

const _ownershipCache = new Map(); // SYM -> { at, payload }
app.get('/api/company/:symbol/ownership', optionalAuth, async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!isValidTicker(symbol)) return res.status(400).json({ message: 'Invalid symbol' });
    try {
        const cached = _ownershipCache.get(symbol);
        if (cached && Date.now() - cached.at < COMPANY_EXTRA_TTL_MS) {
            // Cache is tier-blind — shape on the way out only, never store the stripped version
            const payload = cached.payload;
            if (req.tier === 'free') {
                const { insiderTransactions, insiderNet, ...rest } = payload;
                return res.json({ ...rest, insiderLocked: true });
            }
            return res.json(payload);
        }
        const data = await yahooSource.fetchOwnership(symbol);
        const payload = { symbol, ...data, source: 'Yahoo Finance (13F-derived)' };
        _ownershipCache.set(symbol, { at: Date.now(), payload });
        if (_ownershipCache.size > 500) _ownershipCache.delete(_ownershipCache.keys().next().value);
        if (req.tier === 'free') {
            const { insiderTransactions, insiderNet, ...rest } = payload;
            return res.json({ ...rest, insiderLocked: true });
        }
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
        // The listing meters in AI credits, so the Ask UI has to be able to show the
        // meter the buyer was actually sold — a customer told us in writing that the
        // "0 / 30 Ask questions" counter was what confused him. Additive only: used,
        // limit and remaining keep their shape for clients still on a cached bundle.
        try {
            const bal = await credits.balance(
                portfolioOwnerId(req), limit,
                req.subscription && req.subscription.planId,
                req.user
            );
            out.credits = { used: bal.used, allowance: bal.allowance, remaining: bal.remaining, resetsAt: bal.resetsAt };
            out.cost = credits.COST;
        } catch (_) { /* the Ask counter above is enough to render the page */ }
        // AppSumo lifetime buyers: expose tier + a real upgrade link so the UI can
        // offer "Upgrade your AppSumo license" at the cap instead of a dead end.
        if (req.user && req.user.appsumoLicenseKey) {
            let upgradeUrl = APPSUMO_ACCOUNT_URL;
            try {
                const lic = await AppSumoLicense.findOne({ licenseKey: req.user.appsumoLicenseKey }, { changePlanUrl: 1 }).lean();
                upgradeUrl = appsumoUpgradeUrl(lic);
            } catch (_) { /* fall back to account page */ }
            // monitorCapLabel is resolved server-side (and is cohort-aware, so a
            // grandfathered buyer keeps their old number) because Infinity does
            // not survive JSON and because the client must never recompute the
            // ladder — see lib/tier-limits.js.
            out.appsumo = { isAppSumo: true, tier: req.user.appsumoTier || null, cap: req.user.appsumoAiCap || null, upgradeUrl, monitorCapLabel: tierLimits.monitorCapLabel(req.user) };
        }
        res.json(out);
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Quota check failed') });
    }
});

// The shared Ask+Dossier credit pool. Separate from /api/ai/chat/quota above
// on purpose: that endpoint's shape is already load-bearing for the existing
// Ask UI, and this is new, additive surface — not a replacement for it.
app.get('/api/credits', authMiddleware, async (req, res) => {
    try {
        const planId = req.subscription && req.subscription.planId;
        // The activity list is paged from the client: a normal profile load
        // takes the small window, and only an explicit "show the whole month"
        // pulls the rest. Clamped so a crafted query can't ask for an unbounded
        // read of the ledger.
        const activityLimit = Math.min(200, Math.max(1, Math.floor(Number(req.query.activityLimit)) || 20));
        const [bal, recent, breakdown] = await Promise.all([
            credits.balance(req.userId, effectiveAskLimit(req), planId, req.user),
            credits.recentActivity(req.userId, activityLimit),
            credits.monthBreakdown(req.userId)
        ]);
        // breakdown is the COMPLETE per-feature split for the month; `recent` is
        // only the newest page of rows. Sending both is what lets the page show
        // a split that always adds up while still capping the list it renders.
        const activityTotal = Object.values(breakdown).reduce((n, r) => n + (Number(r && r.count) || 0), 0);
        // hasMonitor: Monitor is Power/Desk-only and not part of the LTD/AppSumo
        // entitlement — the profile page needs this to decide between showing a
        // Monitor breakdown row and a one-line upsell, since a user who can't
        // reach the feature shouldn't see a usage row for it.
        res.json({ ...bal, cost: credits.COST, recent, breakdown, activityTotal, hasMonitor: hasMonitor(req) });
    } catch (error) {
        res.status(500).json({ message: publicErrorMessage(error, 'Credit balance check failed') });
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
        // Target portfolio: absent or 'main' → the implicit Main portfolio
        // (old clients keep working); an ObjectId must belong to the caller.
        let targetPortfolioId = null;
        const rawPortfolioId = String((req.body || {}).portfolioId || '').trim();
        if (rawPortfolioId && rawPortfolioId !== 'main') {
            if (!/^[0-9a-f]{24}$/i.test(rawPortfolioId)) {
                return res.status(400).json({ message: 'Unknown portfolio.' });
            }
            const owned = await Portfolio.findOne({ _id: rawPortfolioId, user: portfolioOwnerId(req) }).lean();
            if (!owned) return res.status(400).json({ message: 'Unknown portfolio.' });
            targetPortfolioId = owned._id;
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
        // A symbol that resolves to neither a name nor a price does not exist
        // as far as any source we have is concerned. Saving it anyway creates a
        // holding stuck at $0 that the user has to hunt down and delete, so
        // refuse it and say why. A transient outage fails the same way, but
        // that is recoverable by retrying — a junk holding is not.
        const resolvedIdentity = profile && profile.name && String(profile.name).toUpperCase() !== ticker;
        if (!livePrice && !resolvedIdentity) {
            return res.status(400).json({ message: 'unknown ticker', code: 'UNKNOWN_SYMBOL' });
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
            portfolioId: targetPortfolioId,
            user: portfolioOwnerId(req)
        });
        await newStock.save();
        invalidatePortfolioCaches(portfolioOwnerId(req));
        const portfolioCount = await Stock.countDocuments({ user: portfolioOwnerId(req) });
        if (portfolioCount >= 1) trackActivation(req.userId, 'portfolio', {
            resultValid: true, sourceOpened: false, featureType: 'portfolio',
            requestFields: trackingRequestFields(req, res)
        });
        markOnboardingStep(req.user, 'hold');
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
        invalidatePortfolioCaches(ownerId);
        res.status(200).json({ message: 'Holding removed successfully' });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) {
            return res.status(503).json({ message: 'Database unavailable. Start MongoDB and configure MONGODB_URI.' });
        }
        res.status(500).json({ message: 'Unable to delete that holding right now.' });
    }
});

// Deleting a portfolio deletes its holdings with it; other portfolios are
// untouched. Main (the implicit portfolio) cannot be deleted.
app.delete('/api/portfolios/:id', authMiddleware, coreGate, async (req, res) => {
    try {
        const ownerId = portfolioOwnerId(req);
        const id = String(req.params.id || '');
        if (id === 'main') return res.status(400).json({ message: 'Main portfolio cannot be deleted.' });
        if (!/^[0-9a-f]{24}$/i.test(id)) return res.status(404).json({ message: 'Portfolio not found.' });
        // Verify ownership first, then delete HOLDINGS BEFORE the portfolio.
        // These two writes are not a transaction, so order decides the failure
        // mode: dropping the portfolio first would leave any holdings whose
        // delete failed orphaned — matched by no scope ('main' requires a null
        // portfolioId, the portfolio's own id no longer resolves) yet still
        // counted and valued in the All view, with no way to reach or remove
        // them. This order fails the other way: the portfolio survives with
        // its holdings, still visible and still deletable by retrying.
        const target = await Portfolio.findOne({ _id: id, user: ownerId });
        if (!target) return res.status(404).json({ message: 'Portfolio not found.' });
        const removedHoldings = await Stock.deleteMany({ user: ownerId, portfolioId: target._id });
        const removed = await Portfolio.findOneAndDelete({ _id: target._id, user: ownerId });
        if (!removed) return res.status(404).json({ message: 'Portfolio not found.' });
        invalidatePortfolioCaches(ownerId);
        res.status(200).json({ ok: true, removedHoldings: removedHoldings.deletedCount || 0 });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).json({ message: 'Database unavailable.' });
        res.status(500).json({ message: 'Unable to delete that portfolio right now.' });
    }
});

// ---- CSV import ----------------------------------------------------------
// Two stateless steps. Preview parses and reports; commit re-parses the same
// text and is authoritative, so a holding added between the steps still merges
// correctly instead of acting on a stale plan.
const CSV_IMPORT_MAX_HOLDINGS = 100;

async function resolveImportTarget(req, rawPortfolioId) {
    const raw = String(rawPortfolioId || '').trim();
    if (!raw || raw === 'main' || raw === 'all') return { ok: true, portfolioId: null };
    if (!/^[0-9a-f]{24}$/i.test(raw)) return { ok: false };
    const owned = await Portfolio.findOne({ _id: raw, user: portfolioOwnerId(req) }).lean();
    return owned ? { ok: true, portfolioId: owned._id } : { ok: false };
}

app.post('/api/portfolio/import/preview', authMiddleware, coreGate, async (req, res) => {
    try {
        const parsed = portfolioCsv.parseHoldingsCsv((req.body || {}).csv);
        if (parsed.error) return res.status(400).json({ message: parsed.error });
        const target = await resolveImportTarget(req, (req.body || {}).portfolioId);
        if (!target.ok) return res.status(400).json({ message: 'Unknown portfolio.' });

        const rows = portfolioCsv.consolidateRows(parsed.rows);
        const existing = await Stock.find({ user: portfolioOwnerId(req), portfolioId: target.portfolioId })
            .select('symbol').lean();
        const existingSymbols = new Set(existing.map((s) => String(s.symbol).toUpperCase()));
        const marked = rows.map((r) => ({ ...r, merges: existingSymbols.has(r.symbol) }));
        const mergedCount = marked.filter((r) => r.merges).length;
        const collapsed = parsed.rows.length - rows.length;

        const notes = [];
        if (collapsed > 0) notes.push(`${collapsed} repeated ticker row${collapsed === 1 ? '' : 's'} combined into one holding each (units summed, price weighted-averaged, earliest date kept).`);
        if (mergedCount > 0) notes.push(`${mergedCount} ticker${mergedCount === 1 ? '' : 's'} already in this portfolio will be merged, not duplicated.`);

        res.json({
            rows: marked,
            skipped: parsed.skipped,
            mergeNote: notes.join(' ') || '',
            total: existingSymbols.size + marked.filter((r) => !r.merges).length,
            max: CSV_IMPORT_MAX_HOLDINGS
        });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).json({ message: 'Database unavailable.' });
        res.status(500).json({ message: 'Unable to read that CSV right now.' });
    }
});

app.post('/api/portfolio/import/commit', authMiddleware, coreGate, async (req, res) => {
    try {
        const ownerId = portfolioOwnerId(req);
        const parsed = portfolioCsv.parseHoldingsCsv((req.body || {}).csv);
        if (parsed.error) return res.status(400).json({ message: parsed.error });
        const target = await resolveImportTarget(req, (req.body || {}).portfolioId);
        if (!target.ok) return res.status(400).json({ message: 'Unknown portfolio.' });

        const rows = portfolioCsv.consolidateRows(parsed.rows);
        if (!rows.length) return res.status(400).json({ message: 'No importable rows found in that CSV.' });

        const existing = await Stock.find({ user: ownerId, portfolioId: target.portfolioId }).lean();
        const bySymbol = new Map(existing.map((s) => [String(s.symbol).toUpperCase(), s]));
        const newSymbols = rows.filter((r) => !bySymbol.has(r.symbol)).length;
        const resulting = bySymbol.size + newSymbols;
        // Reject whole-file rather than importing half of it — a partially
        // applied import is worse than none, because it is hard to undo.
        if (resulting > CSV_IMPORT_MAX_HOLDINGS) {
            return res.status(400).json({
                message: `That import would leave ${resulting} holdings in this portfolio; the limit is ${CSV_IMPORT_MAX_HOLDINGS}. Nothing was imported.`
            });
        }

        // One profile lookup per distinct symbol, best effort: a failed lookup
        // stores price 0 and fills in on the next dashboard load, exactly like
        // a single add whose quote lookup failed.
        const profiles = new Map();
        for (const row of rows) {
            if (bySymbol.has(row.symbol)) continue;
            let profile = {};
            let livePrice = 0;
            try {
                profile = await assetProfile.fetchAssetProfile(row.symbol, { fundDetails: false }) || {};
                const quoted = Number(profile.price);
                if (Number.isFinite(quoted) && quoted > 0) { livePrice = quoted; cacheSet(priceCache, row.symbol, livePrice); }
            } catch (_) { /* unknown ticker or quote outage — reported below */ }
            if (!livePrice) {
                try { livePrice = await getStockPrice(row.symbol); } catch (_) { /* price fills in later */ }
            }
            profiles.set(row.symbol, { profile, livePrice });
        }

        // A symbol that resolves to neither a name nor a price does not exist:
        // importing it would create a holding stuck at $0. Report it with the
        // other skips rather than silently filling the portfolio with junk.
        const unresolved = rows.filter((row) => {
            if (bySymbol.has(row.symbol)) return false;
            const got = profiles.get(row.symbol) || {};
            const named = got.profile && got.profile.name && String(got.profile.name).toUpperCase() !== row.symbol;
            return !got.livePrice && !named;
        }).map((row) => row.symbol);
        const unresolvedSet = new Set(unresolved);

        let imported = 0;
        let merged = 0;
        for (const row of rows) {
            if (unresolvedSet.has(row.symbol)) continue;
            const current = bySymbol.get(row.symbol);
            if (current) {
                // Weighted average across both lots, ignoring unpriced units so
                // a price-less CSV row cannot drag the cost basis toward zero.
                const curShares = Number(current.shares) || 0;
                const curPrice = Number(current.purchasePrice) || 0;
                const pricedShares = (curPrice > 0 ? curShares : 0) + (row.price > 0 ? row.shares : 0);
                const pricedTotal = (curPrice > 0 ? curShares * curPrice : 0) + (row.price > 0 ? row.shares * row.price : 0);
                const update = {
                    shares: curShares + row.shares,
                    purchasePrice: pricedShares > 0 ? pricedTotal / pricedShares : 0
                };
                const rowDate = row.purchaseDate ? new Date(`${row.purchaseDate}T00:00:00Z`) : null;
                if (rowDate && (!current.purchaseDate || rowDate < new Date(current.purchaseDate))) update.purchaseDate = rowDate;
                await Stock.updateOne({ _id: current._id, user: ownerId }, { $set: update });
                merged++;
                continue;
            }
            const { profile, livePrice } = profiles.get(row.symbol) || { profile: {}, livePrice: 0 };
            await new Stock({
                symbol: row.symbol,
                name: profile.name || row.symbol,
                sector: profile.sector || profile.category || '',
                assetType: profile.assetType || (isCryptoSymbol(row.symbol) ? 'crypto' : 'stock'),
                quoteType: profile.quoteType || '',
                category: profile.category || '',
                shares: row.shares,
                purchasePrice: row.price > 0 ? row.price : livePrice,
                purchaseDate: row.purchaseDate ? new Date(`${row.purchaseDate}T00:00:00Z`) : new Date(),
                currentPrice: livePrice,
                portfolioId: target.portfolioId,
                user: ownerId
            }).save();
            imported++;
        }

        invalidatePortfolioCaches(ownerId);
        if (imported + merged > 0) {
            trackActivation(req.userId, 'portfolio', {
                resultValid: true, sourceOpened: false, featureType: 'portfolio',
                requestFields: trackingRequestFields(req, res)
            });
            markOnboardingStep(req.user, 'hold');
        }
        res.status(200).json({
            imported,
            merged,
            skipped: parsed.skipped.length + unresolved.length,
            unknownSymbols: unresolved
        });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).json({ message: 'Database unavailable.' });
        res.status(500).json({ message: 'Unable to import that CSV right now.' });
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
    } catch (liveError) {
        // Direct-LTD test mode: a test-account event fails live-secret
        // verification above (expected — different signing secret). Retry
        // against the test secret ONLY if one is configured; this never runs,
        // and never weakens verification, when STRIPE_TEST_WEBHOOK_SECRET is
        // unset (the normal production state).
        if (directLtdStripe && STRIPE_TEST_WEBHOOK_SECRET) {
            try {
                event = directLtdStripe.webhooks.constructEvent(req.body, sig, STRIPE_TEST_WEBHOOK_SECRET);
            } catch (testError) {
                console.error('Stripe webhook signature error (live + test):', liveError, testError);
                return res.status(400).send('Webhook signature invalid');
            }
        } else {
            console.error('Stripe webhook signature error:', liveError);
            return res.status(400).send('Webhook signature invalid');
        }
    }

    const payload = event.data.object;
    if (event.type === 'checkout.session.completed') {
        try {
            // Paid-first signup: this is where the account is actually born.
            // materializePendingSignup() refuses unless Stripe reports the
            // session paid, so no payment means no user — full stop.
            // The paid research briefing is settled BEFORE the userId gate
            // below, because it is the one product here that a complete
            // stranger can buy: the Stripe payment link grants no app access,
            // so there is no account to look up and none to create. A buyer
            // with no userId would otherwise fall past every branch and pay
            // for silence — the exact failure the Intelligence SKU already
            // has (HANDOFF item 7: "purchase takes money, delivers nothing").
            //
            // It is also a genuine recurring Stripe subscription, so
            // payload.subscription is set and it MUST return here rather than
            // reach the subscription branches, where syncSubscriptionFromStripe
            // would try to resolve it to an app plan it must never grant.
            if (briefingSubscription.enabled()) {
                // Only pay for the extra Stripe round trip when the session
                // declares no checkoutType of its own. Every other paid path
                // here sets one, so this costs nothing on app checkouts and
                // still catches a dashboard payment link built without the
                // metadata field filled in.
                let briefingPriceIds = [];
                if (!payload.metadata?.checkoutType && stripe) {
                    try {
                        const items = await stripe.checkout.sessions.listLineItems(payload.id, { limit: 10 });
                        briefingPriceIds = (items && items.data ? items.data : []).map((li) => li.price && li.price.id);
                    } catch (lineItemError) {
                        console.error('[briefing] line item lookup failed:', lineItemError && lineItemError.message);
                    }
                }
                if (briefingSubscription.matches(payload, briefingPriceIds)) {
                    if (payload.payment_status === 'paid') {
                        // record() is idempotent on the session id and returns
                        // true only on a real first insert, so a webhook
                        // redelivery can never send a second welcome email.
                        const inserted = await briefingSubscription.record({ payload, eventId: event.id });
                        if (inserted) {
                            const email = briefingSubscription.buyerEmail(payload);
                            // Informational only: it decides one line of the
                            // owner alert. A briefing sale never reads from or
                            // writes to the app account, even when one exists.
                            let alreadyACustomer = false;
                            try {
                                alreadyACustomer = email ? Boolean(await User.findOne({ email }).select('_id').lean()) : false;
                            } catch (lookupError) {
                                console.error('[briefing] account overlap lookup failed:', lookupError && lookupError.message);
                            }
                            await mailer.sendBriefingPaidEmails({
                                name: briefingSubscription.buyerName(payload),
                                email,
                                priceUsd: briefingSubscription.priceUsd(),
                                companiesPerMonth: briefingSubscription.COMPANIES_PER_MONTH,
                                alreadyACustomer
                            }).catch((mailError) => console.error('[briefing] paid mail failed:', mailError && mailError.message));
                        }
                    } else {
                        console.warn(`[briefing] session ${payload.id} completed with payment_status=${payload.payment_status}; no subscriber recorded.`);
                    }
                    return res.status(200).send({ received: true });
                }
            }
            const pendingSignupId = payload.metadata?.pendingSignupId || null;
            const materialized = pendingSignupId
                ? await materializePendingSignup(pendingSignupId, payload)
                : null;
            const clientRef = typeof payload.client_reference_id === 'string' && payload.client_reference_id.startsWith('pending:')
                ? null
                : payload.client_reference_id;
            const userId = payload.metadata?.userId
                || (materialized ? materialized._id.toString() : null)
                || clientRef;
            if (pendingSignupId && !materialized) {
                console.warn(`[stripe] session ${payload.id} carried pending signup ${pendingSignupId} but no account was created (payment_status=${payload.payment_status}).`);
            }
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
                    if (payload.metadata?.checkoutType === directLtd.CHECKOUT_TYPE) {
                        // Direct lifetime deal (#9). Like the China pass this is a
                        // one-time payment with payload.subscription === null, so it
                        // must be handled before the subscription branches below or it
                        // would fall through to activateSubscription(). Card-only, so
                        // payment_status is settled here and there is no async path.
                        if (payload.payment_status === 'paid') {
                            await handleDirectLtdPaid(user, payload, event);
                            // Entitlement first, commission second: a partner
                            // ledger failure must never cost the buyer access.
                            await affiliateProgram.recordStripeOneTimePaid({
                                payload,
                                eventId: event.id,
                                holdDays: directLtd.refundDays()
                            }).catch((error) => console.error('[affiliate] direct-LTD commission error:', error && error.message));
                        } else {
                            console.warn(`[direct-ltd] Session ${payload.id} completed with payment_status=${payload.payment_status}; no entitlement granted.`);
                        }
                    } else if (payload.metadata?.checkoutType === 'china_annual_pass') {
                        // One-time payment, not a Stripe Subscription — payload.subscription
                        // is always null here, so this must be handled before (and instead
                        // of) the subscription/no-subscription branches below, otherwise it
                        // would fall into the `else` branch and get a non-expiring
                        // activateSubscription() grant. Alipay/WeChat Pay confirm async, so
                        // payment_status may still be 'unpaid' here — async_payment_succeeded
                        // picks it up in that case.
                        if (payload.payment_status === 'paid') {
                            await handleChinaAnnualPassPaid(user, payload, event);
                        }
                        return res.status(200).send({ received: true });
                    } else if (payload.metadata?.checkoutType === 'credit_topup') {
                        // One-time credit refill (payment mode, payload.subscription
                        // always null) — handled before the subscription branches, same
                        // reason as the china pass. grant() is idempotent on the session
                        // id, so Stripe webhook redelivery never double-credits.
                        if (payload.payment_status === 'paid') {
                            const inserted = await credits.grant(
                                userId,
                                Number(payload.metadata?.credits) || CREDIT_TOPUP_CREDITS,
                                'topup',
                                payload.id
                            );
                            if (inserted) {
                                trackFunnel('credit_topup_paid', user._id, user.subscription && user.subscription.planName, {
                                    eventName: 'credit_topup_paid',
                                    dedupeKey: `credit_topup:${payload.id}`,
                                    entitlementSource: 'stripe',
                                    testFlag: payload.livemode === false
                                });
                            }
                        } else {
                            console.warn(`[credits] topup session ${payload.id} completed with payment_status=${payload.payment_status}; no credits granted.`);
                        }
                        return res.status(200).send({ received: true });
                    }
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
    } else if (event.type === 'checkout.session.async_payment_succeeded') {
        // Alipay/WeChat Pay's normal confirmation path — payment_status was
        // still 'unpaid' at checkout.session.completed time for these.
        try {
            if (payload.metadata?.checkoutType === 'china_annual_pass') {
                const userId = payload.metadata?.userId || payload.client_reference_id;
                const user = userId ? await User.findById(userId) : null;
                if (user) await handleChinaAnnualPassPaid(user, payload, event);
            }
        } catch (err) {
            console.error('Stripe webhook async_payment_succeeded error:', err);
        }
    } else if (event.type === 'checkout.session.async_payment_failed') {
        try {
            if (payload.metadata?.checkoutType === 'china_annual_pass') {
                const userId = payload.metadata?.userId || payload.client_reference_id;
                const user = userId ? await User.findById(userId) : null;
                if (user) trackFunnel('checkout_payment_failed', user._id, 'China annual pass', {
                    eventName: 'checkout_payment_failed',
                    dedupeKey: event.id ? `stripe:china-annual-failed:${event.id}` : null,
                    entitlementSource: 'stripe_china_annual'
                });
            }
        } catch (err) {
            console.error('Stripe webhook async_payment_failed error:', err);
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
            const result = await affiliateProgram.reverseStripeCommission({
                payload,
                reason: 'refund',
                eventId: event.id,
                eventType: event.type
            });
            if (result && result.reversed) trackFunnel('commission_reversed', null, 'Stripe', { reason: 'refund' });
        } catch (err) {
            console.error('[affiliate] Stripe refund attribution error:', err && err.message);
        }
    } else if (event.type === 'charge.dispute.created') {
        try {
            const result = await affiliateProgram.reverseStripeCommission({
                payload,
                reason: 'dispute',
                eventId: event.id,
                eventType: event.type
            });
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
            // A cancelled briefing has no app user attached, so it is marked
            // on its own collection and never falls through to the User
            // lookup below (which would find nothing and silently no-op).
            await briefingSubscription.deactivate(subscription.id);
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
// Second gating dimension (monitored companies + history depth), shipped dark.
// Ask count meters cost; these meter value. Both flags off => no behaviour
// change anywhere. See lib/tier-limits.js and the tier-v2 proposal doc.
// (tierLimits itself is required at the top, beside trial-grant, because
// hasMonitor() needs it and is defined long before this point.)

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

// Grants the lifetime Pro entitlement. Shared by BOTH lifetime channels:
// AppSumo (marketplace-issued license key) and direct LTD (#9, key minted by
// backend/direct-ltd.js after a Stripe payment). The entitlement is identical
// by design — same tier ladder, same Ask cap, same AppSumoLicense row — so
// `channel` is what keeps the two apart in reporting and in outbound email.
// It defaults to 'appsumo', leaving every existing caller unchanged.
async function grantAppSumoProAccess(user, { licenseKey, tier, acquisition, requestFields, discoverySource, channel = 'appsumo', paidUsd = null, stripeSessionId = null } = {}) {
    const isDirect = channel === directLtd.CHANNEL;
    const directCfg = isDirect ? directLtd.tierConfig(tier) : null;
    // Fall back to the AppSumo ladder if a direct tier is somehow unknown, so a
    // paying customer is never left ungranted.
    const cfg = directCfg ? { planName: directCfg.planName, askCap: directCfg.askCap } : appsumoTierConfig(tier);
    const now = new Date();
    const firstRedemption = !user.appsumoRedeemedAt;
    const licenseFingerprint = licenseKey
        ? crypto.createHash('sha256').update(String(licenseKey)).digest('hex').slice(0, 20)
        : 'unknown';
    if (firstRedemption) trackFunnel(isDirect ? 'direct_ltd_redemption_started' : 'appsumo_redemption_started', user._id, cfg.planName, {
        eventName: isDirect ? 'direct_ltd_redemption_started' : 'appsumo_redemption_started',
        dedupeKey: `${channel}:redemption-started:${String(user._id)}:${licenseFingerprint}`,
        entitlementSource: channel, appsumoTier: Number(tier) || null,
        ...(requestFields || {})
    });
    applyPlanToSubscription(user, PRO_PLAN_ID); // reuse the Pro plan ladder
    user.subscription.planName = cfg.planName;
    user.subscription.price = 0;                 // already paid (AppSumo, or direct at checkout)
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
    user.ltdChannel = user.ltdChannel || channel;
    user.pendingDirectLtdTier = null;
    if (isDirect) {
        if (stripeSessionId) user.directLtdStripeSessionId = stripeSessionId;
        if (Number.isFinite(Number(paidUsd))) user.directLtdPaidUsd = Number(paidUsd);
    }
    user.markModified('subscription');
    await user.save();
    if (firstRedemption) {
        await recordCustomerLifecycleEvent(user, isDirect ? 'direct_ltd_redeemed' : 'appsumo_redeemed', {
            source: channel,
            appsumoTier: Number(tier) || null,
            discoverySource: normalizedDiscoverySource
        });
        // A direct buyer never gets the AppSumo review request: they did not buy
        // on AppSumo and cannot leave a review there, so the ask would be both
        // useless and confusing. Onboarding is channel-neutral and is reused.
        if (!isDirect) {
            scheduleAppSumoReviewRequest(user, { licenseKey, tier })
                .catch((e) => console.error('[appsumo] review schedule error:', e && e.message));
        }
        scheduleAppSumoOnboarding(user, { tier })
            .catch((e) => console.error(`[${channel}] onboarding schedule error:`, e && e.message));
    }
    trackFunnel('paid', user._id, cfg.planName, {
        // The legacy `paid` event remains for existing dashboards. Its
        // canonical name is explicit so an AppSumo redemption cannot be
        // mistaken for a Stripe invoice, and the key makes webhook retries
        // idempotent.
        eventName: firstRedemption ? (isDirect ? 'direct_ltd_redemption_completed' : 'appsumo_redemption_completed') : 'legacy_paid',
        dedupeKey: `${channel}:redemption-completed:${String(user._id)}:${licenseFingerprint}`,
        source: channel,
        entitlementSource: channel,
        // Revenue: an AppSumo redemption is $0 to us at this moment (AppSumo
        // collected it), a direct one is the Stripe charge. Keeping them in
        // separate channels is what stops the two being added together.
        amountUsd: isDirect ? paidUsd : null,
        appsumoLicenseKey: licenseKey || null,
        appsumoTier: Number(tier) || null,
        acquisitionSource: acquisition ? acquisition.source : null,
        acquisitionClickId: acquisition ? acquisition.clickId : null,
        contentId: acquisition ? acquisition.contentId : null,
        acquisitionClickedAt: acquisition ? acquisition.clickedAt : null,
        discoverySource: normalizedDiscoverySource,
        ...(requestFields || {})
    });
    if (firstRedemption) trackFunnel(isDirect ? 'direct_ltd_activation' : 'appsumo_activation', user._id, cfg.planName, {
        eventName: isDirect ? 'direct_ltd_activation' : 'appsumo_activation',
        dedupeKey: `${channel}:activation:${String(user._id)}:${licenseFingerprint}`,
        entitlementSource: channel, source: channel,
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
// Keep a side-effect-free GET response for partner-portal reachability checks.
// Real lifecycle events are accepted only by the signed POST handler below.
app.get('/appsumo/webhook', (_req, res) => {
    return res.status(200).json({ success: true, status: 'ready' });
});

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
        // 60 minutes: long enough that stepping away mid-activation doesn't
        // send the buyer back to AppSumo to start over.
        const rt = jwt.sign({ asLicenseKey: licenseKey, asTier: tier, asRedeem: true }, JWT_SECRET, { expiresIn: '60m' });
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
.hint{font-size:12px;color:#5b6470;margin:6px 0 0}
.or{display:flex;align-items:center;gap:10px;color:#8a929c;font-size:13px;margin:18px 0 4px}
.or:before,.or:after{content:"";flex:1;height:1px;background:#e6e8eb}
#gshell{margin-top:4px}
#gbtn{display:flex;justify-content:center;min-height:44px}
.msg{margin-top:14px;padding:11px 12px;border-radius:10px;font-size:14px}
.msg.err{background:#fdecea;color:#b3261e}.msg.ok{background:#e8f5ed;color:#1a7f43}
.bull{font-size:34px}
</style></head><body><div class="wrap"><div class="card">
<div class="bull">&#128002;</div>
<h1>Activate your lifetime Pro</h1>
<p class="sub">Attach your AppSumo purchase to a StockPortfolio.pro account. It's yours for life.</p>
<div id="form">
<div id="gshell" hidden><div id="gbtn"></div><div class="or">or</div></div>
<label for="email">Email</label><input id="email" type="email" autocomplete="email" placeholder="you@email.com">
<label for="password">Password</label><input id="password" type="password" autocomplete="new-password" placeholder="Create a password">
<p class="hint" id="pwhint">At least 8 characters, with one capital letter, one lowercase letter and one number.</p>
<label for="discovery">Where did you first discover StockPortfolio.pro? <span style="font-weight:400;color:#5b6470">(optional)</span></label>
<select id="discovery"><option value="">Choose one</option><option value="appsumo">AppSumo marketplace</option><option value="x">X / Twitter</option><option value="linkedin">LinkedIn</option><option value="youtube">YouTube</option><option value="google">Google</option><option value="newsletter">Newsletter</option><option value="friend">Friend or colleague</option><option value="other">Other</option></select>
<button id="go">Create account &amp; activate</button>
<button id="alt" class="alt">I already have an account</button>
</div>
<div id="out"></div>
</div></div>
<script>
var DATA = ${data};
// Signup is the default because almost everyone landing here came straight
// from AppSumo's Redeem button and has never had an account. Logging in is
// the exception, not the rule.
var mode = 'signup';
var out = document.getElementById('out');
var go = document.getElementById('go');
var alt = document.getElementById('alt');
var pwhint = document.getElementById('pwhint');
var blocked = false;
function show(cls, html){ out.innerHTML = '<div class="msg '+cls+'">'+html+'</div>'; }
function lock(){ blocked = true; go.disabled = true; alt.disabled = true; }
if (DATA.error) { show('err', DATA.error); lock(); }
else if (!DATA.rt) { show('err', 'Open this page from your AppSumo "Redeem" button to activate.'); lock(); }
alt.onclick = function(){
  mode = (mode === 'signup') ? 'login' : 'signup';
  go.textContent = (mode === 'signup') ? 'Create account & activate' : 'Log in & activate';
  alt.textContent = (mode === 'signup') ? 'I already have an account' : 'Create a new account instead';
  document.getElementById('password').setAttribute('autocomplete', mode === 'signup' ? 'new-password' : 'current-password');
  document.getElementById('password').placeholder = (mode === 'signup') ? 'Create a password' : 'Your password';
  pwhint.hidden = (mode !== 'signup');
};

// One-click path: Google verifies the email, so the buyer types nothing.
// Self-contained on purpose — this page deliberately loads none of the v2
// bundle. Silently stays hidden if Google sign-in is not enabled on this host.
function finishActivation(token){
  var discoverySource = document.getElementById('discovery').value;
  return fetch('/api/appsumo/activate', {
    method:'POST',
    headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},
    body: JSON.stringify({ rt: DATA.rt, discoverySource: discoverySource || undefined })
  }).then(function(rr){ return rr.json().then(function(rj){ return { ok: rr.ok, body: rj }; }); });
}
function activated(token, rj){
  try { localStorage.setItem('token', token); } catch(e){}
  document.getElementById('form').style.display = 'none';
  show('ok', '\u2705 ' + ((rj && rj.message) || 'Pro unlocked.') + ' <a href="/onboarding">Run your first cited result &rarr;</a>');
}
(async function initGoogle(){
  if (blocked) return;
  try {
    var cfg = await fetch('/api/auth/providers').then(function(r){ return r.ok ? r.json() : null; });
    if (!cfg || !cfg.google || !cfg.google.enabled || !cfg.google.clientId) return;
    await new Promise(function(resolve, reject){
      var sc = document.createElement('script');
      sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true; sc.defer = true;
      sc.onload = resolve; sc.onerror = reject; document.head.appendChild(sc);
    });
    if (!(window.google && window.google.accounts && window.google.accounts.id)) return;
    window.google.accounts.id.initialize({
      client_id: cfg.google.clientId,
      callback: async function(response){
        go.disabled = true; alt.disabled = true; show('', 'Activating...');
        try {
          var ar = await fetch('/api/auth/social', {
            method:'POST', headers:{'Content-Type':'application/json'},
            body: JSON.stringify({ provider:'google', flow:'register', plan:'pro', credential: response.credential, appsumoRedeemToken: DATA.rt })
          });
          var aj = await ar.json();
          if (!ar.ok || !aj.token) { show('err', (aj && aj.message) || 'Could not sign you in with Google.'); go.disabled=false; alt.disabled=false; return; }
          var done = await finishActivation(aj.token);
          if (!done.ok) { show('err', (done.body && done.body.message) || 'Activation failed.'); go.disabled=false; alt.disabled=false; return; }
          activated(aj.token, done.body);
        } catch (e) {
          show('err', 'Network error - please try again.'); go.disabled=false; alt.disabled=false;
        }
      }
    });
    var shell = document.getElementById('gshell');
    var mount = document.getElementById('gbtn');
    var width = Math.max(200, Math.round(mount.getBoundingClientRect().width || 380));
    window.google.accounts.id.renderButton(mount, { theme:'outline', size:'large', shape:'rectangular', text:'continue_with', width: width, logo_alignment:'left' });
    shell.hidden = false;
  } catch (e) { /* Google unavailable - the email form below still works */ }
})();
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
    var done = await finishActivation(aj.token);
    if (!done.ok) { show('err', (done.body && done.body.message) || 'Activation failed.'); go.disabled=false; alt.disabled=false; return; }
    activated(aj.token, done.body);
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

// ---- POST /api/onboarding — declared intent, and dismissal ----
// The browser may record which of the three first-run paths the customer chose,
// and it may dismiss the flow. It may NOT mark a step complete: steps are
// written only by the handlers that observe the real action (markOnboardingStep),
// so the checklist can never claim work the customer did not actually do.
app.post('/api/onboarding', authMiddleware, async (req, res) => {
    try {
        const user = req.user;
        const plan = user.subscription && user.subscription.planName;
        if (req.body && req.body.dismissed === true) {
            if (!user.onboardingDismissedAt) {
                user.onboardingDismissedAt = new Date();
                await User.updateOne({ _id: user._id }, { $set: { onboardingDismissedAt: user.onboardingDismissedAt } });
                trackFunnel('onboarding_skipped', user._id, plan, {
                    eventName: 'onboarding_skipped',
                    dedupeKey: `onboarding-skipped:${String(user._id)}`,
                    entitlementSource: entitlementSourceFor(user)
                });
            }
            return res.json({ ok: true, onboarding: onboardingState(user) });
        }
        const path = String(req.body && req.body.path || '').trim().toLowerCase();
        if (!['research', 'portfolio', 'ideas'].includes(path)) {
            return res.status(400).json({ message: 'Unknown onboarding path.' });
        }
        // First choice wins: re-opening the dialog must not restart the funnel.
        if (!user.onboardingPath) {
            user.onboardingPath = path;
            user.onboardingStartedAt = new Date();
            await User.updateOne({ _id: user._id }, { $set: { onboardingPath: path, onboardingStartedAt: user.onboardingStartedAt } });
            trackFunnel('onboarding_started', user._id, plan, {
                eventName: 'onboarding_started',
                dedupeKey: `onboarding-started:${String(user._id)}`,
                entitlementSource: entitlementSourceFor(user),
                onboardingPath: path
            });
        }
        return res.json({ ok: true, onboarding: onboardingState(user) });
    } catch (error) {
        console.error('/api/onboarding error:', error);
        return res.status(500).json({ message: 'Unable to save onboarding progress.' });
    }
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
    const rows = Array.isArray(data.holdings) ? data.holdings : [];
    const holdings = rows.slice(0, 5).map(({ activity, shareChangePct, prevShares, ...keep }) => keep);
    return {
        ...data, holdings, sells: [], performance: null, hasActivity: false, analysis: null,
        holdingsTotal: data.holdingsTotal ?? rows.length, holdingsShown: holdings.length,
        locked: true, teaser: true, analysisLocked: true
    };
}
// Core: the Form-4 trail. Free keeps the shape (so the company page renders and
// the teaser stays honest) but not the values: no per-transaction list, and the
// newest quarter — the one that says what insiders did *most recently* — is
// withheld server-side instead of blurred client-side.
function lockInsiderHistory(result) {
    const quarters = Array.isArray(result.quarters) ? result.quarters.slice(0, -1) : result.quarters;
    return {
        ...result, quarters, recent: [], recentTotal: Array.isArray(result.recent) ? result.recent.length : 0,
        latestQuarterLocked: true, locked: true, source: result.source
    };
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
        // Lifetime tiers are coverage-capped rather than gated out entirely;
        // Power/Desk pass through untouched (capSymbols is a no-op for them).
        const symbols = tierLimits.capSymbols(req.user, [...holdings.map((h) => h.symbol), ...((wl && wl.symbols) || [])]);
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
            if (cached) {
                recordMonitorView(req.userId, normSym, cached.name);
                return res.json({ report: cached });
            }
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
            recordMonitorView(req.userId, normSym, instrument.name);
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
            // Credit charge lives INSIDE this wrapper, after buildReport resolves,
            // rather than after the Promise.race below. A cold build routinely
            // outlives MONITOR_FAST_MS (9s) — this route then returns PENDING to
            // its original caller, and the finished result is only ever observed
            // later via ?poll=1, which never charges (it's a pure cache read).
            // Charging only after `winner` resolves would mean any build slow
            // enough to hit that path is never charged at all — the same
            // poll-path/fast-path gap fixed for Dossier at the credits.check/
            // spend call above. Wrapping it here also keeps this atomic with
            // registering the promise in _monitorInflight (no `await` in
            // between), so two concurrent requests for the same brand-new
            // symbol can't both slip through uncharged the way the Dossier race
            // did before that fix.
            build = (async () => {
                const result = await filingMonitor.buildReport(sym, { force, onStage: (stage) => _monitorProgress.set(sym, stage) });
                if (paid && req.userId && result && !result.error && result.cached !== true) {
                    await credits.spend(req.userId, 'monitor', 'monitor', sym);
                }
                return result;
            })()
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
        recordMonitorView(req.userId, normSym, winner && winner.name);
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

// ---- Research Dossier (Pro/Power/Desk) — the on-demand initiation report ----
// The Monitor says "what changed in a name I follow"; the dossier answers
// "should I own this at all" — a from-scratch, source-linked write-up on ANY
// ticker. It composes several slow grounded surfaces, so (like the Monitor) we
// decouple the build and let the client poll, sharing one build across callers.
const dossier = require('./dossier');
const thesisModel = require('./thesis');
const _dossierInflight = new Map();
const _dossierProgress = new Map();
const DOSSIER_FAST_MS = 9000;

// Dossier Compare — the same structured sections for 2–3 companies, side by
// side. Comparability is the product's stated differentiator (customer
// interviews, 2026-08): every Dossier already shares one section schema, so a
// compare surface is read-only over work already paid for. peekDossier is
// build-free: this route NEVER triggers a build — a missing report is
// reported back and the client builds it through the paid single-symbol path.
// Must stay registered BEFORE /api/dossier/:symbol, or this path is captured
// as a ticker and 400s on the first request.
app.get('/api/dossier/compare', authMiddleware, proGate, async (req, res) => {
    try {
        const syms = [...new Set(String(req.query.symbols || '')
            .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))];
        if (syms.length < 2) return res.status(400).json({ message: 'Compare 2 or 3 companies.', code: 'COMPARE_SYMBOL_COUNT' });
        if (syms.length > 3) return res.status(400).json({ message: 'Compare up to 3 companies at a time.', code: 'COMPARE_SYMBOL_COUNT' });
        if (syms.some((s) => !/^[A-Z0-9.\-]{1,10}$/.test(s))) return res.status(400).json({ message: 'Invalid ticker.' });

        const ready = [];
        const missing = [];
        for (const sym of syms) {
            const cached = await dossier.peekDossier(sym).catch(() => null);
            if (cached && !cached.error && cached.schemaVersion) ready.push(cached); else missing.push(sym);
        }
        if (missing.length) {
            return res.json({ missing, readyCount: ready.length, buildCost: credits.COST.dossier_standard, message: `${missing.join(', ')} ${missing.length === 1 ? "doesn't" : "don't"} have a Dossier yet. Build the Standard Dossier first.` });
        }

        const planId = req.subscription && req.subscription.planId;
        const affordability = await credits.check(req.userId, 'dossier_compare', effectiveAskLimit(req), planId, req.user);
        if (!affordability.ok) {
            return res.status(402).json({
                message: `A comparison costs ${credits.COST.dossier_compare} credits — you have ${affordability.remaining} left this month.`,
                code: 'INSUFFICIENT_CREDITS', cost: affordability.cost, remaining: affordability.remaining
            });
        }
        await credits.spend(req.userId, 'dossier_compare', 'dossier-compare', syms.join(':'));
        trackFunnel('dossier_compare_rendered', req.userId, planId, {
            eventName: 'dossier_compare_rendered',
            dedupeKey: `dossier-compare:${String(req.userId)}:${syms.join(':')}`,
            entitlementSource: req.user && req.user.appsumoRedeemedAt ? 'appsumo' : 'unknown',
            appsumoTier: Number(req.user && req.user.appsumoTier) || null
        });
        return res.json({ comparison: ready, symbols: syms, cost: credits.COST.dossier_compare });
    } catch (error) {
        console.error('[dossier-compare] route error:', error && error.message);
        res.status(500).json({ message: 'Failed to compare the dossiers.' });
    }
});

app.get('/api/dossier/:symbol', authMiddleware, proGate, async (req, res) => {
    try {
        const sym = String(req.params.symbol || '').toUpperCase().trim();
        if (!/^[A-Z0-9.\-]{1,10}$/.test(sym)) return res.status(400).json({ message: 'Invalid ticker.' });
        // Deep reads the last 3 10-Ks and compares them; a Standard and a Deep
        // request for the same symbol are different work and must not share an
        // in-flight slot or one requester could receive the other's depth.
        const depth = req.query.depth === 'deep' ? 'deep' : 'standard';
        const inflightKey = `${sym}:${depth}`;
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
            recordDossierView(req.userId, sym, instrument.name);
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
        // Never charges — it cannot trigger new work, only observe it.
        if (req.query.poll === '1') {
            if (_dossierInflight.has(inflightKey)) return res.status(202).json({ status: 'building', symbol: sym, stage: _dossierProgress.get(inflightKey) || null });
            const cached = await dossier.peekDossier(sym, depth).catch(() => null);
            if (cached) {
                recordDossierView(req.userId, sym, cached.name);
                return res.json({ dossier: cached });
            }
            return res.status(202).json({ status: 'building', symbol: sym, stage: _dossierProgress.get(inflightKey) || null });
        }

        // Same free-cache-read the poll path just did, done here too: without
        // this, a request for an already-cached dossier reaching the non-poll
        // branch would fall through to the credit check below and get charged
        // for work buildDossier was about to skip anyway (it does its own
        // cache check first). Skipped on a force refresh, which explicitly
        // wants to ignore the cache.
        if (!force) {
            const preCached = await dossier.peekDossier(sym, depth).catch(() => null);
            if (preCached) {
                recordDossierView(req.userId, sym, preCached.name);
                return res.json({ dossier: preCached });
            }
        }

        let build = (!force && _dossierInflight.get(inflightKey)) || null;
        if (!build) {
            // Reaching here means this request is originating a NEW build, not
            // joining one already running (that case takes the branch above,
            // via _dossierInflight). The credit check+spend happens INSIDE
            // this async wrapper, not before it, so the wrapper's promise can
            // be registered in _dossierInflight synchronously — with no
            // `await` between "no one else is building this" and "I've
            // claimed the slot". Two requests for the same brand-new
            // symbol+depth arriving back to back would otherwise both read
            // _dossierInflight as empty, both pass the credit check, and both
            // spend — the credit check/spend must ride inside the same
            // atomic claim the de-dup itself relies on. Concurrent requests
            // that find this build already in flight ride it for free: the
            // work was already paid for by whoever started it. force is
            // exempt — an ops action gated by ADMIN_TOKEN above, not a
            // purchase.
            build = (async () => {
                if (!force) {
                    const costKey = depth === 'deep' ? 'dossier_deep' : 'dossier_standard';
                    const planId = req.subscription && req.subscription.planId;
                    const gate = await credits.check(req.userId, costKey, effectiveAskLimit(req), planId, req.user);
                    if (!gate.ok) return { creditsError: gate };
                    await credits.spend(req.userId, costKey, 'dossier', `${sym}:${depth}`);
                }
                return dossier.buildDossier(sym, { force, depth, onStage: (stage) => _dossierProgress.set(inflightKey, stage) });
            })()
                .catch((err) => { console.error('[dossier] build error:', err && err.message); return { error: 'Couldn’t build the dossier right now — please try again in a moment.' }; })
                .finally(() => { _dossierInflight.delete(inflightKey); _dossierProgress.delete(inflightKey); });
            _dossierInflight.set(inflightKey, build);
        }
        const winner = await Promise.race([build, new Promise((r) => setTimeout(() => r('PENDING'), DOSSIER_FAST_MS))]);
        if (winner && winner.creditsError) {
            const gate = winner.creditsError;
            return res.status(402).json({
                message: `A ${depth === 'deep' ? 'Deep ' : ''}Dossier costs ${gate.cost} credits — you have ${gate.remaining} left this month.`,
                code: 'CREDITS_REQUIRED',
                credits: { used: gate.used, allowance: gate.allowance, remaining: gate.remaining, needed: gate.cost, resetsAt: gate.resetsAt }
            });
        }
        if (winner && winner.error) return res.status(404).json(winner);
        if (winner === 'PENDING') return res.status(202).json({ status: 'building', symbol: sym, stage: _dossierProgress.get(inflightKey) || null });
        if (winner && winner.status === 'building') return res.status(202).json(winner);
        recordDossierView(req.userId, sym, winner && winner.name);
        if (req.userId && winner && !winner.error) trackActivation(req.userId, 'dossier', {
            resultValid: true, sourceOpened: false, featureType: 'dossier',
            requestFields: trackingRequestFields(req, res)
        });
        if (winner && !winner.error) markOnboardingStep(req.user, 'dossier');
        return res.json({ dossier: winner });
    } catch (err) {
        console.error('[dossier] route error:', err.message);
        res.status(500).json({ message: 'Failed to build the dossier.' });
    }
});

app.get('/api/dossier-history/recent', authMiddleware, async (req, res) => {
    try {
        const views = await DossierView.find({ userId: req.userId }).sort({ lastViewedAt: -1 }).limit(12).lean();
        res.json({ recent: views.map((v) => ({ symbol: v.symbol, name: v.name || null, lastViewedAt: v.lastViewedAt })) });
    } catch (error) {
        res.status(500).json({ message: 'Unable to load recent research.' });
    }
});

// Saved Ask answers — read-only, free to open (credits are only spent when a
// new answer is generated, never when re-reading a stored one).
app.get('/api/ask-history/recent', authMiddleware, async (req, res) => {
    try {
        const reports = await AskReport.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(12).lean();
        res.json({
            recent: reports.map((r) => ({
                id: r._id,
                question: String(r.question || '').slice(0, ASK_REPORT_LIST_BLURB),
                mode: r.mode,
                toolsUsed: r.toolsUsed || [],
                createdAt: r.createdAt
            }))
        });
    } catch (error) {
        res.status(500).json({ message: 'Unable to load recent answers.' });
    }
});

app.get('/api/ask-history/:id', authMiddleware, async (req, res) => {
    try {
        if (!/^[0-9a-fA-F]{24}$/.test(String(req.params.id || ''))) return res.status(404).json({ message: 'Report not found.' });
        const report = await AskReport.findOne({ _id: req.params.id, userId: req.userId }).lean();
        if (!report) return res.status(404).json({ message: 'Report not found.' });
        res.json({ report: { question: report.question, answer: report.answer, mode: report.mode, toolsUsed: report.toolsUsed || [], createdAt: report.createdAt } });
    } catch (error) {
        res.status(500).json({ message: 'Unable to load the saved answer.' });
    }
});

// Ask conversation threads — list (optionally full-text ?q= search) / read /
// rename / pin / delete. Reading never touches credits (the same promise as
// saved answers); a follow-up question inside a thread charges like any new Ask.
app.get('/api/ask/threads', authMiddleware, async (req, res) => {
    try {
        const uid = new mongoose.Types.ObjectId(req.userId);
        const q = String((req.query && req.query.q) || '').trim().slice(0, 120);
        // 🔍 searches titles AND chat text. $text over the compound index, with
        // a case-insensitive regex fallback while the index builds on a fresh deploy.
        const matchStage = { userId: uid };
        if (q) {
            try {
                const textHit = await AskThread.findOne(
                    { $text: { $search: q }, userId: uid },
                    { projection: { _id: 1 } }
                ).lean();
                if (textHit) matchStage.$text = { $search: q };
                else matchStage.$or = [
                    { title: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
                    { 'messages.content': new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
                ];
            } catch (_) {
                matchStage.$or = [
                    { title: new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') },
                    { 'messages.content': new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }
                ];
            }
        }
        const rows = await AskThread.aggregate([
            { $match: matchStage },
            { $sort: { pinned: -1, updatedAt: -1 } },
            { $limit: ASK_THREAD_KEEP },
            { $project: { title: 1, pinned: 1, mode: 1, createdAt: 1, updatedAt: 1, messageCount: { $size: '$messages' } } }
        ]);
        res.json({
            threads: rows.map((t) => ({
                id: t._id, title: t.title || 'New chat', pinned: !!t.pinned, mode: t.mode,
                messageCount: t.messageCount, updatedAt: t.updatedAt, createdAt: t.createdAt
            }))
        });
    } catch (error) {
        res.status(500).json({ message: 'Unable to load your chats.' });
    }
});

app.get('/api/ask/threads/:id', authMiddleware, async (req, res) => {
    try {
        if (!THREAD_ID_RE.test(String(req.params.id || ''))) return res.status(404).json({ message: 'Thread not found.' });
        const thread = await AskThread.findOne({ _id: req.params.id, userId: req.userId }).lean();
        if (!thread) return res.status(404).json({ message: 'Thread not found.' });
        res.json({
            thread: {
                id: thread._id, title: thread.title || 'New chat', pinned: !!thread.pinned, mode: thread.mode,
                messages: (thread.messages || []).map((m) => ({ role: m.role, content: m.content, toolsUsed: m.toolsUsed || [], at: m.at })),
                createdAt: thread.createdAt, updatedAt: thread.updatedAt
            }
        });
    } catch (error) {
        res.status(500).json({ message: 'Unable to load that chat.' });
    }
});

// Rename and/or 📌 pin/unpin — both are metadata-only, owner-scoped, free.
app.patch('/api/ask/threads/:id', authMiddleware, async (req, res) => {
    try {
        if (!THREAD_ID_RE.test(String(req.params.id || ''))) return res.status(404).json({ message: 'Thread not found.' });
        const body = req.body || {};
        const patch = {};
        if (Object.prototype.hasOwnProperty.call(body, 'title')) {
            const title = String(body.title || '').trim().slice(0, 160);
            if (!title) return res.status(400).json({ message: 'Give the chat a name.' });
            patch.title = title;
        }
        if (Object.prototype.hasOwnProperty.call(body, 'pinned')) patch.pinned = !!body.pinned;
        if (!Object.keys(patch).length) return res.status(400).json({ message: 'Nothing to update.' });
        const thread = await AskThread.findOneAndUpdate(
            { _id: req.params.id, userId: req.userId },
            { $set: patch },
            { new: true, projection: { _id: 1, title: 1, pinned: 1 } }
        );
        if (!thread) return res.status(404).json({ message: 'Thread not found.' });
        res.json({ thread: { id: thread._id, title: thread.title, pinned: !!thread.pinned } });
    } catch (error) {
        res.status(500).json({ message: 'Unable to update that chat.' });
    }
});

app.delete('/api/ask/threads/:id', authMiddleware, async (req, res) => {
    try {
        if (!THREAD_ID_RE.test(String(req.params.id || ''))) return res.status(404).json({ message: 'Thread not found.' });
        const out = await AskThread.deleteOne({ _id: req.params.id, userId: req.userId });
        if (!out.deletedCount) return res.status(404).json({ message: 'Thread not found.' });
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ message: 'Unable to delete that chat.' });
    }
});

// Ask personal memory — ChatGPT-style saved memories. All owner-scoped and
// free; every key of the store is the user's own document, so no cross-user
// leak is possible by construction. The toggle only gates the assistant's
// writes/reads in the chat loop — the Profile UI manages the list regardless.
app.get('/api/ask/memory', authMiddleware, async (req, res) => {
    try {
        const facts = await pm.readFacts(req.userId);
        res.json({
            enabled: !!(req.user && req.user.askMemoryEnabled),
            facts: facts.map((f) => ({ id: f.id, fact: f.fact, at: f.at }))
        });
    } catch (error) {
        res.status(500).json({ message: 'Unable to load memory.' });
    }
});

app.put('/api/ask/memory/consent', authMiddleware, async (req, res) => {
    try {
        const enabled = !!(req.body && req.body.enabled);
        await User.updateOne({ _id: req.userId }, { $set: { askMemoryEnabled: enabled } });
        res.json({ enabled });
    } catch (error) {
        res.status(500).json({ message: 'Unable to update the memory setting.' });
    }
});

app.post('/api/ask/memory', authMiddleware, async (req, res) => {
    try {
        const out = await pm.addFact(req.userId, (req.body && req.body.fact) || (req.body && req.body.content) || '');
        if (!out.ok) return res.status(400).json({ message: out.note });
        const facts = await pm.readFacts(req.userId);
        res.json({
            saved: out.saved || null,
            facts: facts.map((f) => ({ id: f.id, fact: f.fact, at: f.at }))
        });
    } catch (error) {
        res.status(500).json({ message: 'Unable to save that memory.' });
    }
});

// Import — Profile → Settings pastes/uploads selected facts distilled from
// another provider's export (ChatGPT, Claude, Grok). Batch, deduped, capped.
app.post('/api/ask/memory/import', authMiddleware, async (req, res) => {
    try {
        const out = await pm.importFacts(req.userId, req.body && req.body.facts);
        if (!out.ok) return res.status(400).json({ message: out.note });
        const facts = await pm.readFacts(req.userId);
        res.json({ imported: out.imported, dropped: out.dropped || 0, facts: facts.map((f) => ({ id: f.id, fact: f.fact, at: f.at })) });
    } catch (error) {
        res.status(500).json({ message: 'Unable to import those facts.' });
    }
});

// Import step 1 — distill durable facts from a digest of the user's own data
// export (ChatGPT/Claude/Grok). Cheap one-shot prose call, no tools; the user
// previews and ticks before anything is stored (POST /import does that).
app.post('/api/ask/memory/extract', authMiddleware, async (req, res) => {
    try {
        const digest = String((req.body && req.body.digest) || '').slice(0, 50000);
        if (!digest.trim()) return res.status(400).json({ message: 'No export text to read.' });
        const aiClient = require('./ai-client');
        if (!aiClient.isConfigured()) return res.status(503).json({ message: 'Extraction is not available right now.' });
        const text = await aiClient.chat([
            {
                role: 'user',
                content: 'The following is text the user extracted from their own data export from another AI assistant (ChatGPT, Claude or Grok). Extract up to 20 DURABLE FACTS ABOUT THE USER THEMSELF as those conversations reveal them: investing goals, holdings, time horizons, risk preferences, constraints, life milestones relevant to finances. Only durable, stable facts — not opinions about stocks, not conversation mechanics, not anything that looks like a credential, address, phone number, account number or email. Each fact: one concise sentence under 120 characters, phrased as remembered about the user (e.g. "Plans to add REITs next year"). Ignore chat questions unless they reveal something personal and lasting. Reply with ONLY a JSON object: {"facts":["…","…"]} — empty array if nothing qualifies.\n\nEXPORT:\n' + digest
            }
        ], { purpose: 'summary', maxTokens: 900, temperature: 0.1 });
        let facts = [];
        const m = text.match(/\{[\s\S]*\}/);
        if (m) {
            try { facts = (JSON.parse(m[0]).facts) || []; } catch (_) { /* fall through to [] */ }
        }
        if (!Array.isArray(facts)) facts = [];
        res.json({
            facts: facts
                .map((f) => String(f || '').replace(/\s+/g, ' ').trim().slice(0, 300))
                .filter((f) => f.length >= 8 && f.length <= 300)
                .slice(0, 25)
        });
    } catch (error) {
        res.status(500).json({ message: 'Extraction failed — try again.' });
    }
});

// Delete one fact — by the fact id the list API handed out, or its text.
app.delete('/api/ask/memory/:id', authMiddleware, async (req, res) => {
    try {
        const key = String(req.params.id || '');
        const removed = await pm.removeFact(req.userId, key);
        if (!removed) return res.status(404).json({ message: 'Memory not found.' });
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ message: 'Unable to delete that memory.' });
    }
});

// Bulk clear ("🧹 Clear all" in Profile → Settings).
app.delete('/api/ask/memory', authMiddleware, async (req, res) => {
    try {
        await pm.clearFacts(req.userId);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ message: 'Unable to clear memory.' });
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

// RFC 8058 one-click unsubscribe. Mail clients POST to the List-Unsubscribe=One-Click
// URL with no session and no confirmation step, so this must succeed on the
// token alone — never behind a login, never behind a "click here to confirm"
// page. Same signed token as the GET link; it carries the user, so nothing is
// read from the request body.
app.post('/api/digest/unsubscribe', express.urlencoded({ extended: false }), async (req, res) => {
    try {
        const decoded = jwt.verify(String(req.query.token || ''), JWT_SECRET);
        if (decoded.p !== 'digest') throw new Error('wrong token purpose');
        await User.updateOne({ _id: decoded.userId }, { $set: { digestOptOut: true } });
        res.status(200).type('text/plain').send('Unsubscribed');
    } catch (_) {
        res.status(400).type('text/plain').send('Invalid unsubscribe token');
    }
});

// Headers every digest must carry so the one-click path actually works.
function digestUnsubHeaders(userId) {
    const appUrl = (process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro').replace(/\/$/, '');
    const url = `${appUrl}/api/digest/unsubscribe?token=${digestUnsubToken(userId)}`;
    return {
        url,
        headers: {
            'List-Unsubscribe': `<${url}>, <mailto:${mailer.SUPPORT_EMAIL}?subject=unsubscribe>`,
            'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click'
        }
    };
}

async function runDigestSweep() {
    if (mongoose.connection.readyState !== 1) return { skipped: 'no db' };
    if (!mailer.isMailerConfigured()) return { skipped: 'no smtp' };
    const appUrl = (process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro').replace(/\/$/, '');
    const ACTIVE = ['active', 'trialing', 'cancel_at_period_end'];
    const dueBefore = new Date(Date.now() - 6.5 * 86400000); // per-user ~weekly cadence
    // Lifetime buyers (AppSumo/DealMirror) get the digest too — their Monitor
    // entitlement is capped per tier (lib/tier-limits.js), and the digest is
    // the retention half of that entitlement. appsumoEmailsOptOut is honoured
    // for them; it is false-by-default for everyone else, so a single filter
    // covers both channels.
    const users = await User.find({
        digestOptOut: { $ne: true },
        appsumoEmailsOptOut: { $ne: true },
        $or: [{ lastDigestAt: null }, { lastDigestAt: { $lt: dueBefore } }],
        $and: [{
            $or: [
                { 'subscription.planId': { $in: ['power', 'power-monthly', 'desk', 'enterprise'] }, 'subscription.status': { $in: ACTIVE } },
                { appsumoRedeemedAt: { $ne: null } },
                { dealMirrorRedeemedAt: { $ne: null } }
            ]
        }]
    }).limit(200);
    let sent = 0;
    for (const u of users) {
        try {
            const [holdings, wl] = await Promise.all([
                Stock.find({ user: u._id, assetType: { $nin: ['etf', 'mutual_fund', 'crypto'] } }, { symbol: 1 }).lean(),
                Watchlist.findOne({ user: u._id }, { symbols: 1 }).lean()
            ]);
            // Dedupe across holdings+watchlist, then trim to what this account
            // is entitled to watch — collectItems BUILDS missing reports (a
            // real token cost), so an uncapped lifetime watchlist here would
            // silently mint spend. capSymbols is a no-op for non-LTD plans.
            const symbols = tierLimits.capSymbols(u, [...new Set([...holdings.map((h) => h.symbol), ...((wl && wl.symbols) || [])])]);
            if (symbols.length) {
                const unsub = digestUnsubHeaders(u._id);
                const digest = await monitorDigest.buildUserDigest(u, { appUrl, unsubUrl: unsub.url, symbols });
                if (digest && await mailer.sendMail({ to: u.email, subject: digest.subject, html: digest.html, text: digest.text, headers: unsub.headers })) sent++;
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

// The scheduled-email queue (AppSumo onboarding, review asks, inactivity nudges)
// had no runner at all: rows were written by the redemption path and read by
// nothing, so 12 jobs sat `scheduled` for up to three weeks while every buyer
// went un-onboarded and unasked for a review. scripts/run-scheduled-emails.js
// was complete the whole time — it simply was never invoked.
//
// It is spawned as a CHILD PROCESS on purpose. The script owns its mongoose
// lifecycle and calls mongoose.disconnect() when it finishes; require()ing it
// here would tear down the connection this server is using to serve requests.
// A separate process gets its own connection and takes the teardown with it.
function startScheduledEmails() {
    if (String(process.env.SCHEDULED_EMAILS || '1') === '0') { console.log('[sched-email] disabled via SCHEDULED_EMAILS=0'); return; }
    const { execFile } = require('node:child_process');
    const script = path.join(__dirname, '../scripts/run-scheduled-emails.js');
    const run = () => {
        execFile(process.execPath, [script], { timeout: 10 * 60 * 1000 }, (error, stdout, stderr) => {
            if (error) return console.error('[sched-email] run failed:', error.message, String(stderr || '').slice(0, 300));
            console.log('[sched-email]', String(stdout || '').replace(/\s+/g, ' ').trim().slice(0, 300));
        });
    };
    // Staggered past the digest's 120s so a cold boot isn't doing both at once.
    setTimeout(run, 180 * 1000);
    setInterval(run, 24 * 3600 * 1000);
    console.log('[sched-email] scheduled daily');
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

// Legacy scheduling stages remain for onboarding compatibility. A review itself
// is a one-time, usage-gated request; never use these stages for repeat asks.
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
        reviewRequestSentAt: null,
        reviewRequestClaimedAt: null,
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
            // The scheduled-email worker has its own stage-2 review ask
            // (appsumo-review-5d:<id>). If that job has already queued or sent,
            // this sweep must not send its own stage-2 copy — the two paths
            // produce the SAME email, and only the user-level claim below (not
            // a shared queue) dedupes them once the sweep moves past stage 1.
            if (nextStage >= 2) {
                const reviewJob = await ScheduledEmail.findOne({ emailKey: `appsumo-review-5d:${String(u._id)}`, status: { $in: ['scheduled', 'sent'] } }).lean();
                if (reviewJob) continue;
            }
            // Stage 1 is onboarding. A review is usage-based only: no rating,
            // feedback verdict, or sentiment ever affects eligibility.
            const hasAskUse = nextStage >= 2 ? await aiChat.hasEverUsed(u._id) : false;
            if (!shareCopy.shouldSendAppSumoReviewStage(nextStage, hasAskUse ? 1 : 0)) continue;
            // Atomically reserve this customer before sending. Both production
            // workers use the same persisted sent/claim fields, so a retry or a
            // second process cannot generate another review request.
            const claimedAt = new Date();
            const claimed = await User.findOneAndUpdate(
                { _id: u._id, reviewRequestSentAt: null, reviewRequestClaimedAt: null },
                { $set: { reviewRequestClaimedAt: claimedAt } },
                { new: true }
            );
            if (!claimed) continue;
            const unsubUrl = `${appUrl}/api/appsumo/unsubscribe?token=${appsumoUnsubToken(u._id)}`;
            const mail = mailer.appsumoReviewEmail(claimed.name, appUrl, nextStage, reviewUrl, unsubUrl);
            if (await mailer.sendMail({ to: claimed.email, subject: mail.subject, html: mail.html, text: mail.text })) {
                // Unconditional (we hold the claim): a guarded success write
                // that loses its race leaves the email sent with the claim
                // still standing — the user is then stranded (never asked
                // again) or, after a manual claim reset, asked a second time.
                // If the claim was somehow lost, stage 3 + sentAt is the safe
                // direction: it suppresses, never enables, another ask.
                const sentAt = new Date();
                await User.updateOne(
                    { _id: claimed._id },
                    { $set: { appsumoReviewStage: 3, reviewRequestSentAt: sentAt }, $unset: { reviewRequestClaimedAt: '' } }
                ).catch(() => {});
                if (nextStage >= 2) {
                    trackFunnel('review_request_sent', claimed._id, claimed.subscription && claimed.subscription.planName, {
                        eventName: 'review_request_sent',
                        dedupeKey: `review-request-sent:${String(claimed._id)}`,
                        entitlementSource: 'appsumo', appsumoTier: Number(claimed.appsumoTier) || null
                    });
                }
                sent++;
            } else {
                await User.updateOne({ _id: claimed._id, reviewRequestClaimedAt: claimedAt, reviewRequestSentAt: null }, { $unset: { reviewRequestClaimedAt: '' } });
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
            projection: { event: 1, toolId: 1, contentId: 1, userId: 1, path: 1, anonymousSessionId: 1, acquisitionSource: 1, trafficSource: 1, referrer: 1, country: 1, userAgent: 1 }
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
    const countryMap = new Map();
    const countrySeen = new Set();
    // Historic events were classified before dev/self-referrers (localhost,
    // 127.0.0.1, the raw onrender.com host) were folded into 'internal', so
    // re-derive from the stored referrer rather than trusting old trafficSource.
    const INTERNAL_REFERRER_HOSTS = new Set(['prod-gpln.onrender.com', 'localhost', '127.0.0.1']);
    // GA4 buckets any request that arrived with zero Referer header as
    // "(direct)/(none)", with no way to see what's actually inside from the GA
    // UI. Every one of those page views still passed through here with its raw
    // user agent intact, so break the bucket open by UA + landing page instead
    // of leaving it opaque.
    const directUaMap = new Map();
    trafficEvents.forEach((event) => {
        const referralHost = event.trafficSource === 'referral' ? marketingAttribution.referrerHostname(event.referrer) : null;
        // 'referral' collapses every unrecognized referrer (directories, AI
        // assistants, social sites without a dedicated bucket) into one opaque
        // row. Break those out by actual hostname so they're identifiable.
        const source = String(event.acquisitionSource
            || (referralHost && INTERNAL_REFERRER_HOSTS.has(referralHost) ? 'internal' : referralHost)
            || event.trafficSource
            || 'direct');
        if (!trafficMap.has(source)) trafficMap.set(source, { source, sessions: 0, pageViews: 0, toolCompletions: 0, appsumoClicks: 0 });
        const row = trafficMap.get(source);
        if (event.event === 'page_view') row.pageViews++;
        if (source === 'direct' && event.event === 'page_view') {
            const ua = String(event.userAgent || '(no user agent)').slice(0, 140);
            const path = String(event.path || '/');
            const key = `${ua}::${path}`;
            if (!directUaMap.has(key)) directUaMap.set(key, { userAgent: ua, path, count: 0 });
            directUaMap.get(key).count++;
        }
        if (event.event === 'free_tool_complete') row.toolCompletions++;
        if (event.event === 'appsumo_outbound') row.appsumoClicks++;
        const sessionKey = `${source}:${event.anonymousSessionId || ''}`;
        if (event.anonymousSessionId && !trafficSeen.has(sessionKey)) {
            trafficSeen.add(sessionKey);
            row.sessions++;
        }
        if (event.anonymousSessionId) uniqueReportableSessions.add(event.anonymousSessionId);
        const country = String(event.country || 'unknown');
        if (!countryMap.has(country)) countryMap.set(country, { country, sessions: 0, pageViews: 0 });
        const countryRow = countryMap.get(country);
        if (event.event === 'page_view') countryRow.pageViews++;
        const countryKey = `${country}:${event.anonymousSessionId || ''}`;
        if (event.anonymousSessionId && !countrySeen.has(countryKey)) {
            countrySeen.add(countryKey);
            countryRow.sessions++;
        }
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
        directBreakdownRows: [...directUaMap.values()].sort((a, b) => b.count - a.count).slice(0, 25),
        countryRows: [...countryMap.values()].sort((a, b) => b.sessions - a.sessions || a.country.localeCompare(b.country)),
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
        const directBreakdownRows = data.directBreakdownRows.length ? data.directBreakdownRows.map((row) => `<tr><td>${e(row.userAgent)}</td><td>${e(row.path)}</td><td>${n(row.count)}</td></tr>`).join('') : '<tr><td colspan="3">No direct page views recorded yet</td></tr>';
        const countryRows = data.countryRows.length ? data.countryRows.map((row) => `<tr><td>${e(row.country)}</td><td>${n(row.sessions)}</td><td>${n(row.pageViews)}</td></tr>`).join('') : '<tr><td colspan="3">No reportable sessions yet</td></tr>';
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
        const directBreakdownPanel = `<section class="panel" style="margin-top:16px"><h2>Direct traffic breakdown · 30 days</h2><table><tr><th>User agent</th><th>Landing page</th><th>Page views</th></tr>${directBreakdownRows}</table><div class="legend">This is what GA4 flattens into "(direct)/(none)" — no Referer header arrived at all, so this is every signal we still have. Look for repeated landing pages tied to an unfamiliar user agent; that's usually an AI assistant opening a link on a user's behalf rather than someone typing the URL. Known AI-assistant fetch signatures are already excluded from "human" counts elsewhere on this page.</div></section>`;
        const countryPanel = `<section class="panel" style="margin-top:16px"><h2>Traffic by country · all reportable</h2><table><tr><th>Country</th><th>Human sessions</th><th>Page views</th></tr>${countryRows}</table><div class="legend">IP-based GeoIP lookup (no external calls); "unknown" covers local/reserved IPs and lookup misses. Independent of GA4, which is blocked in mainland China without a VPN.</div></section>`;
        const auditPanel = `<section class="panel" style="margin-top:16px"><h2>Measurement audit · 30 days</h2><table><tr><th>Raw page views</th><th>Reportable page views</th><th>QA events excluded</th><th>Bot/automation events excluded</th><th>Unclassified events excluded</th></tr><tr><td>${n(data.rawLast30.page_view)}</td><td>${n(w.page_view)}</td><td>${n(data.excluded30.qa)}</td><td>${n(data.excluded30.bot)}</td><td>${n(data.excluded30.unclassified)}</td></tr></table><div class="legend">AppSumo webhook/license collection last changed: ${e(data.appsumoSync.lastEventAt ? new Date(data.appsumoSync.lastEventAt).toISOString() : 'no event recorded')}. The AppSumo Partner Portal remains definitive for purchases that have not reached the webhook.</div></section>`;
        const renderedHtml = html.replace('<section class="panel" style="margin-top:16px"><h2>Activation jobs</h2>', `${trafficPanel}${directBreakdownPanel}${countryPanel}${toolPanel}${researchPanel}${auditPanel}<section class="panel" style="margin-top:16px"><h2>Activation jobs</h2>`);
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
    const chinaExpiry = await expireChinaAnnualPasses();
    if (!mailer.isMailerConfigured()) return { expired: expiry.modifiedCount, chinaExpired: chinaExpiry.modifiedCount, skipped: 'no smtp' };
    if (String(process.env.TRIAL_LIFECYCLE_EMAILS || '1') === '0') return { expired: expiry.modifiedCount, chinaExpired: chinaExpiry.modifiedCount, skipped: 'disabled' };
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
    return { eligible: users.length, sent, expired: expiry.modifiedCount, chinaExpired: chinaExpiry.modifiedCount };
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
        // Monitor pre-grants: queue the expiry email and revoke lapsed grants.
        // Queue only — it never sends, so it is safe on the same daily tick.
        trialExpiryCheck.runTrialExpiryCheck()
            .then((r) => console.log('[trial-grant] expiry check', JSON.stringify(r)))
            .catch((e) => console.warn('[trial-grant] expiry check failed:', e.message));
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

async function hasVerifiedAffiliatePurchase(user) {
    if (!user) return false;
    if (affiliateProgram.hasVerifiedStripeSubscription(user)) return true;
    if (!user.appsumoRedeemedAt) return false;
    return Boolean(await AppSumoLicense.exists({ userId: user._id, status: 'active' }));
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
        const profile = await AffiliateProfile.findOne({
            slug,
            status: 'active',
            invitedAt: { $ne: null },
            termsAcceptedAt: { $ne: null }
        }).lean();
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
        const target = destination === 'appsumo' ? affiliateProgram.appSumoUrl()
            : destination === 'lifetime' ? '/lifetime'
            : destination === 'pricing' ? '/#pricing' : '/';
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
    const totalsByCurrency = affiliateProgram.summarizeCommissionsByCurrency(commissions);
    const totals = affiliateProgram.combineCommissionCurrencyTotals(totalsByCurrency);
    const commissionLedger = commissions.map((commission) => ({
        provider: commission.provider,
        currency: commission.currency,
        basisMinor: commission.basisMinor,
        rateBps: commission.rateBps,
        amountMinor: commission.amountMinor,
        reversalMinor: commission.reversalMinor,
        holdUntil: commission.holdUntil,
        status: commission.status,
        reason: commission.reason || null,
        createdAt: commission.createdAt
    }));
    res.set('Cache-Control', 'no-store').json({ eligible: true, profile: affiliateProgram.publicProfile(profile, process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro'), clicks: await affiliateProgram.models().ReferralClick.countDocuments({ affiliateProfileId: profile._id }), purchases: orders.filter((o) => ['paid', 'pending_reconciliation'].includes(o.status)).length, totals, totalsByCurrency, commissions: commissionLedger, orders: orders.map((o) => ({ provider: o.provider, status: o.status, planId: o.planId, currency: o.currency, purchasedAt: o.purchasedAt })), disclosure: profile.disclosure });
});

app.post('/api/affiliate/accept', authMiddleware, affiliateMutationLimiter, async (req, res) => {
    if (!affiliateFeatureEnabled(res)) return;
    if (req.body?.acceptTerms !== true) return res.status(400).json({ message: 'You must accept the ambassador terms before activating the link.' });
    // The original server-rendered Release-1 page posts only acceptTerms. A
    // genuinely invited, verified customer using that same-origin page may be
    // recorded against the first versioned terms without breaking the dark
    // pilot. Any explicit/stale version still fails closed.
    const acceptedTermsVersion = req.body?.termsVersion == null
        ? affiliateProgram.CURRENT_TERMS_VERSION
        : String(req.body.termsVersion);
    if (acceptedTermsVersion !== affiliateProgram.CURRENT_TERMS_VERSION) {
        return res.status(409).json({ message: 'The ambassador terms have changed. Review the current version before accepting.', currentTermsVersion: affiliateProgram.CURRENT_TERMS_VERSION });
    }
    const { AffiliateProfile } = affiliateProgram.models();
    const profile = await AffiliateProfile.findOne({ userId: req.userId });
    if (!profile) return res.status(404).json({ message: 'No ambassador invitation is available for this account.' });
    if (profile.status === 'suspended' || profile.status === 'declined') return res.status(409).json({ message: 'This invitation is not active.' });
    const appSumoLicenseActive = Boolean(req.user?.appsumoRedeemedAt)
        && Boolean(await AppSumoLicense.exists({ userId: req.userId, status: 'active' }));
    // Partner profiles are external publishers (deal/review sites) enrolled by an
    // admin. They are never expected to buy, so the customer-purchase gate must not
    // apply to them — same exemption canAcceptAmbassadorInvite() makes below. Without
    // this, every partner 409s here and can never activate their link.
    const verifiedPurchase = String(profile.kind) === 'partner'
        || appSumoLicenseActive
        || affiliateProgram.hasVerifiedStripeSubscription(req.user);
    if (!verifiedPurchase) return res.status(409).json({ message: 'A verified active customer purchase is required before accepting an ambassador invitation.' });
    const legacyActive = profile.status === 'active' && profile.invitedAt && profile.termsAcceptedAt;
    if (!legacyActive && !affiliateProgram.canAcceptAmbassadorInvite({ profile, user: req.user, appSumoLicenseActive })) {
        return res.status(409).json({ message: 'A current administrator invitation is required before this link can be activated.' });
    }
    const wasActive = profile.status === 'active';
    profile.status = 'active'; profile.customerStatus = 'ambassador_active'; profile.termsAcceptedAt = new Date(); profile.activatedAt = profile.activatedAt || new Date(); profile.termsVersion = affiliateProgram.CURRENT_TERMS_VERSION;
    await profile.save();
    await affiliateProgram.writeAudit(wasActive ? 'ambassador_terms_accepted' : 'ambassador_activated', String(req.user?.email || req.userId), { affiliateProfileId: profile._id, termsVersion: affiliateProgram.CURRENT_TERMS_VERSION });
    if (!wasActive) trackFunnel('ambassador_activated', req.userId, req.user?.subscription?.planName, { affiliateProfileId: String(profile._id), termsVersion: affiliateProgram.CURRENT_TERMS_VERSION });
    return res.json({ ok: true, profile: affiliateProgram.publicProfile(profile, process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro') });
});

app.get('/affiliate', authMiddleware, async (req, res) => {
    if (!affiliateProgram.isEnabled()) return res.status(404).send('Referral program is not enabled.');
    if (!affiliateProgram.cookieSecret()) return res.status(503).send('Referral program is temporarily unavailable.');
    const { AffiliateProfile } = affiliateProgram.models();
    const profile = await AffiliateProfile.findOne({ userId: req.userId }).lean();
    if (!profile) return res.status(404).send('No ambassador invitation is available for this account.');
    res.set('Cache-Control', 'private, no-store, max-age=0');
    res.set('X-Robots-Tag', 'noindex, nofollow, noarchive');
    return res.sendFile(path.join(__dirname, 'affiliate-dashboard.html'));
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
            const totalsByCurrency = affiliateProgram.summarizeCommissionsByCurrency(commissions);
            const totals = affiliateProgram.combineCommissionCurrencyTotals(totalsByCurrency);
            return { ...affiliateProgram.publicProfile(profile, process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro'), userId: String(profile.userId), clicks, purchases: orders.filter((o) => ['paid', 'pending_reconciliation'].includes(o.status)).length, grossReferredRevenueMinor: orders.reduce((n, o) => n + Math.max(0, Number(o.grossCollectedMinor || 0)), 0), refundsMinor: orders.reduce((n, o) => n + Math.max(0, Number(o.refundedMinor || 0)), 0), totalsByCurrency, ...totals };
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
    // Partner enrollment (external deal/review publishers) is a deliberate,
    // explicit admin act. Partners are not customers and are never expected to
    // buy, so the customer-purchase gate cannot apply to them. It still guards
    // the default ambassador path, which is unchanged.
    const partner = req.body?.partner === true;
    if (!partner) {
        const paid = await hasVerifiedAffiliatePurchase(user);
        if (!paid) return res.status(409).json({ message: 'Only verified paying customers can be invited.' });
    }
    const { AffiliateProfile } = affiliateProgram.models();
    let profile = await AffiliateProfile.findOne({ userId: user._id });
    if (profile && !partner && profile.customerStatus !== 'successful_user') return res.status(409).json({ message: 'Mark this customer as successful_user after onboarding before inviting them.' });
    if (profile && partner && profile.kind !== 'partner') return res.status(409).json({ message: 'This account already has a customer ambassador profile.' });
    if (!profile) profile = await AffiliateProfile.create({ userId: user._id, slug: await uniqueAffiliateSlug(), customerStatus: 'successful_user', kind: partner ? 'partner' : 'ambassador' });
    profile.status = 'invited'; profile.customerStatus = 'ambassador_invited'; profile.invitedAt = new Date(); await profile.save();
    await affiliateProgram.writeAudit(partner ? 'partner_invited' : 'ambassador_invited', String(req.headers['x-admin-actor'] || 'admin'), { affiliateProfileId: profile._id, targetId: String(user._id), kind: profile.kind });
    trackFunnel('ambassador_invited', user._id, user.subscription?.planName, { affiliateProfileId: String(profile._id) });
    try {
        if (applyPayoutDetails(profile, req.body)) await profile.save();
    } catch (error) {
        if (error instanceof PayoutDetailError) return res.status(400).json({ message: error.message });
        throw error;
    }
    return res.json({ ok: true, sentEmail: false, profile: affiliateProgram.publicProfile(profile, process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro') });
});

// Where a partner actually gets paid. Payouts are manual, so without this the
// destination lived only in free-text notes; a batch CSV that names the amount
// but not the account is not a worksheet you can act on.
function applyPayoutDetails(profile, body) {
    let changed = false;
    if (body?.payoutMethod !== undefined) {
        const method = body.payoutMethod === null || body.payoutMethod === '' ? null : String(body.payoutMethod).trim().toLowerCase();
        if (method !== null && !affiliateProgram.PAYOUT_METHOD_VALUES.includes(method)) throw new PayoutDetailError(`payoutMethod must be one of: ${affiliateProgram.PAYOUT_METHOD_VALUES.join(', ')}`);
        profile.payoutMethod = method; changed = true;
    }
    if (body?.payoutHandle !== undefined) {
        const handle = body.payoutHandle === null || body.payoutHandle === '' ? null : String(body.payoutHandle).trim().slice(0, 200);
        // Not a place for raw bank numbers: an account email or invoice
        // reference is enough to send a manual payment against.
        if (handle && /\d{9,}/.test(handle.replace(/[\s-]/g, ''))) throw new PayoutDetailError('payoutHandle looks like a raw account number; store an account email or reference instead.');
        profile.payoutHandle = handle; changed = true;
    }
    if (body?.payoutCurrency !== undefined) {
        const currency = body.payoutCurrency === null || body.payoutCurrency === '' ? null : String(body.payoutCurrency).trim().toLowerCase();
        if (currency !== null && !/^[a-z]{3}$/.test(currency)) throw new PayoutDetailError('payoutCurrency must be a 3-letter code.');
        profile.payoutCurrency = currency; changed = true;
    }
    return changed;
}

class PayoutDetailError extends Error {}

app.post('/api/admin/affiliates/:id/payout-method', affiliateAdminAuth, affiliateMutationLimiter, async (req, res) => {
    const { AffiliateProfile } = affiliateProgram.models();
    const profile = await AffiliateProfile.findById(req.params.id);
    if (!profile) return res.status(404).json({ message: 'Ambassador not found.' });
    try {
        if (applyPayoutDetails(profile, req.body)) await profile.save();
    } catch (error) {
        if (error instanceof PayoutDetailError) return res.status(400).json({ message: error.message });
        throw error;
    }
    await affiliateProgram.writeAudit('payout_method_set', String(req.headers['x-admin-actor'] || 'admin'), { affiliateProfileId: profile._id, details: { payoutMethod: profile.payoutMethod } });
    res.json({ ok: true, profile: affiliateProgram.publicProfile(profile, process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro') });
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
    if (!/^[a-z]{3}$/.test(currency)) return res.status(400).json({ message: 'Provide a valid three-letter currency code.' });
    const min = Math.max(
        affiliateProgram.ABSOLUTE_PAYOUT_MINIMUM_MINOR,
        Number(req.body?.minAmountMinor) || affiliateProgram.DEFAULT_PAYOUT_MINIMUM_MINOR
    );
    const commissions = await Commission.find({ currency, status: 'approved', holdUntil: { $lte: new Date() }, payoutBatchId: null }).sort({ createdAt: 1 }).lean();
    const selection = affiliateProgram.selectPayoutEligibleCommissions(commissions, min);
    if (!selection.eligibleCommissions.length) return res.status(409).json({ message: 'No individual ambassador meets the minimum payout threshold in this currency.', totalMinor: 0, minimumMinor: selection.minimumMinor, excludedProfiles: selection.excludedProfiles });
    const commissionIds = selection.eligibleCommissions.map((commission) => commission._id);
    const batch = await PayoutBatch.create({ currency, minAmountMinor: selection.minimumMinor, totalMinor: selection.totalMinor, commissionIds, status: 'draft' });
    await Commission.updateMany({ _id: { $in: commissionIds }, status: 'approved', payoutBatchId: null }, { $set: { payoutBatchId: batch._id } });
    await affiliateProgram.writeAudit('payout_batch_created', String(req.headers['x-admin-actor'] || 'admin'), { targetId: String(batch._id), totalMinor: selection.totalMinor, qualifyingProfiles: selection.qualifyingProfiles.length });
    res.status(201).json({ ok: true, batch: { id: String(batch._id), totalMinor: selection.totalMinor, currency, status: batch.status, ambassadorCount: selection.qualifyingProfiles.length, automaticPayout: false } });
});

app.post('/api/admin/affiliates/payout-batches/:id/paid', affiliateAdminAuth, affiliateMutationLimiter, async (req, res) => {
    const { PayoutBatch, Commission } = affiliateProgram.models();
    const batch = await PayoutBatch.findById(req.params.id);
    if (!batch) return res.status(404).json({ message: 'Payout batch not found.' });
    if (batch.status === 'paid') return res.json({ ok: true, alreadyPaid: true });
    if (!['draft', 'exported'].includes(batch.status)) return res.status(409).json({ message: 'Only a draft or exported payout batch can be marked paid.' });
    const reference = String(req.body?.reference || '').trim().slice(0, 160);
    if (!reference) return res.status(400).json({ message: 'Record the external payment reference before marking this batch paid.' });
    batch.status = 'paid'; batch.reference = reference; batch.paidAt = new Date(); await batch.save();
    await Commission.updateMany({ _id: { $in: batch.commissionIds }, status: 'approved' }, { $set: { status: 'paid', paidAt: batch.paidAt } });
    await affiliateProgram.writeAudit('payout_marked_paid', String(req.headers['x-admin-actor'] || 'admin'), { targetId: String(batch._id), reference: batch.reference });
    trackFunnel('payout_completed', null, 'affiliate', { payoutBatchId: String(batch._id) });
    res.json({ ok: true, status: batch.status, automaticPayout: false });
});

app.post('/api/admin/affiliates/payout-batches/:id/cancel', affiliateAdminAuth, affiliateMutationLimiter, async (req, res) => {
    const { PayoutBatch, Commission } = affiliateProgram.models();
    const batch = await PayoutBatch.findById(req.params.id);
    if (!batch) return res.status(404).json({ message: 'Payout batch not found.' });
    if (batch.status === 'cancelled') return res.json({ ok: true, alreadyCancelled: true });
    if (!['draft', 'exported'].includes(batch.status)) return res.status(409).json({ message: 'A paid payout batch cannot be cancelled.' });
    await Commission.updateMany({ _id: { $in: batch.commissionIds }, status: 'approved', payoutBatchId: batch._id }, { $set: { payoutBatchId: null } });
    batch.status = 'cancelled';
    await batch.save();
    await affiliateProgram.writeAudit('payout_batch_cancelled', String(req.headers['x-admin-actor'] || 'admin'), { targetId: String(batch._id) });
    return res.json({ ok: true, status: batch.status, automaticPayout: false });
});

app.get('/api/admin/affiliates/payout-batches/:id.csv', affiliateAdminAuth, async (req, res) => {
    const { PayoutBatch, Commission, AffiliateProfile } = affiliateProgram.models();
    const batch = await PayoutBatch.findById(req.params.id).lean();
    if (!batch) return res.status(404).json({ message: 'Payout batch not found.' });
    const commissions = await Commission.find({ _id: { $in: batch.commissionIds || [] } }).lean();
    const profiles = await AffiliateProfile.find({ _id: { $in: commissions.map((c) => c.affiliateProfileId) } }, { slug: 1, userId: 1, payoutMethod: 1, payoutHandle: 1, payoutCurrency: 1 }).lean();
    const byProfile = new Map(profiles.map((p) => [String(p._id), p]));
    const users = await User.find({ _id: { $in: profiles.map((p) => p.userId) } }, { email: 1 }).lean();
    const byUser = new Map(users.map((u) => [String(u._id), u]));
    const cell = (value) => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
    const lines = [
        ['batch_id', 'affiliate_slug', 'affiliate_email', 'payout_method', 'payout_handle', 'payout_currency', 'profile_id', 'commission_id', 'provider', 'currency', 'amount_minor', 'status'].map(cell).join(',')
    ];
    commissions.forEach((c) => { const p = byProfile.get(String(c.affiliateProfileId)); const u = p && byUser.get(String(p.userId)); lines.push([String(batch._id), p?.slug || '', u?.email || '', p?.payoutMethod || '', p?.payoutHandle || '', p?.payoutCurrency || '', String(c.affiliateProfileId), String(c._id), c.provider, c.currency, Math.max(0, Number(c.amountMinor || 0) - Number(c.reversalMinor || 0)), c.status].map(cell).join(',')); });
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
// Yahoo rate-limits by origin IP, so "did our egress IP change on this deploy?"
// is the first question in any upstream outage — and it was unanswerable during
// the 2026-09-05 incident. Fire-and-forget; never let it affect boot.
(async () => {
    try {
        const r = await fetch('https://api.ipify.org?format=json', { signal: AbortSignal.timeout(5000) });
        console.log(`[egress-ip] ${(await r.json()).ip}`);
    } catch (e) { console.log('[egress-ip] lookup failed:', e && e.message); }
})();
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
// Background jobs touch REAL users' inboxes and Stripe subscriptions (digest
// mail, AppSumo review drip + reconcile, trial lifecycle). A local boot with
// production env must never run them: set DISABLE_BACKGROUND_JOBS=1 and the
// loops don't schedule at all. Never set this on the deployed service.
if (String(process.env.DISABLE_BACKGROUND_JOBS || '') === '1') {
    console.log('[jobs] DISABLE_BACKGROUND_JOBS=1 — digest, appsumo and trial sweeps not scheduled (local boot)');
} else {
    startDigest();
    startScheduledEmails();
    startAppSumoJobs();
    startTrialLifecycleJobs();
    // 🧪 AI Paper Portfolio daily sweep (no-ops unless the beta env is armed).
    aiPaper.start();
}
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
// Warm the filings-grounded peer/industry cache for the tickers the free Ask
// demo uses, so the first landing-page visitor skips the 34-65s cold build.
// Deferred past the health-check critical path; no-op unless the operator
// sets ASK_WARM_TICKERS (comma list, e.g. "NVDA,AMD,INTC,AAPL,TSLA,V,MA").
try {
    const warmList = String(process.env.ASK_WARM_TICKERS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (warmList.length) {
        setTimeout(() => { require('./ai-chat').warmPeerContext(warmList).catch(() => {}); }, 15000);
    }
} catch (e) { console.log('[ask-warm] not started:', e && e.message); }
// Refresh the /filing-changes/:symbol sitemap snapshot once the DB is up.
// Deferred past the health-check critical path; the pages serve fine without
// it, they just would not be listed in the sitemap until the next boot.
try {
    setTimeout(() => {
        refreshFilingDiffSitemapSnapshot()
            .then((n) => {
                if (!n) return;
                console.log(`[filing-changes] sitemap snapshot: ${n} symbols`);
                // The boot warm above already cached a diffs-less /sitemap.xml in
                // ssr-cache's dedicated slot (90-minute TTL), because the snapshot
                // did not exist yet. Re-warm now that it does, or the diffs shard
                // stays invisible to crawlers until that TTL expires.
                try { ssrCache.warmSitemap(ssrCacheMw, () => seoPages.buildSitemap()); } catch (_) {}
            })
            .catch(() => {});
    }, 20000);
} catch (e) { console.log('[filing-changes] snapshot not scheduled:', e && e.message); }
