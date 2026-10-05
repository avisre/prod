'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const p=require('../sec-coverage'),{extract}=require('../sec-facts'),{createResolver}=require('../company-evidence'),obs=require('../company-observations');
const {fixture}=require('./fixtures/sec-fixture');
const company={symbol:'EX',name:'Example',securityType:'stock',cik:'0000000123'};
function setup(overrides={}) {
 const {doc,evidence}=fixture();evidence.lastSuccessfulCheckAt='2020-01-01';
 let value=null,calls=0;
 const deps={lookup:()=>company,baseline:()=>({financial:extract(doc,evidence),reporting:evidence,supplemental:[]}),cache:{get:async()=>value,set:async(k,v)=>{value=v;return {persisted:true};}},client:{fetchReporting:async()=>{calls++;return {...evidence,lastSuccessfulCheckAt:new Date().toISOString()};},fetchFacts:async()=>doc},yahoo:async()=>({statements:{},errors:['Unavailable financial history']}),...overrides};
 return {resolver:createResolver(deps),deps,calls:()=>calls,value:()=>value,doc,evidence};
}
test('shared requests reuse validated evidence and expose exact remaining gaps without model calls',async()=>{
 const x=setup();const [a,b]=await Promise.all([x.resolver.getCompanyEvidence('EX',['totalRevenue'],{annual:1,quarterly:0}),x.resolver.getCompanyEvidence('EX',['totalRevenue'],{annual:1,quarterly:0})]);
 assert.equal(x.calls(),1);assert.equal(a.observations.find(f=>f.field==='totalRevenue').value,0);assert.equal(a.evidenceFingerprint,b.evidenceFingerprint);assert.deepEqual(a.remainingGaps,[]);
 await x.resolver.getCompanyEvidence('EX',['totalRevenue'],{annual:1,quarterly:0});assert.equal(x.calls(),1);assert.equal(x.value().persistence.persisted,true);
});
test('timeout serves last-good data while one shared background task persists its result',async()=>{
 let finish;const x=setup({timeoutMs:5,client:{fetchReporting:()=>new Promise(resolve=>{finish=resolve;}),fetchFacts:async()=>fixture().doc}});
 const a=await x.resolver.getCompanyEvidence('EX',['totalRevenue'],{annual:1,quarterly:0});assert.equal(a.freshness.backgroundStatus,'running');assert.equal(a.observations.find(f=>f.field==='totalRevenue').value,0);
 finish({...fixture().evidence,lastSuccessfulCheckAt:new Date().toISOString()});await Promise.all(x.resolver.pending.values());assert.equal(x.value().lastAttemptResult,'success');
});
test('outages retain last-good observations and apply a brief shared failure cooldown',async()=>{
 let tries=0;const x=setup({client:{fetchReporting:async()=>{tries++;throw new Error('OUTAGE');}}});const a=await x.resolver.getCompanyEvidence('EX',['totalRevenue'],{annual:1,quarterly:0});assert.equal(a.observations.find(f=>f.field==='totalRevenue').value,0);assert.equal(a.freshness.lastAttemptResult,'retrieval_failed');await x.resolver.getCompanyEvidence('EX',['totalRevenue'],{annual:1,quarterly:0});assert.equal(tries,1);
});
test('missing stored history can return separately attributed Yahoo observations in native currency',async()=>{
 const x=setup({baseline:()=>({financial:null,reporting:fixture().evidence}),client:{fetchReporting:async()=>{throw new Error('SEC unavailable');}},yahoo:async()=>({fetchedAt:new Date().toISOString(),statements:{income:{annualReports:[{fiscalDateEnding:'2025-12-31',reportedCurrency:'TWD',totalRevenue:123}],quarterlyReports:[]}}})});
 const a=await x.resolver.getCompanyEvidence('EX',['totalRevenue'],{annual:1,quarterly:0});assert.equal(a.observations.length,0);assert.equal(a.supplementalObservations[0].value,123);assert.equal(a.supplementalObservations[0].currency,'TWD');assert.equal(a.supplementalObservations[0].accountingBasis,'provider-reported');assert.equal(a.data.income.annualReports.length,0);assert.equal(a.remainingGaps.length,0);
});
test('recent annual check does not suppress retrieval for missing interim periods',async()=>{
 const x=setup();x.evidence.lastSuccessfulCheckAt=new Date().toISOString();const a=await x.resolver.getCompanyEvidence('EX',['totalRevenue'],{annual:1,quarterly:4});assert.equal(x.calls(),1);assert.ok(a.remainingGaps.some(g=>g.basis==='quarterly'));assert.ok(a.coverage.sourceAttempts.some(s=>s.source==='Yahoo Finance'));
});
test('a requested missing business profile is fetched even when stored core financial history is complete and fresh',async()=>{
 const {doc,evidence}=fixture();evidence.lastSuccessfulCheckAt=new Date().toISOString();let yahoo=0;
 const x=setup({baseline:()=>({financial:extract(doc,evidence),reporting:evidence,supplemental:[]}),yahoo:async()=>{yahoo++;return {fetchedAt:new Date().toISOString(),overview:{Description:'Issuer business description'},statements:{}};}});
 const result=await x.resolver.getCompanyEvidence('EX',['totalRevenue'],{annual:1,quarterly:0,businessProfile:true});assert.equal(yahoo,1);assert.equal(result.data.businessProfile.overview.Description,'Issuer business description');assert.equal(result.data.businessProfile.sourceName,'Yahoo Finance');assert.deepEqual(result.remainingGaps,[]);
});
test('identity and fund routes do not borrow company financials',async()=>{
 const a=setup({lookup:()=>null});await assert.rejects(a.resolver.getCompanyEvidence('EX'),{code:'UNKNOWN_LISTING'});const b=setup({lookup:()=>({...company,securityType:'closed_end_fund'})});await assert.rejects(b.resolver.getCompanyEvidence('EX'),{code:'UNSUPPORTED_SECURITY_TYPE'});
});
test('public request-cache memory is strictly bounded, including a single oversized entry',async()=>{
 const cache=require('../public-financial-cache').createCache({maxMemory:100,connection:()=>null});await cache.set('a',{text:'x'.repeat(200)});assert.equal(cache.stats().bytes,0);for(let i=0;i<20;i++)await cache.set(String(i),{value:i});assert.ok(cache.stats().bytes<=100);assert.equal(cache.stats().maxPersistent,64*1024*1024);
});
test('same-period filed observations win, while adjusted figures and different currencies remain separate',()=>{
 const base={issuer:company.cik,field:'netIncome',periodStart:'2025-01-01',periodEnd:'2025-12-31',unit:'USD',currency:'USD',basis:'annual',scope:'parent',accountingBasis:'US GAAP',value:5,sourceType:'sec_filing'};
 assert.deepEqual(obs.reconcile([base],[{...base,value:7,sourceType:'provider'}]),[]);
 assert.equal(obs.reconcile([base],[{...base,value:7,sourceType:'issuer_release',accountingBasis:'adjusted'}]).length,1);assert.equal(obs.reconcile([base],[{...base,value:7,sourceType:'provider',unit:'TWD',currency:'TWD'}]).length,1);
});
test('coverage never counts different currencies or accounting bases as one compatible history',()=>{
 const base={issuer:company.cik,field:'totalRevenue',basis:'annual',state:'available',scope:'entity',unit:'USD',accountingBasis:'US GAAP'};
 const facts=[{...base,periodEnd:'2025-12-31'},{...base,periodEnd:'2024-12-31',unit:'TWD'},{...base,periodEnd:'2023-12-31',accountingBasis:'adjusted'}];
 assert.equal(obs.gaps(facts,['totalRevenue'],{annual:3,quarterly:0})[0].availablePeriods,1);
});
test('complete old history still reports a missing latest filing period',()=>{
 const base={issuer:company.cik,field:'totalRevenue',basis:'annual',state:'available',scope:'entity',unit:'USD',accountingBasis:'US GAAP'};
 const facts=Array.from({length:5},(_,i)=>({...base,periodEnd:(2024-i)+'-12-31'}));
 const reporting={latestAnnual:{reportDate:'2025-12-31',filingUrl:'https://www.sec.gov/filing.htm'}};
 const missing=obs.gaps(facts,['totalRevenue'],{annual:5,quarterly:0},'quarterly',reporting);
 assert.equal(missing.length,1);assert.equal(missing[0].requiredPeriodEnd,'2025-12-31');
 facts.push({...base,periodEnd:'2025-12-31'});assert.deepEqual(obs.gaps(facts,['totalRevenue'],{annual:5,quarterly:0},'quarterly',reporting),[]);
});
test('a missing interim period attempts its original SEC filing before Yahoo',async()=>{
 const {doc,evidence}=fixture(),accession='0000000123-26-000002',attempts=[];
 const reporting={...evidence,latestPeriodic:{form:'10-Q',accessionNumber:accession,reportDate:'2026-03-31',filingDate:'2026-05-01',primaryDocument:'quarter.htm'},lastSuccessfulCheckAt:new Date().toISOString()};
 const quarter={val:50,start:'2026-01-01',end:'2026-03-31',accn:accession,form:'10-Q',filed:'2026-05-01'};
 const x=setup({client:{fetchReporting:async()=>reporting,fetchFacts:async()=>doc,fetchOriginal:async(cik,filing)=>{attempts.push(filing.form);return {cik:123,facts:{'us-gaap':{Revenues:{units:{USD:[quarter]}}}},segments:[],originalDocument:{form:'10-Q',accessionNumber:accession,url:'https://www.sec.gov/Archives/edgar/data/123/'+accession.replace(/-/g,'')+'/quarter.htm'}};}},yahoo:async()=>{attempts.push('Yahoo');return {overview:{},statements:{},fetchedAt:new Date().toISOString()};}});
 const result=await x.resolver.getCompanyEvidence('EX',['totalRevenue'],{annual:1,quarterly:1});assert.equal(attempts[0],'10-Q');assert.equal(result.observations.find(f=>f.periodEnd==='2026-03-31').value,50);assert.deepEqual(result.remainingGaps,[]);assert.ok(result.coverage.sourceAttempts.some(a=>a.source==='SEC original interim filing'));
});
test('simultaneous statement requests batch their different missing fields once per issuer',async()=>{
 const {evidence}=fixture();let yahooCalls=0,sections=[];
 const x=setup({baseline:()=>({financial:null,reporting:evidence,supplemental:[]}),client:{fetchReporting:async()=>{await new Promise(r=>setTimeout(r,5));return {...evidence,lastSuccessfulCheckAt:new Date().toISOString()};},fetchFacts:async()=>({cik:123,facts:{}})},yahoo:async(symbol,requested)=>{yahooCalls++;sections=requested;return {fetchedAt:'2026-10-04T00:00:00Z',overview:{},statements:{income:{annualReports:[{fiscalDateEnding:'2025-12-31',reportedCurrency:'USD',totalRevenue:0}]},balance:{annualReports:[{fiscalDateEnding:'2025-12-31',reportedCurrency:'USD',totalAssets:100}]}}};}});
 const [income,balance]=await Promise.all([x.resolver.getCompanyEvidence('EX',['totalRevenue'],{annual:1,quarterly:0}),x.resolver.getCompanyEvidence('EX',['totalAssets'],{annual:1,quarterly:0})]);
 assert.equal(yahooCalls,1);assert.deepEqual(new Set(sections),new Set(['income','balance']));assert.equal(income.supplementalObservations.find(f=>f.field==='totalRevenue').value,0);assert.equal(balance.supplementalObservations.find(f=>f.field==='totalAssets').value,100);assert.equal(balance.supplementalObservations[0].publicationDate,null);
});

