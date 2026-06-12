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
const secSource = require('./sec-source');
const aiBriefing = require('./ai-briefing');
const aiFeatures = require('./ai-features');
const aiChat = require('./ai-chat');
const xray = require('./xray');
const watchdog = require('./watchdog');
require('dotenv').config();

// Pro-tier gate. AI_PRO_FOR_ALL=true (default) gives every active subscriber the
// AI features now; set it to 'false' once a paid Pro plan is live to restrict
// the AI assistant to Pro subscribers only.
const AI_PRO_FOR_ALL = process.env.AI_PRO_FOR_ALL !== 'false';
function isProUser(req) {
    if (AI_PRO_FOR_ALL) return true;
    const planId = (req.subscription && req.subscription.planId) || (req.user && req.user.subscription && req.user.subscription.planId);
    return planId === 'pro' || planId === 'pro-annual';
}
function proGate(req, res, next) {
    if (isProUser(req)) return next();
    return res.status(402).json({ message: 'This is a Pro feature. Upgrade to Pro to use the AI assistant.', code: 'PRO_REQUIRED' });
}
require('dotenv').config({ path: path.join(__dirname, 'prod.env') });

const { sendNewUserEmails } = require('./mailer');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
const jsonParser = express.json();
app.use((req, res, next) => {
  if (req.originalUrl === '/stripe/webhook') {
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
app.use(cors());
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }
}));
// gzip the HTML/CSS/JS surfaces (Core Web Vitals / crawl speed). The API is
// excluded so the AI chat's SSE stream is never buffered by the compressor.
app.use(compression({
  filter: (req, res) => {
    if (req.path.startsWith('/api')) return false;
    return compression.filter(req, res);
  }
}));

const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  // v2 pages fan out ~9 API calls each — 300 allowed only ~33 page views
  // per window for a legitimate researcher. 900 still throttles abuse.
  max: 900,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api', apiLimiter);

// Alpha Vantage is no longer used — all market data is served from
// Yahoo Finance via backend/yahoo-source.js. The env var is kept here
// only so existing deployments don't reject unrecognised settings.
const JWT_SECRET = process.env.JWT_SECRET || (process.env.NODE_ENV !== 'production' ? 'dev-jwt-secret-change-me' : '');
if (!JWT_SECRET) {
  throw new Error('JWT_SECRET is required when NODE_ENV=production');
}
const alphaResponseCache = new Map();
const EXPECTED_STRIPE_ACCOUNT_ID = process.env.STRIPE_ACCOUNT_ID || 'acct_1TDj4gAUeKapY1OP';
const MONTHLY_PLAN_ID = 'monthly';
const ANNUAL_PLAN_ID = 'annual';
const PRO_PLAN_ID = 'pro';
const CORE_PLAN_PRICE = parseFloat(process.env.CORE_PLAN_PRICE || '9.00');
const CORE_PLAN_CURRENCY = process.env.CORE_PLAN_CURRENCY || 'GBP';
const ANNUAL_PLAN_PRICE = parseFloat(process.env.ANNUAL_PLAN_PRICE || '90.00');
const ANNUAL_PLAN_CURRENCY = process.env.ANNUAL_PLAN_CURRENCY || CORE_PLAN_CURRENCY;
const PRO_PLAN_PRICE = parseFloat(process.env.PRO_PLAN_PRICE || '25.00');
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
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID || '';
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET || '';
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

  try {
    await mongoose.connect(uri, options);
    console.log(`MongoDB connected (${redactMongoUri(uri)})`);
    return;
  } catch (error) {
    if (!String(uri || '').startsWith('mongodb+srv://') || !isMongoSrvResolutionError(error)) {
      console.error('MongoDB connection error:', error);
      return;
    }

    try {
      const directUri = await expandMongoSrvUri(uri);
      await mongoose.connect(directUri, options);
      console.log(`MongoDB connected via SRV fallback (${redactMongoUri(directUri)})`);
    } catch (fallbackError) {
      console.error('MongoDB connection error:', error);
      console.error('MongoDB SRV fallback error:', fallbackError);
    }
  }
}

function normalizePlanSelection(value) {
  const plan = String(value || '').trim().toLowerCase();
  if (plan === ANNUAL_PLAN_ID || plan === 'year' || plan === 'yearly') {
    return ANNUAL_PLAN_ID;
  }
  if (plan === PRO_PLAN_ID) {
    return PRO_PLAN_ID;
  }
  if (plan === MONTHLY_PLAN_ID || plan === 'month' || plan === 'monthly') {
    return MONTHLY_PLAN_ID;
  }
  return MONTHLY_PLAN_ID;
}

