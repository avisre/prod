'use strict';
const fs=require('node:fs');
const path=require('node:path');
const p=require('./sec-coverage');
const stocks=require('./stock-universe');
const sector=require('./sector');
const index=require('./public-stock-index');
const entries=new Map();let bytes=0;
function invalidate(id){const x=entries.get(id);if(x){bytes-=x.bytes;entries.delete(id);}}
function loadIssuer(id,expectedDigest) {
 const hit=entries.get(id);if(hit && hit.digest===expectedDigest){entries.delete(id);entries.set(id,hit);return hit.data;}
 invalidate(id);if(!id || !expectedDigest)return null;
 try {const raw=fs.readFileSync(path.join(p.DATA_DIR,'sec-financials',id+'.json'),'utf8');if(p.digest(raw)!==expectedDigest)return null;const data=JSON.parse(raw);if(data.schemaVersion!==1 || p.cik(data.cik)!==id)return null;const size=Buffer.byteLength(raw);entries.set(id,{data,digest:expectedDigest,bytes:size});bytes+=size;while(bytes>8*1024*1024 || entries.size>96)invalidate(entries.keys().next().value);return data;}catch(_){return null;}
}
function safeRows(data,st,basis,perShareAllowed) {
 const metadata=new Set(['fiscalDateEnding','periodStart','reportedCurrency','periodType']);
 const asOf=p.day(new Date().toISOString());
 return (data?.[st]?.[basis] || []).map(r=>{
  const row={...r,_sources:{...r._sources},_derivations:{...r._derivations},_scopes:{...r._scopes},_signs:{...r._signs}};
  // Check every populated financial field, including ones with no source map.
  const fields=new Set([...Object.keys(r).filter(f=>!metadata.has(f) && !f.startsWith('_')),...Object.keys(r._sources || {})]);
  for(const field of fields)if(!p.verifiedField(data,r,field) || !p.day(r.fiscalDateEnding) || r.fiscalDateEnding>asOf || (r._sources?.[field] || []).some(id=>data.sources?.[id]?.filingDate>asOf) || (!perShareAllowed && /(?:EPS|^eps$|Shares)/.test(field))){row[field]=null;delete row._sources[field];delete row._derivations[field];delete row._scopes[field];delete row._signs[field];}
  return row;
 }).filter(r=>Object.keys(r._sources).length);
}
// Tracking stocks: each series follows a group inside the issuer, so the filed EPS is not
// theirs (audit 2026-10-25).
const TRACKING=new Set(['FWONA','FWONK','LLYVA','LLYVK','GLIBA','GLIBK','METC','METCB']);
// Why the listing's share is not the share the filing's per-share amounts are for, or null
// when it is. A sibling that is a note, unit, ETN or preferred is not a second class of
// common stock (Duke's DUKU units blocked Duke's EPS until 2026-10-25). With several classes,
// the one EPS a company files fits this class when price ÷ that EPS agrees with the quote's
// own trailing P/E: Alphabet's two classes share one EPS; Berkshire files per Class A share.
function perShareBasis(company,data,quote,quoteCurrency) {
 if(TRACKING.has(String(company.symbol).toUpperCase().replace(/[.-]/g,'')))return 'tracking';
 if(/American Deposit(?:ary|ory)|\b(?:ADR|ADS)\b/i.test(company.securityName || company.name || ''))return 'adr';
 const latest=data?.income?.annualReports?.[0];
 if(latest?.reportedCurrency && latest.reportedCurrency!==quoteCurrency)return 'currency';
 const {securityType}=require('../scripts/lib/us-listings');
 const classes=stocks.companies().filter(s=>s.securityType==='stock' && p.cik(s.cik)===p.cik(company.cik) && securityType({symbol:s.symbol,name:s.securityName || ''})==='stock' && !/\bwhen issued$/i.test(s.securityName || ''));
 if(classes.length===1)return null;
 if(!classes.length)return 'share_class';
 const price=p.number(quote?.price),pe=p.number(quote?.trailingPE);
 if(!(price>0 && pe>0))return 'share_class';
 // The quote's P/E is trailing twelve months, so compare with the fiscal year moved on by the
 // quarters filed since it, less the same quarters a year earlier (Q4 is never filed alone).
 const perShare=r=>p.number(r?.dilutedEPS) ?? p.number(r?.eps),quarters=data?.income?.quarterlyReports || [];
 const since=quarters.filter(r=>r.fiscalDateEnding>latest?.fiscalDateEnding),before=since.map(r=>quarters.find(x=>Math.abs((Date.parse(r.fiscalDateEnding)-Date.parse(x.fiscalDateEnding))/864e5-365)<=10));
 const ttm=perShare(latest)!==null && [...since,...before].every(r=>perShare(r)!==null)?since.reduce((t,r,i)=>t+perShare(r)-perShare(before[i]),perShare(latest)):null;
 return [perShare(latest),ttm].some(eps=>eps>0 && Math.abs(Math.log(price/pe/eps))<=Math.log(1/0.6))?null:'share_class';
}
function adapt(company,raw,data,entry,issuer) {
 const type=company.securityType || 'stock';
 // Sector is rebuilt rather than copied: us-companies carries GICS names and the
 // fundamentals file carries Yahoo ones, and every peer/median consumer groups on
 // the GICS key. Falling back to the file's own label is what keeps ~1,968
 // companies that are absent from us-companies from losing peer context entirely.
 const overview={Symbol:company.symbol,Name:company.name,CIK:company.cik || '',Sector:sector.canonical(company.sector) || sector.canonical(raw?.overview?.Sector) || '',Exchange:company.exchange || '',Currency:'USD'};
 for(const key of ['Industry','Description','Country','AssetType'])if(raw?.overview?.[key])overview[key]=raw.overview[key];
 // Legacy cover-page share overlays infer security basis from provider scale.
 // Verified company market values retain the dated provider quote instead.
 const quote=require('./quote-store').getDailyQuote(company.symbol,{useLegacySecShares:false});
 const marketData=quote?.asOf?{...quote,source:'Yahoo Finance daily snapshot',financialSource:false}:null;
 const perShareReason=perShareBasis(company,data,marketData,marketData?.currency || raw?.overview?.Currency || 'USD'),perShareAllowed=!perShareReason;
 if(marketData && !perShareAllowed){marketData.trailingPE=null;marketData.forwardPE=null;marketData.sharesOutstanding=null;}
 if(marketData){overview.MarketCapitalization=p.number(marketData.marketCap);overview.PERatio=p.number(marketData.trailingPE);overview.ForwardPE=p.number(marketData.forwardPE);overview.DividendYield=p.number(marketData.dividendYield);overview['52WeekHigh']=p.number(marketData.fiftyTwoWeekHigh);overview['52WeekLow']=p.number(marketData.fiftyTwoWeekLow);if(perShareAllowed)overview.SharesOutstanding=p.number(marketData.sharesOutstanding);}
 const out={overview,daily:raw?.daily || {},monthly:raw?.monthly || {},marketData,coverage:{annualReportingStatus:entry?.annualReportingStatus || 'unverified',financialCoverage:data?(entry?.financialCoverage || 'unavailable'):'unavailable',securityType:type,latestAnnual:issuer?.evidence?.latestAnnual || null,lastSuccessfulCheckAt:issuer?.evidence?.lastSuccessfulCheckAt || null,sic:issuer?.evidence?.sic || null,perShareAllowed,perShareReason,missingReason:!data?'No verified SEC financial observations are available.':null},provenance:{sources:data?.sources || {},financialDigest:issuer?.financialDigest || issuer?.evidence?.financialDigest || null},fetchedAt:data?.fetchedAt || null};
 for(const st of ['income','balance','cash'])out[st]={annualReports:type==='stock'?safeRows(data,st,'annualReports',perShareAllowed):[],quarterlyReports:type==='stock'?safeRows(data,st,'quarterlyReports',perShareAllowed):[]};
 const inc=out.income.annualReports[0];overview.Currency=inc?.reportedCurrency || out.balance.annualReports[0]?.reportedCurrency || 'USD';
 overview.EPS=inc?.dilutedEPS ?? inc?.eps ?? null;
 // An ADR's or foreign filer's EPS stays out of the statement rows, where readers pair it
 // with the listing's price; the page shows it alone, in the filing currency, per ordinary share.
 if(type==='stock' && ['adr','currency'].includes(perShareReason)){const row=safeRows(data,'income','annualReports',true)[0];if(row && (p.number(row.dilutedEPS)!==null || p.number(row.eps)!==null))out.filedPerShare={fiscalDateEnding:row.fiscalDateEnding,reportedCurrency:row.reportedCurrency,dilutedEPS:p.number(row.dilutedEPS),eps:p.number(row.eps),basis:'per ordinary share'};}
 if(!perShareAllowed)overview.PERatio=null;
 if(type==='stock')out.supplementalObservations=require('./company-observations').reconcile(require('./company-observations').observations(data),require('./committed-supplements').forIssuer(company.cik || 'listing:'+company.symbol.replace(/\./g,'-'))).filter(f=>f.state==='available');
 // The cost lines a company files in place of a cost of revenue (filed-costs.js).
 const latest=out.income.annualReports[0];
 if(type==='stock' && latest && latest.costOfRevenue==null && latest.grossProfit==null){const filed=require('./filed-costs').forIssuer(company.cik,out.income.annualReports);if(filed)out.filedCosts=filed;}
 out.provenance.supplementalDigest=p.digest(out.supplementalObservations || []);
 return out;
}
function load(symbol,raw) {
 const company=stocks.lookup(symbol);if(!company)return null;
 let entry=null,issuer=null;try{entry=index.get(company.symbol);issuer=index.view().issuers[p.cik(company.cik)];}catch(_){}
 const data=loadIssuer(p.cik(company.cik),issuer?.financialDigest || issuer?.evidence?.financialDigest);
 return adapt(company,raw,data,entry,issuer);
}
function sourcesFor(data,row,field){return (row?._sources?.[field] || []).map(id=>data?.provenance?.sources?.[id]).filter(Boolean);}
function getCompanyEvidence(...args){return require('./company-evidence').getCompanyEvidence(...args);}
module.exports={getCompanyEvidence,load,loadIssuer,adapt,safeRows,sourcesFor,invalidate};
