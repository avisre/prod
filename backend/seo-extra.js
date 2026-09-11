// Programmatic SEO surfaces beyond the per-ticker page (the "Macrotrends
// playbook"): per-metric history pages (/stocks/SYM/revenue …), head-to-head
// ticker comparisons (/compare/AAPL-vs-MSFT), and live screener-preset
// landing pages (/screens/dividend-stocks …). All server-rendered from the
// nightly fundamentals cache; shares head/nav/footer with seo-pages.js.

const express = require('express');
const fs = require('fs');
const path = require('path');
const seo = require('./seo-pages');
const aiChat = require('./ai-chat');
const marketingAttribution = require('./marketing-attribution');
const shareCopy = require('./share-copy');

const SITE = 'https://www.stockportfolio.pro';
const { esc, num, money, price, pct, ratio, head, nav, footer, loadCompanies, loadFundamentals, resolveCanonicalSymbol } = seo;
const { normalizeTicker } = require('./symbol-resolver');

// The activation pilot is deliberately dark by default. Its eligibility is a
// generated, secret-free manifest from observed Search Console query/page
// rows, so a flag change cannot silently turn every ticker page into a CTA.
const ACTIVATION_MANIFEST = path.join(__dirname, '..', 'seo-data', 'activation-eligibility.json');
let _activationManifest = null;
function activationManifest() {
    if (_activationManifest) return _activationManifest;
    try {
        const parsed = JSON.parse(fs.readFileSync(ACTIVATION_MANIFEST, 'utf8'));
        _activationManifest = parsed && Array.isArray(parsed.eligiblePages) ? parsed : { eligiblePages: [] };
    } catch (_) { _activationManifest = { eligiblePages: [] }; }
    return _activationManifest;
}
function pilotEnabled() { return process.env.SEO_ACTIVATION_PILOT === 'true'; }
function organicRequest(req) {
    const referrer = req && (req.headers?.referer || req.headers?.referrer);
    const referrerSource = marketingAttribution.referrerSource(referrer);
    let cookieSource = null;
    try {
        const acquisition = shareCopy.parseAcquisitionCookieHeader(req && req.headers && req.headers.cookie, { secret: process.env.JWT_SECRET });
        cookieSource = acquisition && acquisition.source;
    } catch (_) { /* a missing local secret simply disables cookie attribution */ }
    const source = ['google', 'bing', 'duckduckgo'].includes(referrerSource) ? referrerSource : cookieSource;
    // Search referrer is the conservative source of truth for this first
    // pilot. A URL parameter such as source=organic is intentionally ignored.
    return ['google', 'bing', 'duckduckgo'].includes(source);
}
function pilotEligibility(symbol, slug) {
    const pathName = `/stocks/${String(symbol || '').toUpperCase()}/${String(slug || '').toLowerCase()}`;
    const match = activationManifest().eligiblePages.find((page) => page.path === pathName);
    if (!match) return null;
    const family = String(match.queryCluster || '');
    const family2 = activationManifest().selectedSecondFamily;
    const firstFamily = ['earnings/EPS/profit'].includes(family) && ['eps', 'net-income'].includes(String(slug).toLowerCase());
    const secondFamily = family2 === 'REVENUE_HISTORY' && family === 'revenue' && String(slug).toLowerCase() === 'revenue';
    if (!firstFamily && !secondFamily) return null;
    return match;
}
function pilotAction(symbol, slug, req) {
    if (!pilotEnabled() || !organicRequest(req)) return null;
    const match = pilotEligibility(symbol, slug);
    if (!match) return null;
    const metric = String(slug).toLowerCase() === 'eps' ? 'eps' : String(slug).toLowerCase();
    const contentId = metric === 'revenue' ? 'seo-revenue-next-action' : 'seo-eps-next-action';
    const label = metric === 'revenue' ? 'Explain this revenue change' : 'Explain these earnings changes';
    const href = `/ask?symbol=${encodeURIComponent(String(symbol).toUpperCase())}&metric=${encodeURIComponent(metric)}&content_id=${contentId}`;
    return { href, label, contentId, metric, queryCluster: match.queryCluster };
}

function renderPilotAction(action, symbol, name) {
    if (!action) return '';
    return `<aside class="seo-next-action" data-seo-experiment="seo-activation-pilot-v1" data-seo-variant="treatment" aria-label="Continue this filing research">
    <p class="seo-next-action-kicker">Next research step</p>
    <h2>${esc(action.label)}</h2>
    <p>Keep the filed periods and source context in view while you investigate ${esc(name)} (${esc(symbol)}). This opens a structured Ask question; it does not make an investment recommendation.</p>
    <a class="seo-cta-btn" data-seo-action="next-research" data-content-id="${esc(action.contentId)}" data-seo-page-type="metric" data-seo-ticker="${esc(symbol)}" data-seo-metric="${esc(action.metric)}" data-seo-query-cluster="${esc(action.queryCluster)}" data-seo-experiment="seo-activation-pilot-v1" data-seo-variant="treatment" data-destination-kind="ask" href="${esc(action.href)}">${esc(action.label)} &rarr;</a>
  </aside>`;
}

// ---------- shared helpers ----------
const fyYear = (r) => String((r || {}).fiscalDateEnding || '').slice(0, 4);
const cagr = (oldV, newV, yrs) =>
    (oldV > 0 && newV > 0 && yrs > 1) ? (Math.pow(newV / oldV, 1 / yrs) - 1) * 100 : null;

function grossProfitOf(r) {
    const rev = num(r.totalRevenue);
    let gp = num(r.grossProfit); if (gp === 0) gp = null;
    let cor = num(r.costOfRevenue); if (cor === 0) cor = null;
    if (gp === null && rev !== null && cor !== null) gp = rev - cor;
    return gp;
}
function totalDebtOf(b) {
    const ltd = num(b.longTermDebt) !== null ? num(b.longTermDebt) : num(b.longTermDebtNoncurrent);
    const std = num(b.shortTermDebt) !== null ? num(b.shortTermDebt) : num(b.currentDebt);
    if (ltd === null && std === null) return null;
    return (ltd || 0) + (std || 0);
}
// Year-end adjusted close from the monthly series, for the P/E history.
function closeAtFiscalEnd(data, fiscalDateEnding) {
    const ts = data?.monthly?.['Monthly Adjusted Time Series'];
    if (!ts || !fiscalDateEnding) return null;
    const months = Object.keys(ts).filter((d) => d <= fiscalDateEnding).sort();
    const last = months[months.length - 1];
    return last ? num(ts[last]['5. adjusted close']) : null;
}
// Monthly adjusted-close series (split- and dividend-adjusted) for return math.
function monthlySeries(data) {
    const ts = data?.monthly?.['Monthly Adjusted Time Series'];
    if (!ts) return [];
    return Object.keys(ts)
        .map((d) => ({ date: d, close: num(ts[d]['5. adjusted close']) }))
        .filter((p) => p.close !== null)
        .sort((a, b) => a.date.localeCompare(b.date));
}
// 52-week high/low. The quote summary's 52WeekHigh/52WeekLow is the source of
// truth, but a handful of cached tickers come back without them (9/8: AMVD,
// BIOA, ENLT, IAC, IIIV, IINNW, JACS.UN, TTAM) and rendered a bare em-dash.
// Fall back to the unadjusted monthly bars — real (not adjusted) prices at
// monthly granularity, requiring all 12 months so a 6-month-old listing never
// gets a fabricated "52-week" range.
function fiftyTwoWeekRange(data) {
    const q = { high: num(data?.overview?.['52WeekHigh']), low: num(data?.overview?.['52WeekLow']) };
    if (q.high != null && q.low != null) return q;
    const ts = data?.monthly?.['Monthly Adjusted Time Series'];
    const pts = ts ? Object.keys(ts).sort((x, y) => x.localeCompare(y)).slice(-12) : [];
    if (pts.length === 12) {
        let hi = null; let lo = null;
        for (const d of pts) {
            const h = num(ts[d]['2. high']); const l = num(ts[d]['3. low']);
            if (h !== null && (hi === null || h > hi)) hi = h;
            if (l !== null && (lo === null || l < lo)) lo = l;
        }
        if (hi !== null && lo !== null) return { high: hi, low: lo };
    }
    return q;
}
// Total return over `years` from the monthly adjusted-close series; null when
// the series is too short to cover the window.
function totalReturn(series, years) {
    if (!series || series.length < 2) return null;
    const latest = series[series.length - 1];
    const target = new Date(latest.date);
    target.setUTCFullYear(target.getUTCFullYear() - years);
    const targetStr = target.toISOString().slice(0, 10);
    let i = series.length - 1;
    while (i >= 0 && series[i].date > targetStr) i--;
    if (i < 0) return null;
    const base = series[i].close;
    if (!base) return null;
    return (latest.close / base - 1) * 100;
}

