// Public, server-rendered SEO landing pages — one per S&P 500 company.
// These are the organic-traffic engine: each /stocks/TICKER page targets
// long-tail searches ("AAPL stock fundamentals / analysis") with a freemium
// teaser (public-domain snapshot + a revenue/income preview) and a signup
// CTA. Full statements, charts, and portfolio tools stay gated behind the
// paid app. Rendered from the nightly fundamentals cache on disk — no auth,
// no API call, in-memory cached.

const fs = require('fs');
const path = require('path');
const fundDate = require('./fundamentals-date');
const fundStatus = require('./fundamentals-status');
const credits = require('./credits'); // the one source of credit prices (see COST)
const COST = credits.COST;
const aiChat = require('./ai-chat'); // health checks + per-symbol metrics
const { pixelHeadSnippet } = require('./pixels'); // env-driven retargeting (no-op when unset)
const { normalizeTicker } = require('./symbol-resolver');
const { loadFundamentals } = require('./fundamentals-cache');

const FRONTEND = path.join(__dirname, '..', 'frontend');
const DATA = path.join(FRONTEND, 'data');
const FUND_DIR = path.join(DATA, 'fundamentals');
const SITE = 'https://www.stockportfolio.pro';
const CLARITY_ID = 'x0dsu053xa';
const GA_ID = 'G-4K10D2FPTT';
const OG_IMAGE = `${SITE}/og.png`; // 1200×630 social card (frontend/og.png)

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

// Site-level product entity (FinanceApplication), emitted on every SEO page.
// offers mirror the live, publicly-advertised tiers (USD) — same prices the
// register page and index.html quote. No aggregateRating: we don't have a real
// review corpus yet, and inventing one is a structured-data violation.
const SOFTWARE_LD = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'SoftwareApplication',
    '@id': `${SITE}/#app`,
    name: 'stockportfolio.pro',
    applicationCategory: 'FinanceApplication',
    operatingSystem: 'Web',
    url: SITE,
    description: 'AI stock analyst grounded in SEC filings (10-K/10-Q): company fundamentals, screening, side-by-side comparisons and portfolio tracking for US stocks.',
    publisher: { '@id': `${SITE}/#org` },
    offers: {
        '@type': 'AggregateOffer', priceCurrency: 'USD', lowPrice: '0', highPrice: '1999.99',
        offerCount: 5,
        offers: [
            { '@type': 'Offer', name: 'Free', price: '0', priceCurrency: 'USD' },
            { '@type': 'Offer', name: 'Monthly', price: '24.99', priceCurrency: 'USD' },
            { '@type': 'Offer', name: 'Annual', price: '199.99', priceCurrency: 'USD' },
            { '@type': 'Offer', name: 'Pro', price: '499.99', priceCurrency: 'USD' },
            { '@type': 'Offer', name: 'Desk', price: '1999.99', priceCurrency: 'USD' }
        ]
    }
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

