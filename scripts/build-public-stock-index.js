#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const p=require('../backend/sec-coverage');
const {content}=require('../backend/public-stock-content');
const adapter=require('../backend/verified-fundamentals');
const {loadRawFundamentals}=require('../backend/fundamentals-cache');
function read(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
function build({asOf=p.day(new Date().toISOString()),write=true}={}) {
 const directoryRaw=fs.readFileSync(path.join(p.DATA_DIR,'us-companies.json'),'utf8');
 const directory=JSON.parse(directoryRaw),report=read(path.join(p.DATA_DIR,'sec-reporting.json'),{schemaVersion:1,issuers:{}});
 const rates=read(path.join(p.DATA_DIR,'sec-fx.json'),{rates:{}}).rates;
 const previous=read(path.join(p.DATA_DIR,'public-stock-index.json'),null);
 const issuers={},securities=[],rows=[],marketDigests=[],priceDigests=[];const oldSecurities=new Map((previous?.securities || []).map(s=>[s.symbol,s]));
 const grouped=new Map();for(const c of directory.companies){const id=p.cik(c.cik);if(!id)continue;const group=grouped.get(id)||[];group.push(c);grouped.set(id,group);}
 for(const [id,companies] of grouped) {
  const evidence=report.issuers[id] || {cik:id,symbols:companies.map(c=>c.symbol),lastAttemptResult:'unverified'};
  const file=path.join(p.DATA_DIR,'sec-financials',id+'.json');
  const raw=evidence.financialDigest && fs.existsSync(file)?fs.readFileSync(file,'utf8'):null;
  if(raw && evidence.financialDigest!==p.digest(raw))throw new Error('Financial digest mismatch '+id);
  const data=raw?JSON.parse(raw):null,classification=p.classify(evidence,data,asOf);
  const compactEvidence={cik:id,lastSuccessfulCheckAt:evidence.lastSuccessfulCheckAt || null,lastAttemptResult:evidence.lastAttemptResult,sic:evidence.sic || null,reportingCurrency:evidence.reportingCurrency || null,reportingCadence:evidence.reportingCadence || null,latestAnnual:evidence.latestAnnual || null,amendmentOnly:!!evidence.amendmentOnly};
  issuers[id]={...classification,evidence:compactEvidence,financialDigest:evidence.financialDigest || null};
  for(let company of companies) {
   // A company with no curated sector takes the sector of its SEC industry code.
   if(!company.sector){const sector=require('../backend/sector').fromSic(evidence.sic);if(sector)company={...company,sector};}
   const eligible=company.securityType==='stock' && classification.financialCoverage==='ready';
   const view=adapter.adapt(company,loadRawFundamentals(company.symbol),data,classification,issuers[id]);
   const state=content({...company,cik:id},view,classification,evidence.financialDigest || null,{asOf,previous:oldSecurities.get(company.symbol),rates});
   securities.push({...company,cik:id,aliases:[company.symbol.replace(/\./g,'-'),company.symbol.replace(/-/g,'.')].filter(s=>s!==company.symbol),...classification,indexable:eligible,screenable:eligible,...state.entry,financialDigest:evidence.financialDigest || null});
   marketDigests.push([company.symbol,state.marketDigest]);priceDigests.push([company.symbol,state.priceDigest]);
   if(state.screenRow)rows.push(state.screenRow);
  }
 }
 for(const c of directory.companies.filter(c=>!p.cik(c.cik))){const contentDigest=p.digest(c),old=oldSecurities.get(c.symbol);securities.push({...c,cik:null,aliases:[],annualReportingStatus:'unverified',financialCoverage:'unavailable',indexable:false,screenable:false,metricSlugs:[],priceHistory:false,financialDigest:null,contentDigest,lastmod:old?.contentDigest===contentDigest?old.lastmod:asOf});}
 const rank=new Map(directory.companies.map((c,i)=>[c.symbol,i]));securities.sort((a,b)=>rank.get(a.symbol)-rank.get(b.symbol));
 const reportingMetadata=require('../backend/company-reporting').metadata(report);
 const sourceFingerprints={reportingMetadataDigest:p.digest(reportingMetadata),supplementalDigest:require('../backend/committed-supplements').fingerprint(),directoryDigest:p.digest(directoryRaw),reportingDigest:p.digest(report),financialDigests:p.digest(Object.entries(issuers).map(([id,i])=>[id,i.financialDigest])),quotesDigest:p.digest(marketDigests),priceHistoryDigest:p.digest(priceDigests),fxDigest:p.digest(rates),screenRowsDigest:p.digest(rows)};
 const datasetId=p.digest({asOf,sourceFingerprints,policyVersion:1,securities:securities.map(s=>s.contentDigest)});
 const comparisonPairs=[];const bySector=new Map();for(const s of securities.filter(s=>s.screenable && s.sector && /^[A-Z0-9.]+$/.test(s.symbol))){const list=bySector.get(s.sector)||[];list.push(s);bySector.set(s.sector,list);}
 const seen=new Set();for(const list of bySector.values())for(let i=0;i<list.length;i++)for(let offset=1;offset<=2;offset++){const peer=list[i+offset];if(peer && peer.cik!==list[i].cik){const pair=[list[i].symbol,peer.symbol].sort().join('-vs-');if(!seen.has(pair) && comparisonPairs.length<5000){seen.add(pair);comparisonPairs.push(pair);}}}
 const publicSnapshot={schemaVersion:1,policyVersion:1,generatedAt:new Date().toISOString(),asOf,sourceFingerprints,datasetId,counts:p.count(securities,issuers),issuers,securities,comparisonPairs};
 const screenSnapshot={v:4,policyVersion:1,generatedAt:publicSnapshot.generatedAt,asOf,datasetId,rowsDigest:sourceFingerprints.screenRowsDigest,count:rows.length,rows};
 for(const doc of [publicSnapshot,screenSnapshot])if(Buffer.byteLength(JSON.stringify(doc))>8*1024*1024)throw new Error('Snapshot exceeds 8 MiB');
 if(write){
  p.atomicWrite(path.join(p.DATA_DIR,'financial-reporting-index.json'),{schemaVersion:1,datasetId,reportingDigest:sourceFingerprints.reportingDigest,issuers:reportingMetadata});
  require('./lib/publish-stock-snapshots').publish(p.DATA_DIR,publicSnapshot,screenSnapshot);
  require('../backend/company-reporting').invalidate();
  require('../backend/public-stock-index').invalidate();
  require('./build-financial-coverage').build();
  require('../backend/financial-coverage').invalidate();
 }
 return {publicSnapshot,screenSnapshot};
}
if(require.main===module){try{const result=build();console.log(JSON.stringify(result.publicSnapshot.counts,null,2));}catch(e){console.error(e.message);process.exitCode=1;}}
module.exports={build};
