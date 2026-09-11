// Shared credit ledger for Ask and Dossier. One pool, so a Dossier isn't
// "free" just because it lives outside the Ask counter, and a heavy Ask month
// doesn't leave zero room for the one Dossier a user actually wanted.
//
// Also the wallet for the hosted MCP endpoint and public REST API
// (mcp-endpoint.js/public-api.js): app.js's apiKeyAuth resolves an API key
// to its owning website account and populates req.userId/user/subscription/
// tier exactly like the cookie/JWT authMiddleware does, so those callers
// spend from this SAME ledger — no separate quota. The local, stdio-only
// mcp-server/src/server.js dev tool still keeps its own flat quota.json;
// it isn't reachable externally and was never converted.
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

// Weights are calibrated from measured input volume, not guessed. Running the
// real extractors over 25 tickers (5 sectors, mega->micro cap) gave, per cold
// build: Monitor ~18K input tokens across 4-6 calls, Dossier standard ~75K
// across ~11-13, Deep ~150K. Normalised against Dossier standard = 10, Monitor
// lands at ~2.4; it is priced at 5 to leave headroom for its two 40MB SEC
// downloads and minutes of wall-clock, while staying legibly below Dossier.
// Monitor's input is cap-bound (filing-diff pins at 2x20K, unit-economics at
// 28K), so it does NOT scale with company size.
// dossier_compare (added 2026-08-31): side-by-side rendering of ALREADY-CACHED
// dossiers — peekDossier only, the compare route never builds. No AI spend
// happens at compare time; the underlying reports were each paid for once at
// build. Priced at 5 (half a standard Dossier): paid, but visibly cheaper
// than running the reports it reads.
// mcp_*/api_* (added for the hosted MCP endpoint and the public REST API,
// mcp-endpoint.js/public-api.js): MCP is the base tier, REST API is priced
// at exactly 2x MCP — a deliberate choice, not a rounding artifact, to make
// the MCP surface the cheaper on-ramp.
// *_lookup covers the deterministic tools (cache/SEC/Yahoo, no AI spend) —
// priced low, mainly abuse prevention rather than cost recovery, since no
// inference happens.
// *_ask is the only AI-backed action on either surface, so it's the only
// one with a real per-call cost to anchor. Measured 9/11: current-generation
// frontier pricing (Claude Fable 5.1 AND GPT-6 Astra, independently — they
// happen to match) is $10/$50 per M input/output tokens. This product's
// measured blended average is ~10,779 tokens/call (24.47M tokens / 2,270
// calls, the 9/6 credit-wallet analysis below) — the input/output SPLIT
// itself isn't measured (ollama-usage-tracker.js stores only the total,
// a gap noted there), so an 85/15 split (typical for tool-augmented Q&A)
// is assumed for this calculation only. That works out to ~$0.17/call at
// frontier pricing, which at this product's existing $0.10/credit rate
// ($14.99 / 150 recharge pack) is ~1.7 credits — mcp_ask: 2 sits right at
// that anchor (and matches the existing web `ask` weight, since it's the
// same underlying AI call). api_ask is 2x that by the same rule as lookup.
const COST = { ask: 2, monitor: 5, dossier_standard: 10, dossier_deep: 30, dossier_compare: 5, ai_paper_build: 10, ai_paper_daily: 4, mcp_lookup: 1, mcp_ask: 2, api_lookup: 2, api_ask: 4 };

function monthKey() { return new Date().toISOString().slice(0, 7); }

// First instant of next month, UTC — the moment monthKey() rolls over and this
// month's spend stops counting. Derived rather than stored: the reset is
// implicit in the month key, and Date.UTC normalises a December rollover into
// the next year on its own.
function resetsAt() {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString();
}

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

// Purchased top-ups land in the same ledger as positive rows (delta > 0,
// reason 'topup'), so a grant is as auditable as a spend and expires with the
// month key by construction — no cron, no second expiry field. used() only
// sums negatives, so the two never contaminate each other.
async function granted(userId) {
    try {
        const rows = await ledgerCol().aggregate([
            { $match: { userId: String(userId), month: monthKey(), delta: { $gt: 0 } } },
            { $group: { _id: null, total: { $sum: '$delta' } } }
        ]).toArray();
        return rows.length ? rows[0].total : 0;
    } catch (_) { return 0; }
}

