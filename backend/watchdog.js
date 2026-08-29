'use strict';

/**
 * Filing Watchdog + health-check flip alerts.
 *
 * Every WATCHDOG_INTERVAL_MS (default 6h) it scans the distinct symbols held
 * across all user portfolios:
 *   1. Filings — polls SEC EDGAR submissions for new 10-K / 10-Q / 8-K
 *      filings and alerts every holder of that symbol.
 *   2. Health flips — recomputes the plain-English health checks (same code
 *      path as the fundamentals page / Ask tool) and alerts when a check
 *      flips pass→fail or fail→pass.
 *
 * First sighting of a symbol seeds watch state silently — users are alerted
 * only on changes that happen after they are being watched, never backfilled
 * with years of old filings.
 *
 * Alerts are in-app (GET /api/alerts). Scans are fail-open per symbol: one
 * bad ticker never kills the sweep.
 */

const axios = require('axios');
const mongoose = require('mongoose');
const secSource = require('./sec-source');
const aiChat = require('./ai-chat');

const WATCH_FORMS = new Set(['10-K', '10-Q', '8-K', '10-K/A', '10-Q/A']);
const SYMBOL_THROTTLE_MS = 200; // SEC fair-use is 10 req/s; stay well under
const MAX_ALERTS_PER_USER = 200;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- Models (guard against double compilation on hot reload) ----
const AlertSchema = new mongoose.Schema({
  user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  symbol: { type: String, required: true },
  type: { type: String, enum: ['filing', 'health-flip', 'insider-cluster', 'dividend-risk', 'threshold', 'filing-diff'], required: true },
  title: { type: String, required: true },
  detail: { type: String, default: '' },
  url: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  seenAt: { type: Date, default: null }
});
AlertSchema.index({ user: 1, createdAt: -1 });
// One alert per user per event (filing accession / check flip), so repeat
// scans are idempotent.
AlertSchema.index({ user: 1, symbol: 1, type: 1, title: 1 }, { unique: true });

const WatchStateSchema = new mongoose.Schema({
  symbol: { type: String, required: true, unique: true },
  seenAccessions: { type: [String], default: [] },
  healthSnapshot: { type: Map, of: Boolean, default: undefined },
  filingsCheckedAt: { type: Date, default: null },
  healthCheckedAt: { type: Date, default: null }
});

const Alert = mongoose.models.Alert || mongoose.model('Alert', AlertSchema);
const WatchState = mongoose.models.WatchState || mongoose.model('WatchState', WatchStateSchema);

// ---- SEC submissions ----
async function fetchRecentFilings(symbol, forms = WATCH_FORMS, cap = 40) {
  let cik = await secSource.cikFor(symbol);
  if (!cik) {
    // Not every filer is in the static company_tickers.json (2 of a 25-ticker
    // measurement sample, e.g. EXAS, were missing entirely) — the same
    // resolveWorkingCik fallback used below for a wrong CIK also covers a
    // missing one, since it queries EDGAR's own ticker search independently
    // of that file. Only worth trying when a 10-K is wanted; a null result
    // here is cached (see resolveWorkingCik), so a ticker with genuinely no
    // EDGAR filer only pays this extra request once.
    if (!forms.has('10-K')) return null;
    const found = await secSource.resolveWorkingCik(symbol, null, '10-K');
    if (!found) return null;
    cik = found;
  }
  let r = await axios.get(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: secSource.SEC_HEADERS,
    timeout: 20000
  });
  let recent = r.data?.filings?.recent;

  // The ticker's mapped CIK sometimes turns out to be a shell/co-registrant
  // that never files the form callers actually asked for (see
  // secSource.resolveWorkingCik — XOM is the case that surfaced this). Try
  // the corrected CIK once and re-fetch before giving up.
  if (forms.has('10-K') && !(recent?.form || []).includes('10-K')) {
    const altCik = await secSource.resolveWorkingCik(symbol, cik, '10-K');
    if (altCik && altCik !== cik) {
      cik = altCik;
      r = await axios.get(`https://data.sec.gov/submissions/CIK${cik}.json`, {
        headers: secSource.SEC_HEADERS,
        timeout: 20000
      });
      recent = r.data?.filings?.recent;
    }
  }

  if (!recent || !Array.isArray(recent.accessionNumber)) return [];
  const out = [];
  for (let i = 0; i < recent.accessionNumber.length && out.length < cap; i++) {
    const form = String(recent.form?.[i] || '');
    if (!forms.has(form)) continue;
    const accession = String(recent.accessionNumber[i]);
    const doc = String(recent.primaryDocument?.[i] || '');
    out.push({
      accession,
      form,
      date: String(recent.filingDate?.[i] || ''),
      url: doc
        ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/${doc}`
        : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${encodeURIComponent(form)}`
    });
  }
  return out;
}

