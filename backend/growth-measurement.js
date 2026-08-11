'use strict';

// Growth Measurement V1 is deliberately a small, dependency-free contract.
// It normalizes request metadata before it reaches MongoDB, GA4 or Clarity.
// No prompt, answer, email, name, holding, licence code or query string is
// accepted by this module.

const crypto = require('crypto');

const SCHEMA_VERSION = 'growth-measurement-v1';
const EVENT_NAMES = Object.freeze(new Set([
    'pricing_viewed', 'cta_clicked', 'appsumo_outbound_clicked', 'signup_started', 'checkout_started',
    'signup_completed', 'appsumo_redemption_started', 'appsumo_redemption_completed',
    'research_outcome_completed', 'activation_completed', 'stripe_checkout_created',
    'stripe_checkout_completed', 'subscription_started', 'invoice_paid',
    'subscription_cancel_scheduled', 'subscription_canceled', 'payment_refunded',
    'review_eligible', 'review_request_sent', 'review_received', 'support_outcome_confirmed',
    'page_view', 'tool_view', 'tool_complete', 'trial_started', 'meaningful_activation',
    'activation', 'appsumo_click', 'appsumo_redemption', 'stripe_subscribe', 'paid', 'cancel',
    'customer_success', 'review_shown', 'review_clicked', 'review_dismissed'
]));

const BROWSER_EVENTS = Object.freeze(new Set([
    'pricing_viewed', 'cta_clicked', 'appsumo_outbound_clicked', 'signup_started', 'checkout_started'
]));

const EVENT_TO_GA4 = Object.freeze({
    signup_completed: 'sign_up',
    stripe_checkout_created: 'begin_checkout',
    invoice_paid: 'purchase',
    payment_refunded: 'refund'
});

const SOURCE_ALIASES = Object.freeze({ twitter: 'x', tw: 'x', site: 'website', web: 'website',
    organic: 'google', search: 'google', hn: 'hackernews', 'hacker-news': 'hackernews' });
const SOURCES = new Set(['direct', 'unknown', 'internal', 'bot', 'google', 'bing', 'duckduckgo',
    'x', 'linkedin', 'reddit', 'hackernews', 'youtube', 'newsletter', 'email', 'creator',
    'appsumo', 'website', 'facebook', 'instagram', 'referral']);
const PAGE_TYPES = new Set(['metric', 'comparison', 'stock', 'screen', 'research', 'tool', 'pricing', 'other']);
const ENTITLEMENTS = new Set(['stripe', 'appsumo', 'trial', 'free', 'comp', 'unknown']);
const FEATURE_TYPES = new Set(['ask', 'comparison', 'portfolio', 'filing_monitor', 'screener', 'tool', 'other']);

function text(value, max = 120) {
    const valueText = String(value == null ? '' : value).trim();
    return valueText ? valueText.slice(0, max) : null;
}

function safeId(value, max = 120) {
    const valueText = text(value, max);
    return valueText && /^[A-Za-z0-9._:-]+$/.test(valueText) ? valueText : null;
}

function normalizeSource(value) {
    const raw = String(value || '').trim().toLowerCase();
    const source = SOURCE_ALIASES[raw] || raw;
    return SOURCES.has(source) ? source : (source ? 'unknown' : null);
}

function normalizeEventName(value, extra = {}) {
    const raw = String(value || '').trim().toLowerCase();
    if (raw === 'signup') return 'signup_completed';
    if (raw === 'trial_start') return 'trial_started';
    if (raw === 'appsumo_outbound' || raw === 'appsumo_click' || raw === 'appsumo_outbound_clicked') return 'appsumo_outbound_clicked';
    if (raw === 'cta_click') return 'cta_clicked';
    if (raw === 'meaningful_activation') return 'research_outcome_completed';
    if (raw === 'activation') return 'activation_completed';
    if (raw === 'paid') return String(extra.source || extra.acquisitionSource || '').toLowerCase() === 'appsumo'
        ? 'appsumo_redemption_completed' : 'invoice_paid';
    if (raw === 'cancel') return 'subscription_canceled';
    if (raw === 'customer_success') return 'support_outcome_confirmed';
    return EVENT_NAMES.has(raw) ? raw : null;
}

function sanitizePath(value) {
    try {
        const parsed = new URL(String(value || ''), 'https://stockportfolio.pro');
        return parsed.pathname.replace(/\/+/g, '/').slice(0, 240) || '/';
    } catch (_) { return '/'; }
}

function sanitizeAttribution(record) {
    if (!record || typeof record !== 'object') return null;
    const source = normalizeSource(record.source) || 'unknown';
    const occurred = record.occurredAt ? new Date(record.occurredAt) : null;
    return {
        source,
        medium: text(record.medium, 60),
        campaign: text(record.campaign, 120),
        term: text(record.term, 120),
        contentId: safeId(record.contentId, 120),
        clickId: safeId(record.clickId, 80),
        referrerHost: text(record.referrerHost, 160),
        landingPath: sanitizePath(record.landingPath),
        ctaId: safeId(record.ctaId, 100),
        environment: text(record.environment, 20),
        occurredAt: occurred && Number.isFinite(occurred.getTime()) ? occurred.toISOString() : null
    };
}

