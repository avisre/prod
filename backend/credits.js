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
// mcp-endpoint.js/public-api.js). The old "REST is exactly 2x MCP" base-tier
// rule was RETIRED 2026-09-22 by owner decision: both metered surfaces run the
// identical call and now carry the identical 6x anchor. There is no longer an
// MCP discount. That first pass equalised the ASK only and left the lookup
// split at 1/2; the owner closed that gap on 2026-09-23, so mcp_lookup and
// api_lookup are now both 2 and the two surfaces are priced identically end to
// end. MCP's remaining advantage is ergonomic, not financial: it is the
// agent-native path, not the cheap one. Safe to raise without a grandfather
// clause because it narrowed nobody — the production ledger held zero
// customer rows on either surface when this changed (only the dev account's
// own test calls), so no lifetime buyer's existing capacity shrank.
// *_lookup covers the deterministic tools (cache/SEC/Yahoo, no AI spend) —
// priced low, mainly abuse prevention rather than cost recovery, since no
// inference happens. The labs anchor below does not apply: there is nothing
// to anchor to.
// *_ask is the only AI-backed action on either surface, so it is the only one
// with a real per-call cost. Repriced 2026-09-11 to 2x current-generation
// frontier pricing, per the owner's rule ("use 2x the premium labs pricing for
// the mcp and api"). Frontier is Claude Fable 5.1 AND GPT-6 Astra,
// independently — they happen to match — at $10/$50 per M input/output tokens.
//
// TOKENS ARE MEASURED PER USER ACTION, NOT PER MODEL CALL. This is the
// correction that forced the 2026-09-22 reprice. Every earlier anchor here
// used 13,820 tokens, which is the average of a single 'chat' COMPLETION —
// but one Ask is an agentic loop that makes 5.6 model calls, re-sending the
// whole conversation plus the system prompt and 28 tool schemas each round.
// Rolling ollama_usage_events up by requestId (one requestId = one user
// action) gives the real figures, medians over the 30-day window:
//
//   Ask (POST /api/ai/chat)      58,239 tokens   5.6 calls   n=301
//   Dossier standard              36,673 tokens  14.1 calls   n=40
//   Monitor report                13,884 tokens   3.2 calls   n=11
//   Keypoints                     46,837 tokens   3.5 calls   n=6
//
// So the previous basis understated an Ask by ~4x. Medians, not means: the
// Ask distribution is right-skewed (mean 76,157) and a median is the honest
// figure for a typical call.
//
// Measured input/output split, same source: 'chat' 95/5, 'summary' 90/10.
// Input-heavy by construction, and it matters because frontier OUTPUT costs
// 5x frontier input.
//
// Frontier remains Claude Fable 5.1 / GPT-6 Astra at $10/$50 per M. Applying
// it to the per-ACTION tokens above, at $0.09993/credit ($14.99 / 150):
//
//   action             tokens   frontier $   multiple   = $      credits
//   mcp_ask / api_ask  58,239   $0.6989      6x         $4.193   42
//   dossier_deep      ~73,346   $1.0268      4x         $4.107   41
//   dossier_standard   36,673   $0.5134      4x         $2.054   21
//   monitor            13,884   $0.1944      4x         $0.778    8
//
// The two metered API surfaces carry 6x; the in-product features carry 4x
// (owner's call, 2026-09-22). Rounded to nearest.
//
// Web `ask` DELIBERATELY STAYS AT 2, unchanged. It is bundled into plan
// credits rather than sold per call, and it is the action LTD buyers actually
// use — repricing it to its 4x anchor (28) would have put 1 of 10 active
// AppSumo buyers over their monthly wallet on their existing September usage,
// and 3 of 10 had the halved V2 wallets been active. That is a deliberate
// subsidy of the bundled surface, not an oversight.
//
// dossier_compare is unchanged: no inference happens on it, so there is
// nothing to anchor to. mcp_lookup and api_lookup are likewise unanchored —
// no inference either. They were levelled at 2 on 2026-09-23 (see the
// surface-parity note above) and cut to 1 on 2026-10-10 (owner decision),
// still as a pair. What forced it: the first paying connector customer spent a
// 100-credit month in 28 minutes on 31 lookups and one answer. Measured the
// same week: a lookup makes no model call at all (filed SEC data from our own
// server), and three ordinary questions asked through Claude cost 1, 7 and 3
// lookups each with no AI answer among them. At 2 a 100-credit month was about
// 7 multi-company questions; at 1 it is about 14. The owner chose 1 over 0.5
// as a first step, to be revisited if customers still run short. Rows already
// in the ledger keep the price they were charged.
// ai_paper_* are unchanged: no per-action token measurement exists for them yet.
//
// For contrast with the anchor, real provider cost per Ask action:
// glm-5.1 $0.065, glm-5.3 $0.090, glm-5.3-flash $0.010. So mcp_ask: 42 earns
// ~65x its marginal cost on glm-5.1. The anchor is a PRICING rule benchmarked
// to frontier labs, NOT a cost-recovery calculation.
// What the site, the docs and our messages QUOTE for each action. It equals COST
// except for the two lookups: the owner cut what a lookup is CHARGED to 1 on
// 2026-10-10 and chose to leave the published price at 2 for now, so a customer
// is charged less than the listing says, never more. Everything that prints a
// price reads this; everything that charges reads COST. When the published
// price is brought into line, delete the two overrides and nothing else.
const LISTED_LOOKUP_COST = 2;
const COST = { ask: 2, monitor: 8, dossier_standard: 21, dossier_deep: 41, dossier_compare: 5, ai_paper_build: 10, ai_paper_daily: 4, mcp_lookup: 1, mcp_ask: 42, api_lookup: 1, api_ask: 42 };