// Year-to-date return: latest close vs the last point before the current year.
function ytdReturn(series) {
    if (!series || series.length < 2) return null;
    const latest = series[series.length - 1];
    const currentYear = latest.date.slice(0, 4);
    let i = series.length - 1;
    while (i >= 0 && series[i].date.slice(0, 4) >= currentYear) i--;
    if (i < 0) return null;
    const base = series[i].close;
    if (!base) return null;
    return (latest.close / base - 1) * 100;
}
// Trailing-12-month high/low from the same monthly series shown on the page.
function range52w(series) {
    if (!series || series.length < 2) return null;
    const latest = series[series.length - 1];
    const cutoff = new Date(latest.date);
    cutoff.setUTCFullYear(cutoff.getUTCFullYear() - 1);
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    const win = series.filter((p) => p.date >= cutoffStr);
    if (win.length < 2) return null;
    return { low: Math.min(...win.map((p) => p.close)), high: Math.max(...win.map((p) => p.close)) };
}
// Monthly adjusted-close line chart; a dated sibling of trendSvg (which labels
// fiscal years). Monthly points carry their calendar month in the hover title.
function monthlyTrendSvg(rows, label, caption) {
    if (!rows || rows.length < 2) return '';
    const min = Math.min(...rows.map((p) => p.close));
    const max = Math.max(...rows.map((p) => p.close));
    const span = max - min || 1; const width = 760; const height = 220; const pad = 28;
    const points = rows.map((p, i) => {
        const x = pad + i * ((width - pad * 2) / Math.max(rows.length - 1, 1));
        const y = height - pad - ((p.close - min) / span) * (height - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<figure style="margin:20px 0"><svg role="img" aria-labelledby="metric-chart-title" viewBox="0 0 ${width} ${height}" style="display:block;width:100%;height:auto;background:var(--surface);border:1px solid var(--line);border-radius:10px"><title id="metric-chart-title">${esc(label)}</title><line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="var(--line2)"/><polyline fill="none" stroke="var(--accent)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" points="${points}"/>${rows.map((p, i) => { const [x, y] = points.split(' ')[i].split(','); return `<circle cx="${x}" cy="${y}" r="4" fill="var(--surface)" stroke="var(--accent)" stroke-width="3"><title>${esc(p.date)}: ${esc(price(p.close))}</title></circle>`; }).join('')}</svg><figcaption style="font-size:12px;color:var(--ink3);margin-top:7px">${esc(caption)}</figcaption></figure>`;
}

// ---------- sector percentile + peer enrichment ----------
// Cross-company context for the per-metric SEO pages, drawn from the same
// cached screen index that powers the Screener. Values are latest-FY raw
// figures; a metric page only shows a percentile when its sector has enough
// peers, so a thin sector never fabricates a ranking.
const METRIC_INDEX_FIELD = {
    'revenue': 'latestRevenue',
    'net-income': 'latestNetIncome',
    'eps': 'latestEps',
    'ebitda': 'latestEbitda',
    'total-debt': 'latestTotalDebt',
    'shares-outstanding': 'latestSharesOutstanding',
    'dividend-history': 'latestDividendPayout',
    'gross-profit': 'latestGrossProfit',
    'free-cash-flow': 'fcfAbs',
    'pe-ratio': 'pe'
};
function ordinal(n) {
    const last = n % 10, tens = n % 100;
    if (tens >= 11 && tens <= 13) return `${n}th`;
    if (last === 1) return `${n}st`;
    if (last === 2) return `${n}nd`;
    if (last === 3) return `${n}rd`;
    return `${n}th`;
}
// Percentile (0–100) of the ticker's latest-FY value within its sector; null
// when the sector is missing or has fewer than 5 comparable peers.
function sectorPercentile(symbol, field) {
    const rows = aiChat.buildScreenIndex();
    const self = rows.find((r) => r.symbol === symbol);
    if (!self || !self.sector) return null;
    const peers = rows.filter((r) => r.sector === self.sector && r[field] !== null && r[field] !== undefined);
    if (peers.length < 5) return null;
    const sorted = peers.map((r) => r[field]).sort((a, b) => a - b);
    const rank = sorted.filter((v) => v < self[field]).length;
    return Math.round((rank / (sorted.length - 1)) * 100);
}
// Top same-sector peers by the field (highest first), for the "related stocks"
// table on each metric page.
function sectorPeers(symbol, field, n = 5) {
    const rows = aiChat.buildScreenIndex();
    const self = rows.find((r) => r.symbol === symbol);
    if (!self || !self.sector) return [];
    return rows
        .filter((r) => r.sector === self.sector && r.symbol !== symbol && r[field] !== null && r[field] !== undefined)
        .sort((a, b) => b[field] - a[field])
        .slice(0, n)
        .map((r) => ({ symbol: r.symbol, name: r.name, value: r[field] }));
}

// ---------- metric registry ----------
// rows(data) -> [{year, value, aux}] newest-first; null value rows are dropped.
const METRICS = {
    'revenue': {
        label: 'Revenue', noun: 'revenue', fmt: money, source: 'income statement (10-K)',
        methodology: 'Revenue is the total revenue line reported in the annual income statement.',
        rows: (d) => ((d.income || {}).annualReports || []).map((r) => ({ year: fyYear(r), value: num(r.totalRevenue) }))
    },
    'net-income': {
        label: 'Net Income', noun: 'net income', fmt: money, source: 'income statement (10-K)',
        methodology: 'Net income is the annual net income line reported in the income statement. Net margin is derived as net income divided by revenue.',
        auxLabel: 'Net margin (derived)',
        rows: (d) => ((d.income || {}).annualReports || []).map((r) => {
            const rev = num(r.totalRevenue); const ni = num(r.netIncome);
            return { year: fyYear(r), value: ni, aux: (rev && ni !== null) ? `${((ni / rev) * 100).toFixed(1)}%` : null };
        })
    },
    'gross-profit': {
        label: 'Gross Profit', noun: 'gross profit', fmt: money, source: 'income statement (10-K)',
        methodology: 'Gross profit uses the reported gross-profit line when available; otherwise it is derived as revenue minus cost of revenue. Gross margin is derived.',
        auxLabel: 'Gross margin (derived)',
        rows: (d) => ((d.income || {}).annualReports || []).map((r) => {
            const rev = num(r.totalRevenue); const reported = num(r.grossProfit); const gp = grossProfitOf(r);
            return { year: fyYear(r), value: gp, derived: reported === null && gp !== null, aux: (rev && gp !== null) ? `${((gp / rev) * 100).toFixed(1)}%` : null };
        })
    },
    'eps': {
        label: 'Earnings per Share (EPS)', noun: 'earnings per share', fmt: price, source: 'income statement (10-K), split-adjusted',
        methodology: 'EPS uses diluted EPS when reported, otherwise the available EPS fallback. Values are presented on the cache’s split-adjusted basis.',
        rows: (d) => ((d.income || {}).annualReports || []).map((r) => {
            const diluted = num(r.dilutedEPS); const basic = num(r.eps);
            return { year: fyYear(r), value: diluted !== null ? diluted : basic, sourceField: diluted !== null ? 'diluted EPS' : 'EPS fallback' };
        })
    },
    'ebitda': {
        label: 'EBITDA', noun: 'EBITDA', fmt: money, source: 'income statement (10-K)',
        rows: (d) => ((d.income || {}).annualReports || []).map((r) => {
            let v = num(r.ebitda); if (v === 0) v = null;
            return { year: fyYear(r), value: v };
        })
    },
    'free-cash-flow': {
        label: 'Free Cash Flow', noun: 'free cash flow', fmt: money, source: 'cash flow statement (10-K)',
        methodology: 'Free cash flow is derived as operating cash flow minus the absolute value of capital expenditure; it is not a directly filed line.',
        rows: (d) => ((d.cash || {}).annualReports || []).map((r) => {
            const ocf = num(r.operatingCashflow); const capex = num(r.capitalExpenditures);
            // capex sign differs by source year (SEC negative, vendor positive) — normalize
            const v = (ocf !== null && capex !== null) ? ocf - Math.abs(capex) : null;
            return { year: fyYear(r), value: v, derived: v !== null };
        })
    },
    'total-debt': {
        label: 'Total Debt', noun: 'total debt (short- plus long-term borrowings)', fmt: money, source: 'balance sheet (10-K)',
        methodology: 'Total debt is derived by adding the available short-term and long-term borrowing fields; it is not a single filed line.',
        rows: (d) => ((d.balance || {}).annualReports || []).map((r) => ({ year: fyYear(r), value: totalDebtOf(r), derived: totalDebtOf(r) !== null }))
    },
    'shares-outstanding': {
        label: 'Shares Outstanding', noun: 'shares outstanding', source: 'balance sheet (10-K), split-adjusted',
        methodology: 'Shares outstanding uses the reported common-stock share count at the fiscal period end, presented on the cache’s split-adjusted basis.',
        fmt: (v) => { const n = num(v); if (n === null) return '—'; return n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : `${(n / 1e6).toFixed(1)}M`; },
        rows: (d) => ((d.balance || {}).annualReports || []).map((r) => ({ year: fyYear(r), period: r.fiscalDateEnding, value: num(r.commonStockSharesOutstanding), sourceField: 'reported common-stock shares' }))
    },
    'dividend-history': {
        label: 'Dividend History', noun: 'dividends paid', fmt: money, source: 'cash flow statement (10-K)',
        methodology: 'Cash dividends paid come from the annual cash-flow statement. The per-share figure is an approximate derived value using the reported payout and share count; it is not a declared dividend rate.',
        auxLabel: 'Per share (approx., derived)',
        allowEmpty: true, // "does X pay a dividend" is a real query even when the answer is no
        rows: (d) => {
            const shares = {};
            ((d.balance || {}).annualReports || []).forEach((r) => { shares[fyYear(r)] = num(r.commonStockSharesOutstanding); });
            return ((d.cash || {}).annualReports || []).map((r) => {
                let v = num(r.dividendPayoutCommonStock); if (v === null) v = num(r.dividendPayout);
                if (v !== null) v = Math.abs(v);
                const sh = shares[fyYear(r)];
                return { year: fyYear(r), period: r.fiscalDateEnding, value: v, aux: (v && sh) ? `$${(v / sh).toFixed(2)}` : null };
            });
        }
    },
    'pe-ratio': {
        label: 'P/E Ratio', noun: 'price-to-earnings ratio', fmt: (v) => ratio(v), source: 'fiscal-year-end price ÷ diluted EPS',
        methodology: 'P/E is derived by dividing the fiscal-year-end adjusted close by diluted EPS; it is not a filed valuation ratio or a live quote.',
        rows: (d) => ((d.income || {}).annualReports || []).map((r) => {
            const e = num(r.dilutedEPS) !== null ? num(r.dilutedEPS) : num(r.eps);
            const c = closeAtFiscalEnd(d, r.fiscalDateEnding);
            const v = (e && e > 0 && c) ? c / e : null;
            return { year: fyYear(r), period: r.fiscalDateEnding, value: v };
        })
    }
};
const METRIC_SLUGS = Object.keys(METRICS);
const RESEARCH_ROUTES = ['/research/shares-outstanding', '/research/pe-ratio-history', '/research/dilution-scorecard', '/research/how-to-read-a-10-k', '/research/how-to-compare-two-stocks', '/research/what-is-free-cash-flow', '/research/how-to-find-undervalued-stocks'];

function pctChange(current, prior) {
    return current !== null && prior !== null && prior !== 0 ? ((current - prior) / Math.abs(prior)) * 100 : null;
}
function signedPct(value) {
    return value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}
function asDate(iso) {
    if (!iso || !/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso || '';
    const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
    return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
}
function secCompanyUrl(symbol, form = '10-K') {
    return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(symbol)}&type=${encodeURIComponent(form)}&owner=exclude&count=40`;
}
function metricCsv(ticker, slug) {
    const sym = resolveCanonicalSymbol(ticker) || normalizeTicker(ticker); const m = METRICS[slug]; const data = loadFundamentals(sym);
    if (!m || !data) return null;
    const rows = m.rows(data).filter((row) => row.year);
    if (!(m.allowEmpty ? rows.length >= 2 : rows.filter((row) => row.value !== null).length >= 2)) return null;
    const quote = (value) => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
    const lines = [['symbol', 'fiscal_year', 'period_end', slug, 'formatted_value', ...(m.auxLabel ? ['auxiliary_value'] : [])]];
    rows.forEach((row) => lines.push([sym, row.year, row.period || '', row.value == null ? '' : row.value, row.value == null ? '' : m.fmt(row.value), ...(m.auxLabel ? [row.aux || ''] : [])]));
    return lines.map((line) => line.map(quote).join(',')).join('\n') + '\n';
}
function trendSvg(rows, label, caption = 'Annual filed history. Hover chart points for raw values; the accessible table below is the source of record.') {
    const values = rows.filter((row) => row.value !== null).slice().reverse();
    if (values.length < 2) return '';
    const chartLabel = /history$/i.test(String(label || '')) ? String(label) : `${label} history`;
    const min = Math.min(...values.map((row) => row.value)); const max = Math.max(...values.map((row) => row.value));
    const span = max - min || 1; const width = 760; const height = 220; const pad = 28;
    const points = values.map((row, index) => {
        const x = pad + index * ((width - pad * 2) / Math.max(values.length - 1, 1));
        const y = height - pad - ((row.value - min) / span) * (height - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<figure style="margin:20px 0"><svg role="img" aria-labelledby="metric-chart-title" viewBox="0 0 ${width} ${height}" style="display:block;width:100%;height:auto;background:var(--surface);border:1px solid var(--line);border-radius:10px"><title id="metric-chart-title">${esc(chartLabel)} from ${esc(values[0].year)} to ${esc(values[values.length - 1].year)}</title><line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="var(--line2)"/><polyline fill="none" stroke="var(--accent)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" points="${points}"/>${values.map((row, index) => { const [x, y] = points.split(' ')[index].split(','); return `<circle cx="${x}" cy="${y}" r="4" fill="var(--surface)" stroke="var(--accent)" stroke-width="3"><title>FY ${esc(row.year)}: ${esc(String(row.value))}${row.derived ? ' (derived)' : ''}</title></circle>`; }).join('')}</svg><figcaption style="font-size:12px;color:var(--ink3);margin-top:7px">${esc(caption)}</figcaption></figure>`;
}

// ---------- per-symbol metric availability (for sitemap honesty) ----------
// One lightweight pass over the cache: parse, record which metrics have >=2
// usable years, discard the JSON (never hold 1,500 full files in memory).
let _avail = null;
function availability() {
    if (_avail) return _avail;
    _avail = new Map();
    for (const c of loadCompanies()) {
        const canonical = resolveCanonicalSymbol(c.symbol);
        if (!canonical) continue;
        try {
            const f = path.join(__dirname, '..', 'frontend', 'data', 'fundamentals',
                `${canonical.replace(/[^A-Z0-9]/g, '_')}.json`);
            if (!fs.existsSync(f)) continue;
            const d = JSON.parse(fs.readFileSync(f, 'utf8'));
            const flags = {};
            for (const slug of METRIC_SLUGS) {
                const m = METRICS[slug];
                const usable = m.rows(d).filter((r) => r.value !== null).length;
                flags[slug] = m.allowEmpty ? m.rows(d).length >= 2 : usable >= 2;
            }
            // Price-history pages need >=2 monthly adjusted closes to render.
            const monthly = (d.monthly || {})['Monthly Adjusted Time Series'] || {};
            flags.priceHistory = Object.keys(monthly).filter((k) => num(monthly[k]['5. adjusted close']) !== null).length >= 2;
            _avail.set(canonical, flags);
        } catch (_) { /* unreadable file — no metric pages for it */ }
    }
    return _avail;
}

// ---------- metric page ----------
function renderMetricPage(ticker, slug, options = {}) {
    const sym = resolveCanonicalSymbol(ticker) || normalizeTicker(ticker);
    const m = METRICS[slug];
    if (!m) return null;
    const company = loadCompanies().find((c) => c.symbol === sym);
    const data = loadFundamentals(sym);
    if (!company || !data) return null;
    const all = m.rows(data).filter((r) => r.year);
    const usable = all.filter((r) => r.value !== null);
    if (!(m.allowEmpty ? all.length >= 2 : usable.length >= 2)) return null;

    const name = (data.overview || {}).Name || company.name || sym;
    const newest = all[0] || {}; const oldest = all[all.length - 1] || {};
    const y1 = newest.year; const y0 = oldest.year;
    const latestVal = usable[0] ? usable[0].value : null;
    const yrsSpan = Number(y1) - Number(y0);
    const growth = cagr(usable[usable.length - 1]?.value, usable[0]?.value, yrsSpan);
    const oneYear = usable.length > 1 ? pctChange(usable[0].value, usable[1].value) : null;
    const fiveYearRow = usable.find((row) => Number(row.year) <= Number(usable[0]?.year) - 5) || usable[usable.length - 1];
    const fiveYear = fiveYearRow && fiveYearRow !== usable[0] ? pctChange(usable[0].value, fiveYearRow.value) : null;

    // Sector context: percentile sentence + peer table, only when the cached
    // screen index has a sector with enough comparable peers.
    const indexField = METRIC_INDEX_FIELD[slug];
    const sectorName = indexField ? (aiChat.buildScreenIndex().find((r) => r.symbol === sym) || {}).sector : null;
    const percentile = indexField ? sectorPercentile(sym, indexField) : null;
    const peers = indexField ? sectorPeers(sym, indexField, 5) : [];

    const canonical = `${SITE}/stocks/${sym}/${slug}`;
    const fundFile = path.join(__dirname, '..', 'frontend', 'data', 'fundamentals', `${sym.replace(/[^A-Z0-9]/g, '_')}.json`);
    let mtimeISO = null, freshness = '';
    try { const mt = fs.statSync(fundFile).mtime; mtimeISO = mt.toISOString(); freshness = mt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); } catch (_) { /* no mtime */ }
    // Search Console shows that Google can associate a query with a neighboring
    // metric page when the title abbreviates the requested metric (for example,
    // "EPS" instead of "Earnings per Share"). Put the exact user-facing metric
    // phrase and ticker first so the canonical page is unambiguous. Keep the
    // company name at the end, where a long legal suffix is less likely to push
    // the answer out of the SERP title. Fall back to a plain range when there is
    // no value (for example, a company that pays no dividend).
    const titleMetric = m.label;
    const titleHistory = /history$/i.test(titleMetric) ? titleMetric : `${titleMetric} History`;
    const titleName = name.replace(/^The\s+/i, '')
        .replace(/,?\s+(Incorporated|Corporation|Corp|Company|Co|Holdings|plc|Ltd|Limited|L\.?P|N\.?V|S\.?A|Inc)\.?$/i, '')
        .trim() || name;
    // A "$0"/"0" headline (e.g. a company that pays no dividend) reads as broken
    // and won't earn the click — use the plain range title in that case.
    // Keep the exact metric phrase/ticker at the front, but avoid pushing the
    // semantic owner out of a search-result title with a long legal name or a
    // volatile value. The latest value and period remain in the description,
    // answer and evidence table.
    const titleNameShort = titleName.length > 28
        ? `${titleName.slice(0, 28).replace(/\s+\S*$/, '').trim()}…`
        : titleName;
    const title = `${sym} ${titleHistory} | ${titleNameShort}`;
    const description = `${name} (${sym}) annual ${m.noun} from ${y0} to ${y1}` +
        (latestVal !== null ? ` — latest: ${m.fmt(latestVal)}` : '') +
        (oneYear !== null ? `, ${signedPct(oneYear)} year over year` : '') +
        `. SEC-sourced history, methodology, chart and downloadable CSV.`;

    // table rows, newest first, with YoY change
    const trs = all.map((r, i) => {
        const prev = all[i + 1];
        let yoy = '—';
        if (r.value !== null && prev && prev.value !== null && prev.value !== 0) {
            const g = ((r.value - prev.value) / Math.abs(prev.value)) * 100;
            yoy = `${g >= 0 ? '+' : ''}${g.toFixed(1)}%`;
        }
        return `<tr><td>FY ${esc(r.year)}</td><td>${esc(r.value === null ? '—' : `${m.fmt(r.value)}${r.derived ? '*' : ''}`)}</td>` +
            (m.auxLabel ? `<td>${esc(r.aux || '—')}</td>` : '') + `<td>${esc(yoy)}</td></tr>`;
    }).join('');
    const latestRow = usable[0] || {};
    const directMetric = !latestRow.derived && !['free-cash-flow', 'total-debt', 'pe-ratio'].includes(slug);
    // Keep the opening answer deterministic and show the filed inputs behind
    // derived metrics before the visitor reaches the chart/table.
    const cashRows = ((data.cash || {}).annualReports || []);
    const balanceRows = ((data.balance || {}).annualReports || []);
    const latestCash = cashRows.find((row) => fyYear(row) === latestRow.year) || cashRows[0] || {};
    const latestBalance = balanceRows.find((row) => fyYear(row) === latestRow.year) || balanceRows[0] || {};
    const operatingCashflow = num(latestCash.operatingCashflow);
    const rawCapitalExpenditures = num(latestCash.capitalExpenditures);
    const capitalExpenditures = rawCapitalExpenditures === null ? null : Math.abs(rawCapitalExpenditures);
    const cashBalance = num(latestBalance.cashAndCashEquivalentsAtCarryingValue) ?? num(latestBalance.cashAndShortTermInvestments);
    const debtValue = totalDebtOf(latestBalance);

    const faqs = [];
    if (latestVal !== null) faqs.push({
        q: `What is ${name}'s ${m.noun}?`,
        a: directMetric
            ? `${name} (${sym}) reported ${m.noun} of ${m.fmt(latestVal)} for fiscal year ${usable[0].year}, per its SEC filings.`
            : `${name} (${sym}) has a calculated ${m.noun} value of ${m.fmt(latestVal)} for fiscal year ${usable[0].year}, derived from the filed inputs described below.`
    });
    if (growth !== null) faqs.push({
        q: `How has ${name}'s ${m.noun} changed over time?`,
        a: `Between fiscal ${y0} and ${y1}, ${sym}'s ${m.noun} ${growth >= 0 ? 'grew' : 'declined'} at roughly ${Math.abs(growth).toFixed(1)}% per year (compound annual rate), from ${m.fmt(usable[usable.length - 1].value)} to ${m.fmt(usable[0].value)}.`
    });
    if (slug === 'dividend-history' && !usable.some((r) => r.value > 0)) faqs.push({
        q: `Does ${name} pay a dividend?`,
        a: `Based on its filed cash flow statements ${y0}–${y1}, ${sym} has not paid a common dividend.`
    });
    faqs.push({
        q: 'Where does this data come from?',
        a: `Figures are computed from ${name}'s official SEC filings (${m.source}), refreshed nightly. Not investment advice.`
    });

    const jsonld = JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'BreadcrumbList',
                itemListElement: [
                    { '@type': 'ListItem', position: 1, name: 'Stocks', item: `${SITE}/stocks` },
                    { '@type': 'ListItem', position: 2, name: `${name} (${sym})`, item: `${SITE}/stocks/${sym}` },
                    { '@type': 'ListItem', position: 3, name: m.label, item: canonical }
                ]
            },
            {
                '@type': 'FAQPage',
                mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } }))
            },
            {
                '@type': 'WebPage', '@id': canonical, url: canonical, name: title,
                ...(mtimeISO ? { dateModified: mtimeISO } : {}),
                isBasedOn: 'https://www.sec.gov/edgar',
                publisher: { '@id': `${SITE}/#org` }, author: { '@id': `${SITE}/#org` }
            }
        ]
    });

    const siblings = METRIC_SLUGS.filter((s) => s !== slug)
        .map((s) => `<a href="/stocks/${esc(sym)}/${s}">${esc(METRICS[s].label)}</a>`).join('');
    const faqHtml = faqs.map((f) =>
        `<h3 style="font-size:15.5px;margin:18px 0 6px">${esc(f.q)}</h3><p style="margin:0;font-size:14px;line-height:1.7;max-width:74ch">${esc(f.a)}</p>`).join('');
    const sourceUrl = secCompanyUrl(sym);
    const metricHub = slug === 'shares-outstanding' ? '/research/shares-outstanding' : slug === 'pe-ratio' ? '/research/pe-ratio-history' : null;
    const metricTool = slug === 'shares-outstanding' ? '/tools/dilution' : slug === 'pe-ratio' ? '/tools/company-comparison' : '/tools/dividend-safety';
    const nextAction = renderPilotAction(pilotAction(sym, slug, options.req), sym, name);
    let interpretation;
    if (slug === 'eps') {
        interpretation = `${name} ${latestRow.sourceField === 'EPS fallback' ? 'uses the reported EPS fallback' : 'reported diluted EPS'} of ${m.fmt(latestVal)} for fiscal ${latestRow.year}, presented on a split-adjusted basis.`;
    } else if (slug === 'shares-outstanding') {
        interpretation = `${name} reported ${m.fmt(latestVal)} shares outstanding at fiscal ${latestRow.year}, presented on a split-adjusted basis.`;
    } else if (slug === 'dividend-history') {
        interpretation = `${name} reported ${m.fmt(latestVal)} of cash dividends paid for fiscal ${latestRow.year}. Any per-share figure below is derived and approximate.`;
    } else if (slug === 'pe-ratio') {
        interpretation = `${name}'s fiscal-year-end P/E ratio is derived from the adjusted close divided by diluted EPS for fiscal ${latestRow.year}: ${m.fmt(latestVal)}.`;
    } else if (slug === 'free-cash-flow') {
        interpretation = `${name}'s free cash flow was calculated as operating cash flow ${money(operatingCashflow)} minus capital expenditures ${money(capitalExpenditures)} for fiscal ${latestRow.year}: ${m.fmt(latestVal)}.`;
    } else if (slug === 'total-debt') {
        const netDebt = debtValue !== null && cashBalance !== null ? debtValue - cashBalance : null;
        interpretation = `${name}'s total debt is derived by adding the available short- and long-term borrowing fields for fiscal ${latestRow.year}: ${m.fmt(latestVal)}${netDebt !== null ? `; cash was ${money(cashBalance)}, implying derived net ${netDebt >= 0 ? 'debt' : 'cash'} of ${money(Math.abs(netDebt))}` : ''}.`;
    } else if (slug === 'gross-profit' && latestRow.derived) {
        interpretation = `${name}'s gross profit is derived as revenue minus cost of revenue for fiscal ${latestRow.year}: ${m.fmt(latestVal)}.`;
    } else if (directMetric) {
        interpretation = `${name} reported ${m.fmt(latestVal)} of ${m.noun} for fiscal ${latestRow.year}.`;
    } else {
        interpretation = `${name}'s ${m.label.toLowerCase()} is calculated as ${m.methodology ? m.methodology.replace(/^[^.]+\.\s*/, '').replace(/;.*$/, '') : 'a deterministic combination of filed values'} for fiscal ${latestRow.year}: ${m.fmt(latestVal)}.`;
    }
    if (oneYear !== null) interpretation += ` That was ${Math.abs(oneYear).toFixed(1)}% ${oneYear >= 0 ? 'higher' : 'lower'} than fiscal ${usable[1]?.year}.`;
    if (fiveYear !== null && fiveYearRow) interpretation += ` Compared with fiscal ${fiveYearRow.year}, the change was ${signedPct(fiveYear)}.`;
    if (slug === 'shares-outstanding') interpretation += oneYear > 0 ? ' A rising share count can dilute per-share ownership; the filings should be checked for issuance and stock-compensation details.' : oneYear < 0 ? ' A falling share count is consistent with net buybacks exceeding issuance over the period, though the filing should be checked for the components.' : ' The filed year-end share count was broadly unchanged.';
    if (slug === 'pe-ratio') interpretation += ' This is a fiscal-year-end price divided by diluted EPS—not a live valuation—and is omitted when annual EPS is not positive.';
    const baseSummaryCards = `<div class="seo-grid"><div class="seo-tile"${directMetric ? '' : ' aria-label="Latest filed value inputs support this calculated value"'}><div class="l">${directMetric ? 'Latest filed value' : 'Latest calculated value'}</div><div class="v">${esc(latestVal === null ? '—' : m.fmt(latestVal))}</div></div><div class="seo-tile"><div class="l">One-year change</div><div class="v">${esc(signedPct(oneYear))}</div></div><div class="seo-tile"><div class="l">Change since ${esc(fiveYearRow?.year || y0)}</div><div class="v">${esc(signedPct(fiveYear))}</div></div><div class="seo-tile"><div class="l">Latest period end</div><div class="v" style="font-size:16px">${esc(usable[0]?.period || usable[0]?.year || '—')}</div></div></div>`;
    const inputSummary = slug === 'free-cash-flow'
        ? `<div class="seo-grid"><div class="seo-tile"><div class="l">Operating cash flow</div><div class="v">${esc(money(operatingCashflow))}</div></div><div class="seo-tile"><div class="l">Capital expenditures</div><div class="v">${esc(money(capitalExpenditures))}</div></div><div class="seo-tile"><div class="l">Calculation</div><div class="v" style="font-size:16px">OCF − capex</div></div></div>`
        : slug === 'total-debt'
            ? `<div class="seo-grid"><div class="seo-tile"><div class="l">Total debt (derived)</div><div class="v">${esc(money(debtValue))}</div></div><div class="seo-tile"><div class="l">Cash balance</div><div class="v">${esc(money(cashBalance))}</div></div><div class="seo-tile"><div class="l">Net debt / (cash)</div><div class="v">${esc(debtValue !== null && cashBalance !== null ? money(debtValue - cashBalance) : '—')}</div></div></div>`
            : '';
    const summaryCards = baseSummaryCards + inputSummary;
    const historyHeading = `${name} ${m.label}${/history$/i.test(m.label) ? '' : ' history'} by fiscal year`;
    const methodology = m.methodology || `Figures are drawn from ${m.source}.`;

    // Dividend ex-date enrichment for the dividend-history page, only when the
    // cache carries Yahoo dividend history (populated by the refresh flow). The
    // fiscal-year cash-flow table above stays the source of record; these are
    // complementary declared per-share dividends and are labelled as such.
    let dividendExtras = '';
    if (slug === 'dividend-history') {
        const divHist = ((data.dividends || {}).history || [])
            .filter((d) => d.exDate && d.amount !== null && d.amount !== undefined);
        if (divHist.length) {
            const nextEx = (data.overview || {}).ExDividendDate || '';
            const exRows = divHist.slice(-24).reverse()
                .map((d) => `<tr><td>${esc(asDate(d.exDate))}</td><td>$${Number(d.amount).toFixed(2)}</td></tr>`).join('');
            const qMap = new Map();
            divHist.forEach((d) => {
                const q = `${d.exDate.slice(0, 4)} Q${Math.floor((Number(d.exDate.slice(5, 7)) - 1) / 3) + 1}`;
                qMap.set(q, (qMap.get(q) || 0) + Number(d.amount));
            });
            const qRows = [...qMap.entries()].slice(-8).reverse()
                .map(([q, v]) => `<tr><td>${esc(q)}</td><td>$${v.toFixed(2)}</td></tr>`).join('');
            const nextHtml = nextEx
                ? `<p class="seo-about" style="margin:0 0 12px"><strong>Next expected ex-dividend date:</strong> ${esc(asDate(nextEx))}. Per Yahoo summary data — the company declares it; this is not a site projection.</p>`
                : '';
            dividendExtras = `<div class="seo-section"><h2>${esc(name)} dividend ex-dates and quarterly payouts</h2>${nextHtml}<div style="overflow-x:auto"><table class="seo-table"><thead><tr><th>Ex-dividend date</th><th>Dividend per share</th></tr></thead><tbody>${exRows}</tbody></table></div>${qRows ? `<div style="overflow-x:auto;margin-top:14px"><table class="seo-table"><thead><tr><th>Quarter</th><th>Total paid per share</th></tr></thead><tbody>${qRows}</tbody></table></div>` : ''}<p style="color:var(--ink3);font-size:12.5px;margin-top:8px">Ex-dates and per-share amounts from Yahoo Finance dividend history, refreshed nightly; per-share figures are the declared cash dividends. The fiscal-year table above comes from the 10-K cash flow statement and remains the source of record.</p></div>`;
        }
    }

    return head(title, description, canonical, jsonld) + nav('company') + `
<main class="seo-wrap">
  <div class="seo-crumbs"><a href="/stocks">Stocks</a> / <a href="/stocks/${esc(sym)}">${esc(sym)}</a> / ${esc(m.label)}</div>
  <h1 class="seo-h1">${esc(name)} ${esc(m.label)} <span style="color:var(--ink3);font-weight:600">${esc(y0)}–${esc(y1)}</span></h1>
  <p class="seo-sub">${esc(interpretation)}</p>
  ${percentile !== null && sectorName ? `<p class="seo-sub" style="margin-top:6px">${esc(name)}'s ${esc(m.label)} is in the ${ordinal(percentile)} percentile of the ${esc(sectorName)} sector — ${percentile >= 50 ? 'above' : 'below'} the sector median.</p>` : ''}
  ${summaryCards}
  <div class="seo-section"><h2>${esc(historyHeading)}</h2>${trendSvg(all, historyHeading, directMetric ? 'Annual filed history. Hover chart points for raw values; the accessible table below is the source of record.' : 'Annual calculated history from filed inputs. Hover chart points for raw values; the accessible table below is the source of record.')}</div>
  <div class="seo-section">
    <div style="overflow-x:auto"><table class="seo-table">
      <thead><tr><th>Fiscal year</th><th>${esc(m.label)}</th>${m.auxLabel ? `<th>${esc(m.auxLabel)}</th>` : ''}<th>Change (YoY)</th></tr></thead>
      <tbody>${trs}</tbody>
    </table></div>
    <p style="color:var(--ink3);font-size:12.5px;margin-top:8px">Source: ${esc(name)} SEC filings — ${esc(m.source)}. ${esc(methodology)}${all.some((row) => row.derived) ? ' Rows marked * are derived from filed inputs.' : ''} Computed deterministically; refreshed nightly${freshness ? ` (last updated ${esc(freshness)})` : ''}. Update frequency: quarterly (on each new SEC filing). <a href="${esc(sourceUrl)}" rel="noopener nofollow" target="_blank">Open ${esc(sym)} 10-K filings at SEC EDGAR</a> · <a href="/methodology" style="color:var(--ink3)">Methodology</a> · <a href="/stocks/${esc(sym)}/${esc(slug)}.csv">Download CSV</a>.</p>
  </div>
  ${dividendExtras}
  ${peers.length ? `<div class="seo-section"><h2>${esc(name)} ${esc(m.label)} vs. ${esc(sectorName)} sector peers</h2>
    <div style="overflow-x:auto"><table class="seo-table">
      <thead><tr><th>Company</th><th>${esc(m.label)}</th></tr></thead>
      <tbody>${peers.map((p) => `<tr><td><a href="/stocks/${esc(p.symbol)}/${esc(slug)}">${esc(p.symbol)}</a> — ${esc(p.name)}</td><td>${esc(m.fmt(p.value))}</td></tr>`).join('')}</tbody>
    </table></div>
    <p style="color:var(--ink3);font-size:12.5px;margin-top:8px">Latest fiscal-year figures from SEC filings, ${esc(sectorName)} sector. Peers are the same-sector companies with the highest ${esc(m.noun)}; values are not estimates.</p>
  </div>` : ''}
  <div class="seo-section"><h2>${esc(m.label)} methodology and context</h2><p class="seo-about">${esc(methodology)} ${esc(interpretation)} Values remain missing when the cached filing does not disclose a comparable line item; they are never estimated. Stock splits, reorganizations and fiscal-calendar changes can reduce comparability.</p><p style="font-size:13px;color:var(--ink3)">Prepared and reviewed by the stockportfolio.pro research desk. Corrections: <a href="mailto:support@stockportfolio.pro">support@stockportfolio.pro</a>.</p></div>
  ${nextAction}
  <div class="seo-lock">
    <h3>See the full picture for ${esc(name)}</h3>
    <p>Complete income statement, balance sheet and cash flow with trend on every row, 48 quarters, ratios, health checks, and Ask — the SEC-grounded research assistant.</p>
    <a class="seo-cta-btn" href="/company?symbol=${esc(sym)}">Open the interactive view — free</a>
  </div>
  <div class="seo-section"><h2>${esc(name)} — frequently asked questions</h2>${faqHtml}</div>
  <div class="seo-section"><h2>More ${esc(sym)} financial history</h2>
    <div class="seo-links">${siblings}</div>
    <p style="margin-top:10px"><a href="/stocks/${esc(sym)}">Full ${esc(sym)} fundamentals page &rarr;</a> &middot; <a href="${metricTool}">Analyze ${esc(m.noun)} with a free tool &rarr;</a>${metricHub ? ` &middot; <a href="${metricHub}">Research guide &amp; leaders &rarr;</a>` : ''} &middot; <a href="/stocks">All 1,500+ companies &rarr;</a></p>
  </div>
</main>` + footer();
}

// ---------- price-history page ----------
// A per-ticker long-tail page: 20-year monthly adjusted-close chart, computed
// total returns, 52-week range and trend indicators. Every number on the page
// is derived from the same cached monthly series, so nothing is estimated.
function renderPriceHistoryPage(ticker, options = {}) {
    const sym = resolveCanonicalSymbol(ticker) || normalizeTicker(ticker);
    const company = loadCompanies().find((c) => c.symbol === sym);
    const data = loadFundamentals(sym);
    if (!company || !data) return null;
    const series = monthlySeries(data);
    if (series.length < 2) return null;

    const name = (data.overview || {}).Name || company.name || sym;
    const ov = data.overview || {};
    const firstDate = series[0].date;
    const lastDate = series[series.length - 1].date;
    const firstYear = firstDate.slice(0, 4);
    const current = series[series.length - 1].close;
    // Current close from the daily feed when present; the monthly series is the
    // fallback so the page never fabricates a fresher quote.
    const daily = (data.daily || {})['Time Series (Daily)'];
    let currentPrice = current;
    if (daily) {
        const dDates = Object.keys(daily).sort();
        const lastDaily = dDates.length ? num(daily[dDates[dDates.length - 1]]['4. close']) : null;
        if (lastDaily !== null) currentPrice = lastDaily;
    }
    const ytd = ytdReturn(series);
    const r1 = totalReturn(series, 1);
    const r3 = totalReturn(series, 3);
    const r5 = totalReturn(series, 5);
    const r10 = totalReturn(series, 10);
    // 52-week range from the market overview (realistic daily high/low, the same
    // source the compare pages use); fall back to the monthly series only when
    // the overview lacks the fields.
    const rng = (num(ov['52WeekLow']) !== null && num(ov['52WeekHigh']) !== null)
        ? { low: num(ov['52WeekLow']), high: num(ov['52WeekHigh']) }
        : (range52w(series) || { low: null, high: null });
    const ma50 = num(ov['50DayMovingAverage']);
    const ma200 = num(ov['200DayMovingAverage']);
    const beta = num(ov.Beta);
    const rangePct = (rng.low !== null && rng.high !== null && rng.high > rng.low && currentPrice !== null)
        ? Math.max(0, Math.min(100, ((currentPrice - rng.low) / (rng.high - rng.low)) * 100)) : null;

    const canonical = `${SITE}/stocks/${sym}/price-history`;
    const fundFile = path.join(__dirname, '..', 'frontend', 'data', 'fundamentals', `${sym.replace(/[^A-Z0-9]/g, '_')}.json`);
    let mtimeISO = null, freshness = '';
    try { const mt = fs.statSync(fundFile).mtime; mtimeISO = mt.toISOString(); freshness = mt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); } catch (_) { /* no mtime */ }
    const titleName = name.replace(/^The\s+/i, '')
        .replace(/,?\s+(Incorporated|Corporation|Corp|Company|Co|Holdings|plc|Ltd|Limited|L\.?P|N\.?V|S\.?A|Inc)\.?$/i, '')
        .trim() || name;
    const titleNameShort = titleName.length > 28
        ? `${titleName.slice(0, 28).replace(/\s+\S*$/, '').trim()}…` : titleName;
    const title = `${sym} (${titleNameShort}) Stock Price History | Monthly since ${firstYear}`;
    const description = `${name} (${sym}) adjusted-close history since ${firstYear}` +
        (currentPrice !== null ? ` — latest ${price(currentPrice)}` : '') +
        (rng.low !== null && rng.high !== null ? `, 52-week range ${price(rng.low)}–${price(rng.high)}` : '') +
        `. Split- and dividend-adjusted monthly chart, YTD/1/3/5/10-year returns.`;

    const faqs = [];
    if (currentPrice !== null) faqs.push({
        q: `What is ${name}'s current stock price?`,
        a: `${name} (${sym}) last closed at ${price(currentPrice)} on ${esc(lastDate)} (split- and dividend-adjusted). The 52-week range is ${price(rng.low)}–${price(rng.high)}.`
    });
    if (r1 !== null) faqs.push({
        q: `How has ${sym} performed over the last year?`,
        a: `Over the past year, ${sym}'s adjusted close ${r1 >= 0 ? 'rose' : 'fell'} ${Math.abs(r1).toFixed(1)}%. It has traded between ${price(rng.low)} and ${price(rng.high)} over that window.`
    });
    if (r5 !== null) faqs.push({
        q: `What is ${sym}'s 5-year return?`,
        a: `Over the last five years, ${sym}'s split- and dividend-adjusted close returned ${r5 >= 0 ? '+' : ''}${r5.toFixed(1)}% total.`
    });
    faqs.push({
        q: 'Where does this price data come from?',
        a: `Prices are split- and dividend-adjusted monthly closes from the site's cached market-data feed, refreshed nightly from the last market session. Not investment advice.`
    });

    const jsonld = JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'BreadcrumbList',
                itemListElement: [
                    { '@type': 'ListItem', position: 1, name: 'Stocks', item: `${SITE}/stocks` },
                    { '@type': 'ListItem', position: 2, name: `${name} (${sym})`, item: `${SITE}/stocks/${sym}` },
                    { '@type': 'ListItem', position: 3, name: 'Stock price history', item: canonical }
                ]
            },
            {
                '@type': 'FAQPage',
                mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } }))
            },
            {
                '@type': 'WebPage', '@id': canonical, url: canonical, name: title,
                ...(mtimeISO ? { dateModified: mtimeISO } : {}),
                isBasedOn: 'https://www.sec.gov/edgar',
                publisher: { '@id': `${SITE}/#org` }, author: { '@id': `${SITE}/#org` }
            }
        ]
    });

    const metricLinks = METRIC_SLUGS
        .map((s) => `<a href="/stocks/${esc(sym)}/${s}">${esc(METRICS[s].label)}</a>`).join('');
    const faqHtml = faqs.map((f) =>
        `<h3 style="font-size:15.5px;margin:18px 0 6px">${esc(f.q)}</h3><p style="margin:0;font-size:14px;line-height:1.7;max-width:74ch">${esc(f.a)}</p>`).join('');
    const returnRows = [
        ['Year to date', ytd], ['1 year', r1], ['3 years', r3], ['5 years', r5], ['10 years', r10]
    ].map(([label, value]) =>
        `<tr><td>${esc(label)}</td><td>${esc(signedPct(value))}</td></tr>`).join('');
    const rangeBar = (rng.low !== null && rng.high !== null && rangePct !== null)
        ? `<div style="display:flex;align-items:center;gap:10px;margin:10px 0 4px"><span style="min-width:64px;font-size:13px;color:var(--ink2)">${esc(price(rng.low))}</span><div style="position:relative;flex:1;height:8px;background:var(--line);border-radius:4px"><div style="position:absolute;left:calc(${rangePct.toFixed(1)}% - 7px);top:-3px;width:14px;height:14px;border-radius:50%;background:var(--accent)"></div></div><span style="min-width:64px;font-size:13px;color:var(--ink2)">${esc(price(rng.high))}</span></div>`
        : '';
    const trendTiles = (ma50 !== null || ma200 !== null || beta !== null) ? `<div class="seo-grid">${ma50 !== null ? `<div class="seo-tile"><div class="l">50-day moving average</div><div class="v">${esc(price(ma50))}</div></div>` : ''}${ma200 !== null ? `<div class="seo-tile"><div class="l">200-day moving average</div><div class="v">${esc(price(ma200))}</div></div>` : ''}${beta !== null ? `<div class="seo-tile"><div class="l">Beta</div><div class="v">${esc(String(beta))}</div></div>` : ''}</div>` : '';

    return head(title, description, canonical, jsonld) + nav('company') + `
<main class="seo-wrap">
  <div class="seo-crumbs"><a href="/stocks">Stocks</a> / <a href="/stocks/${esc(sym)}">${esc(sym)}</a> / Price history</div>
  <h1 class="seo-h1">${esc(name)} stock price history <span style="color:var(--ink3);font-weight:600">${esc(firstYear)}–${esc(lastDate.slice(0, 4))}</span></h1>
  <p class="seo-sub">As of ${esc(asDate(lastDate))}, ${esc(name)} (${esc(sym)}) last closed at <strong>${esc(price(currentPrice))}</strong> — ${esc(signedPct(ytd))} year to date, ${esc(signedPct(r1))} over one year and ${esc(signedPct(r5))} over five. The 52-week range is ${esc(price(rng.low))}–${esc(price(rng.high))}.</p>
  <div class="seo-section"><h2>${esc(sym)} adjusted monthly close since ${esc(firstYear)}</h2>${monthlyTrendSvg(series, `${sym} adjusted monthly close ${firstDate} to ${lastDate}`, 'Split- and dividend-adjusted monthly closes. Hover chart points for the raw value; the table below is the source of record.')}</div>
  <div class="seo-section">
    <div style="overflow-x:auto"><table class="seo-table">
      <thead><tr><th>Period</th><th>Total return (adjusted close)</th></tr></thead>
      <tbody>${returnRows}</tbody>
    </table></div>
    ${rangePct !== null ? `<p style="font-size:13px;color:var(--ink3);margin:6px 0 0">Position of the current price within the 52-week range${rangeBar}.</p>` : ''}
    <p style="color:var(--ink3);font-size:12.5px;margin-top:8px">Source: ${esc(name)} split- and dividend-adjusted monthly closes, ${esc(firstDate)} to ${esc(lastDate)}. Computed deterministically; refreshed nightly${freshness ? ` (last updated ${esc(freshness)})` : ''}. <a href="${esc(secCompanyUrl(sym))}" rel="noopener nofollow" target="_blank">Open ${esc(sym)} filings at SEC EDGAR</a> &middot; <a href="/methodology" style="color:var(--ink3)">Methodology</a>.</p>
  </div>
  ${trendTiles}
  <div class="seo-lock">
    <h3>See the full picture for ${esc(name)}</h3>
    <p>Complete income statement, balance sheet and cash flow with trend on every row, 48 quarters, ratios, health checks, and Ask — the SEC-grounded research assistant.</p>
    <a class="seo-cta-btn" href="/company?symbol=${esc(sym)}">Open the interactive view — free</a>
  </div>
  <div class="seo-section"><h2>${esc(name)} — frequently asked questions</h2>${faqHtml}</div>
  <div class="seo-section"><h2>More ${esc(sym)} financial history</h2>
    <div class="seo-links">${metricLinks}</div>
    <p style="margin-top:10px"><a href="/stocks/${esc(sym)}">Full ${esc(sym)} fundamentals page &rarr;</a> &middot; <a href="/stocks">All 1,500+ companies &rarr;</a></p>
  </div>
</main>` + footer();
}

