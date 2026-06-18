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
        rows: (d) => ((d.balance || {}).annualReports || []).map((r) => ({ year: fyYear(r), value: num(r.commonStockSharesOutstanding) }))
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
                return { year: fyYear(r), value: v, aux: (v && sh) ? `$${(v / sh).toFixed(2)}` : null };
            });
        }
    },
    'pe-ratio': {
        label: 'P/E Ratio', noun: 'price-to-earnings ratio', fmt: (v) => ratio(v), source: 'fiscal-year-end price ÷ diluted EPS',
        rows: (d) => ((d.income || {}).annualReports || []).map((r) => {
            const e = num(r.dilutedEPS) !== null ? num(r.dilutedEPS) : num(r.eps);
            const c = closeAtFiscalEnd(d, r.fiscalDateEnding);
            const v = (e && e > 0 && c) ? c / e : null;
            return { year: fyYear(r), value: v };
        })
    }
};
const METRIC_SLUGS = Object.keys(METRICS);

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
        ? `${titleName} (${sym}) ${shortLabel}: ${m.fmt(latestVal)} (${y1}) — ${yrsSpan}-Year History`
        : `${titleName} (${sym}) ${shortLabel} History ${y0}–${y1}`;
    const description = `${name} (${sym}) annual ${m.noun} from ${y0} to ${y1}` +
        (latestVal !== null ? ` — latest: ${m.fmt(latestVal)}` : '') +
        (growth !== null ? `, ${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%/yr over ${yrsSpan} years` : '') +
        `. Table of ${m.noun} by year, computed from SEC filings.`;

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

    return head(title, description, canonical, jsonld) + nav() + `
<main class="seo-wrap">
  <div class="seo-crumbs"><a href="/stocks">Stocks</a> / <a href="/stocks/${esc(sym)}">${esc(sym)}</a> / ${esc(m.label)}</div>
  <h1 class="seo-h1">${esc(name)} ${esc(m.label)} <span style="color:var(--ink3);font-weight:600">${esc(y0)}–${esc(y1)}</span></h1>
  <p class="seo-sub">${esc(name)} (${esc(sym)}) annual ${esc(m.noun)} by fiscal year, computed from SEC filings.${growth !== null ? ` Compound growth ${growth >= 0 ? '+' : ''}${growth.toFixed(1)}%/yr over ${yrsSpan} years.` : ''}</p>
  <div class="seo-section">
    <div style="overflow-x:auto"><table class="seo-table">
      <thead><tr><th>Fiscal year</th><th>${esc(m.label)}</th>${m.auxLabel ? `<th>${esc(m.auxLabel)}</th>` : ''}<th>Change (YoY)</th></tr></thead>
      <tbody>${trs}</tbody>
    </table></div>
    <p style="color:var(--ink3);font-size:12.5px;margin-top:8px">Source: ${esc(name)} SEC filings — ${esc(m.source)}. Computed deterministically; refreshed nightly${freshness ? ` (last updated ${esc(freshness)})` : ''}. <a href="/methodology" style="color:var(--ink3)">Methodology</a>.</p>
  </div>
  <div class="seo-lock">
    <h3>See the full picture for ${esc(name)}</h3>
    <p>Complete income statement, balance sheet and cash flow with trend on every row, 48 quarters, ratios, health checks, and Ask — the SEC-grounded research assistant.</p>
    <a class="seo-cta-btn" href="/company?symbol=${esc(sym)}">Open the interactive view — free</a>
  </div>
  <div class="seo-section"><h2>${esc(name)} — frequently asked questions</h2>${faqHtml}</div>
  <div class="seo-section"><h2>More ${esc(sym)} financial history</h2>
    <div class="seo-links">${siblings}</div>
    <p style="margin-top:10px"><a href="/stocks/${esc(sym)}">Full ${esc(sym)} fundamentals page &rarr;</a> &middot; <a href="/stocks">All 1,500+ companies &rarr;</a></p>
  </div>
</main>` + footer();
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
    const title = `${a} vs ${b}: Fundamentals Compared (${ma.name} vs ${mb.name})`;
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
    const verdictHtml = vSent.length
        ? `<div style="border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:10px;background:var(--surface);padding:14px 16px;margin:8px 0 4px;font-size:14.5px;line-height:1.65;color:var(--ink)">${vSent.join(' ')} <span style="color:var(--ink3)">Full numbers below — the stronger figure on each row is in <span style="color:var(--pos);font-weight:650">green</span>.</span></div>`
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
    const datalist = dlSyms.slice(0, 20).map((s) => `<option value="${esc(s)}">`).join('');
    const swapHtml = related.length ? `
  <div class="seo-section" style="margin:22px 0">
    <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center;border:1px solid var(--line);border-radius:10px;background:var(--surface);padding:12px 14px">
      <span style="font-size:13.5px;color:var(--ink2);font-weight:600">Compare with another company:</span>
      <input id="cmpAdd" list="cmpPeers" autocomplete="off" placeholder="ticker, e.g. ${esc(dlSyms[0] || 'MSFT')}" style="flex:1;min-width:140px;padding:7px 10px;border:1px solid var(--line);border-radius:8px;font-size:13.5px;background:var(--paper);color:var(--ink)">
      <datalist id="cmpPeers">${datalist}</datalist>
      <button type="button" onclick="cmpGo('${esc(a)}')" style="padding:7px 12px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink);font-size:13px;font-weight:600;cursor:pointer">vs ${esc(a)}</button>
      <button type="button" onclick="cmpGo('${esc(b)}')" style="padding:7px 12px;border:1px solid var(--line);border-radius:8px;background:var(--paper);color:var(--ink);font-size:13px;font-weight:600;cursor:pointer">vs ${esc(b)}</button>
    </div>
  </div>
  <script>
  function cmpGo(base){var el=document.getElementById('cmpAdd');var v=(el.value||'').toUpperCase().replace(/[^A-Z0-9.]/g,'');if(!v||v===base)return;var p=[base,v].sort();location.href='/compare/'+p[0]+'-vs-'+p[1];}
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

    return { html: head(title, description, canonical, jsonld) + nav() + `
