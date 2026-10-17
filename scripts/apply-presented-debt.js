#!/usr/bin/env node
'use strict';
// Applies sec-facts presentedDebt (total debt from the debt lines a balance sheet presents) to
// the published financial files in place, without a re-extraction: re-extracting drops the
// original-document stage (refresh-sec-industry.js), which takes hours of paced SEC requests
// to read again. A refresh that does re-extract applies the same rule inside extract().
//
//   node scripts/apply-presented-debt.js [--dry-run]
//
// Needs frontend/data/sec-statement-lines built by scripts/build-statement-lines.js. Each changed
// file must pass validateFinancial, or it is left as it was.
const fs=require('node:fs'),path=require('node:path');
const p=require('../backend/sec-coverage'),{presentedDebt}=require('../backend/sec-facts'),lines=require('../backend/statement-lines');

function apply(data,records) {
 const presented=new Map(records.filter(l=>l.k==='debt').map(l=>[l.a,l.c]));
 if(!presented.size)return null;
 const out=structuredClone(data);
 for(const basis of ['annualReports','quarterlyReports'])for(const row of out.balance?.[basis] || [])presentedDebt(out,row,presented);
 return out;
}

function main(argv=process.argv.slice(2)) {
 const dry=argv.includes('--dry-run');
 const reportFile=path.join(p.DATA_DIR,'sec-reporting.json'),report=JSON.parse(fs.readFileSync(reportFile,'utf8'));
 const lock=path.join(p.DATA_DIR,'.sec-refresh.lock');const fd=dry?null:fs.openSync(lock,'wx');if(fd!==null)fs.writeSync(fd,String(process.pid));
 const unlock=()=>{if(fd===null)return;try{fs.closeSync(fd);fs.unlinkSync(lock);}catch(_){}};process.once('exit',unlock);
 const tally={issuers:0,changed:0,rowsChanged:0,invalid:0,digestMismatch:0};
 try {
  for(const [cik,e] of Object.entries(report.issuers || {})) {
   if(!e?.financialDigest)continue;
   const file=path.join(p.DATA_DIR,'sec-financials',cik+'.json');if(!fs.existsSync(file))continue;
   const raw=fs.readFileSync(file,'utf8');if(p.digest(raw)!==e.financialDigest){tally.digestMismatch++;continue;}
   tally.issuers++;
   const data=JSON.parse(raw),next=apply(data,lines.forCik(cik));
   if(!next || JSON.stringify(next)===JSON.stringify(data))continue;
   if(p.validateFinancial(next,next.cik,report.asOf).length>p.validateFinancial(data,data.cik,report.asOf).length){tally.invalid++;continue;}
   for(const basis of ['annualReports','quarterlyReports'])data.balance[basis].forEach((row,i)=>{if(JSON.stringify(row)!==JSON.stringify(next.balance[basis][i]))tally.rowsChanged++;});
   tally.changed++;
   if(!dry){p.atomicWrite(file,next);e.financialDigest=p.digest(fs.readFileSync(file,'utf8'));}
  }
  if(!dry)p.atomicWrite(reportFile,report);
 } finally {unlock();}
 console.log(JSON.stringify(tally));
}
if(require.main===module)main();
module.exports={apply};