const FORM_LABEL = {
  '10-K': 'Annual report (10-K)',
  '10-K/A': 'Annual report amendment (10-K/A)',
  '10-Q': 'Quarterly report (10-Q)',
  '10-Q/A': 'Quarterly report amendment (10-Q/A)',
  '8-K': 'Material event (8-K)',
  '8-K/A': 'Material event amendment (8-K/A)',
  '4': 'Form 4 (insider ownership)',
  '4/A': 'Form 4 amendment (4/A)',
  'DEF 14A': 'Proxy statement (DEF 14A)'
};

async function createAlerts(userIds, fields) {
  for (const userId of userIds) {
    try {
      await Alert.updateOne(
        { user: userId, symbol: fields.symbol, type: fields.type, title: fields.title },
        { $setOnInsert: { ...fields, user: userId, createdAt: new Date() } },
        { upsert: true }
      );
    } catch (_) { /* duplicate race — fine */ }
  }
}

async function scanSymbolFilings(symbol, holderIds) {
  const filings = await fetchRecentFilings(symbol);
  if (filings === null) return; // unknown CIK (ETF, foreign) — skip quietly
  const state = await WatchState.findOneAndUpdate(
    { symbol },
    { $setOnInsert: { symbol } },
    { upsert: true, new: true }
  );
  const seen = new Set(state.seenAccessions || []);
  const firstRun = !state.filingsCheckedAt;
  const fresh = filings.filter((f) => !seen.has(f.accession));

  if (!firstRun) {
    for (const f of fresh) {
      await createAlerts(holderIds, {
        symbol,
        type: 'filing',
        title: `${symbol}: ${FORM_LABEL[f.form] || f.form} filed ${f.date}`,
        detail: `New ${f.form} filing on SEC EDGAR.`,
        url: f.url
      });
    }
    // Fresh 10-K/10-Q: compute the what-changed diff in the background and
    // alert Pro holders with the headline. Fire-and-forget — the sweep never
    // waits on document fetches + the model.
    const reportForm = fresh.find((f) => f.form === '10-K' || f.form === '10-Q');
    if (reportForm) {
      (async () => {
        try {
          const filingDiff = require('./filing-diff'); // lazy: avoids load cycle
          const smartAlerts = require('./smart-alerts');
          const diff = await filingDiff.computeFilingDiff(symbol);
          if (diff && !diff.error && diff.headline) {
            const ids = await smartAlerts.proFilter(holderIds);
            if (ids.length) {
              await createAlerts(ids, {
                symbol,
                type: 'filing-diff',
                title: `${symbol}: what changed in the new ${reportForm.form} (${reportForm.date})`,
                detail: diff.headline,
                url: `/company.html?symbol=${encodeURIComponent(symbol)}#filing-diff`
              });
            }
          }
        } catch (_) { /* diff alert is enrichment */ }
      })();
    }
  }
  state.seenAccessions = [...new Set([...seen, ...filings.map((f) => f.accession)])].slice(-200);
  state.filingsCheckedAt = new Date();
  await state.save();
}

async function scanSymbolHealth(symbol, holderIds) {
  // Watchdog runs in the background and must never trigger an uncached
  // fundamentals build. The old call returned a Promise without awaiting it,
  // launching one full build per holding while silently producing no checks.
  // Use the synchronous on-disk cache instead; customer requests still use
  // get_health_checks and can build missing symbols on demand.
  const result = aiChat.healthChecksFromData(aiChat.loadFund(symbol), symbol);
  const checks = result && Array.isArray(result.checks) ? result.checks : null;
  if (!checks || !checks.length) return;
  const state = await WatchState.findOneAndUpdate(
    { symbol },
    { $setOnInsert: { symbol } },
    { upsert: true, new: true }
  );
  const firstRun = !state.healthCheckedAt;
  const prev = state.healthSnapshot;
  const next = new Map();
  for (const c of checks) next.set(c.label, !!c.pass);

  if (!firstRun && prev) {
    for (const c of checks) {
      const was = prev.get(c.label);
      if (was === undefined || was === !!c.pass) continue;
      const improved = !!c.pass;
      await createAlerts(holderIds, {
        symbol,
        type: 'health-flip',
        title: `${symbol}: "${c.label}" flipped to ${improved ? 'PASS ✓' : 'FAIL ✗'}`,
        detail: c.detail ? `Now: ${c.detail}` : `Health check ${improved ? 'recovered' : 'deteriorated'} in the latest filed data.`,
        url: `/fundamentals.html?symbol=${encodeURIComponent(symbol)}`
      });
    }
  }
  state.healthSnapshot = next;
  state.healthCheckedAt = new Date();
  await state.save();
}

