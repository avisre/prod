'use strict';

// ============================================================
// Direct lifetime deal (#9) — the same LTD sold from our own site.
//
// WHY THIS MODULE EXISTS SEPARATELY
// The AppSumo integration does not generate redemption codes: AppSumo issues
// the license key and we consume it (POST /appsumo/webhook, GET /appsumo/redeem).
// There is therefore no "AppSumo code generator" to reuse. What IS reused, and
// what this module deliberately does not duplicate, is everything downstream of
// the key: the AppSumoLicense collection, grantAppSumoProAccess(), the tier ->
// Ask-cap ladder, and the onboarding/confirmation email. This module only mints
// a key of our own so that a direct buyer enters that identical path.
//
// EXCLUSIVITY / MFN
// The partner agreement requires AppSumo to remain the cheapest place to buy
// this deal. It does not prohibit selling direct. Every direct tier is
// therefore priced strictly ABOVE its AppSumo counterpart, and that is not
// left to a one-time manual check — assertPriceFloor() is a runtime guard on
// the boot path AND on every checkout-session creation, and it re-checks the
// amount Stripe actually reports, not just the constant in this file.
//
// PAYMENT MODE
// This module never selects a Stripe mode/key. It is live-mode-agnostic by
// construction: it only maps tiers to Price IDs supplied by the environment.
// ============================================================

const crypto = require('crypto');

const USD = 'usd';

// Direct tiers mirror APPSUMO_TIER_CONFIG in app.js exactly — same numeric
// tier, same Ask cap, same Pro grant. Only the price and the channel differ.
// `appsumoUsd` is the reference price the floor guard compares against; it is
// env-overridable precisely so that an AppSumo price change is expressible
// without a deploy, and the guard then fires on the next boot/checkout.
const TIERS = Object.freeze({
  1: Object.freeze({
    tier: 1,
    slug: 'starter',
    label: 'Starter',
    planName: 'Pro — Lifetime (Starter)',
    askCap: 30,
    appsumoUsd: 39,
    directUsd: 39.99,
    priceEnvVar: 'STRIPE_PRICE_ID_LTD_STARTER',
    testPriceEnvVar: 'STRIPE_PRICE_ID_LTD_TEST_STARTER',
    appsumoPriceEnvVar: 'APPSUMO_TIER1_PRICE_USD'
  }),
  2: Object.freeze({
    tier: 2,
    slug: 'investor',
    label: 'Investor',
    planName: 'Pro — Lifetime (Investor)',
    askCap: 100,
    appsumoUsd: 79,
    directUsd: 79.99,
    priceEnvVar: 'STRIPE_PRICE_ID_LTD_INVESTOR',
    testPriceEnvVar: 'STRIPE_PRICE_ID_LTD_TEST_INVESTOR',
    appsumoPriceEnvVar: 'APPSUMO_TIER2_PRICE_USD'
  }),
  3: Object.freeze({
    tier: 3,
    slug: 'pro',
    label: 'Pro',
    planName: 'Pro — Lifetime (Pro)',
    askCap: 300,
    appsumoUsd: 149,
    directUsd: 149.99,
    priceEnvVar: 'STRIPE_PRICE_ID_LTD_PRO',
    testPriceEnvVar: 'STRIPE_PRICE_ID_LTD_TEST_PRO',
    appsumoPriceEnvVar: 'APPSUMO_TIER3_PRICE_USD'
  })
});

const TIER_NUMBERS = Object.freeze([1, 2, 3]);

// Channel tag. Kept distinct from 'appsumo' everywhere it is written so that
// revenue reporting can never sum the two channels into one number.
const CHANNEL = 'direct-ltd';
const CHECKOUT_TYPE = 'direct_ltd';

function enabled(env = process.env) {
  return String(env.DIRECT_LTD_ENABLED || 'false').toLowerCase() === 'true';
}

/**
 * Test mode routes direct-LTD checkout at Stripe's TEST account/keys instead
 * of the live sk_live path, so a real end-to-end purchase can be exercised
 * with a 4242 test card before DIRECT_LTD_ENABLED ever goes live. Nothing
 * else in the app (subscriptions, the main webhook secret, etc.) is affected
 * by this flag — it is read only by the direct-ltd checkout/webhook code.
 */
function testModeEnabled(env = process.env) {
  return String(env.NODE_ENV || '').toLowerCase() === 'test'
    || String(env.DIRECT_LTD_TEST_MODE || 'false').toLowerCase() === 'true';
}

/**
 * Refund window, in days, for a direct purchase. Deliberately separate from
 * AppSumo's own 60-day refund policy — that one is AppSumo's to run, this one
 * is ours, and the two must never be conflated in copy or in code.
 */
function refundDays(env = process.env) {
  const raw = env.DIRECT_LTD_REFUND_DAYS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 30;
}

function tierConfig(tier) {
  return TIERS[Number(tier)] || null;
}