// Idempotent on refId (the Stripe checkout session id): the webhook fires
// checkout.session.completed once but redelivers on ack failure, and a retry
// must never double-charge the ledger. Returns true only when a row was
// actually inserted this call.
async function grant(userId, amount, reason, refId) {
    const amountN = Math.floor(Number(amount) || 0);
    if (!Number.isFinite(amountN) || amountN <= 0) return false;
    try {
        if (refId) {
            const existing = await ledgerCol().countDocuments({ userId: String(userId), refId, delta: { $gt: 0 } });
            if (existing) return false;
        }
        await ledgerCol().insertOne({
            userId: String(userId), month: monthKey(), delta: amountN,
            reason, refId: refId || null, at: new Date()
        });
        return true;
    } catch (error) { console.error('[credits] grant failed:', error && error.message); return false; }
}

// One wallet shared with Ask, Monitor and Dossier, sized off the Ask limit the
// user already has (effectiveAskLimit — tier, AppSumo cap, env overrides all
// already resolved there) rather than a second, parallel tier table that could
// drift from it. ×2 preserves exactly the Ask capacity already sold: every
// existing user can still ask precisely as many questions as before, with the
// other features layered on top of the same budget, not carved out of it.
//
// Power/Desk get a materially larger ceiling instead of the bare ×2. Reason:
// userTier() (app.js) deliberately collapses power/power-monthly/desk to the
// same 'pro' gate tier, so effectiveAskLimit — and a bare ×2 off it — would
// give a $540 Desk customer the identical 600-credit wallet as a $79.99 Pro
// customer, while Monitor (Power/Desk-only, previously unmetered) is now
// drawing from that same pool. Keyed on the *uncollapsed* planId so it must be
// read from req.subscription.planId, not req.tier. Every other plan keeps the
// plain ×2 — no current user's capacity shrinks.
const PLAN_ALLOWANCE_FLOOR = { power: 2000, 'power-monthly': 2000, desk: 10000 };

// Explicit per-tier wallet for AppSumo/DealMirror lifetime buyers, replacing the
// derived x2 for those accounts. The derived form made the listing a second,
// drifting source of truth: the marketplace page advertised a number nothing in
// the code actually held. These literals ARE the advertised numbers.
//
// Every value is above the old derived allowance (60/200/600), so no existing
// buyer's capacity shrinks. That is deliberate and load-bearing: widening needs
// no grandfather clause and no AppSumo downgrade approval, where narrowing a
// lifetime entitlement needs both.
const LTD_CREDIT_ALLOWANCE = { 1: 100, 2: 300, 3: 800 };

// V2 (cost round, 2026-09-06): half of V1. Measured provider cost is what forced
// this — at ~82k tokens per charged credit, a single tier-3 buyer spending the
// full 800 would cost more per month than the entire AI plan. Nobody has ever
// come close (heaviest recorded month: 118 credits), so this is tail protection,
// not a change anyone should feel.
//
// It is a NARROWING, so it applies only to redemptions on or after
// CREDIT_ALLOWANCE_V2_EFFECTIVE_FROM. Every buyer who redeemed before it keeps
// V1 permanently. Same shape, and the same reasoning, as LTD_MONITOR_CAP_V2 in
// lib/tier-limits.js — read that file's note on retroactive metering first.
const LTD_CREDIT_ALLOWANCE_V2 = { 1: 50, 2: 150, 3: 400 };

/**
 * Cutover for the V2 wallet. No default: unset or unparseable means "no cohort
 * is on V2 yet", so everyone keeps V1. Fail-closed on the downgrade, never on
 * access — the same rule monitorCapV2EffectiveFrom() follows.
 */
function creditAllowanceV2EffectiveFrom(env = process.env) {
    const raw = String(env.CREDIT_ALLOWANCE_V2_EFFECTIVE_FROM || '').trim();
    if (!raw) return null;
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
}

/**
 * True only for lifetime buyers who redeemed ON OR AFTER the cutover.
 * A bare tier number carries no redemption date, so it can never be classified
 * into V2 — that is deliberate: an unclassifiable account keeps the larger
 * wallet rather than silently losing half of it.
 */
function isCreditAllowanceV2Cohort(user, env = process.env) {
    if (!user || typeof user !== 'object') return false;
    const redeemedRaw = user.appsumoRedeemedAt || user.dealMirrorRedeemedAt;
    if (!redeemedRaw) return false;
    const v2From = creditAllowanceV2EffectiveFrom(env);
    if (v2From === null) return false;
    const redeemed = new Date(redeemedRaw).getTime();
    return Number.isFinite(redeemed) && redeemed >= v2From;
}

