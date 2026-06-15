// Public, server-rendered SEO landing pages — one per S&P 500 company.
// These are the organic-traffic engine: each /stocks/TICKER page targets
// long-tail searches ("AAPL stock fundamentals / analysis") with a freemium
// teaser (public-domain snapshot + a revenue/income preview) and a signup
// CTA. Full statements, charts, and portfolio tools stay gated behind the
// paid app. Rendered from the nightly fundamentals cache on disk — no auth,
// no API call, in-memory cached.

const fs = require('fs');
const path = require('path');
const aiChat = require('./ai-chat'); // health checks + per-symbol metrics

const FRONTEND = path.join(__dirname, '..', 'frontend');
const DATA = path.join(FRONTEND, 'data');
const FUND_DIR = path.join(DATA, 'fundamentals');
const SITE = 'https://www.stockportfolio.pro';
const CLARITY_ID = 'x0dsu053xa';
const GA_ID = 'G-4K10D2FPTT';

// Site-level publisher entity, emitted on every SEO page. Gives Google a stable
// Organization to attach E-E-A-T / authorship to (YMYL finance now expects a
// verifiable publisher) — pages reference it by @id for author/publisher.
const ORG_LD = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Organization',
    '@id': `${SITE}/#org`, name: 'stockportfolio.pro', url: SITE,
    logo: `${SITE}/Media/icon.png`,
    description: 'US stock fundamentals, financial statements and analysis computed deterministically from official SEC filings (10-K/10-Q via EDGAR).',
    foundingDate: '2024',
    sameAs: ['https://www.sec.gov/edgar']
});

// ---- data loading (cached) ----
let _companies = null;
function loadCompanies() {
    if (_companies) return _companies;
    try {
        // Prefer the S&P 1500 universe (built by scripts/build-sp1500-list.js);
        // fall back to the original S&P 500 list.
        let file = path.join(DATA, 'sp1500-companies.json');
        if (!fs.existsSync(file)) file = path.join(DATA, 'sp500-companies.json');
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const list = Array.isArray(raw) ? raw : (raw.companies || []);
        _companies = list
            .map((c) => ({ symbol: String(c.symbol || '').toUpperCase(), name: c.name || c.symbol, sector: c.sector || '', index: c.index || '' }))
            .filter((c) => c.symbol);
    } catch (_) { _companies = []; }
    return _companies;
}

function symbolToFile(symbol) {
    return path.join(FUND_DIR, `${String(symbol || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')}.json`);
}

const _fundCache = new Map();
function loadFundamentals(symbol) {
    const key = String(symbol || '').toUpperCase();
    if (_fundCache.has(key)) return _fundCache.get(key);
    let data = null;
    try {
        const f = symbolToFile(key);
        if (fs.existsSync(f)) data = JSON.parse(fs.readFileSync(f, 'utf8'));
    } catch (_) { data = null; }
    _fundCache.set(key, data);
    // Fundamentals blobs run large; cap the map so a full-universe crawl can't
    // pin every symbol's payload in heap (was an unbounded OOM source).
    if (_fundCache.size > 300) _fundCache.delete(_fundCache.keys().next().value);
    return data;
}

