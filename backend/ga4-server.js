'use strict';

// Optional GA4 Measurement Protocol augment. It is off by default; browser GA4
// remains the normal consent-gated source for page and intent events. This
// module sends only canonical server events and never receives PII.

const axios = require('axios');

function enabled() {
    return String(process.env.GA4_MP_ENABLED || '').toLowerCase() === 'true'
        && Boolean(process.env.GA4_MEASUREMENT_ID && process.env.GA4_API_SECRET);
}

function safeParam(value, max = 120) {
    const text = String(value == null ? '' : value).trim();
    return text ? text.slice(0, max) : undefined;
}

function buildPayload({ event, clientId, sessionId, opaqueUserId, params = {}, debug = false } = {}) {
    if (!event || !clientId) return null;
    const cleanParams = {};
    for (const [key, value] of Object.entries(params || {})) {
        if (!/^[a-z][a-z0-9_]{0,39}$/.test(key) || /email|name|prompt|answer|holding|license|token|password/i.test(key)) continue;
        if (typeof value === 'boolean' || Number.isFinite(value)) cleanParams[key] = value;
        else if (safeParam(value)) cleanParams[key] = safeParam(value);
    }
    if (sessionId) cleanParams.session_id = safeParam(sessionId, 80);
    if (debug) cleanParams.debug_mode = 1;
    return {
        client_id: safeParam(clientId, 80),
        ...(opaqueUserId ? { user_id: safeParam(opaqueUserId, 80) } : {}),
        events: [{ name: safeParam(event, 40), params: cleanParams }]
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

module.exports = { enabled, buildPayload, sendServerEvent, validationUrl };
