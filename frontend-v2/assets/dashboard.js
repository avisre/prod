// Dashboard: holdings, what changed (alerts), X-Ray, Ask — same APIs as v1.
(function () {
    'use strict';
    const { API, token, num, money, pct, fixed, esc, nav, footer, mountAsk, markdown, chart } = window.V2;
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
    let lastRows = []; // for CSV export

    if (DEMO) {
        // Read-only sample: hide mutation UI, label clearly, sell quietly.
        $('add-form').outerHTML = `
          <div class="card card-pad" style="max-width:380px;">
            <p class="label" style="margin-bottom:6px;">Demo portfolio</p>
            <p class="small muted" style="margin:0 0 12px;">A read-only sample. Start a free trial to build your own and unlock the look-through view, alerts and Ask.</p>
            <a class="btn btn-primary" href="/register.html">Start 7-day free trial</a>
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
        if (!perfSeries.compact) perfSeries.compact = await fetchDaily(syms, 'compact');
        drawPerf(rows);
        if (perfWired) return;
        perfWired = true;
        document.querySelectorAll('#perf-range button').forEach((b) =>
            b.addEventListener('click', async () => {
                document.querySelectorAll('#perf-range button').forEach((x) => x.setAttribute('aria-pressed', x === b));
                perfRange = b.dataset.r;
                if ((perfRange === '1Y' || perfRange === 'MAX') && !perfSeries.full) {
                    $('perf-chart').innerHTML = '<p style="padding:40px 0; text-align:center;"><span class="loading-line"><span class="spin"></span>Loading full history…</span></p>';
                    perfSeries.full = await fetchDaily(lastRows.map((r) => r.symbol), 'full');
                }
                drawPerf(lastRows);
            }));
    }

    async function loadHoldings() {
        try {
            const r = await fetch(DEMO ? `${API}/demo/portfolio` : `${API}/portfolio`, { headers: auth });
            if (!DEMO && (r.status === 401 || r.status === 402)) { localStorage.removeItem('token'); location.reload(); return; }
            const list = await r.json();
            const rows = (Array.isArray(list) ? list : []).map((h) => {
                const shares = num(h.shares) || 0;
                const price = num(h.currentPrice) !== null ? num(h.currentPrice) : num(h.purchasePrice);
                const paid = num(h.purchasePrice);
                const value = price !== null ? shares * price : null;
                const gain = (price !== null && paid !== null && paid > 0) ? (price / paid - 1) * 100 : null;
                return { id: h._id, symbol: (h.symbol || '').toUpperCase(), name: h.name || '', shares, paid, price, value, gain };
            });
            lastRows = rows;
            renderAllocation(rows);
            loadPerformance(rows);
            const total = rows.reduce((a, r2) => a + (r2.value || 0), 0);
            $('pf-total').textContent = '$' + fixed(total, 2);
            $('pf-sub').textContent = DEMO
                ? `${rows.length} holdings · demo data, read-only`
                : `${rows.length} holdings · stored prices refresh through the day`;
            if (!rows.length) {
                $('holdings-body').innerHTML = '<tr><td colspan="8" class="faint" style="text-align:center;padding:36px;">No holdings yet — add your first above.</td></tr>';
                return;
            }
            $('holdings-body').innerHTML = rows.map((r2) => `
              <tr>
                <td class="row-head"><a href="/company.html?symbol=${esc(r2.symbol)}"><strong>${esc(r2.symbol)}</strong></a>&ensp;<span class="muted small">${esc(r2.name)}</span></td>
                <td>${fixed(r2.shares, r2.shares % 1 ? 2 : 0)}</td>
                <td>${r2.paid === null ? '—' : '$' + fixed(r2.paid, 2)}</td>
                <td>${r2.price === null ? '—' : '$' + fixed(r2.price, 2)}</td>
                <td>${r2.value === null ? '—' : '$' + fixed(r2.value, 2)}</td>
                <td>${total > 0 && r2.value !== null ? pct(r2.value / total * 100) : '—'}</td>
                <td class="${r2.gain > 0 ? 'delta-pos' : r2.gain < 0 ? 'delta-neg' : ''}">${r2.gain === null ? '—' : (r2.gain >= 0 ? '+' : '') + r2.gain.toFixed(1) + '%'}</td>
                <td>${DEMO ? '' : `<button class="btn btn-quiet btn-sm" data-del="${esc(r2.id)}" aria-label="Remove ${esc(r2.symbol)}">Remove</button>`}</td>
              </tr>`).join('');
            document.querySelectorAll('[data-del]').forEach((b) =>
                b.addEventListener('click', async () => {
                    await fetch(`${API}/portfolio/${b.dataset.del}`, { method: 'DELETE', headers: auth }).catch(() => {});
                    loadHoldings(); loadXray();
                }));
        } catch (_) {
            $('holdings-body').innerHTML = '<tr><td colspan="8" class="faint" style="text-align:center;padding:36px;">Couldn’t load holdings.</td></tr>';
        }
    }

    async function loadXray() {
        try {
            const r = await fetch(`${API}/portfolio/xray`, { headers: auth });
            if (!r.ok) return;
            const x = await r.json();
            if (!x || !x.lookThrough) return;
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

    async function loadAlerts() {
        try {
            const r = await fetch(`${API}/alerts`, { headers: auth });
            if (!r.ok) return;
            const data = await r.json();
            const alerts = (data.alerts || []).slice(0, 8);
            if (!alerts.length) return;
            $('alerts-sub').textContent = `${data.unseen || 0} new`;
            $('alerts-list').innerHTML = alerts.map((a) => {
                const cls = a.type === 'health-flip' ? (String(a.title || '').includes('now passes') ? 'notice-pos' : 'notice-neg') : '';
                const when = a.createdAt ? new Date(a.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : '';
                return `<div class="notice ${cls}"><strong>${esc(a.symbol)}</strong> — ${esc(a.title)} <span class="faint small" style="float:right">${when}</span></div>`;
            }).join('');
            $('alerts-section').hidden = false;
            fetch(`${API}/alerts/seen`, { method: 'POST', headers: auth }).catch(() => {});
        } catch (_) { /* quiet */ }
    }

    if (!DEMO) $('add-form').addEventListener('submit', async (e) => {
        e.preventDefault();
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
        const btn = $('add-form').querySelector('button[type=submit]');
        btn.disabled = true;
        try {
            const r = await fetch(`${API}/portfolio`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...auth },
                body: JSON.stringify(body)
            });
            if (!r.ok) {
                const d = await r.json().catch(() => ({}));
                if (r.status === 402) note('Your subscription isn’t active — <a href="/register.html">restart your trial</a> to add holdings.');
                else note(esc(d.message || `Couldn’t add ${symbol} — try again.`));
                return;
            }
            note('');
            $('add-sym').value = ''; $('add-shares').value = ''; $('add-price').value = '';
            loadHoldings(); loadXray();
        } catch (_) {
            note('Network problem — the holding wasn’t added.');
        } finally {
            btn.disabled = false;
        }
    });

    mountAsk($('pf-ask'), {
        placeholder: 'Ask about your portfolio — concentration, quality, what changed…',
        suggestions: [
            'Is my portfolio concentrated in one sector?',
            'Which of my holdings has the weakest balance sheet?',
            'How would my portfolio fare if margins compress?'
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
            if (!data.briefing) return;
            $('brief-body').innerHTML = markdown(data.briefing);
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
        loadAlerts();
        loadBriefing();
        loadWatchlist();
    }
})();
