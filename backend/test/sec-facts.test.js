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
// 187 covered companies were understated on 2026-10-06 because the customer-contract line won.
test('revenue is the largest revenue line of the filing, or net revenues where a financial firm reports them',()=>{
 const period={start:'2025-01-01',end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'},f=val=>({units:{USD:[{...period,val}]}});
 const rev=extra=>{const {doc,evidence}=fixture();Object.assign(doc.facts['us-gaap'],extra);return extract(doc,evidence,{asOf:'2026-10-03'}).income.annualReports[0].totalRevenue;};
 assert.equal(rev({Revenues:f(10600),RevenueFromContractWithCustomerExcludingAssessedTax:f(900)}),10600);
 assert.equal(rev({Revenues:f(130),RevenueFromContractWithCustomerExcludingAssessedTax:f(980)}),980);
 assert.equal(rev({Revenues:f(126000),RevenuesNetOfInterestExpense:f(58000),RevenueFromContractWithCustomerExcludingAssessedTax:f(20000)}),58000);
 assert.equal(rev({Revenues:f(500)}),500);
 // A gap under a fifth with nothing to arbitrate keeps the original line.
 assert.equal(rev({Revenues:f(1900),RevenueFromContractWithCustomerExcludingAssessedTax:f(1660)}),1660);
 // StoneX: a small net figure beside a far larger total is not the top line.
 assert.equal(rev({Revenues:f(132000),RevenuesNetOfInterestExpense:f(2000)}),132000);
 // Sales before excise tax are larger, but gross profit plus cost names net sales as the total.
 assert.equal(rev({Revenues:f(9756),RevenueFromContractWithCustomerExcludingAssessedTax:f(9139),GrossProfit:f(4639),CostOfGoodsAndServicesSold:f(4500)}),9139);
 assert.equal(rev({Revenues:f(10600),RevenueFromContractWithCustomerExcludingAssessedTax:f(900),OperatingIncomeLoss:f(4600),CostsAndExpenses:f(6000)}),10600);
});
// Quarter and bank rules added after the 2026-10-06 audit.
test('a 16-week first quarter is a quarter, and a full-year figure mis-dated as a quarter is not',()=>{
 const {doc,evidence}=fixture();const q=(start,end,val,accn,form='10-Q',filed)=>({val,start,end,accn,form,filed:filed||end});
 doc.facts['us-gaap'].Revenues.units.USD=[{val:1000,start:'2025-01-01',end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'},q('2025-01-01','2025-04-22',400,'0000000123-25-000002'),
  q('2025-10-01','2025-12-31',1000,ACC,'10-K','2026-02-01')];
 const d=extract(doc,evidence,{asOf:'2026-10-03'});const ends=d.income.quarterlyReports.map(r=>r.fiscalDateEnding);
 assert.ok(ends.includes('2025-04-22'));assert.equal(d.income.quarterlyReports.find(r=>r.fiscalDateEnding==='2025-04-22').totalRevenue,400);
 assert.notEqual(d.income.quarterlyReports.find(r=>r.fiscalDateEnding==='2025-12-31')?.totalRevenue,1000);
});
test('a bank that files net interest and noninterest income is measured on their sum, not a stray Revenues tag',()=>{
 const {doc,evidence}=fixture();evidence.sic='6022';const f=val=>({units:{USD:[{val,start:'2025-01-01',end:'2025-12-31',accn:ACC,form:'10-K',filed:'2026-02-01'}]}});
 Object.assign(doc.facts['us-gaap'],{Revenues:f(68),InterestIncomeExpenseNet:f(300),NoninterestIncome:f(90)});
 const d=extract(doc,evidence,{asOf:'2026-10-03'});assert.equal(d.income.annualReports[0].totalRevenue,390);assert.deepEqual(p.validateFinancial(d,CIK,'2026-10-03'),[]);
});
