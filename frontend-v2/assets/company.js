// Company page — the Ive cut. Three ideas in reading order:
//   ① the instrument (masthead: name, price, dual-axis chart),
//   ② the verdict (one machine-made checks band, labeled),
//   ③ the record (peers → statements+growth → ratios ║ check detail →
//      ownership → documents).
// Synthesized intelligence (segments, AI summary) lives in the right-edge
// Insights drawer; Ask is the page's voice — a bar pinned to the floor.
(function () {
    'use strict';
    const { API, token, trackActivation, num, money, pct, fixed, esc, sparkline, chart, markdown, nav, footer, mountAskFloor, companies, mountShare } = window.V2;

    const params = new URLSearchParams(location.search);
    const symbol = (params.get('symbol') || 'AAPL').toUpperCase().replace(/[^A-Z0-9.\-]/g, '');
    if (document.referrer && /\/screener(?:\.html)?(?:[/?#]|$)/i.test(document.referrer)) trackActivation('screener_company');
    document.title = `${symbol} — financials | stockportfolio.pro`;
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
        $('co-crumb').textContent = [symbol, p.assetTypeLabel, p.category, p.exchange].filter(Boolean).join(' · ');
        $('co-price').textContent = currencyAmount(p.price, p.currency, { compact: false });
        $('co-change').textContent = p.changePercent === null ? '—' : `${p.changePercent >= 0 ? '+' : ''}${fixed(p.changePercent, 2)}% today`;
        $('co-change').className = `small num ${p.changePercent >= 0 ? 'delta-pos' : 'delta-neg'}`;
        const stats = [
            ['Net assets', currencyAmount(p.totalAssets, p.currency)],
            ['Expense ratio', fundPct(p.expenseRatio)], ['Yield', fundPct(p.yield)],
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
        const holdings = (p.topHoldings || []).map((h) => `<tr><td class="row-head">${esc(h.symbol || '—')}</td><td>${esc(h.name)}</td><td class="num">${fundPct(h.weight, 2)}</td></tr>`).join('');
        const sectors = (p.allocations && p.allocations.sectors || []).map((s) => [s.name, s.weight]);
        const monthly = (data.monthly && data.monthly['Monthly Adjusted Time Series']) || {};
        const points = Object.keys(monthly).sort().slice(-120).map((d) => [d, num(monthly[d]['5. adjusted close'] || monthly[d]['4. close'])]).filter((x) => x[1] !== null);
        const chartHtml = points.length > 1 ? chart([{ values: points.map((x) => x[1]), cls: 'accent' }], points.map((x) => x[0].slice(0, 7)), { fmt: (v) => currencyAmount(v, p.currency, { compact: false, decimals: 0 }), height: 230 }) : '';
        section.innerHTML = `
          <div class="section-head"><div><span class="label">${esc(p.assetTypeLabel || 'Fund')} research</span><h2 class="title-2" style="margin-top:5px;">Costs, composition and performance</h2></div><span class="small faint">${esc(p.fundFamily || '')}</span></div>
          <div class="fund-grid">${stats.map(([k, v]) => `<div class="fund-stat"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div></div>`).join('')}</div>
          ${chartHtml ? `<div style="margin-top:28px;"><p class="label">Adjusted monthly price · last 10 years</p>${chartHtml}</div>` : ''}
          <div class="fund-cols">
            <div><h3 class="title-3">Asset allocation</h3>${bars(allocation)}${sectors.length ? `<h3 class="title-3" style="margin-top:24px;">Sector exposure</h3>${bars(sectors.slice(0, 12))}` : ''}</div>
            <div><h3 class="title-3">Top holdings</h3>${holdings ? `<div class="table-wrap"><table class="table-data"><thead><tr><th>Symbol</th><th>Holding</th><th>Weight</th></tr></thead><tbody>${holdings}</tbody></table></div>` : '<p class="muted">Holdings are not available from the data source for this fund.</p>'}</div>
          </div>
          <div class="card card-pad" style="margin-top:24px;" id="fund-ai-card">
            <div class="section-head"><div><span class="label">AI fund summary</span><h3 class="title-3" style="margin-top:5px;">Costs, composition, performance and risk</h3></div><button class="btn btn-primary btn-sm" id="fund-ai-btn" type="button">Generate summary</button></div>
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
                    body.innerHTML = r.status === 402 ? 'This summary is available on Pro. <a href="/register.html">View plans →</a>' : esc(result.message || 'Could not generate the summary.');
                    body.hidden = false; return;
                }
                body.innerHTML = markdown(result.summary || '');
                body.hidden = false;
                mountShare($('fund-ai-share'), { title: `${p.name || symbol} (${symbol}) fund research`, text: result.summary || '', url: location.href });
                button.hidden = true;
            } catch (_) {
                body.textContent = 'Network problem — please try again.'; body.hidden = false;
            } finally { button.disabled = false; if (!button.hidden) button.textContent = 'Try again'; }
        });
        document.title = `${symbol} ${p.assetTypeLabel || 'fund'} — holdings, fees and returns | stockportfolio.pro`;
    }

    // ---------- shared math ----------
    const ratio = (a, b) => (a !== null && b !== null && b !== 0) ? a / b : null;
    const derive = (r) => {
        const rev = num(r.totalRevenue);
        let gp = num(r.grossProfit); if (gp === 0) gp = null;
        let cor = num(r.costOfRevenue); if (cor === 0) cor = null;
        if (rev !== null) {
            if (gp === null && cor !== null) gp = rev - cor;
            if (cor === null && gp !== null) cor = rev - gp;
        }
        return { rev, gp, cor };
    };
    const debtOf = (r) => {
        const parts = ['shortTermDebt', 'currentLongTermDebt', 'longTermDebt'].map((k) => num(r[k])).filter((v) => v !== null);
        return parts.length ? parts.reduce((a, v) => a + v, 0) : null;
    };
    const fcfOf = (r) => {
        const ocf = num(r.operatingCashflow); const capex = num(r.capitalExpenditures);
        return (ocf !== null && capex !== null) ? ocf + capex : null;
    };
    function cagr(first, last, years) {
        if (first === null || last === null || first <= 0 || last <= 0 || years < 1.5) return null;
        return (Math.pow(last / first, 1 / years) - 1) * 100;
    }
    const pctFmt = (v) => v === null ? '—' : pct(v * 100);
    const signedPct = (v) => v === null ? '—' : (v >= 0 ? '+' : '') + v.toFixed(1) + '%';

    const ROWS = {
        // Income-statement accordion order: the primary line appears first and
        // its supporting lines unfold DIRECTLY BELOW it.
        income: [
            { label: 'Revenue', get: (r) => derive(r).rev, fmt: money, kind: 'money' },
            { label: 'Cost of revenue', get: (r) => derive(r).cor, fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Gross margin', get: (r) => ratio(derive(r).gp, derive(r).rev), fmt: pctFmt, kind: 'pct', neutral: true, sub: true },
            { label: 'Gross profit', get: (r) => derive(r).gp, fmt: money, kind: 'money', solo: true },
            { label: 'Operating expenses', get: (r) => num(r.operatingExpenses), fmt: money, kind: 'money', neutral: true },
            { label: 'R&D', get: (r) => num(r.researchAndDevelopment), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'SG&A', get: (r) => num(r.sellingGeneralAndAdministrative), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Other operating expenses', get: (r) => { const t = num(r.operatingExpenses); const rd = num(r.researchAndDevelopment); const sg = num(r.sellingGeneralAndAdministrative); if (t === null || (rd === null && sg === null)) return null; const rest = t - (rd || 0) - (sg || 0); return Math.abs(rest) < 1 ? null : rest; }, fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Operating income', get: (r) => num(r.operatingIncome), fmt: money, kind: 'money', rule: true },
            { label: 'Operating margin', get: (r) => ratio(num(r.operatingIncome), derive(r).rev), fmt: pctFmt, kind: 'pct', neutral: true, sub: true },
            { label: 'Pre-tax income', get: (r) => num(r.incomeBeforeTax), fmt: money, kind: 'money' },
            { label: 'Interest income', get: (r) => num(r.interestIncome), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Interest expense', get: (r) => num(r.interestExpense), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Other non-operating income', get: (r) => num(r.otherNonOperatingIncome), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Income tax', get: (r) => num(r.incomeTaxExpense), fmt: money, kind: 'money', neutral: true },
            { label: 'Effective tax rate', get: (r) => { const t = num(r.incomeTaxExpense); const p = num(r.incomeBeforeTax); return (t !== null && p !== null && p > 0) ? t / p : null; }, fmt: pctFmt, kind: 'pct', neutral: true, sub: true },
            { label: 'Net income', get: (r) => num(r.netIncome), fmt: money, kind: 'money', rule: true },
            { label: 'Net margin', get: (r) => ratio(num(r.netIncome), derive(r).rev), fmt: pctFmt, kind: 'pct', neutral: true, sub: true },
            { label: 'EBITDA', get: (r) => num(r.ebitda), fmt: money, kind: 'money' },
            { label: 'EBIT', get: (r) => num(r.ebit), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Depreciation & amortization', get: (r) => num(r.depreciationAndAmortization), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'EPS, basic', get: (r) => num(r.eps), fmt: (v) => fixed(v, 2), kind: 'ps', solo: true },
            { label: 'EPS, diluted', get: (r) => num(r.dilutedEPS), fmt: (v) => fixed(v, 2), kind: 'ps', solo: true },
            { label: 'Shares outstanding', get: (r) => num(r.commonStockSharesOutstanding), fmt: money, kind: 'shares', neutral: true, solo: true }
        ],
        // Macrotrends content, accordion order: each subtotal is the parent
        // row and its components unfold DIRECTLY BELOW it when expanded.
        balance: [
            { label: 'Total current assets', get: (r) => num(r.totalCurrentAssets), fmt: money, kind: 'money' },
            { label: 'Cash & short-term investments', get: (r) => { const t = num(r.cashAndShortTermInvestments); if (t !== null) return t; const c = num(r.cashAndCashEquivalentsAtCarryingValue); const s = num(r.shortTermInvestments); return c === null && s === null ? null : (c || 0) + (s || 0); }, fmt: money, kind: 'money', sub: true },
            { label: 'Receivables', get: (r) => num(r.currentNetReceivables), fmt: money, kind: 'money', sub: true },
            { label: 'Inventory', get: (r) => num(r.inventory), fmt: money, kind: 'money', sub: true },
            { label: 'Other current assets', get: (r) => num(r.otherCurrentAssets), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Total long-term assets', get: (r) => { const t = num(r.totalNonCurrentAssets); if (t !== null) return t; const a = num(r.totalAssets); const c = num(r.totalCurrentAssets); return (a !== null && c !== null) ? a - c : null; }, fmt: money, kind: 'money' },
            { label: 'Property, plant & equipment', get: (r) => num(r.propertyPlantEquipment), fmt: money, kind: 'money', sub: true },
            { label: 'Long-term investments', get: (r) => num(r.longTermInvestments), fmt: money, kind: 'money', sub: true },
            { label: 'Goodwill & intangibles', get: (r) => { const g2 = num(r.goodwill); const ix = num(r.intangibleAssetsExcludingGoodwill); if (g2 !== null || ix !== null) return (g2 || 0) + (ix || 0); return num(r.intangibleAssets); }, fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Other long-term assets', get: (r) => num(r.otherNonCurrentAssets), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Total assets', get: (r) => num(r.totalAssets), fmt: money, kind: 'money', rule: true, solo: true },
            { label: 'Total current liabilities', get: (r) => num(r.totalCurrentLiabilities), fmt: money, kind: 'money' },
            { label: 'Accounts payable', get: (r) => num(r.currentAccountsPayable), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Short-term debt', get: (r) => { const a = num(r.shortTermDebt); const b = num(r.currentLongTermDebt); return a === null && b === null ? null : (a || 0) + (b || 0); }, fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Total long-term liabilities', get: (r) => { const t = num(r.totalNonCurrentLiabilities); if (t !== null) return t; const a = num(r.totalLiabilities); const c = num(r.totalCurrentLiabilities); return (a !== null && c !== null) ? a - c : null; }, fmt: money, kind: 'money' },
            { label: 'Long-term debt', get: (r) => num(r.longTermDebt), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Other non-current liabilities', get: (r) => num(r.otherNonCurrentLiabilities), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Total liabilities', get: (r) => num(r.totalLiabilities), fmt: money, kind: 'money', rule: true, solo: true, neutral: true },
            { label: 'Shareholder equity', get: (r) => num(r.totalShareholderEquity), fmt: money, kind: 'money' },
            { label: 'Common stock', get: (r) => num(r.commonStock), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Retained earnings', get: (r) => num(r.retainedEarnings), fmt: money, kind: 'money', sub: true },
            { label: 'Treasury stock', get: (r) => num(r.treasuryStock), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Total liabilities & equity', get: (r) => { const a = num(r.totalLiabilities); const e = num(r.totalShareholderEquity); return (a !== null && e !== null) ? a + e : null; }, fmt: money, kind: 'money', rule: true, solo: true },
            { label: 'Shares outstanding', get: (r) => num(r.commonStockSharesOutstanding), fmt: money, kind: 'shares', neutral: true, solo: true }
        ],
        cash: [
            { label: 'Cash flow from operations', get: (r) => num(r.operatingCashflow), fmt: money, kind: 'money', rule: true },
            { label: 'Net income', get: (r) => num(r.netIncome), fmt: money, kind: 'money', sub: true },
            { label: 'Depreciation & amortization', get: (r) => num(r.depreciationDepletionAndAmortization), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Change in receivables', get: (r) => num(r.changeInReceivables), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Change in inventory', get: (r) => num(r.changeInInventory), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Change in operating assets', get: (r) => num(r.changeInOperatingAssets), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Change in operating liabilities', get: (r) => num(r.changeInOperatingLiabilities), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Cash flow from investing', get: (r) => num(r.cashflowFromInvestment), fmt: money, kind: 'money', rule: true, neutral: true },
            { label: 'Capital expenditure', get: (r) => num(r.capitalExpenditures), fmt: money, kind: 'money', sub: true, invert: true },
            { label: 'Cash flow from financing', get: (r) => num(r.cashflowFromFinancing), fmt: money, kind: 'money', rule: true, neutral: true },
            { label: 'Debt issued / repaid, net', get: (r) => { const a = num(r.proceedsFromIssuanceOfLongTermDebtAndCapitalSecuritiesNet); const b = num(r.proceedsFromRepaymentsOfShortTermDebt); return a === null && b === null ? null : (a || 0) + (b || 0); }, fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Stock issued', get: (r) => num(r.proceedsFromIssuanceOfCommonStock), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Share buybacks', get: (r) => num(r.paymentsForRepurchaseOfCommonStock), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Dividends paid', get: (r) => num(r.dividendPayout), fmt: money, kind: 'money', sub: true, neutral: true },
            { label: 'Net change in cash', get: (r) => num(r.changeInCashAndCashEquivalents), fmt: money, kind: 'money', neutral: true, solo: true },
            { label: 'Free cash flow', get: (r) => fcfOf(r), fmt: money, kind: 'money', rule: true, solo: true }
        ]
    };

    let payload = null;
    let stState = 'income';
    let basisState = 'annual';
    let viewState = 'usd';
    let chartMode = 'price';
    let rangeYears = 10;
    let sharesByPeriod = new Map();
    let lastRender = { rows: [], periods: [] };

    function quoteCurrency(data = payload) {
        return currencyCode((data && data.overview && data.overview.Currency) || 'USD');
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
        return quoteCurrency(data) !== sourceReportingCurrency(data);
    }

    // ---------- data joins ----------
    function annualJoined() {
        const by = new Map();
        for (const st of ['income', 'balance', 'cash']) {
            for (const r of ((payload[st] || {}).annualReports) || []) {
                const k = String(r.fiscalDateEnding || '').slice(0, 7);
                if (!k) continue;
                if (!by.has(k)) by.set(k, { end: r.fiscalDateEnding });
                by.get(k)[st] = r;
            }
        }
        return [...by.values()].sort((a, b) => String(a.end).localeCompare(String(b.end)));
    }
    function monthlySeries(p) {
        const ts = (p.monthly || {})['Monthly Adjusted Time Series'] || (p.monthly || {})['Monthly Time Series'] || {};
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
                const k = String(r.fiscalDateEnding || '').slice(0, 7);
                const v = num(r.commonStockSharesOutstanding);
                if (k && v) sharesByPeriod.set(k, v);
            }
        }
    }
    // step function: shares as of a given month (latest fiscal period ≤ month)
    let _shareSteps = null;
    function sharesAt(month) {
        if (!_shareSteps) _shareSteps = [...sharesByPeriod.entries()].sort((a, b) => a[0].localeCompare(b[0]));
        if (!_shareSteps.length) return null;
        let s = _shareSteps[0][1];
        for (const [k, v] of _shareSteps) {
            if (k <= month) s = v; else break;
        }
        return s;
    }

    // ---------- ① masthead ----------
    function renderMasthead() {
        const ov = payload.overview || {};
        const q = (payload.quote || {})['Global Quote'] || {};
        $('co-crumb').textContent = [symbol, ov.Sector, ov.Exchange].filter(Boolean).join('  ·  ');
        $('co-name').textContent = ov.Name || symbol;
        const dos = $('co-dossier');
        if (dos) { dos.href = `/dossier.html?symbol=${encodeURIComponent(symbol)}`; dos.hidden = false; }
        document.title = `${ov.Name || symbol} (${symbol}) — 19 years of financials | stockportfolio.pro`;
        const price = num(q['05. price']);
        const chPct = num(String(q['10. change percent'] || '').replace('%', ''));
        $('co-price').textContent = price !== null ? currencyAmount(price, quoteCurrency(), { compact: false }) : '';
        const chEl = $('co-change');
        if (chPct !== null) {
            chEl.textContent = (chPct >= 0 ? '+' : '') + chPct.toFixed(2) + '% today';
            chEl.className = 'small num ' + (chPct >= 0 ? 'delta-pos' : 'delta-neg');
        }
    }

    // ---------- the dual-axis chart (price right, market cap left) ----------
    const GEOM = { W: 1280, H: 320, padL: 70, padR: 70, padT: 30, padB: 28 };
    // capAxisMult: when no separate cap line is drawn, the left axis still
    // reads in market-cap terms — price tick × current share count.
    function dualChart(price, cap, labels, fmtPrimary, capAxisMult) {
        const { W, H, padL, padR, padT, padB } = GEOM;
        const fmtP = fmtPrimary || ((v) => currencyAmount(v, quoteCurrency(), {
            compact: false,
            decimals: v >= 100 ? 0 : 1
        }));
        const scale = (vals) => {
            const vs = vals.filter((v) => v !== null && Number.isFinite(v));
            let min = Math.min(...vs); let max = Math.max(...vs);
            if (min === max) { min -= 1; max += 1; }
            const span = max - min; min -= span * 0.05; max += span * 0.05;
            return { min, max };
        };
        const sp = scale(price);
        const sc = cap ? scale(cap) : null;
        const x = (i, n) => padL + (n < 2 ? 0 : (i / (n - 1)) * (W - padL - padR));
        const yP = (v) => padT + (1 - (v - sp.min) / (sp.max - sp.min)) * (H - padT - padB);
        const yC = (v) => padT + (1 - (v - sc.min) / (sc.max - sc.min)) * (H - padT - padB);
        let g = '';
        for (let i = 0; i <= 3; i++) {
            const fr = i / 3;
            const yy = padT + (1 - fr) * (H - padT - padB);
            g += `<line x1="${padL}" y1="${yy.toFixed(1)}" x2="${W - padR}" y2="${yy.toFixed(1)}" stroke="var(--line)" stroke-width="1"/>`;
            const pv = sp.min + fr * (sp.max - sp.min);
            g += `<text x="${W - padR + 8}" y="${(yy + 3.5).toFixed(1)}" font-size="10.5" fill="var(--ink-3)" style="font-variant-numeric:tabular-nums">${esc(fmtP(pv))}</text>`;
            if (sc) {
                const cv = sc.min + fr * (sc.max - sc.min);
                g += `<text x="${padL - 8}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end" font-size="10.5" fill="var(--ink-3)" style="font-variant-numeric:tabular-nums">${esc(currencyAmount(cv, quoteCurrency()))}</text>`;
            } else if (capAxisMult) {
                g += `<text x="${padL - 8}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end" font-size="10.5" fill="var(--ink-3)" style="font-variant-numeric:tabular-nums">${esc(currencyAmount(pv * capAxisMult, quoteCurrency()))}</text>`;
            }
        }
        // solid axis borders: left and bottom only — the right edge stays open
        g += `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${H - padB}" stroke="var(--line-strong)" stroke-width="1.4"/>`;
        g += `<line x1="${padL}" y1="${H - padB}" x2="${W - padR}" y2="${H - padB}" stroke="var(--line-strong)" stroke-width="1.4"/>`;
        const n = price.length;
        // draw at the indices that actually carry a (deduped) label, capped ~8
        const labelIdx = labels.map((l, i) => l ? i : -1).filter((i) => i >= 0);
        const lstep = Math.max(1, Math.ceil(labelIdx.length / 8));
        for (let j = 0; j < labelIdx.length; j += lstep) {
            const i = labelIdx[j];
            g += `<text x="${x(i, n).toFixed(1)}" y="${H - 8}" text-anchor="middle" font-size="10.5" fill="var(--ink-3)">${esc(labels[i])}</text>`;
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
        if (sc) g += path(cap, yC, 'var(--accent)', 1.4);
        g += path(price, yP, 'var(--ink)', 1.8);
        // last value: dot on the line + a clear badge ON the right axis, where
        // the line can never hide it
        const li = price.length - 1;
        if (price[li] !== null) {
            const ly = yP(price[li]);
            g += `<circle cx="${x(li, n).toFixed(1)}" cy="${ly.toFixed(1)}" r="3.2" fill="var(--ink)"/>`;
            g += `<rect x="${W - padR + 2}" y="${(ly - 11).toFixed(1)}" width="${padR - 4}" height="20" rx="5" fill="var(--ink)"/>`;
            g += `<text x="${W - padR + (padR - 2) / 2}" y="${(ly + 3.5).toFixed(1)}" text-anchor="middle" font-size="11" font-weight="650" fill="var(--paper, #faf9f6)" style="font-variant-numeric:tabular-nums">${esc(fmtP(price[li]))}</text>`;
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
            const useDaily = rangeYears < 1;
            const src = useDaily ? dailySeriesPts() : series;
            if (src.length < (useDaily ? 30 : 12)) return;
            const win = useDaily
                ? src.slice(-126)
                : src.slice(rangeYears >= 99 ? 0 : Math.max(0, src.length - rangeYears * 12));
            const price = win.map((p) => p.close);
            const rawLabels = useDaily
                ? win.map((p) => new Date(p.month + 'T12:00').toLocaleString('en-US', { month: 'short' }))
                : win.map((p) => p.month.slice(0, 4));
            let seen = '';
            const yl = rawLabels.map((y) => { if (y === seen) return ''; seen = y; return y; });
            const cap = (!mixedCurrencies && showCap && sharesByPeriod.size)
                ? win.map((p) => { const s = sharesAt(p.month.slice(0, 7)); return s ? p.close * s : null; })
                : null;
            // left axis ALWAYS reads in market cap — via the live cap line
            // when shown, otherwise price × the current share count
            const sharesNow = !mixedCurrencies && sharesByPeriod.size ? sharesAt('9999-12') : null;
            $('main-chart').innerHTML = dualChart(price, cap, yl, null, cap ? null : sharesNow);
            const fmtPoint = useDaily
                ? (m) => new Date(m + 'T12:00').toLocaleString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })
                : (m) => new Date(m + '-15').toLocaleString('en-US', { month: 'short', year: 'numeric' });
            wireChartHover(win.map((p) => ({
                label: fmtPoint(p.month),
                lines: [currencyAmount(p.close, quoteCurrency(), { compact: false })] // price only — the cap reads off the left axis
            })));
            $('chart-prov').textContent = mixedCurrencies
                ? `Price is shown in ${quoteCurrency()}. Historical P/E and price × filed-share-count overlays are disabled because the source statements are reported in ${sourceReportingCurrency()}; USD presentation conversion does not supply the listing’s depositary-share ratio.`
                : cap
                ? 'Price (right axis): split-adjusted — ink. Market cap (left axis): price × that fiscal year’s filed share count — blue. Where the lines drift apart, buybacks or dilution is why.'
                : `Price (right axis): ${useDaily ? 'daily' : 'monthly'}, split-adjusted. Left axis: the equivalent market cap at today’s share count.`;
        } else {
            // P/E by fiscal year: avg monthly close within the FY ÷ diluted EPS
            const inc = ((payload.income || {}).annualReports || []).slice().reverse();
            const vals = []; const labels = [];
            for (const r of inc) {
                const eps = num(r.dilutedEPS);
                const end = String(r.fiscalDateEnding || '').slice(0, 7);
                if (eps === null || eps <= 0 || !end) continue;
                const endIdx = series.findIndex((p) => p.month >= end);
                const idx = endIdx === -1 ? series.length - 1 : endIdx;
                const windowMonths = series.slice(Math.max(0, idx - 11), idx + 1);
                if (!windowMonths.length) continue;
                const avg = windowMonths.reduce((a, p) => a + p.close, 0) / windowMonths.length;
                vals.push(avg / eps);
                labels.push('FY' + new Date(r.fiscalDateEnding).getFullYear());
            }
            const keep = rangeYears >= 99 ? vals.length : Math.min(vals.length, Math.max(3, rangeYears));
            const v = vals.slice(-keep); const l = labels.slice(-keep);
            $('main-chart').innerHTML = dualChart(v, null, l, (x2) => Math.round(x2) + '×');
            wireChartHover(v.map((pe, i) => ({ label: l[i], lines: [Math.round(pe * 10) / 10 + '× earnings'] })));
            $('chart-prov').textContent = 'P/E by fiscal year: average monthly close across the year ÷ that year’s diluted EPS, both split-adjusted.';
        }
        $('cap-toggle').hidden = chartMode !== 'price' || mixedCurrencies;
        $('chart-block').hidden = false;
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
        ];
        $('kv-grid').innerHTML = items.map(([l, v]) =>
            `<div class="kv-row"><span>${l}</span><b>${v}</b></div>`).join('');
    }

    // ---------- ③ key points: the dossier from the 10-K ----------
    async function renderDossier() {
        const body = $('kp-body');
        try {
            const r = await fetch(`/api/company/${encodeURIComponent(symbol)}/keypoints`);
            if (!r.ok) { body.innerHTML = '<p class="small muted">Key points unavailable for this company.</p>'; return; }
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
        const yrSpan = years.length - 1;
        const checks = [];
        const add = (label, ok, detail) => { if (ok !== null) checks.push({ label, pass: !!ok, detail }); };

        const revC = cagr(get(years[0], 'income', 'totalRevenue'), get(last, 'income', 'totalRevenue'), yrSpan);
        add(`Revenue compounding over ${yrSpan} years`, revC === null ? null : revC > 4, revC === null ? '' : revC.toFixed(1) + '%/yr');
        const ni = (y) => get(y, 'income', 'netIncome');
        add('Profitable every year, last five', span(5).length >= 5 ? span(5).every((y) => (ni(y) || 0) > 0) : null, '');
        const nmOf = (y) => ratio(ni(y), get(y, 'income', 'totalRevenue'));
        const nmNow = nmOf(last); const nm5 = years.length > 5 ? nmOf(years[years.length - 6]) : null;
        if (nmNow !== null && nm5 !== null && Math.abs(nmNow - nm5) > 0.02) {
            add('Net margin direction, five years', nmNow > nm5, `${pct(nm5 * 100)} → ${pct(nmNow * 100)}`);
        }
        add('Net margin above 10%', nmNow === null ? null : nmNow > 0.10, nmNow === null ? '' : pct(nmNow * 100));
        const cashRaw = get(last, 'balance', 'cashAndCashEquivalentsAtCarryingValue');
        const cash = (cashRaw || 0) + (get(last, 'balance', 'shortTermInvestments') || 0);
        const debt = debtOf(last.balance || {});
        add('More cash than total debt', cashRaw === null ? null : cash > (debt || 0), `${currencyAmount(cash, reportingCurrency())} vs ${currencyAmount(debt || 0, reportingCurrency())}`);
        add('Operating cash flow positive, five years', span(5).length >= 5 ? span(5).every((y) => (get(y, 'cash', 'operatingCashflow') || 0) > 0) : null, '');
        const fcfN = fcfOf(last.cash || {});
        add('Free cash flow positive, latest year', fcfN === null ? null : fcfN > 0, fcfN === null ? '' : currencyAmount(fcfN, reportingCurrency()));
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
        return checks;
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
        const sector = ((payload.overview || {}).Sector || '').trim();
        if (!sector) return;
        try {
            const r = await fetch(`/api/screener?sector=${encodeURIComponent(sector)}&limit=100`);
            const data = await r.json();
            const all = (data.rows || []).filter((x) => x.marketCapB !== null);
            if (all.length < 3) return;
            const med = (key) => {
                const vs = all.map((x) => x[key]).filter((v) => v !== null).sort((a, b) => a - b);
                return vs.length ? vs[Math.floor(vs.length / 2)] : null;
            };
            const self = all.find((x) => x.symbol === symbol);
            const rows = [self].concat(all.filter((x) => x.symbol !== symbol).slice(0, 7)).filter(Boolean);
            const cell = (v, f, colored) => v === null || v === undefined ? '—'
                : `<span class="${colored && v !== 0 ? (v > 0 ? 'delta-pos' : 'delta-neg') : ''}">${f(v)}</span>`;
            let html = `<thead><tr><th class="row-head" style="text-align:left;">Company</th><th>Mkt cap</th><th>P/E</th><th>Rev CAGR 5y</th><th>Profit growth YoY</th><th>Net margin</th><th>ROE</th><th>Div yield</th><th>Profit yrs/10</th></tr></thead><tbody>`;
            for (const x of rows) {
                const hl = x.symbol === symbol;
                html += `<tr data-sym="${esc(x.symbol)}" style="${hl ? 'font-weight:650;' : ''}">
                  <td class="row-head">${esc(x.symbol)}&ensp;<span class="muted" style="font-weight:400;">${esc(x.name || '')}</span></td>
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
            html += `<tr class="row-rule"><td class="row-head muted">Median · ${all.length} companies</td>
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
            $('peers-sub').textContent = sector.toLowerCase() + ' · median of ' + all.length;
            // Navigate on a genuine TAP only. A horizontal swipe to scroll the
            // table used to register as a click and yank you to another company,
            // which made the table feel like it couldn't be scrolled on a phone.
            let pStart = null;
            table.addEventListener('pointerdown', (e) => { pStart = { x: e.clientX, y: e.clientY }; });
            table.querySelectorAll('tr[data-sym]').forEach((tr) =>
                tr.addEventListener('click', (e) => {
                    if (pStart && (Math.abs(e.clientX - pStart.x) > 8 || Math.abs(e.clientY - pStart.y) > 8)) return;
                    if (tr.dataset.sym !== symbol) location.href = `/company.html?symbol=${tr.dataset.sym}`;
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
        { label: 'FCF margin', get: (p) => { const c = ((p.cash || {}).annualReports || [])[0] || {}; const r = ((p.income || {}).annualReports || [])[0] || {}; return pctFmt(ratio(fcfOf(c), derive(r).rev)); } },
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
            results.innerHTML = items.map((c) =>
                `<a href="#" data-sym="${esc(c.symbol)}"><span class="sym">${esc(c.symbol)}</span><span class="nm">${esc(c.name)}</span></a>`).join('');
            results.hidden = !items.length;
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
                    const sh = sharesByPeriod.get(String(rows[i].fiscalDateEnding || '').slice(0, 7));
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
    function groupDefs(defs, st) {
        const out = defs.map((d) => ({ ...d }));
        // a parent is a non-sub row immediately FOLLOWED by sub rows — its
        // components unfold below it
        let parent = null;
        let gid = -1;
        for (const d of out) {
            if (d.sub) {
                if (parent) {
                    if (parent.parentOf === undefined) { gid++; parent.parentOf = gid; }
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
        if (!table || !wrap || !rowHead || !wrap.clientWidth) return;

        const oldMax = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
        const wasAtLatest = oldMax === 0 || oldMax - wrap.scrollLeft <= 4;
        const oldProgress = oldMax ? wrap.scrollLeft / oldMax : 1;
        const rowHeadWidth = rowHead.getBoundingClientRect().width;
        const availableForYears = Math.max(1, wrap.clientWidth - rowHeadWidth);
        const completeYears = window.innerWidth <= 760
            ? (availableForYears >= 176 ? 2 : 1)
            : Math.max(3, Math.floor(availableForYears / 108));
        table.style.setProperty('--stmt-year-width', `${availableForYears / completeYears}px`);

        // Layout is synchronous for the width calculation. Preserve a reader's
        // approximate history position on resize; initial renders remain pinned
        // to the latest complete fiscal-year column.
        const newMax = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
        wrap.scrollLeft = !preservePosition || wasAtLatest ? newMax : oldProgress * newMax;
        const top = $('stmt-scroll-top');
        if (top && top.firstElementChild) {
            top.firstElementChild.style.width = wrap.scrollWidth + 'px';
            top.scrollLeft = wrap.scrollLeft;
        }
        updateHbar(wrap);
    }
    function renderStatements() {
        const rows = reports(stState, basisState);
        const table = $('stmt-table');
        if (!rows.length) { table.innerHTML = '<tbody><tr><td style="text-align:left">No data filed for this view.</td></tr></tbody>'; return; }
        lastRender = { rows: [], periods: rows.map((r) => periodLabel(r, basisState)) };
        const expanded = expandedGroups[stState] || new Set();
        const reportCur = reportingCurrency();
        const converted = Boolean(payload.currencyConversion && payload.currencyConversion.from && payload.currencyConversion.to === 'USD');
        let html = '<thead><tr><th class="row-head" style="text-align:left">' +
            (viewState === 'yoy' ? 'YoY growth' : viewState === 'ps' ? `Per filed share · ${reportCur}` : `${reportCur} · ${converted ? 'converted' : 'reported'}`) +
            '</th><th style="width:96px">Trend</th>';
        rows.forEach((r, i) => { html += `<th${i === rows.length - 1 ? " class='col-now'" : ''}>${periodLabel(r, basisState)}</th>`; });
        html += '</tr></thead><tbody>';
        let ri = 0;
        const defs = groupDefs(ROWS[stState], stState);
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
            if (raw.every((v) => v === null)) continue;
            const { vals, fmt, colored } = viewVals(def, raw, rows);
            if (vals.every((v) => v === null)) continue;
            lastRender.rows.push({ label: def.label, vals, fmt, neutral: !!def.neutral });
            const sparkVals = def.invert ? vals.map((v) => v === null ? null : -v) : vals;
            const isParent = def.parentOf !== undefined && liveGroups.has(def.parentOf);
            const inGroup = def.gid !== undefined;
            const hide = inGroup && !expanded.has(def.gid);
            const caret = isParent
                ? `<button class="grp-caret" data-g="${def.parentOf}" aria-label="Expand components" title="Show the components">${expanded.has(def.parentOf) ? '▾' : '▸'}</button>`
                : '';
            html += `<tr class="${def.sub ? 'row-sub' : ''} ${def.rule ? 'row-rule' : ''}${inGroup ? ' grp-' + def.gid : ''}${isParent ? ' grp-parent' : ''}"${isParent ? ` data-g="${def.parentOf}"` : ''} data-i="${ri}"${hide ? ' hidden' : ''}>
              <td class="row-head">${caret}${def.label}</td>
              <td>${sparkline(sparkVals, { neutral: !!def.neutral })}</td>`;
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
        const provenance = $('stmt-prov');
        if (provenance) {
            const mismatch = hasCurrencyMismatch();
            const conversionText = converted
                ? `Financial statements are shown in USD, converted from ${sourceReportingCurrency()}. Balance-sheet figures use the fiscal-period closing monthly FX rate; income and cash-flow figures use average month-end FX rates over each reporting period. This is an approximate convenience conversion. `
                : `Financial statements are shown in ${reportCur}, the company’s reported currency; no FX conversion is applied. `;
            provenance.textContent = conversionText +
                (mismatch ? `The exchange-traded quote and market-cap data are in ${quoteCurrency()}; ADR-dependent valuation overlays remain disabled. ` : '') +
                'Figures come from company filings (10-K/10-Q or foreign-filer equivalents), as filed. Per-share figures and share counts are adjusted to the current split basis. ▸ unfolds a total into its components.';
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
        // proxy scrollbar above the table mirrors the real one below
        const top = $('stmt-scroll-top');
        top.firstElementChild.style.width = wrap.scrollWidth + 'px';
        top.scrollLeft = wrap.scrollLeft;
        attachHScroll(wrap);
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
        if (!wrap) return;
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
    (function wireTopScroll() {
        const top = $('stmt-scroll-top');
        const wrap = $('stmt-wrap');
        top.addEventListener('scroll', () => { if (wrap.scrollLeft !== top.scrollLeft) wrap.scrollLeft = top.scrollLeft; });
        wrap.addEventListener('scroll', () => { if (top.scrollLeft !== wrap.scrollLeft) top.scrollLeft = wrap.scrollLeft; });
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
        const roes = years.map((y) => ratio(num((y.income || {}).netIncome), num((y.balance || {}).totalShareholderEquity)));
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
    const RATIOS = [
        { label: 'Gross margin', get: (y) => { const d = derive(y.income || {}); return ratio(d.gp, d.rev); }, fmt: pctFmt },
        { label: 'Operating margin', get: (y) => ratio(num((y.income || {}).operatingIncome), derive(y.income || {}).rev), fmt: pctFmt },
        { label: 'Net margin', get: (y) => ratio(num((y.income || {}).netIncome), derive(y.income || {}).rev), fmt: pctFmt },
        { label: 'FCF margin', get: (y) => ratio(fcfOf(y.cash || {}), derive(y.income || {}).rev), fmt: pctFmt },
        { label: 'Return on equity', get: (y) => ratio(num((y.income || {}).netIncome), num((y.balance || {}).totalShareholderEquity)), fmt: pctFmt },
        { label: 'Return on assets', get: (y) => ratio(num((y.income || {}).netIncome), num((y.balance || {}).totalAssets)), fmt: pctFmt },
        { label: 'Current ratio', get: (y) => ratio(num((y.balance || {}).totalCurrentAssets), num((y.balance || {}).totalCurrentLiabilities)), fmt: (v) => v === null ? '—' : fixed(v, 2) },
        { label: 'Debt to equity', get: (y) => ratio(debtOf(y.balance || {}), num((y.balance || {}).totalShareholderEquity)), fmt: (v) => v === null ? '—' : fixed(v, 2) },
        { label: 'OCF / net income', get: (y) => ratio(num((y.cash || {}).operatingCashflow), num((y.income || {}).netIncome)), fmt: (v) => v === null ? '—' : fixed(v, 2) },
        { label: 'Capex % of revenue', get: (y) => { const c = num((y.cash || {}).capitalExpenditures); const r = derive(y.income || {}).rev; return (c !== null && r) ? Math.abs(c) / r : null; }, fmt: pctFmt }
    ];
    function renderRatios() {
        const years = annualJoined().slice(-19);
        const table = $('ratio-table');
        if (years.length < 2) { table.innerHTML = ''; return; }
        const periods = years.map((y) => 'FY' + new Date(y.end).getFullYear());
        const render = { rows: [], periods };
        let html = '<thead><tr><th class="row-head" style="text-align:left">Ratio</th><th style="width:96px">Trend</th>';
        periods.forEach((p, i) => { html += `<th${i === periods.length - 1 ? " class='col-now'" : ''}>${p}</th>`; });
        html += '</tr></thead><tbody>';
        let ri = 0;
        for (const def of RATIOS) {
            const vals = years.map((y) => def.get(y));
            if (vals.every((v) => v === null)) continue;
            render.rows.push({ label: def.label, vals, fmt: def.fmt, neutral: false });
            html += `<tr class="row-data" data-i="${ri}" title="Click for chart"><td class="row-head">${def.label}</td><td>${sparkline(vals)}</td>`;
            vals.forEach((v, i) => { html += `<td class="${i === vals.length - 1 ? 'col-now' : ''}">${def.fmt(v)}</td>`; });
            html += '</tr>';
            ri++;
        }
        table.innerHTML = html + '</tbody>';
        wireExpand(table, render);
        attachHScroll(table.closest('.table-wrap'));
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
    let isPro = null;
    async function proStatus() {
        if (isPro !== null) return isPro;
        if (!token()) { isPro = false; return false; }
        try {
            const r = await fetch(`${API}/ai/chat/quota`, { headers: { Authorization: `Bearer ${token()}` } });
            isPro = r.ok ? !!(await r.json()).pro : false;
        } catch (_) { isPro = false; }
        return isPro;
    }
    let form4Quarters = null; // parsed-from-EDGAR history once built
    let form4Meta = '';
    async function renderInsiderHistory(o) {
        histTx = (o.insiderTransactions || []).filter((t) => t.date);
        await proStatus();
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
            if ((d.quarters || []).length) {
                form4Quarters = d.quarters;
                form4Meta = `${d.filingsParsed} Form 4 filings parsed directly from EDGAR` + (d.building ? ' — still building…' : '');
                paintInsiderHistory();
                $('insider-hist-block').hidden = false;
                // the parsed feed also upgrades the transactions table (3yr deep)
                if ((d.recent || []).length) {
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
        const shown = keys.slice(-12); // everything the feed reaches — up to 3 years
        const latest = shown[shown.length - 1];
        const lock = !isPro;
        const cell = (k, v) => (lock && k === latest)
            ? '<span title="The latest period is a Pro feature" style="filter:blur(5px); user-select:none;">●●●</span>'
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
            shown.map((k) => `<th${k === latest ? " class='col-now'" : ''}>${esc(k)}${lock && k === latest ? ' 🔒' : ''}</th>`).join('') + '</tr></thead><tbody>';
        for (const [label, fn] of rows) {
            html += `<tr><td class="row-head">${label}</td>` +
                shown.map((k) => {
                    const v = fn(buckets.get(k));
                    const cls = label === 'Net shares' && !(lock && k === latest) ? (v.startsWith('+') ? 'delta-pos' : v.startsWith('−') ? 'delta-neg' : '') : '';
                    return `<td class="${cls}${k === latest ? ' col-now' : ''}">${cell(k, v)}</td>`;
                }).join('') + '</tr>';
        }
        $('insider-hist-table').innerHTML = html + '</tbody>';
        attachHScroll($('insider-hist-table').closest('.table-wrap'));
        $('insider-hist-prov').innerHTML = (lock
            ? '🔒 The most recent period is part of Pro — <a href="/register.html?plan=pro">upgrade</a> to see what insiders did latest. '
            : '') + esc(form4Meta || 'Aggregated from Form 4 filings, as far back as the transactions feed reaches.');
    }

    let insiderSide = 'all';
    let insiderData = [];
    function renderInsiders(o) {
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
        const teaser = (what) => `${what} is a Pro feature — <a href="/register.html?plan=pro">upgrade</a> or <a href="/login.html">log in</a>.`;
        if (!token()) {
            segBody.innerHTML = `<p class="small muted">${teaser('Business segments from the 10-K')}</p>`;
            insBody.innerHTML = `<p class="small muted">${teaser('Insights — the analyst’s reading of 19 years of filings, the valuation record and sector position')}</p>`;
            return;
        }
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
            renderStatements();
        }));
    document.querySelectorAll('#seg-view button').forEach((b) =>
        b.addEventListener('click', () => {
            document.querySelectorAll('#seg-view button').forEach((x) => x.setAttribute('aria-pressed', x === b));
            viewState = b.dataset.view;
            renderStatements();
        }));

    // ---------- load ----------
    (async () => {
        try {
            const assetRes = await fetch(`${API}/assets/${encodeURIComponent(symbol)}/profile?history=1`);
            const assetData = assetRes.ok ? await assetRes.json() : null;
            if (assetData && ['etf', 'mutual_fund'].includes(assetData.profile && assetData.profile.assetType)) {
                renderFundProfile(assetData);
                mountAskFloor({ placeholder: `Ask about ${symbol} — fees, holdings, allocation, performance and risk…  (⌘K)` });
                return;
            }
            mountAskFloor({ placeholder: `Ask about ${symbol} — answers come from its SEC filings…  (⌘K)` });
            const r = await fetch(`/api/demo/alpha/fundamentals/${encodeURIComponent(symbol)}?presentationCurrency=USD`);
            if (!r.ok) throw new Error('load failed');
            payload = await r.json();
            buildSharesMap();
            renderMasthead();
            renderMainChart();
            renderKv();
            renderDossier();
            renderAbout();
            renderChecks();
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
