#!/usr/bin/env node
/* Detects a *meaningful* change in a symbol's fundamentals and turns it into
 * the list of pages worth telling Bing about.
 *
 * Why only filed statements: `overview` carries market cap, P/E and moving
 * averages, and `daily`/`monthly` carry price series — all of which move every
 * trading day. Fingerprinting those would mark all ~1500 symbols changed daily
 * and resubmit the whole catalogue to IndexNow every run, which is the abuse
 * pattern the guidance warns against and would devalue our submissions. Filed
 * statements move on filings, which is a real content change. This matches the
 * repo's existing lastmod rule: it must represent a meaningful data change, not
 * every refresh.
 *
 * Consequence, deliberately accepted: /stocks/<sym>/price-history and the
 * price-derived parts of pe-ratio change daily but do not trigger IndexNow.
 */
const crypto = require('crypto');

const FILED_KEYS = ['income', 'balance', 'cash', 'dividends'];

/* Stable hash of the filed-statement content only. Returns null for an unusable
 * payload so a first-ever write is not mistaken for a change. */
function filedFingerprint(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const subset = {};
  let present = false;
  for (const key of FILED_KEYS) {
    if (payload[key] !== undefined) { subset[key] = payload[key]; present = true; }
  }
  if (!present) return null;
  return crypto.createHash('sha1').update(JSON.stringify(subset)).digest('hex');
}

/* Same predicate as availability() in backend/seo-extra.js: a metric page
 * exists when it has at least two usable rows. seo-extra is required lazily so
 * this module stays importable (and testable) without the backend's deps. */
function metricTable(injected) {
  if (injected) return injected;
  const extra = require('../../backend/seo-extra.js');
  return { METRICS: extra.METRICS, METRIC_SLUGS: extra.METRIC_SLUGS };
}

function urlsForSymbol(symbol, payload, options = {}) {
  const sym = String(symbol || '').toUpperCase();
  if (!sym || !payload) return [];
  const { METRICS, METRIC_SLUGS } = metricTable(options.metrics);
  const urls = [];
  for (const slug of METRIC_SLUGS) {
    const metric = METRICS[slug];
    if (!metric || typeof metric.rows !== 'function') continue;
    let rows;
    try { rows = metric.rows(payload) || []; } catch (_) { continue; }
    const usable = rows.filter((r) => r && r.value !== null).length;
    const exists = metric.allowEmpty ? rows.length >= 2 : usable >= 2;
    if (exists) urls.push(`/stocks/${sym}/${slug}`);
  }
  return urls;
}

/* Returns the URLs to enqueue for one symbol, or [] when nothing meaningful
 * changed. `previous` is the payload already on disk. */
function changedUrls(symbol, nextPayload, previousPayload, options = {}) {
  const next = filedFingerprint(nextPayload);
  if (!next) return [];
  const prev = filedFingerprint(previousPayload);
  // No previous filed data at all: this is a new page set, worth announcing.
  if (prev !== null && prev === next) return [];
  return urlsForSymbol(symbol, nextPayload, options);
}

module.exports = { filedFingerprint, urlsForSymbol, changedUrls, FILED_KEYS };