// ---------- research hubs and downloadable dilution dataset ----------
// A deliberately small, curated research layer over the existing stock pages.
// These pages add interpretation and cross-company context without creating a
// second programmatic URL explosion. Values stay deterministic and traceable to
// the same cached SEC statements used everywhere else on the site.
let _dilutionCache = null;
function dilutionRows() {
    if (_dilutionCache && Date.now() - _dilutionCache.at < 6 * 60 * 60 * 1000) return _dilutionCache.rows;
    let universe = [];
    try {
        universe = aiChat.screenRows({ limit: 500, maxLimit: 500, sort_by: 'marketCapB', exclude_secondary_listings: true }).rows;
    } catch (_) { universe = []; }
    const rows = [];
    universe.forEach((company) => {
        const data = loadFundamentals(company.symbol);
        const history = ((data || {}).balance?.annualReports || [])
            .map((row) => ({ period: row.fiscalDateEnding || '', year: fyYear(row), value: num(row.commonStockSharesOutstanding) }))
            .filter((row) => row.year && row.value !== null && row.value > 0);
        if (history.length < 2) return;
        const latest = history[0]; const prior = history[1];
        // Do not call an abandoned/stale cache row "latest" in a current
        // cross-company dataset. Individual history pages may still expose it
        // with its date, but the scorecard requires a 2024-or-newer filing.
        if (!latest.period || latest.period < '2024-01-01') return;
        const base5 = history.find((row) => Number(row.year) <= Number(latest.year) - 5) || history[history.length - 1];
        const oneYearPct = pctChange(latest.value, prior.value);
        const rawFiveYearPct = base5 === latest ? null : pctChange(latest.value, base5.value);
        // A single-year move this large is more likely a split, recapitalisation,
        // merger or mapping discontinuity than ordinary issuance/buybacks. Keep
        // the row visible but never rank or calculate a misleading score from it.
        const notComparable = (oneYearPct !== null && Math.abs(oneYearPct) >= 65) ||
            (rawFiveYearPct !== null && Math.abs(rawFiveYearPct) >= 200);
        const fiveYearPct = notComparable ? null : rawFiveYearPct;
        const cash = (((data || {}).cash || {}).annualReports || []).find((row) => fyYear(row) === latest.year) || {};
        let repurchases = num(cash.paymentsForRepurchaseOfCommonStock);
        if (repurchases === null) repurchases = num(cash.paymentsForRepurchaseOfEquity);
        if (repurchases !== null) repurchases = Math.abs(repurchases);
        rows.push({
            symbol: company.symbol,
            name: (data?.overview || {}).Name || company.name || company.symbol,
            sector: company.sector || (data?.overview || {}).Sector || '',
            period: latest.period,
            latestShares: latest.value,
            oneYearPct: notComparable ? null : oneYearPct,
            fiveYearPct: notComparable ? null : fiveYearPct,
            baseYear: base5.year,
            repurchases,
            marketCapB: num(company.marketCapB),
            notComparable
        });
    });
    _dilutionCache = { at: Date.now(), rows };
    return rows;
}

function dilutionCsv() {
    const quote = (value) => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
    const lines = [['symbol', 'company', 'sector', 'latest_period', 'latest_shares', 'one_year_change_pct', 'five_year_change_pct', 'comparison_base_year', 'latest_fy_share_repurchases_usd', 'comparison_status']];
    dilutionRows().forEach((row) => lines.push([
        row.symbol, row.name, row.sector, row.period, row.latestShares,
        row.oneYearPct === null ? '' : row.oneYearPct.toFixed(4),
        row.fiveYearPct === null ? '' : row.fiveYearPct.toFixed(4), row.baseYear,
        row.repurchases === null ? '' : row.repurchases,
        row.notComparable ? 'not directly comparable' : 'comparable'
    ]));
    return lines.map((line) => line.map(quote).join(',')).join('\n') + '\n';
}

const RESEARCH_SYMBOLS = ['AAPL', 'MSFT', 'TSLA', 'NVDA', 'AMZN', 'GOOGL', 'META', 'JPM', 'WMT', 'AVGO'];
function metricLeaders(slug) {
    return RESEARCH_SYMBOLS.map((symbol) => {
        const data = loadFundamentals(symbol); const metric = METRICS[slug];
        if (!data || !metric) return null;
        const rows = metric.rows(data).filter((row) => row.value !== null);
        if (rows.length < 2) return null;
        return { symbol, name: (data.overview || {}).Name || symbol, latest: rows[0], change: pctChange(rows[0].value, rows[1].value) };
    }).filter(Boolean);
}

function researchScaffold({ slug, title, description, h1, intro, body, jsonld }) {
    const canonical = `${SITE}/research/${slug}`;
    const contentId = `research-${slug}`;
    return head(title, description, canonical, JSON.stringify(jsonld)) + nav() + `
<main class="seo-wrap">
  <div class="seo-crumbs"><a href="/">Home</a> / Research / ${esc(h1)}</div>
  <h1 class="seo-h1">${esc(h1)}</h1>
  <p class="seo-sub" style="max-width:76ch">${esc(intro)}</p>
  ${body}
  <div class="seo-lock"><h3>Turn the source trail into a repeatable workflow</h3><p>Research filings, compare companies and track a real portfolio in one workspace.</p><a class="seo-cta-btn" href="/appsumo?source=website&amp;content_id=${esc(contentId)}">See the StockPortfolio.pro AppSumo offer</a></div>
</main>` + footer();
}

function renderSharesResearch() {
    const canonical = `${SITE}/research/shares-outstanding`;
    const rows = dilutionRows().filter((row) => !row.notComparable && row.oneYearPct !== null);
    const rising = rows.filter((row) => row.oneYearPct > 0).sort((a, b) => b.oneYearPct - a.oneYearPct).slice(0, 12);
    const falling = rows.filter((row) => row.oneYearPct < 0).sort((a, b) => a.oneYearPct - b.oneYearPct).slice(0, 12);
    const table = (items) => items.map((row) => `<tr><td><a href="/stocks/${esc(row.symbol)}/shares-outstanding">${esc(row.name)} (${esc(row.symbol)})</a></td><td>${esc(row.period)}</td><td>${esc(METRICS['shares-outstanding'].fmt(row.latestShares))}</td><td>${esc(signedPct(row.oneYearPct))}</td><td>${esc(signedPct(row.fiveYearPct))}</td></tr>`).join('');
    const body = `
  <div class="seo-grid"><div class="seo-tile"><div class="l">Companies analysed</div><div class="v">${rows.length}</div></div><div class="seo-tile"><div class="l">Filed source</div><div class="v" style="font-size:16px">Annual 10-K</div></div><div class="seo-tile"><div class="l">Refresh</div><div class="v" style="font-size:16px">Nightly</div></div></div>
  <div class="seo-section"><h2>What a changing share count means</h2><div class="seo-about"><p>Shares outstanding are the company pieces held by investors. If the count rises, each existing share can represent a smaller fraction of the business; if it falls, net repurchases may increase each remaining share&rsquo;s ownership. The direction alone is not a verdict: acquisitions, employee compensation, conversions, buybacks and reorganisations can all move the number.</p><p>This research view compares reported year-end common shares from annual filings. It excludes suspected split or reorganisation discontinuities from leaderboards and links every company back to its full filed history.</p></div></div>
  <div class="seo-section"><h2>Largest latest-year share-count increases</h2><div style="overflow-x:auto"><table class="seo-table"><thead><tr><th>Company</th><th>Latest period</th><th>Shares</th><th>1-year</th><th>Long-run context</th></tr></thead><tbody>${table(rising)}</tbody></table></div></div>
  <div class="seo-section"><h2>Largest latest-year share-count reductions</h2><div style="overflow-x:auto"><table class="seo-table"><thead><tr><th>Company</th><th>Latest period</th><th>Shares</th><th>1-year</th><th>Long-run context</th></tr></thead><tbody>${table(falling)}</tbody></table></div></div>
  <div class="seo-lock"><h3>Check any company for dilution</h3><p>Enter a ticker for the exact filed counts, dates, change and split-comparability warning.</p><a class="seo-cta-btn" href="/tools/dilution">Open the free dilution calculator</a></div>
  <div class="seo-section"><h2>Continue the research</h2><div class="seo-links"><a href="/research/dilution-scorecard">Download the US-company dilution scorecard</a><a href="/research/how-to-read-a-10-k">How to read a 10-K</a><a href="/research/what-is-free-cash-flow">What is free cash flow?</a>${RESEARCH_SYMBOLS.slice(0, 8).map((symbol) => `<a href="/stocks/${symbol}/shares-outstanding">${symbol} shares outstanding history</a>`).join('')}</div></div>
  <div class="seo-section"><h2>Method and limitations</h2><div class="seo-about"><p>Latest and comparison values use <code>commonStockSharesOutstanding</code> from cached annual balance sheets dated 2024 or later. A one-year change of 65% or more, or a five-year change of 200% or more, is labelled not directly comparable and left out of rankings because it may reflect a split, merger, spin-off, pre-listing base or reporting discontinuity. This is a screening signal, not proof of economic dilution and not investment advice.</p><p>Primary source: <a href="https://www.sec.gov/edgar" rel="noopener nofollow" target="_blank">SEC EDGAR</a>. See the <a href="/methodology">full methodology</a> or report a correction to <a href="mailto:support@stockportfolio.pro">support@stockportfolio.pro</a>.</p></div></div>`;
    return researchScaffold({
        slug: 'shares-outstanding', title: 'Shares Outstanding History: Dilution & Buyback Research',
        description: 'Understand shares outstanding, dilution and buybacks with filed histories, latest-year leaderboards, a free calculator and a downloadable US-company dataset.',
        h1: 'Shares outstanding, dilution and buybacks', intro: 'A source-backed guide to how company share counts change—and where to inspect the filed evidence before drawing a conclusion.', body,
        jsonld: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Shares outstanding, dilution and buybacks', url: canonical, isBasedOn: 'https://www.sec.gov/edgar', publisher: { '@id': `${SITE}/#org` } }
    });
}

function renderPeResearch() {
    const canonical = `${SITE}/research/pe-ratio-history`;
    const leaders = metricLeaders('pe-ratio');
    const trs = leaders.map((row) => `<tr><td><a href="/stocks/${esc(row.symbol)}/pe-ratio">${esc(row.name)} (${esc(row.symbol)})</a></td><td>${esc(row.latest.period || row.latest.year)}</td><td>${esc(METRICS['pe-ratio'].fmt(row.latest.value))}×</td><td>${esc(signedPct(row.change))}</td></tr>`).join('');
    const body = `
  <div class="seo-grid"><div class="seo-tile"><div class="l">Calculation</div><div class="v" style="font-size:16px">FY-end price ÷ EPS</div></div><div class="seo-tile"><div class="l">Earnings basis</div><div class="v" style="font-size:16px">Diluted annual EPS</div></div><div class="seo-tile"><div class="l">Refresh</div><div class="v" style="font-size:16px">Nightly</div></div></div>
  <div class="seo-section"><h2>What historical P/E can—and cannot—tell you</h2><div class="seo-about"><p>A P/E ratio relates a stock price to earnings per share. Comparing the same company across fiscal year ends can show how much investors paid for each dollar of annual earnings at different points in time. It does not explain why the multiple changed, and comparisons across sectors can be misleading.</p><p>Our historical series uses the adjusted monthly close at or immediately before each fiscal year end divided by positive diluted EPS from that annual filing. It is not a live P/E, forward estimate or recommendation. Years with zero or negative EPS are deliberately omitted rather than presented as a meaningful multiple.</p></div></div>
  <div class="seo-section"><h2>Frequently researched P/E histories</h2><div style="overflow-x:auto"><table class="seo-table"><thead><tr><th>Company</th><th>Fiscal period</th><th>Historical P/E</th><th>Change vs prior FY</th></tr></thead><tbody>${trs}</tbody></table></div></div>
  <div class="seo-section"><h2>Go deeper</h2><div class="seo-links">${RESEARCH_SYMBOLS.map((symbol) => `<a href="/stocks/${symbol}/pe-ratio">${symbol} P/E ratio history</a>`).join('')}<a href="/screens/low-pe-stocks">Low P/E stock screen</a><a href="/compare">Compare two companies</a><a href="/research/how-to-find-undervalued-stocks">How to find undervalued stocks</a><a href="/research/how-to-compare-two-stocks">How to compare two stocks</a></div></div>
  <div class="seo-lock"><h3>Compare valuation with business quality</h3><p>A lower multiple is not automatically cheaper. Put margins, growth, returns and filed risks beside the valuation.</p><a class="seo-cta-btn" href="/compare">Compare two stocks free</a></div>
  <div class="seo-section"><h2>Sources and limitations</h2><p class="seo-about">Annual EPS comes from company 10-K income statements and fiscal-year-end prices from the adjusted monthly series in the local fundamentals cache. Corporate actions and unusual earnings can impair comparability. Verify the primary filing at <a href="https://www.sec.gov/edgar" rel="noopener nofollow" target="_blank">SEC EDGAR</a>; see <a href="/methodology">methodology</a>. Corrections: <a href="mailto:support@stockportfolio.pro">support@stockportfolio.pro</a>.</p></div>`;
    return researchScaffold({
        slug: 'pe-ratio-history', title: 'Historical P/E Ratios: Method, Examples & Company Data',
        description: 'Research historical P/E ratios using fiscal-year-end prices and diluted annual EPS, with transparent methodology and direct links to company histories.',
        h1: 'Historical P/E ratios, explained with filed data', intro: 'Use consistent fiscal-year snapshots to understand how a company’s earnings multiple changed—without confusing historical P/E with today’s valuation.', body,
        jsonld: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Historical P/E ratios', url: canonical, isBasedOn: 'https://www.sec.gov/edgar', publisher: { '@id': `${SITE}/#org` } }
    });
}

// ---- Educational /research/* guides (SEO gap #5) ----
// Informational entry points in the Wisesheets model: plain-English
// explanations, SEC source links, a worked example computed from the live
// fundamentals cache at render time, an FAQ block, and the seo-lock CTA that
// researchScaffold already appends.

function guideFaq(faqs) {
    return faqs.map((f) =>
        `<h3 style="font-size:15.5px;margin:18px 0 6px">${esc(f.q)}</h3><p style="margin:0;font-size:14px;line-height:1.7;max-width:74ch">${esc(f.a)}</p>`).join('');
}

