'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const reporting=require('../sec-reporting'),p=require('../sec-coverage');
test('submissions columns reject unequal lengths',()=>assert.throws(()=>reporting.parseFilings({accessionNumber:['x'],form:[],filingDate:[],reportDate:[],primaryDocument:[]},'0000000123'),/MALFORMED/));
test('transient retries honor Retry-After and stop after three attempts',async()=>{
 let calls=0;const waits=[];const result=await reporting.getJson('local',{get:async()=>{calls++;if(calls<3)throw Object.assign(new Error('busy'),{response:{status:503,headers:{'retry-after':'5'}}});return {data:{cik:123}};},wait:async t=>waits.push(t)});
 assert.equal(result.cik,123);assert.equal(calls,3);assert.deepEqual(waits,[5000,5000]);
});
test('permanently missing, invalid JSON and syntax errors do not retry',async()=>{
 for(const err of [Object.assign(new Error('missing'),{response:{status:404}}),new SyntaxError('Invalid JSON')]){let calls=0;await assert.rejects(reporting.getJson('local',{get:async()=>{calls++;throw err;},wait:async()=>{}}));assert.equal(calls,1);}
});
test('identity mismatches cannot authorize a different issuer',async()=>{
 await assert.rejects(reporting.fetchReporting({cik:'0000000123'},{asOf:'2026-10-03',request:async()=>({cik:456})}),/IDENTITY/);
});
test('SEC timeout preserves successful reporting and financial evidence',async()=>{
 const old={cik:'0000000123',lastSuccessfulCheckAt:'2026-10-03',latestAnnual:{form:'10-K',filingDate:'2026-02-01',reportDate:'2025-12-31'},financialDigest:'unchanged'};
 const result=await require('../../scripts/refresh-sec-coverage').refreshIssuer({cik:old.cik,symbols:['EX']},old,{asOf:'2026-10-03',clientImpl:{fetchReporting:async()=>{throw Object.assign(new Error('timeout'),{code:'ETIMEDOUT'});}}});
 assert.deepEqual(result.latestAnnual,old.latestAnnual);assert.equal(result.financialDigest,'unchanged');assert.equal(result.lastAttemptResult,'transient_failure');assert.equal(p.reportingStatus(result,'2026-10-03'),'recent_annual');
});
test('amendment without original and only current reports remain ineligible',async()=>{
 const raw={cik:123,name:'Example',filings:{recent:{accessionNumber:['0000000123-26-000001'],form:['10-K/A'],filingDate:['2026-05-01'],reportDate:['2025-12-31'],primaryDocument:['ex.htm']},files:[]}};
 const e=await reporting.fetchReporting({cik:'0000000123'},{asOf:'2026-10-03',request:async()=>raw});assert.equal(e.latestAnnual,null);assert.equal(p.reportingStatus(e,'2026-10-03'),'unverified');
});
test('resumed reconciliation never treats an interrupted or modified financial file as a completed checkpoint',()=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{matchingFinancialFile}=require('../../scripts/refresh-sec-coverage');
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'sec-checkpoint-')),file=path.join(dir,'facts.json');
 try{fs.writeFileSync(file,'{"value":1}');const e={financialDigest:p.digest(fs.readFileSync(file,'utf8'))};assert.equal(matchingFinancialFile(e,file),true);fs.writeFileSync(file,'{"value":2}');assert.equal(matchingFinancialFile(e,file),false);fs.unlinkSync(file);assert.equal(matchingFinancialFile(e,file),false);}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('the previous quarterly report is the earlier 10-Q of the same fiscal year, or none',async()=>{
 const rows=[['0000000123-25-000009','10-Q','2025-11-01','2025-09-30'],['0000000123-26-000001','10-K','2026-02-01','2025-12-31'],['0000000123-26-000002','10-Q','2026-05-01','2026-03-31'],['0000000123-26-000003','10-Q','2026-08-01','2026-06-30']];
 const raw=n=>({cik:123,name:'Example',filings:{recent:{accessionNumber:rows.slice(0,n).map(r=>r[0]),form:rows.slice(0,n).map(r=>r[1]),filingDate:rows.slice(0,n).map(r=>r[2]),reportDate:rows.slice(0,n).map(r=>r[3]),primaryDocument:rows.slice(0,n).map(()=>'x.htm')},files:[]}});
 const second=await reporting.fetchReporting({cik:'0000000123'},{asOf:'2026-10-03',request:async()=>raw(4)});
 assert.equal(second.latestPeriodic.reportDate,'2026-06-30');assert.equal(second.previousPeriodic.reportDate,'2026-03-31');
 // the first quarter's predecessor would be last fiscal year's, which the annual report closes
 const first=await reporting.fetchReporting({cik:'0000000123'},{asOf:'2026-10-03',request:async()=>raw(3)});
 assert.equal(first.latestPeriodic.reportDate,'2026-03-31');assert.equal(first.previousPeriodic,null);
});
