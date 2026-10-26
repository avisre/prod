// Public, server-rendered stock pages for the current US-listed stock directory.
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
// Pages quote the LISTED price; the charge is credits.COST (see credits.js).
const COST = credits.LISTED_COST;
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
    description: 'Company financial statements and analysis use verified SEC filing facts, including 10-K, 10-Q, 20-F, 40-F and 6-K filings via EDGAR.',
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
    description: 'AI stock analyst grounded in verified SEC filing facts: company fundamentals, screening, side-by-side comparisons and portfolio tracking.',
    publisher: { '@id': `${SITE}/#org` },
    offers: {
        '@type': 'AggregateOffer', priceCurrency: 'USD', lowPrice: '0', highPrice: '1999.99',
        offerCount: 5,
        offers: [
            { '@type': 'Offer', name: 'Free', price: '0', priceCurrency: 'USD' },
            { '@type': 'Offer', name: 'Monthly', price: '79.99', priceCurrency: 'USD' },
            { '@type': 'Offer', name: 'Annual', price: '649.99', priceCurrency: 'USD' },
            { '@type': 'Offer', name: 'Pro', price: '799.99', priceCurrency: 'USD' },
            { '@type': 'Offer', name: 'Desk', price: '1999.99', priceCurrency: 'USD' }
        ]
    }
});