function guideJsonLd(canonical, title, faqs) {
    const graph = [
        { '@type': 'Article', '@id': canonical, url: canonical, name: title, headline: title, isBasedOn: 'https://www.sec.gov/edgar', publisher: { '@id': `${SITE}/#org` }, author: { '@id': `${SITE}/#org` } },
        { '@type': 'WebPage', '@id': canonical, url: canonical, name: title, isBasedOn: 'https://www.sec.gov/edgar', publisher: { '@id': `${SITE}/#org` }, author: { '@id': `${SITE}/#org` } }
    ];
    if (faqs.length) graph.splice(1, 0, { '@type': 'FAQPage', mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
    return graph;
}

function renderRead10KGuide() {
    const canonical = `${SITE}/research/how-to-read-a-10-k`;
    const data = loadFundamentals('AAPL') || {};
    const inc = (data.income || {}).annualReports?.[0] || {};
    const cash = (data.cash || {}).annualReports?.[0] || {};
    const fy = (inc.fiscalDateEnding || '').slice(0, 4) || 'latest';
    const rev = num(inc.totalRevenue), ni = num(inc.netIncome), eps = num(inc.dilutedEPS);
    const ocf = num(cash.operatingCashflow), capexRaw = num(cash.capitalExpenditures);
    const capex = capexRaw === null ? null : Math.abs(capexRaw);
    const fmt = (v) => v === null ? '—' : money(v);
    const name = (data.overview || {}).Name || 'Apple';
    const faqs = [
        { q: 'Where do I find a company’s 10-K?', a: 'Every US public company files its annual report (the 10-K) with the SEC. The fastest route is SEC EDGAR: search the company, open the filing index and pick the most recent 10-K. Companies must file within 60–90 days of fiscal year end depending on size.' },
        { q: 'What is the difference between a 10-K and a 10-Q?', a: 'The 10-K is the annual report: audited full-year financial statements plus Management’s Discussion & Analysis and risk factors. The 10-Q is the lighter, unaudited quarterly report. Both are required filings, but the 10-K is where the audited numbers and the full narrative live.' },
        { q: 'Which parts should a beginner read first?', a: 'Start with the three audited statements: income, balance sheet and cash flow. Then read Management’s Discussion & Analysis (MD&A), where the company itself explains the drivers, and skim the risk factors for what could go wrong.' }
    ];
    const body = `
  <div class="seo-section"><h2>What a 10-K is and why investors read it</h2><div class="seo-about"><p>A 10-K is the annual report every US public company files with the SEC. It contains audited financial statements, a management discussion, and a candid section on the risks the company believes it faces. The numbers in a 10-K are the ones the company is legally responsible for — which is why serious research starts here rather than on a price chart.</p><p>The primary source is <a href="https://www.sec.gov/edgar" rel="noopener nofollow" target="_blank">SEC EDGAR</a>, where every filing is public, searchable and free.</p></div></div>
  <div class="seo-section"><h2>The financial statements at a glance</h2><div class="seo-about"><p><strong>Income statement</strong> — revenue, costs and the profit (or loss) for the year. <strong>Balance sheet</strong> — what the company owns and owes at year end. <strong>Cash flow statement</strong> — where cash actually came from and went, including what was reinvested and what was returned to shareholders. <strong>Statement of equity</strong> — how retained earnings and share counts moved. Most investors read the first three and go back for the fourth when they need it.</p></div></div>
  <div class="seo-section"><h2>Worked example: ${esc(name)}’s fiscal ${esc(fy)} 10-K</h2><div class="seo-about"><p>The latest filed annual income statement shows revenue of ${esc(fmt(rev))} and net income of ${esc(fmt(ni))}, or diluted EPS of ${esc(eps === null ? '—' : eps.toFixed(2))}. Operating cash flow was ${esc(fmt(ocf))} while capital expenditures were ${esc(fmt(capex))} — the difference is the cash the business produced before reinvestment. Every figure is available here with its filed history and source links: <a href="/stocks/AAPL/revenue">AAPL revenue history</a> · <a href="/stocks/AAPL/net-income">AAPL net income history</a> · <a href="/stocks/AAPL/free-cash-flow">AAPL free cash flow history</a>.</p><p>Open the primary documents at <a href="${esc(secCompanyUrl('AAPL'))}" rel="noopener nofollow" target="_blank">Apple’s 10-K filings on SEC EDGAR</a>.</p></div></div>
  <div class="seo-section"><h2>Read MD&A and the risk factors, not just the numbers</h2><div class="seo-about"><p>The statements answer “how much.” Management’s Discussion and Analysis answers “why” — the company’s own explanation of what moved revenue, margins and cash, and what it expects next. The risk factors are the formal list of things that could hurt the business. Reading all three together is what turns a 10-K into research instead of a data dump.</p></div></div>
  <div class="seo-section"><h2>Frequently asked questions</h2>${guideFaq(faqs)}</div>
  <div class="seo-section"><h2>Related research</h2><div class="seo-links"><a href="/research/what-is-free-cash-flow">What is free cash flow?</a><a href="/research/how-to-compare-two-stocks">How to compare two stocks</a><a href="/research/how-to-find-undervalued-stocks">How to find undervalued stocks</a><a href="/methodology">Full methodology</a></div></div>
  <div class="seo-section"><h2>Sources and limitations</h2><p class="seo-about">Figures shown are from the local fundamentals cache, which originates in company SEC filings; they are a convenience summary, not a substitute for reading the primary 10-K at <a href="https://www.sec.gov/edgar" rel="noopener nofollow" target="_blank">SEC EDGAR</a>. See <a href="/methodology">methodology</a>. Not investment advice.</p></div>`;
    return researchScaffold({
        slug: 'how-to-read-a-10-k', title: 'How to Read a 10-K: A Plain-English Walkthrough',
        description: 'Learn how to read a 10-K with a worked example from real filings — the financial statements, MD&A, risk factors and where to find them on SEC EDGAR.',
        h1: 'How to read a 10-K', intro: 'A plain-English walkthrough of the annual report — what each section is for, what to read first and how to pull the filed numbers yourself.', body,
        jsonld: guideJsonLd(canonical, 'How to read a 10-K', faqs)
    });
}

function renderCompareGuide() {
    const canonical = `${SITE}/research/how-to-compare-two-stocks`;
    const a = loadFundamentals('AAPL') || {}; const b = loadFundamentals('MSFT') || {};
    const sA = monthlySeries(a), sB = monthlySeries(b);
    const r = (series, years) => totalReturn(series, years);
    const pct = (v) => v === null ? '—' : signedPct(v);
    const nameA = (a.overview || {}).Name || 'Apple', nameB = (b.overview || {}).Name || 'Microsoft';
    const peA = num((a.overview || {}).TrailingPE), peB = num((b.overview || {}).TrailingPE);
    const peFmt = (v) => v === null ? '—' : `${v.toFixed(1)}×`;
    const faqs = [
        { q: 'What should I compare first — the stock or the business?', a: 'The business. Revenue growth, margins, returns on capital and debt describe how the company actually performs; the price multiple tells you what the market currently charges for that performance. Comparing price before business is how superficially similar charts hide very different companies.' },
        { q: 'Why is it misleading to compare P/E ratios across sectors?', a: 'Different sectors carry different typical margins, growth and capital intensity, so a 25× multiple in one sector can be ordinary while the same number is expensive in another. Compare a company against its own history and its same-sector peers first.' },
        { q: 'Where do the numbers in this example come from?', a: 'Returns come from monthly adjusted closes (split- and dividend-adjusted) in the fundamentals cache; P/E uses trailing annual EPS from the latest filed income statement. Every underlying series links to its filed source.' }
    ];
    const body = `
  <div class="seo-grid"><div class="seo-tile"><div class="l">1-year</div><div class="v">${esc(pct(r(sA, 1)))} vs ${esc(pct(r(sB, 1)))}</div></div><div class="seo-tile"><div class="l">5-year</div><div class="v">${esc(pct(r(sA, 5)))} vs ${esc(pct(r(sB, 5)))}</div></div><div class="seo-tile"><div class="l">Trailing P/E</div><div class="v" style="font-size:16px">${esc(peFmt(peA))} vs ${esc(peFmt(peB))}</div></div></div>
  <div class="seo-section"><h2>Compare the business first, the stock second</h2><div class="seo-about"><p>A comparison is only useful when it matches the right questions. Start with the business: Is revenue growing and at what pace? Are margins stable, expanding or eroding? How much of the result is cash rather than accounting profit? How much debt is on the balance sheet? Then — and only then — ask what the market charges for it.</p></div></div>
  <div class="seo-section"><h2>Worked example: ${esc(nameA)} vs ${esc(nameB)}</h2><div class="seo-about"><p>Over the past year ${esc(nameA)} returned ${esc(pct(r(sA, 1)))} on an adjusted basis while ${esc(nameB)} returned ${esc(pct(r(sB, 1)))}; over five years the figures are ${esc(pct(r(sA, 5)))} and ${esc(pct(r(sB, 5)))}. On trailing filed earnings ${esc(nameA)} trades near ${esc(peFmt(peA))} and ${esc(nameB)} near ${esc(peFmt(peB))} — but the multiple only means something once you have checked margins, growth and the balance sheet behind it. The full head-to-head, with the verdict, is at <a href="/compare/AAPL-vs-MSFT">Apple vs Microsoft</a>.</p></div></div>
  <div class="seo-section"><h2>Watch the base you compare on</h2><div class="seo-about"><p>A price-to-earnings multiple changes with the price, the fiscal year end, and whether earnings are trailing or forward. Returns change with the start date and whether dividends are counted. Two sources showing “different” numbers are often just using different bases — the honest comparison states the period and the formula.</p></div></div>
  <div class="seo-section"><h2>Frequently asked questions</h2>${guideFaq(faqs)}</div>
  <div class="seo-section"><h2>Related research</h2><div class="seo-links"><a href="/compare">Compare any two stocks</a><a href="/research/how-to-find-undervalued-stocks">How to find undervalued stocks</a><a href="/research/pe-ratio-history">Historical P/E research</a><a href="/methodology">Full methodology</a></div></div>
  <div class="seo-section"><h2>Sources and limitations</h2><p class="seo-about">Returns are computed from the split- and dividend-adjusted monthly close series in the fundamentals cache; P/E is trailing fiscal-year-end price divided by positive diluted annual EPS. All figures refresh nightly and originate in <a href="https://www.sec.gov/edgar" rel="noopener nofollow" target="_blank">SEC EDGAR</a>. See <a href="/methodology">methodology</a>. Not investment advice.</p></div>`;
    return researchScaffold({
        slug: 'how-to-compare-two-stocks', title: 'How to Compare Two Stocks Without Fooling Yourself',
        description: 'Compare two stocks fairly: business fundamentals before valuation, same-sector peers, adjusted returns and a real Apple vs Microsoft worked example.',
        h1: 'How to compare two stocks', intro: 'A method for comparing companies fairly — business first, valuation second, always on the same basis, with a real filed-data example.', body,
        jsonld: guideJsonLd(canonical, 'How to compare two stocks', faqs)
    });
}

function renderFreeCashFlowGuide() {
    const canonical = `${SITE}/research/what-is-free-cash-flow`;
    const data = loadFundamentals('AAPL') || {};
    const cash = (data.cash || {}).annualReports?.[0] || {};
    const fy = (cash.fiscalDateEnding || '').slice(0, 4) || 'latest';
    const ocf = num(cash.operatingCashflow), capexRaw = num(cash.capitalExpenditures);
    const capex = capexRaw === null ? null : Math.abs(capexRaw);
    const fcf = ocf !== null && capex !== null ? ocf - capex : null;
    const fmt = (v) => v === null ? '—' : money(v);
    const name = (data.overview || {}).Name || 'Apple';
    const faqs = [
        { q: 'Is free cash flow the same as net income?', a: 'No. Net income is accounting profit and can include non-cash items such as depreciation. Free cash flow is the cash left after operating cash flow pays for the capital expenditures needed to run the business. The two often differ materially.' },
        { q: 'Can free cash flow be negative for a healthy company?', a: 'Yes. Young or fast-growing companies routinely invest more in plant, inventory and equipment than current operations generate, producing negative FCF for years. The number is diagnostic, not a verdict — read it alongside growth and debt.' },
        { q: 'Where do the operating and capital figures come from?', a: 'They are the company’s filed cash flow statement at SEC EDGAR. This site computes free cash flow deterministically as operating cash flow minus capital expenditures and shows the full history on each company’s free cash flow page.' }
    ];
    const body = `
  <div class="seo-section"><h2>The one-line definition</h2><div class="seo-about"><p>Free cash flow (FCF) = operating cash flow − capital expenditures. It is the cash a business produces in a period after paying for the investments required to keep it running. It matters because it is the cash a company can repay debt with, buy back shares with, pay dividends with, or reinvest — and because it is much harder to inflate with accounting than net income.</p></div></div>
  <div class="seo-section"><h2>Worked example: ${esc(name)} fiscal ${esc(fy)}</h2><div class="seo-about"><p>From the filed cash flow statement: operating cash flow of ${esc(fmt(ocf))} minus capital expenditures of ${esc(fmt(capex))} gives free cash flow of ${esc(fmt(fcf))} for the fiscal year. The full filed series — with every year’s operating cash flow, capital expenditures and the derived FCF — is on the <a href="/stocks/AAPL/free-cash-flow">Apple free cash flow history page</a>, which links back to the primary filing.</p></div></div>
  <div class="seo-section"><h2>Why analysts watch it more than earnings</h2><div class="seo-about"><p>Net income can be moved by non-cash charges, inventory timing and one-off items. Free cash flow asks a simpler question: after keeping the lights on and the plants running, how much cash did the company generate? Steady, growing FCF is how a company funds returns to shareholders without borrowing. When FCF keeps falling while profits keep rising, the accounting deserves a second look.</p></div></div>
  <div class="seo-section"><h2>Frequently asked questions</h2>${guideFaq(faqs)}</div>
  <div class="seo-section"><h2>Related research</h2><div class="seo-links"><a href="/research/how-to-read-a-10-k">How to read a 10-K</a><a href="/research/how-to-compare-two-stocks">How to compare two stocks</a><a href="/methodology">Full methodology</a></div></div>
  <div class="seo-section"><h2>Sources and limitations</h2><p class="seo-about">FCF is computed deterministically as operating cash flow minus capital expenditures from the local cache of filed cash flow statements, which originates in <a href="https://www.sec.gov/edgar" rel="noopener nofollow" target="_blank">SEC EDGAR</a>. Different sources define FCF differently (for example, subtracting acquisitions), so state the definition when you cite it. See <a href="/methodology">methodology</a>. Not investment advice.</p></div>`;
    return researchScaffold({
        slug: 'what-is-free-cash-flow', title: 'What Is Free Cash Flow? Definition with a Filed Example',
        description: 'Free cash flow explained with a real worked example — operating cash flow minus capital expenditures, why it matters and where to find the filed numbers.',
        h1: 'What is free cash flow?', intro: 'The definition, a real filed example, and why analysts watch this number more closely than net income.', body,
        jsonld: guideJsonLd(canonical, 'What is free cash flow?', faqs)
    });
}

function renderFindUndervaluedGuide() {
    const canonical = `${SITE}/research/how-to-find-undervalued-stocks`;
    const a = loadFundamentals('AAPL') || {}; const b = loadFundamentals('MSFT') || {};
    const peA = num((a.overview || {}).TrailingPE), peB = num((b.overview || {}).TrailingPE);
    const peFmt = (v) => v === null ? '—' : `${v.toFixed(1)}×`;
    const nameA = (a.overview || {}).Name || 'Apple', nameB = (b.overview || {}).Name || 'Microsoft';
    const faqs = [
        { q: 'Is “cheap” the same as “undervalued”?', a: 'No. Cheap means a low multiple relative to a reference — an industry, the market or the company’s own history. Undervalued means the market is systematically understating the cash the business can return. A low P/E on a falling business is cheap for a reason.' },
        { q: 'What should I check after a screen flags a stock?', a: 'The filings: is revenue growing, are margins stable or eroding, is cash flow backing up the earnings, how much debt is there, and what does management say about the future? A shortlist from a screen is an agenda for reading, not a conclusion.' },
        { q: 'Does a low P/E mean the stock will go up?', a: 'No. Multiple levels reflect consensus about growth, risk and quality, and a stock can stay cheap while it re-rates or while the business keeps disappointing. Valuation signals help you choose a research priority, not predict a price.' }
    ];
    const body = `
  <div class="seo-section"><h2>Cheap is a fact, undervalued is a conclusion</h2><div class="seo-about"><p>Every tool that “finds undervalued stocks” actually finds one thing: a price that is low relative to some reference — a sector, the market, the company’s own history. Whether that low price is an opportunity or a warning is a question about the business, not the ratio. This page turns that the other way: the screen narrows the field, and the filings decide.</p></div></div>
  <div class="seo-section"><h2>Worked example: two very different “multiples”</h2><div class="seo-about"><p>As of the latest filed data, ${esc(nameA)} trades near ${esc(peFmt(peA))} trailing earnings while ${esc(nameB)} trades near ${esc(peFmt(peB))} — so ${esc(peA !== null && peB !== null && peA > peB ? 'AAPL' : 'MSFT')} “costs more” per unit of trailing earnings. The question is whether that gap reflects a difference in growth, margins, balance sheet risk, or an opportunity. That is exactly the comparison the <a href="/research/how-to-compare-two-stocks">compare guide</a> and the <a href="/compare">live compare tool</a> are built to help you make.</p></div></div>
  <div class="seo-section"><h2>Start from a screen, verify in the filings</h2><div class="seo-about"><p>The <a href="/screens/low-pe-stocks">low P/E stock screen</a> is a legitimate starting point: it ranks companies by price relative to earnings. Treat the output as a shortlist. For each name, the research loop is the same — growth, margins, cash flow, debt, dividend safety — then a decision about why the market is charging what it does. The same discipline applies to <a href="/research/pe-ratio-history">historical P/E research</a>.</p></div></div>
  <div class="seo-section"><h2>Frequently asked questions</h2>${guideFaq(faqs)}</div>
  <div class="seo-section"><h2>Related research</h2><div class="seo-links"><a href="/research/how-to-compare-two-stocks">How to compare two stocks</a><a href="/research/what-is-free-cash-flow">What is free cash flow?</a><a href="/research/how-to-read-a-10-k">How to read a 10-K</a><a href="/research/pe-ratio-history">Historical P/E research</a></div></div>
  <div class="seo-section"><h2>Sources and limitations</h2><p class="seo-about">Trailing P/E figures come from the fundamentals cache, which originates in <a href="https://www.sec.gov/edgar" rel="noopener nofollow" target="_blank">SEC EDGAR</a>. A multiple is a research signal, not a recommendation; a low P/E never guarantees a gain. See <a href="/methodology">methodology</a>. Not investment advice.</p></div>`;
    return researchScaffold({
        slug: 'how-to-find-undervalued-stocks', title: 'How to Find Undervalued Stocks: A Source-Backed Method',
        description: 'A disciplined, source-backed method for finding undervalued stocks — cheap is a fact, undervalued is a conclusion — with a real worked example.',
        h1: 'How to find undervalued stocks', intro: 'Cheap is a fact, undervalued is a conclusion. A method for turning screens into research — and research into a decision.', body,
        jsonld: guideJsonLd(canonical, 'How to find undervalued stocks', faqs)
    });
}

function renderDilutionScorecard() {
    const canonical = `${SITE}/research/dilution-scorecard`;
    const all = dilutionRows();
    const ranked = all.filter((row) => !row.notComparable && row.oneYearPct !== null)
        .sort((a, b) => b.oneYearPct - a.oneYearPct).slice(0, 50);
    const flagged = all.filter((row) => row.notComparable).length;
    const trs = ranked.map((row, index) => `<tr><td>${index + 1}</td><td><a href="/stocks/${esc(row.symbol)}/shares-outstanding">${esc(row.name)} (${esc(row.symbol)})</a></td><td>${esc(row.sector || '—')}</td><td>${esc(METRICS['shares-outstanding'].fmt(row.latestShares))}</td><td>${esc(signedPct(row.oneYearPct))}</td><td>${esc(signedPct(row.fiveYearPct))}</td><td>${esc(money(row.repurchases))}</td></tr>`).join('');
    const body = `
  <div class="seo-grid"><div class="seo-tile"><div class="l">Companies in CSV</div><div class="v">${all.length}</div></div><div class="seo-tile"><div class="l">Comparable rankings</div><div class="v">${all.length - flagged}</div></div><div class="seo-tile"><div class="l">Flagged discontinuities</div><div class="v">${flagged}</div></div></div>
  <div class="seo-section"><h2>Largest reported latest-year increases</h2><p class="seo-about">Ranked by the latest annual percentage increase in year-end common shares among up to 500 large primary listings with usable recent history. An increase is a research prompt—not a verdict—because acquisitions and compensation may create value even while adding shares.</p><div style="overflow-x:auto"><table class="seo-table"><thead><tr><th>Rank</th><th>Company</th><th>Sector</th><th>Latest shares</th><th>1-year</th><th>Long-run context</th><th>Latest FY repurchases</th></tr></thead><tbody>${trs}</tbody></table></div><p style="font-size:12.5px;color:var(--ink3)">Dollar amounts automatically use millions, billions or trillions according to scale. <a href="/research/dilution-scorecard.csv">Download all ${all.length} rows as CSV</a>.</p></div>
  <div class="seo-lock"><h3>Use the data in your own research</h3><p>The CSV includes company, sector, latest period, raw share count, one- and five-year change, repurchases and comparability status.</p><a class="seo-cta-btn" href="/research/dilution-scorecard.csv">Download the free CSV</a></div>
  <div class="seo-section"><h2>How this scorecard is built</h2><div class="seo-about"><p>Universe: up to 500 market-cap-ranked US primary listings in the existing fundamentals cache whose latest annual share count is dated 2024 or later. Metric: latest reported annual common shares versus the prior annual observation and an observation at least five fiscal years earlier when available. Latest-fiscal-year share repurchases are shown as context, but do not alter the ranking.</p><p>Rows with a one-year change of 65% or more or a five-year change of 200% or more are retained in the downloadable dataset but marked “not directly comparable” and excluded from rankings. Values are never imputed. Source: cached company statements originating in <a href="https://www.sec.gov/edgar" rel="noopener nofollow" target="_blank">SEC filings</a>; refreshed nightly. <a href="/methodology">Methodology</a>. Not investment advice.</p></div></div>
  <div class="seo-section"><h2>Related research</h2><div class="seo-links"><a href="/research/shares-outstanding">Shares outstanding research guide</a><a href="/tools/dilution">Share dilution calculator</a><a href="/research/pe-ratio-history">Historical P/E research</a></div></div>`;
    return researchScaffold({
        slug: 'dilution-scorecard', title: `Share Dilution Scorecard: ${all.length} US Companies + CSV`,
        description: `Compare one- and five-year share-count changes across ${all.length} large US companies. Filed data, split warnings, buyback context and free CSV.`,
        h1: 'US company share dilution scorecard', intro: 'A reproducible starting point for finding material share-count changes, with source trails, comparability warnings and a downloadable dataset.', body,
        jsonld: { '@context': 'https://schema.org', '@type': 'Dataset', name: 'US Company Share Dilution Scorecard', description: 'Annual common-share-count changes and repurchase context for large US-listed companies.', url: canonical, creator: { '@id': `${SITE}/#org` }, isBasedOn: 'https://www.sec.gov/edgar', distribution: { '@type': 'DataDownload', encodingFormat: 'text/csv', contentUrl: `${SITE}/research/dilution-scorecard.csv` } }
    });
}

// ---------- head-to-head comparisons ----------
// Pairs: each primary company with its 2 nearest same-sector neighbours by
// market cap (deduped, alphabetical canonical order). Two neighbours is a
// deliberate crawl-budget ceiling: widening this to four created 11,602 URLs,
// almost exactly the comparison-heavy "discovered, currently not indexed"
// backlog reported by Search Console. The pages still work for any valid pair;
// this list controls only what we actively advertise to crawlers.
const POPULAR_COMPARISONS = [
    ['AMD', 'NVDA'], ['AAPL', 'MSFT'], ['GOOGL', 'META'], ['AMZN', 'MSFT'],
    ['TSLA', 'F'], ['JPM', 'BAC'], ['KO', 'PEP'], ['V', 'MA'],
    ['AMD', 'INTC'], ['DIS', 'NFLX'], ['CRM', 'ORCL'], ['WMT', 'COST']
];
let _pairs = null;
function comparePairs() {
    if (_pairs) return _pairs;
    const rows = aiChat.screenRows({
        limit: 5000, maxLimit: 5000, sort_by: 'marketCapB', exclude_secondary_listings: true
    }).rows.filter((r) => r.marketCapB !== null && r.sector && /^[A-Z0-9.]+$/.test(r.symbol));
    const bySector = {};
    rows.forEach((r) => { (bySector[r.sector] = bySector[r.sector] || []).push(r); });
    const set = new Set();
    POPULAR_COMPARISONS.forEach(([x, y]) => {
        const ca = resolveCanonicalSymbol(x);
        const cb = resolveCanonicalSymbol(y);
        if (!ca || !cb) return;
        if (!aiChat.metricsFor(ca) || !aiChat.metricsFor(cb)) return;
        const [a, b] = [ca, cb].sort();
        set.add(`${a}-vs-${b}`);
    });
    Object.values(bySector).forEach((list) => {
        list.sort((a, b) => b.marketCapB - a.marketCapB);
        list.forEach((r, i) => {
            [list[i + 1], list[i + 2]].forEach((p) => {
                if (!p) return;
                const [a, b] = [r.symbol, p.symbol].sort();
                set.add(`${a}-vs-${b}`);
            });
        });
    });
    _pairs = [...set].sort();
    return _pairs;
}

// Shared client-side helpers: the old implementation embedded roughly 180 KB of
// repeated <option> markup in every comparison page. Search suggestions now use
// the site's existing public asset search only after a visitor types, keeping
// the server-rendered response small while retaining company-name autocomplete.
const CMP_EXTRACT_SYM = `function cmpExtractSym(v){v=(v||'').split(' — ')[0];return v.toUpperCase().replace(/[^A-Z0-9.]/g,'');}`;
const CMP_AUTOCOMPLETE = `function cmpWireAutocomplete(inputId,boxId){
  var input=document.getElementById(inputId),box=document.getElementById(boxId);if(!input||!box)return;
  var rows=[],active=-1,seq=0,timer=null;
  function close(){rows=[];active=-1;box.hidden=true;box.innerHTML='';input.removeAttribute('aria-activedescendant');}
  function draw(){if(!rows.length){close();return;}box.innerHTML=rows.map(function(r,i){return '<button type="button" role="option" id="'+boxId+'-'+i+'" data-i="'+i+'" aria-selected="'+(i===active)+'" style="display:flex;width:100%;gap:9px;padding:9px 11px;border:0;border-bottom:1px solid var(--line);background:'+(i===active?'var(--paper)':'var(--surface)')+';color:var(--ink);text-align:left;cursor:pointer"><strong style="min-width:54px">'+V2.esc(r.symbol)+'</strong><span style="color:var(--ink2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+V2.esc(r.name||r.symbol)+'</span></button>';}).join('');box.hidden=false;if(active>=0)input.setAttribute('aria-activedescendant',boxId+'-'+active);}
  function choose(i){var r=rows[i];if(!r)return;input.value=r.symbol+' — '+(r.name||r.symbol);close();input.focus();}
  input.addEventListener('input',function(){var q=input.value.trim();clearTimeout(timer);var mine=++seq;if(q.length<1){close();return;}timer=setTimeout(function(){V2.searchAssets(q,{limit:8,types:['stock']}).then(function(found){if(mine!==seq)return;rows=(found||[]).filter(function(r){return /^[A-Z0-9.]{1,10}$/.test(r.symbol||'');});active=-1;draw();}).catch(close);},120);});
  input.addEventListener('keydown',function(e){if(box.hidden||!rows.length)return;if(e.key==='ArrowDown'||e.key==='ArrowUp'){e.preventDefault();active=e.key==='ArrowDown'?(active+1)%rows.length:(active-1+rows.length)%rows.length;draw();}else if(e.key==='Enter'&&active>=0){e.preventDefault();choose(active);}else if(e.key==='Escape')close();});
  box.addEventListener('pointerdown',function(e){var b=e.target.closest('[data-i]');if(!b)return;e.preventDefault();choose(Number(b.dataset.i));});
  document.addEventListener('pointerdown',function(e){if(e.target!==input&&!box.contains(e.target))close();});
}`;

// ---- /compare hub: pick two tickers → the side-by-side + AI verdict ----
// Gives the "Compare" nav item a real home and works as a compare-hub SEO page.
function renderCompareIndex() {
    const canonical = `${SITE}/compare`;
    const title = 'Compare Any Two US Stocks — Fundamentals & AI Verdict';
    const description = 'Put any two US-listed companies side by side: revenue, margins, growth, P/E, ROE and red flags from SEC filings — plus an AI verdict on which is the stronger business and the cheaper stock. Free, no account.';
    const popular = POPULAR_COMPARISONS;
    const popHtml = popular.map(([a, b]) => { const p = [a, b].slice().sort(); return `<a href="/compare/${p[0]}-vs-${p[1]}" style="display:inline-block;padding:8px 13px;border:1px solid var(--line);border-radius:999px;font-size:13.5px;font-weight:600;color:var(--ink);background:var(--surface)">${esc(a)} vs ${esc(b)}</a>`; }).join('');
    // Deduplicate browse links against popular pairs and cap at 200
    const popSet = new Set(popular.map(([a, b]) => { const [x, y] = [a, b].slice().sort(); return `${x}-vs-${y}`; }));
    const allPairs = comparePairs();
    const browsePairs = allPairs.filter((p) => !popSet.has(p)).slice(0, 200);
    const browseHtml = browsePairs.map((slug) => {
        const parts = slug.split('-vs-');
        return `<a href="/compare/${esc(slug)}" style="display:inline-block;padding:6px 11px;border:1px solid var(--line);border-radius:999px;font-size:12.5px;font-weight:500;color:var(--ink);background:var(--surface)">${esc(parts[0])} vs ${esc(parts[1])}</a>`;
    }).join('');
    const jsonld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebPage', name: title, url: canonical, publisher: { '@id': `${SITE}/#org` } });
    return head(title, description, canonical, jsonld) + nav('compare') + `
<main class="seo-wrap">
  <div class="seo-crumbs"><a href="/stocks">Stocks</a> / Compare</div>
  <h1 class="seo-h1">Compare any two US stocks</h1>
  <p class="seo-sub">Side by side on the filed numbers &mdash; revenue, margins, growth, P/E, ROE, red flags &mdash; plus an AI verdict on which is the stronger business and the cheaper stock. Every figure from SEC filings, refreshed nightly.</p>
  <div class="seo-section" style="border:1px solid var(--line);border-radius:12px;background:var(--surface);padding:18px">
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <div style="position:relative;flex:1;min-width:150px"><input id="cA" autocomplete="off" placeholder="Company or ticker — e.g. AMD" aria-label="First company or ticker" aria-autocomplete="list" aria-controls="cAMatches" style="width:100%;min-height:46px;padding:0 14px;border:1px solid var(--line);border-radius:9px;font-size:16px;background:var(--paper);color:var(--ink)"><div id="cAMatches" role="listbox" hidden style="position:absolute;z-index:20;left:0;right:0;top:calc(100% + 4px);max-height:290px;overflow:auto;border:1px solid var(--line);border-radius:9px;background:var(--surface);box-shadow:0 10px 28px rgba(0,0,0,.12)"></div></div>
      <span style="color:var(--ink3);font-weight:700;font-size:14px">vs</span>
      <div style="position:relative;flex:1;min-width:150px"><input id="cB" autocomplete="off" placeholder="Company or ticker — e.g. Nvidia" aria-label="Second company or ticker" aria-autocomplete="list" aria-controls="cBMatches" style="width:100%;min-height:46px;padding:0 14px;border:1px solid var(--line);border-radius:9px;font-size:16px;background:var(--paper);color:var(--ink)"><div id="cBMatches" role="listbox" hidden style="position:absolute;z-index:20;left:0;right:0;top:calc(100% + 4px);max-height:290px;overflow:auto;border:1px solid var(--line);border-radius:9px;background:var(--surface);box-shadow:0 10px 28px rgba(0,0,0,.12)"></div></div>
      <button type="button" id="cGo" style="min-height:46px;padding:0 22px;border:0;border-radius:9px;background:var(--accent);color:#fff;font-size:15px;font-weight:650;cursor:pointer;white-space:nowrap">Compare &rarr;</button>
    </div>
    <p id="cErr" style="margin:10px 0 0;font-size:13px;color:#b4413c;display:none"></p>
  </div>
  <div class="seo-section">
    <h2>Popular comparisons</h2>
    <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:6px">${popHtml}</div>
  </div>
  <div class="seo-section">
    <h2>Browse more matchups</h2>
    <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">${browseHtml}</div>
  </div>
</main>
<script>
(function(){
  ${CMP_EXTRACT_SYM}
  ${CMP_AUTOCOMPLETE}
  cmpWireAutocomplete('cA','cAMatches');cmpWireAutocomplete('cB','cBMatches');
  function go(){
    var a=cmpExtractSym(document.getElementById('cA').value);
    var b=cmpExtractSym(document.getElementById('cB').value);
    var err=document.getElementById('cErr');
    if(!a||!b){err.textContent='Enter two tickers to compare.';err.style.display='block';return;}
    if(a===b){err.textContent='Pick two different companies.';err.style.display='block';return;}
    var p=[a,b].sort();location.href='/compare/'+p[0]+'-vs-'+p[1];
  }
  document.getElementById('cGo').addEventListener('click',go);
  ['cA','cB'].forEach(function(id){document.getElementById(id).addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.defaultPrevented){e.preventDefault();go();}});});
})();
</script>` + footer();
}

// ---- Discovered compare pairs -> sitemap ----
// /compare renders ANY pair that has metrics for both sides, but comparePairs()
// only emits the algorithmic set (sector adjacency + POPULAR_COMPARISONS). A
// pair that arrives via an external link (Bing found PANW-vs-SNDK that way)
// renders 200 + indexable yet never had a sitemap entry — Bing flags this as
// "important new pages missing from your sitemaps". Record each newly-served
// pair into a bounded snapshot (same contract as indexable-shares.json /
// filing-diff-symbols.json); seo-pages.buildSitemapInventory merges it in.
// Best-effort: comparison works with the file missing or unwritable.
const DISCOVERED_COMPARES_FILE = path.join(__dirname, 'discovered-compares.json');
const DISCOVERED_COMPARES_MAX = 1000;
const _discoveredSeen = new Set();
let _discoveredLoaded = false;
let _discoveredFlushTimer = null;
let _discoveredPending = [];
function noteDiscoveredCompare(a, b) {
    try {
        a = String(a || '').toUpperCase(); b = String(b || '').toUpperCase();
        if (!/^[A-Z0-9.]+$/.test(a) || !/^[A-Z0-9.]+$/.test(b) || a === b) return;
        if (!_discoveredLoaded) {
            _discoveredLoaded = true;
            try { JSON.parse(fs.readFileSync(DISCOVERED_COMPARES_FILE, 'utf8')).forEach((e) => { if (e && e.p) _discoveredSeen.add(e.p); }); } catch (_) { /* first entry */ }
        }
        const slug = [a, b].sort().join('-vs-');
        if (_discoveredSeen.has(slug)) return;
        _discoveredSeen.add(slug);
        _discoveredPending.push({ p: slug, at: new Date().toISOString().slice(0, 10) });
        if (_discoveredFlushTimer) return;
        // Write-behind: one flush per burst so a crawler sweeping pair URLs
        // costs one write, not one per render.
        _discoveredFlushTimer = setTimeout(() => {
            _discoveredFlushTimer = null;
            try {
                let list = [];
                try { list = JSON.parse(fs.readFileSync(DISCOVERED_COMPARES_FILE, 'utf8')); } catch (_) { /* first entry */ }
                const merged = new Map();
                list.concat(_discoveredPending).forEach((e) => { if (e && e.p) merged.set(e.p, e); });
                fs.writeFileSync(DISCOVERED_COMPARES_FILE, JSON.stringify([...merged.values()].slice(-DISCOVERED_COMPARES_MAX)));
                _discoveredPending = [];
            } catch (_) { /* kept in _discoveredPending; next new pair re-arms */ }
        }, 5000).unref();
    } catch (_) { /* best-effort */ }
}

// ---- paid/free pair-page split ----
// app.js hands in its optionalAuth (an app.js internal) at mount time so the
// /compare/:pair route can resolve the visitor's tier. Unset (unit tests mount
// the bare router) = every visitor renders the free page.
let cmpAuth = null;
function setCompareAuth(x) { cmpAuth = x || null; }
// Em-dashes are a house-style call on page copy: prose on the paid variant
// reads with commas and colons instead. The missing-data cell placeholder in
// tables stays an em-dash on purpose — that is a table glyph, not prose.
function dedash(s) {
    return String(s == null ? '' : s).replace(/\s*—\s*/g, ', ').replace(/\s{2,}/g, ' ').trim();
}

// Shared data assembly for the pair page. Both renderers (renderComparePage =
// the free/SEO surface, renderComparePagePro = the paid variant) consume this
// so the two pages can never disagree about the underlying numbers.
function compareData(pairSlug) {
    const mm = String(pairSlug || '').toUpperCase().match(/^([A-Z0-9.]+)-VS-([A-Z0-9.]+)$/);
    if (!mm) return null;
    let [a, b] = [mm[1], mm[2]];
    if (a === b) return null;
    if (a > b) return { redirect: `/compare/${b}-vs-${a}` };
    const ma = aiChat.metricsFor(a); const mb = aiChat.metricsFor(b);
    if (!ma || !mb) return null;
    const da = loadFundamentals(a) || {}; const db = loadFundamentals(b) || {};
    const inca = ((da.income || {}).annualReports || [])[0] || {};
    const incb = ((db.income || {}).annualReports || [])[0] || {};
    // Extra statements the pro variant's expanded table draws on (pure adds —
    // the free render never reads these).
    const inca1 = ((da.income || {}).annualReports || [])[1] || {};
    const incb1 = ((db.income || {}).annualReports || [])[1] || {};
    const bala = ((da.balance || {}).annualReports || [])[0] || {};
    const balb = ((db.balance || {}).annualReports || [])[0] || {};
    const casha = ((da.cash || {}).annualReports || [])[0] || {};
    const cashb = ((db.cash || {}).annualReports || [])[0] || {};

    // Performance from the monthly adjusted-close series (no new data source).
    const perfA = { r1: totalReturn(monthlySeries(da), 1), r3: totalReturn(monthlySeries(da), 3), r5: totalReturn(monthlySeries(da), 5), r10: totalReturn(monthlySeries(da), 10) };
    const perfB = { r1: totalReturn(monthlySeries(db), 1), r3: totalReturn(monthlySeries(db), 3), r5: totalReturn(monthlySeries(db), 5), r10: totalReturn(monthlySeries(db), 10) };
    const rangeA = fiftyTwoWeekRange(da);
    const rangeB = fiftyTwoWeekRange(db);
    // First monthly close = a proxy for the listing year. A return window the
    // series can't cover is a recent listing, not missing data — the cell says
    // "Listed YYYY" instead of a bare em-dash that reads as broken (owner
    // report, 9/8: LB's 3/5/10-year cells all dashed because it listed in 2024).
    const listedYear = (d) => { const s = monthlySeries(d); return s.length ? s[0].date.slice(0, 4) : null; };
    const listedA = listedYear(da); const listedB = listedYear(db);
    const fmtRet = (v, listed) => v !== null ? `${v.toFixed(1)}%` : (listed ? `Listed ${listed}` : '—');

    const canonical = `${SITE}/compare/${a}-vs-${b}`;
    const shortCompany = (value) => String(value || '').replace(/^The\s+/i, '').replace(/,?\s+(Incorporated|Corporation|Corp|Company|Co|Holdings|plc|Ltd|Limited|L\.?P|N\.?V|S\.?A|Inc)\.?$/i, '').trim();
    // GSC comparison queries commonly contain company names rather than
    // tickers (for example, “Playtika Ltd. Yelp”). Put both names and tickers
    // in the title/H1 so the canonical comparison page is an obvious match.
    const title = `${shortCompany(ma.name)} (${a}) vs ${shortCompany(mb.name)} (${b}) | SEC-filed comparison`;
    const description = `${ma.name} (${a}) vs ${mb.name} (${b}) with side-by-side SEC-filed revenue, margins, growth, P/E, ROE, dividends, red flags and 1/3/5/10-year performance. Compare the fundamentals before buying.`;

    const fmtB = (v) => v === null ? '—' : `$${v >= 1000 ? (v / 1000).toFixed(2) + 'T' : v.toFixed(1) + 'B'}`;
    const fmtP = (v) => v === null ? '—' : `${v.toFixed(1)}%`;
    const peFmt = (v) => (v === null || v === undefined) ? '—' : v.toFixed(1);
    const yesNo = (v) => (v === null || v === undefined) ? '—' : (v ? 'Yes' : 'No');
    // win: 0 -> A stronger, 1 -> B stronger, -1 -> tie / not comparable.
    const hi = (av, bv) => (av == null || bv == null || av === bv) ? -1 : (av > bv ? 0 : 1);
    const loPos = (av, bv) => (av == null || bv == null || !(av > 0 && bv > 0) || av === bv) ? -1 : (av < bv ? 0 : 1);
    const boolWin = (av, bv) => (av == null || bv == null || av === bv) ? -1 : (av ? 0 : 1);
    // Only quality / return / value rows get a "winner". Raw size (market cap,
    // revenue, net income) is bigger-not-better, so those stay untinted.
    const rowsMeta = [
        { l: 'Market cap', a: fmtB(ma.marketCapB), b: fmtB(mb.marketCapB), w: -1 },
        { l: 'Revenue (latest FY)', a: money(inca.totalRevenue), b: money(incb.totalRevenue), w: -1 },
        { l: 'Net income (latest FY)', a: money(inca.netIncome), b: money(incb.netIncome), w: -1 },
        { l: 'Revenue growth (5y CAGR)', a: fmtP(ma.revCagr5Pct), b: fmtP(mb.revCagr5Pct), w: hi(ma.revCagr5Pct, mb.revCagr5Pct) },
        { l: 'Net margin', a: fmtP(ma.netMarginPct), b: fmtP(mb.netMarginPct), w: hi(ma.netMarginPct, mb.netMarginPct) },
        { l: 'Return on equity', a: fmtP(ma.roePct), b: fmtP(mb.roePct), w: hi(ma.roePct, mb.roePct) },
        { l: 'P/E ratio', a: peFmt(ma.pe), b: peFmt(mb.pe), w: loPos(ma.pe, mb.pe) },
        { l: 'Dividend yield', a: fmtP(ma.divYieldPct), b: fmtP(mb.divYieldPct), w: hi(ma.divYieldPct, mb.divYieldPct) },
        { l: 'Profitable years (of last 10)', a: String(ma.profitableYears10), b: String(mb.profitableYears10), w: hi(ma.profitableYears10, mb.profitableYears10) },
        { l: 'Positive free cash flow', a: yesNo(ma.fcfPositive), b: yesNo(mb.fcfPositive), w: boolWin(ma.fcfPositive, mb.fcfPositive) }
    ];
    const winCell = 'background:rgba(27,122,75,.10);color:var(--pos);font-weight:650';
    const trs = rowsMeta.map((r) =>
        `<tr><td>${esc(r.l)}</td>` +
        `<td${r.w === 0 ? ` style="${winCell}"` : ''}>${esc(r.a)}</td>` +
        `<td${r.w === 1 ? ` style="${winCell}"` : ''}>${esc(r.b)}</td></tr>`).join('');

    // ---- performance rows (returns from monthly adjusted closes) ----
    // The en-dash must be a literal character, not an entity: cell values pass
    // through esc(), which would turn &ndash; into &amp;ndash; and render the
    // entity as visible text (9/8: every free compare page showed "$x&ndash;$y").
    const rangeFmt = (r) => (r.high != null && r.low != null) ? `$${r.low.toFixed(2)}–$${r.high.toFixed(2)}` : '—';
    const perfRows = [
        { l: '1-year return', a: fmtRet(perfA.r1, listedA), b: fmtRet(perfB.r1, listedB), w: hi(perfA.r1, perfB.r1) },
        { l: '3-year return', a: fmtRet(perfA.r3, listedA), b: fmtRet(perfB.r3, listedB), w: hi(perfA.r3, perfB.r3) },
        { l: '5-year return', a: fmtRet(perfA.r5, listedA), b: fmtRet(perfB.r5, listedB), w: hi(perfA.r5, perfB.r5) },
        { l: '10-year return', a: fmtRet(perfA.r10, listedA), b: fmtRet(perfB.r10, listedB), w: hi(perfA.r10, perfB.r10) },
        { l: '52-week range', a: rangeFmt(rangeA), b: rangeFmt(rangeB), w: -1 }
    ];
    const perfTrs = perfRows.map((r) =>
        `<tr><td>${esc(r.l)}</td>` +
        `<td${r.w === 0 ? ` style="${winCell}"` : ''}>${esc(r.a)}</td>` +
        `<td${r.w === 1 ? ` style="${winCell}"` : ''}>${esc(r.b)}</td></tr>`).join('');
    const perfHtml = `
  <div class="seo-section">
    <h2>Performance &mdash; ${esc(a)} vs ${esc(b)}</h2>
    <p style="margin:0 0 10px;font-size:13.5px;color:var(--ink2)">Total returns from monthly split- and dividend-adjusted closes; 52-week range from the latest quote. Past performance is not a prediction.</p>
    <div style="overflow-x:auto"><table class="seo-table cmp-table">
      <thead><tr><th>&nbsp;</th><th>${esc(ma.name)} (${esc(a)})</th><th>${esc(mb.name)} (${esc(b)})</th></tr></thead>
      <tbody>${perfTrs}</tbody>
    </table></div>
  </div>`;

    const faqs = [
        {
            q: `Which is bigger, ${a} or ${b}?`,
            a: (ma.marketCapB !== null && mb.marketCapB !== null)
                ? `${ma.marketCapB >= mb.marketCapB ? ma.name : mb.name} is larger by market capitalization — ${fmtB(Math.max(ma.marketCapB, mb.marketCapB))} versus ${fmtB(Math.min(ma.marketCapB, mb.marketCapB))}.`
                : 'Market capitalization data is not available for both companies.'
        },
        {
            q: `Which grows faster, ${a} or ${b}?`,
            a: (ma.revCagr5Pct !== null && mb.revCagr5Pct !== null)
                ? `Over the last five fiscal years, ${ma.revCagr5Pct >= mb.revCagr5Pct ? ma.name : mb.name} grew revenue faster — ${fmtP(Math.max(ma.revCagr5Pct, mb.revCagr5Pct))}/yr versus ${fmtP(Math.min(ma.revCagr5Pct, mb.revCagr5Pct))}/yr, computed from SEC-filed statements.`
                : 'Five-year growth data is not available for both companies.'
        },
        { q: 'Where does this data come from?', a: 'All figures are computed from official SEC filings (10-K), refreshed nightly. This is a data comparison, not investment advice.' }
    ];
    // Naming both sides as ticker-bearing entities lets Bing and Copilot resolve
    // the comparison to the right companies rather than to the words alone, and
    // isBasedOn states where the figures come from. Breadcrumbs mirror the
    // metric pages so the whole site exposes one consistent hierarchy.
    const companyNode = (sym, name, data) => {
        const node = { '@type': 'Corporation', name, tickerSymbol: sym, url: `${SITE}/stocks/${sym}` };
        const sector = data.overview?.Sector;
        if (sector) node.industry = sector;
        return node;
    };
    const jsonld = JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'WebPage', '@id': canonical, url: canonical, name: title, description,
                about: [companyNode(a, ma.name, da), companyNode(b, mb.name, db)],
                isBasedOn: { '@type': 'CreativeWork', name: 'SEC filings (10-K)', url: 'https://www.sec.gov/edgar/searchedgar/companysearch' }
            },
            {
                '@type': 'BreadcrumbList',
                itemListElement: [
                    { '@type': 'ListItem', position: 1, name: 'Stocks', item: `${SITE}/stocks` },
                    { '@type': 'ListItem', position: 2, name: 'Compare', item: `${SITE}/compare` },
                    { '@type': 'ListItem', position: 3, name: `${a} vs ${b}`, item: canonical }
                ]
            },
            { '@type': 'FAQPage', mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) }
        ]
    });
    const faqHtml = faqs.map((f) =>
        `<h3 style="font-size:15.5px;margin:18px 0 6px">${esc(f.q)}</h3><p style="margin:0;font-size:14px;line-height:1.7;max-width:74ch">${esc(f.a)}</p>`).join('');

    // ---- plain-English verdict, lifted above the fold (answers the query) ----
    const peX = (v) => `${v.toFixed(1)}×`;
    const vClause = (av, bv, dir, fmt, phrase) => {
        if (av == null || bv == null || av === bv) return null;
        if (dir === 'lo' && !(av > 0 && bv > 0)) return null;
        const aWins = dir === 'hi' ? av > bv : av < bv;
        const w = aWins ? a : b, wv = aWins ? av : bv, lv = aWins ? bv : av;
        return `<strong>${esc(w)}</strong> ${phrase} (${fmt(wv)} vs ${fmt(lv)})`;
    };
    const vbits = [
        vClause(ma.revCagr5Pct, mb.revCagr5Pct, 'hi', fmtP, 'grows revenue faster'),
        vClause(ma.netMarginPct, mb.netMarginPct, 'hi', fmtP, 'earns a higher net margin'),
        vClause(ma.roePct, mb.roePct, 'hi', fmtP, 'has the stronger return on equity'),
        vClause(ma.pe, mb.pe, 'lo', peX, 'trades cheaper on earnings'),
        vClause(ma.divYieldPct, mb.divYieldPct, 'hi', fmtP, 'pays a higher dividend yield')
    ].filter(Boolean).slice(0, 3);
    let sizeBit = null;
    if (ma.marketCapB != null && mb.marketCapB != null && ma.marketCapB !== mb.marketCapB) {
        const bigA = ma.marketCapB > mb.marketCapB;
        sizeBit = `<strong>${esc(bigA ? a : b)}</strong> is the larger company (${fmtB(Math.max(ma.marketCapB, mb.marketCapB))} vs ${fmtB(Math.min(ma.marketCapB, mb.marketCapB))})`;
    }
    const vSent = [];
    if (sizeBit) vSent.push(sizeBit + '.');
    if (vbits.length) vSent.push('On the fundamentals, ' + vbits.join('; ') + '.');
    if (perfA.r5 != null && perfB.r5 != null && perfA.r5 !== perfB.r5) {
        const aWins = perfA.r5 > perfB.r5;
        vSent.push(`Over the last five years, <strong>${esc(aWins ? a : b)}</strong> returned ${fmtP(aWins ? perfA.r5 : perfB.r5)} vs ${fmtP(aWins ? perfB.r5 : perfA.r5)}.`);
    }
    // Red-flag tally per side — the "what could hurt me" signal no free numbers
    // table surfaces. Computed from each company's filed statements.
    const rfa = aiChat.redFlagsFor(a), rfb = aiChat.redFlagsFor(b);
    const fa = rfa ? rfa.flagCount : null, fb = rfb ? rfb.flagCount : null;
    if (fa !== null && fb !== null) {
        if (fa !== fb) vSent.push(`On the filings, <strong>${esc(fa < fb ? a : b)}</strong> carries fewer potential red flags (${Math.min(fa, fb)} vs ${Math.max(fa, fb)}).`);
        else if (fa === 0) vSent.push('Neither shows an obvious red flag in the filings.');
        else vSent.push(`Both carry ${fa} potential red flag${fa > 1 ? 's' : ''} in the filings.`);
    }
    const verdictHtml = vSent.length
        ? `<div style="border:1px solid var(--line);border-radius:10px;background:var(--surface);padding:14px 16px;margin:8px 0 4px;font-size:14.5px;line-height:1.65;color:var(--ink)">${vSent.join(' ')} <span style="color:var(--ink3)">Full numbers below — the stronger figure on each row is in <span style="color:var(--pos);font-weight:650">green</span>.</span></div>`
        : '';

    // ---- related comparisons + ticker-swap (keep them in the format that converts) ----
    const peersOf = (m) => (m && m.sector && m.marketCapB != null)
        ? aiChat.screenRows({ sector: m.sector, sort_by: 'marketCapB', limit: 300, maxLimit: 300 }).rows
            .filter((r) => r.symbol && /^[A-Z0-9.]+$/.test(r.symbol) && r.symbol !== a && r.symbol !== b && r.marketCapB != null)
            .sort((x, y) => Math.abs(x.marketCapB - m.marketCapB) - Math.abs(y.marketCapB - m.marketCapB))
        : [];
    const peersA = peersOf(ma), peersB = peersOf(mb);
    const relSeen = new Set([`${a}-vs-${b}`]);
    const related = [];
    for (let i = 0; i < 4; i++) {
        for (const [sym, peers] of [[a, peersA], [b, peersB]]) {
            const p = peers[i]; if (!p) continue;
            const [x, y] = [sym, p.symbol].sort();
            const slug = `${x}-vs-${y}`;
            if (relSeen.has(slug)) continue;
            relSeen.add(slug);
            related.push(slug);
        }
    }
    const relatedHtml = related.slice(0, 8)
        .map((slug) => `<a href="/compare/${esc(slug)}">${esc(slug.replace('-vs-', ' vs '))}</a>`).join('');
    const dlSyms = [];
    for (let i = 0; i < 12; i++) for (const peers of [peersA, peersB]) { const p = peers[i]; if (p && !dlSyms.includes(p.symbol)) dlSyms.push(p.symbol); }
    const swapHtml = related.length ? `
  <div class="seo-section" style="margin:22px 0">
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;border:1px solid var(--line);border-radius:10px;background:var(--surface);padding:12px 14px">
      <span style="font-size:13.5px;color:var(--ink2);font-weight:600">Compare with another company:</span>
      <div style="position:relative;flex:1;min-width:150px"><input id="cmpAdd" autocomplete="off" aria-autocomplete="list" aria-controls="cmpMatches" placeholder="company or ticker, e.g. ${esc(dlSyms[0] || 'MSFT')}" style="width:100%;min-height:44px;padding:0 12px;border:1px solid var(--line);border-radius:8px;font-size:16px;background:var(--paper);color:var(--ink)"><div id="cmpMatches" role="listbox" hidden style="position:absolute;z-index:20;left:0;right:0;top:calc(100% + 4px);max-height:290px;overflow:auto;border:1px solid var(--line);border-radius:9px;background:var(--surface);box-shadow:0 10px 28px rgba(0,0,0,.12)"></div></div>
      <button type="button" onclick="cmpGo('${esc(a)}')" style="min-height:44px;padding:0 16px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink);font-size:14px;font-weight:600;cursor:pointer">vs ${esc(a)}</button>
      <button type="button" onclick="cmpGo('${esc(b)}')" style="min-height:44px;padding:0 16px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink);font-size:14px;font-weight:600;cursor:pointer">vs ${esc(b)}</button>
    </div>
  </div>
  <script>
  ${CMP_EXTRACT_SYM}
  ${CMP_AUTOCOMPLETE}
  cmpWireAutocomplete('cmpAdd','cmpMatches');
  function cmpGo(base){var el=document.getElementById('cmpAdd');var v=cmpExtractSym(el.value);if(!v||v===base)return;var p=[base,v].sort();location.href='/compare/'+p[0]+'-vs-'+p[1];}
  document.getElementById('cmpAdd').addEventListener('keydown',function(e){if(e.key==='Enter'&&!e.defaultPrevented){e.preventDefault();cmpGo('${esc(a)}');}});
  </script>` : '';

    // ---- contextual screens, picked from where these two are strong ----
    const scr = [];
    const add = (k, l) => scr.push(`<a href="/screens/${k}">${esc(l)} &rarr;</a>`);
    const ge = (v, t) => v != null && v >= t;
    if (ge(ma.revCagr5Pct, 15) || ge(mb.revCagr5Pct, 15)) add('high-growth-stocks', 'Fastest-growing stocks');
    if (ge(ma.netMarginPct, 20) || ge(mb.netMarginPct, 20)) add('most-profitable-stocks', 'Most profitable stocks');
    if (ge(ma.roePct, 15) || ge(mb.roePct, 15)) add('quality-compounders', 'Quality compounders');
    if ((ma.pe != null && ma.pe > 0 && ma.pe <= 15) || (mb.pe != null && mb.pe > 0 && mb.pe <= 15)) add('low-pe-stocks', 'Low P/E value stocks');
    if (ge(ma.divYieldPct, 2) || ge(mb.divYieldPct, 2)) add('dividend-stocks', 'Best dividend stocks');
    if (!scr.length) { add('quality-compounders', 'Quality compounders'); add('high-growth-stocks', 'Fastest-growing stocks'); }
    const screensHtml = scr.slice(0, 4).join('');

    // ---- AI Verdict — grounded head-to-head, generated on click (gated trial) ----
    const pair = `${a}-vs-${b}`;
    const verdictAi = `
  <div class="seo-section" id="aiv" style="border:1px solid var(--line);border-radius:12px;background:var(--surface);padding:16px 18px;margin:14px 0 4px">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px;flex-wrap:wrap">
      <div style="flex:1;min-width:220px">
        <h2 style="margin:0;font-size:16px;line-height:1.3">AI verdict — ${esc(a)} vs ${esc(b)}, read from the filings</h2>
        <p style="margin:5px 0 0;font-size:12.5px;color:var(--ink2);line-height:1.55;max-width:72ch">The stronger business, the cheaper stock, and the risks &mdash; synthesised from both companies&rsquo; SEC filings, every figure computed not guessed. Not investment advice.</p>
      </div>
      <button type="button" id="aivbtn" style="min-height:42px;padding:0 18px;border:0;border-radius:9px;background:var(--accent);color:#fff;font-size:14px;font-weight:650;cursor:pointer;white-space:nowrap">Generate the verdict &rarr;</button>
    </div>
    <div id="aivout"></div>
  </div>
  <script>
  (function(){
    var btn=document.getElementById('aivbtn'),out=document.getElementById('aivout');
    if(!btn)return;
    btn.addEventListener('click',function(){
      btn.disabled=true;var orig=btn.textContent;btn.textContent='Reading the filings…';
      out.style.marginTop='14px';
      out.innerHTML='<p style="font-size:13.5px;color:var(--ink3);margin:0">Computing the head-to-head from both companies&rsquo; filings…</p>';
      var tok=null;try{tok=localStorage.getItem('token');}catch(e){}
      fetch('/api/compare/${esc(pair)}/verdict',{headers:tok?{Authorization:'Bearer '+tok}:{}}).then(function(r){
        return r.json().then(function(j){return {status:r.status,j:j};});
      }).then(function(res){
        if(res.status===429){
          out.innerHTML='<div style="border:1px solid var(--line);border-radius:10px;padding:14px 16px;background:var(--paper)"><p style="margin:0 0 12px;font-size:14px;color:var(--ink)">'+(res.j.message||'Free limit reached for today.')+'</p><a class="seo-cta-btn" href="/register.html">Create a free account &rarr;</a></div>';
          btn.style.display='none';return;
        }
        if(res.status!==200||!res.j.verdict){
          out.innerHTML='<p style="font-size:13.5px;color:var(--ink3);margin:0">Could not generate the verdict right now &mdash; please try again in a moment.</p>';
          btn.disabled=false;btn.textContent='Try again';return;
        }
        var safe=res.j.verdict.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        out.innerHTML='<div style="white-space:pre-wrap;font-size:14.5px;line-height:1.7;color:var(--ink)">'+safe+'</div><p style="margin:10px 0 0;font-size:11.5px;color:var(--ink3)">Computed from SEC-filed statements; the model writes the synthesis, never the numbers. Not investment advice.</p><div style="display:flex;gap:7px;align-items:center;margin-top:10px"><span style="font-size:11.5px;color:var(--ink3)">Share</span><button type="button" id="aivx" class="seo-cta-btn" style="cursor:pointer">X / Twitter</button><button type="button" id="aivcopy" class="seo-cta-btn" style="cursor:pointer">Copy</button></div>';
        var excerpt=res.j.verdict.replace(/\\s+/g,' ').slice(0,220),shareTitle='${esc(a)} vs ${esc(b)} AI verdict';
        document.getElementById('aivx').onclick=function(){window.open('https://twitter.com/intent/tweet?text='+encodeURIComponent(shareTitle+'\\n\\n'+excerpt)+'&url='+encodeURIComponent(location.href),'_blank','noopener,noreferrer,width=720,height=520');};
        document.getElementById('aivcopy').onclick=function(){var text=shareTitle+'\\n\\n'+res.j.verdict+'\\n\\n'+location.href;navigator.clipboard?navigator.clipboard.writeText(text):window.prompt('Copy this verdict',text);this.textContent='Copied';};
        btn.style.display='none';
      }).catch(function(e){
        out.innerHTML='<p style="font-size:13.5px;color:var(--ink3);margin:0">Something went wrong &mdash; please try again.</p>';
        btn.disabled=false;btn.textContent=orig;
      });
    });
  })();
  </script>`;

    return {
        a, b, ma, mb, da, db, inca, incb, inca1, incb1, bala, balb, casha, cashb,
        perfA, perfB, rangeA, rangeB, listedA, listedB, fmtRet, rangeFmt, fmtB, fmtP, peFmt, yesNo,
        hi, loPos, boolWin, winCell, canonical, title, description, jsonld,
        faqs, faqHtml, verdictHtml, rfa, rfb, relatedHtml, swapHtml, screensHtml, pair, verdictAi,
        trs, perfHtml
    };
}

