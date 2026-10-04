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
