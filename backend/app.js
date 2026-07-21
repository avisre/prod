const express = require('express');
const path = require('path');
const fs = require('fs');
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
const assetProfile = require('./asset-profile');
const secSource = require('./sec-source');
const aiBriefing = require('./ai-briefing');
const aiFeatures = require('./ai-features');
const aiChat = require('./ai-chat');
const shareCopy = require('./share-copy');
const xray = require('./xray');
const watchdog = require('./watchdog');
const reverseDcf = require('./reverse-dcf');
require('dotenv').config();

// Tier ladder: free < core < pro.
//   free — no card: screener/SEO (public anyway), watchlist (capped), a taste of Ask.
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
        message: 'This feature needs a subscription. Start a free trial to unlock it.',
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

const { sendNewUserEmails } = require('./mailer');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
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
  contentSecurityPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' },
  // helmet's no-referrer default breaks YouTube embeds (error 153);
  // strict-origin-when-cross-origin is the modern browser default.
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));
// gzip the HTML/CSS/JS surfaces (Core Web Vitals / crawl speed). The API is
// excluded so the AI chat's SSE stream is never buffered by the compressor.
app.use(compression({
  filter: (req, res) => {
    if (req.path.startsWith('/api')) return false;
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

function isPrivateIpHost(hostname = '') {
  const host = String(hostname || '').trim().toLowerCase();
  if (!host) return true;
  if (host === 'localhost' || host === '::1') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    if (host.startsWith('10.') || host.startsWith('127.') || host.startsWith('192.168.') || host.startsWith('169.254.')) {
      return true;
    }
    if (host.startsWith('172.')) {
      const second = Number(host.split('.')[1]);
      if (second >= 16 && second <= 31) return true;
    }
  }
  return false;
}

function isSafeNewsImageUrl(value = '') {
  try {
    const parsed = new URL(String(value || ''));
    if (!['http:', 'https:'].includes(parsed.protocol)) return false;
    if (isPrivateIpHost(parsed.hostname)) return false;
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
      return;
    } catch (error) {
      if (String(uri || '').startsWith('mongodb+srv://') && isMongoSrvResolutionError(error)) {
        try {
          const directUri = await expandMongoSrvUri(uri);
          await mongoose.connect(directUri, options);
          console.log(`MongoDB connected via SRV fallback (${redactMongoUri(directUri)})`);
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
    message: String(error?.message || fallbackMessage)
  };
  if (error?.code) payload.code = String(error.code);
  if (error?.field) payload.field = String(error.field);
  if (typeof error?.retryable === 'boolean') payload.retryable = error.retryable;
  return res.status(status).json(payload);
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

function safeUpper(value = '') {
  return String(value || '').trim().toUpperCase();
}

// Class shares are written a dozen ways by humans and data vendors:
// Berkshire B is BRK.B (NYSE/CNBC/Morningstar), BRK-B (Yahoo), BRK/B
// (Bloomberg/Fidelity), sometimes "BRK B". Yahoo — our upstream — only
// resolves the dash form, so the dotted/slashed forms used to return degraded
// data or a 502 blank page. Normalize any separator to '-' so every spelling
// of the same security lands on the same full record. A plain ticker with no
// separator is untouched.
function normalizeTicker(value = '') {
  return safeUpper(value)
    .replace(/[.\/\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
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

// Plans charged today (no no-card trial): the annual commitments bill upfront,
// and the premium desk plans are sold via direct outreach links. Only the
// monthly tiers (monthly Core, monthly Pro) enter the no-card 7-day trial —
// which keeps the register-page copy honest ("billed today" vs "free trial").
const NO_TRIAL_PLAN_IDS = ['annual', 'pro-annual', 'power', 'power-monthly', 'desk', 'enterprise'];

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
// localyze-proxy router (1037). Caches GET + status-200 + text/html|xml +
// no-Set-Cookie only. Deploy clears it; 6h TTL covers the out-of-process
// nightly fundamentals rewrites. Zero new npm deps.
const ssrCache = require('./ssr-cache');
const ssrCacheMw = ssrCache.middleware();
app.use(ssrCacheMw);

app.get('/sitemap.xml', (req, res) => {
    res.set('Content-Type', 'application/xml').send(seoPages.buildSitemap());
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

// [LOCALYZE-PROXY] Isolated add-on: model backend for the Localyze.ai app.
// To fully revert: delete this line AND backend/localyze-proxy.js (nothing else refs it).
app.use(require('./localyze-proxy').router);

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
    activatedAt: { type: Date, default: null },
    renewedAt: { type: Date, default: null },
    lastPaymentAt: { type: Date, default: null }
}, { _id: false });

const UserSchema = new mongoose.Schema({
    name: String,
    email: { type: String, unique: true },
    password: String,
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
    // Password reset via email. Stores only a SHA-256 hash of the emailed token
    // (never the raw token) plus its expiry; both are cleared on a successful
    // reset so the link is single-use. See /api/password/forgot + /reset.
    resetPasswordToken: { type: String, default: null, index: true },
    resetPasswordExpires: { type: Date, default: null }
});

const User = mongoose.model('User', UserSchema);

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

// ---- Funnel event tracking (server-side, no third-party) ----
// Events: page_view | signup | trial_start | paid | cancel
// Stored in the 'funnel_events' Mongo collection with fire-and-forget writes.
async function trackFunnel(event, userId, plan, extra) {
    try {
        await mongoose.connection.collection('funnel_events').insertOne({
            ...(extra || {}),
            event: String(event),
            userId: userId ? String(userId) : null,
            plan: plan ? String(plan) : null,
            at: new Date()
        });
    } catch (_) { /* non-blocking — funnel data loss is acceptable */ }
}

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

function createUserToken(user) {
    return jwt.sign({ userId: user._id }, JWT_SECRET, { expiresIn: '30d' });
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
    const metadata = extraMetadata.metadata || {};
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
    return stripe.checkout.sessions.create({
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
                message: planConfig.planId === ANNUAL_PLAN_ID
                    ? 'Annual plan for long-term investors. Cancel anytime.'
                    : 'Monthly plan, billed today. Cancel anytime before renewal.'
            }
        },
        subscription_data: {
            metadata: {
                userId: user._id.toString(),
                planId: planConfig.planId,
                billingInterval: planConfig.billingInterval
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
        // New social signup: onboarding email + owner notification (fire-and-forget).
        sendNewUserEmails({ name: user.name, email: user.email, plan: profile.provider ? `social (${profile.provider})` : 'social' })
            .catch((e) => console.error('[mailer] new-user email error:', e && e.message));
    }

    return { user, created };
}

// Middleware to authenticate user and enforce subscription
async function authMiddleware(req, res, next) {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) {
        return res.status(401).json({ message: 'Authentication required' });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await User.findById(decoded.userId);
        if (!user) {
            return res.status(401).json({ message: 'User not found' });
        }

        const normalized = ensureSubscriptionShape(user);
        if (user.isModified('subscription')) {
            await user.save().catch(() => {});
        }

        req.userId = user._id;
        req.user = user;
        req.subscription = normalized;
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
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return next();
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const user = await User.findById(decoded.userId);
        if (user) {
            const normalized = ensureSubscriptionShape(user);
            req.user = user;
            req.subscription = normalized;
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
    // Honeypot: the register form ships a visually hidden "website" field that
    // humans never see or fill. A non-empty value is a form bot — swallow the
    // submission (no account, no email, no funnel event) but answer 200 so the
    // bot doesn't learn it was detected and adapt.
    if (String(req.body?.website || '').trim()) {
        return res.status(200).json({ ok: true });
    }
    const selectedPlan = normalizePlanSelection(req.body?.plan);
    const planConfig = getPlanConfig(selectedPlan);
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

    // Only the plans that actually hit Stripe checkout (annual + premium) need
    // Stripe up front. Free and the no-card trial plans (monthly/pro) never
    // touch Stripe at signup, so a Stripe outage must not block them.
    if (!stripe && planConfig.planId !== FREE_PLAN_ID && NO_TRIAL_PLAN_IDS.includes(planConfig.planId)) {
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

        user.subscription = ensureSubscriptionShape(user);
        user.subscription.status = 'pending';
        user.subscription.planId = planConfig.planId;
        user.subscription.planName = planConfig.planName;
        user.subscription.price = planConfig.price;
        user.subscription.currency = planConfig.currency;
        user.subscription.billingInterval = planConfig.billingInterval;
        user.subscription.stripePriceId = planConfig.stripePriceId || null;
        user.subscription.trialStartedAt = new Date();
        user.subscription.trialEndsAt = planConfig.trialDays > 0 ? defaultTrialEndsAt() : null;
        user.subscription.activatedAt = null;
        user.subscription.renewedAt = null;
        user.subscription.lastPaymentAt = null;
        // Free plan: no card, no checkout — the account is live immediately.
        if (planConfig.planId === FREE_PLAN_ID) {
            user.subscription.status = 'active';
            user.subscription.activatedAt = new Date();
            user.subscription.trialEndsAt = null;
        }
        user.markModified('subscription');
        await user.save();

        // New signup: send onboarding email + owner notification (fire-and-forget).
        sendNewUserEmails({ name: displayName, email: normalizedEmail, plan: planConfig.planName })
            .catch((e) => console.error('[mailer] new-user email error:', e && e.message));
        trackFunnel('signup', user._id, planConfig.planName);

        if (planConfig.planId === FREE_PLAN_ID) {
            return res.status(200).json({
                token: createUserToken(user),
                subscription: normalizeSubscription(user.subscription),
                plan: FREE_PLAN_ID
            });
        }

        // Standard plans (monthly/annual/pro): start a no-card 7-day Pro trial
        // and land straight in the app — no Stripe, no card. Only the direct
        // outreach plans (power/desk) still go to paid checkout below.
        if (!NO_TRIAL_PLAN_IDS.includes(planConfig.planId)) {
            startNoCardTrial(user);
            await user.save();
            trackFunnel('trial_start', user._id, 'Pro');
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
            returnContext: {
                flow: 'register',
                next: req.body?.next
            },
            metadata: {
                authFlow: 'register',
                checkoutType: 'email',
                next: sanitizeRelativeAppPath(req.body?.next, 'news.html'),
                billingInterval: planConfig.billingInterval
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
        const profile = await verifySocialIdentity(provider, req.body || {});
        const { user, created } = await findOrCreateSocialUser(profile);
        let normalized = ensureSubscriptionShape(user);

        if (subscriptionIsActive(user.subscription)) {
            return res.status(200).json({
                token: createUserToken(user),
                subscription: normalized,
                created,
                provider
            });
        }

        // Free plan via social sign-in: activate immediately, no checkout.
        if (planConfig.planId === FREE_PLAN_ID) {
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

        // New Google sign-ups on a standard plan get the same no-card 7-day Pro
        // trial as email sign-ups — straight into the app, no checkout. Only
        // brand-new accounts (created) so a returning expired user can't loop
        // the trial; direct outreach plans (power/desk) still go to checkout.
        if (created && !NO_TRIAL_PLAN_IDS.includes(planConfig.planId)) {
            startNoCardTrial(user);
            await user.save();
            trackFunnel('trial_start', user._id, 'Pro');
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

        const session = await createCheckoutSessionForUser(user, {
            req,
            planId: planConfig.planId,
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
                billingInterval: planConfig.billingInterval
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

        // Create JWT
        const token = createUserToken(user);
        res.status(200).json({ token, subscription: normalized });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) {
            return res.status(503).json({ message: 'Database unavailable. Start MongoDB and configure MONGODB_URI.' });
        }
        res.status(500).json({ message: 'Error logging in', error: error.message });
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
        res.status(500).json({ message: 'Unable to cancel the subscription', error: error.message });
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
            tier: req.tier
        });
    } catch (error) {
        console.error('/api/session error:', error);
        res.status(500).json({ message: 'Unable to load session' });
    }
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
        const session = await createCheckoutSessionForUser(req.user, {
            req,
            planId,
            skipTrial: true,
            returnContext: { flow: 'upgrade', next: req.body?.next },
            metadata: {
                authFlow: 'upgrade',
                checkoutType: 'upgrade',
                next: sanitizeRelativeAppPath(req.body?.next, 'dashboard.html')
            }
        });
        if (!session?.url) {
            return res.status(502).json({ message: 'Checkout session could not be created. Please try again.', code: 'CHECKOUT_URL_MISSING' });
        }
        res.json({ url: session.url });
    } catch (error) {
        console.error('/api/checkout error:', error);
        res.status(500).json({ message: 'Unable to start checkout', error: error.message });
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
        res.status(error.status || 500).json({ message: error.message || 'Alpha search failed' });
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
        res.status(error.status || 500).json({ message: error.message || 'Daily series failed' });
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
        res.status(500).json({ message: error.message || 'Market strip failed' });
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
        res.status(error.status || 500).json({ message: error.message || 'Monthly series failed' });
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
        res.json(payload);
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message || 'Fundamentals load failed' });
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
        res.status(error.status || 500).json({ message: error.message || 'Quote load failed' });
    }
});

app.get('/api/alpha/movers', authMiddleware, coreGate, async (req, res) => {
    try {
        const data = await fetchAlphaCached('TOP_GAINERS_LOSERS', {}, ALPHA_CACHE_TTL_MS.quote);
        res.json(data);
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message || 'Movers load failed' });
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
        res.status(error.status || 500).json({ message: error.message || 'News load failed' });
    }
});

app.get('/api/news-image', async (req, res) => {
    const targetUrl = String(req.query.url || '').trim();
    if (!isSafeNewsImageUrl(targetUrl)) {
        return res.status(400).send('Invalid image URL');
    }

    try {
        const response = await axios.get(targetUrl, {
            responseType: 'arraybuffer',
            timeout: NEWS_IMAGE_PROXY_TIMEOUT_MS,
            maxContentLength: NEWS_IMAGE_PROXY_MAX_BYTES,
            maxBodyLength: NEWS_IMAGE_PROXY_MAX_BYTES,
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
    res.json({
        ok: true,
        timestamp: new Date().toISOString(),
        dbConnected,
        dbState: readyState,
        mongoUriConfigured: Boolean(process.env.MONGODB_URI),
        appsumo: {
            apiKeyConfigured: Boolean(APPSUMO_API_KEY),
            oauthConfigured: Boolean(APPSUMO_CLIENT_ID && APPSUMO_CLIENT_SECRET),
            redirectUri: APPSUMO_REDIRECT_URI
        }
    });
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
        res.status(500).json({ message: error.message });
    }
});

// AI weekly portfolio briefing. Numbers are computed deterministically in
// ai-briefing.js; the model only writes prose. Cached per user for 12h so we
// make at most ~2 model calls per user per day.
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
        res.status(500).json({ message: error.message || 'Briefing failed' });
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
            const result = await aiBriefing.generateBriefing(demoHoldings);
            _sampleBriefingCache = { briefing: result.briefing, facts: result.facts, generatedAt: new Date().toISOString(), sample: true };
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
        res.status(500).json({ message: error.message || 'AI summary failed' });
    }
});

// Rewrite an existing generated answer/article for a platform's practical
// character limit. This edits presentation only and never changes the research.
app.post('/api/ai/share-copy', async (req, res) => {
    const platform = String((req.body && req.body.platform) || '').toLowerCase();
    const title = String((req.body && req.body.title) || '').trim().slice(0, 500);
    const content = String((req.body && req.body.content) || '').trim().slice(0, 20000);
    if (!content) return res.status(400).json({ message: 'Share content is required.' });
    try {
        return res.json(await shareCopy.rewriteForPlatform({ platform, title, content }));
    } catch (error) {
        return res.status(error.status || 500).json({ message: error.message || 'Could not prepare share copy.' });
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
        res.status(500).json({ message: error.message || 'Question failed' });
    }
});

// ----- Ask: the tool-grounded financial chatbot (metered, not Pro-gated) -----
// Free users get a monthly taste (AI_CHAT_FREE_LIMIT, default 5); Pro gets
// AI_CHAT_PRO_LIMIT (default 300). Quota is only consumed on a real answer.
// ----- Anonymous Ask teaser: a couple of free, abuse-bounded queries so a
// cold visitor can feel the filing-grounded answer before the signup wall.
// Everything off-switchable: ANON_ASK_LIMIT=0 restores signup-required Ask.
const ANON_ASK_LIMIT = Number(process.env.ANON_ASK_LIMIT ?? 3);        // free queries per browser
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
    const raw = req.headers.authorization?.split(' ')[1];
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
                send('error', { message: error.message || 'Ask failed' });
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
        if (!res.headersSent) res.status(500).json({ message: error.message || 'Ask failed' });
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
                const usedNow = counted ? used + 1 : used;
                send('done', {
                    answer: result.answer, toolsUsed: result.toolsUsed, source: result.source,
                    quota: { used: usedNow, limit, remaining: Math.max(0, limit - usedNow) }
                });
            } catch (error) {
                send('error', { message: error.message || 'Ask failed' });
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
        const usedNow = counted ? used + 1 : used;
        res.json({
            answer: result.answer, toolsUsed: result.toolsUsed, source: result.source,
            quota: { used: usedNow, limit, remaining: Math.max(0, limit - usedNow) }
        });
    } catch (error) {
        if (!res.headersSent) res.status(500).json({ message: error.message || 'Ask failed' });
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
        res.status(500).json({ message: error.message || 'X-Ray failed' });
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
        res.status(Number(error.status) || 500).json({ message: error.message || 'Import failed' });
    }
});

app.get('/api/tax/accounts', authMiddleware, monitorGate, async (req, res) => {
    try {
        res.json({ accounts: await washSale.listAccounts(portfolioOwnerId(req)) });
    } catch (error) {
        res.status(500).json({ message: error.message || 'Accounts load failed' });
    }
});

app.delete('/api/tax/accounts/:account', authMiddleware, monitorGate, async (req, res) => {
    try {
        await washSale.deleteAccount(portfolioOwnerId(req), decodeURIComponent(req.params.account));
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ message: error.message || 'Delete failed' });
    }
});

app.get('/api/tax/wash-sales', authMiddleware, monitorGate, async (req, res) => {
    try {
        res.json(await washSale.washReport(portfolioOwnerId(req)));
    } catch (error) {
        res.status(500).json({ message: error.message || 'Wash-sale report failed' });
    }
});

app.get('/api/tax/wash-check', authMiddleware, monitorGate, async (req, res) => {
    try {
        res.json(await washSale.preTradeCheck(portfolioOwnerId(req), req.query.symbol));
    } catch (error) {
        res.status(Number(error.status) || 500).json({ message: error.message || 'Check failed' });
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
        res.status(500).json({ message: error.message || 'Attribution failed' });
    }
});

// ----- Alerts (Filing Watchdog + health-check flips, see backend/watchdog.js) -----
app.get('/api/alerts', authMiddleware, async (req, res) => {
    try {
        const result = await watchdog.listAlerts(portfolioOwnerId(req));
        res.json(result);
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).json({ message: 'Database unavailable.' });
        res.status(500).json({ message: error.message || 'Alerts load failed' });
    }
});

app.post('/api/alerts/seen', authMiddleware, async (req, res) => {
    try {
        await watchdog.markSeen(portfolioOwnerId(req));
        res.json({ ok: true });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).json({ message: 'Database unavailable.' });
        res.status(500).json({ message: error.message || 'Alerts update failed' });
    }
});