// The free / SEO surface of the pair page: byte-for-byte the markup that ships
// today. Paid subscribers see renderComparePagePro instead (via ?sp=2).
function renderComparePage(pairSlug) {
    const d = compareData(pairSlug);
    if (!d || d.redirect) return d;
    // This pair is about to render with real metrics on both sides. If it came
    // from outside comparePairs(), the sitemap would never learn it existed.
    noteDiscoveredCompare(d.a, d.b);
    const { a, b, ma, mb, canonical, title, description, jsonld, verdictHtml, verdictAi, trs, perfHtml, swapHtml, relatedHtml, faqHtml, screensHtml } = d;
    return { html: head(title, description, canonical, jsonld) + nav('compare') + `
<main class="seo-wrap">
  <style>@media (max-width:560px){.cmp-table{table-layout:fixed;width:100%}.cmp-table th,.cmp-table td{padding:8px 7px;font-size:12.5px;white-space:normal;overflow-wrap:anywhere;word-break:break-word}.cmp-table th:first-child,.cmp-table td:first-child{width:40%}.cmp-table th:nth-child(n+2),.cmp-table td:nth-child(n+2){width:30%}}</style>
  <div class="seo-crumbs"><a href="/stocks">Stocks</a> / ${esc(a)} vs ${esc(b)}</div>
  <h1 class="seo-h1">${esc(ma.name)} (${esc(a)}) vs ${esc(mb.name)} (${esc(b)})</h1>
  <p class="seo-sub">${esc(ma.name)} and ${esc(mb.name)} side by side — fundamentals from SEC filings, refreshed nightly. Sector: ${esc(ma.sector)}${ma.sector !== mb.sector ? ` / ${esc(mb.sector)}` : ''}.</p>
  ${verdictHtml}
  ${verdictAi}
  <div class="seo-section">
    <div style="overflow-x:auto"><table class="seo-table cmp-table">
      <thead><tr><th>&nbsp;</th><th><a href="/stocks/${esc(a)}">${esc(ma.name)} (${esc(a)})</a></th><th><a href="/stocks/${esc(b)}">${esc(mb.name)} (${esc(b)})</a></th></tr></thead>
      <tbody>${trs}</tbody>
    </table></div>
  </div>
  ${perfHtml}
  <div class="seo-section"><h2>Verify the comparison</h2><div class="seo-links"><a href="/tools/earnings-quality">Check earnings versus cash flow &rarr;</a><a href="/tools/dilution">Compare filed share counts &rarr;</a><a href="/tools/filing-timeline">Open the latest SEC filing timeline &rarr;</a><a href="/tools/company-comparison">Run another company comparison &rarr;</a></div><p style="margin-top:10px;font-size:13px;color:var(--ink3)">Use the filing period and source shown by each tool before treating two figures as comparable.</p></div>
  ${swapHtml}
  <div class="seo-lock">
    <h3>See the full ${esc(a)} vs ${esc(b)} breakdown</h3>
    <p>Both companies across 19 years of income statement, balance sheet and cash flow — with ratios, health checks and Ask, the SEC-grounded research assistant. Free, no account needed.</p>
    <a class="seo-cta-btn" href="/company?symbol=${esc(a)}">Open ${esc(a)}'s full financials &rarr;</a>
    &nbsp; <a class="seo-cta-btn" href="/company?symbol=${esc(b)}">Open ${esc(b)}'s full financials &rarr;</a>
  </div>
  ${relatedHtml ? `<div class="seo-section"><h2>More comparisons</h2><div class="seo-links">${relatedHtml}</div></div>` : ''}
  <div class="seo-section"><h2>Frequently asked questions</h2>${faqHtml}</div>
  <div class="seo-section"><h2>Keep exploring</h2>
    <div class="seo-links">${screensHtml}</div>
    <p style="margin-top:10px"><a href="/stocks/${esc(a)}">${esc(a)} fundamentals &rarr;</a> &middot; <a href="/stocks/${esc(b)}">${esc(b)} fundamentals &rarr;</a> &middot; <a href="/stocks">All 1,500+ companies &rarr;</a> &middot; <a href="/screener">Free screener &rarr;</a></p>
  </div>
</main>
<script>
(function(){
  var k='sp2up';
  // Consume the one-shot flag on the ?sp=2 load itself, not on the next free
  // visit — otherwise the visit right after an upgrade does nothing.
  if(/(^|[?&])sp=2/.test(location.search)){try{sessionStorage.removeItem(k);}catch(e){}return;}
  try{if(sessionStorage.getItem(k)){sessionStorage.removeItem(k);return;}}catch(e){}
  // The app's auth is cookie-based (HttpOnly sp_auth + sp_logged_in marker);
  // login never stores a localStorage token. Gate on the marker cookie, and
  // let the same-origin fetch carry sp_auth to /api/session.
  if(!/(?:^|;\s*)sp_logged_in=1(?:;|$)/.test(document.cookie||''))return;
  fetch('/api/session').then(function(r){return r.ok?r.json():null;}).then(function(j){
    var t=j&&j.tier;
    if(t==='core'||t==='pro'){try{sessionStorage.setItem(k,'1');}catch(e){}location.replace(location.pathname+'?sp=2');}
  }).catch(function(){});
})();
</script>` + footer() };
}

