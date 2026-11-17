'use strict';

// Signup trial policy (owner decision 2026-11-18, proposed):
//   * one 72-hour, no-card trial per account, starting when the account is
//     created (email signup) or first verified (Google sign-in);
//   * full website/data access while it runs;
//   * five standard Ask questions in total, never renewed by signing out,
//     changing device or signing in with another method;
//   * after expiry the account and its portfolios stay, but every product
//     surface is blocked until Stripe confirms a payment.
//
// This module deliberately owns only the trial clock and the AI counter. Access
// decisions live in app.js because they must also account for paid plans,
// AppSumo/DealMirror lifetime grants and the existing manual trial grants.

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_HOURS = 72;
const DEFAULT_AI_QUESTIONS = 5;

function intInRange(value, fallback, min, max) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function config(env = process.env) {
  const enabled = String(env.TRIAL_ENABLED ?? 'true').toLowerCase() !== 'false';
  const hours = intInRange(env.TRIAL_HOURS, DEFAULT_HOURS, 1, 24 * 30);
  const aiQuestions = intInRange(env.TRIAL_AI_QUESTIONS, DEFAULT_AI_QUESTIONS, 0, 100);
  return {
    enabled,
    hours,
    ms: hours * HOUR_MS,
    aiQuestions,
    // The trial itself is free, but the page must quote what follows it. The
    // plan config is the source of truth; this is only a safe fallback for
    // copy and for accounts whose plan has not been written yet.
    price: Number(env.CORE_PLAN_PRICE || 79.99),
    currency: env.CORE_PLAN_CURRENCY || 'USD'
  };
}

function startOf(user) {
  return user && user.signupTrialAt ? new Date(user.signupTrialAt) : null;
}

function endOf(user) {
  const sub = user && user.subscription ? user.subscription : null;
  return sub && sub.trialEndsAt ? new Date(sub.trialEndsAt) : null;
}

function used(user) {
  return Math.max(0, Number(user && user.trialAiUsed) || 0);
}

function limitFor(user, cfg = config()) {
  const stored = Number(user && user.trialAiLimit);
  return Number.isFinite(stored) && stored >= 0 ? stored : cfg.aiQuestions;
}

// The authoritative read used by every gate. It requires an actually running
// local trial, so a manual comp or a Stripe trial is not mistaken for a signup
// trial and cannot spend this counter.
function status(user, now = Date.now(), cfg = config()) {
  const startedAt = startOf(user);
  const endsAt = endOf(user);
  const sub = (user && user.subscription) || {};
  const startedMs = startedAt ? startedAt.getTime() : 0;
  const endsMs = endsAt ? endsAt.getTime() : 0;
  const active = Boolean(cfg.enabled && startedAt && endsAt
    && endsMs > now
    && sub.status === 'trialing'
    && !user.stripeSubscriptionId
    && sub.planId !== 'free');
  const expired = Boolean(startedAt && endsAt && endsMs <= now);
  const limit = limitFor(user, cfg);
  const usedCount = used(user);
  return {
    enabled: cfg.enabled,
    startedAt: startedAt ? startedAt.toISOString() : null,
    endsAt: endsAt ? endsAt.toISOString() : null,
    active,
    expired,
    used: usedCount,
    limit,
    remaining: Math.max(0, limit - usedCount),
    msLeft: active ? Math.max(0, endsMs - now) : 0,
    hoursLeft: active ? Math.max(0, Math.ceil((endsMs - now) / HOUR_MS)) : 0,
    planId: sub.planId || null,
    planName: sub.planName || null,
    price: Number.isFinite(Number(sub.price)) ? Number(sub.price) : cfg.price,
    currency: sub.currency || cfg.currency
  };
}

function active(user, now = Date.now(), cfg = config()) {
  return status(user, now, cfg).active;
}