// 0 means "not a lifetime buyer" — callers must fall through to the derived
// allowance rather than treat it as a zero grant. An unknown but truthy tier
// resolves UP to tier 3, matching appsumoTierConfig() and monitorCapFor(): a
// paying customer is never under-served because of a data gap.
//
// Accepts either a bare tier (legacy callers, and every non-LTD path) or the
// user document. Only the document carries a redemption date, so only the
// document can be placed in the V2 cohort.
function ltdAllowance(tierOrUser, env = process.env) {
    const isUser = tierOrUser && typeof tierOrUser === 'object';
    const tier = Number(isUser ? (tierOrUser.appsumoTier || tierOrUser.dealMirrorTier) : tierOrUser);
    if (!Number.isFinite(tier) || tier <= 0) return 0;
    const map = (isUser && isCreditAllowanceV2Cohort(tierOrUser, env))
        ? LTD_CREDIT_ALLOWANCE_V2
        : LTD_CREDIT_ALLOWANCE;
    return map[tier] || map[3];
}

function allowance(effectiveAskLimit, planId, appsumoTierOrUser) {
    const floor = PLAN_ALLOWANCE_FLOOR[String(planId || '').toLowerCase()];
    const ltd = ltdAllowance(appsumoTierOrUser);
    // An LTD tier is an explicit grant, not a floor over the derived base:
    // reading it as max(ltd, base) would re-admit the derived number as a
    // competing source of truth, which is the drift this table exists to end.
    // A plan floor still wins if it is larger, so an LTD holder who also runs a
    // Desk subscription keeps the Desk ceiling.
    if (ltd) return Math.max(ltd, floor || 0);
    const base = Math.max(0, Number(effectiveAskLimit) || 0) * 2;
    return floor ? Math.max(floor, base) : base;
}

async function balance(userId, effectiveAskLimit, planId, appsumoTierOrUser) {
    const spent = await used(userId);
    // Plan allowance plus any purchased top-ups still inside this month. The
    // two halves are returned as well as their sum: a recharge silently
    // inflating `allowance` left the profile meter unable to say that 150 of
    // the wallet was bought rather than granted by the plan, so a $14.99
    // purchase had no visible receipt anywhere in the product.
    const plan = allowance(effectiveAskLimit, planId, appsumoTierOrUser);
    const purchased = await granted(userId);
    const limit = plan + purchased;
    return { used: spent, allowance: limit, plan, purchased, remaining: Math.max(0, limit - spent), month: monthKey(), resetsAt: resetsAt() };
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
async function check(userId, cost, effectiveAskLimit, planId, appsumoTierOrUser) {
    const amount = Number(COST[cost] ?? cost);
    const bal = await balance(userId, effectiveAskLimit, planId, appsumoTierOrUser);
    return { ok: bal.remaining >= amount, cost: amount, ...bal };
}

// Display-only: the last few ledger rows for this user's current month, for
// an itemized "what did I spend it on" view. Not used by check()/spend() —
// those stay a single cheap aggregate on the hot gating path; this is a
// separate, capped read for a profile page. Default raised from 8 to 12 so a
// three-feature (Ask/Monitor/Dossier) breakdown more often has enough rows to
// account for the full month's spend — see the `covered >= used` guard in
// profile.js, which hides the breakdown rather than show a partial one.
async function recentActivity(userId, limit = 12) {
    try {
        return await ledgerCol()
            .find({ userId: String(userId), month: monthKey() })
            .sort({ at: -1 })
            .limit(limit)
            .project({ _id: 0, reason: 1, refId: 1, delta: 1, at: 1 })
            .toArray();
    } catch (_) { return []; }
}

// Complete per-feature totals for the current month, in one aggregate over the
// whole ledger. The profile page used to derive this client-side by summing
// recentActivity()'s capped rows, which meant the breakdown VANISHED for anyone
// past the cap - precisely the users with a month worth breaking down. This has
// no cap, so the split is always complete and always adds up to used().
//
// Positive rows (top-ups) are included rather than filtered: the caller renders
// those as credits added, and a reason whose delta is > 0 is never usage.
async function monthBreakdown(userId) {
    try {
        const rows = await ledgerCol().aggregate([
            { $match: { userId: String(userId), month: monthKey() } },
            { $group: { _id: '$reason', delta: { $sum: '$delta' }, count: { $sum: 1 } } }
        ]).toArray();
        const out = {};
        for (const r of rows) out[String(r._id || 'other')] = { delta: r.delta, count: r.count };
        return out;
    } catch (_) { return {}; }   // same fail-open as used(): a DB blip hides the split, not the page
}

module.exports = { COST, LTD_CREDIT_ALLOWANCE, LTD_CREDIT_ALLOWANCE_V2, isCreditAllowanceV2Cohort, creditAllowanceV2EffectiveFrom, monthKey, resetsAt, used, granted, grant, ltdAllowance, allowance, balance, spend, check, recentActivity, monthBreakdown };
