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
// maxPortfolios counts TOTAL portfolios including the implicit "Main", so
// tier 1 = 1 is exactly the product as it shipped before multi-portfolio
// existed: nobody loses a capability they already had. Multi-portfolio is the
// only one of the new surfaces that was never sold on the live listing
// ("portfolio tracking" is promised across all three tiers with no number), so
// it is the only one eligible to meter — holdings are deliberately unmetered.
const TIER_V2_CONFIG = {
    1: { maxMonitoredCompanies: 12, historyYearsLimit: 5, maxPortfolios: 1 },
    2: { maxMonitoredCompanies: 40, historyYearsLimit: 10, maxPortfolios: 5 },
    3: { maxMonitoredCompanies: UNLIMITED, historyYearsLimit: UNLIMITED, maxPortfolios: UNLIMITED }
};

const UNLIMITED_LIMITS = { maxMonitoredCompanies: UNLIMITED, historyYearsLimit: UNLIMITED, maxPortfolios: UNLIMITED, metered: false };

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

/**
 * True when creating one more portfolio would exceed the tier cap.
 * currentCount is the TOTAL the user has now, including the implicit "Main".
 */
function wouldExceedPortfolios(user, currentCount, env = process.env) {
    const { maxPortfolios } = limitsFor(user, env);
    return Number(currentCount) >= maxPortfolios;
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
// V1 (original AppSumo launch, 2026-08-01): 12/40/unlimited. This widened a
// lifetime entitlement, which can never be narrowed retroactively — see the
// note at the top of this file about retroactive metering. Owner widened the
// entry tier from 10 to 12 (2026-08-31, customer-feedback round).
const LTD_MONITOR_CAP = { 1: 12, 2: 40, 3: UNLIMITED };

// V2 (repositioning round, 2026-09-02): tightened to 1/4/8 based on customer
// feedback showing Monitor is high-value and tighter limits create a clearer
// upgrade path. All 13 buyers who redeemed before MONITOR_CAP_V2_EFFECTIVE_FROM
// are permanently grandfathered at 12/40/unlimited. New redemptions after that
// cutover get 1/4/8. Narrowing a lifetime entitlement requires this grandfather
// clause and AppSumo approval — both conditions must hold before deploying.
const LTD_MONITOR_CAP_V2 = { 1: 1, 2: 4, 3: 8 };

/** True when this account is a lifetime buyer (AppSumo or DealMirror). */
function isLifetimeBuyer(user) {
    return !!(user && (user.appsumoRedeemedAt || user.dealMirrorRedeemedAt));
}

/**
 * Cutover date for the V2 Monitor caps (1/4/8). No default: an unset or
 * unparseable value means "no cohort is under V2 yet", so everyone keeps V1
 * (12/40/unlimited). Fail-closed on the downgrade, not on access.
 */
function monitorCapV2EffectiveFrom(env = process.env) {
    const raw = String(env.MONITOR_CAP_V2_EFFECTIVE_FROM || '').trim();
    if (!raw) return null;
    const t = Date.parse(raw);
    return Number.isFinite(t) ? t : null;
}

/**
 * True only for lifetime buyers who redeemed ON OR AFTER the V2 cutover.
 * Everyone else — grandfathered buyers, non-LTD accounts, and every account
 * while the cutover is unset — is false, which is what keeps the narrowing
 * off anyone who bought under the old terms.
 *
 * One source of truth: both the cap and the watchlist gate read cohort
 * membership from here, so they can never disagree about who is metered.
 */
function isMonitorCapV2Cohort(user, env = process.env) {
    if (!isLifetimeBuyer(user)) return false;
    const v2From = monitorCapV2EffectiveFrom(env);
    if (v2From === null) return false;
    const redeemed = new Date(user.appsumoRedeemedAt || user.dealMirrorRedeemedAt).getTime();
    return Number.isFinite(redeemed) && redeemed >= v2From;
}

/**
 * How many companies a lifetime buyer may have watched by the Monitor.
 * null for anyone who is not a lifetime buyer — callers use that to mean
 * "this entitlement does not apply", not "zero companies".
 * An unknown tier resolves UP, matching appsumoTierConfig().
 *
 * V1 (12/40/unlimited) for pre-cutover buyers and while the cutover is unset;
 * V2 (1/4/8) for redemptions on or after it.
 */
function monitorCapFor(user, env = process.env) {
    if (!isLifetimeBuyer(user)) return null;
    const tier = Number(user.appsumoTier || user.dealMirrorTier);
    const map = isMonitorCapV2Cohort(user, env) ? LTD_MONITOR_CAP_V2 : LTD_MONITOR_CAP;
    return map[tier] || map[3];
}

/**
 * True when adding one more watched symbol would exceed this account's Monitor
 * cap. ONLY the V2 cohort is gated: grandfathered lifetime buyers and every
 * other plan get false, so their watchlist stays exactly as ungated as it is
 * today. The watchlist is a general feature, not a Monitor entitlement, and it
 * must not retroactively become one for anyone who bought before the cutover.
 */
function wouldExceedMonitorCap(user, currentCount, env = process.env) {
    if (!isMonitorCapV2Cohort(user, env)) return false;
    const cap = monitorCapFor(user, env);
    if (cap === null || !Number.isFinite(cap)) return false;
    return Number(currentCount) >= cap;
}

/**
 * The cap rendered for display: "unlimited companies", "up to 8 companies",
 * "up to 1 company". null for non-lifetime accounts, matching monitorCapFor().
 *
 * One implementation on purpose. The redemption email and the profile page each
 * used to hardcode their own copy of the ladder with a comment telling the next
 * reader to keep it in step by hand — which is how they came to promise
 * "unlimited companies" to a cohort the code caps at 8. Callers render this
 * string; they do not compute the number.
 */
function monitorCapLabel(user, env = process.env) {
    const cap = monitorCapFor(user, env);
    if (cap === null) return null;
    if (!Number.isFinite(cap)) return 'unlimited companies';
    return `up to ${cap} ${cap === 1 ? 'company' : 'companies'}`;
}

/** Trim a symbol list to what this account's tier is entitled to watch. */
function capSymbols(user, symbols, env = process.env) {
    const cap = monitorCapFor(user, env);
    const list = Array.isArray(symbols) ? symbols : [];
    if (cap === null || !Number.isFinite(cap)) return list;
    return list.slice(0, cap);
}

module.exports = { TIER_V2_CONFIG, UNLIMITED, limitsFor, wouldExceedMonitored, wouldExceedPortfolios, clampHistoryYears, enabled, effectiveFrom, LTD_MONITOR_CAP, LTD_MONITOR_CAP_V2, isLifetimeBuyer, isMonitorCapV2Cohort, monitorCapFor, monitorCapLabel, monitorCapV2EffectiveFrom, wouldExceedMonitorCap, capSymbols };
