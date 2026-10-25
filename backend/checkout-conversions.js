'use strict';

const { createHash } = require('node:crypto');

// Called only after a successful paid-first checkout claim. Do not give ad
// tags customer identity or the bearer-like Stripe Checkout Session ID.
function paidSignupConversion(session, { accountCreated = false, userId, internal = false } = {}) {
    if (internal || !session || session.livemode !== true || session.payment_status !== 'paid' ||
        session.mode !== 'subscription' || !session.metadata?.pendingSignupId ||
        !/^cs_live_[A-Za-z0-9_]+$/.test(session.id || '') ||
        !Number.isSafeInteger(session.amount_total) || session.amount_total <= 0 ||
        !/^[a-z]{3}$/i.test(session.currency || '')) return null;
    const currency = session.currency.toUpperCase();
    let digits;
    try { digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits; }
    catch (_) { return null; }
    const opaqueId = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
    return {
        transactionId: 'checkout_' + opaqueId(session.id),
        value: session.amount_total / (10 ** digits),
        currency,
        signupId: accountCreated && userId ? 'signup_' + opaqueId(userId) : null
    };
}

module.exports = { paidSignupConversion };