// Return the symbol used by the company directory, not merely the normalized
// input. This preserves class-share punctuation (BRK.B/BF.B) in canonicals
// while allowing the resolver's existing dash/dot/slash/space equivalence.
function resolveCanonicalSymbol(input) {
    const normalized = normalizeTicker(input);
    if (!normalized) return null;
    const match = loadCompanies().find((company) => normalizeTicker(company.symbol) === normalized);
    if (match) return match.symbol;
    // Some supported securities are present in the fundamentals cache but not
    // in the curated directory. The normalized spelling still maps to the same
    // cache filename; use it only as a fallback and never create an alias.
    if (fs.existsSync(symbolToFile(normalized))) return normalized;
    return null;
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
// Empty cache fields mean "not disclosed", not zero. Number('') is 0, so a
// direct coercion created plausible-looking $0/EPS histories that Google quite
// reasonably treated as duplicate or low-value pages.
function num(v) {
    if (v === null || v === undefined || (typeof v === 'string' && !v.trim())) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
}
function money(v) {
    const n = num(v); if (n === null) return '—';
    const a = Math.abs(n);
    if (a >= 1e12) return `$${(n / 1e12).toFixed(2)}T`;
    if (a >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
    if (a >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
    return `$${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}
function price(v) { const n = num(v); return n === null ? '—' : `$${n.toFixed(2)}`; }

// SERP length budget, shared by the SSR head builders (seo-extra.js and app.js
// require it from here). Bing's URL Inspection files a title over 70 characters
// as "Title too long" and a description outside 25-160 as out of range; a long
// registered name ("Zions Bancorporation, National Association") crosses those
// limits on its own, so the name gives up room first — clipped on a word
// boundary, never mid-word. The full name stays in the H1 and page body.
function clipName(name, room) {
    const s = String(name || '').trim();
    if (s.length <= room) return s;
    const clipped = room > 0 ? s.slice(0, room).replace(/\s+\S*$/, '').trim() : '';
    return clipped || s.split(/\s+/)[0];
}

// The legal-suffix stripper the stock, metric and pair pages share. The
// `(?:&|and)?` is load-bearing: without it "JPMorgan Chase & Co" strips down to a
// dangling "&" and "Becton, Dickinson and Company" to a dangling "and" — both
// shipped live in page titles before this was centralised (found 9/28).
function shortCompanyName(name) {
    return String(name || '').replace(/^The\s+/i, '')
        .replace(/,?\s+(?:&|and)?\s*(Incorporated|Corporation|Corp|Company|Co|Holdings|plc|Ltd|Limited|L\.?P|N\.?V|S\.?A|Inc)\.?$/i, '')
        .trim();
}
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
// `ask` ({ placeholder }) opts a server-rendered surface into the ask floor:
// the shared runtime mounts its ⌘K bar on <body data-ask-floor="1"> so every
// page this traffic lands on keeps Ask one keystroke away.
function head(title, description, canonical, jsonld, ask) {
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
<meta property="og:image" content="${OG_IMAGE}" />
<meta property="og:image:width" content="1200" />
<meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:title" content="${esc(title)}" />
<meta name="twitter:description" content="${esc(description)}" />
<meta name="twitter:image" content="${OG_IMAGE}" />
<link rel="icon" href="/Media/icon.png" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:opsz,wght@14..32,400..750&display=swap" />
<link rel="stylesheet" href="/assets/system.css?v=20260928-fundsearch" />
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA_ID}',{anonymize_ip:true});</script>
<script type="text/javascript">if(location.hostname.endsWith("stockportfolio.pro"))(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","${CLARITY_ID}");</script>
<script type="application/ld+json">${ORG_LD}</script>
<script type="application/ld+json">${SOFTWARE_LD}</script>${jsonld ? `<script type="application/ld+json">${jsonld}</script>` : ''}${pixelHeadSnippet()}
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
  .seo-crumbs a{color:var(--ink3);display:inline-block;padding:9px 2px}
  .seo-h1{font-size:clamp(28px,4vw,42px);font-weight:650;margin:6px 0 4px;letter-spacing:-.03em;line-height:1.08}
  .seo-sub{color:var(--ink2);font-size:14px;margin:0 0 16px}
  .seo-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin:20px 0}
  .seo-tile{border:1px solid var(--line);border-radius:10px;padding:14px 16px;background:var(--surface)}
  .seo-tile .l{font-size:11.5px;text-transform:uppercase;letter-spacing:.07em;color:var(--ink3);font-weight:600}
  .seo-tile .v{font-size:19px;font-weight:600;margin-top:4px;font-variant-numeric:tabular-nums;letter-spacing:-.015em}
  .seo-tile .n{font-size:11.5px;color:var(--ink3);margin-top:3px}
  .seo-section{margin:40px 0}
  .seo-section h2{font-size:21px;font-weight:600;letter-spacing:-.015em;margin:0 0 12px}
  .seo-table{width:100%;border-collapse:collapse;font-size:13px;font-variant-numeric:tabular-nums;background:var(--surface);border:1px solid var(--line);border-radius:10px;overflow:hidden}
  .seo-table th,.seo-table td{padding:9px 14px;border-bottom:1px solid var(--line);text-align:right;white-space:nowrap}
  .seo-table th:first-child,.seo-table td:first-child{text-align:left}
  .seo-table tbody tr:last-child td{border-bottom:0}
  .seo-table thead th{color:var(--ink3);font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;font-weight:600}
  .seo-table td a{display:inline-block;padding:6px 0;color:var(--ink)}
  .seo-lock{border:1px solid var(--line);border-radius:10px;padding:28px 18px;text-align:center;background:var(--surface);margin:18px 0}
  .seo-lock h3{margin:0 0 6px;font-size:17px;font-weight:600;letter-spacing:-.01em}
  .seo-lock p{margin:0 0 14px;color:var(--ink2);font-size:14px;max-width:560px;margin-left:auto;margin-right:auto}
  .seo-next-action{border:1px solid #c9d7f7;border-radius:10px;padding:22px 20px;background:#f4f7ff;margin:28px 0}
  .seo-next-action-kicker{margin:0 0 5px;color:var(--accent);font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase}
  .seo-next-action h2{margin:0 0 7px;font-size:19px;font-weight:650;letter-spacing:-.01em}
  .seo-next-action p:not(.seo-next-action-kicker){margin:0 0 14px;color:var(--ink2);font-size:14px;max-width:680px}
  .seo-about{color:var(--ink);font-size:14.5px;line-height:1.75;max-width:74ch}
  .seo-links{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px}
  .seo-links a{font-size:12px;padding:10px 12px;border:1px solid var(--line);border-radius:999px;color:var(--ink2);background:var(--surface)}
  .seo-links a:hover{border-color:var(--ink3);color:var(--ink)}
  .seo-foot{max-width:1000px;margin:48px auto 0;padding:24px 16px 40px;border-top:1px solid var(--line);color:var(--ink3);font-size:12px}
  .seo-foot a{color:var(--ink2)}.seo-foot a,.seo-about a,.seo-section p a{display:inline-block;padding:6px 2px}
  .seo-disc{font-size:11.5px;color:var(--ink3);margin-top:18px;line-height:1.6}
  @media(max-width:900px){.seo-nav{height:auto;min-height:58px;padding:10px 14px}.seo-nav-links{gap:10px!important}.seo-nav-links a{display:inline-block;padding:11px 2px}}@media(max-width:760px){.seo-nav{height:auto;min-height:58px;padding:10px 14px}.seo-nav-hide-mobile{display:none}.seo-cta-btn{padding:8px 11px}.seo-wrap{padding:12px}.seo-table th,.seo-table td{padding:8px 10px}.seo-section{margin:30px 0}.seo-crumbs a{display:inline-block;padding:9px 2px}}
</style>
</head><body${ask && ask.placeholder ? ` data-ask-floor="1" data-ask-placeholder="${esc(ask.placeholder)}"` : ''}>`;
}

function nav(current = '') {
    const active = ['screener', 'tools', 'compare', 'company', 'news', 'ask', 'dossier', 'monitor', 'dashboard', 'gurus', 'pricing'].includes(current)
        ? current
        : '';
    // SEO pages retain their own source-aware page-view beacon in footer().
    // The flag prevents the shared runtime from recording the same view twice.
    return `<script>window.__spSkipAutoPageView=true;</script><script src="/assets/app.js?v=20260928-fundsearch"></script><script>V2.nav(${JSON.stringify(active)});</script>`;
}

function footer() {
    return `<footer class="seo-foot">
  <p><a href="/screens/dividend-stocks">Best dividend stocks</a> &middot; <a href="/screens/high-growth-stocks">Fastest-growing</a> &middot; <a href="/screens/most-profitable-stocks">Most profitable</a> &middot; <a href="/screens/low-pe-stocks">Low P/E value</a> &middot; <a href="/screens/low-peg-stocks">Low PEG</a> &middot; <a href="/screens/highest-free-cash-flow-stocks">Highest free cash flow</a> &middot; <a href="/screens/stocks-below-book-value">Below book value</a> &middot; <a href="/screens/quality-compounders">Quality compounders</a></p>
  <p><a href="/stocks">All stocks</a> &middot; <a href="/tools">Free tools</a> &middot; <a href="/research/shares-outstanding">Shares research</a> &middot; <a href="/research/pe-ratio-history">P/E research</a> &middot; <a href="/research/dilution-scorecard">Dilution dataset</a> &middot; <a href="/">Home</a> &middot; <a href="/screener">Free screener</a> &middot; <a href="/ask">Ask the AI analyst</a> &middot; <a href="/register?plan=monthly">Free trial</a> &middot; <a href="/methodology">Methodology</a> &middot; <a href="/editorial-policy">Editorial policy</a> &middot; <a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a></p>
  <p class="seo-disc">Compiled by the <strong>stockportfolio.pro</strong> research desk from companies&#39; official U.S. SEC filings (10-K/10-Q via <a href="https://www.sec.gov/edgar" rel="noopener nofollow" target="_blank">EDGAR</a>). All figures are computed deterministically from filed statements — no analyst estimates, no AI-guessed numbers, and no paid placement. See our <a href="/methodology">methodology</a> and <a href="/editorial-policy">editorial policy</a>.</p>
  <p class="seo-disc">Data is provided for informational purposes only and may be delayed or inaccurate. stockportfolio.pro is an analysis and visualization tool and does not provide financial advice. &copy; 2026 stockportfolio.pro.</p>
</footer><script>try{var rm={'/research/shares-outstanding':'research-shares-outstanding','/research/pe-ratio-history':'research-pe-ratio-history','/research/dilution-scorecard':'research-dilution-scorecard'};var pv=JSON.stringify({path:location.pathname,contentId:rm[location.pathname]||null,referrer:document.referrer});(navigator.sendBeacon&&navigator.sendBeacon('/api/track/page_view',new Blob([pv],{type:'application/json'})))||fetch('/api/track/page_view',{method:'POST',headers:{'Content-Type':'application/json'},body:pv,keepalive:true}).catch(function(){})}catch(e){}</script></body></html>`;
}

// ---- stock page ----
// options.quote — a quote-store record ({ price, asOf, source }) fetched by the
// route. Optional: sync callers (tests, scripts) still work and fall back to the
// cached close, which the Price tile then labels as cached rather than current.
function renderStockPage(ticker, options = {}) {
    const sym = resolveCanonicalSymbol(ticker) || String(ticker || '').toUpperCase();
    const company = loadCompanies().find((c) => c.symbol === sym);
    const data = loadFundamentals(sym);
    if (!company && !data) return null;

    const ov = (data && data.overview) || {};
    const name = ov.Name || (company && company.name) || sym;
    const sector = ov.Sector || (company && company.sector) || '';
    const industry = ov.Industry || '';
    const exchange = ov.Exchange || '';
    const quote = options.quote && Number.isFinite(Number(options.quote.price)) ? options.quote : null;
    const close = quote ? Number(quote.price) : latestClose(data);
    const dailySeries = (data && data.daily && data.daily['Time Series (Daily)']) || null;
    const closeDate = dailySeries ? Object.keys(dailySeries).sort().pop() : null;
    const priceStamp = (quote && quote.asOf) || closeDate || '';
    const priceNote = quote
        ? `${priceStamp ? `as of ${priceStamp} · ` : ''}${quote.source === 'live' ? 'live' : 'last close'}`
        : (close !== null && closeDate ? `as of ${closeDate} · cached` : '');
    const quoteCaption = priceNote ? `Price, market cap, P/E and 52-week range: ${priceNote}.` : '';
    // Price-derived fields come from the live quote when we have one; the cached
    // overview figure is the fallback, dated by the freshness line above.
    const mcap = (quote && quote.marketCap) || ov.MarketCapitalization;
    const pe = (quote && quote.trailingPE !== null && quote.trailingPE !== undefined) ? quote.trailingPE : ov.PERatio;
    const eps = ov.EPS;
    const desc = ov.Description || '';
    const income = (data && data.income && data.income.annualReports) || [];

    const canonical = `${SITE}/stocks/${sym}`;
    // The data's own dates — never the file mtime. A git-checkout deploy stamps
    // every file with the deploy time, so the old code advertised the deploy
    // date as "last refreshed" while the sitemap said something else. The month
    // this file was actually written is the honest answer; see
    // backend/fundamentals-date.js.
    const dates = fundDate.describe(data);
    const refreshedDay = dates.fetchedAt ? dates.fetchedAt.slice(0, 10) : dates.dataAsOf;
    const mtimeISO = refreshedDay ? `${refreshedDay}T00:00:00.000Z` : null;
    const freshness = refreshedDay ? fmtDate(new Date(`${refreshedDay}T00:00:00Z`)) : '';
    const listing = fundStatus.info(sym);
    const staleNote = listing.unlisted
        ? `No longer listed under this ticker — last data as of ${freshness}.`
        : (dates.stale ? 'Not the latest data — a newer SEC filing may exist.' : '');
    // Metric + year-range words are the long-tail hooks searchers actually type
    // ("apple revenue by year", "{name} net income 2018").
    // Keep the <title> inside Bing's limit (its "Title too long" report says over
    // 70 characters; Google truncates around 60) — the budget below is 65, inside
    // both. Strip the legal suffix from the company name and keep the keyword tail
    // short. The full name, year range and Revenue/Net Income terms still live in
    // the description + H1.
    const shortName = name.replace(/^The\s+/i, '')
        .replace(/,?\s+(?:&|and)?\s*(Incorporated|Corporation|Corp|Company|Co|Holdings|plc|Ltd|Limited|L\.?P|N\.?V|S\.?A|Inc)\.?$/i, '')
        .trim() || name;
    const titleTail = ` (${sym}) Stock: Fair Value & Financials`;
    const title = clipName(shortName, 65 - titleTail.length) + titleTail;
    const metricBits = [
        mcap ? `Market cap ${money(mcap)}` : '',
        pe ? `P/E ${ratio(pe)}` : '',
        income[0] && income[0].totalRevenue ? `revenue ${money(income[0].totalRevenue)}` : ''
    ].filter(Boolean).join(', ');
    // Measured 9/28 over all 1,502 symbols: the previous template put 1,469 pages
    // (98%) outside Bing's 25-160 description range, worst 204 characters. The
    // boilerplate tail ("…on stockportfolio.pro") and the unstripped legal name
    // were the whole cause; the tail now carries only terms a searcher types.
    const descTail = ` (${sym}): ${metricBits || 'key financials'}. Income statement, balance sheet, cash flow, price chart.`;
    const description = clipName(shortName, 158 - descTail.length) + descTail;

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

    // Public snapshot tiles (all public-domain facts). The price is live from
    // quote-store when the route supplied a quote; the fundamentals close is the
    // last resort, and the tile always carries an as-of label so a stale number
    // cannot read as current.
    const tiles = [
        ['Price', close !== null ? price(close) : (eps && pe ? price(num(eps) * num(pe)) : '—'), priceNote],
        ['Market Cap', money(mcap)],
        ['P/E Ratio', ratio(pe)],
        ['EPS (TTM)', eps ? price(eps) : '—'],
        ['Sector', sector || '—'],
        ['52-Week High', price((quote && quote.fiftyTwoWeekHigh) || ov['52WeekHigh'])],
        ['52-Week Low', price((quote && quote.fiftyTwoWeekLow) || ov['52WeekLow'])],
        ['Dividend Yield', ov.DividendYield ? pct(ov.DividendYield) : '—']
    ].map(([l, v, n]) => `<div class="seo-tile"><div class="l">${esc(l)}</div><div class="v">${esc(v)}</div>${n ? `<div class="n">${esc(n)}</div>` : ''}</div>`).join('');

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
        // This renderer is synchronous. Do not call the async tool wrapper
        // here: doing so starts an uncached network build for every crawler
        // hit and the returned Promise can never contain `.checks`.
        const hc = aiChat.healthChecksFromData(data, sym);
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

    // Red-flag scanner — deterministic patterns in the filed statements that are
    // worth a second look. Unique, crawlable, cited; the "what could hurt me" hook
    // no free numbers-tool surfaces. Sync (redFlagsFor uses the cache loader).
    let redFlagBlock = '';
    let redFlagInfo = { count: 0, top: '' };
    try {
        const rf = aiChat.redFlagsFor(sym);
        if (rf && Array.isArray(rf.flags)) {
            redFlagInfo.count = rf.flags.length;
            if (rf.flags.length) {
                redFlagInfo.top = rf.flags[0].title || '';
                const sev = { high: '#f87171', warn: '#fbbf24', watch: '#9ca3af' };
                const items = rf.flags.map((f) =>
                    `<li style="background:var(--panel-solid);border:1px solid var(--border);border-left:3px solid ${sev[f.severity] || '#fbbf24'};border-radius:8px;padding:11px 14px;list-style:none;margin:0">` +
                    `<strong style="display:block;font-size:13.5px;margin-bottom:3px">${esc(f.title)}</strong>` +
                    `<span style="color:var(--muted);font-size:12.5px;line-height:1.55">${esc(f.detail)}</span></li>`).join('');
                redFlagBlock = `<div class="seo-section"><h2>${esc(name)}: ${rf.flags.length} potential red flag${rf.flags.length > 1 ? 's' : ''} in the filings</h2>
                  <p style="color:var(--muted);font-size:12.5px;margin:0 0 10px">Patterns in the filed statements worth a second look — computed and cited, not AI guesswork, and not a signal to sell. The kind of thing that hides in a 10-K.</p>
                  <ul style="display:grid;gap:8px;padding:0;margin:0">${items}</ul>
                  <p style="font-size:13px;margin-top:12px"><a href="/ask?q=${encodeURIComponent('Explain the red flags in ' + sym + "'s latest filings")}" style="color:var(--accent);font-weight:600">Ask the AI to dig into these &rarr;</a></p></div>`;
            } else {
                redFlagBlock = `<div class="seo-section"><h2>${esc(name)}: no obvious red flags in the filings</h2>
                  <p style="color:var(--muted);font-size:12.5px;margin:0">Our deterministic scan of the filed statements — receivables vs sales, earnings vs cash, dilution, leverage and margins — didn't flag anything. <a href="/ask?q=${encodeURIComponent('What are the main risks in ' + sym + '?')}" style="color:var(--accent);font-weight:600">Ask about the risks &rarr;</a></p></div>`;
            }
        }
    } catch (_) { /* page renders without red flags */ }

    // FAQ block + FAQPage JSON-LD (the featured-snippet play).
    const revCagr5Pct = aiChat.revCagrFromData(data);
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
    if (num(pe) !== null) faqs.push({ q: `What is ${sym}'s P/E ratio?`, a: `${name} trades at a price-to-earnings ratio of about ${num(pe).toFixed(1)}, based on the latest quote and filed figures.` });
    if (revCagr5Pct !== null && revCagr5Pct !== undefined) {
        faqs.push({ q: `How fast is ${name} growing?`, a: `${sym}'s revenue grew at roughly ${revCagr5Pct.toFixed(1)}% per year over the last five fiscal years (compound annual growth rate), computed from SEC-filed statements.` });
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
        a: `${name} (${sym}) has a market capitalization of about ${money(mcap)}, based on the latest quote and filed share count.`
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
    let rdInfo = null;
    try {
        const rd = require('./reverse-dcf').computeFromData(sym, data);
        if (rd && !rd.error && rd.impliedGrowthPct !== null) {
            const a = rd.assumptions; const rec = rd.record || {};
            rdInfo = { impliedGrowthPct: rd.impliedGrowthPct, recordFcfCagr5Pct: (rec.fcfCagr5Pct ?? null), recordRevCagr5Pct: (rec.revCagr5Pct ?? null) };
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
    faqs.push({ q: 'Where does this data come from?', a: `All figures are computed from ${name}'s official SEC filings (10-K and 10-Q), covering ${income.length} years of history, refreshed on a rolling schedule. stockportfolio.pro does not provide investment advice.` });
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
    if (revCagr5Pct !== null && revCagr5Pct !== undefined) leadBits.push(`and has compounded revenue about ${revCagr5Pct.toFixed(1)}%/yr over five years`);
    const leadSentence = leadBits.length ? `${name} (${sym}) ${leadBits.join(', ')}, per its SEC filings.` : '';
    const leadHtml = leadSentence ? `<p class="seo-about" style="margin:8px 0 4px">${esc(leadSentence)}</p>` : '';
    const latestPeriod = income[0] ? String(income[0].fiscalDateEnding || '').slice(0, 10) : '';
    const freshHtml = freshness
        ? `<p style="font-size:12px;color:var(--ink3);margin:2px 0 16px">Financial statements${latestPeriod ? ` through ${esc(latestPeriod)}` : ''} &middot; data last refreshed ${esc(freshness)}${staleNote ? ` &middot; <strong>${esc(staleNote)}</strong>` : ''} &middot; <a href="/methodology" style="color:var(--ink3)">how we compute this</a></p>`
        : '';

    // Per-metric history pages (seo-extra) — linked here so crawlers discover
    // them from every ticker page, not just the sitemap. Lazy require: this
    // module loads before seo-extra.
    let metricBlock = '';
    try {
        const extra = require('./seo-extra');
        const links = extra.METRIC_SLUGS
            .map((s) => `<a href="/stocks/${esc(sym)}/${s}">${esc(extra.METRICS[s].label)}</a>`).join('');
        metricBlock = `<div class="seo-section"><h2>${esc(name)} financial history</h2><div class="seo-links">${links}<a href="/stocks/${esc(sym)}/price-history">Price history</a><a href="/research/shares-outstanding">Shares outstanding research guide</a><a href="/research/pe-ratio-history">Historical P/E methodology</a><a href="/research/dilution-scorecard">US-company dilution scorecard</a></div></div>`;
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

    // Analyst take — the compelling, filing-grounded narrative read. This is the
    // conversion surface: it shows a cold visitor the product's analytical brain.
    // Renders the deterministic template instantly; upgrades to the LLM read on
    // the next request once it has been generated and disk-cached in the
    // background. All numbers come from facts computed above; the prose only.
    let analystBlock = '';
    try {
        const analystTake = require('./analyst-take');
        const passed = healthChecks.filter((c) => c.pass).length;
        const nm = (revN && niN !== null) ? Number(((niN / revN) * 100).toFixed(1)) : null;
        const revPv = num((income[1] || {}).totalRevenue); const niPv = num((income[1] || {}).netIncome);
        const pnm = (revPv && niPv !== null) ? Number(((niPv / revPv) * 100).toFixed(1)) : null;
        const gm = (() => {
            let gp = num(latestInc.grossProfit); if (gp === 0) gp = null;
            let cor = num(latestInc.costOfRevenue); if (cor === 0) cor = null;
            if (gp === null && revN !== null && cor !== null) gp = revN - cor;
            return (gp !== null && revN) ? Number(((gp / revN) * 100).toFixed(1)) : null;
        })();
        const yearsCount = Math.min(income.length, 10);
        const revFirstR = income[yearsCount - 1] || {};
        const debtTot = (ltd !== null || std !== null) ? ((ltd || 0) + (std || 0)) : null;
        const facts = {
            sym, name, sector,
            latestFY, revLatest: money(revN), revFirst: money(num(revFirstR.totalRevenue)), yearsCount,
            revYoYPct: (leadGrowth !== null && leadGrowth !== undefined) ? Number(leadGrowth.toFixed(1)) : null,
            revCagr5Pct: (revCagr5Pct != null ? Number(Number(revCagr5Pct).toFixed(1)) : null),
            netMarginPct: nm, netMarginChangePts: (nm !== null && pnm !== null) ? Number((nm - pnm).toFixed(1)) : null,
            grossMarginPct: gm,
            fcfMarginPct: null,
            mcap: money(mcap), pe: num(pe),
            impliedGrowthPct: rdInfo ? rdInfo.impliedGrowthPct : null,
            recordFcfCagr5Pct: rdInfo ? (rdInfo.recordFcfCagr5Pct ?? null) : null,
            recordRevCagr5Pct: rdInfo ? (rdInfo.recordRevCagr5Pct ?? null) : null,
            healthPassed: passed, healthTotal: healthChecks.length,
            redFlagsCount: redFlagInfo.count, topRedFlag: redFlagInfo.top,
            debtTotal: debtTot ? money(debtTot) : null,
            debtNote: debtTot ? `it carries about ${money(debtTot)} of total debt` : '',
            paysDividend: !!(divCheck && divCheck.pass), divYield: ov.DividendYield ? pct(ov.DividendYield) : ''
        };
        const { take } = analystTake.getTake(sym, facts);
        if (take) {
            const paras = take.split(/\n\n+/).map((p) => `<p style="margin:0 0 12px">${esc(p.trim())}</p>`).join('');
            analystBlock = `<div class="seo-section" style="background:var(--panel-solid);border:1px solid var(--border);border-radius:12px;padding:18px 22px">
              <h2 style="margin:0 0 12px">The analyst's take on ${esc(name)}</h2>
              <div style="font-size:15px;line-height:1.72;color:var(--text);max-width:74ch">${paras}</div>
              <p style="font-size:12.5px;color:var(--muted);margin:4px 0 0">Synthesised from ${esc(name)}'s SEC filings — descriptive, not advice. <a href="/ask?q=${encodeURIComponent('Give me your full analysis of ' + sym)}" style="color:var(--accent);font-weight:600">Ask the analyst your own question &rarr;</a></p>
            </div>`;
        }
    } catch (_) { /* page renders without the take */ }

    // Claim-check widget — the warm-visitor conversion moment: a reader who
    // doubts a headline about this company is one click from the free verify
    // tool (and the paywall). Same plain-language verdict + bar comparison as
    // /verify.html, ticker pre-filled. Free, no account.
    const verifyBlock = `<div class="seo-section" style="background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:20px 22px">
  <div style="display:flex;justify-content:space-between;align-items:baseline;gap:12px;flex-wrap:wrap">
    <h2 style="margin:0">See a claim about ${esc(name)}? Check it against the filing</h2>
    <span style="font-size:12.5px;color:var(--ink3)"><a href="/verify" style="color:var(--accent)">Open the full tool &rarr;</a></span>
  </div>
  <p style="margin:8px 0 16px;color:var(--ink2);font-size:14px;max-width:74ch">Paste a headline number you saw about ${esc(sym)} &mdash; a press-release figure, a tweet, another tool&rsquo;s number &mdash; and see the filed SEC number side-by-side with its source. Free, no account.</p>
  <div class="vf-form">
    <div>
      <label class="vf-label" for="cc-ticker">Ticker</label>
      <input id="cc-ticker" class="input vf-ticker" value="${esc(sym)}" aria-label="Ticker" data-ticker-ac />
    </div>
    <div>
      <label class="vf-label" for="cc-claim">Headline or claim</label>
      <textarea id="cc-claim" class="input vf-claim" placeholder='Paste a headline &mdash; e.g. "Q2 revenue $23.5B beat estimates"' aria-label="Financial claim"></textarea>
    </div>
  </div>
  <button id="cc-go" class="btn btn-accent vf-btn" type="button">Check against the filing</button>
  <div id="cc-status" class="vf-status"></div>
  <div id="cc-out"></div>
</div>
<script>
(function () {
  const $ = (s) => document.getElementById(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[m]));
  const money = (n) => {
    if (n == null) return '—';
    const abs = Math.abs(n);
    // The decimal is chosen from the SCALED value. Comparing \`abs\` here made the
    // decimal branch dead code — every real financial figure is >= 100 — so a
    // $15.5 billion filing printed as "$16 billion" on the public verify pages,
    // whose entire claim is that the filed number is the reliable one. Same fix
    // as verify.html and the ledger in app.js.
    const one = (v) => { const x = v.toFixed(Math.abs(v) >= 1000 ? 0 : 1); return x.replace(/\\.0$/, ''); };
    if (abs >= 1e12) return '$' + one(n / 1e12) + ' trillion';
    if (abs >= 1e9) return '$' + one(n / 1e9) + ' billion';
    if (abs >= 1e6) return '$' + one(n / 1e6) + ' million';
    if (abs >= 1e3) return '$' + one(n / 1e3) + ' thousand';
    return '$' + one(n);
  };
  const mult = (r) => { const x = Math.round(r * 10) / 10; return x >= 10 ? String(Math.round(x)) : String(x); };
  function explain(j) {
    const c = j.pr && j.pr.value, f = j.filed && j.filed.value;
    if (c == null || f == null) return '';
    const what = (j.pr && j.pr.label) || 'revenue';
    const cw = money(c), fw = money(f);
    if (Math.abs(j.diffPct || 0) <= 2) return 'Your headline says ' + cw + ' in ' + what + '. The filing shows ' + fw + ' in ' + what + ' — those match, within rounding.';
    const ratio = c / f;
    const dir = ratio > 1 ? 'about ' + mult(ratio) + '× higher' : 'about ' + mult(1 / ratio) + '× lower';
    const pct = Math.abs(j.diffPct).toFixed(0);
    return 'Your headline says ' + cw + ' in ' + what + '. The filing shows ' + fw + ' — your number is ' + dir + ' than what’s actually filed, a difference of ' + pct + '%.';
  }
  function bars(j) {
    const c = j.pr && j.pr.value, f = j.filed && j.filed.value;
    if (c == null || f == null) return '';
    const max = Math.max(c, f, 1);
    const cw = Math.max(3, Math.round(c / max * 100));
    const fw = Math.max(3, Math.round(f / max * 100));
    return '<div class="vf-bars">'
      + '<div class="vf-bar-row"><span class="vf-bar-label">Your headline</span><div class="vf-bar-track"><div class="vf-bar pr" style="width:' + cw + '%"></div></div><span class="vf-bar-val">' + money(c) + '</span></div>'
      + '<div class="vf-bar-row"><span class="vf-bar-label">SEC filing</span><div class="vf-bar-track"><div class="vf-bar filed" style="width:' + fw + '%"></div></div><span class="vf-bar-val">' + money(f) + '</span></div>'
      + '</div>';
  }
  function render(j) {
    const flag = String(j.verdict).startsWith('FLAGGED');
    const warn = String(j.verdict).includes('different periods');
    const cls = flag ? 'vf-flag' : warn ? 'vf-warn' : 'vf-ok';
    const title = flag
      ? 'The number in your headline doesn’t match the filing.'
      : warn
        ? 'The periods don’t line up — the headline looks quarterly, the filed figure is annual.'
        : 'The number in your headline matches the SEC filing.';
    const source = j.filed && j.filed.sourceUrl;
    const period = j.period || 'latest filed';
    $('cc-out').innerHTML = '<div class="vf-verdict ' + cls + '">'
      + '<div class="vf-title">' + title + '</div>'
      + '<p>' + explain(j) + '</p>'
      + bars(j)
      + '</div>'
      + '<table class="vf-table"><tr><th>Source</th><th>Number</th><th>Period</th></tr>'
      + '<tr><td>Headline</td><td><strong>' + (j.pr ? (j.pr.raw || '—') : '—') + '</strong></td><td>—</td></tr>'
      + '<tr><td>SEC filing</td><td><strong>' + money(j.filed && j.filed.value) + '</strong></td><td>' + period + ' · <a href="' + esc(source) + '" target="_blank" rel="noopener nofollow">sec.gov</a></td></tr>'
      + '</table>'
      + ((j.warnings && j.warnings.length) ? '<div class="vf-note"><strong>What to watch:</strong> ' + j.warnings.map(esc).join(' ') + '</div>' : '');
    $('cc-status').textContent = '';
  }
  const go = async () => {
    const ticker = $('cc-ticker').value.trim();
    const claim = $('cc-claim').value.trim();
    if (!claim) { $('cc-status').textContent = 'Paste a headline number — e.g. "Walmart profit $155B".'; return; }
    $('cc-status').textContent = 'Checking the filing…';
    $('cc-out').innerHTML = '';
    try {
      const r = await fetch('/api/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticker, prText: claim }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'Verification failed');
      render(j);
    } catch (e) { $('cc-status').textContent = e.message; }
  };
  $('cc-go').addEventListener('click', go);
  $('cc-claim').addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
})();
</script>`;

    return head(title, description, canonical, jsonld, { placeholder: `Ask about ${sym} — answered from its SEC filings…` }) + faqLdTag + nav('company') + `
<main class="seo-wrap">
  <div class="seo-crumbs"><a href="/stocks">Stocks</a> / ${esc(sym)}</div>
  <h1 class="seo-h1">${esc(name)} <span style="color:var(--muted);font-weight:600">(${esc(sym)})</span> Stock Analysis</h1>
  <p class="seo-sub">${meta || 'US-listed equity'}</p>
  ${leadHtml}
  ${freshHtml}
  <div class="seo-grid">${tiles}</div>
  ${quoteCaption ? `<p style="font-size:12px;color:var(--ink3);margin:-6px 0 16px">${esc(quoteCaption)}</p>` : ''}
  ${analystBlock}
  ${verifyBlock}
  ${teaserTable}
  ${healthBlock}
  ${redFlagBlock}
  ${rdcfBlock}
  <div class="seo-lock">
    <h3>Explore ${esc(String(income.length))} years of ${esc(name)} financials — interactive</h3>
    <p>Full income statement, balance sheet and cash flow with CAGR and trend on every row, 48 quarters, valuation ratios, plain-English health checks, and Ask — our SEC-grounded research assistant.</p>
    <a class="seo-cta-btn" href="/company?symbol=${esc(sym)}">Open the interactive view — free</a>
    <p style="margin-top:10px"><a href="/register?plan=monthly" style="font-size:13px">Or start a $24.99/month plan to track ${esc(sym)} in your portfolio &rarr;</a></p>
  </div>
  ${metricBlock}
  ${compareBlock}
  ${about}
  ${faqBlock}
  <div class="seo-section"><h2>Explore more stocks</h2>
    <div class="seo-links">${linkPills}</div>
    <p style="margin-top:10px"><a href="/stocks" style="color:var(--primary)">Browse all 1,500+ companies &rarr;</a> &middot; <a href="/screener" style="color:var(--primary)">Screen them by fundamentals &rarr;</a> &middot; <a href="/tools/earnings-quality" style="color:var(--primary)">Check earnings quality &rarr;</a> &middot; <a href="/tools/dilution" style="color:var(--primary)">Check share dilution &rarr;</a></p>
  </div>
</main>` + footer();
}

// ---- index page ----
function renderStockIndex() {
    const all = loadCompanies().slice().sort((a, b) => a.name.localeCompare(b.name));
    const bySector = {};
    all.forEach((c) => { (bySector[c.sector || 'Other'] = bySector[c.sector || 'Other'] || []).push(c); });
    const canonical = `${SITE}/stocks`;
    const title = 'Stock Research & Analysis — AI Analyst Grounded in SEC Filings';
    const description = 'AI stock research grounded only in SEC filings: revenue, margins, P/E and up to 19 years of financials for 1,500+ US companies. Compare and screen free.';
    const jsonld = JSON.stringify({
        '@context': 'https://schema.org', '@type': 'CollectionPage',
        name: 'Stock fundamentals directory', url: canonical
    });
    const sectorBlocks = Object.keys(bySector).sort().map((sec) => {
        const links = bySector[sec].map((c) => `<a href="/stocks/${esc(c.symbol)}" title="${esc(c.name)}">${esc(c.symbol)} <span style="color:var(--muted)">${esc(c.name)}</span></a>`).join('');
        return `<div class="seo-section"><h2>${esc(sec)}</h2><div class="seo-links">${links}</div></div>`;
    }).join('');
    return head(title, description, canonical, jsonld, { placeholder: 'Ask about any company — answered from its SEC filings…' }) + nav('company') + `
<main class="seo-wrap">
  <h1 class="seo-h1">Stock fundamentals directory</h1>
  <p class="seo-sub">Revenue, earnings, valuation and financial statements for 1,500+ US-listed companies. Pick a ticker to see its snapshot, or start a free trial for full statements and portfolio tracking.</p>
  ${sectorBlocks}
</main>` + footer();
}

// ---- sitemap index + truthful, crawl-budget-friendly shards ----
// The old sitemap marked all 26k URLs as modified today each time it was built.
// Bing uses lastmod to schedule crawls, so that fake freshness wasted crawl
// capacity. Shard by page type and use the actual page/data modification date.
const SITEMAP_CHUNK = 5000;
// Metric history pages were excluded from the sitemap on Google crawl-budget
// grounds. Bing data since then says they are the pages that actually earn
// Bing traffic and Copilot citations, and Bing has no other lastmod signal for
// them. Set SITEMAP_INCLUDE_METRICS=0 to restore the old behaviour.
const SITEMAP_INCLUDE_METRICS = String(process.env.SITEMAP_INCLUDE_METRICS || '1') !== '0';
const SITEMAP_TTL_MS = 30 * 60 * 1000;
// Last-resort date for a symbol with no entry in the change-date manifest and no
// cache-wide refresh date — the known date the bundled data shipped. Keeps a
// missing or unreadable manifest from falsely telling crawlers that thousands of
// unchanged company pages changed today.
const SITEMAP_DATA_SNAPSHOT = '2026-07-19';
let _sitemapInventoryCache = null;
let _dataDatesCache = null;

function isoMtime(file, fallback = '2026-07-19') {
    try { return fs.statSync(file).mtime.toISOString().slice(0, 10); } catch (_) { return fallback; }
}
// Per-symbol data dates come from a committed manifest the refresh writes, NOT
// from filesystem mtime.
//
// Why not mtime: a git-checkout deploy stamps *every* file with the checkout
// time, so mtime says nothing about the data. The previous version tried to
// detect that by clamping any file modified within an hour of this file's own
// deploy stamp back to SITEMAP_DATA_SNAPSHOT — but on a checkout deploy that
// window matches every file, so the clamp fired unconditionally. The result was
// <lastmod> frozen at 2026-07-19 across the ~20K stock/compare/metric URLs while
// the page body, reading the same mtime unclamped, advertised a date months
// newer. The page and its own sitemap entry contradicted each other.
//
// The manifest cannot drift that way: a symbol's date advances only when its
// filed statements actually change, and it survives a checkout.
function loadDataDates() {
    if (_dataDatesCache) return _dataDatesCache;
    let generatedAt = SITEMAP_DATA_SNAPSHOT;
    const symbols = {};
    try {
        const parsed = JSON.parse(fs.readFileSync(path.join(DATA, 'fundamentals-changed.json'), 'utf8'));
        if (parsed && parsed.symbols && typeof parsed.symbols === 'object') {
            for (const [sym, date] of Object.entries(parsed.symbols)) {
                const day = String(date || '').slice(0, 10);
                if (/^\d{4}-\d{2}-\d{2}$/.test(day)) symbols[String(sym).toUpperCase()] = day;
            }
        }
        if (parsed && parsed.generatedAt) {
            const day = String(parsed.generatedAt).slice(0, 10);
            if (/^\d{4}-\d{2}-\d{2}$/.test(day)) generatedAt = day;
        }
    } catch (_) { /* no manifest yet — the bundled snapshot date still stands */ }
    _dataDatesCache = { generatedAt, symbols };
    return _dataDatesCache;
}
// The date a symbol's fundamentals actually last changed: its own manifest
// entry, else the cache-wide refresh date, else the bundled snapshot date.
function dataDateFor(symbol) {
    const { generatedAt, symbols } = loadDataDates();
    return symbols[String(symbol || '').toUpperCase()] || generatedAt;
}
function maxDate(...dates) { return dates.filter(Boolean).sort().pop() || '2026-07-19'; }
function staticPageMtime(route) {
    const names = {
        '/filing-watch': 'filing-watch.html', '/filing-watch-sample': 'filing-watch-sample.html',
        '/': 'index.html', '/register': 'register.html', '/appsumo': 'appsumo.html', '/tour': 'tour.html', '/monitor-demo': 'monitor-demo.html', '/features': 'features.html',
        '/screener': 'screener.html', '/ask': 'ask.html', '/support': 'support.html', '/privacy': 'privacy.html',
        '/terms': 'terms.html', '/sitemap': 'sitemap.html', '/gurus': 'gurus.html', '/monitor': 'monitor.html', '/dossier': 'dossier.html',
        // Public pages that were linked from the site but present in no shard at all
        // (measured 2026-09-28, all four answering 200) — without an entry here
        // their lastmod would fall back to this module's own mtime.
        '/verify': 'verify.html', '/company': 'company.html', '/compare-dossiers': 'compare-dossiers.html',
        '/partners': 'partners.html', '/partners-apply': 'partners-apply.html', '/lifetime': 'lifetime.html'
    };
    if (route.startsWith('/tools/')) return isoMtime(path.join(__dirname, 'free-tools.js'));
    if (names[route]) return isoMtime(path.join(__dirname, '..', 'frontend-v2', names[route]));
    if (route === '/stocks') return isoMtime(path.join(DATA, 'sp1500-companies.json'));
    if (route === '/compare' || route.startsWith('/screens/') || route.startsWith('/research/')) return isoMtime(path.join(__dirname, 'seo-extra.js'));
    if (route.startsWith('/vs/')) return isoMtime(path.join(__dirname, 'comparison-pages.js'));
    return isoMtime(__filename);
}
function videoMarkup(route) {
    if (route === '/tour') return `\n    <video:video>\n      <video:thumbnail_loc>${SITE}/assets/tour-poster.jpg</video:thumbnail_loc>\n      <video:title>stockportfolio.pro — 60-second product tour</video:title>\n      <video:description>A one-minute tour of stockportfolio.pro: the SEC-grounded AI analyst, the free stock screener, and filed fundamentals.</video:description>\n      <video:content_loc>${SITE}/assets/tour-1080p.mp4</video:content_loc>\n      <video:duration>53</video:duration>\n    </video:video>\n    <video:video>\n      <video:thumbnail_loc>https://i.ytimg.com/vi/-3V_IaCOQUo/hqdefault.jpg</video:thumbnail_loc>\n      <video:title>I asked an AI 3 hard finance questions. Every answer came from the SEC filing.</video:title>\n      <video:description>Three hard finance questions answered by stockportfolio.pro's Ask analyst — every answer grounded in the company's actual SEC filing, with the source linked.</video:description>\n      <video:content_loc>https://www.youtube.com/watch?v=-3V_IaCOQUo</video:content_loc>\n      <video:player_loc allow_embed="yes">https://www.youtube.com/embed/-3V_IaCOQUo</video:player_loc>\n    </video:video>`;
    if (route === '/monitor-demo') return `\n    <video:video>\n      <video:thumbnail_loc>${SITE}/assets/monitor-poster.jpg</video:thumbnail_loc>\n      <video:title>Filing Change Monitor — reading NVIDIA's latest 10-Q</video:title>\n      <video:description>The Filing Change Monitor reads what changed in a company's newest filing and links the evidence.</video:description>\n      <video:content_loc>${SITE}/assets/monitor-1080p.mp4</video:content_loc>\n      <video:duration>18</video:duration>\n    </video:video>`;
    return '';
}

function buildSitemapInventory() {
    if (_sitemapInventoryCache && Date.now() - _sitemapInventoryCache.at < SITEMAP_TTL_MS) return _sitemapInventoryCache.shards;
    const coreRoutes = ['/filing-watch', '/filing-watch-sample', '/', '/zh', '/register', '/appsumo', '/tour', '/monitor-demo', '/features', '/stocks', '/screener', '/compare', '/ask', '/support', '/methodology', '/editorial-policy', '/licensing', '/api', '/privacy', '/terms', '/sitemap', '/gurus', '/monitor', '/dossier', '/tools', '/docs', '/verify-ledger', '/filing-changes',
        // Indexable and internally linked, but in no shard until 2026-09-28 — Bing's
        // Site Scan reports exactly this as "important pages missing from sitemaps".
        // /lifetime is the direct-sale twin of /appsumo (index,follow, prices from
        // /api/lifetime/config) and had no inbound link at all.
        // /company is deliberately absent: bare /company is a JS-only skeleton (the
        // name is filled in client-side) that nothing links, and /stocks/:symbol
        // already covers per-symbol pages — advertising a thin page is worse than
        // leaving an unlinked URL out of the sitemap. Its `.html` twin still 301s
        // to it, so the redirect table stays file-complete.
        '/verify', '/compare-dossiers', '/partners', '/partners-apply', '/lifetime'];
    try { Object.values(require('./free-tools').TOOL_DEFINITIONS).forEach((tool) => coreRoutes.push(tool.path)); } catch (_) {}
    try { Object.values(require('./docs-pages').DOC_PAGES).forEach((d) => coreRoutes.push(d.path)); } catch (_) {}
    try { require('./comparison-pages').competitors.forEach((s) => coreRoutes.push(`/vs/${s}`)); } catch (_) {}
    const core = coreRoutes.map((route) => ({ loc: SITE + route, lastmod: staticPageMtime(route), video: videoMarkup(route) }));
    const mtimes = new Map();
    const tickerMtime = (sym) => {
        const key = String(sym || '').toUpperCase();
        if (!mtimes.has(key)) mtimes.set(key, dataDateFor(key));
        return mtimes.get(key);
    };
    const stocks = loadCompanies()
        .filter((c) => !fundStatus.isUnlisted(c.symbol))
        .filter((c) => resolveCanonicalSymbol(c.symbol) === c.symbol)
        .map((c) => ({ loc: `${SITE}/stocks/${c.symbol}`, lastmod: tickerMtime(c.symbol) }));
    const compares = [], screens = [], metrics = [];
    try {
        require('./seo-extra').sitemapUrls().forEach((u) => {
            const route = u.loc;
            // Per-metric history pages (/stocks/:sym/:metric) are the least-unique,
            // highest-volume tier (~14K templated URLs). They were held out of the
            // sitemap on Google's crawl-budget guidance, since crawlers still reach
            // them via the "financial history" links on every ticker page.
            // Bing changed that calculus: these are the pages earning Bing clicks
            // and Copilot citations, and with no sitemap entry Bing gets no lastmod
            // for them at all. They are shipped in their own `metrics-*` shards so
            // the split stays visible and revertible.
            const metricMatch = route.match(/^\/stocks\/([^/]+)\//);
            if (metricMatch) {
                if (SITEMAP_INCLUDE_METRICS) {
                    metrics.push({ loc: SITE + route, lastmod: tickerMtime(metricMatch[1]) });
                }
                return;
            }
            const m = route.match(/^\/compare\/([A-Z0-9.\-]+)-vs-([A-Z0-9.\-]+)$/i);
            if (m) return compares.push({ loc: SITE + route, lastmod: maxDate(tickerMtime(m[1]), tickerMtime(m[2])) });
            screens.push({ loc: SITE + route, lastmod: staticPageMtime(route) });
        });
    } catch (_) {}
    // Pairs discovered live (see noteDiscoveredCompare in seo-extra.js): any
    // /compare/A-vs-B with metrics for both sides renders indexable, but only
    // the algorithmic set above used to reach the sitemap. Merge the bounded
    // discovered snapshot in so externally-found pairs keep a lastmod signal
    // (Bing: "important new pages missing from your sitemaps"). Same snapshot
    // contract as shares/diffs below: best-effort read, works if missing.
    try {
        const seenPairs = new Set(compares.map((c) => c.loc));
        JSON.parse(fs.readFileSync(path.join(__dirname, 'discovered-compares.json'), 'utf8'))
            .filter((e) => e && /^[A-Z0-9.]+-vs-[A-Z0-9.]+$/.test(e.p))
            .slice(-1000)
            .forEach((e) => {
                const loc = `${SITE}/compare/${e.p}`;
                if (seenPairs.has(loc)) return;
                seenPairs.add(loc);
                const [x, y] = e.p.split('-vs-');
                compares.push({ loc, lastmod: maxDate(String(e.at || ''), maxDate(tickerMtime(x), tickerMtime(y))) });
            });
    } catch (_) {}
    core.push(...screens);
    const shards = {};
    const addChunks = (prefix, entries) => {
        for (let i = 0; i < entries.length; i += SITEMAP_CHUNK) shards[`${prefix}-${Math.floor(i / SITEMAP_CHUNK) + 1}`] = entries.slice(i, i + SITEMAP_CHUNK);
    };
    shards.core = core;
    addChunks('stocks', stocks);
    addChunks('comparisons', compares);
    addChunks('metrics', metrics);
    // Authenticated users' published research reports (/r/:id) — the public
    // research library. Written by the share endpoint into a small JSON
    // snapshot beside this file (see noteIndexableShare in app.js) so the
    // sitemap build stays synchronous.
    try {
        const shareRows = JSON.parse(fs.readFileSync(path.join(__dirname, 'indexable-shares.json'), 'utf8'));
        if (Array.isArray(shareRows) && shareRows.length) {
            shards.shares = shareRows.filter((e) => e && e.id)
                .map((e) => ({ loc: `${SITE}/r/${encodeURIComponent(e.id)}`, lastmod: String(e.at || '2026-08-31').slice(0, 10) }));
        }
    } catch (_) {}
    // Per-company filing-change pages (/filing-changes/:symbol). Same snapshot
    // contract as shares above: app.js writes filing-diff-symbols.json on boot
    // so this build stays synchronous and works if the file is missing.
    try {
        const diffRows = JSON.parse(fs.readFileSync(path.join(__dirname, 'filing-diff-symbols.json'), 'utf8'));
        if (Array.isArray(diffRows) && diffRows.length) {
            addChunks('diffs', diffRows.filter((e) => e && e.s)
                .map((e) => ({ loc: `${SITE}/filing-changes/${encodeURIComponent(e.s)}`, lastmod: String(e.at || SITEMAP_DATA_SNAPSHOT).slice(0, 10) })));
        }
    } catch (_) {}
    _sitemapInventoryCache = { at: Date.now(), shards };
    return shards;
}

function buildSitemapShard(name) {
    const entries = buildSitemapInventory()[String(name || '')];
    if (!entries) return null;
    const body = entries.map((u) => `  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod>${u.video || ''}</url>`).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:video="http://www.google.com/schemas/sitemap-video/1.1">\n${body}\n</urlset>\n`;
}

function buildSitemap() {
    const body = Object.entries(buildSitemapInventory()).map(([name, entries]) => {
        const lastmod = entries.reduce((latest, u) => maxDate(latest, u.lastmod), '');
        return `  <sitemap><loc>${SITE}/sitemaps/${name}.xml</loc><lastmod>${lastmod}</lastmod></sitemap>`;
    }).join('\n');
    return `<?xml version="1.0" encoding="UTF-8"?>\n<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</sitemapindex>\n`;
}

// ---- helpers for the interactive company page's dynamic <head> ----
// Name lookup over the full US universe (~10.4k registrants), falling back to
// the S&P 1500 list. Lazy-loaded once.
let _usNames = null;
function companyName(symbol) {
    const sym = resolveCanonicalSymbol(symbol) || String(symbol || '').toUpperCase();
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
    const sym = resolveCanonicalSymbol(symbol);
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
  ${S('How often it updates', `<p>The fundamentals cache is rebuilt on a rolling schedule — the S&P 500 weekly, the wider universe monthly — and a stock can also refresh on demand when its page is opened. Each stock and metric page shows the date its underlying data was last refreshed. Newly filed 10-Ks and 10-Qs flow in on the next build.</p>`)}
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
  <div class="seo-section"><p style="font-size:13px"><a href="/editorial-policy">Editorial policy &amp; independence &rarr;</a> &middot; <a href="/stocks">Browse stocks &rarr;</a> &middot; <a href="/screener">Free screener &rarr;</a> &middot; <a href="/tools/earnings-quality">Earnings quality checker &rarr;</a> &middot; <a href="/tools/dilution">Share dilution calculator &rarr;</a> &middot; <a href="/tools/filing-timeline">SEC filing timeline &rarr;</a></p></div>
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
  ${S('Corrections', `<p>If a figure looks wrong, it usually traces to the source filing or a data-vendor mapping. We correct confirmed errors on the next refresh. Report an issue at <a href="mailto:support@stockportfolio.pro">support@stockportfolio.pro</a> with the ticker and the figure, and we&#39;ll investigate.</p>`)}
  ${S('Disclosures', `<p>Some outbound links (for example to brokers or partner tools) may be affiliate links that earn us a commission at no cost to you. Affiliate relationships never influence which companies&#39; data we show or how any ranking is computed.</p>`)}
  ${S('Not investment advice', `<p>Everything here is information and analysis for research and education only. It is not investment, financial, tax, or legal advice, and not a recommendation to buy or sell any security. Markets carry risk; do your own research and consider a licensed professional before investing.</p>`)}
  <div class="seo-section"><p style="font-size:13px"><a href="/methodology">How we compute our data &rarr;</a> &middot; <a href="/stocks">Browse stocks &rarr;</a></p></div>
</main>` + footer();
}

// ---- API & MCP landing (/api) ----
// The page every developer-facing funnel lands on: the npm package README, the
// MCP directory listings, the embeddable widgets and the programmatic SEO
// pages all point here. Its job is to answer "what does it cost and can I make
// one call in the next two minutes" without a sales conversation, so the
// example payload and the copy-paste MCP config are the load-bearing parts —
// not the prose.
//
// The example below is a REAL response captured from the live extractor for
// NVDA (2026-09-11), not an illustrative mock-up. Same rule as everywhere else
// on this site: a number on the page is a number the product actually returns.
function renderApiLanding() {
    const canonical = `${SITE}/api`;
    const title = 'Stock Data API & MCP Server — SEC filing data for developers';
    const description = 'A REST API and hosted MCP server over US SEC filings. Every value carries the filing it came from. $19.99/mo for 200 credits, no sales call.';
    const jsonld = JSON.stringify({
        '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'stockportfolio.pro API & MCP server', url: canonical,
        applicationCategory: 'DeveloperApplication', operatingSystem: 'Any',
        publisher: { '@id': `${SITE}/#org` }, isBasedOn: 'https://www.sec.gov/edgar',
        offers: { '@type': 'Offer', price: '19.99', priceCurrency: 'USD', description: 'Dev plan — 200 API/MCP credits per month' }
    });
    const S = (h, body) => `<div class="seo-section"><h2>${h}</h2><div class="seo-about">${body}</div></div>`;
    // Two MCP configs, because the two clients need different things and a
    // snippet that does not work is worse than no snippet — the reader blames
    // the product. Both point at the hosted /mcp endpoint, which is what the
    // key actually pays for and needs no install.
    //
    // The npm package (mcp-server/, name `stockportfolio-mcp`) went live on the
    // registry on 2026-09-14, so the first-party bridge config below is true now
    // and is offered alongside the generic mcp-remote one. The key shape differs
    // between the two and that difference is load-bearing: mcp-remote carries the
    // whole `Bearer <key>` string because it is pasted straight into a header,
    // while stockportfolio-mcp takes the BARE key and adds the scheme itself
    // (see mcp-server/README.md). Swapping them silently 401s.
    //
    // `url` + `headers` is the native hosted shape; Cursor and every other
    // client that reads a `url` infers Streamable HTTP from it.
    const mcpConfig = `{
  "mcpServers": {
    "stockportfolio": {
      "url": "https://www.stockportfolio.pro/mcp",
      "headers": { "Authorization": "Bearer your-key-here" }
    }
  }
}`;
    // Claude Desktop reads claude_desktop_config.json as stdio only — a `url`
    // entry is dropped silently, and takes its neighbours with it — so it goes
    // through the published `mcp-remote` bridge. Two details are load-bearing:
    // mcp-remote expands ${VAR} from the environment (the `env` block supplies
    // it), and the header carries no space in `args`, because Windows clients
    // do not escape spaces inside args and a `"Authorization: Bearer x"` value
    // arrives split in two. The whole value rides in the variable instead.
    const desktopConfig = `{
  "mcpServers": {
    "stockportfolio": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://www.stockportfolio.pro/mcp", "--header", "Authorization:\${STOCKPORTFOLIO_API_KEY}"],
      "env": { "STOCKPORTFOLIO_API_KEY": "Bearer your-key-here" }
    }
  }
}`;
    // First-party stdio bridge, published as `stockportfolio-mcp`. It talks to
    // the same hosted /mcp endpoint — it only replaces the generic mcp-remote
    // hop, and sidesteps that config's Windows arg-splitting footgun because
    // the whole credential rides in one env var with no spaces in `args`.
    const npmBridgeConfig = `{
  "mcpServers": {
    "stockportfolio": {
      "command": "npx",
      "args": ["-y", "stockportfolio-mcp"],
      "env": { "STOCKPORTFOLIO_API_KEY": "your-key-here" }
    }
  }
}`;
    const claudeCodeCmd = `claude mcp add --transport http stockportfolio \\
  https://www.stockportfolio.pro/mcp \\
  --header "Authorization: Bearer sp_live_..."`;
    const curlExample = `curl -H "X-Api-Key: sp_live_..." \\
  "https://www.stockportfolio.pro/api/v1/financials/NVDA?tool=earnings-quality"`;
    const jsonExample = `{
  "tool": "earnings-quality",
  "symbol": "NVDA",
  "period": "2026-01-31",
  "data": {
    "revenue": 215938000000,
    "netIncome": 120067000000,
    "operatingCashFlow": 102718000000,
    "freeCashFlow": 96676000000,
    "cashConversionRatio": 0.855505675997568,
    "warnings": []
  },
  "source": {
    "type": "filed",
    "url": "https://www.sec.gov/edgar/search/#/q=NVDA",
    "period": "2026-01-31"
  },
  "citation": {
    "filingSource": "https://www.sec.gov/edgar/search/#/q=NVDA",
    "period": "2026-01-31",
    "verifyAt": "https://www.stockportfolio.pro/stocks/NVDA?...",
    "poweredBy": "StockPortfolio.pro — filing-grounded US company data"
  }
}`;
    return head(title, description, canonical, jsonld) + nav() + `
<main class="seo-wrap">
  <div class="seo-crumbs"><a href="/">Home</a> / API</div>
  <h1 class="seo-h1">Stock data your agent can cite</h1>
  <p class="seo-sub">A REST API and a hosted MCP server over US SEC filings. Every value carries the filing it came from — <code>null</code> when the filing is silent, never interpolated. No sales call, no minimum contract: $19.99/mo.</p>

  <div class="seo-next-action">
    <p class="seo-next-action-kicker">Dev plan</p>
    <h2>$19.99/month — 200 credits, every tool</h2>
    <p>One API key covers both surfaces: the REST API at <code>/api/v1</code> and the MCP server at <code>/mcp</code>. A data lookup costs ${COST.mcp_lookup} credits, an AI answer ${COST.mcp_ask}, the same on both surfaces. Credits reset monthly. Cancel any time.</p>
    <p><a class="seo-cta-btn" href="/register?plan=dev">Get a key &rarr;</a></p>
    <p style="font-size:13px;margin-top:10px">Already on Power or Desk? API/MCP access is included — generate a key from your <a href="/profile.html" rel="nofollow">Profile page</a>.</p>
  </div>

  ${S('Make a call in two minutes', `<p>One key, one header. This is the actual response for <code>NVDA</code>, captured from the live extractor:</p>
    <pre style="background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px;overflow-x:auto;font-size:12.5px;line-height:1.5">${esc(curlExample)}</pre>
    <pre style="background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px;overflow-x:auto;font-size:12.5px;line-height:1.5">${esc(jsonExample)}</pre>
    <p>Every response — including every error — carries that <code>citation</code> block. It is what makes the data usable in an agent: the model can point at the filing rather than assert a number.</p>`)}

  ${S('The tools', `<p>Each surface lists its own catalog, because they are not the same shape: the MCP endpoint is built for an agent to route on, so its tools are named for the question they answer, while the REST API mirrors the website's free tools one route at a time.</p>
  <table class="seo-table">
    <thead><tr><th>MCP tool (${esc('POST /mcp')})</th><th>What it returns</th><th>Credits</th></tr></thead>
    <tbody>
      <tr><td><code>search_companies</code></td><td>Name or ticker → ticker, company name, SEC CIK</td><td>free</td></tr>
      <tr><td><code>get_company_fundamentals</code></td><td>Filed statements by fiscal period — revenue, margins, EPS, cash flow, debt, shares — each figure with its filing</td><td>${COST.mcp_lookup}</td></tr>
      <tr><td><code>search_filings</code></td><td>Filings by type and date range, with direct EDGAR links</td><td>${COST.mcp_lookup}</td></tr>
      <tr><td><code>get_filing</code></td><td>One filing's metadata and content, by accession number or ticker</td><td>${COST.mcp_lookup}</td></tr>
      <tr><td><code>ask_filings</code></td><td>A filing-grounded answer, with the figures and citations behind it</td><td>${COST.mcp_ask}</td></tr>
      <tr><td><code>sp_health</code></td><td>Liveness probe — safe to call before anything else</td><td>free</td></tr>
    </tbody>
  </table>
  <table class="seo-table" style="margin-top:16px">
    <thead><tr><th>REST endpoint (<code>/api/v1</code>)</th><th>What it returns</th><th>Credits</th></tr></thead>
    <tbody>
      <tr><td><code>GET /api/v1/health</code></td><td>Liveness probe</td><td>free</td></tr>
      <tr><td><code>GET /api/v1/financials/:ticker</code></td><td>One free-tool view of the filed statements</td><td>${COST.api_lookup}</td></tr>
      <tr><td><code>GET /api/v1/filing/:ticker</code></td><td>Recent 10-K / 10-Q / 8-K / Form 4 with EDGAR links</td><td>${COST.api_lookup}</td></tr>
      <tr><td><code>GET /api/v1/compare?tickers=</code></td><td>Two companies side by side, from their latest filed annuals</td><td>${COST.api_lookup}</td></tr>
      <tr><td><code>GET /api/v1/screen?tickers=</code></td><td>Up to ten tickers ranked by filed revenue growth</td><td>${COST.api_lookup}</td></tr>
      <tr><td><code>GET /api/v1/fund/:symbol</code></td><td>ETF / mutual-fund profile — Yahoo-derived, labelled as such</td><td>${COST.api_lookup}</td></tr>
      <tr><td><code>POST /api/v1/ask</code></td><td>AI-backed answer, with its source class (filed / fund-data / live-web)</td><td>${COST.api_ask}</td></tr>
    </tbody>
  </table>
  <p style="margin-top:12px">Both surfaces are priced identically — a lookup costs ${COST.mcp_lookup} credits and an AI answer ${COST.mcp_ask} on each, because they run the same call over the same filings. Reading the tool list is free on both, so a connector scan or a directory probe needs no key. Rate limit: 60 requests/minute per key. The full per-client setup guide is in the <a href="/docs/api-mcp">documentation</a>.</p>`)}

  ${S('Point your client at the hosted server', `<p>The server is hosted, so there is nothing to install: your key is the only configuration. Cursor and any other client that takes a <code>url</code>:</p>
    <pre style="background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px;overflow-x:auto;font-size:12.5px;line-height:1.5">${esc(mcpConfig)}</pre>
    <p>Claude Desktop's config is stdio-only, so it needs a bridge. The first-party one is on npm — nothing to clone, and the bare key goes straight in <code>env</code>:</p>
    <pre style="background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px;overflow-x:auto;font-size:12.5px;line-height:1.5">${esc(npmBridgeConfig)}</pre>
    <p>Or use the generic <code>mcp-remote</code> bridge instead — note this one wants the full <code>Bearer &lt;key&gt;</code> value, since it is expanded into a header rather than read as a key:</p>
    <pre style="background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px;overflow-x:auto;font-size:12.5px;line-height:1.5">${esc(desktopConfig)}</pre>
    <p>Claude Code takes one command:</p>
    <pre style="background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px;overflow-x:auto;font-size:12.5px;line-height:1.5">${esc(claudeCodeCmd)}</pre>
    <p>Either way the tools appear in the tool list, served from <code>https://www.stockportfolio.pro/mcp</code> — note the <code>www</code>, since the apex redirect drops the <code>Authorization</code> header. See the <a href="/licensing#mcp-api">licensing page</a> for the full tool reference.</p>`)}

  ${S('Free embeds, no key', `<p>Not ready for an API key? Two of these widgets drop onto any site as a single <code>&lt;iframe&gt;</code> — a filing-grounded earnings-quality card and an SEC filing timeline, rendered server-side, no JavaScript and no key. They are free to embed and carry a link back to the full filing trail.</p>
    <p><a href="/tools/earnings-quality#embed">Get the embed snippet &rarr;</a></p>`)}

  ${S('What it is, and what it is not', `<ul>
      <li><strong>Filed, not estimated.</strong> Figures are computed deterministically from 10-K/10-Q filings across 6,000+ US companies. No analyst estimates, no model-guessed numbers.</li>
      <li><strong>Not investment advice</strong>, and not a quote feed. Market data — prices, market cap, P/E — comes from a third-party feed we don't hold redistribution rights to, which is why the API is filing-grounded by design.</li>
      <li><strong>Fund data is different.</strong> <code>sp_fund</code> is Yahoo-derived, for your own research, and not for redistribution.</li>
      <li><strong>Bulk corpus licensing</strong> (the whole dataset, for training or redistribution) is a separate arrangement — see <a href="/licensing">data licensing</a>.</li>
    </ul>`)}
  <div class="seo-section"><p style="font-size:13px"><a href="/licensing">Data licensing &amp; terms &rarr;</a> &middot; <a href="/methodology">Methodology &rarr;</a> &middot; <a href="/tools">Free tools (no key needed) &rarr;</a></p></div>
</main>` + footer();
}

// ---- Data licensing (AI companies / agent builders) ----
// backend/bot-blocker.js refuses automated access and its 403 body points here,
// so this is where a crawler operator lands after being blocked. It therefore
// leads with why the block exists and states the exclusions up front — the
// audience arrived from an error, not from a marketing page.
function renderLicensing() {
    const canonical = `${SITE}/licensing`;
    const title = 'Data Licensing & API Access — stockportfolio.pro';
    const description = 'Licensed bulk SEC fundamentals and filing-change data, plus MCP and API access for agent builders. What the corpus contains, what it excludes, and what it costs.';
    const jsonld = JSON.stringify({
        '@context': 'https://schema.org', '@type': 'AboutPage', name: 'Data Licensing & API Access', url: canonical,
        publisher: { '@id': `${SITE}/#org` }, isBasedOn: 'https://www.sec.gov/edgar'
    });
    const S = (h, body) => `<div class="seo-section"><h2>${h}</h2><div class="seo-about">${body}</div></div>`;
    return head(title, description, canonical, jsonld) + nav() + `
<main class="seo-wrap">
  <div class="seo-crumbs"><a href="/">Home</a> / Licensing</div>
  <h1 class="seo-h1">Data licensing &amp; API access</h1>
  <p class="seo-sub">If your crawler was refused a moment ago, this is the supported way in. Structured, filing-sourced data under licence — cleaner than anything scraping these pages would give you.</p>
  ${S('Why automated access is blocked', `<p>The reason is bandwidth cost, not secrecy. Bots were 68% of all traffic to this site and were consuming most of a 5GB/month allowance, so <a href="/robots.txt">robots.txt</a> denies crawling by default and the policy is enforced server-side rather than merely requested. Googlebot and Bingbot remain allowed. Everything the crawler was after is available under licence, already normalised.</p>`)}
  ${S('What the corpus contains', `<ul>
      <li><strong>Fundamentals panel</strong> — income statement, balance sheet and cash flow <em>as filed</em>, one row per company per fiscal period: up to 19 fiscal years and 48 quarters where filings exist.</li>
      <li><strong>Filing-change table</strong> — period-over-period deltas drawn from our filing-change reports: the metric, both periods&#39; values, direction, and a materiality score. This is the part you cannot get by re-parsing EDGAR yourself without building the diff layer.</li>
      <li><strong>Company identity</strong> — ticker, CIK, exchange, reporting currency, sector, industry.</li>
      <li>Every row carries a <code>sourceUrl</code> to the filer&#39;s own EDGAR record, so any figure is verifiable against the primary document. Delivered as CSV <em>and</em> JSON with a manifest.</li>
    </ul>`)}
  ${S('What it excludes, and why', `<ul>
      <li><strong>No market data.</strong> Price series, market caps, P/E, analyst targets and other quote-derived figures come from a third-party feed we don&#39;t hold redistribution rights to. Be suspicious of anyone including those at this price.</li>
      <li><strong>No user or personal data of any kind</strong> — no accounts, usage, or email addresses. The export process never reads a collection containing a user reference.</li>
      <li><strong>No written analysis.</strong> Report narratives, headlines and pulled quotes stay ours. You&#39;re licensing filed facts and the deterministic differences between them.</li>
    </ul>`)}
  ${S('Pricing', `<ul>
      <li><strong>Pilot — $1,500 flat, one-time.</strong> Fixed scope, no quote needed: ~1,500 companies, up to 19 fiscal years of fundamentals, and the filing-change table, delivered as a one-off CSV+JSON export with manifest. Built for evaluating the data before an annual commitment, or for a one-off analysis that doesn&#39;t need refreshes. <a href="mailto:support@stockportfolio.pro?subject=Licensing%20pilot%20-%20%241%2C500">Buy the pilot &rarr;</a></li>
      <li><strong>Annual licence — $5,000 to $15,000/year</strong>, by scope: company universe, history depth, and whether the filing-change table is included. Refreshed quarterly for the term.</li>
      <li><strong>Custom one-off snapshot — $500 to $2,000</strong>, same scope dimensions as the annual licence (broader or narrower than the pilot's fixed scope), delivered once with no refreshes.</li>
      <li>No recurring fee on either one-off, and no seat count on the corpus itself. Outside the pilot&#39;s fixed scope, ask with your intended scope and you&#39;ll get a fixed number.</li>
    </ul>`)}
  <div class="seo-section" id="mcp-api"><h2>MCP &amp; API access</h2><div class="seo-about">
    <p>A separate, self-serve surface from the bulk corpus above — no quote needed. Filing-grounded tools reachable two ways: a hosted <strong>MCP endpoint</strong> for agent clients (search, fundamentals, filings, one filing, ask, health), or a plain <strong>REST API</strong> at <code>/api/v1</code> (financials, filing timeline, compare, screen, fund data, ask, health). Every response cites the filing it drew from, the same as everywhere else on this site. Reading the tool list is free on both — only calling a metered tool spends credits.</p>
    <p><strong>Who has access:</strong> the <strong>Dev plan</strong> at $19.99/month (200 credits, self-serve — <a href="/api">full details &rarr;</a>), included with a Power or Desk subscription, the top AppSumo/DealMirror lifetime tier, or any AppSumo/DealMirror tier purchased on or before 22 September 2026. Generate a key from your <a href="/profile.html" rel="nofollow">Profile page</a> once you&#39;re on a qualifying plan.</p>
    <ul>
      <li><strong>MCP</strong> — 2 credits per lookup, 42 credits per AI-backed ask. The agent-native path: your client calls the tools directly, no HTTP code to write.</li>
      <li><strong>REST API</strong> — 2 credits per lookup, 42 credits per ask. Identical pricing to MCP: same call, same filings, same price.</li>
      <li>Both spend from the same monthly AI-credit wallet your plan already includes — no separate quota to track.</li>
      <li>Fund data (<code>/api/v1/fund/:symbol</code> on the REST surface; the MCP endpoint carries SEC-filed company data only) is Yahoo-derived, not SEC-filed, and is for your own research — not for redistribution.</li>
    </ul>
  </div></div>
  ${S('How to start', `<p>Email <a href="mailto:support@stockportfolio.pro">support@stockportfolio.pro</a> with the scope you want — how many companies, how far back, and whether you need the filing-change table — and you&#39;ll get a quote and a sample. Figures are drawn from public SEC filings and provided as-is; verify anything material against the <code>sourceUrl</code> on the row.</p>`)}
  <div class="seo-section"><p style="font-size:13px"><a href="/methodology">How we compute our data &rarr;</a> &middot; <a href="/editorial-policy">Editorial policy &rarr;</a> &middot; <a href="/stocks">Browse stocks &rarr;</a></p></div>
</main>` + footer();
}

// The filing-diff snapshot is written ~20s after boot (app.js), but the
// inventory above caches for 30 minutes on first call. Any request landing in
// that window — a crawler, a health check — would otherwise pin a diffs-less
// sitemap for half an hour after every restart. app.js calls this once the
// snapshot exists so the next build picks it up.
function invalidateSitemapInventory() {
    _sitemapInventoryCache = null;
}

module.exports = {
    renderStockPage, renderStockIndex, buildSitemap, buildSitemapShard, loadCompanies, companyName, hasStockPage,
    resolveCanonicalSymbol, invalidateSitemapInventory,
    renderMethodology, renderEditorialPolicy, renderLicensing, renderApiLanding,
    // shared by seo-extra.js (metric pages / compare pages / screen pages)
    loadFundamentals, esc, num, money, price, pct, ratio, clipName, shortCompanyName, head, nav, footer,
    // The one date source for a symbol's data — used by the sitemap *and* by the
    // page body, so a page can never advertise a freshness its sitemap entry
    // contradicts.
    dataDateFor
};
