// Shared Normal/Analyst mode helper + visual-first primitives for Ask,
// Dossier and Monitor. Ends the copy-pasted getMode()/chip markup (previously
// 3x: dossier.js, monitor.js, app.js). Everything here is a pure function
// returning HTML from data already in a page's payload — no extra AI calls,
// no network. Analyst-mode pages keep using their own existing chart helpers
// (chartBars/chartGroupedBars/etc.) untouched; these primitives are the
// simpler, plainer-language layer Normal mode reads instead.
(function () {
    'use strict';
    const { esc } = window.V2;

    function getMode(key) {
        return localStorage.getItem(key) === 'analyst' ? 'analyst' : 'normal';
    }

    function modeChips(idPrefix, mode) {
        return `<button class="chip${mode === 'normal' ? ' chip-accent' : ''}" id="${idPrefix}-mode-normal" aria-pressed="${mode === 'normal' ? 'true' : 'false'}" title="Plain-English writing, built with charts and simple visuals">Normal</button>` +
            `<button class="chip${mode === 'analyst' ? ' chip-accent' : ''}" id="${idPrefix}-mode-analyst" aria-pressed="${mode === 'analyst' ? 'true' : 'false'}" title="Denser analyst writing and tables">Analyst</button>`;
    }

    // 0..of filled dots — a quick at-a-glance verdict score.
    function ratingDots(score, of) {
        const total = of || 5;
        const n = Math.max(0, Math.min(total, Math.round(Number(score) || 0)));
        let dots = '';
        for (let i = 0; i < total; i++) dots += `<i class="pv-dot${i < n ? ' is-on' : ''}"></i>`;
        return `<span class="pv-dots" role="img" aria-label="${n} out of ${total}">${dots}</span>`;
    }

    // One labelled bar out of a max, with a tone (pos/neg/'') and a shown string.
    function scaleBar({ label, value, max, tone, shown }) {
        const m = Number(max) || 1;
        const pct = Math.max(2, Math.min(100, Math.abs(Number(value) || 0) / m * 100));
        return `<div class="pv-scale-row">` +
            `<span class="pv-scale-label">${esc(label)}</span>` +
            `<span class="pv-scale-track"><i class="pv-scale-fill${tone ? ' ' + esc(tone) : ''}" style="width:${pct.toFixed(1)}%"></i></span>` +
            `<b class="pv-scale-val">${esc(shown != null ? shown : String(value))}</b>` +
            `</div>`;
    }

    // Stacked horizontal split — e.g. "of every $1 of revenue: cost / profit".
    // parts: [{label, value, color, shown}]
    function splitBar(parts) {
        const total = parts.reduce((a, p) => a + Math.max(0, Number(p.value) || 0), 0) || 1;
        const segs = parts.map((p) => {
            const w = Math.max(0, Number(p.value) || 0) / total * 100;
            return `<i style="width:${w.toFixed(1)}%;background:${esc(p.color || 'var(--ink-3)')}" title="${esc(p.label)}: ${esc(p.shown || String(p.value))}"></i>`;
        }).join('');
        const legend = parts.map((p) => `<span class="pv-split-legend-item"><i style="background:${esc(p.color || 'var(--ink-3)')}"></i>${esc(p.label)} <b>${esc(p.shown || String(p.value))}</b></span>`).join('');
        return `<div class="pv-split"><div class="pv-split-track">${segs}</div><div class="pv-split-legend">${legend}</div></div>`;
    }

    // Two bars, same scale, for a direct A-vs-B comparison (e.g. priced-in
    // growth vs actual growth, or this company vs peers).
    function pairBars(aLabel, aVal, bLabel, bVal, fmt) {
        const f = fmt || ((v) => String(v));
        const max = Math.max(Math.abs(Number(aVal) || 0), Math.abs(Number(bVal) || 0), 1);
        const row = (label, val, cls) => {
            const pct = Math.max(3, Math.abs(Number(val) || 0) / max * 100);
            return `<div class="pv-pair-row"><span>${esc(label)}</span><span class="pv-pair-track"><i class="pv-pair-fill ${cls}" style="width:${pct.toFixed(1)}%"></i></span><b>${esc(f(val))}</b></div>`;
        };
        return `<div class="pv-pair">${row(aLabel, aVal, 'a')}${row(bLabel, bVal, 'b')}</div>`;
    }

    // Share-of-whole bars — e.g. segment revenue %.
    // items: [{label, pct, note}]
    function share(items) {
        return `<div class="pv-share">${items.map((it) => `
      <div class="pv-share-row">
        <span class="pv-share-label">${esc(it.label)}${it.note ? `<br /><span class="small faint">${esc(it.note)}</span>` : ''}</span>
        <span class="pv-share-track"><i style="width:${Math.max(2, Math.min(100, Number(it.pct) || 0)).toFixed(1)}%"></i></span>
        <b class="pv-share-val">${it.pct != null ? it.pct + '%' : '—'}</b>
      </div>`).join('')}</div>`;
    }

    // ---- plain-English formatters ----
    function perDollar(pct) {
        const n = Number(pct);
        if (!Number.isFinite(n)) return '';
        return `about ${Math.round(Math.abs(n))}¢ of every $1 of sales`;
    }

    function plainDir(direction) {
        const m = { improving: 'getting better', deteriorating: 'getting worse', stable: 'holding steady', up: 'up', down: 'down' };
        return m[direction] || String(direction || '');
    }

    function plainSeverity(sev) {
        const m = { high: 'Serious', warn: 'Worth watching', watch: 'Worth watching', medium: 'Worth watching', low: 'Minor' };
        return m[sev] || (sev ? String(sev) : 'Worth watching');
    }

    window.PV = { getMode, modeChips, ratingDots, scaleBar, splitBar, pairBars, share, perDollar, plainDir, plainSeverity };
})();