<main class="seo-wrap">
  <div class="seo-crumbs"><a href="/stocks">Stocks</a> / ${esc(a)} vs ${esc(b)}</div>
  <h1 class="seo-h1">${esc(a)} vs ${esc(b)}</h1>
  <p class="seo-sub">${esc(ma.name)} and ${esc(mb.name)} side by side — fundamentals from SEC filings, refreshed nightly. Sector: ${esc(ma.sector)}${ma.sector !== mb.sector ? ` / ${esc(mb.sector)}` : ''}.</p>
  ${verdictHtml}
  <div class="seo-section">
    <div style="overflow-x:auto"><table class="seo-table">
      <thead><tr><th>&nbsp;</th><th><a href="/stocks/${esc(a)}">${esc(ma.name)} (${esc(a)})</a></th><th><a href="/stocks/${esc(b)}">${esc(mb.name)} (${esc(b)})</a></th></tr></thead>
      <tbody>${trs}</tbody>
    </table></div>
  </div>
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
    }
};
const COL_DEFS = {
    revCagr5Pct: ['Rev growth (5y)', (v) => v === null ? '—' : `${v.toFixed(1)}%/yr`],
    netMarginPct: ['Net margin', (v) => v === null ? '—' : `${v.toFixed(1)}%`],
    roePct: ['ROE', (v) => v === null ? '—' : `${v.toFixed(1)}%`],
    divYieldPct: ['Dividend yield', (v) => v === null ? '—' : `${v.toFixed(2)}%`],
    pe: ['P/E', (v) => v === null ? '—' : v.toFixed(1)]
};

function renderScreenPage(slug) {
    const s = SCREENS[slug];
    if (!s) return null;
    const year = new Date().getFullYear();
    const { matched, rows } = aiChat.screenRows(s.args);
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
    const others = Object.keys(SCREENS).filter((k) => k !== slug)
        .map((k) => `<a href="/screens/${k}">${esc(SCREENS[k].h1)}</a>`).join('');
    return head(title, description, canonical, jsonld) + nav() + `
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
router.get('/stocks/:ticker/:metric', (req, res, next) => {
    const slug = String(req.params.metric || '').toLowerCase();
    if (!METRICS[slug]) return next();
    const html = renderMetricPage(req.params.ticker, slug);
    if (!html) return res.redirect(302, `/stocks/${encodeURIComponent(String(req.params.ticker).toUpperCase())}`);
    res.set('Content-Type', 'text/html; charset=utf-8').send(html);
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
    return urls;
}

module.exports = { router, METRICS, METRIC_SLUGS, sitemapUrls, comparePairs, SCREENS };
