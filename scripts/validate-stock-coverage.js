#!/usr/bin/env node
'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const p=require('../backend/sec-coverage');
const {content}=require('../backend/public-stock-content'),adapter=require('../backend/verified-fundamentals'),rawFunds=require('../backend/fundamentals-cache');
function validate({asOf,bootstrap=false}={}){
 const errors=[],fail=message=>errors.push(message),read=name=>JSON.parse(fs.readFileSync(path.join(p.DATA_DIR,name),'utf8'));
 const dir=read('us-companies.json'),report=read('sec-reporting.json'),pub=read('public-stock-index.json'),screen=read('screen-index.json');
 const rates=read('sec-fx.json').rates || {},marketDigests=[],priceDigests=[],expectedRows=[];
 asOf=asOf || pub.asOf;
 const canonical=new Set(),normalized=new Set();
 for(const c of dir.companies){const k=c.symbol?.replace(/\./g,'-');if(!c.symbol || canonical.has(c.symbol) || normalized.has(k))fail('Symbol collision '+c.symbol);canonical.add(c.symbol);normalized.add(k);if(!['stock','unit','right','closed_end_fund','unresolved'].includes(c.securityType))fail('Invalid type '+c.symbol);if(c.cik && c.cik!==p.cik(c.cik))fail('Noncanonical CIK '+c.symbol);}
 if(report.schemaVersion!==1 || pub.schemaVersion!==1 || pub.policyVersion!==1 || screen.v!==4 || screen.policyVersion!==1)fail('Incompatible schema');
 if(screen.datasetId!==pub.datasetId || screen.asOf!==pub.asOf)fail('Snapshot generation mismatch');
 try{const coverage=read('financial-coverage.json');if(coverage.datasetId!==pub.datasetId || coverage.asOf!==pub.asOf)fail('Coverage generation mismatch');const covered=new Set(coverage.records.flatMap(r=>r.symbols));for(const c of dir.companies.filter(c=>c.securityType==='stock'))if(!covered.has(c.symbol))fail('Missing financial coverage record '+c.symbol);}catch(e){fail('Financial coverage audit unavailable');}
 if(pub.sourceFingerprints?.directoryDigest!==p.digest(fs.readFileSync(path.join(p.DATA_DIR,'us-companies.json'),'utf8')) || pub.sourceFingerprints?.reportingDigest!==p.digest(report))fail('Source fingerprint mismatch');
 for(const name of ['public-stock-index.json','screen-index.json'])if(fs.statSync(path.join(p.DATA_DIR,name)).size>=8*1024*1024)fail(name+' exceeds 8 MiB');
 const securities=new Map(pub.securities.map(s=>[s.symbol,s]));if(securities.size!==canonical.size || pub.securities.length!==canonical.size)fail('Incomplete directory outcomes');
 let checked=0,recent=0,completed=0,networkFailures=0,financialFailures=0,invalidIdentity=0,files=0,values=0;
 const eligibleIds=new Set(dir.companies.filter(c=>c.securityType==='stock' && c.cik).map(c=>c.cik));
 for(const [id,item]of Object.entries(pub.issuers)){
  const e=report.issuers[id],file=path.join(p.DATA_DIR,'sec-financials',id+'.json');let data=null;
  if(e?.financialDigest){try{const raw=fs.readFileSync(file,'utf8');if(p.digest(raw)!==e.financialDigest || item.financialDigest!==e.financialDigest)fail('Financial digest mismatch '+id);data=JSON.parse(raw);files++;for(const error of p.validateFinancial(data,id,asOf))fail(id+': '+error);for(const st of ['income','balance','cash'])for(const basis of ['annualReports','quarterlyReports'])for(const row of data[st]?.[basis] || [])values+=Object.keys(row._sources || {}).length;}catch(err){fail('Financial file '+id+': '+err.message);}}
  const status=p.classify(e,data,asOf);
  for(const company of dir.companies.filter(c=>c.cik===id)){
   const view=adapter.adapt(company,rawFunds.loadRawFundamentals(company.symbol),data,status,item);
   const state=content(company,view,status,e?.financialDigest || null,{asOf,rates});
   marketDigests.push([company.symbol,state.marketDigest]);priceDigests.push([company.symbol,state.priceDigest]);if(state.screenRow)expectedRows.push(state.screenRow);
   const s=securities.get(company.symbol);if(s?.contentDigest!==state.entry.contentDigest || s?.priceHistory!==state.entry.priceHistory || p.digest(s?.metricSlugs)!==p.digest(state.entry.metricSlugs))fail('Content fingerprint or capability mismatch '+company.symbol);
  }
  if(status.annualReportingStatus!==item.annualReportingStatus || status.financialCoverage!==item.financialCoverage)fail('Incorrect classification '+id);
  if(e?.financialFile && e.financialFile!==`sec-financials/${id}.json`)fail('Invalid financial path '+id);
  if(eligibleIds.has(id)){
   if(p.day(e?.lastSuccessfulCheckAt) && Date.parse(asOf)-Date.parse(p.day(e.lastSuccessfulCheckAt))<=35*86400000)checked++;
   if(status.annualReportingStatus==='recent_annual'){recent++;if(e?.lastFinancialCheckAt && ['success','no_facts'].includes(e.lastFinancialResult))completed++;}
   if(e?.lastAttemptResult==='transient_failure')networkFailures++;
   if(e?.lastFinancialResult==='transient_failure')financialFailures++;
   if(e?.lastAttemptResult==='invalid_identity')invalidIdentity++;
  }
 }
 for(const [field,value]of Object.entries({supplementalDigest:require('../backend/committed-supplements').fingerprint(),quotesDigest:p.digest(marketDigests),priceHistoryDigest:p.digest(priceDigests),fxDigest:p.digest(rates),screenRowsDigest:p.digest(expectedRows)}))if(pub.sourceFingerprints?.[field]!==value)fail('Source fingerprint mismatch '+field);
 if(screen.rowsDigest!==p.digest(screen.rows) || screen.rowsDigest!==pub.sourceFingerprints?.screenRowsDigest)fail('Screen contents do not match generation fingerprint');
 if(pub.datasetId!==p.digest({asOf:pub.asOf,sourceFingerprints:pub.sourceFingerprints,policyVersion:pub.policyVersion,securities:pub.securities.map(s=>s.contentDigest)}))fail('Dataset identity mismatch');
 for(const c of dir.companies){const s=securities.get(c.symbol);if(!s){fail('Missing security '+c.symbol);continue;}const expected=c.securityType==='stock' && pub.issuers[c.cik]?.financialCoverage==='ready';if(s.indexable!==!!expected || s.screenable!==!!expected)fail('Incorrect eligibility '+c.symbol);if(s.cik!==(c.cik || null) || s.securityType!==c.securityType)fail('Identity mismatch '+c.symbol);if(!Array.isArray(s.metricSlugs) || (!expected && s.metricSlugs.length))fail('Invalid metric capability '+c.symbol);if(!p.day(s.lastmod) || s.lastmod>asOf)fail('Invalid content date '+c.symbol);}
 const seen=new Set();for(const r of screen.rows){const s=securities.get(r.symbol);if(seen.has(r.symbol) || !s?.screenable || s.financialDigest!==r.financialDigest || r.cik!==s.cik || r.coverageStatus!=='ready')fail('Invalid screen row '+r.symbol);seen.add(r.symbol);for(const [k,v]of Object.entries(r))if(typeof v==='number' && !Number.isFinite(v))fail('Invalid screen number '+r.symbol+'.'+k);}
 if(seen.size!==pub.securities.filter(s=>s.screenable).length || screen.count!==screen.rows.length)fail('Screen count mismatch');
 for(const pair of pub.comparisonPairs){const [a,b]=pair.split('-vs-');if(!securities.get(a)?.screenable || !securities.get(b)?.screenable || a===b)fail('Invalid comparison '+pair);}
 try{assert.deepEqual(pub.counts,p.count(pub.securities,pub.issuers));}catch(_){fail('Counts do not reconcile');}
 const submissionsPercent=100*checked/eligibleIds.size,factsPercent=recent?100*completed/recent:0;
 if(bootstrap && (submissionsPercent<98 || factsPercent<95))fail('Bootstrap thresholds not met');
 return {ok:!errors.length,asOf,policyVersion:pub.policyVersion,datasetId:pub.datasetId,counts:pub.counts,financialFiles:files,verifiedValues:values,unresolvedIdentityMappings:dir.companies.filter(c=>!c.cik).length+invalidIdentity,networkFailures,financialFailures,successfulSubmissions:checked,completedFacts:completed,submissionsPercent,factsPercent,errors};
}
if(require.main===module){try{const report=validate({bootstrap:process.argv.includes('--bootstrap')});console.log(JSON.stringify(report,null,2));if(!report.ok)process.exitCode=1;}catch(e){console.error(JSON.stringify({ok:false,error:e.message}));process.exitCode=1;}}
module.exports={validate};
