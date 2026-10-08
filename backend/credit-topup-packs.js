'use strict';

// Larger credit refills (owner decision 2026-10-08). The connector spends in
// bursts — the first paying connector customer used a 100-credit month in 28
// minutes — and one 150-credit pack is seven checkouts for a 500-company pull.
// Same rate as the base $14.99 / 150 pack, 10 credits per dollar, so no pack
// undercuts another and the only thing a bigger one buys is fewer trips to
// checkout.
//
// This table is the whole authority. The client sends a pack id, never an
// amount or a credit count; checkout creates the session at this amount with
// inline price_data (no Stripe price to create, drift or leave inactive); and
// the webhook grants only when the paid total matches this table again.
//
// Dependency-free on purpose: the out-of-credits responses (api-response.js)
// and the nudge email (connector-nudge.js) quote these sizes and must not pull
// in the database to do it.
const PACKS = Object.freeze({
    50: Object.freeze({ usd: 50, credits: 500 }),
    100: Object.freeze({ usd: 100, credits: 1000 }),
    250: Object.freeze({ usd: 250, credits: 2500 }),
    500: Object.freeze({ usd: 500, credits: 5000 })
});

function pack(id) {
    const key = String(id == null ? '' : id);
    return Object.prototype.hasOwnProperty.call(PACKS, key) ? PACKS[key] : null;
}

// True when a completed session that names a pack paid exactly what that pack
// costs and carries exactly its credits. A session with no pack is the base
// refill and is not this function's business.
function settled(payload) {
    const meta = (payload && payload.metadata) || {};
    const p = pack(meta.pack);
    return Boolean(p
        && Number(payload.amount_total) === p.usd * 100
        && String(payload.currency || '').toLowerCase() === 'usd'
        && Number(meta.credits) === p.credits);
}

function largest() {
    return Object.values(PACKS).reduce((a, b) => (b.credits > a.credits ? b : a));
}

// "5,000 credits for $500" — the one phrase every out-of-credits message uses.
function largestLabel() {
    const p = largest();
    return `${p.credits.toLocaleString('en-US')} credits for $${p.usd}`;
}

module.exports = { PACKS, pack, settled, largest, largestLabel };
