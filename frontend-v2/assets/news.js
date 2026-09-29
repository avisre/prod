// Markets page — market/strip, alpha/news, and alpha/movers.
(function () {
    'use strict';
    const { API, token, esc, fixed, sparkline, nav, footer, searchAssets } = window.V2;
    nav('news');
    footer();
    const $ = (id) => document.getElementById(id);

    const TAPE = [
        ['S&P 500 ETF · SPY', 'SPY'], ['Dow ETF · DIA', 'DIA'], ['Nasdaq 100 ETF · QQQ', 'QQQ'], ['Russell 2000 ETF · IWM', 'IWM'],
        ['VIX futures ETN · VXX', 'VXX'], ['Oil fund · USO', 'USO'], ['Gold ETF · GLD', 'GLD'], ['20+ yr Treasury ETF · TLT', 'TLT'], ['Bitcoin strategy ETF · BITO', 'BITO']
    ];
    const TOPICS = [
        ['all', 'All'], ['top_stories', 'Top stories'], ['financial_markets', 'Markets'],
        ['earnings', 'Earnings'], ['technology', 'Tech'], ['economy_macro', 'Macro'],
        ['economy_monetary', 'Monetary'], ['ipo', 'IPO'], ['mergers_and_acquisitions', 'M&A'],
        ['energy_transportation', 'Energy'], ['finance', 'Finance'], ['life_sciences', 'Life sciences'],
        ['real_estate', 'Real estate'], ['retail_wholesale', 'Retail']
    ];
    const ASSETS = [
        ['all', 'All', ''], ['stocks', 'Stocks', 'SPY,QQQ,DIA,IWM'], ['crypto', 'Crypto', 'BTC,ETH,COIN,MARA,RIOT'],
        ['forex', 'Forex', 'UUP,FXE,FXY,FXB,EWY'], ['bonds', 'Bonds', 'TLT,AGG,BND,IEF,LQD'],
        ['commodities', 'Commodities', 'GLD,USO,SLV,DBA,UNG'], ['etfs', 'ETFs', 'SPY,QQQ,VTI,VOO,SCHD'],
        ['sectors', 'Sectors', 'XLK,XLF,XLE,XLV,XLI,XLY,XLP']
    ];

    let topic = 'all';
    let assetTickers = '';
    let searchTickers = '';

    // ---------- ① tape ----------
    (async () => {
        try {
            const r = await fetch(`${API}/market/strip?symbols=${TAPE.map(([, s]) => s).join(',')}`);
            const data = await r.json();
            $('tape').innerHTML = TAPE.map(([label, sym]) => {
                const q = (data.quotes || {})[sym];
                if (!q) return '';
                const up = q.pct >= 0;
                const closeDate = q.date
                    ? new Date(`${q.date}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' })
                    : 'date unavailable';
                return `<a class="tape-item" href="/company.html?symbol=${sym}" style="color:inherit;">
                  <span class="label">${esc(label)}</span>
                  <b>$${fixed(q.value, 2)} USD</b>
                  <span class="small num ${up ? 'delta-pos' : 'delta-neg'}">${up ? '+' : ''}${fixed(q.pct, 2)}%</span>
                  <span class="small faint">Daily close · ${closeDate}</span>
                </a>`;
            }).join('');
        } catch (_) { $('tape').hidden = true; }
    })();

    // ---------- ② filters ----------
    function chipRow(el, items, onPick) {
        el.innerHTML = items.map(([k, label], i) =>
            `<button type="button" class="chip${i === 0 ? ' chip-accent' : ''}" data-k="${k}" aria-pressed="${i === 0}">${label}</button>`).join('');
        el.querySelectorAll('.chip').forEach((b) =>
            b.addEventListener('click', () => {
                el.querySelectorAll('.chip').forEach((x) => {
                    x.classList.toggle('chip-accent', x === b);
                    x.setAttribute('aria-pressed', String(x === b));
                });
                onPick(b.dataset.k);
            }));
    }
    chipRow($('topics-row'), TOPICS, (k) => { topic = k; loadNews(); });
    chipRow($('assets-row'), ASSETS, (k) => {
        const a = ASSETS.find(([key]) => key === k);
        assetTickers = a ? a[2] : '';
        if (k !== 'all') { searchTickers = ''; $('news-q').value = ''; $('news-q-active').textContent = ''; }
        loadNews();
    });

    (function wireSearch() {
        const input = $('news-q');
        const results = $('news-q-results');
        let suggestionState = { query: '', items: [] };
        let searchVersion = 0;
        const go = (sym) => {
            searchTickers = sym;
            $('news-q-active').textContent = sym ? `showing news for ${sym}` : '';
            results.hidden = true;
            loadNews();
        };
        input.addEventListener('input', async () => {
            const q = input.value.trim();
            const version = ++searchVersion;
            suggestionState = { query: q, items: [] };
            if (q.length < 1) { results.hidden = true; return; }
            // searchAssets, NOT the bundled companies() directory. That list is
            // SEC registrants, so it holds SPY and QQQ — both registered trusts —
            // but not SCHG, VOO, VTI or VTSAX, which are series of one trust.
            // Measured 2026-09-28: "SCHG" here gave an empty box and no message
            // while the header search found it. The ETFs chip on this very page
            // already sends VTI, VOO and SCHD to the same news endpoint.
            const items = (await searchAssets(q, { limit: 8 }))
                .filter((row) => /^[A-Z0-9.\-]{1,10}$/.test(String(row.symbol || '')));
            if (version !== searchVersion || input.value.trim() !== q) return;
            suggestionState = { query: q, items };
            if (!items.length) {
                // Say so. Hiding the box on no match is what made a fund look
                // like a broken search rather than a symbol we don't carry.
                results.innerHTML = `<div class="nav-search-empty">No ticker or fund matches “${esc(q)}”. Try SCHG, VOO or VXUS.</div>`;
                results.hidden = false;
                return;
            }
            results.innerHTML = items.map((c) =>
                `<a href="#" data-sym="${esc(c.symbol)}"><span class="sym">${esc(c.symbol)}</span><span class="nm">${esc(c.name)}${c.assetType && c.assetType !== 'stock' ? ` · ${esc(c.assetTypeLabel || c.assetType)}` : ''}</span></a>`).join('');
            results.hidden = false;
            results.querySelectorAll('a').forEach((a) =>
                a.addEventListener('click', (e) => { e.preventDefault(); input.value = a.dataset.sym; go(a.dataset.sym); }));
        });
        const resolveAndGo = async () => {
            const query = input.value.trim();
            if (!query) { go(''); return; }
            let items = suggestionState.query.toLowerCase() === query.toLowerCase() ? suggestionState.items : [];
            if (!items.length) {
                items = (await searchAssets(query, { limit: 8 }))
                    .filter((row) => /^[A-Z0-9.\-]{1,10}$/.test(String(row.symbol || '')));
            }
            if (input.value.trim() !== query) return;
            const chosen = items.find((row) => String(row.symbol || '').toUpperCase() === query.toUpperCase())
                || items.find((row) => String(row.name || '').trim().toLowerCase() === query.toLowerCase())
                || items[0];
            if (!chosen) {
                $('news-q-active').textContent = `No ticker or fund matches “${query}”.`;
                results.hidden = false;
                results.innerHTML = `<div class="nav-search-empty">No ticker or fund matches “${esc(query)}”. Try a ticker such as AAPL.</div>`;
                return;
            }
            input.value = chosen.symbol;
            go(String(chosen.symbol).toUpperCase());
        };
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); resolveAndGo(); }
            if (e.key === 'Escape') results.hidden = true;
        });
        $('news-go').addEventListener('click', resolveAndGo);
    })();

    // ---------- ③ news ----------
    const when = (t) => {
        const s = String(t || '');
        if (s.length < 13) return '';
        const d = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:00Z`);
        const mins = (Date.now() - d.getTime()) / 60000;
        if (mins < 60) return Math.max(1, Math.round(mins)) + 'm ago';
        if (mins < 60 * 24) return Math.round(mins / 60) + 'h ago';
        return d.toLocaleDateString('en-US', { day: 'numeric', month: 'short' });
    };
    const tickerLinks = (it, n) => (it.ticker_sentiment || [])
        .filter((s) => /^[A-Z.\-]{1,6}$/.test(String(s.ticker || '')))
        .slice(0, n)
        .map((s) => `<a href="/company.html?symbol=${s.ticker}">${s.ticker}</a>`).join('');
    const meta = (it, n) =>
        `<div class="news-meta"><span>${esc(it.source || '')}</span><span>${when(it.time_published)}</span>${tickerLinks(it, n)}</div>`;

    function renderFeatured(it) {
        const card = $('news-feature');
        if (!it) { card.hidden = true; return; }
        card.innerHTML =
            `<a href="${esc(it.url)}" target="_blank" rel="noopener">
               ${it.banner_image ? `<img class="feature-img" src="${esc(it.banner_image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
               <h2 class="feature-title">${esc(it.title)}</h2>
             </a>
             <p class="stream-sum">${esc((it.summary || '').slice(0, 260))}${(it.summary || '').length > 260 ? '…' : ''}</p>` +
            meta(it, 4);
        card.hidden = false;
    }
    function renderSecondary(items) {
        $('news-secondary').innerHTML = items.map((it) => `
          <article class="sec-card">
            <a href="${esc(it.url)}" target="_blank" rel="noopener">
              ${it.banner_image ? `<img class="sec-img" src="${esc(it.banner_image)}" alt="" loading="lazy" onerror="this.remove()">` : ''}
              <h3 class="sec-title">${esc(it.title)}</h3>
            </a>
            ${meta(it, 2)}
          </article>`).join('');
    }
    function renderLatest(items) {
        $('news-latest').innerHTML = items.map((it) => `
          <li>
            <h3><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a></h3>
            ${meta(it, 2)}
          </li>`).join('');
    }
    function renderStream(items) {
        $('news-stream').innerHTML = items.map((it) => `
          <article class="stream-item">
            ${it.banner_image
                ? `<img class="stream-img" src="${esc(it.banner_image)}" alt="" loading="lazy" onerror="this.remove()">`
                : '<span></span>'}
            <div>
              <h3><a href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.title)}</a></h3>
              <p class="stream-sum">${esc((it.summary || '').slice(0, 220))}${(it.summary || '').length > 220 ? '…' : ''}</p>
              ${meta(it, 3)}
            </div>
          </article>`).join('');
    }
    // weighted trending: relevance × |sentiment| per mention, summed per ticker
    function renderTrending(items) {
        const stats = new Map();
        for (const it of items) {
            for (const s of it.ticker_sentiment || []) {
                const tk = String(s.ticker || '');
                if (!/^[A-Z.\-]{1,6}$/.test(tk)) continue;
                const rel = Math.max(0, parseFloat(s.relevance_score) || 0);
                const sen = parseFloat(s.ticker_sentiment_score) || 0;
                const p = stats.get(tk) || { score: 0, mentions: 0, signed: 0 };
                p.score += rel * Math.abs(sen);
                p.mentions += 1;
                p.signed += rel * sen;
                stats.set(tk, p);
            }
        }
        const ranked = [...stats.entries()]
            .sort((a, b) => (b[1].score - a[1].score) || (b[1].mentions - a[1].mentions))
            .slice(0, 8);
        $('trending-list').innerHTML = ranked.length
            ? ranked.map(([tk, s]) => `
                <li>
                  <span class="tone-dot ${s.signed > 0.05 ? 'pos' : s.signed < -0.05 ? 'neg' : ''}"></span>
                  <a class="tk" href="/company.html?symbol=${tk}">${tk}</a>
                  <span class="vl muted small">${s.mentions} mention${s.mentions > 1 ? 's' : ''}</span>
                </li>`).join('')
            : '<li class="side-empty">No mentions yet.</li>';
    }

    let newsRequest = 0;
    function setAccessGate(paidRequired) {
        $('news-controls').hidden = true;
        $('news-signedout').hidden = false;
        const panel = $('news-signedout');
        panel.querySelector('h2').textContent = 'Market news is included with paid plans';
        panel.querySelector('p').textContent = 'Get company headlines, market movers, and trending tickers. Choose a plan to unlock the Markets feed.';
        panel.querySelector('.signedout-actions').innerHTML = paidRequired
            ? '<a class="btn btn-primary" href="/pricing">View plans</a>'
            : '<a class="btn btn-primary" href="/pricing">View plans</a><a rel="nofollow" class="btn btn-ghost" href="/login">Log in</a>';
        $('news-feature-col').hidden = true;
        $('news-latest-col').hidden = true;
        $('news-stream-col').hidden = true;
    }

    function clearResults() {
        $('news-feature').hidden = true;
        $('news-secondary').innerHTML = '';
        $('news-latest').innerHTML = '';
        $('news-stream').innerHTML = '';
        $('news-empty').hidden = true;
        $('news-error').hidden = true;
    }

    async function loadNews() {
        const request = ++newsRequest;
        const tickers = searchTickers || assetTickers;
        const empty = $('news-empty');
        empty.hidden = true;
        $('news-error').hidden = true;
        if (!token()) {
            clearResults();
            setAccessGate(false);
            ['trending-list'].forEach((id) => { $(id).innerHTML = '<li class="side-empty">Sign in to see trending.</li>'; });
            return;
        }
        $('news-controls').hidden = false;
        $('news-signedout').hidden = true;
        $('news-feature-col').hidden = false;
        $('news-latest-col').hidden = false;
        $('news-stream-col').hidden = false;
        clearResults();
        $('news-latest').innerHTML = '<li class="side-empty"><span class="loading-line"><span class="spin"></span>Loading…</span></li>';
        try {
            const q = new URLSearchParams({ limit: '60', sort: 'LATEST' });
            if (topic !== 'all') q.set('topics', topic);
            if (tickers) q.set('tickers', tickers);
            const r = await fetch(`${API}/alpha/news?${q}`, { headers: { Authorization: `Bearer ${token()}` } });
            if (request !== newsRequest) return;
            if (r.status === 401 || r.status === 402) {
                // Markets news + sentiment are a paid feature. Collapse the hollow
                // columns into the spanning panel (same as the signed-out path) so
                // the wide featured track isn't left as a void down the middle, and
                // show an upgrade prompt — not a transient "try again". The sidebar
                // movers show their own paid-plan gate.
                setAccessGate(true);
                $('trending-list').innerHTML = '<li class="side-empty">Included with paid plans — <a href="/pricing">view plans →</a>.</li>';
                return;
            }
            if (!r.ok) throw new Error('news ' + r.status);
            const data = await r.json();
            if (request !== newsRequest) return;
            const items = (data.feed || []).filter((it) => it && it.title && it.url);
            if (!items.length) {
                renderFeatured(null); renderSecondary([]); renderLatest([]); renderStream([]); renderTrending([]);
                empty.hidden = false;
                return;
            }
            renderFeatured(items[0]);
            renderSecondary(items.slice(1, 3));
            renderLatest(items.slice(3, 11));
            renderStream(items.slice(11));
            renderTrending(items);
        } catch (_) {
            if (request !== newsRequest) return;
            $('news-error').hidden = false;
            renderTrending([]); // don't leave the trending rail spinning on a real error
        }
    }

    // ---------- ④ movers ----------
    (async () => {
        const setMsg = (msg) => ['movers-gainers', 'movers-losers', 'movers-active'].forEach((id) => {
            $(id).innerHTML = `<li class="side-empty">${msg}</li>`;
        });
        if (!token()) { setMsg('Sign in to see movers.'); return; }
        try {
            const r = await fetch(`${API}/alpha/movers`, { headers: { Authorization: `Bearer ${token()}` } });
            if (!r.ok) { setMsg(r.status === 402 ? 'On the paid plans — <a href="/upgrade.html">upgrade →</a>.' : r.status === 401 ? 'Sign in to see movers.' : 'Movers unavailable right now.'); return; }
            const data = await r.json();
            const paint = (id, rows) => {
                $(id).innerHTML = (rows || []).slice(0, 6).map((row) => {
                    const tk = String(row.ticker || '').toUpperCase();
                    const price = parseFloat(row.price);
                    const pc = parseFloat(String(row.change_percentage || '').replace('%', ''));
                    return `<li>
                      <a class="tk" href="/company.html?symbol=${esc(tk)}">${esc(tk)}</a>
                      <span class="vl">${Number.isFinite(price) ? price.toFixed(2) : '—'}</span>
                      <span class="ch ${pc >= 0 ? 'delta-pos' : 'delta-neg'}">${Number.isFinite(pc) ? (pc > 0 ? '+' : '') + pc.toFixed(2) + '%' : '—'}</span>
                    </li>`;
                }).join('') || '<li class="side-empty">No data right now.</li>';
            };
            paint('movers-gainers', data.top_gainers);
            paint('movers-losers', data.top_losers);
            paint('movers-active', data.most_actively_traded);
        } catch (_) { setMsg('Movers unavailable right now.'); }
    })();

    // ---------- ⑤ recently viewed (written by company.js) ----------
    (function () {
        let recent = [];
        try { recent = JSON.parse(localStorage.getItem('v2_recent') || '[]'); } catch (_) { /* fresh */ }
        if (!recent.length) return;
        $('recent-viewed').innerHTML = recent.slice(0, 6).map((s) =>
            `<li><a class="tk" href="/company.html?symbol=${esc(s)}">${esc(s)}</a></li>`).join('');
    })();

    loadNews();
    $('news-retry').addEventListener('click', loadNews);
})();
