'use strict';
const p=require('./sec-coverage');
const index=require('./public-stock-index');
const fm=require('./financial-metrics');
const {sourcesFor}=require('./verified-fundamentals');
const LABELS={revenue:'Revenue','net-income':'Net income','gross-profit':'Gross profit',eps:'Earnings per share',ebitda:'EBITDA','free-cash-flow':'Free cash flow','total-debt':'Total debt','shares-outstanding':'Shares outstanding','dividend-history':'Dividend payouts','pe-ratio':'P/E ratio'};
function amount(value,currency='USD',perShare=false) {
 const n=p.number(value);if(n===null)return '—';
 if(currency==='shares')return n.toLocaleString('en-US',{maximumFractionDigits:0})+' shares';
 const prefix=currency==='USD'?'$':currency+' ';
 if(perShare)return prefix+n.toLocaleString('en-US',{maximumFractionDigits:4});
 const abs=Math.abs(n);return prefix+(abs>=1e12?(n/1e12).toFixed(2)+'T':abs>=1e9?(n/1e9).toFixed(2)+'B':abs>=1e6?(n/1e6).toFixed(2)+'M':n.toLocaleString('en-US',{maximumFractionDigits:0}));
}
function sourceLinks(sources,esc,derived=false) {
 const distinct=[...new Map(sources.map(s=>[s.accessionNumber,s])).values()];
 return distinct.map((s,i)=>`<a href="${esc(s.filingUrl)}" rel="noopener" title="${esc(`${s.form}, filed ${s.filingDate}, ${s.concept}`)}">${derived?'Calculation input':'SEC source'}${distinct.length>1?' '+(i+1):''}</a>`).join(' · ');
}
function fieldCell(data,row,field,seo) {
 const n=p.number(row?.[field]);if(n===null)return '—';
 const sources=sourcesFor(data,row,field);if(!sources.length)return '—';
 return `${seo.esc(amount(n,/Shares/.test(field)?'shares':row.reportedCurrency,/EPS|^eps$/.test(field)))} <small>${sourceLinks(sources,seo.esc,!!row._derivations?.[field])}</small>`;
}
function claimWidget(sym,name,esc) { return `<div class="seo-section" style="background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:20px 22px">
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
</script>`; }
function coverageMessage(status,reportingStatus) {
 const recent=reportingStatus==='recent_annual';
 if(status==='ready' && recent)return 'Recent annual SEC report verified. Core annual income, assets, equity and operating cash flow are available.';
 if(status==='partial' && recent)return 'Recent annual SEC report verified. Some financial fields are available; core statement coverage is incomplete.';
 if(status==='historical_only' && recent)return 'Recent annual SEC report verified. Only historical financial figures are available; verified figures for the latest annual report period are not available.';
 if(status==='historical_only')return 'Verified historical SEC figures are available. Recent annual reporting has not been verified under our coverage criteria.';
 return (recent?'Recent annual SEC report verified. ':'')+'Verified financial history is not yet available. Missing figures are not treated as reported zeros.';
}
function profile(ticker,options,seo) {
 const symbol=seo.resolveCanonicalSymbol(ticker);if(!symbol)return null;
 let company=seo.loadCompanies().find(c=>c.symbol===symbol);
 if(!company && require('./fundamentals-status').isUnlisted(symbol)){const raw=require('./fundamentals-cache').loadRawFundamentals(symbol);if(raw?.overview?.Name)company={symbol,name:raw.overview.Name,exchange:raw.overview.Exchange,securityType:'stock',cik:null};}
 if(!company)return null;
 const data=seo.loadFundamentals(symbol),entry=index.get(symbol),issuer=index.view().issuers[entry?.cik];
 const type=company.securityType || 'stock',isStock=type==='stock',ready=entry?.indexable && data?.coverage?.financialCoverage==='ready' && !require('./fundamentals-status').isUnlisted(symbol);
 const coverage=data?.coverage || {},annual=coverage.latestAnnual;
 const name=company.name,canonical=`https://www.stockportfolio.pro/stocks/${symbol}`;
 const title=`${seo.clipName(name,42)} (${symbol}): ${isStock?'SEC financials':type+' profile'}`;
 const description=`${name} (${symbol}) ${isStock?'financial data with periods and SEC sources':'security profile and issuer filings'}. Financial coverage: ${coverage.financialCoverage || 'unavailable'}.`;
 const status=coverage.financialCoverage || 'unavailable';
 const unlisted=require('./fundamentals-status').isUnlisted(symbol);
 const notice=unlisted?'No longer listed under this ticker. Available verified financials below are historical context.':isStock?coverageMessage(status,coverage.annualReportingStatus):`This listing is a ${type}. Company financial analysis is unavailable for this instrument. Issuer filings are linked below when known.`;
 const income=data?.income?.annualReports || [],balance=data?.balance?.annualReports || [],cash=data?.cash?.annualReports || [];
 const rowsFor=(rows,fields)=>rows.slice(0,8).map(r=>`<tr><td>${seo.esc(r.fiscalDateEnding)}</td>${fields.map(f=>`<td>${fieldCell(data,r,f,seo)}</td>`).join('')}</tr>`).join('');
 const section=(label,rows,fields,names)=>rows.length?`<section class="seo-section"><h2>${label}</h2><div style="overflow-x:auto"><table class="seo-table"><thead><tr><th>Period end</th>${names.map(n=>`<th>${n}</th>`).join('')}</tr></thead><tbody>${rowsFor(rows,fields)}</tbody></table></div><p>Figures retain their reported currency and security basis. Missing values are shown as —. Calculated values identify their source inputs.</p></section>`:'';
 const financials=isStock && data?section('Annual income statement',income,['totalRevenue','netIncome','dilutedEPS'],['Revenue','Net income','Diluted EPS'])+section('Annual balance sheet',balance,['totalAssets','totalShareholderEquity'],['Total assets','Shareholders’ equity'])+section('Annual cash flow',cash,['operatingCashflow','capitalExpenditures'],['Operating cash flow','Capital expenditure']):'';
 const quarterly=isStock && !income.length && data?.income?.quarterlyReports?.length?section('Reported quarterly income',data.income.quarterlyReports,['totalRevenue','netIncome'],['Revenue','Net income']):'';
 const metricLinks=(entry?.indexable?entry.metricSlugs:[]).map(slug=>`<a href="/stocks/${seo.esc(symbol)}/${slug}">${LABELS[slug] || slug}</a>`).join('');
 const priceLink=entry?.priceHistory?`<a href="/stocks/${seo.esc(symbol)}/price-history">Market price history</a>`:'';
 const peers=ready && company.sector?index.view().securities.filter(c=>c.screenable && c.sector===company.sector && c.cik!==company.cik).slice(0,3):[];
 const comparisons=peers.map(c=>{const pair=[symbol,c.symbol].sort().join('-vs-');return `<a href="/compare/${seo.esc(pair)}">${seo.esc(symbol)} vs ${seo.esc(c.symbol)}</a>`;}).join('');
 const supplied=options?.quote,present=supplied && p.day(supplied.asOf) && supplied.asOf<=p.day(new Date().toISOString()) && p.number(supplied.price)>0;
 const quote=present?{...supplied,currency:supplied.currency || data?.marketData?.currency || 'USD'}:data?.marketData;
 const label=present?(supplied.source==='live'?'live':'last close'):'cached daily snapshot';
 const price=value=>p.number(value)===null?'—':(quote.currency==='USD'?'$':quote.currency+' ')+p.number(value).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:4});
 const overlay=quote?.marketCapSource==='sec-shares';
 const stats=[['Price',price(quote?.price)],...(isStock?[['Market Cap',overlay?'—':amount(quote?.marketCap,quote?.currency)],['P/E Ratio',!coverage.perShareAllowed || p.number(quote?.trailingPE)===null?'—':p.number(quote.trailingPE).toFixed(2)],['52-Week High',price(quote?.fiftyTwoWeekHigh)],['52-Week Low',price(quote?.fiftyTwoWeekLow)]]:[])];
 const quoteHtml=quote?.asOf?`<section class="seo-section"><h2>Market snapshot</h2><div class="seo-stats">${stats.map(([name,value])=>`<div><div class="l">${name}</div><div class="v">${seo.esc(value)}</div><div class="n">as of ${seo.esc(quote.asOf)} · ${label}</div></div>`).join('')}</div><p>Source: Yahoo Finance ${present && supplied.source==='live'?'live quote':'daily snapshot'}. Market prices and ratios are separate from SEC financial statements.</p></section>`:'';
 const filing=annual?`<a href="${seo.esc(annual.filingUrl)}">${seo.esc(annual.form)} filed ${seo.esc(annual.filingDate)}</a> · report period ${seo.esc(annual.reportDate)}`:company.cik?`<a href="https://www.sec.gov/edgar/browse/?CIK=${seo.esc(company.cik)}">Issuer filings on SEC EDGAR</a>`:'SEC issuer identity has not yet been verified.';
 const annualCount=new Set(income.map(r=>r.fiscalDateEnding)).size;
 const jsonld=JSON.stringify({'@context':'https://schema.org','@type':'WebPage',name:title,url:canonical,description});
 return seo.head(title,description,canonical,jsonld,null,ready?'index, follow, max-image-preview:large':'noindex, follow')+seo.nav('company')+`<main class="seo-wrap"><div class="seo-crumbs"><a href="/stocks">Securities</a> / ${seo.esc(symbol)}</div><h1 class="seo-h1">${seo.esc(name)} (${seo.esc(symbol)})</h1><p class="seo-sub">${seo.esc(type==='stock'?'Company equity':type.charAt(0).toUpperCase()+type.slice(1))} · ${seo.esc(company.exchange || 'Exchange not specified')}</p><section class="seo-section" data-coverage="${seo.esc(status)}"><h2>Financial coverage · SEC filings</h2><p>${notice}</p><p>${filing}</p>${issuer?.evidence?.lastSuccessfulCheckAt?`<p>SEC reporting checked ${seo.esc(issuer.evidence.lastSuccessfulCheckAt.slice(0,10))}.</p>`:''}</section>${quoteHtml}${financials}${isStock && income.length && data.overview.Currency==='USD'?claimWidget(symbol,name,seo.esc):''}${quarterly}${!coverage.perShareAllowed && isStock && income.length?'<p>Per-share values are omitted because a matching share-class or depositary-receipt basis has not been verified.</p>':''}${metricLinks || priceLink?`<section class="seo-section"><h2>Available history</h2><div class="seo-links">${metricLinks}${priceLink}</div></section>`:''}${comparisons?`<section class="seo-section"><h2>Company comparisons</h2><div class="seo-links">${comparisons}</div></section>`:''}${isStock && annualCount?`<section class="seo-lock"><h3>Explore the filed financials</h3><p>${annualCount} distinct annual reporting periods are available in this dataset. Each displayed figure identifies its source.</p><a class="seo-cta-btn" href="/company?symbol=${seo.esc(symbol)}">Open company financials</a> <a class="seo-cta-btn" href="/ask?q=${encodeURIComponent('Explain the verified financials for '+symbol)}">Ask about ${seo.esc(symbol)}</a></section>`:''}<p><a href="/stocks">Directory and verified company coverage</a></p></main>`+seo.footer();
}
function unavailableMetric(symbol,slug,seo) {
 const canonical=`https://www.stockportfolio.pro/stocks/${symbol}/${slug}`;
 return seo.head(`${symbol}: ${LABELS[slug] || slug} availability`,'Verified comparable financial history is unavailable for this metric.',canonical,null,null,'noindex, follow')+seo.nav('company')+`<main class="seo-wrap"><h1 class="seo-h1">${seo.esc(symbol)}: ${seo.esc(LABELS[slug] || slug)}</h1><p>At least two comparable verified annual observations and ready company coverage are required for this history page.</p><p><a href="/stocks/${seo.esc(symbol)}">View the company profile and available SEC data</a></p></main>`+seo.footer();
}
function metric(ticker,slug,seo,{action=''}={}) {
 if(!LABELS[slug])return null;
 const symbol=seo.resolveCanonicalSymbol(ticker);if(!symbol)return null;
 const entry=index.get(symbol),data=seo.loadFundamentals(symbol);
 if(!entry?.indexable || !entry.metricSlugs.includes(slug) || !data)return unavailableMetric(symbol,slug,seo);
 const observations=fm.history(data,slug).filter(r=>r.value!==null && r.sourceIds.length),rows=observations.filter(r=>r.currency===observations[0]?.currency);
 if(new Set(rows.map(r=>r.period)).size<2)return unavailableMetric(symbol,slug,seo);
 const company=seo.loadCompanies().find(c=>c.symbol===symbol),canonical=`https://www.stockportfolio.pro/stocks/${symbol}/${slug}`,title=`${symbol} ${LABELS[slug]} history`;
 const latest=rows[0], prior=rows.find(r=>r.period!==latest.period && r.currency===latest.currency);
 const change=prior && prior.value>0?(latest.value/prior.value-1)*100:null;
 const elapsedDays=prior?(Date.parse(latest.period)-Date.parse(prior.period))/86400000:null;
 const changeLabel=elapsedDays>=340 && elapsedDays<=380?'One-year change':prior?'Change since '+prior.period:'Change';
 const opening=`<section class="seo-section"><h2>Latest filed value</h2><p>${seo.esc(amount(latest.value,slug==='shares-outstanding'?'shares':latest.currency,slug==='eps'))}, period end ${seo.esc(latest.period)}. ${sourceLinks(latest.sourceIds.map(id=>data.provenance.sources[id]),seo.esc,latest.derived)} · <a href="https://www.sec.gov/edgar/browse/?CIK=${entry.cik}">SEC EDGAR</a>.</p><p>${changeLabel}: ${change===null?'Unavailable':change.toFixed(1)+'%'}. ${slug==='free-cash-flow'?'Free cash flow is calculated as operating cash flow minus the magnitude of capital expenditures (OCF − capex). Both inputs are required.':''}</p></section>`;
 const chart=`<svg role="img" aria-labelledby="metric-chart-title" viewBox="0 0 640 150"><title id="metric-chart-title">${seo.esc(LABELS[slug])} annual verified history</title>${rows.slice(0,20).reverse().map((r,i)=>{const max=Math.max(...rows.map(x=>Math.abs(x.value)),1),height=Math.abs(r.value)/max*100;return `<rect x="${i*30+10}" y="${120-height}" width="20" height="${height}" fill="${r.value<0?'#b33':'#3464aa'}"><title>${r.period}: ${seo.esc(amount(r.value,r.currency))}</title></rect>`;}).join('')}</svg>`;
 const sectorField={revenue:'latestRevenue','net-income':'latestNetIncome','gross-profit':'latestGrossProfit','free-cash-flow':'fcfAbs','total-debt':'latestTotalDebt'}[slug];
 const extra=require('./seo-extra'),percentile=sectorField && entry.sector?extra.sectorPercentile(symbol,sectorField):null;
 const peers=sectorField && entry.sector?extra.sectorPeers(symbol,sectorField,5).filter(peer=>index.get(peer.symbol)?.metricSlugs.includes(slug)):[];
 const peerHtml=percentile!==null && percentile!==false && percentile!==undefined?`<section class="seo-section"><h2>${symbol} vs. ${seo.esc(entry.sector)} sector peers</h2><p>${percentile.toFixed(0)} percentile of the ${seo.esc(entry.sector)} sector for this available metric. USD presentations can use explicitly recorded approximate FX calculations.</p><div class="seo-links">${peers.map(peer=>`<a href="/stocks/${peer.symbol}/${slug}">${peer.symbol}</a>`).join('')}</div></section>`:'';
 const trs=rows.map(r=>`<tr><td>${seo.esc(r.period)}</td><td>${seo.esc(amount(r.value,slug==='shares-outstanding'?'shares':r.currency,slug==='eps'))}</td><td>${r.derived?'Calculated':'Reported'}</td><td>${sourceLinks(r.sourceIds.map(id=>data.provenance.sources[id]).filter(Boolean),seo.esc,r.derived)}</td></tr>`).join('');
 return seo.head(title,`Verified ${LABELS[slug].toLowerCase()} history for ${symbol}, with fiscal periods and SEC source links.`,canonical,JSON.stringify({'@context':'https://schema.org','@type':'WebPage',name:title,url:canonical}))+seo.nav('company')+`<main class="seo-wrap"><div class="seo-crumbs"><a href="/stocks/${seo.esc(symbol)}">${seo.esc(symbol)}</a> / ${LABELS[slug]}</div><h1 class="seo-h1">${seo.esc(company.name)}: ${LABELS[slug]}</h1><p class="seo-sub">${rows.length} comparable annual observations. Values retain the filing’s currency and basis; calculated figures link their inputs.</p>${opening}${action}${chart}${peerHtml}<p>Update frequency: SEC reporting checked daily, facts after new filings and on a rolling monthly schedule.</p><h2>${LABELS[slug]} history by fiscal year</h2><div class="seo-section" style="overflow-x:auto"><table class="seo-table"><thead><tr><th>Period end</th><th>${LABELS[slug]}</th><th>Basis</th><th>SEC sources</th></tr></thead><tbody>${trs}</tbody></table></div><p><a href="mailto:support@stockportfolio.pro">Report a data issue</a> · <a href="/stocks/${seo.esc(symbol)}/${slug}.csv">Download CSV with SEC sources</a> · <a href="/stocks/${seo.esc(symbol)}">Company profile</a></p></main>`+seo.footer();
}
function compare(pairSlug,seo,{privatePage=false,record=true}={}) {
 const match=String(pairSlug).toUpperCase().match(/^([A-Z0-9.]+)-VS-([A-Z0-9.]+)$/);if(!match || match[1]===match[2])return null;
 const [a,b]=match.slice(1);if(a>b)return {redirect:`/compare/${b}-vs-${a}`};
 const ea=index.get(a),eb=index.get(b);if(!ea?.screenable || !eb?.screenable)return null;
 const da=seo.loadFundamentals(a),db=seo.loadFundamentals(b);if(!da || !db)return null;
 const periodA=da.coverage.latestAnnual.reportDate,periodB=db.coverage.latestAnnual.reportDate;
 const join=(d,st,end)=>(d[st]?.annualReports || []).find(r=>r.fiscalDateEnding===end) || {};
 const definitions=[['Revenue','income','totalRevenue'],['Net income','income','netIncome'],['Total assets','balance','totalAssets'],['Shareholders’ equity','balance','totalShareholderEquity'],['Operating cash flow','cash','operatingCashflow'],['Capital expenditure','cash','capitalExpenditures']];
 const trs=definitions.map(([label,st,f])=>{const ra=join(da,st,periodA),rb=join(db,st,periodB),same=ra.reportedCurrency===rb.reportedCurrency;return `<tr><th>${label}</th><td>${same?fieldCell(da,ra,f,seo):'Currency presentation unavailable'}</td><td>${same?fieldCell(db,rb,f,seo):'Currency presentation unavailable'}</td></tr>`;}).join('');
 const extra=require('./seo-extra');
 const swap=`<section class="seo-section"><h2>Compare another company</h2><input id="cmpAdd" placeholder="Ticker or company" aria-label="Compare another company"><div id="cmpMatches" role="listbox" hidden></div><button onclick="cmpGo('${a}')">vs ${a}</button></section><script>${extra.CMP_EXTRACT_SYM}${extra.CMP_AUTOCOMPLETE}cmpWireAutocomplete('cmpAdd','cmpMatches');function cmpGo(base){var v=cmpExtractSym(document.getElementById('cmpAdd').value);if(v && v!==base)location.href='/compare/'+[base,v].sort().join('-vs-');}</script>`;
 const upgrade=privatePage?'':`<script>
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
</script>`;
 const performanceRows=[1,3,5,10].map(years=>{
  const cell=d=>{const series=extra.monthlySeries(d),value=extra.totalReturn(series,years);return value===null?(series.length?`Listed ${series[0].date.slice(0,4)}`:'Unavailable'):value.toFixed(1)+'%';};
  return `<tr><td>${years}-year return</td><td>${cell(da)}</td><td>${cell(db)}</td></tr>`;
 }).join('');
 const rangeCell=d=>{const r=extra.fiftyTwoWeekRange(d);return r.low!==null && r.high!==null?amount(r.low,d.marketData?.currency || 'USD',true)+'–'+amount(r.high,d.marketData?.currency || 'USD',true):'Unavailable';};
 const performance=`<section class="seo-section"><h2>Performance &mdash; ${a} vs ${b}</h2><p>1/3/5/10-year performance uses dated market prices separately from SEC facts.</p><table class="seo-table"><tbody>${performanceRows}<tr><td>52-week range</td><td>${rangeCell(da)}</td><td>${rangeCell(db)}</td></tr></tbody></table></section>`;
 const ratioCell=(d,st,numerator,denominator)=>{const r=join(d,st,d.coverage.latestAnnual.reportDate),value=fm.ratio(r[numerator],r[denominator]);if(value===null)return '—';const refs=[...sourcesFor(d,r,numerator),...sourcesFor(d,r,denominator)];return (value*100).toFixed(1)+'% <small>'+sourceLinks(refs,seo.esc,true)+'</small>';};
 const groupRows=defs=>defs.map(([label,st,f])=>`<tr><td>${label}</td><td>${fieldCell(da,join(da,st,periodA),f,seo)}</td><td>${fieldCell(db,join(db,st,periodB),f,seo)}</td></tr>`).join('');
 const groups=[['Overview',trs],['Margins',`<tr><td>Net margin</td><td>${ratioCell(da,'income','netIncome','totalRevenue')}</td><td>${ratioCell(db,'income','netIncome','totalRevenue')}</td></tr>`],['Cash flow',groupRows([['Operating cash flow','cash','operatingCashflow'],['Capital expenditure','cash','capitalExpenditures']])],['Balance sheet',groupRows([['Assets','balance','totalAssets'],['Equity','balance','totalShareholderEquity'],['Combined debt','balance','shortLongTermDebtTotal']])],['Security basis',groupRows([['Basic EPS','income','eps'],['Diluted EPS','income','dilutedEPS'],['Shares','balance','commonStockSharesOutstanding']])],['Available history',`<tr><td>Distinct annual periods</td><td>${da.income.annualReports.length}</td><td>${db.income.annualReports.length}</td></tr>`],['Market performance',performanceRows]];
 const pro=privatePage?`<div class="cmp-grp">${groups.map(([label,body],n)=>`<details class="cmp-sec${n===0?' cmp-open':''}" ${n===0?'open':''}><summary>${label}</summary>${n>0?'<p class="cmp-prev">Expand to inspect available values and sources.</p>':''}<table class="seo-table"><tbody>${body}</tbody></table></details>`).join('')}</div><section class="seo-section"><h2>Red flags in the filings</h2><p>Missing observations cannot establish an absence of red flags. Use the source-linked statements and available checks.</p></section><section class="seo-section"><h2>AI VERDICT</h2><p>Open Ask to investigate the available verified observations. No AI service is called to render this page.</p></section>`:'';

 const title=`${a} vs ${b}: verified SEC financials`,canonical=`https://www.stockportfolio.pro/compare/${a}-vs-${b}`;
 return {html:seo.head(title,`Compare verified annual financials for ${a} and ${b}, with dates and SEC sources.`,canonical,JSON.stringify({'@context':'https://schema.org','@type':'WebPage',name:title,url:canonical}),null,privatePage?'noindex, follow':undefined)+seo.nav('compare')+`<main class="seo-wrap"><h1 class="seo-h1">${seo.esc(da.overview.Name)} (${a}) vs ${seo.esc(db.overview.Name)} (${b})</h1><p class="seo-sub">Annual report periods: ${seo.esc(periodA)} and ${seo.esc(periodB)}. Different periods and currencies can limit comparability. Figures identify their SEC sources.</p><section class="seo-section" style="overflow-x:auto"><table class="seo-table"><thead><tr><th>Metric</th><th><a href="/stocks/${a}">${a}</a></th><th><a href="/stocks/${b}">${b}</a></th></tr></thead><tbody>${trs}</tbody></table></section>${privatePage?'':performance}${pro}${swap}${upgrade}<p>Missing figures are not treated as zeros. Currency-incompatible monetary figures are omitted.</p><div class="seo-links"><a href="/company?symbol=${a}">Open ${a} financials</a><a href="/company?symbol=${b}">Open ${b} financials</a><a href="/compare">Compare another company</a></div></main>`+seo.footer()};
}
module.exports={profile,metric,compare,amount,sourceLinks,fieldCell,coverageMessage,LABELS};
