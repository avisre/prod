// Alerts panel — Filing Watchdog + health-check flips on the dashboard.
(function () {
    'use strict';

    function apiBase() {
        const host = window.location.hostname;
        if (host === 'localhost' || host === '127.0.0.1') return `${window.location.protocol}//${window.location.host}/api`;
        return 'https://stockportfolio.pro/api';
    }
    const API = apiBase();
    const $ = (id) => document.getElementById(id);

    function escapeHtml(s) {
        return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }

    function timeAgo(iso) {
        const ms = Date.now() - new Date(iso).getTime();
        const mins = Math.floor(ms / 60000);
        if (mins < 60) return `${Math.max(1, mins)}m ago`;
        const hrs = Math.floor(mins / 60);
        if (hrs < 48) return `${hrs}h ago`;
        return `${Math.floor(hrs / 24)}d ago`;
    }

    function icon(type, title) {
        if (type === 'filing') return '📄';
        return /PASS/.test(title) ? '✅' : '⚠️';
    }

    function render(d) {
        const section = $('alerts-section');
        const list = $('alerts-list');
        const badge = $('alerts-badge');
        const empty = $('alerts-empty');
        if (!section || !list) return;
        section.hidden = false;
        if (badge) {
            badge.textContent = d.unseen > 0 ? `${d.unseen} new` : 'Up to date';
            badge.classList.toggle('has-new', d.unseen > 0);
        }
        if (!d.alerts.length) {
            if (empty) empty.hidden = false;
            return;
        }
        if (empty) empty.hidden = true;
        list.innerHTML = d.alerts.map((a) => {
            const external = /^https?:/i.test(a.url || '');
            const href = a.url ? escapeHtml(a.url) : '';
            const inner = `
              <span class="alert-icon" aria-hidden="true">${icon(a.type, a.title)}</span>
              <span class="alert-main">
                <span class="alert-title">${escapeHtml(a.title)}</span>
                ${a.detail ? `<span class="alert-detail">${escapeHtml(a.detail)}</span>` : ''}
              </span>
              <span class="alert-time">${timeAgo(a.createdAt)}</span>`;
            const cls = `alert-item${a.seenAt ? '' : ' unseen'}`;
            return href
                ? `<a class="${cls}" href="${href}" ${external ? 'target="_blank" rel="noopener"' : ''}>${inner}</a>`
                : `<div class="${cls}">${inner}</div>`;
        }).join('');
    }

    async function load() {
        const section = $('alerts-section');
        if (!section) return;
        const token = localStorage.getItem('token');
        if (!token) return;
        try {
            const r = await fetch(`${API}/alerts`, { headers: { Authorization: `Bearer ${token}` } });
            if (!r.ok) return;
            const d = await r.json();
            if (!Array.isArray(d.alerts)) return;
            // Only surface the card once there has ever been something to say.
            if (!d.alerts.length) { section.hidden = false; const empty = $('alerts-empty'); if (empty) empty.hidden = false; }
            render(d);
            const markBtn = $('alerts-mark-read');
            if (markBtn) {
                markBtn.onclick = async () => {
                    markBtn.disabled = true;
                    try {
                        await fetch(`${API}/alerts/seen`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
                        const badge = $('alerts-badge');
                        if (badge) { badge.textContent = 'Up to date'; badge.classList.remove('has-new'); }
                        document.querySelectorAll('#alerts-list .alert-item.unseen').forEach((el) => el.classList.remove('unseen'));
                    } finally {
                        markBtn.disabled = false;
                    }
                };
            }
        } catch (_) { /* alerts are an enhancement — never break the dashboard */ }
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', load);
    else load();
})();