// Grant the one trial. Returns true only when this call created it, so callers
// can emit a single trial_started event and never reset an existing clock.
// `planConfig` is a normal getPlanConfig() object; the trial is still a Core
// (monthly) entitlement while it runs, regardless of the plan selected for
// after the trial. Keep the selected plan on the subscription so the page can
// quote the right post-trial price.
function grant(user, planConfig = {}, now = new Date(), cfg = config()) {
  if (!user || !cfg.enabled || user.signupTrialAt) return false;
  const plan = planConfig && planConfig.planId ? planConfig : {};
  const startsAt = now instanceof Date ? now : new Date(now);
  const endsAt = new Date(startsAt.getTime() + cfg.ms);
  const current = user.subscription && typeof user.subscription === 'object' ? user.subscription : {};
  user.subscription = current;
  user.subscription.planId = plan.planId || current.planId || 'monthly';
  user.subscription.planName = plan.planName || current.planName || 'Monthly';
  user.subscription.price = Number.isFinite(Number(plan.price)) ? Number(plan.price) : Number(current.price) || cfg.price;
  user.subscription.currency = plan.currency || current.currency || cfg.currency;
  user.subscription.billingInterval = plan.billingInterval || current.billingInterval || 'month';
  // No Stripe object exists during the trial. Clearing the price id is what
  // lets ensureSubscriptionShape() self-expire the trial locally and what keeps
  // hasApiAccess()/Stripe webhooks from treating it as a subscription.
  user.subscription.stripePriceId = null;
  user.subscription.status = 'trialing';
  user.subscription.trialStartedAt = startsAt;
  user.subscription.trialEndsAt = endsAt;
  user.subscription.expiredAt = null;
  user.subscription.activatedAt = null;
  user.subscription.renewedAt = null;
  user.subscription.lastPaymentAt = null;
  user.signupTrialAt = startsAt;
  user.trialAiUsed = 0;
  user.trialAiLimit = cfg.aiQuestions;
  user.trialActivatedAt = null;
  user.trialExpiredTrackedAt = null;
  user.markModified('subscription');
  return true;
}

// Reserve one standard Ask question before any model call. The conditional
// update is the concurrency guard: two tabs cannot both see "1 left" and spend
// it. The caller refunds the reservation when the answer did not come back
// from the model (blocked, error, stopped before an answer).
async function reserveQuestion(User, userId, now = Date.now(), cfg = config()) {
  if (!cfg.enabled || cfg.aiQuestions <= 0) return { ok: false, reason: 'disabled', status: null };
  const updated = await User.findOneAndUpdate(
    {
      _id: userId,
      signupTrialAt: { $ne: null },
      'subscription.status': 'trialing',
      'subscription.trialEndsAt': { $gt: new Date(now) },
      trialAiUsed: { $lt: cfg.aiQuestions }
    },
    { $inc: { trialAiUsed: 1 } },
    { new: true }
  );
  if (!updated) {
    const user = await User.findById(userId);
    return { ok: false, reason: 'limit', status: user ? status(user, now, cfg) : null };
  }
  return { ok: true, status: status(updated, now, cfg) };
}

async function refundQuestion(User, userId) {
  if (!userId) return;
  await User.updateOne(
    { _id: userId, trialAiUsed: { $gt: 0 } },
    { $inc: { trialAiUsed: -1 } }
  ).catch(() => {});
}

// Mark the first answered trial question. The $set-if-null is atomic, so a
// burst of five questions still records one activation timestamp and event.
async function markActivated(User, userId, now = new Date()) {
  if (!userId) return false;
  const result = await User.updateOne(
    { _id: userId, trialActivatedAt: null },
    { $set: { trialActivatedAt: now } }
  ).catch(() => null);
  return Boolean(result && (result.modifiedCount || result.nModified));
}

