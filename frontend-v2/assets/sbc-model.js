/* Stock-based compensation model for the Stocks & funds page.
   One pure function over a company's filed annual rows. It runs in the browser
   (company.js draws from it) and under Node (backend/test/sbc-model.test.js and
   scripts/build-sbc-sector.js), so the page, the tests and the sector table can
   never disagree about what "SBC % of revenue" means.

   Every output is a filed number or arithmetic on filed numbers. A measure
   whose inputs were not filed is null and carries the reason in `why`; nothing
   is estimated or carried forward from another year. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SBCModel = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // A year-over-year move in the diluted share count beyond this is almost
  // always a split, a merger or a restated share class, not dilution. The
  // filings do not say which, so the change is withheld rather than shown as
  // if staff had been handed half the company.
  const SHARE_JUMP = 0.4;
  const CHECK_YEARS = 5;
  const TREND_YEARS = 10;

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const fyOf = (end) => { const d = new Date(end); return Number.isNaN(d.getTime()) ? '' : 'FY' + d.getUTCFullYear(); };

  // rows: [{ end, sbc, rev, ocf, capex, buy, dil, sourceId }], any order.
  // capex and buy may be filed as negative outflows; both are read as amounts.
  function normalise(rows) {
    return (rows || [])
      .filter((r) => r && r.end)
      .map((r) => {
        const ocf = num(r.ocf), capex = num(r.capex), buy = num(r.buy);
        return {
          end: String(r.end), fy: fyOf(r.end),
          sbc: num(r.sbc), rev: num(r.rev),
          fcf: ocf !== null && capex !== null ? ocf - Math.abs(capex) : null,
          buy: buy === null ? null : Math.abs(buy),
          dil: num(r.dil),
          sourceId: r.sourceId || null
        };
      })
      .sort((a, b) => (a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
  }

  const pctOfRevenue = (y) => (y && y.sbc !== null && y.rev !== null && y.rev > 0 ? (100 * y.sbc) / y.rev : null);

  function shareChange(from, to) {
    if (!from || !to || from.dil === null || to.dil === null || from.dil <= 0) return null;
    return (to.dil - from.dil) / from.dil;
  }

  function build(rows) {
    const years = normalise(rows);
    const reported = years.filter((y) => y.sbc !== null);
    if (!reported.length) {
      return { status: 'not_reported', why: 'Not available: no separate stock-based compensation line appears in the cash flow data we hold from this company\'s filings.' };
    }
    const newest = years[years.length - 1];
    const latest = reported[reported.length - 1];
    const i = years.indexOf(latest);
    const prev = i > 0 ? years[i - 1] : null;
    const fiveAgo = i >= CHECK_YEARS ? years[i - CHECK_YEARS] : null;

    const out = {
      status: 'ok',
      fy: latest.fy, end: latest.end, sourceId: latest.sourceId,
      // The newest filed year has no SBC line although an earlier one does: the
      // figures below are that earlier year's, and the page says which.
      stale: latest !== newest ? `Not reported for ${newest.fy}; latest filed figure is ${latest.fy}.` : null,
      sbc: latest.sbc,
      pctRevenue: pctOfRevenue(latest),
      pctRevenueFiveAgo: fiveAgo ? pctOfRevenue(fiveAgo) : null,
      fiveAgoFy: fiveAgo ? fiveAgo.fy : null,
      trend: reported.slice(-TREND_YEARS).map((y) => ({ fy: y.fy, sbc: y.sbc, pctRevenue: pctOfRevenue(y) })),
      fcf: latest.fcf, fcfAfter: null, pctOfFcf: null, fcfWhy: null,
      buybacks: latest.buy, buybackOffsetPct: null,
      dilutionYoY: null, dilutionFive: null, dilutionWhy: null,
      check: null
    };
    if (out.pctRevenue === null) out.pctRevenueWhy = latest.rev === null ? `Not available: revenue for ${latest.fy} is not in our filings data.` : `Not shown: revenue for ${latest.fy} was not positive.`;

    if (latest.fcf === null) out.fcfWhy = `Not available: operating cash flow or capital expenditure for ${latest.fy} is not in our filings data.`;
    else {
      out.fcfAfter = latest.fcf - latest.sbc;
      // "SBC is 180% of free cash flow" is meaningful; a share of a negative
      // number is not, so that case is described in words by the page.
      if (latest.fcf > 0) out.pctOfFcf = (100 * latest.sbc) / latest.fcf;
    }

    if (latest.buy !== null && latest.buy > 0) out.buybackOffsetPct = (100 * latest.sbc) / latest.buy;

    // Dilution. Any single-year jump inside the window withholds the measure
    // that crosses it.
    const yoy = shareChange(prev, latest);
    if (yoy === null) out.dilutionWhy = 'Not available: the diluted share count is not in our filings data for both years.';
    else if (Math.abs(yoy) > SHARE_JUMP) out.dilutionWhy = 'Not shown: the diluted share count changed by more than 40% in a year, which usually means a split or a merger rather than dilution.';
    else out.dilutionYoY = 100 * yoy;
    if (fiveAgo && out.dilutionYoY !== null) {
      const window = years.slice(i - CHECK_YEARS, i + 1);
      let clean = true;
      for (let k = 1; k < window.length; k += 1) { const c = shareChange(window[k - 1], window[k]); if (c === null || Math.abs(c) > SHARE_JUMP) clean = false; }
      if (clean) out.dilutionFive = 100 * shareChange(fiveAgo, latest);
    }

    // Buybacks against stock pay over five filed years. Only when SBC was filed
    // for every year in the window and a buyback was filed in at least one:
    // a company that never buys back stock is not failing a test it never sat.
    const win = years.slice(Math.max(0, i - CHECK_YEARS + 1), i + 1);
    if (win.length === CHECK_YEARS && win.every((y) => y.sbc !== null) && win.some((y) => y.buy !== null && y.buy > 0)) {
      const buy = win.reduce((n, y) => n + (y.buy || 0), 0);
      const sbc = win.reduce((n, y) => n + y.sbc, 0);
      out.check = { pass: buy > sbc, buybacks: buy, sbc };
    }
    return out;
  }

  // Where a value sits in a sorted list of the same measure for a sector.
  // `higherThanPct` is the share of the OTHER companies it exceeds.
  function rank(sorted, value) {
    const list = (sorted || []).filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (value === null || value === undefined || list.length < 10) return null;
    let below = 0;
    for (const v of list) if (v < value) below += 1;
    return {
      n: list.length,
      median: list[Math.floor((list.length - 1) / 2)],
      higherThanPct: Math.round((100 * below) / Math.max(1, list.length - 1))
    };
  }

  return { build, rank, pctOfRevenue, normalise, SHARE_JUMP, CHECK_YEARS, TREND_YEARS };
});