test('an authoritative stock listing without a CIK uses attributed provider evidence and a distinct cache identity',async()=>{
 let secCalls=0;const keys=[];let cached;
 const x=setup({lookup:()=>({...company,symbol:'NEW',cik:null}),baseline:()=>({financial:null,reporting:{},supplemental:[]}),cache:{get:async key=>{keys.push(key);return cached;},set:async(key,value)=>{keys.push(key);cached=value;return {persisted:true};}},client:{fetchReporting:async()=>{secCalls++;throw new Error('A null CIK must never reach SEC');}},yahoo:async()=>({fetchedAt:new Date().toISOString(),overview:{},statements:{income:{annualReports:[{fiscalDateEnding:'2025-12-31',reportedCurrency:'USD',totalRevenue:0}]}}})});
 const first=await x.resolver.getCompanyEvidence('NEW',['totalRevenue'],{annual:1,quarterly:0});assert.equal(secCalls,0);assert.equal(first.cik,null);assert.equal(first.supplementalObservations[0].issuer,'listing:NEW');assert.equal(first.supplementalObservations[0].value,0);assert.deepEqual(first.remainingGaps,[]);assert.ok(keys.every(key=>key==='listing:NEW'));assert.ok(first.coverage.sourceAttempts.some(a=>a.reason==='SEC_IDENTITY_UNRESOLVED'));
 await x.resolver.getCompanyEvidence('NEW',['totalRevenue'],{annual:1,quarterly:0});assert.equal(keys.filter(key=>key==='listing:NEW').length,3);
});
test('core and industry extraction reuse one fetched annual document within the four-page budget',async()=>{
 const {doc,evidence}=fixture();let originalCalls=0;
 const original={...doc,segments:[],originalDocument:{form:'10-K',accessionNumber:evidence.latestAnnual.accessionNumber,url:'https://www.sec.gov/Archives/edgar/data/123/'+evidence.latestAnnual.accessionNumber.replace(/-/g,'')+'/annual.htm'}};
 const x=setup({baseline:()=>({financial:null,reporting:evidence,supplemental:[]}),client:{fetchReporting:async()=>({...evidence,lastSuccessfulCheckAt:new Date().toISOString()}),fetchFacts:async()=>({cik:123,facts:{}}),fetchOriginal:async()=>{originalCalls++;return original;}}});
 const result=await x.resolver.getCompanyEvidence('EX',['totalRevenue'],{annual:1,quarterly:0});assert.equal(originalCalls,1);assert.equal(result.observations.find(f=>f.field==='totalRevenue').value,0);assert.deepEqual(result.remainingGaps,[]);
});
test('a successful filing-index check does not label a failed financial refresh as fully successful',async()=>{
 const {evidence}=fixture(),reporting={...evidence,lastSuccessfulCheckAt:new Date().toISOString(),latestPeriodic:{form:'10-Q',accessionNumber:'0000000123-26-000099',reportDate:'2026-03-31',filingDate:'2026-05-01'}};
 const x=setup({client:{fetchReporting:async()=>reporting,fetchFacts:async()=>{throw new Error('FACTS_OUTAGE');}}});
 const result=await x.resolver.getCompanyEvidence('EX',['totalRevenue'],{annual:1,quarterly:1});assert.equal(result.freshness.lastAttemptResult,'partial_failure');assert.equal(result.freshness.financialAttemptResult,'retrieval_failed');assert.equal(result.observations.find(f=>f.field==='totalRevenue').value,0);assert.ok(result.coverage.sourceAttempts.some(a=>a.reason==='FACTS_OUTAGE'));assert.ok(result.remainingGaps.some(g=>g.basis==='quarterly'));
});