// Honest "last updated" for a symbol = when the nightly cache last wrote its
// fundamentals file. Real freshness, not a fabricated date (Google penalises
// fake freshness). Returns a Date or null.
function fundamentalsMtime(symbol) {
    try { return fs.statSync(symbolToFile(symbol)).mtime; } catch (_) { return null; }
}
function fmtDate(d) {
    if (!d) return '';
    try { return d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' }); }
    catch (_) { return d.toISOString().slice(0, 10); }
}

// ---- formatting ----
function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function num(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function money(v) {
    const n = num(v); if (n === null) return '—';
    const a = Math.abs(n);
    if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
    if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
function price(v) { const n = num(v); return n === null ? '—' : `$${n.toFixed(2)}`; }
function pct(v) { const n = num(v); return n === null ? '—' : `${(n * 100).toFixed(2)}%`; }
function ratio(v) { const n = num(v); return n === null ? '—' : n.toFixed(2); }

function latestClose(data) {
    const ts = data?.daily?.['Time Series (Daily)'];
    if (!ts) return null;
    const days = Object.keys(ts).sort();
    const last = days[days.length - 1];
    return last ? num(ts[last]['4. close']) : null;
}

// ---- shared head/nav/footer ----
function head(title, description, canonical, jsonld) {
    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<meta name="robots" content="index, follow, max-image-preview:large" />
<link rel="canonical" href="${esc(canonical)}" />
<meta property="og:title" content="${esc(title)}" />
<meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(canonical)}" />
<meta property="og:type" content="website" />
<meta property="og:site_name" content="stockportfolio.pro" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(description)}" />
<link rel="icon" href="/Media/icon.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..750&display=swap" />
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA_ID}',{anonymize_ip:true});</script>
<script type="text/javascript">if(location.hostname.endsWith("stockportfolio.pro"))(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","${CLARITY_ID}");</script>
<script type="application/ld+json">${ORG_LD}</script>${jsonld ? `<script type="application/ld+json">${jsonld}</script>` : ''}
<style>
  /* v2 design system, self-contained (paper/ink; color = meaning only) */
  :root{--paper:#faf9f6;--surface:#fff;--ink:#1c1b18;--ink2:#5f5c55;--ink3:#8f8b82;--line:#e8e6e0;--line2:#d8d5cd;--accent:#1a4fd6;--pos:#1b7a4b;--neg:#b3261e}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font-family:'Inter',-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased;font-optical-sizing:auto}
  a{color:var(--accent);text-decoration:none}
  a:hover{color:#15409f}
  .seo-wrap{max-width:1000px;margin:0 auto;padding:16px}
  .seo-nav{position:sticky;top:0;z-index:9;display:flex;align-items:center;justify-content:space-between;gap:10px;padding:0 24px;height:60px;background:color-mix(in srgb,var(--paper) 92%,transparent);backdrop-filter:blur(10px);border-bottom:1px solid var(--line)}
  .seo-nav .brand{display:flex;align-items:center;gap:8px;font-weight:700;letter-spacing:-.025em;color:var(--ink);font-size:16px}
  .seo-nav .brand img{width:22px;height:22px;border-radius:6px}
  .seo-nav a{color:var(--ink2)}
  .seo-cta-btn{background:var(--ink);color:var(--paper) !important;padding:9px 16px;border-radius:9px;font-weight:600;text-decoration:none;font-size:13px}
  .seo-cta-btn:hover{background:#000}
  .seo-crumbs{font-size:12px;color:var(--ink3);margin:18px 0 4px}
  .seo-crumbs a{color:var(--ink3)}
  .seo-h1{font-size:clamp(28px,4vw,42px);font-weight:650;margin:6px 0 4px;letter-spacing:-.03em;line-height:1.08}
  .seo-sub{color:var(--ink2);font-size:14px;margin:0 0 16px}
  .seo-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0}
  .seo-tile{border:1px solid var(--line);border-radius:10px;padding:14px 16px;background:var(--surface)}
  .seo-tile .l{font-size:11px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink3);font-weight:600}
  .seo-tile .v{font-size:19px;font-weight:600;margin-top:4px;font-variant-numeric:tabular-nums;letter-spacing:-.015em}
  .seo-section{margin:40px 0}
  .seo-section h2{font-size:21px;font-weight:600;letter-spacing:-.015em;margin:0 0 12px}
  .seo-table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums;background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden}
  .seo-table th,.seo-table td{padding:9px 14px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
  .seo-table th:first-child,.seo-table td:first-child{text-align:left}
  .seo-table tbody tr:last-child td{border-bottom:0}
  .seo-table thead th{color:var(--ink3);font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;font-weight:600}
  .seo-lock{border:1px solid var(--line);border-radius:10px;padding:28px 18px;text-align:center;background:var(--surface);margin:18px 0}
  .seo-lock h3{margin:0 0 6px;font-size:17px;font-weight:600;letter-spacing:-.01em}
  .seo-lock p{margin:0 0 14px;color:var(--ink2);font-size:14px;max-width:560px;margin-left:auto;margin-right:auto}
  .seo-about{color:var(--ink);font-size:14.5px;line-height:1.75;max-width:74ch}
  .seo-links{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
  .seo-links a{font-size:12px;padding:4px 10px;border:1px solid var(--line);border-radius:999px;color:var(--ink2);background:var(--surface)}
  .seo-links a:hover{border-color:var(--ink3);color:var(--ink)}
  .seo-foot{max-width:1000px;margin:48px auto 0;padding:24px 16px 40px;border-top:1px solid var(--line);color:var(--ink3);font-size:12px}
  .seo-foot a{color:var(--ink2)}
  .seo-disc{font-size:11.5px;color:var(--ink3);margin-top:18px;line-height:1.6}
</style>
</head><body>`;
}

function nav() {
    return `<header class="seo-nav">
  <a class="brand" href="/"><img src="/Media/icon.png" alt="stockportfolio.pro logo" />stockportfolio.pro</a>
  <div style="display:flex;align-items:center;gap:16px">
    <a href="/stocks" style="font-size:13px;font-weight:500">Stocks</a>
    <a href="/screener" style="font-size:13px;font-weight:500">Screener</a>
    <a class="seo-cta-btn" href="/register?plan=monthly">Start 7-day free trial</a>
  </div>
</header>`;
}

function footer() {
    return `<footer class="seo-foot">
  <p><a href="/screens/dividend-stocks">Best dividend stocks</a> &middot; <a href="/screens/high-growth-stocks">Fastest-growing</a> &middot; <a href="/screens/most-profitable-stocks">Most profitable</a> &middot; <a href="/screens/low-pe-stocks">Low P/E value</a> &middot; <a href="/screens/quality-compounders">Quality compounders</a></p>
  <p><a href="/stocks">All stocks</a> &middot; <a href="/">Home</a> &middot; <a href="/screener">Free screener</a> &middot; <a href="/ask">Ask the AI analyst</a> &middot; <a href="/register?plan=monthly">Free trial</a> &middot; <a href="/methodology">Methodology</a> &middot; <a href="/editorial-policy">Editorial policy</a> &middot; <a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a></p>
  <p class="seo-disc">Compiled by the <strong>stockportfolio.pro</strong> research desk from companies&#39; official U.S. SEC filings (10-K/10-Q via <a href="https://www.sec.gov/edgar" rel="noopener nofollow" target="_blank">EDGAR</a>). All figures are computed deterministically from filed statements — no analyst estimates, no AI-guessed numbers, and no paid placement. See our <a href="/methodology">methodology</a> and <a href="/editorial-policy">editorial policy</a>.</p>
  <p class="seo-disc">Data is provided for informational purposes only and may be delayed or inaccurate. stockportfolio.pro is an analysis and visualization tool and does not provide financial advice. &copy; 2026 stockportfolio.pro.</p>
</footer><script>try{var pv=JSON.stringify({path:location.pathname});(navigator.sendBeacon&&navigator.sendBeacon('/api/track/page_view',new Blob([pv],{type:'application/json'})))||fetch('/api/track/page_view',{method:'POST',headers:{'Content-Type':'application/json'},body:pv,keepalive:true}).catch(function(){})}catch(e){}</script></body></html>`;
}

// ---- stock page ----
function renderStockPage(ticker) {
    const sym = String(ticker || '').toUpperCase();
    const company = loadCompanies().find((c) => c.symbol === sym);
    const data = loadFundamentals(sym);
    if (!company && !data) return null;

    const ov = (data && data.overview) || {};
    const name = ov.Name || (company && company.name) || sym;
    const sector = ov.Sector || (company && company.sector) || '';
    const industry = ov.Industry || '';
    const exchange = ov.Exchange || '';
    const close = latestClose(data);
    const mcap = ov.MarketCapitalization;
    const pe = ov.PERatio;
    const eps = ov.EPS;
    const desc = ov.Description || '';
    const income = (data && data.income && data.income.annualReports) || [];

    const canonical = `${SITE}/stocks/${sym}`;
    const mtime = fundamentalsMtime(sym);
    const mtimeISO = mtime ? mtime.toISOString() : null;
    const freshness = fmtDate(mtime);
    // Metric + year-range words are the long-tail hooks searchers actually type
    // ("apple revenue by year", "{name} net income 2018").
    const fyOf = (r) => String((r || {}).fiscalDateEnding || '').slice(0, 4);
    const titleYears = income.length >= 2 ? `${fyOf(income[income.length - 1])}-${fyOf(income[0])}` : '';
    const title = titleYears
        ? `${name} (${sym}) Stock — Revenue, Net Income & Financials ${titleYears}`
        : `${name} (${sym}) Stock Fundamentals, Financials & Analysis`;
    const metricBits = [
        mcap ? `Market cap ${money(mcap)}` : '',
        pe ? `P/E ${ratio(pe)}` : '',
        income[0] && income[0].totalRevenue ? `revenue ${money(income[0].totalRevenue)}` : ''
    ].filter(Boolean).join(', ');
    const description = `${name} (${sym}) fundamentals: ${metricBits || 'key financials'}. View income statement, balance sheet, cash flow and a price chart on stockportfolio.pro.`;

    let jsonld = JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'BreadcrumbList',
                itemListElement: [
                    { '@type': 'ListItem', position: 1, name: 'Stocks', item: `${SITE}/stocks` },
                    { '@type': 'ListItem', position: 2, name: `${name} (${sym})`, item: canonical }
                ]
            },
            {
                '@type': 'Corporation',
                name,
                tickerSymbol: sym,
                ...(desc ? { description: desc.slice(0, 280) } : {}),
                url: canonical
            },
            {
                '@type': 'WebPage',
                '@id': canonical,
                url: canonical,
                name: title,
                ...(mtimeISO ? { dateModified: mtimeISO } : {}),
                isBasedOn: 'https://www.sec.gov/edgar',
                publisher: { '@id': `${SITE}/#org` },
                author: { '@id': `${SITE}/#org` }
            }
        ]
    });

    // Public snapshot tiles (all public-domain facts)
    const tiles = [
        ['Price', close !== null ? price(close) : (eps && pe ? price(num(eps) * num(pe)) : '—')],
        ['Market Cap', money(mcap)],
        ['P/E Ratio', ratio(pe)],
        ['EPS', eps ? price(eps) : '—'],
        ['Sector', sector || '—'],
        ['52-Week High', price(ov['52WeekHigh'])],
        ['52-Week Low', price(ov['52WeekLow'])],
        ['Dividend Yield', ov.DividendYield ? pct(ov.DividendYield) : '—']
    ].map(([l, v]) => `<div class="seo-tile"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div></div>`).join('');

    // Revenue + profit history — 10 years of crawlable text (we un-gate what
    // rivals lock; the interactive page has the full 19 yrs + quarters).
    let teaserTable = '';
    if (income.length) {
        const yrs = income.slice(0, 10).reverse(); // oldest → newest reads naturally
        const gpOf = (r) => {
            // Source years sometimes store a literal 0 for gross profit /
            // cost of revenue when undisclosed — derive or blank, never $0.
            const rev = num(r.totalRevenue);
            let gp = num(r.grossProfit); if (gp === 0) gp = null;
            let cor = num(r.costOfRevenue); if (cor === 0) cor = null;
            if (gp === null && rev !== null && cor !== null) gp = rev - cor;
            return gp;
        };
        const head2 = yrs.map((r) => `<th>${esc(String(r.fiscalDateEnding || '').slice(0, 4))}</th>`).join('');
        const revRow = yrs.map((r) => `<td>${money(r.totalRevenue)}</td>`).join('');
        const niRow = yrs.map((r) => `<td>${money(r.netIncome)}</td>`).join('');
        const gpRow = yrs.map((r) => { const g = gpOf(r); return `<td>${g === null ? '—' : money(g)}</td>`; }).join('');
        const nmRow = yrs.map((r) => {
            const rev = num(r.totalRevenue); const ni = num(r.netIncome);
            return `<td>${rev && ni !== null ? ((ni / rev) * 100).toFixed(1) + '%' : '—'}</td>`;
        }).join('');
        teaserTable = `<div class="seo-section"><h2>${esc(name)} revenue &amp; earnings — last ${yrs.length} fiscal years</h2>
          <div style="overflow-x:auto"><table class="seo-table"><thead><tr><th>Metric</th>${head2}</tr></thead>
          <tbody>
            <tr><td>Revenue</td>${revRow}</tr>
            <tr><td>Gross profit</td>${gpRow}</tr>
            <tr><td>Net income</td>${niRow}</tr>
            <tr><td>Net margin</td>${nmRow}</tr>
          </tbody></table></div>
          <p style="color:var(--muted);font-size:12.5px;margin-top:8px">Source: ${esc(name)} SEC filings (10-K). ${income.length > 10 ? `${income.length} years of history available in the interactive view.` : ''}</p></div>`;
    }

    // Plain-English financial health checks (✓/✗) — unique crawlable content.
    let healthBlock = '';
    let healthChecks = [];
    try {
        const hc = aiChat.runTool('get_health_checks', { symbol: sym });
        if (hc && Array.isArray(hc.checks) && hc.checks.length) {
            healthChecks = hc.checks;
            const passed = hc.checks.filter((c) => c.pass).length;
            const items = hc.checks.map((c) =>
                `<li style="background:var(--panel-solid);border:1px solid var(--border);border-radius:8px;padding:10px 14px;font-size:13.5px;list-style:none">` +
                `<span style="color:${c.pass ? '#34d399' : '#f87171'};font-weight:700;margin-right:6px">${c.pass ? '✓' : '✗'}</span>` +
                `${esc(c.label)}${c.detail ? ` <em style="color:var(--muted);font-style:normal;font-size:12px">(${esc(c.detail)})</em>` : ''}</li>`).join('');
            healthBlock = `<div class="seo-section"><h2>${esc(name)} financial health: ${passed} of ${hc.checks.length} checks passed</h2>
              <ul style="display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:8px;padding:0;margin:0">${items}</ul>
              <p style="color:var(--muted);font-size:12.5px;margin-top:8px">Checks computed deterministically from filed annual statements — no AI judgement.</p></div>`;
        }
    } catch (_) { /* page renders without checks */ }

    // FAQ block + FAQPage JSON-LD (the featured-snippet play).
    const metrics = aiChat.metricsFor(sym) || {};
    const latestInc = income[0] || {};
    const latestFY = String(latestInc.fiscalDateEnding || '').slice(0, 4);
    const revN = num(latestInc.totalRevenue); const niN = num(latestInc.netIncome);
    const revP = num((income[1] || {}).totalRevenue);
    const faqs = [];
    if (revN !== null) {
        const growth = (revP && revP !== 0) ? ((revN - revP) / Math.abs(revP) * 100) : null;
        faqs.push({
            q: `What is ${name}'s revenue?`,
            a: `${name} (${sym}) reported revenue of ${money(revN)} for fiscal year ${latestFY}` +
                (growth !== null ? `, ${growth >= 0 ? 'up' : 'down'} ${Math.abs(growth).toFixed(1)}% from the prior year` : '') + ', according to its SEC filings.'
        });
    }
    if (niN !== null) {
        faqs.push({
            q: `Is ${name} profitable?`,
            a: niN > 0
                ? `Yes. ${sym} earned net income of ${money(niN)} in fiscal ${latestFY}` + (revN ? `, a net margin of ${((niN / revN) * 100).toFixed(1)}%` : '') + '.'
                : `No — ${sym} reported a net loss of ${money(niN)} in fiscal ${latestFY}.`
        });
    }
    if (num(pe) !== null) faqs.push({ q: `What is ${sym}'s P/E ratio?`, a: `${name} trades at a price-to-earnings ratio of about ${num(pe).toFixed(1)} based on the latest data in our nightly-refreshed cache.` });
    if (metrics.revCagr5Pct !== null && metrics.revCagr5Pct !== undefined) {
        faqs.push({ q: `How fast is ${name} growing?`, a: `${sym}'s revenue grew at roughly ${metrics.revCagr5Pct.toFixed(1)}% per year over the last five fiscal years (compound annual growth rate), computed from SEC-filed statements.` });
    }
    const divCheck = healthChecks.find((c) => c.label === 'Pays a dividend');
    if (divCheck) {
        faqs.push({
            q: `Does ${name} pay a dividend?`,
            a: divCheck.pass
                ? `Yes, ${sym} pays a dividend${ov.DividendYield ? ` — the yield is about ${pct(ov.DividendYield)}` : ''}.`
                : `${sym} does not pay a dividend based on its most recent filings.`
        });
    }
    // PAA-style additions from data already on hand: debt, gross margin,
    // market cap, fiscal year end.
    const bal0 = ((data && data.balance && data.balance.annualReports) || [])[0] || {};
    const ltd = num(bal0.longTermDebt) !== null ? num(bal0.longTermDebt) : num(bal0.longTermDebtNoncurrent);
    const std = num(bal0.shortTermDebt) !== null ? num(bal0.shortTermDebt) : num(bal0.currentDebt);
    if (ltd !== null || std !== null) {
        const balFY = String(bal0.fiscalDateEnding || '').slice(0, 4) || latestFY;
        faqs.push({
            q: `How much debt does ${name} have?`,
            a: `As of fiscal year ${balFY}, ${sym} carried roughly ${money((ltd || 0) + (std || 0))} in total debt (short- plus long-term borrowings), per its filed balance sheet.`
        });
    }
    {
        let gp = num(latestInc.grossProfit); if (gp === 0) gp = null;
        let cor = num(latestInc.costOfRevenue); if (cor === 0) cor = null;
        if (gp === null && revN !== null && cor !== null) gp = revN - cor;
        if (gp !== null && revN) faqs.push({
            q: `What is ${name}'s gross margin?`,
            a: `${sym}'s gross margin was ${((gp / revN) * 100).toFixed(1)}% in fiscal ${latestFY} — gross profit of ${money(gp)} on revenue of ${money(revN)}.`
        });
    }
    if (num(mcap) !== null) faqs.push({
        q: `What is ${name}'s market cap?`,
        a: `${name} (${sym}) has a market capitalization of about ${money(mcap)}, based on the latest data in our nightly-refreshed cache.`
    });
    {
        // overview.FiscalYearEnd is blank in SEC-sourced caches — derive the
        // month from the latest annual report's fiscalDateEnding instead.
        const fyMonth = (() => {
            const mIdx = parseInt(String(latestInc.fiscalDateEnding || '').slice(5, 7), 10);
            const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
            return (mIdx >= 1 && mIdx <= 12) ? names[mIdx - 1] : (ov.FiscalYearEnd || '');
        })();
        if (fyMonth) faqs.push({
            q: `When does ${name}'s fiscal year end?`,
            a: `${sym}'s fiscal year ends in ${fyMonth}. Its most recent annual filing covers the fiscal year ending ${latestInc.fiscalDateEnding || latestFY}.`
        });
    }
    // Reverse DCF — "what growth is priced in" (unique crawlable angle: the
    // anti-black-box valuation block; assumptions stated inline).
    let rdcfBlock = '';
    try {
        const rd = require('./reverse-dcf').computeFromData(sym, data);
        if (rd && !rd.error && rd.impliedGrowthPct !== null) {
            const a = rd.assumptions; const rec = rd.record || {};
            const recBits = [
                rec.fcfCagr5Pct !== null ? `free cash flow actually grew ${rec.fcfCagr5Pct}%/yr over the last five fiscal years` : '',
                rec.revCagr5Pct !== null ? `revenue ${rec.revCagr5Pct}%/yr` : ''
            ].filter(Boolean).join(' and ');
            const sentence = `At today's market cap of ${money(rd.marketCap)}, ${name} is priced for free-cash-flow growth of about ${rd.impliedGrowthPct}% per year for ${a.horizonYears} years (assuming a ${a.discountRatePct}% discount rate and ${a.terminalGrowthPct}% terminal growth, base FCF ${money(rd.fcfBase)} from the ${rd.fcfBasis}).${recBits ? ` For comparison, ${recBits}, computed from its SEC filings.` : ''}`;
            rdcfBlock = `<div class="seo-section"><h2>What growth is priced into ${esc(sym)} stock?</h2>
              <p style="margin:0;color:var(--text);font-size:14px;line-height:1.7;max-width:74ch">${esc(sentence)} This is a reverse DCF — a translation of the price into a growth assumption you can judge, not a fair value and not advice. <a href="/company?symbol=${esc(sym)}">Change the assumptions yourself in the interactive view &rarr;</a></p></div>`;
            faqs.push({
                q: `What growth is priced into ${sym} stock?`,
                a: sentence
            });
        }
    } catch (_) { /* page renders without the block */ }
    faqs.push({ q: 'Where does this data come from?', a: `All figures are computed from ${name}'s official SEC filings (10-K and 10-Q), covering ${income.length} years of history, refreshed nightly. stockportfolio.pro does not provide investment advice.` });
    const faqBlock = `<div class="seo-section"><h2>${esc(name)} — frequently asked questions</h2>` +
        faqs.map((f) => `<h3 style="font-size:15.5px;margin:18px 0 6px">${esc(f.q)}</h3><p style="margin:0;color:var(--text);font-size:14px;line-height:1.7;max-width:74ch">${esc(f.a)}</p>`).join('') + '</div>';
    const faqLdTag = `<script type="application/ld+json">${JSON.stringify({
        '@context': 'https://schema.org', '@type': 'FAQPage',
        mainEntity: faqs.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } }))
    })}</script>`;

    // Internal links to other stocks (same sector first, then a spread) for crawlability.
    // Filter by the company-list sector (GICS), not ov.Sector — fundamentals use a
    // different taxonomy ("Technology" vs "Information Technology"), which otherwise
    // matches nothing and silently drops every same-sector link.
    const all = loadCompanies();
    const peerSector = (company && company.sector) || sector;
    // Large-cap peers first (S&P 500 > 400 > 600) so links land on recognizable
    // names, not alphabetical micro-caps.
    const idxRank = { sp500: 0, sp400: 1, sp600: 2 };
    const sameSector = all.filter((c) => c.sector === peerSector && c.symbol !== sym)
        .sort((a, b) => (idxRank[a.index] ?? 3) - (idxRank[b.index] ?? 3)).slice(0, 12);
    const others = all.filter((c) => c.symbol !== sym && !sameSector.includes(c)).slice(0, 12);
    const linkPills = [...sameSector, ...others].slice(0, 20)
        .map((c) => `<a href="/stocks/${esc(c.symbol)}">${esc(c.symbol)}</a>`).join('');

    const about = desc ? `<div class="seo-section"><h2>About ${esc(name)}</h2><p class="seo-about">${esc(desc)}</p></div>` : '';
    const meta = [sector, industry, exchange].filter(Boolean).map(esc).join(' &middot; ');

    // Lead summary — one-sentence synthesis of the numbers. "Information gain":
    // a citable takeaway above the fold for crawlers and AI answer engines, the
    // signal the 2026 core updates reward. All deterministic from filed data.
    const leadGrowth = (revP && revP !== 0 && revN !== null) ? ((revN - revP) / Math.abs(revP) * 100) : null;
    const leadBits = [];
    if (revN !== null) leadBits.push(`posted ${money(revN)} in revenue for fiscal ${latestFY}` + (leadGrowth !== null ? ` (${leadGrowth >= 0 ? 'up' : 'down'} ${Math.abs(leadGrowth).toFixed(1)}% year over year)` : ''));
    if (niN !== null && revN && niN >= 0) leadBits.push(`at a ${((niN / revN) * 100).toFixed(1)}% net margin`);
    else if (niN !== null && niN < 0) leadBits.push(`with a net loss of ${money(Math.abs(niN))}`);
    if (metrics.revCagr5Pct !== null && metrics.revCagr5Pct !== undefined) leadBits.push(`and has compounded revenue about ${metrics.revCagr5Pct.toFixed(1)}%/yr over five years`);
    const leadSentence = leadBits.length ? `${name} (${sym}) ${leadBits.join(', ')}, per its SEC filings.` : '';
    const leadHtml = leadSentence ? `<p class="seo-about" style="margin:8px 0 4px">${esc(leadSentence)}</p>` : '';
    const freshHtml = freshness ? `<p style="font-size:12px;color:var(--ink3);margin:2px 0 16px">Data last refreshed ${esc(freshness)} from SEC filings &middot; <a href="/methodology" style="color:var(--ink3)">how we compute this</a></p>` : '';

    // Per-metric history pages (seo-extra) — linked here so crawlers discover
    // them from every ticker page, not just the sitemap. Lazy require: this
    // module loads before seo-extra.
    let metricBlock = '';
    try {
        const extra = require('./seo-extra');
        const links = extra.METRIC_SLUGS
            .map((s) => `<a href="/stocks/${esc(sym)}/${s}">${esc(sym)} ${esc(extra.METRICS[s].label.toLowerCase())}</a>`).join('');
        metricBlock = `<div class="seo-section"><h2>${esc(name)} financial history by metric</h2><div class="seo-links">${links}</div></div>`;
    } catch (_) { /* seo-extra unavailable — page renders without the block */ }

    // Head-to-head compare pages (seo-extra) — link the top same-sector peers so
    // crawlers reach /compare/* contextually, not just via the sitemap. Use the
    // alphabetical canonical order ([a,b].sort()) so these don't 301.
    let compareBlock = '';
    if (sameSector.length) {
        const cmp = sameSector.slice(0, 8).map((c) => {
            const [a, b] = [sym, String(c.symbol).toUpperCase()].sort();
            return `<a href="/compare/${esc(a)}-vs-${esc(b)}">${esc(sym)} vs ${esc(c.symbol)}</a>`;
        }).join('');
        compareBlock = `<div class="seo-section"><h2>Compare ${esc(name)} with peers</h2><div class="seo-links">${cmp}</div></div>`;
    }

    return head(title, description, canonical, jsonld) + faqLdTag + nav() + `
<main class="seo-wrap">
  <div class="seo-crumbs"><a href="/stocks">Stocks</a> / ${esc(sym)}</div>
  <h1 class="seo-h1">${esc(name)} <span style="color:var(--muted);font-weight:600">(${esc(sym)})</span></h1>
  <p class="seo-sub">${meta || 'US-listed equity'}</p>
  ${leadHtml}
  ${freshHtml}
  <div class="seo-grid">${tiles}</div>
  ${teaserTable}
  ${healthBlock}
  ${rdcfBlock}
  <div class="seo-lock">
    <h3>Explore ${esc(String(income.length))} years of ${esc(name)} financials — interactive</h3>
    <p>Full income statement, balance sheet and cash flow with CAGR and trend on every row, 48 quarters, valuation ratios, plain-English health checks, and Ask — our SEC-grounded research assistant.</p>
    <a class="seo-cta-btn" href="/company?symbol=${esc(sym)}">Open the interactive view — free</a>
    <p style="margin-top:10px"><a href="/register?plan=monthly" style="font-size:13px">Or start a 7-day free trial to track ${esc(sym)} in your portfolio &rarr;</a></p>
  </div>
  ${metricBlock}
  ${compareBlock}
  ${about}
  ${faqBlock}
  <div class="seo-section"><h2>Explore more stocks</h2>
    <div class="seo-links">${linkPills}</div>
    <p style="margin-top:10px"><a href="/stocks" style="color:var(--primary)">Browse all 1,500+ companies &rarr;</a> &middot; <a href="/screener" style="color:var(--primary)">Screen them by fundamentals &rarr;</a></p>
  </div>
</main>` + footer();
}