// A signed-in reader's Ask has no fixed length: it runs until the question is
// answered or the wallet is empty (owner decision 2026-10-11). The flat 2 can
// no longer be the whole price, so work beyond an ordinary question is charged
// by size.
//
// Measured, not estimated — tokens per Ask action, ollama_usage_events rolled
// up by requestId, 30 days to 2026-10-11, n=241:
//   median 31,370   mean 63,428   p75 77,030   p90 136,684   p95 197,311
//   p99 479,038     max 583,987
// ASK_BASE_TOKENS is set just above p90, so nine questions in ten cost exactly
// what they did (2). Each further ASK_TOKENS_PER_CREDIT is one credit, which is
// the price per token the flat 2 already implied at the mean (63,428 / 2).
// Under these the p95 question is 4 credits and the p99 question 13.
const ASK_BASE_TOKENS = Number(process.env.ASK_BASE_TOKENS) > 0 ? Number(process.env.ASK_BASE_TOKENS) : 150000;
const ASK_TOKENS_PER_CREDIT = Number(process.env.ASK_TOKENS_PER_CREDIT) > 0 ? Number(process.env.ASK_TOKENS_PER_CREDIT) : 30000;
function askCredits(tokens) {
    const t = Number(tokens);
    return COST.ask + (Number.isFinite(t) && t > ASK_BASE_TOKENS ? Math.ceil((t - ASK_BASE_TOKENS) / ASK_TOKENS_PER_CREDIT) : 0);
}

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
// reason TOPUP_REASON), so a grant is as auditable as a spend. used() only
// sums negatives, so the two never contaminate each other.
//
// Top-ups do NOT expire at the month boundary (owner decision 2026-09-23: a
// pack someone paid $14.99 for vanishing on the 1st was indefensible). Each
// month the plan allowance is spent first; only spend beyond it draws the
// top-up bank down, and whatever is left carries into the next month until it
// is used. Every other positive row (manual 'refund' credits) stays scoped to
// its own month, exactly as before.
const TOPUP_REASON = 'topup';

function snapshotCol() { return mongoose.connection.collection('credit_plan_snapshots'); }

// Replaying the bank needs each past month's PLAN allowance, which the ledger
// does not hold and which can change (upgrades, LTD cohorts). So the plan is
// snapshotted per month while a user holds top-up credits — only those users,
// so nobody else pays a write on the gating path. A past month with no
// snapshot falls back to the current plan.
async function snapshotPlan(userId, month, plan) {
    try {
        await snapshotCol().updateOne(
            { userId: String(userId), month },
            { $set: { plan, at: new Date() } },
            { upsert: true }
        );
    } catch (_) { /* a missed snapshot only means a later fallback to the current plan */ }
}

