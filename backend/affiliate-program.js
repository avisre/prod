'use strict';

// Release-1 customer ambassador primitives.  This module deliberately keeps
// referral state separate from the existing acquisition cookie: campaign
// attribution answers “which channel brought the visitor?”, while this cookie
// answers “which approved customer may receive credit?”.  It contains only a
// random click id and an opaque ambassador slug, never an email or user id.

const crypto = require('crypto');
const mongoose = require('mongoose');

const COOKIE_NAME = 'sp_aff_ref';
const DEFAULT_ATTRIBUTION_DAYS = 60;
const DEFAULT_APP_SUMO_DESTINATION = 'appsumo';
const CURRENT_TERMS_VERSION = 'customer-ambassador-v1-2026-08-13';
const STRIPE_COMMISSION_RATE_BPS = Object.freeze({
    monthly: 3000,
    annual: 3000,
    pro: 3000,
    'pro-annual': 3000,
    power: 3000,
    'power-monthly': 3000,
    desk: 2000,
    firm: 1000,
    enterprise: 1000
});
const STATUS_VALUES = [
    'needs_support', 'needs_onboarding', 'successful_user', 'ambassador_invited',
    'ambassador_active', 'declined', 'unresponsive'
];
const PROFILE_STATUS_VALUES = ['invited', 'active', 'suspended', 'declined'];

function isEnabled(env = process.env) {
    return String(env.AFFILIATE_PROGRAM_ENABLED || '').toLowerCase() === 'true';
}

function attributionDays(env = process.env) {
    const value = Number.parseInt(env.AFFILIATE_ATTRIBUTION_DAYS, 10);
    return Number.isFinite(value) ? Math.min(365, Math.max(1, value)) : DEFAULT_ATTRIBUTION_DAYS;
}

function cookieSecret(env = process.env) {
    return String(env.AFFILIATE_COOKIE_SECRET || '');
}

function appSumoUrl(env = process.env) {
    const configured = String(env.APPSUMO_NEW_BUYER_URL || '').trim();
    try {
        const url = new URL(configured);
        if (url.protocol === 'https:' && (url.hostname === 'appsumo.com' || url.hostname.endsWith('.appsumo.com')) && !url.username && !url.password) return url.toString();
    } catch (_) { /* use the safe local fallback below */ }
    return '/appsumo?source=affiliate';
}

function safeEqual(a, b) {
    const left = Buffer.from(String(a || ''));
    const right = Buffer.from(String(b || ''));
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function signature(payload, secret) {
    return crypto.createHmac('sha256', String(secret || '')).update(payload).digest('base64url').slice(0, 32);
}

function randomId(bytes = 16) {
    return crypto.randomBytes(bytes).toString('base64url');
}

function createReferralCookieValue({ slug, clickId = randomId(), now = Date.now(), secret } = {}) {
    if (!secret || !/^[a-z0-9][a-z0-9-]{2,63}$/.test(String(slug || ''))) return null;
    const timestamp = Math.floor(Number(now) / 1000);
    if (!Number.isInteger(timestamp) || timestamp <= 0) return null;
    const id = String(clickId || '');
    if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) return null;
    const payload = `v1.${String(slug)}.${timestamp}.${id}`;
    return `${payload}.${signature(payload, secret)}`;
}

function parseReferralCookieValue(value, { secret, now = Date.now(), maxAgeSeconds } = {}) {
    if (!secret) return null;
    const parts = String(value || '').split('.');
    if (parts.length !== 5 || parts[0] !== 'v1') return null;
    const [, slug, timestampRaw, clickId, sig] = parts;
    const timestamp = Number(timestampRaw);
    const maxAge = Number.isFinite(Number(maxAgeSeconds)) ? Number(maxAgeSeconds) : attributionDays() * 86400;
    const nowSeconds = Math.floor(Number(now) / 1000);
    if (!/^[a-z0-9][a-z0-9-]{2,63}$/.test(slug) || !/^[A-Za-z0-9_-]{16,64}$/.test(clickId)) return null;
    if (!Number.isInteger(timestamp) || timestamp > nowSeconds + 300 || nowSeconds - timestamp > maxAge) return null;
    const payload = parts.slice(0, 4).join('.');
    if (!safeEqual(sig, signature(payload, secret))) return null;
    return { slug, clickId, clickedAt: new Date(timestamp * 1000), expiresAt: new Date((timestamp + maxAge) * 1000) };
}

function parseCookieHeader(header = '') {
    for (const part of String(header || '').split(';')) {
        const index = part.indexOf('=');
        if (index <= 0) continue;
        if (part.slice(0, index).trim() !== COOKIE_NAME) continue;
        let value = part.slice(index + 1).trim();
        try { value = decodeURIComponent(value); } catch (_) { /* keep raw */ }
        return value;
    }
    return '';
}

function referralFromRequest(req, env = process.env) {
    return parseReferralCookieValue(parseCookieHeader(req && req.headers && req.headers.cookie), {
        secret: cookieSecret(env),
        maxAgeSeconds: attributionDays(env) * 86400
    });
}

