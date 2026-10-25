#!/usr/bin/env node
'use strict';
// Second deterministic stage: original annual disclosures, two paced workers.
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{spawn}=require('node:child_process');
const p=require('../backend/sec-coverage'),original=require('../backend/sec-original'),industry=require('../backend/sec-industry');
const {issuersFor}=require('./refresh-sec-coverage');
// --jobs N: the reads wait on SEC, not the CPU, so N processes share the issuers and the one 8-a-second pace.
// The parent holds the lock and merges each shard's entries; on a stop it waits for the shards to save first.
async function parent(argv,jobs) {
 const reportFile=path.join(p.DATA_DIR,'sec-reporting.json'),lock=path.join(p.DATA_DIR,'.sec-refresh.lock');const fd=fs.openSync(lock,'wx');fs.writeSync(fd,String(process.pid));
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'sec-industry-')),rest=argv.filter((a,i)=>a!=='--jobs' && argv[i-1]!=='--jobs'),wait=()=>{};
 process.on('SIGINT',wait);process.on('SIGTERM',wait);
 const codes=await Promise.all(Array.from({length:jobs},(_,i)=>new Promise(res=>spawn(process.execPath,[__filename,...rest,'--shard',`${i}/${jobs}`,'--shard-out',path.join(tmp,i+'.json')],{stdio:['ignore','inherit','inherit']}).on('exit',res))));
 const report=JSON.parse(fs.readFileSync(reportFile,'utf8'));let merged=0;
 for(let i=0;i<jobs;i++){let part;try{part=JSON.parse(fs.readFileSync(path.join(tmp,i+'.json'),'utf8'));}catch(e){if(e.code==='ENOENT')continue;throw e;}for(const [cik,entry] of Object.entries(part)){Object.assign(report.issuers[cik],entry);merged++;}}
 p.atomicWrite(reportFile,report);fs.rmSync(tmp,{recursive:true,force:true});fs.closeSync(fd);fs.unlinkSync(lock);
 process.removeListener('SIGINT',wait);process.removeListener('SIGTERM',wait);
 console.log(JSON.stringify({merged,shardExitCodes:codes}));
 if(codes.some(c=>c!==0))throw new Error('a shard failed; rerun to resume');
}
async function main(argv=process.argv.slice(2)) {
 const opt=k=>{const i=argv.indexOf(k);return i>=0?argv[i+1]:null;},jobs=Number(opt('--jobs') || 1),shard=opt('--shard');
 if(jobs>1 && !shard)return parent(argv,jobs);
 const symbols=argv.includes('--symbols')?new Set(argv[argv.indexOf('--symbols')+1].split(',')):null;
 const directory=JSON.parse(fs.readFileSync(path.join(p.DATA_DIR,'us-companies.json'),'utf8'));
 const reportFile=path.join(p.DATA_DIR,'sec-reporting.json'),report=JSON.parse(fs.readFileSync(reportFile,'utf8'));
 const retryOnly=argv.includes('--retry');
 let todo=issuersFor(directory.companies).filter(i=>(!symbols || i.symbols.some(s=>symbols.has(s))) && (!retryOnly || report.issuers[i.cik]?.industryExtraction?.status==='retrieval_failed'));
 const touched={};
 if(shard){const [i,n]=shard.split('/').map(Number);todo=todo.filter((_,k)=>k%n===i);require('./reextract-local').pace(8/n);}
 const lock=path.join(p.DATA_DIR,'.sec-refresh.lock'),fd=shard?null:fs.openSync(lock,'wx');if(fd!==null)fs.writeSync(fd,String(process.pid));
 let done=0,success=0,failed=0;const save=shard?()=>p.atomicWrite(opt('--shard-out'),touched):()=>p.atomicWrite(reportFile,report);
 const shutdown=()=>{save();process.exit(130);};process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
 const unlock=()=>{if(fd===null)return;try{fs.closeSync(fd);fs.unlinkSync(lock);}catch(_){}};process.once('exit',unlock);
 // A shard that throws still hands back what it wrote, or the next run finds those files' digests changed.
 if(shard)process.once('exit',save);
 await Promise.all(Array.from({length:2},async()=>{while(todo.length){const issuer=todo.shift(),e=report.issuers[issuer.cik];
  if(!e?.financialDigest || !e.latestAnnual)continue;
  const file=path.join(p.DATA_DIR,'sec-financials',issuer.cik+'.json'),raw=fs.readFileSync(file,'utf8');if(p.digest(raw)!==e.financialDigest)throw new Error('FINANCIAL_DIGEST_MISMATCH');
  // A re-extracted file carries no industryExtraction, so a matching one means this annual
  // report was already read into this exact file; only a new 10-K or VERSION reads it again.
  const data=JSON.parse(raw);if(data.industryExtraction?.version===industry.VERSION && data.industryExtraction.sourceVersion===e.latestAnnual.accessionNumber)continue;
  if(e.industryExtraction?.status==='unsupported_extraction' && e.industryExtraction.version===industry.VERSION && e.industryExtraction.sourceVersion===e.latestAnnual.accessionNumber)continue;
  try{const document=await original.fetchOriginal(issuer.cik,e.latestAnnual),next=industry.enrich(data,document,e,{asOf:report.asOf});p.atomicWrite(file,next);e.financialDigest=p.digest(fs.readFileSync(file,'utf8'));e.industryExtraction=next.industryExtraction;touched[issuer.cik]={financialDigest:e.financialDigest,industryExtraction:e.industryExtraction};success++;}
  catch(err){e.industryExtraction={version:industry.VERSION,status:/INVALID_INDUSTRY|ORIGINAL_DOCUMENT_(?:TOO_LARGE|PATH_UNAVAILABLE)/.test(err.message || '')?'unsupported_extraction':'retrieval_failed',sourceVersion:e.latestAnnual.accessionNumber,checkedAt:new Date().toISOString(),reason:String(err.code || err.message).slice(0,120)};touched[issuer.cik]={industryExtraction:e.industryExtraction};failed++;}
  done++;if(done%20===0){save();console.log(JSON.stringify({originalIssuers:done,success,failed,remaining:todo.length}));}
 }}));save();process.removeListener('SIGINT',shutdown);process.removeListener('SIGTERM',shutdown);unlock();process.removeListener('exit',unlock);console.log(JSON.stringify({originalIssuers:done,success,failed}));
}
if(require.main===module)main().catch(e=>{console.error(e.code || e.message);process.exitCode=1;});module.exports={main};
