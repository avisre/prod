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
        ? `${titleName} (${sym}) ${shortLabel}: ${m.fmt(latestVal)} (${y1})`
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
    const datalist = universeOptions();
    const jsonld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebPage', name: title, url: canonical, publisher: { '@id': `${SITE}/#org` } });
    return head(title, description, canonical, jsonld) + nav() + `
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
  <div class="seo-section" id="aiv" style="border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:12px;background:var(--surface);padding:16px 18px;margin:14px 0 4px">
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
        out.innerHTML='<div style="white-space:pre-wrap;font-size:14.5px;line-height:1.7;color:var(--ink)">'+safe+'</div><p style="margin:10px 0 0;font-size:11.5px;color:var(--ink3)">Computed from SEC-filed statements; the model writes the synthesis, never the numbers. Not investment advice.</p>';
        btn.style.display='none';
      }).catch(function(e){
        out.innerHTML='<p style="font-size:13.5px;color:var(--ink3);margin:0">Something went wrong &mdash; please try again.</p>';
        btn.disabled=false;btn.textContent=orig;
      });
    });
  })();
  </script>`;

    return { html: head(title, description, canonical, jsonld) + nav() + `
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
    return urls;
}

module.exports = { router, METRICS, METRIC_SLUGS, sitemapUrls, comparePairs, SCREENS };