// ---- Sweep ----
let running = false;
async function scan() {
  if (running) return { skipped: 'already running' };
  if (mongoose.connection.readyState !== 1) return { skipped: 'no db' };
  running = true;
  const startedAt = Date.now();
  let symbols = [];
  try {
    const Stock = mongoose.models.Stock;
    if (!Stock) return { skipped: 'no Stock model' };
    const holdings = await Stock.find(
      { assetType: { $nin: ['etf', 'mutual_fund', 'crypto'] } },
      { symbol: 1, user: 1 }
    ).lean();
    const holders = new Map(); // SYMBOL -> Set<userId>
    for (const h of holdings) {
      const sym = String(h.symbol || '').toUpperCase().trim();
      if (!sym || !h.user) continue;
      if (!holders.has(sym)) holders.set(sym, new Set());
      holders.get(sym).add(String(h.user));
    }
    symbols = [...holders.keys()];
    const smartAlerts = require('./smart-alerts'); // lazy: avoids cycles at module load
    for (const symbol of symbols) {
      const ids = [...holders.get(symbol)];
      try { await scanSymbolFilings(symbol, ids); } catch (_) { /* per-symbol fail-open */ }
      try { await scanSymbolHealth(symbol, ids); } catch (_) { /* per-symbol fail-open */ }
      try { await smartAlerts.scanInsiderCluster(symbol, ids, createAlerts); } catch (_) { /* fail-open */ }
      try { await smartAlerts.scanDividendRisk(symbol, ids, createAlerts); } catch (_) { /* fail-open */ }
      await sleep(SYMBOL_THROTTLE_MS);
    }
    try { await smartAlerts.scanRules(createAlerts); } catch (_) { /* fail-open */ }
    return { symbols: symbols.length, ms: Date.now() - startedAt };
  } finally {
    running = false;
  }
}

function start() {
  if (String(process.env.WATCHDOG || '1') === '0') {
    console.log('[watchdog] disabled via WATCHDOG=0');
    return;
  }
  const intervalMs = Math.max(15 * 60 * 1000, Number(process.env.WATCHDOG_INTERVAL_MS || 6 * 3600 * 1000));
  // First sweep shortly after boot (lets Mongo connect), then on interval.
  setTimeout(() => { scan().then((r) => console.log('[watchdog] initial sweep', JSON.stringify(r))).catch(() => {}); }, 90 * 1000);
  setInterval(() => { scan().then((r) => console.log('[watchdog] sweep', JSON.stringify(r))).catch(() => {}); }, intervalMs);
  console.log(`[watchdog] scheduled every ${Math.round(intervalMs / 60000)} min`);
}

// ---- API helpers (used by app.js routes) ----
async function listAlerts(userId, limit = 50) {
  const alerts = await Alert.find({ user: userId }).sort({ createdAt: -1 }).limit(limit).lean();
  const unseen = await Alert.countDocuments({ user: userId, seenAt: null });
  return { alerts, unseen };
}

async function markSeen(userId) {
  await Alert.updateMany({ user: userId, seenAt: null }, { $set: { seenAt: new Date() } });
  // Cap stored alerts per user so the collection can't grow unbounded.
  const excess = await Alert.find({ user: userId }).sort({ createdAt: -1 }).skip(MAX_ALERTS_PER_USER).select('_id').lean();
  if (excess.length) await Alert.deleteMany({ _id: { $in: excess.map((d) => d._id) } });
}

// Deep fetch: recent window + EDGAR archive files until per-form caps are
// met (older 10-Ks live in the archive files once Form 4s flood `recent`).
async function fetchFilingsDeep(symbol, forms, perFormCap = {}) {
  const cik = await secSource.cikFor(symbol);
  if (!cik) return null;
  const out = [];
  const count = {};
  const capOf = (form) => perFormCap[form] ?? 8;
  const scan = (cols) => {
    if (!cols || !Array.isArray(cols.accessionNumber)) return;
    for (let i = 0; i < cols.accessionNumber.length; i++) {
      const form = String(cols.form?.[i] || '');
      if (!forms.has(form) || (count[form] || 0) >= capOf(form)) continue;
      const accession = String(cols.accessionNumber[i]);
      const doc = String(cols.primaryDocument?.[i] || '');
      count[form] = (count[form] || 0) + 1;
      out.push({
        accession,
        form,
        date: String(cols.filingDate?.[i] || ''),
        url: doc
          ? `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accession.replace(/-/g, '')}/${doc}`
          : `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=${encodeURIComponent(form)}`
      });
    }
  };
  const base = await axios.get(`https://data.sec.gov/submissions/CIK${cik}.json`, {
    headers: secSource.SEC_HEADERS, timeout: 20000
  });
  scan(base.data?.filings?.recent);
  const wantMore = () => ['10-K', '10-Q', 'DEF 14A'].some((f) => forms.has(f) && (count[f] || 0) < capOf(f));
  for (const f of (base.data?.filings?.files || []).slice(0, 3)) {
    if (!wantMore()) break;
    try {
      const r2 = await axios.get(`https://data.sec.gov/submissions/${f.name}`, {
        headers: secSource.SEC_HEADERS, timeout: 20000
      });
      scan(r2.data?.filings?.recent || r2.data);
    } catch (_) { /* archive fetch is best-effort */ }
  }
  return out;
}

module.exports = { start, scan, listAlerts, markSeen, fetchRecentFilings, fetchFilingsDeep, FORM_LABEL, createAlerts, Alert, WatchState };