// ---- index page ----
function renderStockIndex() {
    const all = loadCompanies().slice().sort((a, b) => a.name.localeCompare(b.name));
    const bySector = {};
    all.forEach((c) => { (bySector[c.sector || 'Other'] = bySector[c.sector || 'Other'] || []).push(c); });
    const canonical = `${SITE}/stocks`;
    const title = 'Browse Stock Fundamentals for 1,500+ US Companies | stockportfolio.pro';
    const description = 'Free fundamentals, financials, and price data for 1,500+ US companies (S&P 500, MidCap 400, SmallCap 600). Search any ticker for revenue, earnings, valuation ratios, and statements.';
    const jsonld = JSON.stringify({
        '@context': 'https://schema.org', '@type': 'CollectionPage',
        name: 'Stock fundamentals directory', url: canonical
    });
    const sectorBlocks = Object.keys(bySector).sort().map((sec) => {
        const links = bySector[sec].map((c) => `<a href="/stocks/${esc(c.symbol)}" title="${esc(c.name)}">${esc(c.symbol)} <span style="color:var(--muted)">${esc(c.name)}</span></a>`).join('');
        return `<div class="seo-section"><h2>${esc(sec)}</h2><div class="seo-links">${links}</div></div>`;
    }).join('');
    return head(title, description, canonical, jsonld) + nav() + `
<main class="seo-wrap">
  <h1 class="seo-h1">Stock fundamentals directory</h1>
  <p class="seo-sub">Revenue, earnings, valuation and financial statements for 500+ US-listed companies. Pick a ticker to see its snapshot, or start a free trial for full statements and portfolio tracking.</p>
  ${sectorBlocks}
</main>` + footer();
}

