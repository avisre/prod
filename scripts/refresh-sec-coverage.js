#!/usr/bin/env node
'use strict';
const fs=require('node:fs');
const path=require('node:path');
const p=require('../backend/sec-coverage');
const client=require('../backend/sec-reporting');
const {extract}=require('../backend/sec-facts');
const DATA=p.DATA_DIR,REPORT=path.join(DATA,'sec-reporting.json');
function read(file,fallback){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch(e){if(e.code==='ENOENT')return fallback;throw e;}}
function args(argv){const o={};for(let i=0;i<argv.length;i++){const name=argv[i];if(['--symbols','--as-of','--max-issuers','--concurrency'].includes(name)){if(!argv[i+1] || argv[i+1].startsWith('--'))throw new Error('Missing value for '+name);o[name]=argv[++i];}else if(['--bootstrap','--daily','--audit','--dry-run'].includes(name))o[name]=true;else throw new Error('Unknown option '+name);}return o;}
function universe(){return read(path.join(DATA,'us-companies.json'),{companies:[]}).companies;}
function issuersFor(list){const issuers=new Map();for(const c of list){const id=p.cik(c.cik);if(!id)continue;const item=issuers.get(id)||{cik:id,symbols:[],securities:[]};item.symbols.push(c.symbol);item.securities.push(c);issuers.set(id,item);}return [...issuers.values()];}
function audit(list,report,asOf){
 let successful=0,recent=0,factsCompleted=0,failed=0;const statuses={ready:0,partial:0,historical_only:0,unavailable:0};
 const issuerList=issuersFor(list);
 for(const issuer of issuerList){const e=report.issuers[issuer.cik];if(p.day(e?.lastSuccessfulCheckAt) && Date.parse(asOf)-Date.parse(p.day(e.lastSuccessfulCheckAt))<=35*86400000)successful++;if(e?.lastAttemptResult==='transient_failure')failed++;const data=read(path.join(DATA,'sec-financials',issuer.cik+'.json'),null);const c=p.classify(e,data,asOf);statuses[c.financialCoverage]++;if(c.annualReportingStatus==='recent_annual'){recent++;if(e.lastFinancialCheckAt && ['success','no_facts'].includes(e.lastFinancialResult))factsCompleted++;}}
 return {asOf,listedSecurities:list.length,identifiedIssuers:issuerList.length,missingCIK:list.filter(c=>!p.cik(c.cik)).map(c=>c.symbol),successfulSubmissions:successful,recentAnnualIssuers:recent,completedFacts: factsCompleted,networkFailures:failed,submissionsPercent:issuerList.length?100*successful/issuerList.length:0,factsPercent:recent?100*factsCompleted/recent:0,statuses};
}
async function refreshIssuer(issuer,old={}, {asOf,force=false,clientImpl=client}={}) {
 const attempted=new Date().toISOString();
 let evidence;
 try {evidence=await clientImpl.fetchReporting(issuer,{asOf});}
 catch(error){return {...old,cik:issuer.cik,symbols:issuer.symbols,lastAttemptAt:attempted,lastAttemptResult:/IDENTITY/.test(error.message)?'invalid_identity':'transient_failure',lastErrorCode:String(error.response?.status || error.code || error.message).slice(0,100)};}
 const merged={...old,...evidence};
 const file=path.join(DATA,'sec-financials',issuer.cik+'.json');
 const changed=old.latestAnnual?.accessionNumber!==evidence.latestAnnual?.accessionNumber || old.latestPeriodic?.accessionNumber!==evidence.latestPeriodic?.accessionNumber || p.digest(old.latestAnnual?.amendments || [])!==p.digest(evidence.latestAnnual?.amendments || []);
 if(!force && !changed && old.financialDigest && old.lastFinancialResult==='success' && fs.existsSync(file))return merged;
 try {
  const raw=await clientImpl.fetchFacts(issuer.cik);
  const data=extract(raw,merged,{asOf});
  const errors=p.validateFinancial(data,issuer.cik,asOf);if(errors.length)throw new Error('INVALID_EXTRACTION: '+errors[0]);
  const validation=p.classify(merged,data,asOf);
  const previous=read(file,null);
  if(previous && p.classify(old,previous,asOf).financialCoverage==='ready' && validation.financialCoverage==='unavailable' && old.latestAnnual?.reportDate===merged.latestAnnual?.reportDate)throw new Error('EXTRACTION_DISCARDED_VALID_PERIOD');
  // Preserve content timestamps if the underlying facts are unchanged.
  const comparable=x=>({...x,fetchedAt:null});
  if(previous && p.digest(comparable(previous))===p.digest(comparable(data)))data.fetchedAt=previous.fetchedAt;
  p.atomicWrite(file,data);
  merged.financialDigest=p.digest(fs.readFileSync(file,'utf8'));merged.lastFinancialCheckAt=attempted;merged.lastFinancialResult='success';merged.lastErrorCode=null;
 }catch(error){
  const identity=/IDENTITY/.test(error.message);
  if(identity)merged.lastAttemptResult='invalid_identity';
  merged.lastFinancialResult=identity?'invalid_identity':error.response?.status===404?'no_facts':'transient_failure';
  if(error.response?.status===404)merged.lastFinancialCheckAt=attempted;
  merged.lastErrorCode=String(error.response?.status || error.code || error.message).slice(0,100);
 }
 return merged;
}
async function main(argv=process.argv.slice(2)) {
 const o=args(argv),asOf=o['--as-of'] || p.day(new Date().toISOString());if(!p.day(asOf))throw new Error('Invalid as-of date');
 let list=universe();const report=read(REPORT,{schemaVersion:1,issuers:{}});
 if(o['--audit']){console.log(JSON.stringify(audit(list,report,asOf),null,2));return;}
 if(!o['--bootstrap'] && !o['--daily'] && !o['--symbols'] && !o['--dry-run'])throw new Error('Choose --bootstrap, --daily, --symbols, --audit, or --dry-run');
 if(o['--symbols']){const selected=new Set(o['--symbols'].split(',').map(s=>s.trim().toUpperCase().replace(/[.-]/g,'')));list=list.filter(c=>selected.has(c.symbol.replace(/[.-]/g,'')));if(!list.length)throw new Error('No matching symbols');}
 let todo=issuersFor(list);
 const max=Number(o['--max-issuers'] || 0),concurrency=Number(o['--concurrency'] || 2);
 if(!Number.isInteger(max)||max<0||!Number.isInteger(concurrency)||concurrency<1||concurrency>2)throw new Error('Invalid max-issuers or concurrency (1-2)');
 if(max)todo=todo.slice(0,max);
 if(o['--dry-run']){console.log(JSON.stringify({asOf,issuers:todo.length,mode:o['--bootstrap']?'bootstrap':'daily',symbols:todo.slice(0,5).map(x=>x.symbols)}));return;}
 const lock=path.join(DATA,'.sec-refresh.lock');
 let lockFd;
 try{lockFd=fs.openSync(lock,'wx');fs.writeSync(lockFd,String(process.pid));}catch(e){let pid;try{pid=Number(fs.readFileSync(lock,'utf8'));process.kill(pid,0);}catch(err){if(pid && err.code==='ESRCH'){fs.unlinkSync(lock);lockFd=fs.openSync(lock,'wx');fs.writeSync(lockFd,String(process.pid));}}if(lockFd===undefined)throw new Error('A SEC refresh is already running');}
 const unlock=()=>{if(lockFd!==undefined){fs.closeSync(lockFd);lockFd=undefined;fs.unlinkSync(lock);}};
 process.once('exit',unlock);
 report.schemaVersion=1;
 let done=0;
 const save=()=>{report.generatedAt=new Date().toISOString();report.asOf=asOf;p.atomicWrite(REPORT,report);};
 const shutdown=()=>{save();process.exit(130);};process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
 const bucket=id=>[...id].reduce((h,c)=>((h*31+c.charCodeAt(0))>>>0),0)%28;
 const shard=(new Date(asOf+'T00:00:00Z').getUTCDate()-1)%28;
 await Promise.all(Array.from({length:concurrency},async()=>{
  while(todo.length){const issuer=todo.shift(),old=report.issuers[issuer.cik];
   const completed=old?.lastAttemptResult==='success' && old?.lastSuccessfulCheckAt?.slice(0,10)===asOf && ['success','no_facts'].includes(old.lastFinancialResult) && (old.lastFinancialResult==='no_facts' || fs.existsSync(path.join(DATA,'sec-financials',issuer.cik+'.json')));
   if(!(o['--bootstrap'] && completed))report.issuers[issuer.cik]=await refreshIssuer(issuer,old,{asOf,force:!!o['--symbols'] || (!o['--bootstrap'] && bucket(issuer.cik)===shard)});
   done++;if(done%20===0){save();console.log(JSON.stringify({done,total:done+todo.length,last:issuer.symbols[0],result:report.issuers[issuer.cik]?.lastFinancialResult,error:report.issuers[issuer.cik]?.lastErrorCode}));}
  }
 }));save();process.removeListener('SIGINT',shutdown);process.removeListener('SIGTERM',shutdown);
 unlock();process.removeListener('exit',unlock);
 const summary=audit(universe(),report,asOf);console.log(JSON.stringify(summary,null,2));if(summary.networkFailures && summary.successfulSubmissions===0)process.exitCode=1;
}
if(require.main===module)main().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={main,args,audit,issuersFor,refreshIssuer};
