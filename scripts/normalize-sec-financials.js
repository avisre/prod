#!/usr/bin/env node
'use strict';
// Explicit migration for datasets extracted before a stricter provenance policy.
// Removes incompatible observations; never adds or estimates financial values.
const fs=require('node:fs'),path=require('node:path'),p=require('../backend/sec-coverage');
function normalize(){
 const file=path.join(p.DATA_DIR,'sec-reporting.json'),report=JSON.parse(fs.readFileSync(file,'utf8'));let changed=0,removed=0;
 for(const [id,e]of Object.entries(report.issuers)){
  if(!e.financialDigest)continue;const name=path.join(p.DATA_DIR,'sec-financials',id+'.json'),raw=fs.readFileSync(name,'utf8'),d=JSON.parse(raw);let modified=false;
  for(const st of ['income','balance','cash'])for(const basis of ['annualReports','quarterlyReports']){
   for(const row of d[st][basis])for(const field of Object.keys(row._sources || {}))if(!p.verifiedField(d,row,field)){row[field]=null;delete row._sources[field];delete row._derivations[field];delete row._scopes?.[field];delete row._signs?.[field];d.issues.push({code:'INVALID_PROVENANCE_OR_PERIOD',field,periodEnd:row.fiscalDateEnding});modified=true;removed++;}
   d[st][basis]=d[st][basis].filter(r=>Object.keys(r._sources || {}).length);
  }
  if(modified){const errors=p.validateFinancial(d,id,report.asOf);if(errors.length)throw new Error(id+': '+errors[0]);p.atomicWrite(name,d);e.financialDigest=p.digest(fs.readFileSync(name,'utf8'));changed++;}
 }
 if(changed){report.generatedAt=new Date().toISOString();p.atomicWrite(file,report);}console.log(JSON.stringify({changed,removed}));
}
if(require.main===module)normalize();module.exports={normalize};
