#!/usr/bin/env node
'use strict';
// Second deterministic stage: original annual disclosures, two paced workers.
const fs=require('node:fs'),path=require('node:path');
const p=require('../backend/sec-coverage'),original=require('../backend/sec-original'),industry=require('../backend/sec-industry');
const {issuersFor}=require('./refresh-sec-coverage');
async function main(argv=process.argv.slice(2)) {
 const symbols=argv.includes('--symbols')?new Set(argv[argv.indexOf('--symbols')+1].split(',')):null;
 const directory=JSON.parse(fs.readFileSync(path.join(p.DATA_DIR,'us-companies.json'),'utf8'));
 const reportFile=path.join(p.DATA_DIR,'sec-reporting.json'),report=JSON.parse(fs.readFileSync(reportFile,'utf8'));
 const todo=issuersFor(directory.companies).filter(i=>!symbols || i.symbols.some(s=>symbols.has(s)));
 const lock=path.join(p.DATA_DIR,'.sec-refresh.lock');const fd=fs.openSync(lock,'wx');fs.writeSync(fd,String(process.pid));
 let done=0,success=0,failed=0;const save=()=>p.atomicWrite(reportFile,report);
 const shutdown=()=>{save();process.exit(130);};process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
 const unlock=()=>{try{fs.closeSync(fd);fs.unlinkSync(lock);}catch(_){}};process.once('exit',unlock);
 await Promise.all(Array.from({length:2},async()=>{while(todo.length){const issuer=todo.shift(),e=report.issuers[issuer.cik];
  if(!e?.financialDigest || !e.latestAnnual)continue;
  const file=path.join(p.DATA_DIR,'sec-financials',issuer.cik+'.json'),raw=fs.readFileSync(file,'utf8');if(p.digest(raw)!==e.financialDigest)throw new Error('FINANCIAL_DIGEST_MISMATCH');
  const data=JSON.parse(raw);if(data.industryExtraction?.version===industry.VERSION && data.industryExtraction.sourceVersion===e.latestAnnual.accessionNumber && (data.industryExtraction.checkedAt || '').slice(0,10)===report.asOf)continue;
  try{const document=await original.fetchOriginal(issuer.cik,e.latestAnnual),next=industry.enrich(data,document,e,{asOf:report.asOf});p.atomicWrite(file,next);e.financialDigest=p.digest(fs.readFileSync(file,'utf8'));e.industryExtraction=next.industryExtraction;success++;}
  catch(err){e.industryExtraction={version:industry.VERSION,status:'retrieval_failed',sourceVersion:e.latestAnnual.accessionNumber,checkedAt:new Date().toISOString(),reason:String(err.code || err.message).slice(0,120)};failed++;}
  done++;if(done%20===0){save();console.log(JSON.stringify({originalIssuers:done,success,failed,remaining:todo.length}));}
 }}));save();process.removeListener('SIGINT',shutdown);process.removeListener('SIGTERM',shutdown);unlock();process.removeListener('exit',unlock);console.log(JSON.stringify({originalIssuers:done,success,failed}));
}
if(require.main===module)main().catch(e=>{console.error(e.code || e.message);process.exitCode=1;});module.exports={main};
