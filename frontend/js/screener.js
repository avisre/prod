// Screener page — drives the public /api/screener endpoint.
(function () {
    'use strict';

    function apiBase() {
        const host = window.location.hostname;
        if (host === 'localhost' || host === '127.0.0.1') return `${window.location.protocol}//${window.location.host}/api`;
        return 'https://stockportfolio.pro/api';
    }
    const API = apiBase();
    const $ = (id) => document.getElementById(id);

    const PRESETS = {
        compounders: { cagr: 10, margin: 15, roe: 15, prof: 9, fcf: true, sort: 'revCagr5Pct' },
        cashmachines: { margin: 20, fcf: true, prof: 10, sort: 'netMarginPct' },
        hypergrowth: { cagr: 20, sort: 'revCagr5Pct' },
        dividends: { div: 2, prof: 8, fcf: true, sort: 'divYieldPct' },
        value: { pe: 18, fcf: true, prof: 7, sort: 'pe' },
        earnings: { qtr: 30, sort: 'qtrNetIncomeYoYPct' },
        clear: {}
    };

    let sortBy = 'marketCapB';
    let lastRows = [];

    function fmt(v, dp, suffix) {
        if (v === null || v === undefined || Number.isNaN(v)) return '–';
        return Number(v).toFixed(dp) + (suffix || '');
    }
    function fmtCap(b) {
        if (b === null || b === undefined) return '–';
        if (b >= 1000) return '$' + (b / 1000).toFixed(2) + 'T';
        return '$' + Number(b).toFixed(1) + 'B';
    }

    function params() {
        const p = new URLSearchParams();
        const set = (k, v) => { if (v !== '' && v !== null && v !== undefined && v !== false) p.set(k, v); };
        set('sector', $('f-sector').value);
        set('minRevCagr5y', $('f-cagr').value);
        set('minNetMargin', $('f-margin').value);
        set('minRoe', $('f-roe').value);
        set('maxPe', $('f-pe').value);
        set('minDivYield', $('f-div').value);
        set('minMarketCapB', $('f-mcap').value);
        set('minQtrEarningsGrowth', $('f-qtr').value);
        set('minProfitableYears', $('f-prof').value);
        if ($('f-fcf').checked) set('fcfPositive', '1');
        set('sortBy', sortBy);
        set('limit', '100');
        return p;
    }

    function render(rows) {
        lastRows = rows;
        const body = $('results-body');
        if (!rows.length) {
            body.innerHTML = '<tr><td colspan="10" class="scrn-empty">No companies match this screen — try loosening a filter.</td></tr>';
            return;
        }
        const dest = localStorage.getItem('token') ? 'fundamentals.html' : 'demo-fundamentals.html';
        body.innerHTML = rows.map((r) => `
          <tr data-symbol="${r.symbol}">
            <td class="scrn-company"><a href="${dest}?symbol=${encodeURIComponent(r.symbol)}"><span class="scrn-sym">${r.symbol}</span> ${r.name}</a></td>
            <td class="scrn-sector">${r.sector || '–'}</td>
            <td>${fmtCap(r.marketCapB)}</td>
            <td>${fmt(r.pe, 1)}</td>
            <td class="${r.revCagr5Pct > 0 ? 'fin-up' : r.revCagr5Pct < 0 ? 'fin-down' : ''}">${fmt(r.revCagr5Pct, 1, '%')}</td>
            <td>${fmt(r.netMarginPct, 1, '%')}</td>
            <td>${fmt(r.roePct, 1, '%')}</td>
            <td>${fmt(r.divYieldPct, 2, '%')}</td>
            <td class="${r.qtrNetIncomeYoYPct > 0 ? 'fin-up' : r.qtrNetIncomeYoYPct < 0 ? 'fin-down' : ''}">${fmt(r.qtrNetIncomeYoYPct, 1, '%')}</td>
            <td>${r.profitableYears10 ?? '–'}</td>
          </tr>`).join('');
    }

    async function run() {
        $('results-body').innerHTML = '<tr><td colspan="10" class="scrn-empty">Screening…</td></tr>';
        try {
            const r = await fetch(`${API}/screener?${params()}`);
            const data = await r.json();
            if (!r.ok) throw new Error(data.message || 'failed');
            $('result-count').textContent = `${data.matched} of ${String(data.universe).match(/\d+/)?.[0] || data.universe} companies match`;
            render(data.rows || []);
            if (data.sectors && $('f-sector').options.length <= 1) {
                for (const s of data.sectors) {
                    const o = document.createElement('option');
                    o.value = s; o.textContent = s;
                    $('f-sector').appendChild(o);
                }
            }
        } catch (e) {
            $('results-body').innerHTML = '<tr><td colspan="10" class="scrn-empty">Screener unavailable — please try again.</td></tr>';
        }
    }

    document.querySelectorAll('.scrn-preset').forEach((btn) => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.scrn-preset').forEach((b) => b.classList.remove('active'));
            const p = PRESETS[btn.dataset.preset] || {};
            if (btn.dataset.preset !== 'clear') btn.classList.add('active');
            $('f-cagr').value = p.cagr ?? '';
            $('f-margin').value = p.margin ?? '';
            $('f-roe').value = p.roe ?? '';
            $('f-pe').value = p.pe ?? '';
            $('f-div').value = p.div ?? '';
            $('f-mcap').value = '';
            $('f-qtr').value = p.qtr ?? '';
            $('f-prof').value = p.prof ?? '';
            $('f-fcf').checked = !!p.fcf;
            $('f-sector').value = '';
            sortBy = p.sort || 'marketCapB';
            run();
        });
    });

    document.querySelectorAll('th.sortable').forEach((th) => {
        th.addEventListener('click', () => {
            const key = th.dataset.sort;
            if (['symbol', 'sector'].includes(key)) {
                lastRows.sort((a, b) => String(a[key]).localeCompare(String(b[key])));
                render(lastRows);
                return;
            }
            sortBy = key;
            document.querySelectorAll('th.sortable').forEach((t) => t.classList.remove('sorted'));
            th.classList.add('sorted');
            run();
        });
    });

    $('run-btn').addEventListener('click', run);
    document.querySelectorAll('.scrn-field input').forEach((el) => {
        el.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
    });
    $('f-sector').addEventListener('change', run);

    run();
})();