// ----- Alert rules: user valuation thresholds (Pro, see backend/smart-alerts.js) -----
const smartAlerts = require('./smart-alerts');
app.get('/api/alert-rules', authMiddleware, proGate, async (req, res) => {
    try {
        res.json({ rules: await smartAlerts.listRules(portfolioOwnerId(req)) });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).json({ message: 'Database unavailable.' });
        res.status(500).json({ message: error.message || 'Rules load failed' });
    }
});

app.post('/api/alert-rules', authMiddleware, proGate, async (req, res) => {
    try {
        const rule = await smartAlerts.createRule(portfolioOwnerId(req), req.body || {});
        res.status(201).json({ rule });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).json({ message: 'Database unavailable.' });
        res.status(Number(error.status) || 500).json({ message: error.message || 'Rule create failed' });
    }
});

app.delete('/api/alert-rules/:id', authMiddleware, proGate, async (req, res) => {
    try {
        await smartAlerts.deleteRule(portfolioOwnerId(req), req.params.id);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ message: error.message || 'Rule delete failed' });
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
        res.status(500).json({ message: error.message || 'Screener failed' });
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
        res.status(500).json({ message: error.message || 'Watchlist load failed' });
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
        res.status(500).json({ message: error.message || 'Watchlist update failed' });
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
        res.status(500).json({ message: error.message || 'Watchlist update failed' });
    }
});