/** Normalize a user-supplied tier ("2", "investor", 2) to 1|2|3, or null. */
function normalizeTier(value) {
  const n = Number(value);
  if (TIER_NUMBERS.includes(n)) return n;
  const slug = String(value || '').trim().toLowerCase();
  const match = TIER_NUMBERS.find((t) => TIERS[t].slug === slug);
  return match || null;
}

/**
 * The AppSumo price this tier must stay above. Env override exists so the
 * guard keeps working after an AppSumo price change; a malformed or negative
 * override falls back to the hard-coded listing price rather than being
 * silently treated as 0, which would disable the floor.
 */
function appsumoReferenceUsd(tier, env = process.env) {
  const cfg = tierConfig(tier);
  if (!cfg) throw new Error(`Unknown direct LTD tier: ${tier}`);
  const raw = env[cfg.appsumoPriceEnvVar];
  if (raw === undefined || raw === null || String(raw).trim() === '') return cfg.appsumoUsd;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) {
    console.error(`[direct-ltd] GUARD: ${cfg.appsumoPriceEnvVar}="${raw}" is not a valid price; falling back to the listing price $${cfg.appsumoUsd}.`);
    return cfg.appsumoUsd;
  }
  return parsed;
}

class PriceFloorViolation extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'PriceFloorViolation';
    this.code = 'DIRECT_LTD_PRICE_FLOOR';
    this.details = details;
  }
}

/**
 * THE GUARD. Throws (loudly) unless the direct price for `tier` is strictly
 * greater than the matching AppSumo tier price.
 *
 * Deliberately strict `<=`, not `<`: matching AppSumo's price is already a
 * breach of "AppSumo is the cheapest", so equality must fail too.
 *
 * `directUsd` is a parameter rather than being read from TIERS so the caller
 * can pass the amount STRIPE actually reports for the configured Price. That
 * is the case this guard exists for — someone editing the Price in the Stripe
 * dashboard, where nothing in this repo would otherwise notice.
 */
function assertPriceFloor({ tier, directUsd, env = process.env, context = 'unspecified' } = {}) {
  const cfg = tierConfig(tier);
  if (!cfg) throw new Error(`Unknown direct LTD tier: ${tier}`);
  const amount = Number(directUsd);
  const floor = appsumoReferenceUsd(tier, env);

  if (!Number.isFinite(amount)) {
    const msg = `[direct-ltd] GUARD FAILED (${context}): tier ${tier} direct price is not a number (${directUsd}). Refusing to sell.`;
    console.error(msg);
    throw new PriceFloorViolation(msg, { tier, directUsd, floor, context });
  }
  if (amount <= floor) {
    const msg =
      `[direct-ltd] EXCLUSIVITY GUARD FAILED (${context}): tier ${tier} (${cfg.label}) direct price $${amount.toFixed(2)} ` +
      `is not above the AppSumo price $${Number(floor).toFixed(2)}. AppSumo must remain strictly the cheapest ` +
      `channel for this deal. Direct lifetime checkout is BLOCKED for this tier until the price is raised ` +
      `(or ${cfg.appsumoPriceEnvVar} is corrected).`;
    console.error(msg);
    throw new PriceFloorViolation(msg, { tier, directUsd: amount, floor, context });
  }
  return true;
}

/**
 * Boot-path check across all three tiers. Returns a report instead of throwing
 * so a misconfiguration takes down direct LTD sales only — never the whole
 * app, which serves plenty of traffic that has nothing to do with this.
 */
function assertAllPriceFloors(env = process.env, { context = 'boot' } = {}) {
  const violations = [];
  for (const tier of TIER_NUMBERS) {
    try {
      assertPriceFloor({ tier, directUsd: TIERS[tier].directUsd, env, context });
    } catch (error) {
      violations.push({ tier, message: error.message });
    }
  }
  if (violations.length) {
    console.error(`[direct-ltd] ${violations.length} tier(s) violate the AppSumo price floor. Direct lifetime checkout is disabled.`);
  }
  return { ok: violations.length === 0, violations };
}

/** True only when every tier clears the floor. Callers gate checkout on this. */
function priceFloorsOk(env = process.env) {
  return assertAllPriceFloors(env, { context: 'preflight' }).ok;
}

/**
 * Stripe Price ID configured for a tier, or null when unset. In test mode
 * this resolves the tier's `testPriceEnvVar` instead of its live one, so a
 * misconfigured/absent test Price cannot silently fall through to a live
 * Price ID (or vice versa) — the two are never mixed.
 */
function priceIdFor(tier, env = process.env) {
  const cfg = tierConfig(tier);
  if (!cfg) return null;
  const varName = testModeEnabled(env) ? cfg.testPriceEnvVar : cfg.priceEnvVar;
  return String(env[varName] || '').trim() || null;
}

/** Reverse lookup used by the webhook to recover the tier from a Price ID. */
function tierFromPriceId(priceId, env = process.env) {
  const wanted = String(priceId || '').trim();
  if (!wanted) return null;
  return TIER_NUMBERS.find((t) => priceIdFor(t, env) === wanted) || null;
}