function opaqueUserId(userId, secret) {
    if (!userId || !secret) return null;
    return crypto.createHmac('sha256', String(secret)).update(String(userId)).digest('hex').slice(0, 32);
}

function randomEventId() { return crypto.randomUUID(); }

function canonicalEvent({ eventName, userId, plan, data = {}, attribution = {}, now = new Date(), secret = process.env.JWT_SECRET } = {}) {
    const normalized = normalizeEventName(eventName, data);
    if (!normalized) return null;
    const current = sanitizeAttribution(attribution.currentSession || data.currentSession);
    const first = sanitizeAttribution(attribution.firstTouch || data.firstTouch);
    const last = sanitizeAttribution(attribution.lastNonDirect || data.lastNonDirect);
    const pagePath = sanitizePath(data.pagePath || data.path || '/');
    const pageType = PAGE_TYPES.has(String(data.pageType || '').toLowerCase()) ? String(data.pageType).toLowerCase() : 'other';
    const featureType = FEATURE_TYPES.has(String(data.featureType || '').toLowerCase()) ? String(data.featureType).toLowerCase() : null;
    const entitlementSource = ENTITLEMENTS.has(String(data.entitlementSource || '').toLowerCase()) ? String(data.entitlementSource).toLowerCase() : null;
    const trafficCategory = text(data.trafficCategory || data.referrerSource || data.trafficClass, 40);
    const internalFlag = data.internalFlag === true || data.isQa === true || trafficCategory === 'internal';
    const botFlag = data.botFlag === true || data.isBot === true || ['bot', 'crawler', 'automation'].includes(trafficCategory);
    const eventId = safeId(data.eventId, 80) || randomEventId();
    const anonymousId = safeId(data.anonymousId || data.anonymousSessionId, 80);
    const sessionId = safeId(data.sessionId || data.anonymousSessionId, 80);
    const user = userId ? String(userId) : null;
    const dedupeKey = safeId(data.dedupeKey, 220) || null;
    const canonical = {
        eventId,
        eventName: normalized,
        schemaVersion: SCHEMA_VERSION,
        occurredAt: new Date(now).toISOString(),
        anonymousId,
        sessionId,
        opaqueUserId: opaqueUserId(user, secret),
        firstTouch: first,
        lastNonDirectTouch: last,
        currentSessionTouch: current,
        pageType,
        pagePath,
        contentId: safeId(data.contentId, 120),
        campaignId: safeId(data.campaignId, 120),
        ctaId: safeId(data.ctaId || data.cta, 100),
        plan: text(plan || data.plan, 80),
        billingPeriod: text(data.billingPeriod || data.billing_interval, 20),
        entitlementSource,
        appsumoTier: Number.isInteger(Number(data.appsumoTier)) ? Number(data.appsumoTier) : null,
        featureType,
        trafficCategory,
        environment: text(data.environment || process.env.NODE_ENV || 'development', 20),
        internalFlag,
        testFlag: data.testFlag === true || String(data.environment || '').toLowerCase() === 'test',
        botFlag,
        dedupeKey,
        ga4EventName: EVENT_TO_GA4[normalized] || null
    };
    // Keep a stable machine-facing spelling for downstream exports while the
    // Mongo document also retains the application's camelCase convention.
    return {
        ...canonical,
        event_id: canonical.eventId,
        event_name: canonical.eventName,
        schema_version: canonical.schemaVersion,
        occurred_at: canonical.occurredAt,
        anonymous_id: canonical.anonymousId,
        session_id: canonical.sessionId,
        opaque_user_id: canonical.opaqueUserId,
        first_touch: canonical.firstTouch,
        last_non_direct_touch: canonical.lastNonDirectTouch,
        current_session_touch: canonical.currentSessionTouch,
        page_type: canonical.pageType,
        page_path: canonical.pagePath,
        content_id: canonical.contentId,
        campaign_id: canonical.campaignId,
        cta_id: canonical.ctaId,
        billing_period: canonical.billingPeriod,
        entitlement_source: canonical.entitlementSource,
        appsumo_tier: canonical.appsumoTier,
        feature_type: canonical.featureType,
        traffic_category: canonical.trafficCategory,
        internal: canonical.internalFlag,
        test: canonical.testFlag,
        bot: canonical.botFlag
    };
}

function validateBrowserEvent(name) { return BROWSER_EVENTS.has(normalizeEventName(name)); }

module.exports = {
    SCHEMA_VERSION, EVENT_NAMES, BROWSER_EVENTS, EVENT_TO_GA4, SOURCES,
    normalizeSource, normalizeEventName, sanitizePath, sanitizeAttribution,
    opaqueUserId, canonicalEvent, validateBrowserEvent, randomEventId
};