// ----- Company extras (v2 page): SEC filings + ownership, public + cached -----
const _filingsCache = new Map(); // SYM -> { at, payload }
const COMPANY_EXTRA_TTL_MS = 24 * 60 * 60 * 1000;
const DOC_FORMS = new Set(['10-K', '10-K/A', '10-Q', '10-Q/A', '8-K', '8-K/A', '4', 'DEF 14A']);
const DOC_CATEGORY = (form) => {
    if (form.startsWith('10-K')) return 'annual';
    if (form.startsWith('10-Q')) return 'quarterly';
    if (form.startsWith('8-K')) return 'events';
    if (form === '4') return 'insider';
    if (form === 'DEF 14A') return 'proxy';
    return 'other';
};
app.get('/api/company/:symbol/filings', async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!symbol) return res.status(400).json({ message: 'symbol required' });
    try {
        const cached = _filingsCache.get(symbol);
        if (cached && Date.now() - cached.at < COMPANY_EXTRA_TTL_MS) return res.json(cached.payload);
        const filings = await watchdog.fetchFilingsDeep(symbol, DOC_FORMS, {
            '10-K': 7, '10-K/A': 2, '10-Q': 8, '10-Q/A': 2, '8-K': 8, '8-K/A': 2, '4': 10, 'DEF 14A': 5
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
        res.status(500).json({ message: error.message || 'Filings load failed' });
    }
});

