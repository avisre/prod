// Portfolio X-Ray — renders look-through fundamentals on the dashboard.
(function () {
    'use strict';

    function apiBase() {
        const host = window.location.hostname;
        if (host === 'localhost' || host === '127.0.0.1') return `${window.location.protocol}//${window.location.host}/api`;
        return 'https://stockportfolio.pro/api';
    }
    const API = apiBase();
    const $ = (id) => document.getElementById(id);

    function fmt(v, dp, suffix) {
        if (v === null || v === undefined || Number.isNaN(v)) return '–';
        return Number(v).toFixed(dp) + (suffix || '');
    }

    function tile(label, value, sub) {
        return `<div class="xray-tile"><div class="xray-tile-label">${label}</div><div class="xray-tile-value">${value}</div>${sub ? `<div class="xray-tile-sub">${sub}</div>` : ''}</div>`;
    }

    async function load() {
        const section = $('xray-section');
        if (!section) return;
        const token = localStorage.getItem('token');
        if (!token) return;
        try {
            const r = await fetch(`${API}/portfolio/xray`, { headers: { Authorization: `Bearer ${token}` } });
            if (!r.ok) return;
            const d = await r.json();
            if (d.empty) return;
            section.hidden = false;

            const lt = d.lookThrough || {};
            $('xray-tiles').innerHTML = [
                tile('Look-through P/E', fmt(lt.peRatio, 1), 'what you pay per £1 of earnings'),
                tile('Net margin', fmt(lt.netMarginPct, 1, '%'), 'value-weighted across holdings'),
                tile('ROE', fmt(lt.roePct, 1, '%'), 'value-weighted'),
                tile('Revenue growth', fmt(lt.revCagr5Pct, 1, '%/yr'), '5-yr CAGR, value-weighted'),
                tile('Dividend yield', fmt(lt.divYieldPct, 2, '%'), 'value-weighted'),
                tile('Health pass rate', fmt(lt.healthPassPct, 0, '%'), 'of weighted health checks')
            ].join('');

            const c = d.concentration || {};
            const conc = [];
            if (c.topHolding) conc.push(`Your largest position <strong>${c.topHolding}</strong> is ${fmt(c.topHoldingPct, 1, '%')} of the portfolio; the top 3 are ${fmt(c.top3Pct, 1, '%')}.`);
            if (c.topSector) conc.push(`Biggest sector exposure: <strong>${c.topSector.sector}</strong> at ${fmt(c.topSector.weightPct, 1, '%')}.`);
            if (d.coveragePct < 100) conc.push(`<span class="xray-dim">${d.coveragePct}% of portfolio value is covered by our fundamentals data.</span>`);
            $('xray-concentration').innerHTML = conc.join(' ');

            $('xray-body').innerHTML = (d.positions || []).map((p) => `
              <tr>
                <td><a href="fundamentals.html?symbol=${encodeURIComponent(p.symbol)}" class="xray-sym">${p.symbol}</a></td>
                <td>${fmt(p.weightPct, 1, '%')}</td>
                <td>${fmt(p.pe, 1)}</td>
                <td>${fmt(p.netMarginPct, 1, '%')}</td>
                <td>${fmt(p.roePct, 1, '%')}</td>
                <td class="${p.revCagr5Pct > 0 ? 'xray-up' : p.revCagr5Pct < 0 ? 'xray-down' : ''}">${fmt(p.revCagr5Pct, 1, '%')}</td>
                <td class="${p.qtrEarningsYoYPct > 0 ? 'xray-up' : p.qtrEarningsYoYPct < 0 ? 'xray-down' : ''}">${fmt(p.qtrEarningsYoYPct, 1, '%')}</td>
                <td>${p.healthScore || '–'}${p.healthFails && p.healthFails.length ? `<span class="xray-fails" title="${p.healthFails.join('; ')}">⚠</span>` : ''}</td>
              </tr>`).join('');
        } catch (_) { /* leave hidden */ }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
    else load();
})();