// ---- the paid variant: the full expanded head-to-head ----
// Grouped ratio table (performance merged in), a red-flags section, a dark
// AI-verdict hero, and no em-dashes in the prose. Same head/nav/FAQ skeleton
// as the free page; reached only through /compare/PAIR?sp=2 by paying
// subscribers, and always sent Cache-Control: private so it never enters the
// shared SSR cache or a browser/CDN cache.
function renderComparePagePro(pairSlug) {
    const d = compareData(pairSlug);
    if (!d || d.redirect) return d;
    const { a, b, ma, mb, da, db, inca, inca1, incb, incb1, bala, balb, casha, cashb,
        perfA, perfB, rangeA, rangeB, listedA, listedB, fmtRet, fmtB, fmtP, peFmt, yesNo, hi, loPos, boolWin, winCell,
        canonical, title, description, jsonld, faqs, verdictHtml, rfa, rfb, relatedHtml, swapHtml, screensHtml, pair } = d;

    const xFmt = (v) => (v === null || v === undefined) ? '—' : `${v.toFixed(2)}×`;
    const rangeFmtP = (r) => (r.high != null && r.low != null) ? `$${r.low.toFixed(2)}–$${r.high.toFixed(2)}` : '—';
    const pctOf = (n, dn) => (n != null && dn != null && dn !== 0) ? (n / dn) * 100 : null;
    const yoy = (cur, prev) => (cur != null && prev != null && prev > 0) ? ((cur / prev) - 1) * 100 : null;
    const shOut = (d2, i) => num((((d2.balance || {}).annualReports || [])[i] || {}).commonStockSharesOutstanding);
    const shares5y = (d2) => yoy(shOut(d2, 0), shOut(d2, 4));
    const debtOf = (bl) => totalDebtOf(bl);
    const cashOf = (bl) => { const c = num(bl.cashAndCashEquivalentsAtCarryingValue); return c !== null ? c : num(bl.cashAndShortTermInvestments); };
    const deOf = (bl) => { const eq = num(bl.totalShareholderEquity), dt = totalDebtOf(bl); return (eq !== null && eq > 0 && dt !== null) ? dt / eq : null; };
    const fcfMargin = (m, rev) => (m.fcfAbs != null && rev != null && rev > 0) ? ((m.fcfPositive ? m.fcfAbs : -m.fcfAbs) / rev) * 100 : null;
    const payoutOf = (csh, inc) => {
        const dv = num(csh.dividendPayoutCommonStock) !== null ? num(csh.dividendPayoutCommonStock) : num(csh.dividendPayout);
        const ni = num(inc.netIncome);
        return (dv !== null && ni !== null && ni > 0) ? (Math.abs(dv) / ni) * 100 : null;
    };

    // One side's expanded-table values, formatted strings plus the raw numbers
    // the winner logic needs.
    const sideOf = (m, d2, inc, inc1, bal, csh, rf) => {
        const rev = num(inc.totalRevenue), gp = grossProfitOf(inc), op = num(inc.operatingIncome),
            ni = num(inc.netIncome), rev1 = num(inc1.totalRevenue);
        // EBITDA as filed, else derived: operating income + the same FY's filed
        // D&A (positive add-back). Missing stays missing — never a guess.
        let eb = num(inc.ebitda);
        if (eb === null && op !== null) {
            const dna = num(csh.depreciationDepletionAndAmortization);
            if (dna !== null && dna > 0) eb = op + dna;
        }
        const ndE = (() => {
            const dt = totalDebtOf(bal), cshv = cashOf(bal);
            return (eb !== null && eb > 0 && dt !== null && cshv !== null) ? (dt - cshv) / eb : null;
        })();
        return {
            cap: { v: m.marketCapB, f: fmtB(m.marketCapB) },
            rev: { v: rev, f: money(rev) },
            gp: { v: gp, f: money(gp) },
            op: { v: op, f: money(op) },
            ni: { v: ni, f: money(ni) },
            eb: { v: eb, f: money(eb) },
            eps: { v: num(inc.dilutedEPS), f: (v => v === null ? '—' : `$${v.toFixed(2)}`)(num(inc.dilutedEPS)) },
            revYoY: { v: yoy(rev, rev1), f: fmtP(yoy(rev, rev1)) },
            revCagr: { v: m.revCagr5Pct, f: fmtP(m.revCagr5Pct) },
            qtrYoY: { v: m.qtrNetIncomeYoYPct, f: fmtP(m.qtrNetIncomeYoYPct) },
            sh5y: { v: shares5y(d2), f: fmtP(shares5y(d2)) },
            gm: { v: pctOf(gp, rev), f: fmtP(pctOf(gp, rev)) },
            om: { v: pctOf(op, rev), f: fmtP(pctOf(op, rev)) },
            nm: { v: m.netMarginPct, f: fmtP(m.netMarginPct) },
            em: { v: pctOf(eb, rev), f: fmtP(pctOf(eb, rev)) },
            roe: { v: m.roePct, f: fmtP(m.roePct) },
            prof: { v: m.profitableYears10, f: (m.profitableYears10 == null ? '—' : String(m.profitableYears10)) },
            fcf: { v: m.fcfPositive, f: yesNo(m.fcfPositive) },
            fcfm: { v: fcfMargin(m, rev), f: fmtP(fcfMargin(m, rev)) },
            flags: { v: rf ? rf.flagCount : null, f: (rf && rf.flagCount != null) ? String(rf.flagCount) : '—' },
            de: { v: deOf(bal), f: xFmt(deOf(bal)) },
            ndE: { v: ndE, f: xFmt(ndE) },
            pe: { v: m.pe, f: peFmt(m.pe) },
            peg: { v: m.pegRatio, f: peFmt(m.pegRatio) },
            pb: { v: m.priceToBook, f: peFmt(m.priceToBook) },
            dy: { v: m.divYieldPct, f: fmtP(m.divYieldPct) },
            payout: { v: payoutOf(csh, inc), f: fmtP(payoutOf(csh, inc)) }
        };
    };
    const sa = sideOf(ma, da, inca, inca1, bala, casha, rfa);
    const sb = sideOf(mb, db, incb, incb1, balb, cashb, rfb);
    const wA = (x) => hi(sa[x].v, sb[x].v);
    const wL = (x) => loPos(sa[x].v, sb[x].v);
    const fa = rfa ? rfa.flagCount : null, fb = rfb ? rfb.flagCount : null;
    const flagWin = (fa !== null && fb !== null && fa !== fb) ? (fa < fb ? 0 : 1) : -1;

    const rowsPro = [
        { g: 'Size and latest FY' },
        { l: 'Market cap', a: sa.cap.f, b: sb.cap.f, w: -1 },
        { l: 'Revenue (latest FY)', a: sa.rev.f, b: sb.rev.f, w: -1 },
        { l: 'Gross profit', a: sa.gp.f, b: sb.gp.f, w: -1 },
        { l: 'Operating income', a: sa.op.f, b: sb.op.f, w: -1 },
        { l: 'Net income', a: sa.ni.f, b: sb.ni.f, w: -1 },
        { l: 'EBITDA', a: sa.eb.f, b: sb.eb.f, w: -1 },
        { l: 'EPS (diluted)', a: sa.eps.f, b: sb.eps.f, w: -1 },
        { g: 'Growth' },
        { l: 'Revenue growth (latest FY)', a: sa.revYoY.f, b: sb.revYoY.f, w: wA('revYoY') },
        { l: 'Revenue growth (5y CAGR)', a: sa.revCagr.f, b: sb.revCagr.f, w: wA('revCagr') },
        { l: 'Latest-quarter earnings YoY', a: sa.qtrYoY.f, b: sb.qtrYoY.f, w: wA('qtrYoY') },
        { l: 'Share count (5y change)', a: sa.sh5y.f, b: sb.sh5y.f, w: wL('sh5y') },
        { g: 'Margins' },
        { l: 'Gross margin', a: sa.gm.f, b: sb.gm.f, w: wA('gm') },
        { l: 'Operating margin', a: sa.om.f, b: sb.om.f, w: wA('om') },
        { l: 'Net margin', a: sa.nm.f, b: sb.nm.f, w: wA('nm') },
        { l: 'EBITDA margin', a: sa.em.f, b: sb.em.f, w: wA('em') },
        { g: 'Returns and quality' },
        { l: 'Return on equity', a: sa.roe.f, b: sb.roe.f, w: wA('roe') },
        { l: 'Profitable years (of last 10)', a: sa.prof.f, b: sb.prof.f, w: wA('prof') },
        { l: 'Positive free cash flow', a: sa.fcf.f, b: sb.fcf.f, w: boolWin(sa.fcf.v, sb.fcf.v) },
        { l: 'FCF margin', a: sa.fcfm.f, b: sb.fcfm.f, w: wA('fcfm') },
        { l: 'Red flags in filings', a: sa.flags.f, b: sb.flags.f, w: flagWin },
        { g: 'Balance sheet (ratios)' },
        { l: 'Debt to equity', a: sa.de.f, b: sb.de.f, w: wL('de') },
        { l: 'Net debt to EBITDA', a: sa.ndE.f, b: sb.ndE.f, w: wL('ndE') },
        { g: 'Valuation and dividends' },
        { l: 'P/E ratio', a: sa.pe.f, b: sb.pe.f, w: wL('pe') },
        { l: 'PEG ratio', a: sa.peg.f, b: sb.peg.f, w: wL('peg') },
        { l: 'Price to book', a: sa.pb.f, b: sb.pb.f, w: wL('pb') },
        { l: 'Dividend yield', a: sa.dy.f, b: sb.dy.f, w: wA('dy') },
        { l: 'Payout ratio', a: sa.payout.f, b: sb.payout.f, w: -1 },
        { g: 'Performance' },
        { l: '1-year return', a: fmtRet(perfA.r1, listedA), b: fmtRet(perfB.r1, listedB), w: hi(perfA.r1, perfB.r1) },
        { l: '3-year return', a: fmtRet(perfA.r3, listedA), b: fmtRet(perfB.r3, listedB), w: hi(perfA.r3, perfB.r3) },
        { l: '5-year return', a: fmtRet(perfA.r5, listedA), b: fmtRet(perfB.r5, listedB), w: hi(perfA.r5, perfB.r5) },
        { l: '10-year return', a: fmtRet(perfA.r10, listedA), b: fmtRet(perfB.r10, listedB), w: hi(perfA.r10, perfB.r10) },
        { l: '52-week range', a: rangeFmtP(rangeA), b: rangeFmtP(rangeB), w: -1 }
    ];
    // Collapsible groups: one tbody per group; the first ("Size and latest FY")
    // starts open, the rest collapsed. Clicking the group row toggles it.
    const groupsPro = [];
    rowsPro.forEach((r) => {
        if (r.g) groupsPro.push({ title: r.g, rows: [] });
        else groupsPro[groupsPro.length - 1].rows.push(r);
    });
    const proTrs = groupsPro.map((g, gi) => {
        const open = gi === 0;
        // Collapsed groups keep their FIRST metric row visible as a teaser;
        // expanding reveals the rest.
        const body = g.rows.map((r, ri) =>
            `<tr${gi > 0 && ri === 0 ? ' class="cmp-prev"' : ''}><td>${esc(r.l)}</td>` +
            `<td${r.w === 0 ? ` style="${winCell}"` : ''}>${esc(r.a)}</td>` +
            `<td${r.w === 1 ? ` style="${winCell}"` : ''}>${esc(r.b)}</td></tr>`).join('');
        return `<tbody class="cmp-sec${open ? ' cmp-open' : ''}">` +
            `<tr class="cmp-grp" role="button" tabindex="0" aria-expanded="${open}" aria-label="${esc(g.title)}: toggle section"><td colspan="3">${esc(g.title)}<span class="cmp-n">${g.rows.length} metrics</span></td></tr>` +
            body + `</tbody>`;
    }).join('');

    // ---- red flags, spelled out per company (counts alone hide the detail) ----
    const flagCard = (sym, name, rf) => {
        const items = (rf && Array.isArray(rf.flags) ? rf.flags : []).slice(0, 6).map((f) =>
            `<li style="margin:0 0 9px"><span style="font-weight:650">${esc(dedash(f.title))}</span> <span style="font-size:11.5px;color:var(--ink3)">(${esc(f.severity)})</span><br><span style="font-size:13px;color:var(--ink2)">${esc(dedash(f.detail))}</span></li>`).join('');
        const empty = !rf
            ? 'No filed history to scan yet.'
            : (rf.flagCount === 0 ? 'No red flags found in the filed statements.' : dedash(rf.source || ''));
        return `<div style="border:1px solid var(--line);border-radius:10px;background:var(--surface);padding:14px 16px">
      <h3 style="margin:0 0 8px;font-size:14.5px">${esc(name)} (${esc(sym)})</h3>
      ${items ? `<ul style="margin:0;padding-left:18px;font-size:13.5px;line-height:1.5">${items}</ul>` : `<p style="margin:0;font-size:13.5px;color:var(--ink3)">${esc(empty)}</p>`}
    </div>`;
    };
    const flagsHtml = `
  <div class="seo-section">
    <h2>Red flags in the filings</h2>
    <p style="margin:0 0 10px;font-size:13.5px;color:var(--ink2)">Computed from each company's filed statements: every flag cites the numbers behind it. A flag is a question to check, not a verdict.</p>
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:12px">${flagCard(a, ma.name, rfa)}${flagCard(b, mb.name, rfb)}</div>
  </div>`;

    // ---- dark-hero AI verdict: same endpoint, same gating, same behavior ----
    const verdictAiPro = `
  <div id="aiv" style="border-radius:14px;background:var(--ink);color:var(--paper);padding:20px 20px 18px;margin:14px 0 4px">
    <div style="font-size:11px;font-weight:700;letter-spacing:.16em;color:rgba(250,249,246,.62)">AI VERDICT</div>
    <h2 style="margin:6px 0 0;font-size:19px;line-height:1.3;color:var(--paper)">Is ${esc(a)} or ${esc(b)} the stronger business?</h2>
    <p style="margin:8px 0 14px;font-size:13px;line-height:1.6;color:rgba(250,249,246,.75);max-width:72ch">The stronger business, the cheaper stock, and the risks: synthesised from both companies&rsquo; SEC filings, every figure computed not guessed. Not investment advice.</p>
    <button type="button" id="aivbtn" style="min-height:46px;padding:0 22px;border:0;border-radius:10px;background:var(--accent);color:#fff;font-size:14.5px;font-weight:650;cursor:pointer;white-space:nowrap">Generate the verdict &rarr;</button>
    <div id="aivout"></div>
  </div>
  <script>
  (function(){
    var btn=document.getElementById('aivbtn'),out=document.getElementById('aivout');
    if(!btn)return;
    btn.addEventListener('click',function(){
      btn.disabled=true;var orig=btn.textContent;btn.textContent='Reading the filings…';
      out.style.marginTop='14px';
      out.innerHTML='<p style="font-size:13px;color:rgba(250,249,246,.7);margin:0">Computing the head-to-head from both companies&rsquo; filings…</p>';
      var tok=null;try{tok=localStorage.getItem('token');}catch(e){}
      fetch('/api/compare/${esc(pair)}/verdict',{headers:tok?{Authorization:'Bearer '+tok}:{}}).then(function(r){
        return r.json().then(function(j){return {status:r.status,j:j};});
      }).then(function(res){
        if(res.status===429){
          out.innerHTML='<div style="border:1px solid rgba(250,249,246,.28);border-radius:10px;padding:14px 16px;margin-top:14px;background:rgba(250,249,246,.06)"><p style="margin:0 0 12px;font-size:14px;color:var(--paper)">'+(res.j.message||'Free limit reached for today.')+'</p><a class="seo-cta-btn" href="/register.html">Create a free account &rarr;</a></div>';
          btn.style.display='none';return;
        }
        if(res.status!==200||!res.j.verdict){
          out.innerHTML='<p style="font-size:13px;color:rgba(250,249,246,.7);margin:14px 0 0">Could not generate the verdict right now. Please try again in a moment.</p>';
          btn.disabled=false;btn.textContent='Try again';return;
        }
        var safe=res.j.verdict.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
        out.innerHTML='<div style="background:var(--surface);border-radius:10px;padding:14px 16px;margin-top:14px"><div style="font-size:11px;font-weight:700;letter-spacing:.12em;color:var(--ink3)">VERDICT</div><div style="white-space:pre-wrap;font-size:14.5px;line-height:1.7;color:var(--ink);margin-top:6px">'+safe+'</div><p style="margin:10px 0 0;font-size:11.5px;color:var(--ink3)">Computed from SEC-filed statements; the model writes the synthesis, never the numbers. Not investment advice.</p></div><div style="display:flex;gap:7px;align-items:center;margin-top:10px"><span style="font-size:11.5px;color:rgba(250,249,246,.65)">Share</span><button type="button" id="aivx" class="seo-cta-btn" style="cursor:pointer">X / Twitter</button><button type="button" id="aivcopy" class="seo-cta-btn" style="cursor:pointer">Copy</button></div>';
        var excerpt=res.j.verdict.replace(/\\s+/g,' ').slice(0,220),shareTitle='${esc(a)} vs ${esc(b)} AI verdict';
        document.getElementById('aivx').onclick=function(){window.open('https://twitter.com/intent/tweet?text='+encodeURIComponent(shareTitle+'\\n\\n'+excerpt)+'&url='+encodeURIComponent(location.href),'_blank','noopener,noreferrer,width=720,height=520');};
        document.getElementById('aivcopy').onclick=function(){var text=shareTitle+'\\n\\n'+res.j.verdict+'\\n\\n'+location.href;navigator.clipboard?navigator.clipboard.writeText(text):window.prompt('Copy this verdict',text);this.textContent='Copied';};
        btn.style.display='none';
      }).catch(function(e){
        out.innerHTML='<p style="font-size:13px;color:rgba(250,249,246,.7);margin:14px 0 0">Something went wrong. Please try again.</p>';
        btn.disabled=false;btn.textContent=orig;
      });
    });
  })();
  </script>`;

    // Em-dash-free FAQ text for the paid page; the free page keeps its copy.
    const proFaqHtml = faqs.map((f) =>
        `<h3 style="font-size:15.5px;margin:18px 0 6px">${esc(f.q)}</h3><p style="margin:0;font-size:14px;line-height:1.7;max-width:74ch">${esc(dedash(f.a))}</p>`).join('');
    const proJsonld = dedash(jsonld);

    return { html: head(title, description, canonical, proJsonld).replace('</title>', '</title><meta name="robots" content="noindex">') + nav('compare') + `
<main class="seo-wrap">
  <style>@media (max-width:560px){.cmp-table{table-layout:fixed;width:100%}.cmp-table th,.cmp-table td{padding:8px 7px;font-size:12.5px;white-space:normal;overflow-wrap:anywhere;word-break:break-word}.cmp-table th:first-child,.cmp-table td:first-child{width:40%}.cmp-table th:nth-child(n+2),.cmp-table td:nth-child(n+2){width:30%}}.cmp-grp td{padding:14px 7px 6px;font-size:10.5px;font-weight:700;letter-spacing:.09em;text-transform:uppercase;color:var(--ink3);border-top:1px solid var(--line)}.cmp-grp{cursor:pointer;-webkit-user-select:none;user-select:none}.cmp-grp:focus-visible td{outline:2px solid var(--accent);outline-offset:-2px}.cmp-grp td::before{content:'▾ ';color:var(--ink3)}.cmp-sec:not(.cmp-open) .cmp-grp td::before{content:'▸ '}.cmp-sec:not(.cmp-open) tr:not(.cmp-grp):not(.cmp-prev){display:none}.cmp-n{float:right;font-weight:600;letter-spacing:.02em;text-transform:none;color:var(--ink3)}@keyframes aivpulse{0%,100%{box-shadow:0 0 0 0 rgba(26,79,214,.40)}55%{box-shadow:0 0 0 9px rgba(26,79,214,0)}}#aivbtn{animation:aivpulse 2.4s infinite}</style>
  <div class="seo-crumbs"><a href="/stocks">Stocks</a> / ${esc(a)} vs ${esc(b)}</div>
  <h1 class="seo-h1">${esc(ma.name)} (${esc(a)}) vs ${esc(mb.name)} (${esc(b)})</h1>
  <p class="seo-sub">${esc(ma.name)} and ${esc(mb.name)} side by side: fundamentals from SEC filings, refreshed nightly. Sector: ${esc(ma.sector)}${ma.sector !== mb.sector ? ` / ${esc(mb.sector)}` : ''}.</p>
  ${dedash(verdictHtml)}
  ${verdictAiPro}
  <div class="seo-section">
    <h2>The full numbers, head to head</h2>
    <p style="margin:0 0 10px;font-size:13.5px;color:var(--ink2)">Every figure is computed from SEC-filed statements, refreshed nightly. Returns are total returns from monthly split- and dividend-adjusted closes; past performance is not a prediction. The stronger figure on each row is in <span style="color:var(--pos);font-weight:650">green</span>; raw size rows stay untinted because bigger is not automatically better.</p>
    <div style="overflow-x:auto"><table class="seo-table cmp-table">
      <thead><tr><th>&nbsp;</th><th><a href="/stocks/${esc(a)}">${esc(ma.name)} (${esc(a)})</a></th><th><a href="/stocks/${esc(b)}">${esc(mb.name)} (${esc(b)})</a></th></tr></thead>
      ${proTrs}
    </table></div>
    <script>
    (function(){
      var t=document.querySelector('.cmp-table');if(!t)return;
      Array.prototype.forEach.call(t.querySelectorAll('.cmp-grp'),function(tr){
        var tg=function(){var sec=tr.closest('tbody');if(!sec)return;var open=sec.classList.toggle('cmp-open');tr.setAttribute('aria-expanded',open?'true':'false');};
        tr.addEventListener('click',tg);
        tr.addEventListener('keydown',function(e){if(e.key==='Enter'||e.key===' '){e.preventDefault();tg();}});
      });
    })();
    </script>
  </div>
  ${flagsHtml}
  <div class="seo-section"><h2>Verify the comparison</h2><div class="seo-links"><a href="/tools/earnings-quality">Check earnings versus cash flow &rarr;</a><a href="/tools/dilution">Compare filed share counts &rarr;</a><a href="/tools/filing-timeline">Open the latest SEC filing timeline &rarr;</a><a href="/tools/company-comparison">Run another company comparison &rarr;</a></div><p style="margin-top:10px;font-size:13px;color:var(--ink3)">Use the filing period and source shown by each tool before treating two figures as comparable.</p></div>
  ${swapHtml}
  <div class="seo-lock">
    <h3>See the full ${esc(a)} vs ${esc(b)} breakdown</h3>
    <p>Both companies across 19 years of income statement, balance sheet and cash flow: ratios, health checks and Ask, the SEC-grounded research assistant. Free, no account needed.</p>
    <a class="seo-cta-btn" href="/company?symbol=${esc(a)}">Open ${esc(a)}'s full financials &rarr;</a>
    &nbsp; <a class="seo-cta-btn" href="/company?symbol=${esc(b)}">Open ${esc(b)}'s full financials &rarr;</a>
  </div>
  ${relatedHtml ? `<div class="seo-section"><h2>More comparisons</h2><div class="seo-links">${relatedHtml}</div></div>` : ''}
  <div class="seo-section"><h2>Frequently asked questions</h2>${proFaqHtml}</div>
  <div class="seo-section"><h2>Keep exploring</h2>
    <div class="seo-links">${screensHtml}</div>
    <p style="margin-top:10px"><a href="/stocks/${esc(a)}">${esc(a)} fundamentals &rarr;</a> &middot; <a href="/stocks/${esc(b)}">${esc(b)} fundamentals &rarr;</a> &middot; <a href="/stocks">All 1,500+ companies &rarr;</a> &middot; <a href="/screener">Free screener &rarr;</a></p>
  </div>
</main>` + footer() };
}