// ---- data loading (cached) ----
let _companies = null;
function loadCompanies() {
    if (_companies) return _companies;
    try {
        // Use the same exchange-listed directory as application search.
        let file = path.join(DATA, 'us-companies.json');
        if (!fs.existsSync(file)) file = path.join(DATA, 'sp1500-companies.json');
        if (!fs.existsSync(file)) file = path.join(DATA, 'sp500-companies.json');
        const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
        const list = Array.isArray(raw) ? raw : (raw.companies || []);
        _companies = list
            .map((c) => ({ symbol: String(c.symbol || '').toUpperCase(), name: c.name || c.symbol, sector: c.sector || '', index: c.index || '', exchange: c.exchange || '', cik: c.cik || null, securityType: c.securityType || 'stock', securityName: c.securityName || c.name }))
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
let canonicalLookup;
function resolveCanonicalSymbol(input) {
    const normalized = normalizeTicker(input);
    if (!normalized) return null;
    if(!canonicalLookup)canonicalLookup=new Map(loadCompanies().map(c=>[normalizeTicker(c.symbol),c]));
    const match = canonicalLookup.get(normalized) || require('./stock-universe').lookup(normalized);
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
function head(title, description, canonical, jsonld, ask, robots = 'index, follow, max-image-preview:large') {
    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<meta name="robots" content="${esc(robots)}" />
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
<link rel="stylesheet" href="/assets/system.css?v=20261026-ui38" />
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA_ID}',{anonymize_ip:true});</script>
<script type="text/javascript">if(location.hostname.endsWith("stockportfolio.pro"))(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","${CLARITY_ID}");</script>
<script type="application/ld+json">${ORG_LD}</script>
<script type="application/ld+json">${SOFTWARE_LD}</script>${jsonld ? `<script type="application/ld+json">${jsonld}</script>` : ''}${pixelHeadSnippet()}
<style>
  /* v2 design system, self-contained (paper/ink; color = meaning only) */
  :root{--paper:#faf9f6;--surface:#fff;--ink:#1c1b18;--ink2:#5f5c55;--ink3:#8f8b82;--line:#e8e6e0;--line2:#d8d5cd;--accent:#1c1b18;--pos:#1b7a4b;--neg:#b3261e}
  *{box-sizing:border-box}
  body{margin:0;background:var(--paper);color:var(--ink);font-family:'Inter',-apple-system,'Segoe UI',sans-serif;font-size:15px;line-height:1.6;-webkit-font-smoothing:antialiased;font-optical-sizing:auto}
  a{color:var(--accent);text-decoration:none}
  a:hover{color:#000000}
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
  @media(max-width:600px){.seo-table th,.seo-table td{white-space:normal;padding:8px 9px}.seo-table td small{display:block}}
  .seo-lock{border:1px solid var(--line);border-radius:10px;padding:28px 18px;text-align:center;background:var(--surface);margin:18px 0}
  .seo-lock h3{margin:0 0 6px;font-size:17px;font-weight:600;letter-spacing:-.01em}
  .seo-lock p{margin:0 0 14px;color:var(--ink2);font-size:14px;max-width:560px;margin-left:auto;margin-right:auto}
  .seo-next-action{border:1px solid #d8d5cd;border-radius:10px;padding:22px 20px;background:#faf9f6;margin:28px 0}
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
    return `<script>window.__spSkipAutoPageView=true;</script><script src="/assets/app.js?v=20261026-ui38"></script><script>V2.nav(${JSON.stringify(active)});</script>`;
}

function footer() {
    return `<footer class="seo-foot">
  <p><a href="/screens/dividend-stocks">Best dividend stocks</a> &middot; <a href="/screens/high-growth-stocks">Fastest-growing</a> &middot; <a href="/screens/most-profitable-stocks">Most profitable</a> &middot; <a href="/screens/low-pe-stocks">Low P/E value</a> &middot; <a href="/screens/low-peg-stocks">Low PEG</a> &middot; <a href="/screens/highest-free-cash-flow-stocks">Highest free cash flow</a> &middot; <a href="/screens/stocks-below-book-value">Below book value</a> &middot; <a href="/screens/quality-compounders">Quality compounders</a></p>
  <p><a href="/stocks">All stocks</a> &middot; <a href="/tools">Free tools</a> &middot; <a href="/research/shares-outstanding">Shares research</a> &middot; <a href="/research/pe-ratio-history">P/E research</a> &middot; <a href="/research/dilution-scorecard">Dilution dataset</a> &middot; <a href="/">Home</a> &middot; <a href="/screener">Free screener</a> &middot; <a href="/ask">Ask the AI analyst</a> &middot; <a href="/register?plan=monthly">Plans</a> &middot; <a href="/methodology">Methodology</a> &middot; <a href="/editorial-policy">Editorial policy</a> &middot; <a href="/privacy">Privacy</a> &middot; <a href="/terms">Terms</a></p>
  <p class="seo-disc">Company financial figures use verified facts from official SEC filings and link to their sources. Market prices and returns come from dated market data. Calculated figures identify their inputs — no analyst estimates or AI-guessed financial values. See our <a href="/methodology">methodology</a> and <a href="/editorial-policy">editorial policy</a>.</p>
  <p class="seo-disc">Data is provided for informational purposes only and may be delayed or inaccurate. stockportfolio.pro is an analysis and visualization tool and does not provide financial advice. &copy; 2026 stockportfolio.pro.</p>
</footer><script>try{var rm={'/research/shares-outstanding':'research-shares-outstanding','/research/pe-ratio-history':'research-pe-ratio-history','/research/dilution-scorecard':'research-dilution-scorecard'};var pv=JSON.stringify({path:location.pathname,contentId:rm[location.pathname]||null,referrer:document.referrer});(navigator.sendBeacon&&navigator.sendBeacon('/api/track/page_view',new Blob([pv],{type:'application/json'})))||fetch('/api/track/page_view',{method:'POST',headers:{'Content-Type':'application/json'},body:pv,keepalive:true}).catch(function(){})}catch(e){}</script></body></html>`;
}

// ---- stock page ----
// options.quote — a quote-store record ({ price, asOf, source }) fetched by the
// route. Optional: sync callers (tests, scripts) still work and fall back to the
// cached close, which the Price tile then labels as cached rather than current.
function renderStockPage(ticker, options = {}) {
    return require('./verified-seo').profile(ticker, options, module.exports);
}

function renderStockIndex() {
    const snapshot=require('./public-stock-index').view();
    const all = loadCompanies().slice().sort((a, b) => a.name.localeCompare(b.name));
    const bySector = {};
    all.forEach((c) => { (bySector[c.sector || 'Other'] = bySector[c.sector || 'Other'] || []).push(c); });
    const canonical = `${SITE}/stocks`;
    const title = 'Stock Research & Analysis — AI Analyst Grounded in SEC Filings';
    const description = `Explore ${all.length.toLocaleString('en-US')} US-listed securities and ${snapshot.counts.financialReadyIssuers.toLocaleString('en-US')} companies with verified core SEC financials.`;
    const jsonld = JSON.stringify({
        '@context': 'https://schema.org', '@type': 'CollectionPage',
        name: 'Stock fundamentals directory', url: canonical
    });
    const sectorBlocks = Object.keys(bySector).sort().map((sec) => {
        const links = bySector[sec].map((c) => `<a href="/stocks/${esc(c.symbol)}" title="${esc(c.name)}">${esc(c.symbol)} <span style="color:var(--muted)">${esc(c.name)}${c.securityType!=='stock'?' · '+esc(c.securityType):''}</span></a>`).join('');
        return `<div class="seo-section"><h2>${esc(sec)}</h2><div class="seo-links">${links}</div></div>`;
    }).join('');
    return head(title, description, canonical, jsonld, { placeholder: 'Ask about any company — answered from its SEC filings…' }) + nav('company') + `
<main class="seo-wrap">
  <h1 class="seo-h1">Stock fundamentals directory</h1>
  <p class="seo-sub">${snapshot.counts.listedSecurities.toLocaleString('en-US')} directory records: ${all.filter(c=>c.securityType==='stock').length.toLocaleString('en-US')} stock listings and ${all.filter(c=>c.securityType==='closed_end_fund').length.toLocaleString('en-US')} closed-end funds, with legacy units and rights listed separately. ${snapshot.counts.financialReadyIssuers.toLocaleString('en-US')} distinct companies have verified core SEC financial coverage; ${snapshot.counts.recentAnnualIssuers.toLocaleString('en-US')} have recent annual SEC reports. Coverage calculated ${esc(snapshot.asOf)}.</p>
  <p>A ready company has an original annual SEC report filed within 15 months, reporting checked within 35 days, and verified annual income, assets, equity and operating cash flow. Partial and historical profiles remain available with their status. Country does not affect eligibility.</p>
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
    try {const entry=require('./public-stock-index').get(symbol);if(entry?.lastmod)return entry.lastmod;} catch (_) {}
    const { generatedAt, symbols } = loadDataDates();
    return symbols[String(symbol || '').toUpperCase()] || generatedAt;
}
function maxDate(...dates) { return dates.filter(Boolean).sort().pop() || '2026-07-19'; }
function staticPageMtime(route) {
    const names = {
        '/filing-watch': 'filing-watch.html', '/filing-watch-sample': 'filing-watch-sample.html',
        '/': 'index.html', '/register': 'register.html', '/monitor-demo': 'monitor-demo.html', '/features': 'features.html',
        '/screener': 'screener.html', '/ask': 'ask.html', '/support': 'support.html', '/privacy': 'privacy.html',
        '/terms': 'terms.html', '/sitemap': 'sitemap.html', '/gurus': 'gurus.html', '/monitor': 'monitor.html', '/dossier': 'dossier.html',
        // Public pages that were linked from the site but present in no shard at all
        // (measured 2026-09-28, all four answering 200) — without an entry here
        // their lastmod would fall back to this module's own mtime.
        '/verify': 'verify.html', '/company': 'company.html', '/compare-dossiers': 'compare-dossiers.html',
        '/partners': 'partners.html', '/partners-apply': 'partners-apply.html'
    };
    if (route.startsWith('/tools/')) return isoMtime(path.join(__dirname, 'free-tools.js'));
    if (names[route]) return isoMtime(path.join(__dirname, '..', 'frontend-v2', names[route]));
    if (route === '/stocks') return isoMtime(path.join(DATA, 'us-companies.json'));
    if (route === '/compare' || route.startsWith('/screens/') || route.startsWith('/research/')) return isoMtime(path.join(__dirname, 'seo-extra.js'));
    if (route.startsWith('/vs/')) return isoMtime(path.join(__dirname, 'comparison-pages.js'));
    return isoMtime(__filename);
}
function videoMarkup(route) {
    if (route === '/features') return `\n    <video:video>\n      <video:thumbnail_loc>${SITE}/assets/tour-poster.jpg</video:thumbnail_loc>\n      <video:title>stockportfolio.pro — 60-second product tour</video:title>\n      <video:description>A one-minute tour of stockportfolio.pro: the SEC-grounded AI analyst, the free stock screener, and filed fundamentals.</video:description>\n      <video:content_loc>${SITE}/assets/tour-1080p.mp4</video:content_loc>\n      <video:duration>53</video:duration>\n    </video:video>\n    <video:video>\n      <video:thumbnail_loc>https://i.ytimg.com/vi/-3V_IaCOQUo/hqdefault.jpg</video:thumbnail_loc>\n      <video:title>I asked an AI 3 hard finance questions. Every answer came from the SEC filing.</video:title>\n      <video:description>Three hard finance questions answered by stockportfolio.pro's Ask analyst — every answer grounded in the company's actual SEC filing, with the source linked.</video:description>\n      <video:content_loc>https://www.youtube.com/watch?v=-3V_IaCOQUo</video:content_loc>\n      <video:player_loc allow_embed="yes">https://www.youtube.com/embed/-3V_IaCOQUo</video:player_loc>\n    </video:video>`;
    if (route === '/monitor-demo') return `\n    <video:video>\n      <video:thumbnail_loc>${SITE}/assets/monitor-poster.jpg</video:thumbnail_loc>\n      <video:title>Filing Change Monitor — reading NVIDIA's latest 10-Q</video:title>\n      <video:description>The Filing Change Monitor reads what changed in a company's newest filing and links the evidence.</video:description>\n      <video:content_loc>${SITE}/assets/monitor-1080p.mp4</video:content_loc>\n      <video:duration>18</video:duration>\n    </video:video>`;
    return '';
}

function buildSitemapInventory() {
    if (_sitemapInventoryCache && _sitemapInventoryCache.day === new Date().toISOString().slice(0,10) && Date.now() - _sitemapInventoryCache.at < SITEMAP_TTL_MS) return _sitemapInventoryCache.shards;
    const coreRoutes = ['/filing-watch', '/filing-watch-sample', '/', '/zh', '/register', '/monitor-demo', '/features', '/stocks', '/screener', '/compare', '/ask', '/support', '/methodology', '/editorial-policy', '/licensing', '/api', '/connect', '/privacy', '/terms', '/sitemap', '/gurus', '/monitor', '/dossier', '/tools', '/docs', '/verify-ledger', '/filing-changes',
        // Indexable and internally linked, but in no shard until 2026-09-28 — Bing's
        // Site Scan reports exactly this as "important pages missing from sitemaps".
        // /lifetime left this list on 2026-10-07, when direct lifetime sales were retired.
        // /company is deliberately absent: bare /company is a JS-only skeleton (the
        // name is filled in client-side) that nothing links, and /stocks/:symbol
        // already covers per-symbol pages — advertising a thin page is worse than
        // leaving an unlinked URL out of the sitemap. Its `.html` twin still 301s
        // to it, so the redirect table stays file-complete.
        '/verify', '/compare-dossiers', '/partners', '/partners-apply'];
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
    const stocks = require('./public-stock-index').view().securities
        .filter((c) => c.indexable)
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
                const pair=e.p.split('-vs-');
                if (!pair.every(s=>require('./public-stock-index').get(s)?.screenable)) return;
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
    _sitemapInventoryCache = { at: Date.now(), day: new Date().toISOString().slice(0,10), shards };
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
  ${S('Where the data comes from', `<p>Company financial statements and figures labeled as SEC sourced use facts traced to the issuer&#39;s filings with the U.S. Securities and Exchange Commission. The coverage check looks for annual reports (Form 10-K, 20-F or 40-F); quarterly observations may come from 10-Q or 6-K filings. We link each reported fact to its source filing. Calculated figures identify their inputs and formula. Prices and returns come from dated market data, not SEC filings. See <a href="https://www.sec.gov/search-filings/edgar-application-programming-interfaces" rel="noopener nofollow" target="_blank">SEC EDGAR APIs</a>.</p>`)}
  ${S('Coverage &amp; history', `<p>The public directory contains ${require('./public-stock-index').view().counts.listedSecurities.toLocaleString('en-US')} securities. ${require('./public-stock-index').view().counts.financialReadyIssuers.toLocaleString('en-US')} distinct issuers have a recent original 10-K, 20-F or 40-F and verified annual net income, assets, equity, operating cash flow, plus revenue or EPS. SEC reporting checks expire after 35 days. Country does not affect coverage. Partial and historical data is labelled separately.</p>`)}
  ${S('How often it updates', `<p>The full stock universe is reconciled weekly. Requested companies are checked for newer filings when the last successful check is over six hours old, and whenever required information is missing. A failed SEC request does not erase the last successful evidence. Profile pages show the fiscal period, filing date, verification date, and market-data date separately.</p>`)}
  ${S('How metrics are computed', `<p>All metrics are deterministic functions of filed line items — no AI, no editorial judgement, no hand-tuning:</p>
    <ul>
      <li><strong>Revenue, net income, assets, equity, earnings per share and operating cash flow</strong> — shown only when a compatible SEC fact is available. Gross profit is calculated from verified revenue and cost of revenue when both have matching periods, units and source evidence. Unavailable metrics remain blank.</li>
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
    const description = 'A REST API and hosted MCP server over US SEC filings. Every value carries the filing it came from. $200/mo for 200 credits, no sales call.';
    const jsonld = JSON.stringify({
        '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'stockportfolio.pro API & MCP server', url: canonical,
        applicationCategory: 'DeveloperApplication', operatingSystem: 'Any',
        publisher: { '@id': `${SITE}/#org` }, isBasedOn: 'https://www.sec.gov/edgar',
        offers: { '@type': 'Offer', price: '200.00', priceCurrency: 'USD', description: 'Dev plan — 200 API/MCP credits per month' }
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
  <p class="seo-sub">A REST API and a hosted MCP server over US SEC filings. Every value carries the filing it came from — <code>null</code> when the filing is silent, never interpolated. No sales call, no minimum contract: $200/mo.</p>

  <div class="seo-next-action">
    <p class="seo-next-action-kicker">Dev plan</p>
    <h2>$200/month — 200 credits, every tool</h2>
    <p>One API key covers both surfaces: the REST API at <code>/api/v1</code> and the MCP server at <code>/mcp</code>. A data lookup costs ${COST.mcp_lookup} credits, an AI answer ${COST.mcp_ask}, the same on both surfaces. Credits reset monthly. Cancel any time.</p>
    <p><a class="seo-cta-btn" href="/register?plan=dev">Get a key &rarr;</a></p>
    <p style="font-size:13px;margin-top:10px">Already on Power or Desk? API/MCP access is included — generate a key from your <a href="/profile.html" rel="nofollow">Profile page</a>.</p>
    <p style="font-size:13px;margin-top:6px">Not writing code? The same server is listed in the Claude connector directory and the ChatGPT app directory — <a href="/connect">add it there in one step &rarr;</a></p>
  </div>

  ${S('Make a call in two minutes', `<p>One key, one header. This is the actual response for <code>NVDA</code>, captured from the live extractor:</p>
    <pre style="background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px;overflow-x:auto;font-size:12.5px;line-height:1.5">${esc(curlExample)}</pre>
    <pre style="background:var(--surface);border:1px solid var(--line);border-radius:10px;padding:14px;overflow-x:auto;font-size:12.5px;line-height:1.5">${esc(jsonExample)}</pre>
    <p>Every response — including every error — carries that <code>citation</code> block. It is what makes the data usable in an agent: the model can point at the filing rather than assert a number.</p>`)}

  ${S('The tools', `<p>Each surface lists its own catalog, because they are not the same shape: the MCP endpoint is built for an agent to route on, so its tools are named for the question they answer, while the REST API mirrors the website's free tools one route at a time.</p>
  <table class="seo-table">
    <thead><tr><th>MCP tool (${esc('POST /mcp')})</th><th>What it returns</th><th>Credits</th></tr></thead>
    <tbody>
      <tr><td><code>search_companies</code></td><td>Name or ticker → ticker, company name, SEC CIK</td><td>${COST.mcp_lookup}</td></tr>
      <tr><td><code>get_company_fundamentals</code></td><td>Filed statements by fiscal period — revenue, margins, EPS, cash flow, debt, shares — each figure with its filing</td><td>${COST.mcp_lookup}</td></tr>
      <tr><td><code>search_filings</code></td><td>Filings by type and date range, with direct EDGAR links</td><td>${COST.mcp_lookup}</td></tr>
      <tr><td><code>get_filing</code></td><td>One filing's metadata and content, by accession number or ticker</td><td>${COST.mcp_lookup}</td></tr>
      <tr><td><code>ask_filings</code></td><td>A filing-grounded answer, with the figures and citations behind it</td><td>${COST.mcp_ask}</td></tr>
      <tr><td><code>get_recent_filings</code></td><td>Each covered company's most recent 10-K/10-Q/20-F/40-F and 8-K earnings release, newest first</td><td>${COST.mcp_lookup}</td></tr>
      <tr><td><code>screen_companies</code></td><td>Screen the covered universe on growth, margins, returns, valuation, index and price trend (signed-in accounts)</td><td>${COST.mcp_lookup}</td></tr>
      <tr><td><code>get_filing_changes</code></td><td>What changed between a company's newest filing and its previous one of the same form, quoted from both (signed-in accounts)</td><td>${COST.mcp_ask}</td></tr>
      <tr><td><code>get_red_flags</code></td><td>Conservative warning signs computed from the filed statements, with the figures behind each</td><td>${COST.mcp_lookup}</td></tr>
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
      <li><strong>Filed, not estimated.</strong> The directory has ${require('./public-stock-index').view().counts.listedSecurities.toLocaleString('en-US')} security listings. ${require('./public-stock-index').view().counts.financialReadyIssuers.toLocaleString('en-US')} distinct issuers currently meet the verified core financial coverage rules. Other issuers remain labeled partial, historical, or unavailable.</li>
      <li><strong>Not investment advice</strong>, and not a quote feed. Market data — prices, market cap, P/E — comes from a third-party feed we don't hold redistribution rights to, which is why the API is filing-grounded by design.</li>
      <li><strong>Fund data is different.</strong> <code>sp_fund</code> is Yahoo-derived, for your own research, and not for redistribution.</li>
      <li><strong>Bulk corpus licensing</strong> (the whole dataset, for training or redistribution) is a separate arrangement — see <a href="/licensing">data licensing</a>.</li>
    </ul>`)}
  <div class="seo-section"><p style="font-size:13px"><a href="/licensing">Data licensing &amp; terms &rarr;</a> &middot; <a href="/methodology">Methodology &rarr;</a> &middot; <a href="/tools">Free tools (no key needed) &rarr;</a></p></div>
</main>` + footer();
}

// ---- Claude & ChatGPT connector landing (/connect) ----
// The page for someone who is NOT a developer: they use Claude or ChatGPT and
// want filing answers there. Everything that announces the directory listings —
// the homepage badge, the footer, the cap-hit message inside the assistant, the
// launch posts — lands here, so the two outbound listing links exist in exactly
// one place (lib/connector-listings.js) and nowhere else on the site.
//
// The trial figures are read from mcp-trial's config rather than typed,
// because they are env-switchable and the docs once said "two" while the code
// said three. The worked example reuses the NVDA response captured for /api
// above — same rule as there: a number on the page is a number the product
// returns.
function renderConnect() {
    const canonical = `${SITE}/connect`;
    const listings = require('../lib/connector-listings').list();
    const trial = require('./mcp-trial').config();
    const title = 'StockPortfolio in Claude and ChatGPT — SEC filing answers, cited';
    const description = 'StockPortfolio is listed in the Claude connector directory and the ChatGPT app directory. Add it once and ask about any US company — every figure cites its SEC filing.';
    // The offer since 2026-10-26 (owner decision): keyless calls are closed and
    // free evaluation is a per-account trial, so the page sells signing up, not
    // an anonymous allowance.
    const free = `a free ${trial.days}-day trial for a free account created on the connector's sign-in screen: ${trial.lookups} data lookups and ${trial.asks} AI answers, once per account, with no renewal`;
    const faq = [
        ['Is StockPortfolio available in Claude?', `Yes. StockPortfolio is listed in the Claude connector directory. Add it from Claude's connector settings and ask about a company; answers come from SEC filings and each figure carries its source.`],
        ['Is StockPortfolio available in ChatGPT?', `Yes. StockPortfolio is listed in the ChatGPT app directory. Add it there and ask about a company in any conversation.`],
        ['Is it free?', `To start, ${free}. Create the account when the connector asks you to sign in, and the ${trial.days} days run from your first tool call. Accounts made on the website start on a paid plan. Past the trial, the Monthly plan is $79.99 a month: the connector and the full website, with 200 credits a month. Through the connector a data lookup costs ${COST.mcp_lookup} credits and an AI answer ${COST.mcp_ask}, and a top-up adds 150 credits for $14.99.`],
        ['Where do the numbers come from?', 'From the company\'s own SEC filings — 10-K, 10-Q and 8-K. A value the filing does not report comes back empty; it is never estimated. Every figure carries a link to the filing it was read from.'],
        ['I already have a StockPortfolio plan. Do I pay again?', `No. Sign in from the connector with your StockPortfolio account and it spends the credits your plan already includes, on the plans that carry API and MCP access. Through the connector a data lookup costs ${COST.mcp_lookup} credits and an AI answer ${COST.mcp_ask}, so the 200 credits on Monthly cover ${Math.floor(200 / COST.mcp_lookup)} lookups or ${Math.floor(200 / COST.mcp_ask)} AI answers a month, the 300 on Annual cover ${Math.floor(300 / COST.mcp_lookup)} lookups or ${Math.floor(300 / COST.mcp_ask)} AI answers, and the 600 on Pro cover ${Math.floor(600 / COST.mcp_lookup)} lookups or ${Math.floor(600 / COST.mcp_ask)} AI answers. If you run out, a top-up adds 150 credits for $14.99.`]
    ];
    const jsonld = JSON.stringify([
        { '@context': 'https://schema.org', '@type': 'SoftwareApplication', name: 'StockPortfolio connector for Claude and ChatGPT', url: canonical,
          applicationCategory: 'FinanceApplication', operatingSystem: 'Any', publisher: { '@id': `${SITE}/#org` }, isBasedOn: 'https://www.sec.gov/edgar',
          offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD', description: `Free to try: ${free}` } },
        { '@context': 'https://schema.org', '@type': 'FAQPage',
          mainEntity: faq.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })) }
    ]);
    const S = (h, body) => `<div class="seo-section"><h2>${h}</h2><div class="seo-about">${body}</div></div>`;
    const card = (l) => `<div class="seo-next-action" id="${l.key}" style="margin:0">
      <p class="seo-next-action-kicker">Listed in ${esc(l.directory)}</p>
      <h2>Add to ${esc(l.name)}</h2>
      <p>${l.find} When it asks you to sign in, create a free account there and the ${trial.days}-day trial starts at your first tool call.</p>
      ${l.url ? `<p><a class="seo-cta-btn" href="${esc(l.url)}" target="_blank" rel="noopener" data-connect="${l.key}">Open the ${esc(l.name)} listing &rarr;</a></p>` : ''}
    </div>`;
    return head(title, description, canonical, jsonld) + nav() + `
<main class="seo-wrap">
  <div class="seo-crumbs"><a href="/">Home</a> / Claude &amp; ChatGPT</div>
  <h1 class="seo-h1">Ask SEC filings from inside Claude or ChatGPT</h1>
  <p class="seo-sub">StockPortfolio is listed in both directories. Add it once, then ask about any covered US company in the assistant you already use — every figure comes back with the SEC filing it was read from. Free to try: ${free}. After that it is on the Monthly plan, $79.99 a month.</p>

  <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:16px;margin:28px 0">
    ${listings.map(card).join('\n    ')}
  </div>

  <div class="seo-section"><h2>Watch it answer a real question</h2><div class="seo-about">
    <p>Claude is asked for Micron&#39;s last eight quarters of revenue, gross profit and free cash flow. Each row comes back with the 10-Q or 10-K it was read from. 34 seconds, no sound.</p>
    <div style="position:relative;width:100%;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:#000;aspect-ratio:16/9;margin-top:12px">
      <video controls preload="none" playsinline poster="/assets/connect-claude-poster.jpg" width="1280" height="720" style="width:100%;height:100%;display:block;background:#000" aria-label="Claude answering a Micron filing question through the StockPortfolio connector">
        <source src="/assets/connect-claude-1080p.mp4" type="video/mp4">
        <source src="/assets/connect-claude-720p.mp4" type="video/mp4">
        <a href="/assets/connect-claude-1080p.mp4">Download the demo (MP4)</a>
      </video>
    </div>
  </div></div>

  ${S('What to ask', `<ul>
      <li>&ldquo;What did NVIDIA report for revenue and free cash flow last fiscal year? Cite the filing.&rdquo;</li>
      <li>&ldquo;What has Apple filed in the last 90 days, and what changed in the latest 10-Q?&rdquo;</li>
      <li>&ldquo;Compare Microsoft and Alphabet on operating margin over five years, from filed numbers only.&rdquo;</li>
    </ul>
    <p>The first one returns this, straight from the filed statements for the fiscal year ended 2026-01-31:</p>
    <table class="seo-table">
      <thead><tr><th>NVDA, as filed</th><th>Value</th></tr></thead>
      <tbody>
        <tr><td>Revenue</td><td>$215.9B</td></tr>
        <tr><td>Net income</td><td>$120.1B</td></tr>
        <tr><td>Operating cash flow</td><td>$102.7B</td></tr>
        <tr><td>Free cash flow</td><td>$96.7B</td></tr>
      </tbody>
    </table>
    <p style="margin-top:12px">Each value arrives with a link to the filer&#39;s EDGAR record, so the assistant can point at the document instead of asserting a number. Where a filing is silent the value is empty, never filled in.</p>`)}

  ${S('For advisers, analysts and fund managers', `<p>If a number is going into a client note, a model or a published piece, it has to trace back to the filing. These are the questions the connector is built for:</p>
    <ul>
      <li>&ldquo;Pull the last eight quarters of revenue, gross margin and free cash flow for Micron, and cite the filing for each quarter.&rdquo;</li>
      <li>&ldquo;How have Kroger&#39;s shares outstanding changed over the last five fiscal years? Link the filing for each year.&rdquo;</li>
      <li>&ldquo;I am about to publish these three figures for Adobe. Check each one against the filing it came from.&rdquo;</li>
    </ul>
    <p>The assistant does the reading and the arithmetic; the connector supplies only what the company filed, with the link, so every figure can be checked before it leaves your desk.</p>`)}

  ${S('What it costs', `<p><strong>Free trial:</strong> ${free} — create the account on the connector's sign-in screen and the ${trial.days} days run from your first tool call. Nothing to install.</p>
    <p><strong>Monthly plan — $79.99/month:</strong> the connector and the full StockPortfolio.pro website, with 200 credits a month. Through the connector a data lookup costs ${COST.mcp_lookup} credits and an AI answer ${COST.mcp_ask}, so 200 credits is ${Math.floor(200 / COST.mcp_lookup)} lookups or ${Math.floor(200 / COST.mcp_ask)} AI answers; a top-up adds 150 credits for $14.99. Cancel any time. <a href="/register?plan=monthly&amp;utm_source=website&amp;utm_campaign=connect">Start the Monthly plan &rarr;</a></p>
    <p><strong>Dev plan — $200/month:</strong> the API and connector without the website. 200 credits. A data lookup costs ${COST.mcp_lookup} credits and an AI answer ${COST.mcp_ask}. Cancel any time. <a href="/register?plan=dev&amp;utm_source=website&amp;utm_campaign=connect">Get the Dev plan &rarr;</a></p>
    <p><strong>Already a customer?</strong> Sign in from the connector and it spends the credits your plan already includes. Which plans carry API and MCP access is on the <a href="/docs/plans">plans page</a>.</p>`)}

  ${S('Questions', faq.map(([q, a]) => `<p style="margin-bottom:14px"><strong>${esc(q)}</strong><br>${esc(a)}</p>`).join(''))}

  <div class="seo-section"><p style="font-size:13px">Building your own agent? <a href="/api">API &amp; MCP for developers &rarr;</a> &middot; <a href="/docs/api-mcp">Setup guide for every client &rarr;</a> &middot; <a href="/methodology">Methodology &rarr;</a></p></div>
  <div class="seo-section"><p style="font-size:12px;color:var(--ink3)">Claude is a product of Anthropic and ChatGPT a product of OpenAI. StockPortfolio is an independent service listed in their directories; it is not affiliated with either company. Nothing here is investment advice.</p></div>
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
    <p>A separate, self-serve surface from the bulk corpus above — no quote needed. Filing-grounded tools reachable two ways: a hosted <strong>MCP endpoint</strong> for agent clients (search, fundamentals, filings, one filing, ask, health), or a plain <strong>REST API</strong> at <code>/api/v1</code> (financials, filing timeline, compare, screen, fund data, ask, health). Every response cites the filing it drew from, the same as everywhere else on this site. Reading the tool list is free on both — only calling a metered tool spends credits. The MCP endpoint is also listed in the Claude connector directory and the ChatGPT app directory — <a href="/connect">add it from either &rarr;</a></p>
    <p><strong>Who has access:</strong> the <strong>Dev plan</strong> at $200/month (200 credits, self-serve — <a href="/api">full details &rarr;</a>), included with a Monthly, Annual, Pro, Power or Desk subscription, the Investor and Pro AppSumo/DealMirror lifetime tiers, or any AppSumo/DealMirror tier purchased on or before 22 September 2026. Generate a key from your <a href="/profile.html" rel="nofollow">Profile page</a> once you&#39;re on a qualifying plan.</p>
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
    renderMethodology, renderEditorialPolicy, renderLicensing, renderApiLanding, renderConnect,
    // shared by seo-extra.js (metric pages / compare pages / screen pages)
    loadFundamentals, esc, num, money, price, pct, ratio, clipName, shortCompanyName, head, nav, footer,
    // The one date source for a symbol's data — used by the sitemap *and* by the
    // page body, so a page can never advertise a freshness its sitemap entry
    // contradicts.
    dataDateFor
};
