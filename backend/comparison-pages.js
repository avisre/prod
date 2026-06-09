// Public comparison landing pages — target high-intent "X alternative" searches.
// Facts (competitor pricing/positioning) are kept deliberately conservative and
// sourced from public pricing pages; claims are about stockportfolio.pro's own
// strengths rather than disparaging competitors.

const SITE = 'https://www.stockportfolio.pro';
const CLARITY_ID = 'x0dsu053xa';
const GA_ID = 'G-4K10D2FPTT';

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
            ['Monthly price', '£9/mo (~$11), 7-day free trial', '$7–$23/mo (annual billing)'],
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
            ['Monthly price', '£9/mo (~$11), 7-day free trial', '$7–$28/mo'],
            ['Free / trial', '7-day free trial, cancel anytime', 'Free plan + paid trials'],
            ['Learning curve', 'Simple, calm, opinionated UI', 'Powerful but dense — lots of screens'],
            ['Company fundamentals', 'Clean income, balance sheet & cash flow', 'Extensive data & screeners'],
            ['Portfolio tracking', 'Yes — holdings, allocation, performance', 'Yes'],
            ['Broker connection required', 'No — manual or CSV', 'No'],
            ['Best for', 'Long-term investors who want clarity, not 50 panels', 'Power users who screen and research heavily']
        ]
    },
    'simply-wall-st': {
        name: 'Simply Wall St',
        slug: 'simply-wall-st',
        blurb: 'Simply Wall St is known for its visual "snowflake" company analysis and is popular with investors who like infographic-style research.',
        theirPrice: 'Free plan available; paid roughly $10/month (annual billing).',
        rows: [
            ['Monthly price', '£9/mo (~$11), 7-day free trial', '~$10/mo (annual billing)'],
            ['Free / trial', '7-day free trial, cancel anytime', 'Free plan + paid annual'],
            ['Fundamentals format', 'Real statements: income, balance, cash flow', 'Visual infographics & summaries'],
            ['Portfolio tracking', 'Yes — holdings, allocation, performance', 'Yes'],
            ['Market news', 'Built-in news feed', 'Yes'],
            ['Broker connection required', 'No — manual or CSV, you keep your data', 'Optional'],
            ['Best for', 'Investors who want the actual numbers + their portfolio', 'Investors who prefer visual snapshots']
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
<meta name="twitter:card" content="summary" />
<link rel="icon" href="/Media/icon.png" />
<link rel="stylesheet" href="/styles.css?v=20260610-1" />
<script async src="https://www.googletagmanager.com/gtag/js?id=${GA_ID}"></script>
<script>window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}gtag('js',new Date());gtag('config','${GA_ID}',{anonymize_ip:true});</script>
<script type="text/javascript">if(location.hostname.endsWith("stockportfolio.pro"))(function(c,l,a,r,i,t,y){c[a]=c[a]||function(){(c[a].q=c[a].q||[]).push(arguments)};t=l.createElement(r);t.async=1;t.src="https://www.clarity.ms/tag/"+i;y=l.getElementsByTagName(r)[0];y.parentNode.insertBefore(t,y);})(window,document,"clarity","script","${CLARITY_ID}");</script>
${jsonld ? `<script type="application/ld+json">${jsonld}</script>` : ''}
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
    return `<header class="seo-nav"><a class="brand" href="/"><img src="/Media/icon.png" alt="stockportfolio.pro logo" />stockportfolio.pro</a><a class="seo-cta-btn" href="/register.html?plan=monthly">Start 7-day free trial</a></header>`;
}
function footer() {
    return `<footer class="seo-foot"><p><a href="/">Home</a> &middot; <a href="/stocks">All stocks</a> &middot; <a href="/demo">Live demo</a> &middot; <a href="/register.html?plan=monthly">Free trial</a></p>
  <p class="seo-disc">Competitor names and prices are trademarks of their respective owners and are shown for comparison only; pricing may change — check each provider for current details. stockportfolio.pro does not provide financial advice.</p></footer></body></html>`;
}

function renderComparison(slug) {
    const c = COMPETITORS[String(slug || '').toLowerCase()];
    if (!c) return null;
    const canonical = `${SITE}/vs/${c.slug}`;
    const title = `stockportfolio.pro vs ${c.name}: Pricing & Features Compared (2026)`;
    const description = `${c.name} alternative? Compare stockportfolio.pro and ${c.name} on price, fundamentals, portfolio tracking and ease of use. £9/mo with a 7-day free trial.`;
    const jsonld = JSON.stringify({ '@context': 'https://schema.org', '@type': 'WebPage', name: title, url: canonical });
    const rows = c.rows.map((r) => `<tr><td>${esc(r[0])}</td><td class="us">${esc(r[1])}</td><td>${esc(r[2])}</td></tr>`).join('');
    return head(title, description, canonical, jsonld) + nav() + `
<main class="seo-wrap">
  <h1 class="seo-h1">stockportfolio.pro vs ${esc(c.name)}</h1>
  <p class="seo-sub">${esc(c.blurb)} If you&rsquo;re weighing ${esc(c.name)}, here&rsquo;s an honest side-by-side. stockportfolio.pro is a calm, single-screen workflow for long-term investors — holdings, allocation, fundamentals and news in one place for <strong>£9/month with a 7-day free trial</strong>.</p>
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
