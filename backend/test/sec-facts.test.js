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

// Measured 2026-10-06: 1,104 stock issuers lacked a core figure in their newest
// annual report and whole companies were dropped from coverage for it.
const swap=(doc,from,to)=>{doc.facts['us-gaap'][to]=doc.facts['us-gaap'][from];delete doc.facts['us-gaap'][from];};
test('net revenues, utility revenue, partners capital and balance-sheet totals are read under the tags filers use',()=>{
 for(const tag of ['RevenuesNetOfInterestExpense','RegulatedAndUnregulatedOperatingRevenue']){const {doc,evidence}=fixture();swap(doc,'Revenues',tag);doc.facts['us-gaap'][tag].units.USD[0].val=500;assert.equal(extract(doc,evidence,{asOf:'2026-10-03'}).income.annualReports[0].totalRevenue,500,tag);}
 const {doc,evidence}=fixture();swap(doc,'StockholdersEquity','PartnersCapital');swap(doc,'Assets','LiabilitiesAndStockholdersEquity');
 const d=extract(doc,evidence,{asOf:'2026-10-03'});assert.equal(d.balance.annualReports[0].totalShareholderEquity,100);assert.equal(d.balance.annualReports[0].totalAssets,100);
 assert.deepEqual(p.validateFinancial(d,CIK,'2026-10-03'),[]);assert.equal(p.classify(evidence,d,'2026-10-03').financialCoverage,'ready');
});
test('a narrower tag stands in only when the filing shows no difference, and never displaces an original tag',()=>{
 let {doc,evidence}=fixture();swap(doc,'NetCashProvidedByUsedInOperatingActivities','NetCashProvidedByUsedInOperatingActivitiesContinuingOperations');swap(doc,'NetIncomeLoss','NetIncomeLossAvailableToCommonStockholdersBasic');
 let d=extract(doc,evidence,{asOf:'2026-10-03'});assert.equal(d.cash.annualReports[0].operatingCashflow,100);assert.equal(d.income.annualReports[0].netIncome,100);
 const period={start:'2025-01-01',end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'};
 doc.facts['us-gaap'].CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations={units:{USD:[{...period,val:7}]}};doc.facts['us-gaap'].DividendsPreferredStock={units:{USD:[{...period,val:3}]}};
 d=extract(doc,evidence,{asOf:'2026-10-03'});assert.equal(d.cash.annualReports[0].operatingCashflow,107);assert.equal(d.income.annualReports[0].netIncome,null);
 ({doc,evidence}=fixture());doc.facts['us-gaap'].NetCashProvidedByUsedInOperatingActivitiesContinuingOperations={units:{USD:[{...period,val:999}]}};
 assert.equal(extract(doc,evidence,{asOf:'2026-10-03'}).cash.annualReports[0].operatingCashflow,100);
});
test('a dollar convenience translation of the current year does not hide the reporting currency',()=>{
 const {doc,evidence}=fixture('us-gaap','CNY');
 for(const fact of Object.values(doc.facts['us-gaap'])){const row=fact.units.CNY[0];fact.units.CNY.push({...row,...(row.start?{start:'2024-01-01'}:{}),end:'2024-12-31'});fact.units.USD=[{...row,val:row.val/7}];}
 const d=extract(doc,evidence,{asOf:'2026-10-03'});assert.equal(d.income.annualReports[0].reportedCurrency,'CNY');assert.equal(d.income.annualReports[0].netIncome,100);
 assert.ok(!d.issues.some(i=>i.code==='AMBIGUOUS_CURRENCY' && i.periodEnd==='2025-12-31'));
});
test('net sales and other revenues are added only when gross profit plus cost of sales confirms the total',()=>{
 const build=gross=>{const {doc,evidence}=fixture('ifrs-full','EUR');delete doc.facts['ifrs-full'].Revenue;const f=(val)=>({units:{EUR:[{val,start:'2025-01-01',end:'2025-12-31',accn:ACC,form:'20-F',filed:'2026-02-01'}]}});
  Object.assign(doc.facts['ifrs-full'],{RevenueFromSaleOfGoods:f(900),OtherRevenue:f(100),GrossProfit:f(gross),CostOfSales:f(300)});return {d:extract(doc,evidence,{asOf:'2026-10-03'}),evidence};};
 const ok=build(700);assert.equal(ok.d.income.annualReports[0].totalRevenue,1000);assert.deepEqual(p.validateFinancial(ok.d,CIK,'2026-10-03'),[]);
 assert.equal(build(650).d.income.annualReports[0].totalRevenue,null);
});
test('operating cash flow filed as continuing and discontinued parts is their sum',()=>{
 const {doc,evidence}=fixture();swap(doc,'NetCashProvidedByUsedInOperatingActivities','NetCashProvidedByUsedInOperatingActivitiesContinuingOperations');
 doc.facts['us-gaap'].CashProvidedByUsedInOperatingActivitiesDiscontinuedOperations={units:{USD:[{val:-30,start:'2025-01-01',end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'}]}};
 const d=extract(doc,evidence,{asOf:'2026-10-03'});assert.equal(d.cash.annualReports[0].operatingCashflow,70);assert.deepEqual(p.validateFinancial(d,CIK,'2026-10-03'),[]);assert.equal(p.classify(evidence,d,'2026-10-03').financialCoverage,'ready');
});