// Insider history — the real Form 4 trail (3 years), parsed from EDGAR.
// Public; first request per company kicks off a background build (~1-2 min)
// and the response says so.
const insiders = require('./insiders');
const gurus = require('./gurus');
const filingMonitor = require('./filing-monitor');
const monitorDigest = require('./monitor-digest');
const mailer = require('./mailer');
app.get('/api/company/:symbol/insider-history', async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!symbol) return res.status(400).json({ message: 'symbol required' });
    try {
        const result = await insiders.history(symbol);
        res.json(result);
    } catch (error) {
        res.status(500).json({ message: error.message || 'Insider history failed' });
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
        res.status(500).json({ message: error.message || 'Reverse DCF failed' });
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
        res.status(500).json({ message: error.message || 'Insights failed' });
    }
});

// Key Points — the AI-extracted company dossier from the latest 10-K.
// Public: one extraction per filing, cached forever in Mongo, so the spend
// is bounded the same way the segments cache is.
const keypoints = require('./keypoints');
app.get('/api/company/:symbol/keypoints', async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!symbol) return res.status(400).json({ message: 'symbol required' });
    try {
        const instrument = await assetProfile.fetchAssetProfile(symbol).catch(() => null);
        if (instrument && assetProfile.isFundAsset(instrument.assetType)) {
            return res.status(422).json({
                code: 'ASSET_FEATURE_UNAVAILABLE', assetType: instrument.assetType,
                message: `${instrument.assetTypeLabel}s do not publish company 10-K business dossiers. Use the fund profile or Ask for holdings, costs, allocation, returns and risk.`
            });
        }
        const result = await keypoints.extractKeyPoints(symbol);
        if (result.error) return res.status(404).json({ message: result.error });
        res.json(result);
    } catch (error) {
        res.status(500).json({ message: error.message || 'Key points failed' });
    }
});