function serializeReferralCookie(value, { secure = true, domain = null, env = process.env } = {}) {
    if (!value) return null;
    const parts = [
        `${COOKIE_NAME}=${encodeURIComponent(value)}`,
        `Max-Age=${attributionDays(env) * 86400}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax'
    ];
    if (domain && /^[a-z0-9.-]+$/.test(String(domain))) parts.push(`Domain=${String(domain).replace(/^\./, '')}`);
    if (secure) parts.push('Secure');
    return parts.join('; ');
}

function slugify(value) {
    const base = String(value || 'ambassador').trim().toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
    return base || 'ambassador';
}

function commissionRateBps(planId, { appsumo = false, desk = false, firm = false } = {}) {
    if (appsumo) return 2500;
    const plan = String(planId || '').toLowerCase();
    if (firm || plan === 'firm' || plan === 'enterprise') return 1000;
    if (desk || plan === 'desk') return 2000;
    return STRIPE_COMMISSION_RATE_BPS[plan] || 0;
}

function calculateCommission({ eligibleBasisMinor, planId, billingInterval, appsumo = false, desk = false, firm = false } = {}) {
    const basis = Math.max(0, Math.floor(Number(eligibleBasisMinor) || 0));
    const rateBps = commissionRateBps(planId, { appsumo, desk, firm });
    return { basisMinor: basis, rateBps, amountMinor: Math.floor((basis * rateBps) / 10000) };
}

function summarizeCommissionsByCurrency(commissions = []) {
    const totalsByCurrency = {};
    for (const commission of commissions || []) {
        const currency = String(commission?.currency || 'usd').toLowerCase().slice(0, 8) || 'usd';
        const totals = totalsByCurrency[currency] || (totalsByCurrency[currency] = {
            count: 0,
            basisMinor: 0,
            amountMinor: 0,
            reversalMinor: 0,
            netMinor: 0,
            pendingMinor: 0,
            approvedMinor: 0,
            paidMinor: 0,
            reversedMinor: 0
        });
        const amount = Math.max(0, Number(commission?.amountMinor || 0));
        const reversal = Math.min(amount, Math.max(0, Number(commission?.reversalMinor || 0)));
        const net = Math.max(0, amount - reversal);
        totals.count++;
        totals.basisMinor += Math.max(0, Number(commission?.basisMinor || 0));
        totals.amountMinor += amount;
        totals.reversalMinor += reversal;
        totals.reversedMinor += reversal;
        totals.netMinor += net;
        if (commission?.status === 'pending') totals.pendingMinor += net;
        else if (commission?.status === 'approved') totals.approvedMinor += net;
        else if (commission?.status === 'paid') totals.paidMinor += net;
    }
    return totalsByCurrency;
}

function combineCommissionCurrencyTotals(totalsByCurrency = {}) {
    return Object.values(totalsByCurrency).reduce((combined, totals) => {
        for (const key of ['pendingMinor', 'approvedMinor', 'paidMinor', 'reversedMinor']) {
            combined[key] += Math.max(0, Number(totals?.[key] || 0));
        }
        return combined;
    }, { pendingMinor: 0, approvedMinor: 0, paidMinor: 0, reversedMinor: 0 });
}

function selectPayoutEligibleCommissions(commissions = [], minAmountMinor = 10000) {
    const minimum = Math.max(10000, Math.floor(Number(minAmountMinor) || 10000));
    const byProfile = new Map();
    for (const commission of commissions || []) {
        const profileId = String(commission?.affiliateProfileId || '');
        if (!profileId) continue;
        const netMinor = Math.max(0, Math.floor(Number(commission?.amountMinor || 0) - Number(commission?.reversalMinor || 0)));
        const group = byProfile.get(profileId) || { profileId, totalMinor: 0, commissions: [] };
        group.totalMinor += netMinor;
        group.commissions.push(commission);
        byProfile.set(profileId, group);
    }
    const qualifyingProfiles = [...byProfile.values()].filter((group) => group.totalMinor >= minimum);
    const eligibleCommissions = qualifyingProfiles.flatMap((group) => group.commissions);
    return {
        minimumMinor: minimum,
        eligibleCommissions,
        qualifyingProfiles: qualifyingProfiles.map(({ profileId, totalMinor }) => ({ profileId, totalMinor })),
        totalMinor: qualifyingProfiles.reduce((total, group) => total + group.totalMinor, 0),
        excludedProfiles: byProfile.size - qualifyingProfiles.length
    };
}

function isMonthlyEligible(sequence) { return Number(sequence) >= 1 && Number(sequence) <= 12; }
function isAnnualEligible(sequence) { return Number(sequence) === 1; }

function hasVerifiedStripeSubscription(user = {}) {
    const status = String(user?.subscription?.status || '');
    return Boolean(
        (user.stripeCustomerId || user.stripeSubscriptionId)
        && ['active', 'cancel_at_period_end'].includes(status)
    );
}

function canAcceptAmbassadorInvite({ profile, user, appSumoLicenseActive = false } = {}) {
    if (!profile || !user) return false;
    const genuinelyInvited = profile.status === 'invited'
        && profile.customerStatus === 'ambassador_invited'
        && Boolean(profile.invitedAt);
    const verifiedCustomer = Boolean(appSumoLicenseActive) || hasVerifiedStripeSubscription(user);
    return genuinelyInvited && verifiedCustomer;
}

const AffiliateProfileSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true, index: true },
    slug: { type: String, required: true, unique: true, index: true, lowercase: true, trim: true },
    customerStatus: { type: String, enum: STATUS_VALUES, default: 'ambassador_invited', index: true },
    status: { type: String, enum: PROFILE_STATUS_VALUES, default: 'invited', index: true },
    termsAcceptedAt: { type: Date, default: null },
    termsVersion: { type: String, default: null, maxlength: 80 },
    invitedAt: { type: Date, default: null },
    activatedAt: { type: Date, default: null },
    suspendedAt: { type: Date, default: null },
    notes: { type: String, default: null, maxlength: 2000 },
    disclosure: { type: String, default: 'I may earn a commission if you purchase through this link.' }
}, { timestamps: true, versionKey: false, collection: 'affiliate_profiles' });

const ReferralClickSchema = new mongoose.Schema({
    clickId: { type: String, required: true, unique: true, index: true },
    affiliateProfileId: { type: mongoose.Schema.Types.ObjectId, ref: 'AffiliateProfile', required: true, index: true },
    slug: { type: String, required: true, index: true },
    destination: { type: String, enum: ['appsumo', 'pricing', 'home'], default: 'appsumo' },
    landingPath: { type: String, default: null, maxlength: 240 },
    referrerDomain: { type: String, default: null, maxlength: 120 },
    ipHash: { type: String, default: null, maxlength: 128 },
    userAgentHash: { type: String, default: null, maxlength: 128 },
    clickedAt: { type: Date, default: () => new Date(), index: true },
    expiresAt: { type: Date, required: true, index: true },
    convertedAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false, collection: 'affiliate_referral_clicks' });
ReferralClickSchema.index({ affiliateProfileId: 1, clickedAt: -1 });

const ReferralOrderSchema = new mongoose.Schema({
    provider: { type: String, enum: ['stripe', 'appsumo'], required: true, index: true },
    providerOrderId: { type: String, required: true },
    providerCustomerId: { type: String, default: null, index: true },
    subscriptionId: { type: String, default: null, index: true },
    affiliateProfileId: { type: mongoose.Schema.Types.ObjectId, ref: 'AffiliateProfile', required: true, index: true },
    referralClickId: { type: String, default: null, index: true },
    customerUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null, index: true },
    planId: { type: String, default: null },
    billingInterval: { type: String, enum: ['month', 'year', null], default: null },
    currency: { type: String, default: 'usd', lowercase: true },
    grossCollectedMinor: { type: Number, default: null },
    eligibleBasisMinor: { type: Number, default: null },
    refundedMinor: { type: Number, default: 0 },
    status: { type: String, enum: ['checkout_started', 'paid', 'pending_reconciliation', 'refunded', 'disputed', 'ineligible_existing_customer', 'unmatched'], default: 'checkout_started', index: true },
    purchasedAt: { type: Date, default: null, index: true },
    refundedAt: { type: Date, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true, versionKey: false, collection: 'affiliate_referral_orders' });
ReferralOrderSchema.index({ provider: 1, providerOrderId: 1 }, { unique: true });

const CommissionSchema = new mongoose.Schema({
    affiliateProfileId: { type: mongoose.Schema.Types.ObjectId, ref: 'AffiliateProfile', required: true, index: true },
    referralOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'ReferralOrder', required: true },
    provider: { type: String, enum: ['stripe', 'appsumo'], required: true },
    invoiceId: { type: String, default: null },
    paymentIntentId: { type: String, default: null, index: true },
    chargeId: { type: String, default: null, index: true },
    sequence: { type: Number, default: 1 },
    currency: { type: String, default: 'usd', lowercase: true },
    basisMinor: { type: Number, required: true, min: 0 },
    rateBps: { type: Number, required: true, min: 0 },
    amountMinor: { type: Number, required: true, min: 0 },
    holdUntil: { type: Date, required: true, index: true },
    status: { type: String, enum: ['pending', 'approved', 'reversed', 'paid'], default: 'pending', index: true },
    reversalMinor: { type: Number, default: 0 },
    refundedBasisMinor: { type: Number, default: 0, min: 0 },
    reversalMetadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    reason: { type: String, default: null, maxlength: 240 },
    paidAt: { type: Date, default: null },
    payoutBatchId: { type: mongoose.Schema.Types.ObjectId, ref: 'PayoutBatch', default: null }
}, { timestamps: true, versionKey: false, collection: 'affiliate_commissions' });
CommissionSchema.index({ referralOrderId: 1, invoiceId: 1 }, { unique: true, sparse: true });

const PayoutBatchSchema = new mongoose.Schema({
    currency: { type: String, default: 'usd', lowercase: true },
    minAmountMinor: { type: Number, default: 10000 },
    totalMinor: { type: Number, required: true, min: 0 },
    commissionIds: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Commission' }],
    status: { type: String, enum: ['draft', 'exported', 'paid', 'cancelled'], default: 'draft', index: true },
    reference: { type: String, default: null, maxlength: 160 },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    paidAt: { type: Date, default: null }
}, { timestamps: true, versionKey: false, collection: 'affiliate_payout_batches' });

const AffiliateAuditEventSchema = new mongoose.Schema({
    action: { type: String, required: true, index: true },
    actor: { type: String, required: true, maxlength: 160 },
    affiliateProfileId: { type: mongoose.Schema.Types.ObjectId, ref: 'AffiliateProfile', default: null, index: true },
    targetId: { type: String, default: null, maxlength: 160 },
    details: { type: mongoose.Schema.Types.Mixed, default: {} }
}, { timestamps: true, versionKey: false, collection: 'affiliate_audit_events' });

const ProcessedWebhookEventSchema = new mongoose.Schema({
    provider: { type: String, required: true },
    eventId: { type: String, required: true },
    eventType: { type: String, default: null },
    processedAt: { type: Date, default: () => new Date() },
    result: { type: String, default: null }
}, { timestamps: true, versionKey: false, collection: 'affiliate_processed_webhook_events' });
ProcessedWebhookEventSchema.index({ provider: 1, eventId: 1 }, { unique: true });

function model(name, schema) { return mongoose.models[name] || mongoose.model(name, schema); }
function models() {
    return {
        AffiliateProfile: model('AffiliateProfile', AffiliateProfileSchema),
        ReferralClick: model('ReferralClick', ReferralClickSchema),
        ReferralOrder: model('ReferralOrder', ReferralOrderSchema),
        Commission: model('Commission', CommissionSchema),
        PayoutBatch: model('PayoutBatch', PayoutBatchSchema),
        AffiliateAuditEvent: model('AffiliateAuditEvent', AffiliateAuditEventSchema),
        ProcessedWebhookEvent: model('AffiliateProcessedWebhookEvent', ProcessedWebhookEventSchema)
    };
}

function publicProfile(profile, baseUrl = '') {
    if (!profile) return null;
    const root = String(baseUrl || '').replace(/\/$/, '');
    return {
        slug: profile.slug,
        referralUrl: `${root}/r/${encodeURIComponent(profile.slug)}`,
        status: profile.status,
        customerStatus: profile.customerStatus,
        termsAcceptedAt: profile.termsAcceptedAt || null,
        termsVersion: profile.termsVersion || null,
        currentTermsVersion: CURRENT_TERMS_VERSION,
        termsCurrent: profile.termsVersion === CURRENT_TERMS_VERSION,
        invitedAt: profile.invitedAt || null,
        activatedAt: profile.activatedAt || null,
        disclosure: profile.disclosure
    };
}

async function writeAudit(action, actor, details = {}) {
    if (mongoose.connection.readyState !== 1) return null;
    try {
        const { AffiliateAuditEvent } = models();
        const { affiliateProfileId, targetId, ...safeDetails } = details || {};
        return await AffiliateAuditEvent.create({
            action: String(action).slice(0, 120), actor: String(actor || 'admin').slice(0, 160),
            affiliateProfileId: affiliateProfileId || null, targetId: targetId ? String(targetId).slice(0, 160) : null,
            details: safeDetails
        });
    } catch (_) { return null; }
}

function hashRequestPart(value, secret = cookieSecret()) {
    return crypto.createHmac('sha256', String(secret || 'fallback')).update(String(value || '')).digest('hex').slice(0, 32);
}

function safeDestination(value) {
    const target = String(value || DEFAULT_APP_SUMO_DESTINATION).toLowerCase();
    return ['appsumo', 'pricing', 'home'].includes(target) ? target : DEFAULT_APP_SUMO_DESTINATION;
}

async function findProfileForReferral(referral, { userId = null, now = new Date() } = {}) {
    if (!referral || mongoose.connection.readyState !== 1) return null;
    const { AffiliateProfile, ReferralClick } = models();
    // `termsVersion` is intentionally not required here so genuinely invited
    // ambassadors who accepted the original unversioned Release-1 terms keep
    // working. New activations always record CURRENT_TERMS_VERSION.
    const profile = await AffiliateProfile.findOne({
        slug: referral.slug,
        status: 'active',
        invitedAt: { $ne: null },
        termsAcceptedAt: { $ne: null }
    }).lean();
    if (!profile || (userId && String(profile.userId) === String(userId))) return null;
    const click = await ReferralClick.findOne({
        clickId: referral.clickId,
        affiliateProfileId: profile._id,
        expiresAt: { $gt: now }
    }).lean();
    return click ? { profile, click } : null;
}

async function buildCheckoutMetadata({ req, user } = {}) {
    if (!isEnabled() || !req || !user) return {};
    // A referral may create a new account, but it must never turn an existing
    // customer’s upgrade or second purchase into a new-customer commission.
    if (user.appsumoRedeemedAt || user.stripeCustomerId || user.stripeSubscriptionId) return {};
    try {
        const referral = referralFromRequest(req);
        const matched = await findProfileForReferral(referral, { userId: user._id });
        if (!matched) return {};
        return {
            affiliateProfileId: String(matched.profile._id),
            affiliateSlug: String(matched.profile.slug),
            referralClickId: String(matched.click.clickId),
            referralClickedAt: new Date(matched.click.clickedAt).toISOString()
        };
    } catch (_) { return {}; }
}

async function recordReferralClick({ profile, clickId, destination, landingPath, req } = {}) {
    if (!profile || !clickId || mongoose.connection.readyState !== 1) return null;
    const { ReferralClick } = models();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + attributionDays() * 86400000);
    return ReferralClick.create({
        clickId, affiliateProfileId: profile._id, slug: profile.slug,
        destination: safeDestination(destination), landingPath: String(landingPath || '').slice(0, 240) || null,
        referrerDomain: (() => { try { return new URL(String(req?.headers?.referer || '')).hostname.replace(/^www\./, '').slice(0, 120) || null; } catch (_) { return null; } })(),
        ipHash: req?.ip ? hashRequestPart(req.ip) : null,
        userAgentHash: req?.headers?.['user-agent'] ? hashRequestPart(req.headers['user-agent']) : null,
        clickedAt: now, expiresAt
    });
}

async function recordAppSumoActivation({ user, referral, licenseKey, tier, track, existingCustomer = false } = {}) {
    if (!isEnabled() || !user || !referral || !licenseKey || mongoose.connection.readyState !== 1) return { recorded: false, reason: 'not_eligible' };
    if (existingCustomer || user.appsumoRedeemedAt || user.stripeCustomerId || user.stripeSubscriptionId) return { recorded: false, reason: 'existing_customer' };
    try {
        const matched = await findProfileForReferral(referral, { userId: user._id });
        if (!matched) return { recorded: false, reason: 'invalid_or_self_referral' };
        const { ReferralOrder, ReferralClick } = models();
        const order = await ReferralOrder.findOneAndUpdate(
            { provider: 'appsumo', providerOrderId: String(licenseKey) },
            { $set: {
                affiliateProfileId: matched.profile._id, referralClickId: matched.click.clickId,
                customerUserId: user._id, planId: `appsumo-tier-${Number(tier) || 1}`,
                status: 'pending_reconciliation', purchasedAt: new Date(), metadata: { tier: Number(tier) || 1 }
            } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        await ReferralClick.updateOne({ _id: matched.click._id }, { $set: { convertedAt: new Date() } });
        await writeAudit('appsumo_referral_recorded', 'system', { affiliateProfileId: matched.profile._id, targetId: String(order._id), providerOrderId: String(licenseKey) });
        if (typeof track === 'function') track('appsumo_activation', user._id, 'AppSumo', { affiliateProfileId: String(matched.profile._id), referralClickId: matched.click.clickId });
        return { recorded: true, orderId: order._id, profileId: matched.profile._id };
    } catch (error) {
        if (error?.code === 11000) return { recorded: true, duplicate: true };
        return { recorded: false, reason: 'storage_error' };
    }
}

function stripeMetadataFromObject(payload = {}) {
    const candidates = [
        payload.metadata,
        payload.parent?.subscription_details?.metadata,
        payload.subscription_details?.metadata,
        payload.lines?.data?.[0]?.metadata
    ];
    return candidates.find((value) => value && typeof value === 'object' && (value.affiliateProfileId || value.referralClickId)) || {};
}

function stripeObjectId(value) {
    if (typeof value === 'string') return value.trim() || null;
    if (value && typeof value === 'object' && typeof value.id === 'string') return value.id.trim() || null;
    return null;
}

function stripeReversalIdentifiers(payload = {}, eventType = '') {
    const type = String(eventType || '');
    const metadata = payload && typeof payload.metadata === 'object' ? payload.metadata : {};
    const refundRows = Array.isArray(payload?.refunds?.data) ? payload.refunds.data : [];
    return {
        invoiceId: stripeObjectId(payload.invoice) || stripeObjectId(metadata.invoiceId),
        paymentIntentId: stripeObjectId(payload.payment_intent || payload.paymentIntent) || stripeObjectId(metadata.paymentIntentId),
        chargeId: type === 'charge.refunded'
            ? stripeObjectId(payload.id)
            : (stripeObjectId(payload.charge) || stripeObjectId(metadata.chargeId)),
        checkoutSessionId: stripeObjectId(metadata.checkoutSessionId),
        refundIds: refundRows.map((row) => stripeObjectId(row)).filter(Boolean)
            .concat(type === 'refund.created' ? [stripeObjectId(payload.id)].filter(Boolean) : [])
    };
}

async function findStripeOrderForReversal(payload, eventType) {
    const { ReferralOrder, Commission } = models();
    const ids = stripeReversalIdentifiers(payload, eventType);
    const clauses = [];
    if (ids.invoiceId) clauses.push({ 'metadata.invoiceId': ids.invoiceId });
    if (ids.paymentIntentId) clauses.push({ 'metadata.paymentIntentId': ids.paymentIntentId });
    if (ids.chargeId) clauses.push({ 'metadata.chargeId': ids.chargeId });
    if (ids.checkoutSessionId) clauses.push({ providerOrderId: ids.checkoutSessionId });

    const candidateIds = new Set();
    if (clauses.length) {
        const rows = await ReferralOrder.find({ provider: 'stripe', $or: clauses }, { _id: 1 }).limit(3).lean();
        rows.forEach((row) => candidateIds.add(String(row._id)));
    }
    // Older attributed orders may predate the metadata fields. The commission
    // invoice id remains an exact, non-customer fallback for those records.
    if (ids.invoiceId) {
        const rows = await Commission.find({ provider: 'stripe', invoiceId: ids.invoiceId }, { referralOrderId: 1 }).limit(3).lean();
        rows.forEach((row) => candidateIds.add(String(row.referralOrderId)));
    }
    if (!candidateIds.size) return { order: null, ids, reason: 'no_order' };
    if (candidateIds.size !== 1) return { order: null, ids, reason: 'ambiguous_order' };
    const order = await ReferralOrder.findOne({ _id: [...candidateIds][0], provider: 'stripe' });
    return order ? { order, ids, reason: null } : { order: null, ids, reason: 'no_order' };
}

async function findStripeCommissionForReversal(orderId, ids) {
    const { Commission } = models();
    const clauses = [];
    if (ids.invoiceId) clauses.push({ invoiceId: ids.invoiceId });
    if (ids.paymentIntentId) clauses.push({ paymentIntentId: ids.paymentIntentId });
    if (ids.chargeId) clauses.push({ chargeId: ids.chargeId });
    if (!clauses.length) return { commission: null, reason: 'no_commission_identifier' };
    const rows = await Commission.find({
        referralOrderId: orderId,
        provider: 'stripe',
        $or: clauses
    }).limit(2);
    if (rows.length !== 1) {
        return { commission: null, reason: rows.length ? 'ambiguous_commission' : 'no_commission' };
    }
    return { commission: rows[0], reason: null };
}

async function recordStripeCheckout({ payload, user } = {}) {
    if (!isEnabled() || !payload || mongoose.connection.readyState !== 1) return { recorded: false, reason: 'disabled' };
    const metadata = stripeMetadataFromObject(payload);
    if (!metadata.affiliateProfileId || !metadata.referralClickId) return { recorded: false, reason: 'no_referral' };
    try {
        const { AffiliateProfile, ReferralClick, ReferralOrder } = models();
        const profile = await AffiliateProfile.findOne({ _id: metadata.affiliateProfileId, status: 'active' });
        const click = await ReferralClick.findOne({ clickId: metadata.referralClickId, affiliateProfileId: metadata.affiliateProfileId, expiresAt: { $gt: new Date() } });
        if (!profile || !click || (user && String(profile.userId) === String(user._id))) return { recorded: false, reason: 'invalid_or_self_referral' };
        const order = await ReferralOrder.findOneAndUpdate(
            { provider: 'stripe', providerOrderId: String(payload.id) },
            { $set: {
                providerCustomerId: stripeObjectId(payload.customer), subscriptionId: stripeObjectId(payload.subscription),
                affiliateProfileId: profile._id, referralClickId: click.clickId, customerUserId: user?._id || null,
                planId: metadata.planId || null, billingInterval: metadata.billingInterval || null,
                status: 'checkout_started', metadata: {
                    checkoutSessionId: String(payload.id),
                    paymentIntentId: stripeObjectId(payload.payment_intent),
                    invoiceId: stripeObjectId(payload.invoice),
                    chargeId: stripeObjectId(payload.charge)
                }
            } },
            { upsert: true, new: true, setDefaultsOnInsert: true }
        );
        return { recorded: true, orderId: order._id, profileId: profile._id };
    } catch (_) { return { recorded: false, reason: 'storage_error' }; }
}

async function recordStripeInvoicePaid({ payload, eventId, userLookup } = {}) {
    if (!isEnabled() || !payload || mongoose.connection.readyState !== 1) return { recorded: false, reason: 'disabled' };
    const { ProcessedWebhookEvent, ReferralOrder, Commission, ReferralClick } = models();
    const id = String(eventId || payload.id || '');
    if (!id) return { recorded: false, reason: 'missing_event_id' };
    const metadata = stripeMetadataFromObject(payload);
    const subscriptionId = typeof payload.subscription === 'string' ? payload.subscription : payload.subscription?.id;
    const exactOrderClauses = [
        ...(subscriptionId ? [{ subscriptionId }] : []),
        ...(metadata.affiliateProfileId && metadata.referralClickId
            ? [{ affiliateProfileId: metadata.affiliateProfileId, referralClickId: metadata.referralClickId }]
            : [])
    ];
    if (!exactOrderClauses.length) return { recorded: false, reason: 'no_attributed_order' };
    const matchingOrders = await ReferralOrder.find({ provider: 'stripe', $or: exactOrderClauses }).sort({ createdAt: -1 }).limit(2);
    if (matchingOrders.length !== 1) return { recorded: false, reason: matchingOrders.length ? 'ambiguous_attributed_order' : 'no_attributed_order' };
    const order = matchingOrders[0];
    if (order.status === 'ineligible_existing_customer') return { recorded: false, reason: 'no_attributed_order' };
    try {
        await ProcessedWebhookEvent.create({ provider: 'stripe', eventId: id, eventType: 'invoice.paid' });
    } catch (error) {
        if (error?.code === 11000) return { recorded: false, duplicate: true };
        return { recorded: false, reason: 'ledger_error' };
    }
    // New accounts are necessarily created before their first Checkout, so a
    // `createdAt < order.createdAt` comparison cannot identify an existing
    // customer. Existing-customer upgrades never receive affiliate metadata
    // in buildCheckoutMetadata; retain this lookup only for an explicit
    // snapshot recorded by a trusted checkout caller.
    if (userLookup && order.customerUserId && order.metadata?.affiliateExistingCustomer === true) {
        order.status = 'ineligible_existing_customer'; await order.save(); return { recorded: false, reason: 'existing_customer' };
    }
    const interval = order.billingInterval || metadata.billingInterval || 'month';
    const priorCount = await Commission.countDocuments({ referralOrderId: order._id, provider: 'stripe' });
    const sequence = priorCount + 1;
    if (interval === 'year' ? !isAnnualEligible(sequence) : !isMonthlyEligible(sequence)) {
        order.status = 'paid'; order.purchasedAt = order.purchasedAt || new Date((payload.status_transitions?.paid_at || payload.created || Date.now()) * 1000); await order.save();
        return { recorded: false, reason: 'outside_commission_window' };
    }
    const gross = Number(payload.total_excluding_tax ?? payload.amount_paid ?? payload.amount_due ?? 0);
    const calculation = calculateCommission({ eligibleBasisMinor: gross, planId: order.planId || metadata.planId, billingInterval: interval });
    if (calculation.amountMinor <= 0) return { recorded: false, reason: 'zero_invoice' };
    const commission = await Commission.findOneAndUpdate(
        { referralOrderId: order._id, invoiceId: String(payload.id) },
        { $setOnInsert: {
            affiliateProfileId: order.affiliateProfileId, referralOrderId: order._id, provider: 'stripe', invoiceId: String(payload.id), sequence,
            paymentIntentId: stripeObjectId(payload.payment_intent), chargeId: stripeObjectId(payload.charge),
            currency: String(payload.currency || order.currency || 'usd').toLowerCase(), basisMinor: calculation.basisMinor,
            rateBps: calculation.rateBps, amountMinor: calculation.amountMinor,
            holdUntil: new Date(Date.now() + 30 * 86400000), status: 'pending'
        } },
        { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    order.status = 'paid'; order.grossCollectedMinor = gross; order.eligibleBasisMinor = calculation.basisMinor; order.purchasedAt = order.purchasedAt || new Date();
    order.metadata = {
        ...(order.metadata || {}),
        invoiceId: String(payload.id),
        paymentIntentId: stripeObjectId(payload.payment_intent) || order.metadata?.paymentIntentId || null,
        chargeId: stripeObjectId(payload.charge) || order.metadata?.chargeId || null
    };
    order.markModified('metadata');
    await order.save();
    await ReferralClick.updateOne({ clickId: order.referralClickId }, { $set: { convertedAt: order.purchasedAt } });
    return { recorded: true, commissionId: commission._id, amountMinor: calculation.amountMinor, sequence };
}

async function reverseStripeCommission({ payload, reason = 'refund', eventId, eventType } = {}) {
    if (!isEnabled() || !payload || mongoose.connection.readyState !== 1) return { reversed: false, reason: 'disabled' };
    const { ProcessedWebhookEvent } = models();
    const id = String(eventId || '');
    const type = String(eventType || (reason === 'dispute' ? 'charge.dispute.created' : 'refund.created'));
    if (!id) return { reversed: false, reason: 'missing_event_id' };
    const matched = await findStripeOrderForReversal(payload, type);
    if (!matched.order) return { reversed: false, reason: matched.reason };
    const order = matched.order;
    const commissionMatch = await findStripeCommissionForReversal(order._id, matched.ids);
    if (!commissionMatch.commission) return { reversed: false, reason: commissionMatch.reason };
    const commission = commissionMatch.commission;

    let ledger;
    try {
        ledger = await ProcessedWebhookEvent.create({ provider: 'stripe', eventId: id, eventType: type });
    } catch (error) {
        if (error?.code === 11000) return { reversed: false, duplicate: true };
        return { reversed: false, reason: 'ledger_error' };
    }

    try {
        const metadata = { ...(commission.reversalMetadata || {}) };
        const processedRefundIds = new Set(Array.isArray(metadata.processedRefundIds) ? metadata.processedRefundIds.map(String) : []);
        const alreadyKnownRefund = matched.ids.refundIds.some((refundId) => processedRefundIds.has(refundId));
        const cumulativeAmount = Number(payload.amount_refunded);
        const incrementalAmount = Number(payload.amount);
        const reconstructedRefundBasis = Number(commission.rateBps || 0) > 0
            ? Math.ceil(Number(commission.reversalMinor || 0) * 10000 / Number(commission.rateBps))
            : 0;
        let refundTotal = Math.max(Number(commission.refundedBasisMinor || 0), reconstructedRefundBasis);

        if (reason !== 'dispute') {
            if (type === 'charge.refunded') {
                if (!Number.isFinite(cumulativeAmount) || cumulativeAmount < 0) {
                    ledger.result = 'invalid_refund_amount'; await ledger.save();
                    return { reversed: false, reason: 'invalid_refund_amount' };
                }
                refundTotal = Math.max(refundTotal, Math.floor(cumulativeAmount));
                metadata.stripeRefundMode = 'cumulative';
            } else if (alreadyKnownRefund) {
                ledger.result = 'duplicate_refund_object'; await ledger.save();
                return { reversed: false, duplicate: true };
            } else if (metadata.stripeRefundMode === 'cumulative') {
                // A charge.refunded event has already supplied Stripe's
                // authoritative cumulative amount. Do not add the same refund
                // again when its refund.created companion arrives.
                matched.ids.refundIds.forEach((refundId) => processedRefundIds.add(refundId));
                metadata.processedRefundIds = [...processedRefundIds].slice(-100);
                commission.reversalMetadata = metadata; commission.markModified('reversalMetadata'); await commission.save();
                ledger.result = 'covered_by_cumulative_refund'; await ledger.save();
                return { reversed: false, duplicate: true };
            } else {
                if (!Number.isFinite(incrementalAmount) || incrementalAmount < 0) {
                    ledger.result = 'invalid_refund_amount'; await ledger.save();
                    return { reversed: false, reason: 'invalid_refund_amount' };
                }
                refundTotal = Math.max(0, refundTotal + Math.floor(incrementalAmount));
                metadata.stripeRefundMode = 'incremental';
            }
        }

        matched.ids.refundIds.forEach((refundId) => processedRefundIds.add(refundId));
        metadata.processedRefundIds = [...processedRefundIds].slice(-100);
        const reversal = reason === 'dispute'
            ? Number(commission.amountMinor || 0)
            : Math.min(Number(commission.amountMinor || 0), Math.floor(refundTotal * Number(commission.rateBps || 0) / 10000));
        const prior = Number(commission.reversalMinor || 0);
        commission.reversalMinor = Math.max(prior, reversal);
        commission.refundedBasisMinor = Math.max(Number(commission.refundedBasisMinor || 0), refundTotal);
        commission.reversalMetadata = metadata;
        commission.markModified('reversalMetadata');
        if (reason === 'dispute' || commission.reversalMinor >= commission.amountMinor) commission.status = 'reversed';
        commission.reason = String(reason).slice(0, 240);
        const changed = commission.isModified() ? 1 : 0;
        if (changed) await commission.save();
        const aggregate = await models().Commission.aggregate([
            { $match: { referralOrderId: order._id, provider: 'stripe' } },
            { $group: { _id: null, total: { $sum: '$refundedBasisMinor' } } }
        ]);
        order.refundedMinor = Math.max(0, Number(aggregate[0]?.total || 0));
        order.status = reason === 'dispute' ? 'disputed' : 'refunded';
        order.refundedAt = new Date();
        await order.save();
        ledger.result = reason === 'dispute' ? 'disputed' : `refunded:${order.refundedMinor}`; await ledger.save();
        return { reversed: changed > 0, commissions: 1, changed, refundedMinor: order.refundedMinor };
    } catch (error) {
        // Release the idempotency claim when storage failed so Stripe's retry
        // can finish the operation. All monetary updates use max/cumulative
        // semantics and are safe to repeat after a partial write.
        if (ledger?._id) await ProcessedWebhookEvent.deleteOne({ _id: ledger._id }).catch(() => {});
        throw error;
    }
}

async function reverseAppSumoCommission({ licenseKey, reason = 'AppSumo refund/deactivation' } = {}) {
    if (!isEnabled() || !licenseKey || mongoose.connection.readyState !== 1) return { reversed: false, reason: 'disabled' };
    const { ReferralOrder, Commission } = models();
    const order = await ReferralOrder.findOne({ provider: 'appsumo', providerOrderId: String(licenseKey) });
    if (!order) return { reversed: false, reason: 'no_order' };
    const commissions = await Commission.find({ referralOrderId: order._id, status: { $in: ['pending', 'approved', 'paid'] } });
    for (const commission of commissions) {
        commission.reversalMinor = Math.max(commission.reversalMinor || 0, commission.amountMinor || 0);
        commission.status = 'reversed'; commission.reason = String(reason).slice(0, 240); await commission.save();
    }
    order.status = 'refunded'; order.refundedAt = new Date(); await order.save();
    return { reversed: true, commissions: commissions.length };
}

async function reconcileAppSumoCsv({ csv, dryRun = true, actor = 'admin', track, mapping = {} } = {}) {
    const text = String(csv || '');
    const rows = parseCsv(text);
    const result = { dryRun: Boolean(dryRun), rows: rows.length, matched: 0, updated: 0, unchanged: 0, commissions: 0, reversed: 0, unmatched: [], errors: [] };
    if (dryRun || mongoose.connection.readyState !== 1) return { ...result, preview: rows.slice(0, 100).map((row) => normalizeAppSumoRow(row, mapping)) };
    const { ReferralOrder, Commission } = models();
    for (const raw of rows) {
        const row = normalizeAppSumoRow(raw, mapping);
        if (!row.providerOrderId || !row.netProceedsMinor && row.netProceedsMinor !== 0) { result.errors.push('row missing license/order or net proceeds'); continue; }
        const order = await ReferralOrder.findOne({ provider: 'appsumo', providerOrderId: row.providerOrderId });
        if (!order) { result.unmatched.push(row.providerOrderId); continue; }
        result.matched++;
        const refunded = row.refundedMinor > 0 || /refund|chargeback|deactivat/i.test(row.status);
        // A refund row can still carry the original partner proceeds. Keep
        // that original basis so the commission can be reversed rather than
        // overwritten with a zero-value commission.
        const originalBasis = Number(order.eligibleBasisMinor || 0);
        const basis = refunded
            ? Math.max(originalBasis, Number(row.netProceedsMinor || 0))
            : Math.max(0, row.netProceedsMinor - row.refundedMinor);
        order.grossCollectedMinor = row.grossMinor == null ? order.grossCollectedMinor : row.grossMinor;
        order.eligibleBasisMinor = basis; order.refundedMinor = row.refundedMinor; order.status = refunded ? 'refunded' : 'paid';
        const calculation = calculateCommission({ eligibleBasisMinor: order.eligibleBasisMinor, appsumo: true });
        const existing = await Commission.findOne({ referralOrderId: order._id, provider: 'appsumo', invoiceId: `appsumo:${row.providerOrderId}` });
        const amountMinor = refunded && existing ? Number(existing.amountMinor || 0) : calculation.amountMinor;
        let commission = existing;
        let created = false;
        let reversedNow = false;
        if (!commission) {
            commission = await Commission.create({
                affiliateProfileId: order.affiliateProfileId, referralOrderId: order._id, provider: 'appsumo', invoiceId: `appsumo:${row.providerOrderId}`, sequence: 1,
                currency: row.currency, basisMinor: calculation.basisMinor, rateBps: calculation.rateBps, amountMinor,
                reversalMinor: refunded ? amountMinor : 0,
                holdUntil: new Date(Date.now() + 60 * 86400000), status: refunded ? 'reversed' : 'pending', reason: refunded ? 'AppSumo refund/deactivation' : null
            });
            created = true;
            reversedNow = refunded;
        } else {
            const wasReversed = commission.status === 'reversed';
            commission.currency = row.currency;
            commission.basisMinor = calculation.basisMinor;
            commission.rateBps = calculation.rateBps;
            commission.amountMinor = amountMinor;
            commission.reversalMinor = refunded ? amountMinor : 0;
            if (refunded) {
                commission.status = 'reversed'; commission.reason = 'AppSumo refund/deactivation';
                reversedNow = !wasReversed;
            } else {
                // Re-importing the same paid row must not move an existing hold
                // or downgrade an approved/paid commission back to pending.
                if (wasReversed) commission.status = 'pending';
                commission.reason = null;
            }
        }
        const orderChanged = order.isModified();
        const commissionChanged = !created && commission.isModified();
        if (orderChanged) await order.save();
        if (commissionChanged) await commission.save();
        if (created) result.commissions++;
        if (reversedNow) result.reversed++;
        if (created || orderChanged || commissionChanged) result.updated++;
        else result.unchanged++;
        if (typeof track === 'function' && created) track(refunded ? 'commission_reversed' : 'commission_created', null, 'AppSumo', { affiliateProfileId: String(order.affiliateProfileId), amountMinor: calculation.amountMinor });
        else if (typeof track === 'function' && reversedNow) track('commission_reversed', null, 'AppSumo', { affiliateProfileId: String(order.affiliateProfileId), amountMinor });
    }
    await writeAudit('appsumo_csv_reconciled', actor, { rows: result.rows, matched: result.matched, updated: result.updated, unmatched: result.unmatched.length });
    return result;
}

function parseCsv(text) {
    const rows = []; let row = []; let cell = ''; let quoted = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === '"') { if (quoted && text[i + 1] === '"') { cell += '"'; i++; } else quoted = !quoted; continue; }
        if (ch === ',' && !quoted) { row.push(cell); cell = ''; continue; }
        if ((ch === '\n' || ch === '\r') && !quoted) { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); if (row.some((v) => String(v).trim())) rows.push(row); row = []; cell = ''; continue; }
        cell += ch;
    }
    if (cell || row.length) { row.push(cell); if (row.some((v) => String(v).trim())) rows.push(row); }
    if (!rows.length) return [];
    const headers = rows.shift().map((v) => String(v).replace(/^\uFEFF/, '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'));
    return rows.map((values) => Object.fromEntries(headers.map((h, i) => [h, values[i] == null ? '' : String(values[i]).trim()])));
}

function parseMinor(value) {
    const raw = String(value == null ? '' : value).trim();
    if (!raw) return null;
    const n = Number(raw.replace(/[^0-9.-]/g, ''));
    if (!Number.isFinite(n)) return null;
    return Math.round(n * 100);
}

function normalizeAppSumoRow(raw = {}, mapping = {}) {
    const mapped = (name) => String(mapping?.[name] || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_');
    const get = (...keys) => [...keys.map(mapped).filter(Boolean), ...keys].map((key) => raw[key]).find((value) => value != null && String(value).trim() !== '') || '';
    return {
        providerOrderId: String(get('license_key', 'license', 'order_id', 'order', 'transaction_id', 'transaction')).trim().slice(0, 160),
        status: String(get('status', 'order_status', 'event')).trim().toLowerCase().slice(0, 80),
        currency: String(get('currency', 'currency_code') || 'usd').trim().toLowerCase().slice(0, 8),
        grossMinor: parseMinor(get('gross', 'gross_sales', 'sale_amount', 'amount')),
        netProceedsMinor: parseMinor(get('net_proceeds', 'partner_proceeds', 'net', 'payout', 'proceeds')),
        refundedMinor: parseMinor(get('refunded', 'refund_amount', 'chargeback')) || 0
    };
}

module.exports = {
    COOKIE_NAME,
    CURRENT_TERMS_VERSION,
    STRIPE_COMMISSION_RATE_BPS,
    STATUS_VALUES,
    PROFILE_STATUS_VALUES,
    DEFAULT_ATTRIBUTION_DAYS,
    isEnabled,
    attributionDays,
    cookieSecret,
    appSumoUrl,
    safeDestination,
    randomId,
    slugify,
    createReferralCookieValue,
    parseReferralCookieValue,
    parseCookieHeader,
    referralFromRequest,
    serializeReferralCookie,
    commissionRateBps,
    calculateCommission,
    summarizeCommissionsByCurrency,
    combineCommissionCurrencyTotals,
    selectPayoutEligibleCommissions,
    isMonthlyEligible,
    isAnnualEligible,
    hasVerifiedStripeSubscription,
    canAcceptAmbassadorInvite,
    models,
    publicProfile,
    writeAudit,
    hashRequestPart,
    findProfileForReferral,
    buildCheckoutMetadata,
    recordReferralClick,
    recordAppSumoActivation,
    recordStripeCheckout,
    recordStripeInvoicePaid,
    reverseStripeCommission,
    reverseAppSumoCommission,
    reconcileAppSumoCsv,
    parseCsv,
    normalizeAppSumoRow,
    stripeMetadataFromObject,
    stripeObjectId,
    stripeReversalIdentifiers,
    findStripeOrderForReversal,
    findStripeCommissionForReversal
};
