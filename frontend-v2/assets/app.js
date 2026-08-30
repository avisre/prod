// stockportfolio.pro v2 — shared runtime: nav, search, formatters,
// sparklines, markdown, and the inline streaming Ask component.
(function () {
    'use strict';

    const API = `${window.location.origin}/api`;
    const token = () => /(?:^|;\s*)sp_logged_in=1(?:;|$)/.test(document.cookie) ? 'cookie' : '';
    const UTM_COOKIE = 'sp_utm';
    function readCookie(name) {
        for (const part of String(document.cookie || '').split(';')) {
            const index = part.indexOf('=');
            if (index <= 0) continue;
            if (part.slice(0, index).trim() !== name) continue;
            try { return decodeURIComponent(part.slice(index + 1).trim()); } catch (_) { return ''; }
        }
        return '';
    }
    function cleanUtmValue(value, max) {
        return String(value || '').trim().slice(0, max || 120);
    }
    function captureUtm() {
        try {
            const params = new URLSearchParams(location.search);
            const utm = {
                source: cleanUtmValue(params.get('utm_source'), 80),
                medium: cleanUtmValue(params.get('utm_medium'), 80),
                campaign: cleanUtmValue(params.get('utm_campaign'), 120),
                content: cleanUtmValue(params.get('utm_content'), 120),
                term: cleanUtmValue(params.get('utm_term'), 120),
                contentId: cleanUtmValue(params.get('content_id'), 120),
                clickId: cleanUtmValue(params.get('click_id') || params.get('gclid') || params.get('msclkid') || params.get('fbclid') || params.get('twclid') || params.get('li_fat_id') || params.get('ttclid'), 80),
                capturedAt: new Date().toISOString()
            };
            if (!utm.source && !utm.medium && !utm.campaign && !utm.content && !utm.term && !utm.contentId && !utm.clickId) return;
            document.cookie = UTM_COOKIE + '=' + encodeURIComponent(JSON.stringify(utm)) + '; Max-Age=' + (30 * 24 * 60 * 60) + '; Path=/; SameSite=Lax';
        } catch (_) { /* attribution is best-effort */ }
    }
    function getStoredUtm() {
        try {
            const raw = readCookie(UTM_COOKIE);
            if (!raw) return null;
            const parsed = JSON.parse(raw);
            const utm = {
                source: cleanUtmValue(parsed.source, 80),
                medium: cleanUtmValue(parsed.medium, 80),
                campaign: cleanUtmValue(parsed.campaign, 120),
                content: cleanUtmValue(parsed.content, 120),
                term: cleanUtmValue(parsed.term, 120),
                contentId: cleanUtmValue(parsed.contentId, 120),
                clickId: cleanUtmValue(parsed.clickId, 80)
            };
            return (utm.source || utm.medium || utm.campaign || utm.content) ? utm : null;
        } catch (_) {
            return null;
        }
    }
    function analyticsConsentGranted() {
        try { return localStorage.getItem('sp_analytics_consent_v1') === 'granted'; } catch (_) { return false; }
    }
    function trackGrowthEvent(eventName, context = {}) {
        if (!analyticsConsentGranted()) return;
        const eventId = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const pagePath = location.pathname || '/';
        const payload = {
            event: String(eventName || ''), eventId, consent: true, path: pagePath,
            pageType: context.pageType || (/^\/compare/.test(pagePath) ? 'comparison' : /^\/stocks\//.test(pagePath) ? 'stock' : /^\/tools\//.test(pagePath) ? 'tool' : /^\/pricing/.test(pagePath) ? 'pricing' : 'other'),
            contentId: context.contentId || null, campaignId: context.campaignId || null, ctaId: context.ctaId || null,
            featureType: context.featureType || null
        };
        const body = JSON.stringify(payload);
        try {
            const sent = navigator.sendBeacon && navigator.sendBeacon('/api/track/event', new Blob([body], { type: 'application/json' }));
            if (!sent) fetch(`${API}/track/event`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
        } catch (_) { /* analytics never blocks the product */ }
        try {
            if (window.gtag) window.gtag('event', String(eventName || ''), {
                page_type: payload.pageType, content_id: payload.contentId || undefined, cta_id: payload.ctaId || undefined
            });
        } catch (_) {}
        try {
            if (window.clarity) {
                window.clarity('event', String(eventName || ''));
                window.clarity('set', 'page_type', payload.pageType);
                window.clarity('set', 'auth_state', token() ? 'authenticated' : 'anonymous');
                if (payload.ctaId) window.clarity('set', 'cta_id', payload.ctaId);
                if (context.entitlementSource) window.clarity('set', 'entitlement_source', String(context.entitlementSource).slice(0, 40));
                if (context.planFamily) window.clarity('set', 'plan_family', String(context.planFamily).slice(0, 40));
            }
        } catch (_) {}
    }
    // Clarity is diagnostic only. Server-owned signup, activation and payment
    // events remain the business truth; this helper never posts a conversion
    // back to Mongo or GA4 and sends only low-cardinality context after consent.
    function trackDiagnosticEvent(eventName, context = {}) {
        if (!analyticsConsentGranted()) return;
        try {
            if (window.clarity) {
                window.clarity('event', String(eventName || ''));
                if (context.pageType) window.clarity('set', 'page_type', String(context.pageType).slice(0, 40));
                if (context.entitlementSource) window.clarity('set', 'entitlement_source', String(context.entitlementSource).slice(0, 40));
            }
        } catch (_) {}
    }
    // Public for the small number of SSR forms that cannot import this module.
    window.spGrowthTrack = trackGrowthEvent;
    window.spGrowthDiagnostic = trackDiagnosticEvent;
    captureUtm();
    const trackActivation = (job) => {
        if (!token() || !['ask', 'comparison', 'screener_company', 'portfolio'].includes(String(job))) return;
        fetch(`${API}/track/activation`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
            body: JSON.stringify({ job }), keepalive: true
        }).catch(() => {});
    };
    const trackMeaningfulActivation = (payload = {}) => {
        if (!token()) return Promise.resolve(null);
        const body = { ...payload, resultValid: payload.resultValid === true, sourceOpened: payload.sourceOpened === true };
        return fetch(`${API}/track/meaningful-activation`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
            body: JSON.stringify(body), keepalive: true
        }).then((r) => r.ok ? r.json() : null).then((result) => {
            if (result && result.meaningfulActivation) trackDiagnosticEvent('activation_completed', { pageType: 'research' });
            return result;
        }).catch(() => null);
    };
    // SEO pilot telemetry is page context only. In particular, this helper
    // never receives or serializes the user's Ask question or answer.
    const trackSeoEvent = (event, context = {}, target = '') => {
        const allowed = {
            contentId: context.contentId || null,
            seoPageType: context.seoPageType || null,
            seoTicker: context.seoTicker || null,
            seoMetric: context.seoMetric || null,
            seoPair: context.seoPair || null,
            seoQueryCluster: context.seoQueryCluster || null,
            seoExperiment: context.seoExperiment || null,
            seoVariant: context.seoVariant || null,
            destinationKind: context.destinationKind || null,
            path: location.pathname,
            target: String(target || '').slice(0, 200),
            referrer: document.referrer
        };
            const payload = JSON.stringify({ event: String(event || ''), ...allowed });
        try {
            const sent = navigator.sendBeacon && navigator.sendBeacon('/api/track/seo_event', new Blob([payload], { type: 'application/json' }));
            if (!sent) fetch(`${API}/track/seo_event`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: payload, keepalive: true }).catch(() => {});
        } catch (_) { /* telemetry never blocks research */ }
    };
    const trackCustomerSuccess = (status, text) => {
        if (!token()) return Promise.resolve(null);
        return fetch(`${API}/track/customer-success`, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
            body: JSON.stringify({ status, text: String(text || '').slice(0, 1000) }), keepalive: true
        }).then((r) => r.ok ? r.json() : null).catch(() => null);
    };
    async function mountCampaign() {
        let cfg;
        try { const r = await fetch('/api/campaign/config'); if (!r.ok) return null; cfg = await r.json(); } catch (_) { return null; }
        document.querySelectorAll('[data-appsumo-deadline]').forEach((el) => { el.textContent = cfg.deadlineLabel || 'Lifetime deal available now'; });
        document.querySelectorAll('[data-campaign-sales-video]').forEach((el) => {
            if (!cfg.salesVideoUrl) { el.hidden = true; return; }
            el.hidden = false; el.src = cfg.salesVideoUrl; el.load();
        });
        document.querySelectorAll('[data-campaign-onboarding-video]').forEach((el) => {
            if (!cfg.onboardingVideoUrl) { el.hidden = true; return; }
            el.hidden = false; el.src = cfg.onboardingVideoUrl; el.load();
        });
        document.querySelectorAll('[data-appsumo-campaign-link]').forEach((el) => {
            const content = el.dataset.contentId || 'campaign-home';
            const clickId = (window.crypto && crypto.randomUUID)
                ? `as-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`
                : `as-${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
            const query = new URLSearchParams({
                content_id: content,
                click_id: clickId,
                utm_source: 'website',
                utm_medium: 'referral',
                utm_campaign: cfg.campaignId || 'appsumo_aug_2026',
                utm_content: content
            });
            el.href = `/go/appsumo/website?${query.toString()}`;
        });
        return cfg;
    }
    try { localStorage.removeItem('token'); } catch (_) {}

    // ---------- funnel-event entry point (retargeting) ----------
    // Safe to call anywhere, anytime: it no-ops until a retargeting pixel has
    // actually loaded (analytics consent granted AND env IDs set). Mirrors
    // backend/pixels.js so an event fires identically on SSR and app pages.
    if (!window.spTrack) window.spTrack = function (name, params) {
        params = params || {};
        const k = window.__spPixelCfg || {};
        try {
            if (window.fbq) {
                if (name === 'signup') window.fbq('track', 'CompleteRegistration');
                else if (name === 'trial_start') window.fbq('track', 'StartTrial');
                else if (name === 'initiate_checkout') window.fbq('track', 'InitiateCheckout');
                else if (name === 'subscribe') window.fbq('track', 'Purchase', { value: params.value, currency: params.currency || 'USD' });
            }
        } catch (_) { /* pixels are best-effort, never block */ }
        try {
            if (window.gtag && k.googleAdsId) {
                if (name === 'signup' && k.signupLabel) window.gtag('event', 'conversion', { send_to: k.googleAdsId + '/' + k.signupLabel });
                else if (name === 'subscribe' && k.subscribeLabel) window.gtag('event', 'conversion', { send_to: k.googleAdsId + '/' + k.subscribeLabel, value: params.value, currency: params.currency || 'USD' });
            }
        } catch (_) { /* pixels are best-effort, never block */ }
    };

    // ---------- first-party page-view ping (anonymous, signed session) ----------
    if (!window.__spSkipAutoPageView) {
        try {
            const pv = JSON.stringify({ path: location.pathname, referrer: document.referrer, utm: getStoredUtm() });
            const sent = navigator.sendBeacon && navigator.sendBeacon('/api/track/page_view', new Blob([pv], { type: 'application/json' }));
            if (!sent) fetch('/api/track/page_view', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: pv, keepalive: true }).catch(() => {});
        } catch (_) { /* never block the page */ }
    }

    document.addEventListener('click', (event) => {
        const link = event.target && event.target.closest && event.target.closest('a[href]');
        if (!link) return;
        const href = link.getAttribute('href') || '';
        if (link.dataset.seoAction) {
            const context = {
                contentId: link.dataset.contentId || null,
                seoPageType: link.dataset.seoPageType || null,
                seoTicker: link.dataset.seoTicker || null,
                seoMetric: link.dataset.seoMetric || null,
                seoPair: link.dataset.seoPair || null,
                seoQueryCluster: link.dataset.seoQueryCluster || null,
                seoExperiment: link.dataset.seoExperiment || null,
                seoVariant: link.dataset.seoVariant || null,
                destinationKind: link.dataset.destinationKind || null
            };
            trackSeoEvent('seo_next_action_click', context, href);
            return;
        }
        if (!/^(?:\/appsumo(?:[?#]|$)|\/go\/appsumo\/|https:\/\/appsumo\.com\/)/i.test(href)) return;
        try {
            const url = new URL(href, location.origin);
            trackGrowthEvent('appsumo_outbound_clicked', {
                contentId: url.searchParams.get('content_id') || link.dataset.contentId || null,
                ctaId: link.dataset.ctaId || link.dataset.cta || link.dataset.toolId || null
            });
        } catch (_) { /* never block navigation */ }
        // Compatibility: /api/track/cta_click remains available for older clients,
        // but this runtime sends only the canonical event above.
    }, { capture: true });

    // P0 proof-funnel: a user opening a filing/source link is `source_opened`.
    // The Ask answer and deterministic recovery render SEC source links; track
    // the click so the funnel can prove evidence was actually opened, not just
    // shown. Scoped to known filing domains so generic outbound clicks are not
    // counted as research sources.
    document.addEventListener('click', (event) => {
        const link = event.target && event.target.closest && event.target.closest('a[href]');
        if (!link) return;
        const href = link.getAttribute('href') || '';
        if (/^https:\/\/(www\.)?sec\.gov/i.test(href)) {
            trackGrowthEvent('source_opened', {
                contentId: link.dataset.contentId || null,
                ctaId: link.dataset.ctaId || 'source'
            });
        }
    }, { capture: true });

    document.addEventListener('click', (event) => {
        const link = event.target && event.target.closest && event.target.closest('a[href]');
        if (!link) return;
        const href = link.getAttribute('href') || '';
        if (/register|signup/i.test(href)) trackGrowthEvent('signup_started', { ctaId: link.dataset.ctaId || 'signup' });
        else if (/checkout|subscribe/i.test(href)) trackGrowthEvent('checkout_started', { ctaId: link.dataset.ctaId || 'checkout' });
    }, { capture: true });

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
        // nice y grid: step snapped to 1/2/2.5/5 × 10^k, gridlines at step
        // multiples — raw data extremes (36.00/23.37/10.73/−1.90) never appear
        const ticks = [];
        let gridStep = 0;
        if (max > min) {
            const target = (max - min) / 4;
            const mag = Math.pow(10, Math.floor(Math.log10(target)));
            const norm = target / mag;
            gridStep = (norm < 1.5 ? 1 : norm < 3.5 ? 2 : norm < 7.5 ? 5 : 10) * mag;
            for (let t = Math.ceil(min / gridStep) * gridStep; t <= max + gridStep * 1e-6; t += gridStep) {
                ticks.push(Math.round(t / gridStep) * gridStep);
            }
        }
        // grid labels carry the step's own precision — 0/10/20/30, never 10.00,
        // and never a -0 artifact at the baseline
        const tickFmt = (t) => {
            if (!Number.isFinite(t)) return '';
            const v = Object.is(t, -0) ? 0 : t;
            const dec = gridStep >= 1 ? 0 : gridStep >= 0.1 ? 1 : gridStep >= 0.01 ? 2 : 3;
            return v.toLocaleString('en-US', { maximumFractionDigits: dec });
        };
        let g = '';
        for (const t of ticks) {
            g += `<line x1="${padL}" y1="${y(t).toFixed(1)}" x2="${W - padR}" y2="${y(t).toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`;
            g += `<text x="${padL - 8}" y="${(y(t) + 3.5).toFixed(1)}" text-anchor="end" font-size="10.5" fill="var(--ink-3)" style="font-variant-numeric:tabular-nums">${esc(tickFmt(t))}</text>`;
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

    // ---------- Ask bars blocks (```bars {json}```) → horizontal compare bars ----------
    // {"title":str,"unit":"$"|"%"|"x","rows":[[label, value, note?]]} — the
    // Normal-mode alternative to a wide markdown table for a multi-metric or
    // multi-company comparison. Reuses PV.pairBars-style styling via a simple
    // one-bar-per-row track so it needs no extra CSS beyond .pv-scale-*.
    function barsBlock(json) {
        let spec;
        try { spec = JSON.parse(json); } catch (_) {
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
        const rows = (Array.isArray(spec.rows) ? spec.rows : [])
            .filter((r) => Array.isArray(r) && r.length >= 2 && Number.isFinite(Number(r[1])))
            .slice(0, 8);
        if (!rows.length) return '';
        const fmt = vizFmt(spec.unit);
        const max = Math.max(...rows.map((r) => Math.abs(Number(r[1]))), 1);
        const rowHtml = rows.map((r) => {
            const [label, value, note] = r;
            const pct = Math.max(2, Math.min(100, Math.abs(Number(value)) / max * 100));
            return `<div class="pv-scale-row">
        <span class="pv-scale-label">${esc(String(label))}${note ? ` <span class="small faint">${esc(String(note))}</span>` : ''}</span>
        <span class="pv-scale-track"><i class="pv-scale-fill" style="width:${pct.toFixed(1)}%"></i></span>
        <b class="pv-scale-val">${esc(fmt(Number(value)))}</b>
      </div>`;
        }).join('');
        return `<figure class="ask-viz">${spec.title ? `<figcaption class="label">${esc(String(spec.title))}</figcaption>` : ''}<div class="pv-card" style="margin-top:0;">${rowHtml}</div></figure>`;
    }

    // A completed answer leads with its source receipt: the first SEC link the
    // model cited, pulled from the already-rendered answer. The receipt is the
    // proof-of-value line ("source is the headline") and its link is the same
    // sec.gov anchor the source_opened funnel already tracks.
    function mountReceipt(el) {
        const secLink = el && el.querySelector ? el.querySelector('a[href*="sec.gov"]') : null;
        if (!secLink) return;
        const rec = document.createElement('div');
        rec.className = 'ask-receipt';
        const label = secLink.textContent.trim().slice(0, 120) || 'SEC filing';
        rec.innerHTML = `<span class="ask-receipt-label">Source</span> <a href="${esc(secLink.getAttribute('href'))}" target="_blank" rel="noopener nofollow" data-cta-id="source">${esc(label)}</a>`;
        el.prepend(rec);
    }

    // ---------- minimal markdown (Ask answers) ----------
    // Links are rendered LAST (after bold/italic) so a citation label can carry
    // inline emphasis. Only http(s) destinations become anchors — the string is
    // already HTML-escaped by the caller, so a `"` in a URL arrives as &quot;
    // and cannot break out of the attribute.
    function inlineMd(s) {
        return s
            .replace(/`([^`]+)`/g, '<code>$1</code>')
            .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
            .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>')
            .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener nofollow">$1</a>');
    }
    function markdown(text) {
        // lift ```viz blocks out before escaping; render them as charts.
        // A still-streaming (unclosed) fence is hidden until it completes.
        const vizzes = [];
        let src = String(text || '').replace(/```viz\s*\n([\s\S]*?)```/g, (m, body) => {
            vizzes.push(vizBlock(body.trim()));
            return `\nVIZBLOCK${vizzes.length - 1}END\n`;
        });
        src = src.replace(/```bars\s*\n([\s\S]*?)```/g, (m, body) => {
            vizzes.push(barsBlock(body.trim()));
            return `\nVIZBLOCK${vizzes.length - 1}END\n`;
        });
        src = src.replace(/```viz[\s\S]*$/, '');
        src = src.replace(/```bars[\s\S]*$/, '');
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
        free: { name: 'Free', price: '$0', per: '/forever', q: 3 },
        core: { name: 'Core', price: '$12', per: '/mo', q: 25 },
        pro: { name: 'Pro', price: '$33', per: '/mo', q: 300 }
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
            const msg = esc((data && data.message) || "You've used all your Ask questions this month — the counter resets on the 1st.");
            // A Pro wall is a dead end unless it offers a way forward: the
            // credit refill buys Asks today, the reset date says when the
            // regular wallet returns, and AppSumo buyers lift their cap by
            // upgrading their license.
            const as = data && data.appsumo;
            if (as && as.isAppSumo && as.upgradeUrl) {
                return `<div class="notice">${msg}<br><a class="btn btn-primary" style="margin-top:12px" href="${esc(as.upgradeUrl)}" target="_blank" rel="noopener">Upgrade your AppSumo license →</a></div>`;
            }
            return `<div class="notice">${msg}<br><a class="btn btn-primary" style="margin-top:12px" href="/recharge.html">Recharge 150 credits — $9</a> <span class="small" style="margin-left:6px;">or <a href="/upgrade.html">upgrade your plan →</a></span></div>`;
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
            <a class="btn btn-primary ask-wall-cta" href="/register.html?plan=pro">Start Pro checkout</a>
            <p class="small faint" style="margin-top:14px;">Not ready to pay? <a href="/verify.html">Verify one headline against the filing — free, no account.</a></p>
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
        loadPixels();
        if (/^\/pricing(?:\/|$)/.test(location.pathname)) trackGrowthEvent('pricing_viewed', { pageType: 'pricing' });
    }

    // ---------- retargeting pixels, consent-gated (env-driven, no-op-safe) ----------
    // Only ever runs after loadAnalytics() (i.e. after the user grants consent).
    // IDs come from the server (/api/analytics/config), which reads them from the
    // environment — unset → empty strings → nothing loads, no console errors.
    function loadPixels() {
        if (window.__spPixels) return;
        window.__spPixels = true;
        fetch(`${API}/analytics/config`).then((r) => r.json()).then((C) => {
            if (!C || (!C.metaPixelId && !C.googleAdsId)) return; // nothing configured
            window.__spPixelCfg = C;
            if (C.metaPixelId && !window.fbq) {
                !function (f, b, e, v, n, t, s) { if (f.fbq) return; n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); }; if (!f._fbq) f._fbq = n; n.push = n; n.loaded = !0; n.version = '2.0'; n.queue = []; t = b.createElement(e); t.async = !0; t.src = v; s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s); }(window, document, 'script', 'https://connect.facebook.net/en_US/fbevents.js');
                window.fbq('init', C.metaPixelId);
                window.fbq('track', 'PageView');
            }
            if (C.googleAdsId) {
                window.dataLayer = window.dataLayer || [];
                window.gtag = window.gtag || function () { window.dataLayer.push(arguments); };
                if (!window.__spAdsScript) {
                    window.__spAdsScript = true;
                    const s = document.createElement('script'); s.async = true;
                    s.src = 'https://www.googletagmanager.com/gtag/js?id=' + C.googleAdsId;
                    document.head.appendChild(s);
                    window.gtag('js', new Date());
                }
                window.gtag('config', C.googleAdsId);
            }
        }).catch(() => { /* pixels are non-essential — ignore */ });
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
          <p><strong>Optional analytics &amp; marketing.</strong> We'd like to measure which pages convert and, with our ad partners, show you relevant ads off-site. Allow it?</p>
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

    // ---------- credit formatting (shared) ----------
    // These three live here rather than in profile.js because BOTH the profile
    // page and the nav account dropdown render the same numbers. Two copies of
    // the `covered >= used` guard in particular could drift apart and start
    // showing a partial breakdown as though it were complete.

    // "Resets 1 Sep" / "Resets 1 Sep · in 3 days"
    function formatReset(iso) {
        const reset = iso ? new Date(iso) : null;
        if (!reset || Number.isNaN(reset.getTime())) return '';
        const dateStr = reset.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
        const days = Math.ceil((reset.getTime() - Date.now()) / 86400000);
        if (days <= 0) return `Resets ${dateStr}`;
        return `Resets ${dateStr} · in ${days} day${days === 1 ? '' : 's'}`;
    }

    function activityLabel(reason, refId) {
        if (reason === 'ask') return 'Ask question';
        if (reason === 'monitor') return refId ? `Monitor report: ${refId}` : 'Monitor report';
        if (reason === 'dossier') {
            const [symbol, depth] = String(refId || '').split(':');
            const kind = depth === 'deep' ? 'Deep Dossier' : 'Standard Dossier';
            return symbol ? `${kind}: ${symbol}` : kind;
        }
        return 'Credit use';
    }

    // Sums the ledger rows by feature. `covered` is what the returned rows
    // account for: recentActivity() is capped server-side, so on a heavy month
    // the rows may not add up to the full `used` total — callers compare
    // covered >= used and hide the split rather than render a partial one.
    function creditSplit(recent) {
        const out = { ask: 0, monitor: 0, dossier: 0, covered: 0 };
        for (const row of (Array.isArray(recent) ? recent : [])) {
            const amt = Math.max(0, -Number(row.delta) || 0);
            out.covered += amt;
            if (row.reason === 'ask') out.ask += amt;
            else if (row.reason === 'monitor') out.monitor += amt;
            else if (row.reason === 'dossier') out.dossier += amt;
        }
        return out;
    }

    // ---------- account dropdown ----------
    // A small tray, not a dashboard: one status line (from data the nav
    // already holds — opening costs no request), one row per profile section
    // (deep links land with that section already open), an admin row for the
    // owner, and Upgrade/Recharge when they apply. Sign out deliberately
    // stays OUT of the tray — the nav's standalone button is the only one, so
    // the irrevocable action keeps its distance from the menu rows.
    function accountMenuHtml(session, credits, messages, unread) {
        const sub = (session && session.subscription) || {};
        const planName = sub.planName || (session && session.tier === 'core' ? 'Core' : session && session.tier === 'pro' ? 'Pro' : 'Free');
        const allowance = Number(credits.allowance) || 0;
        const used = Number(credits.used) || 0;
        const remaining = Number.isFinite(credits.remaining) ? credits.remaining : Math.max(0, allowance - used);
        const hasBalance = allowance > 0 || used > 0;
        const isOwner = String(((session && session.profile) || {}).email || '').trim().toLowerCase() === 'rin@gmail.com';
        // Same top-tier rule as the nav Upgrade chip — nothing to upgrade to.
        const topTier = ['power', 'power-monthly', 'desk', 'enterprise'].includes(sub.planId);
        const as = session && session.appsumo;
        const rechargeEligible = hasBalance && remaining / Math.max(1, allowance) <= 0.2;
        const row = (href, label) => `<a href="${href}" role="menuitem">${esc(label)}</a>`;
        let html = `
        <p class="nav-account-status">${esc(planName)}${hasBalance ? ` · ${Math.max(0, remaining)} left` : ''}</p>
        <div class="nav-account-sep"></div>
        <div class="nav-account-links" role="none">
          ${row('/profile.html#usage-details', 'Usage')}
          ${row('/profile.html#settings-section', 'Settings')}
          ${row('/profile.html#messages-details', `Messages${unread ? ` <span class="nav-account-unread">${esc(unread)}</span>` : ''}`)}
          ${isOwner ? row('/profile.html#admin-section', 'Admin') : ''}
        </div>`;
        if (as && as.isAppSumo && as.upgradeUrl) {
            html += `<a class="nav-account-cta" role="menuitem" href="${esc(as.upgradeUrl)}" target="_blank" rel="noopener">Upgrade license &rarr;</a>`;
        } else if (!topTier) {
            html += `<a class="nav-account-cta" role="menuitem" href="/upgrade.html">Upgrade plan</a>`;
        }
        if (rechargeEligible) {
            html += `<a class="nav-account-cta nav-account-cta-quiet" role="menuitem" href="/recharge.html">Recharge credits</a>`;
        }
        html += `<div class="nav-account-sep"></div>
        <div class="nav-account-links"><a href="/profile.html">Full profile &rarr;</a></div>`;
        return html;
    }

    function mountAccountMenu(trigger, menu, sessionPromise) {
        if (!trigger || !menu || menu.dataset.wired === '1') return;
        menu.dataset.wired = '1';   // nav() is already idempotent; belt and braces
        let loaded = false;

        // Below 641px the icon keeps plain-link behaviour — the mobile drawer
        // already has its own Profile entry, and a tray doesn't belong on a
        // phone-sized canvas. (The old 1181px threshold made laptop-narrow
        // windows navigate instead of opening the tray — that was the bug.)
        const isDesktop = () => window.matchMedia('(min-width: 641px)').matches;
        const isOpen = () => menu.dataset.open === '1';
        const close = () => { menu.dataset.open = '0'; trigger.setAttribute('aria-expanded', 'false'); };

        async function load() {
            const badge = document.getElementById('v2-message-badge');
            const unread = badge && !badge.hidden ? badge.textContent : '';
            let session = null;
            let credits = {};
            try {
                // Reuses the /api/session response the trial banner already
                // fetched; the one extra call prices the tray's credit line.
                // The message-thread preview is gone from the tray, so that
                // fetch went with it — opening is cheap, always.
                const sessionData = await sessionPromise.catch(() => null);
                session = sessionData;
                const r = await fetch(`${API}/credits`, { headers: { Authorization: `Bearer ${token()}` } });
                credits = r.ok ? await r.json() : {};
            } catch (_) { /* the fallback below still opens */ }
            menu.innerHTML = accountMenuHtml(session, credits || {}, [], unread);
        }

        const open = () => {
            menu.dataset.open = '1';
            trigger.setAttribute('aria-expanded', 'true');
            if (!loaded) { loaded = true; load(); }
        };

        trigger.addEventListener('click', (e) => {
            if (!isDesktop()) return;      // let the href do its job
            e.preventDefault();
            if (isOpen()) { close(); return; }
            open();
        });

        // Hover OPEN only. There is deliberately no hover-close: a tray that
        // vanishes when the mouse wanders is flicker-prone; the deliberate
        // dismissals (outside click, Esc, re-click) are the only exits.
        trigger.addEventListener('mouseenter', () => {
            if (!isDesktop()) return;
            if (isOpen()) return;
            menu.dataset.open = '1';
            trigger.setAttribute('aria-expanded', 'true');
            if (!loaded) { loaded = true; load(); }
        });

        document.addEventListener('click', (e) => {
            if (isOpen() && !menu.contains(e.target) && !trigger.contains(e.target)) close();
        });
        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && isOpen()) { close(); trigger.focus(); }
        });
        // role=menu contract: arrows walk the rows. Small and forgiving — it
        // complements, never replaces, plain Tab order.
        menu.addEventListener('keydown', (e) => {
            if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
            const items = Array.from(menu.querySelectorAll('a'));
            if (!items.length) return;
            e.preventDefault();
            const idx = items.indexOf(document.activeElement);
            const target = e.key === 'ArrowDown'
                ? items[Math.min(items.length - 1, idx + 1)]
                : items[Math.max(0, idx - 1)];
            if (target) target.focus();
        });
    }

    // ---------- nav ----------
    function nav(current) {
        // Idempotent: profile.html loads both profile.js and the bundled
        // messages.js, and messages.js calls nav('') itself (same as it does
        // on inbox.html) — without this guard, whichever runs second would
        // prepend a second <header class="nav">.
        if (document.querySelector('header.nav')) return;
        const authed = !!token();
        const cur = (page) => current === page ? "aria-current='page'" : '';
        const el = document.createElement('header');
        el.className = 'nav';
        el.innerHTML = `
          <div class="container nav-inner">
            <a class="wordmark" href="/index.html" aria-label="StockPortfolio.pro home">
              <img class="wordmark-emblem" src="/Media/icon.png" width="24" height="24" alt="" aria-hidden="true" />
              <span class="wordmark-text">stockportfolio<span>.pro</span></span>
            </a>
            <nav class="nav-links" aria-label="Primary">
              <a href="/screener.html" ${cur('screener')}>Screener</a>
              <a href="/tools" ${cur('tools')}>Tools</a>
              <a href="/compare" ${cur('compare')}>Compare</a>
              <a href="/company.html?symbol=AAPL" ${cur('company')}>Stocks &amp; funds</a>
              <a href="/news.html" ${cur('news')}>Markets</a>
              <div class="nav-dd">
                <a href="/ask.html" class="nav-dd-trigger" ${cur('ask') || cur('dossier') || cur('monitor')} aria-haspopup="true">Ask&nbsp;AI <span class="nav-dd-caret" aria-hidden="true">▾</span></a>
                <div class="nav-dd-menu" role="menu">
                  <a href="/ask.html" role="menuitem" ${cur('ask')}><strong>Ask</strong><span>Question any company's filings</span></a>
                  <a href="/dossier.html" role="menuitem" ${cur('dossier')}><strong>Research Dossier</strong><span>Full auto-generated report</span></a>
                  <a href="/monitor.html" role="menuitem" ${cur('monitor')}><strong>Filing Monitor</strong><span>What changed in the latest filing</span></a>
                </div>
              </div>
              <a href="/dashboard.html" ${cur('dashboard')}>Portfolio</a>
              <a href="/gurus.html" ${cur('gurus')}>Gurus</a>
              <a href="/#pricing" ${cur('pricing')}>Pricing</a>
            </nav>
            <div class="nav-spacer"></div>
            <div class="nav-search">
              <input type="search" id="v2-search" placeholder="Search stocks, ETFs, funds…" autocomplete="off"
                     aria-label="Search companies" />
              <div class="nav-search-results" id="v2-search-results" hidden></div>
            </div>
            ${authed
                ? `<a class="btn btn-primary btn-sm" href="/upgrade.html" id="v2-upgrade" hidden>Upgrade</a>
                   <div class="nav-account">
                     <a class="nav-profile" href="/profile.html" id="v2-account-trigger" aria-label="Profile and messages" title="Profile" aria-haspopup="menu" aria-expanded="false" aria-controls="v2-account-menu">
                       <svg viewBox="0 0 24 24" width="19" height="19" aria-hidden="true"><path d="M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm0 2c-4.1 0-7.5 2.1-7.5 4.7V20h15v-1.3C19.5 16.1 16.1 14 12 14Z" fill="currentColor"/></svg><span class="nav-message-badge" id="v2-message-badge" hidden>0</span>
                     </a>
                     <div class="nav-account-menu" id="v2-account-menu" role="menu" data-open="0"></div>
                   </div>
                   <a class="btn btn-quiet" href="#" id="v2-signout">Sign out</a>`
                : `<a class="btn btn-quiet" href="/login.html">Log in</a>
                   <a class="btn btn-primary btn-sm" href="/register.html">Sign up free</a>`}
            <button class="nav-ham" id="v2-ham" aria-label="Open menu" aria-expanded="false" aria-controls="v2-mobile-nav">
              <svg width="20" height="15" viewBox="0 0 20 15" fill="currentColor" aria-hidden="true">
                <rect y="0" width="20" height="2" rx="1"/><rect y="6.5" width="20" height="2" rx="1"/><rect y="13" width="20" height="2" rx="1"/>
              </svg>
            </button>
          </div>`;
        document.body.prepend(el);

        // Mobile drawer is appended to <body>, NOT nested in <header class="nav">.
        // The header sets `backdrop-filter: blur(...)`, which makes it the containing
        // block for any position:fixed descendant — that was clipping this overlay to
        // the ~60px header height and hiding every menu option. At <body> level, the
        // fixed overlay resolves against the viewport, so the drawer is full-height.
        const mob = document.createElement('div');
        mob.className = 'nav-mobile';
        mob.id = 'v2-mobile-nav';
        mob.setAttribute('aria-hidden', 'true');
        mob.innerHTML = `
            <div class="nav-mobile-dim" id="v2-mobile-dim"></div>
            <div class="nav-mobile-panel" role="dialog" aria-label="Navigation">
              <button class="nav-mobile-close" id="v2-mobile-close" aria-label="Close menu" type="button">
                <svg width="10.5" height="10.5" viewBox="0 0 15 15" aria-hidden="true"><path d="M1 1l13 13M14 1L1 14" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/></svg>
              </button>
              <div class="nav-search">
                <input type="search" id="v2-mobile-search" placeholder="Search stocks, ETFs, funds…" autocomplete="off"
                       aria-label="Search stocks, ETFs and funds" enterkeyhint="search" />
                <div class="nav-search-results" id="v2-mobile-search-results" hidden></div>
              </div>
              <nav>
                <a href="/screener.html" ${cur('screener')}>Screener</a>
                <a href="/tools" ${cur('tools')}>Tools</a>
                <a href="/compare" ${cur('compare')}>Compare</a>
                <a href="/company.html?symbol=AAPL" ${cur('company')}>Stocks &amp; funds</a>
                <a href="/news.html" ${cur('news')}>Markets</a>
                <a href="/ask.html" ${cur('ask')}>Ask&nbsp;AI</a>
                <a href="/dossier.html" class="nav-mobile-sub" ${cur('dossier')}>Research Dossier</a>
                <a href="/monitor.html" class="nav-mobile-sub" ${cur('monitor')}>Filing Monitor</a>
                <a href="/dashboard.html" ${cur('dashboard')}>Portfolio</a>
                <a href="/gurus.html" ${cur('gurus')}>Guru Portfolios</a>
                ${authed ? `<a href="/profile.html" ${cur('profile')}>Profile</a>` : ''}
                <a href="/#pricing" ${cur('pricing')}>Pricing</a>
              </nav>
              <div class="nav-mobile-auth">
                ${authed
                    ? `<a class="btn btn-primary" href="/upgrade.html" id="v2-mobile-upgrade" hidden>Upgrade</a>
                       <a class="btn btn-ghost" href="#" id="v2-mobile-signout">Sign out</a>`
                    : `<a class="btn btn-ghost" href="/login.html">Log in</a>
                       <a class="btn btn-primary" href="/register.html">Choose a plan</a>`}
              </div>
            </div>`;
        document.body.appendChild(mob);

        // Mobile nav open/close
        const ham = el.querySelector('#v2-ham');
        const mobileNav = mob;
        const dim = mob.querySelector('#v2-mobile-dim');
        const closeBtn = mob.querySelector('#v2-mobile-close');
        function openMenu() {
            mobileNav.setAttribute('aria-hidden', 'false');
            ham.setAttribute('aria-expanded', 'true');
            requestAnimationFrame(() => mobileNav.classList.add('is-open'));
        }
        function closeMenu() {
            mobileNav.classList.remove('is-open');
            ham.setAttribute('aria-expanded', 'false');
            setTimeout(() => mobileNav.setAttribute('aria-hidden', 'true'), 160);
        }
        // ☰ toggles the dropdown; the in-panel ✕ (top-right), tap-outside and Esc also close
        ham.addEventListener('click', () => mobileNav.classList.contains('is-open') ? closeMenu() : openMenu());
        dim.addEventListener('click', closeMenu);
        if (closeBtn) closeBtn.addEventListener('click', closeMenu);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && mobileNav.classList.contains('is-open')) closeMenu(); });

        const out = el.querySelector('#v2-signout');
        if (out) out.addEventListener('click', async (e) => { e.preventDefault(); await fetch(`${V2.API}/logout`, { method: 'POST' }).catch(() => {}); location.reload(); });
        const mobileOut = mob.querySelector('#v2-mobile-signout');
        if (mobileOut) mobileOut.addEventListener('click', async (e) => { e.preventDefault(); await fetch(`${V2.API}/logout`, { method: 'POST' }).catch(() => {}); location.reload(); });

        wireSearch(el.querySelector('#v2-search'), el.querySelector('#v2-search-results'));
        // phones get the search in the drawer — the header input is crushed at 390px
        wireSearch(mob.querySelector('#v2-mobile-search'), mob.querySelector('#v2-mobile-search-results'));
        const messageBadge = el.querySelector('#v2-message-badge');
        if (messageBadge) {
            const refreshMessageBadge = () => fetch(`${API}/messages/unread-count`, { headers: { Authorization: `Bearer ${token()}` } })
                .then((r) => r.ok ? r.json() : null).then((data) => {
                    const unread = Math.max(0, Number(data && data.unread || 0));
                    messageBadge.hidden = !unread;
                    messageBadge.textContent = unread > 99 ? '99+' : String(unread);
                    if (unread) messageBadge.parentElement.setAttribute('aria-label', `${unread} unread message${unread === 1 ? '' : 's'} — open messages and account`);
                }).catch(() => {});
            refreshMessageBadge();
            // New replies become visible without requiring the customer to
            // refresh the page, while keeping this lightweight (one tiny,
            // authenticated count request per minute).
            window.setInterval(refreshMessageBadge, 60000);
        }
        mountConsent();
        // One /api/session read serves three consumers now: the banner resolves
        // with the payload, onboarding reuses it, and the account dropdown takes
        // the plan name from it instead of issuing a request of its own.
        const sessionPromise = trialBanner();
        sessionPromise.then(onboarding).catch(() => {});
        mountAccountMenu(el.querySelector('#v2-account-trigger'), el.querySelector('#v2-account-menu'), sessionPromise);
    }

    // ---------- trial banner ----------
    // Slim bar above the nav for signed-in users: a countdown during the no-card
    // Pro trial, and an "ended" prompt once it lapses to free. Both route to the
    // in-app upgrade checkout. Dismissals (trial state only) hold for the session.
    async function startUpgrade(e) {
        if (e) e.preventDefault();
        const t = token();
        if (!t) { location.href = '/register.html?plan=pro'; return; }
        try {
            const r = await fetch(`${V2.API}/checkout`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` },
                body: JSON.stringify({ plan: 'pro', next: 'dashboard.html' })
            });
            const d = await r.json().catch(() => ({}));
            if (r.ok && d.url) { location.href = d.url; return; }
        } catch (_) { /* fall through to the register page */ }
        location.href = '/register.html?plan=pro';
    }

    // Returns the /api/session payload (or null) so the caller can reuse it —
    // onboarding needs the same response and must not fetch it a second time.
    async function trialBanner() {
        const t = token();
        if (!t) return null;
        let s;
        try {
            const r = await fetch(`${V2.API}/session`, { headers: { Authorization: `Bearer ${t}` } });
            if (!r.ok) return null;
            s = await r.json();
        } catch (_) { return null; }
        const sub = s && s.subscription;
        // Upgrade chip in the nav: visible for every signed-in user except the
        // top paid tiers (they have nothing to upgrade to in the pricing grid).
        const topTier = ['power', 'power-monthly', 'desk', 'enterprise'].includes(sub && sub.planId) &&
            ['active', 'trialing', 'cancel_at_period_end'].includes(sub && sub.status);
        ['v2-upgrade', 'v2-mobile-upgrade'].forEach((id) => {
            const chip = document.getElementById(id);
            if (chip) chip.hidden = topTier;
        });
        if (!sub) return s;
        const ends = sub.trialEndsAt ? new Date(sub.trialEndsAt) : null;
        let html = '';
        let dismissible = false;
        if (sub.status === 'trialing' && ends) {
            if (sessionStorage.getItem('trialBannerDismissed') === '1') return s;
            const days = Math.max(0, Math.ceil((ends.getTime() - Date.now()) / 86400000));
            const label = days <= 1 ? 'Last day of your Pro trial' : `${days} days left in your Pro trial`;
            html = `<span>${label} — the full AI analyst is unlocked.</span> <a href="#" data-upgrade>Keep Pro →</a>`;
            dismissible = true;
        } else if (s.tier === 'free' && sub.status === 'cancelled' && !sub.activatedAt && ends && ends.getTime() < Date.now()) {
            html = `<span>Your free Pro trial has ended.</span> <a href="#" data-upgrade>Upgrade to keep the AI analyst →</a>`;
        } else {
            return s;
        }
        const bar = document.createElement('div');
        bar.className = 'trial-banner';
        bar.innerHTML = `<div class="container">${html}${dismissible ? '<button class="trial-x" aria-label="Dismiss">&times;</button>' : ''}</div>`;
        document.body.prepend(bar);
        const up = bar.querySelector('[data-upgrade]');
        if (up) up.addEventListener('click', startUpgrade);
        const x = bar.querySelector('.trial-x');
        if (x) x.addEventListener('click', () => { try { sessionStorage.setItem('trialBannerDismissed', '1'); } catch (_) {} bar.remove(); });
        return s;
    }

    // ---------- first-run onboarding ----------
    // Three steps, ordered by the intent the customer declares once in the
    // welcome dialog. Progress lives on the server (/api/session -> onboarding)
    // and every step is ticked by the backend handler that observes the real
    // action, so the card can never claim work that did not happen. Only
    // accounts created after the ship date are eligible.
    const ONBOARD_STEPS = {
        ask: { label: 'Ask one question about a company’s filings', href: '/onboarding' },
        hold: { label: 'Add a holding you own', href: '/dashboard.html#add-form' },
        watch: { label: 'Watch one company for changes', href: '/dashboard.html#rules-section' }
    };
    const ONBOARD_PATHS = {
        research: {
            title: 'Understand one company deeply',
            blurb: 'Ask its filings a question and read the cited source.',
            order: ['ask', 'hold', 'watch'], start: '/onboarding?path=research'
        },
        portfolio: {
            title: 'Track a portfolio I already own',
            blurb: 'Add your holdings, then see what moved them and why.',
            order: ['hold', 'ask', 'watch'], start: '/dashboard.html#add-form'
        },
        ideas: {
            title: 'Find new ideas to research',
            blurb: 'Screen the whole US market on real fundamentals.',
            order: ['ask', 'hold', 'watch'], start: '/screener.html'
        }
    };

    function saveOnboarding(body) {
        return fetch(`${API}/onboarding`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
            body: JSON.stringify(body)
        }).catch(() => { /* best-effort; onboarding is never worth an error */ });
    }

    function onboardingWelcome(name) {
        let chosen = 'research';
        const choices = Object.keys(ONBOARD_PATHS).map((id) => `
          <button type="button" class="onboard-choice${id === chosen ? ' is-on' : ''}" data-path="${id}" aria-pressed="${id === chosen}">
            <strong>${esc(ONBOARD_PATHS[id].title)}</strong>
            <span>${esc(ONBOARD_PATHS[id].blurb)}</span>
          </button>`).join('');
        const dlg = modal({
            label: 'Welcome',
            title: name ? `Welcome, ${name}.` : 'Welcome.',
            body: 'What do you want to do first? Pick one — the rest keeps for later.',
            bodyHtml: `<div class="onboard-choices">${choices}</div>`,
            actions: [
                {
                    label: 'Start', primary: true,
                    // Awaited, not fired-and-forgotten: the navigation on the next
                    // line would otherwise cancel the request that records the choice.
                    onClick: async () => { await saveOnboarding({ path: chosen }); location.href = ONBOARD_PATHS[chosen].start; }
                },
                { label: 'Skip for now', onClick: () => saveOnboarding({ dismissed: true }) }
            ],
            onDismiss: () => saveOnboarding({ dismissed: true })
        });
        const buttons = dlg.el.querySelectorAll('[data-path]');
        buttons.forEach((b) => b.addEventListener('click', () => {
            chosen = b.dataset.path;
            buttons.forEach((x) => {
                const on = x === b;
                x.classList.toggle('is-on', on);
                x.setAttribute('aria-pressed', String(on));
            });
        }));
    }

    function onboardingCard(state) {
        const order = (ONBOARD_PATHS[state.path] || ONBOARD_PATHS.research).order;
        const done = new Set(state.steps || []);
        const card = document.createElement('aside');
        card.className = 'onboard-card';
        card.setAttribute('aria-label', 'Getting started');
        card.innerHTML = `
          <div class="onboard-head">
            <button type="button" class="onboard-toggle" aria-expanded="true" aria-controls="onboard-list">
              <span>Getting started · ${done.size} of ${order.length}</span>
              <span class="onboard-caret" aria-hidden="true">▾</span>
            </button>
            <button type="button" class="onboard-x" aria-label="Dismiss getting started">&times;</button>
          </div>
          <ul class="onboard-list" id="onboard-list">
            ${order.map((id) => `
              <li class="${done.has(id) ? 'is-done' : ''}">
                <span class="onboard-mark" aria-hidden="true">${done.has(id) ? '✓' : ''}</span>
                <a href="${ONBOARD_STEPS[id].href}">${esc(ONBOARD_STEPS[id].label)}</a>
              </li>`).join('')}
          </ul>`;
        document.body.appendChild(card);

        // Collapsed/expanded is a per-browser convenience, not account state —
        // the dismissal is the decision worth recording on the server.
        const toggle = card.querySelector('.onboard-toggle');
        const setCollapsed = (on) => {
            card.classList.toggle('is-collapsed', on);
            toggle.setAttribute('aria-expanded', String(!on));
            try { localStorage.setItem('sp_onboard_collapsed', on ? '1' : '0'); } catch (_) { /* private mode */ }
        };
        try { if (localStorage.getItem('sp_onboard_collapsed') === '1') setCollapsed(true); } catch (_) { /* private mode */ }
        toggle.addEventListener('click', () => setCollapsed(!card.classList.contains('is-collapsed')));
        card.querySelector('.onboard-x').addEventListener('click', () => { saveOnboarding({ dismissed: true }); card.remove(); });
    }

    function onboarding(session) {
        const state = session && session.onboarding;
        if (!state || !state.eligible || state.dismissed || state.completed) return;
        // The wizard page is already the checklist; a floating copy of it there
        // would just cover the step the customer is working through.
        if (/^\/onboarding(\.html)?$/.test(location.pathname)) return;
        if (!state.path && /^\/dashboard(\.html)?$/.test(location.pathname)) {
            const first = String(session.profile && session.profile.name || '').trim().split(/\s+/)[0];
            onboardingWelcome(first || '');
            return;
        }
        onboardingCard(state);
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
    async function searchAssets(query, { limit = 10, types = null } = {}) {
        const q = String(query || '').trim();
        if (!q) return [];
        let rows = [];
        try {
            const r = await fetch(`${API}/assets/search?q=${encodeURIComponent(q)}&limit=${Math.min(limit, 20)}`);
            if (r.ok) rows = await r.json();
        } catch (_) { /* static fallback below */ }
        if (!Array.isArray(rows) || !rows.length) {
            const list = await companies();
            const up = q.toUpperCase();
            rows = list.filter((c) => (c.symbol || '').toUpperCase().startsWith(up))
                .concat(list.filter((c) => !(c.symbol || '').toUpperCase().startsWith(up) && (c.name || '').toUpperCase().includes(up)))
                .slice(0, limit).map((c) => ({ ...c, assetType: 'stock', assetTypeLabel: 'Stock' }));
        }
        if (types && types.length) rows = rows.filter((row) => types.includes(row.assetType || 'stock'));
        return rows.slice(0, limit);
    }
    function wireSearch(input, results) {
        if (!input) return;
        let items = [];
        let active = -1;
        const render = () => {
            if (!items.length) { results.hidden = true; return; }
            results.innerHTML = items.map((c, i) =>
                `<a href="/company.html?symbol=${encodeURIComponent(c.symbol)}" class="${i === active ? 'is-active' : ''}">
                   <span class="sym">${esc(c.symbol)}</span><span class="nm">${esc(c.name)}${c.assetType && c.assetType !== 'stock' ? ` · ${esc(c.assetTypeLabel || c.assetType)}` : ''}</span></a>`).join('');
            results.hidden = false;
        };
        input.addEventListener('input', async () => {
            const q = input.value.trim().toUpperCase();
            if (q.length < 1) { results.hidden = true; return; }
            items = await searchAssets(q, { limit: 8 });
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

    // Ticker autocomplete for the claim-check inputs — same company list the nav
    // search uses; typing a company name suggests the symbol, picking fills it.
    function mountTickerAutocomplete(input) {
        if (!input) return;
        const parent = input.parentElement;
        if (!parent) return;
        parent.style.position = 'relative';
        const box = document.createElement('div');
        box.className = 'sym-ac';
        box.hidden = true;
        parent.appendChild(box);
        let items = [], active = -1;
        const render = () => {
            if (!items.length) { box.hidden = true; return; }
            box.innerHTML = items.map((c, i) =>
                `<button type="button" data-sym="${esc(c.symbol)}" class="${i === active ? 'is-active' : ''}"><span class="sym">${esc(c.symbol)}</span><span class="nm">${esc(c.name || '')}${c.assetType && c.assetType !== 'stock' ? ` · ${esc(c.assetTypeLabel || c.assetType)}` : ''}</span></button>`).join('');
            box.hidden = false;
        };
        const pick = (sym) => { input.value = sym; box.hidden = true; items = []; };
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
    function scanTickerAc() {
        document.querySelectorAll('[data-ticker-ac]').forEach((input) => {
            if (input.__tickerAc) return;
            input.__tickerAc = true;
            mountTickerAutocomplete(input);
        });
    }

    function footer() {
        // Idempotent for the same reason as nav() above: profile.js and the
        // bundled messages.js both call footer() on profile.html.
        if (document.querySelector('footer.footer')) return;
        const el = document.createElement('footer');
        el.className = 'footer';
        el.innerHTML = `
          <div class="container footer-inner">
            <div>© 2026 stockportfolio.pro — figures from SEC filings (10-K/10-Q), as filed; per-share figures split-adjusted. Not investment advice.</div>
            <div style="display:flex; gap:8px 18px; flex-wrap:wrap;">
              <a href="/tools">Free tools</a><a href="/company.html?symbol=SPY">ETFs &amp; funds</a><a href="/stocks">All stocks</a><a href="/ask.html">Ask AI</a><a href="/dossier.html">Research Dossier</a><a href="/monitor.html">Filing Monitor</a><a href="/gurus.html">Gurus</a><a href="/#pricing">Pricing</a><a href="/tour">Tour</a><a href="/privacy.html">Privacy</a><a href="/terms.html">Terms</a><a href="/support.html">Support</a><a href="/sitemap.html">Sitemap</a>
            </div>
          </div>`;
        document.body.appendChild(el);
    }

    // Reusable, user-initiated sharing for every AI output. Each platform gets
    // a meaning-preserving rewrite sized for that platform before it opens.
    function mountShare(host, { title = 'stockportfolio.pro research', text = '', url = location.href } = {}) {
        if (!host) return;
        const publicContent = String(text || '').replace(/\u0000/g, '').trim().slice(0, 20000);
        const clean = publicContent.replace(/```[\s\S]*?```/g, ' ').replace(/[#*_>`|\[\]]/g, '').replace(/\s+/g, ' ').trim();
        const fallbackUrl = String(url || location.href);
        const prepared = new Map();
        let publicReportPromise = null;
        host.classList.add('share-actions');
        host.innerHTML = `
          <span class="share-label">Share</span>
          <button type="button" class="share-btn" data-share="x">X / Twitter</button>
          <button type="button" class="share-btn" data-share="linkedin">LinkedIn</button>
          <button type="button" class="share-btn" data-share="email">Email</button>
          <button type="button" class="share-btn" data-share="whatsapp">WhatsApp</button>
          <span class="share-disclosure" style="flex-basis:100%;font-size:12px;color:var(--muted,#68717d);line-height:1.4">Clicking a share option creates an unlisted public copy. Anyone with its URL can view the shared research.</span>
          <span class="share-status" role="status" aria-live="polite"></span>`;

        const status = host.querySelector('.share-status');
        const say = (message) => { status.textContent = message; clearTimeout(status.__timer); status.__timer = setTimeout(() => { status.textContent = ''; }, 5500); };
        const copyText = async (value) => {
            try { await navigator.clipboard.writeText(value); return true; }
            catch (_) {
                // Clipboard can be blocked (permissions policy, insecure origin)
                // — don't dead-end: show the link in the shared modal so it can
                // still be copied by hand. window.prompt stays as the fallback
                // if app.js's dialog itself is somehow unavailable.
                if (window.V2 && V2.modal) {
                    const m = V2.modal({
                        label: 'Copy link',
                        title: 'Copy this link',
                        body: 'Your browser blocked automatic copying — select the link below and copy it manually.',
                        bodyHtml: `<textarea class="input" readonly rows="2" style="width:100%;resize:vertical;">${esc(value)}</textarea>`,
                        actions: [{ label: 'Done', primary: true }]
                    });
                    const ta = m.el.querySelector('textarea');
                    ta.addEventListener('focus', () => ta.select());
                } else {
                    window.prompt('Copy this post', value);
                }
                return false;
            }
        };
        const prepare = (platform) => {
            if (!prepared.has(platform)) prepared.set(platform, fetch(`${API}/ai/share-copy`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(token() ? { Authorization: `Bearer ${token()}` } : {})
                },
                body: JSON.stringify({ platform, title, content: clean })
            }).then(async (r) => {
                const data = await r.json().catch(() => ({}));
                if (!r.ok || !data.caption) throw new Error(data.message || 'Share rewrite failed');
                return data.caption;
            }).catch(() => [title, clean].filter(Boolean).join('\n\n')));
            return prepared.get(platform);
        };
        // No report is created during render or hover. The first explicit share
        // click creates one immutable URL; every subsequent platform reuses it.
        const ensurePublicReport = () => {
            if (!publicReportPromise) {
                publicReportPromise = fetch(`${API}/research-shares`, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        ...(token() ? { Authorization: `Bearer ${token()}` } : {})
                    },
                    body: JSON.stringify({ title, content: publicContent || clean, sourceUrl: fallbackUrl })
                }).then(async (r) => {
                    const data = await r.json().catch(() => ({}));
                    if (!r.ok || !data.url) throw new Error(data.message || 'Public link creation failed');
                    return { url: data.url, isPublicReport: true };
                }).catch(() => ({ url: fallbackUrl, isPublicReport: false }));
            }
            return publicReportPromise;
        };
        host.addEventListener('click', async (event) => {
            const button = event.target.closest('[data-share]');
            if (!button) return;
            const platform = button.dataset.share;
            // Only the four approved platforms are handled; any other is ignored.
            if (!['x', 'linkedin', 'email', 'whatsapp'].includes(platform)) return;
            const popup = platform === 'email' ? null : window.open('about:blank', '_blank', 'width=760,height=640');
            if (popup) popup.opener = null;
            const openPrepared = (target) => {
                if (popup) popup.location.href = target;
                else { window.open(target, '_blank', 'noopener,noreferrer'); say('If nothing opened, allow pop-ups and try again.'); }
            };
            const original = button.textContent;
            button.disabled = true; button.textContent = 'Preparing…';
            try {
                const [caption, report] = await Promise.all([prepare(platform), ensurePublicReport()]);
                const shareUrl = report.url;
                // caption is already platform-structured via /api/ai/share-copy (x: compact 245, linkedin: structured 2600, whatsapp: concise, email: structured 4000)
                // Visualizations and charts are viewable at the public report URL, which is always appended.
                if (platform === 'x') {
                    openPrepared(`https://twitter.com/intent/tweet?text=${encodeURIComponent(caption)}&url=${encodeURIComponent(shareUrl)}`);
                } else if (platform === 'whatsapp') {
                    openPrepared(`https://wa.me/?text=${encodeURIComponent([caption, shareUrl].filter(Boolean).join('\n\n'))}`);
                } else if (platform === 'linkedin') {
                    await copyText(caption); openPrepared(`https://www.linkedin.com/sharing/share-offsite/?url=${encodeURIComponent(shareUrl)}`); say('LinkedIn post copied — paste it into the share window. The public report holds the charts.');
                } else if (platform === 'email') {
                    const subject = encodeURIComponent(String(title || 'StockPortfolio.pro research').slice(0, 180));
                    const body = encodeURIComponent([caption, '', `View the full research with charts: ${shareUrl}`, '', '— Shared from StockPortfolio.pro'].filter(Boolean).join('\n\n'));
                    window.location.href = `mailto:?subject=${subject}&body=${body}`;
                    say('Email draft opened with structured research and report link.');
                }
                if (!report.isPublicReport) say('Public link unavailable; shared this page instead.');
            } finally {
                button.disabled = false; button.textContent = original;
            }
        });
    }

    // ---------- Ask (one streaming engine, two shells: inline + floor) ----------
    const TOOL_LABELS = {
        get_fund_profile: (a) => `${(a.symbol || '').toUpperCase()} fund profile`,
        rank_funds: (a) => `Ranked ${a.asset_type === 'mutual_fund' ? 'mutual funds' : a.asset_type === 'etf' ? 'ETFs' : 'ETFs and mutual funds'}`,
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
        fetch_page: (a) => { try { return 'Read ' + new URL(a.url).hostname.replace('www.', ''); } catch (_) { return 'Read a page'; } },
        get_unit_economics: (a) => `${(a.symbol || '').toUpperCase()} unit economics`,
        get_red_flags: (a) => `${(a.symbol || '').toUpperCase()} red-flag scan`,
        get_reverse_dcf: (a) => `${(a.symbol || '').toUpperCase()} reverse DCF`,
        get_peer_context: (a) => `${(a.symbol || '').toUpperCase()} peer & industry context`,
        get_key_points: (a) => `${(a.symbol || '').toUpperCase()} key points (10-K)`,
        get_governance: (a) => `${(a.symbol || '').toUpperCase()} governance & ownership`,
        get_esg: (a) => `${(a.symbol || '').toUpperCase()} ESG disclosure`,
        get_filing_diff: (a) => `${(a.symbol || '').toUpperCase()} filing diff`,
        get_guru_ownership: (a) => `${(a.symbol || '').toUpperCase()} guru ownership`,
        get_portfolio_xray: () => 'Portfolio X-Ray',
        view_image: (a) => `🔍 Reading ${String(a.attachment || 'image').slice(0, 40)}…`,
        read_document: (a) => `📄 Reading ${String(a.attachment || 'document').slice(0, 40)}…`,
        remember: (a) => `🧠 Added to memory: ${String(a.fact || '').slice(0, 60)}`
    };

    // outline thumb (drawn for this design — no icon font)
    const THUMB = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"><path d="M5.5 7.5v6h-3v-6h3zm0 0 2.2-4.6a1.3 1.3 0 0 1 2.47.7L9.7 6h2.9a1.4 1.4 0 0 1 1.36 1.73l-1.1 4.7a1.4 1.4 0 0 1-1.36 1.07H5.5"/></svg>';
    const ICON_COPY = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5H4a1.5 1.5 0 0 0-1.5 1.5v6.5"/></svg>';
    const ICON_RERUN = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"><path d="M13.2 8A5.2 5.2 0 1 1 10.9 3.7"/><path d="M11 1.2v2.8h2.8L11 1.2z"/></svg>';

    // ---------- shared dialog ----------
    // One centered modal for the whole app. Extracted from the AppSumo review
    // prompt so the onboarding welcome step reuses the same scrim, Escape and
    // backdrop-dismiss behaviour instead of a second hand-rolled overlay.
    // Actions: { label, href, newTab, primary, close, onClick(close) }. `close`
    // defaults to true for buttons; pass close:false for a link that should
    // leave the dialog standing while a new tab opens.
    function modal({ label, title, body, bodyHtml, actions = [], onDismiss } = {}) {
        const back = document.createElement('div');
        back.className = 'v2-modal';
        back.setAttribute('role', 'dialog');
        back.setAttribute('aria-modal', 'true');
        if (label) back.setAttribute('aria-label', label);
        back.innerHTML = `
          <div class="v2-modal-card">
            ${title ? `<h2 class="v2-modal-title">${esc(title)}</h2>` : ''}
            ${body ? `<p class="v2-modal-body">${esc(body)}</p>` : ''}
            ${bodyHtml || ''}
            <div class="v2-modal-actions"></div>
          </div>`;

        const onKey = (e) => { if (e.key === 'Escape') { if (onDismiss) onDismiss(); close(); } };
        function close() { back.remove(); document.removeEventListener('keydown', onKey); }

        const row = back.querySelector('.v2-modal-actions');
        actions.forEach((a) => {
            const el = document.createElement(a.href ? 'a' : 'button');
            el.className = 'v2-modal-btn' + (a.primary ? ' v2-modal-btn-primary' : '');
            el.textContent = a.label;
            if (a.href) {
                // href is set as a property, never interpolated into markup.
                el.href = a.href;
                if (a.newTab) { el.target = '_blank'; el.rel = 'noopener'; }
            } else {
                el.type = 'button';
            }
            el.addEventListener('click', () => {
                if (a.onClick) a.onClick(close);
                if (a.close !== false && !a.href) close();
            });
            row.appendChild(el);
        });

        back.addEventListener('click', (e) => { if (e.target === back) { if (onDismiss) onDismiss(); close(); } });
        document.addEventListener('keydown', onKey);
        document.body.appendChild(back);
        const first = row.querySelector('.v2-modal-btn');
        if (first) first.focus();
        return { el: back, close };
    }

    // One-time AppSumo review prompt. Eligibility lives entirely on the server
    // (second distinct day of successful Asks), and 'shown' is recorded the
    // moment it opens, so a reload or a second answer in the same session can
    // never bring it back. A local guard stops a double-fire within one page.
    let reviewPromptOpen = false;
    function showReviewPrompt(prompt) {
        if (reviewPromptOpen || !prompt || !prompt.url || !token()) return;
        reviewPromptOpen = true;
        const mark = (action) => fetch(`${API}/review/prompt`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
            body: JSON.stringify({ action })
        }).catch(() => { /* best-effort; the prompt is not worth an error */ });

        modal({
            label: 'Review request',
            title: prompt.headline || 'Worth a review?',
            body: prompt.body || '',
            // The review link opens a new tab; the dialog stays put so the
            // customer can come back to it rather than losing their place.
            actions: [
                { label: prompt.cta || 'Leave a review', href: prompt.url, newTab: true, primary: true, close: false, onClick: () => mark('clicked') },
                { label: 'Not now', onClick: () => mark('dismissed') }
            ],
            onDismiss: () => mark('dismissed')
        });
        // Recorded on open, not on click — "we already asked this person" is the
        // fact worth remembering, whichever way they answered.
        mark('shown');
    }

    function askEngine(exchange, { onActivity, onComplete } = {}) {
        const history = [];
        let busy = false;
        let aborter = null;

        const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const atBottom = () => (document.documentElement.scrollHeight - window.scrollY - window.innerHeight) < 160;
        const recoveryTool = (question) => {
            const q = String(question || '').toLowerCase();
            if (/dilut|share count|shares outstanding|buyback|repurchase/.test(q)) return 'dilution';
            if (/filing|10-k|10-q|8-k|proxy|insider|form 4/.test(q)) return 'filing-timeline';
            return 'earnings-quality';
        };
        async function tickerInQuestion(question) {
            const q = String(question || '').toUpperCase();
            const explicit = q.match(/\$([A-Z][A-Z0-9.-]{0,9})/);
            if (explicit && /^[A-Z0-9.\-]{1,10}$/.test(explicit[1])) return explicit[1];
            const candidates = q.match(/\b[A-Z][A-Z0-9.-]{0,9}\b/g) || [];
            const list = await companies();
            const known = new Set((list || []).map((c) => String(c.symbol || '').toUpperCase()).filter(Boolean));
            return candidates.find((candidate) => known.has(candidate)) || '';
        }
        async function deterministicRecovery(question, answerEl, traceEl) {
            const symbol = await tickerInQuestion(question);
            if (!symbol) return false;
            const tool = recoveryTool(question);
            let data;
            try {
                const r = await fetch(`${API}/free-tools/${tool}?symbol=${encodeURIComponent(symbol)}`);
                if (!r.ok) return false;
                data = await r.json();
            } catch (_) { return false; }
            if (!data || data.error) return false;
            const safeSource = /^https:\/\/www\.sec\.gov\//.test(String(data.sourceUrl || '')) ? String(data.sourceUrl) : '';
            const sourceLink = safeSource ? ` · <a href="${esc(safeSource)}" target="_blank" rel="noopener nofollow">Open SEC source</a>` : '';
            let body = '';
            if (tool === 'earnings-quality') {
                body = `<table><tbody>
                  <tr><th>Period</th><td>${esc(data.period || '—')}</td></tr>
                  <tr><th>Revenue</th><td>${money(data.revenue)}</td></tr>
                  <tr><th>Net income</th><td>${money(data.netIncome)}</td></tr>
                  <tr><th>Operating cash flow</th><td>${money(data.operatingCashFlow)}</td></tr>
                  <tr><th>Free cash flow</th><td>${money(data.freeCashFlow)}</td></tr>
                  <tr><th>Cash conversion</th><td>${data.cashConversionRatio == null ? '—' : pct(Number(data.cashConversionRatio) * 100, 1)}</td></tr>
                </tbody></table>`;
            } else if (tool === 'dilution') {
                body = `<table><tbody>
                  <tr><th>Latest filed shares</th><td>${fixed(data.latest && data.latest.shares, 0)} (${esc(data.latest && data.latest.period || '—')})</td></tr>
                  <tr><th>Prior filed shares</th><td>${fixed(data.prior && data.prior.shares, 0)} (${esc(data.prior && data.prior.period || '—')})</td></tr>
                  <tr><th>Change</th><td>${fixed(data.change, 0)} (${data.percentageChange == null ? '—' : pct(data.percentageChange, 1)})</td></tr>
                </tbody></table>`;
            } else {
                const filings = Array.isArray(data.filings) ? data.filings.slice(0, 6) : [];
                body = filings.length
                    ? `<table><thead><tr><th>Form</th><th>Filed</th><th>Source</th></tr></thead><tbody>${filings.map((f) => `<tr><td>${esc(f.form || '—')}</td><td>${esc(f.date || '—')}</td><td><a href="${esc(String(f.url || ''))}" target="_blank" rel="noopener nofollow">SEC filing</a></td></tr>`).join('')}</tbody></table>`
                    : '<p>No recent filing rows were available for this ticker.</p>';
            }
            const warnings = Array.isArray(data.warnings) && data.warnings.length
                ? `<p class="small faint">${data.warnings.map((w) => esc(w)).join(' ')}</p>` : '';
            const landing = `/tools/${tool}?symbol=${encodeURIComponent(symbol)}`;
            answerEl.innerHTML = `<div class="notice"><strong>AI synthesis is temporarily unavailable.</strong><p>Here is a deterministic filing check for ${esc(symbol)} so your research can continue.</p>${body}${warnings}<p class="small faint">No AI conclusion was used. <a href="${landing}">Run the full ${esc(tool.replace(/-/g, ' '))} tool</a>${sourceLink}.</p></div>`;
            if (traceEl) {
                traceEl.innerHTML = '<details><summary>Used deterministic filing data</summary><div><span class="ask-step">StockPortfolio.pro fundamentals cache</span></div></details>';
            }
            return true;
        }

        async function send(question, opts = {}) {
            if (busy) return;
            busy = true;
            if (onActivity) onActivity();
            aborter = new AbortController();
            const block = document.createElement('div');
            // The working state shows EVERYTHING the stream has told us so far:
            // the model's own plan (`note`), every finished step with its
            // duration, the step running now, a live timer, and a skeleton
            // where the answer will land. Previously all of this was collected
            // into traceSteps but never rendered until the answer arrived — the
            // user watched one grey italic line for the whole tool phase.
            const blockAskMode = localStorage.getItem('sp_ask_mode_v1') === 'analyst' ? 'analyst' : 'normal';
            block.innerHTML = `
              <div class="ask-q">${esc(question)}</div>
              <div class="ask-trace"></div>
              <div class="ask-progress" role="status" aria-live="polite">
                <div class="ask-progress-head">
                  <span class="ask-ring" aria-hidden="true"></span>
                  <span class="ask-working">Reading the filings…</span>
                  <span class="ask-elapsed" aria-hidden="true">0:00</span>
                  <button type="button" class="ask-stop" aria-label="Stop">Stop</button>
                </div>
                <p class="ask-note" hidden></p>
                <div class="ask-steps"></div>
              </div>
              <div class="ask-a${blockAskMode === 'normal' ? ' is-normal' : ''}"></div>
              <div class="ask-skel" aria-hidden="true">
                <span class="skeleton"></span>
                <span class="skeleton" style="width:72%"></span>
                <span class="skeleton" style="width:88%"></span>
                <span class="skeleton" style="width:54%"></span>
              </div>`;
            exchange.appendChild(block);
            const traceEl = block.querySelector('.ask-trace');
            const answerEl = block.querySelector('.ask-a');
            const workingRow = block.querySelector('.ask-progress');
            const workingEl = block.querySelector('.ask-working');
            const noteEl = block.querySelector('.ask-note');
            const stepsEl = block.querySelector('.ask-steps');
            const skelEl = block.querySelector('.ask-skel');
            const traceSteps = [];
            // one timer drives both the head readout and each step's duration
            const startedAt = Date.now();
            let stepStartedAt = startedAt;
            const secs = (ms) => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`;
            const elapsedEl = block.querySelector('.ask-elapsed');
            const ticker = setInterval(() => {
                if (!elapsedEl.isConnected) return clearInterval(ticker);
                elapsedEl.textContent = secs(Date.now() - startedAt);
            }, 1000);
            // every step stays on screen, newest last, with what it cost
            const renderSteps = () => {
                stepsEl.innerHTML = traceSteps.map((s, i) => {
                    const running = i === traceSteps.length - 1 && s.ms == null;
                    return `<div class="row${s.miss ? ' miss' : ''}${running ? ' now' : ''}">`
                        + `<span class="mk">${running ? '●' : s.miss ? '✕' : '✓'}</span>`
                        + `<span class="lb">${esc(s.label)}</span>`
                        + `<span class="dur">${s.ms == null ? '' : `${(s.ms / 1000).toFixed(1)}s`}</span>`
                        + '</div>';
                }).join('');
            };
            // first token: the skeleton has served its purpose and the card
            // steps aside — but it is only HIDDEN, because a `rollback` can
            // send us back to the tool phase and it has to come back.
            const pauseProgress = () => {
                if (skelEl.isConnected) skelEl.remove();
                workingRow.hidden = true;
            };
            // terminal: answered, failed, or stopped
            const closeProgress = () => {
                clearInterval(ticker);
                if (skelEl.isConnected) skelEl.remove();
                if (workingRow.isConnected) workingRow.remove();
            };
            const showFailure = async (message) => {
                closeProgress();
                renderTrace();
                if (await deterministicRecovery(question, answerEl, traceEl)) {
                    if (onComplete) onComplete({ deterministic: true });
                    return;
                }
                answerEl.innerHTML = `<div class="notice">${esc(message || 'Ask is temporarily unavailable.')} <button type="button" class="btn btn-quiet btn-sm" data-ask-retry style="margin-top:10px">Retry this question</button><p class="small faint" style="margin-top:8px">Your question is preserved above. You can retry it without retyping.</p></div>`;
                const retry = answerEl.querySelector('[data-ask-retry]');
                if (retry) retry.addEventListener('click', () => { retry.disabled = true; send(question, opts); });
            };
            block.querySelector('.ask-stop').addEventListener('click', () => { if (aborter) aborter.abort(); });
            const renderTrace = () => {
                if (!traceSteps.length) { traceEl.innerHTML = ''; return; }
                const took = (Date.now() - startedAt) / 1000;
                traceEl.innerHTML = `
                  <details>
                    <summary>Researched ${traceSteps.length} source${traceSteps.length > 1 ? 's' : ''} · ${took.toFixed(1)}s</summary>
                    <div>${traceSteps.map((s) => `<span class="ask-step${s.miss ? ' ask-step-miss' : ''}">${esc(s.label)}</span>`).join('')}</div>
                  </details>`;
            };
            // 'nearest' frequently resolved to "do nothing" against the sticky
            // dock, leaving a new turn parked underneath it. Put the question at
            // the top of the viewport instead (scroll-margin-top clears the nav).
            block.scrollIntoView({ behavior: 'smooth', block: 'start' });
            try {
                const _askHeaders = { 'Content-Type': 'application/json' };
                if (token()) _askHeaders.Authorization = `Bearer ${token()}`;
                let r;
                for (let attempt = 0; attempt < 2; attempt++) {
                    try {
                        const askMode = localStorage.getItem('sp_ask_mode_v1') === 'analyst' ? 'analyst' : 'normal';
                        r = await fetch(`${API}/ai/chat`, {
                            method: 'POST',
                            headers: _askHeaders,
                            // the server owns per-thread context when a threadId
                            // is present; callers without one behave exactly as before
                            body: JSON.stringify({ question, history: history.slice(-8), stream: true, mode: askMode, ...(opts && opts.threadId ? { threadId: opts.threadId } : {}), ...(opts && Array.isArray(opts.attachments) && opts.attachments.length ? { attachments: opts.attachments } : {}) }),
                            signal: aborter.signal
                        });
                        if (r.status < 500 || attempt === 1) break;
                    } catch (error) {
                        if ((error && error.name === 'AbortError') || attempt === 1) throw error;
                    }
                    workingEl.textContent = 'Temporary issue — retrying…';
                    await wait(700);
                }
                const ct = r.headers.get('content-type') || '';
                if (!ct.includes('text/event-stream')) {
                    const data = await r.json().catch(() => ({}));
                    closeProgress();
                    if (r.status === 401) {
                        answerEl.innerHTML = `Ask needs an account — <a href="/login.html">log in</a> or <a href="/register.html?plan=free">create a free account</a>.`;
                    } else if (r.status === 429) {
                        answerEl.innerHTML = data && data.trial
                            ? `<div class="notice">${esc((data && data.message) || 'That was the free preview.')} <a href="/login.html">Log in</a> or <a href="/register.html?plan=free">create a free account &rarr;</a> · or <a href="/verify.html">verify one headline against the filing, free</a></div>`
                            : quotaWall(data);
                    } else if (data.answer && data.source !== 'error') {
                        finish(data);
                    } else {
                        await showFailure((data && data.message) || 'Ask is temporarily unavailable.');
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
                        // close out whatever was running, then open this step
                        const open = traceSteps[traceSteps.length - 1];
                        if (open && open.ms == null) open.ms = Date.now() - stepStartedAt;
                        stepStartedAt = Date.now();
                        if (!traceSteps.some((s) => s.label === label)) traceSteps.push({ label, miss: d.ok === false });
                        workingEl.textContent = label + '…';
                        workingRow.hidden = false;
                        renderSteps();
                    } else if (ev === 'note') {
                        // the model's own plan, in its own words — kept on screen
                        // beside the steps rather than overwriting the status line
                        const t = String(d.text || '').trim();
                        if (t) { noteEl.textContent = t; noteEl.hidden = false; }
                        workingEl.textContent = 'Working on it';
                        workingRow.hidden = false;
                    } else if (ev === 'delta') {
                        text += d.text || '';
                        answerEl.innerHTML = markdown(text);
                        answerEl.classList.add('ask-cursor');
                        const open = traceSteps[traceSteps.length - 1];
                        if (open && open.ms == null) open.ms = Date.now() - stepStartedAt;
                        pauseProgress(); // the answer itself is now the progress
                        renderTrace();
                        // follow the text only if the reader is already at the
                        // bottom — never yank someone who has scrolled back up
                        if (atBottom()) window.scrollTo({ top: document.documentElement.scrollHeight });
                    } else if (ev === 'rollback') {
                        // the model discarded its draft and went back to work
                        text = '';
                        answerEl.innerHTML = '';
                        answerEl.classList.remove('ask-cursor');
                        workingEl.textContent = 'Rechecking the figures…';
                        stepStartedAt = Date.now();
                        workingRow.hidden = false;
                        renderSteps();
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
                closeProgress();
                renderTrace();
                if (finalData && finalData.answer && finalData.source !== 'error') finish(finalData);
                else await showFailure('Ask is temporarily unavailable.');

                    function finish(data) {
                    answerEl.classList.remove('ask-cursor');
                    closeProgress();
                    renderTrace();
                    answerEl.innerHTML = markdown(data.answer);
                    answerEl.querySelectorAll('.ask-next').forEach((b) =>
                        b.addEventListener('click', () => { b.disabled = true; send(b.dataset.q, opts); }));
                    // The receipt leads the answer: the cited source is the first
                    // thing read, and it is the same sec.gov link source_opened tracks.
                    mountReceipt(answerEl);
                    // ChatGPT-style "Added to memory" card: every fact the
                    // remember tool saved during THIS answer surfaces under it,
                    // ✕ deletes it on the spot.
                    (Array.isArray(data.toolsUsed) ? data.toolsUsed : [])
                        .filter((t) => t && t.tool === 'remember' && t.args && t.args.fact)
                        .slice(-3)
                        .forEach((t) => {
                            const card = document.createElement('div');
                            card.className = 'ask-memcard';
                            card.setAttribute('style', 'display:flex;align-items:flex-start;gap:8px;margin:10px 0 0;padding:8px 12px;border:1px dashed var(--line-strong);border-radius:12px;font-size:12.5px;color:var(--ink-2);background:var(--surface);');
                            card.innerHTML = `<span>🧠 Added to memory — <em>${esc(String(t.args.fact).slice(0, 300))}</em></span><button type="button" data-mem-del title="Remove from memory" aria-label="Remove from memory" style="margin-left:auto;border:0;background:none;padding:0 2px;cursor:pointer;color:var(--ink-3);font-size:12px;line-height:1.4;">✕</button>`;
                            card.querySelector('[data-mem-del]').addEventListener('click', () => {
                                card.remove();
                                fetch(`${API}/ask/memory/${encodeURIComponent(t.args.fact)}`, {
                                    method: 'DELETE',
                                    headers: { Authorization: `Bearer ${token()}` }
                                }).catch(() => { /* best-effort */ });
                            });
                            answerEl.appendChild(card);
                        });
                    history.push({ role: 'user', content: question }, { role: 'assistant', content: data.answer });
                    // one quiet footer line: copy/rerun · feedback · quota
                    // (the trace disclosure above already holds the sources)
                    const foot = document.createElement('div');
                    foot.className = 'ask-foot';
                    const quotaTxt = (data.quota && Number.isFinite(data.quota.limit))
                        ? `${Math.max(0, data.quota.limit - data.quota.used)} of ${data.quota.limit} left`
                        : '';
                    foot.innerHTML = `
                      <span class="ask-fb" role="group" aria-label="Answer actions">
                        <button type="button" data-act="copy" title="Copy answer" aria-label="Copy answer">${ICON_COPY}</button>
                        <button type="button" data-act="rerun" title="Ask this again" aria-label="Ask this again">${ICON_RERUN}</button>
                      </span>
                      <span class="ask-fb" role="group" aria-label="Was this helpful?">
                        <button type="button" data-v="up" title="Helpful" aria-label="Helpful">${THUMB}</button>
                        <button type="button" data-v="down" title="Not helpful" aria-label="Not helpful" style="transform:scaleY(-1);">${THUMB}</button>
                      </span>
                      ${quotaTxt ? `<span>${quotaTxt}</span>` : ''}
                      <span class="scope">Never buy/sell advice — figures from SEC filings and fund data.</span>`;
                    foot.querySelector('[data-act="rerun"]').addEventListener('click', () => send(question, opts));
                    foot.querySelector('[data-act="copy"]').addEventListener('click', async (e) => {
                        const btn = e.currentTarget;
                        try {
                            await navigator.clipboard.writeText(String(data.answer));
                            btn.classList.add('is-picked');
                            btn.title = 'Copied';
                            setTimeout(() => { btn.classList.remove('is-picked'); btn.title = 'Copy answer'; }, 1600);
                        } catch (_) {
                            modal({
                                label: 'Copy answer',
                                title: 'Copy this answer',
                                body: 'Your browser blocked automatic copying — select the text below and copy it manually.',
                                bodyHtml: `<textarea class="input" rows="10" aria-label="Answer text" style="width:100%">${esc(String(data.answer))}</textarea>`
                            });
                        }
                    });
                    foot.querySelectorAll('button[data-v]').forEach((b) =>
                        b.addEventListener('click', () => {
                            foot.querySelectorAll('button[data-v]').forEach((x) => { x.disabled = true; x.classList.toggle('is-picked', x === b); });
                            fetch(`${API}/ai/chat/feedback`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token()}` },
                                body: JSON.stringify({ verdict: b.dataset.v, question, answer: String(data.answer).slice(0, 4000) })
                            }).catch(() => { /* best-effort */ });
                        }));
                    const share = document.createElement('div');
                    mountShare(share, { title: `Ask: ${question}`, text: data.answer });
                    foot.appendChild(share);
                        answerEl.appendChild(foot);
                        // Fires at most once per account: the server only sends
                        // reviewPrompt after a second distinct day of successful
                        // Asks and never again once 'shown' is recorded.
                        if (data.reviewPrompt) showReviewPrompt(data.reviewPrompt);
                        if (onComplete) onComplete(data || {});
                    }
            } catch (err) {
                if (err && err.name === 'AbortError') {
                    // user pulled the cord — keep whatever streamed, say so quietly
                    closeProgress();
                    renderTrace();
                    answerEl.classList.remove('ask-cursor');
                    answerEl.insertAdjacentHTML('beforeend', '<p class="small faint" style="margin-top:8px;">Stopped.</p>');
                } else {
                    await showFailure('Network problem while reaching Ask.');
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
            <input class="input" type="text" maxlength="8000" placeholder="${esc(placeholder || 'Ask about any company, ETF or mutual fund…')}" aria-label="Ask a question" />
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
        sheet.innerHTML = '<button type="button" class="ask-sheet-close" aria-label="Close">&times;</button><div class="ask-exchange"></div>';
        const bar = document.createElement('div');
        bar.className = 'ask-floor';
        bar.innerHTML = `
          <form class="ask-floor-inner">
            <span class="ask-kbd">⌘K</span>
            <input class="input" type="text" maxlength="8000" placeholder="${esc(placeholder || 'Ask about a company, ETF or mutual fund…')}" aria-label="Ask a question" />
            <button class="btn btn-primary" type="submit">Ask</button>
          </form>`;
        document.body.appendChild(sheet);
        document.body.appendChild(bar);
        const input = bar.querySelector('input');
        const exchange = sheet.querySelector('.ask-exchange');
        sheet.querySelector('.ask-sheet-close').addEventListener('click', () => { sheet.hidden = true; });
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

    // --- Draggable horizontal scrollbar for any wide .table-wrap, site-wide ---
    // Native scrollbars are invisible/undraggable on phones, so this thumb (click
    // + drag, both directions) is an explicit affordance. Idempotent (keyed on
    // wrap.__hbar) and shared by every page; an observer catches tables rendered
    // async after data loads. It only shows where a table actually overflows.
    function updateHbar(wrap) {
        const bar = wrap.__hbar; if (!bar) return;
        const thumb = bar.firstElementChild;
        const sw = wrap.scrollWidth, cw = wrap.clientWidth, max = sw - cw;
        if (max <= 2) { bar.classList.remove('on'); return; }
        bar.classList.add('on');
        const bw = bar.clientWidth;
        const tw = Math.max((cw / sw) * bw, 36);
        thumb.style.width = tw + 'px';
        thumb.style.transform = 'translateX(' + ((bw - tw) > 0 ? (wrap.scrollLeft / max) * (bw - tw) : 0) + 'px)';
    }
    function attachHScroll(wrap) {
        if (!wrap || wrap.dataset.hbar === 'off') return;
        if (wrap.__hbar) { updateHbar(wrap); return; }
        const bar = document.createElement('div'); bar.className = 'hbar';
        const thumb = document.createElement('div'); thumb.className = 'hbar-thumb';
        bar.appendChild(thumb);
        wrap.insertAdjacentElement('beforebegin', bar);
        wrap.classList.add('has-hbar');
        wrap.__hbar = bar;
        let drag = null;
        thumb.addEventListener('pointerdown', (e) => {
            e.preventDefault(); e.stopPropagation();
            drag = { x: e.clientX, left: wrap.scrollLeft };
            thumb.classList.add('grabbing');
            try { thumb.setPointerCapture(e.pointerId); } catch (_) { /* ignore */ }
        });
        thumb.addEventListener('pointermove', (e) => {
            if (!drag) return;
            const trackW = bar.clientWidth - thumb.offsetWidth;
            const max = wrap.scrollWidth - wrap.clientWidth;
            wrap.scrollLeft = drag.left + (e.clientX - drag.x) * (trackW > 0 ? max / trackW : 0);
        });
        const end = () => { drag = null; thumb.classList.remove('grabbing'); };
        thumb.addEventListener('pointerup', end);
        thumb.addEventListener('pointercancel', end);
        bar.addEventListener('pointerdown', (e) => {
            if (e.target === thumb) return;
            const r = bar.getBoundingClientRect();
            wrap.scrollLeft = ((e.clientX - r.left) / r.width) * (wrap.scrollWidth - wrap.clientWidth);
        });
        wrap.addEventListener('scroll', () => updateHbar(wrap));
        updateHbar(wrap);
    }
    function scanHScroll() { document.querySelectorAll('.table-wrap').forEach(attachHScroll); }
    function initHScroll() {
        scanHScroll();
        scanTickerAc();
        let t = null;
        new MutationObserver(() => { clearTimeout(t); t = setTimeout(() => { scanHScroll(); scanTickerAc(); }, 120); })
            .observe(document.body, { childList: true, subtree: true });
        window.addEventListener('resize', () => document.querySelectorAll('.table-wrap').forEach((w) => w.__hbar && updateHbar(w)));
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initHScroll);
    else initHScroll();

    mountCampaign();
    window.V2 = { API, token, trackActivation, trackMeaningfulActivation, trackSeoEvent, trackCustomerSuccess, trackGrowthEvent, trackDiagnosticEvent, mountCampaign, getStoredUtm, num, money, pct, fixed, fy, esc, sparkline, chart, markdown, nav, footer, formatReset, activityLabel, creditSplit, modal, onboarding, mountAsk, mountAskFloor, askEngine, companies, searchAssets, mountTickerAutocomplete, mountShare, spinner, attachHScroll };
})();
