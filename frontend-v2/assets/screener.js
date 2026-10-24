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
    let trendAsOf = null; // the snapshot date when the screen used a price-trend filter

    const PRESETS = {
        compounders: { 'f-cagr': 8, 'f-margin': 12, 'f-roe': 15, 'f-fcf': true },
        cashmachines: { 'f-margin': 20, 'f-fcf': true, 'f-roe': 20 },
        hypergrowth: { 'f-cagr': 20 },
        dividends: { 'f-div': 2.5, 'f-fcf': true },
        value: { 'f-pe': 16, 'f-fcf': true, 'f-margin': 8 },
        earnings: { 'f-qtr': 25 },
        uptrend: { 'f-sma200': 'above', 'f-rsi': 50 },
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
        ['f-cagr', 'f-margin', 'f-roe', 'f-pe', 'f-div', 'f-qtr', 'f-rsi', 'f-sma200', 'f-cross', 'f-vol'].forEach((id) => { $(id).value = p[id] ?? ''; });
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
        set('minRsi14', $('f-rsi').value);
        set('sma200', $('f-sma200').value);
        set('goldenCrossWithinDays', $('f-cross').value);
        set('minVolumeRatio20', $('f-vol').value);
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
            trendAsOf = data.technicalsAsOf || null;
            $('result-count').textContent = `${data.matched} of ${data.universe} companies match` + (trendAsOf ? ` · price trend as of ${trendAsOf}` : '');
            const sel = $('f-sector');
            if (sel.options.length <= 1 && Array.isArray(data.sectors)) {
                data.sectors.forEach((s) => sel.insertAdjacentHTML('beforeend', `<option>${esc(s)}</option>`));
            }
            render(data.error);
            renderAiNote();
        } catch (_) {
            // A dead-looking error row is a dead end (D7) — make it the retry
            // control itself so recovery is one click in place.
            const body = $('results-body');
            body.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:40px;" class="faint">Couldn’t load the screen. <button type="button" class="btn btn-ghost btn-sm" id="screen-retry">Retry</button></td></tr>';
            body.querySelector('#screen-retry').addEventListener('click', run);
        }
    }

    function render(error) {
        $('th-rsi').hidden = !trendAsOf;
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
            $('results-body').innerHTML = `<tr><td colspan="10" style="text-align:center;padding:40px;" class="faint">${error ? esc(error.replace(/ For a 200-day.*$/, '')) : 'No companies match these filters — loosen one and run again.'}</td></tr>`;
            return;
        }
        const companyUrl = (sym) => `/company?symbol=${encodeURIComponent(sym)}`;
        // The company is a real link, so a right-click, middle-click or Ctrl/⌘-click
        // opens it in a new tab; the ↗ beside it does the same in one tap.
        $('results-body').innerHTML = sorted.map((r) => `
          <tr data-sym="${esc(r.symbol)}">
            <td class="row-head"><span class="sym-cell"><a class="sym-link" href="${esc(companyUrl(r.symbol))}"><strong>${esc(r.symbol)}</strong>&ensp;<span class="muted">${esc(r.name)}</span></a><a class="sym-newtab" href="${esc(companyUrl(r.symbol))}" target="_blank" rel="noopener" title="Open ${esc(r.symbol)} in a new tab" aria-label="Open ${esc(r.symbol)} in a new tab">↗</a></span></td>
            <td class="small muted" style="text-transform:capitalize;" data-label="Sector">${esc((r.sector || '').toLowerCase())}</td>
            <td data-label="Mkt cap">${r.marketCapB === null ? '—' : '$' + money(r.marketCapB * 1e9)}</td>
            <td data-label="P/E">${fixed(r.pe, 1)}</td>
            <td data-label="Rev CAGR 5y" class="${r.revCagr5Pct > 0 ? 'delta-pos' : r.revCagr5Pct < 0 ? 'delta-neg' : ''}">${pct(r.revCagr5Pct)}</td>
            <td data-label="Net margin">${pct(r.netMarginPct)}</td>
            <td data-label="ROE">${pct(r.roePct)}</td>
            <td data-label="Div yield">${r.divYieldPct === null ? '—' : pct(r.divYieldPct, 2)}</td>
            <td data-label="Qtr earn YoY" class="${r.qtrNetIncomeYoYPct > 0 ? 'delta-pos' : r.qtrNetIncomeYoYPct < 0 ? 'delta-neg' : ''}">${pct(r.qtrNetIncomeYoYPct, 0)}</td>
            <td data-label="Profit yrs">${r.profitableYears10 ?? '—'}/10</td>${trendAsOf ? `
            <td data-label="RSI 14">${fixed(r.rsi14, 0)}</td>` : ''}
          </tr>`).join('');
        document.querySelectorAll('#results-body tr[data-sym]').forEach((tr) => {
            const url = companyUrl(tr.dataset.sym);
            tr.addEventListener('click', (e) => {
                if (e.target.closest('a')) return; // the links open themselves
                if (e.metaKey || e.ctrlKey) window.open(url, '_blank', 'noopener');
                else location.href = url;
            });
            // a middle-click anywhere on the row opens a new tab, as on the name
            tr.addEventListener('auxclick', (e) => {
                if (e.button === 1 && !e.target.closest('a')) window.open(url, '_blank', 'noopener');
            });
        });
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
    const FILTER_IDS = ['f-cagr', 'f-margin', 'f-roe', 'f-pe', 'f-div', 'f-mcap', 'f-qtr', 'f-rsi', 'f-sma200', 'f-cross', 'f-vol'];
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
    // ---- saved screens on the account (signed in) ----
    // Signed in, screens are kept on the account (/api/screens) so they follow
    // the user across browsers and so Ask can save one. A screen there is a set
    // of screen criteria, the same shape an adopted AI screen has. Signed out,
    // the localStorage screens above are all there is.
    const FILTER_TO_CRITERIA = [['f-cagr', 'min_revenue_cagr_5y_pct'], ['f-margin', 'min_net_margin_pct'], ['f-roe', 'min_roe_pct'], ['f-pe', 'max_pe'], ['f-div', 'min_dividend_yield_pct'], ['f-qtr', 'min_latest_qtr_earnings_growth_yoy_pct'], ['f-rsi', 'min_rsi14'], ['f-cross', 'golden_cross_within_days'], ['f-vol', 'min_volume_ratio_20']];
    let accountScreens = [];
    const signedIn = () => !!(window.V2 && V2.token && V2.token());
    const authHeaders = () => ({ 'Content-Type': 'application/json', Authorization: 'Bearer ' + V2.token() });
    function criteriaFromFilters(f) {
        const c = {};
        FILTER_TO_CRITERIA.forEach(([id, key]) => { if (f[id] !== undefined && f[id] !== '' && !Number.isNaN(Number(f[id]))) c[key] = Number(f[id]); });
        if (f['f-fcf']) c.require_positive_fcf = true;
        if (f['f-sma200']) c.sma200_position = f['f-sma200'];
        if (f['f-sector']) c.sector = f['f-sector'];
        const mv = f['f-mcap'];
        const band = (mv !== undefined && mv !== '') ? BANDS[Number.isNaN(Number(mv)) ? mv : bandFor(Number(mv))] : null;
        if (band) {
            if (band.min !== undefined) c.min_market_cap_billions = band.min;
            if (band.max !== undefined) c.max_market_cap_billions = band.max;
        }
        return c;
    }
    async function saveToAccount(name, criteria) {
        const r = await fetch('/api/screens', { method: 'POST', headers: authHeaders(), credentials: 'same-origin', body: JSON.stringify({ name, criteria }) });
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.message || 'Could not save the screen.');
        return data.screen;
    }
    async function loadAccountScreens() {
        if (!signedIn()) return;
        try {
            // Screens saved in this browser before accounts held them move up once.
            const local = savedScreens();
            if (local.length) {
                let moved = 0;
                for (const s of local) {
                    const criteria = criteriaFromFilters(s.filters || {});
                    if (!Object.keys(criteria).length) { moved += 1; continue; }
                    try { await saveToAccount(s.name, criteria); moved += 1; } catch (_) { /* keep it local and try again next visit */ }
                }
                if (moved === local.length) localStorage.removeItem(SAVED_KEY);
            }
            const r = await fetch('/api/screens', { headers: authHeaders(), credentials: 'same-origin' });
            if (r.ok) accountScreens = (await r.json()).screens || [];
        } catch (_) { /* the page works without saved screens */ }
        renderSaved();
    }

    function renderSaved() {
        const wrap = $('saved-screens');
        const account = accountScreens.map((s) =>
            `<button class="chip chip-accent" data-acct="${esc(s.id)}" title="Saved to your account">${esc(s.name)}&ensp;<span data-del-acct="${esc(s.id)}" aria-label="Delete ${esc(s.name)}" style="opacity:.6;">×</span></button>`).join('');
        wrap.innerHTML = account + savedScreens().map((s, i) =>
            `<button class="chip chip-accent" data-saved="${i}" title="Your saved screen">${esc(s.name)}&ensp;<span data-del-saved="${i}" aria-label="Delete ${esc(s.name)}" style="opacity:.6;">×</span></button>`).join('');
        wrap.querySelectorAll('[data-acct]').forEach((b) =>
            b.addEventListener('click', async (e) => {
                if (e.target.dataset.delAcct !== undefined) {
                    const id = e.target.dataset.delAcct;
                    try { await fetch('/api/screens/' + encodeURIComponent(id), { method: 'DELETE', headers: authHeaders(), credentials: 'same-origin' }); } catch (_) { /* shown again on reload if it failed */ }
                    accountScreens = accountScreens.filter((x) => x.id !== id);
                    renderSaved();
                    return;
                }
                const s = accountScreens.find((x) => x.id === b.dataset.acct);
                if (s) adoptAiScreen(s.criteria);
            }));
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
        // An adopted screen (from Ask, a link or a saved screen) can carry
        // criteria the filter boxes cannot show, so it is saved as it is.
        const criteria = aiCriteria && Object.keys(aiCriteria).length ? aiCriteria : criteriaFromFilters(f);
        if (!Object.keys(f).length && !Object.keys(criteria).length) return;
        const saveWith = (name) => {
            if (signedIn() && Object.keys(criteria).length) {
                saveToAccount(name, criteria)
                    .then((saved) => { accountScreens = [saved, ...accountScreens.filter((x) => x.id !== saved.id)]; renderSaved(); })
                    .catch((err) => { if (window.V2 && V2.modal) V2.modal({ label: 'Save screen', title: 'Could not save', bodyHtml: '<p>' + esc(err.message) + '</p>', actions: [{ label: 'OK', primary: true }] }); });
                return;
            }
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
    loadAccountScreens();

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

    // ---- Doppelganger: a company (or plain words) in, the table out ---------
    // The result lands in the same table every preset fills — never in a chat.
    // Naming a company is answered by the page's own screen endpoint, which
    // ranks the closest matches by the filed numbers. A screen described in
    // words needs one Ask to turn the words into criteria; the page reads that
    // run's screen_universe arguments off the stream and re-runs them through
    // ?criteria=, so the rows, the count and the export stay one code path.
    let aiCriteria = null;        // screen_universe args the page re-runs
    let aiSimilar = null;         // the result's similarTo block, for the note
    let aiStatus = null;          // { text, html } shown while a screen is built

    const AI_MAPPED_KEYS = new Set(['similar_to', 'min_revenue_cagr_5y_pct', 'min_net_margin_pct', 'min_roe_pct', 'max_pe', 'min_dividend_yield_pct', 'min_latest_qtr_earnings_growth_yoy_pct', 'require_positive_fcf', 'min_market_cap_billions', 'max_market_cap_billions', 'sector']);

    function clearAiScreen() {
        aiCriteria = null;
        aiSimilar = null;
        aiStatus = null;
        renderAiNote();
    }

    function renderAiNote() {
        const el = $('ai-note');
        $('ai-screen-btn').classList.toggle('chip-accent', !!(aiStatus || aiCriteria));
        const clearBtn = '<button type="button" class="chip" id="ai-clear" title="Back to plain filters">×</button>';
        if (aiStatus) {
            el.style.display = 'flex';
            el.innerHTML = aiStatus.html || '<span class="muted">' + esc(aiStatus.text) + '</span>';
            el.querySelectorAll('[data-ai-pick]').forEach((b) => b.addEventListener('click', () => adoptAiScreen({ similar_to: b.dataset.aiPick })));
            return;
        }
        if (aiSimilar) {
            const f = aiSimilar.factors || {};
            const bits = [];
            if (f.revCagr5Pct !== null && f.revCagr5Pct !== undefined) bits.push('rev CAGR ' + pct(f.revCagr5Pct));
            if (f.netMarginPct !== null && f.netMarginPct !== undefined) bits.push('net margin ' + pct(f.netMarginPct));
            const floor = (aiCriteria && aiCriteria.min_market_cap_billions) ? '' : ' · $2B+ market cap';
            el.style.display = 'flex';
            el.innerHTML = '<span class="muted">Ranked by resemblance to <strong>' + esc(aiSimilar.symbol) + '</strong>' + (bits.length ? ' — ' + esc(bits.join(', ')) : '') + esc(floor) + '; ' + esc(aiSimilar.symbol) + ' excluded.</span>' + clearBtn;
            $('ai-clear').addEventListener('click', () => { clearAiScreen(); run(); });
            return;
        }
        if (aiCriteria) {
            // limit and sort_by belong to the page, and the server drops them anyway.
            const extra = Object.keys(aiCriteria).filter((k) => !AI_MAPPED_KEYS.has(k) && k !== 'limit' && k !== 'sort_by');
            el.style.display = 'flex';
            el.innerHTML = '<span class="muted">Doppelganger screen applied' + (extra.length ? ' — also ' + esc(extra.map((k) => k.replace(/_/g, ' ')).join(', ')) : '') + '.</span>' + clearBtn;
            $('ai-clear').addEventListener('click', () => { clearAiScreen(); run(); });
            return;
        }
        el.style.display = 'none';
        el.innerHTML = '';
    }

    function syncFiltersTo(a) {
        [['f-cagr', 'min_revenue_cagr_5y_pct'], ['f-margin', 'min_net_margin_pct'], ['f-roe', 'min_roe_pct'], ['f-pe', 'max_pe'], ['f-div', 'min_dividend_yield_pct'], ['f-qtr', 'min_latest_qtr_earnings_growth_yoy_pct'], ['f-rsi', 'min_rsi14'], ['f-cross', 'golden_cross_within_days'], ['f-vol', 'min_volume_ratio_20']]
            .forEach(([id, key]) => { $(id).value = (a[key] === undefined || a[key] === null) ? '' : a[key]; });
        $('f-fcf').checked = a.require_positive_fcf === true;
        $('f-sma200').value = a.sma200_position === 'above' || a.sma200_position === 'below' ? a.sma200_position : '';
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

    function adoptAiScreen(args) {
        aiCriteria = args;
        aiStatus = null;
        document.querySelectorAll('#presets .chip[data-preset]').forEach((x) => x.classList.remove('chip-accent'));
        syncFiltersTo(aiCriteria);
        return run();
    }

    function aiMessage(text, html) {
        aiStatus = { text, html };
        renderAiNote();
    }
    const dismissible = (text) => '<span class="muted">' + text + '</span><button type="button" class="chip" id="ai-dismiss" title="Dismiss">×</button>';
    function aiFail(text) {
        aiMessage(null, dismissible(text));
        const x = $('ai-dismiss');
        if (x) x.addEventListener('click', () => { aiStatus = null; renderAiNote(); });
    }
    function tableBusy(text) {
        $('results-body').innerHTML = '<tr><td colspan="10" style="text-align:center;padding:40px;" class="faint">' + esc(text) + '</td></tr>';
    }

    // A screen described in words: one Ask turns it into criteria. Only the
    // screen_universe arguments are read from the stream — the written answer
    // is never shown, because the table is the answer here.
    async function screenFromWords(q) {
        const headers = { 'Content-Type': 'application/json' };
        if (window.V2 && V2.token && V2.token()) headers.Authorization = 'Bearer ' + V2.token();
        let r;
        try {
            r = await fetch('/api/ai/chat', { method: 'POST', headers, credentials: 'same-origin',
                body: JSON.stringify({ question: 'Run a stock screen for: ' + q, history: [], stream: true, mode: 'normal' }) });
        } catch (_) { return null; }
        if (r.status === 401 || r.status === 402 || r.status === 429) return { denied: true };
        if (!r.ok || !r.body || !/event-stream/.test(r.headers.get('content-type') || '')) return { denied: r.ok };
        const reader = r.body.getReader();
        const dec = new TextDecoder();
        let buf = '', args = null;
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buf += dec.decode(value, { stream: true });
            let cut;
            while ((cut = buf.indexOf('\n\n')) >= 0) {
                const frame = buf.slice(0, cut); buf = buf.slice(cut + 2);
                const ev = (frame.match(/^event: (.*)$/m) || [])[1];
                const data = (frame.match(/^data: (.*)$/m) || [])[1];
                if (ev !== 'tool' || !data) continue;
                try {
                    const d = JSON.parse(data);
                    if (d.tool === 'screen_universe' && d.args && Object.keys(d.args).length) args = d.args;
                } catch (_) { /* a malformed frame is not a screen */ }
            }
        }
        return { args };
    }

    async function runDoppelganger(q) {
        const named = /\b(?:like|similar to|resembl\w*|lookalikes? (?:of|for)|doppelg[aä]ngers? (?:of|for))\s+/i.test(q);
        const company = q.replace(/^.*?\b(?:like|similar to|resembl\w*|lookalikes? (?:of|for)|doppelg[aä]ngers? (?:of|for))\s+/i, '').replace(/[?.!]+$/, '').trim() || q;
        aiCriteria = null; aiSimilar = null;
        aiMessage('Finding the closest matches to ' + company + '…');
        tableBusy('Running the screen…');
        let probe = null;
        try {
            probe = await (await fetch('/api/screener?' + new URLSearchParams({ criteria: JSON.stringify({ similar_to: company }), limit: 1 }))).json();
        } catch (_) { /* fall through to the words path */ }
        if (probe && probe.similarTo && probe.similarTo.symbol) return adoptAiScreen({ similar_to: probe.similarTo.symbol });
        if (probe && Array.isArray(probe.candidates) && probe.candidates.length) {
            aiMessage(null, '<span class="muted">Several companies match — pick one:</span>' + probe.candidates.map((c) =>
                '<button type="button" class="chip" data-ai-pick="' + esc(c.symbol) + '">' + esc(c.symbol) + '&ensp;<span class="muted">' + esc(c.name) + '</span></button>').join(''));
            return run();
        }
        if (named) { aiFail('No US-listed company with filed fundamentals matches “' + esc(company) + '”.'); return run(); }
        aiMessage('Turning that into a screen…');
        const built = await screenFromWords(q);
        if (built && built.args) return adoptAiScreen(built.args);
        if (built && built.denied) aiFail('Describing a screen in words uses Ask — <a href="/login.html?next=/screener.html">sign in</a>, or name a company to match instead.');
        else aiFail('Couldn’t turn that into a screen. Name a company to match, or use the filters below.');
        return run();
    }

    const AI_EXAMPLES = ['Companies like AppLovin', 'High-margin growers under 30× earnings', 'Cash machines with steady dividends'];
    $('ai-screen-btn').addEventListener('click', () => {
        if (!(window.V2 && V2.modal)) return;
        const m = V2.modal({
            label: 'Doppelganger',
            title: "Find a stock's doppelganger",
            bodyHtml: '<p class="small muted" style="margin:0 0 10px;">Closest matches by the numbers — any sector. Name a company to match, or describe a screen.</p>' +
              '<input class="input" id="ai-screen-q" maxlength="500" placeholder="A company to match — or a screen in plain words…" style="width:100%;">' +
              '<p class="small muted" style="margin:12px 0 0;">Try:</p>' +
              '<p style="margin:6px 0 0;">' + AI_EXAMPLES.map((x) => '<button type="button" class="chip" data-ai-example="' + esc(x) + '">' + esc(x) + '</button>').join(' ') + '</p>' +
              '<p class="small faint" style="margin:12px 0 0;">Results appear in the table below. Matching a company is instant; a screen described in words spends one Ask.</p>',
            actions: [
                { label: 'Run it', primary: true, onClick: (close) => {
                    const q = (m.el.querySelector('#ai-screen-q').value || '').trim();
                    if (!q) return;
                    close();
                    runDoppelganger(q);
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
    if (!(window.V2 && V2.modal)) $('ai-screen-btn').style.display = 'none';

    document.querySelectorAll('#presets .chip[data-preset]').forEach((b) =>
        b.addEventListener('click', () => {
            document.querySelectorAll('#presets .chip[data-preset]').forEach((x) => x.classList.remove('chip-accent'));
            if (b.dataset.preset !== 'clear') b.classList.add('chip-accent');
            clearAiScreen();
            setFilters(PRESETS[b.dataset.preset] || {});
            run();
        }));
    $('run-btn').addEventListener('click', run);
    ['f-sector', 'f-mcap', 'f-sma200', 'f-cross'].forEach((id) => $(id).addEventListener('change', () => { clearAiScreen(); run(); }));
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

    // A screen can arrive in the address: ?criteria=<json> (the "Open in
    // Screener" link under an Ask answer) or ?screen=<id> (a screen saved to the
    // account). Either way it is adopted like any AI screen, and the server
    // whitelists every key when the page re-runs it.
    (async () => {
        const params = new URLSearchParams(location.search);
        let linked = null;
        if (params.get('criteria')) {
            try { const c = JSON.parse(params.get('criteria')); if (c && typeof c === 'object' && !Array.isArray(c) && Object.keys(c).length) linked = c; } catch (_) { /* not a screen */ }
        } else if (params.get('screen') && signedIn()) {
            try {
                const r = await fetch('/api/screens/' + encodeURIComponent(params.get('screen')), { headers: authHeaders(), credentials: 'same-origin' });
                if (r.ok) linked = ((await r.json()).screen || {}).criteria || null;
            } catch (_) { /* fall through to the default screen */ }
        }
        if (linked) adoptAiScreen(linked); else run();
    })();
})();
