/* Stock-based compensation model for the Stocks & funds page.
   One pure function over a company's filed annual rows. It runs in the browser
   (company.js draws from it) and under Node (backend/test/sbc-model.test.js and
   scripts/build-sbc-sector.js), so the page, the tests and the sector table can
   never disagree about what "SBC % of revenue" means.

   Every output is a filed number or arithmetic on filed numbers. A measure
   whose inputs are missing is null and carries the reason in a `…Why` field;
   nothing is estimated or carried forward from another year.

   The rules below that look fussy each come from running this over all 5,761
   companies in the data (2026-10-08): 275 had no SBC line in their newest
   year, 84 had a "five years ago" row that was not five years ago, 99 had two
   fiscal years ending in the same calendar year, 16 filed a negative figure. */
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
  const YEAR_MS = 365.2425 * 86400000;
  // How far from a whole number of years a comparison row may end. A 52/53-week
  // year drifts by days; a changed year-end drifts by months and is refused.
  const TOLERANCE = 0.2;

  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const time = (end) => Date.parse(end);

  // The fiscal year a period belongs to. A 52/53-week year can end on the first
  // days of January: 2 January 2021 closes fiscal 2020, and labelling it by its
  // calendar year gives a company two "FY2021"s and no FY2020. Ten days of
  // slack puts those where the company puts them and moves nothing else.
  function fyOf(end) {
    const t = time(end);
    if (Number.isNaN(t)) return '';
    return 'FY' + new Date(t - 10 * 86400000).getUTCFullYear();
  }

  // A period filed among the annual rows that is not a year long: the stub a
  // company reports when it moves its year-end (six months, sometimes three).
  // Its flows are a fraction of a year's, so it is left out of every comparison
  // rather than drawn as a year in which stock pay halved. A row with no start
  // date is taken at its word.
  function isStub(r) {
    const s = time(r.start);
    if (!r.start || Number.isNaN(s)) return false;
    const len = (time(r.end) - s) / YEAR_MS;
    return len < 0.85 || len > 1.15;
  }

  // rows: [{ end, start, sbc, rev, ocf, capex, buy, dil, sourceId }], any order.
  // capex and buy may be filed as negative outflows; both are read as amounts.
  function normalise(rows) {
    const sorted = (rows || [])
      .filter((r) => r && r.end && !Number.isNaN(time(r.end)) && !isStub(r))
      .map((r) => {
        const ocf = num(r.ocf), capex = num(r.capex), buy = num(r.buy);
        return {
          end: String(r.end), t: time(r.end), fy: fyOf(r.end),
          sbc: num(r.sbc), rev: num(r.rev),
          fcf: ocf !== null && capex !== null ? ocf - Math.abs(capex) : null,
          buy: buy === null ? null : Math.abs(buy),
          dil: num(r.dil),
          sourceId: r.sourceId || null
        };
      })
      .sort((a, b) => a.t - b.t);
    // Two rows ending within a few months of each other cover largely the same
    // twelve months: a year refiled with a slightly different end date, or the
    // old and new fiscal years around a change of year-end. Counting both draws
    // one year twice, so the later-ending one stands for the pair.
    const kept = [];
    for (let i = sorted.length - 1; i >= 0; i -= 1) {
      if (!kept.length || (kept[0].t - sorted[i].t) / YEAR_MS >= 0.6) kept.unshift(sorted[i]);
    }
    return kept;
  }

  const pctOfRevenue = (y) => (y && y.sbc !== null && y.rev !== null && y.rev > 0 ? (100 * y.sbc) / y.rev : null);

  // The row that ends `n` years before `from`, give or take a few weeks. A
  // company with a missing year must not have "five years ago" quietly mean
  // four or six, so this looks at dates, never at position in the list.
  function yearsBack(years, from, n) {
    let best = null;
    for (const y of years) {
      const gap = (from.t - y.t) / YEAR_MS;
      if (Math.abs(gap - n) <= TOLERANCE && (!best || Math.abs(gap - n) < Math.abs((from.t - best.t) / YEAR_MS - n))) best = y;
    }
    return best;
  }

  // Axis labels for the chart: the fiscal year, except where a change of
  // year-end leaves two full years carrying the same one. Those two are told
  // apart by the month they ended in.
  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function ticks(list) {
    const count = {};
    for (const y of list) count[y.fy] = (count[y.fy] || 0) + 1;
    return list.map((y) => {
      const d = new Date(y.t);
      return { y, tick: count[y.fy] > 1 ? `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}` : y.fy.slice(2) };
    });
  }

  function shareChange(from, to) {
    if (!from || !to || from.dil === null || to.dil === null || from.dil <= 0) return null;
    return (to.dil - from.dil) / from.dil;
  }

  // One year's answer to the owner's question: can free cash flow pay for the
  // stock handed to staff and still leave the share count lower? Every phrase
  // is chosen from filed figures; a missing input names itself.
  function flowYear(years, y) {
    const prev = yearsBack(years, y, 1);
    const raw = shareChange(prev, y);
    const change = raw !== null && Math.abs(raw) <= SHARE_JUMP ? raw : null;
    let dilutionWhy = null;
    if (!prev) dilutionWhy = 'Not available: the year before is not in our filings data.';
    else if (raw === null) dilutionWhy = 'Not available: the diluted share count is not in our filings data for both years.';
    else if (Math.abs(raw) > SHARE_JUMP) dilutionWhy = 'Not shown: the diluted share count changed by more than 40% in a year, which usually means a split or a merger rather than dilution.';
    const fcfAfter = y.fcf !== null && y.sbc !== null ? y.fcf - y.sbc : null;
    let pctOfFcf = null, pctOfFcfWhy = null;
    if (y.fcf === null) pctOfFcfWhy = `Not available: operating cash flow or capital expenditure for ${y.fy} is not in our filings data.`;
    else if (y.fcf <= 0) pctOfFcfWhy = 'Not shown: FCF was negative.';
    else if (y.sbc === null) pctOfFcfWhy = `Not available: stock-based compensation for ${y.fy} is not in our filings data.`;
    else if (y.sbc < 0) pctOfFcfWhy = 'Not shown: the filed stock-based compensation figure is a net reversal.';
    else pctOfFcf = (100 * y.sbc) / y.fcf;
    return {
      fy: y.fy, end: y.end, fcf: y.fcf, sbc: y.sbc, fcfAfter,
      buybacks: y.buy, pctOfFcf, pctOfFcfWhy,
      dilutionPct: change === null ? null : 100 * change, dilutionWhy,
      verdict: flowVerdict(y, change, dilutionWhy)
    };
  }

  function flowVerdict(y, change, dilutionWhy) {
    const fy = y.fy;
    if (y.fcf === null) return `Not available: operating cash flow or capital expenditure for ${fy} is not in our filings data.`;
    if (y.fcf < 0) return 'FCF was negative';
    if (y.sbc === null) return `Not available: stock-based compensation for ${fy} is not in our filings data.`;
    if (y.sbc < 0) return 'Not shown: stock-based compensation was a net reversal, so there was no stock cost to fund.';
    if (y.sbc === 0) return 'FCF covered SBC; no stock-based compensation was filed.';
    if (y.fcf < y.sbc) return 'SBC exceeded FCF: dilution was not funded by cash generation';
    const times = (y.fcf / y.sbc).toFixed(1);
    if (change === null) return `FCF covered SBC ${times} times. ${dilutionWhy}`;
    if (change > 0) return `FCF covered SBC but the share count still rose ${(100 * change).toFixed(1)}%`;
    if (change < 0 && y.buy !== null && y.buy > 0) return `FCF covered SBC ${times} times and buybacks reduced the share count`;
    if (change < 0) return `FCF covered SBC ${times} times and the share count fell ${Math.abs(100 * change).toFixed(1)}%, but share buybacks for ${fy} were not filed`;
    return `FCF covered SBC ${times} times and the share count was unchanged`;
  }

  function build(rows) {
    const years = normalise(rows);
    const reported = years.filter((y) => y.sbc !== null);
    if (!reported.length) {
      return { status: 'not_reported', why: 'Not available: no separate stock-based compensation line appears in the cash flow data we hold from this company\'s filings.' };
    }
    const newest = years[years.length - 1];
    const latest = reported[reported.length - 1];
    // The newest filed year has no SBC line although an earlier one does. An old
    // figure under a current heading is how a 2010 number gets read as today's,
    // so nothing is drawn from it: the page says which year is missing and what
    // the last filed figure was.
    if (latest !== newest) {
      return {
        status: 'stale', fy: newest.fy, lastFy: latest.fy, lastSbc: latest.sbc, sourceId: latest.sourceId,
        why: `Not available for ${newest.fy}: the most recent stock-based compensation line in our filings data is for ${latest.fy}.`
      };
    }

    const prev = yearsBack(years, latest, 1);
    const fiveAgo = yearsBack(years, latest, CHECK_YEARS);
    // A negative figure is a net reversal (more stock pay cancelled than
    // expensed). It is the filed number, but it is not a cost, so nothing is
    // measured against it.
    const reversal = latest.sbc < 0;

    const out = {
      status: 'ok',
      fy: latest.fy, end: latest.end, sourceId: latest.sourceId,
      sbc: latest.sbc, reversal,
      pctRevenue: reversal ? null : pctOfRevenue(latest),
      pctRevenueWhy: null,
      pctRevenueFiveAgo: fiveAgo && fiveAgo.sbc !== null && fiveAgo.sbc >= 0 ? pctOfRevenue(fiveAgo) : null,
      fiveAgoFy: fiveAgo ? fiveAgo.fy : null,
      fiveAgoEnd: fiveAgo ? fiveAgo.end : null,
      trend: ticks(reported.slice(-TREND_YEARS)).map(({ y, tick }) => ({ fy: y.fy, tick, sbc: y.sbc, pctRevenue: y.sbc < 0 ? null : pctOfRevenue(y) })),
      fcf: latest.fcf, fcfAfter: null, pctOfFcf: null, fcfWhy: null,
      buybacks: latest.buy, buybackOffsetPct: null,
      dilutionYoY: null, dilutionFive: null, dilutionWhy: null,
      check: null
    };
    if (reversal) out.pctRevenueWhy = `Not shown: the filed figure for ${latest.fy} is a net reversal, not a cost.`;
    else if (out.pctRevenue === null) out.pctRevenueWhy = latest.rev === null ? `Not available: revenue for ${latest.fy} is not in our filings data.` : `Not shown: revenue for ${latest.fy} was not positive.`;

    if (latest.fcf === null) out.fcfWhy = `Not available: operating cash flow or capital expenditure for ${latest.fy} is not in our filings data.`;
    else if (!reversal) {
      out.fcfAfter = latest.fcf - latest.sbc;
      // "SBC is 180% of free cash flow" is meaningful; a share of a negative
      // number is not, so that case is described in words by the page.
      if (latest.fcf > 0) out.pctOfFcf = (100 * latest.sbc) / latest.fcf;
    }

    if (!reversal && latest.buy !== null && latest.buy > 0) out.buybackOffsetPct = (100 * latest.sbc) / latest.buy;

    // Dilution, against the year that actually ended a year earlier.
    const yoy = shareChange(prev, latest);
    if (!prev) out.dilutionWhy = 'Not available: the year before is not in our filings data.';
    else if (yoy === null) out.dilutionWhy = 'Not available: the diluted share count is not in our filings data for both years.';
    else if (Math.abs(yoy) > SHARE_JUMP) out.dilutionWhy = 'Not shown: the diluted share count changed by more than 40% in a year, which usually means a split or a merger rather than dilution.';
    else out.dilutionYoY = 100 * yoy;

    // The five-year figures need every year in between, each a year apart, and
    // no jump across any of them.
    const window = [];
    for (let k = CHECK_YEARS; k >= 0; k -= 1) window.push(k === 0 ? latest : yearsBack(years, latest, k));
    const whole = window.every(Boolean);
    if (whole && out.dilutionYoY !== null) {
      let clean = true;
      for (let k = 1; k < window.length; k += 1) { const c = shareChange(window[k - 1], window[k]); if (c === null || Math.abs(c) > SHARE_JUMP) clean = false; }
      if (clean) out.dilutionFive = 100 * shareChange(window[0], latest);
    }

    // Buybacks against stock pay over five filed years. Only when SBC was filed
    // (and was a cost) in each of the five and a buyback was filed in at least
    // one: a company that never buys back stock is not failing a test it never
    // sat.
    const five = window.slice(1);
    if (five.every((y) => y && y.sbc !== null && y.sbc >= 0) && five.some((y) => y.buy !== null && y.buy > 0)) {
      const buy = five.reduce((n, y) => n + (y.buy || 0), 0);
      const sbc = five.reduce((n, y) => n + y.sbc, 0);
      out.check = { pass: buy > sbc, buybacks: buy, sbc };
    }
    // The five-year table beside the panel's current-year rows. It runs over
    // every annual row, not only the years that filed stock pay: a year with a
    // missing SBC line names that input instead of disappearing from the table.
    out.years = years.slice(-CHECK_YEARS).map((y) => flowYear(years, y));
    out.verdict = out.years[out.years.length - 1].verdict;
    out.verdictFy = out.years[out.years.length - 1].fy;
    return out;
  }

  // Where a value sits in a sorted list of the same measure for a sector.
  // `higherThanPct` is the share of the OTHER companies it exceeds.
  function rank(sorted, value) {
    const list = (sorted || []).filter((v) => typeof v === 'number' && Number.isFinite(v));
    if (value === null || value === undefined || !Number.isFinite(value) || list.length < 10) return null;
    let below = 0;
    for (const v of list) if (v < value) below += 1;
    return {
      n: list.length,
      median: list[Math.floor((list.length - 1) / 2)],
      higherThanPct: Math.min(100, Math.round((100 * below) / Math.max(1, list.length - 1)))
    };
  }

  return { build, rank, pctOfRevenue, normalise, fyOf, SHARE_JUMP, CHECK_YEARS, TREND_YEARS };
});
