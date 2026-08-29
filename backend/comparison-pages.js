// Public comparison landing pages — target high-intent "X alternative" searches.
// Facts (competitor pricing/positioning) are kept deliberately conservative and
// sourced from public pricing pages; claims are about stockportfolio.pro's own
// strengths rather than disparaging competitors.

const SITE = 'https://www.stockportfolio.pro';
const CLARITY_ID = 'x0dsu053xa';
const GA_ID = 'G-4K10D2FPTT';
const OG_IMAGE = `${SITE}/og.png`; // 1200×630 social card (frontend/og.png)
const { pixelHeadSnippet } = require('./pixels'); // env-driven retargeting (no-op when unset)

// Sitewide JSON-LD entities. Kept in sync with seo-pages.js (this module is
// deliberately self-contained, mirroring how it already duplicates SITE/GA_ID).
const ORG_LD = JSON.stringify({
    '@context': 'https://schema.org', '@type': 'Organization',
    '@id': `${SITE}/#org`, name: 'stockportfolio.pro', url: SITE,
    logo: `${SITE}/Media/icon.png`,
    description: 'US stock fundamentals, financial statements and analysis computed deterministically from official SEC filings (10-K/10-Q via EDGAR).',
    foundingDate: '2024',
    sameAs: ['https://www.sec.gov/edgar']
});
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
        '@type': 'AggregateOffer', priceCurrency: 'USD', lowPrice: '0', highPrice: '250',
        offerCount: 5,
        offers: [
            { '@type': 'Offer', name: 'Free', price: '0', priceCurrency: 'USD' },
            { '@type': 'Offer', name: 'Monthly', price: '12', priceCurrency: 'USD' },
            { '@type': 'Offer', name: 'Annual', price: '118', priceCurrency: 'USD' },
            { '@type': 'Offer', name: 'Pro', price: '33', priceCurrency: 'USD' },
            { '@type': 'Offer', name: 'Pro Annual', price: '250', priceCurrency: 'USD' }
        ]
    }
});

