// Filing Change Monitor — client. On-demand "what changed in the latest
// filing" report for any ticker, plus a materiality-ranked feed across the
// user's holdings + watchlist. Pro feature: a 402 swaps in the upgrade card.
(function () {
  const { API, token, esc, markdown, spinner, companies } = window.V2;
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
          <a class="btn btn-primary" href="/register.html?plan=desk">Get Desk — £1,490/yr</a>
          <a class="btn btn-ghost" href="/register.html?plan=power">Power — £440/yr</a>
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
    if (remRaw === null || limRaw === null) return; // unlimited (Power/Desk)
    const remaining = parseInt(remRaw, 10);
    const limit = parseInt(limRaw, 10);
    if (!Number.isFinite(remaining) || !Number.isFinite(limit)) return;
    // Two limiters emit ratelimit-* headers: the small per-day trial gate
    // (free / no-login) and a 900/window global abuse limiter that also applies
    // to Power/Desk. Only the trial gate drives this counter — if the limit is
    // the large global one, the user is entitled (trial skipped); show nothing.
    if (limit > 10) return;
    const msg = remaining > 0
      ? `<strong>${remaining} of ${limit} free stock${remaining === 1 ? '' : 's'} left today.</strong> <span class="faint">Re-runs of a stock you’ve already opened stay free. Unlimited stocks across your whole watchlist are on Power.</span>`
      : `<strong>That’s your ${limit} free stocks for today.</strong> <span class="faint">Power gives you unlimited filing intelligence across your whole watchlist — the read institutions pay five figures a seat for.</span>`;
    const banner = document.createElement('div');
    banner.className = 'card card-pad mon-trial-note';
    banner.style.cssText = 'margin-bottom:14px; display:flex; flex-wrap:wrap; align-items:center; gap:10px 16px; justify-content:space-between;';
    banner.innerHTML = `<div class="small" style="max-width:58ch; margin:0;">${msg}</div>
      <div style="flex-shrink:0;">
        <a class="btn btn-primary btn-sm" href="/register.html?plan=power-monthly">Go unlimited — Power £49/mo</a>
      </div>`;
    const out = $('mon-report');
    out.insertBefore(banner, out.firstChild);
  }

  // The free no-login trial is spent for the day — convert rather than dead-end.
  function trialWall(out) {
    out.innerHTML = `
      <div class="card card-pad mon-upsell">
        <span class="mon-summary-badge">✦ The Filing Monitor — unlimited on Power</span>
        <h2 class="title-2" style="margin:12px 0 8px;">You’ve used today’s 3 free stocks</h2>
        <p class="muted" style="max-width:62ch;">Power gives you an instant, cited read on what materially changed in any 10-K, 10-Q or 8-K — the year-over-year numbers and the guidance, risk and demand language that moved, ranked by materiality — unlimited, with an auto-updating feed across your whole watchlist. The job institutional desks pay five figures a seat for.</p>
        <div style="display:flex; flex-wrap:wrap; gap:12px; margin-top:16px;">
          <a class="btn btn-primary" href="/register.html?plan=power-monthly">Start Power — £49/mo</a>
          <a class="btn btn-ghost" href="/register.html?plan=power">Or £440/yr — save 25%</a>
        </div>
        <p class="small faint" style="margin:12px 0 0;">Founding rate — locked for as long as you stay subscribed. Desk for RIAs &amp; funds — <a href="/register.html?plan=desk">£1,490/yr →</a></p>
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
      if (r.status === 402) { upsell(out); return; }    // logged-in, needs Power/Desk
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
        const kind = classifyErr(d && d.error);
        monFail(out, sym, kind, kind === 'generic' ? (d && d.error) : null);
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

  // Ticker autocomplete on the monitor input — same US-company list the nav
  // search and portfolio add-form use. A wrong/foreign symbol no longer
  // dead-ends: you pick a valid ticker from the list (and it analyzes at once).
  function wireAutocomplete() {
    const input = $('mon-input');
    if (!input || !companies) return;
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
        `<button type="button" data-sym="${esc(c.symbol)}" class="${i === active ? 'is-active' : ''}"><span class="sym">${esc(c.symbol)}</span><span class="nm">${esc(c.name || '')}</span></button>`).join('');
      box.hidden = false;
    };
    const choose = (sym) => { box.hidden = true; items = []; pick(sym); };
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
    wireAutocomplete();
    const sym = new URLSearchParams(window.location.search).get('symbol');
    if (sym) { $('mon-input').value = sym.toUpperCase(); analyze(sym); }
    loadFeed();
  });
})();