// Current month's spend, month-scoped credits (refunds), and the top-up credits
// available this month (carried bank + this month's packs). Fail-open to zeros,
// matching used().
async function walletState(userId, plan) {
    const empty = { spent: 0, monthCredits: 0, topupAvailable: 0 };
    let rows;
    try {
        rows = await ledgerCol().aggregate([
            { $match: { userId: String(userId) } },
            { $group: {
                _id: {
                    month: '$month',
                    kind: { $cond: [{ $lt: ['$delta', 0] }, 'spent',
                        { $cond: [{ $eq: ['$reason', TOPUP_REASON] }, 'topup', 'credit'] }] }
                },
                total: { $sum: '$delta' }
            } }
        ]).toArray();
    } catch (_) { return empty; }

    const now = monthKey();
    const byMonth = new Map();
    for (const r of rows) {
        const m = r._id.month;
        if (!byMonth.has(m)) byMonth.set(m, { spent: 0, credit: 0, topup: 0 });
        const e = byMonth.get(m);
        if (r._id.kind === 'spent') e.spent = -r.total;
        else e[r._id.kind] = r.total;
    }
    const cur = byMonth.get(now) || { spent: 0, credit: 0, topup: 0 };
    const pastMonths = [...byMonth.keys()].filter((m) => m < now).sort();
    const everTopup = cur.topup > 0 || pastMonths.some((m) => byMonth.get(m).topup > 0);
    if (!everTopup) return { spent: cur.spent, monthCredits: cur.credit, topupAvailable: 0 };

    let snaps = new Map();
    try {
        const docs = await snapshotCol().find({ userId: String(userId), month: { $lt: now } }).toArray();
        snaps = new Map(docs.map((d) => [d.month, Number(d.plan) || 0]));
    } catch (_) { /* fall back to the current plan for every past month */ }

    let bank = 0;
    for (const m of pastMonths) {
        const e = byMonth.get(m);
        bank += e.topup;
        const monthPlan = snaps.has(m) ? snaps.get(m) : plan;
        const overflow = Math.max(0, e.spent - monthPlan - e.credit);
        bank -= Math.min(bank, overflow);
    }
    const topupAvailable = bank + cur.topup;
    if (topupAvailable > 0) await snapshotPlan(userId, now, plan);
    return { spent: cur.spent, monthCredits: cur.credit, topupAvailable };
}

