#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const p=require('../backend/sec-coverage');
const {content}=require('../backend/public-stock-content');
const screenFacts=require('../backend/screen-facts');
const adapter=require('../backend/verified-fundamentals');
const {loadRawFundamentals}=require('../backend/fundamentals-cache');
const {isMainThread,workerData}=require('node:worker_threads');
const {runChunks,serveChunks}=require('./lib/worker-pool');
function read(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
// Inputs every pass reads. A worker calls this too, with the parent's resolved
// date, so its chunk sees exactly what the parent sees.
function inputs(asOf) {
 const directoryRaw=fs.readFileSync(path.join(p.DATA_DIR,'us-companies.json'),'utf8');
 const directory=JSON.parse(directoryRaw),report=read(path.join(p.DATA_DIR,'sec-reporting.json'),{schemaVersion:1,issuers:{}});
 // The dataset is dated by the reconciliation cycle that checked its issuers,
 // not by the day the index happens to be rebuilt: the deploy gate requires
 // every issuer to have been checked in the index's own cycle, so a daily
 // price refresh stamped with today's date could never be deployed.
 asOf=asOf || p.day(report.asOf) || p.day(new Date().toISOString());
 const rates=read(path.join(p.DATA_DIR,'sec-fx.json'),{rates:{}}).rates;
 const previous=read(path.join(p.DATA_DIR,'public-stock-index.json'),null);
 const oldSecurities=new Map((previous?.securities || []).map(s=>[s.symbol,s]));
 const grouped=new Map();for(const c of directory.companies){const id=p.cik(c.cik);if(!id)continue;const group=grouped.get(id)||[];group.push(c);grouped.set(id,group);}
 return {directoryRaw,directory,report,asOf,rates,oldSecurities,groups:[...grouped]};
}
// Issuers groups[start..end) in directory order. Each issuer depends only on
// its own files, so chunks can run anywhere and concatenate to the serial result.
function chunk({report,asOf,rates,oldSecurities,groups},start,end) {
 const issuers=[],securities=[],rows=[],facts=[],marketDigests=[],priceDigests=[];
 for(const [id,companies] of groups.slice(start,end)) {
  const evidence=report.issuers[id] || {cik:id,symbols:companies.map(c=>c.symbol),lastAttemptResult:'unverified'};
  const file=path.join(p.DATA_DIR,'sec-financials',id+'.json');
  const raw=evidence.financialDigest && fs.existsSync(file)?fs.readFileSync(file,'utf8'):null;
  if(raw && evidence.financialDigest!==p.digest(raw))throw new Error('Financial digest mismatch '+id);
  const data=raw?JSON.parse(raw):null,classification=p.classify(evidence,data,asOf);
  const compactEvidence={cik:id,lastSuccessfulCheckAt:evidence.lastSuccessfulCheckAt || null,lastAttemptResult:evidence.lastAttemptResult,sic:evidence.sic || null,reportingCurrency:evidence.reportingCurrency || null,reportingCadence:evidence.reportingCadence || null,latestAnnual:evidence.latestAnnual || null,amendmentOnly:!!evidence.amendmentOnly};
  const issuer={...classification,evidence:compactEvidence,financialDigest:evidence.financialDigest || null};
  for(let company of companies) {
   // A company with no curated sector takes the sector of its SEC industry code.
   if(!company.sector){const sector=require('../backend/sector').fromSic(evidence.sic);if(sector)company={...company,sector};}
   const eligible=company.securityType==='stock' && classification.financialCoverage==='ready';
   const view=adapter.adapt(company,loadRawFundamentals(company.symbol),data,classification,issuer);
   const state=content({...company,cik:id},view,classification,evidence.financialDigest || null,{asOf,previous:oldSecurities.get(company.symbol),rates});
   securities.push({...company,cik:id,aliases:[company.symbol.replace(/\./g,'-'),company.symbol.replace(/-/g,'.')].filter(s=>s!==company.symbol),...classification,indexable:eligible,screenable:eligible,...state.entry,financialDigest:evidence.financialDigest || null});
   marketDigests.push([company.symbol,state.marketDigest]);priceDigests.push([company.symbol,state.priceDigest]);
   if(state.screenRow)rows.push(state.screenRow);
   // The statement lines behind the row, for questions no precomputed column answers.
   if(state.screenRow){const fact=screenFacts.row(company,view);if(fact)facts.push(fact);}
  }
  issuers.push([id,issuer]);
 }
 return {issuers,securities,rows,facts,marketDigests,priceDigests};
}
function build({asOf,write=true}={}) {
 const ctx=inputs(asOf);
 return finish(ctx,[chunk(ctx,0,ctx.groups.length)],write);
}
// The same build with the per-issuer work spread over worker threads (about
// 80% of a rebuild is verified-fundamentals adapt, one issuer at a time).
// Chunks are small and handed out as workers free up, then reassembled in
// directory order, so the output is identical to build().
async function buildParallel({asOf,write=true,workers}={}) {
 const ctx=inputs(asOf);
 const parts=await runChunks(__filename,{indexBuildWorker:true,asOf:ctx.asOf},ctx.groups.length,{workers});
 const result=finish(ctx,parts,write,{coverage:false});
 // Coverage reads the index just written, so it follows it, on every core as well.
 if(write){await require('./build-financial-coverage').buildParallel({workers});require('../backend/financial-coverage').invalidate();}
 return result;
}
function finish({directoryRaw,directory,report,asOf,rates,oldSecurities},parts,write,{coverage=true}={}) {
 const issuers={},securities=[],rows=[],facts=[],marketDigests=[],priceDigests=[];
 for(const part of parts){for(const [id,issuer] of part.issuers)issuers[id]=issuer;securities.push(...part.securities);rows.push(...part.rows);facts.push(...part.facts);marketDigests.push(...part.marketDigests);priceDigests.push(...part.priceDigests);}
 for(const c of directory.companies.filter(c=>!p.cik(c.cik))){const contentDigest=p.digest(c),old=oldSecurities.get(c.symbol);securities.push({...c,cik:null,aliases:[],annualReportingStatus:'unverified',financialCoverage:'unavailable',indexable:false,screenable:false,metricSlugs:[],priceHistory:false,financialDigest:null,contentDigest,lastmod:old?.contentDigest===contentDigest?old.lastmod:asOf});}
 const rank=new Map(directory.companies.map((c,i)=>[c.symbol,i]));securities.sort((a,b)=>rank.get(a.symbol)-rank.get(b.symbol));
 const reportingMetadata=require('../backend/company-reporting').metadata(report);
 const sourceFingerprints={reportingMetadataDigest:p.digest(reportingMetadata),supplementalDigest:require('../backend/committed-supplements').fingerprint(),directoryDigest:p.digest(directoryRaw),reportingDigest:p.digest(report),financialDigests:p.digest(Object.entries(issuers).map(([id,i])=>[id,i.financialDigest])),quotesDigest:p.digest(marketDigests),priceHistoryDigest:p.digest(priceDigests),fxDigest:p.digest(rates),screenRowsDigest:p.digest(rows)};
 const datasetId=p.digest({asOf,sourceFingerprints,policyVersion:1,securities:securities.map(s=>s.contentDigest)});
 const comparisonPairs=[];const bySector=new Map();for(const s of securities.filter(s=>s.screenable && s.sector && /^[A-Z0-9.]+$/.test(s.symbol))){const list=bySector.get(s.sector)||[];list.push(s);bySector.set(s.sector,list);}
 const seen=new Set();for(const list of bySector.values())for(let i=0;i<list.length;i++)for(let offset=1;offset<=2;offset++){const peer=list[i+offset];if(peer && peer.cik!==list[i].cik){const pair=[list[i].symbol,peer.symbol].sort().join('-vs-');if(!seen.has(pair) && comparisonPairs.length<5000){seen.add(pair);comparisonPairs.push(pair);}}}
 const publicSnapshot={schemaVersion:1,policyVersion:1,generatedAt:new Date().toISOString(),asOf,sourceFingerprints,datasetId,counts:p.count(securities,issuers),issuers,securities,comparisonPairs};
 const screenSnapshot={v:4,policyVersion:1,generatedAt:publicSnapshot.generatedAt,asOf,datasetId,rowsDigest:sourceFingerprints.screenRowsDigest,count:rows.length,rows};
 const factsSnapshot=screenFacts.snapshot(facts,asOf);
 for(const doc of [publicSnapshot,screenSnapshot])if(Buffer.byteLength(JSON.stringify(doc))>8*1024*1024)throw new Error('Snapshot exceeds 8 MiB');
 if(write){
  p.atomicWrite(path.join(p.DATA_DIR,'financial-reporting-index.json'),{schemaVersion:1,datasetId,reportingDigest:sourceFingerprints.reportingDigest,issuers:reportingMetadata});
  require('./lib/publish-stock-snapshots').publish(p.DATA_DIR,publicSnapshot,screenSnapshot);
  p.atomicWrite(path.join(p.DATA_DIR,screenFacts.FILE),factsSnapshot);screenFacts.invalidate();
  require('../backend/company-reporting').invalidate();
  require('../backend/public-stock-index').invalidate();
  if(coverage){require('./build-financial-coverage').build();require('../backend/financial-coverage').invalidate();}
 }
 return {publicSnapshot,screenSnapshot,factsSnapshot};
}
if(!isMainThread && workerData?.indexBuildWorker){
 const ctx=inputs(workerData.asOf);serveChunks((start,end)=>chunk(ctx,start,end));
}else if(require.main===module){buildParallel().then(result=>console.log(JSON.stringify(result.publicSnapshot.counts,null,2)),e=>{console.error(e.message);process.exitCode=1;});}
module.exports={build,buildParallel};
