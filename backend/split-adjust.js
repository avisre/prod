'use strict';

/**
 * Normalizes share counts and per-share figures in a fundamentals payload to
 * the CURRENT split basis.
 *
 * Why per-value detection: SEC EDGAR returns as-filed numbers, but the merge
 * can mix bases across years and across statements for the same year — e.g.
 * AAPL FY2018 shares outstanding is as-filed (4.75B) while FY2018 diluted EPS
 * came from a post-4:1-split comparative (2.98). So every value's basis is
 * detected independently:
 *   - share counts: continuity walk newest→oldest, anchored to the current
 *     overview SharesOutstanding (share counts move slowly; a ~4x or ~7x jump
 *     can only be a basis mismatch)
 *   - eps/dilutedEPS: checked against netIncome / adjustedShares for the same
 *     period — net income is split-invariant, so it is ground truth
 *
 * A stored value can be in the basis of any filing made on/after its period
 * end, so the candidate multipliers to today's basis are the suffix products
 * of the split ratios that occurred after the period end.
 */

function parseNum(v) {
  if (v === null || v === undefined || v === '' || v === 'None') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

// splits: [{ date, numerator, denominator }] in any order.
function normalizeSplits(splits) {
  return (splits || [])
    .map((s) => ({
      time: new Date(s.date).getTime(),
      ratio: parseNum(s.numerator) && parseNum(s.denominator)
        ? Number(s.numerator) / Number(s.denominator)
        : null
    }))
    .filter((s) => Number.isFinite(s.time) && Number.isFinite(s.ratio) && s.ratio > 0 && s.ratio !== 1)
    .sort((a, b) => a.time - b.time);
}

// All plausible multipliers from the stored value's basis to today's basis.
// Index 0 (= product of ALL post-period splits) is the as-filed assumption,
// which is the default when there is no reference to compare against.
function candidateFactors(splits, periodEnd) {
  const t = new Date(periodEnd).getTime();
  if (!Number.isFinite(t)) return [1];
  const after = splits.filter((s) => s.time > t).map((s) => s.ratio);
  const out = [];
  for (let j = 0; j <= after.length; j++) {
    out.push(after.slice(j).reduce((a, b) => a * b, 1));
  }
  return [...new Set(out)];
}

function closest(cands, score) {
  let best = cands[0];
  let bestScore = Infinity;
  for (const c of cands) {
    const s = score(c);
    if (s < bestScore) { bestScore = s; best = c; }
  }
  return best;
}

function logDist(a, b) {
  if (!(a > 0) || !(b > 0)) return Infinity;
  return Math.abs(Math.log(a / b));
}

function periodKey(dateText) {
  return String(dateText || '').slice(0, 7);
}

// Continuity walks assume newest→oldest; don't rely on stored array order.
function newestFirst(reports) {
  return [...(reports || [])].sort((a, b) =>
    String(b.fiscalDateEnding || '').localeCompare(String(a.fiscalDateEnding || '')));
}

// Walk share-count reports newest→oldest; multiply each stored value by the
// candidate factor that keeps the series continuous with the newer neighbour
// (or the live overview count for the newest report).
function adjustShareSeries(reports, splits, anchor, stats) {
  let ref = Number.isFinite(anchor) && anchor > 0 ? anchor : null;
  const adjusted = new Map();
  for (const report of newestFirst(reports)) {
    const v = parseNum(report.commonStockSharesOutstanding);
    if (!(v > 0)) continue;
    const cands = candidateFactors(splits, report.fiscalDateEnding);
    let factor;
    if (cands.length === 1) {
      factor = cands[0];
    } else if (ref) {
      factor = closest(cands, (m) => logDist(v * m, ref));
    } else {
      factor = cands[0]; // as-filed assumption
    }
    const out = Math.round(v * factor);
    if (factor !== 1) {
      report.commonStockSharesOutstanding = typeof report.commonStockSharesOutstanding === 'string' ? String(out) : out;
      stats.shares++;
    }
    ref = out;
    adjusted.set(periodKey(report.fiscalDateEnding), out);
  }
  return adjusted;
}

// Adjust eps/dilutedEPS using netIncome / adjustedShares as the reference;
// fall back to continuity with the newer adjusted EPS when shares or income
// are unavailable for the period.
function adjustEpsSeries(reports, splits, sharesByPeriod, stats) {
  const refByField = {};
  for (const report of newestFirst(reports)) {
    const netIncome = parseNum(report.netIncome);
    const shares = sharesByPeriod.get(periodKey(report.fiscalDateEnding));
    const expected = netIncome !== null && shares > 0 ? netIncome / shares : null;
    for (const field of ['eps', 'dilutedEPS']) {
      const v = parseNum(report[field]);
      if (v === null || v === 0) continue;
      const cands = candidateFactors(splits, report.fiscalDateEnding);
      let factor;
      if (cands.length === 1) {
        factor = cands[0];
      } else if (expected !== null && Math.sign(expected) === Math.sign(v)) {
        factor = closest(cands, (m) => logDist(Math.abs(v / m), Math.abs(expected)));
      } else if (Number.isFinite(refByField[field]) && Math.sign(refByField[field]) === Math.sign(v)) {
        factor = closest(cands, (m) => logDist(Math.abs(v / m), Math.abs(refByField[field])));
      } else {
        factor = cands[0]; // as-filed assumption
      }
      const out = Math.round((v / factor) * 10000) / 10000;
      if (factor !== 1) {
        report[field] = typeof report[field] === 'string' ? String(out) : out;
        stats.eps++;
      }
      refByField[field] = out;
    }
  }
}

/**
 * Mutates payload in place. Returns { changed, shares, eps }.
 * splits: raw Yahoo chart events.splits array (or []).
 */
function adjustPayloadForSplits(payload, splits) {
  const stats = { shares: 0, eps: 0 };
  const timeline = normalizeSplits(splits);
  if (!timeline.length || !payload) return { changed: false, ...stats };

  const anchor = parseNum(payload.overview?.SharesOutstanding);
  const annualShares = adjustShareSeries(payload.balance?.annualReports, timeline, anchor, stats);
  const quarterlyShares = adjustShareSeries(payload.balance?.quarterlyReports, timeline, anchor, stats);
  adjustEpsSeries(payload.income?.annualReports, timeline, annualShares, stats);
  adjustEpsSeries(payload.income?.quarterlyReports, timeline, quarterlyShares, stats);

  return { changed: stats.shares + stats.eps > 0, ...stats };
}

// ---- Self-contained per-symbol entry point (lazy Yahoo client + 24h splits
// cache) so callers like sec-source don't each need their own split fetch.
let yfInstance = null;
function getYahoo() {
  if (!yfInstance) {
    const YahooFinance = require('yahoo-finance2').default;
    yfInstance = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
  }
  return yfInstance;
}

const SPLITS_TTL_MS = 24 * 3600 * 1000;
const splitsCache = new Map(); // SYMBOL -> { at, splits }

async function fetchSplits(symbol) {
  const key = String(symbol || '').toUpperCase();
  const hit = splitsCache.get(key);
  if (hit && Date.now() - hit.at < SPLITS_TTL_MS) return hit.splits;
  const yahooSymbol = key.replace(/[._]/g, '-'); // BRK.B / BRK_B -> BRK-B
  const r = await getYahoo().chart(yahooSymbol, {
    period1: '1980-01-01',
    interval: '1mo',
    events: 'split'
  });
  const splits = r?.events?.splits || [];
  splitsCache.set(key, { at: Date.now(), splits });
  if (splitsCache.size > 2000) splitsCache.delete(splitsCache.keys().next().value);
  return splits;
}

// Fail-open: a Yahoo hiccup must never block serving fundamentals.
async function adjustPayloadForSymbol(symbol, payload) {
  try {
    const splits = await fetchSplits(symbol);
    return adjustPayloadForSplits(payload, splits);
  } catch (_) {
    return { changed: false, shares: 0, eps: 0 };
  }
}

module.exports = { adjustPayloadForSplits, adjustPayloadForSymbol, normalizeSplits, candidateFactors };
