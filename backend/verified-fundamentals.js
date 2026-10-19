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
function adapt(company,raw,data,entry,issuer) {
 const type=company.securityType || 'stock';
 const siblings=stocks.companies().filter(s=>s.securityType==='stock' && p.cik(s.cik)===p.cik(company.cik));
 let perShareAllowed=siblings.length===1 && !/American Deposit(?:ary|ory)|\b(?:ADR|ADS)\b/i.test(company.securityName || company.name || '');
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
 const financialCurrency=data?.income?.annualReports?.[0]?.reportedCurrency;
 if(financialCurrency && financialCurrency!==(marketData?.currency || raw?.overview?.Currency || 'USD'))perShareAllowed=false;
 if(marketData && !perShareAllowed){marketData.trailingPE=null;marketData.sharesOutstanding=null;}
 if(marketData){overview.MarketCapitalization=p.number(marketData.marketCap);overview.PERatio=p.number(marketData.trailingPE);overview['52WeekHigh']=p.number(marketData.fiftyTwoWeekHigh);overview['52WeekLow']=p.number(marketData.fiftyTwoWeekLow);if(perShareAllowed)overview.SharesOutstanding=p.number(marketData.sharesOutstanding);}
 const out={overview,daily:raw?.daily || {},monthly:raw?.monthly || {},marketData,coverage:{annualReportingStatus:entry?.annualReportingStatus || 'unverified',financialCoverage:data?(entry?.financialCoverage || 'unavailable'):'unavailable',securityType:type,latestAnnual:issuer?.evidence?.latestAnnual || null,lastSuccessfulCheckAt:issuer?.evidence?.lastSuccessfulCheckAt || null,sic:issuer?.evidence?.sic || null,perShareAllowed,missingReason:!data?'No verified SEC financial observations are available.':null},provenance:{sources:data?.sources || {},financialDigest:issuer?.financialDigest || issuer?.evidence?.financialDigest || null},fetchedAt:data?.fetchedAt || null};
 for(const st of ['income','balance','cash'])out[st]={annualReports:type==='stock'?safeRows(data,st,'annualReports',perShareAllowed):[],quarterlyReports:type==='stock'?safeRows(data,st,'quarterlyReports',perShareAllowed):[]};
 const inc=out.income.annualReports[0];overview.Currency=inc?.reportedCurrency || out.balance.annualReports[0]?.reportedCurrency || 'USD';
 overview.EPS=inc?.dilutedEPS ?? inc?.eps ?? null;
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
