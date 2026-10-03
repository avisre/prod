#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),p=require('../backend/sec-coverage');
async function main(){
 const report=JSON.parse(fs.readFileSync(path.join(p.DATA_DIR,'sec-reporting.json'),'utf8')),currencies=new Set();
 for(const e of Object.values(report.issuers)){if(!e.financialDigest)continue;const d=JSON.parse(fs.readFileSync(path.join(p.DATA_DIR,'sec-financials',e.cik+'.json'),'utf8'));for(const r of d.income.annualReports)if(r.reportedCurrency!=='USD')currencies.add(r.reportedCurrency);}
 const file=path.join(p.DATA_DIR,'sec-fx.json');let doc;try{doc=JSON.parse(fs.readFileSync(file,'utf8'));}catch(_){doc={schemaVersion:1,rates:{}};}
 for(const currency of currencies)try{doc.rates[currency]=await require('../backend/fx-conversion').rateSeries(currency);}catch(e){console.error(currency+': '+e.message);}
 doc.generatedAt=new Date().toISOString();p.atomicWrite(file,doc);console.log(JSON.stringify({currencies:[...currencies],available:Object.keys(doc.rates)}));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