// The trial on the connectors (/mcp, /mcp/apps) and the REST API (/api/v1).
// Same trial, same counter as the website: an AI answer reserves one of the
// five questions on the user row (reserveQuestion), so asking in the browser,
// in Claude and over the API all draw from one allowance. Data lookups are not
// counted while the trial runs, as on the website; the per-account company
// breadth cap still applies at the call sites.
//
// Credits-shaped (check / spend / release) so mcp-endpoint.js, mcp-apps.js and
// public-api.js run their existing reserve-then-confirm flow unmodified. One
// facade serves one request. `onAnswered(first)` fires when an AI answer is
// confirmed, so app.js can record activation the way the website Ask does.
const ASK_KEYS = new Set(['mcp_ask', 'api_ask']);

function connectorLimiter(User, user, { upgradeUrl = '/upgrade.html', onAnswered = null, cfg = config() } = {}) {
  const userId = user && user._id;
  const outstanding = [];

  const fmtEnds = (iso) => {
    const d = iso ? new Date(iso) : null;
    return d && !Number.isNaN(d.getTime())
      ? d.toLocaleString('en-GB', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'UTC', timeZoneName: 'short' })
      : null;
  };
  const view = (st, ok, extra = {}) => ({
    ok,
    trial: true,
    used: st.used,
    allowance: st.limit,
    // Lookups are not counted during the trial; null tells the caller so.
    lookupsLeft: null,
    lookupsLimit: null,
    asksLeft: st.remaining,
    asksLimit: st.limit,
    endsAt: st.endsAt,
    hoursLeft: st.hoursLeft,
    daysLeft: Math.ceil((st.hoursLeft || 0) / 24),
    notice: ok
      ? `Free trial: ${st.remaining} of ${st.limit} AI answers left (shared with the website); data lookups are included until ${fmtEnds(st.endsAt)} (${st.hoursLeft} hours left). After the trial this connector needs a subscription: ${upgradeUrl}`
      : null,
    neutralNotice: ok
      ? `Evaluation access: ${st.remaining} AI answers left; ends ${fmtEnds(st.endsAt)}.`
      : null,
    ...extra
  });
  const refuse = (st, reason) => view(st, false, {
    reason,
    message: reason === 'trial_ended'
      ? `Your free trial has ended. Your account and portfolios are kept; subscribe to use this connector again: ${upgradeUrl}`
      : `That was the last of your ${st.limit} free AI questions (the website, connectors and API share them). Data lookups continue until the trial ends; subscribe to keep asking: ${upgradeUrl}`
  });

  return {
    async check(_userId, costKey) {
      const now = Date.now();
      const st = status(user, now, cfg);
      if (!st.active) return refuse(st, 'trial_ended');
      if (!ASK_KEYS.has(costKey)) return view(st, true);
      const reservation = await reserveQuestion(User, userId, now, cfg);
      const after = reservation.status || st;
      if (!reservation.ok) return refuse(after, after.active ? 'ask_limit' : 'trial_ended');
      outstanding.push({ costKey, st: after });
      // remaining already excludes this reservation; the notice reports what
      // is left once this answer is delivered.
      return view(after, true);
    },
    async spend(_userId, costKey) {
      const i = outstanding.findIndex((r) => r.costKey === costKey);
      if (i < 0) return;
      const [{ st }] = outstanding.splice(i, 1);
      const first = await markActivated(User, userId);
      if (typeof onAnswered === 'function') {
        try { onAnswered({ first, used: st.used, limit: st.limit }); } catch (_) { /* telemetry must never fail the call */ }
      }
    },
    async release(_userId, costKey) {
      const i = outstanding.findIndex((r) => r.costKey === costKey);
      if (i < 0) return;
      outstanding.splice(i, 1);
      await refundQuestion(User, userId);
    }
  };
}

module.exports = {
  connectorLimiter,
  HOUR_MS,
  DEFAULT_HOURS,
  DEFAULT_AI_QUESTIONS,
  config,
  status,
  active,
  grant,
  reserveQuestion,
  refundQuestion,
  markActivated
};
