// stockportfolio.pro v2 — shared runtime: nav, search, formatters,
// sparklines, markdown, and the inline streaming Ask component.
(function () {
    'use strict';

    const API = `${window.location.origin}/api`;
    const token = () => localStorage.getItem('token');

    // ---------- first-party page-view ping (server-side count, no cookies) ----------
    try {
        const pv = JSON.stringify({ path: location.pathname });
        const sent = navigator.sendBeacon && navigator.sendBeacon('/api/track/page_view', new Blob([pv], { type: 'application/json' }));
        if (!sent) fetch('/api/track/page_view', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: pv, keepalive: true }).catch(() => {});
    } catch (_) { /* never block the page */ }

    // ---------- formatters ----------
    function num(v) {
        if (v === null || v === undefined || v === '' || v === 'None') return null;
        const n = Number(v);
        return Number.isFinite(n) ? n : null;
    }
    // Compact money: 416.16B, 93.7M — annual-report scale, tabular-safe.
    function money(v, dp) {
        const n = num(v);
        if (n === null) return '—';
        const a = Math.abs(n);
        const f = (x, d) => x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
        if (a >= 1e12) return f(n / 1e12, dp ?? 2) + 'T';
        if (a >= 1e9) return f(n / 1e9, dp ?? 2) + 'B';
        if (a >= 1e6) return f(n / 1e6, dp ?? 1) + 'M';
        if (a >= 1e3) return f(n / 1e3, dp ?? 1) + 'K';
        return f(n, dp ?? 2);
    }
    function pct(v, dp = 1) {
        const n = num(v);
        return n === null ? '—' : n.toFixed(dp) + '%';
    }
    function fixed(v, dp = 2) {
        const n = num(v);
        return n === null ? '—' : n.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: dp });
    }
    function fy(dateStr) {
        if (!dateStr) return '—';
        const d = new Date(dateStr);
        if (Number.isNaN(+d)) return String(dateStr);
        return "FY '" + String(d.getFullYear()).slice(2) + ' (' + d.toLocaleString('en-US', { month: 'short' }) + ')';
    }
    function esc(s) {
        return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    // ---------- sparkline ----------
    // values oldest→newest; meaning color from direction unless neutral.
    function sparkline(values, { neutral = false } = {}) {
        const vs = values.filter((v) => v !== null && Number.isFinite(v));
        if (vs.length < 3) return '';
        const w = 84, h = 22, pad = 2;
        const min = Math.min(...vs), max = Math.max(...vs);
        const span = max - min || 1;
        const pts = vs.map((v, i) => [
            pad + (i / (vs.length - 1)) * (w - 2 * pad),
            h - pad - ((v - min) / span) * (h - 2 * pad)
        ]);
        const d = pts.map((p, i) => (i ? 'L' : 'M') + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ');
        const cls = neutral ? 'flat' : (vs[vs.length - 1] >= vs[0] ? 'pos' : 'neg');
        return `<svg class="spark" viewBox="0 0 ${w} ${h}" aria-hidden="true"><path class="${cls}" d="${d}"/></svg>`;
    }

    // ---------- chart (the system's only chart: line on hairlines) ----------
    // series: [{values:[...oldest→newest], cls:'ink'|'accent'}], labels: per-point x labels
    function chart(series, labels, { fmt = (v) => String(v), height = 220 } = {}) {
        const all = series.flatMap((s) => s.values).filter((v) => v !== null && Number.isFinite(v));
        if (all.length < 2) return '';
        const W = 760, H = height, padL = 56, padR = 20, padT = 28, padB = 26;
        let min = Math.min(...all, 0 < Math.min(...all) ? Infinity : 0);
        let max = Math.max(...all, 0 > Math.max(...all) ? -Infinity : 0);
        if (min === max) { min -= 1; max += 1; }
        const span = max - min;
        min -= span * 0.04; max += span * 0.04;
        const x = (i, n) => padL + (n < 2 ? 0 : (i / (n - 1)) * (W - padL - padR));
        const y = (v) => padT + (1 - (v - min) / (max - min)) * (H - padT - padB);
        // 4 clean y ticks
        const ticks = [];
        for (let i = 0; i <= 3; i++) ticks.push(min + ((max - min) * i) / 3);
        let g = '';
        for (const t of ticks) {
            g += `<line x1="${padL}" y1="${y(t).toFixed(1)}" x2="${W - padR}" y2="${y(t).toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`;
            g += `<text x="${padL - 8}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end" font-size="10.5" fill="var(--ink-3)" style="font-variant-numeric:tabular-nums">${esc(fmt(t))}</text>`;
        }
        if (min < 0 && max > 0) {
            g += `<line x1="${padL}" y1="${y(0).toFixed(1)}" x2="${W - padR}" y2="${y(0).toFixed(1)}" stroke="var(--line-strong)" stroke-width="1"/>`;
        }
        // x labels: up to 7
        const n = Math.max(...series.map((s) => s.values.length));
        const step = Math.max(1, Math.ceil(n / 7));
        for (let i = 0; i < n; i += step) {
            if (labels && labels[i] !== undefined) {
                g += `<text x="${x(i, n).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10.5" fill="var(--ink-3)">${esc(String(labels[i]))}</text>`;
            }
        }
        const colors = { ink: 'var(--ink)', accent: 'var(--accent)', pos: 'var(--pos)', neg: 'var(--neg)', faint: 'var(--ink-3)' };
        for (const s of series) {
            const vs = s.values;
            let d = ''; let started = false;
            vs.forEach((v, i) => {
                if (v === null || !Number.isFinite(v)) { started = false; return; }
                d += (started ? 'L' : 'M') + x(i, vs.length).toFixed(1) + ' ' + y(v).toFixed(1) + ' ';
                started = true;
            });
            const col = colors[s.cls || 'ink'] || colors.ink;
            g += `<path d="${d.trim()}" fill="none" stroke="${col}" stroke-width="1.8" stroke-linejoin="round" stroke-linecap="round"/>`;
            // endpoint dot + value — haloed in paper so the line can never
            // swallow it, and flipped below the point when it's near the top
            for (let i = vs.length - 1; i >= 0; i--) {
                if (vs[i] !== null && Number.isFinite(vs[i])) {
                    const ex = x(i, vs.length); const ey = y(vs[i]);
                    const below = ey < padT + (H - padT - padB) * 0.25;
                    const ly = below ? ey + 17 : ey - 9;
                    g += `<circle cx="${ex.toFixed(1)}" cy="${ey.toFixed(1)}" r="3" fill="${col}"/>`;
                    g += `<text x="${(ex - 7).toFixed(1)}" y="${ly.toFixed(1)}" text-anchor="end" font-size="11" font-weight="600" fill="${col}" stroke="var(--surface)" stroke-width="3.5" paint-order="stroke" style="font-variant-numeric:tabular-nums">${esc(fmt(vs[i]))}</text>`;
                    break;
                }
            }
        }
        return `<svg viewBox="0 0 ${W} ${H}" style="width:100%; max-width:880px; height:auto; display:block;" role="img">${g}</svg>`;
    }

    // ---------- Ask viz blocks (```viz {json}```) → the system chart ----------
    function vizFmt(unit) {
        if (unit === '$') return (v) => money(v);
        if (unit === '%') return (v) => (Math.round(v * 10) / 10) + '%';
        if (unit === 'x') return (v) => (Math.round(v * 10) / 10) + '×';
        if (unit === '$ps') return (v) => '$' + fixed(v, 2);
        return (v) => money(v) || String(v);
    }
    function vizBlock(json) {
        let spec;
        try { spec = JSON.parse(json); } catch (_) {
            // models sometimes drop a trailing bracket — auto-close and retry
            let depth = []; let inStr = false; let escp = false;
            for (const ch of json) {
                if (escp) { escp = false; continue; }
                if (ch === '\\') { escp = true; continue; }
                if (ch === '"') { inStr = !inStr; continue; }
                if (inStr) continue;
                if (ch === '{' || ch === '[') depth.push(ch);
                else if (ch === '}' || ch === ']') depth.pop();
            }
            const closers = depth.reverse().map((c) => (c === '{' ? '}' : ']')).join('');
            try { spec = JSON.parse(json + closers); } catch (_2) { return ''; }
        }
        const series = (Array.isArray(spec.series) ? spec.series : []).slice(0, 3)
            .map((s) => ({
                name: String(s.name || ''),
                points: (Array.isArray(s.points) ? s.points : [])
                    .filter((p) => Array.isArray(p) && p.length === 2 && Number.isFinite(Number(p[1])))
            }))
            .filter((s) => s.points.length >= 2);
        if (!series.length) return '';
        const labels = series.reduce((a, s) => (s.points.length > a.length ? s.points.map((p) => String(p[0])) : a), []);
        const cls = ['ink', 'accent', 'pos'];
        const chartSeries = series.map((s, i) => {
            const map = new Map(s.points.map((p) => [String(p[0]), Number(p[1])]));
            return { values: labels.map((l) => (map.has(l) ? map.get(l) : null)), cls: cls[i % 3] };
        });
        const svg = chart(chartSeries, labels, { fmt: vizFmt(spec.unit), height: 240 });
        if (!svg) return '';
        const legend = series.length > 1
            ? `<div class="ask-viz-legend">${series.map((s, i) => `<span><i class="lg lg-${cls[i % 3]}"></i>${esc(s.name)}</span>`).join('')}</div>`
            : '';
        return `<figure class="ask-viz">${spec.title ? `<figcaption class="label">${esc(String(spec.title))}</figcaption>` : ''}${svg}${legend}</figure>`;
    }

    // ---------- minimal markdown (Ask answers) ----------
    function inlineMd(s) {
        return s
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    }
    function markdown(text) {
        // lift ```viz blocks out before escaping; render them as charts.
        // A still-streaming (unclosed) fence is hidden until it completes.
        const vizzes = [];
        let src = String(text || '').replace(/```viz\s*\n([\s\S]*?)```/g, (m, body) => {
            vizzes.push(vizBlock(body.trim()));
            return `\nVIZBLOCK${vizzes.length - 1}END\n`;
        });
        src = src.replace(/```viz[\s\S]*$/, '');
        src = src.replace(/```[a-z]*\n?([\s\S]*?)```/g, '$1');
        const lines = esc(src).split('\n');
        const out = [];
        let list = null;
        let i = 0;
        const close = () => { if (list) { out.push(`</${list}>`); list = null; } };
        while (i < lines.length) {
            const line = lines[i];
            const viz = line.match(/^VIZBLOCK(\d+)END$/);
            if (viz) { close(); out.push(vizzes[Number(viz[1])] || ''); i++; continue; }
            const quote = line.match(/^\s*&gt;\s*(.*)$/);
            if (quote) {
                close();
                const next = quote[1].match(/^Next:\s*(.+)$/i);
                if (next) out.push(`<p><button type="button" class="ask-next" data-q="${next[1].replace(/"/g, '&quot;')}">${inlineMd(next[1])} →</button></p>`);
                else out.push(`<p class="ask-quote">${inlineMd(quote[1])}</p>`);
                i++; continue;
            }
            if (line.includes('|') && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[i + 1])) {
                close();
                const cells = (l) => l.replace(/^\s*\|/, '').replace(/\|\s*$/, '').split('|').map((c) => inlineMd(c.trim()));
                out.push('<table><thead><tr>' + cells(line).map((c) => `<th>${c}</th>`).join('') + '</tr></thead><tbody>');
                i += 2;
                while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') {
                    out.push('<tr>' + cells(lines[i]).map((c) => `<td>${c}</td>`).join('') + '</tr>');
                    i++;
                }
                out.push('</tbody></table>');
                continue;
            }
            if (/^\s*[-*_]{3,}\s*$/.test(line)) { close(); i++; continue; } // hr → just a pause
            const h = line.match(/^(#{1,4})\s+(.*)$/);
            const ul = line.match(/^\s*[-*]\s+(.*)$/);
            const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
            if (h) { close(); out.push(`<p><strong>${inlineMd(h[2])}</strong></p>`); }
            else if (ul) { if (list !== 'ul') { close(); out.push('<ul>'); list = 'ul'; } out.push(`<li>${inlineMd(ul[1])}</li>`); }
            else if (ol) { if (list !== 'ol') { close(); out.push('<ol>'); list = 'ol'; } out.push(`<li>${inlineMd(ol[1])}</li>`); }
            else if (line.trim() === '') close();
            else if (/^\*\*The read\*\*/i.test(line.trim())) { close(); out.push(`<p class="ask-read">${inlineMd(line)}</p>`); }
            else { close(); out.push(`<p>${inlineMd(line)}</p>`); }
            i++;
        }
        close();
        return out.join('');
    }

    // ---------- loading ring ----------
    const spinner = (label) => `<span class="loading-line"><span class="spin" aria-hidden="true"></span>${esc(label || 'Loading…')}</span>`;

    // ---------- Ask quota wall ----------
    // Shown when a free/core user spends their monthly Ask allowance. Instead
    // of a flat "limit reached" line, show a blurred ghost of an answer's shape
    // (the value is seen, not described) above one upgrade panel with the plan
    // ladder and a single CTA. Pro users just get a reset note, no upsell.
    const ASK_PLANS = {
        free: { name: 'Free', price: '£0', per: '/forever', q: 3 },
        core: { name: 'Core', price: '£9', per: '/mo', q: 25 },
        pro: { name: 'Pro', price: '£25', per: '/mo', q: 300 }
    };
    function quotaWall(data) {
        const limit = (data && data.quota && Number(data.quota.limit)) || 3;
        // trust the server's tier when it sends one (survives AI_CHAT_*_LIMIT env
        // overrides); fall back to inferring from the limit for older responses
        const sent = data && data.tier;
        const tier = (sent === 'pro' || sent === 'core' || sent === 'free')
            ? sent
            : (limit >= 300 ? 'pro' : limit >= 25 ? 'core' : 'free');
        if (tier === 'pro') {
            return `<div class="notice">${esc((data && data.message) || "You've used all your Ask questions this month — the counter resets on the 1st.")}</div>`;
        }
        const cards = ['free', 'core', 'pro'].map((k) => {
            const p = ASK_PLANS[k];
            const current = k === tier;
            const pick = k === 'pro' && tier !== 'pro';
            return `<div class="ask-plan${current ? ' is-current' : ''}${pick ? ' is-pick' : ''}">
                <div class="pn">${p.name}</div>
                <div class="pp">${p.price}<span>${esc(p.per)}</span></div>
                <div class="pq"><strong>${p.q}</strong> Ask / mo</div>
                ${current ? '<div class="tag">Your plan</div>' : pick ? '<div class="tag">Recommended</div>' : ''}
              </div>`;
        }).join('');
        return `<div class="ask-wall">
          <div class="ask-wall-ghost" aria-hidden="true">
            <div class="g h"></div>
            <div class="g s"></div><div class="g m"></div><div class="g t"></div>
            <div class="g-row"><div class="g"></div><div class="g"></div><div class="g"></div>
              <div class="g"></div><div class="g"></div><div class="g"></div></div>
            <div class="g s"></div><div class="g m"></div>
          </div>
          <div class="ask-wall-panel">
            <h3>That's your ${limit} Ask questions for this month.</h3>
            <p class="sub">Upgrade to keep going — comparisons, screens, portfolio Q&amp;A, with charts, tables and a source under every figure. The counter resets on the 1st either way.</p>
            <div class="ask-plans">${cards}</div>
            <a class="btn btn-primary ask-wall-cta" href="/register.html?plan=pro">Start Pro free trial</a>
          </div>
        </div>`;
    }

    // ---------- analytics, consent-gated (prod hostname only) ----------
    // Nothing loads until the user says yes; the choice is remembered and
    // shared with v1 (same key). Decline = the scripts never exist.
    const CONSENT_KEY = 'sp_analytics_consent_v1';
    function loadAnalytics() {
        if (!location.hostname.endsWith('stockportfolio.pro') || window.__spAnalytics) return;
        window.__spAnalytics = true;
        window.dataLayer = window.dataLayer || [];
        window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
        window.gtag('js', new Date());
        window.gtag('config', 'G-4K10D2FPTT', { anonymize_ip: true });
        const g = document.createElement('script');
        g.async = true; g.src = 'https://www.googletagmanager.com/gtag/js?id=G-4K10D2FPTT';
        document.head.appendChild(g);
        (function (c, l, a, r, i) {
            c[a] = c[a] || function () { (c[a].q = c[a].q || []).push(arguments); };
            const t = l.createElement(r); t.async = 1; t.src = 'https://www.clarity.ms/tag/' + i;
            const y = l.getElementsByTagName(r)[0]; y.parentNode.insertBefore(t, y);
        })(window, document, 'clarity', 'script', 'x0dsu053xa');
    }
    function mountConsent() {
        let choice = '';
        try { choice = localStorage.getItem(CONSENT_KEY) || ''; } catch (_) { /* private mode */ }
        if (choice === 'granted') { loadAnalytics(); return; }
        if (choice === 'denied') return;
        if (!location.hostname.endsWith('stockportfolio.pro')) return; // nothing to consent to locally
        const el = document.createElement('aside');
        el.className = 'consent';
        el.setAttribute('role', 'dialog');
        el.setAttribute('aria-label', 'Analytics consent');
        el.innerHTML = `
          <p><strong>Optional analytics.</strong> We'd like to measure which pages convert — nothing else, no ad tracking. Allow it?</p>
          <div class="consent-actions">
            <button class="btn btn-primary btn-sm" data-c="granted">Allow</button>
            <button class="btn btn-ghost btn-sm" data-c="denied">Decline</button>
            <a href="/privacy.html">Privacy</a>
          </div>`;
        el.querySelectorAll('[data-c]').forEach((b) =>
            b.addEventListener('click', () => {
                try { localStorage.setItem(CONSENT_KEY, b.dataset.c); } catch (_) { /* private mode */ }
                if (b.dataset.c === 'granted') loadAnalytics();
                el.remove();
            }));
        document.body.appendChild(el);
    }

    // ---------- nav ----------
    function nav(current) {
        const authed = !!token();
        const cur = (page) => current === page ? "aria-current='page'" : '';
        const el = document.createElement('header');
        el.className = 'nav';
        el.innerHTML = `
          <div class="container nav-inner">
            <a class="wordmark" href="/index.html">stockportfolio<span>.pro</span></a>
            <nav class="nav-links" aria-label="Primary">
              <a href="/screener.html" ${cur('screener')}>Screener</a>
              <a href="/company.html?symbol=AAPL" ${cur('company')}>Companies</a>
              <a href="/news.html" ${cur('news')}>Markets</a>
              <a href="/ask.html" ${cur('ask')}>Ask&nbsp;AI</a>
              <a href="/dashboard.html" ${cur('dashboard')}>Portfolio</a>
              <a href="/gurus.html" ${cur('gurus')}>Gurus</a>
              <a href="/monitor.html" ${cur('monitor')}>Monitor</a>
              <a href="/dossier.html" ${cur('dossier')}>Dossier</a>
            </nav>
            <div class="nav-spacer"></div>
            <div class="nav-search">
              <input type="search" id="v2-search" placeholder="Search any US-listed company…" autocomplete="off"
                     aria-label="Search companies" />
              <div class="nav-search-results" id="v2-search-results" hidden></div>
            </div>
            ${authed
                ? `<a class="btn btn-quiet" href="#" id="v2-signout">Sign out</a>`
                : `<a class="btn btn-quiet" href="/login.html">Log in</a>
                   <a class="btn btn-primary btn-sm" href="/register.html">Sign up free</a>`}
            <button class="nav-ham" id="v2-ham" aria-label="Open menu" aria-expanded="false" aria-controls="v2-mobile-nav">
              <svg width="20" height="15" viewBox="0 0 20 15" fill="currentColor" aria-hidden="true">
                <rect y="0" width="20" height="2" rx="1"/><rect y="6.5" width="20" height="2" rx="1"/><rect y="13" width="20" height="2" rx="1"/>
              </svg>
            </button>
          </div>
          <div class="nav-mobile" id="v2-mobile-nav" aria-hidden="true">
            <div class="nav-mobile-dim" id="v2-mobile-dim"></div>
            <div class="nav-mobile-panel" role="dialog" aria-label="Navigation">
              <div class="nav-mobile-top">
                <a class="wordmark" href="/index.html">stockportfolio<span>.pro</span></a>
                <button class="nav-mobile-close" id="v2-mobile-close" aria-label="Close menu">✕</button>
              </div>
              <nav>
                <a href="/screener.html" ${cur('screener')}>Screener</a>
                <a href="/company.html?symbol=AAPL" ${cur('company')}>Companies</a>
                <a href="/news.html" ${cur('news')}>Markets</a>
                <a href="/ask.html" ${cur('ask')}>Ask&nbsp;AI</a>
                <a href="/dashboard.html" ${cur('dashboard')}>Portfolio</a>
                <a href="/gurus.html" ${cur('gurus')}>Guru Portfolios</a>
                <a href="/monitor.html" ${cur('monitor')}>Filing Monitor</a>
                <a href="/dossier.html" ${cur('dossier')}>Research Dossier</a>
              </nav>
              <div class="nav-mobile-auth">
                ${authed
                    ? `<a class="btn btn-ghost" href="#" id="v2-mobile-signout">Sign out</a>`
                    : `<a class="btn btn-ghost" href="/login.html">Log in</a>
                       <a class="btn btn-primary" href="/register.html">Start free trial</a>`}
              </div>
            </div>
          </div>`;
        document.body.prepend(el);

        // Mobile nav open/close
        const ham = el.querySelector('#v2-ham');
        const mobileNav = el.querySelector('#v2-mobile-nav');
        const dim = el.querySelector('#v2-mobile-dim');
        const closeBtn = el.querySelector('#v2-mobile-close');
        function openMenu() {
            mobileNav.setAttribute('aria-hidden', 'false');
            ham.setAttribute('aria-expanded', 'true');
            document.body.style.overflow = 'hidden';
            requestAnimationFrame(() => mobileNav.classList.add('is-open'));
        }
        function closeMenu() {
            mobileNav.classList.remove('is-open');
            ham.setAttribute('aria-expanded', 'false');
            document.body.style.overflow = '';
            setTimeout(() => mobileNav.setAttribute('aria-hidden', 'true'), 240);
        }
        ham.addEventListener('click', openMenu);
        dim.addEventListener('click', closeMenu);
        closeBtn.addEventListener('click', closeMenu);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mobileNav.classList.contains('is-open')) closeMenu(); });

        const out = el.querySelector('#v2-signout');
        if (out) out.addEventListener('click', (e) => { e.preventDefault(); localStorage.removeItem('token'); location.reload(); });
        const mobileOut = el.querySelector('#v2-mobile-signout');
        if (mobileOut) mobileOut.addEventListener('click', (e) => { e.preventDefault(); localStorage.removeItem('token'); location.reload(); });

        wireSearch(el.querySelector('#v2-search'), el.querySelector('#v2-search-results'));
        mountConsent();
    }

    // company search over the full US-listed directory (static, cached)
    let _companies = null;
    async function companies() {
        if (_companies) return _companies;
        // the full US universe (~10.4k SEC registrants, market-cap ordered);
        // falls back to the S&P 1500 list if the big directory is missing
        for (const src of ['/data/us-companies.json', '/data/sp1500-companies.json']) {
            try {
                const r = await fetch(src);
                if (!r.ok) continue;
                const d = await r.json();
                _companies = Array.isArray(d) ? d : (d.companies || []);
                if (_companies.length) return _companies;
            } catch (_) { /* try next */ }
        }
        _companies = [];
        return _companies;
    }
    function wireSearch(input, results) {
        if (!input) return;
        let items = [];
        let active = -1;
        const render = () => {
            if (!items.length) { results.hidden = true; return; }
            results.innerHTML = items.map((c, i) =>
                `<a href="/company.html?symbol=${encodeURIComponent(c.symbol)}" class="${i === active ? 'is-active' : ''}">
                   <span class="sym">${esc(c.symbol)}</span><span class="nm">${esc(c.name)}</span></a>`).join('');
            results.hidden = false;
        };
        input.addEventListener('input', async () => {
            const q = input.value.trim().toUpperCase();
            if (q.length < 1) { results.hidden = true; return; }
            const list = await companies();
            const starts = list.filter((c) => c.symbol.startsWith(q));
            const names = list.filter((c) => !c.symbol.startsWith(q) && (c.name || '').toUpperCase().includes(q));
            items = starts.concat(names).slice(0, 8);
            active = -1;
            render();
        });
        input.addEventListener('keydown', (e) => {
            if (results.hidden) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, items.length - 1); render(); }
            if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
            if (e.key === 'Enter' && active >= 0) { e.preventDefault(); location.href = `/company.html?symbol=${items[active].symbol}`; }
            if (e.key === 'Escape') { results.hidden = true; }
        });
        document.addEventListener('click', (e) => { if (!results.contains(e.target) && e.target !== input) results.hidden = true; });
    }

    function footer() {
        const el = document.createElement('footer');
        el.className = 'footer';
        el.innerHTML = `
          <div class="container footer-inner">
            <div>© 2026 stockportfolio.pro — figures from SEC filings (10-K/10-Q), as filed; per-share figures split-adjusted. Not investment advice.</div>
            <div style="display:flex; gap:8px 18px; flex-wrap:wrap;">
              <a href="/stocks">All stocks</a><a href="/gurus.html">Gurus</a><a href="/tour">Tour</a><a href="/privacy.html">Privacy</a><a href="/terms.html">Terms</a><a href="/support.html">Support</a><a href="/sitemap.html">Sitemap</a>
            </div>
          </div>`;
        document.body.appendChild(el);
    }

    // ---------- Ask (one streaming engine, two shells: inline + floor) ----------
    const TOOL_LABELS = {
        get_financials: (a) => `${(a.symbol || '').toUpperCase()} ${a.statement || ''} statements`,
        get_ratios_history: (a) => `${(a.symbol || '').toUpperCase()} ratio history`,
        get_health_checks: (a) => `${(a.symbol || '').toUpperCase()} health checks`,
        get_quote: (a) => `${(a.symbol || '').toUpperCase()} snapshot`,
        get_price_history: (a) => `${(a.symbol || '').toUpperCase()} 20-yr returns`,
        get_segments: (a) => `${(a.symbol || '').toUpperCase()} segments (10-K)`,
        get_insider_activity: (a) => `${(a.symbol || '').toUpperCase()} insider trades`,
        screen_universe: () => 'Screened the fundamentals universe',
        get_portfolio: () => 'Your portfolio',
        calculator: () => 'Calculator',
        search_web: (a) => `Searched the web: ${String(a.query || '').slice(0, 40)}`,
        search_filings: (a) => `Searched SEC filings: ${String(a.query || '').slice(0, 40)}`,
        fetch_page: (a) => { try { return 'Read ' + new URL(a.url).hostname.replace('www.', ''); } catch (_) { return 'Read a page'; } }
    };

    // outline thumb (drawn for this design — no icon font)
    const THUMB = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M5.5 7.5v6h-3v-6h3zm0 0 2.2-4.6a1.3 1.3 0 0 1 2.47.7L9.7 6h2.9a1.4 1.4 0 0 1 1.36 1.73l-1.1 4.7a1.4 1.4 0 0 1-1.36 1.07H5.5"/></svg>';

    function askEngine(exchange, { onActivity } = {}) {
        const history = [];
        let busy = false;
        let aborter = null;

        async function send(question) {
            if (busy) return;
            busy = true;
            if (onActivity) onActivity();
            aborter = new AbortController();
            const block = document.createElement('div');
            // the working state is ONE quiet line: the model's plan (or the
            // current step) with a stop affordance — no growing checklist.
            // The full trail collapses in behind a disclosure when done.
            block.innerHTML = `
              <div class="ask-q">${esc(question)}</div>
              <div class="ask-trace"></div>
              <div class="ask-a"></div>
              <div class="ask-working-row">
                <span class="ask-working">Reading the filings…</span>
                <button type="button" class="ask-stop" aria-label="Stop">stop</button>
              </div>`;
            exchange.appendChild(block);
            const traceEl = block.querySelector('.ask-trace');
            const answerEl = block.querySelector('.ask-a');
            const workingRow = block.querySelector('.ask-working-row');
            const workingEl = block.querySelector('.ask-working');
            const traceSteps = [];
            block.querySelector('.ask-stop').addEventListener('click', () => { if (aborter) aborter.abort(); });
            const renderTrace = () => {
                if (!traceSteps.length) { traceEl.innerHTML = ''; return; }
                traceEl.innerHTML = `
                  <details>
                    <summary>Researched ${traceSteps.length} source${traceSteps.length > 1 ? 's' : ''}</summary>
                    <div>${traceSteps.map((s) => `<span class="ask-step${s.miss ? ' ask-step-miss' : ''}">${esc(s.label)}</span>`).join('')}</div>
                  </details>`;
            };
            block.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            try {
                const r = await fetch(`${API}/ai/chat`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
                    body: JSON.stringify({ question, history: history.slice(-8), stream: true }),
                    signal: aborter.signal
                });
                const ct = r.headers.get('content-type') || '';
                if (!ct.includes('text/event-stream')) {
                    const data = await r.json().catch(() => ({}));
                    workingRow.remove();
                    if (r.status === 401) {
                        answerEl.innerHTML = `Ask needs an account — <a href="/login.html">log in</a> or <a href="/register.html?plan=free">create a free account</a>.`;
                    } else if (r.status === 429) {
                        answerEl.innerHTML = quotaWall(data);
                    } else if (data.answer) {
                        finish(data);
                    } else {
                        answerEl.textContent = 'Something went wrong — please try again.';
                    }
                    return;
                }
                let text = '';
                let finalData = null;
                const reader = r.body.getReader();
                const dec = new TextDecoder();
                let buf = '';
                const handle = (ev, d) => {
                    if (ev === 'tool') {
                        const fn = TOOL_LABELS[d.tool];
                        const label = fn ? fn(d.args || {}) : d.tool;
                        if (!traceSteps.some((s) => s.label === label)) traceSteps.push({ label, miss: d.ok === false });
                        // the live line shows only what's happening NOW
                        workingEl.textContent = label + '…';
                        workingRow.hidden = false;
                    } else if (ev === 'note') {
                        // the model's plan line — shown while tools run
                        workingEl.textContent = d.text || 'Reading the filings…';
                        workingRow.hidden = false;
                    } else if (ev === 'delta') {
                        text += d.text || '';
                        answerEl.innerHTML = markdown(text);
                        answerEl.classList.add('ask-cursor');
                        workingEl.textContent = 'Writing…'; // stop stays reachable
                        renderTrace();
                    } else if (ev === 'rollback') {
                        text = '';
                        answerEl.innerHTML = '';
                        workingRow.hidden = false;
                    } else if (ev === 'done') {
                        finalData = d;
                    }
                };
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buf += dec.decode(value, { stream: true });
                    let sep;
                    while ((sep = buf.indexOf('\n\n')) !== -1) {
                        const blockTxt = buf.slice(0, sep);
                        buf = buf.slice(sep + 2);
                        let ev = 'message'; let dataStr = '';
                        for (const ln of blockTxt.split('\n')) {
                            if (ln.startsWith('event:')) ev = ln.slice(6).trim();
                            else if (ln.startsWith('data:')) dataStr += ln.slice(5).trim();
                        }
                        if (!dataStr) continue;
                        try { handle(ev, JSON.parse(dataStr)); } catch (_) { /* skip bad frame */ }
                    }
                }
                answerEl.classList.remove('ask-cursor');
                workingRow.remove();
                renderTrace();
                if (finalData && finalData.answer) finish(finalData);
                else if (!text) answerEl.textContent = 'Something went wrong — please try again.';

                function finish(data) {
                    answerEl.classList.remove('ask-cursor');
                    if (workingRow.isConnected) workingRow.remove();
                    renderTrace();
                    answerEl.innerHTML = markdown(data.answer);
                    answerEl.querySelectorAll('.ask-next').forEach((b) =>
                        b.addEventListener('click', () => { b.disabled = true; send(b.dataset.q); }));
                    history.push({ role: 'user', content: question }, { role: 'assistant', content: data.answer });
                    // one quiet footer line: feedback · quota (the trace
                    // disclosure above already holds the sources)
                    const foot = document.createElement('div');
                    foot.className = 'ask-foot';
                    const quotaTxt = (data.quota && Number.isFinite(data.quota.limit))
                        ? `${Math.max(0, data.quota.limit - data.quota.used)} of ${data.quota.limit} left`
                        : '';
                    foot.innerHTML = `
                      <span class="ask-fb" role="group" aria-label="Was this helpful?">
                        <button type="button" data-v="up" title="Helpful" aria-label="Helpful">${THUMB}</button>
                        <button type="button" data-v="down" title="Not helpful" aria-label="Not helpful" style="transform:scaleY(-1);">${THUMB}</button>
                      </span>
                      ${quotaTxt ? `<span>${quotaTxt}</span>` : ''}`;
                    foot.querySelectorAll('.ask-fb button').forEach((b) =>
                        b.addEventListener('click', () => {
                            foot.querySelectorAll('.ask-fb button').forEach((x) => { x.disabled = true; x.classList.toggle('is-picked', x === b); });
                            fetch(`${API}/ai/chat/feedback`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
                                body: JSON.stringify({ verdict: b.dataset.v, question, answer: String(data.answer).slice(0, 4000) })
                            }).catch(() => { /* best-effort */ });
                        }));
                    answerEl.appendChild(foot);
                }
            } catch (err) {
                if (err && err.name === 'AbortError') {
                    // user pulled the cord — keep whatever streamed, say so quietly
                    if (workingRow.isConnected) workingRow.remove();
                    renderTrace();
                    answerEl.classList.remove('ask-cursor');
                    answerEl.insertAdjacentHTML('beforeend', '<p class="small faint" style="margin-top:8px;">Stopped.</p>');
                } else {
                    workingEl.textContent = 'Network problem — please try again.';
                }
            } finally {
                busy = false;
                aborter = null;
            }
        }

        return { send, stop: () => { if (aborter) aborter.abort(); } };
    }

    // In-flow shell: bar + panel inside a page section.
    function mountAsk(el, { placeholder, suggestions = [] } = {}) {
        el.innerHTML = `
          <form class="ask-bar">
            <input class="input" type="text" maxlength="1000" placeholder="${esc(placeholder || 'Ask about any company — answers come from SEC filings…')}" aria-label="Ask a question" />
            <button class="btn btn-primary" type="submit">Ask</button>
          </form>
          <div class="ask-panel" hidden><div class="ask-exchange"></div></div>
          ${suggestions.length ? `<div class="ask-sources" style="margin-top:10px">${suggestions.map((s) => `<button type="button" class="chip ask-suggest">${esc(s)}</button>`).join('')}</div>` : ''}`;
        const form = el.querySelector('form');
        const input = el.querySelector('input');
        const panel = el.querySelector('.ask-panel');
        const engine = askEngine(el.querySelector('.ask-exchange'), { onActivity: () => { panel.hidden = false; } });
        el.querySelectorAll('.ask-suggest').forEach((b) =>
            b.addEventListener('click', () => { input.value = b.textContent; form.requestSubmit(); }));
        form.addEventListener('submit', (e) => {
            e.preventDefault();
            const q = input.value.trim();
            if (!q) return;
            input.value = '';
            engine.send(q);
        });
        return engine;
    }

    // Floor shell: a quiet bar pinned to the bottom of the viewport — the
    // page's voice, always one keystroke away (⌘K / Ctrl-K). Answers unfold
    // in a sheet above the bar; Esc puts it away without losing the thread.
    function mountAskFloor({ placeholder } = {}) {
        document.body.classList.add('has-ask-floor');
        const sheet = document.createElement('div');
        sheet.className = 'ask-sheet';
        sheet.hidden = true;
        sheet.innerHTML = '<div class="ask-exchange"></div>';
        const bar = document.createElement('div');
        bar.className = 'ask-floor';
        bar.innerHTML = `
          <form class="ask-floor-inner">
            <span class="ask-kbd">⌘K</span>
            <input class="input" type="text" maxlength="1000" placeholder="${esc(placeholder || 'Ask — answers come from SEC filings…')}" aria-label="Ask a question" />
            <button class="btn btn-primary" type="submit">Ask</button>
          </form>`;
        document.body.appendChild(sheet);
        document.body.appendChild(bar);
        const input = bar.querySelector('input');
        const exchange = sheet.querySelector('.ask-exchange');
        const engine = askEngine(exchange, { onActivity: () => { sheet.hidden = false; } });
        bar.querySelector('form').addEventListener('submit', (e) => {
            e.preventDefault();
            const q = input.value.trim();
            if (!q) return;
            input.value = '';
            engine.send(q);
        });
        input.addEventListener('focus', () => { if (exchange.children.length) sheet.hidden = false; });
        document.addEventListener('keydown', (e) => {
            if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); input.focus(); }
            if (e.key === 'Escape' && !sheet.hidden) sheet.hidden = true;
        });
        return engine;
    }

    window.V2 = { API, token, num, money, pct, fixed, fy, esc, sparkline, chart, markdown, nav, footer, mountAsk, mountAskFloor, askEngine, companies, spinner };
})();