function getPlanConfig(value) {
  const planId = normalizePlanSelection(value);
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
  if (priceId && priceId === STRIPE_PRICE_ID_ANNUAL) {
    return getPlanConfig(ANNUAL_PLAN_ID);
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
        return (data?.bestMatches || []).map((m) => ({ symbol: m['1. symbol'], name: m['2. name'] }));
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
    try {
        return await yahooSource.fetchFromYahoo(functionName, params);
    } catch (error) {
        const err = new Error(error?.message || 'Upstream data source failed');
        err.status = error?.status || 502;
        throw err;
    }
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

app.get('/sitemap.xml', (req, res) => {
    res.set('Content-Type', 'application/xml').send(seoPages.buildSitemap());
});
app.get('/stocks', (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8').send(seoPages.renderStockIndex());
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

// CUTOVER (local): v2 is the product at / — it wins name collisions; anything
// it doesn't have (Media, legal pages, demo pages, data/) falls through to v1.
// HTML revalidates on every request (assets aren't fingerprinted, so a deploy
// must show up immediately); images/css/js/data may be cached for an hour.
const staticCacheHeaders = (res, filePath) => {
    res.setHeader('Cache-Control', filePath.endsWith('.html') ? 'no-cache' : 'public, max-age=3600');
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
    stripeSubscriptionId: { type: String, default: null }
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
    return jwt.sign({ userId: user._id }, JWT_SECRET);
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
            ...(planConfig.trialDays > 0 ? { trial_period_days: planConfig.trialDays } : {})
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

// Per-user stock holdings used by the Dashboard portfolio tracker.
const StockSchema = new mongoose.Schema({
    symbol: { type: String, required: true },
    name: { type: String },
    sector: { type: String },
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
        if (REQUIRE_ACTIVE_SUBSCRIPTION && !subscriptionIsActive(user.subscription)) {
            if (user.isModified('subscription')) {
                await user.save().catch(() => {});
            }
            return res.status(402).json({
                message: 'An active subscription is required to use the app.',
                code: 'SUBSCRIPTION_REQUIRED',
                subscription: normalized
            });
        }

        if (user.isModified('subscription')) {
            await user.save().catch(() => {});
        }

        req.userId = user._id;
        req.user = user;
        req.subscription = normalized;
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

// Subscription signup route
app.post('/api/subscribe', async (req, res) => {
    const { name, email, password } = req.body || {};
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

    if (!stripe) {
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
        user.markModified('subscription');
        await user.save();

        // New signup: send onboarding email + owner notification (fire-and-forget).
        sendNewUserEmails({ name: displayName, email: normalizedEmail, plan: planConfig.planName })
            .catch((e) => console.error('[mailer] new-user email error:', e && e.message));

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

app.post('/api/support', async (req, res) => {
    try {
        const { name, email, subject, message } = req.body || {};
        if (!name || !email || !subject || !message) {
            return res.status(400).json({ message: 'All fields are required' });
        }
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ message: 'Please provide a valid email address' });
        }
        const ticket = new SupportTicket({
            name: name.trim(),
            email: email.toLowerCase(),
            subject: subject.trim(),
            message: message.trim()
        });
        await ticket.save();
        res.status(201).json({ message: 'Support ticket submitted. We will reach out shortly.' });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) {
            return res.status(503).json({ message: 'Database unavailable. Start MongoDB and configure MONGODB_URI.' });
        }
        console.error('Support ticket error:', error);
        res.status(500).json({ message: 'Unable to submit ticket right now.' });
    }
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

        if (REQUIRE_ACTIVE_SUBSCRIPTION && !subscriptionIsActive(user.subscription)) {
            if (user.isModified('subscription')) {
                await user.save().catch(() => {});
            }
            return res.status(402).json({
                message: 'An active subscription is required to log in. Please complete payment.',
                code: 'SUBSCRIPTION_REQUIRED',
                subscription: normalized
            });
        }

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
            subscription
        });
    } catch (error) {
        console.error('/api/session error:', error);
        res.status(500).json({ message: 'Unable to load session' });
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
    if (localMatches.length) {
        return res.json(localMatches);
    }
    try {
        const matches = await alphaClient.searchSymbols(query);
        res.json(matches);
    } catch (error) {
        // Return an empty array instead of erroring to avoid breaking UX
        res.json([]);
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

app.get('/api/alpha/time-series/daily', authMiddleware, async (req, res) => {
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
        res.json(payload);
    } catch (error) {
        res.status(500).json({ message: error.message || 'Market strip failed' });
    }
});

app.get('/api/alpha/time-series/monthly', authMiddleware, async (req, res) => {
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

app.get('/api/alpha/fundamentals/:symbol', authMiddleware, async (req, res) => {
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
app.get('/api/alpha/quote/:symbol', authMiddleware, async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!symbol) return res.status(400).json({ message: 'symbol is required' });
    try {
        const data = await fetchAlphaCached('GLOBAL_QUOTE', { symbol }, ALPHA_CACHE_TTL_MS.quote);
        res.json(data);
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message || 'Quote load failed' });
    }
});

app.get('/api/alpha/movers', authMiddleware, async (req, res) => {
    try {
        const data = await fetchAlphaCached('TOP_GAINERS_LOSERS', {}, ALPHA_CACHE_TTL_MS.quote);
        res.json(data);
    } catch (error) {
        res.status(error.status || 500).json({ message: error.message || 'Movers load failed' });
    }
});

app.get('/api/alpha/news', authMiddleware, async (req, res) => {
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
        mongoUriConfigured: Boolean(process.env.MONGODB_URI)
    });
});

// ----- Portfolio routes (used by the Dashboard tracker) -----
function portfolioOwnerId(req) {
    return req.userId;
}

app.get('/api/portfolio', authMiddleware, async (req, res) => {
    try {
        const ownerId = portfolioOwnerId(req);
        const portfolio = await Stock.find({ user: ownerId });
        const enriched = await Promise.all(portfolio.map(async (stock) => {
            const ticker = safeUpper(stock.symbol);
            const payload = stock.toObject();
            payload.symbol = ticker;
            try {
                payload.currentPrice = await getStockPrice(ticker);
            } catch (priceError) {
                console.warn(`Price update failed for ${ticker}: ${priceError.message}`);
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
app.get('/api/portfolio/briefing', authMiddleware, async (req, res) => {
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
        res.json({ ...payload, cached: false });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) {
            return res.status(503).json({ message: 'Database unavailable.' });
        }
        res.status(500).json({ message: error.message || 'Briefing failed' });
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
        const payload = { symbol, summary: result.summary, source: result.source, generatedAt: new Date().toISOString() };
        _aiSummaryCache.set(symbol, { at: Date.now(), payload });
        res.json({ ...payload, cached: false });
    } catch (error) {
        res.status(500).json({ message: error.message || 'AI summary failed' });
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
app.post('/api/ai/chat', authMiddleware, async (req, res) => {
    const question = String((req.body && req.body.question) || '').trim();
    if (!question) return res.status(400).json({ message: 'Ask a question.' });
    try {
        const userId = portfolioOwnerId(req);
        const limit = aiChat.limits(isProUser(req));
        const used = await aiChat.getUsage(userId);
        if (used >= limit) {
            return res.status(429).json({
                message: isProUser(req)
                    ? `You've used all ${limit} Ask queries this month — the counter resets on the 1st.`
                    : `You've used your ${limit} free Ask queries this month. Upgrade to Pro for ${aiChat.limits(true)} a month.`,
                code: 'ASK_QUOTA', quota: { used, limit, remaining: 0 }
            });
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
app.get('/api/portfolio/xray', authMiddleware, async (req, res) => {
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
        res.json({ ...payload, cached: false });
    } catch (error) {
        if (isDatabaseUnavailableError(error)) return res.status(503).json({ message: 'Database unavailable.' });
        res.status(500).json({ message: error.message || 'X-Ray failed' });
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

app.post('/api/watchlist/:symbol', authMiddleware, async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!symbol || !/^[A-Z0-9.\-]{1,10}$/.test(symbol)) return res.status(400).json({ message: 'Invalid symbol' });
    try {
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
        res.json(payload);
    } catch (error) {
        res.status(500).json({ message: error.message || 'Filings load failed' });
    }
});

// Insider history — the real Form 4 trail (3 years), parsed from EDGAR.
// Public; first request per company kicks off a background build (~1-2 min)
// and the response says so.
const insiders = require('./insiders');
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

// Insights — connected, decision-relevant analysis from a deterministic
// fact pack (Pro: this is the synthesized intelligence tier).
const insights = require('./insights');
app.get('/api/company/:symbol/insights', authMiddleware, proGate, async (req, res) => {
    const symbol = safeUpper(req.params.symbol);
    if (!symbol) return res.status(400).json({ message: 'symbol required' });
    try {
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
        const result = await segments.extractSegments(symbol);
        if (result.error) return res.status(404).json({ message: result.error });
        res.json(result);
    } catch (error) {
        res.status(500).json({ message: error.message || 'Segment extraction failed' });
    }
});

// Quota peek so the UI can show "3 of 5 free questions left" before asking.
// Thumbs on an Ask answer — stored for quality review, nothing else.
app.post('/api/ai/chat/feedback', authMiddleware, async (req, res) => {
    try {
        await mongoose.connection.collection('ai_chat_feedback').insertOne({
            userId: String(portfolioOwnerId(req)),
            verdict: (req.body && req.body.verdict) === 'up' ? 'up' : 'down',
            question: String((req.body && req.body.question) || '').slice(0, 1000),
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
        const limit = aiChat.limits(isProUser(req));
        const used = await aiChat.getUsage(portfolioOwnerId(req));
        res.json({ used, limit, remaining: Math.max(0, limit - used), pro: isProUser(req) });
    } catch (error) {
        res.status(500).json({ message: error.message || 'Quota check failed' });
    }
});

app.post('/api/portfolio', authMiddleware, async (req, res) => {
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
        let livePrice = 0;
        try { livePrice = await getStockPrice(ticker); }
        catch (priceError) { console.warn(`Price lookup failed for ${ticker}: ${priceError.message}`); }

        const buyPrice = Number.isFinite(Number(purchasePrice)) && Number(purchasePrice) > 0
            ? Number(purchasePrice)
            : livePrice;

        let profile = await getCompanyProfile(ticker);
        const resolvedName = name || profile.name || ticker;
        const sector = profile.sector || '';
        let purchase = purchaseDate ? new Date(purchaseDate) : new Date();
        if (Number.isNaN(purchase.getTime())) purchase = new Date();

        const newStock = new Stock({
            symbol: ticker,
            name: resolvedName,
            sector,
            shares: qty,
            purchasePrice: buyPrice,
            purchaseDate: purchase,
            currentPrice: livePrice,
            user: portfolioOwnerId(req)
        });
        await newStock.save();
        res.json(newStock);
    } catch (error) {
        if (isDatabaseUnavailableError(error)) {
            return res.status(503).json({ message: 'Database unavailable. Start MongoDB and configure MONGODB_URI.' });
        }
        res.status(500).json({ message: error.message });
    }
});

app.delete('/api/portfolio/:id', authMiddleware, async (req, res) => {
    try {
        const ownerId = portfolioOwnerId(req);
        const stock = await Stock.findOneAndDelete({ _id: req.params.id, user: ownerId });
        if (!stock) return res.status(404).json({ message: 'Stock not found or unauthorized' });
        res.status(200).json({ message: 'Stock deleted successfully' });
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
                        await syncSubscriptionFromStripe(user, subscription, payload.customer);
                    } else {
                        await activateSubscription(user, {
                            subscriptionId: payload.subscription,
                            customerId: payload.customer,
                            planId: payload.metadata?.planId,
                            stripeStatus: 'active',
                            stripePriceId: payload.metadata?.stripePriceId || null
                        });
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
                await syncSubscriptionFromStripe(user, subscription, subscription.customer);
            }
        } catch (err) {
            console.error('Stripe webhook update error:', err);
        }
    } else if (event.type === 'customer.subscription.deleted') {
        try {
            const subscription = payload;
            const user = await User.findOne({ stripeSubscriptionId: subscription.id });
            if (user) {
                user.subscription.status = 'cancelled';
                user.subscription.trialEndsAt = null;
                user.stripeSubscriptionId = null;
                await user.save();
            }
        } catch (err) {
            console.error('Stripe webhook delete error:', err);
        }
    }

    res.status(200).send({ received: true });
});

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
    res.sendFile(path.join(__dirname, '../frontend/founding.html'));
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

// Anything that reached this point matches no page, file, or route. Serving
// the homepage here (the old behavior) made every bad URL a 200 "soft 404"
// that wastes crawl budget and pollutes the index — return a real 404.
app.get('*', (req, res) => {
    res.status(404).sendFile(path.join(__dirname, '../frontend-v2/404.html'));
});

// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
watchdog.start();






