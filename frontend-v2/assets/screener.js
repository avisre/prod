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

    // One toggle for size — the band select maps to min/max cap bounds.
    // Saved screens from before 9/2 stored a plain min-$B number in f-mcap;
    // bandFor() migrates those to the closest band instead of dropping them.
    const BANDS = {
        mega: { min: 200 },
        large: { min: 10, max: 200 },
        mid: { min: 2, max: 10 },
        small: { min: 0.3, max: 2 },
        micro: { min: 0.05, max: 0.3 },
        penny: { max: 0.05 }
    };
    function bandFor(minB) {
        if (minB >= 200) return 'mega';
        if (minB >= 10) return 'large';
        if (minB >= 2) return 'mid';
        if (minB >= 0.3) return 'small';
        if (minB >= 0.05) return 'micro';
        return 'penny';
    }

    function setFilters(p) {
        ['f-cagr', 'f-margin', 'f-roe', 'f-pe', 'f-div', 'f-qtr'].forEach((id) => { $(id).value = p[id] ?? ''; });
        const mv = p['f-mcap'];
        $('f-mcap').value = (mv !== undefined && mv !== '' && !Number.isNaN(Number(mv))) ? bandFor(Number(mv)) : (mv || '');
        $('f-fcf').checked = !!p['f-fcf'];
        $('f-sector').value = '';
    }

    function buildQuery() {
        const q = new URLSearchParams();
        const set = (k, v) => { if (v !== '' && v !== null && v !== undefined && v !== false) q.set(k, v); };
        set('sector', $('f-sector').value);
        set('minRevCagr5y', $('f-cagr').value);
        set('minNetMargin', $('f-margin').value);
        set('minRoe', $('f-roe').value);
        set('maxPe', $('f-pe').value);
        set('minDivYield', $('f-div').value);
        const band = BANDS[$('f-mcap').value];
        if (band) {
            if (band.min !== undefined) set('minMarketCapB', band.min);
            if (band.max !== undefined) set('maxMarketCapB', band.max);
        }
        set('minQtrEarningsGrowth', $('f-qtr').value);
        if ($('f-fcf').checked) set('fcfPositive', '1');
        set('sortBy', sortKey === 'symbol' || sortKey === 'sector' ? 'marketCapB' : sortKey);
        set('limit', 100);
        // An adopted AI screen travels back as its own tool args — the server
        // whitelists them, so filters the controls cannot express (similar_to,
        // PEG ceilings, secondary-listing exclusions) survive the round trip.
        if (aiCriteria) q.set('criteria', JSON.stringify(aiCriteria));
        return q;
    }

    async function run() {
        const q = buildQuery();
        try {
            const r = await fetch(`/api/screener?${q}`);
            const data = await r.json();
            rows = data.rows || [];
            aiSimilar = data.similarTo || null;
            $('result-count').textContent = `${data.matched} of ${data.universe} companies match`;
            const sel = $('f-sector');
            if (sel.options.length <= 1 && Array.isArray(data.sectors)) {
                data.sectors.forEach((s) => sel.insertAdjacentHTML('beforeend', `<option>${esc(s)}</option>`));
            }
            render();
            renderAiNote();
        } catch (_) {
            // A dead-looking error row is a dead end (D7) — make it the retry
            // control itself so recovery is one click in place.
            const body = $('results-body');
            body.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:40px;" class="faint">Couldn’t load the screen. <button type="button" class="btn btn-ghost btn-sm" id="screen-retry">Retry</button></td></tr>';
            body.querySelector('#screen-retry').addEventListener('click', run);
        }
    }

    function render() {
        // A similarity screen arrives ranked by the server — re-sorting it
        // client-side by a column would silently destroy that ranking.
        const sorted = aiSimilar ? rows.slice() : rows.slice().sort((a, b) => {
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
            // Sorting by a column is off-script for a similarity screen: leave
            // it and re-fetch as a plain screen ordered by that column, so the
            // table and the TradingView export never disagree about the set.
            if (aiSimilar) { clearAiScreen(); run(); return; }
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
        const saveWith = (name) => {
            const list = savedScreens().filter((s) => s.name !== name);
            list.push({ name, filters: f });
            localStorage.setItem(SAVED_KEY, JSON.stringify(list.slice(-8)));
            renderSaved();
        };
        // Naming uses the shared dialog (D5); window.prompt stays as the
        // fallback for the unlikely case app.js didn't mount this page.
        if (!window.V2 || !V2.modal) {
            const name = (window.prompt('Name this screen:') || '').trim().slice(0, 30);
            if (name) saveWith(name);
            return;
        }
        const m = V2.modal({
            label: 'Name this screen',
            title: 'Name this screen',
            bodyHtml: '<input class="input" id="screen-name" maxlength="30" placeholder="e.g. Cash-rich small caps" style="width:100%;">',
            actions: [
                { label: 'Save screen', primary: true, onClick: (close) => {
                    const name = m.el.querySelector('#screen-name').value.trim().slice(0, 30);
                    if (!name) return;
                    close();
                    saveWith(name);
                } },
                { label: 'Cancel' }
            ]
        });
        const field = m.el.querySelector('#screen-name');
        field.focus();
        field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); m.el.querySelector('.v2-modal-btn-primary').click(); } });
    });
    renderSaved();

    // ---- export to TradingView (Investor/Pro tiers; the server enforces it) ----
    // The file is the current screen, in the order the table shows it, as a
    // comma-separated ticker list — the shape TradingView's "Import list"
    // takes. The server re-runs the screen and decides who may have it, so
    // this handler only has to explain the answer.
    function note(title, html) {
        if (window.V2 && V2.modal) V2.modal({ label: title, title, bodyHtml: html, actions: [{ label: 'OK', primary: true }] });
        else window.alert(title);
    }
    function sortedSymbols() {
        const ordered = aiSimilar ? rows.slice() : rows.slice().sort((a, b) => {
            const x = a[sortKey]; const y = b[sortKey];
            if (typeof x === 'string' || typeof y === 'string') {
                return (sortDir === 'asc' ? 1 : -1) * String(x || '').localeCompare(String(y || ''));
            }
            return ((x === null) - (y === null)) || (sortDir === 'asc' ? x - y : y - x);
        });
        return ordered.map((r) => r.symbol);
    }
    $('export-btn').addEventListener('click', async () => {
        if (!rows.length) { note('Nothing to export', '<p>Run a screen with at least one match first.</p>'); return; }
        if (!(window.V2 && V2.token && V2.token())) {
            note('Sign in to export', '<p>Exporting a screen to TradingView is included on the <strong>Investor and Pro</strong> tiers. <a href="/login.html?next=/screener.html">Sign in</a> to use it.</p>');
            return;
        }
        const q = buildQuery();
        q.set('order', sortedSymbols().join(','));
        const btn = $('export-btn');
        btn.disabled = true;
        try {
            const r = await fetch(`/api/screener/export?${q}`, { headers: { Authorization: `Bearer ${V2.token()}` }, credentials: 'same-origin' });
            if (r.status === 401) {
                note('Sign in to export', '<p>Your session has ended. <a href="/login.html?next=/screener.html">Sign in again</a> to export.</p>');
                return;
            }
            if (r.status === 402) {
                const d = await r.json().catch(() => ({}));
                note('An Investor and Pro feature', `<p>${esc(d.message || 'Exporting screens to TradingView is on the Investor and Pro tiers.')}</p><p><a href="${esc(d.upgradeUrl || '/upgrade.html')}">See upgrade options →</a></p>`);
                return;
            }
            if (!r.ok) throw new Error(String(r.status));
            const text = await r.text();
            const count = text ? text.split(',').length : 0;
            const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
            const a = document.createElement('a');
            a.href = url;
            a.download = `stockportfolio-screen-${new Date().toISOString().slice(0, 10)}.txt`;
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            note('Screen exported', `<p>Saved <strong>${count}</strong> ticker${count === 1 ? '' : 's'}.</p><p>In TradingView, open the watchlist panel, click the watchlist name, choose <strong>Import list…</strong> and pick the file.</p>`);
        } catch (_) {
            note('Export failed', '<p>Couldn’t export this screen. Please try again.</p>');
        } finally {
            btn.disabled = false;
        }
    });

    // ---- AI screen: plain words in, a real screen out ----------------------
    // The chip hands the question to the page's Ask floor; when Ask actually
    // runs screen_universe, the page offers to adopt the screen it ran — never
    // automatically. Adoption re-runs the exact tool args server-side through
    // ?criteria=, so the rows, the count and the export stay one code path.
    let aiCriteria = null;        // screen_universe args the page re-runs
    let aiSimilar = null;         // the result's similarTo block, for the note
    let pendingAiScreen = false;  // the chip started the in-flight Ask
    let pendingScreenArgs = null; // a screen Ask ran, waiting for adoption

    const AI_TOOL_EVT = (window.V2 && V2.askToolEvent) || 'v2:ask-tool';
    const AI_DONE_EVT = (window.V2 && V2.askDoneEvent) || 'v2:ask-done';
    const AI_MAPPED_KEYS = new Set(['similar_to', 'min_revenue_cagr_5y_pct', 'min_net_margin_pct', 'min_roe_pct', 'max_pe', 'min_dividend_yield_pct', 'min_latest_qtr_earnings_growth_yoy_pct', 'require_positive_fcf', 'min_market_cap_billions', 'max_market_cap_billions', 'sector']);

    function clearAiScreen() {
        aiCriteria = null;
        aiSimilar = null;
        renderAiNote();
    }

    function renderAiNote() {
        const el = $('ai-note');
        $('ai-screen-btn').classList.toggle('chip-accent', !!(pendingScreenArgs || aiCriteria));
        const clearBtn = '<button type="button" class="chip" id="ai-clear" title="Back to plain filters">×</button>';
        if (pendingScreenArgs) {
            el.style.display = 'flex';
            el.innerHTML = '<button type="button" class="chip chip-accent" id="ai-use-btn">Use this screen on the page</button><span class="muted">Doppelganger ran a screen over the filed fundamentals.</span>';
            $('ai-use-btn').addEventListener('click', adoptAiScreen);
            return;
        }
        if (aiSimilar) {
            const f = aiSimilar.factors || {};
            const bits = [];
            if (f.revCagr5Pct !== null && f.revCagr5Pct !== undefined) bits.push('rev CAGR ' + pct(f.revCagr5Pct));
            if (f.netMarginPct !== null && f.netMarginPct !== undefined) bits.push('net margin ' + pct(f.netMarginPct));
            const floor = (aiCriteria && aiCriteria.min_market_cap_billions) ? '' : ' · $2B+ market cap';
            el.style.display = 'flex';
            el.innerHTML = `<span class="muted">Ranked by resemblance to <strong>${esc(aiSimilar.symbol)}</strong>${bits.length ? ' — ' + esc(bits.join(', ')) : ''}${esc(floor)}; ${esc(aiSimilar.symbol)} excluded.</span>${clearBtn}`;
            $('ai-clear').addEventListener('click', () => { clearAiScreen(); run(); });
            return;
        }
        if (aiCriteria) {
            const extra = Object.keys(aiCriteria).filter((k) => !AI_MAPPED_KEYS.has(k));
            el.style.display = 'flex';
            el.innerHTML = `<span class="muted">Doppelganger screen applied${extra.length ? ' — also ' + esc(extra.map((k) => k.replace(/_/g, ' ')).join(', ')) : ''}.</span>${clearBtn}`;
            $('ai-clear').addEventListener('click', () => { clearAiScreen(); run(); });
            return;
        }
        el.style.display = 'none';
        el.innerHTML = '';
    }

    function syncFiltersTo(a) {
        [['f-cagr', 'min_revenue_cagr_5y_pct'], ['f-margin', 'min_net_margin_pct'], ['f-roe', 'min_roe_pct'], ['f-pe', 'max_pe'], ['f-div', 'min_dividend_yield_pct'], ['f-qtr', 'min_latest_qtr_earnings_growth_yoy_pct']]
            .forEach(([id, key]) => { $(id).value = (a[key] === undefined || a[key] === null) ? '' : a[key]; });
        $('f-fcf').checked = a.require_positive_fcf === true;
        // The cap select expresses a band, not a bound — only set it when the
        // screen's own bounds are exactly a band's, else leave it "Any size"
        // (the criteria still carries the bounds to the server).
        const minB = a.min_market_cap_billions ?? null, maxB = a.max_market_cap_billions ?? null;
        let bandName = '';
        for (const [name, b] of Object.entries(BANDS)) {
            if ((b.min ?? null) === minB && (b.max ?? null) === maxB) { bandName = name; break; }
        }
        $('f-mcap').value = bandName;
        const sector = typeof a.sector === 'string' ? a.sector.toUpperCase() : '';
        const opt = sector ? [...$('f-sector').options].find((o) => o.value.toUpperCase() === sector) : null;
        $('f-sector').value = opt ? opt.value : '';
    }

    function adoptAiScreen() {
        aiCriteria = pendingScreenArgs;
        pendingScreenArgs = null;
        syncFiltersTo(aiCriteria);
        run();
    }

    document.addEventListener(AI_TOOL_EVT, (e) => {
        // Only a screen from an Ask this chip started is ever offered, and an
        // explicit click still stands between Ask's run and the page's table.
        if (!pendingAiScreen) return;
        const d = e.detail || {};
        if (d.tool !== 'screen_universe' || d.ok === false) return;
        const args = d.args || {};
        if (!Object.keys(args).length) return; // an unfiltered screen is nothing to adopt
        pendingScreenArgs = args;
        renderAiNote();
    });
    document.addEventListener(AI_DONE_EVT, () => { pendingAiScreen = false; });

    const AI_EXAMPLES = ['Companies like AppLovin', 'High-margin growers under 30× earnings', 'Cash machines with steady dividends'];
    $('ai-screen-btn').addEventListener('click', () => {
        if (!(window.V2 && V2.askFloor && V2.modal)) return;
        const ask = (q) => { pendingAiScreen = true; V2.askFloor.send(q); };
        const m = V2.modal({
            label: 'Doppelganger',
            title: "Find a stock's doppelganger",
            bodyHtml: `<p class="small muted" style="margin:0 0 10px;">Closest matches by the numbers — any sector. Name a company to match, or describe a screen.</p>
              <input class="input" id="ai-screen-q" maxlength="500" placeholder="A company to match — or a screen in plain words…" style="width:100%;">
              <p class="small muted" style="margin:12px 0 0;">Try:</p>
              <p style="margin:6px 0 0;">${AI_EXAMPLES.map((x) => `<button type="button" class="chip" data-ai-example="${esc(x)}">${esc(x)}</button>`).join(' ')}</p>
              <p class="small faint" style="margin:12px 0 0;">Runs a real screen over the filed fundamentals — spends one Ask.</p>`,
            actions: [
                { label: 'Run it', primary: true, onClick: () => {
                    const q = (m.el.querySelector('#ai-screen-q').value || '').trim();
                    if (!q) return;
                    ask(q);
                } },
                { label: 'Cancel' }
            ]
        });
        m.el.querySelectorAll('[data-ai-example]').forEach((b) =>
            b.addEventListener('click', () => {
                const field = m.el.querySelector('#ai-screen-q');
                field.value = b.dataset.aiExample;
                field.focus();
            }));
        const field = m.el.querySelector('#ai-screen-q');
        field.focus();
        field.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); m.el.querySelector('.v2-modal-btn-primary').click(); } });
    });
    if (!(window.V2 && V2.askFloor)) $('ai-screen-btn').style.display = 'none';

    document.querySelectorAll('#presets .chip[data-preset]').forEach((b) =>
        b.addEventListener('click', () => {
            document.querySelectorAll('#presets .chip[data-preset]').forEach((x) => x.classList.remove('chip-accent'));
            if (b.dataset.preset !== 'clear') b.classList.add('chip-accent');
            clearAiScreen();
            setFilters(PRESETS[b.dataset.preset] || {});
            run();
        }));
    $('run-btn').addEventListener('click', run);
    ['f-sector', 'f-mcap'].forEach((id) => $(id).addEventListener('change', () => { clearAiScreen(); run(); }));
    // typing applies live — no hunting for the Run button; a manual edit also
    // releases the active preset highlight (you're off-script now) and leaves
    // any adopted AI screen behind
    let debounce = null;
    document.querySelectorAll('.card input').forEach((i) => {
        i.addEventListener('keydown', (e) => { if (e.key === 'Enter') { clearTimeout(debounce); run(); } });
        i.addEventListener('input', () => {
            document.querySelectorAll('#presets .chip[data-preset]').forEach((x) => x.classList.remove('chip-accent'));
            clearAiScreen();
            clearTimeout(debounce);
            debounce = setTimeout(run, 450);
        });
    });

    run();
})();
