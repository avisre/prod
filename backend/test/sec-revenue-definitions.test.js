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
test('legacy partial insurance revenue is quarantined rather than presented as total revenue',()=>{
 const f=load('MET'),d=extract(f.facts,{...f.evidence,sic:''},{asOf:'2026-10-05'}),r=d.income.annualReports.find(r=>r.fiscalDateEnding===f.evidence.latestAnnual.reportDate);
 assert.equal(r.totalRevenue,2436000000);d.reportingSic=f.evidence.sic;assert.equal(p.verifiedField(d,r,'totalRevenue'),false);
 const result=sanitize(d);assert.equal(r.totalRevenue,null);assert.equal(r._superseded.totalRevenue.value,2436000000);assert.ok(result.excluded>0);
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
