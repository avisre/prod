'use strict';

// Tier meter v2 — a second gating dimension alongside the existing monthly
// Ask count.
//
// The Ask meter counts what a query COSTS US. It does not track what the buyer
// VALUES, which is why Tier 1's 30 Asks already satisfies a casual buyer and
// almost nobody climbs a tier. maxMonitoredCompanies and historyYearsLimit
// meter coverage and depth instead — the two things a buyer wants more of as
// they get more serious. See docs/growth/appsumo-tier-v2-proposal.md.
//
// SHIPPED DARK. Two independent conditions both have to hold before a single
// user is affected:
//
//   1. ENABLE_TIER_V2_LIMITS=true — off by default; with it unset this module
//      returns unlimited for everybody, so importing it changes nothing.
//   2. The account redeemed on or after TIER_V2_EFFECTIVE_FROM. Anyone who has
//      already bought keeps unlimited coverage and depth forever. Retroactively
//      metering a one-time lifetime purchase is a refund event and a review
//      event; the cutover date makes that structurally impossible rather than
//      merely intended.

const UNLIMITED = Infinity;

// Per AppSumo tier. Existing Ask caps are left exactly where they are — this
// adds dimensions, it does not re-cut the current meter.
const TIER_V2_CONFIG = {
    1: { maxMonitoredCompanies: 12, historyYearsLimit: 5 },
    2: { maxMonitoredCompanies: 40, historyYearsLimit: 10 },
    3: { maxMonitoredCompanies: UNLIMITED, historyYearsLimit: UNLIMITED }
};

const UNLIMITED_LIMITS = { maxMonitoredCompanies: UNLIMITED, historyYearsLimit: UNLIMITED, metered: false };

function enabled(env = process.env) {
    return String(env.ENABLE_TIER_V2_LIMITS || 'false') === 'true';
}

// No default: an unset/unparseable cutover means "no cohort is metered yet",
// which is the safe direction. Fail-closed on the downgrade, not on access.
function effectiveFrom(env = process.env) {
    const raw = String(env.TIER_V2_EFFECTIVE_FROM || '').trim();
    if (!raw) return null;
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
}

/**
 * Effective v2 limits for a user. Always returns unlimited unless the flag is
 * on AND this account redeemed on or after the cutover.
 */
function limitsFor(user, env = process.env) {
    if (!enabled(env)) return UNLIMITED_LIMITS;
    const from = effectiveFrom(env);
    if (from === null) return UNLIMITED_LIMITS;

    const redeemedAt = user && (user.appsumoRedeemedAt || user.dealMirrorRedeemedAt);
    if (!redeemedAt) return UNLIMITED_LIMITS;          // not an LTD buyer — plan gates apply, not these
    const redeemed = new Date(redeemedAt).getTime();
    if (!Number.isFinite(redeemed) || redeemed < from) return UNLIMITED_LIMITS; // grandfathered

    const tier = Number(user.appsumoTier || user.dealMirrorTier);
    // An unknown tier resolves UP, matching appsumoTierConfig(): a paying
    // customer is never under-served because of a data gap.
    const cfg = TIER_V2_CONFIG[tier] || TIER_V2_CONFIG[3];
    return { ...cfg, metered: true };
}

/** True when adding one more monitored company would exceed the cap. */
function wouldExceedMonitored(user, currentCount, env = process.env) {
    const { maxMonitoredCompanies } = limitsFor(user, env);
    return Number(currentCount) >= maxMonitoredCompanies;
}

/** Clamp a requested history window (in years) to the tier's depth. */
function clampHistoryYears(user, requestedYears, env = process.env) {
    const { historyYearsLimit } = limitsFor(user, env);
    const req = Number(requestedYears);
    if (!Number.isFinite(req) || req <= 0) return historyYearsLimit;
    return Math.min(req, historyYearsLimit);
}

// ---- Filing Monitor on the lifetime tiers -----------------------------------
// Monitor used to be the Power/Desk differentiator, withheld from lifetime
// buyers. Measurement killed that rationale: reports are cached per (symbol,
// accession) and shared by every reader, so an extra Monitor user costs
// nothing for a company already built — and the paid Monitor plans it was
// protecting turned out to be a single account that had never used it.
//
// What lifetime buyers get is COVERAGE-CAPPED rather than unlimited, reusing
// the same per-tier numbers as TIER_V2_CONFIG so there is one ladder, not two.
// Deliberately independent of ENABLE_TIER_V2_LIMITS: that flag also meters
// history depth, which this must not switch on as a side effect.
//
// This widens a lifetime entitlement, which can never be narrowed again — see
// the note at the top of this file about retroactive metering.
// Owner widened the entry tier from 10 to 12 (2026-08-31, customer-feedback
// round). A widening — the only direction this map ever moves.
const LTD_MONITOR_CAP = { 1: 12, 2: 40, 3: UNLIMITED };

/** True when this account is a lifetime buyer (AppSumo or DealMirror). */
function isLifetimeBuyer(user) {
    return !!(user && (user.appsumoRedeemedAt || user.dealMirrorRedeemedAt));
}

/**
 * How many companies a lifetime buyer may have watched by the Monitor.
 * null for anyone who is not a lifetime buyer — callers use that to mean
 * "this entitlement does not apply", not "zero companies".
 * An unknown tier resolves UP, matching appsumoTierConfig().
 */
function monitorCapFor(user) {
    if (!isLifetimeBuyer(user)) return null;
    const tier = Number(user.appsumoTier || user.dealMirrorTier);
    return LTD_MONITOR_CAP[tier] || LTD_MONITOR_CAP[3];
}

/** Trim a symbol list to what this account's tier is entitled to watch. */
function capSymbols(user, symbols) {
    const cap = monitorCapFor(user);
    const list = Array.isArray(symbols) ? symbols : [];
    if (cap === null || !Number.isFinite(cap)) return list;
    return list.slice(0, cap);
}

module.exports = { TIER_V2_CONFIG, UNLIMITED, limitsFor, wouldExceedMonitored, clampHistoryYears, enabled, effectiveFrom, LTD_MONITOR_CAP, isLifetimeBuyer, monitorCapFor, capSymbols };