const _ownershipCache = new Map(); // SYM -> { at, payload }
app.get('/api/company/:symbol/ownership', async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!symbol) return res.status(400).json({ message: 'symbol required' });
    try {
        const cached = _ownershipCache.get(symbol);
        if (cached && Date.now() - cached.at < COMPANY_EXTRA_TTL_MS) return res.json(cached.payload);
        const data = await yahooSource.fetchOwnership(symbol);
        const payload = { symbol, ...data, source: 'Yahoo Finance (13F-derived)' };
        _ownershipCache.set(symbol, { at: Date.now(), payload });
        if (_ownershipCache.size > 500) _ownershipCache.delete(_ownershipCache.keys().next().value);
        res.json(payload);
    } catch (error) {
        res.status(500).json({ message: error.message || 'Ownership load failed' });
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
        res.status(500).json({ message: error.message || 'Segment extraction failed' });
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
        res.status(500).json({ message: error.message || 'Filing comparison failed' });
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
        res.status(500).json({ message: error.message || 'Quota check failed' });
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
        res.json(newStock);
    } catch (error) {
        if (isDatabaseUnavailableError(error)) {
            return res.status(503).json({ message: 'Database unavailable. Start MongoDB and configure MONGODB_URI.' });
        }
        res.status(500).json({ message: error.message });
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
        res.status(500).json({ message: 'Error deleting stock', error: error.message });
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
        return res.status(400).send(`Webhook error: ${error.message}`);
    }

    const payload = event.data.object;
    if (event.type === 'checkout.session.completed') {
        try {
            const userId = payload.metadata?.userId || payload.client_reference_id;
            if (userId) {
                const user = await User.findById(userId);
                if (user) {
                    const subscription = payload.subscription
                        ? await stripe.subscriptions.retrieve(payload.subscription)
                        : null;
                    if (subscription) {
                        const prevStatus = user.subscription && user.subscription.status;
                        await syncSubscriptionFromStripe(user, subscription, payload.customer);
                        const newStatus = user.subscription && user.subscription.status;
                        // A Stripe-side trial (card-trial flow) lands as 'trialing'
                        // → trial_start; converting later fires 'paid' below. Any
                        // checkout that lands 'active' took money now (annual, the
                        // no-card→paid upgrade via /api/checkout, direct paid) → 'paid'.
                        // The prevStatus !== 'active' guard keeps it single-fire across
                        // the parallel customer.subscription.updated webhook.
                        if (newStatus === 'trialing') trackFunnel('trial_start', user._id, user.subscription.planName);
                        else if (newStatus === 'active' && prevStatus !== 'active') trackFunnel('paid', user._id, user.subscription.planName);
                    } else {
                        await activateSubscription(user, {
                            subscriptionId: payload.subscription,
                            customerId: payload.customer,
                            planId: payload.metadata?.planId,
                            stripeStatus: 'active',
                            stripePriceId: payload.metadata?.stripePriceId || null
                        });
                        trackFunnel('paid', user._id, user.subscription.planName);
                    }
                }
            }
        } catch (err) {
            console.error('Stripe webhook processing error:', err);
        }
    } else if (event.type === 'customer.subscription.updated') {
        try {
            const subscription = payload;
            const user = await User.findOne({ stripeSubscriptionId: subscription.id });
            if (user) {
                const prevStatus = user.subscription && user.subscription.status;
                await syncSubscriptionFromStripe(user, subscription, subscription.customer);
                const newStatus = user.subscription && user.subscription.status;
                // trialing → active = first real payment
                if (prevStatus === 'trialing' && newStatus === 'active') {
                    trackFunnel('paid', user._id, user.subscription.planName);
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
    const cap = req.user && req.user.appsumoAiCap;
    return (Number.isFinite(cap) && cap > 0) ? Math.min(cap, base) : base;
}

async function grantAppSumoProAccess(user, { licenseKey, tier } = {}) {
    const cfg = appsumoTierConfig(tier);
    const now = new Date();
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
    user.appsumoRedeemedAt = user.appsumoRedeemedAt || now;
    user.markModified('subscription');
    await user.save();
    trackFunnel('paid', user._id, cfg.planName, { source: 'appsumo', appsumoLicenseKey: licenseKey || null, appsumoTier: Number(tier) || null });
}

async function revokeAppSumoAccess(user) {
    user.subscription.status = 'cancelled';
    user.subscription.trialEndsAt = null;
    user.appsumoAiCap = null;
    user.markModified('subscription');
    await user.save().catch(() => {});
    trackFunnel('cancel', user._id, 'Pro — AppSumo', { source: 'appsumo' });
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
        await grantAppSumoProAccess(req.user, { licenseKey, tier: lic.tier || tier });
        return res.json({ ok: true, message: 'Your AppSumo lifetime Pro is active.', subscription: normalizeSubscription(req.user.subscription) });
    } catch (err) {
        console.error('AppSumo activate error:', err);
        return res.status(500).json({ message: 'Activation failed. Please try again.' });
    }
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
input{width:100%;padding:11px 12px;border:1px solid #cfd4da;border-radius:10px;font-size:15px}
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
  if (!email || !password) { show('err', 'Enter your email and password.'); return; }
  go.disabled = true; alt.disabled = true; show('', 'Working...');
  try {
    var authUrl = (mode === 'login') ? '/api/login' : '/api/subscribe';
    var authBody = (mode === 'login') ? { email: email, password: password } : { email: email, password: password, plan: 'pro' };
    var ar = await fetch(authUrl, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(authBody) });
    var aj = await ar.json();
    if (!ar.ok || !aj.token) { show('err', (aj && aj.message) || 'Could not sign you in.'); go.disabled=false; alt.disabled=false; return; }
    var rr = await fetch('/api/appsumo/activate', { method:'POST', headers:{'Content-Type':'application/json','Authorization':'Bearer '+aj.token}, body: JSON.stringify({ rt: DATA.rt }) });
    var rj = await rr.json();
    if (!rr.ok) { show('err', (rj && rj.message) || 'Activation failed.'); go.disabled=false; alt.disabled=false; return; }
    try { localStorage.setItem('token', aj.token); } catch(e){}
    document.getElementById('form').style.display = 'none';
    show('ok', '\\u2705 ' + ((rj && rj.message) || 'Pro unlocked.') + ' <a href="/">Go to your dashboard &rarr;</a>');
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
        res.status(error.status || 500).json({ message: error.message || 'Daily series failed' });
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
        res.json(payload);
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message || 'Fundamentals load failed' });
    }
});

