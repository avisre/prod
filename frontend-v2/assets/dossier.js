// Research Dossier page — on-demand initiation report on any ticker, plus the
// thesis tracker. Power/Desk feature: a 402 swaps in the upgrade card. The
// build is slow (it composes several grounded surfaces), so the server kicks
// it and returns {status:'building', stage} fast; we poll until it lands.
(function () {
  'use strict';
  const { API, token, esc, money, num, spinner, nav, companies } = window.V2;
  const $ = (id) => document.getElementById(id);
  const auth = () => (token() ? { Authorization: `Bearer ${token()}` } : {});

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
        <span class="label">Research Dossier — on Power &amp; Desk</span>
        <h2 class="title-2" style="margin:12px 0 8px;">The analyst’s write-up, on demand</h2>
        <p class="muted" style="max-width:64ch;">A from-scratch, source-linked dossier on any US-listed company — business, segments, ten-year figures, what’s priced in, the bull and bear case, and what just changed in the latest filing — plus a thesis tracker that grades your own reasons against every new filing. The work an analyst bills 20–40 hours for, or that a research seat costs five figures a year. Yours unlimited on Power.</p>
        <div style="display:flex; flex-wrap:wrap; gap:12px; margin-top:16px;">
          <a class="btn btn-primary" href="/register.html?plan=power-monthly">Start Power — $64/mo</a>
          <a class="btn btn-ghost" href="/register.html?plan=power">Or $579/yr — save 25%</a>
        </div>
        <p class="small faint" style="margin:12px 0 0;">Desk for RIAs &amp; funds — <a href="/register.html?plan=desk">$1,961/yr →</a></p>
      </div>`;
    out.hidden = false;
  }

  function fail(out, msg) {
    out.innerHTML = `<div class="card card-pad"><p style="margin:0;">${esc(msg)}</p>
      <p class="small faint" style="margin:10px 0 0;">Check the ticker (US exchange-listed SEC filers only) or try again in a moment.</p></div>`;
    out.hidden = false;
  }

  // ---- rendering ----
  const TONE = { improving: 'pos', deteriorating: 'neg', stable: '' };
  function snapRow(k, v) { return v == null || v === '' || v === 'None' ? '' : `<div><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`; }

  // ---- compact inline SVG charts (print-friendly, dependency-free) ----
  const C = { ink: '#1c1b18', accent: '#1a4fd6', pos: '#1b7a4b', neg: '#b4422f', grey: '#8a877e', faint: '#e7e4dd' };
  function chartBars(rows, key, fmt, color) {
    const pts = rows.map((r) => ({ fy: r.fy, v: r[key] })).filter((p) => p.v !== null && p.v !== undefined);
    if (pts.length < 2) return '';
    const max = Math.max(...pts.map((p) => Math.abs(p.v))) || 1;
    const W = 100, H = 46, n = pts.length, bw = (W / n) * 0.62, gap = (W / n) * 0.38;
    const bars = pts.map((p, i) => {
      const h = Math.max(1, (Math.abs(p.v) / max) * (H - 14));
      const x = i * (W / n) + gap / 2;
      return `<rect x="${x.toFixed(1)}" y="${(H - 10 - h).toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" fill="${color}" rx="0.5"><title>${esc(p.fy)}: ${esc(fmt(p.v))}</title></rect>`;
    }).join('');
    const labs = `<text x="0" y="${H}" font-size="4" fill="${C.grey}">${esc(pts[0].fy)}</text><text x="${W}" y="${H}" font-size="4" fill="${C.grey}" text-anchor="end">${esc(pts[pts.length - 1].fy)}</text>`;
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:90px;display:block">${bars}${labs}</svg>`;
  }
  function chartLines(rows, series) {
    const fys = rows.map((r) => r.fy);
    const all = series.flatMap((s) => rows.map((r) => r[s.key]).filter((v) => v !== null && v !== undefined));
    if (all.length < 2) return '';
    const min = Math.min(...all), max = Math.max(...all), span = (max - min) || 1;
    const W = 100, H = 46, n = rows.length;
    const x = (i) => (n <= 1 ? 0 : (i / (n - 1)) * W);
    const y = (v) => H - 10 - ((v - min) / span) * (H - 14);
    const lines = series.map((s) => {
      const pts = rows.map((r, i) => ({ i, v: r[s.key] })).filter((p) => p.v !== null && p.v !== undefined);
      if (pts.length < 2) return '';
      const d = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)} ${y(p.v).toFixed(1)}`).join(' ');
      return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="1.2"/>`;
    }).join('');
    const labs = `<text x="0" y="${H}" font-size="4" fill="${C.grey}">${esc(fys[0])}</text><text x="${W}" y="${H}" font-size="4" fill="${C.grey}" text-anchor="end">${esc(fys[fys.length - 1])}</text>`;
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:90px;display:block">${lines}${labs}</svg>`;
  }
  function legend(items) { return `<div style="display:flex;gap:12px;flex-wrap:wrap;margin-top:4px;">${items.map((i) => `<span class="small" style="color:var(--ink-3)"><span style="display:inline-block;width:9px;height:9px;background:${i.color};border-radius:2px;margin-right:4px;vertical-align:middle"></span>${esc(i.label)}</span>`).join('')}</div>`; }
  const bn = (v) => (v == null ? '—' : Math.abs(v) >= 1e12 ? '$' + (v / 1e12).toFixed(2) + 'T' : Math.abs(v) >= 1e9 ? '$' + (v / 1e9).toFixed(1) + 'B' : '$' + (v / 1e6).toFixed(0) + 'M');

  function render(out, d, sym) {
    const s = d.snapshot || {};
    const mc = num(s.marketCap);
    const pct = (x) => { const n = num(x); return n == null ? null : (Math.abs(n) <= 1 ? (n * 100).toFixed(1) : Number(n).toFixed(1)) + '%'; };
    const snap = [
      snapRow('Market cap', mc ? '$' + money(mc) : null),
      snapRow('P/E', s.pe && s.pe !== 'None' ? Number(s.pe).toFixed(1) : null),
      snapRow('EPS', s.eps && s.eps !== 'None' ? '$' + Number(s.eps).toFixed(2) : null),
      snapRow('Profit margin', pct(s.profitMargin)),
      snapRow('ROE', pct(s.roe)),
      snapRow('Dividend yield', pct(s.dividendYield))
    ].join('');

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
    const competitive = cp ? `
      <div class="dos-sec">
        <h2>Competitive positioning <span class="small faint">vs ${cp.peerCount} ${esc(cp.sector)} peers</span></h2>
        <p style="max-width:74ch;">${esc(cp.verdict)}</p>
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
    const recent = rc ? `
      <div class="dos-sec">
        <h2>Recent changes ${rc.tone && TONE[rc.tone] ? `<span class="small ${TONE[rc.tone] === 'pos' ? 'delta-pos' : 'delta-neg'}">${esc(rc.tone)}</span>` : ''}</h2>
        ${rc.headline ? `<p style="max-width:74ch;"><strong>${esc(rc.headline)}</strong></p>` : ''}
        ${rc.summary ? `<p class="muted" style="max-width:74ch;">${esc(rc.summary)}</p>` : ''}
        ${(rc.deltas || []).length ? `<div class="table-wrap"><table class="table-data"><thead><tr><th>Metric</th><th>Latest</th><th>Prior</th><th>Change</th></tr></thead><tbody>${rc.deltas.map((x) => `<tr><td>${esc(x.label)}</td><td>${esc(x.latest)}</td><td>${esc(x.prior)}</td><td class="${x.direction === 'up' ? 'delta-pos' : x.direction === 'down' ? 'delta-neg' : ''}">${esc(x.change)}</td></tr>`).join('')}</tbody></table></div>` : ''}
        ${rc.filing && rc.filing.url ? `<p class="small faint" style="margin-top:8px;"><a href="${esc(rc.filing.url)}" rel="noopener" target="_blank">${esc(rc.filing.label || rc.filing.form || 'Filing')} — ${esc(rc.filing.date || '')} on SEC EDGAR ↗</a></p>` : ''}
        <p class="small faint" style="margin-top:6px;">Want this pushed when it files? <a href="/monitor.html?symbol=${esc(sym)}">Open it in the Monitor →</a></p>
      </div>` : '';

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
    const fin = d.financials;
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
        <div class="dos-sec">
          <h2>Financial analysis</h2>
          <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(200px,1fr)); gap:16px; margin-bottom:14px;">
            <div><p class="small faint" style="margin:0 0 2px;">Revenue</p>${chartBars(fin, 'revenue', bn, C.ink)}</div>
            <div><p class="small faint" style="margin:0 0 2px;">Margins</p>${chartLines(fin, [{ key: 'grossMarginPct', color: C.grey }, { key: 'opMarginPct', color: C.accent }, { key: 'netMarginPct', color: C.pos }])}${legend([{ label: 'Gross', color: C.grey }, { label: 'Operating', color: C.accent }, { label: 'Net', color: C.pos }])}</div>
            <div><p class="small faint" style="margin:0 0 2px;">Returns</p>${chartLines(fin, [{ key: 'roePct', color: C.accent }, { key: 'roicPct', color: C.pos }])}${legend([{ label: 'ROE', color: C.accent }, { label: 'ROIC', color: C.pos }])}</div>
          </div>
          <div class="table-wrap"><table class="table-data"><thead><tr><th>DuPont &amp; ratios</th>${head}</tr></thead><tbody>${body}</tbody></table></div>
          <p class="small faint" style="margin-top:6px;">Computed from filed annual statements. ROIC uses NOPAT ≈ operating income × (1 − 21%).</p>
        </div>`;
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

    out.innerHTML = `
      <div class="dos-head">
        <div>
          <h1 class="title-1" style="margin:0;">${esc(d.name || sym)} <span class="faint" style="font-weight:600;">(${esc(sym)})</span><span class="beta-badge">Beta</span></h1>
          <p class="small faint" style="margin:4px 0 0;">${esc([d.sector, d.industry].filter(Boolean).join(' · ') || 'US-listed equity')} · dossier as of fiscal ${esc(d.fyEnd || '')}${d.cached ? '' : ' · freshly built'}</p>
        </div>
        <div class="dos-actions">
          <button class="btn btn-ghost btn-sm" id="dos-print">Print / Save PDF</button>
          <button class="btn btn-quiet btn-sm" id="dos-refresh" title="Rebuild from the latest filings">Refresh</button>
        </div>
      </div>
      <div class="dos-snap">${snap}</div>
      ${d.executiveSummary ? `<div class="dos-sec"><div class="dos-summary">${esc(d.executiveSummary)}</div></div>` : ''}
      ${edge}
      ${industryHtml}
      ${s.description ? `<div class="dos-sec"><h2>The business</h2><p style="max-width:74ch; line-height:1.7;">${esc(s.description)}</p></div>` : ''}
      ${segs}
      ${d.keyFigures ? `<div class="dos-sec"><h2>Key figures</h2>${keyFiguresHtml(d.keyFigures)}</div>` : ''}
      ${read}
      ${competitive}
      ${governanceHtml}
      ${esgHtml}
      ${valuationHtml}
      ${scenarioHtml}
      ${forwardDcfHtml}
      ${bullbear}
      ${risks}
      ${financialHtml}
      ${checks}
      ${recent}
      <div id="dos-thesis"></div>
      <p class="dos-prov">${esc((d.sources && d.sources.note) || 'Every figure is computed from SEC-filed statements; prose is written over those finished facts. Educational, not investment advice.')}</p>`;
    out.hidden = false;

    $('dos-print').addEventListener('click', () => window.print());
    $('dos-refresh').addEventListener('click', () => run(sym, true));
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
        if (r.status === 402) { upsell(out); break; }
        if (r.status === 404) { const e = await r.json().catch(() => ({})); fail(out, e.message || `Couldn’t build a dossier for ${sym}.`); break; }
        if (r.status === 202) { const d = await r.json().catch(() => ({})); setBuilding(out, sym, d.stage, Date.now() - started); await wait(POLL_MS); continue; }
        if (!r.ok) { fail(out, 'Something went wrong building the dossier.'); break; }
        const d = await r.json().catch(() => ({}));
        if (d && d.dossier) { render(out, d.dossier, sym); break; }
        await wait(POLL_MS);
      }
      if (Date.now() - started >= MAX_WAIT_MS && out.querySelector('.loading-line')) {
        out.innerHTML = `<div class="card card-pad"><p style="margin:0;">This dossier is taking longer than usual.</p><button class="btn btn-ghost btn-sm" style="margin-top:10px;" onclick="location.reload()">Try again</button></div>`;
      }
    } finally { running = false; }
  }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  $('dos-form').addEventListener('submit', (e) => { e.preventDefault(); run($('dos-sym').value, false); });

  // Ticker autocomplete — same as the Monitor search: type a symbol or company
  // name, pick from the list, and it builds the dossier at once.
  (function wireAutocomplete() {
    const input = $('dos-sym');
    if (!input || !companies) return;
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
        `<button type="button" data-sym="${esc(c.symbol)}" class="${i === active ? 'is-active' : ''}"><span class="sym">${esc(c.symbol)}</span><span class="nm">${esc(c.name || '')}</span></button>`).join('');
      box.hidden = false;
    };
    const choose = (sym) => { box.hidden = true; items = []; input.value = sym; run(sym, false); };
    input.addEventListener('input', async () => {
      const q = input.value.trim().toUpperCase();
      if (q.length < 1) { box.hidden = true; return; }
      const list = await companies();
      const starts = list.filter((c) => c.symbol && c.symbol.toUpperCase().startsWith(q));
      const names = list.filter((c) => c.symbol && !c.symbol.toUpperCase().startsWith(q) && (c.name || '').toUpperCase().includes(q));
      items = starts.concat(names).slice(0, 8); active = -1; render();
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

  const initial = new URLSearchParams(location.search).get('symbol');
  if (initial) { $('dos-sym').value = initial.toUpperCase(); run(initial, false); }
})();
