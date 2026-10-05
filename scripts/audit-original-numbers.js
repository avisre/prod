#!/usr/bin/env node
'use strict';
// Recapture literal inline receipts for earlier extraction versions. Financial
// amounts stay unchanged only when the original context independently agrees.
const fs=require('node:fs'),path=require('node:path');
const p=require('../backend/sec-coverage'),original=require('../backend/sec-original');
async function main() {
 const file=path.join(p.DATA_DIR,'sec-reporting.json'),report=JSON.parse(fs.readFileSync(file,'utf8'));
 const issuers=Object.keys(report.issuers).filter(id=>report.issuers[id].financialDigest);let done=0,retrieved=0,failed=0;
 const lock=path.join(p.DATA_DIR,'.sec-refresh.lock'),fd=fs.openSync(lock,'wx');fs.writeSync(fd,String(process.pid));
 const save=()=>p.atomicWrite(file,report),unlock=()=>{try{fs.closeSync(fd);fs.unlinkSync(lock);}catch(_){}};
 process.once('exit',unlock);const stop=()=>{save();process.exit(130);};process.once('SIGINT',stop);process.once('SIGTERM',stop);
 await Promise.all(Array.from({length:2},async()=>{while(issuers.length){const id=issuers.shift(),e=report.issuers[id],financialFile=path.join(p.DATA_DIR,'sec-financials',id+'.json');const raw=fs.readFileSync(financialFile,'utf8');if(p.digest(raw)!==e.financialDigest)throw new Error('FINANCIAL_DIGEST_MISMATCH');const data=JSON.parse(raw),used=new Set();
  for(const st of ['income','balance','cash'])for(const basis of ['annualReports','quarterlyReports'])for(const row of data[st][basis])for(const ids of Object.values(row._sources))for(const ref of ids)used.add(ref);
  const dependent=[...used].map(ref=>data.sources[ref]).filter(s=>s?.verificationMethod==='original_inline_xbrl' && !s.originalDocument?.numericReceipt);
  const groups=(data.segmentObservations || []).filter(g=>g.entries.some(entry=>!entry.sourceFact?.numericReceipt));
  const urls=new Set([...dependent.map(s=>s.originalDocument.documentUrl),...groups.map(g=>g.sourceUrl)]);let changed=false;
  for(const url of urls)try {
   const u=new URL(url),acc=dependent.find(s=>s.originalDocument.documentUrl===url)?.accessionNumber || groups.find(g=>g.sourceUrl===url).sourceVersion;
   if(!url.startsWith('https://www.sec.gov/Archives/edgar/data/'+Number(id)+'/'+acc.replace(/-/g,'')+'/'))throw new Error('ORIGINAL_IDENTITY_MISMATCH');
   const filing={accessionNumber:acc,primaryDocument:u.pathname.split('/').pop(),form:dependent.find(s=>s.originalDocument.documentUrl===url)?.form || '10-K',filingDate:dependent.find(s=>s.originalDocument.documentUrl===url)?.filingDate || groups.find(g=>g.sourceUrl===url).publicationDate};
   const doc=await original.fetchOriginal(id,filing);retrieved++;
   for(const s of dependent.filter(s=>s.originalDocument.documentUrl===url)){const match=doc.facts[s.taxonomy]?.[s.concept]?.units?.[s.unit]?.find(f=>f._original.contextRef===s.originalDocument.contextRef && f.val===s.rawValue);if(match){s.originalDocument.numericReceipt=match._original.numericReceipt;changed=true;}}
   for(const g of groups.filter(g=>g.sourceUrl===url))for(const entry of g.entries){const match=doc.segments.find(f=>f._original.contextRef===entry.contextRef && f.val===entry.value && f.concept===entry.sourceFact?.concept);if(match){entry.sourceFact.numericReceipt=match._original.numericReceipt;changed=true;}}
  }catch(_){failed++;}
  if(data.industryExtraction?.version==='20261005-industry1' && !dependent.some(s=>!s.originalDocument.numericReceipt) && !groups.some(g=>g.entries.some(entry=>!entry.sourceFact?.numericReceipt))){data.industryExtraction.version=require('../backend/sec-industry').VERSION;changed=true;}
  if(changed){p.atomicWrite(financialFile,data);e.financialDigest=p.digest(fs.readFileSync(financialFile,'utf8'));e.industryExtraction=data.industryExtraction || e.industryExtraction;}
  done++;if(done%20===0){save();if(urls.size)console.log(JSON.stringify({auditedIssuers:done,originalDocuments:retrieved,failures:failed}));}
 }}));save();unlock();process.removeListener('exit',unlock);process.removeListener('SIGINT',stop);process.removeListener('SIGTERM',stop);console.log(JSON.stringify({auditedIssuers:done,originalDocuments:retrieved,failures:failed}));
}
if(require.main===module)main().catch(e=>{console.error(e.code || e.message);process.exitCode=1;});module.exports={main};
