'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),{fixture,ACC}=require('./fixtures/sec-fixture');
const {extract}=require('../sec-facts'),p=require('../sec-coverage');
const normalize=(doc,evidence)=>extract(doc,evidence,{asOf:'2026-10-03'});
test('missing-value parser retains finite zeros and negative values',()=>{
 for(const v of [null,undefined,'','   ','None','null',NaN,Infinity])assert.equal(p.number(v),null);
 for(const [v,n]of [[0,0],['0',0],[-1,-1],[' -9.5 ',-9.5]])assert.equal(p.number(v),n);
});
test('negative annual income, equity and cash flow remain complete observations',()=>{
 const {doc,evidence}=fixture();for(const key of ['NetIncomeLoss','StockholdersEquity','NetCashProvidedByUsedInOperatingActivities'])doc.facts['us-gaap'][key].units.USD[0].val=-100;
 const data=normalize(doc,evidence);assert.equal(p.classify(evidence,data,'2026-10-03').financialCoverage,'ready');assert.equal(data.balance.annualReports[0].totalShareholderEquity,-100);
});
test('52 and 53 week fiscal years qualify; short transitions and trailing facts do not',()=>{
 for(const [start,end,ready]of [['2024-12-29','2025-12-27',true],['2024-12-29','2026-01-03',true],['2025-04-01','2025-12-31',false]]){
  const {doc,evidence}=fixture();evidence.latestAnnual.reportDate=end;for(const fact of Object.values(doc.facts['us-gaap']))for(const row of fact.units.USD){row.end=end;if(row.start)row.start=start;}
  const data=normalize(doc,evidence);assert.equal(p.classify(evidence,data,'2026-10-03').financialCoverage==='ready',ready);
 }
 const {doc,evidence}=fixture();for(const fact of Object.values(doc.facts['us-gaap']))for(const row of fact.units.USD)row.form='10-Q';assert.notEqual(p.classify(evidence,normalize(doc,evidence),'2026-10-03').financialCoverage,'ready');
});
test('instant assets require no duration and exact annual end',()=>{
 const {doc,evidence}=fixture();doc.facts['us-gaap'].Assets.units.USD[0].start='2025-01-01';const data=normalize(doc,evidence);assert.equal(data.balance.annualReports[0].totalAssets,null);assert.equal(p.classify(evidence,data,'2026-10-03').financialCoverage,'partial');
});
test('duplicate observations are harmless and matched amendments retain corrected accession',()=>{
 const {doc,evidence}=fixture(),arr=doc.facts['us-gaap'].NetIncomeLoss.units.USD;arr.push({...arr[0]});assert.equal(normalize(doc,evidence).income.annualReports[0].netIncome,100);
 const amendment={...evidence.latestAnnual,form:'10-K/A',filingDate:'2026-09-01',accessionNumber:'0000000123-26-000002'};evidence.latestAnnual.amendments=[amendment];arr.push({...arr[0],form:amendment.form,filed:amendment.filingDate,accn:amendment.accessionNumber,val:101});
 const data=normalize(doc,evidence),row=data.income.annualReports[0];assert.equal(row.netIncome,101);assert.equal(data.sources[row._sources.netIncome[0]].accessionNumber,amendment.accessionNumber);
});
test('future restatements cannot replace current values and missing custom facts stay missing',()=>{
 const {doc,evidence}=fixture(),arr=doc.facts['us-gaap'].NetIncomeLoss.units.USD;arr.push({...arr[0],filed:'2027-01-01',accn:'0000000123-27-000001',val:777});assert.equal(normalize(doc,evidence).income.annualReports[0].netIncome,100);
 doc.facts.custom={CustomOperatingCashflow:doc.facts['us-gaap'].NetCashProvidedByUsedInOperatingActivities};delete doc.facts['us-gaap'].NetCashProvidedByUsedInOperatingActivities;assert.equal(normalize(doc,evidence).cash.annualReports.length,0);
});
test('YTD cash-flow differences keep both source accessions; EPS is directly reported only',()=>{
 const {doc,evidence}=fixture(),gaap=doc.facts['us-gaap'];const fact=(start,end,val,accn)=>({start,end,val,accn,form:'10-Q',filed:'2026-08-01'});
 gaap.NetCashProvidedByUsedInOperatingActivities.units.USD.push(fact('2026-01-01','2026-03-31',20,'0000000123-26-000003'),fact('2026-01-01','2026-06-30',55,'0000000123-26-000004'));
 gaap.Revenues.units.USD.push(fact('2026-04-01','2026-06-30',100,'0000000123-26-000004'));
 gaap.EarningsPerShareDiluted={units:{'USD/shares':[fact('2026-04-01','2026-06-30',2.2,'0000000123-26-000004')]}};
 const data=normalize(doc,evidence),cash=data.cash.quarterlyReports.find(r=>r.fiscalDateEnding==='2026-06-30'),inc=data.income.quarterlyReports.find(r=>r.fiscalDateEnding==='2026-06-30');assert.equal(cash.operatingCashflow,35);assert.equal(cash._sources.operatingCashflow.length,2);assert.equal(cash._derivations.operatingCashflow.formula,'ytd_difference');assert.equal(inc.dilutedEPS,2.2);assert.ok(p.verifiedField(data,cash,'operatingCashflow'));
});
test('missing capex cannot create FCF and parent/consolidated scopes are distinct',()=>{
 const {doc,evidence}=fixture();delete doc.facts['us-gaap'].StockholdersEquity;doc.facts['us-gaap'].StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest={units:{USD:[{val:200,end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'}]}};
 const data=normalize(doc,evidence);assert.equal(data.income.annualReports[0]._scopes.netIncome,'parent');assert.equal(data.balance.annualReports[0]._scopes.totalShareholderEquity,'consolidated');
 const view={...data,coverage:{latestAnnual:evidence.latestAnnual,perShareAllowed:true}};const row=require('../financial-metrics').screenRow({symbol:'EX'},view);assert.equal(row.roePct,null);assert.equal(row.fcfPositive,null);
});
