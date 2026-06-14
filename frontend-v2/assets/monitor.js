// Filing Change Monitor — client. On-demand "what changed in the latest
// filing" report for any ticker, plus a materiality-ranked feed across the
// user's holdings + watchlist. Pro feature: a 402 swaps in the upgrade card.
(function () {
  const { API, token, esc, markdown, spinner } = window.V2;
  const auth = () => (token() ? { Authorization: 'Bearer ' + token() } : {});
  const $ = (id) => document.getElementById(id);

  function chip(bucket, score) {
    const cls = bucket === 'high' ? 'mon-chip-high' : bucket === 'medium' ? 'mon-chip-med' : 'mon-chip-low';
    const label = bucket === 'high' ? 'High materiality' : bucket === 'medium' ? 'Worth a look' : 'Low impact';
    return `<span class="mon-chip ${cls}">${label} · ${esc(String(score))}</span>`;
  }

  function statCard(d) {
    const dir = d.direction === 'up' ? 'mon-up' : d.direction === 'down' ? 'mon-down' : 'mon-flat';
    return `<div class="mon-stat">
      <div class="mon-stat-label">${esc(d.label)}</div>
      <div class="mon-stat-val">${esc(d.latest)}</div>
      <div class="mon-stat-delta ${dir}">${esc(d.change)} YoY</div>
      <div class="mon-stat-prior">from ${esc(d.prior)}</div>
    </div>`;
  }

  const TONE = { improving: ['Improving', 'mon-tone-up'], deteriorating: ['Deteriorating', 'mon-tone-down'], stable: ['Stable', 'mon-tone-flat'] };

  function changeRow(c) {
    return `<div class="mon-change">
      <div class="mon-change-area">${esc(c.area)}</div>
      <div class="mon-change-what">${esc(c.what)}</div>
      ${c.quote ? `<blockquote class="mon-quote">${esc(c.quote)}</blockquote>` : ''}
    </div>`;
  }

  function renderReport(rep) {
    const out = $('mon-report');
    const filing = rep.latestFiling || {};
    const deltas = (rep.deltas || []).map(statCard).join('');
    const narr = rep.narrative;
    let narrHtml = '';
    if (narr) {
      const tone = TONE[narr.tone] || null;
      narrHtml = `
        <div class="mon-section">
          <div class="mon-section-hd">
            <h3 class="title-3">What changed in the filing</h3>
            ${tone ? `<span class="mon-tone ${tone[1]}">${tone[0]}</span>` : ''}
          </div>
          ${narr.headline ? `<p class="mon-headline">${esc(narr.headline)}</p>` : ''}
          <div class="mon-changes">${(narr.changes || []).map(changeRow).join('')}</div>
          ${narr.latest && narr.prev ? `<p class="small faint" style="margin-top:12px;">Compared <a href="${esc(narr.latest.url)}" target="_blank" rel="noopener">new ${esc(narr.latest.form)} (${esc(narr.latest.date)})</a> against <a href="${esc(narr.prev.url)}" target="_blank" rel="noopener">prior ${esc(narr.prev.form)} (${esc(narr.prev.date)})</a>.</p>` : ''}
        </div>`;
    } else if (rep.narrativeNote) {
      narrHtml = `<div class="mon-section"><p class="small faint">${esc(rep.narrativeNote)}</p></div>`;
    }

    out.innerHTML = `
      <div class="card card-pad mon-card">
        <div class="mon-card-hd">
          <div>
            <span class="label">${esc(rep.symbol)}</span>
            <h2 class="title-2" style="margin:4px 0 0;">${esc(filing.label || 'Latest filing')}</h2>
            <p class="small faint" style="margin:4px 0 0;">Filed ${esc(filing.date || '')}${filing.url ? ` · <a href="${esc(filing.url)}" target="_blank" rel="noopener">on SEC EDGAR ↗</a>` : ''}</p>
          </div>
          ${chip(rep.materialityBucket, rep.materiality)}
        </div>

        <div class="mon-summary">
          <span class="mon-summary-badge">✦ What changed &amp; why it matters</span>
          <div class="prose">${markdown(rep.summary || '')}</div>
        </div>

        ${deltas ? `<div class="mon-section">
          <h3 class="title-3">By the numbers <span class="small faint" style="font-weight:400;">· ${esc(rep.reportedPeriod || '')} vs the year-ago quarter</span></h3>
          <div class="mon-grid">${deltas}</div>
        </div>` : ''}

        ${narrHtml}

        <p class="small faint mon-note">${esc(rep.note || '')}</p>
      </div>`;
    out.hidden = false;
  }

  function upsell(out) {
    out.innerHTML = `
      <div class="card card-pad mon-upsell">
        <span class="mon-summary-badge">✦ Power &amp; Desk feature</span>
        <h2 class="title-2" style="margin:12px 0 8px;">The Filing Monitor is on Power &amp; Desk</h2>
        <p class="muted" style="max-width:62ch;">Get an instant, cited read on what materially changed in any company's latest 10-K, 10-Q or 8-K — the year-over-year numbers and the guidance, risk and demand language that moved — plus a materiality-ranked feed across your whole watchlist.</p>
        <div style="display:flex; flex-wrap:wrap; gap:12px; margin-top:16px;">
          <a class="btn btn-primary" href="/register.html?plan=desk">Get Desk — $1,990/yr</a>
          <a class="btn btn-ghost" href="/register.html?plan=power">Power — $590/yr</a>
        </div>
      </div>`;
    out.hidden = false;
  }

  async function analyze(sym) {
    sym = String(sym || '').toUpperCase().trim();
    if (!sym) return;
    const out = $('mon-report');
    out.hidden = false;
    out.innerHTML = `<div class="card card-pad">${spinner('Reading ' + esc(sym) + '’s latest filing &amp; the prior quarter… the first read can take up to a minute, then it’s instant.')}</div>`;
    try { history.replaceState(null, '', '?symbol=' + encodeURIComponent(sym)); } catch (_) {}
    if (!token()) { window.location.href = '/login.html?next=' + encodeURIComponent('/monitor.html?symbol=' + sym); return; }
    try {
      const r = await fetch(`${API}/filings/${encodeURIComponent(sym)}/report`, { headers: auth() });
      if (r.status === 401) { window.location.href = '/login.html'; return; }
      if (r.status === 402) { upsell(out); return; }
      const d = await r.json();
      if (!r.ok || !d.report) {
        out.innerHTML = `<div class="card card-pad"><p class="small faint">${esc((d && d.error) || 'Could not analyze that filing.')}</p></div>`;
        return;
      }
      renderReport(d.report);
    } catch (_) {
      out.innerHTML = `<div class="card card-pad"><p class="small faint">Something went wrong. Please try again.</p></div>`;
    }
  }

  function pick(sym) {
    $('mon-input').value = sym;
    analyze(sym);
    window.scrollTo({ top: 0, behavior: 'smooth' });
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
    const sym = new URLSearchParams(window.location.search).get('symbol');
    if (sym) { $('mon-input').value = sym.toUpperCase(); analyze(sym); }
    loadFeed();
  });
})();
