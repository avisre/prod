'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {extract}=require('../sec-facts');
const p=require('../sec-coverage');
const CIK='0000000123',ACC='0000000123-26-000001';
function fixture(taxonomy='us-gaap',currency='USD') {
 const keys=taxonomy==='us-gaap'?['Revenues','NetIncomeLoss','Assets','StockholdersEquity','NetCashProvidedByUsedInOperatingActivities']:['Revenue','ProfitLossAttributableToOwnersOfParent','Assets','EquityAttributableToOwnersOfParent','CashFlowsFromUsedInOperatingActivities'];
 const doc={cik:123,entityName:'Example',facts:{[taxonomy]:{}}};
 for(const [i,k] of keys.entries())doc.facts[taxonomy][k]={units:{[currency]:[{val:i===0?0:100,start:[2,3].includes(i)?undefined:'2025-01-01',end:'2025-12-31',accn:ACC,form:taxonomy==='us-gaap'?'10-K':'20-F',filed:'2026-02-01'}]}};
 const evidence={cik:CIK,lastSuccessfulCheckAt:'2026-10-03',latestAnnual:{form:taxonomy==='us-gaap'?'10-K':'20-F',filingDate:'2026-02-01',reportDate:'2025-12-31',accessionNumber:ACC,amendments:[]}};
 return {doc,evidence};
}
test('US GAAP and IFRS extraction retain reported zero, exact accessions, native units and core completeness',()=>{
 for(const [tax,cur] of [['us-gaap','USD'],['ifrs-full','EUR']]){const {doc,evidence}=fixture(tax,cur);const d=extract(doc,evidence,{asOf:'2026-10-03'});assert.equal(d.income.annualReports[0].totalRevenue,0);assert.equal(d.income.annualReports[0].reportedCurrency,cur);assert.equal(p.classify(evidence,d,'2026-10-03').financialCoverage,'ready');assert.equal(Object.values(d.sources)[0].accessionNumber,ACC);}
});
test('conflicting values from the same accession are missing rather than guessed',()=>{
 const {doc,evidence}=fixture();const arr=doc.facts['us-gaap'].NetIncomeLoss.units.USD;arr.push({...arr[0],val:999});const d=extract(doc,evidence,{asOf:'2026-10-03'});assert.equal(d.income.annualReports[0].netIncome,null);assert.ok(d.issues.some(i=>i.code==='AMBIGUOUS_FACT'));assert.equal(p.classify(evidence,d,'2026-10-03').financialCoverage,'partial');
});
test('multiple currencies without SEC reporting currency do not borrow a provider stamp',()=>{
 const {doc,evidence}=fixture();for(const fact of Object.values(doc.facts['us-gaap']))fact.units.EUR=fact.units.USD.map(r=>({...r,val:222}));const d=extract(doc,evidence,{asOf:'2026-10-03'});assert.equal(d.income.annualReports.length,0);assert.ok(d.issues.some(i=>i.code==='AMBIGUOUS_CURRENCY'));
});
test('a later quarterly restatement cannot replace the qualifying annual cohort',()=>{
 const {doc,evidence}=fixture();const row=doc.facts['us-gaap'].NetIncomeLoss.units.USD[0];doc.facts['us-gaap'].NetIncomeLoss.units.USD.push({...row,val:777,form:'10-Q',filed:'2026-08-01',accn:'0000000123-26-000002'});const d=extract(doc,evidence,{asOf:'2026-10-03'});assert.equal(d.income.annualReports[0].netIncome,100);
});
test('quarterly EPS is never inferred by subtracting YTD EPS',()=>{
 const {doc,evidence}=fixture();doc.facts['us-gaap'].EarningsPerShareDiluted={units:{'USD/shares':[{val:5,start:'2025-01-01',end:'2025-06-30',filed:'2025-08-01',form:'10-Q',accn:ACC},{val:2,start:'2025-01-01',end:'2025-03-31',filed:'2025-05-01',form:'10-Q',accn:ACC}]}};doc.facts['us-gaap'].Revenues.units.USD.push({val:10,start:'2025-04-01',end:'2025-06-30',filed:'2025-08-01',form:'10-Q',accn:ACC});const d=extract(doc,evidence,{asOf:'2026-10-03'});assert.equal(d.income.quarterlyReports.find(r=>r.fiscalDateEnding==='2025-06-30').dilutedEPS,null);
});
test('identity mismatch is rejected before financial extraction',()=>{
 const {doc,evidence}=fixture();assert.throws(()=>extract({...doc,cik:456},evidence),/IDENTITY/);
});
module.exports={fixture};
