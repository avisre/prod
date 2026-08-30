// Filing Change Monitor — client. On-demand "what changed in the latest
// filing" report for any ticker, plus a materiality-ranked feed across the
// user's holdings + watchlist. Pro feature: a 402 swaps in the upgrade card.
(function () {
  const { API, token, esc, markdown, spinner, searchAssets, mountShare, money, mountAskFloor } = window.V2;
  const auth = () => (token() ? { Authorization: 'Bearer ' + token() } : {});
  const $ = (id) => document.getElementById(id);
  const MODE_KEY = 'sp_monitor_mode_v1';
  let RAW_REPORT = null;
  // See dossier.js: mountAskFloor appends to document.body, and renderReport()
  // re-runs on every poll -> build -> rerender cycle, so guard the mount.
  let askMounted = false;

  function renderFundRedirect(rep) {
    const out = $('mon-report');
    const p = rep.profile || {};
    out.innerHTML = `<div class="card card-pad mon-card">
      <span class="label">${esc(rep.symbol)} · ${esc(rep.assetTypeLabel || 'Fund')}</span>
      <h2 class="title-2" style="margin:8px 0;">This instrument does not file 10-K or 10-Q reports</h2>
      <p class="muted" style="max-width:62ch;">Filing Monitor is intentionally SEC-only. Use the fund workspace for costs, holdings and performance, or Ask for a source-aware comparison.</p>
      <div style="display:flex; flex-wrap:wrap; gap:10px; margin-top:18px;">
        <a class="btn btn-primary" href="/company.html?symbol=${encodeURIComponent(rep.symbol)}">Open fund workspace</a>
        <a class="btn btn-ghost" href="/ask.html?q=${encodeURIComponent(`Research ${rep.symbol}`)}">Ask about ${esc(rep.symbol)}</a>
      </div>
    </div>`;
    out.hidden = false;
  }

  function chip(bucket, score) {
    const cls = bucket === 'high' ? 'mon-chip-high' : bucket === 'medium' ? 'mon-chip-med' : 'mon-chip-low';
    const label = bucket === 'high' ? 'High materiality' : bucket === 'medium' ? 'Worth a look' : 'Low impact';
    return `<span class="mon-chip ${cls}">${label} · ${esc(String(score))}</span>`;
  }

  const TONE = { improving: ['Improving', 'mon-tone-up'], deteriorating: ['Deteriorating', 'mon-tone-down'], stable: ['Stable', 'mon-tone-flat'] };

  function deltaNumber(d) {
    const n = parseFloat(String((d && d.change) || '').replace(/[^0-9+\-.]/g, ''));
    return Number.isFinite(n) ? n : 0;
  }

  function displayNumber(value) {
    const s = String(value == null ? '' : value).replace(/,/g, '').trim();
    const m = s.match(/[-+]?\d*\.?\d+/);
    if (!m) return 0;
    let n = Number(m[0]);
    if (!Number.isFinite(n)) return 0;
    if (/\bT\b/i.test(s) || /\dT(?:\s|$)/i.test(s)) n *= 1e12;
    else if (/\bB\b/i.test(s) || /\dB(?:\s|$)/i.test(s)) n *= 1e9;
    else if (/\bM\b/i.test(s) || /\dM(?:\s|$)/i.test(s)) n *= 1e6;
    else if (/\bK\b/i.test(s) || /\dK(?:\s|$)/i.test(s)) n *= 1e3;
    return n;
  }

  function metricBars(d) {
    const prior = displayNumber(d.prior), latest = displayNumber(d.latest);
    const max = Math.max(Math.abs(prior), Math.abs(latest), 1);
    const row = (label, shown, value, latestRow) => `<div class="mon-bar-line ${latestRow ? 'is-latest' : ''} ${value < 0 ? 'is-negative' : ''}">
      <span>${label}</span><span class="mon-metric-track"><i class="mon-metric-fill" style="width:${Math.max(3, Math.abs(value) / max * 100).toFixed(1)}%"></i></span><b>${esc(shown)}</b>
    </div>`;
    return `<div class="mon-bar-pair">${row('Prior', d.prior, prior, false)}${row('Latest', d.latest, latest, true)}</div>`;
  }

  function deltaRows(deltas) {
    return (deltas || []).map((d) => {
      const dir = d.direction === 'up' ? 'mon-up' : d.direction === 'down' ? 'mon-down' : 'mon-flat';
      return `<div class="mon-delta-row">
        <div class="mon-delta-head"><strong>${esc(d.label)}</strong><span class="${dir}">${esc(d.change)}</span></div>
        ${metricBars(d)}
      </div>`;
    }).join('');
  }

  function numericReadings(deltas) {
    const all = deltas || [];
    if (!all.length) return '<li data-n="01">No comparable filed-period figures were available.</li>';
    const find = (label) => all.find((d) => d.label === label);
    const rev = find('Revenue'), opm = find('Operating margin'), nm = find('Net margin');
    const ni = find('Net income'), fcf = find('Free cash flow'), eps = find('Diluted EPS');
    const lines = [];
    if (rev && opm) {
      const bothUp = rev.direction === 'up' && opm.direction === 'up';
      const tension = rev.direction === 'up' && opm.direction === 'down';
      lines.push(`${bothUp ? '<strong>Operating leverage improved:</strong>' : tension ? '<strong>Growth and profitability diverged:</strong>' : '<strong>Revenue and margin moved together:</strong>'} revenue went from ${esc(rev.prior)} to ${esc(rev.latest)} (${esc(rev.change)}), while operating margin went from ${esc(opm.prior)} to ${esc(opm.latest)} (${esc(opm.change)}).`);
    } else if (rev) lines.push(`<strong>Revenue</strong> moved from ${esc(rev.prior)} to ${esc(rev.latest)} (${esc(rev.change)}).`);
    if (ni && fcf) {
      const same = ni.direction === fcf.direction;
      lines.push(`${same ? '<strong>Earnings and cash confirmed each other:</strong>' : '<strong>Earnings and cash diverged:</strong>'} net income moved from ${esc(ni.prior)} to ${esc(ni.latest)} (${esc(ni.change)}), while free cash flow moved from ${esc(fcf.prior)} to ${esc(fcf.latest)} (${esc(fcf.change)}).`);
    }
    if (eps) lines.push(`<strong>Per-share earnings</strong> moved from ${esc(eps.prior)} to ${esc(eps.latest)} (${esc(eps.change)}); compare that direction with net income to detect whether share-count changes affected the per-share result.`);
    if (nm && opm && nm.direction !== opm.direction) lines.push(`<strong>Margin quality needs explanation:</strong> operating margin changed ${esc(opm.change)}, but net margin changed ${esc(nm.change)}, pointing to factors below operating income.`);
    const largest = all.slice().sort((a, b) => Math.abs(deltaNumber(b)) - Math.abs(deltaNumber(a)))[0];
    if (largest) lines.push(`<strong>Base-effect caution:</strong> ${esc(largest.label)} has the largest percentage or point move (${esc(largest.change)}), measured from ${esc(largest.prior)}; the absolute starting base matters when judging its persistence.`);
    return lines.slice(0, 4).map((line, i) => `<li data-n="${String(i + 1).padStart(2, '0')}">${line}</li>`).join('');
  }

  function materialityHtml(rep) {
    const b = rep.materialityBreakdown || {};
    const rows = [
      ['Numbers', Number(b.numbers || 0)],
      ['Language', Number(b.language || 0)],
      ['Risk', Number(b.risk || 0)]
    ];
    return `<div class="mon-materiality-layout">
      <div class="mon-score-ring" style="--score:${Math.max(0, Math.min(100, Number(rep.materiality || 0)))}"><div><strong>${esc(String(rep.materiality || 0))}</strong><span>out of 100</span></div></div>
      <div class="mon-score-breakdown">${rows.map(([label, value]) => `<div class="mon-score-line"><span>${label}</span><span class="mon-score-track"><i style="width:${Math.max(2, Math.min(100, value))}%"></i></span><b>${value}</b></div>`).join('')}
        <span class="small faint">${chip(rep.materialityBucket, rep.materiality)}</span>
      </div>
    </div>`;
  }

  function filingEvidenceHtml(narr) {
    const changes = (narr && narr.changes) || [];
    if (!changes.length) return '';
    // Three states, not two. A point is only quotable on both sides when both
    // filings actually say it; often only the new filing does, and showing that
    // one verified passage beats printing an apology. Every quote here has been
    // matched character-for-character against the filing it is attributed to.
    const withEvidence = changes.filter((c) => c.newQuote || (c.evidenceVerified && c.priorQuote));
    const quotes = changes.map((c) => {
      const paired = !!(c.evidenceVerified && c.priorQuote && c.newQuote);
      const newOnly = !paired && !!c.newQuote;
      let bodyHtml;
      if (paired) {
        bodyHtml = `<div class="mon-quote-pair">
          <div class="mon-quote-side"><b>Prior filing</b><q>${esc(c.priorQuote)}</q></div>
          <span class="mon-quote-sep" aria-hidden="true">→</span>
          <div class="mon-quote-side"><b>New filing</b><q>${esc(c.newQuote)}</q></div>
        </div>`;
      } else if (newOnly) {
        bodyHtml = `<div class="mon-quote-single">
          <div class="mon-quote-side"><b>New filing</b><q>${esc(c.newQuote)}</q></div>
        </div>`;
      } else {
        bodyHtml = '<div class="mon-no-quote">Neither filing states this point in a single quotable passage — see the summary alongside.</div>';
      }
      const tag = paired ? 'Verified passages' : newOnly ? 'Verified passage' : '';
      return `<div class="mon-language-item">
        <div class="mon-language-area"><strong>${esc(c.area)}</strong>${tag ? `<span class="mon-verified">${tag}</span>` : ''}</div>
        ${bodyHtml}
      </div>`;
    }).join('');
    const explanations = changes.map((c) => `<div class="mon-explain-item"><strong>${esc(c.area)}</strong><p>${esc(c.what)}</p></div>`).join('');
    return `<div class="mon-evidence-block">
      <div class="mon-evidence-title"><div><span class="mon-section-label">Narrative evidence</span><h3>What management changed in the filing</h3></div>${TONE[narr.tone] ? `<span class="mon-tone ${TONE[narr.tone][1]}">${TONE[narr.tone][0]}</span>` : ''}</div>
      ${narr.headline ? `<p class="mon-headline">${esc(narr.headline)}</p>` : ''}
      ${withEvidence.length ? `<div class="mon-evidence-grid">
        <section><span class="mon-section-label">${changes.some((c) => c.evidenceVerified) ? 'Before → after · SEC text' : 'Quoted SEC text'}</span><div class="mon-language-list">${quotes}</div></section>
        <section><span class="mon-section-label">What the difference means</span><div class="mon-change-explain">${explanations}</div></section>
      </div>` : `<div class="mon-evidence-grid is-single">
        <section><span class="mon-section-label">What the difference means</span><div class="mon-change-explain">${explanations}</div></section>
      </div>`}
      ${narr.latest && narr.prev ? `<p class="small faint" style="margin-top:12px;">Compared <a href="${esc(narr.latest.url)}" target="_blank" rel="noopener">new ${esc(narr.latest.form)} (${esc(narr.latest.date)})</a> against <a href="${esc(narr.prev.url)}" target="_blank" rel="noopener">prior ${esc(narr.prev.form)} (${esc(narr.prev.date)})</a>. Every quotation shown was matched character-for-character against the filing it is attributed to.</p>` : ''}
    </div>`;
  }

  function researchProse(text) {
    const raw = String(text || '').trim();
    if (!raw) return '';
    if (/\n|^[-*#]/m.test(raw)) return markdown(raw);
    const sentences = raw.split(/(?<=[.!?])\s+(?=[A-Z])/).filter(Boolean);
    return sentences.map((sentence) => `<p>${esc(sentence)}</p>`).join('');
  }

  // Turn a filing read into a concrete research workflow. These are investigation
  // steps, not trading instructions: the user gets the signal, the next question
  // and the exact filed metric to watch on the next report.
  function workflowHtml(rep) {
    const changes = (rep.narrative && rep.narrative.changes) || [];
    const deltas = (rep.deltas || []).slice().sort((a, b) => Math.abs(deltaNumber(b)) - Math.abs(deltaNumber(a)));
    const strongest = deltas[0];
    const tone = (rep.narrative && rep.narrative.tone) || 'stable';
    const questions = [];
    if (changes[0]) questions.push(`What evidence supports the change in ${changes[0].area || 'management’s outlook'}, and what could reverse it?`);
    if (changes[1]) questions.push(`How material is the ${changes[1].area || 'filing'} change compared with the prior filing?`);
    if (strongest) questions.push(`Is the ${strongest.label.toLowerCase()} move durable, seasonal, or driven by a one-off item?`);
    const revenue = deltas.find((d) => d.label === 'Revenue');
    if (revenue) questions.push(`What drove revenue to ${revenue.latest}, and did growth come with better or worse cash conversion?`);
    questions.push(`What would disprove the current ${tone} read in the next filing?`);
    const unique = [...new Set(questions)].slice(0, 3);
    const watches = deltas.slice(0, 3).map((d) => {
      const verb = d.direction === 'up' ? 'holds or accelerates' : d.direction === 'down' ? 'stabilises or reverses' : 'moves materially';
      return `<li><strong>${esc(d.label)}</strong><span>Now ${esc(d.latest)} (${esc(d.change)} YoY). Check whether it ${verb} in the next comparable period.</span></li>`;
    }).join('');
    const queryButtons = unique.map((q) => `<a class="mon-question" href="/ask.html?q=${encodeURIComponent(`${rep.symbol}: ${q}`)}"><span>${esc(q)}</span><b>Ask →</b></a>`).join('');
    return `<section class="mon-workflow">
      <div class="mon-section-hd"><div><span class="mon-kicker">Investor workflow</span><h3>Turn this filing into your next three checks</h3></div><span class="small faint">Questions are pre-filled in Ask</span></div>
      <div class="mon-workflow-grid">
        <div class="mon-workflow-block"><h4>Investigate now</h4><div class="mon-questions">${queryButtons}</div></div>
        <div class="mon-workflow-block"><h4>Watch next quarter</h4><ol class="mon-watch-list">${watches || '<li><span>No comparable quarterly deltas were available. Track the narrative changes instead.</span></li>'}</ol></div>
      </div>
    </section>`;
  }

  function renderReport(rep) {
    // See dossier.js: mounted before the fund branch so funds get the bar, with
    // the fund wording — renderFundRedirect's own copy tells people ETFs and
    // mutual funds belong in Ask, so that state needs the bar most of all.
    if (!askMounted && mountAskFloor && rep && rep.symbol) {
      askMounted = true;
      mountAskFloor({ placeholder: rep.isFund
        ? `Ask about ${rep.symbol} — fees, holdings, allocation, performance and risk…  (⌘K)`
        : `Ask about what changed in ${rep.symbol}'s latest filing…  (⌘K)` });
    }
    if (rep && rep.isFund) { renderFundRedirect(rep); return; }
    RAW_REPORT = rep;
    const mode = window.PV.getMode(MODE_KEY);
    if (mode === 'normal') { renderNormal(rep); return; }
    renderAnalyst(rep, mode);
  }

  // Today's report render, unchanged — Analyst mode stays byte-identical.
  function renderAnalyst(rep, mode) {
    const out = $('mon-report');
    const filing = rep.periodic || rep.latestFiling || {};
    const latest = rep.latestFiling || {};
    const deltas = rep.deltas || [];
    const narr = rep.narrative;
    const comparisonText = narr && narr.latest && narr.prev
      ? `${narr.latest.form} ${narr.latest.date} vs ${narr.prev.form} ${narr.prev.date}`
      : `${filing.form || 'filing'} filed ${filing.date || ''}`;
    const hasSeparateEvent = latest.url && filing.url && (latest.form !== filing.form || latest.date !== filing.date);

    const ueRep = rep.unitEconomics;
    const unitEconHtml = ueRep && Array.isArray(ueRep.metrics) && ueRep.metrics.length ? `
      <div class="mon-evidence-block">
        <div class="mon-evidence-title"><div><span class="mon-section-label">Unit economics</span><h3>${esc(ueRep.unitLabel || 'Unit')} · fiscal ${esc(ueRep.fiscalYear || '')}</h3></div></div>
        <div class="mon-delta-list">${ueRep.metrics.map((m) => `<div class="mon-delta-row"><div class="mon-delta-head"><strong>${esc(m.name || 'Metric')}</strong><span>${m.value != null ? money(m.value) + (m.unit && !/^(count|units?|#)$/i.test(String(m.unit).trim()) ? ' ' + esc(m.unit) : '') : '—'}</span></div>${m.period ? `<p class="small faint" style="margin:2px 0 0;">${esc(m.period)}</p>` : ''}</div>`).join('')}</div>
        ${(ueRep.derived && ueRep.derived.note) || ueRep.note ? `<p class="small faint" style="margin-top:6px;">${esc((ueRep.derived && ueRep.derived.note) || ueRep.note)}</p>` : ''}
      </div>` : '';

    out.innerHTML = `
      <div class="card card-pad mon-card mon-card-v2">
        <div class="mon-card-hd">
          <div>
            <span class="label">${esc(rep.symbol)} · Filing Change Monitor</span>
            <h2 class="title-2" style="margin:5px 0 0;">What changed in the ${esc(filing.label || filing.form || 'latest comparable filing')}</h2>
            <div class="mon-report-meta"><span class="mon-comparison-badge">Comparing ${esc(comparisonText)}</span><span>Figures: ${esc(rep.reportedPeriod || 'latest period')} vs ${esc(rep.priorPeriod || 'comparable prior period')}</span></div>
          </div>
          <div class="mon-mode-toggle">${window.PV.modeChips('mon', mode)}</div>
          ${filing.url ? `<a class="btn btn-ghost btn-sm" href="${esc(filing.url)}" target="_blank" rel="noopener">Open comparison filing ↗</a>` : ''}
        </div>

        <div class="mon-decision-grid">
          <section><span class="mon-section-label">Materiality</span>${materialityHtml(rep)}</section>
          <section><span class="mon-section-label">The 30-second read</span><div class="prose mon-brief-copy">${researchProse(rep.summary || '')}</div></section>
        </div>

        ${deltas.length ? `<div class="mon-evidence-block">
          <div class="mon-evidence-title"><div><span class="mon-section-label">Filed numbers</span><h3>Before and after, on comparable periods</h3></div><span class="small faint">${esc(rep.currency || '')} · no model arithmetic</span></div>
          <div class="mon-evidence-grid">
            <section><span class="mon-section-label">Prior → latest</span><div class="mon-delta-list">${deltaRows(deltas)}</div></section>
            <section><span class="mon-section-label">What moved most</span><ol class="mon-reading-list">${numericReadings(deltas)}</ol></section>
          </div>
        </div>` : ''}
        ${unitEconHtml}

        ${narr ? filingEvidenceHtml(narr) : rep.narrativeNote ? `<div class="mon-section"><p class="small faint">${esc(rep.narrativeNote)}</p></div>` : ''}
        ${hasSeparateEvent ? `<div class="mon-event-strip"><div><strong>Newer event filing kept separate</strong><p>${esc(latest.label || latest.form)} filed ${esc(latest.date)} is newer than the periodic comparison above; it is not being presented as the same analysis.</p></div><a class="btn btn-ghost btn-sm" href="${esc(latest.url)}" target="_blank" rel="noopener">Open ${esc(latest.form)} ↗</a></div>` : ''}
        ${workflowHtml(rep)}

        <div class="mon-next-actions">
          <button class="btn btn-primary btn-sm" type="button" id="mon-track">Track ${esc(rep.symbol)}</button>
          <a class="btn btn-ghost btn-sm" href="/dossier.html?symbol=${encodeURIComponent(rep.symbol)}#dos-thesis">Build &amp; grade my thesis</a>
          <a class="btn btn-ghost btn-sm" href="/company.html?symbol=${encodeURIComponent(rep.symbol)}#statements-section">Open financial record</a>
          ${filing.url ? `<a class="btn btn-ghost btn-sm" href="${esc(filing.url)}" target="_blank" rel="noopener">Open SEC filing ↗</a>` : ''}
        </div>
        <p class="small faint mon-note">${esc(rep.note || '')}</p>
      </div>`;
    const share = document.createElement('div');
    mountShare(share, { title: `${rep.symbol} filing change brief`, text: [rep.summary, narr && narr.headline].filter(Boolean).join('\n\n') });
    const card = out.querySelector('.mon-card');
    if (card) card.appendChild(share);
    $('mon-mode-normal').addEventListener('click', () => { localStorage.setItem(MODE_KEY, 'normal'); renderReport(RAW_REPORT); });
    $('mon-mode-analyst').addEventListener('click', () => { localStorage.setItem(MODE_KEY, 'analyst'); renderReport(RAW_REPORT); });
    const track = $('mon-track');
    if (track) track.addEventListener('click', async () => {
      if (!token()) { location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`; return; }
      track.disabled = true; track.textContent = 'Adding to watchlist…';
      try {
        const r = await fetch(`${API}/watchlist/${encodeURIComponent(rep.symbol)}`, { method: 'POST', headers: auth() });
        track.textContent = r.ok ? `✓ Tracking ${rep.symbol}` : 'Could not add — try again';
      } catch (_) { track.textContent = 'Could not add — try again'; }
      finally { track.disabled = false; }
    });
    out.hidden = false;
  }

  // Normal mode — same materiality score and deltas, read visually: a gauge
  // relabelled in plain terms, delta cards (unit-economics delta first, since
  // filing-monitor.js already unshifts it), and was/now narrative cards. All
  // from fields the Analyst render already uses — nothing recomputed here.
  function renderNormal(rep) {
    const PV = window.PV;
    const out = $('mon-report');
    const filing = rep.periodic || rep.latestFiling || {};
    const deltas = rep.deltas || [];
    const narr = rep.narrative;
    const bucket = rep.materialityBucket;
    const gaugeLabel = bucket === 'high' ? 'Big change' : bucket === 'medium' ? 'Some change' : 'Routine';

    const deltaCards = deltas.map((d) => {
      const dir = d.direction === 'up' ? 'mon-up' : d.direction === 'down' ? 'mon-down' : 'mon-flat';
      return `<div class="pv-card">
        <div class="mon-delta-head"><strong>${esc(d.label)}</strong><span class="${dir}">${esc(d.change)}</span></div>
        ${metricBars(d)}
      </div>`;
    }).join('');

    const changes = (narr && narr.changes) || [];
    const narrCards = changes.map((c) => {
      const paired = c.evidenceVerified && c.priorQuote && c.newQuote;
      return `<div class="pv-card">
        <strong>${esc(c.area)}</strong>
        <p>${esc(c.what)}</p>
        ${paired ? `<div class="mon-quote-pair"><div class="mon-quote-side"><b>Was</b><q>${esc(c.priorQuote)}</q></div><span class="mon-quote-sep" aria-hidden="true">→</span><div class="mon-quote-side"><b>Now</b><q>${esc(c.newQuote)}</q></div></div>` : ''}
      </div>`;
    }).join('');

    const ue = rep.unitEconomics;
    const unitFallbackHtml = (!rep.unitDeltaIncluded && ue && Array.isArray(ue.metrics) && ue.metrics.length) ? `
      <div class="pv-card">
        <h2>Its ${esc(ue.unitLabel || 'units')} this filing</h2>
        <ul style="padding-left:18px; margin:0;">${ue.metrics.slice(0, 4).map((m) => {
      const val = m.value != null ? money(m.value) : '—';
      const unitSuffix = m.unit && !/^(count|units?|#)$/i.test(String(m.unit).trim()) ? ' ' + esc(m.unit) : '';
      return `<li><b>${esc(m.name || 'Metric')}</b>: ${val}${unitSuffix}${m.period ? ` <span class="small faint">(${esc(m.period)})</span>` : ''}</li>`;
    }).join('')}</ul>
        <p class="small faint" style="margin-top:8px;">${esc((ue.derived && ue.derived.note) || ue.note || 'This filing did not state a prior-year figure to compare against.')}</p>
      </div>` : '';

    out.innerHTML = `
      <div class="card card-pad mon-card mon-card-v2">
        <div class="mon-card-hd">
          <div>
            <span class="label">${esc(rep.symbol)} · Filing Change Monitor</span>
            <h2 class="title-2" style="margin:5px 0 0;">What changed in the ${esc(filing.label || filing.form || 'latest comparable filing')}</h2>
          </div>
          <div class="mon-mode-toggle">${PV.modeChips('mon', 'normal')}</div>
        </div>

        <div class="pv-card">
          <h2>Does this filing matter? <span class="small faint">${esc(gaugeLabel)}</span></h2>
          <div class="mon-decision-grid" style="margin-top:8px;">
            <div class="mon-score-ring is-label" style="--score:${Math.max(0, Math.min(100, Number(rep.materiality || 0)))}"><div><strong>${esc(gaugeLabel)}</strong></div></div>
            <div class="prose mon-brief-copy">${researchProse(rep.summaryPlain || rep.summary || '')}</div>
          </div>
        </div>

        ${deltaCards ? `<h2 style="margin:22px 0 4px;">Before → after</h2>${deltaCards}` : ''}
        ${unitFallbackHtml}
        ${narrCards ? `<h2 style="margin:22px 0 4px;">What the words changed</h2>${narrCards}` : ''}

        <div class="mon-next-actions" style="margin-top:20px;">
          <button class="btn btn-primary btn-sm" type="button" id="mon-track">Track ${esc(rep.symbol)}</button>
          <a class="btn btn-ghost btn-sm" href="/dossier.html?symbol=${encodeURIComponent(rep.symbol)}#dos-thesis">Build &amp; grade my thesis</a>
        </div>

        <details class="dos-module" style="margin-top:16px;"><summary><span><strong>Show the analyst brief</strong><small>Full evidence, workflow and filed-numbers detail</small></span><span class="dos-module-action">View</span></summary>
          <div class="dos-module-body"><button class="btn btn-ghost btn-sm" id="mon-show-analyst">Switch to Analyst mode →</button></div>
        </details>
      </div>`;
    const share = document.createElement('div');
    mountShare(share, { title: `${rep.symbol} filing change brief`, text: [rep.summaryPlain || rep.summary, narr && narr.headline].filter(Boolean).join('\n\n') });
    const card = out.querySelector('.mon-card');
    if (card) card.appendChild(share);
    $('mon-mode-normal').addEventListener('click', () => { localStorage.setItem(MODE_KEY, 'normal'); renderReport(RAW_REPORT); });
    $('mon-mode-analyst').addEventListener('click', () => { localStorage.setItem(MODE_KEY, 'analyst'); renderReport(RAW_REPORT); });
    $('mon-show-analyst').addEventListener('click', () => { localStorage.setItem(MODE_KEY, 'analyst'); renderReport(RAW_REPORT); });
    const track = $('mon-track');
    if (track) track.addEventListener('click', async () => {
      if (!token()) { location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`; return; }
      track.disabled = true; track.textContent = 'Adding to watchlist…';
      try {
        const r = await fetch(`${API}/watchlist/${encodeURIComponent(rep.symbol)}`, { method: 'POST', headers: auth() });
        track.textContent = r.ok ? `✓ Tracking ${rep.symbol}` : 'Could not add — try again';
      } catch (_) { track.textContent = 'Could not add — try again'; }
      finally { track.disabled = false; }
    });
    out.hidden = false;
  }

  function upsell(out) {
    out.innerHTML = `
      <div class="card card-pad mon-upsell">
        <span class="mon-summary-badge">Power &amp; Desk feature</span>
        <h2 class="title-2" style="margin:12px 0 8px;">The Filing Monitor is on Power &amp; Desk</h2>
        <p class="muted" style="max-width:62ch;">Get a cited first pass over material changes in a supported company's latest available 10-K, 10-Q or 8-K — including available year-over-year figures and changes in guidance, risk and demand language — plus a ranked feed across your watchlist.</p>
        <div style="display:flex; flex-wrap:wrap; gap:12px; margin-top:16px;">
          <a class="btn btn-primary" href="/register.html?plan=desk">Get Desk — $1,961/yr</a>
          <a class="btn btn-ghost" href="/register.html?plan=power">Power — $579/yr</a>
        </div>
      </div>`;
    out.hidden = false;
  }

  // After a free-trial report, show how many are left and nudge to upgrade.
  // Power/Desk skip the server limiter, so these headers are absent for them —
  // no banner, no nag for paying users. The report is already rendered; we
  // prepend the note above it.
  function maybeShowTrialCounter(r) {
    const remRaw = r.headers.get('ratelimit-remaining');
    const limRaw = r.headers.get('ratelimit-limit');
    if (remRaw === null || limRaw === null) return; // no free-trial stock counter (Power/Desk)
    const remaining = parseInt(remRaw, 10);
    const limit = parseInt(limRaw, 10);
    if (!Number.isFinite(remaining) || !Number.isFinite(limit)) return;
    // Two limiters emit ratelimit-* headers: the small per-day trial gate
    // (free / no-login) and a 900/window global abuse limiter that also applies
    // to Power/Desk. Only the trial gate drives this counter — if the limit is
    // the large global one, the user is entitled (trial skipped); show nothing.
    if (limit > 10) return;
    const msg = remaining > 0
      ? `<strong>${remaining} of ${limit} free stock${remaining === 1 ? '' : 's'} left today.</strong> <span class="faint">Re-runs of a stock you’ve already opened stay free. Power removes the free per-stock trial counter and adds the watchlist workflow.</span>`
      : `<strong>That’s your ${limit} free stocks for today.</strong> <span class="faint">Power removes the free per-stock trial counter and adds filing-change research across your watchlist.</span>`;
    const banner = document.createElement('div');
    banner.className = 'card card-pad mon-trial-note';
    banner.style.cssText = 'margin-bottom:14px; display:flex; flex-wrap:wrap; align-items:center; gap:10px 16px; justify-content:space-between;';
    banner.innerHTML = `<div class="small" style="max-width:58ch; margin:0;">${msg}</div>
      <div style="flex-shrink:0;">
        <a class="btn btn-primary btn-sm" href="/register.html?plan=power-monthly">Get Power — $64/mo</a>
      </div>`;
    const out = $('mon-report');
    out.insertBefore(banner, out.firstChild);
  }

  // The free no-login trial is spent for the day — convert rather than dead-end.
  function trialWall(out) {
    out.innerHTML = `
      <div class="card card-pad mon-upsell">
        <span class="mon-summary-badge">The Filing Monitor — Power &amp; Desk</span>
        <h2 class="title-2" style="margin:12px 0 8px;">You’ve used today’s 3 free stocks</h2>
        <p class="muted" style="max-width:62ch;">Power gives you a cited first pass over material changes in supported 10-K, 10-Q and 8-K filings, with available numerical and narrative changes ranked by materiality and an updating feed across your watchlist.</p>
        <div style="display:flex; flex-wrap:wrap; gap:12px; margin-top:16px;">
          <a class="btn btn-primary" href="/register.html?plan=power-monthly">Start Power — $64/mo</a>
          <a class="btn btn-ghost" href="/register.html?plan=power">Or $579/yr — save 25%</a>
        </div>
        <p class="small faint" style="margin:12px 0 0;">Founding rate — locked for as long as you stay subscribed. Desk for RIAs &amp; funds — <a href="/register.html?plan=desk">$1,961/yr →</a></p>
      </div>`;
    out.hidden = false;
  }

  // A cold read of a large filing (e.g. Berkshire's 10-K) can take a couple of
  // minutes. The server kicks the build and returns {status:'building', stage}
  // fast; we poll until the report lands, showing WHAT it's doing at each step
  // instead of a mute spinner the user gives up on (and a specific, useful card
  // when something actually fails).
  const POLL_MS = 6000;
  const MAX_WAIT_MS = 240000; // 4 min before we hand back a manual retry

  const STAGE_LABEL = {
    finding: 'Locating the latest filing on SEC EDGAR…',
    reading: 'Reading the filing and the year-ago period — a large 10-K can take a couple of minutes…',
    summarizing: 'Writing the what-changed brief…'
  };

  function setBuilding(out, sym, stage, elapsedMs) {
    const base = STAGE_LABEL[stage] || ('Reading ' + sym + '’s latest filing & the prior quarter…');
    const hint = elapsedMs > 45000
      ? 'Still going — big filings take longer. This loads the moment it’s ready; no need to refresh, and you won’t lose the work if you wait.'
      : 'This loads the moment it’s ready — no need to refresh.';
    out.innerHTML = `<div class="card card-pad">${spinner(base)}<p class="small faint" style="margin:10px 0 0;">${esc(hint)}</p></div>`;
  }

  // The wallet wall, distinct from the tier upsell: the server's 402 carries
  // code CREDITS_REQUIRED when a Power/Desk user's monthly balance is spent
  // (the tier they hold is right; the wallet is what's empty). Pitching the
  // plan they already own would be the wrong diagnosis.
  function creditsWall(out, d) {
    const c = (d && d.credits) || {};
    const needed = Number(c.needed) || 5;
    const remaining = Number(c.remaining) || 0;
    const reset = (window.V2 && window.V2.formatReset) ? window.V2.formatReset(c.resetsAt) : '';
    out.innerHTML = `<div class="card card-pad">
      <span class="label">Out of credits</span>
      <h3 class="title-3" style="margin:12px 0 8px;">Your wallet is empty this month</h3>
      <p class="small faint" style="max-width:64ch; margin:0 0 4px;">A Monitor report costs ${needed} credits — you have ${remaining} left this month.${reset ? ` ${esc(reset)} — your plan's allowance comes back on its own.` : ''}</p>
      <div style="display:flex; flex-wrap:wrap; gap:12px; margin-top:14px;">
        <a class="btn btn-primary" href="/recharge.html">Recharge 150 credits — $9</a>
        <a class="btn btn-ghost" href="/profile.html#usage-details">See this month's usage →</a>
      </div>
    </div>`;
  }

  // Detailed, specific failure cards so the user always knows what happened and
  // what to do next — never a bare "could not analyze".
  function monFail(out, sym, kind, detail) {
    const CARD = {
      notfound: ['No SEC filings for ' + sym,
        'The Monitor covers <strong>US exchange-listed companies that file with the SEC</strong> (10-K, 10-Q, 8-K). Foreign listings, ETFs and funds won’t have filings here. Check the ticker, or pick a US company from the search above.'],
      sec: ['SEC EDGAR didn’t respond',
        'The SEC’s filing system (EDGAR) is slow or briefly unavailable right now — that’s on their side, not yours. Give it a few seconds and try again.'],
      slow: ['Still reading a large filing',
        sym + '’s filing is large and it’s taking longer than usual. It’s still being prepared in the background — keep this tab open, or try again in a moment and it’ll come straight back (the work isn’t lost).'],
      invalid: ['That doesn’t look like a ticker',
        'Enter a stock symbol — e.g. <strong>NVDA</strong> — and pick from the suggestions as you type.'],
      offline: ['You appear to be offline',
        'We couldn’t reach the server. Check your connection and try again.'],
      generic: ['Couldn’t analyse that filing', esc(detail || 'Something went wrong on our side while building the report. Please try again.')]
    };
    const [title, body] = CARD[kind] || CARD.generic;
    out.innerHTML = `<div class="card card-pad">
      <h3 class="title-3" style="margin:0 0 6px;">${esc(title)}</h3>
      <p class="small faint" style="max-width:64ch; margin:0;">${body}</p>
      <button class="btn btn-ghost btn-sm" type="button" id="mon-retry" style="margin-top:14px;">Try ${esc(sym)} again</button>
    </div>`;
    const btn = $('mon-retry');
    if (btn) btn.addEventListener('click', () => analyze(sym));
  }

  function classifyErr(msg) {
    const m = String(msg || '').toLowerCase();
    if (/no sec filings|exchange-listed|we cover|could ?n.t find|no filings found/.test(m)) return 'notfound';
    if (/edgar|reach.*sec|sec.*(unavailable|slow|respond)/.test(m)) return 'sec';
    if (/invalid ticker|not a (valid )?ticker|doesn.t look/.test(m)) return 'invalid';
    return 'generic';
  }

  async function analyze(sym) {
    sym = String(sym || '').toUpperCase().trim();
    if (!sym) return;
    const out = $('mon-report');
    out.hidden = false;
    setBuilding(out, sym, null, 0);
    try { history.replaceState(null, '', '?symbol=' + encodeURIComponent(sym)); } catch (_) {}

    const started = Date.now();
    let first = true;        // the first call starts the build + counts the free-stock
    let countedResp = null;  // hold the credit-counting response for the footer counter

    const reqOnce = async (poll) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 45000);
      try {
        return await fetch(`${API}/filings/${encodeURIComponent(sym)}/report${poll ? '?poll=1' : ''}`,
          { headers: auth(), signal: ctrl.signal });
      } finally { clearTimeout(t); }
    };

    while (true) {
      let r;
      try {
        r = await reqOnce(!first);
      } catch (_) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) { monFail(out, sym, 'offline'); return; }
        if (Date.now() - started > MAX_WAIT_MS) { monFail(out, sym, 'slow'); return; }
        first = false;
        await new Promise((res) => setTimeout(res, POLL_MS));
        continue;
      }
      if (r.status === 429) { trialWall(out); return; } // free stocks spent for the day
      if (r.status === 402) {
        // The server code says which 402 this is: MONITOR_REQUIRED = tier
        // gate (the upgrade card is right); CREDITS_REQUIRED = wallet empty.
        const d = await r.json().catch(() => ({}));
        if (d && d.code === 'CREDITS_REQUIRED') { creditsWall(out, d); return; }
        upsell(out); return;                              // logged-in, needs Power/Desk
      }
      if (first) countedResp = r;                        // the counted (non-poll) response
      let d = null;
      try { d = await r.json(); } catch (_) { d = null; }
      if (r.status === 202) {                            // still building — show the stage, poll on
        if (Date.now() - started > MAX_WAIT_MS) { monFail(out, sym, 'slow'); return; }
        setBuilding(out, sym, d && d.stage, Date.now() - started);
        first = false;
        await new Promise((res) => setTimeout(res, POLL_MS));
        continue;
      }
      if (!r.ok || !d || !d.report) {
        const message = d && (d.message || d.error);
        const kind = r.status === 422 ? 'notfound' : classifyErr(message);
        monFail(out, sym, kind, kind === 'generic' ? message : null);
        return;
      }
      renderReport(d.report);
      maybeShowTrialCounter(countedResp || r);
      return;
    }
  }

  function pick(sym) {
    $('mon-input').value = sym;
    analyze(sym);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }

  // Ticker autocomplete on the monitor input is deliberately stock-only.
  // Fund research remains available in Ask and the instrument workspace.
  function wireAutocomplete() {
    const input = $('mon-input');
    if (!input || !searchAssets) return;
    // wrap so the dropdown anchors to the input (the form is a flex row)
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
    const choose = (sym) => { box.hidden = true; items = []; pick(sym); };
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
  }

  async function loadFeed() {
    if (!token()) return;
    const wrap = $('mon-feed-wrap');
    const body = $('mon-feed');
    try {
      const r = await fetch(`${API}/filings/feed`, { headers: auth() });
      if (!r.ok) return; // 402/401: report path handles the upsell
      const d = await r.json();
      const items = d.items || [];
      const pending = d.pending || [];
      if (!items.length && !pending.length) return;
      let html = '';
      if (items.length) {
        html += `<div class="mon-feed-grid">` + items.map((it) => `
          <button class="mon-feed-item" data-sym="${esc(it.symbol)}" type="button">
            <div class="mon-feed-top">
              <span class="mon-feed-sym">${esc(it.symbol)}</span>
              <span class="mon-chip ${it.bucket === 'high' ? 'mon-chip-high' : it.bucket === 'medium' ? 'mon-chip-med' : 'mon-chip-low'}">${esc(String(it.materiality))}</span>
            </div>
            <p class="mon-feed-sum">${esc((it.summary || '').slice(0, 170))}${(it.summary || '').length > 170 ? '…' : ''}</p>
            <p class="small faint" style="margin:8px 0 0;">${esc((it.latestFiling && it.latestFiling.label) || '')} ${esc(it.filedDate || '')}</p>
          </button>`).join('') + `</div>`;
      }
      if (pending.length) {
        html += `<div class="mon-pending"><span class="small faint">Tap to analyze:</span> ${pending.map((s) => `<button class="mon-tag" data-sym="${esc(s)}" type="button">${esc(s)}</button>`).join(' ')}</div>`;
      }
      body.innerHTML = html;
      wrap.hidden = false;
      body.querySelectorAll('[data-sym]').forEach((b) => b.addEventListener('click', () => pick(b.dataset.sym)));
    } catch (_) { /* feed is enrichment */ }
  }

  document.addEventListener('DOMContentLoaded', () => {
    const form = $('mon-form');
    if (form) form.addEventListener('submit', (e) => { e.preventDefault(); analyze($('mon-input').value); });
    // "Free for 3 companies, no login" is a pitch for anonymous visitors —
    // once a user is signed in it no longer applies, so hide it.
    if (/(?:^|;\s*)sp_logged_in=1(?:;|$)/.test(document.cookie)) {
      const note = $('mon-free-note');
      if (note) note.hidden = true;
    }
    wireAutocomplete();
    const sym = new URLSearchParams(window.location.search).get('symbol');
    if (sym) { $('mon-input').value = sym.toUpperCase(); analyze(sym); }
    loadFeed();
  });
})();