// Credits added on top of the plan this month: top-up credits still available
// (carried plus bought this month) and any month-scoped credits. Kept for
// callers of the old name; balance() is the source of truth.
async function granted(userId, plan = 0) {
    const s = await walletState(userId, plan);
    return s.topupAvailable + s.monthCredits;
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
// The Dev plan (app.js DEV_PLAN_ID) is the API/MCP-only rung: $200/mo for 200
// credits. It gets an explicit floor rather than the derived x2 for the same
// reason Power/Desk do — its Ask limit is the FREE tier's (it deliberately
// grants no web-app features, so userTier() reads it as 'free'), and x2 off
// that would be 6 credits, not the 200 that were sold. Keyed on the
// uncollapsed planId, so it must be read from req.subscription.planId.
//
// $200 for 200 credits = $1.00/credit against the $14.99/150 recharge-pack
// rate of $0.09993, so since the 2026-10-08 reprice (from $19.99) the pack is
// ten times the cheaper of the two per credit. That is the inversion the rule
// above forbids, by an owner decision on the price rather than by rounding;
// test/dev-plan.test.js pins the two rates so the gap stays a recorded fact.
// Worst case all 200 credits go to mcp_ask (42 each) = 4 AI calls, the same
// tail the V2 LTD note below is protecting against.
//
// Monthly and Annual were given explicit floors on 2026-10-26 (owner
// decision): Monthly moved from 100 credits a month to 200, Annual to 300.
// Before this, both sat on the derived x2 off a 50-question Ask limit (100
// credits), which the first paying connector customer spent in 28 minutes.
// Annual gets the larger wallet as the reward for paying a year upfront.
// Pure widening, so no grandfather clause is needed. The Dev floor above is
// untouched.
const PLAN_ALLOWANCE_FLOOR = { monthly: 200, annual: 300, power: 2000, 'power-monthly': 2000, desk: 10000, dev: 200 };

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

// V3 (final-window round, 2026-09-25): the listing's closing days are repriced
// and the wallet is re-laddered to 200 / 500 / 1000. Every value sits above BOTH
// earlier tables (100/300/800 and 50/150/400), so for the buyers it covers this
// is a pure WIDENING — it needs no grandfather clause and no AppSumo downgrade
// approval, where V2's narrowing needed both. It applies only to redemptions on
// or after CREDIT_ALLOWANCE_V3_EFFECTIVE_FROM; every earlier buyer keeps
// whichever table was metering them.
//
// The shape matters as much as the size: the per-credit price has to FALL as the
// tier rises ($0.74 / $0.60 / $0.50 against the listed $149 / $299 / $499). A
// ladder that gets worse as you climb turns the listing's "best value" tag on
// the Pro tier into a claim a buyer can disprove with a calculator — 200/400/600
// was rejected for exactly that, at $0.75 / $0.75 / $0.83.
const LTD_CREDIT_ALLOWANCE_V3 = { 1: 200, 2: 500, 3: 1000 };

/**
 * Cutover for one wallet round. No default: unset or unparseable means "no
 * cohort is on this round yet", so everyone keeps the table they already had.
 * Fail-closed on every metering change, never on access — the same rule
 * monitorCapV2EffectiveFrom() follows.
 */
function allowanceCutoff(envVar, env) {
    const raw = String(env[envVar] || '').trim();
    if (!raw) return null;
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
}

function creditAllowanceV2EffectiveFrom(env = process.env) {
    return allowanceCutoff('CREDIT_ALLOWANCE_V2_EFFECTIVE_FROM', env);
}

function creditAllowanceV3EffectiveFrom(env = process.env) {
    return allowanceCutoff('CREDIT_ALLOWANCE_V3_EFFECTIVE_FROM', env);
}

/**
 * True only for lifetime buyers who redeemed ON OR AFTER the cutover.
 * A bare tier number carries no redemption date, so it can never be classified
 * into a cohort — that is deliberate: an unclassifiable account keeps the larger
 * wallet rather than silently losing half of it.
 */
function redeemedOnOrAfter(user, cutoff) {
    if (!user || typeof user !== 'object' || cutoff === null) return false;
    const redeemedRaw = user.appsumoRedeemedAt || user.dealMirrorRedeemedAt;
    if (!redeemedRaw) return false;
    const redeemed = new Date(redeemedRaw).getTime();
    return Number.isFinite(redeemed) && redeemed >= cutoff;
}

function isCreditAllowanceV2Cohort(user, env = process.env) {
    return redeemedOnOrAfter(user, creditAllowanceV2EffectiveFrom(env));
}

function isCreditAllowanceV3Cohort(user, env = process.env) {
    return redeemedOnOrAfter(user, creditAllowanceV3EffectiveFrom(env));
}

// The table a buyer is metered by: the NEWEST round whose cutover they fall
// after. Picking the newest rather than testing V3-then-V2 in source order means
// overlapping or out-of-order cutovers still cannot meter someone by an older,
// smaller table. Anything that is not a user document — a bare tier number, or
// any non-LTD caller — gets the original table, which is also the largest.
function allowanceTableFor(user, env) {
    if (!user || typeof user !== 'object') return LTD_CREDIT_ALLOWANCE;
    const rounds = [
        { from: creditAllowanceV3EffectiveFrom(env), table: LTD_CREDIT_ALLOWANCE_V3 },
        { from: creditAllowanceV2EffectiveFrom(env), table: LTD_CREDIT_ALLOWANCE_V2 }
    ].filter((round) => round.from !== null).sort((a, b) => b.from - a.from);
    for (const round of rounds) {
        if (redeemedOnOrAfter(user, round.from)) return round.table;
    }
    return LTD_CREDIT_ALLOWANCE;
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
    const map = allowanceTableFor(isUser ? tierOrUser : null, env);
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
    // Plan allowance plus top-up credits still available (carried from earlier
    // months or bought this one) plus any month-scoped credits. The halves are
    // returned as well as their sum: a recharge silently inflating `allowance`
    // left the profile meter unable to say that 150 of the wallet was bought
    // rather than granted by the plan, so a $14.99 purchase had no visible
    // receipt anywhere in the product.
    const plan = allowance(effectiveAskLimit, planId, appsumoTierOrUser);
    const s = await walletState(userId, plan);
    const purchased = s.topupAvailable + s.monthCredits;
    const limit = plan + purchased;
    // What survives the reset: top-up credits not yet drawn this month. The
    // plan (and month-scoped credits) are spent first.
    const topupCarriesOver = Math.max(0, s.topupAvailable - Math.max(0, s.spent - plan - s.monthCredits));
    return { used: s.spent, allowance: limit, plan, purchased, topupCarriesOver, remaining: Math.max(0, limit - s.spent), month: monthKey(), resetsAt: resetsAt() };
}

// Never throws: a failed ledger write must not undo an answer already shown
// to the user, and must not crash the request that's about to respond 200.
// It still logs loudly, because a silently-failing debit is a revenue leak,
// not a safety concern like a failing read.
// `client` is the assistant a connector call came through ("Claude"), kept so
// the profile page can say which one spent what. Absent everywhere else.
async function spend(userId, cost, reason, refId, client) {
    const amount = Number(COST[cost] ?? cost);
    if (!Number.isFinite(amount) || amount <= 0) return;
    try {
        await ledgerCol().insertOne({
            userId: String(userId), month: monthKey(), delta: -amount,
            reason, refId: refId || null, at: new Date(),
            ...(client ? { client: String(client).slice(0, 60) } : {})
        });
    } catch (error) { console.error('[credits] spend failed:', error && error.message); }
}

// Credits spent since a moment, per month — what a priced refund deducts
// (refund-quote.js). Unlike used(), this THROWS on a read error: a refund must
// not be priced off a metering blip that reads as zero.
async function spentByMonthSince(userId, since) {
    const rows = await ledgerCol().aggregate([
        { $match: { userId: String(userId), delta: { $lt: 0 }, at: { $gte: new Date(since) } } },
        { $group: { _id: '$month', total: { $sum: '$delta' } } }
    ]).toArray();
    return rows.map((r) => ({ month: r._id, spent: -r.total }));
}

// One step of a long Ask, charged while it runs. It is the same question as
// the row that carries its flat price, so it adds to what Ask spent and not to
// how many questions were asked (`step` keeps it out of monthBreakdown's count).
async function spendAskStep(userId, amount, refId) {
    const n = Math.floor(Number(amount));
    if (!Number.isFinite(n) || n <= 0) return;
    try { await ledgerCol().insertOne({ userId: String(userId), month: monthKey(), delta: -n, reason: 'ask', refId: String(refId), step: true, at: new Date() }); }
    catch (error) { console.error('[credits] spend failed:', error && error.message); }
}

// The steps charged while one long Ask ran, taken back when that run produced
// no answer (a failed Ask has always been free). Never throws.
async function refundRun(userId, refId) {
    if (!refId) return 0;
    try { return (await ledgerCol().deleteMany({ userId: String(userId), refId: String(refId), step: true })).deletedCount || 0; }
    catch (error) { console.error('[credits] refund failed:', error && error.message); return 0; }
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
            { $group: { _id: '$reason', delta: { $sum: '$delta' }, count: { $sum: { $cond: [{ $eq: ['$step', true] }, 0, 1] } } } }
        ]).toArray();
        const out = {};
        for (const r of rows) out[String(r._id || 'other')] = { delta: r.delta, count: r.count };
        return out;
    } catch (_) { return {}; }   // same fail-open as used(): a DB blip hides the split, not the page
}

const LISTED_COST = { ...COST, mcp_lookup: LISTED_LOOKUP_COST, api_lookup: LISTED_LOOKUP_COST };
// Deep thinking (high reasoning effort) on Ask costs this many times a normal question.
// app.js charges it and the /docs pages quote it, so the number lives in one place.
const DEEP_THINKING_FACTOR = 3;

module.exports = { askCredits, spendAskStep, refundRun, spentByMonthSince, ASK_BASE_TOKENS, ASK_TOKENS_PER_CREDIT, COST, LISTED_COST, DEEP_THINKING_FACTOR, LTD_CREDIT_ALLOWANCE, LTD_CREDIT_ALLOWANCE_V2, LTD_CREDIT_ALLOWANCE_V3, isCreditAllowanceV2Cohort, isCreditAllowanceV3Cohort, creditAllowanceV2EffectiveFrom, creditAllowanceV3EffectiveFrom, allowanceTableFor, monthKey, resetsAt, used, granted, grant, ltdAllowance, allowance, balance, spend, check, recentActivity, monthBreakdown };
