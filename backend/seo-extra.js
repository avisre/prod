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

const SITE = 'https://www.stockportfolio.pro';
const { esc, num, money, price, pct, ratio, head, nav, footer, loadCompanies, loadFundamentals } = seo;

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

// ---------- metric registry ----------
// rows(data) -> [{year, value, aux}] newest-first; null value rows are dropped.
const METRICS = {
    'revenue': {
        label: 'Revenue', noun: 'revenue', fmt: money, source: 'income statement (10-K)',
        rows: (d) => ((d.income || {}).annualReports || []).map((r) => ({ year: fyYear(r), value: num(r.totalRevenue) }))
    },
    'net-income': {
        label: 'Net Income', noun: 'net income', fmt: money, source: 'income statement (10-K)',
        auxLabel: 'Net margin',
        rows: (d) => ((d.income || {}).annualReports || []).map((r) => {
            const rev = num(r.totalRevenue); const ni = num(r.netIncome);
            return { year: fyYear(r), value: ni, aux: (rev && ni !== null) ? `${((ni / rev) * 100).toFixed(1)}%` : null };
        })
    },
    'gross-profit': {
        label: 'Gross Profit', noun: 'gross profit', fmt: money, source: 'income statement (10-K)',
        auxLabel: 'Gross margin',
        rows: (d) => ((d.income || {}).annualReports || []).map((r) => {
            const rev = num(r.totalRevenue); const gp = grossProfitOf(r);
            return { year: fyYear(r), value: gp, aux: (rev && gp !== null) ? `${((gp / rev) * 100).toFixed(1)}%` : null };
        })
    },
    'eps': {
        label: 'EPS (Earnings per Share)', noun: 'earnings per share', fmt: price, source: 'income statement (10-K), split-adjusted',
        rows: (d) => ((d.income || {}).annualReports || []).map((r) => {
            const e = num(r.dilutedEPS) !== null ? num(r.dilutedEPS) : num(r.eps);
            return { year: fyYear(r), value: e };
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
        rows: (d) => ((d.cash || {}).annualReports || []).map((r) => {
            const ocf = num(r.operatingCashflow); const capex = num(r.capitalExpenditures);
            // capex sign differs by source year (SEC negative, vendor positive) — normalize
            const v = (ocf !== null && capex !== null) ? ocf - Math.abs(capex) : null;
            return { year: fyYear(r), value: v };
        })
    },
    'total-debt': {
        label: 'Total Debt', noun: 'total debt (short- plus long-term borrowings)', fmt: money, source: 'balance sheet (10-K)',
        rows: (d) => ((d.balance || {}).annualReports || []).map((r) => ({ year: fyYear(r), value: totalDebtOf(r) }))
    },
    'shares-outstanding': {
        label: 'Shares Outstanding', noun: 'shares outstanding', source: 'balance sheet (10-K), split-adjusted',
        fmt: (v) => { const n = num(v); if (n === null) return '—'; return n >= 1e9 ? `${(n / 1e9).toFixed(2)}B` : `${(n / 1e6).toFixed(1)}M`; },
        rows: (d) => ((d.balance || {}).annualReports || []).map((r) => ({ year: fyYear(r), period: r.fiscalDateEnding, value: num(r.commonStockSharesOutstanding) }))
    },
    'dividend-history': {
        label: 'Dividend History', noun: 'dividends paid', fmt: money, source: 'cash flow statement (10-K)',
        auxLabel: 'Per share (approx)',
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
        rows: (d) => ((d.income || {}).annualReports || []).map((r) => {
            const e = num(r.dilutedEPS) !== null ? num(r.dilutedEPS) : num(r.eps);
            const c = closeAtFiscalEnd(d, r.fiscalDateEnding);
            const v = (e && e > 0 && c) ? c / e : null;
            return { year: fyYear(r), period: r.fiscalDateEnding, value: v };
        })
    }
};
const METRIC_SLUGS = Object.keys(METRICS);
const RESEARCH_ROUTES = ['/research/shares-outstanding', '/research/pe-ratio-history', '/research/dilution-scorecard'];

function pctChange(current, prior) {
    return current !== null && prior !== null && prior !== 0 ? ((current - prior) / Math.abs(prior)) * 100 : null;
}
function signedPct(value) {
    return value === null ? '—' : `${value >= 0 ? '+' : ''}${value.toFixed(1)}%`;
}
function secCompanyUrl(symbol, form = '10-K') {
    return `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${encodeURIComponent(symbol)}&type=${encodeURIComponent(form)}&owner=exclude&count=40`;
}
function metricCsv(ticker, slug) {
    const sym = String(ticker || '').toUpperCase(); const m = METRICS[slug]; const data = loadFundamentals(sym);
    if (!m || !data) return null;
    const rows = m.rows(data).filter((row) => row.year);
    if (!(m.allowEmpty ? rows.length >= 2 : rows.filter((row) => row.value !== null).length >= 2)) return null;
    const quote = (value) => `"${String(value == null ? '' : value).replace(/"/g, '""')}"`;
    const lines = [['symbol', 'fiscal_year', 'period_end', slug, 'formatted_value', ...(m.auxLabel ? ['auxiliary_value'] : [])]];
    rows.forEach((row) => lines.push([sym, row.year, row.period || '', row.value == null ? '' : row.value, row.value == null ? '' : m.fmt(row.value), ...(m.auxLabel ? [row.aux || ''] : [])]));
    return lines.map((line) => line.map(quote).join(',')).join('\n') + '\n';
}
function trendSvg(rows, label) {
    const values = rows.filter((row) => row.value !== null).slice().reverse();
    if (values.length < 2) return '';
    const min = Math.min(...values.map((row) => row.value)); const max = Math.max(...values.map((row) => row.value));
    const span = max - min || 1; const width = 760; const height = 220; const pad = 28;
    const points = values.map((row, index) => {
        const x = pad + index * ((width - pad * 2) / Math.max(values.length - 1, 1));
        const y = height - pad - ((row.value - min) / span) * (height - pad * 2);
        return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(' ');
    return `<figure style="margin:20px 0"><svg role="img" aria-labelledby="metric-chart-title" viewBox="0 0 ${width} ${height}" style="display:block;width:100%;height:auto;background:var(--surface);border:1px solid var(--line);border-radius:10px"><title id="metric-chart-title">${esc(label)} history from ${esc(values[0].year)} to ${esc(values[values.length - 1].year)}</title><line x1="${pad}" y1="${height - pad}" x2="${width - pad}" y2="${height - pad}" stroke="var(--line2)"/><polyline fill="none" stroke="var(--accent)" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" points="${points}"/>${values.map((row, index) => { const [x, y] = points.split(' ')[index].split(','); return `<circle cx="${x}" cy="${y}" r="4" fill="var(--surface)" stroke="var(--accent)" stroke-width="3"><title>FY ${esc(row.year)}: ${esc(String(row.value))}</title></circle>`; }).join('')}</svg><figcaption style="font-size:12px;color:var(--ink3);margin-top:7px">Annual filed history. Hover chart points for raw values; the accessible table below is the source of record.</figcaption></figure>`;
}

// ---------- per-symbol metric availability (for sitemap honesty) ----------
// One lightweight pass over the cache: parse, record which metrics have >=2
// usable years, discard the JSON (never hold 1,500 full files in memory).
let _avail = null;
function availability() {
    if (_avail) return _avail;
    _avail = new Map();
    for (const c of loadCompanies()) {
        try {
            const f = path.join(__dirname, '..', 'frontend', 'data', 'fundamentals',
                `${c.symbol.replace(/[^A-Z0-9]/g, '_')}.json`);
            if (!fs.existsSync(f)) continue;
            const d = JSON.parse(fs.readFileSync(f, 'utf8'));
            const flags = {};
            for (const slug of METRIC_SLUGS) {
                const m = METRICS[slug];
                const usable = m.rows(d).filter((r) => r.value !== null).length;
                flags[slug] = m.allowEmpty ? m.rows(d).length >= 2 : usable >= 2;
            }
            _avail.set(c.symbol, flags);
        } catch (_) { /* unreadable file — no metric pages for it */ }
    }
    return _avail;
}

// ---------- metric page ----------
function renderMetricPage(ticker, slug) {
    const sym = String(ticker || '').toUpperCase();
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

    const canonical = `${SITE}/stocks/${sym}/${slug}`;
    const fundFile = path.join(__dirname, '..', 'frontend', 'data', 'fundamentals', `${sym.replace(/[^A-Z0-9]/g, '_')}.json`);
    let mtimeISO = null, freshness = '';
    try { const mt = fs.statSync(fundFile).mtime; mtimeISO = mt.toISOString(); freshness = mt.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); } catch (_) { /* no mtime */ }
    // short form for the title tail: "EPS (Earnings per Share)" -> "EPS",
    // "Dividend History" -> "Dividend" (avoids "History History")
    const shortLabel = m.label.replace(/\s*\(.*\)/, '').replace(/\s+History$/i, '');
    // Front-load name+ticker (queries use both) and put the actual latest value
    // in the title — a result that visibly contains the answer earns the click
    // even at position 4-5. Strip the noisy legal suffix ("Corporation", ", Inc.")
    // so a long legal name doesn't push the value past SERP truncation. Fall back
    // to a plain range when there's no value (e.g. a company that pays no dividend).
    const titleName = name.replace(/^The\s+/i, '')
        .replace(/,?\s+(Incorporated|Corporation|Corp|Company|Co|Holdings|plc|Ltd|Limited|L\.?P|N\.?V|S\.?A|Inc)\.?$/i, '')
        .trim() || name;
    // A "$0"/"0" headline (e.g. a company that pays no dividend) reads as broken
    // and won't earn the click — use the plain range title in that case.
    const title = (latestVal !== null && latestVal !== 0)
        ? `${titleName} ${shortLabel} History: ${m.fmt(latestVal)} (${y1}) | ${sym}`
        : `${titleName} (${sym}) ${shortLabel} History ${y0}–${y1}`;
    const description = `${name} (${sym}) annual ${m.noun} from ${y0} to ${y1}` +
        (latestVal !== null ? ` — latest: ${m.fmt(latestVal)}` : '') +
        (oneYear !== null ? `, ${signedPct(oneYear)} year over year` : '') +
        `. SEC-filed history, methodology, chart and downloadable CSV.`;

    // table rows, newest first, with YoY change
    const trs = all.map((r, i) => {
        const prev = all[i + 1];
        let yoy = '—';
        if (r.value !== null && prev && prev.value !== null && prev.value !== 0) {
            const g = ((r.value - prev.value) / Math.abs(prev.value)) * 100;
            yoy = `${g >= 0 ? '+' : ''}${g.toFixed(1)}%`;
        }
        return `<tr><td>FY ${esc(r.year)}</td><td>${esc(r.value === null ? '—' : m.fmt(r.value))}</td>` +
            (m.auxLabel ? `<td>${esc(r.aux || '—')}</td>` : '') + `<td>${esc(yoy)}</td></tr>`;
    }).join('');

    const faqs = [];
    if (latestVal !== null) faqs.push({
        q: `What is ${name}'s ${m.noun}?`,
        a: `${name} (${sym}) reported ${m.noun} of ${m.fmt(latestVal)} for fiscal year ${usable[0].year}, per its SEC filings.`
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
        .map((s) => `<a href="/stocks/${esc(sym)}/${s}">${esc(sym)} ${esc(METRICS[s].label.toLowerCase())}</a>`).join('');
    const faqHtml = faqs.map((f) =>
        `<h3 style="font-size:15.5px;margin:18px 0 6px">${esc(f.q)}</h3><p style="margin:0;font-size:14px;line-height:1.7;max-width:74ch">${esc(f.a)}</p>`).join('');
    const sourceUrl = secCompanyUrl(sym);
    const metricHub = slug === 'shares-outstanding' ? '/research/shares-outstanding' : slug === 'pe-ratio' ? '/research/pe-ratio-history' : null;
    const metricTool = slug === 'shares-outstanding' ? '/tools/dilution' : slug === 'pe-ratio' ? '/tools/company-comparison' : '/tools/dividend-safety';
    let interpretation = `${name} reported ${m.fmt(latestVal)} of ${m.noun} for fiscal ${usable[0]?.year}.`;
    if (oneYear !== null) interpretation += ` That was ${Math.abs(oneYear).toFixed(1)}% ${oneYear >= 0 ? 'higher' : 'lower'} than fiscal ${usable[1]?.year}.`;
    if (fiveYear !== null && fiveYearRow) interpretation += ` Compared with fiscal ${fiveYearRow.year}, the change was ${signedPct(fiveYear)}.`;
    if (slug === 'shares-outstanding') interpretation += oneYear > 0 ? ' A rising share count can dilute per-share ownership; the filings should be checked for issuance and stock-compensation details.' : oneYear < 0 ? ' A falling share count is consistent with net buybacks exceeding issuance over the period, though the filing should be checked for the components.' : ' The filed year-end share count was broadly unchanged.';
    if (slug === 'pe-ratio') interpretation += ' This is a fiscal-year-end price divided by diluted EPS—not a live valuation—and is omitted when annual EPS is not positive.';
    if (slug === 'dividend-history') interpretation += ' This page measures cash dividends reported in the cash-flow statement; the per-share figure is approximate and may differ from declared dividends.';
    const summaryCards = `<div class="seo-grid"><div class="seo-tile"><div class="l">Latest filed value</div><div class="v">${esc(latestVal === null ? '—' : m.fmt(latestVal))}</div></div><div class="seo-tile"><div class="l">One-year change</div><div class="v">${esc(signedPct(oneYear))}</div></div><div class="seo-tile"><div class="l">Change since ${esc(fiveYearRow?.year || y0)}</div><div class="v">${esc(signedPct(fiveYear))}</div></div><div class="seo-tile"><div class="l">Latest period end</div><div class="v" style="font-size:16px">${esc(usable[0]?.period || usable[0]?.year || '—')}</div></div></div>`;

    return head(title, description, canonical, jsonld) + nav('company') + `
<main class="seo-wrap">
  <div class="seo-crumbs"><a href="/stocks">Stocks</a> / <a href="/stocks/${esc(sym)}">${esc(sym)}</a> / ${esc(m.label)}</div>
  <h1 class="seo-h1">${esc(name)} ${esc(m.label)} <span style="color:var(--ink3);font-weight:600">${esc(y0)}–${esc(y1)}</span></h1>
  <p class="seo-sub">${esc(interpretation)}</p>
  ${summaryCards}
  ${trendSvg(all, `${name} ${m.label}`)}
  <div class="seo-section">
    <div style="overflow-x:auto"><table class="seo-table">
      <thead><tr><th>Fiscal year</th><th>${esc(m.label)}</th>${m.auxLabel ? `<th>${esc(m.auxLabel)}</th>` : ''}<th>Change (YoY)</th></tr></thead>
      <tbody>${trs}</tbody>
    </table></div>
    <p style="color:var(--ink3);font-size:12.5px;margin-top:8px">Source: ${esc(name)} SEC filings — ${esc(m.source)}. Computed deterministically; refreshed nightly${freshness ? ` (last updated ${esc(freshness)})` : ''}. <a href="${esc(sourceUrl)}" rel="noopener nofollow" target="_blank">Open ${esc(sym)} 10-K filings at SEC EDGAR</a> · <a href="/methodology" style="color:var(--ink3)">Methodology</a> · <a href="/stocks/${esc(sym)}/${esc(slug)}.csv">Download CSV</a>.</p>
  </div>
  <div class="seo-section"><h2>How to read this history</h2><p class="seo-about">${esc(interpretation)} Values remain missing when the cached filing does not disclose a comparable line item; they are never estimated. Stock splits, reorganizations and fiscal-calendar changes can reduce comparability.</p><p style="font-size:13px;color:var(--ink3)">Prepared and reviewed by the stockportfolio.pro research desk. Corrections: <a href="mailto:support@stockportfolio.pro">support@stockportfolio.pro</a>.</p></div>
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
  <div class="seo-section"><h2>Continue the research</h2><div class="seo-links"><a href="/research/dilution-scorecard">Download the US-company dilution scorecard</a>${RESEARCH_SYMBOLS.slice(0, 8).map((symbol) => `<a href="/stocks/${symbol}/shares-outstanding">${symbol} shares outstanding history</a>`).join('')}</div></div>
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
  <div class="seo-section"><h2>Go deeper</h2><div class="seo-links">${RESEARCH_SYMBOLS.map((symbol) => `<a href="/stocks/${symbol}/pe-ratio">${symbol} P/E ratio history</a>`).join('')}<a href="/screens/low-pe-stocks">Low P/E stock screen</a><a href="/compare">Compare two companies</a></div></div>
  <div class="seo-lock"><h3>Compare valuation with business quality</h3><p>A lower multiple is not automatically cheaper. Put margins, growth, returns and filed risks beside the valuation.</p><a class="seo-cta-btn" href="/compare">Compare two stocks free</a></div>
  <div class="seo-section"><h2>Sources and limitations</h2><p class="seo-about">Annual EPS comes from company 10-K income statements and fiscal-year-end prices from the adjusted monthly series in the local fundamentals cache. Corporate actions and unusual earnings can impair comparability. Verify the primary filing at <a href="https://www.sec.gov/edgar" rel="noopener nofollow" target="_blank">SEC EDGAR</a>; see <a href="/methodology">methodology</a>. Corrections: <a href="mailto:support@stockportfolio.pro">support@stockportfolio.pro</a>.</p></div>`;
    return researchScaffold({
        slug: 'pe-ratio-history', title: 'Historical P/E Ratios: Method, Examples & Company Data',
        description: 'Research historical P/E ratios using fiscal-year-end prices and diluted annual EPS, with transparent methodology and direct links to company histories.',
        h1: 'Historical P/E ratios, explained with filed data', intro: 'Use consistent fiscal-year snapshots to understand how a company’s earnings multiple changed—without confusing historical P/E with today’s valuation.', body,
        jsonld: { '@context': 'https://schema.org', '@type': 'CollectionPage', name: 'Historical P/E ratios', url: canonical, isBasedOn: 'https://www.sec.gov/edgar', publisher: { '@id': `${SITE}/#org` } }
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
// Pairs: each company with its 2 nearest same-sector neighbours by market cap
// (deduped, alphabetical canonical order). Built from the screener index so we
// never load 1,500 full fundamentals files.
let _pairs = null;
function comparePairs() {
    if (_pairs) return _pairs;
    const rows = aiChat.screenRows({ limit: 5000, maxLimit: 5000, sort_by: 'marketCapB' }).rows
        .filter((r) => r.marketCapB !== null && r.sector);
    const bySector = {};
    rows.forEach((r) => { (bySector[r.sector] = bySector[r.sector] || []).push(r); });
    const set = new Set();
    Object.values(bySector).forEach((list) => {
        list.sort((a, b) => b.marketCapB - a.marketCapB);
        list.forEach((r, i) => {
            // 4 nearest same-sector neighbours by market cap (was 2). Compare
            // pages are the highest-CTR surface in Search Console, so widen the
            // net — still similar-size, same-sector pairs, exactly what searchers
            // type ("X vs Y").
            [list[i + 1], list[i + 2], list[i + 3], list[i + 4]].forEach((p) => {
                if (!p) return;
                const [a, b] = [r.symbol, p.symbol].sort();
                set.add(`${a}-vs-${b}`);
            });
        });
    });
    _pairs = [...set];
    return _pairs;
}

// Full data-backed universe as datalist <option>s, market-cap sorted, memoized.
// value = "TICKER — Name" so the native datalist matches BOTH a ticker prefix
// (e.g. "CBRS") AND a company-name substring (e.g. "cerebras"); the picker JS
// (cmpExtractSym below) parses the leading ticker back out on submit. Only
// companies that actually have fundamentals are included, so a suggestion never
// leads to a 404 /compare page.
let _univOpts = null;
function universeOptions() {
    if (_univOpts !== null) return _univOpts;
    try {
        const rows = aiChat.screenRows({ limit: 5000, maxLimit: 5000, sort_by: 'marketCapB' }).rows;
        _univOpts = rows
            .filter((r) => r && r.symbol && r.name)
            .map((r) => `<option value="${esc(r.symbol + ' — ' + r.name)}">`)
            .join('');
    } catch (_) { _univOpts = ''; }
    return _univOpts;
}
// Shared client-side helper: turn a datalist value ("TICKER — Name" or a raw
// ticker the user typed) into a clean ticker. Inlined into each page's script.
const CMP_EXTRACT_SYM = `function cmpExtractSym(v){v=(v||'').split(' — ')[0];return v.toUpperCase().replace(/[^A-Z0-9.]/g,'');}`;

// ---- /compare hub: pick two tickers → the side-by-side + AI verdict ----
// Gives the "Compare" nav item a real home and works as a compare-hub SEO page.
function renderCompareIndex() {
    const canonical = `${SITE}/compare`;
    const title = 'Compare Any Two US Stocks — Fundamentals & AI Verdict';
    const description = 'Put any two US-listed companies side by side: revenue, margins, growth, P/E, ROE and red flags from SEC filings — plus an AI verdict on which is the stronger business and the cheaper stock. Free, no account.';
    const popular = [['AMD', 'NVDA'], ['AAPL', 'MSFT'], ['GOOGL', 'META'], ['AMZN', 'MSFT'], ['TSLA', 'F'], ['JPM', 'BAC'], ['KO', 'PEP'], ['V', 'MA'], ['AMD', 'INTC'], ['DIS', 'NFLX'], ['CRM', 'ORCL'], ['WMT', 'COST']];
    const popHtml = popular.map(([a, b]) => { const p = [a, b].slice().sort(); return `<a href="/compare/${p[0]}-vs-${p[1]}" style="display:inline-block;padding:8px 13px;border:1px solid var(--line);border-radius:999px;font-size:13.5px;font-weight:600;color:var(--ink);background:var(--surface)">${esc(a)} vs ${esc(b)}</a>`; }).join('');
    // Deduplicate browse links against popular pairs and cap at 200
    const popSet = new Set(popular.map(([a, b]) => { const [x, y] = [a, b].slice().sort(); return `${x}-vs-${y}`; }));
    const allPairs = comparePairs();
    const browsePairs = allPairs.filter((p) => !popSet.has(p)).slice(0, 200);
    const browseHtml = browsePairs.map((slug) => {
        const parts = slug.split('-vs-');
        return `<a href="/compare/${esc(slug)}" style="display:inline-block;padding:6px 11px;border:1px solid var(--line);border-radius:999px;font-size:12.5px;font-weight:500;color:var(--ink);background:var(--surface)">${esc(parts[0])} vs ${esc(parts[1])}</a>`;
    }).join('');
    const datalist = universeOptions();
    const jsonld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebPage', name: title, url: canonical, publisher: { '@id': `${SITE}/#org` } });
    return head(title, description, canonical, jsonld) + nav('compare') + `
<main class="seo-wrap">
  <div class="seo-crumbs"><a href="/stocks">Stocks</a> / Compare</div>
  <h1 class="seo-h1">Compare any two US stocks</h1>
  <p class="seo-sub">Side by side on the filed numbers &mdash; revenue, margins, growth, P/E, ROE, red flags &mdash; plus an AI verdict on which is the stronger business and the cheaper stock. Every figure from SEC filings, refreshed nightly.</p>
  <div class="seo-section" style="border:1px solid var(--line);border-radius:12px;background:var(--surface);padding:18px">
    <div style="display:flex;gap:10px;flex-wrap:wrap;align-items:center">
      <input id="cA" list="cmpDL" autocomplete="off" placeholder="Company or ticker — e.g. AMD" aria-label="First company or ticker" style="flex:1;min-width:150px;min-height:46px;padding:0 14px;border:1px solid var(--line);border-radius:9px;font-size:16px;background:var(--paper);color:var(--ink);text-transform:uppercase">
      <span style="color:var(--ink3);font-weight:700;font-size:14px">vs</span>
      <input id="cB" list="cmpDL" autocomplete="off" placeholder="Company or ticker — e.g. Nvidia" aria-label="Second company or ticker" style="flex:1;min-width:150px;min-height:46px;padding:0 14px;border:1px solid var(--line);border-radius:9px;font-size:16px;background:var(--paper);color:var(--ink);text-transform:uppercase">
      <datalist id="cmpDL">${datalist}</datalist>
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
  function go(){
    var a=cmpExtractSym(document.getElementById('cA').value);
    var b=cmpExtractSym(document.getElementById('cB').value);
    var err=document.getElementById('cErr');
    if(!a||!b){err.textContent='Enter two tickers to compare.';err.style.display='block';return;}
    if(a===b){err.textContent='Pick two different companies.';err.style.display='block';return;}
    var p=[a,b].sort();location.href='/compare/'+p[0]+'-vs-'+p[1];
  }
  document.getElementById('cGo').addEventListener('click',go);
  ['cA','cB'].forEach(function(id){document.getElementById(id).addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();go();}});});
})();
</script>` + footer();
}

function renderComparePage(pairSlug) {
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

    const canonical = `${SITE}/compare/${a}-vs-${b}`;
    const title = `${a} vs ${b} Stock: Which Is the Better Buy?`;
    const description = `${ma.name} (${a}) vs ${mb.name} (${b}) — side-by-side revenue, margins, growth, P/E, ROE and dividends from SEC filings. Which fundamentals look stronger?`;

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
    const jsonld = JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
            { '@type': 'WebPage', name: title, url: canonical },
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
            .filter((r) => r.symbol && r.symbol !== a && r.symbol !== b && r.marketCapB != null)
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
    const datalist = universeOptions(); // full universe so any company (incl. recent IPOs) is searchable by name or ticker
    const swapHtml = related.length ? `
  <div class="seo-section" style="margin:22px 0">
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;border:1px solid var(--line);border-radius:10px;background:var(--surface);padding:12px 14px">
      <span style="font-size:13.5px;color:var(--ink2);font-weight:600">Compare with another company:</span>
      <input id="cmpAdd" list="cmpPeers" autocomplete="off" placeholder="company or ticker, e.g. ${esc(dlSyms[0] || 'MSFT')}" style="flex:1;min-width:150px;min-height:44px;padding:0 12px;border:1px solid var(--line);border-radius:8px;font-size:16px;background:var(--paper);color:var(--ink)">
      <datalist id="cmpPeers">${datalist}</datalist>
      <button type="button" onclick="cmpGo('${esc(a)}')" style="min-height:44px;padding:0 16px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink);font-size:14px;font-weight:600;cursor:pointer">vs ${esc(a)}</button>
      <button type="button" onclick="cmpGo('${esc(b)}')" style="min-height:44px;padding:0 16px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink);font-size:14px;font-weight:600;cursor:pointer">vs ${esc(b)}</button>
    </div>
  </div>
  <script>
  ${CMP_EXTRACT_SYM}
  function cmpGo(base){var el=document.getElementById('cmpAdd');var v=cmpExtractSym(el.value);if(!v||v===base)return;var p=[base,v].sort();location.href='/compare/'+p[0]+'-vs-'+p[1];}
  document.getElementById('cmpAdd').addEventListener('keydown',function(e){if(e.key==='Enter'){e.preventDefault();cmpGo('${esc(a)}');}});
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
        var excerpt=res.j.verdict.replace(/\s+/g,' ').slice(0,220),shareTitle='${esc(a)} vs ${esc(b)} AI verdict';
        document.getElementById('aivx').onclick=function(){window.open('https://twitter.com/intent/tweet?text='+encodeURIComponent(shareTitle+'\n\n'+excerpt)+'&url='+encodeURIComponent(location.href),'_blank','noopener,noreferrer,width=720,height=520');};
        document.getElementById('aivcopy').onclick=function(){var text=shareTitle+'\n\n'+res.j.verdict+'\n\n'+location.href;navigator.clipboard?navigator.clipboard.writeText(text):window.prompt('Copy this verdict',text);this.textContent='Copied';};
        btn.style.display='none';
      }).catch(function(e){
        out.innerHTML='<p style="font-size:13.5px;color:var(--ink3);margin:0">Something went wrong &mdash; please try again.</p>';
        btn.disabled=false;btn.textContent=orig;
      });
    });
  })();
  </script>`;

    return { html: head(title, description, canonical, jsonld) + nav('compare') + `
<main class="seo-wrap">
  <style>@media (max-width:560px){.cmp-table{table-layout:fixed;width:100%}.cmp-table th,.cmp-table td{padding:8px 7px;font-size:12.5px;white-space:normal;overflow-wrap:anywhere;word-break:break-word}.cmp-table th:first-child,.cmp-table td:first-child{width:40%}.cmp-table th:nth-child(n+2),.cmp-table td:nth-child(n+2){width:30%}}</style>
  <div class="seo-crumbs"><a href="/stocks">Stocks</a> / ${esc(a)} vs ${esc(b)}</div>
  <h1 class="seo-h1">${esc(a)} vs ${esc(b)}: Which Stock Is the Better Buy?</h1>
  <p class="seo-sub">${esc(ma.name)} and ${esc(mb.name)} side by side — fundamentals from SEC filings, refreshed nightly. Sector: ${esc(ma.sector)}${ma.sector !== mb.sector ? ` / ${esc(mb.sector)}` : ''}.</p>
  ${verdictHtml}
  ${verdictAi}
  <div class="seo-section">
    <div style="overflow-x:auto"><table class="seo-table cmp-table">
      <thead><tr><th>&nbsp;</th><th><a href="/stocks/${esc(a)}">${esc(ma.name)} (${esc(a)})</a></th><th><a href="/stocks/${esc(b)}">${esc(mb.name)} (${esc(b)})</a></th></tr></thead>
      <tbody>${trs}</tbody>
    </table></div>
  </div>
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

// ---------- router ----------
const router = express.Router();
router.get('/stocks/:ticker/:metric.csv', (req, res, next) => {
    const slug = String(req.params.metric || '').toLowerCase();
    if (!METRICS[slug]) return next();
    const csv = metricCsv(req.params.ticker, slug);
    if (!csv) return res.status(404).type('text/plain').send('Metric history not found.');
    const sym = String(req.params.ticker || '').toUpperCase().replace(/[^A-Z0-9.-]/g, '');
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${sym}-${slug}.csv"`, 'Cache-Control': 'public, max-age=3600' }).send(csv);
});
router.get('/stocks/:ticker/:metric', (req, res, next) => {
    const slug = String(req.params.metric || '').toLowerCase();
    if (!METRICS[slug]) return next();
    const html = renderMetricPage(req.params.ticker, slug);
    if (!html) return res.redirect(302, `/stocks/${encodeURIComponent(String(req.params.ticker).toUpperCase())}`);
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
});
router.get('/research/shares-outstanding', (_req, res) => res.type('html').send(renderSharesResearch()));
router.get('/research/pe-ratio-history', (_req, res) => res.type('html').send(renderPeResearch()));
router.get('/research/dilution-scorecard', (_req, res) => res.type('html').send(renderDilutionScorecard()));
router.get('/research/dilution-scorecard.csv', (_req, res) => {
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="stockportfolio-dilution-scorecard.csv"', 'Cache-Control': 'public, max-age=21600' }).send(dilutionCsv());
});
router.get('/compare', (req, res) => {
    res.set('Content-Type', 'text/html; charset=utf-8').send(renderCompareIndex());
});
router.get('/compare/:pair', (req, res) => {
    const out = renderComparePage(req.params.pair);
    if (!out) return res.redirect(302, '/stocks');
    if (out.redirect) return res.redirect(301, out.redirect);
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
    }
    comparePairs().forEach((p) => urls.push({ loc: `/compare/${p}`, pri: '0.4' }));
    Object.keys(SCREENS).forEach((s) => urls.push({ loc: `/screens/${s}`, pri: '0.7' }));
    RESEARCH_ROUTES.forEach((route) => urls.push({ loc: route, pri: '0.8' }));
    return urls;
}

module.exports = {
    router, METRICS, METRIC_SLUGS, RESEARCH_ROUTES, sitemapUrls, comparePairs, SCREENS,
    renderMetricPage, renderComparePage, renderCompareIndex, metricCsv, dilutionRows, dilutionCsv,
    renderSharesResearch, renderPeResearch, renderDilutionScorecard
};
