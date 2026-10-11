'use strict';

// One source of truth for the AppSumo August sprint.  The deadline is
// deliberately unset by default: a countdown must never invent an expiry date.
const DEFAULT_ID = 'appsumo_aug_2026';
const DEFAULT_START = '2026-08-01T00:00:00.000Z';

function iso(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const date = new Date(text);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function config(now = new Date()) {
  const enabled = process.env.APPSUMO_AUGUST_CAMPAIGN_ENABLED !== 'false';
  const endAt = iso(process.env.APPSUMO_DEAL_END_AT);
  const startAt = iso(process.env.APPSUMO_CAMPAIGN_START_AT) || DEFAULT_START;
  const end = endAt ? new Date(endAt) : null;
  const current = now instanceof Date ? now : new Date(now);
  const expired = Boolean(end && current.getTime() >= end.getTime());
  const publicBase = String(process.env.APP_PUBLIC_URL || 'https://www.stockportfolio.pro').replace(/\/$/, '');
  const daysRemaining = end && !expired
    ? Math.max(0, Math.ceil((end.getTime() - current.getTime()) / 86400000))
    : null;
  let deadlineLabel = 'Lifetime deal available now';
  let urgency = 'none';
  if (end && !expired) {
    const hours = (end.getTime() - current.getTime()) / 3600000;
    if (hours <= 24) { deadlineLabel = 'Final day for lifetime access'; urgency = 'final-day'; }
    else if (hours <= 72) { deadlineLabel = '72 hours left for lifetime access'; urgency = '72-hours'; }
    else if (daysRemaining <= 7) { deadlineLabel = `Lifetime deal ends ${end.toLocaleDateString('en-US', { dateStyle: 'long', timeZone: process.env.APPSUMO_DEAL_END_TIMEZONE || 'UTC' })}`; urgency = 'final-week'; }
    else if (daysRemaining <= 14) { deadlineLabel = `Lifetime deal ends ${end.toLocaleDateString('en-US', { dateStyle: 'long', timeZone: process.env.APPSUMO_DEAL_END_TIMEZONE || 'UTC' })}`; urgency = 'two-weeks'; }
    else { deadlineLabel = `Lifetime deal ends ${end.toLocaleDateString('en-US', { dateStyle: 'long', timeZone: process.env.APPSUMO_DEAL_END_TIMEZONE || 'UTC' })}`; urgency = 'subtle'; }
  }
  if (expired) deadlineLabel = 'The lifetime deal has ended';
  return {
    campaignId: process.env.APPSUMO_CAMPAIGN_ID || DEFAULT_ID,
    enabled: enabled && !expired,
    configured: Boolean(endAt),
    appsumoUrl: process.env.APPSUMO_ATTRIBUTED_URL || 'https://appsumo.com/products/stockportfoliopro/',
    starterPrice: 39,
    investorPrice: 79,
    proPrice: 149,
    recommendedTier: 'pro',
    campaignStart: startAt,
    expiration: endAt,
    expirationTimezone: process.env.APPSUMO_DEAL_END_TIMEZONE || 'UTC',
    // The generated public assets are safe defaults; Render env vars can
    // override them later if a hosted replacement is approved.
    salesVideoUrl: String(process.env.APPSUMO_SALES_VIDEO_URL || '').trim() || `${publicBase}/assets/appsumo-sales-demo.mp4`,
    onboardingVideoUrl: String(process.env.APPSUMO_ONBOARDING_VIDEO_URL || '').trim() || `${publicBase}/assets/appsumo-onboarding.mp4`,
    countdownEnabled: process.env.APPSUMO_COUNTDOWN_ENABLED !== 'false',
    revenueTarget: 100000,
    daysRemaining,
    deadlineLabel,
    urgency,
    expired
  };
}

// AppSumo SALES were retired on 2026-10-11: the site no longer sends a new
// buyer to the AppSumo deal — every route that did now lands on our own plans.
// A code constant, like direct-ltd.js SALES_RETIRED, because the AppSumo env
// vars also drive the webhook, redeem and licence paths that people who
// ALREADY bought still depend on. salesOpen() is read only by the surfaces
// that sell, so turning sales off takes nothing away from an existing buyer.
const SALES_RETIRED = true;
const NEW_BUYER_PATH = '/#pricing';
function salesOpen() {
  return !SALES_RETIRED;
}

function appsumoPath({ source = 'website', contentId, clickId } = {}) {
  const query = new URLSearchParams();
  if (contentId) query.set('content_id', String(contentId));
  if (clickId) query.set('click_id', String(clickId));
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return `/go/appsumo/${encodeURIComponent(String(source || 'website'))}${suffix}`;
}

module.exports = { config, appsumoPath, DEFAULT_ID, SALES_RETIRED, NEW_BUYER_PATH, salesOpen };
