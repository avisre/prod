#!/usr/bin/env node
'use strict';
// Re-extracts every issuer's SEC statements on this machine after an extraction
// change, with the same refreshIssuer the weekly job runs: the filing index is
// read live (paced by sec-throttle), the company facts come from SEC's nightly
// companyfacts.zip instead of ~5,800 separate downloads, and the original
// filing is still fetched live wherever refreshIssuer needs it. The weekly
// job's guards apply unchanged: an issuer that would lose a verified figure
// keeps its old file. Resumable: issuers already at this extraction version
// are skipped.
//   SEC_BULK_DIR=<dir with companyfacts.zip> node scripts/reextract-local.js [--symbols AAPL,MSFT] [--concurrency 4]
//     [--offline-reporting] [--jobs 12]
// --offline-reporting reads each issuer's filing index as last checked (sec-reporting.json)
// instead of live; the facts and the extraction are what change. --jobs N splits the
// issuers over N processes; their SEC requests together stay at 8 a second.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const p=require('../backend/sec-coverage');
const client=require('../backend/sec-reporting');
const bulk=require('../backend/companyfacts-bulk');
const {EXTRACTION_VERSION}=require('../backend/sec-facts');
const {refreshIssuer,issuersFor}=require('./refresh-sec-coverage');
const DATA=p.DATA_DIR,REPORT=path.join(DATA,'sec-reporting.json');

// sec-throttle paces each process at 8 a second; N processes each take an even share.
function pace(perSecond) {
 const axios=require(require.resolve('axios',{paths:[path.join(__dirname,'../backend')]}));let next=0;
 axios.interceptors.request.use(async cfg=>{let host='';try{host=new URL(cfg.url,cfg.baseURL).hostname;}catch(_){}
  if(/(^|\.)sec\.gov$/.test(host)){const now=Date.now(),at=Math.max(now,next);next=at+1000/perSecond;if(at>now)await new Promise(r=>setTimeout(r,at-now));}return cfg;});
}
async function parent(argv,jobs) {
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'reextract-')),rest=[];
 for(let i=0;i<argv.length;i++){if(argv[i]==='--jobs'){i++;continue;}rest.push(argv[i]);}
 const codes=await Promise.all(Array.from({length:jobs},(_,i)=>new Promise(res=>{const c=spawn(process.execPath,[__filename,...rest,'--shard',`${i}/${jobs}`,'--shard-out',path.join(tmp,i+'.json')],{stdio:['ignore','inherit','inherit']});c.on('exit',res);})));
 // Whatever a shard finished is kept, even when another failed, so a rerun resumes.
 const report=JSON.parse(fs.readFileSync(REPORT,'utf8')),asOf=p.day(new Date().toISOString()),live=!argv.includes('--offline-reporting');let merged=0;
 // A shard's day is the day it started; the cycle is the report's day, so a run past midnight stamps the later one.
 for(let i=0;i<jobs;i++){let part;try{part=JSON.parse(fs.readFileSync(path.join(tmp,i+'.json'),'utf8'));}catch(e){if(e.code==='ENOENT')continue;throw e;}for(const [cik,entry] of Object.entries(part)){report.issuers[cik]=live?{...entry,lastReconciledCycle:asOf}:entry;merged++;}}
 report.generatedAt=new Date().toISOString();if(live)report.asOf=asOf;p.atomicWrite(REPORT,report);
 fs.rmSync(tmp,{recursive:true,force:true});
 console.log(JSON.stringify({merged,shardExitCodes:codes}));
 if(codes.some(c=>c!==0))throw new Error('a shard failed; rerun to resume');
}
async function main(argv=process.argv.slice(2)) {
 const opt=k=>{const i=argv.indexOf(k);return i>=0?argv[i+1]:null;};
 if(!bulk.isFresh())throw new Error('companyfacts.zip is missing or older than 36h: set SEC_BULK_DIR and download a fresh one');
 const jobs=Number(opt('--jobs') || 1),shard=opt('--shard'),offline=argv.includes('--offline-reporting');
 if(jobs>1 && !shard)return parent(argv,jobs);
 const asOf=p.day(new Date().toISOString()),concurrency=Number(opt('--concurrency') || 4);
 const report=JSON.parse(fs.readFileSync(REPORT,'utf8'));
 let list=JSON.parse(fs.readFileSync(path.join(DATA,'us-companies.json'),'utf8')).companies;
 const symbols=opt('--symbols');
 if(symbols){const wanted=new Set(symbols.split(',').map(s=>s.trim().toUpperCase()));list=list.filter(c=>wanted.has(c.symbol));}
 let todo=issuersFor(list).filter(i=>(symbols || report.issuers[i.cik]?.extractionVersion!==EXTRACTION_VERSION) && (!offline || report.issuers[i.cik]?.latestAnnual || report.issuers[i.cik]?.latestPeriodic));
 if(shard){const [i,n]=shard.split('/').map(Number);todo=todo.filter((_,k)=>k%n===i);pace(8/n);}
 const touched={};
 const clientImpl={fetchReporting:offline?async()=>({}):client.fetchReporting,fetchFacts:async cik=>(await bulk.documentForCik(p.cik(cik))) || client.fetchFacts(cik)};
 const tally={};let done=0;const total=todo.length;
 // as the weekly job does: the checks are dated today, so the report's day is today, or the
 // index built from it reads checks from after its own day and never expires them
 const save=shard?()=>p.atomicWrite(opt('--shard-out'),touched):()=>{report.generatedAt=new Date().toISOString();if(!offline)report.asOf=asOf;p.atomicWrite(REPORT,report);};
 process.once('SIGINT',()=>{save();process.exit(130);});
 await Promise.all(Array.from({length:concurrency},async()=>{
  for(let issuer=todo.shift();issuer;issuer=todo.shift()) {
   const old=report.issuers[issuer.cik],next=await refreshIssuer(issuer,old,{asOf,force:true,clientImpl});
   // As the weekly job does (refresh-sec-coverage.js): a live read of the filing index is this cycle's check.
   // An offline run re-reads nothing from SEC's index, so it leaves the cycle as it was.
   if(!offline)next.lastReconciledCycle=asOf;
   report.issuers[issuer.cik]=next;touched[issuer.cik]=next;
   const result=next.lastFinancialResult==='success' && next.extractionVersion===EXTRACTION_VERSION?'written':(next.lastErrorCode || next.lastFinancialResult || 'unknown').split(':')[0];
   tally[result]=(tally[result] || 0)+1;
   if(++done%50===0){save();console.log(JSON.stringify({done,total,tally}));}
  }
 }));
 save();console.log(JSON.stringify({done,total,tally}));
}
if(require.main===module)main().then(()=>process.exit(0)).catch(e=>{console.error(e.message);process.exit(1);});
module.exports={main};
