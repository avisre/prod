// Shared credit ledger for Ask and Dossier. One pool, so a Dossier isn't
// "free" just because it lives outside the Ask counter, and a heavy Ask month
// doesn't leave zero room for the one Dossier a user actually wanted.
//
// Deliberately NOT wired into MCP yet: mcp-server/src/server.js authenticates
// with a single shared MCP_API_KEY and meters to a local JSON file, with no
// concept of which website user is calling. A shared wallet requires knowing
// whose wallet it is — that identity bridge is tracked separately. Until it
// lands, MCP keeps its own flat quota and this ledger only sees web traffic.
//
// Same append-only-ledger shape as the rest of this codebase's metering
// (ai_chat_usage, company_keypoints, company_dossiers are all raw
// mongoose.connection.collection() access, no formal schema) — collection
// `credit_ledger`, month keyed as an ISO 'YYYY-MM' string exactly like
// ai-chat.js's monthKey(), so both reset on the same calendar boundary with
// no cron job required.
//
// One append per event, not a running counter: gives "why was I charged 12
// credits at 14:03" for free (query the ledger), at the cost of an aggregate
// sum on read instead of an O(1) counter increment — negligible at this
// product's volume, and it avoids a second, dual-written source of truth that
// could drift from the audit trail.

const mongoose = require('mongoose');

const COST = { ask: 2, dossier_standard: 10, dossier_deep: 30 };

function monthKey() { return new Date().toISOString().slice(0, 7); }
function ledgerCol() { return mongoose.connection.collection('credit_ledger'); }

// A used amount of 0 on any error, matching aiChat.getUsage's fail-open
// convention: a metering blip must never block the underlying feature.
async function used(userId) {
    try {
        const rows = await ledgerCol().aggregate([
            { $match: { userId: String(userId), month: monthKey(), delta: { $lt: 0 } } },
            { $group: { _id: null, spent: { $sum: '$delta' } } }
        ]).toArray();
        return rows.length ? -rows[0].spent : 0;
    } catch (_) { return 0; }
}

// One wallet shared with Ask, sized off the Ask limit the user already has
// (effectiveAskLimit — tier, AppSumo cap, env overrides all already resolved
// there) rather than a second, parallel tier table that could drift from it.
// ×2 preserves exactly the Ask capacity already sold: every existing user can
// still ask precisely as many questions as before, with Dossier layered on
// top of the same budget, not carved out of it.
function allowance(effectiveAskLimit) {
    return Math.max(0, Number(effectiveAskLimit) || 0) * 2;
}

async function balance(userId, effectiveAskLimit) {
    const spent = await used(userId);
    const limit = allowance(effectiveAskLimit);
    return { used: spent, allowance: limit, remaining: Math.max(0, limit - spent), month: monthKey() };
}

// Never throws: a failed ledger write must not undo an answer already shown
// to the user, and must not crash the request that's about to respond 200.
// It still logs loudly, because a silently-failing debit is a revenue leak,
// not a safety concern like a failing read.
async function spend(userId, cost, reason, refId) {
    const amount = Number(COST[cost] ?? cost);
    if (!Number.isFinite(amount) || amount <= 0) return;
    try {
        await ledgerCol().insertOne({
            userId: String(userId), month: monthKey(), delta: -amount,
            reason, refId: refId || null, at: new Date()
        });
    } catch (error) { console.error('[credits] spend failed:', error && error.message); }
}

// Read-only check a route can act on BEFORE doing expensive work — does not
// itself spend anything.
async function check(userId, cost, effectiveAskLimit) {
    const amount = Number(COST[cost] ?? cost);
    const bal = await balance(userId, effectiveAskLimit);
    return { ok: bal.remaining >= amount, cost: amount, ...bal };
}

module.exports = { COST, monthKey, used, allowance, balance, spend, check };
