'use strict';

// Optional GA4 Measurement Protocol augment. It is off by default; browser GA4
// remains the normal consent-gated source for page and intent events. This
// module sends only canonical server events and never receives PII.

const axios = require('axios');
const { createHash } = require('node:crypto');

function enabled() {
    return String(process.env.GA4_MP_ENABLED || '').toLowerCase() === 'true'
        && Boolean(process.env.GA4_MEASUREMENT_ID && process.env.GA4_API_SECRET);
}

function safeParam(value, max = 100) {
    const text = typeof value === 'string' ? value.trim() : '';
    return text ? text.slice(0, max) : undefined;
}

function identityFromCookies(cookies, measurementId = process.env.GA4_MEASUREMENT_ID) {
    const stream = /^G-([A-Z0-9]+)$/.exec(measurementId || '');
    const clientId = /^GA\d+\.\d+\.(\d{1,19}\.\d{1,19})$/.exec(cookies.get('_ga') || '')?.[1];
    if (!stream || !clientId) return null;
    const session = cookies.get(`_ga_${stream[1]}`) || '';
    const sessionId = /^GS1\.\d+\.(\d+)(?:\.|$)/.exec(session)?.[1]
        || (/^GS2\.\d+\./.test(session) && /[.$]s(\d+)(?:\$|$)/.exec(session)?.[1]);
    return { clientId, sessionId: sessionId || null };
}

function acquisitionParams(touch) {
    if (!/^[a-z][a-z0-9_-]{0,99}$/i.test(touch?.campaign || '')) return {};
    return { acquisition_campaign: touch.campaign };
}

function purchaseParams(invoice, planId, isFirstPayment) {
    if (!invoice || invoice.livemode !== true || invoice.status !== 'paid' || !/^in_[A-Za-z0-9]+$/.test(invoice.id || '')
        || !Number.isSafeInteger(invoice.amount_paid) || invoice.amount_paid <= 0 || !/^[a-z]{3}$/i.test(invoice.currency || '')) return null;
    const currency = invoice.currency.toUpperCase();
    const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
    const scale = 10 ** digits;
    const taxMinor = Number.isSafeInteger(invoice.total) && Number.isSafeInteger(invoice.total_excluding_tax)
        ? Math.min(invoice.amount_paid, Math.max(0, invoice.total - invoice.total_excluding_tax)) : 0;
    const value = (invoice.amount_paid - taxMinor) / scale;
    return {
        transaction_id: 'invoice_' + createHash('sha256').update(invoice.id).digest('hex').slice(0, 32),
        currency,
        value,
        ...(taxMinor > 0 && { tax: taxMinor / scale }),
        ...(isFirstPayment && { customer_type: 'new' }),
        subscription_payment: isFirstPayment ? 'first' : 'subsequent',
        items: [{ item_id: /^[a-z0-9-]{1,40}$/.test(planId || '') ? planId : 'subscription', price: value, quantity: 1 }]
    };
}

function buildPayload({ event, clientId, sessionId, opaqueUserId, params = {}, purchase, debug = false, now = Date.now() } = {}) {
    if (!/^[a-z][a-z0-9_]{0,39}$/.test(event || '') || !/^\d{1,19}\.\d{1,19}$/.test(clientId || '')) return null;
    if (event === 'purchase' && !purchase) return null;
    const cleanParams = {};
    for (const [key, value] of Object.entries(params || {})) {
        if (!/^[a-z][a-z0-9_]{0,39}$/.test(key) || /email|name|prompt|answer|holding|license|token|password/i.test(key)) continue;
        if (typeof value === 'boolean' || Number.isFinite(value)) cleanParams[key] = value;
        else if (safeParam(value)) cleanParams[key] = safeParam(value);
    }
    const sessionAgeMs = now - Number(sessionId) * 1000;
    if (/^\d{1,13}$/.test(sessionId || '') && sessionAgeMs >= 0 && sessionAgeMs < 30 * 60 * 1000) {
        cleanParams.session_id = Number(sessionId);
    }
    if (debug) cleanParams.debug_mode = 1;
    return {
        client_id: clientId,
        ...(opaqueUserId ? { user_id: safeParam(opaqueUserId, 80) } : {}),
        events: [{ name: event, params: event === 'purchase' ? { ...cleanParams, ...purchase } : cleanParams }]
    };
}

async function sendServerEvent(options = {}) {
    if (!enabled() || options.consent !== true || options.testFlag || options.internalFlag || options.botFlag) return { sent: false, reason: 'disabled_or_ineligible' };
    const payload = buildPayload(options);
    if (!payload) return { sent: false, reason: 'invalid_payload' };
    const url = `https://www.google-analytics.com/mp/collect?measurement_id=${encodeURIComponent(process.env.GA4_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(process.env.GA4_API_SECRET)}`;
    await axios.post(url, payload, { timeout: 5000, validateStatus: (status) => status >= 200 && status < 300 });
    return { sent: true };
}

function validationUrl() {
    if (!process.env.GA4_MEASUREMENT_ID || !process.env.GA4_API_SECRET) return null;
    return `https://www.google-analytics.com/debug/mp/collect?measurement_id=${encodeURIComponent(process.env.GA4_MEASUREMENT_ID)}&api_secret=${encodeURIComponent(process.env.GA4_API_SECRET)}`;
}

module.exports = { enabled, identityFromCookies, acquisitionParams, purchaseParams, buildPayload, sendServerEvent, validationUrl };