// ---- sitemap ----
// Clean paths only (the server resolves them), and no URLs that robots.txt
// disallows (/login, /register) — a sitemap pointing at blocked pages just
// generates Search Console errors and wastes crawl budget.
function buildSitemap() {
    const today = new Date().toISOString().slice(0, 10);
    const staticUrls = ['/', '/tour', '/stocks', '/screener', '/ask', '/support', '/methodology', '/editorial-policy', '/privacy', '/terms', '/sitemap'];
    const urls = staticUrls.map((u) => ({ loc: SITE + u, pri: u === '/' ? '1.0' : '0.7' }));
    urls.push({ loc: `${SITE}/gurus`, pri: '0.8' }); // guru 13F portfolios — marquee feature page
    urls.push({ loc: `${SITE}/monitor`, pri: '0.8' }); // filing change monitor — pro feature landing
    try { // competitor comparison pages — driven by the registry, not a hardcoded list
        require('./comparison-pages').competitors.forEach((s) => urls.push({ loc: `${SITE}/vs/${s}`, pri: '0.7' }));
    } catch (_) { /* module unavailable */ }
    loadCompanies().forEach((c) => urls.push({ loc: `${SITE}/stocks/${c.symbol}`, pri: '0.6' }));
    try { // metric histories, X-vs-Y comparisons, screen landing pages (seo-extra)
        require('./seo-extra').sitemapUrls().forEach((u) => urls.push({ loc: SITE + u.loc, pri: u.pri }));
    } catch (_) { /* seo-extra unavailable — base sitemap still valid */ }
    // the /tour page carries the 60-second product tour as its main content
    // (where Google can index it as a video) — declare it via the video sitemap
    // extension, attached to /tour, not the homepage.
    const tourVideo = `\n    <video:video>\n`
        + `      <video:thumbnail_loc>${SITE}/assets/tour-poster.jpg</video:thumbnail_loc>\n`
        + `      <video:title>stockportfolio.pro — 60-second product tour</video:title>\n`
        + `      <video:description>A one-minute tour of stockportfolio.pro: the SEC-grounded AI analyst, the free stock screener, and 19 years of filed fundamentals.</video:description>\n`
        + `      <video:content_loc>${SITE}/assets/tour-1080p.mp4</video:content_loc>\n`
        + `      <video:player_loc>${SITE}/tour</video:player_loc>\n`
        + `      <video:duration>63</video:duration>\n`
        + `    </video:video>`;
    const body = urls.map((u) => {
        const vid = u.loc === `${SITE}/tour` ? tourVideo : '';
        return `  <url><loc>${u.loc}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>${u.pri}</priority>${vid}</url>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">\n${body}\n</urlset>\n`;
}

// ---- helpers for the interactive company page's dynamic <head> ----
// Name lookup over the full US universe (~10.4k registrants), falling back to
// the S&P 1500 list. Lazy-loaded once.
let _usNames = null;
function companyName(symbol) {
    const sym = String(symbol || '').toUpperCase();
    const c = loadCompanies().find((x) => x.symbol === sym);
    if (c) return c.name;
    if (_usNames === null) {
        _usNames = new Map();
        try {
            const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'us-companies.json'), 'utf8'));
            (Array.isArray(raw) ? raw : (raw.companies || [])).forEach((x) => {
                if (x.symbol) _usNames.set(String(x.symbol).toUpperCase(), x.name || x.symbol);
            });
        } catch (_) { /* directory missing — sp1500 fallback above still works */ }
    }
    return _usNames.get(sym) || null;
}

