// Research Dossier page — on-demand initiation report on any ticker, plus the
// thesis tracker. Power/Desk feature: a 402 swaps in the upgrade card. The
// build is slow (it composes several grounded surfaces), so the server kicks
// it and returns {status:'building', stage} fast; we poll until it lands.
(function () {
  'use strict';
  const { API, token, esc, money, num, spinner, nav, searchAssets, mountShare, markdown, mountAskFloor } = window.V2;
  const $ = (id) => document.getElementById(id);
  const auth = () => (token() ? { Authorization: `Bearer ${token()}` } : {});
  const MODE_KEY = 'sp_dossier_mode_v1';
  let RAW_DOSSIER = null, RAW_SYM = null;
  // mountAskFloor appends to document.body unconditionally, and render() runs
  // again on every poll -> build -> rerender cycle and on each mode toggle, so
  // without this guard the page would stack a bar per render.
  let askMounted = false;

  // "Key figures" arrives as machine-readable lines ("REVENUE: latest $716.9B…")
  // meant for the model. Turn each "LABEL: value" into a clean card; the leading
  // COMPANY line (no colon) becomes a lead-in sentence.
  function keyFiguresHtml(text) {
    const lines = String(text || '').split('\n').map((s) => s.trim()).filter(Boolean);
    let intro = '';
    let cards = '';
    for (const line of lines) {
      const i = line.indexOf(':');
      if (i > 0) {
        cards += `<div class="card card-pad"><p class="label" style="margin-bottom:6px;">${esc(line.slice(0, i).trim())}</p><p class="dos-kf-val">${esc(line.slice(i + 1).trim())}</p></div>`;
      } else {
        intro += `<p class="dos-kf-intro">${esc(line.replace(/^COMPANY\s+/i, ''))}</p>`;
      }
    }
    return intro + (cards ? `<div class="dos-kf-grid">${cards}</div>` : '');
  }

  // The payload's `industry` field is the INDUSTRY-DRIVERS OBJECT (used at
  // d.industry.drivers below), not the industry name string. A header that
  // joins [d.sector, d.industry] printed '[object Object]' on every dossier
  // whose industry build succeeded. Read the name off the object instead.
  function metaLine(d) {
    const ind = d.industry && typeof d.industry === 'object' ? d.industry.sector : d.industry;
    return [d.sector, ind].filter(Boolean).join(' · ') || 'US-listed equity';
  }

  const POLL_MS = 6000;
  const MAX_WAIT_MS = 300000; // 5 min — a dossier touches several filings + the model
  const STAGE_LABEL = {
    gathering: 'Gathering the grounded surfaces — financials, segments, valuation, industry drivers, governance & ownership, ESG, the latest filings…',
    writing: 'Writing the executive summary and the bull vs bear case…'
  };

  function setBuilding(out, sym, stage, elapsedMs) {
    const base = STAGE_LABEL[stage] || ('Researching ' + sym + ' across its filings…');
    const hint = elapsedMs > 60000
      ? 'Still going — a full dossier reads several filings. It loads the moment it’s ready; no need to refresh, and the work isn’t lost if you wait.'
      : 'This loads the moment it’s ready — no need to refresh.';
    out.innerHTML = `<div class="card card-pad">${spinner(base)}<p class="small faint" style="margin:10px 0 0;">${esc(hint)}</p></div>`;
    out.hidden = false;
  }

  function upsell(out) {
    out.innerHTML = `
      <div class="card card-pad">
        <span class="label">Research Dossier — on Pro, Power &amp; Desk</span>
        <h2 class="title-2" style="margin:12px 0 8px;">The analyst’s write-up, on demand</h2>
        <p class="muted" style="max-width:64ch;">A from-scratch, source-linked dossier on any US-listed company — business, segments, ten-year figures, what’s priced in, the bull and bear case, and what just changed in the latest filing. The work an analyst bills 20–40 hours for, or that a research seat costs five figures a year. Yours unlimited on Pro.</p>
        <div style="display:flex; flex-wrap:wrap; gap:12px; margin-top:16px;">
          <a class="btn btn-primary" href="/register.html?plan=pro-annual">Start Pro checkout</a>
        </div>
        <p class="small faint" style="margin:12px 0 0;">Pro already includes the Filing Change Monitor and thesis tracker. Desk for RIAs &amp; funds — <a href="/register.html?plan=desk">$1,999.99/yr →</a></p>
      </div>`;
    out.hidden = false;
  }

  function fail(out, msg) {
    out.innerHTML = `<div class="card card-pad"><p style="margin:0;">${esc(msg)}</p>
      <p class="small faint" style="margin:10px 0 0;">Check the ticker (US exchange-listed SEC filers only) or try again in a moment.</p></div>`;
    out.hidden = false;
  }

  // The wallet wall, distinct from the tier upsell: the server's 402 carries
  // code CREDITS_REQUIRED for balance exhaustion (a Pro/Power user, not a
  // tier problem). Selling them "unlimited on Pro" here would be wrong twice
  // — wrong diagnosis, and they already hold the card being sold.
  function creditsWall(out, d) {
    const c = (d && d.credits) || {};
    const needed = Number(c.needed) || 10;
    const remaining = Number(c.remaining) || 0;
    const deep = needed > 10;
    const reset = (window.V2 && window.V2.formatReset) ? window.V2.formatReset(c.resetsAt) : '';
    out.innerHTML = `<div class="card card-pad">
      <span class="label">Out of credits</span>
      <h2 class="title-2" style="margin:12px 0 8px;">Your wallet is empty this month</h2>
      <p class="muted" style="max-width:62ch;">A ${deep ? 'Deep ' : ''}Dossier costs ${needed} credits — you have ${remaining} left this month. Recharge to run it now${reset ? `, or wait for the regular wallet: ${esc(reset).toLowerCase()}` : '.'}</p>
      <div style="display:flex; flex-wrap:wrap; gap:12px; margin-top:16px;">
        <a class="btn btn-primary" href="/recharge.html">Recharge 150 credits — $14.99</a>
        <a class="btn btn-ghost" href="/profile.html#usage-details">See this month's usage →</a>
      </div>
${reset ? `      <p class="small faint" style="margin:12px 0 0;">${esc(reset)} — your plan's allowance comes back on its own.</p>` : ''}
    </div>`;
    out.hidden = false;
  }

  // One 402 handler for the build request: the server distinguishes
  // PRO_REQUIRED (tier gate — the upsell is right) from CREDITS_REQUIRED
  // (wallet empty — the wall above is right).
  function handleDossier402(out, body) {
    if (body && body.code === 'CREDITS_REQUIRED') creditsWall(out, body);
    else upsell(out);
  }

  // ---- rendering ----
  const TONE = { improving: 'pos', deteriorating: 'neg', stable: '' };
  function snapRow(k, v) { return v == null || v === '' || v === 'None' ? '' : `<div><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`; }

  function renderFundRedirect(out, d, sym) {
    out.innerHTML = `<div class="card card-pad">
      <span class="label">${esc(sym)} · ${esc(d.assetTypeLabel || 'Fund')}</span>
      <h2 class="title-2" style="margin:8px 0;">Use the fund research workspace</h2>
      <p class="muted" style="max-width:62ch;">AI Analyst is deliberately SEC-only and does not apply operating-company analysis to pooled funds. The fund workspace covers fees, holdings, allocation, performance and risk with provider-labelled data.</p>
      <div style="display:flex; flex-wrap:wrap; gap:10px; margin-top:18px;">
        <a class="btn btn-primary" href="/company.html?symbol=${encodeURIComponent(sym)}">Open fund workspace</a>
        <a class="btn btn-ghost" href="/ask.html?q=${encodeURIComponent(`Research ${sym}`)}">Ask about ${esc(sym)}</a>
      </div>
    </div>`;
    out.hidden = false;
  }

  // ---- compact inline SVG charts (print-friendly, dependency-free) ----
  const C = { ink: '#1c1b18', accent: '#1a4fd6', pos: '#1b7a4b', neg: '#b4422f', grey: '#8a877e', faint: '#e7e4dd' };
  function chartBars(rows, key, fmt, color) {
    const pts = rows.map((r) => ({ fy: r.fy, v: r[key] })).filter((p) => p.v !== null && p.v !== undefined);
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
    const labs = pts.map((p, i) => `<text x="${(i * slot + slot / 2).toFixed(1)}" y="${H - 6}" font-size="10" fill="${C.grey}" text-anchor="middle">${esc(p.fy.slice(-2))}</text>`).join('');
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
  function legend(items) { return `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:4px;">${items.map((i) => `<span class="small" style="color:var(--ink-3)"><span style="display:inline-block;width:9px;height:9px;background:${i.color};border-radius:2px;margin-right:4px;vertical-align:middle"></span>${esc(i.label)}</span>`).join('')}</div>`; }
  const bn = (v) => {
    if (v == null) return '—';
    const sign = v < 0 ? '−' : '';
    const a = Math.abs(v);
    return sign + (a >= 1e12 ? '$' + (a / 1e12).toFixed(2) + 'T' : a >= 1e9 ? '$' + (a / 1e9).toFixed(1) + 'B' : '$' + (a / 1e6).toFixed(0) + 'M');
  };

  function miniBars(rows, key, color, fmt) {
    const pts = (rows || []).map((r) => Number(r[key])).filter(Number.isFinite);
    if (pts.length < 2) return '';
    const max = Math.max(...pts.map((v) => Math.abs(v)), 1);
    const show = fmt || ((v) => String(v));
    return `<span class="dos-mini-bars" aria-hidden="true">${pts.map((v, i) => `<i style="height:${Math.max(3, Math.abs(v) / max * 100).toFixed(1)}%;background:${v < 0 ? C.neg : i === pts.length - 1 ? C.ink : color}" title="${esc(show(v))}"></i>`).join('')}</span>`;
  }

  // First→latest change per trend row, purely from the filed history. Dollar
  // metrics read as a total change, percentage metrics as points. Null when
  // either endpoint is missing so nothing is implied.
  function trendChangeLine(fin, key, pctMetric) {
    const vals = (fin || []).map((r) => Number(r[key])).filter(Number.isFinite);
    if (vals.length < 2) return '';
    const first = vals[0], last = vals[vals.length - 1];
    if (pctMetric) {
      const pts = last - first;
      if (!Number.isFinite(pts) || Math.abs(pts) < 0.05) return '';
      return (pts > 0 ? '+' : '−') + Math.abs(pts).toFixed(1) + ' pts';
    }
    if (first <= 0 || last <= 0) return '';
    const ratio = last / first;
    if (ratio >= 1.15) return '×' + ratio.toFixed(1) + ' total';
    const pct = Math.round((ratio - 1) * 100);
    if (pct === 0) return '';
    return (pct > 0 ? '+' : '−') + Math.abs(pct) + '% total';
  }

  function decisionTrends(fin) {
    if (!fin || fin.length < 2) return '<p class="small faint">No multi-year filed history is available.</p>';
    const latest = fin[fin.length - 1] || {};
    const span = `${esc(fin[0].fy)}→${esc(latest.fy)}`;
    const rows = [
      ['Revenue', 'revenue', bn(latest.revenue), C.ink, bn, false],
      ['Operating margin', 'opMarginPct', latest.opMarginPct == null ? '—' : latest.opMarginPct + '%', C.grey, (v) => v + '%', true],
      ['Free cash flow', 'fcf', bn(latest.fcf), C.pos, bn, false],
      ['ROIC', 'roicPct', latest.roicPct == null ? '—' : latest.roicPct + '%', C.ink, (v) => v + '%', true]
    ];
    return `<div class="dos-trends">${rows.map(([label, key, value, color, fmt, pctMetric]) => {
      const change = trendChangeLine(fin, key, pctMetric);
      return `<div class="dos-trend-row"><span>${label}<small class="dos-trend-change">${span}${change ? ' · ' + esc(change) : ''}</small></span>${miniBars(fin, key, color, fmt)}<b>${esc(value)}</b></div>`;
    }).join('')}</div>`;
  }

  function displayNumber(value) {
    const s = String(value == null ? '' : value).replace(/,/g, '').trim();
    const m = s.match(/[-+]?\d*\.?\d+/);
    if (!m) return 0;
    let n = Number(m[0]);
    if (!Number.isFinite(n)) return 0;
    if (/\dT(?:\s|$)/i.test(s)) n *= 1e12;
    else if (/\dB(?:\s|$)/i.test(s)) n *= 1e9;
    else if (/\dM(?:\s|$)/i.test(s)) n *= 1e6;
    else if (/\dK(?:\s|$)/i.test(s)) n *= 1e3;
    return n;
  }

  function dossierMetricBars(d) {
    const prior = displayNumber(d.prior), latest = displayNumber(d.latest);
    const max = Math.max(Math.abs(prior), Math.abs(latest), 1);
    const row = (label, shown, value, isLatest) => `<div class="dos-bar-line ${isLatest ? 'is-latest' : ''} ${value < 0 ? 'is-negative' : ''}"><span>${label}</span><span class="dos-bar-track"><i class="dos-bar-fill" style="width:${Math.max(3, Math.abs(value) / max * 100).toFixed(1)}%"></i></span><b>${esc(shown)}</b></div>`;
    return `<div class="dos-bar-pair">${row('Prior', d.prior, prior, false)}${row('Latest', d.latest, latest, true)}</div>`;
  }

  function financialReadings(fin) {
    if (!fin || fin.length < 2) return '<li data-n="01">No comparable filed annual history is available.</li>';
    const first = fin[0], latest = fin[fin.length - 1];
    const years = Math.max(1, Number(latest.fy) - Number(first.fy));
    const cagr = (a, b) => a > 0 && b > 0 ? (Math.pow(b / a, 1 / years) - 1) * 100 : null;
    const revCagr = cagr(Number(first.revenue), Number(latest.revenue));
    const opMove = Number.isFinite(Number(first.opMarginPct)) && Number.isFinite(Number(latest.opMarginPct)) ? Number(latest.opMarginPct) - Number(first.opMarginPct) : null;
    const lines = [];
    if (revCagr != null) lines.push(`Revenue compounded at approximately <strong>${revCagr.toFixed(1)}% a year</strong> from ${first.fy} to ${latest.fy}.`);
    if (opMove != null) lines.push(`Operating margin moved from <strong>${first.opMarginPct}%</strong> to <strong>${latest.opMarginPct}%</strong>, a ${opMove >= 0 ? '+' : ''}${opMove.toFixed(1)}-point change.`);
    const fcfVals = fin.map((r) => Number(r.fcf)).filter(Number.isFinite);
    if (fcfVals.length > 1) {
      const peak = Math.max(...fcfVals), trough = Math.min(...fcfVals);
      lines.push(`Free cash flow finished at <strong>${bn(latest.fcf)}</strong> versus <strong>${bn(first.fcf)}</strong> at the start, but ranged from ${bn(trough)} to ${bn(peak)}; the bar pattern matters more than a single end-point growth rate.`);
    }
    // The conversion ratio is only meaningful when net income is positive —
    // negative/negative lands on a huge "percentage" that reads as sanity (INTC: "1854% of net income").
    if (Number(latest.netIncome) > 0 && Number(latest.fcf) !== 0) {
      const conversion = Number(latest.fcf) / Number(latest.netIncome) * 100;
      lines.push(`Latest free cash flow equalled approximately <strong>${conversion.toFixed(0)}%</strong> of net income (${bn(latest.fcf)} versus ${bn(latest.netIncome)}), a check on earnings-to-cash conversion rather than a quality verdict by itself.`);
    }
    if (latest.roicPct != null) lines.push(`Latest filed ROIC is <strong>${latest.roicPct}%</strong>${first.roicPct != null ? ` versus ${first.roicPct}% at the start of the displayed record` : ''}${latest.roePct != null ? `; ROE is ${latest.roePct}% and can differ because of leverage and capital structure` : ''}.`);
    return (lines.length ? lines : ['The filed history is shown visually; exact ratios remain available below.']).map((x, i) => `<li data-n="${String(i + 1).padStart(2, '0')}">${x}</li>`).join('');
  }

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
    return lines.join(' ') || `This brief is built from ${d.name || d.symbol}'s filed financial record. Open the evidence modules below to test the business, valuation and risks.`;
  }

  function briefParagraphs(text) {
    const sentences = String(text || '').trim().split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean);
    return (sentences.length ? sentences : [String(text || '')]).map((sentence) => `<p>${esc(sentence)}</p>`).join('');
  }

  function render(out, d, sym) {
    // Mounted before the fund branch, and with the fund wording, so an ETF or
    // mutual fund gets the bar too — the fund view's own copy sends people to
    // Ask, so it is the one state that most needs a way to ask. Same split as
    // company.js.
    if (!askMounted && mountAskFloor) {
      askMounted = true;
      mountAskFloor({ placeholder: d && d.isFund
        ? `Ask about ${sym} — fees, holdings, allocation, performance and risk…  (⌘K)`
        : `Ask about ${sym} — answers come from its SEC filings…  (⌘K)` });
    }
    if (d && d.isFund) { renderFundRedirect(out, d, sym); return; }
    RAW_DOSSIER = d; RAW_SYM = sym;
    const mode = window.PV.getMode(MODE_KEY);
    if (mode === 'normal') { renderNormal(out, d, sym); return; }
    renderAnalyst(out, d, sym, mode);
  }

  // Today's dossier render, unchanged — Analyst mode stays byte-identical.
  // `mode` is always 'analyst' here; kept as a parameter (rather than a local
  // const) only so this function no longer re-derives it itself.
  function renderAnalyst(out, d, sym, mode) {
    if (mode === 'normal') {
      d = {
        ...d,
        executiveSummary: d.executiveSummaryPlain || d.executiveSummary,
        risks: (d.risksPlain && d.risksPlain.length) ? d.risksPlain : d.risks,
        edge: (d.edgePlain && d.edgePlain.length) ? d.edgePlain : d.edge,
        bull: (d.bullPlain && d.bullPlain.length) ? d.bullPlain : d.bull,
        bear: (d.bearPlain && d.bearPlain.length) ? d.bearPlain : d.bear
      };
    }
    const s = d.snapshot || {};
    const briefText = String(d.executiveSummary || '').trim() || deterministicBrief(d);
    const history = d.financials || [];
    const mc = num(s.marketCap);
    const pct = (x) => { const n = num(x); return n == null ? null : (Math.abs(n) <= 1 ? (n * 100).toFixed(1) : Number(n).toFixed(1)) + '%'; };
    const keyStrip = [
      ['Market cap', mc ? '$' + money(mc) : '—'],
      ['P/E', s.pe && s.pe !== 'None' ? Number(s.pe).toFixed(1) + '×' : '—'],
      ['TTM margin', pct(s.profitMargin) || '—']
    ].map(([k, v]) => `<div><small>${esc(k)}</small><strong>${esc(v)}</strong></div>`).join('');

    const v = d.valuation;
    const rec = v && v.record ? v.record : {};
    const valuationHtml = v && v.impliedGrowthPct != null ? `
      <div class="dos-sec">
        <h2>What’s priced in</h2>
        <p style="max-width:74ch;">At today’s market cap, the price implies free-cash-flow growth of about <strong>${v.impliedGrowthPct}%/yr</strong> for ${v.assumptions ? v.assumptions.horizonYears : 10} years (${v.assumptions ? v.assumptions.discountRatePct : '—'}% discount rate, ${v.assumptions ? v.assumptions.terminalGrowthPct : '—'}% terminal growth). For comparison, FCF actually grew ${rec.fcfCagr5Pct ?? '—'}%/yr and revenue ${rec.revCagr5Pct ?? '—'}%/yr over the last five years. <a href="/company.html?symbol=${esc(sym)}">Change the assumptions →</a></p>
      </div>` : '';

    const segs = d.segments && d.segments.items && d.segments.items.length ? `
      <div class="dos-sec">
        <h2>Segments <span class="small faint">${esc(d.segments.fiscalYear || '')}</span></h2>
        <div class="table-wrap"><table class="table-data dos-seg">
          <thead><tr><th>Segment</th><th>Share</th></tr></thead>
          <tbody>${d.segments.items.map((x) => `<tr><td>${esc(x.name)}${x.description ? `<br /><span class="small faint">${esc(x.description)}</span>` : ''}</td><td>${x.revenuePct != null ? x.revenuePct + '%' : '—'}</td></tr>`).join('')}</tbody>
        </table></div>
        ${d.segments.note ? `<p class="small faint" style="margin-top:6px;">${esc(d.segments.note)}</p>` : ''}
      </div>` : '';

    const ueA = d.unitEconomics;
    const unitEcon = ueA && Array.isArray(ueA.metrics) && ueA.metrics.length ? `
      <div class="dos-sec">
        <h2>Unit economics <span class="small faint">${esc(ueA.unitLabel || '')} · fiscal ${esc(ueA.fiscalYear || '')}</span></h2>
        <div class="table-wrap"><table class="table-data">
          <thead><tr><th>Metric</th><th>Value</th><th>Period</th><th>Basis</th></tr></thead>
          <tbody>${ueA.metrics.map((m) => `<tr><td>${esc(m.name || '—')}</td><td>${m.value != null ? money(m.value) + (m.unit && !/^(count|units?|#)$/i.test(String(m.unit).trim()) ? ' ' + esc(m.unit) : '') : '—'}</td><td>${esc(m.period || '—')}</td><td class="small faint">${esc(m.basis || '—')}</td></tr>`).join('')}
          ${ueA.derived && ueA.derived.revenuePerUnit != null ? `
            <tr><td>Revenue per ${esc(ueA.unitLabel || 'unit')}</td><td>$${money(ueA.derived.revenuePerUnit)}</td><td>${esc(ueA.derived.period || ueA.fiscalYear || '—')}</td><td class="small faint">Derived: revenue ÷ volume</td></tr>
            ${ueA.derived.costPerUnit != null ? `<tr><td>Cost per ${esc(ueA.unitLabel || 'unit')}</td><td>$${money(ueA.derived.costPerUnit)}</td><td>${esc(ueA.derived.period || ueA.fiscalYear || '—')}</td><td class="small faint">Derived: COGS ÷ volume</td></tr>` : ''}
            ${ueA.derived.grossProfitPerUnit != null ? `<tr><td>Gross profit per ${esc(ueA.unitLabel || 'unit')}</td><td>$${money(ueA.derived.grossProfitPerUnit)}</td><td>${esc(ueA.derived.period || ueA.fiscalYear || '—')}</td><td class="small faint">Derived: gross profit ÷ volume</td></tr>` : ''}` : ''}</tbody>
        </table></div>
        ${(ueA.derived && ueA.derived.note) || ueA.note ? `<p class="small faint" style="margin-top:6px;">${esc((ueA.derived && ueA.derived.note) || ueA.note)}</p>` : ''}
      </div>` : '';

    const read = (d.analystRead || []).length ? `
      <div class="dos-sec">
        <h2>Analyst read</h2>
        <ul class="dos-read" style="padding-left:18px;">${d.analystRead.map((i) => `<li><span class="t">${esc(i.title)}</span><br />${esc(i.body)}</li>`).join('')}</ul>
      </div>` : '';

    // Edge — the non-obvious forensic insights (the differentiator)
    const edge = (d.edge || []).length ? `
      <div class="dos-sec">
        <h2>Edge <span class="small faint">non-obvious signals a summary misses</span></h2>
        <ul class="dos-read" style="padding-left:18px;">${d.edge.map((i) => `<li><span class="t">${esc(i.insight)}</span>${i.evidence ? ` <span class="small" style="color:var(--accent-ink); font-variant-numeric:tabular-nums;">${esc(i.evidence)}</span>` : ''}${i.soWhat ? `<br /><span class="basis">${esc(i.soWhat)}</span>` : ''}</li>`).join('')}</ul>
      </div>` : '';

    // Competitive positioning + peer-multiples valuation
    const cp = d.competitive;
    const competitiveRead = cp && cp.company && cp.medians ? [
      cp.company.revCagr5Pct != null && cp.medians.revCagr5Pct != null ? `Five-year revenue growth is ${cp.company.revCagr5Pct}% versus the ${cp.sector} median of ${cp.medians.revCagr5Pct}% (${(cp.company.revCagr5Pct - cp.medians.revCagr5Pct) >= 0 ? '+' : ''}${(cp.company.revCagr5Pct - cp.medians.revCagr5Pct).toFixed(1)} points).` : '',
      cp.company.netMarginPct != null && cp.medians.netMarginPct != null ? `Net margin is ${cp.company.netMarginPct}% versus ${cp.medians.netMarginPct}% for the median peer.` : '',
      cp.company.pe != null && cp.medians.pe != null ? `The shares trade at ${cp.company.pe}× earnings versus ${cp.medians.pe}× for the median peer, so the valuation embeds a ${cp.company.pe >= cp.medians.pe ? 'premium' : 'discount'} alongside those operating differences.` : ''
    ].filter(Boolean).join(' ') : (cp && cp.verdict) || '';
    const competitive = cp ? `
      <div class="dos-sec">
        <h2>Competitive positioning <span class="small faint">vs ${cp.peerCount} ${esc(cp.sector)} peers</span></h2>
        <p style="max-width:74ch;">${esc(competitiveRead)}</p>
        <div class="table-wrap"><table class="table-data">
          <thead><tr><th>Metric</th><th>${esc(d.name || sym)}</th><th>Peer median</th></tr></thead>
          <tbody>
            <tr><td>P/E</td><td>${cp.company.pe ?? '—'}</td><td>${cp.medians.pe ?? '—'}</td></tr>
            <tr><td>Rev CAGR 5y</td><td>${cp.company.revCagr5Pct ?? '—'}%</td><td>${cp.medians.revCagr5Pct ?? '—'}%</td></tr>
            <tr><td>Net margin</td><td>${cp.company.netMarginPct ?? '—'}%</td><td>${cp.medians.netMarginPct ?? '—'}%</td></tr>
            <tr><td>ROE</td><td>${cp.company.roePct ?? '—'}%</td><td>${cp.medians.roePct ?? '—'}%</td></tr>
            <tr><td>Dividend yield</td><td>${cp.company.divYieldPct ?? '—'}%</td><td>${cp.medians.divYieldPct ?? '—'}%</td></tr>
          </tbody>
        </table></div>
        ${cp.multiples ? `<p class="small" style="margin-top:8px;">On a peer-multiples basis it trades at <strong>${cp.multiples.companyPe}× P/E</strong> vs the sector median <strong>${cp.multiples.peerMedianPe}×</strong> — a ${cp.multiples.premiumPct >= 0 ? `${cp.multiples.premiumPct}% premium` : `${Math.abs(cp.multiples.premiumPct)}% discount`} (${cp.multiples.repriceToMedianPct >= 0 ? '+' : ''}${cp.multiples.repriceToMedianPct}% to re-rate to the peer median).</p>` : ''}
        ${(cp.comps || []).length ? `<div class="table-wrap" style="margin-top:10px;"><table class="table-data"><thead><tr><th>Closest peers</th><th>Mkt cap $B</th><th>P/E</th><th>Rev 5y</th><th>Net mgn</th><th>ROE</th></tr></thead><tbody>${cp.comps.map((c) => `<tr><td><a href="/dossier.html?symbol=${esc(c.symbol)}">${esc(c.symbol)}</a></td><td>${c.marketCapB ?? '—'}</td><td>${c.pe ?? '—'}</td><td>${c.revCagr5Pct ?? '—'}%</td><td>${c.netMarginPct ?? '—'}%</td><td>${c.roePct ?? '—'}%</td></tr>`).join('')}</tbody></table></div>` : ''}
      </div>` : '';

    const SEV = { high: 'th-broken', medium: 'th-weakening', low: 'th-holding' };
    const risks = (d.risks || []).length ? `
      <div class="dos-sec">
        <h2>Investment risks</h2>
        <div style="display:grid; gap:10px;">${d.risks.map((r) => `
          <div class="dos-case dos-case--${r.severity === 'high' ? 'red' : r.severity === 'low' ? 'green' : 'blue'}">
            <div style="display:flex; justify-content:space-between; gap:10px; align-items:baseline;"><strong>${esc(r.risk)}</strong><span class="th-badge ${SEV[r.severity] || 'th-weakening'}">${esc(r.severity)}</span></div>
            <div class="small" style="margin-top:6px;"><strong>Trigger:</strong> ${esc(r.trigger)}</div>
            <div class="small"><strong>Impact:</strong> ${esc(r.impact)}</div>
            ${r.mitigant ? `<div class="small" style="margin-top:4px; color:var(--ink-3);"><strong>Mitigant:</strong> ${esc(r.mitigant)}</div>` : ''}
          </div>`).join('')}</div>
      </div>` : '';

    const caseList = (arr) => (arr || []).map((x) => `<li>${esc(x.point)}${x.basis ? `<br /><span class="basis">${esc(x.basis)}</span>` : ''}</li>`).join('');
    const bullbear = (d.bull && d.bull.length) || (d.bear && d.bear.length) ? `
      <div class="dos-sec">
        <h2>Bull vs bear</h2>
        <div class="dos-bullbear">
          <div class="dos-case bull"><h3>Bull case</h3><ul style="padding-left:18px; margin:0;">${caseList(d.bull) || '<li class="faint">—</li>'}</ul></div>
          <div class="dos-case bear"><h3>Bear case</h3><ul style="padding-left:18px; margin:0;">${caseList(d.bear) || '<li class="faint">—</li>'}</ul></div>
        </div>
      </div>` : '';

    const checks = (d.healthChecks || []).length ? `
      <div class="dos-sec">
        <h2>Health checks <span class="small faint">${d.healthChecks.filter((c) => c.pass).length}/${d.healthChecks.length} pass · computed from filings, not advice</span></h2>
        <div class="dos-checks">${d.healthChecks.map((c) => `<div class="dos-check ${c.pass ? 'pass' : 'fail'}"><span class="mk">${c.pass ? '✓' : '✗'}</span><span>${esc(c.label)}${c.detail ? ` <span class="faint">(${esc(c.detail)})</span>` : ''}</span></div>`).join('')}</div>
      </div>` : '';

    const rc = d.recentChanges;
    const recent = rc ? (() => {
      const deltaRows = (rc.deltas || []).map((x) => `<div class="dos-delta-row">
        <div class="dos-delta-row-head"><span>${esc(x.label)}</span><b class="${x.direction === 'up' ? 'delta-pos' : x.direction === 'down' ? 'delta-neg' : ''}">${esc(x.change)}</b></div>
        ${dossierMetricBars(x)}
      </div>`).join('');
      const changes = rc.changes || [];
      const changeRows = changes.map((c) => {
        const pair = c.evidenceVerified && c.priorQuote && c.newQuote;
        return `<li><strong>${esc(c.area)}</strong><span>${esc(c.what)}</span>${pair ? `<div class="dos-quote-pair"><div class="dos-quote-side"><b>Prior filing</b><q>${esc(c.priorQuote)}</q></div><i>→</i><div class="dos-quote-side"><b>New filing</b><q>${esc(c.newQuote)}</q></div></div>` : ''}</li>`;
      }).join('');
      const cmp = rc.comparison;
      const mb = rc.materialityBreakdown || {};
      const materiality = `<div class="dos-materiality"><strong>${esc(String(rc.materiality == null ? '—' : rc.materiality))}</strong><div class="dos-materiality-bars">${[['Numbers',mb.numbers],['Language',mb.language],['Risk',mb.risk]].map(([label,value]) => `<div class="dos-materiality-row"><span>${label}</span><i><b style="width:${Math.max(2,Math.min(100,Number(value)||0))}%"></b></i><strong>${Number(value)||0}</strong></div>`).join('')}</div></div>`;
      const followups = changes.slice(0, 3).map((c) => `<a href="/ask.html?q=${encodeURIComponent(`${sym}: What evidence supports the ${c.area || 'filing'} change, what could reverse it, and what should the next filing confirm?`)}">Investigate ${esc(c.area || 'change')} →</a>`).join('');
      const periodText = rc.reportedPeriod && rc.priorPeriod ? `${rc.reportedPeriod} versus ${rc.priorPeriod}` : '';
      const eventNote = rc.latestEvent ? `<div class="dos-event-note"><strong>Newer event filing kept separate.</strong> ${esc(rc.latestEvent.label || rc.latestEvent.form)} filed ${esc(rc.latestEvent.date)} is newer than the periodic comparison above and is not presented as the same analysis. ${rc.latestEvent.url ? `<a href="${esc(rc.latestEvent.url)}" target="_blank" rel="noopener">Open ${esc(rc.latestEvent.form)} ↗</a>` : ''}</div>` : '';
      return `<section class="dos-recent-v2" id="dos-latest-change">
        <div class="dos-section-head"><div><span class="dos-kicker">Latest filing change</span><h2>What moved—and what management rewrote</h2></div><span class="small faint">${esc(periodText)}${rc.currency ? ` · ${esc(rc.currency)}` : ''}</span></div>
        <div class="dos-filing-grid">
          <section><span class="dos-kicker">Filed numbers · comparable periods</span>${materiality}<div class="dos-delta-list">${deltaRows || '<p class="small faint">No comparable filed-period figures are available.</p>'}</div></section>
          <section class="dos-change-copy"><span class="dos-kicker">Research read</span><h3>${esc(rc.headline || 'Latest filing comparison')}</h3>${rc.summary ? `<p>${esc(rc.summary)}</p>` : ''}${changeRows ? `<ul class="dos-change-list">${changeRows}</ul>` : '<p class="small faint">No verified management-language comparison is available for this filing pair.</p>'}
            ${cmp && cmp.latest && cmp.prev ? `<p class="dos-source-row">Compared <a href="${esc(cmp.latest.url)}" target="_blank" rel="noopener">${esc(cmp.latest.form)} ${esc(cmp.latest.date)}</a> with <a href="${esc(cmp.prev.url)}" target="_blank" rel="noopener">${esc(cmp.prev.form)} ${esc(cmp.prev.date)}</a>. Quotation pairs are displayed only when verified against both SEC documents.</p>` : ''}
            ${eventNote}<div class="dos-followups">${followups}<a href="/monitor.html?symbol=${encodeURIComponent(sym)}">Open full Filing Monitor →</a></div>
          </section>
        </div>
      </section>`;
    })() : '';

    // Scenario value range (bear/base/bull) — descriptive, no target price
    const sc = d.valuation && d.valuation.scenarios;
    const scenarioHtml = sc ? `
      <div class="dos-sec">
        <h2>Scenario value range <span class="small faint">bear / base / bull — a value band, not a price target</span></h2>
        <div class="dos-bullbear" style="grid-template-columns:repeat(3,1fr);">
          ${['bear', 'base', 'bull'].map((k) => { const x = sc[k]; const up = x.upsidePct; return `<div class="dos-case dos-case--${k === 'bull' ? 'green' : k === 'bear' ? 'red' : 'blue'}"><h3 style="text-transform:capitalize;">${k}</h3><div style="font-size:20px;font-weight:650;">${bn(x.value)}</div><div class="small ${up >= 0 ? 'delta-pos' : 'delta-neg'}">${up >= 0 ? '+' : ''}${up}% vs market cap</div><div class="basis">at ${x.growthPct}%/yr FCF growth</div></div>`; }).join('')}
        </div>
        <p class="provenance" style="margin-top:8px;">${esc(sc.basis)}</p>
      </div>` : '';

    // Financial analysis — trend charts + DuPont / ratio table
    const fin = history;
    let financialHtml = '';
    if (fin && fin.length >= 2) {
      const dupont = [
        ['Gross margin', 'grossMarginPct', '%'], ['Operating margin', 'opMarginPct', '%'], ['Net margin', 'netMarginPct', '%'],
        ['Asset turnover', 'assetTurnover', 'x'], ['ROA', 'roaPct', '%'], ['ROE', 'roePct', '%'], ['ROIC', 'roicPct', '%'],
        ['Current ratio', 'currentRatio', 'x'], ['Debt / equity', 'debtToEquity', 'x'], ['Interest coverage', 'interestCoverage', 'x']
      ];
      const head = fin.map((r) => `<th>${esc(r.fy)}</th>`).join('');
      const body = dupont.map(([label, key, suf]) => `<tr><td>${label}</td>${fin.map((r) => `<td>${r[key] == null ? '—' : r[key] + (suf === '%' ? '%' : '×')}</td>`).join('')}</tr>`).join('');
      financialHtml = `
        <section class="dos-sec dos-financials" id="dos-financials">
          <div class="dos-section-head"><div><span class="dos-kicker">Financial trajectory</span><h2>The filed record, with the read beside it</h2></div><span class="small faint">Annual statements · exact values on hover</span></div>
          <div class="dos-financial-evidence">
            <section><span class="dos-kicker">Visual evidence</span><div class="dos-visual-stack">
              <div class="dos-visual-panel"><h3>Revenue</h3><p>Scale and compounding</p>${chartBars(fin, 'revenue', bn, C.ink)}</div>
              <div class="dos-visual-panel"><h3>Earnings and cash</h3><p>Annual net income versus free cash flow</p>${chartGroupedBars(fin, [{ key: 'netIncome', label: 'Net income', color: C.grey, fmt: bn }, { key: 'fcf', label: 'Free cash flow', color: C.pos, fmt: bn }])}${legend([{ label: 'Net income', color: C.grey }, { label: 'Free cash flow', color: C.pos }])}</div>
            </div></section>
            <section><span class="dos-kicker">What the record says</span><ol class="dos-financial-read">${financialReadings(fin)}</ol>
              <div class="dos-visual-panel" style="margin-top:24px;"><h3>Margins and returns</h3><p>Annual operating margin versus return on invested capital</p>${chartGroupedBars(fin, [{ key: 'opMarginPct', label: 'Operating margin', color: C.grey, fmt: (v) => v + '%' }, { key: 'roicPct', label: 'ROIC', color: C.pos, fmt: (v) => v + '%' }])}${legend([{ label: 'Operating margin', color: C.grey }, { label: 'ROIC', color: C.pos }])}</div>
            </section>
          </div>
          <details class="dos-ratio-details"><summary>Open the full ratio history</summary><div class="table-wrap"><table class="table-data"><thead><tr><th>DuPont &amp; ratios</th>${head}</tr></thead><tbody>${body}</tbody></table></div><p class="small faint">Computed from filed annual statements. ROIC uses NOPAT ≈ operating income × (1 − 21%).</p></details>
        </section>`;
    }

    // Industry & competitive drivers — Positive/Negative tags, verbatim evidence
    const ind = d.industry;
    const dirBadge = (dir) => { const m = { positive: ['Positive', 'th-holding'], negative: ['Negative', 'th-broken'], mixed: ['Mixed', 'th-weakening'] }; const [lab, cls] = m[dir] || m.mixed; return `<span class="th-badge ${cls}">${lab}</span>`; };
    const industryHtml = ind && !ind.error && ind.drivers && ind.drivers.length ? `
      <div class="dos-sec">
        <h2>Industry &amp; competitive drivers ${ind.sectorContext ? `<span class="small faint">${esc(ind.sector)} · ${ind.sectorContext.peerCount} peers · ${esc(ind.sectorContext.structure || '')}${ind.sectorContext.hhi != null ? ` · HHI ${ind.sectorContext.hhi}` : ''}</span>` : ''}</h2>
        ${ind.sectorNarrative ? `<p style="max-width:74ch;">${esc(ind.sectorNarrative)}</p>` : ''}
        ${ind.sectorContext ? `<div class="dos-snap" style="margin:10px 0;">${snapRow('Sector median growth', ind.sectorContext.medianRevCagr5Pct != null ? ind.sectorContext.medianRevCagr5Pct + '%/yr' : null)}${snapRow('Sector median net margin', ind.sectorContext.medianNetMarginPct != null ? ind.sectorContext.medianNetMarginPct + '%' : null)}${snapRow('Market structure', ind.sectorContext.structure)}</div>` : ''}
        <div class="table-wrap"><table class="table-data">
          <thead><tr><th>Driver</th><th>For ${esc(sym)}</th><th>Position</th><th>Why</th></tr></thead>
          <tbody>${ind.drivers.map((dr) => `<tr><td>${esc(dr.driver)}${dr.evidence ? `<br /><span class="small faint">“${esc(dr.evidence)}”</span>` : ''} <span class="small faint">[${esc(dr.source)}]</span></td><td>${dirBadge(dr.direction)}</td><td class="small">${esc(dr.companyPosition || '—')}</td><td class="small">${esc(dr.rationale || '')}</td></tr>`).join('')}</tbody>
        </table></div>
        ${ind.honesty ? `<p class="provenance" style="margin-top:8px;">${esc(ind.honesty)}</p>` : ''}
      </div>` : '';

    // Governance & ownership — board (DEF 14A) + insider Form 4 + tracked 13F holders
    const g = d.governance;
    let governanceHtml = '';
    if (g && (g.board || g.insider || (g.ownership && g.ownership.holders && g.ownership.holders.length))) {
      const b = g.board;
      const wp = g.webProvenance || {};
      const webTag = (f) => wp[f] ? ` <a href="${esc((wp[f].urls || [])[0] || '#')}" target="_blank" rel="noopener" class="small" style="color:var(--accent); text-decoration:none;" title="Filled from public sources, cross-checked across two independent sources (${esc(wp[f].confidence || '')})">↗ web</a>` : '';
      const row = (k, v, field) => (v == null || v === '') ? '' : `<div><div class="k">${esc(k)}</div><div class="v">${esc(v)}${field && wp[field] ? webTag(field) : ''}</div></div>`;
      const boardGrid = b ? `<div class="dos-snap" style="margin:8px 0 14px;">${row('CEO', b.ceoName, 'ceoName')}${row('Board size', b.boardSize != null ? b.boardSize : null)}${row('Independent', b.independencePct != null ? b.independencePct + '%' : null)}${row('Women on board', b.womenPct != null ? b.womenPct + '%' : null)}${row('CEO also Chair', b.ceoChairCombined == null ? null : (b.ceoChairCombined ? 'Yes' : 'No'), 'ceoChairCombined')}${row('Say-on-pay', b.sayOnPayApprovalPct != null ? b.sayOnPayApprovalPct + '%' : null)}${row('CEO pay ratio', b.ceoPayRatio != null ? Math.round(b.ceoPayRatio) + '× median' : null)}${row('Dual-class shares', b.dualClassShares == null ? null : (b.dualClassShares ? 'Yes' : 'No'), 'dualClassShares')}</div>` : (g.boardError ? `<p class="small faint">${esc(g.boardError)}</p>` : '');
      const ins = g.insider;
      const insiderHtml = ins ? `<h3 class="title-3" style="margin:6px 0 8px;">Insider activity <span class="small faint">Form 4 · last 8 quarters · ${esc(ins.sentiment)}</span></h3><p class="small">Net ${ins.netShares >= 0 ? 'bought' : 'sold'} ${money(Math.abs(ins.netShares))} shares (${bn(Math.abs(ins.netValue))}) across ${ins.buys + ins.sells} transactions over two years.</p>${(ins.recent || []).length ? `<div class="table-wrap"><table class="table-data"><thead><tr><th>Date</th><th>Insider</th><th>Side</th><th>Shares</th><th>Value</th></tr></thead><tbody>${ins.recent.slice(0, 8).map((t) => `<tr><td>${esc(t.date || '')}</td><td>${esc(t.owner || '')}${t.relation ? `<br /><span class="small faint">${esc(t.relation)}</span>` : ''}</td><td class="${t.side === 'buy' ? 'delta-pos' : 'delta-neg'}">${esc(t.side)}</td><td>${t.shares != null ? money(t.shares) : '—'}</td><td>${t.value != null ? bn(t.value) : '—'}</td></tr>`).join('')}</tbody></table></div>` : ''}` : '';
      const own = g.ownership;
      const ownHtml = own && own.holders && own.holders.length ? `<h3 class="title-3" style="margin:14px 0 8px;">Tracked investors holding ${esc(sym)} <span class="small faint">${own.holderCount} of ${own.scanned}${own.period ? ' · ' + esc(own.period) : ''}</span></h3><div class="table-wrap"><table class="table-data"><thead><tr><th>Investor</th><th>Position</th><th>Weight</th><th>Activity</th></tr></thead><tbody>${own.holders.slice(0, 10).map((h) => `<tr><td>${esc(h.name)}${h.fund ? `<br /><span class="small faint">${esc(h.fund)}</span>` : ''}</td><td>${h.value != null ? bn(h.value) : '—'}</td><td>${h.weight != null ? h.weight + '%' : '—'}</td><td class="small ${(h.shareChangePct || 0) > 0 ? 'delta-pos' : (h.shareChangePct || 0) < 0 ? 'delta-neg' : ''}">${h.activity ? esc(h.activity) : ''}${h.shareChangePct != null ? ` ${h.shareChangePct > 0 ? '+' : ''}${h.shareChangePct}%` : ''}</td></tr>`).join('')}</tbody></table></div>${own.note ? `<p class="small faint" style="margin-top:6px;">${esc(own.note)}</p>` : ''}` : '';
      const flags = (g.redFlags || []).length ? `<div style="margin-top:12px;">${g.redFlags.map((f) => `<p class="small" style="margin:4px 0; color:var(--neg);">⚠ ${esc(f)}</p>`).join('')}</div>` : '';
      governanceHtml = `<div class="dos-sec"><h2>Governance &amp; ownership</h2>${boardGrid}${insiderHtml}${ownHtml}${flags}${g.source ? `<p class="provenance" style="margin-top:8px;">${esc(g.source)}${g.boardFiling && g.boardFiling.url ? ` · <a href="${esc(g.boardFiling.url)}" target="_blank" rel="noopener">DEF 14A ${esc(g.boardFiling.date || '')} ↗</a>` : ''}</p>` : ''}</div>`;
    }

    // ESG — filings-grounded, disclosure-completeness score (climate is voluntary)
    const eg = d.esg;
    let esgHtml = '';
    if (eg && eg.transparency) {
      const t = eg.transparency, env = eg.environmental, hc = eg.humanCapital, gv = eg.governance, lit = eg.litigation;
      const pillar = (label, val) => `<div style="flex:1;min-width:90px;"><div class="small faint">${label}</div><div style="font-weight:650;">${val == null ? 'n/a' : val + '/100'}</div></div>`;
      const li = (k, v) => (v == null || v === '' || v === false) ? '' : `<div class="small"><strong>${esc(k)}:</strong> ${esc(v === true ? 'Yes' : v)}</div>`;
      const card = (title, rows, basis) => rows ? `<div class="dos-case"><h3 style="margin:0 0 6px;">${title}</h3>${rows}${basis ? `<p class="small faint" style="margin-top:6px;">${esc(basis)}</p>` : ''}</div>` : '';
      const govCard = gv ? card('Governance', [li('Board independence', gv.independencePct != null ? gv.independencePct + '%' : null), li('Women on board', gv.womenPct != null ? gv.womenPct + '%' : null), li('Say-on-pay', gv.sayOnPayApprovalPct != null ? gv.sayOnPayApprovalPct + '%' : null), li('Dual-class', gv.dualClassShares === true ? 'Yes' : gv.dualClassShares === false ? 'No' : null), li('CEO pay ratio', gv.ceoPayRatio != null ? Math.round(gv.ceoPayRatio) + '×' : null)].join(''), 'DEF 14A · mandated') : '';
      const envCard = env ? card('Environmental', [li('Discusses climate', env.discussesClimate ? 'Yes' : 'Not disclosed'), li('Emissions target', env.emissionsTarget), li('Net-zero commitment', env.netZeroCommitment === true ? 'Yes' : null), li('Renewable share', env.renewablePct != null ? env.renewablePct + '%' : null), li('Scope 1', env.scope1), li('Scope 2', env.scope2), env.summary ? `<div class="small" style="margin-top:4px;">${esc(env.summary)}</div>` : ''].join(''), env.basis) : '';
      const hcCard = hc ? card('Human capital', [li('Employees', hc.employeeCount != null ? money(hc.employeeCount) : null), li('Turnover', hc.turnoverPct != null ? hc.turnoverPct + '%' : null), li('DEI disclosed', hc.deiDisclosed ? 'Yes' : null), li('Health &amp; safety', hc.safetyDisclosed ? 'Yes' : null), li('Training', hc.trainingDisclosed ? 'Yes' : null), hc.summary ? `<div class="small" style="margin-top:4px;">${esc(hc.summary)}</div>` : ''].join(''), hc.basis) : '';
      const litHtml = lit && lit.materiality && lit.materiality !== 'none' && lit.materiality !== 'low' ? `<p class="small" style="margin-top:10px;"><strong>Litigation materiality: ${esc(lit.materiality)}.</strong> ${esc(lit.summary || '')}</p>` : '';
      esgHtml = `<div class="dos-sec"><h2>ESG &amp; disclosure transparency <span class="small faint">${t.overall}/100 · ${esc(t.verdict)}</span></h2>${t.unavailable ? `<p class="small faint" style="margin:0 0 8px;">${esc(t.unavailable)}</p>` : ''}<div style="display:flex; gap:18px; margin:6px 0 12px;">${pillar('Governance', t.byPillar.governance)}${pillar('Environmental', t.byPillar.environmental)}${pillar('Human capital', t.byPillar.humanCapital)}</div><div class="dos-bullbear" style="grid-template-columns:repeat(auto-fit,minmax(200px,1fr));">${govCard}${envCard}${hcCard}</div>${litHtml}${eg.honesty ? `<p class="provenance" style="margin-top:10px;">${esc(eg.honesty)}</p>` : ''}</div>`;
    }

    // Forward DCF + transparent WACC buildup — descriptive fair value, no rating
    const fd = d.forwardDcf;
    let forwardDcfHtml = '';
    if (fd && !fd.error && fd.fairValue && fd.fairValue.perShare != null) {
      const w = fd.waccBuildup, fv = fd.fairValue, a = fd.assumptions, sc2 = fd.scenarios, proj = fd.projection;
      const waccRows = [
        ['Risk-free rate (Rf)', w.riskFreePct + '%', '10Y Treasury, editable'],
        ['Beta (β)', w.beta, w.betaSource],
        ['Equity risk premium', w.erpPct + '%', 'Damodaran 2026, editable'],
        ['Cost of equity (Re)', w.costOfEquityPct + '%', 'Rf + β × ERP'],
        ['Cost of debt (Rd)', w.costOfDebtPct != null ? w.costOfDebtPct + '%' : '—', w.costOfDebtNote],
        ['Tax rate', w.taxRatePct + '%', 'effective, from the 10-K'],
        ['Weight equity / debt', w.weightEquityPct + '% / ' + w.weightDebtPct + '%', 'market equity vs book debt'],
        ['WACC', `<strong>${w.waccPct}%</strong>`, 'wE·Re + wD·Rd·(1−tax)']
      ];
      const scRow = (k) => { const x = sc2[k]; return `<tr><td style="text-transform:capitalize;">${k}</td><td>${x.growthPct}%/yr</td><td>${x.perShare != null ? '$' + x.perShare : '—'}</td><td class="${(x.upsidePct || 0) >= 0 ? 'delta-pos' : 'delta-neg'}">${x.upsidePct != null ? (x.upsidePct >= 0 ? '+' : '') + x.upsidePct + '%' : '—'}</td></tr>`; };
      const projRows = proj && proj.yearRows ? proj.yearRows.map((y) => `<tr><td>Y${y.year}</td><td>${bn(y.fcff)}</td><td>${y.discountFactor}</td><td>${bn(y.pv)}</td></tr>`).join('') : '';
      const weak = fv.historicalAnchorWeak;
      const weakBanner = weak && fv.weakNote ? `<p class="small" style="margin:0 0 12px; padding:10px 12px; border:1px solid var(--accent-ink); border-radius:var(--radius);">${esc(fv.weakNote)}</p>` : '';
      const fvCard = `<div class="dos-case dos-case--${weak ? 'grey' : 'blue'}"><div class="small faint">${weak ? 'Historical-trend value' : 'Base-case fair value'}</div><div style="font-size:28px; font-weight:700;">$${fv.perShare}</div><div class="small">vs $${fv.currentPrice} now${weak ? '' : ` · <span class="${fv.upsidePct >= 0 ? 'delta-pos' : 'delta-neg'}">${fv.upsidePct >= 0 ? '+' : ''}${fv.upsidePct}%</span>`}</div><div class="basis" style="margin-top:6px;">${weak ? 'On past cash flows only — the price is set by expected growth, not history' : esc(fv.status || '')}</div></div>`;
      forwardDcfHtml = `<div class="dos-sec"><h2>Forward DCF &amp; WACC <span class="small faint">descriptive fair value — every input shown, none of it a recommendation</span></h2>
        ${weakBanner}
        <div style="display:flex; gap:24px; flex-wrap:wrap; align-items:flex-start;">
          <div style="flex:2; min-width:280px;"><div class="table-wrap"><table class="table-data"><thead><tr><th>WACC buildup</th><th>Value</th><th>Source</th></tr></thead><tbody>${waccRows.map(([k, v, src]) => `<tr><td>${k}</td><td>${v}</td><td class="small faint">${esc(src || '')}</td></tr>`).join('')}</tbody></table></div></div>
          <div style="flex:1; min-width:200px;">${fvCard}</div>
        </div>
        <div class="table-wrap" style="margin-top:14px;"><table class="table-data"><thead><tr><th>Scenario</th><th>FCF growth</th><th>Fair value/share</th><th>vs market</th></tr></thead><tbody>${scRow('bear')}${scRow('base')}${scRow('bull')}</tbody></table></div>
        ${projRows ? `<details style="margin-top:10px;"><summary class="small" style="cursor:pointer;">Year-by-year FCFF projection (base case)</summary><div class="table-wrap" style="margin-top:8px;"><table class="table-data"><thead><tr><th>Year</th><th>FCFF</th><th>Discount factor</th><th>PV</th></tr></thead><tbody>${projRows}</tbody></table></div><p class="small faint" style="margin-top:6px;">Terminal value ${bn(proj.terminalValuePv)} (${proj.terminalSharePct}% of EV). EV ${bn(proj.enterpriseValue)} − net debt ${bn(proj.netDebt)} = equity ${bn(proj.equityValue)}.</p></details>` : ''}
        <p class="small faint" style="margin-top:8px;">FCF growth anchored on the filed 5-year FCF CAGR (${a.historicalFcfCagr5Pct != null ? a.historicalFcfCagr5Pct + '%/yr' : 'n/a'}) ± an 8-pt band; ${a.horizonYears}-yr horizon; ${a.terminalGrowthPct}% terminal growth${a.terminalGrowthClamped ? ' (capped below WACC)' : ''}.</p>
        <p class="provenance" style="margin-top:6px;">${esc(fd.disclaimer)}</p>
      </div>`;
    } else if (fd && fd.note) {
      forwardDcfHtml = `<div class="dos-sec"><h2>Forward DCF &amp; WACC</h2><p class="muted" style="max-width:74ch;">${esc(fd.note)}</p>${fd.waccBuildup ? `<p class="small faint" style="margin-top:6px;">Computed WACC ${fd.waccBuildup.waccPct}% (cost of equity ${fd.waccBuildup.costOfEquityPct}%, beta ${fd.waccBuildup.beta}).</p>` : ''}</div>`;
    }

    const module = (title, subtitle, content, open = false) => content ? `<details class="dos-module"${open ? ' open' : ''}><summary><span><strong>${esc(title)}</strong>${subtitle ? `<small>${esc(subtitle)}</small>` : ''}</span><span class="dos-module-action">View</span></summary><div class="dos-module-body">${content}</div></details>` : '';
    out.innerHTML = `
      <div class="dos-head">
        <div>
          <h1 class="title-1" style="margin:0;">${esc(d.name || sym)} <span class="faint" style="font-weight:600;">(${esc(sym)})</span><span class="beta-badge">Beta</span></h1>
          <p class="small faint" style="margin:4px 0 0;">${esc(metaLine(d))} · dossier as of fiscal ${esc(d.fyEnd || '')}${d.cached ? '' : ' · freshly built'}</p>
        </div>
        <div class="dos-actions">
          ${window.PV.modeChips('dos', mode)}
          <a class="btn btn-ghost btn-sm" href="./compare-dossiers.html?symbols=${encodeURIComponent(sym)}" title="Put this company side by side with up to two others">Compare ↔ <span class="beta-badge">Beta</span></a>
          <button class="btn btn-ghost btn-sm" id="dos-print">Print / Save PDF</button>
          <button class="btn btn-quiet btn-sm" id="dos-refresh" title="Rebuild from the latest filings">Refresh</button>
        </div>
      </div>
      <nav class="dos-jump" aria-label="Dossier sections"><a href="#dos-brief">Decision brief</a><a href="#dos-financials">Financial trajectory</a><a href="#dos-latest-change">Latest filing</a><a href="#dos-cases">Cases &amp; risks</a><a href="#dos-deep">Deep research</a><a href="#dos-thesis">My thesis</a></nav>
      <section class="dos-decision-grid" id="dos-brief">
        <section><span class="dos-kicker">Visual evidence</span><h2>The business trajectory</h2>${decisionTrends(history)}</section>
        <section><span class="dos-kicker">Decision brief</span><h2>The case in two minutes</h2><div class="dos-decision-copy">${briefParagraphs(briefText)}</div><div class="dos-key-strip">${keyStrip}</div></section>
      </section>
      ${financialHtml}
      ${recent}
      <section id="dos-cases" class="dos-priority">
        <div class="dos-section-head"><div><span class="dos-kicker">Decision pressure-test</span><h2>What has to go right—and what can break</h2></div></div>
        ${bullbear}
        ${risks}
      </section>
      <section id="dos-deep" class="dos-deep">
        <div class="dos-section-head"><div><span class="dos-kicker">Deep research</span><h2>Open only the evidence you need</h2></div><span class="small faint">The detail is preserved, not dumped on the page.</span></div>
        <div class="dos-modules">
          ${module('Business & segments', 'How the company makes money', `${s.description ? `<div class="dos-sec"><h2>The business</h2><p style="max-width:74ch;line-height:1.7;">${esc(s.description)}</p></div>` : ''}${unitEcon}${segs}`)}
          ${module('Forensic signals', 'Non-obvious earnings and capital-allocation evidence', `${edge}${read}`)}
          ${module('Industry & peers', 'Competitive position and comparable-company context', `${industryHtml}${competitive}`)}
          ${module('Valuation', 'Expectations, scenarios and DCF assumptions', `${valuationHtml}${scenarioHtml}${forwardDcfHtml}`)}
          ${module('Governance & ownership', 'Board, insiders and tracked investors', `${governanceHtml}${esgHtml}`)}
          ${module('Financial health checks', 'Deterministic tests from filed statements', checks)}
        </div>
      </section>
      <div id="dos-thesis"></div>
      <p class="dos-prov">${esc((d.sources && d.sources.note) || 'Every figure is computed from SEC-filed statements; prose is written over those finished facts. Educational, not investment advice.')}</p>`;
    const share = document.createElement('div');
    mountShare(share, { title: `${d.name || sym} (${sym}) research dossier`, text: briefText });
    out.appendChild(share);
    out.hidden = false;

    $('dos-print').addEventListener('click', () => window.print());
    $('dos-refresh').addEventListener('click', () => run(sym, true));
    $('dos-mode-normal').addEventListener('click', () => { localStorage.setItem(MODE_KEY, 'normal'); render(out, RAW_DOSSIER, RAW_SYM); });
    $('dos-mode-analyst').addEventListener('click', () => { localStorage.setItem(MODE_KEY, 'analyst'); render(out, RAW_DOSSIER, RAW_SYM); });
    loadThesis(sym);
  }

  // Normal mode — same underlying analysis as Analyst mode, read visually:
  // score dots, split/pair/share bars and plain captions instead of tables.
  // Nothing here recomputes a figure; everything reads a field the payload
  // already has. "Show the analyst numbers" below switches straight into
  // renderAnalyst so no number is ever a second, possibly-drifted copy.
  function renderNormal(out, d, sym) {
    const PV = window.PV;
    const s = d.snapshot || {};
    const history = d.financials || [];
    const last = history[history.length - 1] || {};
    const prev = history[history.length - 2] || {};
    const briefText = String(d.executiveSummaryPlain || d.executiveSummary || '').trim() || deterministicBrief(d);
    const firstSentence = (briefText.split(/(?<=[.!?])\s+/)[0] || briefText).trim();

    // Verdict score: revenue direction + margin move + FCF-positive years + risk mix.
    let score = 2.5;
    if (history.length >= 2) {
      if ((last.revenue || 0) > (prev.revenue || 0)) score += 0.5; else if (last.revenue != null) score -= 0.5;
      if ((last.opMarginPct || 0) > (prev.opMarginPct || 0)) score += 0.5; else if (last.opMarginPct != null) score -= 0.5;
    }
    const fcfPosYears = history.filter((r) => (r.fcf || 0) > 0).length;
    if (history.length) score += (fcfPosYears / history.length - 0.5);
    const risks = d.risksPlain && d.risksPlain.length ? d.risksPlain : (d.risks || []);
    const highRisks = risks.filter((r) => r.severity === 'high').length;
    score -= Math.min(1.5, highRisks * 0.5);
    score = Math.max(0, Math.min(5, score));

    const verdictHtml = `
      <div class="pv-card">
        <div style="display:flex; align-items:center; gap:12px; flex-wrap:wrap;">
          ${PV.ratingDots(score, 5)}
          <strong style="font-size:15px;">${esc(d.name || sym)} (${esc(sym)})</strong>
        </div>
        <p style="max-width:74ch; margin-top:10px;">${esc(firstSentence)}</p>
      </div>`;

    // What it earns per unit — straight off the Part B payload field.
    const ue = d.unitEconomics;
    let unitHtml = '';
    if (ue && ue.derived && ue.derived.revenuePerUnit != null) {
      const parts = [
        { label: 'Cost to make one', value: Math.max(0, ue.derived.revenuePerUnit - (ue.derived.grossProfitPerUnit || 0)), color: 'var(--neg)', shown: ue.derived.costPerUnit != null ? '$' + money(ue.derived.costPerUnit) : undefined },
        { label: 'Profit kept', value: Math.max(0, ue.derived.grossProfitPerUnit || 0), color: 'var(--pos)', shown: ue.derived.grossProfitPerUnit != null ? '$' + money(ue.derived.grossProfitPerUnit) : undefined }
      ];
      unitHtml = `
        <div class="pv-card">
          <h2>What it earns per ${esc(ue.unitLabel || 'unit')}</h2>
          <p class="small faint" style="margin:0 0 10px;">Fiscal ${esc(ue.fiscalYear || '')} · price paid ~$${money(ue.derived.revenuePerUnit)}</p>
          ${PV.splitBar(parts)}
          ${ue.note ? `<p class="small faint" style="margin-top:8px;">${esc(ue.note)}</p>` : ''}
        </div>`;
    } else if (ue && Array.isArray(ue.metrics) && ue.metrics.length) {
      const rows = ue.metrics.slice(0, 4).map((m) => {
        const val = m.value != null ? money(m.value) : '—';
        const unitSuffix = m.unit && !/^(count|units?|#)$/i.test(String(m.unit).trim()) ? ' ' + esc(m.unit) : '';
        return `<li><b>${esc(m.name || 'Metric')}</b>: ${val}${unitSuffix}${m.period ? ` <span class="small faint">(${esc(m.period)})</span>` : ''}</li>`;
      }).join('');
      const note = (ue.derived && ue.derived.note) || ue.note;
      unitHtml = `
        <div class="pv-card">
          <h2>What we know about its ${esc(ue.unitLabel || 'units')}</h2>
          <ul style="padding-left:18px; margin:0;">${rows}</ul>
          ${note ? `<p class="small faint" style="margin-top:8px;">${esc(note)}</p>` : ''}
        </div>`;
    }

    // Where the money goes — split of the latest year's revenue.
    let moneyHtml = '';
    if (last.revenue) {
      const cost = Math.max(0, (last.revenue || 0) - (last.grossProfit != null ? last.grossProfit : (last.revenue || 0) - (last.costOfRevenue || 0)));
      const profit = Math.max(0, last.netIncome || 0);
      const other = Math.max(0, (last.revenue || 0) - cost - profit);
      moneyHtml = `
        <div class="pv-card">
          <h2>Where the money goes</h2>
          <p class="small faint" style="margin:0 0 10px;">Every $1 of ${esc(last.fy || 'latest year')} sales</p>
          ${PV.splitBar([
        { label: 'Cost of what it sells', value: cost, color: 'var(--neg)', shown: PV.perDollar(cost / last.revenue * 100) },
        { label: 'Everything else (opex, tax, interest)', value: other, color: 'var(--ink-3)', shown: PV.perDollar(other / last.revenue * 100) },
        { label: 'Kept as profit', value: profit, color: 'var(--pos)', shown: PV.perDollar(profit / last.revenue * 100) }
      ])}
        </div>`;
    }

    // Trend strip — reuse the existing chart helpers, just plainer captions.
    const trendHtml = history.length >= 2 ? `
      <div class="pv-card">
        <h2>The trend</h2>
        <div class="dos-visual-stack">
          <div class="dos-visual-panel"><h3>Revenue</h3><p>${last.revenue > prev.revenue ? 'Growing' : 'Shrinking'} year over year</p>${chartBars(history, 'revenue', bn, C.ink)}</div>
          <div class="dos-visual-panel"><h3>Profit</h3><p>Net income, ${last.netIncome > prev.netIncome ? 'improving' : 'declining'}</p>${chartGroupedBars(history, [{ key: 'netIncome', label: 'Net income', color: C.pos, fmt: bn }])}</div>
        </div>
      </div>` : '';

    // What it sells — segment share-of-revenue.
    const segItems = d.segments && d.segments.items && d.segments.items.length ? d.segments.items : null;
    const sellsHtml = segItems ? `
      <div class="pv-card">
        <h2>What it sells</h2>
        ${PV.share(segItems.map((x) => ({ label: x.name, pct: x.revenuePct, note: x.description })))}
      </div>` : '';

    // Bull / bear cards.
    const bullArr = d.bullPlain && d.bullPlain.length ? d.bullPlain : (d.bull || []);
    const bearArr = d.bearPlain && d.bearPlain.length ? d.bearPlain : (d.bear || []);
    const caseList = (arr) => arr.map((x) => `<li>${esc(x.point)}${x.basis ? `<br /><span class="basis">${esc(x.basis)}</span>` : ''}</li>`).join('');
    const bullbearHtml = (bullArr.length || bearArr.length) ? `
      <div class="pv-card">
        <h2>What's working / what could go wrong</h2>
        <div class="dos-bullbear">
          <div class="dos-case bull"><h3>Working</h3><ul style="padding-left:18px; margin:0;">${caseList(bullArr) || '<li class="faint">—</li>'}</ul></div>
          <div class="dos-case bear"><h3>Could go wrong</h3><ul style="padding-left:18px; margin:0;">${caseList(bearArr) || '<li class="faint">—</li>'}</ul></div>
        </div>
      </div>` : '';

    // Risks with a plain severity meter.
    const risksHtml = risks.length ? `
      <div class="pv-card">
        <h2>Risks</h2>
        <div style="display:grid; gap:10px;">${risks.map((r) => {
        const step = r.severity === 'high' ? 3 : r.severity === 'low' ? 1 : 2;
        return `<div>
            <div style="display:flex; justify-content:space-between; gap:10px; align-items:baseline;"><strong>${esc(r.risk)}</strong><span class="small faint">${esc(PV.plainSeverity(r.severity))}</span></div>
            <div class="pv-meter">${[1, 2, 3].map((i) => `<i class="${i <= step ? `is-on ${step === 3 ? 'high' : step === 2 ? 'mid' : 'low'}` : ''}"></i>`).join('')}</div>
            <div class="small" style="margin-top:4px;">${esc(r.trigger || r.impact || '')}</div>
          </div>`;
      }).join('')}</div>
      </div>` : '';

    // What the price assumes vs what actually happened.
    const v = d.valuation;
    const rec = v && v.record ? v.record : {};
    const priceHtml = v && v.impliedGrowthPct != null ? `
      <div class="pv-card">
        <h2>What the price assumes</h2>
        <p class="small faint" style="margin:0 0 10px;">Growth priced in vs. actual 5-year growth</p>
        ${PV.pairBars('Priced in', v.impliedGrowthPct, 'Actually delivered', rec.fcfCagr5Pct || 0, (x) => x + '%/yr')}
      </div>` : '';

    // Versus rivals.
    const cp = d.competitive;
    const rivalsHtml = cp && cp.company && cp.medians ? `
      <div class="pv-card">
        <h2>Versus rivals</h2>
        <p class="small faint" style="margin:0 0 10px;">${esc(sym)} vs the ${esc(cp.sector || '')} peer median</p>
        ${cp.company.revCagr5Pct != null ? PV.pairBars(esc(sym) + ' revenue growth', cp.company.revCagr5Pct, 'Peer median', cp.medians.revCagr5Pct, (x) => x + '%/yr') : ''}
        ${cp.company.netMarginPct != null ? PV.pairBars(esc(sym) + ' net margin', cp.company.netMarginPct, 'Peer median', cp.medians.netMarginPct, (x) => x + '%') : ''}
      </div>` : '';

    out.innerHTML = `
      <div class="dos-head">
        <div>
          <h1 class="title-1" style="margin:0;">${esc(d.name || sym)} <span class="faint" style="font-weight:600;">(${esc(sym)})</span><span class="beta-badge">Beta</span></h1>
          <p class="small faint" style="margin:4px 0 0;">${esc(metaLine(d))} · dossier as of fiscal ${esc(d.fyEnd || '')}${d.cached ? '' : ' · freshly built'}</p>
        </div>
        <div class="dos-actions">
          ${PV.modeChips('dos', 'normal')}
          <a class="btn btn-ghost btn-sm" href="./compare-dossiers.html?symbols=${encodeURIComponent(sym)}" title="Put this company side by side with up to two others">Compare ↔ <span class="beta-badge">Beta</span></a>
          <button class="btn btn-ghost btn-sm" id="dos-print">Print / Save PDF</button>
          <button class="btn btn-quiet btn-sm" id="dos-refresh" title="Rebuild from the latest filings">Refresh</button>
        </div>
      </div>
      ${verdictHtml}
      ${unitHtml}
      ${moneyHtml}
      ${trendHtml}
      ${sellsHtml}
      ${bullbearHtml}
      ${risksHtml}
      ${priceHtml}
      ${rivalsHtml}
      <details class="dos-module"><summary><span><strong>Show the analyst numbers</strong><small>Every table, chart and figure Analyst mode shows</small></span><span class="dos-module-action">View</span></summary>
        <div class="dos-module-body"><button class="btn btn-ghost btn-sm" id="dos-show-analyst" style="margin-bottom:10px;">Switch to Analyst mode →</button></div>
      </details>
      <div id="dos-thesis"></div>`;
    const share = document.createElement('div');
    mountShare(share, { title: `${d.name || sym} (${sym}) research dossier`, text: firstSentence });
    out.appendChild(share);
    out.hidden = false;

    $('dos-print').addEventListener('click', () => window.print());
    $('dos-refresh').addEventListener('click', () => run(sym, true));
    $('dos-mode-normal').addEventListener('click', () => { localStorage.setItem(MODE_KEY, 'normal'); render(out, RAW_DOSSIER, RAW_SYM); });
    $('dos-mode-analyst').addEventListener('click', () => { localStorage.setItem(MODE_KEY, 'analyst'); render(out, RAW_DOSSIER, RAW_SYM); });
    $('dos-show-analyst').addEventListener('click', () => { localStorage.setItem(MODE_KEY, 'analyst'); render(out, RAW_DOSSIER, RAW_SYM); });
    loadThesis(sym);
  }

  // ---- thesis tracker ----
  const TH_LABEL = { holding: 'Holding', weakening: 'Weakening', broken: 'Broken', unclear: 'Unclear' };
  function renderThesisEditor(host, sym, existing) {
    host.innerHTML = `
      <div class="dos-sec dos-thesis-edit">
        <h2>Your thesis</h2>
        <p class="muted small" style="max-width:74ch; margin:0 0 10px;">Write, in plain English, why you own (or are watching) ${esc(sym)}. We split it into claims and grade each against the latest filing — your reasons, not generic materiality.</p>
        <textarea class="input" id="th-text" rows="3" style="width:100%; resize:vertical;" placeholder="e.g. Data-center revenue keeps growing over 30% a year, gross margin stays above 70%, and no single customer is more than 15% of sales.">${esc(existing || '')}</textarea>
        <div style="display:flex; gap:8px; margin-top:10px; flex-wrap:wrap;">
          <button class="btn btn-primary btn-sm" id="th-save">${existing ? 'Update & re-grade' : 'Save & grade'}</button>
          ${existing ? '<button class="btn btn-quiet btn-sm" id="th-del">Remove</button>' : ''}
          <span class="small faint" id="th-msg" role="status"></span>
        </div>
        <div id="th-grade" style="margin-top:14px;"></div>
      </div>`;
    $('th-save').addEventListener('click', () => saveThesis(sym));
    if (existing) {
      const del = $('th-del');
      if (del) del.addEventListener('click', () => delThesis(sym));
      grade(sym);
    }
  }

  async function loadThesis(sym) {
    const host = $('dos-thesis');
    if (!host) return;
    try {
      const r = await fetch(`${API}/thesis`, { headers: auth() });
      if (r.status === 402 || !r.ok) { host.innerHTML = ''; return; } // gated/unauth: dossier already gated, so this is rare
      const d = await r.json();
      const mine = (d.theses || []).find((t) => t.symbol === sym);
      renderThesisEditor(host, sym, mine ? mine.text : '');
    } catch (_) { host.innerHTML = ''; }
  }

  async function saveThesis(sym) {
    const msg = $('th-msg');
    const text = $('th-text').value.trim();
    msg.textContent = 'Saving…';
    try {
      const r = await fetch(`${API}/thesis`, { method: 'POST', headers: { ...auth(), 'Content-Type': 'application/json' }, body: JSON.stringify({ symbol: sym, text }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { msg.textContent = d.message || 'Could not save.'; return; }
      msg.textContent = 'Saved — grading against the latest filing…';
      grade(sym);
    } catch (_) { msg.textContent = 'Network problem — try again.'; }
  }

  async function delThesis(sym) {
    try { await fetch(`${API}/thesis/${encodeURIComponent(sym)}`, { method: 'DELETE', headers: auth() }); } catch (_) {}
    loadThesis(sym);
  }

  async function grade(sym) {
    const out = $('th-grade');
    if (!out) return;
    out.innerHTML = spinner('Grading your thesis against the latest filing…');
    try {
      const r = await fetch(`${API}/thesis/${encodeURIComponent(sym)}/grade`, { headers: auth() });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { out.innerHTML = `<p class="small faint">${esc(d.message || 'Could not grade right now.')}</p>`; return; }
      const overallCls = d.overall === 'intact' ? 'th-holding' : d.overall === 'impaired' ? 'th-broken' : 'th-weakening';
      out.innerHTML = `
        <p style="margin:0 0 10px;"><span class="th-badge ${overallCls}">Thesis ${esc(d.overall || 'mixed')}</span> <span class="small">${esc(d.summary || '')}</span></p>
        ${(d.claims || []).map((c) => `<div class="th-claim"><span class="th-badge th-${c.status}">${esc(TH_LABEL[c.status] || c.status)}</span><div>${esc(c.claim)}${c.evidence ? `<div class="th-ev">${esc(c.evidence)}</div>` : ''}</div></div>`).join('')}
        ${d.gradedFiling ? `<p class="small faint" style="margin-top:10px;">Graded against ${esc(d.gradedFiling.label || d.gradedFiling.form || 'the latest filing')}${d.gradedFiling.date ? ` (${esc(d.gradedFiling.date)})` : ''}. ${esc(d.note || '')}</p>` : ''}`;
      const share = document.createElement('div');
      mountShare(share, { title: `${sym} thesis grade: ${d.overall || 'mixed'}`, text: d.summary || '' });
      out.appendChild(share);
    } catch (_) { out.innerHTML = '<p class="small faint">Network problem grading the thesis.</p>'; }
  }

  // ---- build + poll loop ----
  let running = false;
  async function run(sym, force) {
    sym = String(sym || '').toUpperCase().trim().replace(/[^A-Z0-9.\-]/g, '');
    if (!sym || running) return;
    running = true;
    const out = $('dos-report');
    $('dos-hero').hidden = true;
    const preview = $('dos-preview');
    if (preview) preview.hidden = true;
    if (history.replaceState) history.replaceState(null, '', `/dossier.html?symbol=${encodeURIComponent(sym)}`);
    setBuilding(out, sym, null, 0);
    const started = Date.now();
    try {
      // first request kicks the build (force adds ?refresh=1); then poll.
      let first = true;
      while (Date.now() - started < MAX_WAIT_MS) {
        const q = first ? (force ? '?refresh=1' : '') : '?poll=1';
        first = false;
        let r;
        try { r = await fetch(`${API}/dossier/${encodeURIComponent(sym)}${q}`, { headers: auth() }); }
        catch (_) { await wait(POLL_MS); continue; }
        if (r.status === 401) { upsell(out); break; }
        if (r.status === 402) { const d = await r.json().catch(() => ({})); handleDossier402(out, d); break; }
        if (r.status === 404 || r.status === 422) { const e = await r.json().catch(() => ({})); fail(out, e.message || `Couldn’t build a dossier for ${sym}.`); break; }
        if (r.status === 202) { const d = await r.json().catch(() => ({})); setBuilding(out, sym, d.stage, Date.now() - started); await wait(POLL_MS); continue; }
        if (!r.ok) { fail(out, 'Something went wrong building the dossier.'); break; }
        const d = await r.json().catch(() => ({}));
        if (d && d.dossier) {
          render(out, d.dossier, sym);
          // A partial carries every data section with the narrative still being
          // written — show it now and keep polling; the full payload re-renders
          // over it when the writing round finishes.
          if (d.dossier.partial) { partialNote(out); await wait(POLL_MS); continue; }
          break;
        }
        await wait(POLL_MS);
      }
      if (Date.now() - started >= MAX_WAIT_MS && out.querySelector('.loading-line')) {
        out.innerHTML = `<div class="card card-pad"><p style="margin:0;">This dossier is taking longer than usual.</p><button class="btn btn-ghost btn-sm" style="margin-top:10px;" onclick="location.reload()">Try again</button></div>`;
      }
    } finally { running = false; }
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // Slim status line placed above a partially-rendered dossier. Re-rendering
  // on the next poll replaces it along with the rest of `out`, so it needs no
  // cleanup of its own.
  function partialNote(out) {
    if (out.querySelector('[data-partial]')) return;
    const bar = document.createElement('div');
    bar.className = 'card card-pad';
    bar.dataset.partial = '1';
    bar.style.marginBottom = '12px';
    bar.innerHTML = '<p style="margin:0;" class="faint">All data sections below are live. The written analysis — executive summary, bull/bear, risks — is still being drafted and will replace this note when ready.</p>';
    out.insertBefore(bar, out.firstChild);
  }

  $('dos-form').addEventListener('submit', (e) => { e.preventDefault(); run($('dos-sym').value, false); });

  // Ticker autocomplete is intentionally company-only. Funds use the provider-
  // labelled instrument workspace and Ask instead of SEC company analysis.
  (function wireAutocomplete() {
    const input = $('dos-sym');
    if (!input || !searchAssets) return;
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative; flex:1; display:flex;';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input.style.flex = '1';
    const box = document.createElement('div');
    box.className = 'sym-ac';
    box.hidden = true;
    wrap.appendChild(box);
    let items = [], active = -1;
    const render = () => {
      if (!items.length) { box.hidden = true; return; }
      box.innerHTML = items.map((c, i) =>
        `<button type="button" data-sym="${esc(c.symbol)}" class="${i === active ? 'is-active' : ''}"><span class="sym">${esc(c.symbol)}</span><span class="nm">${esc(c.name || '')}${c.assetType && c.assetType !== 'stock' ? ` · ${esc(c.assetTypeLabel || c.assetType)}` : ''}</span></button>`).join('');
      box.hidden = false;
    };
    const choose = (sym) => { box.hidden = true; items = []; input.value = sym; run(sym, false); };
    input.addEventListener('input', async () => {
      const q = input.value.trim().toUpperCase();
      if (q.length < 1) { box.hidden = true; return; }
      items = (await searchAssets(q, { limit: 16 }))
        .filter((item) => !item.assetType || item.assetType === 'stock')
        .slice(0, 8);
      active = -1; render();
    });
    input.addEventListener('keydown', (e) => {
      if (box.hidden) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); render(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
      else if (e.key === 'Enter' && items.length) { e.preventDefault(); choose(items[active >= 0 ? active : 0].symbol); }
      else if (e.key === 'Escape') { box.hidden = true; }
    });
    box.addEventListener('click', (e) => { const btn = e.target.closest('button[data-sym]'); if (btn) choose(btn.dataset.sym); });
    document.addEventListener('click', (e) => { if (e.target !== input && !box.contains(e.target)) box.hidden = true; });
  })();

  // The pricing line under the Build dossier form is a pitch: hide it from
  // accounts that have nothing left to buy (same top-tier rule as the nav chip).
  (async () => {
    const line = document.getElementById('dos-planline');
    if (!line || !token()) return; // logged-out visitors ARE the audience here
    try {
      const r = await fetch(`${API}/session`, { headers: auth() });
      if (!r.ok) return;
      const s = await r.json();
      const planId = (s && s.subscription && s.subscription.planId) || '';
      if (['power', 'power-monthly', 'desk', 'enterprise'].includes(planId)) line.hidden = true;
    } catch (_) { /* leave the line up on any session hiccup */ }
  })();

  // What this click will cost, BEFORE it is clicked. Until now the only credit
  // signal on this page was the 402 wall after the spend had already failed.
  (async () => {
    const el = document.getElementById('dos-credit-line');
    if (!el || !token()) return;
    try {
      const r = await fetch(`${API}/credits`, { headers: auth() });
      if (!r.ok) return;
      const c = await r.json();
      if (!Number.isFinite(c.remaining)) return;
      el.textContent = `You have ${c.remaining} left. `;
    } catch (_) { /* the static costs above are still true */ }
  })();

  const initial = new URLSearchParams(location.search).get('symbol');
  if (initial) { $('dos-sym').value = initial.toUpperCase(); run(initial, false); }
})();