app.get('/api/demo/alpha/quote/:symbol', async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!symbol) return res.status(400).json({ message: 'symbol is required' });
    try {
        const data = await fetchAlphaCached('GLOBAL_QUOTE', { symbol }, ALPHA_CACHE_TTL_MS.quote);
        res.json(data);
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message || 'Quote load failed' });
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

// ---- page-view beacon (first-party, no cookies) — the funnel's top step ----
// Crawlers don't run JS so most never reach this; UA filter as belt-and-braces.
app.post('/api/track/page_view', (req, res) => {
    const ua = String(req.headers['user-agent'] || '');
    if (/bot|crawl|spider|slurp|headless|lighthouse|facebookexternalhit|preview/i.test(ua)) return res.status(204).end();
    const viewPath = String((req.body && req.body.path) || '').slice(0, 200);
    trackFunnel('page_view', null, null, { path: viewPath });
    res.status(204).end();
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
    const provided = req.query.token || req.headers['x-admin-token'];
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
    const provided = req.query.token || req.headers['x-admin-token'];
    if (!token || !timingSafeStrEqual(provided, token)) return res.status(403).send('Forbidden');
    try {
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
const MONITOR_FREE_STOCKS = parseInt(process.env.MONITOR_FREE_STOCKS || '3', 10);
const MONITOR_FREE_WINDOW_MS = 24 * 60 * 60 * 1000;
const _monitorFreeSeen = new Map(); // ipKey -> { at:number, syms:Set<string> }

// Per-IP record of which stocks a free visitor has spent today (lazy 24h reset).
function monitorFreeRecord(req) {
    const key = req.ip || 'unknown';
    const now = Date.now();
    let rec = _monitorFreeSeen.get(key);
    if (!rec || now - rec.at > MONITOR_FREE_WINDOW_MS) { rec = { at: now, syms: new Set() }; _monitorFreeSeen.set(key, rec); }
    if (_monitorFreeSeen.size > 50000) { const k = _monitorFreeSeen.keys().next().value; if (k !== key) _monitorFreeSeen.delete(k); }
    return rec;
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
        const instrument = await assetProfile.fetchAssetProfile(sym).catch(() => null);
        if (instrument && assetProfile.isFundAsset(instrument.assetType)) {
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
        const normSym = normalizeTicker(sym); // BRK.B and BRK-B are one stock

        // Poll path: free, build-free, never spends a credit. Returns the report
        // once cached, else {status:'building'} — never kicks a new build.
        if (req.query.poll === '1') {
            if (_monitorInflight.has(sym)) return res.status(202).json({ status: 'building', symbol: sym, stage: _monitorProgress.get(sym) || null });
            const cached = await filingMonitor.peekReport(sym).catch(() => null);
            if (cached) return res.json({ report: cached });
            return res.status(202).json({ status: 'building', symbol: sym, stage: _monitorProgress.get(sym) || null });
        }

        // Free allowance: MONITOR_FREE_STOCKS DISTINCT stocks / IP / day. A stock
        // already on the visitor's list re-runs free; only a brand-new ticker
        // spends a credit, and only once it yields a real report (claimed below).
        const paid = hasMonitor(req);
        let freeRec = null, known = false;
        if (!paid) {
            freeRec = monitorFreeRecord(req);
            known = freeRec.syms.has(normSym);
            res.setHeader('RateLimit-Limit', String(MONITOR_FREE_STOCKS));
            if (!known && freeRec.syms.size >= MONITOR_FREE_STOCKS) {
                res.setHeader('RateLimit-Remaining', '0');
                return res.status(429).json({
                    code: 'TRIAL_EXHAUSTED',
                    message: `That's your ${MONITOR_FREE_STOCKS} free stocks for today. Sign up free to keep exploring, or upgrade to Power for unlimited filing intelligence across your whole watchlist.`,
                    stocks: [...freeRec.syms]
                });
            }
            // counter reflects the state once this stock is claimed
            res.setHeader('RateLimit-Remaining', String(Math.max(0, MONITOR_FREE_STOCKS - (freeRec.syms.size + (known ? 0 : 1)))));
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
        const winner = await Promise.race([build, new Promise((r) => setTimeout(() => r('PENDING'), MONITOR_FAST_MS))]);
        if (winner && winner.error) return res.status(404).json(winner); // typo/invalid → no credit spent
        if (freeRec && !known) freeRec.syms.add(normSym);                  // real report (or building) → claim the stock
        if (winner === 'PENDING') return res.status(202).json({ status: 'building', symbol: sym, stage: _monitorProgress.get(sym) || null });
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
        const out = await compareVerdict.verdictFor(a, b);
        if (!out) return res.status(404).json({ error: 'We could not find filings for both companies.' });
        if (rec && !out.cached) rec.n++; // only a real generation spends a credit; cached reads are free
        if (rec) res.setHeader('RateLimit-Remaining', String(Math.max(0, VERDICT_FREE_PER_DAY - rec.n)));
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

        const force = req.query.refresh === '1';
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
        res.status(500).json({ message: error.message || 'Failed to load theses.' });
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
        res.status(Number(error.status) || 500).json({ message: error.message || 'Failed to save thesis.' });
    }
});

app.delete('/api/thesis/:symbol', authMiddleware, monitorGate, async (req, res) => {
    try {
        await thesisModel.deleteThesis(req.userId, req.params.symbol);
        res.json({ ok: true });
    } catch (error) {
        res.status(500).json({ message: error.message || 'Failed to delete thesis.' });
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
        res.status(500).json({ message: error.message || 'Failed to grade thesis.' });
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
            const unsubUrl = `${appUrl}/api/appsumo/unsubscribe?token=${appsumoUnsubToken(u._id)}`;
            const mail = mailer.appsumoReviewEmail(u.name, appUrl, nextStage, reviewUrl, unsubUrl);
            if (await mailer.sendMail({ to: u.email, subject: mail.subject, html: mail.html, text: mail.text })) {
                u.appsumoReviewStage = nextStage; // bump only on successful send; retries next sweep otherwise
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

// Support tool: look up an AppSumo license by key, or a buyer by email (AppSumo
// never hands us buyer emails, so key lookup is the only way to answer "my key
// won't redeem"). Token-gated with ADMIN_TOKEN, same as /api/admin/comp.
app.get('/api/admin/appsumo/lookup', async (req, res) => {
    const token = process.env.ADMIN_TOKEN;
    const provided = req.query.token || req.headers['x-admin-token'];
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
    if (!mailer.isMailerConfigured()) return { skipped: 'no smtp' };
    if (String(process.env.TRIAL_LIFECYCLE_EMAILS || '1') === '0') return { skipped: 'disabled' };
    const appUrl = (process.env.APP_PUBLIC_URL || 'https://stockportfolio.pro').replace(/\/$/, '');
    const dashUrl = `${appUrl}/dashboard.html`;
    const ownerEmail = mailer.config().owner || 'avinashsreekumar007@gmail.com';
    const excludedEmails = new Set([ownerEmail.toLowerCase(), 'avinashsreekumar007@gmail.com', 'avinashsreekumar0007@gmail.com']);
    const now = Date.now();
    // Find all users with active trials (trialing status, trialEndsAt set, not opted out).
    const users = await User.find({
        'subscription.status': 'trialing',
        'subscription.trialEndsAt': { $ne: null },
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
            // Email 1: 2 days before expiry (0 < msLeft <= 2*24h)
            if (msLeft > 0 && daysLeft <= 2 && (u.trialEmailStage || 0) < 1) {
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
    return { eligible: users.length, sent };
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

// Anything that reached this point matches no page, file, or route. Serving
// the homepage here (the old behavior) made every bad URL a 200 "soft 404"
// that wastes crawl budget and pollutes the index — return a real 404.
app.get('*', (req, res) => {
    res.status(404).sendFile(path.join(__dirname, '../frontend-v2/404.html'));
});

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
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
// Pre-warm the most-viewed dossiers in the background (top ~300 by market cap).
// On in production automatically; locally only with PREWARM=on. SEC calls are
// globally throttled (sec-throttle), so this never trips a rate limit.
if (process.env.NODE_ENV === 'production' || process.env.PREWARM === 'on') {
    try { require('./prewarm').start({ n: Number(process.env.PREWARM_TICKERS) || 300 }); }
    catch (e) { console.log('[prewarm] not started:', e && e.message); }
}
// Optional: nightly SEC bulk companyfacts (inert unless SEC_BULK_DIR is set).
try { require('./companyfacts-bulk').start(); } catch (e) { console.log('[companyfacts-bulk] not started:', e && e.message); }
