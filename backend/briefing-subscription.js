'use strict';

// The paid research briefing — two companies a month, written by hand, sold
// as its own annual subscription and NOT as part of any app plan or lifetime
// deal.
//
// It is deliberately a separate module and a separate Stripe product from the
// "Intelligence founding" $149/yr SKU (prod_VBJ9tuIAexvOf8). That SKU is an
// in-app feature attach; this one buys a newsletter and nothing else. Sharing
// one price between them would put the wrong product name on the buyer's card
// statement and make revenue reporting unable to tell the two apart — the same
// reason direct-ltd.js keeps its channel tag distinct from 'appsumo'.
//
// The important structural difference from every other paid thing here: a
// briefing buyer is NOT necessarily a user. The Stripe payment link can be
// opened by anyone, so this path must work with no userId at all, keyed only
// on the email Stripe collected. Nothing in it grants app entitlements, so
// there is no account to find and none to create.

const mongoose = require('mongoose');

const CHECKOUT_TYPE = 'briefing_annual';
const PRODUCT_LABEL = 'Research Briefing';

// Two names a month. Stated here because the welcome email promises it and a
// cadence promise that drifts from the product is the one thing a subscriber
// will notice immediately.
const COMPANIES_PER_MONTH = 2;

function priceId(env = process.env) {
    return String(env.STRIPE_PRICE_ID_BRIEFING_ANNUAL || '').trim();
}

function priceUsd(env = process.env) {
    const raw = Number(env.BRIEFING_ANNUAL_USD);
    return Number.isFinite(raw) && raw > 0 ? raw : 149;
}

// Unset price id means "not selling yet", exactly like DIRECT_LTD_ENABLED
// gates the direct ladder. Fail closed on the sale, never on an existing one.
function enabled(env = process.env) {
    return Boolean(priceId(env));
}

/**
 * Two independent ways to recognise a briefing checkout, because either one
 * alone has a real failure mode:
 *
 *   - metadata.checkoutType is what the rest of this webhook keys on, but a
 *     Stripe Payment Link only carries it if whoever built the link in the
 *     dashboard remembered to add it. A forgotten field would silently sell
 *     the product and deliver nothing.
 *   - the price id is impossible to forget (it IS the thing being bought) but
 *     requires an extra listLineItems() round trip, so it is the fallback.
 *
 * Either match is sufficient. Both being checked means the dashboard and the
 * env var have to BOTH be wrong before a paid buyer goes unnoticed.
 */
function matches(payload, lineItemPriceIds, env = process.env) {
    if (payload && payload.metadata && payload.metadata.checkoutType === CHECKOUT_TYPE) return true;
    const want = priceId(env);
    if (!want) return false;
    return (Array.isArray(lineItemPriceIds) ? lineItemPriceIds : [])
        .some((id) => String(id || '').trim() === want);
}

function subscriberCol() { return mongoose.connection.collection('briefing_subscribers'); }

function buyerEmail(payload) {
    const fromDetails = payload && payload.customer_details && payload.customer_details.email;
    return String(fromDetails || (payload && payload.customer_email) || '').trim().toLowerCase();
}

function buyerName(payload) {
    const n = payload && payload.customer_details && payload.customer_details.name;
    return String(n || '').trim();
}

/**
 * Idempotent on the Stripe checkout session id, same contract as
 * credits.grant(): the webhook fires once but redelivers whenever our ack is
 * late, and a redelivery must not produce a second subscriber row or a second
 * welcome email. Returns true ONLY when a row was actually inserted, so the
 * caller can use it to decide whether to send mail.
 */
async function record({ payload, eventId, env = process.env } = {}) {
    const email = buyerEmail(payload);
    if (!email) {
        console.warn(`[briefing] session ${payload && payload.id} paid but carried no customer email; nothing recorded.`);
        return false;
    }
    try {
        const sessionId = String(payload.id || '');
        if (sessionId) {
            const existing = await subscriberCol().countDocuments({ stripeSessionId: sessionId });
            if (existing) return false;
        }
        await subscriberCol().insertOne({
            email,
            name: buyerName(payload) || null,
            status: 'active',
            stripeSessionId: sessionId || null,
            stripeCustomerId: payload.customer || null,
            stripeSubscriptionId: payload.subscription || null,
            stripeEventId: eventId || null,
            priceUsd: priceUsd(env),
            // Whether the buyer also holds an app account. Recorded, never
            // required — an LTD holder buying the briefing is a second,
            // unrelated purchase and must not touch their app entitlement.
            userId: (payload.metadata && payload.metadata.userId) || null,
            livemode: payload.livemode !== false,
            subscribedAt: new Date()
        });
        return true;
    } catch (error) {
        console.error('[briefing] subscriber record failed:', error && error.message);
        return false;
    }
}

/** Cancellation arrives as customer.subscription.deleted; mark, never delete. */
async function deactivate(stripeSubscriptionId) {
    const id = String(stripeSubscriptionId || '').trim();
    if (!id) return false;
    try {
        const r = await subscriberCol().updateOne(
            { stripeSubscriptionId: id, status: 'active' },
            { $set: { status: 'cancelled', cancelledAt: new Date() } }
        );
        return r.modifiedCount > 0;
    } catch (error) {
        console.error('[briefing] deactivate failed:', error && error.message);
        return false;
    }
}

/** The live send list. Used by the issue-sending script, not by any route. */
async function activeSubscribers() {
    try {
        return await subscriberCol().find({ status: 'active' }).project({ email: 1, name: 1, _id: 0 }).toArray();
    } catch (error) {
        console.error('[briefing] subscriber list failed:', error && error.message);
        return [];
    }
}

module.exports = {
    CHECKOUT_TYPE, PRODUCT_LABEL, COMPANIES_PER_MONTH,
    priceId, priceUsd, enabled, matches,
    buyerEmail, buyerName,
    record, deactivate, activeSubscribers
};