// True when /stocks/SYM renders a real page (in the universe or cached on disk)
function hasStockPage(symbol) {
    const sym = String(symbol || '').toUpperCase();
    if (!sym) return false;
    if (loadCompanies().some((c) => c.symbol === sym)) return true;
    return fs.existsSync(symbolToFile(sym));
}

// ---- E-E-A-T pages (methodology + editorial policy) ----
// Honest, verifiable transparency pages. YMYL finance now expects a clear,
// checkable account of where numbers come from and how rankings are decided.
function renderMethodology() {
    const canonical = `${SITE}/methodology`;
    const title = 'Methodology — How stockportfolio.pro Computes Its Data';
    const description = 'Where our numbers come from (U.S. SEC filings via EDGAR), how each metric and screen is computed, our refresh cadence, and the limitations — full transparency on the data behind stockportfolio.pro.';
    const jsonld = JSON.stringify({
        '@context': 'https://schema.org', '@type': 'AboutPage', name: title, url: canonical,
        publisher: { '@id': `${SITE}/#org` }, isBasedOn: 'https://www.sec.gov/edgar'
    });
    const S = (h, body) => `<div class="seo-section"><h2>${h}</h2><div class="seo-about">${body}</div></div>`;
    return head(title, description, canonical, jsonld) + nav() + `
<main class="seo-wrap">
  <div class="seo-crumbs"><a href="/">Home</a> / Methodology</div>
  <h1 class="seo-h1">Methodology</h1>
  <p class="seo-sub">How stockportfolio.pro turns raw regulatory filings into the fundamentals, metrics, and screens you see — stated plainly so you can check our work.</p>
  ${S('Where the data comes from', `<p>Every financial figure on this site is computed from companies&#39; official filings with the U.S. Securities and Exchange Commission — annual reports (Form 10-K) and quarterly reports (Form 10-Q), sourced via <a href="https://www.sec.gov/edgar" rel="noopener nofollow" target="_blank">SEC EDGAR</a>. Prices come from end-of-day market data. We do not use analyst estimates, forecasts, or third-party &ldquo;adjusted&rdquo; numbers in the figures we report.</p>`)}
  ${S('Coverage &amp; history', `<p>We cover 1,500+ US-listed companies in the per-stock pages (S&amp;P 500, MidCap 400, SmallCap 600) and 3,800+ in the screener, with up to 19 fiscal years of history per company where filings exist.</p>`)}
  ${S('How often it updates', `<p>The fundamentals cache is rebuilt nightly. Each stock and metric page shows the date its underlying data was last refreshed. Newly filed 10-Ks and 10-Qs flow in on the next nightly build.</p>`)}
  ${S('How metrics are computed', `<p>All metrics are deterministic functions of filed line items — no AI, no editorial judgement, no hand-tuning:</p>
    <ul>
      <li><strong>Revenue, net income, gross profit, EBITDA</strong> — taken directly from the income statement; gross profit is derived as revenue minus cost of revenue when not separately disclosed.</li>
      <li><strong>Margins</strong> — net margin = net income ÷ revenue; gross margin = gross profit ÷ revenue, for the same fiscal year.</li>
      <li><strong>Growth (CAGR)</strong> — compound annual growth rate between the first and last fiscal year of the window, not an average of yearly changes.</li>
      <li><strong>Free cash flow</strong> — operating cash flow minus capital expenditure (capex sign normalised across filing sources).</li>
      <li><strong>P/E history</strong> — fiscal-year-end adjusted close ÷ diluted EPS for that year.</li>
      <li><strong>Reverse DCF</strong> — solves for the free-cash-flow growth rate the current market cap implies, with the discount rate, horizon, and terminal growth stated inline on each page. It is a translation of price into an assumption you can judge — not a fair value and not advice.</li>
    </ul>`)}
  ${S('Financial health checks', `<p>The pass/fail health checks (profitability, debt, cash flow, dividend coverage, etc.) are fixed rules applied to the filed statements — the same thresholds for every company. They describe what the filings say; they are not buy/sell signals.</p>`)}
  ${S('What we don&#39;t do', `<p>We don&#39;t publish price targets, we don&#39;t accept payment for placement in any ranking or screen, and we don&#39;t present opinion as data. Figures can still be delayed or contain source errors — see our <a href="/editorial-policy">editorial policy</a> for corrections, and always verify against the primary filing before acting.</p>`)}
  <div class="seo-section"><p style="font-size:13px"><a href="/editorial-policy">Editorial policy &amp; independence &rarr;</a> &middot; <a href="/stocks">Browse stocks &rarr;</a> &middot; <a href="/screener">Free screener &rarr;</a></p></div>
</main>` + footer();
}

function renderEditorialPolicy() {
    const canonical = `${SITE}/editorial-policy`;
    const title = 'Editorial Policy & Independence — stockportfolio.pro';
    const description = 'Our independence, how rankings and screens are decided, our corrections process, affiliate disclosure, and why nothing here is investment advice.';
    const jsonld = JSON.stringify({
        '@context': 'https://schema.org', '@type': 'AboutPage', name: 'Editorial Policy & Independence', url: canonical,
        publisher: { '@id': `${SITE}/#org` }
    });
    const S = (h, body) => `<div class="seo-section"><h2>${h}</h2><div class="seo-about">${body}</div></div>`;
    return head(title, description, canonical, jsonld) + nav() + `
<main class="seo-wrap">
  <div class="seo-crumbs"><a href="/">Home</a> / Editorial policy</div>
  <h1 class="seo-h1">Editorial policy &amp; independence</h1>
  <p class="seo-sub">How stockportfolio.pro decides what to show, keeps it independent, and fixes mistakes.</p>
  ${S('Independence', `<p>stockportfolio.pro is an independent analysis tool. No company can pay to appear, rank higher, or be presented more favourably in any stock page, comparison, screen, or list. Rankings and screens are produced by deterministic filters over filed fundamentals — never by editorial selection or commercial relationship.</p>`)}
  ${S('How rankings and screens work', `<p>Every &ldquo;best / fastest / most&rdquo; list is the output of a stated, reproducible filter (for example, &ldquo;dividend yield ≥ 2.5% and profitable in ≥ 8 of the last 10 years, sorted by yield&rdquo;). The criteria are shown on each page. Run the same filter yourself in the <a href="/screener">free screener</a> to verify.</p>`)}
  ${S('Corrections', `<p>If a figure looks wrong, it usually traces to the source filing or a data-vendor mapping. We correct confirmed errors on the next nightly build. Report an issue at <a href="mailto:avinashsreekumar007@gmail.com">avinashsreekumar007@gmail.com</a> with the ticker and the figure, and we&#39;ll investigate.</p>`)}
  ${S('Disclosures', `<p>Some outbound links (for example to brokers or partner tools) may be affiliate links that earn us a commission at no cost to you. Affiliate relationships never influence which companies&#39; data we show or how any ranking is computed.</p>`)}
  ${S('Not investment advice', `<p>Everything here is information and analysis for research and education only. It is not investment, financial, tax, or legal advice, and not a recommendation to buy or sell any security. Markets carry risk; do your own research and consider a licensed professional before investing.</p>`)}
  <div class="seo-section"><p style="font-size:13px"><a href="/methodology">How we compute our data &rarr;</a> &middot; <a href="/stocks">Browse stocks &rarr;</a></p></div>
</main>` + footer();
}

module.exports = {
    renderStockPage, renderStockIndex, buildSitemap, loadCompanies, companyName, hasStockPage,
    renderMethodology, renderEditorialPolicy,
    // shared by seo-extra.js (metric pages / compare pages / screen pages)
    loadFundamentals, esc, num, money, price, pct, ratio, head, nav, footer
};
