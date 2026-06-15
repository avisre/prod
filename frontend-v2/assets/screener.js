// Screener: the public front door. Same /api/screener as v1.
(function () {
    'use strict';
    const { num, money, pct, fixed, esc, nav, footer } = window.V2;
    nav('screener');
    footer();

    const $ = (id) => document.getElementById(id);
    let rows = [];
    let sortKey = 'marketCapB';
    let sortDir = 'desc';

    const PRESETS = {
        compounders: { 'f-cagr': 8, 'f-margin': 12, 'f-roe': 15, 'f-fcf': true },
        cashmachines: { 'f-margin': 20, 'f-fcf': true, 'f-roe': 20 },
        hypergrowth: { 'f-cagr': 20 },
        dividends: { 'f-div': 2.5, 'f-fcf': true },
        value: { 'f-pe': 16, 'f-fcf': true, 'f-margin': 8 },
        earnings: { 'f-qtr': 25 },
        clear: {}
    };

    function setFilters(p) {
        ['f-cagr', 'f-margin', 'f-roe', 'f-pe', 'f-div', 'f-mcap', 'f-qtr'].forEach((id) => { $(id).value = p[id] ?? ''; });
        $('f-fcf').checked = !!p['f-fcf'];
        $('f-sector').value = '';
    }

    async function run() {
        const q = new URLSearchParams();
        const set = (k, v) => { if (v !== '' && v !== null && v !== undefined && v !== false) q.set(k, v); };
        set('sector', $('f-sector').value);
        set('minRevCagr5y', $('f-cagr').value);
        set('minNetMargin', $('f-margin').value);
        set('minRoe', $('f-roe').value);
        set('maxPe', $('f-pe').value);
        set('minDivYield', $('f-div').value);
        set('minMarketCapB', $('f-mcap').value);
        set('minQtrEarningsGrowth', $('f-qtr').value);
        if ($('f-fcf').checked) set('fcfPositive', '1');
        set('sortBy', sortKey === 'symbol' || sortKey === 'sector' ? 'marketCapB' : sortKey);
        set('limit', 100);
        try {
            const r = await fetch(`/api/screener?${q}`);
            const data = await r.json();
            rows = data.rows || [];
            $('result-count').textContent = `${data.matched} of ${data.universe} companies match`;
            const sel = $('f-sector');
            if (sel.options.length <= 1 && Array.isArray(data.sectors)) {
                data.sectors.forEach((s) => sel.insertAdjacentHTML('beforeend', `<option>${esc(s)}</option>`));
            }
            render();
        } catch (_) {
            $('results-body').innerHTML = '<tr><td colspan="10" style="text-align:center;padding:40px;" class="faint">Couldn’t load — try again.</td></tr>';
        }
    }

    function render() {
        const sorted = rows.slice().sort((a, b) => {
            const x = a[sortKey]; const y = b[sortKey];
            if (typeof x === 'string' || typeof y === 'string') {
                return (sortDir === 'asc' ? 1 : -1) * String(x || '').localeCompare(String(y || ''));
            }
            return ((x === null) - (y === null)) || (sortDir === 'asc' ? x - y : y - x);
        });
        if (!sorted.length) {
            $('results-body').innerHTML = '<tr><td colspan="10" style="text-align:center;padding:40px;" class="faint">No companies match these filters — loosen one and run again.</td></tr>';
            return;
        }
        $('results-body').innerHTML = sorted.map((r) => `
          <tr data-sym="${esc(r.symbol)}">
            <td class="row-head"><strong>${esc(r.symbol)}</strong>&ensp;<span class="muted">${esc(r.name)}</span></td>
            <td class="small muted" style="text-transform:capitalize;" data-label="Sector">${esc((r.sector || '').toLowerCase())}</td>
            <td data-label="Mkt cap">${r.marketCapB === null ? '—' : '$' + money(r.marketCapB * 1e9)}</td>
            <td data-label="P/E">${fixed(r.pe, 1)}</td>
            <td data-label="Rev CAGR 5y" class="${r.revCagr5Pct > 0 ? 'delta-pos' : r.revCagr5Pct < 0 ? 'delta-neg' : ''}">${pct(r.revCagr5Pct)}</td>
            <td data-label="Net margin">${pct(r.netMarginPct)}</td>
            <td data-label="ROE">${pct(r.roePct)}</td>
            <td data-label="Div yield">${r.divYieldPct === null ? '—' : pct(r.divYieldPct, 2)}</td>
            <td data-label="Qtr earn YoY" class="${r.qtrNetIncomeYoYPct > 0 ? 'delta-pos' : r.qtrNetIncomeYoYPct < 0 ? 'delta-neg' : ''}">${pct(r.qtrNetIncomeYoYPct, 0)}</td>
            <td data-label="Profit yrs">${r.profitableYears10 ?? '—'}/10</td>
          </tr>`).join('');
        document.querySelectorAll('#results-body tr').forEach((tr) =>
            tr.addEventListener('click', () => { location.href = `/company.html?symbol=${tr.dataset.sym}`; }));
    }

    document.querySelectorAll('th.sortable').forEach((th) =>
        th.addEventListener('click', () => {
            const k = th.dataset.sort;
            if (sortKey === k) sortDir = sortDir === 'desc' ? 'asc' : 'desc';
            else { sortKey = k; sortDir = k === 'pe' || k === 'symbol' || k === 'sector' ? 'asc' : 'desc'; }
            document.querySelectorAll('th.sortable').forEach((x) => x.removeAttribute('data-dir'));
            th.setAttribute('data-dir', sortDir);
            render();
        }));

    // ---- saved screens (localStorage) ----
    const SAVED_KEY = 'v2_saved_screens';
    const FILTER_IDS = ['f-cagr', 'f-margin', 'f-roe', 'f-pe', 'f-div', 'f-mcap', 'f-qtr'];
    function currentFilters() {
        const f = {};
        FILTER_IDS.forEach((id) => { if ($(id).value !== '') f[id] = $(id).value; });
        if ($('f-fcf').checked) f['f-fcf'] = true;
        if ($('f-sector').value) f['f-sector'] = $('f-sector').value;
        return f;
    }
    function savedScreens() {
        try { return JSON.parse(localStorage.getItem(SAVED_KEY) || '[]'); } catch (_) { return []; }
    }
    function renderSaved() {
        const wrap = $('saved-screens');
        wrap.innerHTML = savedScreens().map((s, i) =>
            `<button class="chip chip-accent" data-saved="${i}" title="Your saved screen">${esc(s.name)}&ensp;<span data-del-saved="${i}" aria-label="Delete ${esc(s.name)}" style="opacity:.6;">×</span></button>`).join('');
        wrap.querySelectorAll('[data-saved]').forEach((b) =>
            b.addEventListener('click', (e) => {
                if (e.target.dataset.delSaved !== undefined) {
                    const list = savedScreens();
                    list.splice(Number(e.target.dataset.delSaved), 1);
                    localStorage.setItem(SAVED_KEY, JSON.stringify(list));
                    renderSaved();
                    return;
                }
                const s = savedScreens()[Number(b.dataset.saved)];
                if (!s) return;
                setFilters(s.filters);
                if (s.filters['f-sector']) $('f-sector').value = s.filters['f-sector'];
                run();
            }));
    }
    $('save-btn').addEventListener('click', () => {
        const f = currentFilters();
        if (!Object.keys(f).length) return;
        const name = (window.prompt('Name this screen:') || '').trim().slice(0, 30);
        if (!name) return;
        const list = savedScreens().filter((s) => s.name !== name);
        list.push({ name, filters: f });
        localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(-8)));
        renderSaved();
    });
    renderSaved();

    document.querySelectorAll('#presets .chip[data-preset]').forEach((b) =>
        b.addEventListener('click', () => {
            document.querySelectorAll('#presets .chip[data-preset]').forEach((x) => x.classList.remove('chip-accent'));
            if (b.dataset.preset !== 'clear') b.classList.add('chip-accent');
            setFilters(PRESETS[b.dataset.preset] || {});
            run();
        }));
    $('run-btn').addEventListener('click', run);
    ['f-sector'].forEach((id) => $(id).addEventListener('change', run));
    // typing applies live — no hunting for the Run button; a manual edit also
    // releases the active preset highlight (you're off-script now)
    let debounce = null;
    document.querySelectorAll('.card input').forEach((i) => {
        i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(debounce); run(); } });
        i.addEventListener('input', () => {
            document.querySelectorAll('#presets .chip[data-preset]').forEach((x) => x.classList.remove('chip-accent'));
            clearTimeout(debounce);
            debounce = setTimeout(run, 450);
        });
    });

    run();
})();
