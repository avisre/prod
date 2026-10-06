'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'financial-promotion-'));process.env.SEC_COVERAGE_DATA_DIR=dir;
const {promote}=require('../../scripts/promote-financial-cache');
const issuer='0000000123';
fs.writeFileSync(path.join(dir,'us-companies.json'),JSON.stringify({companies:[{symbol:'EX',cik:issuer,securityType:'stock'}]}));
function fact(value=100){return {issuer,field:'totalRevenue',definition:'Provider reported revenue',value,scale:1,unit:'USD',currency:'USD',periodStart:'2025-01-01',periodEnd:'2025-12-31',basis:'annual',historyBasis:'annual',statement:'income',accountingBasis:'provider reported',scope:'entity',sourceType:'provider',sourceName:'Yahoo Finance',sourceUrl:'https://finance.yahoo.com/quote/EX/financials/',publicationDate:null,sourceDataDate:'2026-10-04',sourceDateKind:'retrieval',retrievedAt:'2026-10-04T01:00:00Z',sourceIds:['provider:fixture'],sourceVersions:['fixture'],state:'available'};}
// Like the driver: no server-side sort is available for whole requests, and
// natural order is not newest-first.
function collection(rows){const stored=rows.map((row,i)=>({_id:i,createdAt:new Date(Date.UTC(2026,9,5)-i*1000),...row})).reverse();
 return {find(query={}){const ids=query._id?.$in;return {sort(){throw Object.assign(new Error('Sort exceeded memory limit'),{code:292});},
  [Symbol.asyncIterator]:async function*(){yield* stored.filter(row=>!ids || ids.includes(row._id));}};}};}
test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
test('a newer empty request does not hide valid older evidence; unavailable provider retains dated last good',async()=>{
 const r=await promote(collection([{issuer,value:{supplemental:[]}},{issuer,value:{supplemental:[{...fact(),currency:'BADUNIT'},fact()]}}]),{asOf:'2026-10-05',refresh:async()=>{throw new Error('outage');}});
 assert.equal(r.promotedIssuers,1);assert.equal(r.rejectedObservations,1);assert.equal(r.refreshFailures,1);
 const stored=JSON.parse(fs.readFileSync(path.join(dir,'supplemental-financials',issuer+'.json')));assert.equal(stored.observations[0].value,100);assert.equal(stored.refreshStatus,'retrieval_failed');
});
test('weekly promotion refreshes previously committed public evidence without request-cache entries',async()=>{
 const r=await promote(collection([]),{asOf:'2026-10-05',refresh:async()=>({fetchedAt:'2026-10-05T00:00:00Z',statements:{income:{annualReports:[{fiscalDateEnding:'2025-12-31',reportedCurrency:'USD',totalRevenue:101}]}}})});
 assert.equal(r.promotedIssuers,1);const stored=JSON.parse(fs.readFileSync(path.join(dir,'supplemental-financials',issuer+'.json')));assert.equal(stored.observations.length,1);assert.equal(stored.observations[0].value,101);assert.equal(stored.observations[0].sourceDataDate,'2026-10-05');
});
