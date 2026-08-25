'use strict';

// ============================================================
// 1-week pricing-swap experiment: show visitors the direct-LTD tiers instead
// of the subscription tiers on /pricing, to measure whether one-time-payment
// framing converts better than subscription framing.
//
// SAFETY MODEL
// - Off by default (PRICING_EXPERIMENT_MODE=off). The only other value is
//   'ltd_only'; anything else is treated as 'off' (fail closed, never fail
//   open into an unreviewed experiment).
// - Activation requires BOTH PRICING_EXPERIMENT_MODE=ltd_only AND
//   PRICING_EXPERIMENT_ACTIVATED_AT set to an ISO timestamp. Without an
//   activation timestamp there is nothing for the auto-revert to measure
//   against, so the experiment is treated as off.
// - Auto-revert: install() starts an in-process interval that flips the mode
//   back to 'off' once PRICING_EXPERIMENT_DURATION_MS (default 7 days) has
//   elapsed since activation, and logs loudly when it does. This mutates
//   process.env directly — legitimate in Node, and the only way to end the
//   experiment without a human action or a redeploy.
// - Underneath, nothing about subscription checkout changes: this module only
//   answers "what should /pricing show right now", never touches the
//   existing /api/checkout routes.
// ============================================================

const CHANNEL_TAG = 'pricing_experiment_ltd_only';
const DEFAULT_DURATION_MS = 7 * 24 * 3600 * 1000;

function rawMode(env = process.env) {
  return String(env.PRICING_EXPERIMENT_MODE || 'off').toLowerCase();
}

function activatedAt(env = process.env) {
  const raw = env.PRICING_EXPERIMENT_ACTIVATED_AT;
  if (!raw) return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? null : d;
}

function durationMs(env = process.env) {
  const raw = Number(env.PRICING_EXPERIMENT_DURATION_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_DURATION_MS;
}

/** True mode after validating the activation timestamp is present and current. */
function mode(env = process.env) {
  const requested = rawMode(env);
  if (requested !== 'ltd_only') return 'off';
  const at = activatedAt(env);
  if (!at) return 'off'; // no activation timestamp => never treat as on
  const elapsed = Date.now() - at.getTime();
  if (elapsed < 0 || elapsed >= durationMs(env)) return 'off';
  return 'ltd_only';
}

function revertsAt(env = process.env) {
  const at = activatedAt(env);
  if (!at || mode(env) !== 'ltd_only') return null;
  return new Date(at.getTime() + durationMs(env));
}

/**
 * Check once whether the live env's experiment has expired and, if so, flip
 * PRICING_EXPERIMENT_MODE back to 'off' in-process. Idempotent — safe to call
 * on every tick. Returns true if it just reverted.
 */
function checkAndRevertIfExpired(env = process.env) {
  if (rawMode(env) !== 'ltd_only') return false;
  const at = activatedAt(env);
  if (!at) return false;
  const elapsed = Date.now() - at.getTime();
  if (elapsed < durationMs(env)) return false;
  console.error(
    `[pricing-experiment] AUTO-REVERT: PRICING_EXPERIMENT_MODE was 'ltd_only' since ${at.toISOString()}, ` +
    `duration ${durationMs(env)}ms elapsed. Flipping back to 'off'. No human action required.`
  );
  env.PRICING_EXPERIMENT_MODE = 'off';
  return true;
}

/** Start the auto-revert interval. Call once at boot. Returns the timer (for tests to clear). */
function install({ env = process.env, intervalMs = 60000 } = {}) {
  const timer = setInterval(() => checkAndRevertIfExpired(env), intervalMs);
  if (timer.unref) timer.unref();
  return timer;
}

module.exports = {
  CHANNEL_TAG,
  DEFAULT_DURATION_MS,
  rawMode, activatedAt, durationMs, mode, revertsAt,
  checkAndRevertIfExpired, install
};
