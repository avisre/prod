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

    let lastRows = []; // for CSV export
    let portfolioActionBusy = false;
    let portfolioRefreshVersion = 0;

    function setPortfolioControlsBusy(busy) {
        const form = $('add-form');
        if (form) form.querySelectorAll('input, button, select').forEach((control) => { control.disabled = busy; });
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
        $('add-form').outerHTML = `
          <div class="card card-pad" style="max-width:380px;">
            <p class="label" style="margin-bottom:6px;">Demo portfolio</p>
            <p class="small muted" style="margin:0 0 12px;">A read-only sample. Choose a paid plan to build your own and unlock the look-through view, alerts and Ask.</p>
            <a class="btn btn-primary" href="/register.html">Choose a plan</a>
          </div>`;
    }

    // ---------- allocation doughnut + portfolio value line (the v1 charts,
    // reset into the paper/ink system: muted tonal palette, hairlines) ----
    const ALLOC_COLORS = ['#1c1b18', '#1a4fd6', '#1b7a4b', '#8a877e', '#6b86c8', '#b3a16e', '#5e5c55', '#9db8a0', '#c4b9a4', '#444239'];
    function renderAllocation(rows) {
        const host = $('alloc-chart');
        const legend = $('alloc-legend');
        const positive = rows.filter((r) => (r.value || 0) > 0).slice().sort((a, b) => b.value - a.value);
        const total = positive.reduce((a, r) => a + r.value, 0);
        if (!positive.length || total <= 0) { $('charts-section').hidden = true; return; }
        $('charts-section').hidden = false;
        // group the tail beyond 8 slices into "Other" so the ring stays legible
        const slices = positive.slice(0, 8);
        const rest = positive.slice(8).reduce((a, r) => a + r.value, 0);
        if (rest > 0) slices.push({ symbol: 'Other', value: rest });
        const W = 220, R = 95, IR = 60, CX = W / 2, CY = W / 2;
        let a0 = -Math.PI / 2;
        const arcs = slices.map((s, i) => {
            const frac = Math.min(0.9999, s.value / total);
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
    function drawPerf(rows) {
        const data = (perfRange === '1Y' || perfRange === 'MAX') ? perfSeries.full : perfSeries.compact;
        if (!data) return;
        let series = aggregate(rows, data);
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
            <a class="btn btn-primary" href="/register.html?plan=monthly">Choose a plan</a>
          </div>`;
        $('pf-total').textContent = '—';
        $('pf-sub').textContent = 'Portfolio tracking is part of the paid plans.';
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
                + '<a class="btn btn-primary btn-sm" href="/register.html?plan=monthly">Choose a plan →</a>'
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
        return {
            id: h._id || h.id,
            symbol: (h.symbol || '').toUpperCase(),
            name: h.name || '',
            assetType: h.assetType || 'stock',
            shares,
            paid: purchase,
            price,
            value,
            gain
        };
    }

    function renderHoldings(rows) {
        lastRows = rows;
        renderAllocation(rows);
        const total = rows.reduce((sum, row) => sum + (row.value || 0), 0);
        $('pf-total').textContent = '$' + fixed(total, 2);
        $('pf-sub').textContent = DEMO
            ? `${rows.length} holdings · demo data, read-only`
            : `${rows.length} holdings · stored prices refresh through the day`;
        $('holdings-loading').hidden = true;

        if (!rows.length) {
            $('holdings-empty').hidden = false;
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
            <td class="${row.gain > 0 ? 'delta-pos' : row.gain < 0 ? 'delta-neg' : ''}">${row.gain === null ? '—' : (row.gain >= 0 ? '+' : '') + row.gain.toFixed(1) + '%'}</td>
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

    async function refreshPerformanceForMutation(symbol, removed) {
        if (removed) {
            if (perfSeries.compact) delete perfSeries.compact[symbol];
            if (perfSeries.full) delete perfSeries.full[symbol];
            if (lastRows.length) drawPerf(lastRows);
            return;
        }
        const compact = await fetchDaily([symbol], 'compact');
        perfSeries.compact = perfSeries.compact || {};
        Object.assign(perfSeries.compact, compact);
        if (perfSeries.full) Object.assign(perfSeries.full, await fetchDaily([symbol], 'full'));
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

    async function removeHolding(button) {
        if (portfolioActionBusy) return;
        const id = button.dataset.del;
        const savedRow = lastRows.find((row) => String(row.id) === String(id));
        const symbol = savedRow ? savedRow.symbol : 'Holding';
        showPortfolioAction(`Removing ${symbol}`, 'Updating your saved holdings…');
        try {
            const response = await fetch(`${API}/portfolio/${id}`, { method: 'DELETE', headers: auth });
            if (!response.ok) {
                const data = await response.json().catch(() => ({}));
                throw new Error(data.message || `Couldn’t remove ${symbol}.`);
            }
            renderHoldings(lastRows.filter((row) => String(row.id) !== String(id)));
            finishPortfolioAction(`${symbol} was removed. Charts and analysis will finish refreshing in the background.`);
            void refreshPortfolioInBackground(symbol, { removed: true });
        } catch (error) {
            finishPortfolioAction(error.message || `${symbol} could not be removed. Please try again.`, { error: true, holdMs: 2200 });
        }
    }

    async function refreshLiveHoldingPrices(version) {
        try {
            const response = await fetch(`${API}/portfolio`, { headers: auth });
            if (!response.ok) return;
            const list = await response.json();
            // Do not let a response started before a mutation overwrite the
            // confirmed add/remove that is already visible in the table.
            if (version !== portfolioRefreshVersion) return;
            renderHoldings((Array.isArray(list) ? list : []).map(holdingToRow));
        } catch (_) { /* stored prices remain usable */ }
    }

    async function loadHoldings() {
        try {
            const r = await fetch(DEMO ? `${API}/demo/portfolio` : `${API}/portfolio`, { headers: auth });
            if (!DEMO && r.status === 401) { await fetch('/api/logout', { method: 'POST' }).catch(() => {}); location.reload(); return; }
            if (!DEMO && r.status === 402) { freeMode(); return; }
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
            const r = await fetch(`${API}/portfolio/xray`, { headers: auth });
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
            const r = await fetch(`${API}/portfolio/attribution`, { headers: auth });
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
            $('alerts-sub').textContent = `${data.unseen || 0} new`;
            $('alerts-list').innerHTML = alerts.map((a) => {
                const cls = a.type === 'health-flip' ? (String(a.title || '').includes('PASS') ? 'notice-pos' : 'notice-neg')
                    : a.type === 'insider-cluster' ? 'notice-pos'
                    : a.type === 'dividend-risk' ? 'notice-neg'
                    : '';
                const when = a.createdAt ? new Date(a.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
                return `<div class="notice ${cls}"><strong>${esc(a.symbol)}</strong> — ${esc(a.title)} <span class="faint small" style="float:right">${when}</span></div>`;
            }).join('');
            $('alerts-section').hidden = false;
            fetch(`${API}/alerts/seen`, { method: 'POST', headers: auth }).catch(() => {});
        } catch (_) { /* quiet */ }
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

    if (!DEMO) $('add-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        if (portfolioActionBusy) return;
        const symbol = $('add-sym').value.trim().toUpperCase();
        const shares = Number($('add-shares').value);
        if (!symbol || !shares) return;
        const body = { symbol, shares };
        const price = Number($('add-price').value);
        if (price > 0) { body.purchasePrice = price; body.purchaseDate = new Date().toISOString().slice(0, 10); }
        // failures must be SEEN — a quiet form that eats errors reads as broken
        const note = (msg) => {
            let el = $('add-error');
            if (!el) {
                el = document.createElement('p');
                el.id = 'add-error';
                el.className = 'small';
                el.style.cssText = 'grid-column: 1 / -1; margin:6px 0 0; color: var(--neg);';
                $('add-form').appendChild(el);
            }
            el.innerHTML = msg;
            el.hidden = !msg;
        };
        showPortfolioAction(`Adding ${symbol}`, 'Checking the ticker and saving the holding…');
        try {
            const r = await fetch(`${API}/portfolio`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...auth },
                body: JSON.stringify(body)
            });
            const saved = await r.json().catch(() => ({}));
            if (!r.ok) {
                const message = r.status === 402
                    ? 'Your subscription is not active. Choose a plan to add holdings.'
                    : (saved.message || `Couldn’t add ${symbol} — try again.`);
                if (r.status === 402) note('Your subscription isn’t active — <a href="/register.html">choose a plan</a> to add holdings.');
                else note(esc(message));
                finishPortfolioAction(message, { error: true, holdMs: 2200 });
                return;
            }
            note('');
            $('add-sym').value = ''; $('add-shares').value = ''; $('add-price').value = '';
            if (saved && saved._id) renderHoldings([...lastRows, holdingToRow(saved)]);
            else if (!await loadHoldings()) throw new Error(`${symbol} was added, but the refreshed portfolio could not be loaded. Reload the page.`);
            finishPortfolioAction(`${symbol} was added. Charts and analysis will finish refreshing in the background.`);
            void refreshPortfolioInBackground(symbol);
        } catch (error) {
            const message = error.message || 'Network problem — the holding wasn’t added.';
            note(esc(message));
            finishPortfolioAction(message, { error: true, holdMs: 2200 });
        }
    });

    mountAsk($('pf-ask'), {
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
            const r = await fetch(`${API}/portfolio/briefing`, { headers: auth });
            if (!r.ok) return;
            const data = await r.json();
            if (!data.briefing) {
                $('brief-section').hidden = true;
                $('brief-body').innerHTML = '';
                $('brief-sub').textContent = '';
                return;
            }
            $('brief-body').innerHTML = markdown(data.briefing);
            const share = document.createElement('div');
            mountShare(share, { title: 'My weekly portfolio briefing', text: data.briefing, url: location.href });
            $('brief-body').appendChild(share);
            $('brief-sub').textContent = data.cached ? 'from this week' : 'fresh';
            $('brief-section').hidden = false;
        } catch (_) { /* briefing is enrichment */ }
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

    loadHoldings();
    if (!DEMO) {
        loadXray();
        loadAttribution();
        loadAlerts();
        loadRules();
        loadWash();
        loadBriefing();
        loadWatchlist();
    }
})();