// ---------- screener-preset landing pages ----------
const SCREENS = {
    'dividend-stocks': {
        h1: 'Best Dividend Stocks in the US Market',
        intro: 'US companies yielding at least 2.5% that were profitable in at least 8 of the last 10 fiscal years — steady payers, not yield traps.',
        explainer: 'A high dividend yield only matters if the company can keep paying it. This screen starts from yield but requires a real, multi-year record of profitability, so it leans toward durable payers rather than stocks whose yield looks high only because the price has collapsed. Yields move inversely with price, so a name near the top today may rank differently after the next nightly refresh — always check the payout against the underlying earnings before relying on it.',
        args: { min_dividend_yield_pct: 2.5, min_profitable_years_of_last_10: 8, sort_by: 'divYieldPct', limit: 25, maxLimit: 25 },
        cols: ['divYieldPct', 'pe', 'netMarginPct']
    },
    'high-growth-stocks': {
        h1: 'Fastest-Growing Stocks in the US Market',
        intro: 'Companies compounding revenue at 20%+ per year over the last five fiscal years, straight from SEC-filed statements.',
        explainer: 'Revenue growth is the clearest signal that a company is winning customers and taking share. This screen ranks businesses purely on their five-year revenue CAGR computed from filed income statements — no forward analyst estimates — so what you see is what they actually delivered, not what the Street hopes for. Fast top-line growth says nothing on its own about profitability or valuation, so the margin and P/E columns are shown alongside to give the full picture.',
        args: { min_revenue_cagr_5y_pct: 20, sort_by: 'revCagr5Pct', limit: 25, maxLimit: 25 },
        cols: ['revCagr5Pct', 'netMarginPct', 'pe']
    },
    'most-profitable-stocks': {
        h1: 'Most Profitable Stocks in the US Market',
        intro: 'The highest net-margin businesses in the US market — companies that keep 25 cents or more of every revenue dollar.',
        explainer: 'Net margin shows how much of every revenue dollar a company keeps after every cost — operations, interest and tax. Consistently high margins usually point to pricing power, a capital-light model, or a durable competitive moat. This list ranks the US market’s highest-margin businesses from their latest filed income statement; margins vary widely by industry, so it is most useful for comparing companies against their own history and close peers.',
        args: { min_net_margin_pct: 25, sort_by: 'netMarginPct', limit: 25, maxLimit: 25 },
        cols: ['netMarginPct', 'roePct', 'pe']
    },
    'low-pe-stocks': {
        h1: 'Low P/E Value Stocks in the US Market',
        intro: 'Profitable, cash-generating companies trading under 12× earnings — classic value screens, computed from filings.',
        explainer: 'A low price-to-earnings ratio can mean a stock is genuinely cheap — or that the market expects its earnings to fall. To separate value from value-traps, this screen requires positive free cash flow and a multi-year record of profits, then ranks the survivors from the lowest P/E up. That filtering is the whole point: plenty of stocks screen as "low P/E" simply because earnings are about to roll over, and those are exactly the ones this list is built to exclude. A low multiple is a starting question, not an answer.',
        args: { max_pe: 12, require_positive_fcf: true, min_profitable_years_of_last_10: 7, sort_by: 'pe', limit: 25, maxLimit: 25 },
        cols: ['pe', 'divYieldPct', 'netMarginPct']
    },
    'quality-compounders': {
        h1: 'Quality Compounder Stocks in the US Market',
        intro: 'High-return businesses (ROE ≥ 15%) growing revenue ≥ 8%/yr with at least 9 profitable years of the last 10.',
        explainer: 'The rare businesses that combine high returns on equity with steady growth and consistent profits tend to compound shareholder value year after year. This screen demands all three at once — ROE of at least 15%, revenue growth of at least 8% a year, and a near-spotless record of nine profitable years out of the last ten — measured from filed statements, not projections. It deliberately favours proven durability over the fastest-growing or cheapest names.',
        args: { min_roe_pct: 15, min_revenue_cagr_5y_pct: 8, min_profitable_years_of_last_10: 9, sort_by: 'roePct', limit: 25, maxLimit: 25 },
        cols: ['roePct', 'revCagr5Pct', 'netMarginPct']
    },

    // ---- valuation-discovery cluster (captures the low-pe / low-peg / below-book
    // searches the site already ranks page 5-7 for, split into matching URLs) ----
    'low-peg-stocks': {
        h1: 'Low PEG Stocks: Cheap Relative to Their Own Growth',
        intro: 'Profitable, cash-generating US companies trading cheaply against their own growth rate — PEG below 1.5, computed from filings rather than analyst estimates.',
        explainer: 'A low P/E can simply mean a company is shrinking. PEG — the P/E divided by the growth rate — asks the better question: is the stock cheap relative to how fast it is actually growing? Here PEG is computed as trailing P/E ÷ 5-year revenue CAGR, both taken straight from SEC-filed income statements; we deliberately do not use the vendor PEG field, which bakes in forward analyst estimates. To keep the list honest, it requires positive free cash flow, at least 7 profitable years of the last 10, and a P/E under 35, and it excludes the near-zero-base-year growth spikes that make a few names look artificially cheap. A low PEG is a starting question — always check whether the growth is durable before treating it as a value.',
        args: { max_peg: 1.5, max_pe: 35, min_revenue_cagr_5y_pct: 7, max_revenue_cagr_5y_pct: 40, require_positive_fcf: true, min_profitable_years_of_last_10: 7, sort_by: 'pegRatio', limit: 25, maxLimit: 25 },
        cols: ['pegRatio', 'pe', 'revCagr5Pct'],
        related: ['low-pe-stocks', 'stocks-below-book-value', 'undervalued-tech-stocks', 'high-growth-stocks', 'quality-compounders']
    },
    'stocks-below-book-value': {
        h1: 'Stocks Trading Below Book Value in the US Market',
        intro: 'Profitable US companies whose market price sits below the net book value on their own balance sheet — price-to-book under 1, straight from filings.',
        explainer: 'A price-to-book ratio below 1 means the market values the whole company at less than the net assets reported on its balance sheet. That can flag a genuine bargain — or a business the market expects to keep destroying value, which is why a sub-1 P/B is so often a trap. This screen requires positive free cash flow and a multi-year record of profits, and it floors price-to-book at 0.2 to drop the distorted, near-zero-equity cases, then ranks the survivors from the lowest P/B up. Book value is least meaningful for asset-light and heavily-financial businesses, so read each name against what it actually owns before drawing conclusions.',
        args: { min_price_to_book: 0.2, max_price_to_book: 1, require_positive_fcf: true, min_profitable_years_of_last_10: 6, sort_by: 'priceToBook', limit: 25, maxLimit: 25 },
        cols: ['priceToBook', 'pe', 'roePct'],
        related: ['low-pe-stocks', 'low-peg-stocks', 'large-cap-value-stocks', 'undervalued-dividend-stocks']
    },
    'undervalued-tech-stocks': {
        h1: 'Undervalued Technology Stocks in the US Market',
        intro: 'Technology companies trading under 20× earnings with positive free cash flow and a real record of profits — value names in a sector that rarely screens cheap.',
        explainer: 'Most technology coverage chases the fastest growers, so the profitable, cheaply-valued names get overlooked. This screen filters the technology sector to companies trading under 20× earnings that also generate positive free cash flow and have been profitable in at least 6 of the last 10 years, then ranks them from the lowest P/E up — all computed from SEC filings and recomputed nightly. A low multiple in tech can reflect slowing growth or a maturing product, so the revenue-growth and margin columns are shown alongside to separate cheap-and-steady from cheap-and-fading.',
        args: { sector: 'technology', max_pe: 20, require_positive_fcf: true, min_profitable_years_of_last_10: 6, sort_by: 'pe', limit: 25, maxLimit: 25 },
        cols: ['pe', 'revCagr5Pct', 'netMarginPct'],
        related: ['low-pe-stocks', 'high-dividend-tech-stocks', 'low-peg-stocks', 'large-cap-value-stocks']
    },
    'undervalued-dividend-stocks': {
        h1: 'Undervalued Dividend Stocks in the US Market',
        intro: 'Income payers yielding 3%+ that also trade under 18× earnings, with positive free cash flow and 8+ profitable years — value and yield in the same screen.',
        explainer: 'A high yield on an expensive, shaky business is not a bargain. This screen wants both halves of the deal: a dividend yield of at least 3% and a P/E under 18, plus positive free cash flow and at least 8 profitable years of the last 10, so the payout rests on real, repeatable earnings. Names are ranked by yield, with the P/E shown next to it so you can see what you are paying for the income. Yields rise as prices fall, so a stock near the top may be there because the market is worried — always check the payout against the underlying cash flow before relying on it.',
        args: { min_dividend_yield_pct: 3, max_pe: 18, require_positive_fcf: true, min_profitable_years_of_last_10: 8, sort_by: 'divYieldPct', limit: 25, maxLimit: 25 },
        cols: ['divYieldPct', 'pe', 'netMarginPct'],
        related: ['dividend-stocks', 'high-dividend-energy-stocks', 'high-dividend-tech-stocks', 'low-pe-stocks']
    },

    // ---- single-metric superlative leaderboards (niche fundamentals Google does
    // not self-answer; we win on shown numbers + dated, filing-sourced ranking) ----
    'highest-free-cash-flow-stocks': {
        h1: 'Stocks With the Highest Free Cash Flow',
        intro: 'The US companies generating the most free cash flow in absolute dollars — operating cash flow minus capital spending, straight from filed cash-flow statements.',
        explainer: 'Free cash flow is the cash a business has left after running and reinvesting in itself — the money that can fund dividends, buybacks and debt paydown without borrowing. This leaderboard ranks US companies by absolute free cash flow (operating cash flow minus capital expenditures) taken directly from their latest filed cash-flow statement, and shows the actual dollar figure behind each rank rather than hiding it behind a login. It requires positive free cash flow and a multi-year profit record so the list reflects durable cash machines, not a single unusual year. Absolute FCF naturally favours the largest companies; for efficiency, compare it against revenue and the margin column shown alongside.',
        args: { require_positive_fcf: true, min_profitable_years_of_last_10: 5, sort_by: 'fcfAbs', limit: 25, maxLimit: 25 },
        cols: ['fcfAbs', 'netMarginPct', 'pe'],
        related: ['most-profitable-stocks', 'highest-roe-stocks', 'quality-compounders', 'blue-chip-high-roe-stocks']
    },
    'highest-roe-stocks': {
        h1: 'Stocks With the Highest Return on Equity (ROE)',
        intro: 'US companies earning the most profit per dollar of shareholder equity — ranked from filed statements, with negative- and negligible-equity distortions removed.',
        explainer: 'Return on equity measures how much profit a company wrings from each dollar of shareholder capital, and consistently high ROE is a hallmark of a high-quality, capital-efficient business. The catch is that ROE explodes to meaningless numbers when equity is tiny or negative — typically after years of buybacks or losses — so a raw "highest ROE" list is usually topped by accounting artifacts. This screen removes them: it caps ROE at a sane ceiling, requires positive free cash flow and at least 8 profitable years of the last 10, and ranks the genuine high-return operators that remain. ROE is inflated by leverage, so read it next to the margin and growth columns rather than on its own.',
        args: { min_roe_pct: 15, max_roe_pct: 80, require_positive_fcf: true, min_profitable_years_of_last_10: 8, sort_by: 'roePct', limit: 25, maxLimit: 25 },
        cols: ['roePct', 'netMarginPct', 'revCagr5Pct'],
        related: ['most-profitable-stocks', 'highest-free-cash-flow-stocks', 'quality-compounders', 'blue-chip-high-roe-stocks']
    },

    // ---- qualified combo pages (sector / size × metric) — narrow, bottom-funnel,
    // knitted into the cluster by the related-link matrix so a low-DA site ranks them ----
    'high-dividend-tech-stocks': {
        h1: 'High-Dividend Technology Stocks',
        intro: 'Technology companies paying a 2%+ dividend yield with a long record of profits — income from a sector usually known for paying none.',
        explainer: 'Technology is the last place most investors look for income, which is exactly why the dividend payers that do exist are easy to miss. This screen filters the technology sector to companies yielding at least 2% that have also been profitable in at least 8 of the last 10 years, then ranks them by yield — all from SEC filings, recomputed nightly. Because few tech names pay meaningful dividends, this is a deliberately short, high-conviction list; the P/E and margin columns are shown so you can judge whether the yield is backed by a healthy business or a stalled one.',
        args: { sector: 'technology', min_dividend_yield_pct: 2, min_profitable_years_of_last_10: 8, sort_by: 'divYieldPct', limit: 25, maxLimit: 25 },
        cols: ['divYieldPct', 'pe', 'netMarginPct'],
        related: ['dividend-stocks', 'undervalued-tech-stocks', 'high-dividend-energy-stocks', 'undervalued-dividend-stocks']
    },
    'small-cap-growth-stocks': {
        h1: 'Small-Cap Growth Stocks in the US Market',
        intro: 'Companies under $2B in market value compounding revenue 15%+ a year with positive free cash flow — fast growers that are also self-funding.',
        explainer: 'Small-cap growth is where the biggest multi-year winners often start, but it is also where cash-burning stories hide. This screen looks for US companies under $2 billion in market capitalisation growing revenue at least 15% a year over the last five fiscal years, and — unusually for a growth screen — requires positive free cash flow, so the list leans toward businesses funding their own expansion rather than the market’s. Everything is computed from filed statements, not projections. Smaller companies carry more single-stock risk and thinner liquidity, so treat this as a research starting point, and read the margin column to see which growers are actually profitable.',
        args: { max_market_cap_billions: 2, min_revenue_cagr_5y_pct: 15, max_revenue_cagr_5y_pct: 80, require_positive_fcf: true, min_profitable_years_of_last_10: 5, sort_by: 'revCagr5Pct', limit: 25, maxLimit: 25 },
        cols: ['revCagr5Pct', 'netMarginPct', 'marketCapB'],
        related: ['high-growth-stocks', 'profitable-small-cap-stocks', 'quality-compounders', 'low-peg-stocks']
    },
    'large-cap-value-stocks': {
        h1: 'Large-Cap Value Stocks in the US Market',
        intro: 'Big, established companies above $10B trading under 15× earnings with positive free cash flow — value among the market’s largest names.',
        explainer: 'When a large, established company trades at a low multiple, it is usually because the market doubts its growth — but size and cash generation also make big caps more resilient than the cheap small-cap names value screens often surface. This screen filters to US companies above $10 billion in market value trading under 15× earnings, with positive free cash flow and a multi-year profit record, then ranks them from the lowest P/E up. All figures come from SEC filings and refresh nightly. A low multiple on a large cap can signal a value opportunity or a slow structural decline, so the yield and ROE columns are shown to help tell durable franchises from value traps.',
        args: { min_market_cap_billions: 10, max_pe: 15, require_positive_fcf: true, min_profitable_years_of_last_10: 7, sort_by: 'pe', limit: 25, maxLimit: 25 },
        cols: ['pe', 'divYieldPct', 'roePct'],
        related: ['low-pe-stocks', 'stocks-below-book-value', 'blue-chip-high-roe-stocks', 'undervalued-dividend-stocks']
    },
    'blue-chip-high-roe-stocks': {
        h1: 'Blue-Chip Stocks With High Return on Equity',
        intro: 'Mega-cap companies above $50B combining 20%+ ROE with a near-spotless profit record — the market’s largest, most capital-efficient franchises.',
        explainer: 'The rare combination of enormous scale and high returns on equity tends to mark the market’s strongest competitive moats — businesses big enough to be stable yet still earning outsized returns on the capital they employ. This screen requires a market value above $50 billion, return on equity of at least 20% (capped to exclude negative-equity distortions), and at least 9 profitable years of the last 10, then ranks the survivors by ROE, all from filed statements. ROE is amplified by debt, so the margin column is shown alongside to distinguish genuinely high-quality franchises from leverage-driven ones.',
        args: { min_market_cap_billions: 50, min_roe_pct: 20, max_roe_pct: 80, min_profitable_years_of_last_10: 9, sort_by: 'roePct', limit: 25, maxLimit: 25 },
        cols: ['roePct', 'netMarginPct', 'marketCapB'],
        related: ['highest-roe-stocks', 'quality-compounders', 'large-cap-value-stocks', 'most-profitable-stocks']
    },
    'high-dividend-energy-stocks': {
        h1: 'High-Dividend Energy Stocks in the US Market',
        intro: 'Energy companies paying a 3%+ dividend yield with a multi-year record of profits — the sector’s highest, best-supported payouts.',
        explainer: 'Energy is one of the market’s most generous income sectors, but payouts here swing with commodity prices, so the headline yield can flatter a business whose earnings are about to turn. This screen filters the energy sector to companies yielding at least 3% that have been profitable in at least 6 of the last 10 years, then ranks them by yield — straight from SEC filings, recomputed nightly. Several of the highest yielders are partnerships whose distributions and tax treatment differ from ordinary dividends, so the P/E and margin columns are shown to gauge how well each payout is covered before relying on it.',
        args: { sector: 'energy', min_dividend_yield_pct: 3, min_profitable_years_of_last_10: 6, sort_by: 'divYieldPct', limit: 25, maxLimit: 25 },
        cols: ['divYieldPct', 'pe', 'netMarginPct'],
        related: ['dividend-stocks', 'undervalued-dividend-stocks', 'high-dividend-tech-stocks', 'low-pe-stocks']
    },
    'profitable-small-cap-stocks': {
        h1: 'Profitable Small-Cap Stocks in the US Market',
        intro: 'Companies under $2B with net margins above 10% and a long record of profits — the small caps that actually make money.',
        explainer: 'Most small-cap lists are crowded with companies that have never turned a profit. This one inverts that: it filters US companies under $2 billion in market value to those with net margins above 10%, positive free cash flow, and at least 8 profitable years of the last 10, then ranks them by margin — all from filed income statements. The result is a list of genuinely profitable smaller businesses rather than hopeful early-stage stories. Small caps still carry higher single-stock and liquidity risk, and high margins vary by industry, so use the growth column and compare each name against close peers.',
        args: { max_market_cap_billions: 2, min_net_margin_pct: 10, require_positive_fcf: true, min_profitable_years_of_last_10: 8, sort_by: 'netMarginPct', limit: 25, maxLimit: 25 },
        cols: ['netMarginPct', 'revCagr5Pct', 'marketCapB'],
        related: ['small-cap-growth-stocks', 'most-profitable-stocks', 'high-growth-stocks', 'quality-compounders']
    }
};
const COL_DEFS = {
    revCagr5Pct: ['Rev growth (5y)', (v) => v === null ? '—' : `${v.toFixed(1)}%/yr`],
    netMarginPct: ['Net margin', (v) => v === null ? '—' : `${v.toFixed(1)}%`],
    roePct: ['ROE', (v) => v === null ? '—' : `${v.toFixed(1)}%`],
    divYieldPct: ['Dividend yield', (v) => v === null ? '—' : `${v.toFixed(2)}%`],
    pe: ['P/E', (v) => v === null ? '—' : v.toFixed(1)],
    fcfAbs: ['Free cash flow', (v) => money(v)],
    pegRatio: ['PEG (P/E ÷ growth)', (v) => v === null ? '—' : v.toFixed(2)],
    priceToBook: ['Price / book', (v) => v === null ? '—' : v.toFixed(2)],
    marketCapB: ['Market cap', (v) => v === null ? '—' : money(v * 1e9)]
};

