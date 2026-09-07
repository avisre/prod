// Dashboard: holdings, what changed (alerts), X-Ray, Ask — same APIs as v1.
(function () {
    'use strict';
    const { API, token, num, money, pct, fixed, esc, nav, footer, mountAsk, markdown, chart, searchAssets, mountShare } = window.V2;
    nav('dashboard');
    footer();

    const $ = (id) => document.getElementById(id);
    const DEMO = new URLSearchParams(location.search).get('demo') === '1' && !token();
    if (!token() && !DEMO) {
        $('locked').hidden = false;
        const actions = $('locked').querySelector('div');
        actions.insertAdjacentHTML('beforeend',
            '<a class="btn btn-ghost" href="/dashboard.html?demo=1">View a demo portfolio</a>');
        return;
    }
    $('authed').hidden = false;

    const auth = DEMO ? {} : { Authorization: `Bearer ${token()}` };

    async function mountInitialRefund() {
        if (DEMO) return;
        try {
            const r = await fetch(`${API}/session`, { headers: auth });
            const data = await r.json().catch(() => ({}));
            const policy = data && data.initialRefund;
            const section = $('billing-refund');
            const copy = $('billing-refund-copy');
            const button = $('billing-refund-button');
            const status = $('billing-refund-status');
            if (!section || !copy || !button || !policy || !policy.eligible) return;
            const until = policy.eligibleUntil ? new Date(policy.eligibleUntil) : null;
            const dateText = until && !Number.isNaN(until.getTime()) ? ` before ${until.toLocaleDateString()}` : '';
            copy.textContent = `Your initial Stripe payment is eligible for a refund${dateText}. Requesting it cancels the subscription and removes paid access.`;
            section.hidden = false;
            button.addEventListener('click', async () => {
                button.disabled = true;
                status.hidden = false;
                status.textContent = 'Processing your refund…';
                try {
                    const response = await fetch(`${API}/billing/refund`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' } });
                    const result = await response.json().catch(() => ({}));
                    if (!response.ok) throw new Error(result.message || 'The refund could not be completed.');
                    status.textContent = result.message || 'Your payment was refunded.';
                    button.hidden = true;
                } catch (error) {
                    status.textContent = error.message || 'The refund could not be completed.';
                    button.disabled = false;
                }
            }, { once: true });
        } catch (_) { /* billing panel is non-blocking */ }
    }
    mountInitialRefund();

    // Recent research — Dossier is cached per company and never re-billed, but
    // that cache is invisible unless we surface it: list what this user has
    // already generated so they don't need to remember tickers to reopen for free.
    async function mountRecentResearch() {
        if (DEMO) return;
        try {
            const r = await fetch(`${API}/dossier-history/recent`, { headers: auth });
            if (!r.ok) return;
            const data = await r.json().catch(() => ({}));
            const recent = Array.isArray(data.recent) ? data.recent : [];
            if (!recent.length) return;
            const section = $('recent-research-section');
            const list = $('recent-research-list');
            list.innerHTML = recent.map((item) => `
              <a class="chip" href="/dossier.html?symbol=${encodeURIComponent(item.symbol)}">
                ${esc(item.symbol)}${item.name ? ` — ${esc(item.name)}` : ''}
              </a>`).join('');
            section.hidden = false;
        } catch (_) { /* recent research is non-blocking */ }
    }
    mountRecentResearch();

    let lastRows = []; // for CSV export
    let portfolioActionBusy = false;
    let portfolioRefreshVersion = 0;

    // ---- multiple portfolios: switcher state ----
    // The selection is a UI preference ('all' | 'main' | portfolio id), not
    // data. Adds and imports always need a real target — "All" isn't one —
    // so they land in Main, with a visible hint, while the merged view is on.
    const PF_STORE_KEY = 'sp_pf_selection_v1';
    let pfList = [];
    let pfSelection = (() => { try { return localStorage.getItem(PF_STORE_KEY) || 'all'; } catch (_) { return 'all'; } })();
    const pfPersist = (v) => {
        pfSelection = v;
        try { localStorage.setItem(PF_STORE_KEY, v); } catch (_) { /* private mode */ }
    };
    const pfAdopted = () => pfList.length > 1; // Main + at least one created portfolio
    const pfCurrent = () => pfList.find((p) => String(p.id) === String(pfSelection));
    const pfScopeQuery = () => (DEMO || pfSelection === 'all') ? '' : `?portfolioId=${encodeURIComponent(pfSelection)}`;
    const pfTargetId = () => (pfSelection === 'all' ? 'main' : pfSelection);

    // ---- gain cells: % by default, $ on click ----
    const GAIN_FMT_KEY = 'sp_gain_fmt_v1';
    let gainFmt = (() => { try { return localStorage.getItem(GAIN_FMT_KEY) === 'usd' ? 'usd' : 'pct'; } catch (_) { return 'pct'; } })();
    const setGainFmt = (v) => {
        gainFmt = v;
        try { localStorage.setItem(GAIN_FMT_KEY, v); } catch (_) { /* private mode */ }
        syncGainMode();
    };
    // The % / $ chips in the GAIN header show the active mode at all times,
    // so the toggle is visible without hovering or guessing.
    function syncGainMode() {
        document.querySelectorAll('[data-gfmt]').forEach((btn) =>
            btn.setAttribute('aria-pressed', String(btn.dataset.gfmt === gainFmt)));
    }

    function setPortfolioControlsBusy(busy) {
        const form = $('add-form');
        if (form) form.querySelectorAll('input, button, select').forEach((control) => { control.disabled = busy; });
        ['pf-select', 'pf-new', 'pf-del'].forEach((id) => { const el = $(id); if (el) el.disabled = busy; });
        document.querySelectorAll('[data-del]').forEach((button) => { button.disabled = busy; });
    }

    function showPortfolioAction(title, detail) {
        portfolioActionBusy = true;
        setPortfolioControlsBusy(true);
        const overlay = $('portfolio-action-overlay');
        overlay.classList.remove('is-error');
        overlay.setAttribute('aria-busy', 'true');
        $('portfolio-action-spinner').hidden = false;
        $('portfolio-action-mark').hidden = true;
        $('portfolio-action-title').textContent = title;
        $('portfolio-action-detail').textContent = detail;
        overlay.hidden = false;
    }

    function finishPortfolioAction(message, { error = false, holdMs = 550 } = {}) {
        const overlay = $('portfolio-action-overlay');
        const status = $('portfolio-action-status');
        overlay.setAttribute('aria-busy', 'false');
        overlay.classList.toggle('is-error', error);
        $('portfolio-action-spinner').hidden = true;
        $('portfolio-action-mark').hidden = false;
        $('portfolio-action-mark').textContent = error ? '!' : '✓';
        $('portfolio-action-title').textContent = error ? 'Portfolio not changed' : 'Portfolio updated';
        $('portfolio-action-detail').textContent = message;
        status.textContent = message;
        status.className = `portfolio-action-status small ${error ? 'is-error' : 'is-success'}`;
        status.hidden = false;
        window.setTimeout(() => {
            overlay.hidden = true;
            overlay.classList.remove('is-error');
            portfolioActionBusy = false;
            setPortfolioControlsBusy(false);
        }, holdMs);
    }

    if (DEMO) {
        // Read-only sample: hide mutation UI, label clearly, sell quietly.
        $('pf-switcher').hidden = true;
        $('add-form').outerHTML = `
          <div class="card card-pad" style="max-width:380px;">
            <p class="label" style="margin-bottom:6px;">Demo portfolio</p>
            <p class="small muted" style="margin:0 0 12px;">A read-only sample. Choose a paid plan to build your own and unlock the look-through view, alerts and Ask.</p>
            <a class="btn btn-primary" href="/register.html">Choose a plan</a>
          </div>`;
    }

    // ---------- allocation doughnut + portfolio value line (the v1 charts,
    // reset into the paper/ink system: muted tonal palette, hairlines) ----
    const ALLOC_COLORS = ['#1c1b18', '#1a4fd6', '#1b7a4b', '#8a877e', '#6b86c8', '#b3a16e', '#5e5c55', '#9db8a0', '#c4b9a4', '#444239',
        '#3d6fd8', '#2c6b4f', '#7d7a70', '#8fa3d6', '#c8b98d', '#78766d', '#b1c6b5', '#a99e83', '#2e2d29', '#57806b'];
    function renderAllocation(rows) {
        const host = $('alloc-chart');
        const legend = $('alloc-legend');
        // Every holding gets its own slice — nothing is folded into an
        // "Other" bucket. The same ticker held in two portfolios merges into
        // one slice (sum of values) so the ring stays legible.
        const bySymbol = new Map();
        rows.filter((r) => (r.value || 0) > 0).forEach((r) => {
            bySymbol.set(r.symbol, (bySymbol.get(r.symbol) || 0) + r.value);
        });
        const slices = [...bySymbol.entries()].map(([symbol, value]) => ({ symbol, value })).sort((a, b) => b.value - a.value);
        const total = slices.reduce((a, s) => a + s.value, 0);
        // Clear the ring too: switching to an empty portfolio must not leave
        // the previous one's slices painted behind a hidden section.
        if (!slices.length || total <= 0) {
            host.innerHTML = '';
            legend.innerHTML = '';
            $('charts-section').hidden = true;
            return;
        }
        $('charts-section').hidden = false;
        const W = 220, R = 95, IR = 60, CX = W / 2, CY = W / 2;
        // Floor each fraction so a tiny slice still paints a visible arc,
        // then renormalise so the ring closes exactly.
        const fracs = slices.map((s) => Math.max(s.value / total, 0.006));
        const fracSum = fracs.reduce((a, f) => a + f, 0);
        let a0 = -Math.PI / 2;
        const arcs = slices.map((s, i) => {
            const frac = Math.min(0.9999, fracs[i] / fracSum);
            const a1 = a0 + frac * Math.PI * 2;
            const big = a1 - a0 > Math.PI ? 1 : 0;
            const p = (r, a) => `${(CX + r * Math.cos(a)).toFixed(2)} ${(CY + r * Math.sin(a)).toFixed(2)}`;
            const d = `M ${p(R, a0)} A ${R} ${R} 0 ${big} 1 ${p(R, a1)} L ${p(IR, a1)} A ${IR} ${IR} 0 ${big} 0 ${p(IR, a0)} Z`;
            a0 = a1;
            return `<path d="${d}" fill="${ALLOC_COLORS[i % ALLOC_COLORS.length]}" stroke="var(--paper)" stroke-width="2"><title>${esc(s.symbol)} · ${pct(s.value / total * 100)}</title></path>`;
        });
        host.innerHTML = `<svg viewBox="0 0 ${W} ${W}" style="width:100%; max-width:230px; height:auto; display:block; margin:0 auto;" role="img" aria-label="Allocation">
            ${arcs.join('')}
            <text x="${CX}" y="${CY - 4}" text-anchor="middle" font-size="10" fill="var(--ink-3)" font-weight="650" letter-spacing="0.08em">TOTAL</text>
            <text x="${CX}" y="${CY + 16}" text-anchor="middle" font-size="17" fill="var(--ink)" font-weight="650" style="font-variant-numeric:tabular-nums">$${money(total)}</text>
          </svg>`;
        legend.classList.toggle('is-scroll', slices.length > 12);
        legend.innerHTML = slices.map((s, i) => `
          <span style="display:flex; align-items:center; gap:8px; white-space:nowrap;">
            <i style="width:10px; height:10px; border-radius:3px; background:${ALLOC_COLORS[i % ALLOC_COLORS.length]}; display:inline-block;"></i>
            <b>${esc(s.symbol)}</b><span class="muted num">${pct(s.value / total * 100)}</span>
          </span>`).join('');
    }

    let perfRange = '3M';
    let perfWired = false;
    const perfSeries = { compact: null, full: null }; // outputsize -> {symbol: [{day, close}]}
    async function fetchDaily(symbols, outputsize) {
        const out = {};
        await Promise.all(symbols.map(async (sym) => {
            try {
                const url = `${API}${DEMO ? '/demo' : ''}/alpha/time-series/daily?symbol=${encodeURIComponent(sym)}&outputsize=${outputsize}`;
                const r = await fetch(url, { headers: auth });
                if (!r.ok) return;
                const ts = ((await r.json()) || {})['Time Series (Daily)'] || {};
                out[sym] = Object.keys(ts).sort().map((d) => ({ day: d, close: num(ts[d]['5. adjusted close']) ?? num(ts[d]['4. close']) }));
            } catch (_) { /* hole stays — aggregation forward-fills around it */ }
        }));
        return out;
    }
    function aggregate(rows, seriesBySym) {
        const days = [...new Set(Object.values(seriesBySym).flatMap((s) => s.map((p) => p.day)))].sort();
        const maps = {}; const last = {};
        for (const [sym, s] of Object.entries(seriesBySym)) maps[sym] = new Map(s.map((p) => [p.day, p.close]));
        return days.map((d) => {
            let total = 0;
            for (const r of rows) {
                const m = maps[r.symbol];
                if (!m) continue;
                if (m.has(d)) last[r.symbol] = m.get(d);
                if (last[r.symbol] != null) total += last[r.symbol] * r.shares;
            }
            return { day: d, value: total };
        }).filter((p) => p.value > 0);
    }
    function historyGaps(rows, seriesBySym) {
        return rows
            .filter((row) => !Array.isArray(seriesBySym[row.symbol]) || !seriesBySym[row.symbol].some((point) => Number.isFinite(point.close)))
            .map((row) => row.symbol);
    }
    function drawPerf(rows) {
        const data = (perfRange === '1Y' || perfRange === 'MAX') ? perfSeries.full : perfSeries.compact;
        if (!data) return;
        let series = aggregate(rows, data);
        const missingSymbols = historyGaps(rows, data);
        const currentTotal = rows.reduce((sum, row) => sum + (row.value || 0), 0);
        // A failed historical request must not silently remove a position from
        // the chart. Reconcile the final point to the same live total shown in
        // the headline and disclose which symbols lack history.
        if (series.length && currentTotal > 0) {
            series = series.slice();
            series[series.length - 1] = { ...series[series.length - 1], value: currentTotal };
        }
        const note = $('perf-note');
        if (note) {
            note.hidden = !missingSymbols.length;
            note.textContent = missingSymbols.length
                ? `Historical prices are unavailable for ${missingSymbols.join(', ')}. The latest chart point is reconciled to the current portfolio total; earlier points exclude those holdings.`
                : '';
        }
        const days = { '1M': 23, '3M': 64, '1Y': 253 }[perfRange];
        if (days && series.length > days) series = series.slice(-days);
        const hostEl = $('perf-chart');
        if (series.length < 2) { hostEl.innerHTML = '<p class="small faint" style="padding:40px 0; text-align:center;">Add a position to see performance.</p>'; return; }
        const up = series[series.length - 1].value >= series[0].value;
        const short = perfRange === '1M' || perfRange === '3M';
        let seen = '';
        const labels = series.map((p) => {
            const l = new Date(p.day + 'T12:00').toLocaleString('en-US', short ? { day: 'numeric', month: 'short' } : { month: 'short', year: '2-digit' });
            if (l === seen) return undefined;
            seen = l;
            return l;
        });
        hostEl.innerHTML = chart(
            [{ values: series.map((p) => p.value), cls: up ? 'pos' : 'neg' }],
            labels,
            { fmt: (v) => '$' + money(v), height: 250 }
        );
    }
    async function loadPerformance(rows) {
        const syms = rows.filter((r) => r.shares > 0 && r.symbol).map((r) => r.symbol);
        if (!syms.length) return;
        if (!perfSeries.compact) {
            // Create the store before awaiting so a concurrent add can merge its
            // one-symbol result instead of being overwritten by this first load.
            perfSeries.compact = {};
            Object.assign(perfSeries.compact, await fetchDaily(syms, 'compact'));
        }
        drawPerf(lastRows.length ? lastRows : rows);
        if (perfWired) return;
        perfWired = true;
        document.querySelectorAll('#perf-range button').forEach((b) =>
            b.addEventListener('click', async () => {
                document.querySelectorAll('#perf-range button').forEach((x) => x.setAttribute('aria-pressed', x === b));
                perfRange = b.dataset.r;
                if ((perfRange === '1Y' || perfRange === 'MAX') && !perfSeries.full) {
                    $('perf-chart').innerHTML = '<p style="padding:40px 0; text-align:center;"><span class="loading-line"><span class="spin"></span>Loading full history…</span></p>';
                    perfSeries.full = {};
                    Object.assign(perfSeries.full, await fetchDaily(lastRows.map((r) => r.symbol), 'full'));
                }
                drawPerf(lastRows);
            }));
    }

    // Free plan: portfolio APIs answer 402 — keep the session, swap the
    // portfolio surfaces for an upgrade card, leave the watchlist live.
    function freeMode() {
        const form = $('add-form');
        if (form) form.outerHTML = `
          <div class="card card-pad" style="max-width:420px;">
            <p class="label" style="margin-bottom:6px;">Free plan</p>
            <p class="small muted" style="margin:0 0 12px;">Your account needs a paid plan to track a portfolio with X-Ray, alerts and the weekly briefing.</p>
            <a class="btn btn-primary" href="/upgrade.html">Choose a plan</a>
          </div>`;
        $('pf-total').textContent = '—';
        $('pf-inception-gain').hidden = true;
        $('pf-sub').textContent = 'Portfolio tracking is part of the paid plans.';
        // The switcher creates and deletes portfolios; on a lapsed plan every
        // one of those calls 402s, so offering them reads as a broken page.
        const switcher = $('pf-switcher');
        if (switcher) switcher.hidden = true;
        ['holdings', 'charts-section', 'xray-section', 'alerts-section', 'rules-section', 'attrib-section', 'wash-section'].forEach((id) => {
            const el = $(id); if (el) el.hidden = true;
        });
        // Show a sample briefing so the feature is visible before subscribing.
        loadSampleBriefing();
    }

    async function loadSampleBriefing() {
        const section = $('brief-section');
        const body = $('brief-body');
        const sub = $('brief-sub');
        if (!section || !body) return;
        try {
            const r = await fetch(`${API}/portfolio/briefing/sample`);
            if (!r.ok) return;
            const data = await r.json();
            body.innerHTML = '<div class="ask-a">' + markdown(data.briefing || '') + '</div>'
                + '<div style="margin-top:12px;padding-top:12px;border-top:1px solid var(--line)">'
                + '<p class="small muted" style="margin:0 0 8px"><strong>Sample briefing</strong> — 5-stock demo portfolio. Subscribe to get your own weekly briefing.</p>'
                + '<a class="btn btn-primary btn-sm" href="/upgrade.html">Choose a plan →</a>'
                + '</div>';
            const share = document.createElement('div');
            mountShare(share, { title: 'Sample weekly portfolio briefing', text: data.briefing || '', url: location.href });
            body.appendChild(share);
            if (sub) sub.textContent = 'sample · 5-stock demo portfolio';
            section.hidden = false;
        } catch (_) { /* non-critical */ }
    }

    function holdingToRow(h) {
        const shares = num(h.shares) || 0;
        const current = num(h.currentPrice);
        const purchase = num(h.purchasePrice);
        const price = current !== null ? current : purchase;
        const value = price !== null ? shares * price : null;
        const gain = (price !== null && purchase !== null && purchase > 0) ? (price / purchase - 1) * 100 : null;
        const gainUsd = (gain === null || value === null) ? null : value - purchase * shares;
        return {
            id: h._id || h.id,
            symbol: (h.symbol || '').toUpperCase(),
            name: h.name || '',
            assetType: h.assetType || 'stock',
            shares,
            paid: purchase,
            price,
            value,
            gain,
            gainUsd
        };
    }

    // Both formats are precomputed at render; the toggle is a text swap, so
    // flipping a cell (or the whole column) never refetches anything.
    function gainCellHtml(row) {
        if (row.gain === null) return '<td>—</td>';
        const pctText = `${row.gain >= 0 ? '+' : ''}${row.gain.toFixed(1)}%`;
        const usdText = `${row.gainUsd >= 0 ? '+' : '−'}$${fixed(Math.abs(row.gainUsd), 2)}`;
        const cls = row.gain > 0 ? 'delta-pos' : row.gain < 0 ? 'delta-neg' : '';
        return `<td class="gain-cell ${cls}" data-pct="${esc(pctText)}" data-usd="${esc(usdText)}" data-on="${gainFmt}" title="Toggle between % and $">${gainFmt === 'usd' ? usdText : pctText}</td>`;
    }

    function renderHoldings(rows) {
        lastRows = rows;
        renderAllocation(rows);
        const total = rows.reduce((sum, row) => sum + (row.value || 0), 0);
        $('pf-total').textContent = '$' + fixed(total, 2);
        const inceptionGain = $('pf-inception-gain');
        const hasCompleteCostBasis = rows.length > 0 && rows.every((row) =>
            row.value !== null && row.paid !== null && row.paid > 0 && row.shares > 0);
        if (hasCompleteCostBasis) {
            const costBasis = rows.reduce((sum, row) => sum + row.paid * row.shares, 0);
            const gainAmount = total - costBasis;
            const gainPercent = costBasis > 0 ? (gainAmount / costBasis) * 100 : null;
            const sign = gainAmount > 0 ? '+' : gainAmount < 0 ? '−' : '';
            inceptionGain.textContent = `${sign}$${fixed(Math.abs(gainAmount), 2)}${gainPercent === null ? '' : ` (${sign}${fixed(Math.abs(gainPercent), 1)}%)`} since inception`;
            inceptionGain.className = `small portfolio-inception-gain ${gainAmount > 0 ? 'delta-pos' : gainAmount < 0 ? 'delta-neg' : ''}`;
            inceptionGain.hidden = false;
        } else {
            // A partial cost basis should never be presented as the portfolio's
            // lifetime return. Users can add the missing price paid to enable it.
            inceptionGain.hidden = true;
        }
        $('pf-sub').textContent = DEMO
            ? `${rows.length} holdings · demo data, read-only`
            : pfAdopted()
                ? (pfSelection === 'all'
                    ? `${rows.length} holdings · ${pfList.length} portfolios`
                    : `${rows.length} holdings · ${(pfCurrent() || {}).name || 'portfolio'}`)
                : `${rows.length} holdings · stored prices refresh through the day`;
        $('holdings-loading').hidden = true;

        if (!rows.length) {
            $('holdings-empty').hidden = false;
            $('holdings-empty-copy').innerHTML = (!DEMO && pfAdopted() && pfSelection !== 'all')
                ? `<strong>${esc((pfCurrent() || {}).name || 'This portfolio')} is empty.</strong> Add a holding with the form above, or import a CSV.`
                : `<strong>No holdings yet.</strong> Add a stock, ETF or mutual fund above — try <strong>AAPL</strong>, <strong>SPY</strong> or <strong>VTSAX</strong>.`;
            ['stock', 'etf', 'mutual'].forEach((key) => { $(`${key}-holdings-group`).hidden = true; });
            return;
        }
        $('holdings-empty').hidden = true;

        const rowHtml = (row) => `
          <tr>
            <td class="row-head"><a href="/company.html?symbol=${esc(row.symbol)}"><strong>${esc(row.symbol)}</strong></a>&ensp;<span class="muted small">${esc(row.name)}</span></td>
            <td>${fixed(row.shares, row.shares % 1 ? 2 : 0)}</td>
            <td>${row.paid === null ? '—' : '$' + fixed(row.paid, 2)}</td>
            <td>${row.price === null ? '—' : '$' + fixed(row.price, 2)}</td>
            <td>${row.value === null ? '—' : '$' + fixed(row.value, 2)}</td>
            <td>${total > 0 && row.value !== null ? pct(row.value / total * 100) : '—'}</td>
            ${gainCellHtml(row)}
            <td>${DEMO ? '' : `<button class="btn btn-quiet btn-sm" data-del="${esc(row.id)}" aria-label="Remove ${esc(row.symbol)}">Remove</button>`}</td>
          </tr>`;
        const groups = {
            stock: rows.filter((row) => row.assetType !== 'etf' && row.assetType !== 'mutual_fund'),
            etf: rows.filter((row) => row.assetType === 'etf'),
            mutual: rows.filter((row) => row.assetType === 'mutual_fund')
        };
        Object.entries(groups).forEach(([key, holdings]) => {
            const group = $(`${key}-holdings-group`);
            group.hidden = !holdings.length;
            $(`${key}-holdings-count`).textContent = `${holdings.length} ${holdings.length === 1 ? 'holding' : 'holdings'}`;
            $(`${key}-holdings-body`).innerHTML = holdings.map(rowHtml).join('');
        });
        document.querySelectorAll('[data-del]').forEach((button) =>
            button.addEventListener('click', () => removeHolding(button)));
        setPortfolioControlsBusy(portfolioActionBusy);
    }

    async function refreshPerformanceForMutation(symbols, removed) {
        const list = Array.isArray(symbols) ? symbols : [symbols];
        if (removed) {
            list.forEach((symbol) => {
                if (perfSeries.compact) delete perfSeries.compact[symbol];
                if (perfSeries.full) delete perfSeries.full[symbol];
            });
            if (lastRows.length) drawPerf(lastRows);
            return;
        }
        const compact = await fetchDaily(list, 'compact');
        perfSeries.compact = perfSeries.compact || {};
        Object.assign(perfSeries.compact, compact);
        if (perfSeries.full) Object.assign(perfSeries.full, await fetchDaily(list, 'full'));
        drawPerf(lastRows);
    }

    async function refreshPortfolioInBackground(symbol, { removed = false } = {}) {
        const version = ++portfolioRefreshVersion;
        const status = $('portfolio-action-status');
        status.textContent = 'Holding saved · refreshing performance and analysis in the background…';
        status.className = 'portfolio-action-status small';
        status.hidden = false;
        await Promise.allSettled([
            refreshPerformanceForMutation(symbol, removed),
            loadXray(),
            loadAttribution(),
            loadBriefing()
        ]);
        if (version === portfolioRefreshVersion) {
            status.textContent = 'Portfolio value, performance and analysis are up to date.';
            status.className = 'portfolio-action-status small is-success';
        }
    }

    // Deleting a holding is irreversible and used to fire on a single click
    // (D3). Confirm in the shared dialog first — window.confirm is the
    // fallback when app.js hasn't mounted for any reason.
    function confirmRemoveHolding(symbol) {
        if (!window.V2 || !V2.modal) return Promise.resolve(window.confirm(`Remove ${symbol} from your portfolio? This cannot be undone.`));
        return new Promise((resolve) => {
            V2.modal({
                label: 'Remove holding',
                title: `Remove ${symbol}?`,
                body: `${symbol} will be removed from your portfolio. This cannot be undone.`,
                actions: [
                    { label: 'Remove', primary: true, onClick: () => resolve(true) },
                    { label: 'Keep', onClick: () => resolve(false) }
                ],
                onDismiss: () => resolve(false)
            });
        });
    }

    async function removeHolding(button) {
        if (portfolioActionBusy) return;
        const id = button.dataset.del;
        const savedRow = lastRows.find((row) => String(row.id) === String(id));
        const symbol = savedRow ? savedRow.symbol : 'Holding';
        if (!await confirmRemoveHolding(symbol)) return;
        showPortfolioAction(`Removing ${symbol}`, 'Updating your saved holdings…');
        try {
            const response = await fetch(`${API}/portfolio/${id}`, { method: 'DELETE', headers: auth });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.message || `Couldn’t remove ${symbol}.`);
            }
            renderHoldings(lastRows.filter((row) => String(row.id) !== String(id)));
            finishPortfolioAction(`${symbol} was removed. Charts and analysis will finish refreshing in the background.`);
            // Counts feed the switcher labels and the delete modal's "and its N
            // holdings" line, which must never quote a stale number.
            void loadPortfolios();
            void refreshPortfolioInBackground(symbol, { removed: true });
        } catch (error) {
            finishPortfolioAction(error.message || `${symbol} could not be removed. Please try again.`, { error: true, holdMs: 2200 });
        }
    }

    async function refreshLiveHoldingPrices(version) {
        try {
            const response = await fetch(`${API}/portfolio${pfScopeQuery()}`, { headers: auth });
            if (!response.ok) return;
            const list = await response.json();
            // Do not let a response started before a mutation overwrite the
            // confirmed add/remove that is already visible in the table.
            if (version !== portfolioRefreshVersion) return;
            renderHoldings((Array.isArray(list) ? list : []).map(holdingToRow));
        } catch (_) { /* stored prices remain usable */ }
    }

    // ---- multiple portfolios: switcher, create, delete ----
    async function loadPortfolios() {
        if (DEMO) return;
        try {
            const r = await fetch(`${API}/portfolios`, { headers: auth });
            if (!r.ok) return;
            const data = await r.json();
            pfList = Array.isArray(data.portfolios) ? data.portfolios : [];
            renderPortfolios();
        } catch (_) { /* the page works without the switcher */ }
    }

    function renderPortfolios() {
        const select = $('pf-select');
        if (!select) return;
        // Before adoption only "+ New" shows — users who never touch the
        // feature keep today's screen (spec: zero visible change).
        const adopted = pfAdopted();
        select.hidden = !adopted;
        if (!['all', ...pfList.map((p) => String(p.id))].includes(String(pfSelection))) pfPersist('all');
        const totalHoldings = pfList.reduce((a, p) => a + (p.holdingsCount || 0), 0);
        select.innerHTML = [
            `<option value="all">All portfolios${adopted ? ` · ${totalHoldings}` : ''}</option>`,
            ...pfList.map((p) => `<option value="${esc(String(p.id))}">${esc(p.name)} · ${p.holdingsCount || 0}</option>`),
            // 🧪 beta-only entry; 'ai-portfolio' is a view, not a portfolio id
            // — the change handler routes it to the experiment section. The
            // option exists only once the portfolio does: display-only, no
            // setup entry point on the dashboard.
            ...(aiPaperBeta && aiPaperBeta.state.exists ? [`<option value="ai-portfolio">🧪 AI Paper Portfolio ★</option>`] : [])
        ].join('');
        select.value = aiPaperView ? 'ai-portfolio' : String(pfSelection);
        const del = $('pf-del');
        if (del) {
            del.hidden = pfSelection === 'all';
            del.setAttribute('aria-label', `Delete ${(pfCurrent() || {}).name || 'portfolio'}`);
        }
        // "All" isn't a portfolio — adds land in Main, and the hint says so.
        const hint = $('pf-add-target');
        if (hint) {
            hint.hidden = !(adopted && pfSelection === 'all');
            hint.textContent = '→ Main';
        }
    }

    // Every switch (and every scope-affecting mutation) funnels through here:
    // scoped holdings + scoped analysis. Alerts, rules, wash-sale, watchlist
    // and Ask stay whole-account on purpose — safety features watch
    // everything you own.
    async function applyScope() {
        // Refresh the list first: if the selected portfolio was deleted in
        // another tab, renderPortfolios() resets the selection to All, and the
        // fetches below then scope correctly instead of querying a dead id and
        // rendering a permanently empty dashboard.
        if (!DEMO) await loadPortfolios();
        else renderPortfolios();
        loadHoldings();
        if (!DEMO) { loadXray(); loadAttribution(); loadBriefing(); }
    }

    function promptNewPortfolio() {
        const dialog = V2.modal({
            label: 'New portfolio',
            title: 'New portfolio',
            bodyHtml: `
              <div style="text-align:left; display:grid; gap:8px;">
                <label class="field" style="text-align:left;"><span>Name</span>
                  <input class="input" id="pf-new-name" maxlength="40" placeholder="e.g. Robinhood fun money" /></label>
                <p class="small muted" style="margin:0; text-align:left;">1–40 characters. It starts empty and becomes your active portfolio.</p>
                <p class="small" id="pf-new-msg" role="status" style="margin:0; text-align:left; color:var(--neg);"></p>
              </div>`,
            actions: [
                { label: 'Cancel' },
                { label: 'Create', primary: true, close: false, onClick: (close) => { void guardModalAction(() => createPortfolio(close)); } }
            ]
        });
        const input = dialog.el.querySelector('#pf-new-name');
        if (input) input.focus();
    }

    // Modal action buttons live outside #add-form, so setPortfolioControlsBusy
    // cannot reach them. Without this, a slow create/delete/import stays
    // clickable and a second click repeats the whole mutation.
    let pfModalBusy = false;
    async function guardModalAction(fn) {
        if (pfModalBusy) return;
        pfModalBusy = true;
        try { await fn(); } finally { pfModalBusy = false; }
    }

    async function createPortfolio(close) {
        const name = $('pf-new-name').value.trim();
        const msg = $('pf-new-msg');
        if (!name || name.length > 40) { msg.textContent = 'Name must be 1–40 characters.'; return; }
        msg.textContent = '';
        try {
            const r = await fetch(`${API}/portfolios`, {
                method: 'POST',
                headers: { ...auth, 'Content-Type': 'application/json' },
                body: JSON.stringify({ name })
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) {
                // A plan limit is actionable, unlike the other failures here —
                // give it the same upgrade link the add form uses on 402.
                if (r.status === 402) msg.innerHTML = `${esc(data.message || 'Your plan does not include more portfolios.')} <a href="/upgrade.html">See plans</a>`;
                else msg.textContent = data.message || 'Could not create the portfolio.';
                return;
            }
            close();
            pfPersist(data.portfolio.id);
            await applyScope(); // refreshes the list itself

        } catch (_) { msg.textContent = 'Network problem — try again.'; }
    }

    function promptDeletePortfolio() {
        const p = pfCurrent();
        if (!p || String(p.id) === 'main') return;
        V2.modal({
            label: 'Delete portfolio',
            title: `Delete ${p.name}?`,
            body: `Delete '${p.name}' and its ${p.holdingsCount} holding${p.holdingsCount === 1 ? '' : 's'}? This cannot be undone.`,
            actions: [
                { label: 'Keep' },
                { label: 'Delete', primary: true, close: false, onClick: (close) => { void guardModalAction(() => deletePortfolio(p, close)); } }
            ]
        });
    }

    async function deletePortfolio(p, close) {
        showPortfolioAction(`Deleting ${p.name}`, 'Removing the portfolio and its holdings…');
        try {
            const r = await fetch(`${API}/portfolios/${encodeURIComponent(p.id)}`, { method: 'DELETE', headers: auth });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) throw new Error(data.message || `Couldn’t delete ${p.name}.`);
            close();
            pfPersist('all');
            // Chart history is scoped to whatever holdings exist now; a fresh
            // fetch is cheaper than pruning the deleted portfolio's symbols.
            perfSeries.compact = null; perfSeries.full = null;
            await Promise.allSettled([loadPortfolios(), loadHoldings()]);
            loadXray(); loadAttribution(); loadBriefing();
            const removed = data.removedHoldings ?? p.holdingsCount;
            finishPortfolioAction(`${p.name} and its ${removed} holding${removed === 1 ? '' : 's'} were deleted. Holdings in other portfolios are untouched.`);
        } catch (error) {
            close();
            finishPortfolioAction(error.message || `Couldn’t delete ${p.name}.`, { error: true, holdMs: 2400 });
        }
    }

    function wirePortfolioSwitcher() {
        const select = $('pf-select');
        const newBtn = $('pf-new');
        const delBtn = $('pf-del');
        if (!select || !newBtn || !delBtn) return;
        select.addEventListener('change', () => {
            // 🧪 the experiment view is transient: never persisted as a scope
            // (it owns no holdings), and leaving it restores the real scope.
            if (select.value === 'ai-portfolio') { showAiPaperView(); return; }
            hideAiPaperView();
            pfPersist(select.value); applyScope();
        });
        newBtn.addEventListener('click', promptNewPortfolio);
        delBtn.addEventListener('click', promptDeletePortfolio);
    }

    // ---- CSV import: file → server parses → preview → commit ----
    // Nothing is written until the preview is confirmed; the commit re-parses
    // the same text so what lands is authoritative even if holdings changed
    // between the two steps.
    function wireCsvImport() {
        const btn = $('pf-import');
        if (!btn || DEMO) return;
        btn.addEventListener('click', openCsvImport);
    }

    function openCsvImport() {
        let csvText = '';
        let targetId = pfTargetId();
        const targetName = () => (pfList.find((p) => String(p.id) === String(targetId)) || {}).name || 'portfolio';

        V2.modal({
            label: 'Import CSV',
            title: 'Import holdings from a CSV',
            bodyHtml: `
              <div style="text-align:left; display:grid; gap:12px;">
                <label class="field"><span>Import into</span>
                  <select class="input" id="pf-import-target">${pfList.map((p) =>
                    `<option value="${esc(String(p.id))}"${String(p.id) === String(targetId) ? ' selected' : ''}>${esc(p.name)} (${p.holdingsCount || 0})</option>`).join('')}</select>
                </label>
                <label class="field"><span>CSV file</span>
                  <input class="input" type="file" id="pf-import-file" accept=".csv,text/csv" /></label>
                <p class="small muted" style="margin:0;">Expected columns: ticker, quantity, purchase price, purchase date — broker export names are recognised. Repeated tickers merge into one holding. Nothing is saved until you confirm the preview.</p>
                <p class="small" id="pf-import-msg" role="status" style="margin:0; color:var(--neg);"></p>
              </div>`,
            actions: [
                { label: 'Cancel' },
                { label: 'Preview', primary: true, close: false, onClick: (close) => { void guardModalAction(() => previewStep(close)); } }
            ]
        });

        async function previewStep(close) {
            const msg = $('pf-import-msg');
            const fileInput = $('pf-import-file');
            const file = fileInput && fileInput.files[0];
            if (!file) { msg.textContent = 'Choose a CSV file first.'; return; }
            if (file.size > 4 * 1024 * 1024) { msg.textContent = 'CSV too large (4MB max).'; return; }
            targetId = $('pf-import-target').value;
            msg.textContent = 'Parsing…';
            try {
                csvText = await file.text();
                const r = await fetch(`${API}/portfolio/import/preview`, {
                    method: 'POST',
                    headers: { ...auth, 'Content-Type': 'application/json' },
                    // The target decides which rows say "merges with existing";
                    // omitting it silently previews against Main instead.
                    body: JSON.stringify({ csv: csvText, portfolioId: targetId })
                });
                const data = await r.json().catch(() => ({}));
                if (!r.ok) { msg.textContent = data.message || 'Could not read that CSV.'; return; }
                if (!data.rows || !data.rows.length) {
                    msg.textContent = 'No importable rows found.' + (data.skipped && data.skipped.length ? ` ${data.skipped.length} row${data.skipped.length === 1 ? '' : 's'} would be skipped.` : '');
                    return;
                }
                close();
                showImportPreview(data);
            } catch (_) { msg.textContent = 'Network problem — try again.'; }
        }

        function showImportPreview(data) {
            const rows = data.rows || [];
            const skipped = data.skipped || [];
            const bodyRows = rows.map((r) => `
              <tr>
                <td class="row-head" style="text-align:left;"><strong>${esc(r.symbol)}</strong>${r.merges ? ' <span class="chip">merges with existing</span>' : ''}</td>
                <td>${fixed(r.shares, r.shares % 1 ? 2 : 0)}</td>
                <td>${r.price > 0 ? '$' + fixed(r.price, 2) : '—'}</td>
                <td>${r.purchaseDate ? esc(r.purchaseDate) : 'today'}</td>
              </tr>`).join('');
            const skipHtml = skipped.length
                ? `<div class="notice notice-neg" style="margin:12px 0 0;">${skipped.map((s) => `! Row ${s.line} — ${esc(s.reason)} → skipped`).join('<br>')}</div>`
                : '';
            const mergeNote = data.mergeNote ? `<p class="small muted" style="margin:10px 0 0;">${esc(data.mergeNote)}</p>` : '';
            V2.modal({
                label: 'Import CSV preview',
                title: `Import ${rows.length} holding${rows.length === 1 ? '' : 's'} into ${targetName()}`,
                bodyHtml: `
                  <div class="pf-import-preview" style="text-align:left;">
                    <div class="table-wrap"><table class="table-data">
                      <thead><tr><th class="row-head" style="text-align:left;">Symbol</th><th>Units</th><th>Price paid</th><th>Purchased</th></tr></thead>
                      <tbody>${bodyRows}</tbody>
                    </table></div>
                    ${skipHtml}
                    ${mergeNote}
                  </div>`,
                actions: [
                    { label: 'Cancel' },
                    { label: `Import ${rows.length} holding${rows.length === 1 ? '' : 's'}`, primary: true, close: false, onClick: (close) => { void guardModalAction(() => commitImport(close)); } }
                ]
            });
        }

        async function commitImport(close) {
            showPortfolioAction('Importing holdings', 'Saving the parsed rows…');
            try {
                const r = await fetch(`${API}/portfolio/import/commit`, {
                    method: 'POST',
                    headers: { ...auth, 'Content-Type': 'application/json' },
                    body: JSON.stringify({ csv: csvText, portfolioId: targetId })
                });
                const data = await r.json().catch(() => ({}));
                if (!r.ok) throw new Error(data.message || 'Import failed — nothing was saved.');
                close();
                perfSeries.compact = null; perfSeries.full = null;
                await Promise.allSettled([loadPortfolios(), loadHoldings()]);
                loadXray(); loadAttribution(); loadBriefing();
                const bits = [`${data.imported} imported`];
                if (data.merged) bits.push(`${data.merged} merged with existing`);
                if (data.skipped) bits.push(`${data.skipped} skipped`);
                const unknown = data.unknownSymbols || [];
                if (unknown.length) bits.push(`unknown ticker${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
                finishPortfolioAction(`${bits.join(' · ')}. Charts and analysis will finish refreshing in the background.`);
            } catch (error) {
                close();
                finishPortfolioAction(error.message || 'Import failed — nothing was saved.', { error: true, holdMs: 2600 });
            }
        }
    }

    // ---- gain toggle wiring (once: the cells are re-rendered per row, but
    // the containers and column headers they live in are not) ----
    function wireGainToggles() {
        ['stock', 'etf', 'mutual'].forEach((key) => {
            const body = $(`${key}-holdings-body`);
            if (!body) return;
            body.addEventListener('click', (e) => {
                const cell = e.target.closest('td.gain-cell');
                if (!cell) return;
                const to = cell.dataset.on === 'usd' ? 'pct' : 'usd';
                cell.dataset.on = to;
                cell.textContent = to === 'usd' ? cell.dataset.usd : cell.dataset.pct;
            });
        });
        document.querySelectorAll('th.gain-th').forEach((th) =>
            th.addEventListener('click', () => {
                setGainFmt(gainFmt === 'usd' ? 'pct' : 'usd');
                if (lastRows.length) renderHoldings(lastRows);
            }));
        // The explicit % / $ chips: click the format you want (and don't let
        // the click bubble into the whole-header toggle on top of it).
        document.querySelectorAll('[data-gfmt]').forEach((btn) =>
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                setGainFmt(btn.dataset.gfmt);
                if (lastRows.length) renderHoldings(lastRows);
            }));
        syncGainMode();
    }

    async function loadHoldings() {
        try {
            const r = await fetch(DEMO ? `${API}/demo/portfolio` : `${API}/portfolio${pfScopeQuery()}`, { headers: auth });
            if (!DEMO && r.status === 401) { await fetch('/api/logout', { method: 'POST' }).catch(() => {}); location.reload(); return; }
            if (!DEMO && r.status === 402) { freeMode(); return; }
            // A malformed scope is rejected outright; a deleted-but-well-formed
            // id instead matches nothing and returns 200 with an empty list, so
            // that case self-heals in renderPortfolios() rather than here.
            if (!DEMO && r.status === 400 && pfSelection !== 'all') {
                pfPersist('all');
                await loadPortfolios();
                return loadHoldings();
            }
            if (!r.ok) {
                const data = await r.json().catch(() => ({}));
                throw new Error(data.message || 'Unable to load the portfolio right now.');
            }
            const list = await r.json();
            const rows = (Array.isArray(list) ? list : []).map(holdingToRow);
            renderHoldings(rows);
            loadPerformance(rows);
            return true;
        } catch (_) {
            $('holdings-empty').hidden = true;
            ['stock', 'etf', 'mutual'].forEach((key) => { $(`${key}-holdings-group`).hidden = true; });
            $('holdings-loading').innerHTML = '<p class="small" style="margin:0; color:var(--neg);">Couldn’t load holdings. Refresh the page to try again.</p>';
            $('holdings-loading').hidden = false;
            return false;
        }
    }

    async function loadXray() {
        try {
            const r = await fetch(`${API}/portfolio/xray${pfScopeQuery()}`, { headers: auth });
            if (!r.ok) return;
            const x = await r.json();
            if (!x || !x.lookThrough) {
                $('xray-section').hidden = true;
                $('xray-strip').innerHTML = '';
                $('xray-flags').innerHTML = '';
                return;
            }
            const m = x.lookThrough;
            const cells = [
                ['Look-through P/E', fixed(m.peRatio, 1)],
                ['Net margin', pct(m.netMarginPct)],
                ['Revenue growth', pct(m.revCagr5Pct)],
                ['Return on equity', pct(m.roePct)],
                ['Dividend yield', m.divYieldPct === null || m.divYieldPct === undefined ? '—' : pct(m.divYieldPct, 2)],
                ['Health pass rate', pct(m.healthPassPct, 0)]
            ].filter(([, v]) => v !== '—');
            $('xray-strip').innerHTML = cells.map(([l, v]) =>
                `<div class="kpi"><span class="label">${l}</span><span class="kpi-value" style="font-size:24px;">${v}</span></div>`).join('');
            const flags = [];
            const fundPositions = (x.positions || []).filter((h) => ['etf', 'mutual_fund'].includes(h.assetType));
            if (fundPositions.length) {
                flags.push('<div class="notice">ETF and mutual-fund positions are included in portfolio value, allocation and concentration. Company-only fundamental averages exclude them.</div>');
            }
            if (x.concentration && x.concentration.topHoldingPct > 30) {
                flags.push(`<div class="notice">${esc(x.concentration.topHolding)} is ${x.concentration.topHoldingPct.toFixed(0)}% of the portfolio — concentration is your biggest single risk.</div>`);
            }
            (x.positions || []).forEach((h) => {
                if (Array.isArray(h.healthFails) && h.healthFails.length >= 3) {
                    flags.push(`<div class="notice notice-neg"><strong>${esc(h.symbol)}</strong> fails ${h.healthFails.length} health checks: ${esc(h.healthFails.slice(0, 3).join(', '))}${h.healthFails.length > 3 ? '…' : ''}</div>`);
                }
            });
            $('xray-flags').innerHTML = flags.join('');
            $('xray-section').hidden = false;
        } catch (_) { /* x-ray is enrichment, not critical */ }
    }

    // ---- why it moved today: per-holding contribution + headlines (Pro) ----
    async function loadAttribution() {
        try {
            const r = await fetch(`${API}/portfolio/attribution${pfScopeQuery()}`, { headers: auth });
            if (!r.ok) return; // 402 (not Pro) or transient — section stays hidden
            const d = await r.json();
            if (d.empty || d.portfolioDayPct === null || d.portfolioDayPct === undefined) {
                $('attrib-section').hidden = true;
                $('attrib-body').innerHTML = '';
                $('attrib-sub').textContent = '';
                return;
            }
            const sign = d.portfolioDayPct >= 0 ? '+' : '';
            const cls = d.portfolioDayPct > 0 ? 'delta-pos' : d.portfolioDayPct < 0 ? 'delta-neg' : '';
            $('attrib-sub').textContent = `as of ${d.asOf}${d.coveragePct < 95 ? ` · quotes cover ${d.coveragePct}% of value` : ''}`;
            const maxAbs = Math.max(...d.movers.map((m) => Math.abs(m.contributionPct || 0)), 0.01);
            const rows = d.movers.filter((m) => m.contributionPct !== null).slice(0, 6).map((m) => {
                const w = Math.round(Math.abs(m.contributionPct) / maxAbs * 100);
                const mc = m.contributionPct > 0 ? 'var(--pos)' : 'var(--neg)';
                const head = (m.headlines && m.headlines[0])
                    ? `<div class="small muted" style="margin-top:2px;">${esc(m.headlines[0].title)}${m.headlines[0].url ? ` <a href="${esc(m.headlines[0].url)}" rel="noopener" target="_blank">↗</a>` : ''}</div>`
                    : '';
                return `<div style="display:grid; grid-template-columns: 70px 1fr auto; gap:10px; align-items:start; padding:6px 0; border-bottom:1px solid var(--line);">
                  <a href="/company.html?symbol=${esc(m.symbol)}"><strong>${esc(m.symbol)}</strong></a>
                  <div><div style="height:6px; width:${w}%; min-width:2px; background:${mc}; border-radius:3px; margin-top:6px;"></div>${head}</div>
                  <span class="num small" style="text-align:right;">${m.dayPct >= 0 ? '+' : ''}${m.dayPct}% day<br /><span class="faint">${m.contributionPct >= 0 ? '+' : ''}${m.contributionPct} pts of yours</span></span>
                </div>`;
            }).join('');
            $('attrib-body').innerHTML = `
              <p style="margin:0 0 10px; font-size:20px; font-weight:650;" class="${cls}">${sign}${d.portfolioDayPct}% today${d.portfolioDayUsd !== null ? ` <span class="small muted" style="font-weight:400;">(${d.portfolioDayUsd >= 0 ? '+' : '−'}$${money(Math.abs(d.portfolioDayUsd))})</span>` : ''}</p>
              ${d.narrative ? `<p class="small" style="max-width:74ch; margin:0 0 12px;">${esc(d.narrative)}</p>` : ''}
              <div>${rows}</div>
              <p class="provenance" style="margin-top:10px;">${esc(d.note || '')}</p>`;
            $('attrib-section').hidden = false;
        } catch (_) { /* enrichment */ }
    }

    async function loadAlerts() {
        try {
            const r = await fetch(`${API}/alerts`, { headers: auth });
            if (!r.ok) return;
            const data = await r.json();
            const alerts = (data.alerts || []).slice(0, 8);
            if (!alerts.length) return;
            $('alerts-sub').textContent = data.unseen ? `${data.unseen} unread` : 'up to date';
            $('alerts-list').innerHTML = alerts.map((a) => {
                const cls = a.type === 'health-flip' ? (String(a.title || '').includes('PASS') ? 'notice-pos' : 'notice-neg')
                    : a.type === 'insider-cluster' ? 'notice-pos'
                    : a.type === 'dividend-risk' ? 'notice-neg'
                    : '';
                const when = a.createdAt ? new Date(a.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
                const href = safeAlertUrl(a.url);
                const filingLink = a.type === 'filing';
                const cta = filingLink ? 'View filing on SEC EDGAR ↗' : a.type === 'filing-diff' ? 'View filing analysis →' : 'View details →';
                const content = `<strong>${esc(a.symbol)}</strong> — ${esc(a.title)}${href ? `<span class="alert-link-meta small"><span>${esc(a.detail || '')}</span><span class="alert-link-cta">${cta}</span></span>` : `<span class="faint small" style="float:right">${when}</span>`}${href && when ? `<span class="faint small" style="display:block; margin-top:4px;">${when}</span>` : ''}`;
                return href
                    ? `<a class="notice alert-link ${cls}" href="${esc(href)}"${filingLink ? ' target="_blank" rel="noopener noreferrer"' : ''}>${content}</a>`
                    : `<div class="notice ${cls}">${content}</div>`;
            }).join('');
            $('alerts-section').hidden = false;
            fetch(`${API}/alerts/seen`, { method: 'POST', headers: auth }).catch(() => {});
        } catch (_) { /* quiet */ }
    }

    // Alert URLs come from server-side SEC and first-party routes. Still
    // validate before putting a database value into href, so an old or malformed
    // alert can never turn the dashboard into an unsafe link.
    function safeAlertUrl(raw) {
        if (!raw) return '';
        try {
            const url = new URL(String(raw), location.origin);
            const internal = url.origin === location.origin;
            const sec = url.protocol === 'https:' && (url.hostname === 'www.sec.gov' || url.hostname === 'sec.gov');
            return internal || sec ? url.href : '';
        } catch (_) { return ''; }
    }

    // ---- alert rules (Pro): valuation thresholds checked on the sweep ----
    const RULE_METRIC = { pe: 'P/E', divYieldPct: 'dividend yield %', marketCapB: 'market cap ($B)', revCagr5Pct: 'revenue CAGR 5y %' };
    async function loadRules() {
        try {
            const r = await fetch(`${API}/alert-rules`, { headers: auth });
            if (r.status === 402) return; // not Pro — section stays hidden
            if (!r.ok) return;
            const data = await r.json();
            const rules = data.rules || [];
            $('rules-list').innerHTML = rules.length ? rules.map((x) => `
              <div class="notice" style="display:flex; justify-content:space-between; align-items:center; gap:10px;">
                <span><strong>${esc(x.symbol)}</strong> — ${esc(RULE_METRIC[x.metric] || x.metric)} ${x.op === 'lt' ? 'drops below' : 'rises above'} ${esc(String(x.value))}
                  ${x.armed ? '' : '<span class="faint small">(fired — re-arms when it reverses)</span>'}</span>
                <button class="btn btn-quiet btn-sm" data-rule-del="${esc(String(x._id))}">Remove</button>
              </div>`).join('')
                : '<p class="small faint" style="margin:0;">No rules yet — add one below, e.g. “AAPL P/E drops below 25”.</p>';
            $('rules-section').hidden = false;
            document.querySelectorAll('[data-rule-del]').forEach((b) =>
                b.addEventListener('click', async () => {
                    await fetch(`${API}/alert-rules/${b.dataset.ruleDel}`, { method: 'DELETE', headers: auth }).catch(() => {});
                    loadRules();
                }));
        } catch (_) { /* enrichment */ }
    }
    $('rule-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = $('rule-msg');
        msg.textContent = '';
        try {
            const r = await fetch(`${API}/alert-rules`, {
                method: 'POST',
                headers: { ...auth, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    symbol: $('rule-sym').value.trim().toUpperCase(),
                    metric: $('rule-metric').value,
                    op: $('rule-op').value,
                    value: Number($('rule-val').value)
                })
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) { msg.textContent = data.message || 'Could not add the rule.'; return; }
            $('rule-sym').value = ''; $('rule-val').value = '';
            loadRules();
        } catch (_) { msg.textContent = 'Network problem — try again.'; }
    });

    // ---- wash-sale guard (Pro): cross-account tax-lot intelligence ----
    async function loadWash() {
        try {
            const r = await fetch(`${API}/tax/accounts`, { headers: auth });
            if (r.status === 402 || !r.ok) return; // not Pro — stays hidden
            const data = await r.json();
            const accounts = data.accounts || [];
            $('wash-section').hidden = false;
            $('wash-accounts').innerHTML = accounts.length
                ? 'Imported: ' + accounts.map((a) =>
                    `<span class="chip">${esc(a.account)} (${esc(a.accountType)}, ${a.trades} trades) <a href="#" data-wash-del="${encodeURIComponent(a.account)}" aria-label="Remove ${esc(a.account)}">✕</a></span>`).join(' ')
                : 'No accounts imported yet — start with your most active broker.';
            document.querySelectorAll('[data-wash-del]').forEach((b) =>
                b.addEventListener('click', async (e) => {
                    e.preventDefault();
                    await fetch(`${API}/tax/accounts/${b.dataset.washDel}`, { method: 'DELETE', headers: auth }).catch(() => {});
                    loadWash();
                }));
            if (!accounts.length) { $('wash-report').innerHTML = ''; return; }
            const rep = await (await fetch(`${API}/tax/wash-sales`, { headers: auth })).json();
            const f = rep.findings || [];
            $('wash-report').innerHTML = f.length ? (
                `<p class="small" style="margin:0;"><strong>${f.length} wash sale${f.length > 1 ? 's' : ''} detected</strong> — about $${money(rep.totalDisallowedEstimate)} of losses disallowed.</p>` +
                f.slice(0, 10).map((x) => `
                  <div class="notice ${x.iraPoison ? 'notice-neg' : ''}">
                    <strong>${esc(x.symbol)}</strong> — sold ${x.sharesSold} sh at a $${money(Math.abs(x.loss))} loss on ${esc(x.sellDate)} (${esc(x.sellAccount)});
                    bought within 30 days in ${x.conflicts.map((c) => esc(c.account)).filter((v, i, a) => a.indexOf(v) === i).join(', ')} →
                    ~$${money(x.disallowedEstimate)} disallowed${x.iraPoison ? ' — <strong>IRA buy: this loss is permanently gone</strong>' : ' (rolls into the new shares’ basis)'}.
                  </div>`).join('')
            ) : '<p class="small muted" style="margin:0;">No wash sales found across your imported accounts. The pre-trade check below keeps it that way.</p>';
            if (rep.note) $('wash-report').innerHTML += `<p class="provenance" style="margin-top:6px;">${esc(rep.note)}</p>`;
        } catch (_) { /* enrichment */ }
    }
    $('wash-import').addEventListener('submit', async (e) => {
        e.preventDefault();
        const msg = $('wash-msg');
        const file = $('wash-file').files[0];
        if (!file) { msg.textContent = 'Choose a CSV file.'; return; }
        if (file.size > 4 * 1024 * 1024) { msg.textContent = 'CSV too large (4MB max).'; return; }
        msg.textContent = 'Importing…';
        try {
            const csv = await file.text();
            const r = await fetch(`${API}/tax/import`, {
                method: 'POST',
                headers: { ...auth, 'Content-Type': 'application/json' },
                body: JSON.stringify({ account: $('wash-acct').value, accountType: $('wash-type').value, csv })
            });
            const data = await r.json().catch(() => ({}));
            if (!r.ok) { msg.textContent = data.message || 'Import failed.'; return; }
            msg.textContent = `Imported ${data.imported} trades${data.skipped ? ` (${data.skipped} rows skipped)` : ''}.`;
            $('wash-file').value = '';
            loadWash();
        } catch (_) { msg.textContent = 'Network problem — try again.'; }
    });
    $('wash-check').addEventListener('submit', async (e) => {
        e.preventDefault();
        const out = $('wash-check-out');
        const sym = $('wash-check-sym').value.trim().toUpperCase();
        if (!sym) return;
        out.textContent = '…';
        try {
            const r = await fetch(`${API}/tax/wash-check?symbol=${encodeURIComponent(sym)}`, { headers: auth });
            const d = await r.json().catch(() => ({}));
            if (!r.ok) { out.textContent = d.message || 'Check failed.'; return; }
            out.innerHTML = d.wouldWash
                ? `<span class="delta-neg">⚠ Would wash${d.iraPoison ? ' — IRA buy in window: loss would be permanently disallowed' : ''}.</span> ${esc(d.recentBuys.map((b) => `${b.shares} sh bought ${b.date} in ${b.account}`).join('; '))}`
                : `<span class="delta-pos">✓ Clear.</span> ${esc(d.note)}`;
        } catch (_) { out.textContent = 'Network problem.'; }
    });

    // Ticker autocomplete on the portfolio add-input — same company list the nav
    // search uses; clicking a suggestion fills the ticker (doesn't navigate away).
    function wireTickerAutocomplete() {
        const input = $('add-sym');
        if (!input) return;
        const label = input.closest('label') || input.parentElement;
        label.style.position = 'relative';
        const box = document.createElement('div');
        box.className = 'sym-ac';
        box.hidden = true;
        label.appendChild(box);
        let items = [], active = -1;
        const render = () => {
            if (!items.length) { box.hidden = true; return; }
            box.innerHTML = items.map((c, i) =>
                `<button type="button" data-sym="${esc(c.symbol)}" class="${i === active ? 'is-active' : ''}"><span class="sym">${esc(c.symbol)}</span><span class="nm">${esc(c.name || '')}${c.assetType && c.assetType !== 'stock' ? ` · ${esc(c.assetTypeLabel || c.assetType)}` : ''}</span></button>`).join('');
            box.hidden = false;
        };
        const pick = (sym) => { input.value = sym; box.hidden = true; items = []; const sh = $('add-shares'); if (sh) sh.focus(); };
        input.addEventListener('input', async () => {
            const q = input.value.trim().toUpperCase();
            if (q.length < 1) { box.hidden = true; return; }
            items = await searchAssets(q, { limit: 8 }); active = -1; render();
        });
        input.addEventListener('keydown', (e) => {
            if (box.hidden) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); render(); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
            else if (e.key === 'Enter' && active >= 0) { e.preventDefault(); pick(items[active].symbol); }
            else if (e.key === 'Escape') { box.hidden = true; }
        });
        box.addEventListener('click', (e) => { const btn = e.target.closest('button[data-sym]'); if (btn) pick(btn.dataset.sym); });
        document.addEventListener('click', (e) => { if (e.target !== input && !box.contains(e.target)) box.hidden = true; });
    }
    wireTickerAutocomplete();

    // failures must be SEEN — a quiet form that eats errors reads as broken
    function noteAddError(msg, tone) {
        let el = $('add-error');
        if (!el) {
            el = document.createElement('p');
            el.id = 'add-error';
            el.className = 'small';
            el.style.cssText = 'grid-column: 1 / -1; margin:6px 0 0;';
            $('add-form').appendChild(el);
        }
        el.style.color = tone === 'pos' ? 'var(--pos)' : tone === 'mixed' ? 'var(--ink-2)' : 'var(--neg)';
        el.innerHTML = msg;
        el.hidden = !msg;
    }

    function clearAddInputs() {
        $('add-sym').value = ''; $('add-shares').value = ''; $('add-price').value = '';
        if ($('add-date')) $('add-date').value = '';
    }

    async function saveOneHolding(symbol, shared) {
        const r = await fetch(`${API}/portfolio`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...auth },
            body: JSON.stringify({ ...shared, symbol })
        });
        const saved = await r.json().catch(() => ({}));
        return { ok: r.ok, status: r.status, saved };
    }

    if (!DEMO) $('add-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (portfolioActionBusy) return;
        const symbols = $('add-sym').value.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
        const shares = Number($('add-shares').value);
        if (!symbols.length || !shares) return;
        const shared = { shares, portfolioId: pfTargetId() };
        const price = Number($('add-price').value);
        if (price > 0) shared.purchasePrice = price;
        shared.purchaseDate = ($('add-date') && $('add-date').value) || new Date().toISOString().slice(0, 10);

        if (symbols.length === 1) {
            const symbol = symbols[0];
            showPortfolioAction(`Adding ${symbol}`, 'Checking the ticker and saving the holding…');
            try {
                const { ok, status, saved } = await saveOneHolding(symbol, shared);
                if (!ok) {
                    const message = status === 402
                        ? 'Your subscription is not active. Choose a plan to add holdings.'
                        : (saved.message || `Couldn’t add ${symbol} — try again.`);
                    if (status === 402) noteAddError('Your subscription isn’t active — <a href="/upgrade.html">choose a plan</a> to add holdings.');
                    else noteAddError(esc(message));
                    finishPortfolioAction(message, { error: true, holdMs: 2200 });
                    return;
                }
                noteAddError('');
                clearAddInputs();
                if (saved && saved._id) renderHoldings([...lastRows, holdingToRow(saved)]);
                else if (!await loadHoldings()) throw new Error(`${symbol} was added, but the refreshed portfolio could not be loaded. Reload the page.`);
                finishPortfolioAction(`${symbol} was added. Charts and analysis will finish refreshing in the background.`);
                void loadPortfolios();
                void refreshPortfolioInBackground(symbol);
            } catch (error) {
                const message = error.message || 'Network problem — the holding wasn’t added.';
                noteAddError(esc(message));
                finishPortfolioAction(message, { error: true, holdMs: 2200 });
            }
            return;
        }

        // Multi-ticker: sequential (not parallel) so status is progressive and
        // one bad symbol never fans out into a burst of concurrent Yahoo calls.
        showPortfolioAction(`Adding ${symbols.length} tickers`, `Adding ${symbols[0]} (1 of ${symbols.length})…`);
        const results = [];
        const addedSymbols = [];
        let stoppedEarly = false;
        for (let i = 0; i < symbols.length; i++) {
            const symbol = symbols[i];
            $('portfolio-action-detail').textContent = `Adding ${symbol} (${i + 1} of ${symbols.length})…`;
            try {
                const { ok, status, saved } = await saveOneHolding(symbol, shared);
                if (!ok) {
                    if (status === 402) { results.push(`<strong>${esc(symbol)}</strong> failed — subscription not active`); stoppedEarly = true; break; }
                    results.push(`<strong>${esc(symbol)}</strong> failed — ${esc(saved.message || 'unknown ticker')}`);
                    continue;
                }
                results.push(`<strong>${esc(symbol)}</strong> added`);
                addedSymbols.push(symbol);
            } catch (_) {
                results.push(`<strong>${esc(symbol)}</strong> failed — network problem`);
            }
        }
        const failed = results.length - addedSymbols.length;
        const tone = failed === 0 ? 'pos' : addedSymbols.length === 0 ? 'neg' : 'mixed';
        noteAddError(results.join(' · '), tone);
        if (addedSymbols.length) {
            clearAddInputs();
            await loadHoldings();
            finishPortfolioAction(
                stoppedEarly
                    ? `${addedSymbols.length} of ${symbols.length} added before your subscription check stopped the rest.`
                    : `${addedSymbols.length} of ${symbols.length} tickers added. Charts and analysis will finish refreshing in the background.`,
                { error: failed > 0, holdMs: failed > 0 ? 2600 : 550 }
            );
            void loadPortfolios();
            void refreshPortfolioInBackground(addedSymbols);
        } else {
            finishPortfolioAction('No tickers were added.', { error: true, holdMs: 2600 });
        }
    });

    // ---- 🧪 AI Paper Portfolio (beta, display-only) ----
    // The dashboard never sets this experiment up — setup lives in Ask AI
    // (the 🧪 toggle on ask.html). This section is only the visualization,
    // reached through the portfolio dropdown: the ★ option appears once a
    // portfolio exists, and nothing renders before that. The portfolio is
    // buy-once-never-change: there is no trade UI anywhere, by design.
    let aiPaperBeta = null;    // probe result { state, gurus }; null = feature off
    let aiPaperView = false;   // the switcher is showing the experiment view
    let aiPaperPoll = null;    // 5s detail poll while status === 'building'

    async function probeAiPaper() {
        if (DEMO) return;
        try {
            const r = await fetch(`${API}/ai-paper-portfolio`, { headers: auth });
            if (!r.ok) return; // 403 = not this account's beta: render nothing at all
            const data = await r.json();
            if (!data || data.enabled !== true) return;
            aiPaperBeta = { state: data.state || { exists: false }, gurus: Array.isArray(data.gurus) ? data.gurus : [] };
            if (aiPaperBeta.state.exists) {
                renderPortfolios(); // the ★ option exists only because the portfolio does
                // a build started on the Ask page (or in flight from a prior
                // load) still needs its poll so this tab shows the outcome
                if (aiPaperBeta.state.status === 'building') startAiPaperPoll();
            }
        } catch (_) { /* any error leaves the feature invisible */ }
    }

    function showAiPaperView() {
        aiPaperView = true;
        const section = $('ai-pf-section');
        if (!section) return;
        if (section.hidden) {
            section.hidden = false;
            loadAiPaperSection();
            section.scrollIntoView({ behavior: 'smooth', block: 'start' });
        }
        renderPortfolios(); // keep the switcher in step with the view
    }

    function hideAiPaperView() {
        aiPaperView = false;
        const section = $('ai-pf-section');
        if (section) section.hidden = true;
        stopAiPaperPoll();
    }

    async function fetchAiPaperDetail() {
        try {
            const r = await fetch(`${API}/ai-paper-portfolio/detail`, { headers: auth });
            if (!r.ok) return null;
            return await r.json();
        } catch (_) { return null; }
    }

    async function loadAiPaperSection() {
        const detail = await fetchAiPaperDetail();
        if (!detail || !detail.exists) {
            // The cached probe was stale — no portfolio: hide the section and
            // drop the dropdown option. There is no empty-state pitch here;
            // setup lives in Ask AI.
            aiPaperBeta.state = { exists: false };
            hideAiPaperView();
            renderPortfolios();
            return;
        }
        renderAiPaperDetail(detail);
        if (detail.portfolio.status === 'building') startAiPaperPoll();
    }

    // Poll every 5s only while a build is in flight; the first response that
    // leaves 'building' renders the outcome and stops the clock.
    function startAiPaperPoll() {
        if (aiPaperPoll) return;
        aiPaperPoll = setInterval(async () => {
            const detail = await fetchAiPaperDetail();
            if (!detail) return;
            if (!detail.exists || detail.portfolio.status !== 'building') {
                stopAiPaperPoll();
                renderAiPaperDetail(detail);
            } else if (!$('ai-pf-progress')) {
                renderAiPaperDetail(detail); // first frame: lay out the building state
            }
        }, 5000);
    }

    function stopAiPaperPoll() {
        if (aiPaperPoll) { clearInterval(aiPaperPoll); aiPaperPoll = null; }
    }

    function aiPaperBadge(p) {
        if (p.status === 'building') return '<span class="ai-badge">Building…</span>';
        if (p.status === 'failed') return '<span class="ai-badge is-neg">Build failed</span>';
        if (p.status === 'committed') return `<span class="ai-badge">Review ${Math.min(p.dayCount + 1, 2)} of 2 — nightly, advisory only, no trades</span>`;
        return '<span class="ai-badge is-ok">Tracking — portfolio fixed; reviews done</span>';
    }

    function renderAiPaperDetail(detail) {
        const body = $('ai-pf-body');
        const sub = $('ai-pf-sub');
        if (!body) return;
        const p = detail.portfolio;
        if (sub) sub.textContent = `since ${new Date(p.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;

        if (p.status === 'building') {
            // never re-render over progress lines that are already streaming
            if ($('ai-pf-progress')) return;
            body.innerHTML = `
              <div class="ai-head">${aiPaperBadge(p)}<span class="small muted">about two minutes — the page keeps working while it builds</span></div>
              <div class="ai-progress" id="ai-pf-progress" role="status" aria-live="polite"></div>`;
            return;
        }

        if (p.status === 'failed') {
            body.innerHTML = `
              <div class="ai-head">${aiPaperBadge(p)}<span class="small muted">nothing was bought — no half-built portfolio exists</span></div>
              <div class="notice"><strong>The build didn’t finish.</strong>
                <p>${esc(p.buildError || 'Something went wrong during construction.')}</p>
                <p style="margin:10px 0 0;">Setup and retry live in <a href="/ask.html?aiPaper=1&amp;q=Retry%20the%20setup%20for%20my%20AI%20Paper%20Portfolio">Ask AI</a> — nothing here ever trades.</p>
              </div>`;
            return;
        }

        const t = detail.totals || {};
        const snaps = Array.isArray(detail.snapshots) ? detail.snapshots : [];
        const latest = snaps.length ? snaps[snaps.length - 1] : null;
        const per = latest && Array.isArray(latest.perPersona) ? latest.perPersona : [];
        const vsSpy = (t.portfolioReturnPct ?? 0) - (t.spyReturnPct ?? 0);
        const cash = Number(p.cash) || 0;

        // Benchmark chart: portfolio return % vs SPY return %, both from the
        // same snapshot series. Days 0–2 are sparse by design — the copy says
        // so rather than pretending a smooth line.
        const n = snaps.length;
        const chartHtml = n >= 2
            ? chart(
                [
                    { values: snaps.map((s) => s.portfolioReturnPct), cls: 'accent' },
                    { values: snaps.map((s) => s.spyReturnPct), cls: 'faint' }
                ],
                snaps.map((s, i) => (i % Math.max(1, Math.ceil(n / 6)) === 0 ? String(s.date).slice(5) : '')),
                { fmt: (v) => `${Number(v).toFixed(1)}%` }
            )
            : '<p class="small muted" style="margin:8px 0 0;">The benchmark chart fills in as daily closes land.</p>';
        const gapNote = n >= 2 && (new Date(snaps[n - 1].date) - new Date(snaps[0].date)) / 86400000 > n + 3
            ? '<p class="small faint" style="margin:8px 0 0;">Some days are missing — the server was likely asleep (free-tier sleep pauses the nightly tick).</p>'
            : '';

        const personaCard = (x) => {
            const pos = (p.positions || []).find((q) => q.personaId === x.id) || {};
            const mine = per.find((q) => q.id === x.id) || {};
            const isGuru = x.kind === 'guru';
            return `
              <div class="ai-persona">
                <div class="ai-persona-head">
                  <span class="ai-persona-kind">${isGuru ? `🧠 Guru mind — ${esc(x.name)}` : `📊 ${esc(x.name)}`}</span>
                  <span class="small muted">${isGuru ? esc(x.fund || '') : 'no investor reference — pure data'}</span>
                </div>
                <p class="ai-persona-pick"><strong><a href="/company.html?symbol=${esc(pos.symbol || '')}">${esc(pos.symbol || '—')}</a></strong> <span class="small muted">${esc(pos.name || '')}</span></p>
                <p class="small" style="margin:6px 0;">${fixed(x.weight * 100, 0)}% of the book · ${money(pos.shares * pos.avgPrice)} at $${fixed(pos.avgPrice, 2)}</p>
                <p class="small ${mine.plPct >= 0 ? 'delta-pos' : 'delta-neg'}" style="margin:6px 0;"><strong>${mine.plPct === undefined ? '—' : (mine.plPct >= 0 ? '+' : '') + fixed(mine.plPct, 2) + '%'}</strong> since purchase</p>
                ${x.philosophy ? `<details class="ai-persona-phil"><summary>The ${isGuru ? 'philosophy' : 'data factors'} it cited</summary><p class="small muted" style="margin:8px 0 0;">${esc(x.philosophy)}</p></details>` : ''}
              </div>`;
        };

        const decisionRows = (detail.decisions || []).map((d) => {
            const titles = {
                construct: 'Construction — the one buying decision',
                review: `Nightly review ${d.day} — advisory only`,
                end_reviews: 'Reviews ended — tracking only from here',
                build_failed: 'Failed build'
            };
            const would = Array.isArray(d.wouldChange) && d.wouldChange.length
                ? `<div class="ai-would">${d.wouldChange.map((w) => `<span class="chip ai-would-chip">would ${esc(w.action || 'hold')} ${esc(w.symbol || '')} — not executed</span>`).join('')}</div>`
                : '';
            const news = Array.isArray(d.newsFactors) && d.newsFactors.length
                ? `<div class="ai-news">${d.newsFactors.map((f) => `<span class="chip">${esc(String(f).slice(0, 140))}</span>`).join('')}</div>`
                : '';
            return `
              <details class="ai-decision">
                <summary>${esc(titles[d.type] || d.type)} <span class="small faint">day ${d.day} · ${new Date(d.at).toLocaleString('en-US', { month: 'short', day: 'numeric' })}</span></summary>
                <p class="small" style="white-space:pre-wrap; margin:10px 0 0;">${esc(d.rationale || '')}</p>
                ${news}${would}
              </details>`;
        }).join('');

        body.innerHTML = `
          <div class="ai-head">${aiPaperBadge(p)}<span class="small muted">two stocks by design — deliberately concentrated, SPY is the benchmark</span></div>
          <div class="ai-tiles">
            <div class="ai-tile"><span class="label">Value</span><strong class="ai-tile-v">$${money(t.totalValue)}</strong><span class="small muted">of $${money(p.startingCapital)} paper</span></div>
            <div class="ai-tile"><span class="label">Return</span><strong class="ai-tile-v ${(t.portfolioReturnPct ?? 0) >= 0 ? 'delta-pos' : 'delta-neg'}">${(t.portfolioReturnPct ?? 0) >= 0 ? '+' : ''}${fixed(t.portfolioReturnPct ?? 0, 2)}%</strong><span class="small muted">at official closes</span></div>
            <div class="ai-tile"><span class="label">SPY benchmark</span><strong class="ai-tile-v">${t.spyReturnPct === null || t.spyReturnPct === undefined ? '—' : (t.spyReturnPct >= 0 ? '+' : '') + fixed(t.spyReturnPct, 2) + '%'}</strong><span class="small muted ${vsSpy >= 0 ? 'delta-pos' : 'delta-neg'}">${vsSpy >= 0 ? 'ahead' : 'behind'} by ${fixed(Math.abs(vsSpy), 2)}%</span></div>
            <div class="ai-tile"><span class="label">Cash</span><strong class="ai-tile-v">$${money(cash)}</strong><span class="small muted">cap 20% by rule</span></div>
          </div>
          <div class="ai-chart">${chartHtml}${gapNote}</div>
          <div class="ai-showdown">
            ${(p.personas || []).map(personaCard).join('<div class="ai-vs" aria-hidden="true">vs</div>')}
          </div>
          ${decisionRows ? `<h3 class="title-3" style="margin:22px 0 8px;">Decision log — append-only, newest first</h3><div class="ai-log">${decisionRows}</div>` : ''}`;
    }

    const aiAskEngine = mountAsk($('pf-ask'), {
        placeholder: 'Ask about your portfolio — concentration, quality, what changed…',
        suggestions: [
            'Is my portfolio concentrated in one sector?',
            'Which of my holdings has the weakest balance sheet?',
            'How would my portfolio fare if margins compress?',
            'What are the top 3 ETFs and mutual funds over 3 months, 1 year and 3 years?'
        ]
    });

    async function loadWatchlist() {
        try {
            const r = await fetch(`${API}/watchlist`, { headers: auth });
            if (!r.ok) return;
            const data = await r.json();
            const rows = data.rows || [];
            if (!rows.length) return;
            $('watch-body').innerHTML = rows.map((w) => `
              <tr data-sym="${esc(w.symbol)}">
                <td class="row-head"><strong>${esc(w.symbol)}</strong>&ensp;<span class="muted small">${esc(w.name || '')}</span></td>
                <td>${w.marketCapB === null || w.marketCapB === undefined ? '—' : '$' + money(w.marketCapB * 1e9)}</td>
                <td>${fixed(w.pe, 1)}</td>
                <td class="${w.revCagr5Pct > 0 ? 'delta-pos' : w.revCagr5Pct < 0 ? 'delta-neg' : ''}">${pct(w.revCagr5Pct)}</td>
                <td>${pct(w.netMarginPct)}</td>
                <td class="${w.qtrNetIncomeYoYPct > 0 ? 'delta-pos' : w.qtrNetIncomeYoYPct < 0 ? 'delta-neg' : ''}">${pct(w.qtrNetIncomeYoYPct, 0)}</td>
                <td><button class="btn btn-quiet btn-sm" data-unwatch="${esc(w.symbol)}" aria-label="Remove ${esc(w.symbol)} from watchlist">Remove</button></td>
              </tr>`).join('');
            $('watch-section').hidden = false;
            document.querySelectorAll('#watch-body tr').forEach((tr) =>
                tr.addEventListener('click', (e) => {
                    if (e.target.dataset.unwatch) return;
                    location.href = `/company.html?symbol=${tr.dataset.sym}`;
                }));
            document.querySelectorAll('[data-unwatch]').forEach((b) =>
                b.addEventListener('click', async () => {
                    await fetch(`${API}/watchlist/${b.dataset.unwatch}`, { method: 'DELETE', headers: auth }).catch(() => {});
                    loadWatchlist();
                    $('watch-body').innerHTML = '';
                }));
        } catch (_) { /* enrichment */ }
    }

    async function loadBriefing() {
        try {
            const r = await fetch(`${API}/portfolio/briefing${pfScopeQuery()}`, { headers: auth });
            if (!r.ok) return;
            const data = await r.json();
            if (!data.briefing) {
                $('brief-section').hidden = true;
                $('brief-body').innerHTML = '';
                $('brief-sub').textContent = '';
                return;
            }
            renderBriefing(data);
            const share = document.createElement('div');
            mountShare(share, { title: 'My weekly portfolio briefing', text: data.briefing, url: location.href });
            $('brief-body').appendChild(share);
            $('brief-sub').textContent = data.cached ? 'from this week' : 'fresh';
            $('brief-section').hidden = false;
        } catch (_) { /* briefing is enrichment */ }
    }

    function briefingMoney(value) {
        return value === null || value === undefined ? '—' : `$${money(value, 0)}`;
    }

    function signedPct(value) {
        const n = Number(value);
        return Number.isFinite(n) ? `${n >= 0 ? '+' : ''}${n.toFixed(1)}%` : '—';
    }

    function renderBriefing(data) {
        const facts = data && data.facts;
        const body = $('brief-body');
        if (!facts || facts.empty) {
            body.innerHTML = markdown(data.briefing || '');
            return;
        }
        const pl = Number(facts.totalPL) || 0;
        const largest = facts.largestPosition || {};
        const best = facts.bestPerformer || {};
        const worst = facts.worstPerformer || {};
        const topSector = facts.topSector || {};
        const funds = Array.isArray(facts.fundPositions) ? facts.fundPositions : [];
        const allocationText = topSector.sector && topSector.sector !== 'Unknown'
            ? `Largest sector / fund category: ${topSector.sector} · ${topSector.weightPct}%`
            : 'Sector and fund-category labels are unavailable for part of this portfolio.';
        const fundHtml = funds.length ? `
          <div class="briefing-funds">
            <span class="label">Funds in this portfolio</span>
            ${funds.map((fund) => `<div class="briefing-fund-row">
              <span><strong>${esc(fund.symbol)}</strong> <span class="small muted">${fund.assetType === 'etf' ? 'ETF' : 'Mutual fund'}</span></span>
              <span class="small">${fixed(fund.weightPct, 1)}% of portfolio</span>
              <span class="small briefing-fund-value">${briefingMoney(fund.value)} · ${signedPct(fund.plPct)} since purchase</span>
            </div>`).join('')}
            <p class="small briefing-context">Funds are included in value, allocation and performance. Company filing ratios are kept separate.</p>
          </div>` : '';
        body.innerHTML = `
          <div class="briefing-wrap">
            <div class="briefing-overview">
              <div><span class="label">Portfolio snapshot</span><p class="briefing-value">${briefingMoney(facts.totalValue)} <small>across ${facts.holdingsCount} holding${facts.holdingsCount === 1 ? '' : 's'}</small></p></div>
              <p class="briefing-change ${pl >= 0 ? 'is-pos' : 'is-neg'}"><strong>${pl >= 0 ? '+' : '−'}${briefingMoney(Math.abs(pl))} · ${signedPct(facts.totalPLPct)}</strong><br><span class="small muted">since purchase</span></p>
            </div>
            <div class="briefing-highlights">
              <div class="briefing-highlight"><span class="label">Largest position</span><strong>${esc(largest.symbol || '—')} · ${fixed(largest.weightPct, 1)}%</strong><span class="small muted">of the portfolio</span></div>
              <div class="briefing-highlight"><span class="label">Best since purchase</span><strong>${esc(best.symbol || '—')} · ${signedPct(best.plPct)}</strong><span class="small muted">holding return</span></div>
              <div class="briefing-highlight"><span class="label">Weakest since purchase</span><strong>${esc(worst.symbol || '—')} · ${signedPct(worst.plPct)}</strong><span class="small muted">holding return</span></div>
            </div>
            <p class="small briefing-context">${esc(allocationText)}</p>
            ${fundHtml}
          </div>`;
    }

    $('pf-csv').addEventListener('click', () => {
        if (!lastRows.length) return;
        const head = 'Symbol,Name,Shares,PurchasePrice,CurrentPrice,Value';
        const lines = lastRows.map((r) =>
            [r.symbol, JSON.stringify(r.name || ''), r.shares, r.paid ?? '', r.price ?? '', r.value ?? ''].join(','));
        const blob = new Blob([[head].concat(lines).join('\n')], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'portfolio.csv';
        a.click();
        URL.revokeObjectURL(a.href);
    });

    wirePortfolioSwitcher();
    wireCsvImport();
    wireGainToggles();
    (async () => {
        if (!DEMO) await loadPortfolios(); // validates the persisted selection before scoping any fetch
        loadHoldings();
        if (!DEMO) {
            loadXray();
            loadAttribution();
            loadAlerts();
            loadRules();
            loadWash();
            loadBriefing();
            loadWatchlist();
            probeAiPaper(); // 🧪 403 for everyone else — nothing renders
        }
    })();
})();
