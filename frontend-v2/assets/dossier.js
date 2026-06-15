// Research Dossier page — on-demand initiation report on any ticker, plus the
// thesis tracker. Power/Desk feature: a 402 swaps in the upgrade card. The
// build is slow (it composes several grounded surfaces), so the server kicks
// it and returns {status:'building', stage} fast; we poll until it lands.
(function () {
  'use strict';
  const { API, token, esc, money, num, spinner, nav } = window.V2;
  const $ = (id) => document.getElementById(id);
  const auth = () => (token() ? { Authorization: `Bearer ${token()}` } : {});

  const POLL_MS = 6000;
  const MAX_WAIT_MS = 300000; // 5 min — a dossier touches several filings + the model
  const STAGE_LABEL = {
    gathering: 'Gathering the grounded surfaces — financials, segments, valuation, the latest filing…',
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
        <span class="label">✦ Research Dossier — on Power &amp; Desk</span>
        <h2 class="title-2" style="margin:12px 0 8px;">The analyst’s write-up, on demand</h2>
        <p class="muted" style="max-width:64ch;">A from-scratch, source-linked dossier on any US-listed company — business, segments, ten-year figures, what’s priced in, the bull and bear case, and what just changed in the latest filing — plus a thesis tracker that grades your own reasons against every new filing. The work an analyst bills 20–40 hours for, or that a research seat costs five figures a year. Yours unlimited on Power.</p>
        <div style="display:flex; flex-wrap:wrap; gap:12px; margin-top:16px;">
          <a class="btn btn-primary" href="/register.html?plan=power-monthly">Start Power — £49/mo</a>
          <a class="btn btn-ghost" href="/register.html?plan=power">Or £440/yr — save 25%</a>
        </div>
        <p class="small faint" style="margin:12px 0 0;">Desk for RIAs &amp; funds — <a href="/register.html?plan=desk">£1,490/yr →</a></p>
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
          <div class="dos-case" style="border-top:3px solid ${r.severity === 'high' ? 'var(--neg)' : r.severity === 'low' ? 'var(--pos)' : 'var(--accent-ink)'};">
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

    out.innerHTML = `
      <div class="dos-head">
        <div>
          <h1 class="title-1" style="margin:0;">${esc(d.name || sym)} <span class="faint" style="font-weight:600;">(${esc(sym)})</span></h1>
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
      ${s.description ? `<div class="dos-sec"><h2>The business</h2><p style="max-width:74ch; line-height:1.7;">${esc(s.description)}</p></div>` : ''}
      ${segs}
      ${d.keyFigures ? `<div class="dos-sec"><h2>Key figures</h2><div class="dos-keyfig">${esc(d.keyFigures)}</div></div>` : ''}
      ${read}
      ${competitive}
      ${valuationHtml}
      ${bullbear}
      ${risks}
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
  const initial = new URLSearchParams(location.search).get('symbol');
  if (initial) { $('dos-sym').value = initial.toUpperCase(); run(initial, false); }
})();
