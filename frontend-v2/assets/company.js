// Company page — the Ive cut. Three ideas in reading order:
//   ① the instrument (masthead: name, price, dual-axis chart),
//   ② the verdict (one machine-made checks band, labeled),
//   ③ the record (peers → statements+growth → ratios ║ check detail →
//      ownership → documents).
// Synthesized intelligence (segments, AI summary) lives in the right-edge
// Insights drawer; Ask is the page's voice — a bar pinned to the floor.
(function () {
    'use strict';
    const { API, token, trackActivation, num, money, pct, fixed, esc, sparkline, chart, markdown, nav, footer, mountAskFloor, companies, mountShare, upgradeStrip } = window.V2;

    const params = new URLSearchParams(location.search);
    const symbol = (params.get('symbol') || 'AAPL').toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
    if (document.referrer && /\/screener(?:\.html)?(?:[/?#]|$)/i.test(document.referrer)) trackActivation('screener_company');
    document.title = `${symbol} — financials | stockportfolio.pro`;
    // The server names the asset type when it knows it (app.js, /company route):
    // a company needs only its fundamentals and a fund only its profile, so neither
    // waits on the other. Without the tag the page asks for the profile first.
    const assetTypeHint = document.querySelector('meta[name="sp-asset-type"]')?.content || '';
    const FUND_TYPES = ['etf', 'mutual_fund', 'closed_end_fund'];
    // Ask for the statements straight away. The page used to wait about a second
    // for the asset profile before even sending this, the slowest request it makes.
    const earlyFundamentals = FUND_TYPES.includes(assetTypeHint) ? null : fetch(`/api/demo/alpha/fundamentals/${encodeURIComponent(symbol)}?presentationCurrency=USD`).catch(() => null);
    nav('company');
    footer();
    try { // recently-viewed trail for the Markets sidebar
        const recent = JSON.parse(localStorage.getItem('v2_recent') || '[]').filter((s) => s !== symbol);
        recent.unshift(symbol);
        localStorage.setItem('v2_recent', JSON.stringify(recent.slice(0, 10)));
    } catch (_) { /* private mode */ }

    const $ = (id) => document.getElementById(id);

    function currencyCode(value, fallback = 'USD') {
        const code = String(value || fallback).trim().toUpperCase();
        return /^[A-Z]{3}$/.test(code) ? code : fallback;
    }
    function currencyAmount(value, currency, { compact = true, decimals = 2 } = {}) {
        const n = num(value);
        if (n === null) return '—';
        const code = currencyCode(currency);
        const body = compact ? money(n) : fixed(n, decimals);
        // Keep the familiar dollar mark for USD. ISO codes are deliberate for
        // every other currency: ¥ is ambiguous between JPY and CNY, and a bare
        // number previously made foreign quotes look like dollars.
        return code === 'USD' ? `$${body}` : `${body}\u00a0${code}`;
    }
    function currencyRange(low, high, currency) {
        const lo = num(low); const hi = num(high);
        if (lo === null || hi === null) return '—';
        const code = currencyCode(currency);
        const values = `${fixed(lo, 0)}–${fixed(hi, 0)}`;
        return code === 'USD' ? `$${values}` : `${values}\u00a0${code}`;
    }

    function fundPct(value, dp = 2) {
        const n = num(value);
        return n === null ? '—' : `${(n * 100).toFixed(dp)}%`;
    }
    // Two decimals is wrong for the one number people choose funds on. FXAIX
    // files 0.015% and rendered as "0.01%"; FZROX files 0.00% and every cheap
    // index fund collapsed toward the same figure. Precision follows magnitude,
    // and trailing zeros are trimmed so 0.03% does not become "0.030%".
    function feePct(value) {
        const n = num(value);
        if (n === null) return '—';
        const p = n * 100;
        if (p === 0) return '0.00%';
        const dp = p >= 1 ? 2 : p >= 0.01 ? 3 : 4;
        return `${p.toFixed(dp).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '')}%`;
    }
    function renderFundProfile(data) {
        const p = data.profile || {};
        const section = $('fund-section');
        // The company research sections remain in the DOM and untouched; they
        // are simply not applicable to pooled funds and are hidden for this view.
        [...section.parentElement.children].forEach((node) => {
            if (node !== section && !node.classList.contains('mast')) node.hidden = true;
        });
        section.hidden = false;
        $('co-name').textContent = p.name || symbol;
        // A mutual fund is not traded on an exchange. Yahoo reports a listing
        // venue for one anyway (FXAIX: "Nasdaq"), but you cannot buy it there —
        // an order fills at the next NAV strike. Printing a venue beside a price
        // implies intraday trading that does not exist, so a fund is identified
        // by the house that runs it instead.
        const isMutualFund = p.assetType === 'mutual_fund';
        const venue = isMutualFund ? p.fundFamily : p.exchange;
        $('co-crumb').textContent = [symbol, p.assetTypeLabel, p.category, venue].filter(Boolean).join(' · ');
        $('co-price').textContent = currencyAmount(p.price, p.currency, { compact: false });
        // ...and "today" was a lie on both kinds. A mutual fund strikes one NAV a
        // day, so its price is ALWAYS at least a session old — FXAIX was showing
        // a 5 September move as today's on the 7th. An ETF is no better over a
        // weekend. Name the day unless the quote really is from today.
        const priceDay = String(p.asOf || '').slice(0, 10);
        const isToday = !!priceDay && priceDay === new Date().toISOString().slice(0, 10);
        const when = isMutualFund
            ? (isToday ? "at today's NAV" : (priceDay ? `at the ${formatAsOf(priceDay)} NAV` : 'at the last NAV'))
            : (isToday ? 'today' : (priceDay ? `on ${formatAsOf(priceDay)}` : ''));
        $('co-change').textContent = p.changePercent === null ? '—'
            : `${p.changePercent >= 0 ? '+' : ''}${fixed(p.changePercent, 2)}% ${when}`.trim();
        $('co-change').className = `small num ${p.changePercent >= 0 ? 'delta-pos' : 'delta-neg'}`;
        // The expense ratio carries its provenance because the two sources are
        // not equally trustworthy: the filed prospectus fee table is exact,
        // while the provider figure has been measured wrong by as much as 60x
        // on cheap index funds. A fund with neither shows nothing.
        const expenseNote = (profile) => {
            if (profile.expenseRatio === null || profile.expenseRatio === undefined) return 'No filed figure available';
            if (!profile.expenseRatioSource) return '';
            return /^SEC/.test(profile.expenseRatioSource)
                ? `As filed ${profile.expenseRatioAsOf || ''}`.trim()
                : 'Provider figure';
        };
        const stats = [
            ['Net assets', currencyAmount(p.totalAssets, p.currency)],
            ['Expense ratio', feePct(p.expenseRatio), 'fund-expense'], ['Yield', fundPct(p.yield)],
            ['YTD return', fundPct(p.ytdReturn)], ['3-year return', fundPct(p.returns && p.returns.threeYear)],
            ['5-year return', fundPct(p.returns && p.returns.fiveYear)],
            ['3-year beta', p.beta3Year === null ? '—' : fixed(p.beta3Year, 2)],
            ['Turnover', fundPct(p.turnover)]
        ];
        const allocation = [
            ['Stocks', p.allocations && p.allocations.stock], ['Bonds', p.allocations && p.allocations.bond],
            ['Cash', p.allocations && p.allocations.cash], ['Other', p.allocations && p.allocations.other]
        ].filter((row) => num(row[1]) !== null);
        const bars = (rows) => rows.map(([name, weight]) => `<div class="fund-bar"><span>${esc(name)}</span><span class="fund-bar-track"><span class="fund-bar-fill" style="display:block;width:${Math.max(0, Math.min(100, Number(weight) * 100))}%"></span></span><span class="num">${fundPct(weight, 1)}</span></div>`).join('');
        // Name, not ticker. Form N-PORT identifies holdings by CUSIP/ISIN and
        // carries no exchange symbol, so the ticker column could only ever be
        // filled from the ten rows Yahoo returns — 8 of VOO's 520, measured —
        // and the other 512 were a sticky, bold, empty column sitting in front
        // of the name you were actually reading. The name is the row head now.
        const holdingRow = (h) => `<tr><td class="row-head">${esc(h.name)}</td><td class="num">${fundPct(h.weight, 2)}</td></tr>`;
        const holdings = (p.topHoldings || []).map(holdingRow).join('');
        const sectors = (p.allocations && p.allocations.sectors || []).map((s) => [s.name, s.weight]);
        // A bond fund has no sectors, so its left column collapsed to four
        // allocation bars and left a tall gap beside the holdings pane. The
        // filling for it was already in the payload and simply never rendered:
        // credit quality is to a bond fund what sector exposure is to an equity
        // one, and BND reports six rating buckets.
        // ...but the provider's buckets are NOT a partition: BND's sum to 151.8%
        // because a US Treasury is counted both as "US Government" and as its
        // letter grade. Drawn as competing bars they would imply a breakdown
        // that does not exist. The letter grades alone DO partition (99.8%), so
        // they carry the bars and the government share is stated as the
        // cross-cutting figure it actually is.
        const allRatings = (p.allocations && p.allocations.bondRatings || []);
        const govRating = allRatings.find((r) => /government/i.test(r.name));
        const bondRatings = allRatings.filter((r) => r !== govRating).map((r) => [r.name, r.weight]);
        // Price history at four ranges, the same segmented control the equity
        // chart uses. A month needs the daily series — monthly closes give one
        // point — so 1M reads `daily` and everything longer reads `monthly`.
        const monthly = (data.monthly && data.monthly['Monthly Adjusted Time Series']) || {};
        const daily = (data.daily && data.daily['Time Series (Daily)']) || {};
        const seriesFor = (months) => {
            const src = months <= 1 ? daily : monthly;
            const keys = Object.keys(src).sort();
            const take = months <= 1 ? 23 : (months >= 999 ? keys.length : months);
            return keys.slice(-take)
                .map((d) => [d, num(src[d]['5. adjusted close'] || src[d]['4. close'])])
                .filter((row) => row[1] !== null);
        };
        const RANGES = [['1M', 1], ['1Y', 12], ['5Y', 60], ['Max', 999]];
        // Time labels in the equity chart's convention: a period name written
        // ONCE, at the point where the period turns over, rather than a raw
        // "2021-11" stamped on every Nth index. The period itself follows the
        // range — days inside a month, months inside a year, years beyond that —
        // because a year label deduped across a one-year window is a single tick.
        const axisLabels = (rows, months) => {
            const raw = rows.map((r) => {
                if (months <= 1) return new Date(`${r[0]}T12:00`).toLocaleString('en-US', { day: 'numeric', month: 'short' });
                if (months <= 12) return new Date(`${r[0].slice(0, 7)}-15`).toLocaleString('en-US', { month: 'short' });
                return r[0].slice(0, 4);
            });
            let seen = '';
            return raw.map((value) => { if (value === seen) return ''; seen = value; return value; });
        };
        const drawChart = (months) => {
            // a phone gets a squarer drawing; the wide one shrinks to an unreadable strip
            const phone = !!(window.matchMedia && window.matchMedia('(max-width: 640px)').matches);
            const rows = seriesFor(months);
            if (rows.length < 2) return '<p class="muted">Not enough price history for this range.</p>';
            return chart([{ values: rows.map((r) => r[1]), cls: 'accent' }],
                axisLabels(rows, months),
                { fmt: (v) => currencyAmount(v, p.currency, { compact: false, decimals: 0 }), height: phone ? 280 : 300, width: phone ? 420 : 1180, area: true, fullWidth: true, strokeWidth: 2.2, axisFmt: (v) => currencyAmount(v, p.currency, { compact: false, decimals: 0 }) });
        };
        const points = seriesFor(999);
        const chartHtml = points.length > 1 ? drawChart(60) : '';
        section.innerHTML = `
          <div class="section-head"><div><span class="label">${esc(p.assetTypeLabel || 'Fund')} research</span><h2 class="title-2" style="margin-top:5px;">Costs, composition and performance</h2></div><span class="small faint">${esc(p.fundFamily || '')}</span></div>
          <div class="fund-grid">${stats.map(([k, v, id]) => `<div class="fund-stat"><div class="k">${esc(k)}</div><div class="v"${id ? ` id="${id}"` : ''}>${esc(v)}</div>${id === 'fund-expense' ? `<div class="small faint" id="fund-expense-note" style="margin-top:3px;">${esc(expenseNote(p))}</div>` : ''}</div>`).join('')}</div>
          ${chartHtml ? `<div style="margin-top:28px;">
            <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;">
              <p class="label" style="margin:0;" id="fund-chart-label">Adjusted price · last 5 years</p>
              <div class="seg" id="fund-seg-range" role="group" aria-label="Chart range">
                ${RANGES.map(([name, months]) => `<button type="button" aria-pressed="${months === 60}" data-m="${months}">${name}</button>`).join('')}
              </div>
            </div>
            <div id="fund-chart">${chartHtml}</div>
          </div>` : ''}
          <div class="fund-cols">
            <div id="fund-left"><h3 class="title-3">Asset allocation</h3>${bars(allocation)}${sectors.length ? `<h3 class="title-3" style="margin-top:24px;">Sector exposure</h3>${bars(sectors.slice(0, 12))}` : ''}${bondRatings.length ? `<h3 class="title-3" style="margin-top:24px;">Credit quality</h3>${bars(bondRatings.slice(0, 12))}<p class="small faint" style="margin-top:8px;">Share of the bond holdings by issuer credit rating.${govRating ? ` Separately, ${fundPct(govRating.weight, 1)} is US government issued — that cuts across the ratings above rather than adding to them.` : ''}</p>` : ''}</div>
            <div id="fund-holdings" class="fund-holdings">
              <div id="fund-holdings-head">
                <h3 class="title-3" id="fund-holdings-title">Top holdings</h3>
                <p class="small faint" id="fund-holdings-meta" hidden></p>
              </div>
              <div class="table-wrap holdings-scroll" id="fund-holdings-table" data-hbar="off"${holdings ? '' : ' hidden'}><table class="table-data"><thead><tr><th>Holding</th><th>Weight</th></tr></thead><tbody id="fund-holdings-body">${holdings}</tbody></table></div>
              <p class="muted" id="fund-holdings-empty"${holdings ? ' hidden' : ''}>Holdings are not available from the data source for this fund.</p>
              <p class="small faint" id="fund-holdings-count" hidden style="margin-top:8px;"></p>
            </div>
          </div>
          <div class="card card-pad" style="margin-top:24px;" id="fund-ai-card">
            <div class="section-head"><div><span class="label">AI fund summary</span><h3 class="title-3" style="margin-top:5px;">Costs, composition, performance and risk</h3></div><button class="btn btn-primary btn-sm" id="fund-ai-btn" type="button">Generate summary</button></div>
            <div id="fund-ai-viz" hidden></div>
            <div class="prose" id="fund-ai-body" hidden></div>
            <div id="fund-ai-share"></div>
          </div>
          <p class="provenance" style="margin-top:24px;">Source: ${esc(p.source || 'market data provider')}. Price and net assets are shown in ${esc(currencyCode(p.currency))}. Fund holdings and characteristics can be reported on different dates. Returns are trailing provider figures; verify the prospectus before making a decision.</p>`;
        $('fund-ai-btn').addEventListener('click', async () => {
            const button = $('fund-ai-btn');
            const body = $('fund-ai-body');
            if (!token()) { location.href = `/login.html?next=${encodeURIComponent(location.pathname + location.search)}`; return; }
            button.disabled = true; button.textContent = 'Writing…';
            try {
                const r = await fetch(`${API}/stocks/${encodeURIComponent(symbol)}/ai-summary`, { headers: { Authorization: `Bearer ${token()}` } });
                const result = await r.json().catch(() => ({}));
                if (!r.ok) {
                    // A signed-out or expired session used to surface the raw
                    // "Invalid token" from the API, which tells a reader nothing
                    // and offers no way out. Send them somewhere useful instead.
                    body.innerHTML = r.status === 402
                        ? 'This summary is available on Pro. <a href="/upgrade.html">View plans →</a>'
                        : (r.status === 401 || r.status === 403)
                            ? `Your session has expired. <a href="/login.html?next=${encodeURIComponent(location.pathname + location.search)}">Sign in again →</a>`
                            : esc(result.message || 'Could not generate the summary.');
                    body.hidden = false; return;
                }
                renderFundViz(result.facts);
                body.innerHTML = markdown(result.summary || '');
                body.hidden = false;
                mountShare($('fund-ai-share'), { title: `${p.name || symbol} (${symbol}) fund research`, text: result.summary || '', url: location.href });
                button.hidden = true;
            } catch (_) {
                body.textContent = 'Network problem — please try again.'; body.hidden = false;
            } finally { button.disabled = false; if (!button.hidden) button.textContent = 'Try again'; }
        });
        // The summary used to be one grey paragraph restating the tiles above it.
        // These three panels answer the questions the numbers are FOR — what the
        // fee actually costs, how the returns compare with each other, and
        // whether "520 holdings" means the fund is really diversified — and the
        // prose then has something to explain rather than repeat.
        function renderFundViz(f) {
            const host = $('fund-ai-viz');
            if (!host || !f) return;
            const blocks = [];

            if (f.annualCostPer10k !== null && f.annualCostPer10k !== undefined) {
                const filed = /^SEC/.test(f.expenseRatioSource || '');
                blocks.push(`<div class="viz-block">
                  <p class="label">What the fee costs you</p>
                  <p class="viz-hero">${esc(money10k(f.annualCostPer10k))}<span class="viz-hero-unit"> a year per $10,000 invested</span></p>
                  <p class="small faint">${esc(f.expenseRatioPct)}% of assets, deducted from returns rather than billed${filed ? `, as filed ${esc(f.expenseRatioAsOf || '')}` : ''}.</p>
                </div>`);
            }

            const returns = [['YTD', f.ytdReturnPct], ['1 year', f.returnsPct && f.returnsPct.oneYear],
                ['3 years', f.returnsPct && f.returnsPct.threeYear], ['5 years', f.returnsPct && f.returnsPct.fiveYear],
                ['10 years', f.returnsPct && f.returnsPct.tenYear]].filter((row) => num(row[1]) !== null);
            if (returns.length) {
                // Bars are scaled to the largest magnitude in the set and share a
                // zero baseline, so a negative period reads as negative instead of
                // as a short positive bar.
                const peak = Math.max(...returns.map((row) => Math.abs(Number(row[1]))), 1);
                blocks.push(`<div class="viz-block">
                  <p class="label">Reported returns · annualised beyond one year</p>
                  ${returns.map(([name, value]) => {
                      const v = Number(value);
                      return `<div class="fund-bar"><span>${esc(name)}</span><span class="fund-bar-track"><span class="fund-bar-fill${v < 0 ? ' is-neg' : ''}" style="display:block;width:${(Math.abs(v) / peak * 100).toFixed(1)}%"></span></span><span class="num">${v >= 0 ? '+' : ''}${v.toFixed(2)}%</span></div>`;
                  }).join('')}
                  <p class="small faint">A record of what happened, not a forecast.</p>
                </div>`);
            }

            if (f.holdingCount && num(f.top10WeightPct) !== null) {
                const top = Number(f.top10WeightPct);
                const rest = Math.max(0, 100 - top);
                blocks.push(`<div class="viz-block">
                  <p class="label">How concentrated it is</p>
                  <div class="viz-split">
                    <span class="viz-split-a" style="width:${top.toFixed(1)}%"></span>
                    <span class="viz-split-b" style="width:${rest.toFixed(1)}%"></span>
                  </div>
                  <p class="small"><strong>${top.toFixed(1)}%</strong> in the 10 largest holdings · <strong>${rest.toFixed(1)}%</strong> spread across the other ${(f.holdingCount - 10).toLocaleString()}</p>
                  ${f.holdingsToHalfAssets ? `<p class="small faint">Half the fund sits in its ${f.holdingsToHalfAssets} largest positions.</p>` : ''}
                </div>`);
            }

            if (!blocks.length) return;
            host.innerHTML = `<div class="viz-grid">${blocks.join('')}</div>`;
            host.hidden = false;
        }

        function money10k(value) {
            return value >= 10 ? `$${Math.round(value).toLocaleString()}` : `$${Number(value).toFixed(2).replace(/\.00$/, '')}`;
        }

        const rangeButtons = document.querySelectorAll('#fund-seg-range button');
        rangeButtons.forEach((button) => button.addEventListener('click', () => {
            const months = Number(button.dataset.m);
            rangeButtons.forEach((other) => other.setAttribute('aria-pressed', other === button));
            $('fund-chart').innerHTML = drawChart(months);
            $('fund-chart-label').textContent = months <= 1
                ? 'Adjusted price · last month (daily)'
                : `Adjusted price · ${months >= 999 ? 'full history' : `last ${months / 12} years`}`;
            // Same fix as the equity chart: the badge was frozen at the
            // day-over-day change fetched once at load, so every range but
            // "today" showed a stale, unrelated figure. Recompute it from the
            // same series the chart just drew.
            const rows = seriesFor(months);
            const chEl = $('co-change');
            if (chEl && rows.length >= 2) {
                const first = rows[0][1];
                const last = rows[rows.length - 1][1];
                if (first !== null && last !== null && first !== 0) {
                    const rangePct = ((last - first) / first) * 100;
                    chEl.textContent = (rangePct >= 0 ? '+' : '') + rangePct.toFixed(2) + '% over ' + button.textContent;
                    chEl.className = 'small num ' + (rangePct >= 0 ? 'delta-pos' : 'delta-neg');
                }
            }
        }));

        // A cold prospectus lookup runs past the profile route's 2.5s budget, so
        // the number above can still be the provider's on a first visit. Asking
        // for it again here corrects the tile on this page load instead of
        // leaving it to the next one.
        (async () => {
            const cell = $('fund-expense'), note = $('fund-expense-note');
            if (!cell || /^SEC/.test(p.expenseRatioSource || '')) return;
            try {
                const r = await fetch(`${API}/assets/${encodeURIComponent(symbol)}/fees`);
                if (!r.ok) return;
                const filed = await r.json();
                if (!filed || filed.expenseRatio === null || filed.expenseRatio === undefined) return;
                cell.textContent = feePct(filed.expenseRatio);
                if (note) {
                    note.innerHTML = filed.sourceUrl
                        ? `As filed ${esc(filed.filedAt || '')} · <a href="${esc(filed.sourceUrl)}" target="_blank" rel="noopener nofollow">prospectus</a>`
                        : `As filed ${esc(filed.filedAt || '')}`;
                }
            } catch (_) { /* the tile keeps whatever the profile gave it */ }
        })();

        // The ten rows above are all Yahoo's topHoldings module ever returns —
        // for every fund, not just the big ones. The complete portfolio comes
        // from the fund's latest SEC Form N-PORT and replaces them in place as
        // soon as it arrives, so the page is useful immediately and correct a
        // moment later.
        //
        // It scrolls inside its own pane rather than growing the page to 520
        // rows (17,409 for BND), and the pane is sized to the allocation column
        // beside it so neither column ends in dead space. Rows load as the pane
        // is scrolled, so the payload stays small on the huge bond funds.
        (async () => {
            const PAGE = 250;
            const title = $('fund-holdings-title'), meta = $('fund-holdings-meta');
            const body = $('fund-holdings-body'), pane = $('fund-holdings-table');
            const empty = $('fund-holdings-empty'), footer = $('fund-holdings-count');
            if (!body || !pane) return;

            // Match the pane to the column beside it. Below the breakpoint the
            // grid is a single column, so there is nothing to line up with and
            // the CSS viewport cap takes over instead.
            const fitPane = () => {
                const left = $('fund-left'), head = $('fund-holdings-head');
                if (!left) return;
                if (window.matchMedia('(max-width: 700px)').matches) { pane.style.maxHeight = ''; return; }
                const available = left.getBoundingClientRect().height -
                    (head ? head.getBoundingClientRect().height : 0) - 30;
                pane.style.maxHeight = `${Math.max(320, Math.round(available))}px`;
            };
            fitPane();
            let resizeTimer = null;
            window.addEventListener('resize', () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(fitPane, 150); });

            const page = async (offset) => {
                const r = await fetch(`${API}/assets/${encodeURIComponent(symbol)}/holdings?limit=${PAGE}&offset=${offset}`);
                return r.ok ? r.json() : null;
            };
            let first = null;
            try { first = await page(0); } catch (_) { return; }
            if (!first || !Array.isArray(first.holdings) || !first.holdings.length) return;

            let total = Number(first.count) || first.holdings.length;
            let loaded = first.holdings.length;
            let loading = false;
            body.innerHTML = first.holdings.map(holdingRow).join('');
            pane.hidden = false; empty.hidden = true;
            title.textContent = first.complete ? `All ${total.toLocaleString()} holdings` : 'Top holdings';
            const filedNote = first.filedAt ? `, filed ${esc(first.filedAt)}` : '';
            const link = first.sourceUrl ? `<a href="${esc(first.sourceUrl)}" target="_blank" rel="noopener nofollow">Form N-PORT</a>` : 'Form N-PORT';
            meta.innerHTML = first.complete
                ? `Complete portfolio as reported on ${link} for ${esc(first.asOf || 'the latest reporting period')}${filedNote}. N-PORT becomes public around 60 days after the reporting date, so trades made since are not reflected.`
                : 'Largest positions reported by the data provider. This fund files no N-PORT, so a complete portfolio is not available.';
            meta.hidden = false;
            fitPane();

            const sync = () => {
                footer.hidden = false;
                footer.textContent = loaded >= total
                    ? `All ${total.toLocaleString()} holdings shown`
                    : `Showing ${loaded.toLocaleString()} of ${total.toLocaleString()} — scroll for more`;
            };
            const loadMore = async () => {
                if (loading || loaded >= total) return;
                loading = true;
                try {
                    const next = await page(loaded);
                    if (next && Array.isArray(next.holdings) && next.holdings.length) {
                        body.insertAdjacentHTML('beforeend', next.holdings.map(holdingRow).join(''));
                        loaded += next.holdings.length;
                    } else {
                        total = loaded; // upstream ran out earlier than the count promised
                    }
                } catch (_) { /* leave the footer as it was; scrolling retries */ }
                loading = false;
                sync();
                // A pane taller than the rows it holds never fires a scroll
                // event, so it would stall short of the full list.
                if (pane.scrollHeight <= pane.clientHeight && loaded < total) loadMore();
            };
            sync();
            pane.addEventListener('scroll', () => {
                if (pane.scrollTop + pane.clientHeight >= pane.scrollHeight - 240) loadMore();
            });
            if (pane.scrollHeight <= pane.clientHeight && loaded < total) loadMore();
        })();
        document.title = `${symbol} ${p.assetTypeLabel || 'fund'} — holdings, fees and returns | stockportfolio.pro`;
    }

    // ---------- shared math ----------
    const ratio = (a, b) => (a !== null && b !== null && b !== 0) ? a / b : null;
    const derive = (r) => {
        let rev = num(r.totalRevenue);
        let gp = num(r.grossProfit); if (gp === 0 && !r._sources?.grossProfit?.length) gp = null;
        let cor = num(r.costOfRevenue); if (cor === 0 && !r._sources?.costOfRevenue?.length) cor = null;
        // a filer that tags revenue under a line we do not read still files both halves of it
        if (rev === null && cor !== null && gp !== null) rev = cor + gp;
        if (rev !== null) {
            if (gp === null && cor !== null) gp = rev - cor;
            if (cor === null && gp !== null) cor = rev - gp;
        }
        return { rev, gp, cor };
    };
    const debtOf = (r) => {
        const combined=num(r.shortLongTermDebtTotal);if(combined!==null)return combined;
        if(r._sources)return null;
        const current=num(r.shortTermDebt),noncurrent=num(r.longTermDebt);
        return current!==null && noncurrent!==null ? current+noncurrent : null;
    };
    const fcfOf = (r) => {
        const ocf = num(r.operatingCashflow); const capex = num(r.capitalExpenditures);
        return (ocf !== null && capex !== null) ? ocf + capex : null;
    };
    // Banks and life insurers have no free cash flow (assets/industry-metrics.js):
    // every FCF row, tile, check and valuation is left out for them.
    const noFcf = (p = payload) => !!(window.IndustryMetrics && p && window.IndustryMetrics.hasNoFcf(p));
    // Free cash flow to set against the same year's revenue. Revenue leaves out a
    // business reported as discontinued; operating cash flow usually keeps it in
    // (AppLovin FY2024 read 65%), so such a year uses the continuing-operations
    // cash flow where filed and otherwise has no FCF margin.
    const fcfForRevenue = (inc, c) => {
        if (!num(inc.discontinuedOperations)) return fcfOf(c);
        return fcfOf({ operatingCashflow: c.operatingCashflowContinuing, capitalExpenditures: c.capitalExpenditures });
    };
    // Capital expenditure set against revenue follows the same rule: a year with a
    // discontinued business and no continuing-operations cash flow has no ratio.
    const cashMatchesRevenue = (inc, c) => !num(inc.discontinuedOperations) || num(c.operatingCashflowContinuing) !== null;
    function cagr(first, last, years) {
        if (first === null || last === null || first <= 0 || last <= 0 || years < 1.5) return null;
        return (Math.pow(last / first, 1 / years) - 1) * 100;
    }
    const pctFmt = (v) => v === null ? '—' : pct(v * 100);
    const signedPct = (v) => v === null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%';

    const cashEffect = (v) => { const n = num(v); return n === null || n === 0 ? n : -n; };
    const ROWS = {
        // Income-statement accordion order: the primary line appears first and
        // its supporting lines unfold DIRECTLY BELOW it.
        income: [
            { label: 'Revenue', get: (r) => derive(r).rev, fmt: money, kind: 'money', solo: true },
            { label: 'Cost of revenue', get: (r) => derive(r).cor, fmt: money, kind: 'money', solo: true, neutral: true },
            { label: 'Gross profit', get: (r) => derive(r).gp, fmt: money, kind: 'money', rule: true },
            { label: 'Gross margin', get: (r) => ratio(derive(r).gp, derive(r).rev), fmt: pctFmt, kind: 'pct', neutral: true, sub: true },
            { label: 'Operating expenses', get: (r) => num(r.operatingExpenses), fmt: money, kind: 'money', neutral: true },
            { label: 'R&D', get: (r) => num(r.researchAndDevelopment), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'SG&A', get: (r) => num(r.sellingGeneralAndAdministrative), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Other operating expenses', get: (r) => { const t = num(r.operatingExpenses); const rd = num(r.researchAndDevelopment); const sg = num(r.sellingGeneralAndAdministrative); if (t === null || rd === null || sg === null) return null; const rest = t - (rd || 0) - (sg || 0); return Math.abs(rest) < 1 ? null : rest; }, fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Operating income', get: (r) => num(r.operatingIncome), fmt: money, kind: 'money', rule: true },
            { label: 'Operating margin', get: (r) => ratio(num(r.operatingIncome), derive(r).rev), fmt: pctFmt, kind: 'pct', neutral: true, sub: true },
            { label: 'Net interest income', get: (r) => num(r.netInterestIncome), fmt: money, kind: 'money', solo: true },
            { label: 'Noninterest income', get: (r) => num(r.nonInterestIncome), fmt: money, kind: 'money', solo: true },
            { label: 'Pre-tax income', get: (r) => num(r.incomeBeforeTax), fmt: money, kind: 'money' },
            { label: 'Interest income', get: (r) => num(r.interestIncome), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Interest expense', get: (r) => num(r.interestExpense), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Other non-operating income', get: (r) => num(r.otherNonOperatingIncome), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Income tax', get: (r) => num(r.incomeTaxExpense), fmt: money, kind: 'money', neutral: true },
            { label: 'Effective tax rate', get: (r) => { const t = num(r.incomeTaxExpense); const p = num(r.incomeBeforeTax); return (t !== null && p !== null && p > 0) ? t / p : null; }, fmt: pctFmt, kind: 'pct', neutral: true, sub: true },
            { label: 'Net income', get: (r) => num(r.netIncome), fmt: money, kind: 'money', rule: true },
            { label: 'Net margin', get: (r) => ratio(num(r.netIncome), derive(r).rev), fmt: pctFmt, kind: 'pct', neutral: true, sub: true },
            // EBIT is operating income; EBITDA adds the filed depreciation and
            // amortization. Neither is shown without both filed figures.
            { label: 'EBITDA', get: (r) => { const o = num(r.operatingIncome); const d = num(r.depreciationAndAmortization); return o === null || d === null ? null : o + d; }, fmt: money, kind: 'money' },
            { label: 'EBIT', get: (r) => num(r.operatingIncome), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Depreciation & amortization', get: (r) => num(r.depreciationAndAmortization), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'EPS, basic', get: (r) => num(r.eps), fmt: (v) => fixed(v, 2), kind: 'ps', solo: true },
            { label: 'EPS, diluted', get: (r) => num(r.dilutedEPS), fmt: (v) => fixed(v, 2), kind: 'ps', solo: true }
        ],
        // Macrotrends content, accordion order: each subtotal is the parent
        // row and its components unfold DIRECTLY BELOW it when expanded.
        balance: [
            { label: 'Total current assets', get: (r) => num(r.totalCurrentAssets), fmt: money, kind: 'money' },
            { label: 'Cash & short-term investments', get: (r) => { const t = num(r.cashAndShortTermInvestments); if (t !== null) return t; const c = num(r.cashAndCashEquivalentsAtCarryingValue); const s = num(r.shortTermInvestments); return c === null || s === null ? null : c + s; }, fmt: money, kind: 'money', sub: true },
            { label: 'Cash and cash equivalents', get: (r) => num(r.cashAndCashEquivalentsAtCarryingValue), fmt: money, kind: 'money', sub: true },
            { label: 'Receivables', get: (r) => num(r.currentNetReceivables), fmt: money, kind: 'money', sub: true },
            { label: 'Inventory', get: (r) => num(r.inventory), fmt: money, kind: 'money', sub: true },
            { label: 'Other current assets', get: (r) => num(r.otherCurrentAssets), fmt: money, kind: 'money', sub: true, neutral: true },
            // Total assets less current assets first: some filers tag only their long-lived
            // (PP&E-like) assets as NoncurrentAssets, which is far below the true total.
            { label: 'Total long-term assets', get: (r) => { const a = num(r.totalAssets); const c = num(r.totalCurrentAssets); return (a !== null && c !== null) ? a - c : num(r.totalNonCurrentAssets); }, fmt: money, kind: 'money' },
            { label: 'Property, plant & equipment', get: (r) => num(r.propertyPlantEquipment), fmt: money, kind: 'money', sub: true },
            { label: 'Operating lease assets', get: (r) => num(r.operatingLeaseRightOfUseAsset), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Long-term investments', get: (r) => num(r.longTermInvestments), fmt: money, kind: 'money', sub: true },
            { label: 'Goodwill', get: (r) => num(r.goodwill), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Intangible assets', get: (r) => { const ix = num(r.intangibleAssetsExcludingGoodwill); return ix !== null ? ix : num(r.intangibleAssets); }, fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Deferred tax assets', get: (r) => num(r.deferredTaxAssets), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Other long-term assets', get: (r) => num(r.otherNonCurrentAssets), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Total assets', get: (r) => num(r.totalAssets), fmt: money, kind: 'money', rule: true, solo: true },
            { label: 'Loans', get: (r) => num(r.loans), fmt: money, kind: 'money', solo: true },
            { label: 'Deposits', get: (r) => num(r.deposits), fmt: money, kind: 'money', solo: true },
            { label: 'Total current liabilities', get: (r) => num(r.totalCurrentLiabilities), fmt: money, kind: 'money' },
            { label: 'Accounts payable', get: (r) => num(r.currentAccountsPayable), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Short-term debt', get: (r) => num(r.shortTermDebt), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Current maturities of long-term debt', get: (r) => num(r.currentLongTermDebt), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Total long-term liabilities', get: (r) => { const t = num(r.totalNonCurrentLiabilities); if (t !== null) return t; const a = num(r.totalLiabilities); const c = num(r.totalCurrentLiabilities); return (a !== null && c !== null) ? a - c : null; }, fmt: money, kind: 'money' },
            { label: 'Long-term debt', get: (r) => num(r.longTermDebt), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Other non-current liabilities', get: (r) => num(r.otherNonCurrentLiabilities), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Total liabilities', get: (r) => num(r.totalLiabilities), fmt: money, kind: 'money', rule: true, solo: true, neutral: true },
            { label: 'Shareholder equity', get: (r) => num(r.totalShareholderEquity), fmt: money, kind: 'money' },
            { label: 'Common stock', get: (r) => num(r.commonStock), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Retained earnings', get: (r) => num(r.retainedEarnings), fmt: money, kind: 'money', sub: true },
            { label: 'Treasury stock', get: (r) => num(r.treasuryStock), fmt: money, kind: 'money', sub: true, neutral: true },
            // The filed total. Liabilities plus parent equity left out noncontrolling interests and temporary equity in
            // 18,044 of 46,116 annual cells (2026-10-17); the total always equals total assets, so that is the fallback.
            { label: 'Total liabilities & equity', get: (r) => num(r.totalLiabilitiesAndEquity) ?? num(r.totalAssets), fmt: money, kind: 'money', rule: true, solo: true },
            { label: 'Shares outstanding', get: (r) => num(r.commonStockSharesOutstanding), fmt: money, kind: 'shares', neutral: true, solo: true }
        ],
        cash: [
            { label: 'Cash flow from operations', get: (r) => num(r.operatingCashflow), fmt: money, kind: 'money', rule: true },
            { label: 'Net income', get: (r) => num(r.cashFlowNetIncome), fmt: money, kind: 'money', sub: true },
            { label: 'Depreciation & amortization', get: (r) => num(r.depreciationDepletionAndAmortization), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Stock-based compensation', get: (r) => num(r.shareBasedCompensation), fmt: money, kind: 'money', sub: true, neutral: true },
            // Filed as the change in the balance (an increase in receivables is
            // positive); an asset that grows uses cash, so its sign is reversed.
            { label: 'Change in receivables', get: (r) => cashEffect(r.changeInReceivables), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Change in inventory', get: (r) => cashEffect(r.changeInInventory), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Change in other operating assets', get: (r) => cashEffect(r.changeInOperatingAssets), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Change in accounts payable', get: (r) => num(r.changeInAccountsPayable), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Change in other operating liabilities', get: (r) => num(r.changeInOperatingLiabilities), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Cash flow from investing', get: (r) => num(r.cashflowFromInvestment), fmt: money, kind: 'money', rule: true, neutral: true },
            { label: 'Capital expenditure', get: (r) => num(r.capitalExpenditures), fmt: money, kind: 'money', sub: true, invert: true },
            { label: 'Cash flow from financing', get: (r) => num(r.cashflowFromFinancing), fmt: money, kind: 'money', rule: true, neutral: true },
            { label: 'Debt issued', get: (r) => num(r.proceedsFromIssuanceOfLongTermDebt), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Debt repaid', get: (r) => num(r.repaymentsOfLongTermDebt), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Short-term borrowing, net', get: (r) => num(r.proceedsFromRepaymentsOfShortTermDebt), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Stock issued', get: (r) => num(r.proceedsFromIssuanceOfCommonStock), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Share buybacks', get: (r) => num(r.paymentsForRepurchaseOfCommonStock), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Dividends paid', get: (r) => { const d = num(r.dividendPayout); return d !== null ? d : num(r.dividendPayoutCommonStock); }, fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Net change in cash', get: (r) => num(r.changeInCashAndCashEquivalents), fmt: money, kind: 'money', neutral: true, solo: true },
            { label: 'Free cash flow', get: (r) => fcfOf(r), fmt: money, kind: 'money', rule: true, solo: true, fcf: true }
        ]
    };

    let payload = null;
    let stState = 'income';
    let basisState = 'annual';
    let viewState = 'usd';
    let chartMode = 'price';
    let rangeYears = 10;
    // The 5Y-trend column is a control, and controls start off: the table
    // opens with no trend column; "Show 5Y trend" is what turns it on.
    let showStatementTrend = true;
    let sharesByPeriod = new Map();
    let sharesBasis = 'period-end'; // which filed count sharesByPeriod holds (buildSharesMap)
    let lastRender = { rows: [], periods: [] };

    function quoteCurrency(data = payload) {
        return currencyCode(data?.marketData?.currency || (data && data.overview && data.overview.Currency) || 'USD');
    }
    function reportingCurrency(data = payload) {
        if (!data) return 'USD';
        for (const statement of ['income', 'balance', 'cash']) {
            for (const period of ['annualReports', 'quarterlyReports']) {
                const row = (((data[statement] || {})[period]) || []).find((item) => item && item.reportedCurrency);
                if (row) return currencyCode(row.reportedCurrency);
            }
        }
        return quoteCurrency(data);
    }
    function sourceReportingCurrency(data = payload) {
        const conversion = data && data.currencyConversion;
        if (conversion && conversion.from) return currencyCode(conversion.from);
        if (!data) return 'USD';
        for (const statement of ['income', 'balance', 'cash']) {
            for (const period of ['annualReports', 'quarterlyReports']) {
                const row = (((data[statement] || {})[period]) || [])
                    .find((item) => item && (item.originalReportedCurrency || item.reportedCurrency));
                if (row) return currencyCode(row.originalReportedCurrency || row.reportedCurrency);
            }
        }
        return quoteCurrency(data);
    }
    function hasCurrencyMismatch(data = payload) {
        return data?.coverage?.perShareAllowed===false || quoteCurrency(data) !== sourceReportingCurrency(data);
    }

    // ---------- data joins ----------
    function annualJoined(kind = 'annualReports') {
        const by = new Map();
        for (const st of ['income', 'balance', 'cash']) {
            for (const r of ((payload[st] || {})[kind]) || []) {
                const k = String(r.fiscalDateEnding || '');
                if (!k) continue;
                if (!by.has(k)) by.set(k, { end: r.fiscalDateEnding });
                by.get(k)[st] = r;
            }
        }
        return [...by.values()].sort((a, b) => String(a.end).localeCompare(String(b.end)));
    }
    // Quarters, each carrying the net income of the four quarters ending with it
    // (ttmNetIncome), or null when those four are not a continuous filed year.
    function quarterlyJoined() {
        const qs = annualJoined('quarterlyReports');
        qs.forEach((q, i) => {
            const four = qs.slice(Math.max(0, i - 3), i + 1).map((x) => x.income || {});
            const vals = four.map((r) => num(r.netIncome));
            const days = four.length === 4 && four[0].periodStart ? (new Date(q.end) - new Date(four[0].periodStart)) / 864e5 + 1 : 0;
            q.ttmNetIncome = days >= 350 && days <= 380 && vals.every((v) => v !== null) ? vals.reduce((a, v) => a + v, 0) : null;
        });
        return qs;
    }
    function monthlySeries(p) {
        const ts =(p.monthly || {})['Monthly Adjusted Time Series'] || (p.monthly || {})['Monthly Time Series'] || {};
        const out = [];
        for (const k of Object.keys(ts).sort()) {
            const row = ts[k];
            const v = num(row['5. adjusted close']) !== null ? num(row['5. adjusted close']) : num(row['4. close']);
            if (v !== null) out.push({ month: k.slice(0, 7), close: v });
        }
        return out;
    }
    function buildSharesMap() {
        sharesByPeriod = new Map();
        for (const kind of ['annualReports', 'quarterlyReports']) {
            for (const r of ((payload.balance || {})[kind]) || []) {
                const k = String(r.fiscalDateEnding || '');
                const v = num(r.commonStockSharesOutstanding);
                if (k && v) sharesByPeriod.set(k, v);
            }
        }
        // 1,440 of 5,090 companies (AbbVie, Chevron, Chipotle) tag no period-end count
        // on the balance sheet, and the chart's left axis came out blank for them
        // (2026-10-19). Their income statement still files the weighted-average count;
        // failing that, the cover page's current count. Never mixed with period-end
        // counts, whose difference would read as a buyback.
        sharesBasis = 'period-end';
        if (sharesByPeriod.size) return;
        for (const kind of ['annualReports', 'quarterlyReports']) {
            for (const r of ((payload.income || {})[kind]) || []) {
                const k = String(r.fiscalDateEnding || '');
                const v = num(r.weightedAverageSharesOutstanding);
                if (k && v) sharesByPeriod.set(k, v);
            }
        }
        sharesBasis = 'weighted';
        if (sharesByPeriod.size) return;
        const now = num((payload.overview || {}).SharesOutstanding);
        if (now) sharesByPeriod.set('9999-12-31', now);
        sharesBasis = 'current';
    }
    // step function: shares as of a given month (latest fiscal period ≤ month)
    let _shareSteps = null;
    function sharesAt(month) {
        if (!_shareSteps) {
            _shareSteps = [...sharesByPeriod.entries()].sort((a, b) => a[0].localeCompare(b[0]));
            // The price series is split-adjusted; share counts are as filed. Across
            // Apple's 4-for-1 the count jumps 4× while the adjusted price does not, so
            // the market-cap line sat at a quarter of its true level before 2020.
            // Walking back from today, a jump that matches a split ratio is carried
            // onto every earlier count, putting them all on today's share basis.
            const RATIOS = [1.5, 2, 3, 4, 5, 6, 7, 8, 10, 15, 20, 25, 50];
            const splitOf = (r) => RATIOS.concat(RATIOS.map((x) => 1 / x)).find((x) => Math.abs(r / x - 1) < 0.04) || null;
            let factor = 1;
            for (let i = _shareSteps.length - 2; i >= 0; i--) {
                const next = _shareSteps[i + 1][1];
                const hit = splitOf(next / (_shareSteps[i][1] * factor));
                if (hit) factor *= hit;
                _shareSteps[i] = [_shareSteps[i][0], _shareSteps[i][1] * factor];
            }
        }
        if (!_shareSteps.length) return null;
        let s = _shareSteps[0][1];
        for (const [k, v] of _shareSteps) {
            if (k <= month) s = v; else break;
        }
        return s;
    }

    // ---------- ① masthead ----------
    // Set when the API served a stored snapshot because Yahoo was unavailable.
    // Holds the trading day the figures are from, so the page can say so rather
    // than presenting a days-old close as a live quote.
    let staleAsOf = null;

    // Past this, the stored close is too old to show as a price at all. The
    // weekly refresh keeps S&P 500 names within 7 days; everything outside that
    // list is frozen months back, and a quarter-old number in the masthead's
    // largest type reads as current however carefully it is labelled. The rest
    // of the page — SEC statements, ratios, the chart — stays, because filed
    // figures don't rot the way a quote does.
    const PRICE_MAX_AGE_DAYS = 30;

    function staleDays() {
        if (!staleAsOf) return 0;
        const then = new Date(`${String(staleAsOf).slice(0, 10)}T00:00:00Z`);
        if (Number.isNaN(then.getTime())) return 0;
        return Math.floor((Date.now() - then.getTime()) / 86400000);
    }

    function priceTooOld() {
        return staleDays() > PRICE_MAX_AGE_DAYS;
    }

    function formatAsOf(iso) {
        const d = new Date(`${String(iso).slice(0, 10)}T00:00:00Z`);
        if (Number.isNaN(d.getTime())) return String(iso);
        return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
    }

    function renderStaleNotice() {
        const el = $('co-stale');
        if (!el) return;
        // The old quote-as-of notice is retired: it printed the provider's
        // raw ISO timestamp plus a market-state suffix, so the same notice
        // read differently on every stock. The notice now says one thing —
        // a formatted date, or the stale-price line when the quote is too
        // old to be shown at all.
        if (!staleAsOf) { el.hidden = true; return; }
        el.textContent = priceTooOld()
            ? `Current price unavailable. Financials and chart shown as of ${formatAsOf(staleAsOf)}`
            : `Data as of ${formatAsOf(staleAsOf)}`;
        el.hidden = false;
    }

    function renderMasthead() {
        const ov = payload.overview || {};
        const q = (payload.quote || {})['Global Quote'] || {};
        $('co-crumb').textContent = [symbol, ov.Sector, ov.Exchange].filter(Boolean).join('  ·  ');
        $('co-name').textContent = ov.Name || symbol;
        const dos = $('co-dossier');
        if (dos) { dos.href = `/dossier.html?symbol=${encodeURIComponent(symbol)}`; dos.hidden = false; }
        document.title = `${ov.Name || symbol} (${symbol}) — verified financials | stockportfolio.pro`;
        const market=payload.marketData || {};
        if(market.asOf)staleAsOf=market.asOf;
        const price = num(market.price ?? q['05. price']);
        const chPct = market.changePercent!==undefined?num(market.changePercent):num(String(q['10. change percent'] || '').replace('%', ''));
        const hidePrice = priceTooOld();
        $('co-price').textContent = (!hidePrice && price !== null)
            ? currencyAmount(price, quoteCurrency(), { compact: false })
            : '';
        const chEl = $('co-change');
        if (hidePrice) {
            chEl.textContent = '';
            chEl.className = 'small num';
        } else if (chPct !== null) {
            // "today" would be a lie on a stored snapshot — name the day instead.
            const when = staleAsOf ? `% on ${formatAsOf(staleAsOf)}` : '% · quote date unavailable';
            chEl.textContent = (chPct >= 0 ? '+' : '') + chPct.toFixed(2) + when;
            chEl.className = 'small num ' + (chPct >= 0 ? 'delta-pos' : 'delta-neg');
        }
        renderStaleNotice();
    }

    // ---------- the dual-axis chart (price right, market cap left) ----------
    // A 1280-wide drawing shrunk onto a phone was 82px tall with 3px labels. A
    // phone gets its own, squarer drawing with larger type and no left axis.
    const NARROW = window.matchMedia && window.matchMedia('(max-width: 640px)').matches;
    const GEOM = NARROW
        ? { W: 420, H: 300, padL: 10, padR: 58, padT: 22, padB: 30, fs: 13, maxLabels: 5 }
        : { W: 1280, H: 320, padL: 70, padR: 70, padT: 30, padB: 28, fs: 11, maxLabels: 8 };
    // capAxisMult: when no separate cap line is drawn, the left axis still
    // reads in market-cap terms — price tick × current share count.
    // capMultiple: text for the badge under the market-cap value, e.g. "33× P/E".
    function dualChart(price, cap, labels, fmtPrimary, capAxisMult, capMultiple) {
        const { W, H, padL, padR, padT, padB, fs } = GEOM;
        const fmtP = fmtPrimary || ((v) => currencyAmount(v, quoteCurrency(), {
            compact: false,
            decimals: v >= 100 ? 0 : 1
        }));
        const scale = (vals) => {
            const vs = vals.filter((v) => v !== null && Number.isFinite(v));
            let min = Math.min(...vs); let max = Math.max(...vs);
            if (min === max) { min -= 1; max += 1; }
            const floor = min; const span = max - min; min -= span * 0.05; max += span * 0.05;
            // a price or market value never goes below zero, so the padding must not
            // push the axis there: NVDA over ten years was labelled "$-9.1".
            if (floor >= 0 && min < 0) min = 0;
            return { min, max };
        };
        // Gridlines sit on round numbers ($100, $200 …), as on the Markets page,
        // not at thirds of whatever the raw range happened to be ("$164.63B", "$11.3").
        const nice = (s) => {
            const raw = (s.max - s.min) / 4;
            const mag = Math.pow(10, Math.floor(Math.log10(raw)));
            const nrm = raw / mag;
            s.step = (nrm < 1.5 ? 1 : nrm < 3.5 ? 2 : nrm < 7.5 ? 5 : 10) * mag;
            s.min = Math.floor(s.min / s.step + 1e-9) * s.step;
            s.max = Math.ceil(s.max / s.step - 1e-9) * s.step;
            return s;
        };
        const sp = nice(scale(price));
        const sc = cap ? scale(cap) : null;
        const x = (i, n) => padL + (n < 2 ? 0 : (i / (n - 1)) * (W - padL - padR));
        const yP = (v) => padT + (1 - (v - sp.min) / (sp.max - sp.min)) * (H - padT - padB);
        const yC = (v) => padT + (1 - (v - sc.min) / (sc.max - sc.min)) * (H - padT - padB);
        const fmtTick = fmtPrimary || ((v) => currencyAmount(v, quoteCurrency(), { compact: false, decimals: sp.step >= 1 ? 0 : 2 }));
        const lastIdx = price.length - 1;
        const lastY = price[lastIdx] !== null && Number.isFinite(price[lastIdx]) ? yP(price[lastIdx]) : null;
        // the share price is always black; the P/E multiple has its own colour so the
        // two views cannot be mistaken for each other
        const mainCol = fmtPrimary ? 'var(--chart-2)' : 'var(--ink)';
        let g = '<defs><linearGradient id="pc-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="' + mainCol + '" stop-opacity="0.13"/><stop offset="1" stop-color="' + mainCol + '" stop-opacity="0.02"/></linearGradient></defs>';
        for (let t = sp.min; t <= sp.max + sp.step * 1e-6; t += sp.step) {
            const yy = yP(t);
            const fr = (t - sp.min) / (sp.max - sp.min);
            g += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`;
            // the last-price badge sits on this axis; a tick label under it is unreadable
            if (lastY === null || Math.abs(yy - lastY) > fs + 7) {
                g += `<text x="${W - padR + 8}" y="${(yy + 3.5).toFixed(1)}" font-size="${fs}" fill="var(--ink-3)" style="font-variant-numeric:tabular-nums">${esc(fmtTick(t))}</text>`;
            }
            const leftVal = sc ? sc.min + fr * (sc.max - sc.min) : (capAxisMult ? t * capAxisMult : null);
            if (leftVal !== null && padL >= 40) {
                g += `<text x="${padL - 8}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end" font-size="11" fill="${sc ? 'var(--chart-2)' : 'var(--ink-3)'}" style="font-variant-numeric:tabular-nums">${esc(currencyAmount(leftVal, quoteCurrency()))}</text>`;
            }
        }
        // one quiet baseline; the heavy left rule made the plot look boxed in
        g += `<line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="var(--line-strong)" stroke-width="1"/>`;
        const n = price.length;
        // draw at the indices that actually carry a (deduped) label, capped ~8
        const labelIdx = labels.map((l, i) => l ? i : -1).filter((i) => i >= 0);
        const lstep = Math.max(1, Math.ceil(labelIdx.length / GEOM.maxLabels));
        // A window that opens late in a year puts its first two year labels a point
        // or two apart ("2021" printed on top of "2022"). Keep the later of the pair.
        const picked = [];
        for (let j = 0; j < labelIdx.length; j += lstep) {
            const i = labelIdx[j];
            if (picked.length && x(i, n) - x(picked[picked.length - 1], n) < (padL < 40 ? 46 : 60)) {
                if (picked.length === 1) picked[0] = i;
                continue;
            }
            picked.push(i);
        }
        for (let j = 0; j < picked.length; j++) {
            const i = picked[j];
            g += `<text x="${x(i, n).toFixed(1)}" y="${H - 8}" text-anchor="${j === 0 && padL < 40 ? 'start' : 'middle'}" font-size="${fs - 0.5}" fill="var(--ink-3)">${esc(labels[i])}</text>`;
        }
        const path = (vals, y, col, w) => {
            let d = ''; let started = false;
            vals.forEach((v, i) => {
                if (v === null || !Number.isFinite(v)) { started = false; return; }
                d += (started ? 'L' : 'M') + x(i, vals.length).toFixed(1) + ' ' + y(v).toFixed(1) + ' ';
                started = true;
            });
            return `<path d="${d.trim()}" fill="none" stroke="${col}" stroke-width="${w}" stroke-linejoin="round" stroke-linecap="round"/>`;
        };
        // the second line has its own colour, matching its axis labels and legend —
        // it was drawn in the same ink as the price and the two could not be told apart
        if (sc) g += path(cap, yC, 'var(--chart-2)', 2);
        // soft fill under the price line, the Markets-page look; left out when a
        // second line shares the plot, where a fill would sit under the wrong one
        if (!sc) {
            // one fill per unbroken run, so a gap (a not-meaningful P/E year) stays empty
            const runs = [[]];
            price.forEach((v, i) => {
                if (v === null || !Number.isFinite(v)) { if (runs[runs.length - 1].length) runs.push([]); return; }
                runs[runs.length - 1].push([x(i, n), yP(v)]);
            });
            const base = (H - padB).toFixed(1);
            for (const pts of runs) {
                // a lone year between gaps draws no line segment; a dot keeps it visible
                if (pts.length === 1) { g += `<circle cx="${pts[0][0].toFixed(1)}" cy="${pts[0][1].toFixed(1)}" r="3" fill="${mainCol}"/>`; continue; }
                if (!pts.length) continue;
                g += '<path d="M' + pts[0][0].toFixed(1) + ' ' + base + ' ' + pts.map((p) => 'L' + p[0].toFixed(1) + ' ' + p[1].toFixed(1)).join(' ') + ' L' + pts[pts.length - 1][0].toFixed(1) + ' ' + base + ' Z" fill="url(#pc-fill)" stroke="none"/>';
            }
        }
        // a not-meaningful P/E year is marked where it falls, so the gap reads as NM
        // rather than missing data; the last year already gets its NM badge below
        if (fmtPrimary) {
            price.forEach((v, i) => {
                if ((v !== null && Number.isFinite(v)) || i === n - 1) return;
                const xx = x(i, n).toFixed(1);
                g += `<line x1="${xx}" y1="${padT}" x2="${xx}" y2="${H - padB}" stroke="var(--chart-2)" stroke-opacity="0.45" stroke-width="1" stroke-dasharray="3 4"/>`;
                g += `<rect x="${(x(i, n) - 17).toFixed(1)}" y="${(H - padB - 26).toFixed(1)}" width="34" height="18" rx="5" fill="var(--surface, #fff)" stroke="var(--chart-2)"/>`;
                g += `<text x="${xx}" y="${(H - padB - 13).toFixed(1)}" text-anchor="middle" font-size="${fs - 1}" font-weight="650" fill="var(--chart-2)">NM</text>`;
            });
        }
        g += path(price, yP, mainCol, 2.2);
        // last value: dot on the line + a clear badge ON the right axis, where
        // the line can never hide it
        if (sc) {
            const lx = padL + 12; const lyy = padT + 4;
            g += `<line x1="${lx}" y1="${lyy}" x2="${lx + 20}" y2="${lyy}" stroke="var(--ink)" stroke-width="2.2"/><text x="${lx + 26}" y="${lyy + 4}" font-size="${fs}" fill="var(--ink)">Price</text>`
                + `<line x1="${lx + 70}" y1="${lyy}" x2="${lx + 90}" y2="${lyy}" stroke="var(--chart-2)" stroke-width="2.2"/><text x="${lx + 96}" y="${lyy + 4}" font-size="${fs}" fill="var(--chart-2)">Market cap</text>`;
        }
        const li = price.length - 1;
        if (price[li] !== null) {
            const ly = yP(price[li]);
            g += `<circle cx="${x(li, n).toFixed(1)}" cy="${ly.toFixed(1)}" r="3.2" fill="${mainCol}"/>`;
            g += `<rect x="${W - padR + 2}" y="${(ly - 11).toFixed(1)}" width="${padR - 4}" height="20" rx="5" fill="${mainCol}"/>`;
            g += `<text x="${W - padR + (padR - 2) / 2}" y="${(ly + 3.5).toFixed(1)}" text-anchor="middle" font-size="${fs}" font-weight="650" fill="var(--paper, #faf9f6)" style="font-variant-numeric:tabular-nums">${esc(fmtP(price[li]))}</text>`;
        } else if (fmtPrimary) {
            // a latest multiple that is not meaningful still gets its badge, never a blank end
            g += `<rect x="${W - padR + 2}" y="${padT - 11}" width="${padR - 4}" height="20" rx="5" fill="${mainCol}"/>`;
            g += `<text x="${W - padR + (padR - 2) / 2}" y="${padT + 3.5}" text-anchor="middle" font-size="${fs}" font-weight="650" fill="var(--paper, #faf9f6)">NM</text>`;
        }
        // the market-cap line ends in its own badge with the earnings multiple under it,
        // so both are read at the end of the line like the price; the pair moves clear
        // of the price badge when they would overlap
        const ci = sc ? cap.length - 1 : -1;
        if (ci >= 0 && cap[ci] !== null && Number.isFinite(cap[ci])) {
            const texts = [currencyAmount(cap[ci], quoteCurrency())].concat(capMultiple ? [capMultiple] : []);
            const span = 22 * (texts.length - 1);
            let cy = yC(cap[ci]);
            if (lastY !== null && lastY > cy - 22 && lastY < cy + span + 22) {
                const above = lastY - 22 - span;
                cy = cy <= lastY && above >= padT ? above : lastY + 22;
            }
            g += `<circle cx="${x(ci, cap.length).toFixed(1)}" cy="${yC(cap[ci]).toFixed(1)}" r="3.2" fill="var(--chart-2)"/>`;
            texts.forEach((txt, k) => {
                const by = cy + 22 * k;
                const bw = Math.max(padR - 4, Math.ceil(txt.length * fs * 0.62) + 10);
                // the value is a filled badge, the multiple an outlined one beneath it
                g += `<rect x="${W - padR + 2 + (padR - 4) - bw}" y="${(by - 10.5).toFixed(1)}" width="${bw}" height="20" rx="5" fill="${k ? 'var(--surface, #fff)' : 'var(--chart-2)'}" stroke="var(--chart-2)" stroke-width="1"/>`;
                g += `<text x="${W - padR + 2 + (padR - 4) - bw / 2}" y="${(by + 3.5).toFixed(1)}" text-anchor="middle" font-size="${fs}" font-weight="650" fill="${k ? 'var(--chart-2)' : 'var(--paper, #faf9f6)'}" style="font-variant-numeric:tabular-nums">${esc(txt)}</text>`;
            });
        }
        return `<svg viewBox="0 0 ${W} ${H}" style="width:100%; height:auto; display:block;" role="img">${g}</svg>`;
    }

    // hover: crosshair + tooltip over the plot area
    function wireChartHover(points) {
        const wrap = $('main-chart');
        let tip = wrap.querySelector('.chart-tip');
        let cross = wrap.querySelector('.chart-cross');
        if (!tip) {
            tip = document.createElement('div'); tip.className = 'chart-tip'; tip.hidden = true; wrap.appendChild(tip);
            cross = document.createElement('div'); cross.className = 'chart-cross'; cross.hidden = true; wrap.appendChild(cross);
        }
        const { W, H, padL, padR, padT, padB } = GEOM;
        wrap.onmousemove = (e) => {
            const svg = wrap.querySelector('svg');
            if (!svg || !points.length) return;
            const rect = svg.getBoundingClientRect();
            const xvb = (e.clientX - rect.left) / rect.width * W;
            if (xvb < padL - 6 || xvb > W - padR + 6) { tip.hidden = true; cross.hidden = true; return; }
            const n = points.length;
            const i = Math.max(0, Math.min(n - 1, Math.round((xvb - padL) / (W - padL - padR) * (n - 1))));
            const xpx = (padL + (n < 2 ? 0 : (i / (n - 1)) * (W - padL - padR))) / W * rect.width;
            cross.style.left = (xpx) + 'px';
            cross.style.top = (padT / H * rect.height) + 'px';
            cross.style.height = ((H - padT - padB) / H * rect.height) + 'px';
            cross.hidden = false;
            tip.innerHTML = `<div class="label">${esc(points[i].label)}</div>` + points[i].lines.map((l) => `<div>${esc(l)}</div>`).join('');
            tip.hidden = false;
            const tw = tip.offsetWidth;
            tip.style.left = Math.min(Math.max(0, xpx - tw / 2), rect.width - tw) + 'px';
            tip.style.top = '6px';
        };
        wrap.onmouseleave = () => { tip.hidden = true; cross.hidden = true; };
    }

    let showCap = false; // price line only by default; the cap LINE is opt-in
    function dailySeriesPts() {
        const ts = (payload.daily || {})['Time Series (Daily)'] || {};
        const out = [];
        for (const k of Object.keys(ts).sort()) {
            const row = ts[k];
            const v = num(row['5. adjusted close']) !== null ? num(row['5. adjusted close']) : num(row['4. close']);
            if (v !== null) out.push({ month: k, close: v });
        }
        return out;
    }
    function renderMainChart() {
        if (!payload) return; // a fund page never loads company fundamentals
        const series = monthlySeries(payload);
        const mixedCurrencies = hasCurrencyMismatch();
        const peButton = document.querySelector('#seg-chart button[data-cm="pe"]');
        if (peButton) peButton.hidden = mixedCurrencies;
        if (mixedCurrencies && chartMode === 'pe') {
            chartMode = 'price';
            document.querySelectorAll('#seg-chart button').forEach((button) =>
                button.setAttribute('aria-pressed', String(button.dataset.cm === 'price')));
        }
        if (mixedCurrencies) showCap = false;
        if (chartMode === 'price') {
            // 6M uses the daily series; longer ranges use monthly
            // A company listed within the last year has too few monthly closes for a
            // line (Cerebras: six), and the page showed no chart at all. Its daily
            // closes are used for every range instead.
            const young = series.length < 12;
            const useDaily = rangeYears < 1 || young;
            const src = useDaily ? dailySeriesPts() : series;
            if (src.length < (young ? 5 : useDaily ? 30 : 12)) return;
            const win = useDaily
                ? src.slice(-126)
                : src.slice(rangeYears >= 99 ? 0 : Math.max(0, src.length - rangeYears * 12));
            const price = win.map((p) => p.close);
            const rawLabels = useDaily
                ? win.map((p) => new Date(p.month + 'T12:00').toLocaleString('en-US', { month: 'short' }))
                : win.map((p) => p.month.slice(0, 4));
            let seen = '';
            const yl = rawLabels.map((y) => { if (y === seen) return ''; seen = y; return y; });
            // a line needs a count per period; with only today's count it would just retrace the price
            const cap = (!mixedCurrencies && showCap && sharesByPeriod.size && sharesBasis !== 'current')
                ? win.map((p) => { const s = sharesAt(p.month.slice(0, 7)); return s ? p.close * s : null; })
                : null;
            // left axis ALWAYS reads in market cap — via the live cap line
            // when shown, otherwise price × the current share count
            const sharesNow = !mixedCurrencies && sharesByPeriod.size ? sharesAt('9999-12') : null;
            // the multiple beside the market cap is the page's headline P/E, so the two agree
            const peNow = num((payload.overview || {}).PERatio);
            const capMultiple = cap ? (peNow !== null && peNow > 0 ? Math.round(peNow) + '× P/E' : 'P/E NM') : null;
            $('main-chart').innerHTML = dualChart(price, cap, yl, null, cap ? null : sharesNow, capMultiple);
            const fmtPoint = useDaily
                ? (m) => new Date(m + 'T12:00').toLocaleString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })
                : (m) => new Date(m + '-15').toLocaleString('en-US', { month: 'short', year: 'numeric' });
            wireChartHover(win.map((p) => ({
                label: fmtPoint(p.month),
                lines: [currencyAmount(p.close, quoteCurrency(), { compact: false })] // price only — the cap reads off the left axis
            })));
            // The badge used to be frozen at the one-day session change fetched
            // once at load, regardless of which range tab was selected — every
            // range but "today" showed a stale, unrelated number. It now tracks
            // the currently selected window, computed from the same series the
            // chart just drew.
            const first = price[0];
            const last = price[price.length - 1];
            const chEl = $('co-change');
            if (chEl && !priceTooOld() && first !== null && last !== null && first !== 0) {
                const rangePct = ((last - first) / first) * 100;
                const rangeBtn = document.querySelector('#seg-range button[aria-pressed="true"]');
                const rangeLabel = rangeBtn ? rangeBtn.textContent : '';
                // a newly listed company has no ten-year window: name the day the line starts
                const span = young && win[0]
                    ? 'since ' + new Date(win[0].month + 'T12:00').toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                    : 'over ' + rangeLabel;
                chEl.textContent = (rangePct >= 0 ? '+' : '') + rangePct.toFixed(2) + '% ' + span;
                chEl.className = 'small num ' + (rangePct >= 0 ? 'delta-pos' : 'delta-neg');
            }
            $('chart-prov').textContent = mixedCurrencies
                ? `Price is shown in ${quoteCurrency()}. Historical P/E and price × filed-share-count overlays are disabled because the source statements are reported in ${sourceReportingCurrency()}; USD presentation conversion does not supply the listing’s depositary-share ratio.`
                : cap
                ? `Price (right axis): split-adjusted — ink. Market cap (left axis): price × that ${sharesBasis === 'weighted' ? 'period’s filed weighted-average share count (the balance sheet files no period-end count)' : 'fiscal year’s filed share count'} — orange. Where the lines drift apart, buybacks or dilution is why.`
                : `Price (right axis): ${useDaily ? 'daily' : 'monthly'}, split-adjusted. Left axis: the equivalent market cap at today’s share count${sharesBasis === 'weighted' ? ' (the latest filed weighted-average count)' : sharesBasis === 'current' ? ' (the count on the latest filing’s cover)' : ''}.`;
        } else {
            // P/E by fiscal year: avg monthly close within the FY ÷ diluted EPS.
            // A loss year, or a multiple above NM_PE (Cisco FY2018: a one-off tax charge
            // left $0.02 of EPS and a 1,600× P/E that flattened every other year), is
            // "not meaningful": it stays on the axis as a gap, off the scale.
            const NM_PE = 100;
            const inc = ((payload.income || {}).annualReports || []).slice().reverse();
            const vals = []; const labels = []; const notes = [];
            for (const r of inc) {
                const eps = num(r.dilutedEPS);
                const end = String(r.fiscalDateEnding || '');
                if (eps === null || !end) continue;
                const endIdx = series.findIndex((p) => p.month >= end);
                const idx = endIdx === -1 ? series.length - 1 : endIdx;
                const windowMonths = series.slice(Math.max(0, idx - 11), idx + 1);
                if (!windowMonths.length) continue;
                const avg = windowMonths.reduce((a, p) => a + p.close, 0) / windowMonths.length;
                const pe = eps > 0 ? avg / eps : null;
                vals.push(pe !== null && pe <= NM_PE ? pe : null);
                notes.push(pe === null ? 'NM: loss year' : pe > NM_PE ? `NM: ${Math.round(pe).toLocaleString('en-US')}× on $${eps} diluted EPS` : Math.round(pe * 10) / 10 + '× earnings');
                labels.push('FY' + new Date(r.fiscalDateEnding).getFullYear());
            }
            const keep = rangeYears >= 99 ? vals.length : Math.min(vals.length, Math.max(3, rangeYears));
            const v = vals.slice(-keep); const l = labels.slice(-keep); const nt = notes.slice(-keep);
            if (!v.some((pe) => pe !== null)) {
                $('main-chart').innerHTML = `<p class="small muted" style="padding:40px 0; text-align:center;">P/E is not meaningful for ${v.length ? 'these years' : 'this company'}: ${v.length ? 'every year shown is a loss or above ' + NM_PE + '×' : 'no fiscal year has diluted EPS and prices to divide'}.</p>`;
            } else {
                $('main-chart').innerHTML = dualChart(v, null, l, (x2) => Math.round(x2) + '×');
                wireChartHover(v.map((pe, i) => ({ label: l[i], lines: [nt[i]] })));
            }
            $('chart-prov').textContent = `P/E by fiscal year: average monthly close across the year ÷ that year’s diluted EPS, both split-adjusted. Loss years and multiples above ${NM_PE}× are not meaningful (NM) and left off the scale.`;
        }
        $('cap-toggle').hidden = chartMode !== 'price' || mixedCurrencies || !sharesByPeriod.size || sharesBasis === 'current';
        $('chart-block').hidden = false;
    }
    // Price trend from daily closes under the chart, fetched after the page is
    // drawn (3 of last month's 10 customer questions asked for RSI, a golden
    // cross or a volume breakout). Descriptive, so nothing is coloured as good
    // or bad; nothing shows when there is no daily series.
    async function renderTrendBand() {
        try {
            const r = await fetch(`${API}/company/${encodeURIComponent(symbol)}/technicals`);
            if (!r.ok) return;
            const t = await r.json();
            const signed = (v) => (v === null || v === undefined ? '—' : (v > 0 ? '+' : '') + fixed(v, 1) + '%');
            const day = (d) => new Date(d + 'T00:00:00Z').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
            const items = [
                ['Trend', t.trend ? t.trend[0].toUpperCase() + t.trend.slice(1) : '—'],
                ['RSI (14)', fixed(t.rsi14, 0)],
                ['vs 50-day avg', signed(t.pctVsSma50)],
                ['vs 200-day avg', signed(t.pctVsSma200)],
                ['Last 50/200 cross', t.lastCross ? `${t.lastCross.type === 'golden' ? 'Golden' : 'Death'} · ${day(t.lastCross.date)}` : 'None recently'],
                ['Volume vs 20-day', t.volumeRatio20 === null ? '—' : fixed(t.volumeRatio20, 2) + '×'],
                ['From 52-week high', signed(t.pctFrom52wHigh)]
            ];
            $('trend-band').innerHTML = `<div class="trend-items">${items.map(([k, v]) => `<div><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('')}</div>`
                + `<p class="provenance">Price trend as of ${esc(day(t.asOf))}, from daily adjusted closes. It describes past prices and is not a trade signal.</p>`;
            $('trend-band').hidden = false;
        } catch (_) { /* the page is complete without it */ }
    }
    $('cap-toggle').addEventListener('click', () => {
        showCap = !showCap;
        $('cap-toggle').setAttribute('aria-pressed', String(showCap));
        $('cap-toggle').classList.toggle('chip-accent', showCap);
        $('cap-toggle').textContent = showCap ? '− Market cap' : '+ Market cap';
        renderMainChart();
    });
    document.querySelectorAll('#seg-chart button').forEach((b) =>
        b.addEventListener('click', () => {
            document.querySelectorAll('#seg-chart button').forEach((x) => x.setAttribute('aria-pressed', x === b));
            chartMode = b.dataset.cm;
            renderMainChart();
        }));
    document.querySelectorAll('#seg-range button').forEach((b) =>
        b.addEventListener('click', () => {
            document.querySelectorAll('#seg-range button').forEach((x) => x.setAttribute('aria-pressed', x === b));
            rangeYears = Number(b.dataset.r);
            renderMainChart();
        }));

    // ---------- ② key numbers + about ----------
    function renderKv() {
        const ov = payload.overview || {};
        const years = annualJoined();
        const last = years[years.length - 1] || {};
        const inc = (last.income || {}); const bal = (last.balance || {}); const cf = (last.cash || {});
        const d = derive(inc);
        const fy = last.end ? 'FY' + new Date(last.end).getFullYear() : 'latest FY';
        const roe = ratio(num(inc.netIncome), num(bal.totalShareholderEquity));
        const nm = ratio(num(inc.netIncome), d.rev);
        const fcf = fcfOf(cf);
        const sh = num(bal.commonStockSharesOutstanding);
        const bps = (num(bal.totalShareholderEquity) !== null && sh) ? num(bal.totalShareholderEquity) / sh : null;
        const quoteCur = quoteCurrency();
        const reportCur = reportingCurrency();
        const items = [
            ['Market cap', currencyAmount(ov.MarketCapitalization, quoteCur)],
            ['P/E', fixed(ov.PERatio, 1)],
            [`Revenue ${fy}`, currencyAmount(d.rev, reportCur)],
            ['Forward P/E', fixed(ov.ForwardPE, 1)],
            ['Net margin', pctFmt(nm)],
            ['Dividend yield', ov.DividendYield ? pct(num(ov.DividendYield) * 100, 2) : '—'],
            ['Return on equity', pctFmt(roe)],
            ['EPS, diluted', currencyAmount(inc.dilutedEPS, reportCur, { compact: false })],
            ['Free cash flow', currencyAmount(fcf, reportCur)],
            ['52-week range', currencyRange(ov['52WeekLow'], ov['52WeekHigh'], quoteCur)],
            ['Book value / filed share', currencyAmount(bps, reportCur, { compact: false })],
            ['Fiscal year end', ov.FiscalYearEnd || (last.end ? new Date(last.end).toLocaleString('en-US', { month: 'short' }) : '—')]
        ].filter(([l]) => !(l === 'Free cash flow' && noFcf()));
        $('kv-grid').innerHTML = items.map(([l, v]) =>
            `<div class="kv-row"><span>${l}</span><b>${v}</b></div>`).join('');
    }

    // ---------- ③ key points: the dossier from the 10-K ----------
    async function renderDossier(generate = false) {
        const body = $('kp-body');
        try {
            const headers = generate && token() ? { Authorization: `Bearer ${token()}` } : {};
            const suffix = generate ? '?generate=1' : '';
            const r = await fetch(`/api/company/${encodeURIComponent(symbol)}/keypoints${suffix}`, { headers });
            if (r.status === 429) {
                const q = await r.json().catch(() => ({}));
                const limit = (q.quota || {}).limit || 5;
                body.innerHTML = upgradeStrip({
                    title: `You've used your ${limit} free stocks with key points this month.`,
                    items: [`${symbol} key points — business, risks, performance from the latest 10-K — need Core (unlimited stocks)`]
                });
                return;
            }
            if (!r.ok) {
                body.innerHTML = generate
                    ? '<p class="small muted">Key points unavailable for this company.</p>'
                    : '<p class="small muted">Open Insights · Pro to generate filing key points.</p>';
                return;
            }
            const d = await r.json();
            if (!Array.isArray(d.sections) || !d.sections.length) { body.innerHTML = '<p class="small muted">Key points unavailable for this company.</p>'; return; }
            const sec = (s) => `
              <div class="kp-section" style="break-inside:avoid;">
                <p class="kp-head">${esc(s.heading)}</p>
                <ul class="kp-points">${s.points.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>
              </div>`;
            body.innerHTML = d.sections.map(sec).join('') +
                `<p class="provenance" style="break-inside:avoid;">AI-extracted from the <a href="${esc((d.filing || {}).url || '#')}" target="_blank" rel="noopener">10-K filed ${esc((d.filing || {}).date || '')}</a> — verify against the filing.</p>`;
        } catch (_) {
            body.innerHTML = '<p class="small muted">Key points unavailable right now.</p>';
        }
    }
    function renderAbout() {
        const ov = payload.overview || {};
        if (!ov.Description) { $('kv-block').style.gridTemplateColumns = '1fr'; return; }
        $('about-title').textContent = `About ${ov.Name || symbol}`;
        // structure first, prose second: facts as a compact grid on top,
        // then ONE quiet paragraph — no artificial splits
        const facts = [
            ['Sector', ov.Sector], ['Industry', ov.Industry], ['Exchange', ov.Exchange],
            ['Country', ov.Country], ['Fiscal year end', ov.FiscalYearEnd]
        ].filter(([, v]) => v);
        $('about-facts').innerHTML = facts.map(([l, v]) =>
            `<div class="kv-row" style="padding:5px 0;"><span>${l}</span><b style="font-weight:550;">${esc(v)}</b></div>`).join('');
        $('about-text').innerHTML = `<p>${esc(String(ov.Description))}</p>`;
        $('about-col').hidden = false;
        const txt = $('about-text');
        requestAnimationFrame(() => {
            if (txt.scrollHeight > txt.clientHeight + 4) {
                const btn = $('about-more');
                btn.hidden = false;
                btn.addEventListener('click', () => {
                    const open = txt.classList.toggle('open');
                    btn.textContent = open ? 'Read less ▴' : 'Read more ▾';
                });
            }
        });
    }

    // ---------- ③ the checks (verdict + detail share one item list) ----------
    function buildChecks() {
        const years = annualJoined();
        if (years.length < 2) return [];
        const get = (y, st, f) => num((y[st] || {})[f]);
        const last = years[years.length - 1];
        const span = (n) => years.slice(-n);
        const yrSpan = (Date.parse(last.end)-Date.parse(years[0].end))/86400000/365.2425;
        const checks = [];
        const add = (label, ok, detail) => { if (ok !== null) checks.push({ label, pass: !!ok, detail }); };

        const revC = cagr(get(years[0], 'income', 'totalRevenue'), get(last, 'income', 'totalRevenue'), yrSpan);
        add(`Revenue compounding over ${yrSpan.toFixed(1)} years`, revC === null ? null : revC > 4, revC === null ? '' : revC.toFixed(1) + '%/yr');
        const ni = (y) => get(y, 'income', 'netIncome');
        add('Profitable every year, last five', span(5).length >= 5 && span(5).every(y=>ni(y)!==null) ? span(5).every(y=>ni(y)>0) : null, '');
        const nmOf = (y) => ratio(ni(y), get(y, 'income', 'totalRevenue'));
        const nmNow = nmOf(last); const nm5 = years.length > 5 ? nmOf(years[years.length - 6]) : null;
        if (nmNow !== null && nm5 !== null && Math.abs(nmNow - nm5) > 0.02) {
            add('Net margin direction, five years', nmNow > nm5, `${pct(nm5 * 100)} → ${pct(nmNow * 100)}`);
        }
        add('Net margin above 10%', nmNow === null ? null : nmNow > 0.10, nmNow === null ? '' : pct(nmNow * 100));
        const cashRaw = get(last, 'balance', 'cashAndCashEquivalentsAtCarryingValue');
        const cash = cashRaw;
        const debt = debtOf(last.balance || {});
        add('Cash and cash equivalents exceed borrowing debt', cashRaw === null || debt === null ? null : cash > debt, `${currencyAmount(cash, reportingCurrency())} vs ${currencyAmount(debt, reportingCurrency())}; short-term investments excluded`);
        add('Operating cash flow positive, five years', span(5).length >= 5 && span(5).every(y=>get(y,'cash','operatingCashflow')!==null) ? span(5).every(y=>get(y,'cash','operatingCashflow')>0) : null, '');
        const fcfN = fcfOf(last.cash || {});
        if (!noFcf()) add('Free cash flow positive, latest year', fcfN === null ? null : fcfN > 0, fcfN === null ? '' : currencyAmount(fcfN, reportingCurrency()));
        const sh = (y) => get(y, 'balance', 'commonStockSharesOutstanding');
        const shWin = span(Math.min(6, years.length)).filter((y) => sh(y) !== null);
        if (shWin.length >= 3) {
            const d = (sh(shWin[shWin.length - 1]) / sh(shWin[0]) - 1) * 100;
            add(`Share count falling over ${shWin.length - 1} years`, d < 0, (d <= 0 ? '' : '+') + d.toFixed(0) + '%');
        }
        const div = (y) => get(y, 'cash', 'dividendPayout');
        const hasDiv = years.some((y) => div(y) !== null);
        let streak = 0;
        for (let i = years.length - 1; i >= 0; i--) { const dd = div(years[i]); if (dd !== null && dd !== 0) streak++; else break; }
        add('Pays a dividend', hasDiv ? streak > 0 : null, streak > 0 ? `${streak} consecutive yrs in our data` : '');
        // Do buybacks return cash to owners, or only replace the stock handed to
        // staff? Omitted unless both sides were filed (see sbc-model.js).
        const sbcCheck = (sbcBuilt() || {}).check;
        if (sbcCheck) add('Buybacks exceed stock paid to staff, five years', sbcCheck.pass, `${currencyAmount(sbcCheck.buybacks, reportingCurrency())} vs ${currencyAmount(sbcCheck.sbc, reportingCurrency())}`);
        return checks;
    }
    // ---------- ⑥a stock-based compensation ----------
    // The model (assets/sbc-model.js) is the only place the arithmetic lives;
    // this block feeds it the filed annual rows and draws what comes back.
    let sbcCache;
    function sbcBuilt() {
        if (sbcCache !== undefined) return sbcCache;
        if (!window.SBCModel || !payload) return (sbcCache = null);
        const rows = annualJoined().map((y) => {
            const c = y.cash || {}; const i = y.income || {};
            return {
                end: y.end, start: c.periodStart || i.periodStart || null, sbc: num(c.shareBasedCompensation), rev: derive(i).rev,
                ocf: num(c.operatingCashflow), capex: num(c.capitalExpenditures),
                buy: num(c.paymentsForRepurchaseOfCommonStock), dil: num(i.weightedAverageSharesDiluted),
                sourceId: ((c._sources || {}).shareBasedCompensation || [])[0] || null
            };
        });
        return (sbcCache = window.SBCModel.build(rows, { fcf: !noFcf() }));
    }
    function sbcChart(trend, cur) {
        const W = 760, H = 160, padL = 8, padB = 22, padT = 18;
        const bw = (W - padL * 2) / trend.length;
        const maxS = Math.max(...trend.map((t) => t.sbc), 0) || 1;
        const pcts = trend.map((t) => t.pctRevenue);
        const maxP = (Math.max(...pcts.filter((v) => v !== null), 0) || 1) * 1.25;
        const cx = (i) => padL + i * bw + bw / 2;
        const py = (v) => H - padB - ((H - padB - padT) * v) / maxP;
        const bars = trend.map((t, i) => {
            const h = Math.max(0, ((H - padB - padT) * t.sbc) / maxS);
            const x = padL + i * bw + bw * 0.2; const w = bw * 0.6; const top = H - padB - h;
            const last = i === trend.length - 1;
            const tip = `${t.fy}: ${currencyAmount(t.sbc, cur)}${t.pctRevenue === null ? '' : (t.pctRevenue > 100 ? `, ${(t.pctRevenue / 100).toFixed(1)}× revenue` : `, ${pct(t.pctRevenue)} of revenue`)}`;
            return `<rect class="${last ? 'sbc-bar sbc-bar-now' : 'sbc-bar'}" x="${x.toFixed(1)}" y="${top.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="3"><title>${esc(tip)}</title></rect>`
                + `<text class="sbc-axis" x="${(x + w / 2).toFixed(1)}" y="${H - 6}" text-anchor="middle">${esc(t.tick)}</text>`
                + ((last || i === 0) ? `<text class="sbc-val" x="${(x + w / 2).toFixed(1)}" y="${(top - 5).toFixed(1)}" text-anchor="middle">${esc(currencyAmount(t.sbc, cur))}</text>` : '');
        }).join('');
        // The line breaks across a year with no filed revenue rather than
        // bridging it.
        let line = ''; let run = [];
        const flush = () => { if (run.length > 1) line += `<polyline class="sbc-line" points="${run.join(' ')}"/>`; run = []; };
        trend.forEach((t, i) => { if (t.pctRevenue === null) flush(); else run.push(`${cx(i).toFixed(1)},${py(t.pctRevenue).toFixed(1)}`); });
        flush();
        const dots = trend.map((t, i) => (t.pctRevenue === null ? '' : `<circle class="sbc-dot" cx="${cx(i).toFixed(1)}" cy="${py(t.pctRevenue).toFixed(1)}" r="2.6"/>`)).join('');
        return `<svg class="sbc-chart" viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="Stock-based compensation by fiscal year">${bars}${line}${dots}</svg>`;
    }
    function renderSbc() {
        const m = sbcBuilt();
        // No SBC line in any filed year: say so once, plainly, in place of the
        // figures. No model at all (script missing): leave the section hidden.
        if (!m) return;
        const show = () => { $('sbc-rule').hidden = false; $('sbc-section').hidden = false; };
        const cur = reportingCurrency();
        const amt = (v) => currencyAmount(v, cur);
        if (m.status !== 'ok') {
            $('sbc-source').textContent = '';
            // An older figure is named with its year, never drawn as the current one.
            const last = m.status === 'stale' && m.lastSbc !== null ? ` It was ${esc(amt(m.lastSbc))} in ${esc(m.lastFy)}.` : '';
            $('sbc-body').innerHTML = `<p class="muted" style="margin:0;">${esc(m.why)}${last}</p>`;
            show();
            return;
        }
        // Above 100% a percentage stops reading as a share: a pre-revenue company
        // paying 23 times its revenue in stock is told as a multiple.
        const share = (v) => (v > 100 ? `${(v / 100).toFixed(1)}×` : pct(v));
        const ofRevenue = (v) => (v > 100 ? `${share(v)} revenue` : `${share(v)} of revenue`);
        const signed = (v) => (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(1) + '%';
        const name = (payload.overview && payload.overview.Name) || symbol;
        const src = ((payload.provenance || {}).sources || {})[m.sourceId] || null;
        $('sbc-source').innerHTML = src && src.filingUrl
            ? `<a rel="nofollow noopener" target="_blank" href="${esc(src.filingUrl)}">${esc(m.fy)} · from the ${esc(src.form || 'filing')}${src.filingDate ? ` filed ${esc(src.filingDate)}` : ''} ↗</a>`
            : esc(m.fy);

        const rows = [];
        const row = (k, v, d, sub) => rows.push(`<tr><td class="k${sub ? ' sub' : ''}">${k}</td><td class="v">${v}</td><td class="d">${d}</td></tr>`);
        if (m.noFcf) { /* a bank or life insurer: no free cash flow row */ }
        else if (m.fcf === null) row('Free cash flow', '—', esc(m.fcfWhy));
        else {
            row('Free cash flow', esc(amt(m.fcf)), 'as reported: operating cash flow less capital expenditure');
            // Not drawn against a net reversal: there is no stock cost to take off.
            if (m.fcfAfter !== null) {
                row('after paying staff in stock', esc(amt(m.fcfAfter)),
                    m.pctOfFcf !== null
                        ? (m.pctOfFcf > 100
                            ? `stock-based compensation is <strong>${esc((m.pctOfFcf / 100).toFixed(1))}×</strong> free cash flow`
                            : `stock-based compensation is <strong>${esc(pct(m.pctOfFcf, 0))}</strong> of free cash flow`)
                        : 'free cash flow is negative before stock pay is counted', true);
            }
        }
        // Buybacks appear only when the company filed some: no row is better than
        // a dash that reads as "bought back nothing".
        if (m.buybacks !== null && m.buybacks > 0) {
            row('Buybacks', esc(amt(m.buybacks)), m.buybackOffsetPct === null
                ? 'bought back in the year'
                : m.buybackOffsetPct >= 100
                    ? `less than the <strong>${esc(amt(m.sbc))}</strong> of stock issued to staff`
                    : `of which <strong>${esc(amt(m.sbc))}</strong> (${esc(pct(m.buybackOffsetPct, 0))}) offset stock issued to staff`);
        }
        if (m.dilutionYoY === null) row('Diluted shares', '—', esc(m.dilutionWhy));
        else row('Diluted shares', esc(signed(m.dilutionYoY)), 'this year' + (m.dilutionFive === null ? '' : ` · <strong>${esc(signed(m.dilutionFive))}</strong> over five years`));

        const first = m.trend[0]; const firstPct = first ? first.pctRevenue : null;
        // One row per filed year: can free cash flow pay for stock pay and still
        // leave the share count lower? The verdict strings come from the model.
        const flowRows = (m.years || []).slice().reverse();
        const flowDash = (why) => `<span class="ind-dash" title="${esc(why || '')}">—</span>`;
        const withFcf = !m.noFcf;
        const flow = flowRows.length ? `<div class="sbc-flow">
          <p class="sbc-flow-summary">${esc(m.verdict)}</p>
          ${withFcf ? '' : `<p class="small muted" style="margin:0 0 8px;">${esc(window.IndustryMetrics.NO_FCF)}</p>`}
          <table class="sbc-years">
            <thead><tr><th>Fiscal year</th>${withFcf ? '<th>FCF</th>' : ''}<th>SBC</th>${withFcf ? '<th>FCF after SBC</th>' : ''}<th>Buybacks</th><th>Diluted shares</th><th>Verdict</th></tr></thead>
            <tbody>${flowRows.map((y) => `<tr>
              <td data-label="Fiscal year"><strong>${esc(y.fy)}</strong></td>
              ${withFcf ? `<td data-label="FCF">${y.fcf === null ? flowDash(y.verdict) : esc(amt(y.fcf))}</td>` : ''}
              <td data-label="SBC">${y.sbc === null ? flowDash(y.verdict) : esc(amt(y.sbc))}</td>
              ${withFcf ? `<td data-label="FCF after SBC">${y.fcfAfter === null ? '—' : esc(amt(y.fcfAfter))}</td>` : ''}
              <td data-label="Buybacks">${y.buybacks === null ? flowDash(`Not available: share buybacks for ${y.fy} are not in our filings data.`) : esc(amt(y.buybacks))}</td>
              <td data-label="Diluted shares">${y.dilutionPct === null ? flowDash(y.dilutionWhy) : esc(signed(y.dilutionPct))}</td>
              <td data-label="Verdict" class="sbc-verdict">${esc(y.verdict)}</td>
            </tr>`).join('')}</tbody>
          </table>
        </div>` : '';
        $('sbc-body').innerHTML = `
          ${m.stale ? `<p class="small muted" style="margin:0 0 10px;">${esc(m.stale)}</p>` : ''}
          <div class="sbc-top">
            <div><div class="sbc-big">${esc(amt(m.sbc))}</div><div class="sbc-sub">${m.reversal ? `net reversal of stock pay, ${esc(m.fy)}: more was cancelled than expensed` : `paid to staff in stock, ${esc(m.fy)}`}</div></div>
            <div>${m.pctRevenue === null
                ? `<div class="sbc-mid">—</div><div class="sbc-sub">${esc(m.pctRevenueWhy || '')}</div>`
                : `<div class="sbc-mid">${esc(ofRevenue(m.pctRevenue))}</div><div class="sbc-sub">${m.pctRevenueFiveAgo === null ? '&nbsp;' : `${esc(ofRevenue(m.pctRevenueFiveAgo))} in ${esc(m.fiveAgoFy)}`}</div>`}</div>
            <div class="sbc-rank" id="sbc-rank"></div>
          </div>
          ${m.trend.length > 1 ? sbcChart(m.trend, cur) + `<div class="sbc-legend"><span><i></i>Stock-based compensation</span>${firstPct === null || m.pctRevenue === null ? '' : `<span><i class="l"></i>As a share of revenue (${esc(share(firstPct))} → ${esc(share(m.pctRevenue))})</span>`}</div>` : ''}
          <table class="sbc-rows">${rows.join('')}</table>
          ${flow}
          <p class="provenance">Every figure is the company's own filed number or arithmetic on filed numbers.${withFcf ? ` Free cash flow after stock-based compensation is our calculation, not a figure ${esc(name)} reports.` : ''}</p>`;
        show();

        // Sector position: one small request, and the line is simply absent if
        // the sector is unknown or too small to rank against.
        const sector = payload.overview && payload.overview.Sector;
        if (sector && m.pctRevenue !== null) {
            fetch(`${API}/sbc/sector-rank?sector=${encodeURIComponent(sector)}&pct=${encodeURIComponent(m.pctRevenue.toFixed(4))}`)
                .then((r) => (r.ok ? r.json() : null))
                .then((d) => {
                    const el = $('sbc-rank');
                    if (!el || !d || !d.rank) return;
                    el.innerHTML = `Higher than <strong>${esc(String(d.rank.higherThanPct))}%</strong> of ${esc(sector)} companies<br><span class="sbc-sub">sector median ${esc(pct(d.rank.median))} · ${esc(String(d.rank.n))} companies in our data</span>`;
                })
                .catch(() => {});
        }
    }

    // ---------- ⑥a2 bank and insurer metrics ----------
    // Gross margin and operating margin are not reported by banks and insurers.
    // The arithmetic lives in assets/industry-metrics.js; this block only draws
    // what that model returns, with each missing input's reason attached.
    function renderIndustryMetrics() {
        if (!window.IndustryMetrics || !payload) return;
        const m = window.IndustryMetrics.build(payload);
        if (!m || !m.rows.length) return;
        const cur = reportingCurrency();
        const amt = (v) => currencyAmount(v, cur);
        const perShare = (v) => currencyAmount(v, cur, { compact: false });
        const dash = (row, key) => `<span class="ind-dash" title="${esc((row.why || {})[key] || '')}">—</span>`;
        const pctCell = (row, key) => row.values[key] === null ? dash(row, key) : esc(pct(row.values[key]));
        const moneyCell = (row, key) => row.values[key] === null ? dash(row, key) : esc(amt(row.values[key]));
        const signedCell = (row, key) => row.values[key] === null ? dash(row, key) : esc((row.values[key] >= 0 ? '+' : '') + row.values[key].toFixed(1) + '%');
        const cells = (row) => {
            if (m.kind === 'bank') return [
                ['Net interest income', moneyCell(row, 'netInterestIncome'), 'netInterestIncome'],
                ['Net interest income growth', signedCell(row, 'netInterestIncomeGrowthPct'), 'netInterestIncomeGrowthPct'],
                [row.values.nimBasis === 'interest-earning assets' ? 'Net interest margin' : 'NII / average total assets', pctCell(row, 'netInterestMarginPct'), 'netInterestMarginPct'],
                ['Efficiency ratio', pctCell(row, 'efficiencyPct'), 'efficiencyPct'],
                ['Loans / deposits (year-end)', pctCell(row, 'loansToDepositsPct'), 'loansToDepositsPct'],
                ['Provision / average loans', pctCell(row, 'provisionToLoansPct'), 'provisionToLoansPct'],
                ['ROA (average assets)', pctCell(row, 'roaPct'), 'roaPct'],
                ['ROE (average equity)', pctCell(row, 'roePct'), 'roePct'],
                ['Equity / assets (year-end)', pctCell(row, 'equityToAssetsPct'), 'equityToAssetsPct']
            ];
            const list = [
                ['Premiums earned', moneyCell(row, 'premiumsEarned'), 'premiumsEarned'],
                ['Premium growth', signedCell(row, 'premiumsGrowthPct'), 'premiumsGrowthPct']
            ];
            if (m.showCombinedRatio) list.push(
                ['Loss ratio', pctCell(row, 'lossRatioPct'), 'lossRatioPct'],
                ['Expense ratio', pctCell(row, 'expenseRatioPct'), 'expenseRatioPct'],
                ['Combined ratio', pctCell(row, 'combinedRatioPct'), 'combinedRatioPct']);
            list.push(
                ['Net investment income', moneyCell(row, 'netInvestmentIncome'), 'netInvestmentIncome'],
                ['ROE (average equity)', pctCell(row, 'roePct'), 'roePct'],
                [row.values.bookValueBasis === 'diluted weighted-average shares' ? 'Book value / diluted share' : 'Book value / year-end share',
                    row.values.bookValuePerShare === null ? dash(row, 'bookValuePerShare') : esc(perShare(row.values.bookValuePerShare)), 'bookValuePerShare']);
            return list;
        };
        const latest = m.latest;
        const parts = [];
        if (m.kind === 'bank') {
            if (latest.values.netInterestIncome !== null) parts.push(`net interest income ${amt(latest.values.netInterestIncome)}`);
            if (latest.values.efficiencyPct !== null) parts.push(`efficiency ratio ${pct(latest.values.efficiencyPct)}`);
            if (latest.values.roePct !== null) parts.push(`ROE ${pct(latest.values.roePct)}`);
        } else {
            if (latest.values.premiumsEarned !== null) parts.push(`premiums earned ${amt(latest.values.premiumsEarned)}`);
            if (latest.values.combinedRatioPct !== null) parts.push(`combined ratio ${pct(latest.values.combinedRatioPct)}`);
            if (latest.values.netInvestmentIncome !== null) parts.push(`net investment income ${amt(latest.values.netInvestmentIncome)}`);
            if (latest.values.roePct !== null) parts.push(`ROE ${pct(latest.values.roePct)}`);
        }
        // A metric with no value in any year is named once, not drawn as a row of dashes.
        const empty = new Set(window.IndustryMetrics.emptyKeys(m));
        const shown = (row) => cells(row).filter(([, , key]) => !empty.has(key));
        const emptyLabels = cells(m.rows[0]).filter(([, , key]) => empty.has(key)).map(([label]) => label.toLowerCase());
        const missing = [...new Set(m.rows.flatMap((row) => Object.entries(row.why || {}).filter(([key]) => !empty.has(key)).map(([, why]) => why)).filter(Boolean))];
        const notFiled = emptyLabels.length
            ? `<p class="ind-note">${esc(`Not shown: ${emptyLabels.join(', ').replace(/, ([^,]*)$/, ' and $1')}. The filings for these years do not carry the lines ${emptyLabels.length > 1 ? 'they need' : 'it needs'}.`)}</p>` : '';
        const note = m.kind === 'insurer' && !m.showCombinedRatio
            ? `<p class="ind-note">${esc(m.insurerType === 'health' ? 'Health insurers' : 'Life insurers')} do not report a combined ratio; premiums, investment income, ROE and book value are shown instead.</p>` : '';
        $('industry-title').textContent = m.label;
        const annual = payload.coverage && payload.coverage.latestAnnual;
        const fdic = (payload.supplementalObservations || [])
            .filter((f) => /^FDIC/.test(f.sourceName || '') && (f.historyBasis || f.basis) === 'annual')
            .sort((a, b) => String(b.periodEnd).localeCompare(String(a.periodEnd)))[0];
        const link = (url, text) => url ? `<a rel="nofollow noopener" target="_blank" href="${esc(url)}">${esc(text)} ↗</a>` : esc(text);
        $('industry-source').innerHTML = /SEC/.test(m.basis || '') && annual && annual.filingUrl
            ? link(annual.filingUrl, `${latest.fy} · ${annual.form || 'filing'}${annual.filingDate ? ` filed ${annual.filingDate}` : ''}`)
            : fdic ? link(fdic.sourceUrl, `${fdic.sourceName} · ${fdic.periodEnd}`) : esc(latest.fy);
        $('industry-body').innerHTML = `
          <p class="ind-summary">${esc(`${latest.fy}: ${parts.join(' · ')}`)}</p>
          ${note}${notFiled}
          <div class="ind-years">${m.rows.map((row) => `<div class="ind-year"><div class="ind-year-head">${esc(row.fy)}</div>${shown(row).map(([label, value, key]) => `<div class="ind-cell"><span>${esc(label)}</span><b class="${row.values[key] === null ? 'ind-null' : ''}">${value}</b></div>`).join('')}</div>`).join('')}</div>
          ${missing.length ? `<details class="ind-missing"><summary>Why a figure is missing</summary><ul>${missing.slice(0, 10).map((why) => `<li>${esc(why)}</li>`).join('')}</ul></details>` : ''}
          <p class="provenance">Computed from filed annual statements. Ratios that divide a flow by a balance use the average of the opening and closing balances; the panel labels that basis. No estimates.</p>`;
        $('industry-rule').hidden = false;
        $('industry-section').hidden = false;
    }

    function renderChecks() {
        const checks = buildChecks();
        if (!checks.length) return;
        const passed = checks.filter((c) => c.pass).length;
        $('checks-score').textContent = `${passed} of ${checks.length} passed · computed from filings — not advice`;
        $('health-list').innerHTML = checks.map((c) => `
          <div class="health-item ${c.pass ? 'health-pass' : 'health-fail'}">
            <span class="health-mark">${c.pass ? '✓' : '✕'}</span>
            <span class="health-label">${esc(c.label)}</span>
            <span class="health-detail">${esc(c.detail)}</span>
          </div>`).join('');
        $('checks-section').hidden = false;
    }
    // Filing diff ("What changed") moved to the Filing Monitor page — removed here.

    // ---------- ③b what's priced in (reverse DCF) ----------
    const bn = (v) => currencyAmount(v, quoteCurrency());
    const gp = (v) => v === null || v === undefined ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%/yr';
    async function loadReverseDcf(opts = {}) {
        const sec = $('rdcf-section'); const body = $('rdcf-body'); const rule = $('rdcf-rule');
        // The reverse DCF solves for free cash flow growth, which a bank or life insurer does not have.
        if (noFcf()) { sec.hidden = true; rule.hidden = true; return; }
        if (hasCurrencyMismatch()) {
            body.innerHTML = `<p class="small muted" style="max-width:72ch;">Unavailable for this listing: its market quote is in <strong>${esc(quoteCurrency())}</strong>, while its source financial statements are reported in <strong>${esc(sourceReportingCurrency())}</strong>. The USD presentation conversion does not supply the listing’s depositary-share ratio, which is required for a defensible per-listed-share valuation.</p>`;
            sec.hidden = false; rule.hidden = false;
            return;
        }
        const teaser = () => {
            body.innerHTML = `<p class="small muted" style="max-width:64ch;">What growth rate does today's price assume? We solve it from the filings and put it next to the company's actual record — <a href="/login.html">log in</a> or <a href="/register.html">start a trial</a> to see it.</p>`;
            sec.hidden = false; rule.hidden = false;
        };
        if (!token()) { teaser(); return; } // signed out: show the teaser without a doomed 401 request
        try {
            const q = new URLSearchParams();
            if (opts.r) q.set('r', opts.r);
            if (opts.tg) q.set('tg', opts.tg);
            if (opts.base) q.set('base', opts.base);
            const resp = await fetch(`${API}/company/${encodeURIComponent(symbol)}/reverse-dcf?${q}`,
                { headers: { Authorization: `Bearer ${token()}` } });
            if (resp.status === 401 || resp.status === 402) { teaser(); return; }
            if (!resp.ok) { sec.hidden = true; rule.hidden = true; return; }
            const d = await resp.json();
            const a = d.assumptions || {};
            const rec = d.record || {};
            const verdictNum = d.impliedGrowthPct;
            const headline = verdictNum === null
                ? (d.priced === 'beyond-model' ? '>100%/yr' : 'n/a')
                : gp(verdictNum);
            body.innerHTML = `
              <div style="display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:16px;">
                <div class="card card-pad">
                  <p class="label" style="margin-bottom:6px;">Priced-in FCF growth</p>
                  <div style="font-size:30px; font-weight:650; letter-spacing:-0.02em; font-variant-numeric:tabular-nums;">${headline}</div>
                  <p class="small muted" style="margin-top:6px;">for ${a.horizonYears || 10} years, to justify ${bn(d.marketCap)} today at a ${a.discountRatePct}% discount rate (${a.terminalGrowthPct}% terminal growth). Base FCF ${bn(d.fcfBase)} — ${esc(d.fcfBasis || '')}.</p>
                </div>
                <div class="card card-pad">
                  <p class="label" style="margin-bottom:6px;">The filed record</p>
                  <table class="table-data rdcf-rec" style="font-size:13px;">
                    <tr><td>FCF growth, 5 yrs</td><td class="num">${gp(rec.fcfCagr5Pct)}</td></tr>
                    <tr><td>FCF growth, 10 yrs</td><td class="num">${gp(rec.fcfCagr10Pct)}</td></tr>
                    <tr><td>Revenue growth, 5 yrs</td><td class="num">${gp(rec.revCagr5Pct)}</td></tr>
                    <tr><td>Revenue growth, 10 yrs</td><td class="num">${gp(rec.revCagr10Pct)}</td></tr>
                  </table>
                </div>
                <div class="card card-pad">
                  <p class="label" style="margin-bottom:6px;">Your assumptions</p>
                  <div style="display:grid; gap:10px; font-size:13px;">
                    <label style="display:flex; justify-content:space-between; align-items:center; gap:8px;">Discount rate
                      <input class="input" id="rdcf-r" type="number" min="5" max="25" step="0.5" value="${a.discountRatePct}" style="width:84px; text-align:right;" />%</label>
                    <label style="display:flex; justify-content:space-between; align-items:center; gap:8px;">Terminal growth
                      <input class="input" id="rdcf-tg" type="number" min="0" max="4" step="0.25" value="${a.terminalGrowthPct}" style="width:84px; text-align:right;" />%</label>
                    <label style="display:flex; justify-content:space-between; align-items:center; gap:8px;">FCF base
                      <select class="input" id="rdcf-base" style="width:140px;">
                        <option value="latest"${opts.base === 'avg3' ? '' : ' selected'}>Latest year</option>
                        <option value="avg3"${opts.base === 'avg3' ? ' selected' : ''}>3-year average</option>
                      </select></label>
                    <button class="btn btn-ghost btn-sm" id="rdcf-go">Recalculate</button>
                  </div>
                </div>
              </div>
              <p class="provenance" style="margin-top:12px;">${(d.notes || []).map(esc).join(' ')} Not a fair value and not advice — a translation of today's price into a growth assumption you can judge.</p>`;
            sec.hidden = false; rule.hidden = false;
            const go = () => loadReverseDcf({
                r: document.getElementById('rdcf-r').value,
                tg: document.getElementById('rdcf-tg').value,
                base: document.getElementById('rdcf-base').value
            });
            document.getElementById('rdcf-go').addEventListener('click', go);
        } catch (_) { sec.hidden = true; rule.hidden = true; }
    }

    // ---------- ④ peers + compare ----------
    async function renderPeers() {
        try {
            // Same industry, closest in market value — not the sector's largest
            // companies, which put Nvidia and Apple beside every software firm.
            const r = await fetch(`/api/company/${encodeURIComponent(symbol)}/peers`);
            if (!r.ok) return;
            const data = await r.json();
            if (!data.self || !(data.peers || []).length) return;
            const med = (key) => (data.median || {})[key] ?? null;
            const group = data.group || {};
            const rows = [data.self].concat(data.peers);
            const cell = (v, f, colored) => v === null || v === undefined ? '—'
                : `<span class="${colored && v !== 0 ? (v > 0 ? 'delta-pos' : 'delta-neg') : ''}">${f(v)}</span>`;
            let html = `<thead><tr><th class="row-head" style="text-align:left;">Company</th><th>Mkt cap</th><th>P/E</th><th>Rev CAGR 5y</th><th>Profit growth YoY</th><th>Net margin</th><th>ROE</th><th>Div yield</th><th>Profit yrs/10</th></tr></thead><tbody>`;
            for (const x of rows) {
                const hl = x === data.self;
                html += `<tr data-sym="${esc(x.symbol)}" style="${hl ? 'font-weight:650;' : ''}">
                  <td class="row-head">${hl ? esc(x.symbol) : `<a href="/company.html?symbol=${encodeURIComponent(x.symbol)}" target="_blank" rel="noopener">${esc(x.symbol)}</a>`}&ensp;<span class="muted" style="font-weight:400;">${esc(x.name || '')}</span></td>
                  <td data-label="Mkt cap">${x.marketCapB === null ? '—' : '$' + money(x.marketCapB * 1e9)}</td>
                  <td data-label="P/E">${fixed(x.pe, 1)}</td>
                  <td data-label="Rev CAGR 5y">${cell(x.revCagr5Pct, (v) => pct(v), true)}</td>
                  <td data-label="Profit growth YoY">${cell(x.qtrNetIncomeYoYPct, (v) => pct(v), true)}</td>
                  <td data-label="Net margin">${cell(x.netMarginPct, (v) => pct(v))}</td>
                  <td data-label="ROE">${cell(x.roePct, (v) => pct(v))}</td>
                  <td data-label="Div yield">${x.divYieldPct === null ? '—' : pct(x.divYieldPct, 2)}</td>
                  <td data-label="Profit yrs">${x.profitableYears10 ?? '—'}/10</td>
                </tr>`;
            }
            html += `<tr class="row-rule"><td class="row-head muted">Median · ${group.count} companies</td>
              <td class="muted" data-label="Mkt cap">${med('marketCapB') === null ? '—' : '$' + money(med('marketCapB') * 1e9)}</td>
              <td class="muted" data-label="P/E">${fixed(med('pe'), 1)}</td>
              <td class="muted" data-label="Rev CAGR 5y">${pct(med('revCagr5Pct'))}</td>
              <td class="muted" data-label="Profit growth YoY">${pct(med('qtrNetIncomeYoYPct'))}</td>
              <td class="muted" data-label="Net margin">${pct(med('netMarginPct'))}</td>
              <td class="muted" data-label="ROE">${pct(med('roePct'))}</td>
              <td class="muted" data-label="Div yield">${med('divYieldPct') === null ? '—' : pct(med('divYieldPct'), 2)}</td>
              <td class="muted" data-label="Profit yrs">${med('profitableYears10') ?? '—'}/10</td></tr></tbody>`;
            const table = $('peers-table');
            table.innerHTML = html;
            // Grouped by the largest filed business line where the annual report breaks
            // revenue down (company-peers.js); the sub-line names that line.
            const by = group.line ? `by largest line, ${group.line.name} (${fixed(group.line.sharePct, 0)}% of revenue) · ` : '';
            $('peers-sub').textContent = by + String(group.label || '').toLowerCase() + ' · closest in market value · median of ' + group.count;
            // Navigate on a genuine TAP only. A horizontal swipe to scroll the
            // table used to register as a click and yank you to another company,
            // which made the table feel like it couldn't be scrolled on a phone.
            let pStart = null;
            table.addEventListener('pointerdown', (e) => { pStart = { x: e.clientX, y: e.clientY }; });
            table.querySelectorAll('tr[data-sym]').forEach((tr) =>
                tr.addEventListener('click', (e) => {
                    if (pStart && (Math.abs(e.clientX - pStart.x) > 8 || Math.abs(e.clientY - pStart.y) > 8)) return;
                    // A peer always opens in a new tab (owner, 2026-10-19), so the
                    // company being read stays where it was. The ticker link does it itself.
                    if (e.target.closest('a')) return;
                    if (tr.dataset.sym !== symbol) window.open(`/company.html?symbol=${encodeURIComponent(tr.dataset.sym)}`, '_blank', 'noopener');
                }));
            $('peers-section').hidden = false;
            attachHScroll(table.closest('.table-wrap'));
        } catch (_) { /* enrichment */ }
    }

    const CMP_METRICS = [
        { label: 'Market cap', get: (p) => currencyAmount((p.overview || {}).MarketCapitalization, quoteCurrency(p)) },
        { label: 'P/E', get: (p) => fixed((p.overview || {}).PERatio, 1) },
        { label: 'Revenue (latest FY)', get: (p) => currencyAmount(derive(((p.income || {}).annualReports || [])[0] || {}).rev, reportingCurrency(p)) },
        { label: 'Revenue CAGR (5y)', get: (p) => { const a = ((p.income || {}).annualReports || []); const b = Math.min(5, a.length - 1); const c = cagr(derive(a[b] || {}).rev, derive(a[0] || {}).rev, b); return c === null ? '—' : signedPct(c); } },
        { label: 'Gross margin', get: (p) => { const r = ((p.income || {}).annualReports || [])[0] || {}; const d = derive(r); return pctFmt(ratio(d.gp, d.rev)); } },
        { label: 'Net margin', get: (p) => { const r = ((p.income || {}).annualReports || [])[0] || {}; return pctFmt(ratio(num(r.netIncome), derive(r).rev)); } },
        { label: 'FCF margin', get: (p) => { if (noFcf(p)) return '—'; const c = ((p.cash || {}).annualReports || [])[0] || {}; const r = ((p.income || {}).annualReports || [])[0] || {}; return pctFmt(ratio(fcfForRevenue(r, c), derive(r).rev)); } },
        { label: 'Return on equity', get: (p) => { const i = ((p.income || {}).annualReports || [])[0] || {}; const b = ((p.balance || {}).annualReports || [])[0] || {}; return pctFmt(ratio(num(i.netIncome), num(b.totalShareholderEquity))); } },
        { label: 'Dividend yield', get: (p) => { const d = num((p.overview || {}).DividendYield); return d === null ? '—' : pct(d * 100, 2); } }
    ];
    async function loadCompare(other) {
        const sym2 = other.toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
        if (!sym2 || sym2 === symbol) return;
        $('cmp-body').hidden = false;
        $('cmp-table').innerHTML = '<tbody><tr><td style="text-align:left" class="faint"><span class="loading-line"><span class="spin" aria-hidden="true"></span>Loading…</span></td></tr></tbody>';
        try {
            const r = await fetch(`/api/demo/alpha/fundamentals/${encodeURIComponent(sym2)}?presentationCurrency=USD`);
            if (!r.ok) throw new Error('nope');
            const p2 = await r.json();
            let html = `<thead><tr><th class="row-head" style="text-align:left;">Metric</th><th>${esc(symbol)}</th><th>${esc(sym2)}</th></tr></thead><tbody>`;
            for (const m of CMP_METRICS) {
                let a = '—'; let b = '—';
                try { a = m.get(payload); } catch (_) { /* dash */ }
                try { b = m.get(p2); } catch (_) { /* dash */ }
                if (a === '—' && b === '—') continue;
                html += `<tr><td class="row-head">${m.label}</td><td>${a}</td><td>${b}</td></tr>`;
            }
            $('cmp-table').innerHTML = html + '</tbody>';
            attachHScroll($('cmp-table').closest('.table-wrap'));
            const s1 = monthlySeries(payload); const s2 = monthlySeries(p2);
            const start = [s1[0], s2[0]].map((p) => p && p.month).sort().pop();
            const w1 = s1.filter((p) => p.month >= start).slice(-120);
            const w2map = new Map(s2.filter((p) => p.month >= start).slice(-120).map((p) => [p.month, p.close]));
            const months = w1.map((p) => p.month).filter((m) => w2map.has(m));
            if (months.length > 12) {
                const base1 = w1.find((p) => p.month === months[0]).close;
                const base2 = w2map.get(months[0]);
                const v1 = months.map((m) => w1.find((p) => p.month === m).close / base1 * 100);
                const v2 = months.map((m) => w2map.get(m) / base2 * 100);
                $('cmp-chart').innerHTML = chart(
                    [{ values: v1, cls: 'ink' }, { values: v2, cls: 'accent' }],
                    months.map((m) => m.slice(0, 4)),
                    { fmt: (v) => Math.round(v), height: 230 }
                );
                $('cmp-prov').innerHTML = `<span style="color:var(--ink)">▬</span> ${esc(symbol)} &nbsp; <span style="color:var(--accent)">▬</span> ${esc(sym2)} — monthly adjusted closes indexed to 100 at ${months[0]}.`;
            } else { $('cmp-chart').innerHTML = ''; $('cmp-prov').textContent = ''; }
            const url = new URL(location.href);
            url.searchParams.set('vs', sym2);
            history.replaceState(null, '', url);
        } catch (_) {
            $('cmp-table').innerHTML = `<tbody><tr><td style="text-align:left" class="faint">No data for ${esc(sym2)} — we couldn't find filings for that ticker.</td></tr></tbody>`;
        }
    }
    (function wireCmpSearch() {
        const input = $('cmp-input');
        const results = $('cmp-results');
        let items = [];
        input.addEventListener('input', async () => {
            const q = input.value.trim().toUpperCase();
            if (q.length < 1) { results.hidden = true; return; }
            const list = await companies();
            items = list.filter((c) => c.symbol.startsWith(q))
                .concat(list.filter((c) => !c.symbol.startsWith(q) && (c.name || '').toUpperCase().includes(q)))
                .slice(0, 8);
            if (!items.length) {
                // The comparison table reads SEC fundamentals, so it stays
                // company-only — but say that instead of hiding the box. Typing
                // a fund (SCHG, VOO) used to look like a broken search.
                results.innerHTML = `<div class="nav-search-empty">No filings match “${esc(q)}”. Comparison covers SEC-filing companies, not funds.</div>`;
                results.hidden = false;
                return;
            }
            results.innerHTML = items.map((c) =>
                `<a href="#" data-sym="${esc(c.symbol)}"><span class="sym">${esc(c.symbol)}</span><span class="nm">${esc(c.name)}</span></a>`).join('');
            results.hidden = false;
            results.querySelectorAll('a').forEach((a) =>
                a.addEventListener('click', (e) => {
                    e.preventDefault();
                    results.hidden = true;
                    input.value = '';
                    loadCompare(a.dataset.sym);
                }));
        });
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') { e.preventDefault(); if (items[0]) { results.hidden = true; loadCompare(items[0].symbol); input.value = ''; } }
            if (e.key === 'Escape') results.hidden = true;
        });
    })();

    // ---------- ⑤ statements + growth cards ----------
    function reports(st, basis) {
        const node = (payload[st] || {});
        const arr = basis === 'annual' ? (node.annualReports || []) : (node.quarterlyReports || []);
        const cap = basis === 'annual' ? 19 : 12;
        return arr.slice(0, cap).slice().reverse();
    }
    function periodLabel(r, basis) {
        const d = new Date(r.fiscalDateEnding);
        if (Number.isNaN(+d)) return r.fiscalDateEnding;
        return basis === 'annual'
            ? `FY${d.getFullYear()}`
            : `${d.toLocaleString('en-US', { month: 'short' })} ’${String(d.getFullYear()).slice(2)}`;
    }
    function viewVals(def, raw, rows) {
        if (viewState === 'yoy' && (def.kind === 'money' || def.kind === 'ps' || def.kind === 'shares')) {
            return {
                vals: raw.map((v, i) => {
                    if (i === 0 || v === null || raw[i - 1] === null || raw[i - 1] === 0) return null;
                    if (raw[i - 1] < 0) return null;
                    return (v / raw[i - 1] - 1) * 100;
                }),
                fmt: signedPct, colored: true
            };
        }
        if (viewState === 'ps' && def.kind === 'money') {
            return {
                vals: raw.map((v, i) => {
                    // Keyed by the full period-end date (buildSharesMap); a month
                    // key matched nothing, so every cell read "—" (2026-10-19).
                    const sh = sharesBasis === 'current' ? null : sharesByPeriod.get(String(rows[i].fiscalDateEnding || ''));
                    return (v !== null && sh) ? v / sh : null;
                }),
                fmt: (v) => v === null ? '—' : '$' + fixed(v, 2), colored: false
            };
        }
        return { vals: raw, fmt: def.fmt, colored: false };
    }
    // statement-convention grouping: indented component rows fold under the
    // subtotal that PRECEDES them
    const expandedGroups = { income: new Set(), balance: new Set(), cash: new Set() }; // default: collapsed
    // A company that files no cost of revenue (Texas Roadhouse: food and beverage,
    // labor, rent and other operating, with no subtotal) shows the cost lines it
    // files between revenue and operating income, under its own labels and
    // headings (backend/filed-costs.js). Annual only: they come from 10-Ks.
    const FILED_GROUP = 900;
    let filedCostsOpened = false;
    function filedCostDefs(converted) {
        const fc = payload && payload.filedCosts;
        if (!fc || stState !== 'income' || basisState !== 'annual' || converted || fc.currency !== reportingCurrency()) return [];
        const at = (l) => (r) => { const v = l.values[r.fiscalDateEnding]; return typeof v === 'number' ? v : null; };
        const lines = fc.lines.filter((l) => !l.total);
        const total = fc.lines.find((l) => l.total);
        const blank = () => '';
        return [{ label: fc.heading || 'Costs and expenses', filed: true, get: total ? at(total) : () => null, fmt: total ? money : blank, kind: total ? 'money' : 'heading', heading: !total, neutral: true, title: `As filed in the ${fc.filing.form} (${fc.filing.accession}); the company files no cost of revenue` }]
            .concat(lines.map((l) => l.heading
                ? { label: l.label, get: () => null, fmt: blank, kind: 'heading', heading: true, sub: true, depth: l.depth }
                : { label: l.label, get: at(l), fmt: money, kind: 'money', sub: true, neutral: true, depth: l.depth }));
    }
    function statementDefs(converted) {
        const filed = filedCostDefs(converted);
        if (!filed.length) return noFcf() ? ROWS[stState].filter((d) => !d.fcf) : ROWS[stState];
        const at = ROWS.income.findIndex((d) => d.label === 'Cost of revenue') + 1;
        return ROWS.income.slice(0, at).concat(filed, ROWS.income.slice(at));
    }
    function groupDefs(defs, st) {
        const out = defs.map((d) => ({ ...d }));
        // a parent is a non-sub row immediately FOLLOWED by sub rows — its
        // components unfold below it
        let parent = null;
        let gid = -1;
        for (const d of out) {
            if (d.sub) {
                if (parent) {
                    // The filed cost lines exist only in the annual view; a fixed id
                    // keeps the other groups' ids, and their open state, the same in both.
                    if (parent.parentOf === undefined) { if (parent.filed) parent.parentOf = FILED_GROUP; else { gid++; parent.parentOf = gid; } }
                    d.gid = parent.parentOf;
                }
            } else {
                parent = d.solo ? null : d;
            }
        }
        return out;
    }
    function alignStatementYearColumns({ preservePosition = false } = {}) {
        const table = $('stmt-table');
        const wrap = $('stmt-wrap');
        const rowHead = table && table.querySelector('.row-head');
        const trendHead = table && !table.classList.contains('trend-hidden')
            ? table.querySelector('thead th:nth-child(2)')
            : null;
        if (!table || !wrap || !rowHead || !wrap.clientWidth) return;

        const oldMax = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
        const wasAtLatest = oldMax === 0 || oldMax - wrap.scrollLeft <= 4;
        const oldProgress = oldMax ? wrap.scrollLeft / oldMax : 1;
        const rowHeadWidth = rowHead.getBoundingClientRect().width;
        const trendWidth = trendHead ? trendHead.getBoundingClientRect().width : 0;
        const availableForYears = Math.max(1, wrap.clientWidth - rowHeadWidth - trendWidth);
        const completeYears = window.innerWidth <= 760
            ? (availableForYears >= 176 ? 2 : 1)
            : Math.max(3, Math.floor(availableForYears / 108));
        table.style.setProperty('--stmt-year-width', `${availableForYears / completeYears}px`);

        // Layout is synchronous for the width calculation. The metric and trend
        // columns stay pinned while the year area opens on the latest periods.
        // Resizes preserve the reader's current position.
        const newMax = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
        wrap.scrollLeft = preservePosition
            ? (wasAtLatest ? newMax : oldProgress * newMax)
            : newMax;
        const proxies = [$('stmt-scroll-top'), $('stmt-scroll-bottom')].filter(Boolean);
        for (const proxy of proxies) {
            if (!proxy.firstElementChild) continue;
            proxy.firstElementChild.style.width = wrap.scrollWidth + 'px';
            proxy.scrollLeft = wrap.scrollLeft;
        }
    }
    function statementMiniBars(values, periods, fmt) {
        const start = Math.max(0, values.length - 5);
        const points = values.slice(start).map((value, index) => ({
            value,
            period: periods[start + index] || ''
        }));
        const finite = points.map((point) => point.value).filter((value) => value !== null && Number.isFinite(value));
        if (finite.length < 2) return '<span class="stmt-mini-empty">—</span>';
        const min = Math.min(...finite);
        const max = Math.max(...finite);
        const span = max - min;
        const signed = viewState === 'yoy' || min < 0;
        const positiveMax = Math.max(0, max);
        const negativeMax = Math.abs(Math.min(0, min));
        const readable = (value) => String(fmt(value)).replace(/<[^>]*>/g, '');
        const aria = points
            .filter((point) => point.value !== null && Number.isFinite(point.value))
            .map((point) => `${point.period}: ${readable(point.value)}`)
            .join(', ');
        const bars = points.map((point, index) => {
            if (point.value === null || !Number.isFinite(point.value)) {
                return '<span class="stmt-mini-slot"><i class="stmt-mini-bar is-missing" aria-hidden="true"></i></span>';
            }
            const height = signed
                ? Math.max(3, (Math.abs(point.value) / (point.value < 0 ? (negativeMax || 1) : (positiveMax || 1))) * 13)
                : (span === 0 ? 17 : 7 + ((point.value - min) / span) * 21);
            const latest = index === points.length - 1 ? ' is-latest' : '';
            const direction = signed ? (point.value < 0 ? ' is-negative' : ' is-positive') : '';
            return `<span class="stmt-mini-slot"><i class="stmt-mini-bar${direction}${latest}" style="height:${height.toFixed(1)}px" title="${esc(point.period)}: ${esc(readable(point.value))}" aria-hidden="true"></i></span>`;
        }).join('');
        const signedClass = signed ? ' is-signed' : '';
        return `<span class="stmt-mini-bars${signedClass}" role="img" aria-label="${esc(basisState === 'annual' ? 'Five-year trend' : 'Five-quarter trend')}. ${esc(aria)}">${bars}</span>`;
    }
    function trendPeriodLabel() { return basisState === 'annual' ? '5Y' : '5Q'; }
    function revealStatementTrendAtLatest() {
        if (!showStatementTrend) return;
        const apply = () => {
            if (!showStatementTrend) return;
            const wrap = $('stmt-wrap');
            if (!wrap) return;
            const latest = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
            wrap.scrollLeft = latest;
            for (const proxy of [$('stmt-scroll-top'), $('stmt-scroll-bottom')]) {
                if (proxy) proxy.scrollLeft = latest;
            }
        };
        // Chromium may restore a nested scroller after synchronous rendering.
        // Reassert the requested open position after layout and after restoration.
        apply();
        requestAnimationFrame(() => requestAnimationFrame(apply));
        setTimeout(apply, 150);
    }
    function syncStatementTrendControls() {
        const toggle = $('stmt-trend-toggle');
        if (!toggle) return;
        toggle.hidden = showStatementTrend;
        toggle.textContent = `Show ${trendPeriodLabel()} trend`;
        toggle.setAttribute('aria-expanded', String(showStatementTrend));
        toggle.setAttribute('aria-label', `Show ${trendPeriodLabel()} trend`);
    }
    function setStatementTrendVisible(visible) {
        showStatementTrend = Boolean(visible);
        syncStatementTrendControls();
        if (payload) renderStatements();
    }
    function renderFinancialSources() {
        let panel=$('financial-source-status');
        if(!panel){panel=document.createElement('section');panel.id='financial-source-status';panel.style.margin='20px 0';$('stmt-prov')?.insertAdjacentElement('afterend',panel);}
        const basis=basisState==='quarterly'?'quarterly':'annual';
        const facts=[...(payload?.supplementalObservations || []),...(payload?.industryObservations || [])].filter(f=>(!f.statement || f.statement===stState) && (f.historyBasis || f.basis)===basis).slice(0,40);
        const fresh=payload?.freshness || {};const gaps=payload?.coverage?.remainingGaps || [];
        const notes=[fresh.lastSuccessfulCheckAt?'Filings last checked '+(Number.isNaN(Date.parse(fresh.lastSuccessfulCheckAt))?fresh.lastSuccessfulCheckAt:new Date(fresh.lastSuccessfulCheckAt).toLocaleString('en-US',{month:'short',day:'numeric',year:'numeric',hour:'numeric',minute:'2-digit'})):null,fresh.backgroundStatus==='running'?'Additional source retrieval is in progress.':null,fresh.backgroundStatus==='capacity_limited'?'Source retrieval is temporarily busy; stored observations and their dates are shown.':null,fresh.lastAttemptResult==='retrieval_failed'?'The freshness check failed; previous dated observations are retained.':fresh.lastAttemptResult==='partial_failure'?'Some source checks failed; last-good observations and remaining gaps are shown.':null].filter(Boolean);
        panel.innerHTML=notes.map(n=>'<p class="small faint">'+esc(n)+'</p>').join('')+(facts.length?'<details><summary>Additional attributed financial observations ('+facts.length+')</summary><p class="small faint">Provider observations and issuer-defined measures are separate from the verified GAAP/IFRS statements.</p><div class="table-wrap"><table class="table-data"><thead><tr><th>Field</th><th>Period end</th><th>Value and unit</th><th>Source and date</th></tr></thead><tbody>'+facts.map(f=>'<tr><td>'+esc(f.definition)+'</td><td>'+esc(f.periodEnd)+'</td><td>'+esc(f.value.toLocaleString('en-US'))+' '+esc(f.unit)+(f.presentation?'<br><span class="small faint">converted from '+esc(f.presentation.originalValue.toLocaleString('en-US'))+' '+esc(f.presentation.originalCurrency)+'</span>':'')+'</td><td><a href="'+esc(f.sourceUrl)+'" target="_blank" rel="noopener">'+esc(f.sourceName)+'</a> '+esc(f.publicationDate || f.sourceDataDate)+' '+esc(f.sourceDateKind==='retrieval'?'retrieved':'published')+' · '+esc(f.accountingBasis)+'</td></tr>').join('')+'</tbody></table></div></details>':'')+(gaps.length?'<details><summary>Remaining data gaps ('+gaps.length+')</summary><ul>'+gaps.slice(0,20).map(g=>'<li>'+esc([g.field,g.basis,g.reason].filter(Boolean).join(' · '))+'</li>').join('')+'</ul></details>':'');
    }
    function renderStatements() {
        if (!payload) return; // a unit, right or fund page has no statements to switch between
        renderFinancialSources();
        const rows = reports(stState, basisState);
        const table = $('stmt-table');
        if (!rows.length) {
            table.innerHTML = '<tbody><tr><td style="text-align:left">No data filed for this view.</td></tr></tbody>';
            // the currency note is written with the table, so with no table it stayed at "loading…"
            if ($('stmt-prov')) $('stmt-prov').textContent = 'No financial statements filed with the SEC are available for this view.';
            return;
        }
        lastRender = { rows: [], periods: rows.map((r) => periodLabel(r, basisState)) };
        table.classList.toggle('trend-hidden', !showStatementTrend);
        const expanded = expandedGroups[stState] || new Set();
        const reportCur = reportingCurrency();
        const converted = Boolean(payload.currencyConversion && payload.currencyConversion.from && payload.currencyConversion.to === 'USD');
        let html = '<thead><tr><th class="row-head" style="text-align:left">' +
            (viewState === 'yoy' ? 'YoY growth' : viewState === 'ps' ? `Per filed share · ${reportCur}` : `${reportCur} · ${converted ? 'converted' : 'reported'}`) + '</th>';
        if (showStatementTrend) {
            html += `<th class="stmt-trend-head" style="width:96px"><span>${trendPeriodLabel()} trend</span><button class="stmt-trend-close" type="button" aria-expanded="true" aria-controls="stmt-table" aria-label="Hide ${trendPeriodLabel()} trend" title="Hide ${trendPeriodLabel()} trend">×</button></th>`;
        }
        rows.forEach((r, i) => {
            const latest = i === rows.length - 1;
            // Keep the period header unambiguous: the fiscal year already
            // identifies the latest column, so do not duplicate it with a
            // second "Latest" label.
            html += `<th${latest ? " class='col-now'" : ''}>${periodLabel(r, basisState)}</th>`;
        });
        html += '</tr></thead><tbody>';
        let ri = 0;
        const defs = groupDefs(statementDefs(converted), stState);
        // Shown open the first time: with no cost of revenue they are the only
        // costs on the statement.
        if (!filedCostsOpened && defs.some((d) => d.parentOf === FILED_GROUP)) { expanded.add(FILED_GROUP); filedCostsOpened = true; }
        // a group only exists if at least one of its components has data
        const liveGroups = new Set();
        for (const def of defs) {
            if (def.gid === undefined) continue;
            const raw = rows.map((r) => def.get(r));
            if (!raw.every((v) => v === null)) liveGroups.add(def.gid);
        }
        for (const def of defs) {
            if (viewState === 'ps' && def.kind === 'shares') continue;
            const raw = rows.map((r) => def.get(r));
            if (raw.every((v) => v === null) && !def.heading) continue;
            const { vals, fmt, colored } = viewVals(def, raw, rows);
            if (vals.every((v) => v === null) && !def.heading) continue;
            lastRender.rows.push({ label: def.label, vals, fmt, neutral: !!def.neutral });
            const isParent = def.parentOf !== undefined && liveGroups.has(def.parentOf);
            const inGroup = def.gid !== undefined;
            const hide = inGroup && !expanded.has(def.gid);
            const caret = isParent
                ? `<button class="grp-caret" data-g="${def.parentOf}" aria-label="Expand components" title="Show the components">${expanded.has(def.parentOf) ? '▾' : '▸'}</button>`
                : '';
            html += `<tr class="${def.sub ? 'row-sub' : ''} ${def.rule ? 'row-rule' : ''}${inGroup ? ' grp-' + def.gid : ''}${isParent ? ' grp-parent' : ''}"${isParent ? ` data-g="${def.parentOf}"` : ''} data-i="${ri}"${hide ? ' hidden' : ''}>
              <td class="row-head"${def.depth ? ` style="padding-left:${36 + def.depth * 16}px"` : ''}${def.title ? ` title="${esc(def.title)}"` : ''}>${caret}${esc(def.label)}</td>`;
            if (showStatementTrend) html += `<td>${def.heading && vals.every((v) => v === null) ? '' : statementMiniBars(vals, lastRender.periods, fmt)}</td>`;
            vals.forEach((v, i) => {
                const colCls = [
                    i === vals.length - 1 ? 'col-now' : '',
                    (colored && v !== null) ? (v >= 0 ? 'delta-pos' : 'delta-neg') : (v !== null && v < 0 ? 'delta-neg' : '')
                ].join(' ');
                html += `<td class="${colCls}">${fmt(v)}</td>`;
            });
            html += '</tr>';
            ri++;
        }
        html += '</tbody>';
        table.innerHTML = html;
        table.querySelector('.stmt-trend-close')?.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            setStatementTrendVisible(false);
        });
        syncStatementTrendControls();
        const provenance = $('stmt-prov');
        if (provenance) {
            const mismatch = hasCurrencyMismatch();
            const conversionText = converted
                ? `Financial statements are shown in USD, converted from ${sourceReportingCurrency()}. ${payload.currencyConversion.restatedFrom ? `Under hyperinflation accounting (IAS 29) each filing restates its figures, earlier years included, into the currency of its own balance-sheet date, so figures from those filings use that date’s closing FX rate; earlier filings use the period basis below. ` : ''}Balance-sheet figures use the fiscal-period closing monthly FX rate; income and cash-flow figures use average month-end FX rates over each reporting period. This is an approximate convenience conversion. `
                : `Financial statements are shown in ${reportCur}, the company’s reported currency; no FX conversion is applied. `;
            provenance.textContent = conversionText +
                (mismatch ? `The exchange-traded quote and market-cap data are in ${quoteCurrency()}; ADR-dependent valuation overlays remain disabled. ` : '') +
                (defs.some((d) => d.filed) ? `The company files no cost of revenue; its cost lines are shown as filed in its ${payload.filedCosts.filing.form}s, with the filing’s own labels and headings. ` : '') +
                'Figures come from company filings (10-K/10-Q or foreign-filer equivalents), as filed. Reported per-share values retain their filed basis. Calculated figures require available verified inputs; missing inputs stay missing. ▸ unfolds a total into its components.';
        }
        // Tapping anywhere on a parent row toggles its component group. The ▸
        // glyph alone is only ~12×18px — far too small to hit on a phone, which
        // is why "unfold" felt broken on mobile. The whole row is the target now.
        table.querySelectorAll('tr.grp-parent').forEach((row) => {
            row.style.cursor = 'pointer';
            row.addEventListener('click', () => {
                const g = Number(row.dataset.g);
                const set = expandedGroups[stState];
                const open = !set.has(g);
                if (open) set.add(g); else set.delete(g);
                const c = row.querySelector('.grp-caret');
                if (c) c.textContent = open ? '▾' : '▸';
                table.querySelectorAll('.grp-' + g).forEach((tr) => { tr.hidden = !open; });
            });
        });
        const wrap = $('stmt-wrap');
        alignStatementYearColumns();
        // Explicit scrollbars above and below the table mirror its position.
        for (const proxy of [$('stmt-scroll-top'), $('stmt-scroll-bottom')]) {
            proxy.firstElementChild.style.width = wrap.scrollWidth + 'px';
            proxy.scrollLeft = wrap.scrollLeft;
        }
        if (showStatementTrend) revealStatementTrendAtLatest();
        // row-click charts deliberately off on statements (user call — later)
    }
    // A visible, draggable horizontal scrollbar for any wide .table-wrap. Native
    // scrollbars are invisible/undraggable on phones, so this thumb (click + drag,
    // both directions) gives an explicit affordance on every device. Idempotent:
    // the wrap persists across re-renders, so re-calling just recomputes the thumb.
    function updateHbar(wrap) {
        const bar = wrap.__hbar; if (!bar) return;
        const thumb = bar.firstElementChild;
        const sw = wrap.scrollWidth, cw = wrap.clientWidth, max = sw - cw;
        if (max <= 2) { bar.classList.remove('on'); return; }
        bar.classList.add('on');
        const bw = bar.clientWidth;
        const tw = Math.max((cw / sw) * bw, 36);
        thumb.style.width = tw + 'px';
        const trackW = bw - tw;
        thumb.style.transform = 'translateX(' + (max > 0 ? (wrap.scrollLeft / max) * trackW : 0) + 'px)';
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
        if (!attachHScroll._resize) {
            attachHScroll._resize = true;
            let resizeTimer = null;
            window.addEventListener('resize', () => {
                clearTimeout(resizeTimer);
                resizeTimer = setTimeout(() => {
                    alignStatementYearColumns({ preservePosition: true });
                    document.querySelectorAll('.table-wrap.has-hbar').forEach(updateHbar);
                }, 100);
            });
        }
        updateHbar(wrap);
    }
    (function wireStatementScrollbars() {
        const top = $('stmt-scroll-top');
        const bottom = $('stmt-scroll-bottom');
        const wrap = $('stmt-wrap');
        let syncing = false;
        const syncFrom = (source) => {
            if (syncing) return;
            syncing = true;
            const left = source.scrollLeft;
            if (source !== wrap) wrap.scrollLeft = left;
            if (source !== top) top.scrollLeft = left;
            if (source !== bottom) bottom.scrollLeft = left;
            syncing = false;
        };
        top.addEventListener('scroll', () => syncFrom(top));
        bottom.addEventListener('scroll', () => syncFrom(bottom));
        wrap.addEventListener('scroll', () => syncFrom(wrap));
        // grab-and-drag panning for MOUSE only: press anywhere on the table and
        // pull left/right; a real drag suppresses the click that would follow.
        // On touch we must NOT hijack the gesture — manually setting scrollLeft
        // without preventDefault fights the native pan and the table feels stuck,
        // so touch falls through to the browser's own horizontal scrolling.
        let down = null;
        let dragged = false;
        wrap.addEventListener('pointerdown', (e) => {
            if (e.pointerType !== 'mouse' || e.button !== 0 || e.target.closest('button, a')) return;
            wrap.style.cursor = 'grab';
            down = { x: e.clientX, left: wrap.scrollLeft };
            dragged = false;
        });
        wrap.addEventListener('pointermove', (e) => {
            if (!down) return;
            const dx = e.clientX - down.x;
            if (Math.abs(dx) > 6) {
                dragged = true;
                wrap.style.cursor = 'grabbing';
                wrap.scrollLeft = down.left - dx;
            }
        });
        const release = () => { down = null; wrap.style.cursor = 'grab'; };
        wrap.addEventListener('pointerup', release);
        wrap.addEventListener('pointerleave', release);
        wrap.addEventListener('click', (e) => { if (dragged) { e.stopPropagation(); e.preventDefault(); dragged = false; } }, true);
    })();
    // Shared "Options"-style popover: a button toggles an anchored menu, closed
    // by tapping outside or Esc. Used for the statement controls AND the
    // Growth & returns groups, so both behave identically.
    function wirePopover(btnId, menuId) {
        const btn = $(btnId);
        const menu = $(menuId);
        if (!btn || !menu) return;
        const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
        const open = () => {
            menu.hidden = false;
            btn.setAttribute('aria-expanded', 'true');
            // Wide popovers are fixed + right-anchored to the viewport; pin their
            // top to the button so they drop directly beneath it, and clamp the
            // height to the space actually left below — otherwise a tall menu
            // (e.g. Documents on mobile) runs off the bottom of the screen.
            if (menu.classList.contains('opts-wide')) {
                const top = btn.getBoundingClientRect().bottom + 6;
                menu.style.top = top + 'px';
                menu.style.maxHeight = Math.min(window.innerHeight * 0.7, window.innerHeight - top - 16) + 'px';
            }
        };
        btn.addEventListener('click', (e) => { e.stopPropagation(); menu.hidden ? open() : close(); });
        document.addEventListener('click', (e) => { if (!menu.hidden && !menu.contains(e.target) && !btn.contains(e.target)) close(); });
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !menu.hidden) close(); });
    }
    wirePopover('stmt-opts-btn', 'stmt-opts-menu');
    wirePopover('cagr-opts-btn', 'cagr-opts-menu');
    wirePopover('docs-opts-btn', 'docs-opts-menu');
    function wireExpand(table, render) {
        table.querySelectorAll('tr.row-data').forEach((tr) => {
            tr.style.cursor = 'pointer';
            tr.addEventListener('click', () => {
                const open = tr.nextElementSibling && tr.nextElementSibling.classList.contains('row-expand');
                table.querySelectorAll('tr.row-expand').forEach((x) => x.remove());
                if (open) return;
                const row = render.rows[Number(tr.dataset.i)];
                if (!row) return;
                const ex = document.createElement('tr');
                ex.className = 'row-expand';
                const cols = tr.children.length;
                ex.innerHTML = `<td colspan="${cols}" style="text-align:left; background:#fcfbf9; padding:20px 22px;">
                    <div class="label" style="margin-bottom:12px;">${esc(row.label)} — ${render.periods[0]}–${render.periods[render.periods.length - 1]}</div>
                    ${chart([{ values: row.vals, cls: 'ink' }], render.periods, { fmt: row.fmt, height: 230 })}
                  </td>`;
                tr.after(ex);
                ex.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
            });
        });
    }
    function renderCagrCards() {
        const years = annualJoined();
        if (years.length < 4) return;
        const revs = years.map((y) => derive(y.income || {}).rev);
        const profits = years.map((y) => num((y.income || {}).netIncome));
        const roes = years.map((y) => (y.income?._scopes?.netIncome===y.balance?._scopes?.totalShareholderEquity ? ratio(num((y.income || {}).netIncome), num((y.balance || {}).totalShareholderEquity)) : null));
        const px = monthlySeries(payload);
        const horizons = [10, 5, 3].filter((h) => h < years.length);
        const seriesCagr = (vals, h) => cagr(vals[vals.length - 1 - h], vals[vals.length - 1], h);
        const stockCagr = (h) => {
            if (px.length < h * 12 + 1) return null;
            return cagr(px[px.length - 1 - h * 12].close, px[px.length - 1].close, h);
        };
        const avg = (vals, h) => {
            const win = vals.slice(-h).filter((v) => v !== null);
            return win.length ? win.reduce((a, v) => a + v, 0) / win.length : null;
        };
        const cards = [
            { title: 'Sales growth', rows: horizons.map((h) => [`${h} yrs`, seriesCagr(revs, h)]) },
            { title: 'Profit growth', rows: horizons.map((h) => [`${h} yrs`, seriesCagr(profits, h)]) },
            { title: 'Stock price CAGR', rows: [10, 5, 3, 1].map((h) => [`${h} yr${h > 1 ? 's' : ''}`, stockCagr(h)]) },
            { title: 'Return on equity', rows: horizons.map((h) => [`${h}-yr avg`, avg(roes, h) === null ? null : avg(roes, h) * 100]).concat([['Latest', roes[roes.length - 1] === null ? null : roes[roes.length - 1] * 100]]) }
        ];
        const cardHtml = (c) => `
          <div class="card card-pad">
            <p class="label" style="margin-bottom:10px;">${c.title}</p>
            <div style="display:grid; gap:6px;">
              ${c.rows.filter(([, v]) => v !== null).map(([l, v]) => {
                  const roe = c.title === 'Return on equity';
                  return `
                <div style="display:flex; justify-content:space-between; font-size:13.5px;">
                  <span class="muted">${l}</span>
                  <span class="num ${roe ? '' : (v >= 0 ? 'delta-pos' : 'delta-neg')}" style="font-weight:600;">${roe ? v.toFixed(1) + '%' : signedPct(v)}</span>
                </div>`;
              }).join('')}
            </div>
          </div>`;
        // All Growth & Returns cards (Sales growth, Profit growth, Stock-price
        // CAGR, Return on equity) shown inline — the mobile-style split that
        // tucked CAGR/ROE under an Options popover is removed on request.
        $('cagr-cards-main').innerHTML = cards.map(cardHtml).join('');
        $('cagr-cards-rest').innerHTML = '';
        const cagrOptsBtn = $('cagr-opts-btn');
        if (cagrOptsBtn) cagrOptsBtn.style.display = 'none';
        $('cagr-collapse').hidden = false;
    }

    // ---------- ⑥ ratios ----------
    // Return on equity and on assets divide a year's profit by a balance. In the
    // quarterly view that year is the four quarters ending at the column: one
    // quarter's profit against the whole balance reads as a quarter of the return,
    // and ×4 turns one seasonal quarter into a year. Margins and the balance-sheet
    // ratios use the quarter's own figures.
    const yearProfit = (y) => ('ttmNetIncome' in y ? y.ttmNetIncome : num((y.income || {}).netIncome));
    const RATIOS = [
        { label: 'Gross margin', get: (y) => { const d = derive(y.income || {}); return ratio(d.gp, d.rev); }, fmt: pctFmt },
        { label: 'Operating margin', get: (y) => ratio(num((y.income || {}).operatingIncome), derive(y.income || {}).rev), fmt: pctFmt },
        { label: 'Net margin', get: (y) => ratio(num((y.income || {}).netIncome), derive(y.income || {}).rev), fmt: pctFmt },
        { label: 'FCF margin', fcf: true, get: (y) => ratio(fcfForRevenue(y.income || {}, y.cash || {}), derive(y.income || {}).rev), fmt: pctFmt },
        { label: 'Return on equity', ttm: true, get: (y) => (y.income?._scopes?.netIncome===y.balance?._scopes?.totalShareholderEquity ? ratio(yearProfit(y), num((y.balance || {}).totalShareholderEquity)) : null), fmt: pctFmt },
        { label: 'Return on assets', ttm: true, get: (y) => ratio(yearProfit(y), num((y.balance || {}).totalAssets)), fmt: pctFmt },
        { label: 'Current ratio', get: (y) => ratio(num((y.balance || {}).totalCurrentAssets), num((y.balance || {}).totalCurrentLiabilities)), fmt: (v) => v === null ? '—' : fixed(v, 2) },
        { label: 'Debt to equity', get: (y) => ratio(debtOf(y.balance || {}), num((y.balance || {}).totalShareholderEquity)), fmt: (v) => v === null ? '—' : fixed(v, 2) },
        { label: 'OCF / net income', get: (y) => ratio(num((y.cash || {}).operatingCashflow), num((y.income || {}).netIncome)), fmt: (v) => v === null ? '—' : fixed(v, 2) },
        { label: 'Capex % of revenue', get: (y) => { if (!cashMatchesRevenue(y.income || {}, y.cash || {})) return null; const c = num((y.cash || {}).capitalExpenditures); const r = derive(y.income || {}).rev; return (c !== null && r) ? Math.abs(c) / r : null; }, fmt: pctFmt },
        // Stock pay against revenue, and what free cash flow comes to once it is
        // counted as the cost it is. Both from filed lines only.
        { label: 'SBC % of revenue', get: (y) => { const s = num((y.cash || {}).shareBasedCompensation); const r = derive(y.income || {}).rev; return (s !== null && r) ? s / r : null; }, fmt: pctFmt },
        { label: 'FCF after SBC, % of revenue', fcf: true, get: (y) => { const f = fcfOf(y.cash || {}); const s = num((y.cash || {}).shareBasedCompensation); const r = derive(y.income || {}).rev; return (f !== null && s !== null && r) ? (f - s) / r : null; }, fmt: pctFmt }
    ];
    // Follows the statements' Annual | Quarterly option (owner, 2026-10-19).
    function renderRatios() {
        const quarterly = basisState === 'quarterly';
        const years = quarterly ? quarterlyJoined().slice(-20) : annualJoined().slice(-19);
        const table = $('ratio-table');
        $('ratio-title').textContent = quarterly ? `Ratios, ${years.length} quarters` : 'Ratios, 19 years';
        $('ratio-prov').textContent = quarterly
            ? 'Computed deterministically from filed quarterly statements — no estimates, no AI. Margins use each quarter’s own figures; return on equity and on assets use the trailing four quarters’ net income against the quarter-end balance. Click any row for its chart.'
            : 'Computed deterministically from filed annual statements — no estimates, no AI. Click any row for its chart.';
        if (years.length < 2) { table.innerHTML = ''; return; }
        const periods = years.map((y) => quarterly ? periodLabel({ fiscalDateEnding: y.end }, 'quarterly') : 'FY' + new Date(y.end).getFullYear());
        const render = { rows: [], periods };
        let html = '<thead><tr><th class="row-head" style="text-align:left">Ratio</th><th style="width:96px">Trend</th>';
        periods.forEach((p, i) => { html += `<th${i === periods.length - 1 ? " class='col-now'" : ''}>${p}</th>`; });
        html += '</tr></thead><tbody>';
        let ri = 0;
        for (const def of RATIOS) {
            if (def.fcf && noFcf()) continue;
            const vals = years.map((y) => def.get(y));
            if (vals.every((v) => v === null)) continue;
            const label = quarterly && def.ttm ? def.label + ' (TTM)' : def.label;
            render.rows.push({ label, vals, fmt: def.fmt, neutral: false });
            html += `<tr class="row-data" data-i="${ri}" title="Click for chart"><td class="row-head">${label}</td><td>${sparkline(vals)}</td>`;
            vals.forEach((v, i) => { html += `<td class="${i === vals.length - 1 ? 'col-now' : ''}">${def.fmt(v)}</td>`; });
            html += '</tr>';
            ri++;
        }
        table.innerHTML = html + '</tbody>';
        wireExpand(table, render);
        attachHScroll(table.closest('.table-wrap'));
        // open on the newest year, as the statements table does — nineteen columns
        // otherwise start at the oldest and hide the one most people came for
        const ratioWrap = table.closest('.table-wrap');
        if (ratioWrap) requestAnimationFrame(() => { ratioWrap.scrollLeft = ratioWrap.scrollWidth; });
    }

    // ---------- ⑦ ownership / ⑧ documents ----------
    async function renderOwnership() {
        try {
            const r = await fetch(`/api/company/${encodeURIComponent(symbol)}/ownership`);
            if (!r.ok) return;
            const o = await r.json();
            if (o.institutionsPctHeld === null && !(o.topInstitutions || []).length) return;
            $('own-strip').innerHTML = [
                o.institutionsPctHeld !== null ? `institutions <b class="num">${pct(o.institutionsPctHeld * 100)}</b>` : '',
                o.insidersPctHeld !== null ? `insiders <b class="num">${pct(o.insidersPctHeld * 100, 2)}</b>` : '',
                o.institutionsCount !== null ? `<b class="num">${o.institutionsCount.toLocaleString('en-US')}</b> holders` : ''
            ].filter(Boolean).map((s) => `<span>${s}</span>`).join('');
            const top = (o.topInstitutions || []).slice(0, 8);
            if (top.length) {
                $('own-table').innerHTML =
                    '<thead><tr><th class="row-head" style="text-align:left;">Holder</th><th>% held</th><th>Value</th><th>Reported</th></tr></thead><tbody>' +
                    top.map((t) => `<tr>
                      <td class="row-head">${esc(t.organization)}</td>
                      <td data-label="% held">${t.pctHeld === null ? '—' : pct(t.pctHeld * 100, 2)}</td>
                      <td data-label="Value">${t.value === null ? '—' : '$' + money(t.value)}</td>
                      <td class="muted" data-label="Reported">${esc(t.reportDate || '—')}</td>
                    </tr>`).join('') + '</tbody>';
                attachHScroll($('own-table').closest('.table-wrap'));
            }
            renderInsiders(o);
            renderInsiderHistory(o);
            $('own-section').hidden = false;
        } catch (_) { /* enrichment */ }
    }

    // ---------- insider activity over time (Annual | Quarterly) ----------
    // Built from the dated Form-4 transaction feed; the most recent period is
    // the differentiator and sits behind Pro.
    let histPeriod = 'quarterly';
    let histTx = [];
    let form4Quarters = null; // parsed-from-EDGAR history once built
    let form4Meta = '';
    let form4Locked = false; // server says free tier — newest quarter withheld
    async function renderInsiderHistory(o) {
        histTx = (o.insiderTransactions || []).filter((t) => t.date);
        if (histTx.length >= 3) {
            paintInsiderHistory();
            $('insider-hist-block').hidden = false;
        }
        document.querySelectorAll('#seg-hist button').forEach((b) =>
            b.addEventListener('click', () => {
                document.querySelectorAll('#seg-hist button').forEach((x) => x.setAttribute('aria-pressed', x === b));
                histPeriod = b.dataset.p;
                paintInsiderHistory();
            }));
        pollForm4(0);
    }
    async function pollForm4(attempt) {
        try {
            const r = await fetch(`/api/company/${encodeURIComponent(symbol)}/insider-history`);
            if (!r.ok) return;
            const d = await r.json();
            form4Locked = !!d.locked;
            if (form4Locked) showPaywallStrip();
            if ((d.quarters || []).length) {
                form4Quarters = d.quarters;
                form4Meta = `${d.filingsParsed} Form 4 filings parsed directly from EDGAR` + (d.building ? ' — still building…' : '');
                paintInsiderHistory();
                $('insider-hist-block').hidden = false;
                // the parsed feed also upgrades the transactions table (3yr deep) — only when unlocked
                if (!d.locked && (d.recent || []).length) {
                    insiderData = d.recent.map((t) => ({
                        name: t.owner, relation: t.relation, side: t.side,
                        date: t.date, shares: t.shares, value: t.value
                    }));
                    paintInsiders();
                    $('insider-block').hidden = false;
                }
            }
            if (d.building && attempt < 6) setTimeout(() => pollForm4(attempt + 1), 20000);
        } catch (_) { /* enrichment */ }
    }
    function paintInsiderHistory() {
        const buckets = new Map();
        if (form4Quarters) {
            for (const q of form4Quarters) {
                const k = histPeriod === 'annual' ? q.key.slice(0, 4) : q.key;
                if (!buckets.has(k)) buckets.set(k, { buys: 0, sells: 0, buySh: 0, sellSh: 0 });
                const b = buckets.get(k);
                b.buys += q.buys; b.sells += q.sells; b.buySh += q.buySh; b.sellSh += q.sellSh;
            }
        } else {
            const keyOf = (d) => histPeriod === 'annual'
                ? d.slice(0, 4)
                : d.slice(0, 4) + ' Q' + (Math.floor((Number(d.slice(5, 7)) - 1) / 3) + 1);
            for (const t of histTx) {
                const k = keyOf(t.date);
                if (!buckets.has(k)) buckets.set(k, { buys: 0, sells: 0, buySh: 0, sellSh: 0 });
                const b = buckets.get(k);
                if (t.side === 'buy') { b.buys++; b.buySh += t.shares || 0; }
                else if (t.side === 'sell') { b.sells++; b.sellSh += t.shares || 0; }
            }
        }
        const keys = [...buckets.keys()].sort();
        // The server withholds the newest quarter entirely for free users, so
        // the last real column here is already one quarter behind. Render an
        // extra locked placeholder column so the wall stays visible, not just implied.
        const shown = keys.slice(-12);
        const lock = form4Locked;
        const cols = lock ? [...shown, '__locked__'] : shown;
        const latest = shown[shown.length - 1];
        const cell = (k, v) => k === '__locked__'
            ? '<span title="The latest period is a Core feature" style="filter:blur(5px); user-select:none;">●●●</span>'
            : v;
        const rows = [
            ['Buys', (b) => String(b.buys)],
            ['Sells', (b) => String(b.sells)],
            ['Net shares', (b) => {
                const net = b.buySh - b.sellSh;
                const s = money(Math.abs(net), 0);
                return net === 0 ? '0' : (net > 0 ? '+' : '−') + s;
            }]
        ];
        let html = '<thead><tr><th class="row-head" style="text-align:left;">Insiders</th>' +
            cols.map((k) => `<th${k === '__locked__' || k === latest ? " class='col-now'" : ''}>${k === '__locked__' ? '🔒' : esc(k)}</th>`).join('') + '</tr></thead><tbody>';
        for (const [label, fn] of rows) {
            html += `<tr><td class="row-head">${label}</td>` +
                cols.map((k) => {
                    const v = k === '__locked__' ? '' : fn(buckets.get(k));
                    const cls = label === 'Net shares' && k !== '__locked__' ? (v.startsWith('+') ? 'delta-pos' : v.startsWith('−') ? 'delta-neg' : '') : '';
                    return `<td class="${cls}${k === '__locked__' || k === latest ? ' col-now' : ''}">${cell(k, v)}</td>`;
                }).join('') + '</tr>';
        }
        $('insider-hist-table').innerHTML = html + '</tbody>';
        attachHScroll($('insider-hist-table').closest('.table-wrap'));
        $('insider-hist-prov').innerHTML = (lock
            ? '🔒 The most recent period is part of Core — <a href="/upgrade.html">upgrade</a> to see what insiders did latest. '
            : '') + esc(form4Meta || 'Aggregated from Form 4 filings, as far back as the transactions feed reaches.');
    }

    let paywallStripShown = false;
    function showPaywallStrip() {
        if (paywallStripShown) return;
        paywallStripShown = true;
        const el = $('paywall-strip');
        if (!el) return;
        el.innerHTML = upgradeStrip({
            items: ['The full 3-year Form 4 insider trail — every buy and sell', 'Guru quarterly buy/sell activity and 3M–15Y performance', 'AI analysis of any portfolio']
        });
        el.hidden = false;
    }

    let insiderSide = 'all';
    let insiderData = [];
    function renderInsiders(o) {
        if (o.insiderLocked) {
            showPaywallStrip();
            $('insider-block').hidden = false;
            $('insider-table').innerHTML = '<tbody><tr><td style="text-align:center; padding:20px;">🔒 The full 3-year Form 4 trail — every buy and sell, insider names, net shares per quarter — is on Core. <a href="/upgrade.html">Unlock with Core →</a></td></tr></tbody>';
            return;
        }
        insiderData = o.insiderTransactions || [];
        if (!insiderData.length) return;
        const net = o.insiderNet || {};
        if (net.netShares !== null && net.netShares !== undefined) {
            const dir = net.netShares >= 0 ? 'net buying' : 'net selling';
            $('insider-net').textContent =
                `last ${net.period || '6m'}: ${net.buyCount ?? '—'} buys / ${net.sellCount ?? '—'} sells · ${dir} of ${money(Math.abs(net.netShares))} shares`;
        }
        paintInsiders();
        document.querySelectorAll('#seg-insider button').forEach((b) =>
            b.addEventListener('click', () => {
                document.querySelectorAll('#seg-insider button').forEach((x) => x.setAttribute('aria-pressed', x === b));
                insiderSide = b.dataset.side;
                paintInsiders();
            }));
        $('insider-block').hidden = false;
    }
    function paintInsiders() {
        const rows = insiderData.filter((t) => insiderSide === 'all' || t.side === insiderSide).slice(0, 12);
        $('insider-table').innerHTML = rows.length
            ? '<thead><tr><th class="row-head" style="text-align:left;">Insider</th><th style="text-align:left;">Role</th><th>Action</th><th>Shares</th><th>Value</th><th>Date</th></tr></thead><tbody>' +
              rows.map((t) => `<tr>
                <td class="row-head">${esc(t.name)}</td>
                <td class="small muted" style="text-align:left; white-space:normal;" data-label="Role">${esc(t.relation)}</td>
                <td class="${t.side === 'buy' ? 'delta-pos' : t.side === 'sell' ? 'delta-neg' : 'muted'}" style="font-weight:600; text-transform:capitalize;" data-label="Action">${esc(t.side)}</td>
                <td data-label="Shares">${t.shares === null ? '—' : money(t.shares, 0)}</td>
                <td data-label="Value">${t.value === null ? '—' : '$' + money(t.value)}</td>
                <td class="muted" data-label="Date">${esc(t.date || '—')}</td>
              </tr>`).join('') + '</tbody>'
            : '<tbody><tr><td class="faint" style="text-align:center; padding:20px;">None in the recent filings.</td></tr></tbody>';
        attachHScroll($('insider-table').closest('.table-wrap'));
    }
    async function renderDocs() {
        try {
            const r = await fetch(`/api/company/${encodeURIComponent(symbol)}/filings`);
            if (!r.ok) return;
            const d = await r.json();
            const cats = d.categories || {};
            const COLS = [
                ['annual', 'Annual reports', '10-K'],
                ['quarterly', 'Quarterly reports', '10-Q'],
                ['events', 'Material events', '8-K'],
                ['insider', 'Insider filings', 'Form 4'],
                ['proxy', 'Proxy statements', 'DEF 14A']
            ];
            const cols = COLS.filter(([k]) => (cats[k] || []).length);
            if (!cols.length) return;
            // Same split as the financial statements: the primary thing (Annual
            // reports / 10-K — what people come for) is shown inline; the rest
            // (10-Q / 8-K / Form 4 / proxy) sit under the Options menu.
            const linkChip = (f) => `<a href="${esc(f.url)}" target="_blank" rel="noopener" class="doc-chip num">${esc(f.date)} ↗</a>`;
            const primary = cols.find(([k]) => k === 'annual') || cols[0];
            const rest = cols.filter((c) => c !== primary);
            const docCard = ([k, title, sub]) => `
                  <div class="card card-pad">
                    <p class="label" style="margin:0 0 8px;">${title} <span class="faint" style="font-weight:400; text-transform:none; letter-spacing:0;">· ${sub}</span></p>
                    <div class="doc-chips">${cats[k].map(linkChip).join('')}</div>
                  </div>`;
            // Desktop has room for everything inline — no Options popover. Mobile
            // keeps Annual inline and tucks the rest under Options.
            if (window.innerWidth > 640) {
                $('docs-grid').innerHTML = `<div class="docs-cols">${cols.map(docCard).join('')}</div>`;
                $('docs-opts').hidden = true;
            } else {
                $('docs-grid').innerHTML = `
                  <p class="title-3" style="margin:0 0 2px;">${primary[1]}</p>
                  <p class="faint" style="font-size:11px; margin:0 0 12px;">${primary[2]}</p>
                  <div class="doc-chips">${cats[primary[0]].map(linkChip).join('')}</div>`;
                if (rest.length) {
                    $('docs-rest').innerHTML = rest.map(docCard).join('');
                    $('docs-opts').hidden = false;
                } else {
                    $('docs-opts').hidden = true;
                }
            }
            $('docs-section').hidden = false;
        } catch (_) { /* enrichment */ }
    }

    // ---------- insights drawer (segments + AI summary) ----------
    function wireDrawer() {
        const tab = $('drawer-tab');
        const drawer = $('drawer');
        const dim = $('drawer-dim');
        const open = () => { drawer.classList.add('open'); dim.hidden = false; loadInsights(); };
        const close = () => { drawer.classList.remove('open'); dim.hidden = true; };
        tab.addEventListener('click', open);
        $('drawer-close').addEventListener('click', close);
        dim.addEventListener('click', close);
        document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && drawer.classList.contains('open')) close(); });
        tab.hidden = false;
    }
    let insightsLoaded = false;
    async function loadInsights() {
        if (insightsLoaded) return;
        insightsLoaded = true;
        const segBody = $('seg-body');
        const insBody = $('insights-body');
        const teaser = (what) => `${what} is a Pro feature — <a href="/upgrade.html">upgrade</a> or <a href="/login.html">log in</a>.`;
        if (!token()) {
            segBody.innerHTML = `<p class="small muted">${teaser('Business segments from the 10-K')}</p>`;
            insBody.innerHTML = `<p class="small muted">${teaser('Insights — the analyst’s reading of 19 years of filings, the valuation record and sector position')}</p>`;
            return;
        }
        // This is the only path allowed to generate the key-point dossier.
        // Passive company-page loads request cache-only data and consume no AI.
        renderDossier(true);
        insBody.innerHTML = '<p class="loading-line"><span class="spin"></span>Connecting 19 years of filings, the valuation record and sector medians…</p>';
        (async () => {
            try {
                const r = await fetch(`${API}/company/${encodeURIComponent(symbol)}/insights`, { headers: { Authorization: `Bearer ${token()}` } });
                if (r.status === 402 || r.status === 403) {
                    insBody.innerHTML = `<p class="small muted">${teaser('Insights')}</p>`;
                } else if (r.ok) {
                    const d = await r.json();
                    insBody.innerHTML = (d.insights || []).map((i) => `
                      <div class="kp-section">
                        <p class="kp-head">${esc(i.title)}</p>
                        <p class="small" style="color:var(--ink-2); margin:0;">${esc(i.body)}</p>
                      </div>`).join('') +
                      `<p class="provenance">${esc(d.basis || '')} Descriptive analysis — not advice.</p>`;
                    const share = document.createElement('div');
                    mountShare(share, {
                        title: `${symbol} AI insights`,
                        text: (d.insights || []).map((i) => `${i.title}: ${i.body}`).join('\n\n')
                    });
                    insBody.appendChild(share);
                } else {
                    insBody.innerHTML = '<p class="small muted">Insights unavailable right now.</p>';
                }
            } catch (_) { insBody.innerHTML = '<p class="small muted">Insights unavailable right now.</p>'; }
        })();
        segBody.innerHTML = '<p class="loading-line"><span class="spin"></span>Reading the 10-K…</p>';
        try {
            const r = await fetch(`${API}/company/${encodeURIComponent(symbol)}/segments`, { headers: { Authorization: `Bearer ${token()}` } });
            if (r.status === 402 || r.status === 403) {
                segBody.innerHTML = `<p class="small muted">${teaser('Business segments from the 10-K')}</p>`;
            } else if (r.ok) {
                const d = await r.json();
                if (Array.isArray(d.segments) && d.segments.length) {
                    const segTotal = d.segments.reduce((a, s) => a + (s.revenueUsd || 0), 0);
                    if (segTotal > 0) d.segments.forEach((s) => {
                        if (s.revenuePct === null && s.revenueUsd !== null) s.revenuePct = Math.round(s.revenueUsd / segTotal * 1000) / 10;
                    });
                    segBody.innerHTML = `
                      <p class="label" style="margin-bottom:10px;">Segments · ${esc(d.fiscalYear || 'latest')}</p>
                      <div style="display:grid; gap:8px;">
                        ${d.segments.map((s) => `
                          <div style="display:flex; justify-content:space-between; gap:12px; font-size:13.5px; border-bottom:1px solid var(--line); padding-bottom:8px;">
                            <span style="font-weight:550;">${esc(s.name)}</span>
                            <span class="num muted" style="white-space:nowrap;">${s.revenueUsd === null ? '' : '$' + money(s.revenueUsd)}${s.revenuePct === null ? '' : ' · ' + pct(s.revenuePct)}</span>
                          </div>`).join('')}
                      </div>
                      <p class="provenance">${d.note ? esc(d.note) + ' ' : ''}AI-extracted from the <a href="${esc((d.filing || {}).url || '#')}" target="_blank" rel="noopener">10-K filed ${esc((d.filing || {}).date || '')}</a> — verify against the filing.</p>`;
                } else {
                    segBody.innerHTML = '<p class="small muted">This company reports as a single segment.</p>';
                }
            } else { segBody.innerHTML = '<p class="small muted">Segments unavailable right now.</p>'; }
        } catch (_) { segBody.innerHTML = '<p class="small muted">Segments unavailable right now.</p>'; }
    }

    // ---------- watchlist ----------
    async function wireWatch() {
        if (!token()) return;
        const btn = $('co-watch');
        const auth = { Authorization: `Bearer ${token()}` };
        let watched = false;
        const paint = () => {
            btn.textContent = watched ? '★ Watching' : '☆ Watch';
            btn.style.color = watched ? 'var(--accent)' : '';
        };
        try {
            const r = await fetch(`${API}/watchlist`, { headers: auth });
            if (!r.ok) return;
            watched = ((await r.json()).symbols || []).includes(symbol);
            paint();
            btn.hidden = false;
            btn.addEventListener('click', async () => {
                btn.disabled = true;
                try {
                    const rr = await fetch(`${API}/watchlist/${encodeURIComponent(symbol)}`, {
                        method: watched ? 'DELETE' : 'POST', headers: auth
                    });
                    if (rr.ok) { watched = !watched; paint(); }
                } finally { btn.disabled = false; }
            });
        } catch (_) { /* enrichment */ }
    }

    // ---------- CSV ----------
    $('csv-btn').addEventListener('click', () => {
        if (!lastRender.rows.length) return;
        const head = [`Metric (${viewState === 'yoy' ? 'percent' : reportingCurrency()})`].concat(lastRender.periods).join(',');
        const lines = lastRender.rows.map((row) =>
            [JSON.stringify(row.label)].concat(row.vals.map((v) => v === null ? '' : v)).join(','));
        const blob = new Blob([[head].concat(lines).join('\n')], { type: 'text/csv' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${symbol}-${stState}-${basisState}-${viewState}.csv`;
        a.click();
        URL.revokeObjectURL(a.href);
    });

    // ---------- segment controls ----------
    document.querySelectorAll('#seg-statement button').forEach((b) =>
        b.addEventListener('click', () => {
            document.querySelectorAll('#seg-statement button').forEach((x) => x.setAttribute('aria-pressed', x === b));
            stState = b.dataset.st;
            renderStatements();
        }));
    document.querySelectorAll('#seg-basis button').forEach((b) =>
        b.addEventListener('click', () => {
            document.querySelectorAll('#seg-basis button').forEach((x) => x.setAttribute('aria-pressed', x === b));
            basisState = b.dataset.basis;
            syncStatementTrendControls();
            renderStatements();
            renderRatios();
        }));
    document.querySelectorAll('#seg-view button').forEach((b) =>
        b.addEventListener('click', () => {
            document.querySelectorAll('#seg-view button').forEach((x) => x.setAttribute('aria-pressed', x === b));
            viewState = b.dataset.view;
            renderStatements();
        }));
    $('stmt-trend-toggle').addEventListener('click', () => setStatementTrendVisible(!showStatementTrend));
    window.addEventListener('pageshow', () => {
        if (payload && showStatementTrend) revealStatementTrendAtLatest();
    });

    // ---------- load ----------
    (async () => {
        try {
            // Only a fund page draws from the profile's price history; a company's
            // comes with its fundamentals. Asking for it on every page held the
            // statements back until it arrived (AAPL 2026-10-19: 3.3s, fundamentals 1.4s).
            const knownFund = FUND_TYPES.includes(assetTypeHint);
            const assetRes = assetTypeHint === 'stock' ? null : await fetch(`${API}/assets/${encodeURIComponent(symbol)}/profile${knownFund ? '?history=1' : ''}`);
            let assetData = assetRes && assetRes.ok ? await assetRes.json() : null;
            if (assetData && assetData.profile && assetData.profile.stale) {
                staleAsOf = assetData.profile.staleAsOf || assetData.profile.asOf || null;
            }
            if (assetData && FUND_TYPES.includes(assetData.profile && assetData.profile.assetType)) {
                if (!knownFund) {
                    const histRes = await fetch(`${API}/assets/${encodeURIComponent(symbol)}/profile?history=1`).catch(() => null);
                    if (histRes && histRes.ok) assetData = await histRes.json();
                }
                renderFundProfile(assetData);
                mountAskFloor({ placeholder: `Ask about ${symbol} — fees, holdings, allocation, performance and risk…  (⌘K)` });
                return;
            }
            if (['unit','right','unresolved'].includes(assetData?.profile?.assetType)) { $('co-name').textContent=assetData.profile.name || symbol; $('co-crumb').textContent=assetData.profile.assetTypeLabel+' · Company financial analysis is unavailable for this instrument.'; $('stmt-table').innerHTML='<tbody><tr><td>No company financial analysis is available for this instrument.</td></tr></tbody>'; $('seg-statement').parentElement.style.display='none'; for (const id of ['kp-section','duo-section','stmt-prov']) $(id).hidden = true; return; }
            mountAskFloor({ placeholder: `Ask about ${symbol} — answers come from its SEC filings…  (⌘K)` });
            const r = (await earlyFundamentals) || await fetch(`/api/demo/alpha/fundamentals/${encodeURIComponent(symbol)}?presentationCurrency=USD`);
            if (!r.ok) throw new Error('load failed');
            payload = await r.json();
            buildSharesMap();
            renderMasthead();
            renderMainChart();
            renderTrendBand();
            renderKv();
            renderDossier();
            renderAbout();
            renderChecks();
            renderSbc();
            renderIndustryMetrics();
            // A company that has not filed a full-year report yet (a new listing, or a shell
            // whose first 10-K covers only the months since it was formed) still has quarters.
            if (!reports('income', 'annual').length && reports('income', 'quarterly').length) {
                basisState = 'quarterly';
                document.querySelectorAll('#seg-basis button').forEach((x) => x.setAttribute('aria-pressed', x.dataset.basis === 'quarterly'));
                syncStatementTrendControls();
            }
            renderStatements();
            renderCagrCards();
            renderRatios();
            renderPeers();
            loadReverseDcf();
            renderOwnership();
            renderDocs();
            wireDrawer();
            wireWatch();
            const vs = params.get('vs');
            if (vs) loadCompare(vs);
        } catch (_) {
            $('co-name').textContent = `Couldn't load ${symbol}`;
            $('co-crumb').textContent = 'Try another ticker from the search above.';
        }
    })();
})();