function esc(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const COMPETITORS = {
    'sharesight': {
        name: 'Sharesight',
        slug: 'sharesight',
        blurb: 'Sharesight is a well-established portfolio tracker focused on performance and tax reporting, popular with investors who want detailed dividend and capital-gains records.',
        theirPrice: 'Free up to 10 holdings; paid tiers roughly $7–$23/month (billed annually).',
        rows: [
            ['Monthly price', '$12/mo, 7-day free trial', '$7–$23/mo (annual billing)'],
            ['Free / trial', '7-day free trial, cancel anytime', 'Free up to 10 holdings'],
            ['Company fundamentals', 'Income, balance sheet & cash flow built in', 'Limited; focus is performance & tax'],
            ['Portfolio tracking', 'Yes — holdings, allocation, performance', 'Yes — strong tax & dividend reporting'],
            ['Market news', 'Built-in news feed', 'Limited'],
            ['Broker connection required', 'No — manual or CSV, you keep your data', 'Optional broker imports'],
            ['Best for', 'A calm weekly review of holdings + fundamentals in one place', 'Detailed tax & dividend record-keeping']
        ]
    },
    'stock-rover': {
        name: 'Stock Rover',
        slug: 'stock-rover',
        blurb: 'Stock Rover is a powerful research and screening platform aimed at US investors who want deep screeners, ratings and detailed data tables.',
        theirPrice: 'Free plan available; paid tiers roughly $7–$28/month.',
        rows: [
            ['Monthly price', '$12/mo, 7-day free trial', '$7–$28/mo'],
            ['Free / trial', '7-day free trial, cancel anytime', 'Free plan + paid trials'],
            ['Learning curve', 'Simple, calm, opinionated UI', 'Powerful but dense — lots of screens'],
            ['Company fundamentals', 'Clean income, balance sheet & cash flow', 'Extensive data & screeners'],
            ['Portfolio tracking', 'Yes — holdings, allocation, performance', 'Yes'],
            ['Broker connection required', 'No — manual or CSV', 'No'],
            ['Best for', 'Long-term investors who want clarity, not 50 panels', 'Power users who screen and research heavily']
        ]
    },
    'macrotrends': {
        name: 'Macrotrends',
        slug: 'macrotrends',
        blurb: 'Macrotrends is a long-running free reference site for historical stock charts and financial-statement data, with decades of history on large caps. It is a lookup tool rather than a research workspace.',
        theirPrice: 'Free tier (ad-supported); paid subscription unlocks more data and downloads.',
        rows: [
            ['Price', 'Free stock pages & screener; $12/mo for the full workspace', 'Free tier with ads; paid unlocks downloads'],
            ['Fundamentals depth', 'Up to 19 years annual + 48 quarters, from SEC filings', 'Long histories, sourced from Zacks'],
            ['AI research assistant', 'Yes — Ask answers from SEC filings, sources shown', 'No'],
            ['Portfolio tracking', 'Yes — holdings, allocation, X-Ray, alerts', 'No'],
            ['Screener', 'Free, S&P 1500, fundamentals-based', 'Free, 50+ filters'],
            ['Workflow', 'One workspace: statements, ratios, health checks, Ask', 'Page-by-page chart lookups'],
            ['Best for', 'Researching and tracking your own portfolio in one place', 'Quick free chart lookups']
        ]
    },
    'stockanalysis': {
        name: 'StockAnalysis.com',
        slug: 'stockanalysis',
        blurb: 'StockAnalysis.com is a popular free site for clean stock statistics and financial statements, with a Pro tier for deeper history and exports.',
        theirPrice: 'Free site; Pro about $9.99/month (or $79/year), Unlimited $199/year.',
        rows: [
            ['Price', 'Free stock pages & screener; $12/mo full workspace', 'Free; Pro ~$9.99/mo'],
            ['Fundamentals depth', 'Up to 19 years annual + 48 quarters, from SEC filings', '10+ yrs free, more on Pro'],
            ['AI research assistant', 'Yes — Ask answers from SEC filings, sources shown', 'No'],
            ['Portfolio tracking', 'Yes — holdings, allocation, X-Ray, SEC filing alerts', 'Watchlists'],
            ['Health checks', 'Plain-English pass/fail checks per company', 'No'],
            ['Best for', 'Going from research to tracking an actual portfolio', 'Fast free data lookups']
        ]
    },
    'koyfin': {
        name: 'Koyfin',
        slug: 'koyfin',
        blurb: 'Koyfin is a professional-grade market dashboard with broad asset coverage (equities, macro, FX) aimed at advanced users and advisors.',
        theirPrice: 'Free plan; Plus ~$39/month and Premium ~$79/month (annual billing); advisor tiers from $209/month.',
        rows: [
            ['Monthly price', '$12/mo; Pro with AI analyst $33/mo', 'Plus ~$39/mo, Premium ~$79/mo (annual)'],
            ['Free / trial', 'Free screener & stock pages; 7-day trial on paid', 'Free plan with limits'],
            ['Fundamentals depth', 'Up to 19 years, SEC-filed, with health checks', 'Deep, multi-asset, customizable dashboards'],
            ['AI research assistant', 'Yes — grounded in SEC filings, sources shown', 'Limited'],
            ['Learning curve', 'Calm, opinionated, one workspace', 'Powerful but dashboard-heavy'],
            ['Best for', 'Long-term US-equity investors at a fraction of the price', 'Multi-asset pros and advisors']
        ]
    },
    'fiscal-ai': {
        name: 'Fiscal.ai',
        slug: 'fiscal-ai',
        blurb: 'Fiscal.ai (formerly FinChat) is an AI-first stock research platform known for KPI datasets and copilot-style chat over company data.',
        theirPrice: 'Free plan; Pro ~$39/month billed annually ($49 monthly); Max ~$79/month billed annually.',
        rows: [
            ['Monthly price', 'Pro with AI analyst $33/mo; Core $12/mo', 'Pro ~$39/mo, Max ~$79/mo (annual billing)'],
            ['AI grounding', 'Answers only from SEC filings + live web, sources shown; refuses when unsure', 'AI copilot over its datasets'],
            ['Fundamentals depth', 'Up to 19 years annual + 48 quarters, SEC-filed', '10+ yrs, 20+ on Max; segment KPIs'],
            ['Portfolio tracking', 'Yes — holdings, X-Ray, SEC filing alerts', 'Watchlists & dashboards'],
            ['Free tier', 'Free screener + 1,500 free stock data pages', 'Free plan with limits'],
            ['Best for', 'SEC-grounded answers + portfolio at half the price', 'KPI-heavy deep dives on global names']
        ]
    },
    'tikr': {
        name: 'TIKR',
        slug: 'tikr',
        blurb: 'TIKR is a research terminal built on S&P Capital IQ data, popular for global coverage and superinvestor portfolio tracking.',
        theirPrice: 'Free plan (limited); Plus ~$24.95/month; Pro ~$54.95/month.',
        rows: [
            ['Monthly price', '$12/mo; Pro with AI analyst $33/mo', 'Plus ~$24.95/mo, Pro ~$54.95/mo'],
            ['Data source', 'Official SEC filings, refreshed nightly', 'S&P Capital IQ (global)'],
            ['AI research assistant', 'Yes — grounded in SEC filings, sources shown', 'No'],
            ['US coverage', 'Every USD-reporting US-listed company, 19 yrs', 'Global, full history on Pro'],
            ['Portfolio tracking', 'Yes — holdings, allocation, X-Ray, alerts', 'Yes + superinvestor tracking'],
            ['Best for', 'US-focused investors who want grounded AI + filings', 'Global coverage and guru-watching']
        ]
    },
    'simply-wall-st': {
        name: 'Simply Wall St',
        slug: 'simply-wall-st',
        blurb: 'Simply Wall St is known for its visual "snowflake" company analysis and is popular with investors who like infographic-style research.',
        theirPrice: 'Free plan available; paid roughly $10/month (annual billing).',
        rows: [
            ['Monthly price', '$12/mo, 7-day free trial', '~$10/mo (annual billing)'],
            ['Free / trial', '7-day free trial, cancel anytime', 'Free plan + paid annual'],
            ['Fundamentals format', 'Real statements: income, balance, cash flow', 'Visual infographics & summaries'],
            ['Portfolio tracking', 'Yes — holdings, allocation, performance', 'Yes'],
            ['Market news', 'Built-in news feed', 'Yes'],
            ['Broker connection required', 'No — manual or CSV, you keep your data', 'Optional'],
            ['Best for', 'Investors who want the actual numbers + their portfolio', 'Investors who prefer visual snapshots']
        ]
    },
    "wallstreetzen": {
        name: "WallStreetZen",
        slug: "wallstreetzen",
        blurb: "WallStreetZen is a stock research platform built around a 115-factor quantitative rating system (Zen Ratings) and transparent analyst performance rankings, aimed at part-time investors who want screeners and due diligence tools.",
        theirPrice: "Free tier (limited screener); Premium $19.50/month when billed yearly ($234/year) or $59/month if paid monthly; 14-day trial for $1.",
        rows: [
            ["Monthly price (annual plan)","$12/mo; 7-day free trial on paid app, cancel anytime","~$19.50/mo when paid yearly ($234/yr); $1 trial, 14-day access"],
            ["Fundamentals depth","Up to 19 years annual + 48 quarters, from SEC filings; health checks included","Historical fundamentals + 115-factor Zen Ratings; no explicit statement of years back"],
            ["AI research assistant","Yes — Ask answers from SEC filings, sources shown; refuses when unsure","No AI assistant; offers analyst rankings and due diligence checks instead"],
            ["Analyst ratings & consensus","No analyst consensus or call transcripts included","Ranks 130+ top analysts by historical accuracy, win rate, and returns; shows analyst consensus — a genuine strength"],
            ["Portfolio tracking","Yes — holdings, allocation, X-Ray (look-through P/E), SEC filing-change alerts","No portfolio tracking; watchlists only"],
            ["Public access","Free public screener + per-stock data pages (no login required); 7-day paid trial","Limited free screener; Premium required for full features"],
            ["Best for","Researching and tracking your own portfolio with real SEC filings in one calm workspace","Part-time investors who want a screener backed by transparent analyst performance data"]
        ]
    },
    "seeking-alpha": {
        name: "Seeking Alpha",
        slug: "seeking-alpha",
        blurb: "Established investment research platform with expert-contributor analysis, analyst consensus ratings, and earnings-call transcripts focused primarily on US-listed stocks.",
        theirPrice: "$33/month equivalent (~$299/year standard, currently $225/year summer sale June-July 2026)",
        rows: [
            ["Data depth","Up to 19 annual years + 48 quarters from SEC 10-K/10-Q via EDGAR; deterministic, health-checked","Quant Rating system scores based on 100+ metrics; does not publish historical-depth years covered"],
            ["AI research tool","Conversational Ask (portfolio + company Q&A), grounded only in SEC filings + live web, shows sources, refuses when unsure","Expert-contributor articles + AI-generated earnings-call summaries; no portfolio-aware questioning"],
            ["Analyst consensus & estimates","NOT AVAILABLE","Wall Street consensus ratings, earnings/revenue estimates, revision tracking from professional analysts — a genuine strength"],
            ["International & multi-asset coverage","US-only (3,835 stocks in screener); no bonds, ETFs, funds, or international stocks","Global coverage including international stocks, plus some ETF/fund analysis"],
            ["Earnings transcripts & calls","NOT INCLUDED; use SEC filings only","Full earnings-call transcripts, audio, and AI-generated insights summaries included — a genuine strength"],
            ["Best for","Hands-on portfolio holders who want filing-grounded AI explanations of their own holdings and deep SEC-filing research","Investors seeking broad analyst consensus, earnings-call insights, and global market coverage with a research-community foundation"]
        ]
    },
    "gurufocus": {
        name: "GuruFocus",
        slug: "gurufocus",
        blurb: "GuruFocus is a value-investing research platform tracking institutional investor trades and providing a 500+ filter screener across 100 global markets with 20+ years of financial history.",
        theirPrice: "Premium ~$449/year (US data); Premium Plus ~$1,335/year (global); Professional ~$2,385/year (API + tools). 7-day free trial; 30-day money-back guarantee.",
        rows: [
            ["Geographic coverage","US only (~3,835 stocks)","100+ markets globally (100,000+ stocks including Europe, Asia, Canada, Latin America) — a genuine strength"],
            ["Historical depth","Up to 19 annual years + 48 quarters (deterministic from SEC 10-K/10-Q)","30+ years of fundamental data; U.S. data back to 2006"],
            ["Analyst ratings & consensus","None — AI analysis is sourced from SEC filings, grounded, and disclosed","Built-in analyst ratings dashboard, price targets, earnings call transcripts — a genuine strength"],
            ["Stock screening","Free screener + data pages; fundamentals + valuation focus","500+ filter screener (fundamentals, valuation, profitability, growth, gurus, insiders); Buffett/Ben Graham strategy templates"],
            ["Institutional trade tracking","Filing-change alerts; no guru portfolio tracking","8,000+ institutional investor tracking; real-time guru trades (Buffett, Icahn, etc.) with weekly updates — a genuine strength"],
            ["Best for","US investors seeking AI-driven, filing-sourced analysis with transparent reasoning at low cost","Global value investors tracking guru moves, earnings calls, and analyst consensus across 100 markets"]
        ]
    },
    "finviz": {
        name: "Finviz",
        slug: "finviz",
        blurb: "Finviz is an established browser-based stock screener and research platform focused on technical and fundamental visualization with real-time data and backtesting capabilities.",
        theirPrice: "$39.50/month or $299.50/year (~$25/month annually); 7-day free trial",
        rows: [
            ["Historical financial depth","Up to 19 years of annual data + 48 quarters from verified SEC filings (10-K/10-Q)","Current fundamentals + analyst estimates; limited historical depth — a weakness"],
            ["Research sources","SEC filings + AI analysis (no third-party analyst ratings or transcripts)","No analyst consensus, ratings, or earnings call transcripts; visualization-focused"],
            ["Screening & technical analysis","Fundamental + technical filters tied to actual SEC data","60+ filter criteria (technical, fundamental); backtesting included — a genuine strength"],
            ["Data source & transparency","Direct SEC filings (10-K, 10-Q) with sourced AI reasoning; refuses when unsure","Compiled market data from multiple sources; aggregation details limited"],
            ["Geographic coverage","US stocks only (~3,835 in screener)","US-focused (~10,000 US stocks) + some international via ADRs — broader"],
            ["Best for","Long-term investors & portfolio trackers seeking deep SEC filing analysis + real-time filing-change alerts","Active traders & technicians who value advanced backtesting, technical screening, and pre-market data"]
        ]
    },
    "morningstar": {
        name: "Morningstar Investor",
        slug: "morningstar",
        blurb: "Independent research platform with proprietary analyst ratings and fundamental analysis covering 600,000+ stocks, ETFs, and mutual funds globally.",
        theirPrice: "$249/year (~$21/month; often $199 first year); $34.95/month monthly billing; 7-day free trial",
        rows: [
            ["Geographic Coverage","US only (3,835 stocks); no international","Global: 600,000+ securities across US, Europe, Asia, emerging markets — a genuine strength"],
            ["Analyst Research & Ratings","No analyst estimates; AI analysis grounded in SEC filings only","Proprietary independent analyst team; star ratings, Medalist ratings, fair-value estimates — a genuine strength"],
            ["Historical Financial Depth","Up to 19 annual years + 48 quarters from SEC filings; deterministic, compliance-verified","Core fundamentals (balance sheet, P&L, cash flow) for listed companies; less depth explicitly detailed"],
            ["Portfolio Tracking & Analysis","Holdings view, X-Ray (look-through P/E), filing-change alerts, 7-day free trial","Portfolio X-Ray, Stock Intersection tool, customizable watchlists, manual entry (no auto-linking)"],
            ["Earnings Calls & Consensus Estimates","None; no earnings call transcripts, no analyst consensus","None; does not provide earnings call transcripts or consensus estimates"],
            ["Best for","US stock research grounded in SEC filings; AI-assisted due diligence with sourced reasoning","Global fund/ETF research and long-term fundamental stock analysis using proprietary analyst ratings"]
        ]
    },
    "yahoo-finance": {
        name: "Yahoo Finance Plus",
        slug: "yahoo-finance",
        blurb: "Established multi-tier financial platform with global market coverage, portfolio tools, and professional-grade analysis at higher price points.",
        theirPrice: "Bronze $9.95/mo (~$95/yr); Silver ~$24.95/mo (~$239/yr); Gold ~$49.95/mo (~$479/yr) with 20% annual discount",
        rows: [
            ["Entry Price","$12/mo; 7-day free trial on paid app","Bronze $9.95/mo (lowest tier)"],
            ["Data Depth (History)","Up to 19 years annual + 48 quarters from verified SEC filings (10-K/10-Q)","~40 years downloadable data (Gold tier); breadth unclear, not SEC-verified"],
            ["Geographic Coverage","US equities only, no international","Global coverage + UK studio + 24/5 US market data; supports non-US stocks on US exchanges — a genuine strength"],
            ["AI/Research","Grounded AI analyst (Pro tier, $33/mo) with SEC filing sources; refuses when unsure","Research reports, stock recommendations, Motley Fool Stock Advisor (Gold); analyst estimates & consensus not emphasized"],
            ["Alerts & Monitoring","SEC filing-change alerts (free + paid), holdings & portfolio X-Ray","Premium alerts + advanced portfolio analysis at Bronze tier; broader market monitoring"],
            ["Best For","US-focused value investors wanting auditable SEC-sourced research + filing alerts at low cost","Global traders & multi-asset portfolio managers needing professional tools, analyst research, and 24/5 market data"]
        ]
    }
};

function head(title, description, canonical, jsonld) {
    return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8" /><meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}" />
<meta name="robots" content="index, follow, max-image-preview:large" />
<link rel="canonical" href="${esc(canonical)}" />
<meta property="og:title" content="${esc(title)}" /><meta property="og:description" content="${esc(description)}" />
<meta property="og:url" content="${esc(canonical)}" /><meta property="og:type" content="website" />
<meta property="og:site_name" content="stockportfolio.pro" />
<meta property="og:image" content="${OG_IMAGE}" />
<meta property="og:image:width" content="1200" /><meta property="og:image:height" content="630" />
<meta name="twitter:card" content="summary_large_image" />
<meta name="twitter:image" content="${OG_IMAGE}" />
<link rel="icon" href="/Media/icon.png" />
<link rel="stylesheet" href="/styles.css?v=20260610-1" />
<link rel="stylesheet" href="/assets/system.css?v=20260830-mob3" />
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA_ID}',{anonymize_ip:true});</script>
<script type="text/javascript">if(location.hostname.endsWith("stockportfolio.pro"))(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","${CLARITY_ID}");</script>
<script type="application/ld+json">${ORG_LD}</script>
<script type="application/ld+json">${SOFTWARE_LD}</script>${jsonld ? `<script type="application/ld+json">${jsonld}</script>` : ''}${pixelHeadSnippet()}
<style>
  .seo-wrap{max-width:880px;margin:0 auto;padding:16px}
  .seo-nav{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 16px;margin:14px auto;max-width:880px;border:1px solid var(--border);border-radius:10px;background:var(--panel)}
  .seo-nav .brand{display:flex;align-items:center;gap:8px;font-weight:700}
  .seo-nav .brand img{width:22px;height:22px;border-radius:6px}
  .seo-cta-btn{background:var(--primary);color:#fff;padding:8px 16px;border-radius:8px;font-weight:600;text-decoration:none;font-size:13px}
  .seo-h1{font-size:clamp(24px,3vw,32px);font-weight:800;margin:10px 0 8px;letter-spacing:-.02em}
  .seo-sub{color:var(--muted);font-size:15px;line-height:1.7;margin:0 0 18px}
  .cmp-table{width:100%;border-collapse:collapse;font-size:14px;margin:18px 0}
  .cmp-table th,.cmp-table td{padding:11px 14px;border-bottom:1px solid var(--border-soft);text-align:left;vertical-align:top}
  .cmp-table thead th{font-size:13px;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
  .cmp-table td:first-child{font-weight:600;color:var(--muted);width:26%}
  .cmp-table .us{color:var(--text);font-weight:600}
  .seo-cta{text-align:center;border:1px solid var(--border);border-radius:12px;padding:24px;margin:24px 0;background:linear-gradient(180deg,rgba(59,130,246,.06),transparent)}
  .seo-foot{max-width:880px;margin:30px auto;padding:18px 16px;border-top:1px solid var(--border);color:var(--muted);font-size:12px}
  .seo-foot a{color:var(--muted)}
  .seo-disc{font-size:11.5px;color:var(--muted);margin-top:16px;line-height:1.6}
</style></head><body class="glass">`;
}

function nav() {
    return `<script>window.__spSkipAutoPageView=true;</script><script src="/assets/app.js?v=20260830-mob3"></script><script>V2.nav('compare');</script>`;
}
function footer() {
    return `<footer class="seo-foot"><p><a href="/">Home</a> &middot; <a href="/stocks">All stocks</a> &middot; <a href="/demo">Live demo</a> &middot; <a href="/register.html?plan=monthly">Free trial</a></p>
  <p class="seo-disc">Competitor names and prices are trademarks of their respective owners and are shown for comparison only; pricing may change — check each provider for current details. stockportfolio.pro does not provide financial advice.</p></footer><script>try{var pv=JSON.stringify({path:location.pathname,referrer:document.referrer});(navigator.sendBeacon&&navigator.sendBeacon('/api/track/page_view',new Blob([pv],{type:'application/json'})))||fetch('/api/track/page_view',{method:'POST',headers:{'Content-Type':'application/json'},body:pv,keepalive:true}).catch(function(){})}catch(e){}</script></body></html>`;
}

function renderComparison(slug) {
    const c = COMPETITORS[String(slug || '').toLowerCase()];
    if (!c) return null;
    const canonical = `${SITE}/vs/${c.slug}`;
    const title = `stockportfolio.pro vs ${c.name}: Pricing & Features (2026)`;
    const description = `${c.name} alternative? Compare stockportfolio.pro and ${c.name} on price, fundamentals, portfolio tracking and ease of use. $12/mo with a 7-day free trial.`;
    // Was a bare WebPage node. Naming both products as entities and adding
    // breadcrumbs brings these vendor pages up to the same structure the stock
    // comparison and metric pages already use.
    const jsonld = JSON.stringify({
        '@context': 'https://schema.org',
        '@graph': [
            {
                '@type': 'WebPage', '@id': canonical, url: canonical, name: title, description,
                about: [
                    { '@type': 'SoftwareApplication', name: 'stockportfolio.pro', applicationCategory: 'FinanceApplication', url: SITE },
                    { '@type': 'SoftwareApplication', name: c.name, applicationCategory: 'FinanceApplication' }
                ]
            },
            {
                '@type': 'BreadcrumbList',
                itemListElement: [
                    { '@type': 'ListItem', position: 1, name: 'Compare', item: `${SITE}/compare` },
                    { '@type': 'ListItem', position: 2, name: `vs ${c.name}`, item: canonical }
                ]
            }
        ]
    });
    const rows = c.rows.map((r) => `<tr><td>${esc(r[0])}</td><td class="us">${esc(r[1])}</td><td>${esc(r[2])}</td></tr>`).join('');
    return head(title, description, canonical, jsonld) + nav() + `
<main class="seo-wrap">
  <h1 class="seo-h1">stockportfolio.pro vs ${esc(c.name)}</h1>
  <p class="seo-sub">${esc(c.blurb)} If you&rsquo;re weighing ${esc(c.name)}, here&rsquo;s an honest side-by-side. stockportfolio.pro is a calm, single-screen workflow for long-term investors — holdings, allocation, fundamentals and news in one place for <strong>$12/month with a 7-day free trial</strong>.</p>
  <table class="cmp-table">
    <thead><tr><th>&nbsp;</th><th>stockportfolio.pro</th><th>${esc(c.name)}</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <p class="seo-sub"><strong>${esc(c.name)} pricing:</strong> ${esc(c.theirPrice)} Prices change, so confirm on their site.</p>
  <div class="seo-cta">
    <h3 style="margin:0 0 8px">Try stockportfolio.pro free for 7 days</h3>
    <p class="seo-sub" style="margin:0 0 14px">No broker connection, cancel anytime. See your holdings, allocation and company fundamentals in minutes.</p>
    <a class="seo-cta-btn" href="/register.html?plan=monthly">Start free trial</a>
    &nbsp;<a class="seo-cta-btn" style="background:transparent;border:1px solid var(--border);color:var(--text)" href="/demo">Try the live demo</a>
  </div>
</main>` + footer();
}

module.exports = { renderComparison, competitors: Object.keys(COMPETITORS) };
