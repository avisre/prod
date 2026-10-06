'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {extract}=require('../sec-facts'),p=require('../sec-coverage');
const {sanitize}=require('../../scripts/normalize-financial-source-ids');
function load(symbol){return require('./fixtures/sec-original/'+symbol+'.json');}
function parsed(symbol){const f=load(symbol);return extract(f.facts,f.evidence,{asOf:'2026-10-05'});}
test('Axos net revenue excludes customer-contract fees and derives matching reported net interest plus noninterest income',()=>{
 const d=parsed('AX'),r=d.income.annualReports.find(r=>r.fiscalDateEnding===load('AX').evidence.latestAnnual.reportDate);
 assert.equal(r.netInterestIncome,1246910000);assert.equal(r.nonInterestIncome,233583000);assert.equal(r.totalRevenue,1480493000);
 assert.equal(r._derivations.totalRevenue.formula,'sum_fields');assert.ok(p.verifiedField(d,r,'totalRevenue'));
});
test('insurance and conglomerate total revenue includes the broader reported revenue definition',()=>{
 for(const [symbol,value]of [['BRK.B',371444000000],['MET',77084000000]]){
  const d=parsed(symbol),r=d.income.annualReports.find(r=>r.fiscalDateEnding===load(symbol).evidence.latestAnnual.reportDate);
  assert.equal(r.totalRevenue,value);assert.equal(d.sources[r._sources.totalRevenue[0]].concept,'Revenues');assert.ok(p.verifiedField(d,r,'totalRevenue'));
 }
});
// The filing's total now wins over its customer-contract line for every issuer,
// so the partial figure is no longer produced even when the industry code is unknown
// (it used to be 2,436,000,000 and had to be quarantined afterwards).
test('total revenue is the filing total, not its customer-contract line, with or without an industry code',()=>{
 const f=load('MET'),d=extract(f.facts,{...f.evidence,sic:''},{asOf:'2026-10-05'}),r=d.income.annualReports.find(r=>r.fiscalDateEnding===f.evidence.latestAnnual.reportDate);
 assert.equal(r.totalRevenue,77084000000);assert.equal(d.sources[r._sources.totalRevenue[0]].concept,'Revenues');d.reportingSic=f.evidence.sic;assert.ok(p.verifiedField(d,r,'totalRevenue'));
});
test('legacy bank fee revenue is quarantined and reconstructed from compatible inputs',()=>{
 const f=load('AX'),d=extract(f.facts,{...f.evidence,sic:''},{asOf:'2026-10-05'}),r=d.income.annualReports.find(r=>r.fiscalDateEnding===f.evidence.latestAnnual.reportDate);
 assert.equal(r.totalRevenue,81254000);d.reportingSic=f.evidence.sic;sanitize(d);assert.equal(r.totalRevenue,1480493000);assert.equal(r._superseded.totalRevenue.value,81254000);
 assert.ok(p.verifiedField(d,r,'totalRevenue'));
});
test('bank net revenue cannot combine different filing versions',()=>{
 const f=load('AX'),doc=structuredClone(f.facts),end=f.evidence.latestAnnual.reportDate;
 for(const row of doc.facts['us-gaap'].NoninterestIncome.units.USD)if(row.end===end)row.accn='0000000123-26-000099';
 const d=extract(doc,f.evidence,{asOf:'2026-10-05'}),r=d.income.annualReports.find(r=>r.fiscalDateEnding===end);assert.equal(r.totalRevenue,null);
});
test('SEC industry classification selects relevant metrics when cached industry names are missing',()=>{
 const {requirements}=require('../financial-requirements');
 for(const [sic,archetype]of [['6021','bank'],['6331','insurer'],['6798','reit'],['3674','semis-hardware'],['2834','pharma-biotech'],['7372','software'],['1311','energy'],['4911','utility'],['5311','consumer'],['3721','industrial']])assert.equal(requirements({},sic).archetype,archetype);
 const life=requirements({},'6311');assert.deepEqual(life.notApplicable,['combinedRatio','lossRatio']);assert.ok(!life.industry.includes('combinedRatio'));
 const mortgage=requirements({Industry:'Mortgage REITs'},'6798');assert.deepEqual(mortgage.notApplicable,['occupancy']);assert.ok(!mortgage.industry.includes('occupancy'));
});
test('an omitted optional fact can retain its original receipt only in the same annual filing version',()=>{
 const {fixture}=require('./fixtures/sec-fixture'),{preserveSameFiling}=require('../sec-last-good'),{doc,evidence}=fixture();
 const acc=evidence.latestAnnual.accessionNumber;doc.facts['us-gaap'].CommonStockSharesOutstanding={units:{shares:[{val:25,end:evidence.latestAnnual.reportDate,form:'10-K',filed:evidence.latestAnnual.filingDate,accn:acc}]}};
 const old=extract(doc,evidence,{asOf:'2026-10-05'});delete doc.facts['us-gaap'].CommonStockSharesOutstanding;
 const incoming=extract(doc,evidence,{asOf:'2026-10-05'});preserveSameFiling(incoming,old,evidence);const row=incoming.balance.annualReports[0];assert.equal(row.commonStockSharesOutstanding,25);assert.ok(p.verifiedField(incoming,row,'commonStockSharesOutstanding'));assert.equal(row._retained.commonStockSharesOutstanding.method,'same_filing_last_good');
 const changed=extract(doc,evidence,{asOf:'2026-10-05'});preserveSameFiling(changed,old,{...evidence,latestAnnual:{...evidence.latestAnnual,accessionNumber:'0000000123-26-000099'}});assert.equal(changed.balance.annualReports[0].commonStockSharesOutstanding,null);
});
test('issuer earnings releases apply the same partial-revenue exclusion as filed statements',()=>{
 const f=load('MET'),facts=structuredClone(f.facts.facts);
 for(const def of Object.values(facts['us-gaap']))for(const rows of Object.values(def.units))for(const row of rows)row._original={contextRef:'reviewed-release-context'};
 const release={facts,originalDocument:{url:'https://www.sec.gov/Archives/edgar/data/1099219/'+f.evidence.latestAnnual.accessionNumber.replace(/-/g,'')+'/release.htm',accessionNumber:f.evidence.latestAnnual.accessionNumber,filingDate:f.evidence.latestAnnual.filingDate}};
 const values=require('../issuer-release').observations(release,f.evidence.cik,['totalRevenue'],'6311');
 assert.ok(values.length>0);assert.ok(values.every(v=>v.concept==='Revenues'));assert.ok(!values.some(v=>v.value===2436000000));
});