/**
 * Validate a Stripe Price object for a tier and return the amount to charge.
 *
 * This is the enforcement point for everything that could quietly turn a
 * compliant configuration into a non-compliant one: an inactive price, a
 * recurring price (which would make a "lifetime" deal a subscription), a
 * non-USD price (which cannot be compared to AppSumo's USD floor), or an
 * amount at/below the AppSumo tier price. It lives here, not in the route, so
 * it is testable without a Stripe key.
 *
 * Throws PriceFloorViolation for a floor breach, and a plain Error tagged with
 * `.reason` for the structural problems.
 */
function validateStripePrice(price, tier, env = process.env) {
  const cfg = tierConfig(tier);
  if (!cfg) throw new Error(`Unknown direct LTD tier: ${tier}`);

  const fail = (reason, message) => {
    console.error(`[direct-ltd] GUARD: ${message}`);
    const error = new Error(message);
    error.reason = reason;
    throw error;
  };

  if (!price) fail('missing', `No Stripe Price found for tier ${tier}.`);
  if (price.active === false) fail('inactive', `Stripe Price ${price.id} (tier ${tier}) is inactive.`);
  if (price.recurring) fail('recurring', `Stripe Price ${price.id} (tier ${tier}) is recurring; a lifetime deal must be one-time.`);
  if (String(price.currency || '').toLowerCase() !== USD) {
    fail('currency', `Stripe Price ${price.id} (tier ${tier}) is in ${price.currency}, but the AppSumo floor is USD. Cannot verify exclusivity.`);
  }

  const amountUsd = Number(price.unit_amount) / 100;
  // Throws PriceFloorViolation, loudly logged, if at or below the AppSumo tier.
  assertPriceFloor({ tier, directUsd: amountUsd, env, context: `stripe-price:${price.id}` });

  // Above the floor but not what /lifetime advertises: exclusivity-safe, so it
  // is allowed, but the landing page is now wrong and that must be visible.
  const drift = amountUsd !== cfg.directUsd;
  if (drift) {
    console.warn(`[direct-ltd] Stripe Price ${price.id} is $${amountUsd.toFixed(2)} but tier ${tier} advertises $${cfg.directUsd.toFixed(2)}. Update the landing page.`);
  }
  return { amountUsd, drift };
}

/**
 * Mint a license key for a direct buyer. The `DIRECT-` segment makes the
 * channel obvious in the AppSumoLicense collection and in support tooling, so
 * a direct license can never be mistaken for an AppSumo-issued one even
 * though both live in the same collection and grant the same entitlement.
 */
function mintLicenseKey(tier) {
  const cfg = tierConfig(tier);
  if (!cfg) throw new Error(`Unknown direct LTD tier: ${tier}`);
  return `SPP-DIRECT-T${cfg.tier}-${crypto.randomBytes(16).toString('base64url').toUpperCase()}`;
}

function isDirectLicenseKey(licenseKey) {
  return /^SPP-DIRECT-T[123]-/.test(String(licenseKey || ''));
}

/** Amount in the smallest currency unit, for Stripe comparisons. */
function unitAmountFor(tier) {
  const cfg = tierConfig(tier);
  if (!cfg) throw new Error(`Unknown direct LTD tier: ${tier}`);
  return Math.round(cfg.directUsd * 100);
}

/** Copy-safe tier list for the /lifetime page and the public config endpoint. */
function publicTiers(env = process.env) {
  return TIER_NUMBERS.map((t) => {
    const cfg = TIERS[t];
    return {
      tier: cfg.tier,
      slug: cfg.slug,
      label: cfg.label,
      priceUsd: cfg.directUsd,
      priceDisplay: `$${cfg.directUsd.toFixed(2)}`,
      // The AppSumo reference price, so the page can state the real per-tier
      // difference instead of a vague "from $39". Resolved through
      // appsumoReferenceUsd so an APPSUMO_TIER*_PRICE_USD override is reflected
      // without a deploy — copy that hard-coded the gap would silently start
      // misstating it the moment that override fired.
      appsumoPriceUsd: appsumoReferenceUsd(t, env),
      appsumoPriceDisplay: `$${appsumoReferenceUsd(t, env).toFixed(2)}`,
      askCap: cfg.askCap,
      currency: USD,
      available: Boolean(priceIdFor(t, env))
    };
  });
}

module.exports = {
  TIERS, TIER_NUMBERS, CHANNEL, CHECKOUT_TYPE, USD,
  PriceFloorViolation,
  enabled, refundDays, testModeEnabled, tierConfig, normalizeTier,
  appsumoReferenceUsd, assertPriceFloor, assertAllPriceFloors, priceFloorsOk,
  priceIdFor, tierFromPriceId, validateStripePrice,
  mintLicenseKey, isDirectLicenseKey, unitAmountFor, publicTiers
};