function renderScreenPage(slug) {
    const s = SCREENS[slug];
    if (!s) return null;
    const year = new Date().getFullYear();
    // Force primary-listing cleaning on every SEO screen so preferreds / warrants /
    // duplicate share classes (which inherit the common's overview and produce junk
    // like "P/E 0.6") never pollute a public leaderboard.
    const { matched, rows } = aiChat.screenRows({ ...s.args, exclude_secondary_listings: true });
    if (!rows.length) return null;
    const canonical = `${SITE}/screens/${slug}`;
    const title = `${s.h1} (${year}) — Ranked by Filed Fundamentals`;
    const description = `${s.intro} ${matched} companies qualify today; top ${rows.length} ranked. Live from SEC filing data, updated nightly.`;
    const colHead = s.cols.map((c) => `<th>${esc(COL_DEFS[c][0])}</th>`).join('');
    const trs = rows.map((r, i) =>
        `<tr><td>${i + 1}. <a href="/stocks/${esc(r.symbol)}">${esc(r.name)} (${esc(r.symbol)})</a></td>` +
        s.cols.map((c) => `<td>${esc(COL_DEFS[c][1](r[c]))}</td>`).join('') + `</tr>`).join('');

    // FAQ block — unique, data-backed text so these pages rank for the long tail
    // ("what are low pe stocks", "lowest pe stock", "how is X calculated"). The
    // top-of-list answer is generated from the live ranking.
    const top = rows[0];
    const c0 = s.cols[0];
    const c0Label = COL_DEFS[c0][0].toLowerCase();
    const c0Val = COL_DEFS[c0][1](top[c0]);
    const faqs = [
        {
            q: `How is the "${s.h1}" list calculated?`,
            a: `${s.intro} The ranking is produced by a deterministic filter over companies' SEC-filed annual statements, re-run every night — no editorial picks and no paid placement. ${matched} companies pass the filter today; the top ${rows.length} are shown.`
        },
        {
            q: `What is the top-ranked stock in this screen right now?`,
            a: `As of the latest nightly refresh, ${top.name} (${top.symbol}) ranks first, with ${c0Label} of ${c0Val}. The full ranked list of ${rows.length} companies is in the table above, and you can re-run or adjust the filters yourself in the free screener.`
        },
        {
            q: `How often is this list updated?`,
            a: `It is recomputed every night from the latest SEC filing data, so newly filed 10-Ks and 10-Qs flow into the ranking on the next build. The figures reflect what companies have actually reported, not analyst forecasts.`
        },
        {
            q: `Is this investment advice?`,
            a: `No. This is a factual, rules-based screen of filed fundamentals for research and education only — not a recommendation to buy or sell any security. Always verify against the primary filing and consider your own circumstances before investing.`
        }
    ];

    const jsonld = JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
            { '@type': 'WebPage', name: title, url: canonical },
            {
                '@type': 'ItemList', name: s.h1, url: canonical,
                itemListElement: rows.slice(0, 10).map((r, i) => ({ '@type': 'ListItem', position: i + 1, name: `${r.name} (${r.symbol})`, url: `${SITE}/stocks/${r.symbol}` }))
            },
            {
                '@type': 'FAQPage',
                mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } }))
            }
        ]
    });
    const faqHtml = faqs.map((f) =>
        `<h3 style="font-size:15.5px;margin:18px 0 6px">${esc(f.q)}</h3><p style="margin:0;font-size:14px;line-height:1.7;max-width:74ch">${esc(f.a)}</p>`).join('');
    // Internal-link matrix: lead with this screen's curated cousins (a dense,
    // topically-tight graph lets the whole cluster rank together on a low-DA domain),
    // then fill with the remaining screens.
    const relSlugs = (s.related || []).filter((k) => SCREENS[k] && k !== slug);
    const ordered = [...new Set([...relSlugs, ...Object.keys(SCREENS).filter((k) => k !== slug)])];
    const others = ordered
        .map((k) => `<a href="/screens/${k}">${esc(SCREENS[k].h1)}</a>`).join('');
    // AI hook — the conversion path for SEO visitors who land here from Google.
    // Deep-links into the SEC-grounded Ask analyst, pre-seeded with this screen's
    // own top names so the prompt is concrete the moment they click.
    const a1 = rows[0]; const a2 = rows[1] || a1; const a3 = rows[2] || a1;
    const askQ = (q) => `/ask?q=${encodeURIComponent(q)}`;
    const askHero = `
  <div class="seo-lock" style="border-color:var(--accent)">
    <h3>Ask the AI analyst about any of these</h3>
    <p>Every figure it cites comes straight from SEC filings, with the sources shown — never AI guesswork. Put this leaderboard to work:</p>
    <div class="seo-links" style="margin:10px 0 14px">
      <a href="${askQ(`Is ${a1.name} (${a1.symbol}) a good buy at today's price? Walk through the fundamentals from its filings.`)}">Is ${esc(a1.symbol)} a good buy? &rarr;</a>
      <a href="${askQ(`Compare ${a1.symbol} and ${a2.symbol} on growth, margins, returns and valuation, using SEC filings.`)}">${esc(a1.symbol)} vs ${esc(a2.symbol)} &rarr;</a>
      <a href="${askQ(`Of ${a1.symbol}, ${a2.symbol} and ${a3.symbol}, which has the most durable fundamentals and what is the risk in each?`)}">Rank the top 3 &rarr;</a>
    </div>
    <a class="seo-cta-btn" href="/register?plan=monthly">Try the AI analyst free — no card</a>
  </div>`;
    return head(title, description, canonical, jsonld) + nav('screener') + `
<main class="seo-wrap">
  <div class="seo-crumbs"><a href="/stocks">Stocks</a> / Screens / ${esc(s.h1)}</div>
  <h1 class="seo-h1">${esc(s.h1)} <span style="color:var(--ink3);font-weight:600">(${year})</span></h1>
  <p class="seo-sub">${esc(s.intro)} ${matched} companies qualify today — top ${rows.length} below, recomputed nightly from SEC filings.</p>
  ${s.explainer ? `<p class="seo-about" style="margin:4px 0 20px">${esc(s.explainer)}</p>` : ''}
  <div class="seo-section">
    <div style="overflow-x:auto"><table class="seo-table">
      <thead><tr><th>Company</th>${colHead}</tr></thead>
      <tbody>${trs}</tbody>
    </table></div>
    <p style="color:var(--ink3);font-size:12.5px;margin-top:8px">Criteria are deterministic filters over filed annual statements — no editorial picks, no payment for placement. Not investment advice.</p>
  </div>
  ${askHero}
  <div class="seo-lock">
    <h3>Run your own screen — free</h3>
    <p>The full screener covers 3,800+ US companies with growth, margin, ROE, valuation and dividend filters. No account needed.</p>
    <a class="seo-cta-btn" href="/screener">Open the free screener</a>
  </div>
  <div class="seo-section"><h2>${esc(s.h1)} — frequently asked questions</h2>${faqHtml}</div>
  <div class="seo-section"><h2>More screens</h2><div class="seo-links">${others}</div></div>
</main>` + footer();
}

// ---- /compare/vs-<vendor>: honest head-to-head against another product ----
// Rules for this surface, deliberately narrow: only feature facts we can point
// at on the vendor's own public product, never a price we have not re-checked,
// and a real "buy them instead" section. Anything we could not verify is left
// as an inline UNVERIFIED comment rather than written as if it were fact — a
// comparison page that overstates is worth less than no comparison page.
const VENDOR_COMPARISONS = {
    'vs-koyfin': {
        vendor: 'Koyfin',
        vendorUrl: 'https://www.koyfin.com/',
        vsSlug: 'koyfin',
        status: 'full',
        title: 'StockPortfolio.pro vs Koyfin — An Honest Comparison',
        description: 'A deliberately honest comparison: what Koyfin does better, who should buy Koyfin instead, and the two things StockPortfolio.pro does that Koyfin does not — citation-grounded Ask and filing diffs.',
        h1: 'StockPortfolio.pro vs Koyfin',
        sub: 'Written by us, about our own competitor, so read it with that in mind &mdash; but we have tried to make it the version we would want to read. Short answer: these are different tools, and for a lot of people Koyfin is the right purchase.',
        verdict: 'Koyfin is a broad market-data and charting terminal. StockPortfolio.pro is a filing-reading tool. If your day is spent watching markets, macro series and non-US names across dashboards, buy Koyfin. If your day is spent reading 10-Ks and 10-Qs and needing to know what changed since the last one &mdash; with a source link on every number &mdash; that is what we built.',
        // Only claims we can point at on Koyfin's own public product surface.
        theirStrengths: [
            ['Breadth of coverage', 'Koyfin covers global equities, ETFs, funds, FX and macro/economic series. Our coverage is US-listed companies that report in USD to the SEC. That is a real gap, not a positioning choice &mdash; if you need non-US names, we do not have them.'],
            ['Charting and dashboards', 'Koyfin&rsquo;s charting, multi-metric overlays and configurable dashboards are the core of the product and are considerably deeper than ours. We do not try to be a charting terminal.'],
            ['Watchlists and market monitoring', 'Koyfin is built to be left open all day across watchlists and market views. We are built to be opened when a filing lands.'],
            ['Analyst estimates and forward data', 'Koyfin surfaces analyst estimate data alongside reported figures. We deliberately publish only filed, reported numbers &mdash; we carry no forward estimates at all.'],
            ['Maturity', 'Koyfin is a far more established product with a much larger user base, a longer track record and more people testing it every day than we have.']
        ],
        buyThemInstead: [
            'You want a market terminal open all day &mdash; quotes, charts, watchlists, macro dashboards.',
            'You invest outside the US, or in non-USD reporters. We will not cover those names.',
            'You need analyst estimates, consensus or forward multiples in your workflow.',
            'Charting depth is the thing you would actually use most days.',
            'You want a mature product with a long track record rather than a small one.'
        ],
        ourStrengths: [
            ['Citation-grounded Ask', 'Ask a question in English about a covered US company and the answer comes back with the SEC filing it was drawn from, linked, so you can open the primary document and check it. When we cannot ground a figure in a filing, the answer says so instead of estimating. This is the whole product thesis: an answer you cannot check is not an answer.'],
            ['Filing diffs', 'We read the newest 10-K/10-Q/8-K against the previous one and show what changed &mdash; risk-factor edits, language changes and the numbers that moved &mdash; ranked by materiality, each linked back to the filed document. That first manual pass through a new filing is the job we automate.'],
            ['Filed-only discipline', 'Every figure on the site keeps its fiscal period and its source. Missing data stays missing. No estimated fills, no blended periods.'],
            ['Free, crawlable research pages', 'The per-company, per-metric and head-to-head pages are server-rendered and free to read without an account.']
        ],
        ourWeaknesses: [
            'US-only coverage, USD reporters only.',
            'No real-time quotes and no trading-grade charting.',
            'No analyst estimates or consensus data, by choice.',
            'A much smaller product with a much shorter track record.'
        ],
        faqs: [
            {
                q: 'Is StockPortfolio.pro as good as Koyfin?',
                a: 'No &mdash; not at the job Koyfin is built for. Koyfin is a broader, more mature market-data and charting platform with global coverage. If you want a terminal, buy Koyfin. StockPortfolio.pro does one narrower job: reading SEC filings for US-listed companies and answering questions about them with the filing linked on every figure.'
            },
            {
                q: 'Can I use both?',
                a: 'That is the honest recommendation for a lot of people. Koyfin for market monitoring, charts and non-US coverage; StockPortfolio.pro when a 10-K or 10-Q lands and you need to know what changed and where the number came from.'
            },
            {
                q: 'What does Koyfin cost?',
                a: 'Check Koyfin&rsquo;s own pricing page &mdash; we do not restate a competitor&rsquo;s prices here, because they change and a stale number on our site would be worse than no number.'
            },
            {
                q: 'Why does the citation matter so much to you?',
                a: 'Because a financial answer you cannot trace to a primary document is a claim, not a fact. Every figure we show keeps its fiscal period and a link to the SEC filing it came from, so the check takes one click rather than a search.'
            }
        ]
    },
    'vs-seeking-alpha': {
        vendor: 'Seeking Alpha',
        vendorUrl: 'https://seekingalpha.com/',
        vsSlug: 'seeking-alpha',
        status: 'stub',
        title: 'StockPortfolio.pro vs Seeking Alpha — Honest Comparison (In Progress)',
        description: 'An honest comparison of StockPortfolio.pro and Seeking Alpha. This page is deliberately short until we have verified every feature claim we want to make.',
        h1: 'StockPortfolio.pro vs Seeking Alpha',
        sub: 'This comparison is not finished. Rather than publish feature claims about another company that we have not verified, here is the short, honest version.',
        verdict: 'Seeking Alpha is a research-and-opinion publisher with a very large contributor community, plus quantitative ratings on top. StockPortfolio.pro publishes no opinion and no ratings at all &mdash; it reads SEC filings and answers questions about them with the filing linked. If what you want is other people&rsquo;s investment theses and a rating to react to, that is Seeking Alpha, not us.',
        buyThemInstead: [
            'You want to read other investors&rsquo; written theses on a company.',
            'You want a quantitative rating or a summarised bull/bear case to react to.',
            'You want earnings-call coverage and news commentary in one subscription.'
        ],
        ourStrengths: [
            ['Citation-grounded Ask', 'Questions about a covered US company are answered from the filed document, with the SEC filing linked on every figure. Nothing is inferred from an article.'],
            ['Filing diffs', 'What actually changed between the newest 10-K/10-Q/8-K and the previous one, ranked by materiality, each item linked to the filing.'],
            ['No opinion layer', 'We do not publish theses, ratings or recommendations. The output is what the company filed.']
        ]
    }
};

function vendorComparePath(slug) { return `/compare/${slug}`; }

function renderVendorComparePage(slugRaw) {
    const slug = String(slugRaw || '').toLowerCase();
    const v = VENDOR_COMPARISONS[slug];
    if (!v) return null;
    const canonical = `${SITE}${vendorComparePath(slug)}`;
    const faqs = v.faqs || [];
    // schema.org has no "ComparisonPage" type, so the closest valid markup is a
    // WebPage that declares both products as its subject, plus FAQPage where we
    // have real Q&A. Emitting an invented type would just be ignored.
    const jsonld = JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'WebPage', name: v.title, url: canonical, description: v.description,
                publisher: { '@id': `${SITE}/#org` },
                about: [
                    { '@type': 'SoftwareApplication', name: 'StockPortfolio.pro', applicationCategory: 'FinanceApplication', operatingSystem: 'Web', url: SITE },
                    { '@type': 'SoftwareApplication', name: v.vendor, applicationCategory: 'FinanceApplication', operatingSystem: 'Web', url: v.vendorUrl }
                ]
            },
            ...(faqs.length ? [{ '@type': 'FAQPage', mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) }] : [])
        ]
    });
    const list = (rows) => rows.map(([h, body]) =>
        `<h3 style="font-size:15.5px;margin:18px 0 6px">${h}</h3><p style="margin:0;font-size:14px;line-height:1.7;max-width:74ch;color:var(--ink2)">${body}</p>`).join('');
    const bullets = (rows) => `<ul style="margin:6px 0 0;padding-left:20px;font-size:14px;line-height:1.75;color:var(--ink2);max-width:74ch">${rows.map((r) => `<li>${r}</li>`).join('')}</ul>`;
    const faqHtml = faqs.map((f) =>
        `<h3 style="font-size:15.5px;margin:18px 0 6px">${f.q}</h3><p style="margin:0;font-size:14px;line-height:1.7;max-width:74ch;color:var(--ink2)">${f.a}</p>`).join('');
    const otherSlugs = Object.keys(VENDOR_COMPARISONS).filter((k) => k !== slug);

    return head(v.title, v.description, canonical, jsonld) + nav('compare') + `
<main class="seo-wrap">
  <div class="seo-crumbs"><a href="/compare">Compare</a> / vs ${esc(v.vendor)}</div>
  <h1 class="seo-h1">${esc(v.h1)}</h1>
  <p class="seo-sub">${v.sub}</p>
  <div class="seo-section" style="border:1px solid var(--line);border-radius:12px;background:var(--surface);padding:18px">
    <h2 style="margin-top:0">The short answer</h2>
    <p style="margin:0;font-size:15px;line-height:1.75;max-width:74ch">${v.verdict}</p>
  </div>
  ${v.theirStrengths ? `<div class="seo-section"><h2>What ${esc(v.vendor)} does better</h2>${list(v.theirStrengths)}</div>` : ''}
  ${v.buyThemInstead ? `<div class="seo-section"><h2>Buy ${esc(v.vendor)} instead if&hellip;</h2>${bullets(v.buyThemInstead)}<p style="margin:14px 0 0;font-size:14px"><a href="${esc(v.vendorUrl)}" rel="nofollow noopener" target="_blank">Go and look at ${esc(v.vendor)} &rarr;</a></p></div>` : ''}
  ${v.ourStrengths ? `<div class="seo-section"><h2>What StockPortfolio.pro does that ${esc(v.vendor)} does not</h2>${list(v.ourStrengths)}</div>` : ''}
  ${v.ourWeaknesses ? `<div class="seo-section"><h2>Where we are weaker, plainly</h2>${bullets(v.ourWeaknesses)}</div>` : ''}
  ${v.status === 'stub' ? `<div class="seo-section"><h2>Why this page is short</h2><p style="margin:0;font-size:14px;line-height:1.7;max-width:74ch;color:var(--ink2)">We would rather publish three claims we have checked than twenty we have not. This page will be extended once each additional claim about ${esc(v.vendor)} has been verified against their live product.</p></div>` : ''}
  ${faqHtml ? `<div class="seo-section"><h2>Questions</h2>${faqHtml}</div>` : ''}
  <div class="seo-lock"><h3>See the citation for yourself</h3><p>Ask a question about a covered US company and open the SEC filing the answer came from. Free, no account for the public research pages.</p><a class="seo-cta-btn" href="/ask">Try a filing-grounded question</a></div>
  <div class="seo-section"><h2>More comparisons</h2><div class="seo-links">${v.vsSlug ? `<a href="/vs/${esc(v.vsSlug)}">Feature-by-feature table: ${esc(v.vendor)}</a>` : ''}${otherSlugs.map((k) => `<a href="${vendorComparePath(k)}">StockPortfolio.pro vs ${esc(VENDOR_COMPARISONS[k].vendor)}</a>`).join('')}<a href="/compare">Compare any two US stocks</a><a href="/features">All features</a><a href="/methodology">Full methodology</a></div></div>
</main>` + footer();
}

// UNVERIFIED: Koyfin's current plan names, tiers and prices are deliberately not
//   stated anywhere on /compare/vs-koyfin. They were not re-checked against
//   koyfin.com when this page was written, so it sends the reader to Koyfin's own
//   pricing page instead. Do not fill these in from memory.
// UNVERIFIED: exact Koyfin coverage counts (exchanges, securities, macro series)
//   and any per-tier feature gating. The page only makes the directional claim
//   that Koyfin's coverage is global and broader than ours.
// UNVERIFIED: whether Koyfin offers any SEC-filing-diff feature. The page does not
//   claim it does not; it only claims what we do.
// UNVERIFIED: Seeking Alpha's plan names, prices, contributor counts and the
//   mechanics of its Quant rating. The vs-seeking-alpha page is intentionally a
//   stub for exactly this reason.
// UNVERIFIED: the older /vs/:competitor pages in comparison-pages.js DO carry
//   competitor prices ("Plus ~$39/mo", "~$299/year") that were not re-checked
//   when these pages were written. They are cross-linked, not restated here.

// ---------- router ----------
const router = express.Router();
function canonicalMetricPath(req, symbol, slug) {
    const query = String(req.originalUrl || '').split('?')[1];
    const pathName = `/stocks/${encodeURIComponent(symbol)}/${encodeURIComponent(slug)}`;
    return query ? `${pathName}?${query}` : pathName;
}
router.get('/stocks/:ticker/:metric.csv', (req, res, next) => {
    const slug = String(req.params.metric || '').toLowerCase();
    if (!METRICS[slug]) return next();
    const canonical = resolveCanonicalSymbol(req.params.ticker);
    if (canonical && String(req.params.ticker) !== canonical) return res.redirect(301, canonicalMetricPath(req, canonical, `${slug}.csv`));
    const csv = metricCsv(canonical || req.params.ticker, slug);
    if (!csv) return res.status(404).type('text/plain').send('Metric history not found.');
    const sym = canonical || normalizeTicker(req.params.ticker);
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${sym}-${slug}.csv"`, 'Cache-Control': 'public, max-age=3600' }).send(csv);
});
router.get('/stocks/:ticker/:metric', (req, res, next) => {
    const slug = String(req.params.metric || '').toLowerCase();
    if (!METRICS[slug]) return next();
    const canonical = resolveCanonicalSymbol(req.params.ticker);
    if (canonical && String(req.params.ticker) !== canonical) return res.redirect(301, canonicalMetricPath(req, canonical, slug));
    const html = renderMetricPage(canonical || req.params.ticker, slug, { req });
    if (!html) return res.redirect(302, `/stocks/${encodeURIComponent(canonical || normalizeTicker(req.params.ticker))}`);
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
});
router.get('/stocks/:ticker/price-history', (req, res, next) => {
    // Not a METRICS slug, so the :metric route above falls through to here.
    const canonical = resolveCanonicalSymbol(req.params.ticker);
    if (canonical && String(req.params.ticker) !== canonical) return res.redirect(301, canonicalMetricPath(req, canonical, 'price-history'));
    const html = renderPriceHistoryPage(canonical || req.params.ticker, { req });
    if (!html) return res.redirect(302, `/stocks/${encodeURIComponent(canonical || normalizeTicker(req.params.ticker))}`);
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
});
router.get('/research/shares-outstanding', (_req, res) => res.type('html').send(renderSharesResearch()));
router.get('/research/pe-ratio-history', (_req, res) => res.type('html').send(renderPeResearch()));
router.get('/research/dilution-scorecard', (_req, res) => res.type('html').send(renderDilutionScorecard()));
router.get('/research/how-to-read-a-10-k', (_req, res) => res.type('html').send(renderRead10KGuide()));
router.get('/research/how-to-compare-two-stocks', (_req, res) => res.type('html').send(renderCompareGuide()));
router.get('/research/what-is-free-cash-flow', (_req, res) => res.type('html').send(renderFreeCashFlowGuide()));
router.get('/research/how-to-find-undervalued-stocks', (_req, res) => res.type('html').send(renderFindUndervaluedGuide()));
router.get('/research/dilution-scorecard.csv', (_req, res) => {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="stockportfolio-dilution-scorecard.csv"', 'Cache-Control': 'public, max-age=21600' }).send(dilutionCsv());
});
router.get('/compare', (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8').send(renderCompareIndex());
});
// Must be registered before /compare/:pair — a vendor slug is not a ticker pair
// and would otherwise fall through to the 302 back to /stocks.
router.get('/compare/:vendor(vs-[a-z0-9-]+)', (req, res, next) => {
    const html = renderVendorComparePage(req.params.vendor);
    if (!html) return next();
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
});
router.get('/compare/:pair', (req, res, next) => (cmpAuth && cmpAuth.optionalAuth ? cmpAuth.optionalAuth(req, res, next) : next()), (req, res) => {
    const out = renderComparePage(req.params.pair);
    if (!out) return res.redirect(302, '/stocks');
    if (out.redirect) return res.redirect(301, out.redirect);
    // Paid variant: /compare/PAIR?sp=2 (the in-page upgrade probe sends paid
    // users here) renders the full expanded design for subscribers. Everyone
    // else — free users, logged-out visitors, crawlers, anyone carrying the
    // param without an active subscription — gets the free page unchanged.
    // Cache-Control: private plus the ssr-cache ?sp=2 skip keeps this per-user
    // render out of every shared cache.
    if (req.query && req.query.sp === '2' && cmpAuth && (req.tier === 'core' || req.tier === 'pro')) {
        const pro = renderComparePagePro(req.params.pair);
        if (pro && pro.html && !pro.redirect) {
            res.set('Cache-Control', 'private, no-cache');
            return res.set('Content-Type', 'text/html; charset=utf-8').send(pro.html);
        }
    }
    res.set('Content-Type', 'text/html; charset=utf-8').send(out.html);
});
router.get('/screens/:slug', (req, res) => {
    const html = renderScreenPage(String(req.params.slug || '').toLowerCase());
    if (!html) return res.redirect(302, '/screener');
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
});

// URL lists for the sitemap (seo-pages.buildSitemap pulls these lazily)
function sitemapUrls() {
    const urls = [];
    const avail = availability();
    for (const [sym, flags] of avail) {
        for (const slug of METRIC_SLUGS) if (flags[slug]) urls.push({ loc: `/stocks/${sym}/${slug}`, pri: '0.5' });
        if (flags.priceHistory) urls.push({ loc: `/stocks/${sym}/price-history`, pri: '0.5' });
    }
    comparePairs().forEach((p) => urls.push({ loc: `/compare/${p}`, pri: '0.4' }));
    Object.keys(VENDOR_COMPARISONS).forEach((slug) => urls.push({ loc: vendorComparePath(slug), pri: '0.7' }));
    Object.keys(SCREENS).forEach((s) => urls.push({ loc: `/screens/${s}`, pri: '0.7' }));
    RESEARCH_ROUTES.forEach((route) => urls.push({ loc: route, pri: '0.8' }));
    return urls;
}

module.exports = {
    router, METRICS, METRIC_SLUGS, RESEARCH_ROUTES, sitemapUrls, comparePairs, SCREENS, noteDiscoveredCompare,
    renderMetricPage, renderComparePage, renderComparePagePro, renderCompareIndex, metricCsv, dilutionRows, dilutionCsv,
    setCompareAuth,
    VENDOR_COMPARISONS, renderVendorComparePage,
    pilotEnabled, organicRequest, pilotEligibility, pilotAction,
    renderSharesResearch, renderPeResearch, renderDilutionScorecard,
    renderRead10KGuide, renderCompareGuide, renderFreeCashFlowGuide, renderFindUndervaluedGuide,
    monthlySeries, totalReturn, fiftyTwoWeekRange, sectorPercentile, sectorPeers, METRIC_INDEX_FIELD,
    renderPriceHistoryPage
};
