// Public, server-rendered SEO landing pages — one per S&P 500 company.
// These are the organic-traffic engine: each /stocks/TICKER page targets
// long-tail searches ("AAPL stock fundamentals / analysis") with a freemium
// teaser (public-domain snapshot + a revenue/income preview) and a signup
// CTA. Full statements, charts, and portfolio tools stay gated behind the
// paid app. Rendered from the nightly fundamentals cache on disk — no auth,
// no API call, in-memory cached.

const fs = require('fs');
const path = require('path');

const FRONTEND = path.join(__dirname, '..', 'frontend');
const DATA = path.join(FRONTEND, 'data');
const FUND_DIR = path.join(DATA, 'fundamentals');
const SITE = 'https://www.stockportfolio.pro';
const CLARITY_ID = 'x0dsu053xa';
const GA_ID = 'G-4K10D2FPTT';

// ---- data loading (cached) ----
let _companies = null;
function loadCompanies() {
    if (_companies) return _companies;
    try {
        const raw = JSON.parse(fs.readFileSync(path.join(DATA, 'sp500-companies.json'), 'utf8'));
        const list = Array.isArray(raw) ? raw : (raw.companies || []);
        _companies = list
            .map((c) => ({ symbol: String(c.symbol || '').toUpperCase(), name: c.name || c.symbol, sector: c.sector || '' }))
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
    return data;
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
<link rel="stylesheet" href="/styles.css?v=20260610-1" />
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA_ID}',{anonymize_ip:true});</script>
<script type="text/javascript">if(location.hostname.endsWith("stockportfolio.pro"))(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","${CLARITY_ID}");</script>
${jsonld ? `<script type="application/ld+json">${jsonld}</script>` : ''}
<style>
  .seo-wrap{max-width:1000px;margin:0 auto;padding:16px}
  .seo-nav{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 16px;margin:14px auto;max-width:1000px;border:1px solid var(--border);border-radius:10px;background:var(--panel)}
  .seo-nav .brand{display:flex;align-items:center;gap:8px;font-weight:700}
  .seo-nav .brand img{width:22px;height:22px;border-radius:6px}
  .seo-cta-btn{background:var(--primary);color:#fff;padding:8px 16px;border-radius:8px;font-weight:600;text-decoration:none;font-size:13px}
  .seo-crumbs{font-size:12px;color:var(--muted);margin:8px 0 4px}
  .seo-crumbs a{color:var(--muted)}
  .seo-h1{font-size:clamp(24px,3vw,34px);font-weight:800;margin:6px 0 4px;letter-spacing:-.02em}
  .seo-sub{color:var(--muted);font-size:14px;margin:0 0 16px}
  .seo-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin:16px 0}
  .seo-tile{border:1px solid var(--border);border-radius:10px;padding:12px 14px;background:var(--panel-solid)}
  .seo-tile .l{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:var(--muted);font-weight:600}
  .seo-tile .v{font-size:18px;font-weight:700;margin-top:4px;font-variant-numeric:tabular-nums}
  .seo-section{margin:26px 0}
  .seo-section h2{font-size:19px;font-weight:700;margin:0 0 10px}
  .seo-table{width:100%;border-collapse:collapse;font-size:13.5px;font-variant-numeric:tabular-nums}
  .seo-table th,.seo-table td{padding:9px 12px;border-bottom:1px solid var(--border-soft);text-align:right}
  .seo-table th:first-child,.seo-table td:first-child{text-align:left}
  .seo-table thead th{color:var(--muted);font-size:12px;text-transform:uppercase;letter-spacing:.04em}
  .seo-lock{position:relative;border:1px solid var(--border);border-radius:12px;padding:26px 18px;text-align:center;background:linear-gradient(180deg,rgba(59,130,246,.06),transparent);margin:18px 0}
  .seo-lock h3{margin:0 0 6px;font-size:17px}
  .seo-lock p{margin:0 0 14px;color:var(--muted);font-size:14px;max-width:560px;margin-left:auto;margin-right:auto}
  .seo-about{color:var(--text);font-size:14px;line-height:1.7}
  .seo-links{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
  .seo-links a{font-size:12.5px;padding:5px 10px;border:1px solid var(--border);border-radius:999px;color:var(--text);text-decoration:none}
  .seo-links a:hover{border-color:var(--primary)}
  .seo-foot{max-width:1000px;margin:30px auto;padding:18px 16px;border-top:1px solid var(--border);color:var(--muted);font-size:12px}
  .seo-foot a{color:var(--muted)}
  .seo-disc{font-size:11.5px;color:var(--muted);margin-top:18px;line-height:1.6}
</style>
</head><body class="glass">`;
}

function nav() {
    return `<header class="seo-nav">
  <a class="brand" href="/"><img src="/Media/icon.png" alt="stockportfolio.pro logo" />stockportfolio.pro</a>
  <a class="seo-cta-btn" href="/register.html?plan=monthly">Start 7-day free trial</a>
</header>`;
}

function footer() {
    return `<footer class="seo-foot">
  <p><a href="/stocks">All stocks</a> &middot; <a href="/">Home</a> &middot; <a href="/demo">Live demo</a> &middot; <a href="/register.html?plan=monthly">Free trial</a> &middot; <a href="/privacy.html">Privacy</a> &middot; <a href="/terms.html">Terms</a></p>
  <p class="seo-disc">Data is provided for informational purposes only and may be delayed or inaccurate. stockportfolio.pro is an analysis and visualization tool and does not provide financial advice. &copy; 2026 stockportfolio.pro.</p>
</footer></body></html>`;
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
    const title = `${name} (${sym}) Stock Fundamentals, Financials & Analysis`;
    const metricBits = [
        mcap ? `Market cap ${money(mcap)}` : '',
        pe ? `P/E ${ratio(pe)}` : '',
        income[0] && income[0].totalRevenue ? `revenue ${money(income[0].totalRevenue)}` : ''
    ].filter(Boolean).join(', ');
    const description = `${name} (${sym}) fundamentals: ${metricBits || 'key financials'}. View income statement, balance sheet, cash flow and a price chart on stockportfolio.pro.`;

    const jsonld = JSON.stringify({
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

    // Teaser: revenue + net income, last up-to-4 years
    let teaserTable = '';
    if (income.length) {
        const yrs = income.slice(0, 4);
        const head2 = yrs.map((r) => `<th>${esc(String(r.fiscalDateEnding || '').slice(0, 4))}</th>`).join('');
        const revRow = yrs.map((r) => `<td>${money(r.totalRevenue)}</td>`).join('');
        const niRow = yrs.map((r) => `<td>${money(r.netIncome)}</td>`).join('');
        const gpRow = yrs.map((r) => `<td>${money(r.grossProfit)}</td>`).join('');
        teaserTable = `<div class="seo-section"><h2>${esc(name)} revenue &amp; earnings (annual)</h2>
          <table class="seo-table"><thead><tr><th>Metric</th>${head2}</tr></thead>
          <tbody>
            <tr><td>Revenue</td>${revRow}</tr>
            <tr><td>Gross profit</td>${gpRow}</tr>
            <tr><td>Net income</td>${niRow}</tr>
          </tbody></table></div>`;
    }

    // Internal links to other stocks (same sector first, then a spread) for crawlability
    const all = loadCompanies();
    const sameSector = all.filter((c) => c.sector === sector && c.symbol !== sym).slice(0, 12);
    const others = all.filter((c) => c.symbol !== sym && !sameSector.includes(c)).slice(0, 12);
    const linkPills = [...sameSector, ...others].slice(0, 20)
        .map((c) => `<a href="/stocks/${esc(c.symbol)}">${esc(c.symbol)}</a>`).join('');

    const about = desc ? `<div class="seo-section"><h2>About ${esc(name)}</h2><p class="seo-about">${esc(desc)}</p></div>` : '';
    const meta = [sector, industry, exchange].filter(Boolean).map(esc).join(' &middot; ');

    return head(title, description, canonical, jsonld) + nav() + `
<main class="seo-wrap">
  <div class="seo-crumbs"><a href="/stocks">Stocks</a> / ${esc(sym)}</div>
  <h1 class="seo-h1">${esc(name)} <span style="color:var(--muted);font-weight:600">(${esc(sym)})</span></h1>
  <p class="seo-sub">${meta || 'US-listed equity'}</p>
  <div class="seo-grid">${tiles}</div>
  ${teaserTable}
  <div class="seo-lock">
    <h3>See the full financials for ${esc(name)}</h3>
    <p>Full income statement, balance sheet and cash flow (28+ line items across multiple years), an interactive price &amp; market-cap chart, valuation ratios, and the ability to track ${esc(sym)} in your own portfolio.</p>
    <a class="seo-cta-btn" href="/register.html?plan=monthly">Start your 7-day free trial</a>
    <p style="margin-top:10px"><a href="/fundamentals.html?symbol=${esc(sym)}" style="color:var(--primary);font-size:13px">Open ${esc(sym)} in the full fundamentals view &rarr;</a></p>
  </div>
  ${about}
  <div class="seo-section"><h2>Explore more stocks</h2>
    <div class="seo-links">${linkPills}</div>
    <p style="margin-top:10px"><a href="/stocks" style="color:var(--primary)">Browse all 500+ companies &rarr;</a></p>
  </div>
</main>` + footer();
}

// ---- index page ----
function renderStockIndex() {
    const all = loadCompanies().slice().sort((a, b) => a.name.localeCompare(b.name));
    const bySector = {};
    all.forEach((c) => { (bySector[c.sector || 'Other'] = bySector[c.sector || 'Other'] || []).push(c); });
    const canonical = `${SITE}/stocks`;
    const title = 'Browse Stock Fundamentals for 500+ US Companies | stockportfolio.pro';
    const description = 'Free fundamentals, financials, and price data for 500+ S&P 500 companies. Search any ticker for revenue, earnings, valuation ratios, and statements.';
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
function buildSitemap() {
    const today = new Date().toISOString().slice(0, 10);
    const staticUrls = ['/', '/founding', '/demo', '/register.html', '/login.html', '/support.html', '/privacy.html', '/terms.html', '/stocks', '/vs/sharesight', '/vs/stock-rover', '/vs/simply-wall-st'];
    const urls = staticUrls.map((u) => ({ loc: SITE + u, pri: u === '/' ? '1.0' : '0.7' }));
    loadCompanies().forEach((c) => urls.push({ loc: `${SITE}/stocks/${c.symbol}`, pri: '0.6' }));
    const body = urls.map((u) => `  <url><loc>${u.loc}</loc><lastmod>${today}</lastmod><changefreq>weekly</changefreq><priority>${u.pri}</priority></url>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;
}

module.exports = { renderStockPage, renderStockIndex, buildSitemap, loadCompanies };
