/* Portfolio dashboard controller — talks to /api/portfolio + /api/alpha/* */
(function () {
  function resolveApiUrl() {
    if (typeof window !== 'undefined' && typeof window.API_URL === 'string' && window.API_URL) return window.API_URL;
    try {
      if (typeof window === 'undefined' || !window.location) return '/api';
      const { protocol, hostname } = window.location;
      const localHost = hostname === 'localhost' || hostname === '127.0.0.1';
      if (protocol === 'file:') return 'http://localhost:5000/api';
      if (localHost) return '/api';
      return '/api';
    } catch (_) { return '/api'; }
  }

  const API_URL = resolveApiUrl();
  // Demo mode (set inline in demo-dashboard.html before this script loads):
  // we route portfolio + market-data calls through /api/demo/... which is
  // unauthenticated and read-only, and hide any add/remove UI.
  const DEMO_MODE = typeof window !== 'undefined' && window.__DEMO_MODE === true;
  const PORTFOLIO_URL = DEMO_MODE ? `${API_URL}/demo/portfolio` : `${API_URL}/portfolio`;
  const DAILY_URL = (sym, depth) => DEMO_MODE
    ? `${API_URL}/demo/alpha/time-series/daily?symbol=${encodeURIComponent(sym)}&outputsize=${depth}`
    : `${API_URL}/alpha/time-series/daily?symbol=${encodeURIComponent(sym)}&outputsize=${depth}`;
  const FUNDAMENTALS_LINK = (sym) => DEMO_MODE
    ? `demo-fundamentals.html?symbol=${encodeURIComponent(sym)}`
    : `fundamentals.html?symbol=${encodeURIComponent(sym)}`;

  const $ = (id) => document.getElementById(id);
  const Loader = {
    show() { const el = $('loading-overlay'); if (el) el.removeAttribute('hidden'); },
    hide() { const el = $('loading-overlay'); if (el) el.setAttribute('hidden', ''); }
  };

  function authHeaders() {
    if (DEMO_MODE) return {};
    const token = localStorage.getItem('token');
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  const fmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 });
  const fmtShort = (v) => {
    if (!Number.isFinite(v)) return '—';
    const abs = Math.abs(v);
    const sign = v < 0 ? '-' : '';
    if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
    if (abs >= 1e3) return `$${(v / 1e3).toFixed(2)}K`;
    return fmt.format(v);
  };
  const fmtPct = (v) => Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(2)}%` : '—';
  const fmtSigned = (v) => Number.isFinite(v) ? `${v >= 0 ? '+' : '-'}${fmt.format(Math.abs(v))}` : '—';
  const fmtDate = (d) => d ? new Date(d).toLocaleString(undefined, { hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }) : '';

  const ALLOC_COLORS = ['#3b82f6', '#22c55e', '#fbbf24', '#a855f7', '#ef4444', '#14b8a6', '#f97316', '#ec4899', '#84cc16', '#06b6d4'];

  const state = {
    holdings: [],
    perfRange: '1M',
    perfSeries: null
  };

  // ---- API helpers ----
  async function fetchPortfolio() {
    const resp = await fetch(PORTFOLIO_URL, { headers: authHeaders() });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      throw new Error(err.message || `HTTP ${resp.status}`);
    }
    return resp.json();
  }

  async function addHolding(payload) {
    if (DEMO_MODE) {
      throw new Error('Editing is disabled in demo mode — sign up to manage your own portfolio.');
    }
    const resp = await fetch(`${API_URL}/portfolio`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders() },
      body: JSON.stringify(payload)
    });
    const body = await resp.json().catch(() => ({}));
    if (!resp.ok) throw new Error(body.message || `HTTP ${resp.status}`);
    return body;
  }

  async function removeHolding(id) {
    if (DEMO_MODE) {
      throw new Error('Editing is disabled in demo mode — sign up to manage your own portfolio.');
    }
    const resp = await fetch(`${API_URL}/portfolio/${id}`, {
      method: 'DELETE',
      headers: authHeaders()
    });
    if (!resp.ok) {
      const body = await resp.json().catch(() => ({}));
      throw new Error(body.message || `HTTP ${resp.status}`);
    }
  }

  // In-memory cache for daily price series so we don't refetch on every
  // refresh()/range-click. 5-minute TTL covers a typical viewing session;
  // compact (last ~100 trading days) is enough for 5D/1M/6M ranges, full
  // is fetched only when the user asks for 1Y or ALL.
  const dailySeriesCache = new Map(); // symbol -> { depth, data, ts }
  const DAILY_CACHE_TTL_MS = 5 * 60 * 1000;

  async function fetchDailySeries(symbol, depth = 'compact') {
    const cached = dailySeriesCache.get(symbol);
    if (cached && Date.now() - cached.ts < DAILY_CACHE_TTL_MS) {
      // Cached full is a superset — fine to serve when compact requested.
      if (cached.depth === depth || cached.depth === 'full') return cached.data;
    }
    const url = DAILY_URL(symbol, depth);
    const resp = await fetch(url, { headers: authHeaders() });
    if (!resp.ok) return [];
    const data = await resp.json().catch(() => null);
    const series = data && data['Time Series (Daily)'];
    if (!series) return [];
    const parsed = Object.keys(series).sort().map((date) => ({
      date: new Date(`${date}T00:00:00`),
      close: parseFloat(series[date]['5. adjusted close'] || series[date]['4. close'])
    })).filter((row) => Number.isFinite(row.close));
    dailySeriesCache.set(symbol, { depth, data: parsed, ts: Date.now() });
    return parsed;
  }

  // Ranges that need more than ~100 trading days of history.
  const FULL_HISTORY_RANGES = new Set(['1Y', 'ALL']);

  // ---- Renderers ----
  function setDelta(el, value, asPercent = false, base = null) {
    if (!el) return;
    const tone = !Number.isFinite(value) ? 'neutral' : (value > 0 ? 'positive' : (value < 0 ? 'negative' : 'neutral'));
    el.classList.remove('positive','negative','neutral');
    el.classList.add(tone);
    if (!Number.isFinite(value)) { el.textContent = ''; return; }
    if (asPercent) el.textContent = fmtPct(value);
    else if (base != null && Number.isFinite(base) && base !== 0) {
      const pct = (value / base) * 100;
      el.textContent = `${fmtSigned(value)} (${fmtPct(pct)})`;
    } else el.textContent = fmtSigned(value);
  }

  function renderKPIs(holdings) {
    const totalValue = holdings.reduce((s, h) => s + (Number(h.currentPrice) || 0) * (Number(h.shares) || 0), 0);
    const totalCost  = holdings.reduce((s, h) => s + (Number(h.purchasePrice) || 0) * (Number(h.shares) || 0), 0);
    const totalGain  = totalValue - totalCost;
    const dayChange  = (state.perfSeries && state.perfSeries.length >= 2)
      ? state.perfSeries[state.perfSeries.length - 1].value - state.perfSeries[state.perfSeries.length - 2].value
      : null;

    $('kpi-total').textContent = fmt.format(totalValue);
    setDelta($('kpi-total-delta'), totalGain, false, totalCost);

    $('kpi-day').textContent = Number.isFinite(dayChange) ? fmtSigned(dayChange) : '—';
    setDelta($('kpi-day-delta'), dayChange, false, totalValue - (dayChange || 0));

    $('kpi-gain').textContent = fmtSigned(totalGain);
    setDelta($('kpi-gain-delta'), totalGain, false, totalCost);

    $('kpi-holdings').textContent = String(holdings.length);
    const note = $('kpi-holdings-note');
    if (note) {
      note.classList.remove('positive','negative');
      note.classList.add('neutral');
      note.textContent = holdings.length ? `${holdings.length} active position${holdings.length === 1 ? '' : 's'}` : 'No positions yet';
    }

    const updated = $('dash-updated');
    if (updated) updated.textContent = `Updated ${fmtDate(new Date())}`;
  }

  // A realistic sample portfolio new users can load with one click, then
  // edit or delete. Removes the empty-dashboard wall — the #1 activation
  // killer — by delivering instant value (live prices, charts, allocation).
  const SAMPLE_HOLDINGS = [
    { symbol: 'AAPL',  name: 'Apple Inc.',            shares: 25, purchasePrice: 175.00, purchaseDate: '2024-01-15' },
    { symbol: 'MSFT',  name: 'Microsoft Corporation', shares: 12, purchasePrice: 370.00, purchaseDate: '2024-02-01' },
    { symbol: 'NVDA',  name: 'NVIDIA Corporation',    shares: 30, purchasePrice: 62.00,  purchaseDate: '2024-01-20' },
    { symbol: 'GOOGL', name: 'Alphabet Inc.',         shares: 18, purchasePrice: 140.00, purchaseDate: '2024-03-04' },
    { symbol: 'JPM',   name: 'JPMorgan Chase & Co.',  shares: 15, purchasePrice: 172.00, purchaseDate: '2024-02-12' }
  ];

  async function loadSamplePortfolio() {
    if (DEMO_MODE) return;
    Loader.show();
    try {
      for (const h of SAMPLE_HOLDINGS) {
        await addHolding({
          symbol: h.symbol,
          name: h.name,
          shares: h.shares,
          purchasePrice: h.purchasePrice,
          purchaseDate: new Date(`${h.purchaseDate}T00:00:00`).toISOString()
        });
      }
      await refresh();
    } catch (e) {
      const err = $('add-error');
      if (err) { err.textContent = e.message || 'Could not load sample portfolio.'; err.hidden = false; }
    } finally { Loader.hide(); }
  }

  function exportHoldingsCSV() {
    const rows = state.holdings || [];
    if (!rows.length) return;
    const header = ['Symbol', 'Name', 'Shares', 'PurchasePrice', 'PurchaseDate', 'CurrentPrice'];
    const csvEscape = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const lines = [header.join(',')];
    rows.forEach((h) => {
      lines.push([
        h.symbol,
        h.name,
        h.shares,
        h.purchasePrice ?? '',
        h.purchaseDate ? String(h.purchaseDate).slice(0, 10) : '',
        h.currentPrice ?? ''
      ].map(csvEscape).join(','));
    });
    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `portfolio-${new Date().toISOString().slice(0, 10)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function parseHoldingsCSV(text) {
    const lines = String(text || '').split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) return [];
    // Detect & skip a header row (first cell non-numeric symbol like "Symbol").
    const splitRow = (line) => {
      const out = []; let cur = ''; let inQ = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQ) {
          if (c === '"' && line[i + 1] === '"') { cur += '"'; i++; }
          else if (c === '"') inQ = false;
          else cur += c;
        } else if (c === '"') inQ = true;
        else if (c === ',') { out.push(cur); cur = ''; }
        else cur += c;
      }
      out.push(cur);
      return out.map((s) => s.trim());
    };
    const first = splitRow(lines[0]).map((s) => s.toLowerCase());
    const hasHeader = first.includes('symbol') || first.includes('ticker');
    const body = hasHeader ? lines.slice(1) : lines;
    const out = [];
    for (const line of body) {
      const c = splitRow(line);
      const symbol = (c[0] || '').toUpperCase();
      if (!symbol) continue;
      // Flexible: Symbol, [Name], Shares, [PurchasePrice], [PurchaseDate]
      // If col1 looks numeric, treat as 2-col (Symbol, Shares).
      let name = '', shares, price, date;
      if (c.length >= 5) { name = c[1]; shares = Number(c[2]); price = Number(c[3]); date = c[4]; }
      else if (c.length === 4) { name = c[1]; shares = Number(c[2]); price = Number(c[3]); }
      else if (c.length === 3) {
        if (Number.isFinite(Number(c[1]))) { shares = Number(c[1]); price = Number(c[2]); }
        else { name = c[1]; shares = Number(c[2]); }
      } else if (c.length === 2) { shares = Number(c[1]); }
      if (!Number.isFinite(shares) || shares <= 0) continue;
      const row = { symbol, name: name || symbol, shares };
      if (Number.isFinite(price) && price > 0) row.purchasePrice = price;
      if (date && !Number.isNaN(new Date(date).getTime())) row.purchaseDate = new Date(`${date}T00:00:00`).toISOString();
      out.push(row);
    }
    return out;
  }

  async function importHoldingsCSV(file) {
    if (DEMO_MODE || !file) return;
    const err = $('add-error');
    if (err) { err.textContent = ''; err.hidden = true; }
    let text = '';
    try { text = await file.text(); }
    catch (_) { if (err) { err.textContent = 'Could not read that file.'; err.hidden = false; } return; }
    const rows = parseHoldingsCSV(text);
    if (!rows.length) {
      if (err) { err.textContent = 'No valid rows found. Use columns: Symbol, Name, Shares, PurchasePrice, PurchaseDate.'; err.hidden = false; }
      return;
    }
    Loader.show();
    let added = 0;
    try {
      for (const r of rows) { try { await addHolding(r); added++; } catch (_) { /* skip bad row */ } }
      await refresh();
      if (err && added < rows.length) {
        err.textContent = `Imported ${added} of ${rows.length} rows (some were skipped).`;
        err.hidden = false;
      }
    } finally { Loader.hide(); }
  }

  function renderHoldings(holdings) {
    const tbody = $('holdings-list');
    if (!tbody) return;
    if (!holdings.length) {
      if (DEMO_MODE) {
        tbody.innerHTML = '<tr class="dash-empty-row"><td colspan="9">Sample portfolio loading…</td></tr>';
        return;
      }
      tbody.innerHTML = `
        <tr class="dash-empty-row"><td colspan="9">
          <div class="dash-onboard">
            <p class="dash-onboard-title">Your portfolio is empty</p>
            <p class="dash-onboard-sub">Add a position above, import a CSV, or start with a sample portfolio you can edit or delete.</p>
            <div class="dash-onboard-actions">
              <button type="button" class="btn btn-primary" id="load-sample-btn">Load a sample portfolio</button>
              <button type="button" class="btn btn-quiet" id="onboard-import-btn">Import from CSV</button>
            </div>
          </div>
        </td></tr>`;
      const sampleBtn = document.getElementById('load-sample-btn');
      if (sampleBtn) sampleBtn.addEventListener('click', loadSamplePortfolio);
      const impBtn = document.getElementById('onboard-import-btn');
      if (impBtn) impBtn.addEventListener('click', () => document.getElementById('csv-import-input')?.click());
      return;
    }
    tbody.innerHTML = '';
    holdings.forEach((h) => {
      const sym = String(h.symbol || '').toUpperCase();
      const shares = Number(h.shares) || 0;
      const buy = Number(h.purchasePrice) || 0;
      const cur = Number(h.currentPrice) || 0;
      const cost = buy * shares;
      const value = cur * shares;
      const pl = value - cost;
      const plPct = cost ? (pl / cost) * 100 : 0;
      const plClass = pl > 0 ? 'gain' : (pl < 0 ? 'loss' : 'neutral');

      const tr = document.createElement('tr');
      tr.dataset.symbol = sym;
      const actionsHtml = DEMO_MODE
        ? '<span class="dash-demo-locked" title="Editing is disabled in demo mode">—</span>'
        : `<button class="dash-remove-btn" data-id="${h._id}">Remove</button>`;
      tr.innerHTML = `
        <td class="dash-name">${escapeHTML(h.name || sym)}</td>
        <td><a class="dash-symbol-pill" href="${FUNDAMENTALS_LINK(sym)}">${sym}</a></td>
        <td class="num">${shares.toLocaleString(undefined, { maximumFractionDigits: 4 })}</td>
        <td class="num">${fmt.format(buy)}</td>
        <td class="num">${fmt.format(cur)}</td>
        <td class="num">${fmt.format(cost)}</td>
        <td class="num">${fmt.format(value)}</td>
        <td class="num ${plClass}">${fmtSigned(pl)} (${fmtPct(plPct)})</td>
        <td class="dash-col-actions">${actionsHtml}</td>
      `;
      tbody.appendChild(tr);
    });

    tbody.querySelectorAll('.dash-remove-btn').forEach((btn) => {
      btn.addEventListener('click', async () => {
        const id = btn.dataset.id;
        if (!id) return;
        if (!window.confirm('Remove this position?')) return;
        try {
          Loader.show();
          await removeHolding(id);
          await refresh();
        } catch (e) {
          alert(e.message || 'Failed to remove position');
        } finally { Loader.hide(); }
      });
    });
  }

  function escapeHTML(value) {
    return String(value || '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[c]);
  }

  // ---- Allocation donut ----
  function drawAllocation(holdings) {
    const container = d3.select('#alloc-chart');
    container.selectAll('*').remove();
    const legend = $('alloc-legend');
    if (legend) legend.innerHTML = '';

    const positive = holdings
      .map((h) => ({
        symbol: String(h.symbol || '').toUpperCase(),
        name: h.name || h.symbol,
        value: (Number(h.currentPrice) || 0) * (Number(h.shares) || 0)
      }))
      .filter((d) => d.value > 0)
      .sort((a, b) => b.value - a.value);
    const total = positive.reduce((s, d) => s + d.value, 0);
    if (!positive.length || total <= 0) {
      container.append('div').attr('class', 'dash-empty-chart').text('Add positions to see allocation');
      return;
    }

    const node = container.node();
    const bbox = node.getBoundingClientRect();
    const W = Math.max(220, Math.floor(bbox.width));
    const H = Math.max(220, Math.floor(bbox.height || W));
    const r  = Math.min(W, H) / 2 - 8;
    const ir = r * 0.62;

    const svg = container.append('svg')
      .attr('viewBox', `0 0 ${W} ${H}`)
      .style('width', '100%').style('height', '100%');
    const g = svg.append('g').attr('transform', `translate(${W/2},${H/2})`);

    const pie = d3.pie().value((d) => d.value).sort(null);
    const arc = d3.arc().innerRadius(ir).outerRadius(r).cornerRadius(8).padAngle(0.018);
    const tooltip = ensureTooltip();

    g.selectAll('path').data(pie(positive)).enter().append('path')
      .attr('d', arc)
      .attr('fill', (_, i) => ALLOC_COLORS[i % ALLOC_COLORS.length])
      .attr('stroke', '#0b0c0e').attr('stroke-width', 1.5)
      .style('cursor', 'pointer')
      .on('mousemove', (event, d) => {
        const pct = (d.data.value / total * 100).toFixed(1);
        tooltip.innerHTML = `<div style="font-weight:700">${escapeHTML(d.data.symbol)}</div>
          <div style="color:#cbd0d8">${fmt.format(d.data.value)} · ${pct}%</div>`;
        tooltip.style.left = `${event.clientX + 12}px`;
        tooltip.style.top = `${event.clientY + 12}px`;
        tooltip.style.opacity = '1';
        tooltip.style.transform = 'translate3d(0,0,0)';
      })
      .on('mouseleave', () => { tooltip.style.opacity = '0'; });

    // Center label
    g.append('text').attr('text-anchor','middle').attr('y',-4)
      .attr('fill','#a3a6ad').attr('font-size',11).attr('font-weight',700)
      .style('letter-spacing','0.08em').text('TOTAL');
    g.append('text').attr('text-anchor','middle').attr('y',20)
      .attr('fill','#f5f5f5').attr('font-size',Math.max(15, Math.min(22, r/4))).attr('font-weight',800)
      .text(fmtShort(total));

    // Legend
    if (legend) {
      positive.slice(0, 8).forEach((d, i) => {
        const li = document.createElement('li');
        li.innerHTML = `<span class="swatch" style="background:${ALLOC_COLORS[i % ALLOC_COLORS.length]}"></span>
          <span class="sym">${escapeHTML(d.symbol)}</span>
          <span class="pct">${(d.value / total * 100).toFixed(1)}%</span>`;
        legend.appendChild(li);
      });
    }
  }

  function ensureTooltip() {
    let t = document.getElementById('dash-tooltip');
    if (!t) {
      t = document.createElement('div');
      t.id = 'dash-tooltip';
      t.className = 'dash-tooltip';
      document.body.appendChild(t);
    }
    return t;
  }

  // ---- Performance line chart ----
  function aggregatePerformance(holdings, seriesBySymbol) {
    const dateSet = new Set();
    holdings.forEach((h) => {
      const sym = String(h.symbol || '').toUpperCase();
      const series = seriesBySymbol[sym] || [];
      series.forEach((row) => dateSet.add(+row.date));
    });
    if (!dateSet.size) return [];
    const dates = Array.from(dateSet).sort((a,b) => a-b).map((ts) => new Date(ts));
    const lookup = {};
    Object.keys(seriesBySymbol).forEach((sym) => {
      lookup[sym] = new Map((seriesBySymbol[sym] || []).map((r) => [+r.date, r.close]));
    });
    const lastClose = {};
    Object.keys(lookup).forEach((sym) => { lastClose[sym] = null; });

    return dates.map((d) => {
      let total = 0;
      holdings.forEach((h) => {
        const sym = String(h.symbol || '').toUpperCase();
        const map = lookup[sym];
        if (!map) return;
        if (map.has(+d)) lastClose[sym] = map.get(+d);
        const price = lastClose[sym];
        const start = h.purchaseDate ? new Date(h.purchaseDate) : null;
        if (price != null && (!start || d >= start)) total += price * (Number(h.shares) || 0);
      });
      return { date: d, value: total };
    });
  }

  function rangeFilter(series, range) {
    if (!series || !series.length) return [];
    if (range === 'ALL') return series.slice();
    const days = { '5D': 7, '1M': 32, '6M': 190, '1Y': 380 }[range] || 32;
    const cutoff = Date.now() - days * 86400000;
    const filtered = series.filter((row) => +row.date >= cutoff);
    return filtered.length >= 2 ? filtered : series.slice(-Math.max(2, Math.floor(days / 1.5)));
  }

  function drawPerformance(series) {
    const container = d3.select('#perf-chart');
    container.selectAll('*').remove();
    if (!series || series.length < 2) {
      container.append('div').attr('class', 'dash-empty-chart').text('Add at least one position to see performance');
      return;
    }

    const node = container.node();
    const bbox = node.getBoundingClientRect();
    const W = Math.max(320, Math.floor(bbox.width));
    const H = Math.max(280, Math.floor(bbox.height || 320));
    const m = { top: 16, right: 16, bottom: 30, left: 56 };
    const w = W - m.left - m.right;
    const h = H - m.top - m.bottom;

    const svg = container.append('svg').attr('viewBox', `0 0 ${W} ${H}`).style('width','100%').style('height','100%');
    const g = svg.append('g').attr('transform', `translate(${m.left},${m.top})`);

    const x = d3.scaleTime().domain(d3.extent(series, (d) => d.date)).range([0, w]);
    const values = series.map((d) => d.value);
    let [lo, hi] = d3.extent(values);
    if (lo === hi) { lo -= 1; hi += 1; }
    const pad = Math.max(1, (hi - lo) * 0.08);
    const y = d3.scaleLinear().domain([Math.max(0, lo - pad), hi + pad]).nice().range([h, 0]);

    const grid = d3.axisLeft(y).ticks(6).tickSize(-w).tickFormat('');
    g.append('g').attr('class','dash-grid').call(grid)
      .selectAll('.tick line').attr('stroke', '#23262d').attr('stroke-dasharray', '3,5');
    g.selectAll('.dash-grid .domain').remove();

    const trend = series[series.length - 1].value - series[0].value;
    const stroke = trend >= 0 ? 'var(--success)' : 'var(--danger)';
    const fillId = `dashArea${Math.random().toString(36).slice(2,7)}`;

    const defs = svg.append('defs');
    const grad = defs.append('linearGradient').attr('id', fillId).attr('x1','0').attr('y1','0').attr('x2','0').attr('y2','1');
    grad.append('stop').attr('offset','0%').attr('stop-color', trend >= 0 ? '#22c55e' : '#ef4444').attr('stop-opacity', 0.32);
    grad.append('stop').attr('offset','100%').attr('stop-color', trend >= 0 ? '#22c55e' : '#ef4444').attr('stop-opacity', 0);

    const area = d3.area().x((d) => x(d.date)).y0(h).y1((d) => y(d.value)).curve(d3.curveMonotoneX);
    g.append('path').datum(series).attr('d', area).attr('fill', `url(#${fillId})`);

    const line = d3.line().x((d) => x(d.date)).y((d) => y(d.value)).curve(d3.curveMonotoneX);
    g.append('path').datum(series).attr('d', line)
      .attr('fill','none').attr('stroke', trend >= 0 ? '#22c55e' : '#ef4444').attr('stroke-width', 2.2);

    g.append('g').attr('transform', `translate(0,${h})`)
      .call(d3.axisBottom(x).ticks(Math.max(3, Math.floor(w/100))).tickFormat(d3.timeFormat('%b %d')))
      .call((sel) => { sel.selectAll('text').attr('fill','#a3a6ad').attr('font-size',11);
        sel.selectAll('line').attr('stroke','#26282e'); sel.selectAll('.domain').attr('stroke','#26282e'); });

    g.append('g')
      .call(d3.axisLeft(y).ticks(6).tickFormat((v) => fmtShort(v)))
      .call((sel) => { sel.selectAll('text').attr('fill','#d1d5db').attr('font-size',11);
        sel.selectAll('line').attr('stroke','transparent'); sel.selectAll('.domain').attr('stroke','#26282e'); });

    // Hover crosshair
    const tooltip = ensureTooltip();
    const hoverLine = g.append('line').attr('stroke','#a3a6ad').attr('stroke-dasharray','3,4').style('display','none');
    const hoverDot = g.append('circle').attr('r',4).attr('fill','#0b0c0e').attr('stroke', trend >= 0 ? '#22c55e' : '#ef4444').attr('stroke-width',2).style('display','none');
    const bisect = d3.bisector((row) => row.date).center;

    g.append('rect').attr('width', w).attr('height', h).attr('fill','transparent').style('cursor','crosshair')
      .on('mouseenter', () => { hoverLine.style('display', null); hoverDot.style('display', null); })
      .on('mousemove', (event) => {
        const [mx] = d3.pointer(event);
        const date = x.invert(Math.max(0, Math.min(w, mx)));
        const idx = Math.max(0, Math.min(series.length - 1, bisect(series, date)));
        const point = series[idx];
        if (!point) return;
        hoverLine.attr('x1', x(point.date)).attr('x2', x(point.date)).attr('y1', 0).attr('y2', h);
        hoverDot.attr('cx', x(point.date)).attr('cy', y(point.value));
        tooltip.innerHTML = `<div style="color:#a3a6ad">${d3.timeFormat('%b %d, %Y')(point.date)}</div>
          <div style="font-weight:700">${fmt.format(point.value)}</div>`;
        tooltip.style.left = `${event.clientX + 12}px`;
        tooltip.style.top = `${event.clientY + 12}px`;
        tooltip.style.opacity = '1';
      })
      .on('mouseleave', () => {
        hoverLine.style('display','none'); hoverDot.style('display','none');
        tooltip.style.opacity = '0';
      });
  }

  // ---- Workflow ----
  // Two-phase render:
  //  1. Fetch portfolio → paint KPIs + table + donut + hide loader (~1-2s)
  //  2. In the background fetch daily series (compact) → paint perf chart
  //     and refresh day-change KPI. Full-history fetch only on 1Y/ALL click.
  async function refresh() {
    Loader.show();
    try {
      const list = await fetchPortfolio();
      state.holdings = Array.isArray(list) ? list : [];
      renderHoldings(state.holdings);
      drawAllocation(state.holdings);
      renderKPIs(state.holdings);
    } catch (error) {
      console.error('Portfolio refresh failed:', error);
      const tbody = $('holdings-list');
      if (tbody) tbody.innerHTML = `<tr class="dash-empty-row"><td colspan="9">${escapeHTML(error.message || 'Unable to load portfolio.')}</td></tr>`;
      Loader.hide();
      return;
    }
    Loader.hide();

    // Phase 2: load chart series in the background. Don't block UI.
    const needsFull = FULL_HISTORY_RANGES.has(state.perfRange);
    const depth = needsFull ? 'full' : 'compact';
    loadPerformanceSeries(depth).catch((e) => console.error('Perf series load failed:', e));

    // Weekly AI briefing (cached server-side; cheap to call).
    loadBriefing(false).catch(() => {});
  }

  async function loadPerformanceSeries(depth = 'compact') {
    const symbols = Array.from(new Set(
      state.holdings.map((h) => String(h.symbol || '').toUpperCase()).filter(Boolean)
    ));
    if (!symbols.length) {
      state.perfSeries = [];
      drawPerformance([]);
      return;
    }
    // Show a brief placeholder while series fetches
    const container = d3.select('#perf-chart');
    if (container.select('svg').empty()) {
      container.selectAll('*').remove();
      container.append('div').attr('class', 'dash-empty-chart').text('Loading performance…');
    }

    const arrays = await Promise.all(symbols.map((s) => fetchDailySeries(s, depth).catch(() => [])));
    const seriesBySymbol = {};
    symbols.forEach((s, i) => { seriesBySymbol[s] = arrays[i]; });
    const fullSeries = aggregatePerformance(state.holdings, seriesBySymbol);
    state.perfSeries = fullSeries;
    state.perfSeriesDepth = depth;
    drawPerformance(rangeFilter(fullSeries, state.perfRange));
    renderKPIs(state.holdings); // refresh day-change KPI now that we have series
  }

  // ---- Symbol search autocomplete ----
  function bindSymbolSearch() {
    const input = $('stock-symbol');
    const list = $('search-results');
    if (!input || !list) return;
    let suggestions = [];

    const hide = () => { list.style.display = 'none'; list.innerHTML = ''; suggestions = []; };
    const render = (items) => {
      suggestions = items;
      list.innerHTML = '';
      items.forEach((item, idx) => {
        const li = document.createElement('li');
        li.dataset.index = String(idx);
        li.textContent = `${item.name} (${item.symbol})`;
        list.appendChild(li);
      });
      list.style.display = items.length ? 'block' : 'none';
    };

    input.addEventListener('input', async () => {
      const query = (input.value || '').trim();
      if (query.length < 2 || !window.SymbolLookup || typeof window.SymbolLookup.searchOne !== 'function') { hide(); return; }
      const items = await window.SymbolLookup.searchOne(query).catch(() => []);
      if (!items.length) { hide(); return; }
      render(items.slice(0, 8));
    });

    list.addEventListener('mousedown', (event) => {
      const li = event.target.closest('li');
      if (!li) return;
      event.preventDefault();
      const item = suggestions[Number(li.dataset.index)];
      hide();
      if (!item?.symbol) return;
      input.value = `${item.name} (${item.symbol})`;
      input.dataset.symbol = item.symbol;
      input.dataset.name = item.name;
    });

    document.addEventListener('click', (event) => {
      if (event.target === input || list.contains(event.target)) return;
      hide();
    });
  }

  function bindForm() {
    const form = $('add-stock-form');
    if (!form) return;
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const error = $('add-error');
      if (error) { error.textContent = ''; error.hidden = true; }

      const input = $('stock-symbol');
      const sharesEl = $('shares');
      const buyEl = $('purchase-price');
      const dateEl = $('purchase-date');
      const raw = (input?.value || '').trim();
      let symbol = (input?.dataset.symbol || '').trim().toUpperCase();
      let name = (input?.dataset.name || '').trim();
      if (!symbol) {
        const match = raw.match(/\(([^)]+)\)\s*$/);
        if (match) { symbol = match[1].toUpperCase(); name = raw.replace(/\s*\([^)]+\)\s*$/, '').trim(); }
        else { symbol = raw.toUpperCase(); name = raw; }
      }
      const shares = Number(sharesEl?.value);
      const buy = Number(buyEl?.value);
      const date = dateEl?.value || null;
      if (!symbol || !Number.isFinite(shares) || shares <= 0) {
        if (error) { error.textContent = 'Enter a symbol and a positive share count.'; error.hidden = false; }
        return;
      }

      const payload = { symbol, name: name || symbol, shares };
      if (Number.isFinite(buy) && buy > 0) payload.purchasePrice = buy;
      if (date) payload.purchaseDate = new Date(`${date}T00:00:00`).toISOString();

      try {
        Loader.show();
        await addHolding(payload);
        if (input) { input.value = ''; delete input.dataset.symbol; delete input.dataset.name; }
        if (sharesEl) sharesEl.value = '';
        if (buyEl) buyEl.value = '';
        if (dateEl) dateEl.value = '';
        await refresh();
      } catch (e) {
        if (error) { error.textContent = e.message || 'Failed to add position.'; error.hidden = false; }
      } finally { Loader.hide(); }
    });
  }

  function bindRangeButtons() {
    const host = $('perf-range');
    if (!host) return;
    host.addEventListener('click', async (event) => {
      const btn = event.target.closest('.dash-toggle');
      if (!btn) return;
      host.querySelectorAll('.dash-toggle').forEach((b) => b.classList.toggle('active', b === btn));
      state.perfRange = btn.dataset.range || '1M';

      // 1Y/ALL need >100 trading days — upgrade to full daily series
      // on demand if we only have compact cached.
      const needsFull = FULL_HISTORY_RANGES.has(state.perfRange);
      if (needsFull && state.perfSeriesDepth !== 'full') {
        await loadPerformanceSeries('full');
        return; // loadPerformanceSeries already redraws
      }

      drawPerformance(rangeFilter(state.perfSeries || [], state.perfRange));
    });
  }

  async function loadBriefing(force) {
    if (DEMO_MODE) return;
    const card = document.getElementById('briefing-card');
    const body = document.getElementById('briefing-body');
    const meta = document.getElementById('briefing-meta');
    if (!card || !body) return;
    // Only show the card once the user has holdings.
    if (!state.holdings || !state.holdings.length) { card.hidden = true; return; }
    card.hidden = false;
    if (force) body.textContent = 'Regenerating your briefing…';
    try {
      const url = `${API_URL}/portfolio/briefing${force ? '?refresh=1' : ''}`;
      const resp = await fetch(url, { headers: authHeaders() });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const data = await resp.json();
      body.textContent = data.briefing || '';
      if (meta) {
        const when = data.generatedAt ? new Date(data.generatedAt) : null;
        const tag = data.source === 'ai' ? 'AI summary' : 'Summary';
        meta.textContent = `${tag}${when && !Number.isNaN(when.getTime()) ? ' · ' + when.toLocaleDateString() : ''} · not financial advice`;
      }
    } catch (e) {
      body.textContent = 'Briefing is unavailable right now.';
      if (meta) meta.textContent = '';
    }
  }

  function bindBriefing() {
    const btn = document.getElementById('briefing-refresh');
    if (btn) btn.addEventListener('click', () => loadBriefing(true));
  }

  async function askPortfolio(question) {
    const ans = document.getElementById('ask-answer');
    const btn = document.getElementById('ask-btn');
    const input = document.getElementById('ask-input');
    if (!ans || !question.trim()) return;
    ans.hidden = false;
    ans.textContent = 'Thinking…';
    if (btn) btn.disabled = true;
    try {
      const resp = await fetch(`${API_URL}/portfolio/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders() },
        body: JSON.stringify({ question: question.trim() })
      });
      const data = await resp.json().catch(() => ({}));
      if (resp.status === 402 && data.code === 'PRO_REQUIRED') {
        ans.innerHTML = 'The AI assistant is a Pro feature. <a href="register.html?plan=pro" style="color:var(--primary)">Upgrade to Pro</a> to ask questions about your portfolio.';
      } else if (!resp.ok) {
        ans.textContent = data.message || 'Could not answer right now.';
      } else {
        ans.textContent = data.answer || 'No answer.';
      }
    } catch (_) {
      ans.textContent = 'The assistant is unavailable right now.';
    } finally {
      if (btn) btn.disabled = false;
      if (input) input.value = '';
    }
  }

  function bindAsk() {
    const form = document.getElementById('ask-form');
    const input = document.getElementById('ask-input');
    const suggest = document.getElementById('ask-suggest');
    if (form) form.addEventListener('submit', (e) => {
      e.preventDefault();
      askPortfolio((input && input.value) || '');
    });
    if (suggest) suggest.addEventListener('click', (e) => {
      const chip = e.target.closest('.dash-ask-chip');
      if (chip) askPortfolio(chip.textContent);
    });
  }

  function bindDataTools() {
    const exportBtn = document.getElementById('export-csv-btn');
    const importBtn = document.getElementById('import-csv-btn');
    const fileInput = document.getElementById('csv-import-input');
    if (exportBtn) exportBtn.addEventListener('click', exportHoldingsCSV);
    if (importBtn && fileInput) importBtn.addEventListener('click', () => fileInput.click());
    if (fileInput) fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (f) importHoldingsCSV(f);
      fileInput.value = '';
    });
  }

  function applyDemoModeUI() {
    if (!DEMO_MODE) return;
    // Hide the Add Position card entirely — demo is read-only.
    const addCard = document.getElementById('add-stock-card');
    if (addCard) addCard.style.display = 'none';
    // Hide import/export tools in demo.
    const tools = document.getElementById('dash-data-tools');
    if (tools) tools.style.display = 'none';
    // Update dashboard subtitle so visitors know it's a sample.
    const sub = document.getElementById('dash-sub');
    if (sub) sub.textContent = 'A sample portfolio with live prices. Sign up to build your own.';
  }

  document.addEventListener('DOMContentLoaded', () => {
    applyDemoModeUI();
    if (!DEMO_MODE) {
      bindSymbolSearch();
      bindForm();
      bindDataTools();
      bindBriefing();
      bindAsk();
    }
    bindRangeButtons();
    refresh();
    window.addEventListener('resize', () => {
      drawAllocation(state.holdings);
      drawPerformance(rangeFilter(state.perfSeries || [], state.perfRange));
    });
  });
})();
