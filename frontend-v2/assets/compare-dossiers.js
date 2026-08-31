// Dossier Compare — side-by-side rendering of ALREADY-BUILT dossiers at FULL
// dossier depth. Talks to GET /api/dossier/compare?symbols=A,B,C (backend
// app.js, registered before /api/dossier/:symbol). The route never builds: a
// requested company without a cached Standard dossier comes back in
// { missing } and the UI links to the paid single-dossier page instead of
// spending anything silently.
//
// Section parity rule (owner, 2026-09-01): compare is not a summary surface.
// A user paid 10 credits per dossier here — the compare page must give back
// everything the single dossier's Simple mode shows, per company, arranged so
// the alignment adds value, plus comparison-native visuals that only make
// sense when there are two or three companies on the page:
//   - a computed verdict strip (score dots, exactly the dossier's arithmetic)
//   - the metric table with the winning value bolded per row
//   - one shared-axis "growth index" chart (each company's first filed year
//     normalised to 100)
//   - the health-check grid with every company's pass/fail on one row
//   - scenario upside on one shared bar scale
// Each section row is the SAME component per column, so mobile (which stacks
// the columns) reads as both dossiers in full, mirrored.
(function () {
  'use strict';

  const { API, token, esc, money, num } = window.V2;
  const PV = window.PV;
  const auth = () => (token() ? { Authorization: `Bearer ${token()}` } : {});
  const $ = (id) => document.getElementById(id);
  const report = $('cmp-report');

  const VALID = /^[A-Z0-9.\-]{1,10}$/;
  const readInputs = () => [$('cmp-sym-1'), $('cmp-sym-2'), $('cmp-sym-3')]
    .map((el) => el.value.trim().toUpperCase())
    .filter(Boolean);

  // ---- drawing + formats (same rules as dossier.js: dependency-free SVG,
  // tabular numbers, latest value labelled; nothing recomputed beyond CAGR) --
  const C = { ink: '#1c1b18', accent: '#1a4fd6', pos: '#1b7a4b', neg: '#b4422f', grey: '#8a877e', faint: '#e7e4dd' };
  const COL_ACCENT = ['#1c1b18', '#1a4fd6', '#8a5f00'];
  const bn = (v) => {
    if (v == null) return '—';
    const sign = v < 0 ? '−' : '';
    const a = Math.abs(v);
    return sign + (a >= 1e12 ? '$' + (a / 1e12).toFixed(2) + 'T' : a >= 1e9 ? '$' + (a / 1e9).toFixed(1) + 'B' : '$' + (a / 1e6).toFixed(0) + 'M');
  };
  const numv = (x) => { const n = num(x); return n == null || n === 'None' ? null : Number(n); };

  function chartBars(rows, key, fmt, color) {
    const pts = (rows || []).map((r) => ({ fy: r.fy, v: r[key] })).filter((p) => p.v !== null && p.v !== undefined);
    if (pts.length < 2) return '';
    const max = Math.max(...pts.map((p) => Math.abs(p.v))) || 1;
    const W = 420, H = 160, top = 24, bottom = 28, n = pts.length, plotH = H - top - bottom;
    const slot = W / n, bw = Math.min(32, slot * .58);
    const grid = [0, .5, 1].map((t) => `<line x1="0" y1="${top + plotH * t}" x2="${W}" y2="${top + plotH * t}" stroke="${C.faint}" stroke-width="1"/>`).join('');
    const bars = pts.map((p, i) => {
      const h = Math.max(2, (Math.abs(p.v) / max) * plotH);
      const x = i * slot + (slot - bw) / 2;
      return `<rect x="${x.toFixed(1)}" y="${(top + plotH - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" rx="2"><title>${esc(p.fy)}: ${esc(fmt(p.v))}</title></rect>`;
    }).join('');
    const labs = pts.map((p, i) => `<text x="${(i * slot + slot / 2).toFixed(1)}" y="${H - 6}" font-size="10" fill="${C.grey}" text-anchor="middle">${esc(String(p.fy).slice(-2))}</text>`).join('');
    const latest = pts[pts.length - 1];
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(pts[0].fy)} to ${esc(latest.fy)} trend" style="width:100%;height:160px;display:block">${grid}${bars}${labs}<text x="${W - 4}" y="14" font-size="11" font-weight="650" fill="${C.ink}" text-anchor="end">${esc(fmt(latest.v))}</text></svg>`;
  }
  function chartGroupedBars(rows, series) {
    const usable = (rows || []).filter((r) => series.some((s) => Number.isFinite(Number(r[s.key]))));
    if (usable.length < 2) return '';
    const values = series.flatMap((s) => usable.map((r) => Number(r[s.key])).filter(Number.isFinite));
    const min = Math.min(0, ...values), max = Math.max(0, ...values), span = max - min || 1;
    const W = 420, H = 170, top = 18, bottom = 30, plotH = H - top - bottom;
    const y = (v) => top + ((max - v) / span) * plotH;
    const zeroY = y(0);
    const slot = W / usable.length;
    const groupW = Math.min(slot * .72, 38);
    const bw = Math.max(3, groupW / series.length - 2);
    const bars = usable.map((r, ri) => series.map((s, si) => {
      const value = Number(r[s.key]);
      if (!Number.isFinite(value)) return '';
      const x = ri * slot + (slot - groupW) / 2 + si * (bw + 2);
      const vy = y(value), height = Math.max(2, Math.abs(zeroY - vy));
      return `<rect x="${x.toFixed(1)}" y="${Math.min(vy, zeroY).toFixed(1)}" width="${bw.toFixed(1)}" height="${height.toFixed(1)}" fill="${value < 0 ? C.neg : s.color}" rx="2"><title>${esc(r.fy)} ${esc(s.label)}: ${esc((s.fmt || String)(value))}</title></rect>`;
    }).join('')).join('');
    const labels = usable.map((r, i) => `<text x="${(i * slot + slot / 2).toFixed(1)}" y="${H - 7}" font-size="10" fill="${C.grey}" text-anchor="middle">${esc(String(r.fy).slice(-2))}</text>`).join('');
    return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Grouped annual bar chart from ${esc(usable[0].fy)} to ${esc(usable[usable.length - 1].fy)}" style="width:100%;height:170px;display:block"><line x1="0" y1="${zeroY.toFixed(1)}" x2="${W}" y2="${zeroY.toFixed(1)}" stroke="${C.faint}"/>${bars}${labels}</svg>`;
  }
  function legend(items) {
    return `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:4px;">${items.map((i) => `<span class="small" style="color:var(--ink-3)"><span style="display:inline-block;width:9px;height:9px;background:${i.color};border-radius:2px;margin-right:4px;vertical-align:middle"></span>${esc(i.label)}</span>`).join('')}</div>`;
  }

  // ---- list rendering: shape-aware, FULL depth (the [object Object] lesson
  // lives in the pin: bull/bear items are {point, basis}, risk items are
  // {risk, trigger, impact, mitigant, severity}; plain translation keeps those
  // keys; only pre-schema caches hold bare strings).
  const SEV_WORD = { high: 'high severity', medium: 'moderate', low: 'low' };
  const SEV_STEP = { high: 3, medium: 2, low: 1 };
  const caseListHtml = (arr) => {
    const items = (Array.isArray(arr) ? arr : []).map((x) => {
      if (typeof x === 'string') return `<li>${esc(x)}</li>`;
      if (!x) return null;
      if (x.point) return `<li>${esc(x.point)}${x.basis ? `<span class="cmp-basis">${esc(x.basis)}</span>` : ''}</li>`;
      const fallback = Object.values(x).find((v) => typeof v === 'string' && v.trim());
      return fallback ? `<li>${esc(fallback)}</li>` : null;
    }).filter(Boolean);
    return items.length ? items.join('') : '<li class="faint">—</li>';
  };
  const riskListHtml = (arr) => {
    const items = (Array.isArray(arr) ? arr : []);
    if (!items.length) return '<p class="cmp-none">No risk items on record.</p>';
    return items.map((x) => {
      if (typeof x === 'string') return `<p class="cmp-risk-item">${esc(x)}</p>`;
      if (!x || !x.risk) return '';
      const step = SEV_STEP[x.severity] || 2;
      return `<div class="cmp-risk-item">
        <div class="cmp-risk-head"><strong>${esc(x.risk)}</strong><span class="small faint">${esc(PV.plainSeverity(x.severity))}</span></div>
        <div class="pv-meter">${[1, 2, 3].map((i) => `<i class="${i <= step ? `is-on ${step === 3 ? 'high' : step === 2 ? 'mid' : 'low'}` : ''}"></i>`).join('')}</div>
        ${x.trigger ? `<div class="small" style="margin-top:4px;"><strong>Trigger:</strong> ${esc(x.trigger)}</div>` : ''}
        ${x.impact ? `<div class="small"><strong>Impact:</strong> ${esc(x.impact)}</div>` : ''}
        ${x.mitigant ? `<div class="small" style="margin-top:4px; color:var(--ink-3);"><strong>Mitigant:</strong> ${esc(x.mitigant)}</div>` : ''}
      </div>`;
    }).filter(Boolean).join('') || '<p class="cmp-none">No risk items on record.</p>';
  };

  // ---- decision brief: the same words the single dossier opens with, and the
  // same fallback arithmetic when a cached summary is missing ----
  function deterministicBrief(d) {
    const fin = d.financials || [];
    const first = fin[0] || {}; const latest = fin[fin.length - 1] || {};
    const years = Math.max(1, Number(latest.fy) - Number(first.fy));
    const revCagr = first.revenue > 0 && latest.revenue > 0 ? (Math.pow(latest.revenue / first.revenue, 1 / years) - 1) * 100 : null;
    const lines = [];
    if (fin.length > 1) lines.push(`${d.name || d.symbol}'s filed revenue rose from ${bn(first.revenue)} in ${first.fy} to ${bn(latest.revenue)} in ${latest.fy}${revCagr == null ? '' : `, a ${revCagr.toFixed(1)}% annualised increase`}; over the same record, operating margin moved from ${first.opMarginPct == null ? 'an unavailable starting value' : first.opMarginPct + '%'} to ${latest.opMarginPct == null ? 'an unavailable latest value' : latest.opMarginPct + '%'}, while latest free cash flow was ${bn(latest.fcf)}.`);
    const cp = d.competitive;
    if (cp && cp.company && cp.medians) {
      const peerBits = [];
      if (cp.company.revCagr5Pct != null && cp.medians.revCagr5Pct != null) peerBits.push(`five-year revenue growth of ${cp.company.revCagr5Pct}% versus the peer median ${cp.medians.revCagr5Pct}%`);
      if (cp.company.netMarginPct != null && cp.medians.netMarginPct != null) peerBits.push(`net margin of ${cp.company.netMarginPct}% versus ${cp.medians.netMarginPct}%`);
      if (peerBits.length) lines.push(`Against ${cp.peerCount || 'its'} ${cp.sector || 'sector'} peers, the filed record shows ${peerBits.join(' and ')}.`);
      if (cp.company.pe != null && cp.medians.pe != null) lines.push(`The valuation tension is explicit: ${cp.company.pe}× earnings versus a ${cp.medians.pe}× peer median, so the operating advantage must persist merely to defend the current premium.`);
    }
    if (d.valuation && d.valuation.impliedGrowthPct != null) {
      const hist = d.valuation.record && d.valuation.record.fcfCagr5Pct;
      lines.push(`The reverse-DCF assumptions imply roughly ${d.valuation.impliedGrowthPct}% annual free-cash-flow growth${hist != null ? ` versus a filed five-year rate of ${hist}%` : ''}; that gap is an expectations test, not a forecast or price target.`);
    }
    return lines.join(' ') || `This brief is built from ${d.name || d.symbol}'s filed financial record. Open the evidence below to test the business, valuation and risks.`;
  }
  function briefText(d) {
    return String(d.executiveSummaryPlain || d.executiveSummary || '').trim() || deterministicBrief(d);
  }
  function briefParagraphs(text) {
    const sentences = String(text || '').trim().split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean);
    return (sentences.length ? sentences : [String(text || '')]).map((sentence) => `<p>${esc(sentence)}</p>`).join('');
  }
  const finCagr = (fin) => {
    if (!fin || fin.length < 2) return null;
    const first = fin[0], latest = fin[fin.length - 1];
    const years = Math.max(1, Number(latest.fy) - Number(first.fy));
    return first.revenue > 0 && latest.revenue > 0 ? (Math.pow(latest.revenue / first.revenue, 1 / years) - 1) * 100 : null;
  };

  // Verdict score: the EXACT arithmetic the single dossier's Simple mode uses
  // (revenue direction + margin move + FCF-positive share − high-risk count).
  function verdictScore(d) {
    const history = d.financials || [];
    let score = 2.5;
    if (history.length >= 2) {
      const last = history[history.length - 1] || {}, prev = history[history.length - 2] || {};
      if ((last.revenue || 0) > (prev.revenue || 0)) score += 0.5; else if (last.revenue != null) score -= 0.5;
      if ((last.opMarginPct || 0) > (prev.opMarginPct || 0)) score += 0.5; else if (last.opMarginPct != null) score -= 0.5;
    }
    const fcfPosYears = history.filter((r) => (r.fcf || 0) > 0).length;
    if (history.length) score += (fcfPosYears / history.length - 0.5);
    const risks = (d.risksPlain && d.risksPlain.length) ? d.risksPlain : (d.risks || []);
    const highRisks = risks.filter((r) => r && r.severity === 'high').length;
    score -= Math.min(1.5, highRisks * 0.5);
    return Math.max(0, Math.min(5, score));
  }

  // ---- the verdict banner (comparison-native) — computed only from numbers
  // already in the payloads: no model call, nothing invented. UNIFORM layout:
  // every company gets the same three plain-English stat rows in the same
  // order, so the two columns always carry the same shape of information. ----
  function verdictStrip(cols) {
    const per = cols.map((d) => ({
      d,
      sym: d.symbol || d.name || '?',
      cagr: finCagr(d.financials || []),
      opMargin: numv((d.financials || []).length ? d.financials[d.financials.length - 1].opMarginPct : null),
      pe: numv(d.snapshot && d.snapshot.pe),
      score: verdictScore(d)
    }));
    const two = per.length === 2;
    const grid = two ? '1fr auto 1fr' : `repeat(${per.length}, minmax(0, 1fr))`;
    // A value row shared by all columns; with two companies a small "vs"
    // sits in the middle so the columns read against each other.
    const valRow = (cells) => `<div class="cmp-vs-vals" style="grid-template-columns:${grid};">${
      (two ? [cells[0], '<i class="cmp-vs-mid">vs</i>', cells[1]] : cells).join('')
    }</div>`;
    // One labelled comparison row: label line, then the same slot per company.
    // Winner gets the green ● only when both values exist and are distinct.
    const statRow = (label, vals, fmt, dir, minGap) => {
      const have = vals.map((v) => (Number.isFinite(Number(v)) ? Number(v) : null));
      let win = -1;
      const nums = have.filter((v) => v != null);
      if (nums.length >= 2) {
        const sorted = [...nums].sort((a, b) => dir > 0 ? b - a : a - b);
        const gap = dir > 0 ? sorted[0] - sorted[1] : sorted[1] - sorted[0];
        if (gap > (minGap || 0)) win = have.indexOf(sorted[0]);
      }
      return `<div class="cmp-vs-label">${esc(label)}</div>${valRow(have.map((v, i) =>
        `<div class="cmp-vs-val${i === win ? ' win' : ''}">${v == null ? '—' : fmt(v)}</div>`))}`;
    };
    return `
      <div class="cmp-banner">
        <div class="cmp-banner-head"><p class="cmp-sec-label" style="margin:0;">Verdict</p><span class="cmp-sec-note">scored from their filings — same rules for both</span></div>
        <div class="cmp-vs-vals cmp-banner-cols" style="grid-template-columns:${grid};">${(two
          ? [per[0], null, per[1]]
          : per).map((p) => p === null
          ? '<i class="cmp-vs-mid cmp-vs-mid-tall">vs</i>'
          : `<div class="cmp-banner-co">
              ${PV.ratingDots(p.score, 5)}
              <div class="cmp-banner-score">${p.score.toFixed(1)}<span class="of"> / 5</span></div>
              <div class="cmp-banner-name">${esc(p.d.name || p.sym)}</div>
              <div class="cmp-banner-sym">${esc(p.sym)}</div>
            </div>`).join('')}</div>
        ${statRow('Growth, across their filed years', per.map((p) => p.cagr), (n) => `${n.toFixed(1)}% a year`, 1, 1)}
        ${statRow('Keeps as profit, per dollar of sales', per.map((p) => p.opMargin), (n) => `${n.toFixed(1)}¢`, 1, 1)}
        ${statRow('Price ÷ earnings — lower is cheaper', per.map((p) => p.pe), (n) => `${n.toFixed(1)}×`, -1, 0.8)}
      </div>`;
  }

  // ---- the metric table, with the winner of each row bolded. dir: +1 higher
  // is better, -1 lower is better, 0 = context only (no bolding). ----
  const METRIC_ROWS = [
    { label: 'Market cap', v: (d) => numv(d.snapshot && d.snapshot.marketCap), show: (n) => '$' + money(n), dir: 0 },
    { label: 'P/E', v: (d) => numv(d.snapshot && d.snapshot.pe), show: (n) => Number(n).toFixed(1) + '×', dir: -1 },
    { label: 'EPS', v: (d) => numv(d.snapshot && d.snapshot.eps), show: (n) => Number(n).toFixed(2), dir: 1 },
    { label: 'Profit margin', v: (d) => numv(d.snapshot && d.snapshot.profitMargin), show: (n) => n.toFixed(1) + '%', dir: 1 },
    { label: 'Return on equity', v: (d) => numv(d.snapshot && d.snapshot.roe), show: (n) => n.toFixed(1) + '%', dir: 1 },
    { label: 'Dividend yield', v: (d) => numv(d.snapshot && d.snapshot.dividendYield), show: (n) => n.toFixed(1) + '%', dir: 1 },
    { label: 'Latest filed revenue', v: (d) => numv((d.financials || []).length && d.financials[d.financials.length - 1].revenue), show: (n) => bn(n), dir: 1 },
    { label: 'Operating margin (same year)', v: (d) => numv((d.financials || []).length && d.financials[d.financials.length - 1].opMarginPct), show: (n) => n.toFixed(1) + '%', dir: 1 },
    { label: 'Free cash flow (same year)', v: (d) => numv((d.financials || []).length && d.financials[d.financials.length - 1].fcf), show: (n) => bn(n), dir: 1 },
    { label: 'Revenue CAGR (filed record)', v: (d) => finCagr(d.financials || []), show: (n) => n.toFixed(1) + '%', dir: 1 }
  ];
  function metricTable(cols) {
    const rows = METRIC_ROWS.map((row) => {
      const vals = cols.map((d) => { let v; try { v = row.v(d); } catch (_) { v = null; } return Number.isFinite(Number(v)) ? Number(v) : null; });
      let winner = -1;
      if (row.dir && vals.filter((v) => v != null).length >= 2) {
        const finite = vals.map((v) => v == null ? (row.dir > 0 ? -Infinity : Infinity) : v);
        const best = row.dir > 0 ? Math.max(...finite) : Math.min(...finite);
        const spread = Math.max(...finite.filter(Number.isFinite)) - Math.min(...finite.filter(Number.isFinite));
        if (Number.isFinite(best) && spread > 0.001) winner = finite.indexOf(best);
      }
      return `<tr><td>${esc(row.label)}</td>${vals.map((v, i) => `<td${winner === i ? ' class="cmp-win"' : ''}>${v == null ? '—' : esc(row.show(v))}</td>`).join('')}</tr>`;
    }).join('');
    return `
      <p class="cmp-sec-label">Key metrics <span class="cmp-sec-note">the better value is bold — bolding is arithmetic, not advice</span></p>
      <div class="table-wrap cmp-metric-table"><table class="table-data">
        <thead><tr><th>Metric</th>${cols.map((d) => `<th>${esc(d.symbol || '')}</th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <p class="small faint" style="margin:8px 0 0;">Snapshot figures are trailing-twelve-month; revenue, operating margin, free cash flow and the CAGR line come from each dossier's latest filed 10-K year.</p>`;
  }

  // ---- growth-index overlay (comparison-native): every company's own first
  // filed year = 100, one shared axis — growth rate, visible in one glance ----
  function growthIndexChart(cols) {
    const series = cols.map((d, ci) => {
      const fin = d.financials || [];
      const pts = fin.map((r) => Number(r.revenue)).filter((v) => v > 0);
      if (pts.length < 2) return null;
      const base = pts[0];
      return { sym: d.symbol || d.name || '?', color: COL_ACCENT[ci % COL_ACCENT.length], pts: pts.map((v) => v / base * 100), fys: fin.map((r) => r.fy) };
    }).filter(Boolean);
    if (series.length < 2) return '';
    const n = Math.max(...series.map((s) => s.pts.length));
    if (n < 2) return '';
    const allV = series.flatMap((s) => s.pts);
    const max = Math.max(100, ...allV) * 1.08;
    const min = Math.min(100, ...allV) * 0.92;
    const W = 560, H = 200, top = 24, bottom = 30, plotH = H - top - bottom;
    const x = (i) => (n === 1 ? 0 : (i / (n - 1)) * W);
    const y = (v) => top + ((max - v) / (max - min)) * plotH;
    const grid = [min, (min + max) / 2, max].map((v) => `<line x1="0" y1="${y(v).toFixed(1)}" x2="${W}" y2="${y(v).toFixed(1)}" stroke="${C.faint}"/>`).join('');
    const base = `<line x1="0" y1="${y(100)}" x2="${W}" y2="${y(100)}" stroke="${C.grey}" stroke-dasharray="4 4"/>`;
    const paths = series.map((s) => `<polyline fill="none" stroke="${s.color}" stroke-width="2.5" points="${s.pts.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}"/>` + s.pts.map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="3" fill="${s.color}"><title>${esc(s.sym)} ${esc(s.fys[i] || '')}: index ${v.toFixed(0)} (first year = 100)</title></circle>`).join('')).join('');
    const endLabels = series.map((s) => {
      const last = s.pts[s.pts.length - 1];
      return `<text x="${(W - 2)}" y="${(y(last) + 4).toFixed(1)}" font-size="11" font-weight="700" fill="${s.color}" text-anchor="end">${esc(last.toFixed(0))}</text>`;
    }).join('');
    const years = Math.max(...series.map((s) => s.pts.length)) - 1;
    const axis = `<text x="4" y="${H - 8}" font-size="10" fill="${C.grey}">each company's first filed year</text><text x="${W - 4}" y="${H - 8}" font-size="10" fill="${C.grey}" text-anchor="end">+${years} filed year${years === 1 ? '' : 's'} →</text>`;
    return `
      <p class="cmp-sec-label">Growth, one axis <span class="cmp-sec-note">each company's first filed year normalised to 100 — the steeper line compounds faster; exact values on hover</span></p>
      <div class="cmp-overlay">${`<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Filed revenue growth indexed to 100 at each company's first filed year" style="width:100%;height:200px;display:block">${grid}${base}${paths}${endLabels}${axis}</svg>`}
      ${legend(series.map((s) => ({ label: `${s.sym} (ends at ${s.pts[s.pts.length - 1].toFixed(0)}/100)`, color: s.color })))}</div>`;
  }

  // ---- health checks, comparison-native grid: one row per filed test, every
  // company's verdict on that row ----
  function healthCompare(cols) {
    const lists = cols.map((d) => (Array.isArray(d.healthChecks) ? d.healthChecks : []));
    if (!lists.some((l) => l.length)) return '';
    const labels = [];
    lists.forEach((l) => l.forEach((c) => { if (c.label && !labels.includes(c.label)) labels.push(c.label); }));
    if (!labels.length) return '';
    const cell = (l, label) => {
      const c = l.find((x) => x.label === label);
      if (!c) return '<td class="cmp-faint-cell">—</td>';
      return `<td class="${c.pass ? 'cmp-check-pass' : 'cmp-check-fail'}" title="${esc(c.detail || c.label)}">${c.pass ? '✓' : '✗'}</td>`;
    };
    const rows = labels.map((label) => `<tr><td>${esc(label)}</td>${lists.map((l) => cell(l, label)).join('')}</tr>`).join('');
    const scores = lists.map((l) => `${l.filter((c) => c.pass).length}/${l.length}`);
    return `
      <p class="cmp-sec-label">Health checks <span class="cmp-sec-note">one row per filed test — each company's pass/fail on that same test · computed from filings, not advice</span></p>
      <div class="table-wrap"><table class="table-data cmp-health">
        <thead><tr><th>Test</th>${cols.map((d, i) => `<th>${esc(d.symbol || '')} <span class="faint">${esc(scores[i])}</span></th>`).join('')}</tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`;
  }

  // ---- scenario value bands (comparison-native): each company's bear / base
  // / bull value and upside on one shared bar scale per scenario ----
  function scenarioCompare(cols) {
    const scs = cols.map((d) => d.valuation && d.valuation.scenarios ? d.valuation.scenarios : null);
    if (!scs.some(Boolean)) return '';
    const rowFor = (k) => {
      const ups = cols.map((d, i) => {
        if (!scs[i] || !scs[i][k]) return null;
        const x = scs[i][k];
        return { sym: d.symbol || d.name || '?', value: numv(x.value), upside: numv(x.upsidePct), growth: x.growthPct };
      });
      if (!ups.some(Boolean)) return '';
      const maxAbs = Math.max(...ups.filter(Boolean).map((u) => Math.abs(u.upside != null ? u.upside : 0)), 1);
      return `
        <div class="cmp-scen-row"><span class="cmp-scen-k">${esc(k)}</span>
          <div class="cmp-scen-cols" style="grid-template-columns:repeat(${cols.length}, minmax(0, 1fr));">${ups.map((u, i) => {
            if (!u) return `<div class="cmp-scen-cell small faint">—</div>`;
            const pct = Math.max(3, Math.abs(u.upside != null ? u.upside : 0) / maxAbs * 100);
            return `<div class="cmp-scen-cell"><div class="pv-scale-row"><span class="pv-scale-label">${esc(u.sym)}</span><span class="pv-scale-track"><i class="pv-scale-fill ${u.upside >= 0 ? 'pos' : 'neg'}" style="width:${pct.toFixed(1)}%"></i></span><b class="pv-scale-val">${u.upside >= 0 ? '+' : '−'}${Math.abs(u.upside).toFixed(0)}%</b></div><span class="small faint">${esc(bn(u.value))} · at ${esc(String(u.growth))}%/yr growth</span></div>`;
          }).join('')}</div>
        </div>`;
    };
    return `
      <p class="cmp-sec-label">Scenario value range <span class="cmp-sec-note">bear / base / bull — a value band, not a price target</span></p>
      ${rowFor('bear')}${rowFor('base')}${rowFor('bull')}`;
  }

  // ---- per-company panels (everything below is the dossier's own copy of
  // that section; nothing is recomputed) ----
  const tag = (d) => `<span class="cmp-tag">${esc(d.symbol || '')}</span>`;
  function trendsPanel(d) {
    const history = d.financials || [];
    if (history.length < 2) return `<div class="pv-card">${tag(d)}<h2>The trend</h2><p class="small faint">No multi-year filed history is available.</p></div>`;
    const last = history[history.length - 1] || {}, prev = history[history.length - 2] || {};
    return `
      <div class="pv-card">
        ${tag(d)}<h2>The trend</h2>
        <div class="dos-visual-stack">
          <div class="dos-visual-panel"><h3>Revenue</h3><p>${last.revenue > prev.revenue ? 'Growing' : 'Shrinking'} year over year</p>${chartBars(history, 'revenue', bn, C.ink)}</div>
          <div class="dos-visual-panel"><h3>Profit and cash</h3><p>Net income versus free cash flow</p>${chartGroupedBars(history, [{ key: 'netIncome', label: 'Net income', color: C.pos, fmt: bn }, { key: 'fcf', label: 'Free cash flow', color: C.grey, fmt: bn }])}${legend([{ label: 'Net income', color: C.pos }, { label: 'Free cash flow', color: C.grey }])}</div>
        </div>
      </div>`;
  }
  function moneyPanel(d) {
    const last = (d.financials || [])[d.financials.length - 1] || {};
    if (!last.revenue) return `<div class="pv-card">${tag(d)}<h2>Where the money goes</h2><p class="small faint">Not available for this company.</p></div>`;
    const cost = Math.max(0, (last.revenue || 0) - (last.grossProfit != null ? last.grossProfit : (last.revenue || 0) - (last.costOfRevenue || 0)));
    const profit = Math.max(0, last.netIncome || 0);
    const other = Math.max(0, (last.revenue || 0) - cost - profit);
    return `
      <div class="pv-card">
        ${tag(d)}<h2>Where the money goes</h2>
        <p class="small faint" style="margin:0 0 10px;">Every $1 of ${esc(last.fy || 'latest year')} sales</p>
        ${PV.splitBar([
          { label: 'Cost of what it sells', value: cost, color: 'var(--neg)', shown: PV.perDollar(cost / last.revenue * 100) },
          { label: 'Everything else (opex, tax, interest)', value: other, color: 'var(--ink-3)', shown: PV.perDollar(other / last.revenue * 100) },
          { label: 'Kept as profit', value: profit, color: 'var(--pos)', shown: PV.perDollar(profit / last.revenue * 100) }
        ])}
      </div>`;
  }
  function unitPanel(d) {
    const ue = d.unitEconomics;
    if (ue && ue.derived && ue.derived.revenuePerUnit != null) {
      return `
        <div class="pv-card">
          ${tag(d)}<h2>What it earns per ${esc(ue.unitLabel || 'unit')}</h2>
          <p class="small faint" style="margin:0 0 10px;">Fiscal ${esc(ue.fiscalYear || '')} · price paid ~$${money(ue.derived.revenuePerUnit)}</p>
          ${PV.splitBar([
            { label: 'Cost to make one', value: Math.max(0, ue.derived.revenuePerUnit - (ue.derived.grossProfitPerUnit || 0)), color: 'var(--neg)', shown: ue.derived.costPerUnit != null ? '$' + money(ue.derived.costPerUnit) : undefined },
            { label: 'Profit kept', value: Math.max(0, ue.derived.grossProfitPerUnit || 0), color: 'var(--pos)', shown: ue.derived.grossProfitPerUnit != null ? '$' + money(ue.derived.grossProfitPerUnit) : undefined }
          ])}
          ${(ue.derived && ue.derived.note) || ue.note ? `<p class="small faint" style="margin-top:8px;">${esc((ue.derived && ue.derived.note) || ue.note)}</p>` : ''}
        </div>`;
    }
    if (ue && Array.isArray(ue.metrics) && ue.metrics.length) {
      const rows = ue.metrics.slice(0, 4).map((m) => {
        const val = m.value != null ? money(m.value) : '—';
        const unitSuffix = m.unit && !/^(count|units?|#)$/i.test(String(m.unit).trim()) ? ' ' + esc(m.unit) : '';
        return `<li><b>${esc(m.name || 'Metric')}</b>: ${val}${unitSuffix}${m.period ? ` <span class="small faint">(${esc(m.period)})</span>` : ''}</li>`;
      }).join('');
      const note = (ue.derived && ue.derived.note) || ue.note;
      return `
        <div class="pv-card">
          ${tag(d)}<h2>What we know about its ${esc(ue.unitLabel || 'units')}</h2>
          <ul style="padding-left:18px; margin:0;">${rows}</ul>
          ${note ? `<p class="small faint" style="margin-top:8px;">${esc(note)}</p>` : ''}
        </div>`;
    }
    return `<div class="pv-card">${tag(d)}<h2>What it earns per unit</h2><p class="small faint">No filed unit economics on record for this company.</p></div>`;
  }
  function sellsPanel(d) {
    const items = d.segments && d.segments.items && d.segments.items.length ? d.segments.items : null;
    if (!items) return `<div class="pv-card">${tag(d)}<h2>What it sells</h2><p class="small faint">No filed segment breakdown on record.</p></div>`;
    return `
      <div class="pv-card">
        ${tag(d)}<h2>What it sells</h2>
        ${PV.share(items.map((x) => ({ label: x.name, pct: x.revenuePct, note: x.description })))}
        ${d.segments.fiscalYear ? `<p class="small faint" style="margin:8px 0 0;">Filed segment split, ${esc(d.segments.fiscalYear)}${d.segments.note ? ' · ' + esc(d.segments.note) : ''}</p>` : ''}
      </div>`;
  }
  const simpleArr = (d, k) => (d[k + 'Plain'] && d[k + 'Plain'].length) ? d[k + 'Plain'] : (d[k] || []);
  function bullPanel(d) {
    return `<div class="pv-card">${tag(d)}<h2>The bull case</h2><ul class="cmp-list">${caseListHtml(simpleArr(d, 'bull'))}</ul></div>`;
  }
  function bearPanel(d) {
    return `<div class="pv-card">${tag(d)}<h2>The bear case</h2><ul class="cmp-list">${caseListHtml(simpleArr(d, 'bear'))}</ul></div>`;
  }
  function risksPanel(d) {
    const risks = (d.risksPlain && d.risksPlain.length) ? d.risksPlain : (d.risks || []);
    return `<div class="pv-card">${tag(d)}<h2>Risks</h2>${riskListHtml(risks)}</div>`;
  }
  function priceAssumesPanel(d) {
    const v = d.valuation;
    if (!(v && v.impliedGrowthPct != null)) return `<div class="pv-card">${tag(d)}<h2>What the price assumes</h2><p class="small faint">No reverse-DCF expectations on record for this company.</p></div>`;
    const rec = v.record || {};
    return `
      <div class="pv-card">
        ${tag(d)}<h2>What the price assumes</h2>
        <p class="small faint" style="margin:0 0 10px;">Growth priced in vs. actually delivered 5-year growth</p>
        ${PV.pairBars('Priced in', v.impliedGrowthPct, 'Actually delivered', rec.fcfCagr5Pct || 0, (x) => x + '%/yr')}
      </div>`;
  }
  function rivalsPanel(d) {
    const cp = d.competitive;
    if (!(cp && cp.company && cp.medians)) return `<div class="pv-card">${tag(d)}<h2>Versus rivals</h2><p class="small faint">No peer-median comparison on record.</p></div>`;
    return `
      <div class="pv-card">
        ${tag(d)}<h2>Versus rivals</h2>
        <p class="small faint" style="margin:0 0 10px;">${esc(d.symbol || '')} vs the ${esc(cp.sector || '')} peer median${cp.peerCount != null ? ` (${esc(cp.peerCount)} peers)` : ''}</p>
        ${cp.company.revCagr5Pct != null ? PV.pairBars(`${esc(d.symbol || '')} revenue growth`, cp.company.revCagr5Pct, 'Peer median', cp.medians.revCagr5Pct, (x) => x + '%/yr') : ''}
        ${cp.company.netMarginPct != null ? PV.pairBars(`${esc(d.symbol || '')} net margin`, cp.company.netMarginPct, 'Peer median', cp.medians.netMarginPct, (x) => x + '%') : ''}
      </div>`;
  }
  function metricBarPair(x) {
    const prior = Number(x.prior == null ? 0 : x.prior) || 0, latest = Number(x.latest == null ? 0 : x.latest) || 0;
    const max = Math.max(Math.abs(prior), Math.abs(latest), 1);
    const row = (label, shown, value, isLatest) => `<div class="dos-bar-line ${isLatest ? 'is-latest' : ''} ${value < 0 ? 'is-negative' : ''}"><span>${label}</span><span class="dos-bar-track"><i class="dos-bar-fill" style="width:${Math.max(3, Math.abs(value) / max * 100).toFixed(1)}%"></i></span><b>${esc(shown)}</b></div>`;
    return `<div class="dos-bar-pair">${row('Prior', x.prior == null ? '—' : String(x.prior), prior, false)}${row('Latest', x.latest == null ? '—' : String(x.latest), latest, true)}</div>`;
  }
  function filingPanel(d) {
    const rc = d.recentChanges;
    const sym = d.symbol || '';
    if (!rc || !rc.summary) return `<div class="pv-card">${tag(d)}<h2>Latest filing</h2><p class="small faint">No recent-filing read on record for this dossier.</p></div>`;
    const periodText = rc.reportedPeriod && rc.priorPeriod ? `${rc.reportedPeriod} versus ${rc.priorPeriod}` : '';
    const mb = rc.materialityBreakdown || {};
    const materiality = `
      <div class="dos-materiality">
        <strong>${esc(String(rc.materiality == null ? '—' : rc.materiality))}</strong>
        <div class="dos-materiality-bars">${[['Numbers', mb.numbers], ['Language', mb.language], ['Risk', mb.risk]].map(([label, value]) => `<div class="dos-materiality-row"><span>${esc(label)}</span><i><b style="width:${Math.max(2, Math.min(100, Number(value) || 0))}%"></b></i><strong>${Number(value) || 0}</strong></div>`).join('')}</div>
      </div>`;
    const deltaRows = (rc.deltas || []).map((x) => `
      <div class="dos-delta-row">
        <div class="dos-delta-row-head"><span>${esc(x.label)}</span><b class="${x.direction === 'up' ? 'delta-pos' : x.direction === 'down' ? 'delta-neg' : ''}">${esc(x.change)}</b></div>
        ${metricBarPair(x)}
      </div>`).join('');
    const changeRows = (rc.changes || []).map((c) => {
      const pair = c.evidenceVerified && c.priorQuote && c.newQuote;
      return `<li><strong>${esc(c.area)}</strong><span>${esc(c.what)}</span>${pair ? `<div class="dos-quote-pair"><div class="dos-quote-side"><b>Prior filing</b><q>${esc(c.priorQuote)}</q></div><i>→</i><div class="dos-quote-side"><b>New filing</b><q>${esc(c.newQuote)}</q></div></div>` : ''}</li>`;
    }).join('');
    const cmp = rc.comparison;
    const eventNote = rc.latestEvent ? `<div class="cmp-event-note"><strong>Newer event filing kept separate.</strong> ${esc(rc.latestEvent.label || rc.latestEvent.form)} filed ${esc(rc.latestEvent.date)} is newer than the periodic comparison above and is not presented as the same analysis.</div>` : '';
    return `
      <div class="pv-card">
        ${tag(d)}<h2>Latest filing <span class="small faint" style="font-weight:400;">${esc(periodText)}${rc.currency ? ` · ${esc(rc.currency)}` : ''}</span></h2>
        ${materiality}
        ${rc.headline ? `<p style="margin:0 0 6px; font-weight:650;">${esc(rc.headline)}</p>` : ''}
        ${rc.summary ? `<p style="margin:0; font-size:13px; line-height:1.6;">${esc(String(rc.summary).slice(0, 900))}</p>` : ''}
        ${deltaRows ? `<div class="dos-delta-list" style="margin-top:12px;">${deltaRows}</div>` : ''}
        ${changeRows ? `<ul class="cmp-change-list">${changeRows}</ul>` : ''}
        ${cmp && cmp.latest && cmp.prev ? `<p class="small faint" style="margin:10px 0 0;">Compared <a href="${esc(cmp.latest.url)}" target="_blank" rel="noopener">${esc(cmp.latest.form)} ${esc(cmp.latest.date)}</a> with <a href="${esc(cmp.prev.url)}" target="_blank" rel="noopener">${esc(cmp.prev.form)} ${esc(cmp.prev.date)}</a>. Quotation pairs display only when verified against both SEC documents.</p>` : ''}
        ${eventNote}
        <div class="cmp-link"><a href="/dossier.html?symbol=${encodeURIComponent(sym)}">Open the full dossier →</a></div>
      </div>`;
  }

  // ---- Deep research — one collapsible per company with the analyst tables
  // (the single dossier keeps the same detail behind "Show the analyst
  // numbers"; here it is per company) ----
  const dosSec = (title, sub, inner) => inner ? `<div class="dos-sec"><h3>${esc(title)}${sub ? ` <span class="small faint">${esc(sub)}</span>` : ''}</h3>${inner}</div>` : '';
  function deepDetails(d, i) {
    const sym = d.symbol || '';
    const bits = [];
    const edgeArr = (d.edgePlain && d.edgePlain.length) ? d.edgePlain : (d.edge || []);
    if (edgeArr.length) {
      bits.push(dosSec('Forensic signals', 'non-obvious evidence a summary misses', `<ul class="cmp-deep-list">${edgeArr.map((it) => `<li><b>${esc(it.insight || '')}</b>${it.evidence ? ` <span class="small" style="color:var(--accent-ink);">${esc(it.evidence)}</span>` : ''}${it.soWhat ? `<span class="cmp-basis">${esc(it.soWhat)}</span>` : ''}</li>`).join('')}</ul>`));
    }
    if ((d.analystRead || []).length) {
      bits.push(dosSec('Analyst read', '', `<ul class="cmp-deep-list">${d.analystRead.map((it) => `<li><b>${esc(it.title)}</b><span class="cmp-basis">${esc(it.body)}</span></li>`).join('')}</ul>`));
    }
    const ind = d.industry;
    if (ind && !ind.error && Array.isArray(ind.drivers) && ind.drivers.length) {
      bits.push(dosSec('Industry & competitive drivers', ind.sector || '', `
        ${ind.sectorNarrative ? `<p class="small" style="margin:0 0 8px;">${esc(ind.sectorNarrative)}</p>` : ''}
        <div class="table-wrap"><table class="table-data"><thead><tr><th>Driver</th><th>For ${esc(sym)}</th><th>Position</th><th>Why</th></tr></thead>
        <tbody>${ind.drivers.map((dr) => `<tr><td>${esc(dr.driver)}${dr.evidence ? `<br /><span class="small faint">“${esc(dr.evidence)}”</span>` : ''} <span class="small faint">[${esc(dr.source || '')}]</span></td><td>${esc(dr.direction || '')}</td><td class="small">${esc(dr.companyPosition || '—')}</td><td class="small">${esc(dr.rationale || '')}</td></tr>`).join('')}</tbody></table></div>`));
    }
    const cp = d.competitive;
    if (cp && cp.company && cp.medians) {
      const rows = [
          ['P/E', cp.company.pe, cp.medians.pe],
          ['Rev CAGR 5y', cp.company.revCagr5Pct, cp.medians.revCagr5Pct],
          ['Net margin', cp.company.netMarginPct, cp.medians.netMarginPct],
          ['ROE', cp.company.roePct, cp.medians.roePct],
          ['Dividend yield', cp.company.divYieldPct, cp.medians.divYieldPct]
        ].map(([label, a, b]) => `<tr><td>${esc(label)}</td><td>${a == null ? '—' : esc(String(a))}</td><td>${b == null ? '—' : esc(String(b))}</td></tr>`).join('');
        const comps = (cp.comps || []).length ? `<div class="table-wrap" style="margin-top:10px;"><table class="table-data"><thead><tr><th>Closest peers</th><th>Mkt cap $B</th><th>P/E</th><th>Rev 5y</th><th>Net mgn</th><th>ROE</th></tr></thead><tbody>${cp.comps.map((c) => `<tr><td><a href="/dossier.html?symbol=${esc(c.symbol)}">${esc(c.symbol)}</a></td><td>${c.marketCapB ?? '—'}</td><td>${c.pe ?? '—'}</td><td>${c.revCagr5Pct ?? '—'}%</td><td>${c.netMarginPct ?? '—'}%</td><td>${c.roePct ?? '—'}%</td></tr>`).join('')}</tbody></table></div>` : '';
        bits.push(dosSec('Competitive positioning', `vs ${cp.peerCount || ''} ${cp.sector || ''} peers`, `
          <div class="table-wrap"><table class="table-data"><thead><tr><th>Metric</th><th>${esc(sym)}</th><th>Peer median</th></tr></thead><tbody>${rows}</tbody></table></div>${comps}`));
    }
    const fd = d.forwardDcf;
    if (fd && !fd.error && fd.fairValue && fd.fairValue.perShare != null) {
      const sc2 = fd.scenarios || {};
      const scRow = (k) => sc2[k] ? `<tr><td style="text-transform:capitalize;">${esc(k)}</td><td>${esc(String(sc2[k].growthPct))}%/yr</td><td>${sc2[k].perShare != null ? '$' + esc(String(sc2[k].perShare)) : '—'}</td><td class="${(numv(sc2[k].upsidePct) || 0) >= 0 ? 'delta-pos' : 'delta-neg'}">${numv(sc2[k].upsidePct) != null ? (sc2[k].upsidePct >= 0 ? '+' : '') + esc(String(sc2[k].upsidePct)) + '%' : '—'}</td></tr>` : '';
      bits.push(dosSec('Forward DCF & WACC', `${fd.waccBuildup ? `WACC ${esc(String(fd.waccBuildup.waccPct))}% · ` : ''}descriptive fair value, every input from the filings`, `
        <p style="margin:0 0 8px;">Base-case fair value <b>$${esc(String(fd.fairValue.perShare))}</b>/<i>share</i> vs <b>$${esc(String(fd.fairValue.currentPrice))}</b> now${fd.fairValue.upsidePct != null ? ` (<span class="${fd.fairValue.upsidePct >= 0 ? 'delta-pos' : 'delta-neg'}">${fd.fairValue.upsidePct >= 0 ? '+' : ''}${esc(String(fd.fairValue.upsidePct))}%</span>)` : ''}.</p>
        <div class="table-wrap"><table class="table-data"><thead><tr><th>Scenario</th><th>FCF growth</th><th>Value/share</th><th>vs market</th></tr></thead><tbody>${scRow('bear')}${scRow('base')}${scRow('bull')}</tbody></table></div>
        ${fd.disclaimer ? `<p class="small faint" style="margin:8px 0 0;">${esc(fd.disclaimer)}</p>` : ''}`));
    } else if (fd && !fd.error && fd.note) {
      bits.push(dosSec('Forward DCF & WACC', '', `<p class="small faint" style="margin:0;">${esc(fd.note)}</p>`));
    }
    const g = d.governance;
    if (g && (g.board || g.insider || (g.ownership && g.ownership.holders && g.ownership.holders.length))) {
      const b = g.board;
      const board = b ? `<div class="cmp-gov-grid">${[['CEO', b.ceoName], ['Board size', b.boardSize], ['Independent', b.independencePct != null ? b.independencePct + '%' : null], ['Women on board', b.womenPct != null ? b.womenPct + '%' : null], ['CEO also Chair', b.ceoChairCombined == null ? null : (b.ceoChairCombined ? 'Yes' : 'No')], ['Say-on-pay', b.sayOnPayApprovalPct != null ? b.sayOnPayApprovalPct + '%' : null]].filter(([, v]) => v != null).map(([k, v]) => `<div><div class="k">${esc(k)}</div><div class="v">${esc(String(v))}</div></div>`).join('') || ''}</div>` : (g.boardError ? `<p class="small faint">${esc(g.boardError)}</p>` : '');
      const ins = g.insider;
      const insider = ins ? `<p class="small" style="margin:8px 0;">Net ${ins.netShares >= 0 ? 'bought' : 'sold'} ${money(Math.abs(ins.netShares) || 0)} shares (${bn(Math.abs(ins.netValue) || 0)}) across ${ins.buys + ins.sells} Form-4 transactions over two years — sentiment ${esc(ins.sentiment || '')}.</p>` : '';
      const own = g.ownership;
      const holders = own && own.holders && own.holders.length ? `<div class="table-wrap"><table class="table-data"><thead><tr><th>Investor</th><th>Position</th><th>Weight</th><th>Activity</th></tr></thead><tbody>${own.holders.slice(0, 8).map((h) => `<tr><td>${esc(h.name)}</td><td>${h.value != null ? bn(h.value) : '—'}</td><td>${h.weight != null ? h.weight + '%' : '—'}</td><td class="small">${esc(h.activity || '')}</td></tr>`).join('')}</tbody></table></div>` : '';
      const flags = (g.redFlags || []).map((f) => `<p class="small" style="margin:4px 0; color:var(--neg);">⚠ ${esc(f)}</p>`).join('');
      bits.push(dosSec('Governance & ownership', '', `${board}${insider}${holders}${flags}${g.source ? `<p class="small faint" style="margin:8px 0 0;">${esc(g.source)}</p>` : ''}`));
    }
    const eg = d.esg;
    if (eg && eg.transparency) {
      const t = eg.transparency;
      const pillar = (label, val) => `<div><div class="small faint">${esc(label)}</div><div style="font-weight:650;">${val == null ? 'n/a' : esc(String(val)) + '/100'}</div></div>`;
      bits.push(dosSec('ESG & disclosure transparency', `${t.overall}/100 · ${t.verdict || ''} · disclosure completeness, from filings`, `<div style="display:flex; gap:18px;">${pillar('Governance', t.byPillar && t.byPillar.governance)}${pillar('Environmental', t.byPillar && t.byPillar.environmental)}${pillar('Human capital', t.byPillar && t.byPillar.humanCapital)}</div>${eg.honesty ? `<p class="small faint" style="margin:8px 0 0;">${esc(eg.honesty)}</p>` : ''}`));
    }
    if (Array.isArray(d.financials) && d.financials.length >= 3) {
      const fin = d.financials;
      const dupont = [
        ['Gross margin', 'grossMarginPct', '%'], ['Operating margin', 'opMarginPct', '%'], ['Net margin', 'netMarginPct', '%'],
        ['Asset turnover', 'assetTurnover', 'x'], ['ROA', 'roaPct', '%'], ['ROE', 'roePct', '%'], ['ROIC', 'roicPct', '%'],
        ['Current ratio', 'currentRatio', 'x'], ['Debt / equity', 'debtToEquity', 'x'], ['Interest coverage', 'interestCoverage', 'x']
      ];
      const head = fin.map((r) => `<th>${esc(r.fy)}</th>`).join('');
      const body = dupont.map(([label, key, suf]) => `<tr><td>${esc(label)}</td>${fin.map((r) => `<td>${r[key] == null ? '—' : esc(String(r[key])) + suf}</td>`).join('')}</tr>`).join('');
      bits.push(dosSec('Full ratio history', 'computed from filed annual statements', `<div class="table-wrap"><table class="table-data"><thead><tr><th>DuPont &amp; ratios</th>${head}</tr></thead><tbody>${body}</tbody></table></div>`));
    }
    if (!bits.length) return `<div class="pv-card"><p class="small faint">No analyst detail on record for this company beyond the sections above.</p></div>`;
    return `
      <details class="cmp-deep">
        <summary><span>${tag(d)}<strong>Show the analyst detail</strong><small>Forensics, peers, valuation, governance — everything the analyst dossier carries</small></span></summary>
        <div class="cmp-deep-body">${bits.join('')}</div>
      </details>`;
  }

  // ---- column wrapper: header card shown once, then per-section panels ----
  function companyHead(d) {
    const s = d.snapshot || {};
    // `industry` in the dossier payload is the DRIVER OBJECT (d.industry.drivers
    // feeds the deep-research section), not a name string — read the sector off
    // the object or join() prints '[object Object]' here, as it did on the
    // dossier page itself.
    const ind = d.industry && typeof d.industry === 'object' ? d.industry.sector : d.industry;
    return `
      <section class="cmp-col">
        <h2>${esc(d.name || d.symbol || '')} <span class="faint">(${esc(d.symbol || '')})</span></h2>
        <p class="sub">${esc([d.sector, ind].filter(Boolean).join(' · ') || 'US-listed equity')} · fiscal ${esc(d.fyEnd || '')}${d.cached ? '' : ' · freshly built'}</p>
        ${s.description ? `<p class="cmp-desc">${esc(String(s.description).slice(0, 320))}${String(s.description).length > 320 ? '…' : ''}</p>` : ''}
      </section>`;
  }
  function perSection(title, note, cols, fn) {
    const panels = cols.map(fn);
    const any = panels.some((p) => p && !/(Not available|No filed|No peer|No reverse|No recent|No analyst detail|No multi-year)/.test(p));
    if (!any) return '';
    return `
      <section class="cmp-row">
        <p class="cmp-sec-label">${esc(title)}${note ? ` <span class="cmp-sec-note">${esc(note)}</span>` : ''}</p>
        <div class="cmp-grid ${cols.length === 2 ? 'two' : 'three'}">${panels.join('')}</div>
      </section>`;
  }

  function renderComparison(data, symbolsList) {
    const cols = data.comparison || [];
    report.hidden = false;
    report.innerHTML = `
      <div class="cmp-topline cmp-toolbar">
        <div>
          <h1 class="title-1" style="margin:0;font-size:clamp(26px,3vw,36px);letter-spacing:-.03em;">${esc(symbolsList.join(cols.length === 2 ? ' vs ' : ' · '))}</h1>
          <p class="small faint" style="margin:6px 0 0;">${esc(String(cols.length))} dossiers · ${esc(String(data.cost || 5))} credits — every figure straight from SEC filings</p>
        </div>
        <button class="btn btn-ghost btn-sm" id="cmp-print">Print / Save PDF</button>
      </div>
      ${verdictStrip(cols)}
      <section class="cmp-row">${metricTable(cols)}</section>
      ${growthIndexChart(cols) ? `<section class="cmp-row">${growthIndexChart(cols)}</section>` : ''}
      <div class="company-heads cmp-grid ${cols.length === 2 ? 'two' : 'three'}">${cols.map(companyHead).join('')}</div>
      ${perSection('The filed trajectory', 'the same charts the dossier page draws', cols, trendsPanel)}
      ${perSection('Where the money goes', 'the split hiding inside each $1 of sales', cols, moneyPanel)}
      ${perSection('What it earns per unit', 'from filed unit disclosures', cols, unitPanel)}
      ${perSection('What it sells', 'segment share of revenue', cols, sellsPanel)}
      ${perSection('The bull case', 'full points, cited', cols, bullPanel)}
      ${perSection('The bear case', 'full points, cited', cols, bearPanel)}
      ${perSection('Key risks', 'same severity meter the dossier uses', cols, risksPanel)}
      ${healthCompare(cols) ? `<section class="cmp-row">${healthCompare(cols)}</section>` : ''}
      ${perSection('What the price assumes', 'priced-in growth vs delivered growth', cols, priceAssumesPanel)}
      ${perSection('Versus peer medians', '', cols, rivalsPanel)}
      ${perSection('Latest filing', 'what moved and what management rewrote', cols, filingPanel)}
      ${scenarioCompare(cols) ? `<section class="cmp-row">${scenarioCompare(cols)}</section>` : ''}
      ${perSection('Deep research', 'open only the evidence you need', cols, (d, i) => deepDetails(d, i))}
      <p class="small faint" style="margin:20px 0 0;">${esc((cols[0] && cols[0].sources && cols[0].sources.note) || 'Every figure is computed from SEC-filed statements; prose is written over those finished facts. Educational, not investment advice.')}</p>`;
    report.scrollIntoView({ behavior: 'smooth', block: 'start' });
    const print = $('cmp-print');
    if (print) print.addEventListener('click', () => window.print());
  }

  function renderMissing(data) {
    const missing = data.missing || [];
    report.hidden = false;
    report.innerHTML = `
      <h1 class="title-1" style="margin:0;font-size:clamp(24px,2.8vw,32px);letter-spacing:-.03em;">Almost — some dossiers aren't built yet</h1>
      <p class="muted" style="max-width:60ch;margin:10px 0 0;">${esc(data.message || 'Build the missing Standard dossiers first; comparing then costs 5 credits.')}</p>
      <div class="cmp-missing">${missing.map((m) => `
        <div class="cmp-missing-card">
          <div><strong>${esc(m)}</strong><div class="small faint">Standard Dossier — ${esc(String(data.buildCost || 10))} credits, one-time build</div></div>
          <a class="btn btn-primary btn-sm" href="/dossier.html?symbol=${encodeURIComponent(m)}">Build ${esc(m)} dossier →</a>
        </div>`).join('')}</div>
      <p class="small faint" style="margin-top:14px;">Nothing was charged — comparing only runs once every requested dossier exists.</p>`;
    report.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function renderError(message) {
    report.hidden = false;
    report.innerHTML = `<div class="cmp-missing-card"><div><strong>${esc(message || 'The comparison failed. Try again.')}</strong></div><a class="btn btn-ghost btn-sm" href="/dossier.html">Dossiers →</a></div>`;
  }

  async function runCompare(symbolsList) {
    report.hidden = false;
    report.innerHTML = `<p class="muted">Comparing dossiers…</p>`;
    try {
      const r = await fetch(`${API}/dossier/compare?symbols=${encodeURIComponent(symbolsList.join(','))}`, { headers: { ...auth() } });
      let body = null;
      try { body = await r.json(); } catch (_) { body = null; }
      if (r.status === 402) { renderError((body && body.message) || 'Not enough credits left for a comparison (5) this month.'); return; }
      if (r.status === 401) { renderError('Sign in to compare dossiers.'); return; }
      if (!r.ok) { renderError((body && body.message) || 'The comparison failed. Try again.'); return; }
      if (body && body.missing && body.missing.length) { renderMissing(body); return; }
      if (body && body.comparison && body.comparison.length >= 2) { renderComparison(body, body.symbols || symbolsList); return; }
      renderError((body && body.message) || 'Could not compare those dossiers.');
    } catch (_) {
      renderError('Network error — check your connection and try again.');
    }
  }

  $('cmp-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const syms = [...new Set(readInputs())];
    if (syms.length < 2) { renderError('Enter two or three tickers to compare.'); return; }
    if (syms.length > 3) { renderError('Compare up to 3 companies at a time.'); return; }
    if (syms.some((s) => !VALID.test(s))) { renderError('One of those tickers doesn\'t look valid.'); return; }
    history.replaceState(null, '', `/compare-dossiers.html?symbols=${encodeURIComponent(syms.join(','))}`);
    runCompare(syms);
  });

  const initial = new URLSearchParams(location.search).get('symbols');
  if (initial) {
    const syms = [...new Set(String(initial).split(',').map((s) => s.trim().toUpperCase()).filter(Boolean))].slice(0, 3);
    syms.forEach((s, i) => { const el = $('cmp-sym-' + (i + 1)); if (el && VALID.test(s)) el.value = s; });
    if (syms.length >= 2 && syms.every((s) => VALID.test(s))) runCompare(syms);
  }
})();