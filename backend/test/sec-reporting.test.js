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

test('a refresh by one ticker keeps every share class of that issuer', {skip:!require('node:fs').existsSync(require('node:path').join(require('../sec-coverage').DATA_DIR,'us-companies.json'))}, async () => {
 const lines=[],log=console.log;console.log=l=>lines.push(l);
 try {await require('../../scripts/refresh-sec-coverage').main(['--symbols','GOOG','--dry-run']);} finally {console.log=log;}
 assert.deepEqual(JSON.parse(lines[0]).symbols,[['GOOG','GOOGL']]);
});

test('a reorganised issuer keeps its history and gains the successor registration\'s reports and facts',async()=>{
 const {successorOf}=require('../../scripts/lib/us-listings');
 assert.equal(successorOf('0000034088','2026-11-18'),'0002115436');
 assert.equal(successorOf('0000034088','2027-04-01'),null);
 assert.equal(successorOf('0002115436','2026-11-18'),null);
 const subs=(cik,rows)=>({cik:Number(cik),name:'X',filings:{recent:{accessionNumber:rows.map(r=>r[0]),form:rows.map(r=>r[1]),filingDate:rows.map(r=>r[2]),reportDate:rows.map(r=>r[3]),primaryDocument:rows.map(()=>'x.htm')},files:[]}});
 const shared=['0000034088-26-000093','10-Q','2026-08-03','2026-06-30'];
 const pages={
  'https://data.sec.gov/submissions/CIK0000034088.json':subs('34088',[['0000034088-26-000010','10-K','2026-02-18','2025-12-31'],shared]),
  'https://data.sec.gov/submissions/CIK0002115436.json':subs('2115436',[['0002115436-26-000020','10-Q','2026-11-02','2026-09-30'],shared]),
 };
 const e=await reporting.fetchReporting({cik:'0000034088'},{asOf:'2026-11-18',request:async u=>pages[u]});
 assert.equal(e.cik,'0000034088');
 assert.equal(e.latestAnnual.accessionNumber,'0000034088-26-000010');
 assert.equal(e.latestPeriodic.accessionNumber,'0002115436-26-000020');
 // EDGAR serves the successor's filing under the predecessor's number, so the link stays under the issuer's own CIK
 assert.equal(e.latestPeriodic.filingUrl,'https://www.sec.gov/Archives/edgar/data/34088/000211543626000020/0002115436-26-000020-index.htm');
 assert.equal(e.previousPeriodic.accessionNumber,'0000034088-26-000093');
 const fact=(accn,start,end,val)=>({accn,start,end,val,form:'10-Q',filed:'2026-11-02'});
 const facts={
  'https://data.sec.gov/api/xbrl/companyfacts/CIK0000034088.json':{cik:34088,entityName:'EXXON MOBIL CORP',facts:{'us-gaap':{Revenues:{units:{USD:[fact('0000034088-26-000093','2026-04-01','2026-06-30',116017e6)]}}}}},
  'https://data.sec.gov/api/xbrl/companyfacts/CIK0002115436.json':{cik:2115436,entityName:'ExxonMobil Holdings Corp',facts:{'us-gaap':{Revenues:{units:{USD:[fact('0000034088-26-000093','2026-04-01','2026-06-30',116017e6),fact('0002115436-26-000020','2026-07-01','2026-09-30',113164e6)]}},Assets:{units:{USD:[fact('0002115436-26-000020',undefined,'2026-09-30',470917e6)]}}}}},
 };
 const raw=await reporting.fetchFacts('0000034088',{asOf:'2026-11-18',request:async u=>facts[u]});
 assert.equal(raw.cik,34088);
 assert.deepEqual(raw.facts['us-gaap'].Revenues.units.USD.map(f=>f.val),[116017e6,113164e6]);
 assert.equal(raw.facts['us-gaap'].Assets.units.USD.length,1);
 // any other issuer reads its own feed alone
 let calls=0;await reporting.fetchFacts('0000000123',{request:async()=>{calls++;return {cik:123,facts:{}};}});assert.equal(calls,1);
});
test('the reorganisation reads the other way once the listing moves: the successor keeps the predecessor\'s history',async()=>{
 const {successorOf,predecessorOf}=require('../../scripts/lib/us-listings');
 assert.equal(predecessorOf('0002115436','2026-11-18'),null);
 assert.equal(predecessorOf('0002115436','2027-04-01'),'0000034088');
 assert.equal(successorOf('0000034088','2027-04-01'),null);
 assert.deepEqual(reporting.continuing('0000034088','2026-11-18'),{cik:'0002115436',linkCik:'0000034088'});
 assert.deepEqual(reporting.continuing('0002115436','2027-04-01'),{cik:'0000034088',linkCik:'0000034088'});
 assert.equal(reporting.continuing('0002115436','2026-11-18'),null);
 const subs=(cik,rows)=>({cik:Number(cik),name:'X',filings:{recent:{accessionNumber:rows.map(r=>r[0]),form:rows.map(r=>r[1]),filingDate:rows.map(r=>r[2]),reportDate:rows.map(r=>r[3]),primaryDocument:rows.map(()=>'x.htm')},files:[]}});
 const pages={
  'https://data.sec.gov/submissions/CIK0002115436.json':subs('2115436',[['0002115436-26-000020','10-Q','2026-11-02','2026-09-30']]),
  'https://data.sec.gov/submissions/CIK0000034088.json':subs('34088',[['0000034088-26-000010','10-K','2026-02-18','2025-12-31'],['0002115436-26-000020','10-Q','2026-11-02','2026-09-30']]),
 };
 // the listing is on the successor after 2027-03-31: its annual is the predecessor's 10-K, linked under the predecessor's CIK
 const e=await reporting.fetchReporting({cik:'0002115436',symbols:['XOM']},{asOf:'2027-04-01',request:async u=>pages[u]});
 assert.equal(e.latestAnnual.accessionNumber,'0000034088-26-000010');
 assert.equal(e.latestAnnual.filingUrl,'https://www.sec.gov/Archives/edgar/data/34088/000003408826000010/0000034088-26-000010-index.htm');
 // the successor's own filing keeps the successor's link even though the predecessor's feed carries it too
 assert.equal(e.latestPeriodic.accessionNumber,'0002115436-26-000020');
 assert.equal(e.latestPeriodic.filingUrl,'https://www.sec.gov/Archives/edgar/data/2115436/000211543626000020/0002115436-26-000020-index.htm');
 const fact=(accn,start,end,val)=>({accn,start,end,val,form:'10-Q',filed:'2026-11-02'});
 const facts={
  'https://data.sec.gov/api/xbrl/companyfacts/CIK0002115436.json':{cik:2115436,entityName:'ExxonMobil Holdings Corp',facts:{'us-gaap':{Revenues:{units:{USD:[fact('0002115436-26-000020','2026-07-01','2026-09-30',113164e6)]}}}}},
  'https://data.sec.gov/api/xbrl/companyfacts/CIK0000034088.json':{cik:34088,entityName:'EXXON MOBIL CORP',facts:{'us-gaap':{Revenues:{units:{USD:[fact('0000034088-26-000010','2025-01-01','2025-12-31',339247e6)]}}}}},
 };
 const raw=await reporting.fetchFacts('0002115436',{asOf:'2027-04-01',request:async u=>facts[u]});
 assert.equal(raw.cik,2115436);
 assert.deepEqual(raw.facts['us-gaap'].Revenues.units.USD.map(f=>f.val),[113164e6,339247e6]);
});
test('a missing successor feed leaves the issuer\'s own facts; a failing one is not swallowed',async()=>{
 const own={cik:34088,entityName:'EXXON MOBIL CORP',facts:{'us-gaap':{Revenues:{units:{USD:[{accn:'0000034088-26-000010',start:'2025-01-01',end:'2025-12-31',val:1}]}}}}};
 const urls=[];
 const missing=await reporting.fetchFacts('0000034088',{asOf:'2026-11-18',request:async u=>{urls.push(u);if(u.includes('2115436'))throw Object.assign(new Error('missing'),{response:{status:404}});return own;}});
 assert.equal(urls.length,2);
 assert.deepEqual(missing,own);
 await assert.rejects(reporting.fetchFacts('0000034088',{asOf:'2026-11-18',request:async u=>{if(u.includes('2115436'))throw Object.assign(new Error('boom'),{response:{status:500}});return own;}}),/boom/);
});
test('a symbol is named by the registration the directory lists it under, not by whichever entry came last',()=>{
 const {normalizeSymbols}=require('../../scripts/refresh-sec-coverage');
 const list=[{symbol:'XOM',cik:'0000034088',securityType:'stock'},{symbol:'XOM-W',cik:'0000034088',securityType:'stock'}];
 const report={issuers:{
  '0000034088':{cik:'0000034088',symbols:['XOM','XOM-W']},
  '0002115436':{cik:'0002115436',symbols:['XOM']},
  '0000099999':{cik:'0000099999',symbols:['ZZZ']},
 }};
 normalizeSymbols(report,list);
 assert.deepEqual(report.issuers['0000034088'].symbols,['XOM','XOM-W']);
 assert.deepEqual(report.issuers['0002115436'].symbols,[]);
 // a symbol the directory does not list at all is left alone: the report is not the directory
 assert.deepEqual(report.issuers['0000099999'].symbols,['ZZZ']);
});
