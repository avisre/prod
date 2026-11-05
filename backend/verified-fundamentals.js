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
  const row={...r,_sources:{...r._sources},_derivations:{...r._derivations},_scopes:{...r._scopes},_signs:{...r._signs},_classes:r._classes && Object.fromEntries(Object.entries(r._classes).map(([f,m])=>[f,{...m}]))};
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
 const perShare=r=>p.number(r?.dilutedEPS) ?? p.number(r?.eps);
 return [perShare(latest),ttmPerShare(latest,data?.income?.quarterlyReports || [],perShare)].some(eps=>eps>0 && Math.abs(Math.log(price/pe/eps))<=Math.log(1/0.6))?null:'share_class';
}
// The quote's P/E is trailing twelve months, so compare with the fiscal year moved on by the
// quarters filed since it, less the same quarters a year earlier (Q4 is never filed alone).
function ttmPerShare(latest,quarters,perShare) {
 const since=quarters.filter(r=>r.fiscalDateEnding>latest?.fiscalDateEnding),before=since.map(r=>quarters.find(x=>Math.abs((Date.parse(r.fiscalDateEnding)-Date.parse(x.fiscalDateEnding))/864e5-365)<=10));
 return perShare(latest)!==null && [...since,...before].every(r=>perShare(r)!==null)?since.reduce((t,r,i)=>t+perShare(r)-perShare(before[i]),perShare(latest)):null;
}
// A filing that reports one EPS per class of stock leaves each class's figure on the row (_classes,
// sec-facts): the listing's own class is the one whose figures the quote's trailing P/E confirms within
// 5% while no other class's are that close (V: Class A 1.5% vs Class B1 32%; GEF-B's stale annual put
// Class A 36% off). Its figures go onto a per-listing copy of the issuer file, never onto the cached one
// loadIssuer shares between the two classes.
function listingClassData(data,quote) {
 const latest=data?.income?.annualReports?.[0],price=p.number(quote?.price),pe=p.number(quote?.trailingPE);
 if(!latest?._classes || !(price>0 && pe>0))return null;
 const members=[...new Set(['dilutedEPS','eps'].flatMap(f=>Object.keys(latest._classes[f] || {})))],band=Math.log(1.05);
 // A row whose classes filed one figure carries it on the field itself (HSY's older quarters).
 const figure=(r,m)=>p.number(r?._classes?.dilutedEPS?.[m]?.v) ?? p.number(r?._classes?.eps?.[m]?.v) ?? p.number(r?.dilutedEPS) ?? p.number(r?.eps);
 const distance=m=>{const f=r=>figure(r,m);return [f(latest),ttmPerShare(latest,data.income.quarterlyReports || [],f)].reduce((best,eps)=>eps>0?Math.min(best,Math.abs(Math.log(price/pe/eps))):best,Infinity);};
 const ranked=members.map(m=>[m,distance(m)]).sort((a,b)=>a[1]-b[1]);
 const member=ranked.length && ranked[0][1]<=band && ranked.slice(1).every(([,d])=>d>band)?ranked[0][0]:null;
 if(!member)return null;
 const on=r=>{let copy=null;for(const f of ['eps','dilutedEPS'])if(r._classes?.[f]?.[member]){(copy ??= {...r,_sources:{...r._sources}})[f]=r._classes[f][member].v;copy._sources[f]=[r._classes[f][member].id];}return copy || r;};
 return {...data,income:{...data.income,annualReports:data.income.annualReports.map(on),quarterlyReports:(data.income.quarterlyReports || []).map(on)}};
}
// Filed annual statements for an issuer whose XBRL carries no annual report yet: a company that
// listed this year files a prospectus (424B4/S-1), not a 10-K, so SEC's facts feed has only the
// quarters. The statements are extracted from that filing's own HTML tables and kept in
// supplemental-financials (extract-html-statements.js); they are shown here with the filing they
// came from, and marked _supplemental so Ask and the API keep their separate attribution.
function filedAnnualRows(company,st,existing,supplements) {
 const list=supplements || require('./committed-supplements').forIssuer(p.cik(company.cik) || 'listing:'+company.symbol.replace(/\./g,'-'));
 const filed=list.filter(f=>f.sourceType==='issuer_release' && f.historyBasis==='annual' && f.statement===st && (st==='balance'?f.basis==='instant':f.basis==='annual') && f.state==='available' && f.scope==='entity');
 if(!filed.length)return {rows:[],sources:{}};
 const have=new Set((existing || []).map(r=>r.fiscalDateEnding)),periods=new Map(),sources={};
 for(const f of filed){
  const value=p.number(f.value);
  if(!p.day(f.periodEnd) || have.has(f.periodEnd) || !/^[A-Z]{3}$/.test(f.currency || '') || value===null || !Array.isArray(f.sourceIds) || !f.sourceIds.length)continue;
  let row=periods.get(f.periodEnd);
  if(!row)periods.set(f.periodEnd,row={fiscalDateEnding:f.periodEnd,periodStart:f.periodStart || null,reportedCurrency:f.currency,periodType:st==='balance'?'instant':'annual',_sources:{},_supplemental:{form:f.filingForm || null,filingDate:f.publicationDate || null,filingUrl:f.sourceUrl || null,sourceType:f.sourceType,verificationMethod:f.verificationMethod || null}});
  if(row.reportedCurrency!==f.currency || row[f.field]!=null)continue;
  row[f.field]=value;row._sources[f.field]=[...f.sourceIds];
  for(const id of f.sourceIds)sources[id]={type:'sec_html_statement',cik:p.cik(company.cik),concept:f.field,label:f.definition || f.field,unit:f.unit || f.currency,rawValue:value,periodStart:f.periodStart || null,periodEnd:f.periodEnd,form:f.filingForm || null,filingDate:f.publicationDate || null,accessionNumber:(f.sourceVersions || [])[0] || null,filingUrl:f.sourceUrl,linkage:'filed_html_statement',verificationMethod:f.verificationMethod || null,accountingBasis:f.accountingBasis || null,scope:f.scope,retrievedAt:f.retrievedAt || null,extractionVersion:f.extractionVersion || null,supplemental:true};
 }
 return {rows:[...periods.values()].filter(r=>Object.keys(r._sources).length).sort((a,b)=>b.fiscalDateEnding.localeCompare(a.fiscalDateEnding)),sources};
}
// Software and internet issuers (SIC 737x) only. Two cases, for annual and quarterly rows alike:
// - a filed software/intangible purchase and no PP&E line: that purchase stands in as capital
//   expenditure (Yahoo's method; AppLovin FY2025 $28.3m), marked _softwareCapex;
// - neither line filed for the whole fiscal year: capital expenditure stays null (shown as a dash,
//   never a made-up 0) and the row is marked _noCapexLine, so free cash flow equals operating cash
//   flow (StockAnalysis's method; AppLovin Q2 2026 $869.0m).
// A row whose neighbours in the same year do file capex is a derivation gap, not a missing line,
// and keeps no free cash flow.
const DAY=864e5;
function softwareCapex(annual,quarters) {
 const copyOf=row=>({...row,_sources:{...row._sources},_derivations:{...row._derivations},_scopes:{...row._scopes}});
 const swap=row=>{
  if(row.capitalExpenditures!==null || row.softwarePurchases==null || !row._sources?.softwarePurchases?.length)return row;
  const copy=copyOf(row);
  copy.capitalExpenditures=copy.softwarePurchases;
  copy._sources.capitalExpenditures=[...copy._sources.softwarePurchases];
  copy._scopes.capitalExpenditures=copy._scopes.softwarePurchases;
  copy._derivations.capitalExpenditures={formula:'software_capitalisation',inputs:['softwarePurchases'],inputValues:[copy.softwarePurchases]};
  copy._softwareCapex=true;
  return copy;
 };
 annual=annual.map(swap);quarters=quarters.map(swap);
 const end=r=>Date.parse(r.fiscalDateEnding);
 const hasCapex=r=>r.capitalExpenditures!==null && r.capitalExpenditures!==undefined;
 const noLine=r=>!hasCapex(r) && p.number(r.operatingCashflow)!==null;
 const mark=r=>({...copyOf(r),_noCapexLine:true});
 // annual row: no quarter inside its fiscal year files capex either
 annual=annual.map(r=>noLine(r) && !quarters.some(q=>end(q)<=end(r) && end(q)>end(r)-360*DAY && hasCapex(q))?mark(r):r);
 // quarter: the covering annual row (if filed) and every quarter of the same fiscal year have none
 quarters=quarters.map(q=>{
  if(!noLine(q))return q;
  const fy=annual.find(a=>end(a)>=end(q) && end(a)-end(q)<360*DAY);
  if(fy && hasCapex(fy))return q;
  const lo=fy?end(fy)-360*DAY:end(q)-280*DAY,hi=fy?end(fy):end(q)+280*DAY;
  return quarters.some(o=>o!==q && end(o)>lo && end(o)<=hi && hasCapex(o))?q:mark(q);
 });
 return {annual,quarters};
}
function adapt(company,raw,data,entry,issuer) {
 const type=company.securityType || 'stock';
 // Sector is rebuilt rather than copied: us-companies carries GICS names and the
 // fundamentals file carries Yahoo ones, and every peer/median consumer groups on
 // the GICS key. Falling back to the file's own label is what keeps ~1,968
 // companies that are absent from us-companies from losing peer context entirely.
 // A company with no fundamentals file (about 1,200 on 2026-10-31, mostly foreign filers) has
 // only its stored profile (scripts/refresh-profiles.js) for these; withIdentity, which merges
 // it, runs only on a file that exists.
 const profile=raw?.overview?.Description?null:stocks.profileFor(company.symbol);
 const overview={Symbol:company.symbol,Name:company.name,CIK:company.cik || '',Sector:sector.canonical(company.sector) || sector.canonical(raw?.overview?.Sector) || sector.canonical(profile?.sector) || '',Exchange:company.exchange || '',Currency:'USD'};
 for(const key of ['Industry','Description','Country','AssetType'])if(raw?.overview?.[key])overview[key]=raw.overview[key];
 if(!overview.Description && profile?.description)overview.Description=profile.description;
 if(!overview.Industry && profile?.industry)overview.Industry=profile.industry;
 // Legacy cover-page share overlays infer security basis from provider scale.
 // Verified company market values retain the dated provider quote instead.
 const quote=require('./quote-store').getDailyQuote(company.symbol,{useLegacySecShares:false});
 const marketData=quote?.asOf?{...quote,source:'Yahoo Finance daily snapshot',financialSource:false}:null;
 const rowsData=listingClassData(data,marketData) || data;
 const perShareReason=perShareBasis(company,rowsData,marketData,marketData?.currency || raw?.overview?.Currency || 'USD'),perShareAllowed=!perShareReason;
 if(marketData && !perShareAllowed){marketData.trailingPE=null;marketData.forwardPE=null;marketData.sharesOutstanding=null;}
 if(marketData){overview.MarketCapitalization=p.number(marketData.marketCap);overview.PERatio=p.number(marketData.trailingPE);overview.ForwardPE=p.number(marketData.forwardPE);overview.DividendYield=p.number(marketData.dividendYield);overview['52WeekHigh']=p.number(marketData.fiftyTwoWeekHigh);overview['52WeekLow']=p.number(marketData.fiftyTwoWeekLow);if(perShareAllowed)overview.SharesOutstanding=p.number(marketData.sharesOutstanding);}
 const out={overview,daily:raw?.daily || {},monthly:raw?.monthly || {},marketData,coverage:{annualReportingStatus:entry?.annualReportingStatus || 'unverified',financialCoverage:rowsData?(entry?.financialCoverage || 'unavailable'):'unavailable',securityType:type,latestAnnual:issuer?.evidence?.latestAnnual || null,latestPeriodic:issuer?.evidence?.latestPeriodic || null,latestEarningsRelease:issuer?.evidence?.latestEarningsRelease || null,lastSuccessfulCheckAt:issuer?.evidence?.lastSuccessfulCheckAt || null,sic:issuer?.evidence?.sic || null,investmentCompany:!!rowsData?.investmentCompany,perShareAllowed,perShareReason,missingReason:!rowsData?'No verified SEC financial observations are available.':null},provenance:{sources:rowsData?.sources || {},financialDigest:issuer?.financialDigest || issuer?.evidence?.financialDigest || null},fetchedAt:rowsData?.fetchedAt || null};
 // Software and internet companies that report no property-and-equipment line carry their capital spending
 // as a software/intangible purchase (AppLovin FY2025: $28.3m of intangibles against $0.5m of PP&E). For those
 // businesses alone that filed line stands in as the capital-expenditure input of free cash flow, and the row
 // is marked so the page can name the line it used. Everything else keeps the strict PP&E rule.
 const softwareSic=/^737\d$/.test(String(out.coverage.sic || ''));
 let softwareQuarters=null;
 for(const st of ['income','balance','cash']){
  let annual=type==='stock'?safeRows(rowsData,st,'annualReports',perShareAllowed):[];
  if(st==='cash' && type==='stock' && softwareSic){
   const quarters=safeRows(rowsData,'cash','quarterlyReports',perShareAllowed);
   ({annual,quarters:softwareQuarters}=softwareCapex(annual,quarters));
  }
  // A capital-expenditure line the XBRL feed does not carry but the printed cash-flow statement does
  // (fill-printed-capex.js): taken for the row's own period, cited to the filing it was read from.
  let printedSources={};
  const financialIssuer=/^(?:60|61|62|63)\d?/.test(String(out.coverage.sic || ''));
  if(st==='cash' && type==='stock' && annual.length && !financialIssuer){
   const filed=require('./committed-supplements').forIssuer(p.cik(company.cik) || 'listing:'+company.symbol.replace(/\./g,'-'))
    .filter(f=>f.sourceType==='issuer_release' && f.field==='capitalExpenditures' && f.historyBasis==='annual' && f.state==='available' && String(f.sourceIds?.[0] || '').startsWith('sec-print:'));
   if(filed.length)annual=annual.map(row=>{
    if(row.capitalExpenditures!==null)return row;
    const near=filed.find(f=>Math.abs(Date.parse(f.periodEnd)-Date.parse(row.fiscalDateEnding))<=10*864e5 && f.currency===(row.reportedCurrency || f.currency));
    if(!near)return row;
    const copy={...row,_sources:{...row._sources},_derivations:{...row._derivations},_scopes:{...row._scopes}};
    copy.capitalExpenditures=p.number(near.value);
    copy._sources.capitalExpenditures=[...near.sourceIds];
    copy._scopes.capitalExpenditures=near.scope || 'entity';
    copy._derivations.capitalExpenditures={formula:'printed_statement_line',inputs:[],inputValues:[p.number(near.value)]};
    copy._printedCapex={label:near.definition,receipt:near.receipt || null};
    for(const id of near.sourceIds)printedSources[id]={type:'sec_printed_statement',cik:p.cik(company.cik),concept:'capitalExpenditures',label:near.definition,unit:near.currency,rawValue:p.number(near.value),periodStart:near.periodStart || null,periodEnd:near.periodEnd,form:near.receipt?.document || null,filingDate:near.publicationDate || null,accessionNumber:(near.sourceVersions || [])[0] || null,filingUrl:near.sourceUrl,linkage:'filed_html_statement',verificationMethod:near.verificationMethod || null,accountingBasis:near.accountingBasis || null,scope:near.scope,retrievedAt:near.retrievedAt || null,extractionVersion:near.extractionVersion || null,supplemental:true};
    return copy;
   });
  }
  const filedAnnual=type==='stock' && !annual.length?filedAnnualRows(company,st,annual):{rows:[],sources:{}};
  out[st]={annualReports:[...annual,...filedAnnual.rows].sort((a,b)=>b.fiscalDateEnding.localeCompare(a.fiscalDateEnding)),quarterlyReports:type==='stock'?(st==='cash' && softwareQuarters) || safeRows(rowsData,st,'quarterlyReports',perShareAllowed):[]};
  if(filedAnnual.rows.length)out.provenance.sources={...out.provenance.sources,...filedAnnual.sources};
  if(Object.keys(printedSources).length)out.provenance.sources={...out.provenance.sources,...printedSources};
 }
 const inc=out.income.annualReports[0];overview.Currency=inc?.reportedCurrency || out.balance.annualReports[0]?.reportedCurrency || 'USD';
 overview.EPS=inc?.dilutedEPS ?? inc?.eps ?? null;
 // An ADR's or foreign filer's EPS stays out of the statement rows, where readers pair it
 // with the listing's price; the page shows it alone, in the filing currency, per ordinary share.
 if(type==='stock' && ['adr','currency'].includes(perShareReason)){const row=safeRows(rowsData,'income','annualReports',true)[0];if(row && (p.number(row.dilutedEPS)!==null || p.number(row.eps)!==null))out.filedPerShare={fiscalDateEnding:row.fiscalDateEnding,reportedCurrency:row.reportedCurrency,dilutedEPS:p.number(row.dilutedEPS),eps:p.number(row.eps),basis:'per ordinary share'};}
 // The filed share counts stay out of the rows for the same reason. The company page needs them
 // for the market-cap history and puts them on the listing's share basis itself (today's market
 // cap ÷ today's price), so they travel apart, labelled as ordinary shares.
 if(type==='stock' && ['adr','currency'].includes(perShareReason)){const counts=(st,field)=>['annualReports','quarterlyReports'].flatMap(k=>safeRows(rowsData,st,k,true)).map(r=>({fiscalDateEnding:r.fiscalDateEnding,shares:p.number(r[field])})).filter(r=>r.shares>0);const periodEnd=counts('balance','commonStockSharesOutstanding'),weighted=counts('income','weightedAverageSharesOutstanding');if(periodEnd.length || weighted.length)out.filedShareCounts={basis:'ordinary shares',periodEnd,weighted};}
 if(!perShareAllowed)overview.PERatio=null;
 if(type==='stock')out.supplementalObservations=require('./company-observations').reconcile(require('./company-observations').observations(rowsData),require('./committed-supplements').forIssuer(company.cik || 'listing:'+company.symbol.replace(/\./g,'-'))).filter(f=>f.state==='available');
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
module.exports={getCompanyEvidence,load,loadIssuer,adapt,safeRows,softwareCapex,filedAnnualRows,sourcesFor,invalidate};
